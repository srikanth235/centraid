// governance: allow-repo-hygiene file-size-limit (#474) this generator was
// already at 498/500 before the durable-history reader landed, so any addition
// trips the cap; the report is one model built in a single pass and then
// rendered, and splitting the reader from the model it feeds would scatter the
// evidence-collection vocabulary across files without making either half
// independently testable. Worth a real decomposition, but not inside a CI fix.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateMatrix } from './validate-matrix.mjs';
import {
  collectEnvGatedOwners,
  extractUnhandledErrors,
  summarizeCellStates,
} from './report-signals.mjs';
import { coverageScopesBelowFloor, writeSummarySidecars } from './summary-markdown.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const flags = parseFlags(process.argv.slice(2));
const matrixPath = path.resolve(flags.matrix ?? path.join(root, 'tests/matrix.json'));
const outputPath = path.resolve(flags.output ?? path.join(root, 'dist/test-report/index.html'));
const laneMarkers = await readJson(
  path.resolve(flags['lane-markers'] ?? path.join(root, 'artifacts/test-results/lane-starts.json')),
  {},
);
const maxEvidenceAgeMs =
  Number(flags['max-age-hours'] ?? process.env.TEST_REPORT_MAX_EVIDENCE_AGE_HOURS ?? 36) *
  60 *
  60 *
  1_000;
const matrix = await readJson(matrixPath, { dimensions: [], surfaces: [], flows: [] });
const validation = await validateMatrix(matrix, { root });
const coverage = await readJson(
  path.resolve(flags.coverage ?? path.join(root, 'coverage/coverage-summary.json')),
  null,
);
const floors = await readJson(path.join(root, 'tests/coverage-floors.json'), {});
const vitest = await readJson(
  path.resolve(flags.vitest ?? path.join(root, 'artifacts/test-results/vitest.json')),
  null,
);
const playwright = await readPlaywright(
  path.resolve(flags.playwright ?? path.join(root, 'artifacts/test-results')),
);
const e2e = await readLane(path.resolve(flags.e2e ?? path.join(root, 'artifacts/e2e')));
const perf = await readLane(path.resolve(flags.perf ?? path.join(root, 'artifacts/perf')));
const scale = await readLane(path.resolve(flags.scale ?? path.join(root, 'artifacts/scale')));
// Durable, gh-pages-committed summary series. Preferred trend source because it
// survives the 7-day/10GB eviction of the `quality-history-` Actions cache that
// feeds artifacts/perf and artifacts/scale.
const durableHistory = await readDurableHistory(
  path.resolve(flags.history ?? path.join(root, 'artifacts/report-history')),
  Number(flags['history-limit'] ?? 30) || 30,
);

const evidence = collectEvidence(vitest, playwright, e2e, perf, scale, {
  laneMarkers,
  maxEvidenceAgeMs,
  nowMs: Date.now(),
});
const cells = buildCells(matrix, evidence, validation.errors);
const coverageRows = collectCoverage(coverage, floors);
const vitestFiles = await collectVitestFiles(vitest);
const laneResults = [...perf, ...scale];
const unhandledErrors = extractUnhandledErrors(vitest);
const cellStateCounts = summarizeCellStates(cells);
const envGatedOwners = await collectEnvGatedOwners(matrix, { root, readFile });
const summary = {
  passed: evidence.filter((item) => item.status === 'passed').length,
  failed: evidence.filter((item) => item.status === 'failed').length,
  skipped: evidence.filter((item) => item.status === 'skipped').length,
  skippedTests: vitestFiles.reduce((sum, file) => sum + file.skipped, 0),
  envGated: vitestFiles.reduce((sum, file) => sum + file.envGated, 0),
  stale:
    evidence.filter((item) => item.status === 'stale').length +
    validation.errors.filter((error) => error.includes('owner does not exist')).length,
  unhandledErrors: unhandledErrors.length,
  unhandledErrorMessages: unhandledErrors,
  // Lane/cell honesty: failed = evidence ran and failed; missing = not run.
  cellsFailed: cellStateCounts.cellsFailed,
  cellsMissing: cellStateCounts.cellsMissing,
  envGatedOwners,
};

