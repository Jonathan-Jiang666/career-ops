#!/usr/bin/env node

/**
 * Daily career-ops scan.
 *
 * Runs the portal scanner, writes a compact summary, and sends a macOS
 * notification. It never submits applications or sends resumes.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const LOG_DIR = path.join(ROOT, 'batch', 'logs');
const SUMMARY_PATH = path.join(ROOT, 'data', 'daily-scan-summary.md');
const DAILY_MATCHES_DIR = path.join(ROOT, 'data', 'daily-matches');
const LATEST_MATCHES_PATH = path.join(DAILY_MATCHES_DIR, 'latest.txt');
const STATE_PATH = path.join(ROOT, 'data', 'daily-scan-state.json');
const PIPELINE_PATH = path.join(ROOT, 'data', 'pipeline.md');
const SCAN_HISTORY_PATH = path.join(ROOT, 'data', 'scan-history.tsv');
const DIALOG_PROJECT_TITLE = 'career-ops daily scan';
const DIALOG_OFFER_LIMIT = 5;
const DIALOG_LINE_MAX = 145;
const MAX_SCAN_ATTEMPTS = 3;
const RETRY_DELAY_SECONDS = 90;
const SCHEDULED_FIRST_RUN_DELAY_SECONDS = 120;

mkdirSync(LOG_DIR, { recursive: true });
mkdirSync(path.dirname(SUMMARY_PATH), { recursive: true });
mkdirSync(DAILY_MATCHES_DIR, { recursive: true });

const args = process.argv.slice(2);
const testDialog = args.includes('--test-dialog');
const dryRun = args.includes('--dry-run');
const noNotify = args.includes('--no-notify');
const noDialog = args.includes('--no-dialog');
const scheduledRun = args.includes('--scheduled');
const scanArgs = dryRun ? ['scan.mjs', '--dry-run'] : ['scan.mjs', '--verify'];
const triggerLabel = scheduledRun ? 'scheduled' : 'manual';

if (testDialog) {
  const testTitle = 'Scan preview';
  const testStamp = timestamp();
  const testOffers = [
    {
      company: 'fanaticsfbg',
      title: 'Platform Engineer III - Core Platform',
      location: 'Dublin, Ireland; Leeds, England, United Kingdom; London, England, United Kingdom',
    },
    { company: 'doit', title: 'Senior Software Engineer - PerfectScale by DoiT', location: 'Remote Ireland' },
    { company: 'openai', title: 'Software Engineer, Privacy', location: 'Dublin, Ireland' },
    { company: 'telnyx54', title: 'Senior Software Engineer, Java', location: 'Dublin, Ireland' },
    { company: 'telnyx54', title: 'Senior Software Engineer (Python)', location: 'Dublin, Ireland; Amsterdam, Netherlands' },
    { company: 'affinidi', title: 'Backend Engineer, Senior (Rust)', location: 'Dublin, Dublin, Ireland' },
    { company: 'astronomer', title: 'Staff Software Engineer, Platform Infrastructure', location: 'Ireland' },
  ];
  const testBody = buildDialogBody({
    added: testOffers.length,
    expired: 1,
    noApply: 0,
    invalid: 0,
    totalJobs: 56371,
    companiesScanned: 956,
    filteredTitle: 50539,
    filteredLocation: 5495,
    filteredStack: 203,
    filteredFreshness: 0,
    duplicates: 133,
    offers: testOffers,
    errors: ['Example scanner warning'],
    exitProblem: false,
  });

  if (!noNotify) notify(testTitle, 'Testing the daily scan dialog.');
  if (!noDialog) {
    const dialog = showDialog(testTitle, testBody, testStamp);
    console.log(`Dialog result: ${dialog.ok ? 'ok' : 'failed'} (${dialog.method})`);
    if (!dialog.ok) console.log(dialog.reason);
  }
  process.exit(0);
}

const stateBefore = readState();
const runDate = timestamp().slice(0, 10);

if (scheduledRun && stateBefore?.date === runDate && stateBefore?.status === 'ok') {
  console.log(`[scheduled] Skipping backup run: successful scan already completed today at ${stateBefore.stamp}.`);
  process.exit(0);
}

if (scheduledRun && stateBefore?.date !== runDate) {
  console.log(`[scheduled] Waiting ${SCHEDULED_FIRST_RUN_DELAY_SECONDS}s before scan so network can settle after wake.`);
  sleepSeconds(SCHEDULED_FIRST_RUN_DELAY_SECONDS);
}

const unseenAudit = runUnseenAudit(runDate);
const historyBefore = readLines(SCAN_HISTORY_PATH);
const attempts = [];

let attempt = runScanAttempt(scanArgs);
attempts.push(attempt);

while (!dryRun && attempts.length < MAX_SCAN_ATTEMPTS && isSystemicFetchFailure(attempt)) {
  appendFileSync(
    attempt.logPath,
    `\n[retry] Systemic fetch failure detected (${attempt.errorCount}/${attempt.companiesScanned} errors, ${attempt.totalJobs} jobs). Retrying in ${RETRY_DELAY_SECONDS}s...\n`,
    'utf8',
  );
  sleepSeconds(RETRY_DELAY_SECONDS);
  attempt = runScanAttempt(scanArgs, `-retry${attempts.length}`);
  attempts.push(attempt);
}

const finalAttempt = attempts[attempts.length - 1];
const retryNotes = summarizeRetryNotes(attempts);
const stamp = finalAttempt.stamp;
const logPath = finalAttempt.logPath;
const result = finalAttempt.result;
const output = finalAttempt.output;
const added = finalAttempt.added;
const expired = finalAttempt.expired;
const noApply = finalAttempt.noApply;
const invalid = finalAttempt.invalid;
const totalJobs = finalAttempt.totalJobs;
const companiesScanned = finalAttempt.companiesScanned;
const filteredTitle = finalAttempt.filteredTitle;
const filteredLocation = finalAttempt.filteredLocation;
const filteredStack = finalAttempt.filteredStack;
const filteredFreshness = finalAttempt.filteredFreshness;
const duplicates = finalAttempt.duplicates;
const historyAfter = readLines(SCAN_HISTORY_PATH);
const offers = dryRun
  ? parseNewOffers(output)
  : parseNewHistoryOffers(historyBefore, historyAfter);
const errors = finalAttempt.errors;
const datedMatchesPath = path.join(DAILY_MATCHES_DIR, `${stamp.slice(0, 10)}.txt`);
const matchesText = formatDailyMatchesText({
  stamp,
  trigger: triggerLabel,
  mode: dryRun ? 'dry-run preview' : 'verified scan',
  added,
  expired,
  noApply,
  invalid,
  totalJobs,
  companiesScanned,
  filteredTitle,
  filteredLocation,
  filteredStack,
  filteredFreshness,
  duplicates,
  offers,
  errors,
  logPath,
  notes: retryNotes,
  unseenAudit,
});
writeFileSync(datedMatchesPath, matchesText, 'utf8');
writeFileSync(LATEST_MATCHES_PATH, matchesText, 'utf8');

if (!existsSync(SUMMARY_PATH)) {
  writeFileSync(SUMMARY_PATH, '# Daily Scan Summary\n\n', 'utf8');
}

const summary = [
  `## ${stamp}`,
  '',
  `- Trigger: ${triggerLabel}`,
  `- Mode: ${dryRun ? 'dry-run preview' : 'verified scan'}`,
  `- Companies scanned: ${companiesScanned}`,
  `- Total jobs found: ${totalJobs}`,
  `- Filtered by title: ${filteredTitle}`,
  `- Filtered by location: ${filteredLocation}`,
  `- Filtered by stack: ${filteredStack}`,
  `- Filtered by freshness: ${filteredFreshness}`,
  `- Duplicates skipped: ${duplicates}`,
  `- New offers added: ${added}`,
  `- Expired dropped: ${expired}`,
  `- No-apply dropped: ${noApply}`,
  `- Invalid dropped: ${invalid}`,
  `- Log: ${path.relative(ROOT, logPath)}`,
  `- Pipeline: ${path.relative(ROOT, PIPELINE_PATH)}`,
  `- Raw clickable links: ${path.relative(ROOT, datedMatchesPath)}`,
  `- Unseen-before-history audit: ${formatUnseenAuditSummary(unseenAudit)}`,
  '',
  retryNotes.length > 0 ? '### Scan Notes' : '',
  ...retryNotes.map((note) => `- ${note}`),
  retryNotes.length > 0 ? '' : '',
  offers.length > 0 ? '### New Best Matches' : '### New Best Matches\n\nNone.',
  ...formatOfferTable(offers),
  '',
  offers.length > 0 ? '### Raw Links' : '',
  ...formatOfferLinks(offers),
  '',
  errors.length > 0 ? '### Scanner Errors' : '',
  ...errors.map((error) => `- ${error}`),
  errors.length > 0 ? '' : '',
].filter((line, index, arr) => line !== '' || arr[index - 1] !== '').join('\n') + '\n\n';

appendFileSync(SUMMARY_PATH, summary, 'utf8');

const systemicFailure = isSystemicFetchFailure(finalAttempt);
const exitProblem = Boolean((result.status && result.status !== 0) || systemicFailure || !unseenAudit.ok);
const title = exitProblem ? 'career-ops scan needs attention' : 'career-ops daily scan complete';
const body = exitProblem
  ? !unseenAudit.ok
    ? `Unseen-before-history audit failed. See ${path.relative(ROOT, unseenAudit.logPath)}.`
    : systemicFailure
    ? `Scanner-wide fetch failure detected after ${attempts.length} attempt${attempts.length === 1 ? '' : 's'}. See daily-scan-summary.md.`
    : `Scan exited with code ${result.status}. See daily-scan-summary.md.`
  : added > 0
    ? `${added} new verified offer${added === 1 ? '' : 's'} added. Please review before applying.`
    : 'No new verified offers today.';

if (!noNotify) {
  notify(title, body);
  if (!noDialog) {
    const dialog = showDialog(
      title,
      buildDialogBody({
        added,
        expired,
        noApply,
        invalid,
        totalJobs,
        companiesScanned,
        filteredTitle,
        filteredLocation,
        filteredStack,
        filteredFreshness,
        duplicates,
        offers,
        errors,
        exitProblem,
        issueSummary: systemicFailure
          ? `Scanner-wide fetch failure after ${attempts.length} attempt${attempts.length === 1 ? '' : 's'}.`
          : !unseenAudit.ok
          ? 'Unseen-before-history audit failed.'
          : '',
      }),
      stamp,
    );
    if (!dialog.ok) {
      appendFileSync(
        logPath,
        `\n[dialog] Topmost dialog failed; fallback result: ${dialog.reason}\n`,
        'utf8',
      );
    }
  }
}

writeState({
  date: stamp.slice(0, 10),
  stamp,
  trigger: triggerLabel,
  status: exitProblem ? 'needs_attention' : 'ok',
  added,
  expired,
  noApply,
  invalid,
  totalJobs,
  companiesScanned,
  filteredTitle,
  filteredLocation,
  filteredStack,
  filteredFreshness,
  duplicates,
  warnings: errors.length,
  attempts: attempts.length,
  unseenAuditOk: unseenAudit.ok,
  unseenBeforeHistory: unseenAudit.unseen,
});

console.log(summary);
if (exitProblem) process.exit(result.status || 2);

function parseCount(text, regex) {
  const match = text.match(regex);
  return match ? Number(match[1]) : 0;
}

function parseNewOffers(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim() === 'New offers:');
  if (start === -1) return [];

  const out = [];
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (out.length > 0) break;
      continue;
    }
    if (!trimmed.startsWith('+ ')) break;
    out.push(parseConsoleOffer(trimmed.slice(2)));
  }
  return out.filter(Boolean);
}

function parseNewHistoryOffers(beforeLines, afterLines) {
  const appended = afterLines.slice(beforeLines.length);
  return appended
    .map(parseScanHistoryLine)
    .filter((offer) => offer && offer.status === 'added');
}

function parseScanHistoryLine(line) {
  const [url, firstSeen, portal, title, company, status, location] = line.split('\t');
  if (!url || url === 'url') return null;
  return { url, firstSeen, portal, title, company, status, location };
}

function parseConsoleOffer(line) {
  const parts = line.split('|').map((part) => part.trim());
  if (parts.length < 2) return null;
  return {
    company: parts[0],
    title: parts[1],
    location: parts.slice(2).join(' | '),
    url: '',
    status: 'preview',
  };
}

function formatOfferTable(offers) {
  if (offers.length === 0) return [];
  return [
    '| Company | Role | Location | JD Link | URL |',
    '|---|---|---|---|---|',
    ...offers.map((offer) => {
      const role = offer.url
        ? `[${escapeTable(offer.title)}](${offer.url})`
        : escapeTable(offer.title);
      const jdLink = offer.url ? `[Open JD](${offer.url})` : 'Preview only';
      const rawUrl = offer.url ? `<${offer.url}>` : '';
      return `| ${escapeTable(offer.company)} | ${role} | ${escapeTable(offer.location || '')} | ${jdLink} | ${rawUrl} |`;
    }),
  ];
}

function formatOfferLinks(offers) {
  if (offers.length === 0) return [];
  return offers.flatMap((offer, index) => [
    `${index + 1}. ${offer.company} - ${offer.title}`,
    offer.url || 'Preview only',
    '',
  ]);
}

function formatDailyMatchesText({
  stamp,
  trigger,
  mode,
  added,
  expired,
  noApply,
  invalid,
  totalJobs,
  companiesScanned,
  filteredTitle,
  filteredLocation,
  filteredStack,
  filteredFreshness,
  duplicates,
  offers,
  errors,
  logPath,
  notes = [],
  unseenAudit = null,
}) {
  const lines = [
    `career-ops daily scan - ${stamp} Europe/Dublin`,
    `Trigger: ${trigger}`,
    `Mode: ${mode}`,
    `Companies scanned: ${companiesScanned}`,
    `Total jobs found: ${totalJobs}`,
    `Filtered: title ${filteredTitle}, location ${filteredLocation}, stack ${filteredStack}, freshness ${filteredFreshness}, duplicates ${duplicates}`,
    `New offers added: ${added}`,
    `Dropped: ${expired + noApply + invalid} (expired ${expired}, no-apply ${noApply}, invalid ${invalid})`,
    `Log: ${path.relative(ROOT, logPath)}`,
  ];

  if (unseenAudit) lines.push(`Unseen-before-history audit: ${formatUnseenAuditSummary(unseenAudit)}`);
  lines.push('');

  notes.forEach((note) => lines.push(`Note: ${note}`));
  if (notes.length > 0) lines.push('');

  if (offers.length === 0) {
    lines.push('Scan completed successfully, but no new matching offers remained after filtering, dedup, and verification.');
  } else {
    lines.push('New matching offers');
    lines.push('');
    offers.forEach((offer, index) => {
      lines.push(`${index + 1}. ${offer.company} | ${offer.title}`);
      if (offer.location) lines.push(`Location: ${offer.location}`);
      if (offer.url) lines.push(offer.url);
      lines.push('');
    });
  }

  if (errors.length > 0) {
    lines.push('Scanner warnings');
    lines.push('');
    errors.forEach((error) => lines.push(`- ${error}`));
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

function escapeTable(value) {
  return String(value ?? '').replace(/\|/g, '\\|').trim();
}

function readLines(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
}

function readState() {
  if (!existsSync(STATE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function writeState(state) {
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function parseErrors(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => /^Errors \(\d+\):/.test(line.trim()));
  if (start === -1) return [];

  const out = [];
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (out.length > 0) break;
      continue;
    }
    if (!trimmed.startsWith('✗') && !trimmed.startsWith('x')) break;
    out.push(trimmed.replace(/^✗\s*/, ''));
  }
  return out;
}

