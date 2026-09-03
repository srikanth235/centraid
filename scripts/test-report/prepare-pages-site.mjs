import {
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { designSystemCss } from "./report-theme.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const flags = parseFlags(process.argv.slice(2));
const reportDir = path.resolve(
  flags.report ?? path.join(root, "dist/test-report")
);
const siteDir = path.resolve(flags.site ?? path.join(root, "site"));
const slot = String(flags.slot ?? "latest").replace(/^\/+|\/+$/gu, "");
const runDate = normalizeDate(flags.date);
const runId = sanitizeSegment(flags["run-id"] ?? "");
const runUrl = String(flags["run-url"] ?? "");
const keep = Math.max(1, Number(flags.keep ?? 30) || 30);
const evidenceDir = flags.evidence
  ? path.resolve(flags.evidence)
  : path.join(root, "artifacts/evidence");

if (!slot || slot.includes("..")) {
  console.error(`invalid --slot: ${flags.slot}`);
  process.exit(1);
}
if (flags.date && !runDate) {
  console.error(`invalid --date (want YYYY-MM-DD): ${flags.date}`);
  process.exit(1);
}

const runSlug = runDate ? (runId ? `${runDate}-${runId}` : runDate) : null;
const dest = path.join(siteDir, "test-report", slot);
await mkdir(dest, { recursive: true });
await cp(reportDir, dest, { recursive: true });

if (slot === "main") {
  await ensureMainScopeBanner(path.join(dest, "index.html"));
}

let archived = null;
let series = [];
if (runSlug) {
  archived = path.join(dest, "runs", runSlug);
  await rm(archived, { recursive: true, force: true });
  await mkdir(archived, { recursive: true });
  await cp(reportDir, archived, { recursive: true });
  await cp(evidenceDir, path.join(archived, "evidence"), {
    recursive: true,
  }).catch(() => {});
  series = await appendSeries({
    historyDir: path.join(siteDir, "test-report", "history"),
    summary: await readJson(path.join(reportDir, "summary.json"), null),
    slug: runSlug,
    date: runDate,
    runId,
    runUrl,
    reportPath: `test-report/${slot}/runs/${runSlug}/`,
  });
  const pruned = await pruneRuns(path.join(dest, "runs"), keep);
  if (pruned.length)
    console.log(
      `pages site: pruned ${pruned.length} dated slot(s) beyond ${keep}`
    );
} else {
  const index = await readJson(
    path.join(siteDir, "test-report", "history", "index.json"),
    {}
  );
  series = Array.isArray(index?.entries) ? index.entries : [];
}

await writeFile(path.join(siteDir, ".nojekyll"), "", "utf8");

const slots = await listSlots(path.join(siteDir, "test-report"));
const landing = renderLanding(slots, {
  repo: process.env.GITHUB_REPOSITORY ?? "centraid",
  generatedAt: new Date().toISOString(),
  highlight: slot,
  series,
  retained: await retainedSlugs(series),
});
await writeFile(path.join(siteDir, "index.html"), landing, "utf8");

console.log(
  `pages site: slot=test-report/${slot} → ${path.relative(root, dest)}`
);
if (archived)
  console.log(`pages site: archived run → ${path.relative(root, archived)}`);
console.log(
  `pages site: landing lists ${slots.length} slot(s), ${series.length} history entr(ies)`
);

async function appendSeries({
  historyDir,
  summary,
  slug,
  date,
  runIdLocal,
  runUrlLocal,
  reportPath,
}) {
  await mkdir(historyDir, { recursive: true });
  const entryPath = path.join(historyDir, `${slug}.json`);
  const record = {
    slug,
    date,
    runId: runIdLocal || null,
    runUrl: runUrlLocal || null,
    reportPath,
    summary: summary ?? null,
  };
  await writeFile(entryPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");

  const files = (await readdir(historyDir).catch(() => []))
    .filter((file) => file.endsWith(".json") && file !== "index.json")
    .sort();
  const entries = (
    await Promise.all(
      files.map((file) => readJson(path.join(historyDir, file), null))
    )
  )
    .filter((loaded) => loaded?.slug)
    .map((loaded) => summarizeEntry(loaded));
  entries.sort((a, b) => (a.slug < b.slug ? 1 : a.slug > b.slug ? -1 : 0));
  await writeFile(
    path.join(historyDir, "index.json"),
    `${JSON.stringify({ updatedAt: new Date().toISOString(), entries }, null, 2)}\n`,
    "utf8"
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

async function retainedSlugs(seriesLocal) {
  const kept = new Set();
  await Promise.all(
    (Array.isArray(seriesLocal) ? seriesLocal : []).map(async (entry) => {
      if (!entry?.reportPath) return;
      try {
        await stat(path.join(siteDir, entry.reportPath, "index.html"));
        kept.add(entry.slug);
      } catch {
        // Intentionally empty.
      }
    })
  );
  return kept;
}

async function pruneRuns(runsDir, keepLocal) {
  const entries = (
    await readdir(runsDir, { withFileTypes: true }).catch(() => [])
  )
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .toReversed();
  const stale = entries.slice(keepLocal);
  await Promise.all(
    stale.map((name) =>
      rm(path.join(runsDir, name), { recursive: true, force: true })
    )
  );
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
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isDirectory()) return;
        if (!prefix && entry.name === "history") return;
        if (entry.name === "runs") return;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        const indexPath = path.join(dir, entry.name, "index.html");
        try {
          await stat(indexPath);
          found.push(rel);
        } catch {
          await walk(path.join(dir, entry.name), rel);
        }
      })
    );
  }
  await walk(base, "");
  return found.sort();
}

