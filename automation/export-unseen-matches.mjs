#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import yaml from 'js-yaml';

import { makeHttpCtx } from '../providers/_http.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PROVIDERS_DIR = path.join(ROOT, 'providers');
const PORTALS_PATH = path.join(ROOT, 'portals.yml');
const HISTORY_PATH = path.join(ROOT, 'data', 'scan-history.tsv');
const PIPELINE_PATH = path.join(ROOT, 'data', 'pipeline.md');
const OUT_DIR = path.join(ROOT, 'data', 'daily-matches');
const CONCURRENCY = 10;

async function loadProviders(dir) {
  const providers = new Map();
  if (!existsSync(dir)) return providers;

  const files = readdirSync(dir)
    .filter((file) => file.endsWith('.mjs') && !file.startsWith('_'))
    .sort();

  for (const file of files) {
    const full = path.join(dir, file);
    const mod = await import(pathToFileURL(full).href);
    const provider = mod.default;
    if (provider?.id && typeof provider.fetch === 'function' && !providers.has(provider.id)) {
      providers.set(provider.id, provider);
    }
  }

  return providers;
}

function resolveProvider(entry, providers, { skipIds = [] } = {}) {
  if (entry.provider) {
    const provider = providers.get(entry.provider);
    return provider ? { provider } : { error: `unknown provider: ${entry.provider}` };
  }

  const localParser = providers.get('local-parser');
  if (localParser && !skipIds.includes('local-parser')) {
    try {
      if (localParser.detect?.(entry)) return { provider: localParser };
    } catch {}
  }

  for (const provider of providers.values()) {
    if (skipIds.includes(provider.id)) continue;
    try {
      if (provider.detect?.(entry)) return { provider };
    } catch {}
  }

  return null;
}

function normalizeKeywordList(value) {
  if (value == null) return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr
    .filter((item) => typeof item === 'string')
    .map((item) => item.toLowerCase().trim())
    .filter(Boolean);
}

function buildTitleFilter(titleFilter) {
  const positive = normalizeKeywordList(titleFilter?.positive);
  const negative = normalizeKeywordList(titleFilter?.negative);

  return (title) => {
    const lower = String(title || '').toLowerCase();
    const hasPositive = positive.length === 0 || positive.some((keyword) => lower.includes(keyword));
    const hasNegative = negative.some((keyword) => lower.includes(keyword));
    return hasPositive && !hasNegative;
  };
}

function buildLocationFilter(locationFilter) {
  if (!locationFilter) return () => true;

  const allowMissing = locationFilter.allow_missing !== false;
  const alwaysAllow = normalizeKeywordList(locationFilter.always_allow);
  const allow = normalizeKeywordList(locationFilter.allow);
  const block = normalizeKeywordList(locationFilter.block);

  return (location) => {
    if (typeof location !== 'string' || location.trim() === '') return allowMissing;
    const lower = location.toLowerCase();
    if (alwaysAllow.length > 0 && alwaysAllow.some((keyword) => lower.includes(keyword))) return true;
    if (block.length > 0 && block.some((keyword) => lower.includes(keyword))) return false;
    if (allow.length === 0) return true;
    return allow.some((keyword) => lower.includes(keyword));
  };
}