function timestamp() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Dublin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date());

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

function notify(titleText, bodyText) {
  const script = `display notification ${appleQuote(bodyText)} with title ${appleQuote(titleText)}`;
  spawnSync('/usr/bin/osascript', ['-e', script], {
    encoding: 'utf8',
    timeout: 5000,
  });
}

function showDialog(titleText, bodyText, scanStamp = '') {
  const topmost = showTopmostDialog(titleText, bodyText, scanStamp);
  if (topmost.ok) return topmost;

  const fallbackBody = [
    scanStamp ? `${DIALOG_PROJECT_TITLE}\nScanned: ${scanStamp} Europe/Dublin` : DIALOG_PROJECT_TITLE,
    '',
    bodyText,
  ].join('\n');

  const fallback = [
    'try',
    '  tell application "SystemUIServer"',
    '    activate',
    `    display dialog ${appleQuote(fallbackBody)} with title ${appleQuote(titleText)} buttons {"OK"} default button "OK" with icon note`,
    '  end tell',
    'on error',
    '  tell application "System Events"',
    '    activate',
    `    display dialog ${appleQuote(fallbackBody)} with title ${appleQuote(titleText)} buttons {"OK"} default button "OK" with icon note`,
    '  end tell',
    'end try',
  ].join('\n');

  const result = spawnSync('/usr/bin/osascript', ['-e', fallback], {
    encoding: 'utf8',
  });
  return result.status === 0
    ? { ok: true, method: 'applescript-fallback' }
    : { ok: false, method: 'applescript-fallback', reason: summarizeSpawnFailure(result, topmost) };
}