function renderLanding(
  slotsLocal,
  { repo, generatedAt, highlight, seriesLocal, retained }
) {
  const items = slotsLocal
    .map((s) => {
      const href = `test-report/${s}/`;
      const label = s === highlight ? `${s} (this deploy)` : s;
      return `<li><a href="${href}">${escapeHtml(label)}</a></li>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Centraid test health reports</title>
  <style>
${designSystemCss()}
    body { font: var(--t-reading); max-width: 44rem; margin: var(--sp-6) auto; padding: 0 var(--page-margin); background: var(--bg); color: var(--text); }
    h1 { font: var(--t-title); letter-spacing: var(--t-title-tracking); }
    h2 { font: var(--t-small-strong); margin: var(--sp-5) 0 var(--sp-1); }
    h3 { font: var(--t-eyebrow); text-transform: var(--t-eyebrow-transform); letter-spacing: var(--t-eyebrow-tracking); color: var(--text-soft); margin: var(--sp-4) 0 var(--sp-1); }
    a { color: var(--link); }
    .meta { color: var(--text-soft); font: var(--t-annot-label); }
    ul { margin: var(--sp-1) 0; padding-left: var(--sp-5); }
    li { margin: 2px 0; }
    /* A run's outcome. The --st-* rung names the state; the tag is a chip, so
       the tone is a border and a label rather than the filled ground a status
       colour is never allowed to become. */
    .tag { font: var(--t-control); border-radius: var(--r-pill); border: 1px solid currentcolor; padding: 0 var(--sp-2); margin-left: var(--sp-1); }
    .ok { color: var(--st-solid-text); }
    .bad { color: var(--st-failed-text); }
  </style>
</head>
<body>
  <h1>Centraid test health reports</h1>
  <p class="meta">${escapeHtml(repo)} · updated ${escapeHtml(generatedAt)}</p>
  <p>Public reports publish from <code>main</code> (per-merge CI) and the <strong>nightly</strong> e2e workflow only — <strong>no PR slots</strong>.</p>
  <h2>What “solid” means</h2>
  <p class="meta">A matrix cell is <strong>solid</strong> only when an owning test exists, runs in the intended lane (per-PR or nightly), and is not whole-file env-gated off default CI. Grey / missing cells are intentional: absence of proof must stay visible. See TESTING.md (Nightly SLA, floors ratchet, confidence map) and issue #496.</p>
  <h2>Slots</h2>
  <ul>
    <li><code>main</code> — last green merge on main (CI verify report)</li>
    <li><code>nightly</code> — full product lanes (desktop/web/mobile/pairing + perf/scale)</li>
  </ul>
  <h2>Latest</h2>
  <ul>
${items || "    <li><em>No reports published yet.</em></li>"}
  </ul>
${renderHistory(seriesLocal, retained)}
</body>
</html>
`;
}

function renderHistory(seriesLocal, retained) {
  const entries = Array.isArray(seriesLocal) ? seriesLocal : [];
  if (!entries.length) return "";
  const groups = new Map();
  for (const entry of entries) {
    const month =
      String(entry.date ?? entry.slug ?? "").slice(0, 7) || "unknown";
    if (!groups.has(month)) groups.set(month, []);
    groups.get(month).push(entry);
  }
  const blocks = [...groups.entries()].map(([month, rows]) => {
    const list = rows
      .map((entry) => {
        const failed =
          Number(entry.failed ?? 0) + Number(entry.cellsFailed ?? 0);
        const badge = Number.isFinite(failed)
          ? failed > 0
            ? `<span class="tag bad">${failed} failing</span>`
            : '<span class="tag ok">green</span>'
          : "";
        const label = escapeHtml(entry.slug ?? entry.date ?? "run");
        const body =
          entry.reportPath && retained.has(entry.slug)
            ? `<a href="${escapeHtml(entry.reportPath)}">${label}</a>`
            : `${label} <span class="meta">(HTML pruned)</span>`;
        const run = entry.runUrl
          ? ` <a class="meta" href="${escapeHtml(entry.runUrl)}">run</a>`
          : "";
        return `      <li>${body}${badge}${run}</li>`;
      })
      .join("\n");
    return `    <h3>${escapeHtml(month)}</h3>\n    <ul>\n${list}\n    </ul>`;
  });
  return `  <h2>Nightly history</h2>
  <p class="meta">Newest first · HTML kept for the most recent runs only (${entries.filter((entry) => retained.has(entry.slug)).length} of ${entries.length}) · full series: <a href="test-report/history/index.json">history/index.json</a></p>
${blocks.join("\n")}`;
}

function numberOrNull(value) {
  if (value == null || value === "" || !Number.isFinite(Number(value)))
    return null;
  return Number(value);
}

function normalizeDate(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const match = /^(?<date>\d{4}-\d{2}-\d{2})/u.exec(text);
  return match?.groups?.date ?? null;
}

function sanitizeSegment(value) {
  return String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]/gu, "");
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function parseFlags(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (!current.startsWith("--")) continue;
    result[current.slice(2)] = args[index + 1];
    index += 1;
  }
  return result;
}

async function ensureMainScopeBanner(indexPath) {
  let html;
  try {
    html = await readFile(indexPath, "utf8");
  } catch {
    return;
  }
  if (html.includes("/test-report/nightly/") && html.includes("per-push"))
    return;
  const banner = `<p class="lede scope">This is the <strong>per-push / main</strong> slot (CI after merge). It does not include nightly desktop/web/mobile/pairing e2e, perf, or scale. Full product lanes: <a href="../nightly/">/test-report/nightly/</a>.</p>`;
  const next = html.includes('<nav class="toc"')
    ? html.replace('<nav class="toc"', `${banner}<nav class="toc"`)
    : html.includes('<main class="page">')
      ? html.replace('<main class="page">', `<main class="page">${banner}`)
      : html.replace("<body>", `<body>${banner}`);
  if (next !== html) await writeFile(indexPath, next, "utf8");
}