function buildStackFilter(stackFilter) {
  if (!stackFilter) return () => true;

  const positive = normalizeKeywordList(stackFilter.positive);
  const negative = normalizeKeywordList(stackFilter.negative);

  return (job) => {
    const text = [
      job.title,
      job.location,
      job.description,
      job.content,
      job.department,
      job.team,
    ].filter(Boolean).join('\n').toLowerCase();

    if (negative.length > 0 && negative.some((keyword) => keywordMatches(text, keyword))) return false;
    if (positive.length === 0) return true;
    return positive.some((keyword) => keywordMatches(text, keyword));
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function keywordMatches(text, keyword) {
  if (!keyword) return false;
  if (!/^[a-z0-9]/i.test(keyword) || !/[a-z0-9]$/i.test(keyword)) {
    return text.includes(keyword);
  }
  const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(keyword)}($|[^a-z0-9])`, 'i');
  return pattern.test(text);
}

function buildFreshnessPolicy(freshnessFilter) {
  const maxPostedAgeDays = Number(freshnessFilter?.max_posted_age_days);
  const enabled = Number.isFinite(maxPostedAgeDays) && maxPostedAgeDays >= 0;
  const requireRecentForRecheckableHistory = freshnessFilter?.require_recent_for_recheckable_history !== false;

  function ageDays(job) {
    if (Number.isFinite(job.postedAgeDays)) return Number(job.postedAgeDays);
    return parsePostedAgeDays(job.postedOn || job.postedText || '');
  }

  return {
    enabled,
    maxPostedAgeDays,
    requireRecentForRecheckableHistory,
    isFresh(job) {
      if (!enabled) return true;
      const age = ageDays(job);
      if (age == null) return true;
      return age <= maxPostedAgeDays;
    },
    hasFreshSignal(job) {
      if (!enabled) return true;
      const age = ageDays(job);
      return age != null && age <= maxPostedAgeDays;
    },
  };
}

function parsePostedAgeDays(postedOn) {
  const value = String(postedOn || '').trim().toLowerCase();
  if (!value) return null;
  if (value.includes('today')) return 0;
  if (value.includes('yesterday')) return 1;

  const dayMatch = value.match(/(\d+)\s+days?\s+ago/);
  if (dayMatch) return Number(dayMatch[1]);

  const weekMatch = value.match(/(\d+)\s+weeks?\s+ago/);
  if (weekMatch) return Number(weekMatch[1]) * 7;

  const monthMatch = value.match(/(\d+)\s+months?\s+ago/);
  if (monthMatch) return Number(monthMatch[1]) * 30;

  return null;
}

function loadHistoryByUrl() {
  const history = new Map();
  if (!existsSync(HISTORY_PATH)) return history;

  const lines = readFileSync(HISTORY_PATH, 'utf8').split('\n');
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const [url, firstSeen, portal, title, company, status, location] = line.split('\t');
    if (!url) continue;
    if (!history.has(url)) history.set(url, []);
    history.get(url).push({ url, firstSeen, portal, title, company, status, location });
  }
  return history;
}

const NON_BLOCKING_HISTORY_STATUSES = new Set([
  'skipped_expired',
  'skipped_no_apply_control',
]);

function shouldSkipHistory(entries, job, freshnessPolicy) {
  if (!entries || entries.length === 0) return false;
  const hasBlockingStatus = entries.some((entry) => !NON_BLOCKING_HISTORY_STATUSES.has(entry.status || ''));
  if (hasBlockingStatus) return true;
  if (!freshnessPolicy.requireRecentForRecheckableHistory) return false;
  return !freshnessPolicy.hasFreshSignal(job);
}

function loadPipelineUrls() {
  const seen = new Set();
  if (!existsSync(PIPELINE_PATH)) return seen;

  const text = readFileSync(PIPELINE_PATH, 'utf8');
  for (const match of text.matchAll(/- \[[ x]\] (https?:\/\/\S+)/g)) {
    seen.add(match[1]);
  }
  return seen;
}

async function parallelFetch(tasks, limit) {
  const results = [];
  let index = 0;

  async function next() {
    while (index < tasks.length) {
      const task = tasks[index++];
      results.push(await task());
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => next()));
  return results;
}

function renderMarkdown({ stamp, stats, offers, errors }) {
  const lines = [
    `# Unseen Matched Offers - ${stamp.slice(0, 10)}`,
    '',
    `Generated: ${stamp}`,
    '',
    'Scope: current `portals.yml` title + location + stack + freshness filters, excluding blocking history statuses in `data/scan-history.tsv`. Expired/no-apply history is recheckable only with a fresh posting signal.',
    '',
    '## Summary',
    '',
    `- Companies scanned: ${stats.companiesScanned}`,
    `- Total jobs fetched: ${stats.totalJobs}`,
    `- Passed title filter: ${stats.titlePassed}`,
    `- Failed location after title pass: ${stats.locationFailed}`,
    `- Failed stack after title+location pass: ${stats.stackFailed}`,
    `- Failed freshness after stack pass: ${stats.freshnessFailed}`,
    `- Matched before history exclusion: ${stats.matchedBeforeHistory}`,
    `- Already in history: ${stats.alreadyInHistory}`,
    `- Unseen matched offers: ${offers.length}`,
    `- Provider errors: ${errors.length}`,
    '',
    '## Offers',
    '',
  ];

  if (offers.length === 0) {
    lines.push('No unseen matched offers found.');
  } else {
    lines.push('| # | Company | Role | Location | Pipeline | URL |');
    lines.push('|---|---------|------|----------|----------|-----|');
    offers.forEach((offer, index) => {
      const pipeline = offer.inPipeline ? 'yes' : 'no';
      lines.push(`| ${index + 1} | ${escapeCell(offer.company)} | ${escapeCell(offer.title)} | ${escapeCell(offer.location || '')} | ${pipeline} | ${offer.url} |`);
    });
  }

  if (errors.length > 0) {
    lines.push('', '## Provider Errors', '');
    for (const error of errors) lines.push(`- ${error}`);
  }

  lines.push('');
  return lines.join('\n');
}