function showTopmostDialog(titleText, bodyText, scanStamp) {
  const script = `
ObjC.import('Cocoa');

function run(argv) {
  const title = argv[0] || 'career-ops daily scan complete';
  const body = argv[1] || '';
  const scanStamp = argv[2] || '';

  const app = $.NSApplication.sharedApplication;
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);

  const alert = $.NSAlert.alloc.init;
  alert.messageText = '';
  alert.informativeText = '';
  alert.alertStyle = $.NSWarningAlertStyle;
  alert.icon = $.NSImage.imageNamed($.NSImageNameCaution);
  alert.addButtonWithTitle('OK');

  const heading = 'career-ops daily scan';
  const dateLine = scanStamp ? 'Scanned: ' + scanStamp + ' Europe/Dublin' : 'Manual preview';
  const helperLine = 'Review before applying. Click OK to close.';
  const fullText = heading + '\\n' + dateLine + '\\n' + helperLine + '\\n\\n' + body;
  const width = 880;
  const lineCount = Math.max(8, fullText.split('\\n').length);
  const height = Math.min(340, Math.max(230, lineCount * 18 + 68));
  const view = $.NSView.alloc.initWithFrame($.NSMakeRect(0, 0, width, height));

  const text = $.NSTextView.alloc.initWithFrame($.NSMakeRect(0, 0, width, height));
  const headingRange = $.NSMakeRange(0, heading.length);
  const metaStart = heading.length + 1;
  const metaRange = $.NSMakeRange(metaStart, dateLine.length + 1 + helperLine.length);
  text.string = fullText;
  text.font = $.NSFont.systemFontOfSize(14);
  text.textColor = $.NSColor.labelColor;
  text.setFontRange($.NSFont.boldSystemFontOfSize(24), headingRange);
  text.setFontRange($.NSFont.systemFontOfSize(13), metaRange);
  text.setTextColorRange($.NSColor.secondaryLabelColor, metaRange);
  text.editable = false;
  text.selectable = true;
  text.drawsBackground = false;
  text.textContainerInset = $.NSMakeSize(0, 0);
  text.textContainer.lineFragmentPadding = 0;
  view.addSubview(text);

  alert.accessoryView = view;

  const window = alert.window;
  window.setLevel($.NSStatusWindowLevel);
  window.setCollectionBehavior(
    $.NSWindowCollectionBehaviorCanJoinAllSpaces |
    $.NSWindowCollectionBehaviorFullScreenAuxiliary
  );
  window.center;

  app.activateIgnoringOtherApps(true);
  window.makeKeyAndOrderFront(null);
  alert.runModal;
}
`;

  const result = spawnSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script, titleText, bodyText, scanStamp], {
    encoding: 'utf8',
  });

  return result.status === 0
    ? { ok: true, method: 'jxa-nsalert' }
    : { ok: false, method: 'jxa-nsalert', reason: summarizeSpawnFailure(result) };
}

