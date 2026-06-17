// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Workday provider — hits the public CXS jobs endpoint behind many
// myworkdayjobs.com career sites.

const WORKDAY_HOST_RE = /^([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com$/i;
const LOCALE_RE = /^[a-z]{2}-[A-Z]{2}$/;
const MAX_JOBS_PER_BOARD = 500;
const PAGE_SIZE = 20;

function parseWorkdayUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  const hostMatch = parsed.hostname.match(WORKDAY_HOST_RE);
  if (!hostMatch) return null;

  const tenant = hostMatch[1];
  const parts = parsed.pathname.split('/').filter(Boolean);
  const site = parts.filter(part => !LOCALE_RE.test(part)).at(-1);
  if (!site) return null;

  return {
    origin: parsed.origin,
    tenant,
    site,
    apiUrl: `${parsed.origin}/wday/cxs/${tenant}/${site}/jobs`,
  };
}

function normalizeUrl(origin, site, externalPath) {
  if (!externalPath) return '';
  if (/^https?:\/\//i.test(externalPath)) return externalPath;

  const path = externalPath.startsWith('/') ? externalPath : `/${externalPath}`;
  const parts = path.split('/').filter(Boolean);
  const hasLocalePrefix = parts.length > 0 && LOCALE_RE.test(parts[0]);
  const firstSitePart = hasLocalePrefix ? parts[1] : parts[0];

  if (firstSitePart === site) return `${origin}${path}`;
  if (firstSitePart === 'job') {
    const localePrefix = hasLocalePrefix ? `/${parts[0]}` : '';
    const restPath = hasLocalePrefix ? path.slice(localePrefix.length) : path;
    return `${origin}${localePrefix}/${site}${restPath}`;
  }

  return `${origin}${path}`;
}

function normalizeLocation(job) {
  if (job.locationsText) return job.locationsText;
  if (typeof job.primaryLocation === 'string') return job.primaryLocation;
  if (job.primaryLocation?.descriptor) return job.primaryLocation.descriptor;
  if (Array.isArray(job.locations)) {
    return job.locations
      .map(location => location?.descriptor || location)
      .filter(Boolean)
      .join('; ');
  }
  return '';
}

function normalizeDescription(job) {
  return [
    ...(Array.isArray(job.bulletFields) ? job.bulletFields : []),
    job.summary,
    job.description,
  ].filter(Boolean).join('\n');
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

/** @type {Provider} */
export default {
  id: 'workday',

  detect(entry) {
    const hit = parseWorkdayUrl(entry.careers_url || '');
    return hit ? { url: hit.apiUrl } : null;
  },

  async fetch(entry, ctx) {
    const hit = parseWorkdayUrl(entry.careers_url || '');
    if (!hit) throw new Error(`workday: cannot derive CXS API URL for ${entry.name}`);

    const jobs = [];
    for (let offset = 0; offset < MAX_JOBS_PER_BOARD; offset += PAGE_SIZE) {
      const json = await ctx.fetchJson(hit.apiUrl, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          appliedFacets: entry.workday_facets || {},
          limit: PAGE_SIZE,
          offset,
          searchText: entry.search_text || '',
        }),
      });

      const pageJobs = Array.isArray(json?.jobPostings) ? json.jobPostings : [];
      jobs.push(...pageJobs);
      if (pageJobs.length < PAGE_SIZE) break;
    }

    return jobs.map(job => ({
      title: job.title || '',
      url: normalizeUrl(hit.origin, hit.site, job.externalPath || job.url),
      company: entry.name,
      location: normalizeLocation(job),
      postedOn: job.postedOn || '',
      postedAgeDays: parsePostedAgeDays(job.postedOn),
      description: normalizeDescription(job),
      department: job.jobFamily || '',
      team: job.jobFamilyGroup || '',
    })).filter(job => job.title && job.url);
  },
};
