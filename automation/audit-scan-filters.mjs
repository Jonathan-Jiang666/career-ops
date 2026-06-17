#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from 'fs';
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
const APPLICATIONS_PATH = path.join(ROOT, 'data', 'applications.md');
const CONCURRENCY = 10;
const SAMPLE_LIMIT = Number(process.env.AUDIT_SAMPLE_LIMIT || 40);
const NON_BLOCKING_HISTORY_STATUSES = new Set([
  'skipped_expired',
  'skipped_no_apply_control',
]);

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

function buildTitleAudit(titleFilter) {
  const positive = normalizeKeywordList(titleFilter?.positive);
  const negative = normalizeKeywordList(titleFilter?.negative);

  return (title) => {
    const lower = String(title || '').toLowerCase();
    const positiveHit = positive.find((keyword) => lower.includes(keyword)) || '';
    const negativeHit = negative.find((keyword) => lower.includes(keyword)) || '';
    return {
      ok: (positive.length === 0 || Boolean(positiveHit)) && !negativeHit,
      positiveHit,
      negativeHit,
    };
  };
}

function buildLocationAudit(locationFilter) {
  if (!locationFilter) return () => ({ ok: true, reason: 'no_filter' });

  const allowMissing = locationFilter.allow_missing !== false;
  const alwaysAllow = normalizeKeywordList(locationFilter.always_allow);
  const allow = normalizeKeywordList(locationFilter.allow);
  const block = normalizeKeywordList(locationFilter.block);

  return (location) => {
    if (typeof location !== 'string' || location.trim() === '') {
      return { ok: allowMissing, reason: allowMissing ? 'missing_allowed' : 'missing_blocked' };
    }

    const lower = location.toLowerCase();
    const alwaysAllowHit = alwaysAllow.find((keyword) => lower.includes(keyword)) || '';
    const allowHit = allow.find((keyword) => lower.includes(keyword)) || '';
    const blockHit = block.find((keyword) => lower.includes(keyword)) || '';

    if (alwaysAllowHit) {
      return { ok: true, reason: 'always_allow', alwaysAllowHit, allowHit, blockHit };
    }
    if (blockHit) {
      return {
        ok: false,
        reason: allowHit ? 'blocked_even_with_allow_hit' : 'blocked',
        allowHit,
        blockHit,
      };
    }
    if (allow.length === 0) return { ok: true, reason: 'allow_empty' };
    if (allowHit) return { ok: true, reason: 'allow', allowHit };
    return { ok: false, reason: 'no_allow_hit' };
  };
}