function buildDialogBody({
  added,
  expired,
  noApply,
  invalid,
  totalJobs,
  companiesScanned,
  filteredTitle,
  filteredLocation,
  filteredStack,
  filteredFreshness,
  duplicates,
  offers,
  errors,
  exitProblem,
  issueSummary = '',
}) {
  if (exitProblem) {
    return [
      issueSummary || 'Daily scan finished with an error.',
      '',
      'Open data/daily-scan-summary.md and batch/logs for details.',
    ].join('\n');
  }

  const lines = [
    `Scanned: ${companiesScanned} companies / ${totalJobs} jobs`,
    `Filtered: title ${filteredTitle}, location ${filteredLocation}, stack ${filteredStack}, freshness ${filteredFreshness}, duplicates ${duplicates}`,
    '',
    `New verified offers: ${added}`,
    `Dropped: ${expired + noApply + invalid}`,
    '',
  ];

  if (offers.length === 0) {
    lines.push('Scan completed successfully, but no new matching offers remained.');
  } else {
    lines.push('New offers:');
    lines.push(...offers.slice(0, DIALOG_OFFER_LIMIT).map((offer) => `- ${compactLine(plainOffer(offer), DIALOG_LINE_MAX)}`));
    if (offers.length > DIALOG_OFFER_LIMIT) lines.push(`- ... and ${offers.length - DIALOG_OFFER_LIMIT} more`);
    lines.push('');
    lines.push('Open data/daily-matches/latest.txt for raw links.');
  }

  if (errors.length > 0) {
    lines.push('');
    lines.push(`Scanner warnings: ${errors.length}`);
  }

  return lines.join('\n');
}