function escapeCell(value) {
  return String(value).replaceAll('|', '\\|').replace(/\s+/g, ' ').trim();
}

async function main() {
  const args = process.argv.slice(2);
  const dateFlag = args.indexOf('--date');
  const outDate = dateFlag !== -1 && args[dateFlag + 1]
    ? args[dateFlag + 1]
    : new Date().toISOString().slice(0, 10);

  const providers = await loadProviders(PROVIDERS_DIR);
  const config = yaml.load(readFileSync(PORTALS_PATH, 'utf8'));
  const companies = config.tracked_companies || [];
  const titleFilter = buildTitleFilter(config.title_filter);
  const locationFilter = buildLocationFilter(config.location_filter);
  const stackFilter = buildStackFilter(config.stack_filter);
  const freshnessPolicy = buildFreshnessPolicy(config.freshness_filter);
  const historyByUrl = loadHistoryByUrl();
  const pipelineUrls = loadPipelineUrls();

  const targets = [];
  const errors = [];
  for (const company of companies) {
    if (!company || typeof company !== 'object' || company.enabled === false) continue;
    const resolved = resolveProvider(company, providers);
    if (!resolved) continue;
    if (resolved.error) {
      errors.push(`${company.name}: ${resolved.error}`);
      continue;
    }
    targets.push({ ...company, _provider: resolved.provider });
  }

  const stats = {
    companiesScanned: targets.length,
    totalJobs: 0,
    titlePassed: 0,
    locationFailed: 0,
    stackFailed: 0,
    freshnessFailed: 0,
    matchedBeforeHistory: 0,
    alreadyInHistory: 0,
  };

  const offers = [];
  const uniqueUnseen = new Set();

  const tasks = targets.map((company) => async () => {
    let provider = company._provider;
    const ctx = makeHttpCtx();

    try {
      let jobs;
      try {
        jobs = await provider.fetch(company, ctx);
      } catch (parserErr) {
        if (provider.id !== 'local-parser') throw parserErr;
        const fallback = resolveProvider(company, providers, { skipIds: ['local-parser'] });
        if (!fallback || fallback.error) throw parserErr;
        provider = fallback.provider;
        jobs = await provider.fetch(company, ctx);
      }

      if (!Array.isArray(jobs)) throw new Error(`${provider.id}: fetch() did not return an array`);

      for (const job of jobs) {
        stats.totalJobs += 1;

        if (!titleFilter(job.title)) continue;
        stats.titlePassed += 1;

        if (!locationFilter(job.location)) {
          stats.locationFailed += 1;
          continue;
        }

        if (!stackFilter(job)) {
          stats.stackFailed += 1;
          continue;
        }

        if (!freshnessPolicy.isFresh(job)) {
          stats.freshnessFailed += 1;
          continue;
        }

        stats.matchedBeforeHistory += 1;
        if (shouldSkipHistory(historyByUrl.get(job.url), job, freshnessPolicy)) {
          stats.alreadyInHistory += 1;
          continue;
        }

        if (uniqueUnseen.has(job.url)) continue;
        uniqueUnseen.add(job.url);
        offers.push({
          company: job.company,
          title: job.title,
          location: job.location || '',
          url: job.url,
          inPipeline: pipelineUrls.has(job.url),
        });
      }
    } catch (err) {
      errors.push(`${company.name}: ${err.message}`);
    }
  });

  await parallelFetch(tasks, CONCURRENCY);

  offers.sort((a, b) => (
    a.company.localeCompare(b.company) ||
    a.title.localeCompare(b.title) ||
    a.url.localeCompare(b.url)
  ));

  const stamp = new Date().toISOString();
  mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, `unseen-matched-${outDate}.md`);
  writeFileSync(outPath, renderMarkdown({ stamp, stats, offers, errors }), 'utf8');

  console.log(`Wrote ${path.relative(ROOT, outPath)}`);
  console.log(`Matched before history exclusion: ${stats.matchedBeforeHistory}`);
  console.log(`Already in history: ${stats.alreadyInHistory}`);
  console.log(`Unseen matched offers: ${offers.length}`);
  if (errors.length > 0) console.log(`Provider errors: ${errors.length}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
