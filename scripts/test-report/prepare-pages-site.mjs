/**
 * Merge a generated test-health report into a Pages site tree.
 *
 * Usage:
 *   node scripts/test-report/prepare-pages-site.mjs \
 *     --report dist/test-report \
 *     --site site \
 *     --slot main
 *
 * Copies report files to site/test-report/<slot>/ and writes a small landing
 * page at site/index.html that links known slots (main + nightly).
 *
 * With --date (and optionally --run-id), the report is ALSO archived into a
 * dated run slot at site/test-report/<slot>/runs/<date>-<runId>/ and this
 * run's summary.json is appended to an append-only JSON series under
 * site/test-report/history/. The plain <slot>/ path keeps serving the newest
 * report so already-published URLs never break. Dated slots are pruned to
 * --keep (default 30) most recent; the JSON series is never pruned.
 */
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const flags = parseFlags(process.argv.slice(2));
const reportDir = path.resolve(flags.report ?? path.join(root, 'dist/test-report'));
const siteDir = path.resolve(flags.site ?? path.join(root, 'site'));
const slot = String(flags.slot ?? 'latest').replace(/^\/+|\/+$/g, '');
const runDate = normalizeDate(flags.date);
const runId = sanitizeSegment(flags['run-id'] ?? '');
const runUrl = String(flags['run-url'] ?? '');
const keep = Math.max(1, Number(flags.keep ?? 30) || 30);

if (!slot || slot.includes('..')) {
  console.error(`invalid --slot: ${flags.slot}`);
  process.exit(1);
}
if (flags.date && !runDate) {
  console.error(`invalid --date (want YYYY-MM-DD): ${flags.date}`);
  process.exit(1);
}

const runSlug = runDate ? (runId ? `${runDate}-${runId}` : runDate) : null;
const dest = path.join(siteDir, 'test-report', slot);
await mkdir(dest, { recursive: true });
await cp(reportDir, dest, { recursive: true });

let archived = null;
let series = [];
if (runSlug) {
  archived = path.join(dest, 'runs', runSlug);
  await rm(archived, { recursive: true, force: true });
  await mkdir(archived, { recursive: true });
  await cp(reportDir, archived, { recursive: true });
  series = await appendSeries({
    historyDir: path.join(siteDir, 'test-report', 'history'),
    summary: await readJson(path.join(reportDir, 'summary.json'), null),
    slug: runSlug,
    date: runDate,
    runId,
    runUrl,
    reportPath: `test-report/${slot}/runs/${runSlug}/`,
  });
  const pruned = await pruneRuns(path.join(dest, 'runs'), keep);
  if (pruned.length)
    console.log(`pages site: pruned ${pruned.length} dated slot(s) beyond ${keep}`);
} else {
  const index = await readJson(path.join(siteDir, 'test-report', 'history', 'index.json'), {});
  series = Array.isArray(index?.entries) ? index.entries : [];
}

// Pages must not run Jekyll (underscored dirs / raw HTML).
await writeFile(path.join(siteDir, '.nojekyll'), '', 'utf8');

const slots = await listSlots(path.join(siteDir, 'test-report'));
const landing = renderLanding(slots, {
  repo: process.env.GITHUB_REPOSITORY ?? 'centraid',
  generatedAt: new Date().toISOString(),
  highlight: slot,
  series,
  // Link only the dated slots whose HTML actually survives pruning.
  retained: await retainedSlugs(series),
});
await writeFile(path.join(siteDir, 'index.html'), landing, 'utf8');

console.log(`pages site: slot=test-report/${slot} → ${path.relative(root, dest)}`);
if (archived) console.log(`pages site: archived run → ${path.relative(root, archived)}`);
console.log(
  `pages site: landing lists ${slots.length} slot(s), ${series.length} history entr(ies)`,
);