function plainOffer(offer) {
  const location = offer.location ? ` - ${offer.location}` : '';
  return `${offer.company} - ${offer.title}${location}`;
}

function compactLine(value, maxLength) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function appleQuote(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function summarizeSpawnFailure(result, prior) {
  const parts = [];
  if (prior?.reason) parts.push(`topmost: ${prior.reason}`);
  if (result.error) parts.push(result.error.message);
  if (result.stderr) parts.push(result.stderr.trim());
  if (result.stdout) parts.push(result.stdout.trim());
  if (typeof result.status === 'number') parts.push(`exit ${result.status}`);
  return parts.filter(Boolean).join(' | ') || 'unknown error';
}

function runScanAttempt(scanArgs, suffix = '') {
  const stamp = timestamp();
  const logPath = path.join(LOG_DIR, `daily-scan-${stamp.replace(/[: ]/g, '-')}${suffix}.log`);
  const result = spawnSync(process.execPath, scanArgs, {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      FORCE_COLOR: '0',
    },
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
  writeFileSync(logPath, output, 'utf8');

  return {
    stamp,
    logPath,
    result,
    output,
    added: parseCount(output, /New offers added:\s+(\d+)/),
    expired: parseCount(output, /Expired \(verified\):\s+(\d+)/),
    noApply: parseCount(output, /No apply control:\s+(\d+)/),
    invalid: parseCount(output, /Invalid \(guarded\):\s+(\d+)/),
    totalJobs: parseCount(output, /Total jobs found:\s+(\d+)/),
    companiesScanned: parseCount(output, /Companies scanned:\s+(\d+)/),
    filteredTitle: parseCount(output, /Filtered by title:\s+(\d+)/),
    filteredLocation: parseCount(output, /Filtered by location:\s+(\d+)/),
    filteredStack: parseCount(output, /Filtered by stack:\s+(\d+)/),
    filteredFreshness: parseCount(output, /Filtered by freshness:\s+(\d+)/),
    duplicates: parseCount(output, /Duplicates:\s+(\d+)/),
    errorCount: parseCount(output, /Errors \((\d+)\):/),
    errors: parseErrors(output),
  };
}

function runUnseenAudit(date) {
  const stamp = timestamp();
  const logPath = path.join(LOG_DIR, `unseen-audit-${stamp.replace(/[: ]/g, '-')}-${date}.log`);
  const reportPath = path.join(DAILY_MATCHES_DIR, `unseen-matched-${date}.md`);
  const result = spawnSync(process.execPath, ['automation/export-unseen-matches.mjs', '--date', date], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      FORCE_COLOR: '0',
    },
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
  writeFileSync(logPath, output, 'utf8');

  return {
    ok: result.status === 0,
    logPath,
    reportPath,
    matchedBeforeHistory: parseCount(output, /Matched before history exclusion:\s+(\d+)/),
    alreadyInHistory: parseCount(output, /Already in history:\s+(\d+)/),
    unseen: parseCount(output, /Unseen matched offers:\s+(\d+)/),
    providerErrors: parseCount(output, /Provider errors:\s+(\d+)/),
  };
}

function formatUnseenAuditSummary(audit) {
  if (!audit) return 'not run';
  if (!audit.ok) return `failed (${path.relative(ROOT, audit.logPath)})`;
  const providerNote = audit.providerErrors > 0 ? `; provider errors ${audit.providerErrors}` : '';
  return `${audit.unseen} unseen before history update${providerNote} (${path.relative(ROOT, audit.reportPath)})`;
}

function isSystemicFetchFailure(attempt) {
  if (!attempt || attempt.result?.status) return false;
  if (attempt.companiesScanned < 100) return false;
  return attempt.totalJobs === 0 && attempt.errorCount >= Math.max(100, Math.floor(attempt.companiesScanned * 0.8));
}

function summarizeRetryNotes(attempts) {
  if (attempts.length <= 1) return [];

  const retried = attempts.length - 1;
  const finalAttempt = attempts[attempts.length - 1];
  const notes = [
    `Automatic retry engaged after scanner-wide fetch failure. Retries used: ${retried}.`,
  ];

  if (isSystemicFetchFailure(finalAttempt)) {
    notes.push(`All ${attempts.length} attempts ended with 0 jobs and ${finalAttempt.errorCount} scanner warnings.`);
  } else {
    notes.push(`Latest attempt recovered and produced ${finalAttempt.totalJobs} total jobs before filtering.`);
  }

  return notes;
}

function sleepSeconds(seconds) {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
}