function buildStackAudit(stackFilter) {
  if (!stackFilter) return () => ({ ok: true });

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

    const negativeHit = negative.find((keyword) => keywordMatches(text, keyword)) || '';
    if (negativeHit) return { ok: false, negativeHit };
    if (positive.length === 0) return { ok: true };

    const positiveHit = positive.find((keyword) => keywordMatches(text, keyword)) || '';
    return { ok: Boolean(positiveHit), positiveHit };
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
    describe(job) {
      const age = ageDays(job);
      if (age == null) return 'unknown posting age';
      return `${age}d old`;
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

function loadHistory() {
  const byUrl = new Map();
  if (!existsSync(HISTORY_PATH)) return byUrl;

  const lines = readFileSync(HISTORY_PATH, 'utf8').split('\n');
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const [url, firstSeen, portal, title, company, status, location] = line.split('\t');
    if (!url) continue;
    byUrl.set(url, { url, firstSeen, portal, title, company, status, location });
  }
  return byUrl;
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

function loadSeenCompanyRoles() {
  const seen = new Set();
  if (!existsSync(APPLICATIONS_PATH)) return seen;

  const text = readFileSync(APPLICATIONS_PATH, 'utf8');
  for (const match of text.matchAll(/\|[^|]+\|[^|]+\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/g)) {
    const company = match[1].trim().toLowerCase();
    const role = match[2].trim().toLowerCase();
    if (company && role && company !== 'company') seen.add(`${company}::${role}`);
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

function inc(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function sample(arr, item) {
  if (arr.length < SAMPLE_LIMIT) arr.push(item);
}

function printCounts(title, map) {
  console.log(title);
  if (map.size === 0) {
    console.log('  none');
    return;
  }
  for (const [key, count] of [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    console.log(`  ${key || '(blank)'}: ${count}`);
  }
}

function printSamples(title, rows) {
  console.log(`\n${title} (${rows.length}${rows.length === SAMPLE_LIMIT ? '+' : ''})`);
  if (rows.length === 0) {
    console.log('  none');
    return;
  }
  for (const row of rows) {
    console.log(`  - ${row.company} | ${row.title} | ${row.location || 'N/A'} | ${row.reason || ''} | ${row.status || ''}`);
    console.log(`    ${row.url}`);
  }
}

async function main() {
  const providers = await loadProviders(PROVIDERS_DIR);
  const config = yaml.load(readFileSync(PORTALS_PATH, 'utf8'));
  const overrides = [];
  if (process.env.AUDIT_DISABLE_STACK_FILTER === '1') {
    delete config.stack_filter;
    overrides.push('AUDIT_DISABLE_STACK_FILTER=1');
  }
  if (process.env.AUDIT_ALLOW_MISSING_LOCATION === '1') {
    config.location_filter ||= {};
    config.location_filter.allow_missing = true;
    overrides.push('AUDIT_ALLOW_MISSING_LOCATION=1');
  }
  if (process.env.AUDIT_LOCATION_ALWAYS_ALLOW) {
    config.location_filter ||= {};
    const extra = process.env.AUDIT_LOCATION_ALWAYS_ALLOW.split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    config.location_filter.always_allow = [
      ...new Set([...(config.location_filter.always_allow || []), ...extra]),
    ];
    overrides.push(`AUDIT_LOCATION_ALWAYS_ALLOW=${extra.join(',')}`);
  }
  if (process.env.AUDIT_REMOVE_LOCATION_ALLOW) {
    config.location_filter ||= {};
    const remove = new Set(process.env.AUDIT_REMOVE_LOCATION_ALLOW.split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean));
    config.location_filter.allow = (config.location_filter.allow || [])
      .filter((item) => !remove.has(String(item).trim().toLowerCase()));
    overrides.push(`AUDIT_REMOVE_LOCATION_ALLOW=${[...remove].join(',')}`);
  }
  const companies = config.tracked_companies || [];
  const titleAudit = buildTitleAudit(config.title_filter);
  const locationAudit = buildLocationAudit(config.location_filter);
  const stackAudit = buildStackAudit(config.stack_filter);
  const freshnessPolicy = buildFreshnessPolicy(config.freshness_filter);
  const history = loadHistory();
  const pipelineUrls = loadPipelineUrls();
  const seenCompanyRoles = loadSeenCompanyRoles();

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
    locationPassed: 0,
    stackPassed: 0,
    freshnessPassed: 0,
    freshnessFailed: 0,
    matchedBeforeDedup: 0,
    unseenExactUrl: 0,
    inHistory: 0,
    inBlockingHistory: 0,
    recheckableHistory: 0,
    inPipeline: 0,
    inApplicationsCompanyRole: 0,
  };

  const locationFailReasons = new Map();
  const locationFailBlocked = new Map();
  const stackFailKeywords = new Map();
  const historyStatuses = new Map();
  const blockingHistoryStatuses = new Map();
  const sourceProviders = new Map();

  const hiddenByHistory = [];
  const nonAppliedHistory = [];
  const recheckableHistory = [];
  const missingLocation = [];
  const blockedWithAllowHit = [];
  const noAllowHit = [];
  const stackFailed = [];
  const freshnessFailed = [];
  const actionableAfterBlocking = [];

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
      inc(sourceProviders, provider.id);

      for (const job of jobs) {
        stats.totalJobs += 1;

        const title = titleAudit(job.title);
        if (!title.ok) continue;
        stats.titlePassed += 1;

        const location = locationAudit(job.location);
        if (!location.ok) {
          inc(locationFailReasons, location.reason);
          if (location.blockHit) inc(locationFailBlocked, location.blockHit);

          const row = {
            company: job.company,
            title: job.title,
            location: job.location || '',
            url: job.url,
            reason: location.allowHit
              ? `${location.reason}: allow=${location.allowHit}; block=${location.blockHit}`
              : location.blockHit
              ? `${location.reason}: block=${location.blockHit}`
              : location.reason,
            status: history.get(job.url)?.status || '',
          };
          if (location.reason === 'missing_blocked') sample(missingLocation, row);
          if (location.reason === 'blocked_even_with_allow_hit') sample(blockedWithAllowHit, row);
          if (location.reason === 'no_allow_hit') sample(noAllowHit, row);
          continue;
        }
        stats.locationPassed += 1;

        const stack = stackAudit(job);
        if (!stack.ok) {
          inc(stackFailKeywords, stack.negativeHit || 'missing_positive');
          sample(stackFailed, {
            company: job.company,
            title: job.title,
            location: job.location || '',
            url: job.url,
            reason: stack.negativeHit || 'missing_positive',
            status: history.get(job.url)?.status || '',
          });
          continue;
        }
        stats.stackPassed += 1;

        if (!freshnessPolicy.isFresh(job)) {
          stats.freshnessFailed += 1;
          sample(freshnessFailed, {
            company: job.company,
            title: job.title,
            location: job.location || '',
            url: job.url,
            reason: freshnessPolicy.describe(job),
            status: history.get(job.url)?.status || '',
          });
          continue;
        }
        stats.freshnessPassed += 1;
        stats.matchedBeforeDedup += 1;

        const hist = history.get(job.url);
        const roleKey = `${String(job.company || '').toLowerCase()}::${String(job.title || '').toLowerCase()}`;
        if (hist) {
          stats.inHistory += 1;
          inc(historyStatuses, hist.status || '');
          if (NON_BLOCKING_HISTORY_STATUSES.has(hist.status || '')) {
            stats.recheckableHistory += 1;
            sample(recheckableHistory, {
              company: job.company,
              title: job.title,
              location: job.location || '',
              url: job.url,
              reason: hist.firstSeen,
              status: hist.status || '',
            });
            if (freshnessPolicy.requireRecentForRecheckableHistory && !freshnessPolicy.hasFreshSignal(job)) {
              stats.inBlockingHistory += 1;
              inc(blockingHistoryStatuses, hist.status || '');
              continue;
            }
          } else {
            stats.inBlockingHistory += 1;
            inc(blockingHistoryStatuses, hist.status || '');
            const row = {
              company: job.company,
              title: job.title,
              location: job.location || '',
              url: job.url,
              reason: hist.firstSeen,
              status: hist.status || '',
            };
            sample(hiddenByHistory, row);
            if (!['added', 'skipped_already_applied'].includes(hist.status || '')) {
              sample(nonAppliedHistory, row);
            }
            continue;
          }
        }
        if (pipelineUrls.has(job.url)) {
          stats.inPipeline += 1;
          continue;
        }
        if (seenCompanyRoles.has(roleKey)) {
          stats.inApplicationsCompanyRole += 1;
          continue;
        }

        stats.unseenExactUrl += 1;
        sample(actionableAfterBlocking, {
          company: job.company,
          title: job.title,
          location: job.location || '',
          url: job.url,
          reason: 'unseen_exact_url',
        });
      }
    } catch (err) {
      errors.push(`${company.name}: ${err.message}`);
    }
  });

  await parallelFetch(tasks, CONCURRENCY);

  console.log('Scan filter audit');
  if (overrides.length > 0) console.log(`Overrides: ${overrides.join('; ')}`);
  console.log(`Companies scanned: ${stats.companiesScanned}`);
  console.log(`Total jobs fetched: ${stats.totalJobs}`);
  console.log(`Passed title: ${stats.titlePassed}`);
  console.log(`Passed location: ${stats.locationPassed}`);
  console.log(`Passed stack: ${stats.stackPassed}`);
  console.log(`Passed freshness: ${stats.freshnessPassed}`);
  console.log(`Failed freshness: ${stats.freshnessFailed}`);
  console.log(`Matched before dedup: ${stats.matchedBeforeDedup}`);
  console.log(`Hidden by exact history URL: ${stats.inHistory}`);
  console.log(`Hidden by blocking history status: ${stats.inBlockingHistory}`);
  console.log(`Recheckable expired/no-apply history: ${stats.recheckableHistory}`);
  console.log(`Hidden by pipeline URL: ${stats.inPipeline}`);
  console.log(`Hidden by applications company+role: ${stats.inApplicationsCompanyRole}`);
  console.log(`Actionable after blocking dedup: ${stats.unseenExactUrl}`);
  console.log(`Provider errors: ${errors.length}`);

  printCounts('\nProvider target counts:', sourceProviders);
  printCounts('\nLocation fail reasons:', locationFailReasons);
  printCounts('\nLocation block keyword counts:', locationFailBlocked);
  printCounts('\nStack fail keyword counts:', stackFailKeywords);
  printCounts('\nHistory status counts for matched jobs:', historyStatuses);
  printCounts('\nBlocking history status counts for matched jobs:', blockingHistoryStatuses);

  printSamples('Matched jobs hidden by non-applied history status', nonAppliedHistory);
  printSamples('Matched jobs hidden by history', hiddenByHistory);
  printSamples('Matched jobs recheckable from expired/no-apply history', recheckableHistory);
  printSamples('Title-passed jobs rejected because location is missing', missingLocation);
  printSamples('Title-passed jobs rejected despite an allowed location keyword', blockedWithAllowHit);
  printSamples('Title-passed jobs rejected because no allowed location keyword matched', noAllowHit);
  printSamples('Location-passed jobs rejected by stack filter', stackFailed);
  printSamples('Stack-passed jobs rejected by freshness filter', freshnessFailed);
  printSamples('Actionable jobs after blocking dedup', actionableAfterBlocking);

  if (errors.length > 0) {
    console.log('\nProvider errors');
    for (const error of errors.slice(0, SAMPLE_LIMIT)) console.log(`  - ${error}`);
    if (errors.length > SAMPLE_LIMIT) console.log(`  ... and ${errors.length - SAMPLE_LIMIT} more`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