/** Append this run to the durable JSON series; never drops earlier entries. */
async function appendSeries({ historyDir, summary, slug, date, runId, runUrl, reportPath }) {
  await mkdir(historyDir, { recursive: true });
  const entryPath = path.join(historyDir, `${slug}.json`);
  const record = {
    slug,
    date,
    runId: runId || null,
    runUrl: runUrl || null,
    reportPath,
    summary: summary ?? null,
  };
  await writeFile(entryPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');

  const files = (await readdir(historyDir).catch(() => []))
    .filter((file) => file.endsWith('.json') && file !== 'index.json')
    .sort();
  const entries = [];
  for (const file of files) {
    const loaded = await readJson(path.join(historyDir, file), null);
    if (loaded?.slug) entries.push(summarizeEntry(loaded));
  }
  entries.sort((a, b) => (a.slug < b.slug ? 1 : a.slug > b.slug ? -1 : 0));
  await writeFile(
    path.join(historyDir, 'index.json'),
    `${JSON.stringify({ updatedAt: new Date().toISOString(), entries }, null, 2)}\n`,
    'utf8',
  );
  return entries;
}

function summarizeEntry(record) {
  const s = record.summary ?? {};
  return {
    slug: record.slug,
    date: record.date ?? String(record.slug).slice(0, 10),
    runId: record.runId ?? null,
    runUrl: record.runUrl ?? null,
    reportPath: record.reportPath ?? null,
    generatedAt: s.generatedAt ?? null,
    passed: numberOrNull(s.passed),
    failed: numberOrNull(s.failed),
    skipped: numberOrNull(s.skipped),
    stale: numberOrNull(s.stale),
    cellsFailed: numberOrNull(s.cellsFailed),
    cellsMissing: numberOrNull(s.cellsMissing),
    unhandledErrors: numberOrNull(s.unhandledErrors),
  };
}

/** Series entries whose archived HTML is still on disk (the rest were pruned). */
async function retainedSlugs(series) {
  const kept = new Set();
  for (const entry of Array.isArray(series) ? series : []) {
    if (!entry?.reportPath) continue;
    try {
      await stat(path.join(siteDir, entry.reportPath, 'index.html'));
      kept.add(entry.slug);
    } catch {
      // pruned
    }
  }
  return kept;
}

/** Keep the `keep` newest dated slots; older HTML is dropped (JSON series stays). */
async function pruneRuns(runsDir, keep) {
  const entries = (await readdir(runsDir, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .toReversed();
  const stale = entries.slice(keep);
  for (const name of stale) await rm(path.join(runsDir, name), { recursive: true, force: true });
  return stale;
}

async function listSlots(base) {
  const found = [];
  async function walk(dir, prefix) {
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // Dated archives and the JSON series are listed from the history index.
      if (!prefix && entry.name === 'history') continue;
      if (entry.name === 'runs') continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const indexPath = path.join(dir, entry.name, 'index.html');
      try {
        await stat(indexPath);
        found.push(rel);
      } catch {
        await walk(path.join(dir, entry.name), rel);
      }
    }
  }
  await walk(base, '');
  return found.sort();
}

function renderLanding(slots, { repo, generatedAt, highlight, series, retained }) {
  const items = slots
    .map((s) => {
      const href = `test-report/${s}/`;
      const label = s === highlight ? `${s} (this deploy)` : s;
      return `<li><a href="${href}">${escapeHtml(label)}</a></li>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Centraid test health reports</title>
  <style>
    body { font: 16px/1.5 system-ui, sans-serif; max-width: 44rem; margin: 2rem auto; padding: 0 1rem; color: #111; }
    h1 { font-size: 1.35rem; }
    h2 { font-size: 1.05rem; margin: 1.6rem 0 0.4rem; }
    h3 { font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.04em; color: #555; margin: 1rem 0 0.3rem; }
    a { color: #0b57d0; }
    .meta { color: #555; font-size: 0.9rem; }
    ul { margin: 0.3rem 0; padding-left: 1.2rem; }
    li { margin: 0.15rem 0; }
    .tag { font-size: 0.8rem; border-radius: 999px; padding: 0 0.45rem; margin-left: 0.35rem; }
    .ok { background: #e6f4ea; color: #137333; }
    .bad { background: #fce8e6; color: #a50e0e; }
  </style>
</head>
<body>
  <h1>Centraid test health reports</h1>
  <p class="meta">${escapeHtml(repo)} · updated ${escapeHtml(generatedAt)}</p>
  <p>Public reports publish from <code>main</code> and the nightly e2e workflow only.</p>
  <h2>Latest</h2>
  <ul>
${items || '    <li><em>No reports published yet.</em></li>'}
  </ul>
${renderHistory(series, retained)}
</body>
</html>
`;
}

function renderHistory(series, retained) {
  const entries = Array.isArray(series) ? series : [];
  if (!entries.length) return '';
  const groups = new Map();
  for (const entry of entries) {
    const month = String(entry.date ?? entry.slug ?? '').slice(0, 7) || 'unknown';
    if (!groups.has(month)) groups.set(month, []);
    groups.get(month).push(entry);
  }
  const blocks = [...groups.entries()].map(([month, rows]) => {
    const list = rows
      .map((entry) => {
        const failed = Number(entry.failed ?? 0) + Number(entry.cellsFailed ?? 0);
        const badge = Number.isFinite(failed)
          ? failed > 0
            ? `<span class="tag bad">${failed} failing</span>`
            : '<span class="tag ok">green</span>'
          : '';
        const label = escapeHtml(entry.slug ?? entry.date ?? 'run');
        const body =
          entry.reportPath && retained.has(entry.slug)
            ? `<a href="${escapeHtml(entry.reportPath)}">${label}</a>`
            : `${label} <span class="meta">(HTML pruned)</span>`;
        const run = entry.runUrl
          ? ` <a class="meta" href="${escapeHtml(entry.runUrl)}">run</a>`
          : '';
        return `      <li>${body}${badge}${run}</li>`;
      })
      .join('\n');
    return `    <h3>${escapeHtml(month)}</h3>\n    <ul>\n${list}\n    </ul>`;
  });
  return `  <h2>Nightly history</h2>
  <p class="meta">Newest first · HTML kept for the most recent runs only (${entries.filter((entry) => retained.has(entry.slug)).length} of ${entries.length}) · full series: <a href="test-report/history/index.json">history/index.json</a></p>
${blocks.join('\n')}`;
}

function numberOrNull(value) {
  if (value == null || value === '' || !Number.isFinite(Number(value))) return null;
  return Number(value);
}

function normalizeDate(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(text);
  return match ? match[1] : null;
}

function sanitizeSegment(value) {
  return String(value ?? '')
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, '');
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function parseFlags(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (!current.startsWith('--')) continue;
    result[current.slice(2)] = args[index + 1];
    index += 1;
  }
  return result;
}