const model = {
  generatedAt: new Date().toISOString(),
  matrix,
  cells,
  coverageRows,
  slowest: vitestFiles.sort((a, b) => b.duration - a.duration).slice(0, 10),
  packageRuntime: packageRuntime(vitestFiles),
  laneResults,
  summary,
  healthHistory: [...durableHistory, historyPoint({ label: 'this run', ...summary })],
  validationErrors: validation.errors,
};

const reportDir = path.dirname(outputPath);
await mkdir(reportDir, { recursive: true });
await writeFile(outputPath, render(model), 'utf8');
const { jsonPath: summaryJsonPath } = await writeSummarySidecars(
  reportDir,
  {
    generatedAt: model.generatedAt,
    ...summary,
    coverageBelowFloor: coverageScopesBelowFloor(coverageRows),
    validationErrorCount: validation.errors.length,
  },
  { reportUrl: process.env.TEST_REPORT_PUBLIC_URL || undefined },
);
console.log(`test report: ${path.relative(root, outputPath)}`);
console.log(`test report summary: ${path.relative(root, summaryJsonPath)}`);
if (validation.errors.length) {
  for (const error of validation.errors) console.error(`matrix: ${error}`);
  process.exitCode = 1;
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

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function readLane(directory) {
  try {
    const files = (await readdir(directory)).filter((file) => file.endsWith('.json')).sort();
    return (
      await Promise.all(files.map((file) => readJson(path.join(directory, file), null)))
    ).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Read the append-only summary series published to gh-pages
 * (`test-report/history/`). Accepts the directory, its `index.json`, or a bare
 * directory of `<slug>.json` records. Returns oldest-first points.
 */
async function readDurableHistory(target, limit) {
  const index = await readJson(
    target.endsWith('.json') ? target : path.join(target, 'index.json'),
    null,
  );
  let records = Array.isArray(index?.entries) ? index.entries : null;
  if (!records) {
    const files = (await readdir(target).catch(() => []))
      .filter((file) => file.endsWith('.json') && file !== 'index.json')
      .sort();
    records = (
      await Promise.all(files.map((file) => readJson(path.join(target, file), null)))
    ).filter(Boolean);
  }
  const points = records
    .map((record) =>
      historyPoint({ label: record.slug ?? record.date, ...record.summary, ...record }),
    )
    .filter((point) => point.label);
  points.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  return points.slice(Math.max(0, points.length - limit));
}

function historyPoint(record) {
  const numeric = (value) =>
    value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
  return {
    label: String(record.label ?? ''),
    passed: numeric(record.passed),
    failed: numeric(record.failed),
    stale: numeric(record.stale),
    cellsFailed: numeric(record.cellsFailed),
    cellsMissing: numeric(record.cellsMissing),
    unhandledErrors: numeric(record.unhandledErrors),
  };
}

async function readPlaywright(target) {
  const single = await readJson(target, undefined);
  if (single) return [{ lane: 'playwright', report: single }];
  try {
    const files = (await readdir(target)).filter((file) => file.endsWith('-playwright.json'));
    return (
      await Promise.all(
        files.map(async (file) => ({
          lane: file.replace(/\.json$/, ''),
          report: await readJson(path.join(target, file), null),
        })),
      )
    ).filter((entry) => entry.report);
  } catch {
    return [];
  }
}

function normalizeFile(value) {
  return String(value ?? '')
    .replaceAll('\\', '/')
    .replace(`${root.replaceAll('\\', '/')}/`, '');
}

function collectEvidence(
  vitestJson,
  playwrightReports,
  e2eResults,
  perfResults,
  scaleResults,
  freshness,
) {
  const items = [];
  for (const result of vitestJson?.testResults ?? vitestJson?.files ?? []) {
    const assertions = result.assertionResults ?? result.tests ?? [];
    const raw =
      result.status ?? (assertions.some((test) => test.status === 'failed') ? 'failed' : 'passed');
    const lastAt = isoAt(result.endTime ?? result.startTime ?? vitestJson?.startTime);
    items.push({
      owner: normalizeFile(result.name ?? result.filepath),
      status: evidenceStatus(raw, 'vitest', lastAt, freshness),
      duration:
        Math.max(0, (result.endTime ?? 0) - (result.startTime ?? 0)) || result.duration || 0,
      lastAt,
    });
  }
  for (const { lane, report } of playwrightReports) {
    const lastAt = isoAt(report.stats?.startTime);
    walkPlaywright(report.suites ?? [], items, { freshness, lane, lastAt });
  }
  for (const result of [...e2eResults, ...perfResults, ...scaleResults]) {
    const wallClock = (result.measurements ?? []).find(
      (measurement) => measurement.name === 'wall clock',
    );
    const lastAt = result.history?.at(-1)?.at ?? result.capturedAt ?? null;
    items.push({
      owner: normalizeFile(result.owner),
      status: evidenceStatus(result.status, result.lane, lastAt, freshness),
      duration: wallClock?.unit === 'ms' ? wallClock.value : (result.durationMs ?? 0),
      lastAt,
    });
  }
  return items;
}

function isoAt(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function evidenceStatus(status, lane, lastAt, freshness) {
  const normalized = normalizeStatus(status);
  if (!lastAt) return 'stale';
  const capturedMs = Date.parse(lastAt);
  if (!Number.isFinite(capturedMs)) return 'stale';
  const laneStartedMs = Date.parse(freshness.laneMarkers[lane] ?? '');
  if (Number.isFinite(laneStartedMs) && capturedMs < laneStartedMs) return 'stale';
  if (freshness.nowMs - capturedMs > freshness.maxEvidenceAgeMs) return 'stale';
  return normalized;
}

function walkPlaywright(suites, items, source) {
  for (const suite of suites) {
    if (suite.file) {
      const specs = suite.specs ?? [];
      const statuses = specs
        .flatMap((spec) => spec.tests ?? [])
        .flatMap((test) => test.results ?? []);
      items.push({
        owner: normalizeFile(suite.file),
        status: evidenceStatus(
          statuses.some((result) => result.status === 'failed')
            ? 'failed'
            : statuses.length
              ? 'passed'
              : 'missing',
          source.lane,
          source.lastAt,
          source.freshness,
        ),
        duration: statuses.reduce((sum, result) => sum + (result.duration ?? 0), 0),
        lastAt: source.lastAt,
      });
    }
    walkPlaywright(suite.suites ?? [], items, source);
  }
}

function normalizeStatus(status) {
  if (['passed', 'pass', 'success'].includes(status)) return 'passed';
  if (['failed', 'fail', 'timedOut', 'interrupted'].includes(status)) return 'failed';
  if (['skipped', 'pending', 'todo'].includes(status)) return 'skipped';
  return 'missing';
}

function buildCells(manifest, evidenceItems, validationErrors) {
  const staleOwners = new Set(
    validationErrors
      .filter((error) => error.includes('owner does not exist:'))
      .map((error) => error.split('owner does not exist: ')[1]),
  );
  const evidenceByOwner = new Map(evidenceItems.map((item) => [item.owner, item]));
  return manifest.surfaces.flatMap((surface) =>
    manifest.dimensions.map((dimension) => {
      const cellId = `${surface.id}.${dimension.id}`;
      const cellOwner = manifest.cellOwners[cellId];
      const flows = manifest.flows.filter(
        (flow) => flow.surface === surface.id && flow.dimension === dimension.id,
      );
      const owners = [];
      if (cellOwner) {
        owners.push({ name: 'Cell evidence owner', tier: cellOwner.tier, owner: cellOwner.owner });
      }
      for (const flow of flows) {
        if (!owners.some((owner) => owner.owner === flow.owner)) owners.push(flow);
      }
      const ownerResults = owners.map((owner) => ({
        ...owner,
        latest: evidenceByOwner.get(owner.owner) ?? {
          status: staleOwners.has(owner.owner) ? 'stale' : 'missing',
          duration: 0,
          lastAt: null,
        },
      }));
      const results = ownerResults.map((owner) => owner.latest);
      let state = 'missing';
      if (results.some((result) => result.status === 'failed')) state = 'failed';
      else if (
        owners.some((owner) => staleOwners.has(owner.owner)) ||
        results.some((result) => result.status === 'stale')
      )
        state = 'stale';
      else if (results.length && results.every((result) => result.status === 'passed'))
        state = 'passed';
      else if (results.some((result) => result.status === 'skipped')) state = 'skipped';
      else if (surface.assessment[dimension.id] === 'skip') state = 'skipped';
      return {
        id: `${surface.id}:${dimension.id}`,
        surface: surface.id,
        surfaceLabel: surface.label,
        dimension: dimension.id,
        dimensionLabel: dimension.label,
        lane: dimension.lane,
        assessment: surface.assessment[dimension.id],
        state,
        flows,
        owners: ownerResults,
      };
    }),
  );
}

async function collectVitestFiles(json) {
  return Promise.all(
    (json?.testResults ?? json?.files ?? []).map(async (result) => {
      const file = normalizeFile(result.name ?? result.filepath);
      const skipped = (result.assertionResults ?? result.tests ?? []).filter((test) =>
        ['skipped', 'pending', 'todo'].includes(test.status),
      ).length;
      let envGated = 0;
      if (skipped) {
        try {
          const source = await readFile(path.join(root, file), 'utf8');
          if (/process\.env|\.skipIf\(|\.runIf\(|t\.skip\(|platform\s*[!=]==?/.test(source)) {
            envGated = skipped;
          }
        } catch {
          envGated = 0;
        }
      }
      return {
        file,
        duration:
          Math.max(0, (result.endTime ?? 0) - (result.startTime ?? 0)) || result.duration || 0,
        status: normalizeStatus(result.status),
        skipped,
        envGated,
      };
    }),
  );
}

function packageRuntime(files) {
  const totals = new Map();
  for (const file of files) {
    const parts = file.file.split('/');
    const scope = ['packages', 'apps'].includes(parts[0]) ? `${parts[0]}/${parts[1]}` : 'other';
    totals.set(scope, (totals.get(scope) ?? 0) + file.duration);
  }
  return [...totals]
    .map(([scope, duration]) => ({ scope, duration }))
    .sort((a, b) => b.duration - a.duration);
}

function collectCoverage(summary, floorConfig) {
  return Object.entries(floorConfig).map(([scope, floor]) => {
    const target = typeof floor === 'number' ? { lines: floor } : floor;
    const prefix = scope.replace('/**', '');
    const entries = summary
      ? Object.entries(summary).filter(
          ([file]) => file !== 'total' && normalizeFile(file).startsWith(prefix),
        )
      : [];
    const source =
      scope === 'lines' ? summary?.total : aggregateCoverage(entries.map(([, value]) => value));
    return {
      scope: scope === 'lines' ? 'repo-wide' : scope,
      lines: source?.lines?.pct ?? null,
      branches: source?.branches?.pct ?? null,
      lineFloor: target.lines,
      branchFloor: target.branches ?? null,
    };
  });
}

function aggregateCoverage(entries) {
  if (!entries.length) return null;
  const result = {};
  for (const metric of ['lines', 'branches']) {
    const total = entries.reduce((sum, item) => sum + (item[metric]?.total ?? 0), 0);
    const covered = entries.reduce((sum, item) => sum + (item[metric]?.covered ?? 0), 0);
    result[metric] = { pct: total ? Math.round((covered / total) * 10_000) / 100 : 100 };
  }
  return result;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function formatMs(value) {
  if (value == null) return '—';
  return value >= 1_000 ? `${(value / 1_000).toFixed(2)}s` : `${Math.round(value)}ms`;
}

function trendSvg(values) {
  const numbers = values.filter((value) => Number.isFinite(value));
  if (numbers.length < 2) return '<span class="muted">No trend yet</span>';
  const min = Math.min(...numbers);
  const span = Math.max(1, Math.max(...numbers) - min);
  const points = numbers
    .map(
      (value, index) =>
        `${(index / (numbers.length - 1)) * 120},${34 - ((value - min) / span) * 28}`,
    )
    .join(' ');
  return `<svg class="spark" viewBox="0 0 120 40" role="img" aria-label="Result trend"><polyline points="${points}" /></svg>`;
}

function render(model) {
  const data = JSON.stringify(model).replaceAll('<', '\\u003c');
  const dimensionHeaders = model.matrix.dimensions
    .map(
      (dimension) =>
        `<th scope="col"><span>${escapeHtml(dimension.label)}</span><small>${escapeHtml(dimension.lane)}</small></th>`,
    )
    .join('');
  const rows = model.matrix.surfaces
    .map((surface, rowIndex) => {
      const surfaceCells = model.cells.filter((cell) => cell.surface === surface.id);
      return `<tr style="--row:${rowIndex}"><th scope="row">${escapeHtml(surface.label)}</th>${surfaceCells
        .map(
          (cell) =>
            `<td><button class="cell ${cell.state}" data-cell="${escapeHtml(cell.id)}" aria-label="${escapeHtml(`${cell.surfaceLabel}, ${cell.dimensionLabel}: ${cell.state}`)}"><span>${symbol(cell.state)}</span><small>${cell.owners.length || '—'}</small></button></td>`,
        )
        .join('')}</tr>`;
    })
    .join('');
  const coverageRows = model.coverageRows
    .map((row) => {
      const lineState =
        row.lines == null ? 'missing' : row.lines >= row.lineFloor ? 'passed' : 'failed';
      const branchState =
        row.branchFloor == null || row.branches == null
          ? 'missing'
          : row.branches >= row.branchFloor
            ? 'passed'
            : 'failed';
      return `<tr><td>${escapeHtml(row.scope)}</td><td class="metric ${lineState}">${row.lines ?? '—'}% <small>/ ${row.lineFloor}%</small></td><td class="metric ${branchState}">${row.branches ?? '—'}% <small>/ ${row.branchFloor ?? '—'}%</small></td></tr>`;
    })
    .join('');
  const runtimeRows = model.packageRuntime.length
    ? model.packageRuntime
        .map(
          (row) => `<tr><td>${escapeHtml(row.scope)}</td><td>${formatMs(row.duration)}</td></tr>`,
        )
        .join('')
    : '<tr><td colspan="2" class="muted">No Vitest JSON found</td></tr>';
  const slowRows = model.slowest.length
    ? model.slowest
        .map(
          (row, index) =>
            `<tr><td>${index + 1}</td><td>${escapeHtml(row.file)}</td><td>${formatMs(row.duration)}</td><td>${row.skipped}</td><td>${row.envGated}</td></tr>`,
        )
        .join('')
    : '<tr><td colspan="5" class="muted">No Vitest timing evidence found</td></tr>';
  // Prefer the durable gh-pages series; lane artifacts remain as the fallback
  // (and as per-owner detail) so a first run with no series still renders.
  const durableSeries = model.healthHistory ?? [];
  const durableTrends =
    durableSeries.length > 1
      ? [
          ['evidence passed', 'passed'],
          ['evidence failed', 'failed'],
          ['cells not run', 'cellsMissing'],
          ['stale owners', 'stale'],
        ]
          .map(
            ([label, key]) =>
              `<article class="trend"><div><strong>${escapeHtml(label)}</strong><small>durable series · ${durableSeries.length} runs · latest ${escapeHtml(String(durableSeries.at(-1)?.[key] ?? '—'))}</small></div>${trendSvg(durableSeries.map((point) => point[key]))}</article>`,
          )
          .join('')
      : '';
  const laneTrends = model.laneResults.length
    ? model.laneResults
        .map(
          (result) =>
            `<article class="trend"><div><strong>${escapeHtml(result.name ?? result.owner ?? 'lane result')}</strong><small>${escapeHtml(result.lane ?? 'nightly')} · ${escapeHtml(result.status ?? 'missing')}</small></div>${trendSvg((result.history ?? result.measurements ?? []).map((entry) => (typeof entry === 'number' ? entry : entry.value)))}</article>`,
        )
        .join('')
    : '<p class="empty">Perf and scale results are missing. The lane stays visible until nightly evidence arrives.</p>';
  const trends = `${durableTrends}${laneTrends}`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Centraid test health</title><style>
:root{color-scheme:dark;--ink:#ecf3ee;--muted:#8f9f98;--panel:#111713;--line:#273129;--bg:#090d0b;--green:#5bd697;--red:#ff766f;--amber:#e9b95c;--blue:#72a9ff;--grey:#4a544e;--sans:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 90% -10%,#173126 0,transparent 35%),var(--bg);color:var(--ink);font:14px/1.5 var(--sans)}main{width:min(1480px,calc(100% - 40px));margin:auto;padding:56px 0 80px}.eyebrow{color:var(--green);font-size:11px;font-weight:800;letter-spacing:.16em;text-transform:uppercase}h1{font-size:clamp(34px,5vw,66px);letter-spacing:-.055em;line-height:.95;margin:14px 0 16px;max-width:780px}.lede{color:#afbbb5;font-size:16px;max-width:720px;margin:0}.hero{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:44px;align-items:end;margin-bottom:42px}.summary{display:grid;grid-template-columns:repeat(3,92px);gap:8px}.stat{background:#101612;border:1px solid var(--line);border-radius:4px;padding:15px 12px}.stat b{display:block;font-size:25px}.stat small,.muted,small{color:var(--muted)}.matrix-shell,.card{background:color-mix(in srgb,var(--panel) 94%,transparent);border:1px solid var(--line);border-radius:6px}.matrix-head{display:flex;justify-content:space-between;gap:24px;align-items:center;padding:18px 20px;border-bottom:1px solid var(--line)}.matrix-head h2,.card h2{font-size:15px;margin:0;letter-spacing:-.01em}.legend{display:flex;gap:14px;flex-wrap:wrap;color:var(--muted);font-size:12px}.dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:5px}.dot.passed{background:var(--green)}.dot.failed{background:var(--red)}.dot.skipped{background:var(--amber)}.dot.missing{background:var(--grey)}.matrix-scroll{overflow:auto;padding:10px}table{border-collapse:separate;border-spacing:4px;width:100%}.heatmap th{font-size:11px;color:var(--muted);font-weight:650;text-align:left;min-width:68px}.heatmap thead th:not(:first-child){height:98px;vertical-align:bottom}.heatmap thead th span{display:block;writing-mode:vertical-rl;transform:rotate(180deg);height:74px}.heatmap thead th small{display:none}.heatmap tbody th{min-width:230px;color:#bdc9c3}.cell{width:100%;min-width:52px;height:40px;border:1px solid transparent;border-radius:3px;color:#07110c;display:flex;justify-content:space-between;align-items:center;padding:0 9px;font:700 13px var(--sans);cursor:pointer;transition:transform .16s,border-color .16s,filter .16s;animation:rise .34s both;animation-delay:calc(var(--row)*28ms)}.cell small{color:inherit;opacity:.65}.cell:hover,.cell:focus-visible{transform:translateY(-2px);filter:brightness(1.12);outline:none;border-color:#fff8}.cell.passed{background:var(--green)}.cell.failed{background:var(--red)}.cell.skipped{background:var(--amber)}.cell.missing,.cell.stale{background:#303a34;color:#aab6b0}.inspector{display:grid;grid-template-columns:220px minmax(0,1fr);gap:22px;padding:20px;border-top:1px solid var(--line);min-height:126px}.inspector .kicker{color:var(--muted);font-size:12px}.inspector h3{margin:4px 0 0;font-size:18px}.flow-list{display:grid;gap:8px}.flow{display:grid;grid-template-columns:minmax(150px,.45fr) 78px 84px 84px minmax(230px,1fr);gap:12px;align-items:center;padding:8px 0;border-bottom:1px solid #202923}.flow:last-child{border-bottom:0}.tier{color:var(--blue);font-size:11px;text-transform:uppercase;letter-spacing:.08em}.result{font-size:11px;font-weight:750;text-transform:uppercase}.result.passed{color:var(--green)}.result.failed{color:var(--red)}.result.skipped{color:var(--amber)}.result.missing,.result.stale{color:var(--muted)}.path{color:#a8b7af;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px}.card{padding:20px;overflow:auto}.card h2{margin-bottom:14px}.data{border-spacing:0;width:100%}.data th,.data td{text-align:left;border-bottom:1px solid #202923;padding:8px 7px;font-size:12px}.data th{color:var(--muted);font-weight:650}.metric.passed{color:var(--green)}.metric.failed{color:var(--red)}.metric.missing{color:var(--muted)}.wide{grid-column:1/-1}.trend-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:8px}.trend{display:flex;justify-content:space-between;gap:12px;align-items:center;background:#0c110e;border:1px solid #202923;padding:12px}.trend strong,.trend small{display:block}.spark{width:120px;height:40px}.spark polyline{fill:none;stroke:var(--green);stroke-width:2;vector-effect:non-scaling-stroke}.empty{color:var(--muted);border:1px dashed #334038;padding:24px;margin:0}.foot{margin-top:20px;color:var(--muted);font-size:12px}@keyframes rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}@media(max-width:900px){main{width:min(100% - 22px,1480px);padding-top:30px}.hero{grid-template-columns:1fr}.summary{grid-template-columns:repeat(3,1fr)}.grid{grid-template-columns:1fr}.wide{grid-column:auto}.inspector{grid-template-columns:1fr}.flow{grid-template-columns:1fr}.matrix-head{align-items:flex-start;flex-direction:column}}@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
</style></head><body><main>
<header class="hero"><div><div class="eyebrow">Centraid · test intelligence</div><h1>Product health, with the gaps left visible.</h1><p class="lede">One view across per-PR correctness and nightly journey, performance, and scale evidence. Grey is intentional: missing proof should never disappear. Red cells failed with evidence; grey cells were not run.</p>${
    model.summary.unhandledErrors
      ? `<p class="lede" style="color:var(--red)">Unhandled Vitest errors: ${model.summary.unhandledErrors} — ${escapeHtml(
          (model.summary.unhandledErrorMessages ?? []).join(' · ').slice(0, 400),
        )}</p>`
      : ''
  }</div><div class="summary"><div class="stat"><b>${model.summary.passed}</b><small>evidence passed</small></div><div class="stat"><b>${model.summary.failed}</b><small>evidence failed</small></div><div class="stat"><b>${model.summary.cellsFailed ?? 0}</b><small>cells failed</small></div><div class="stat"><b>${model.summary.cellsMissing ?? 0}</b><small>cells not run</small></div><div class="stat"><b>${model.summary.unhandledErrors ?? 0}</b><small>unhandled errors</small></div><div class="stat"><b>${model.summary.skippedTests}</b><small>tests skipped</small></div><div class="stat"><b>${model.summary.envGated}</b><small>environment-gated</small></div><div class="stat"><b>${model.summary.stale}</b><small>stale owners</small></div></div></header>
<section class="matrix-shell"><div class="matrix-head"><h2>Surface × quality dimension</h2><div class="legend"><span><i class="dot passed"></i>passed</span><span><i class="dot failed"></i>failed (ran)</span><span><i class="dot skipped"></i>skipped</span><span><i class="dot missing"></i>missing / not run</span></div></div><div class="matrix-scroll"><table class="heatmap"><thead><tr><th>Product surface</th>${dimensionHeaders}</tr></thead><tbody>${rows}</tbody></table></div><div class="inspector" aria-live="polite"><div><span class="kicker" id="inspector-kicker">Select a matrix cell</span><h3 id="inspector-title">Evidence inspector</h3></div><div class="flow-list" id="inspector-flows"><p class="muted">Choose any cell to see its canonical flow owner, tier, lane, and latest result.</p></div></div></section>
<section class="grid"><article class="card"><h2>Coverage vs ratchet floor</h2><table class="data"><thead><tr><th>Scope</th><th>Lines</th><th>Branches</th></tr></thead><tbody>${coverageRows}</tbody></table></article><article class="card"><h2>Per-package wall clock</h2><table class="data"><thead><tr><th>Package</th><th>Runtime</th></tr></thead><tbody>${runtimeRows}</tbody></table></article><article class="card wide"><h2>Slowest 10 test files · bloat watch</h2><table class="data"><thead><tr><th>#</th><th>File</th><th>Runtime</th><th>Skipped</th><th>Env-gated</th></tr></thead><tbody>${slowRows}</tbody></table></article><article class="card wide"><h2>Environment-gated matrix owners</h2>${
    (model.summary.envGatedOwners ?? []).length
      ? `<table class="data"><thead><tr><th>Cell</th><th>Owner</th><th>Env</th><th>Kind</th></tr></thead><tbody>${(
          model.summary.envGatedOwners ?? []
        )
          .map(
            (row) =>
              `<tr><td>${escapeHtml(row.cellId)}</td><td class="path">${escapeHtml(row.owner)}</td><td>${escapeHtml(row.env)}</td><td>${escapeHtml(row.kind)}</td></tr>`,
          )
          .join('')}</tbody></table>`
      : '<p class="empty">No solid/partial matrix owners are whole-file env-gated off default CI.</p>'
  }</article><article class="card wide"><h2>Nightly performance and scale trends</h2><div class="trend-grid">${trends}</div></article></section>
<p class="foot">Generated ${escapeHtml(model.generatedAt)} · ${model.matrix.surfaces.length} surfaces · ${model.matrix.dimensions.length} dimensions · ${model.matrix.flows.length} canonical flows</p></main>
<script type="application/json" id="report-data">${data}</script><script>
const report=JSON.parse(document.querySelector('#report-data').textContent);const byId=new Map(report.cells.map(cell=>[cell.id,cell]));const kicker=document.querySelector('#inspector-kicker');const title=document.querySelector('#inspector-title');const flows=document.querySelector('#inspector-flows');for(const button of document.querySelectorAll('[data-cell]'))button.addEventListener('click',()=>{const cell=byId.get(button.dataset.cell);kicker.textContent=cell.dimensionLabel+' · '+cell.lane+' · '+cell.state;title.textContent=cell.surfaceLabel;flows.innerHTML=cell.owners.length?cell.owners.map(owner=>'<div class="flow"><strong>'+safe(owner.name)+'</strong><span class="tier">'+safe(owner.tier)+'</span><span class="result '+safe(owner.latest.status)+'">'+safe(owner.latest.status)+'</span><span>'+duration(owner.latest.duration)+'</span><span class="path">'+safe(owner.owner)+'</span></div>').join(''):'<p class="muted">No evidence owner is expected for this cell. Catalog assessment: '+safe(cell.assessment)+'.</p>';for(const current of document.querySelectorAll('[data-cell][aria-pressed]'))current.removeAttribute('aria-pressed');button.setAttribute('aria-pressed','true')});function duration(value){if(!Number.isFinite(value))return '—';return value>=1000?(value/1000).toFixed(2)+'s':Math.round(value)+'ms'}function safe(value){const span=document.createElement('span');span.textContent=value;return span.innerHTML}
</script></body></html>`;
}

function symbol(state) {
  return { passed: '✓', failed: '×', skipped: '–', stale: '!', missing: '·' }[state] ?? '·';
}
