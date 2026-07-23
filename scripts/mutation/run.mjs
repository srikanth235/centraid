/**
 * Mutation lane runner (#532).
 *
 * Runs StrykerJS from each seed package directory (package-local
 * `stryker.config.mjs` + `vitest.mutation.config.ts`) and writes a normalized
 * scores JSON under artifacts/mutation/ for the test-health report.
 *
 * Usage:
 *   node scripts/mutation/run.mjs
 *   node scripts/mutation/run.mjs --package vault
 *   node scripts/mutation/run.mjs --affected [--base origin/main]
 *   node scripts/mutation/run.mjs --enforce-floors
 *   node scripts/mutation/run.mjs --dry-run
 *
 * Per-PR lane (`bun run test:mutation:pr`) is `--affected --enforce-floors`.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MUTATION_GLOBAL_WATCH, MUTATION_SEEDS } from './seeds.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export { MUTATION_GLOBAL_WATCH, MUTATION_SEEDS };

/**
 * Normalize a Stryker JSON report into a score percentage.
 * @param {unknown} report Stryker JSON report object.
 * @returns {number | null} Mutation score 0–100, or null if missing.
 */
export function mutationScoreFromReport(report) {
  if (!report || typeof report !== 'object') return null;
  const r = /** @type {Record<string, unknown>} */ (report);
  if (typeof r.mutationScore === 'number') return r.mutationScore;
  const metrics = r.metrics ?? r.totals;
  if (metrics && typeof metrics === 'object') {
    const m = /** @type {Record<string, unknown>} */ (metrics);
    if (typeof m.mutationScore === 'number') return m.mutationScore;
    if (typeof m.killed === 'number' && typeof m.totalValid === 'number' && m.totalValid > 0) {
      return (m.killed / m.totalValid) * 100;
    }
    if (
      typeof m.killed === 'number' &&
      typeof m.survived === 'number' &&
      typeof m.timeout === 'number'
    ) {
      const denom = m.killed + m.survived + m.timeout + (Number(m.noCoverage) || 0);
      if (denom > 0) return (m.killed / denom) * 100;
    }
  }
  if (r.files && typeof r.files === 'object') {
    const fileEntries = Object.values(
      /** @type {Record<string, { mutationScore?: number; mutants?: Array<{ status?: string }> }> } */ (
        r.files
      ),
    );
    const scores = fileEntries.map((f) => f?.mutationScore).filter((n) => typeof n === 'number');
    if (scores.length) {
      return scores.reduce((a, b) => a + b, 0) / scores.length;
    }
    let killed = 0;
    let valid = 0;
    for (const f of fileEntries) {
      if (!Array.isArray(f?.mutants)) continue;
      for (const m of f.mutants) {
        const status = m?.status;
        if (
          status === 'Killed' ||
          status === 'Timeout' ||
          status === 'RuntimeError' ||
          status === 'CompileError'
        ) {
          killed += status === 'Killed' || status === 'Timeout' ? 1 : 0;
          valid += 1;
        } else if (status === 'Survived' || status === 'NoCoverage') {
          valid += 1;
        }
      }
    }
    if (valid > 0) return (killed / valid) * 100;
  }
  return null;
}

/**
 * Build the scores.json artifact consumed by the test-health report.
 * @param {Array<{ id: string; label: string; score: number | null; status: string; reportPath?: string; error?: string }>} rows Package rows.
 * @returns {object} Artifact payload.
 */
export function buildScoresArtifact(rows) {
  return {
    generatedAt: new Date().toISOString(),
    lane: 'mutation',
    packages: rows,
  };
}

/**
 * Compare measured scores against floors.
 * @param {{ packages?: Array<{ id?: string; score?: number | null }> }} scores Artifact.
 * @param {Record<string, unknown>} floors tests/mutation-floors.json shape.
 * @returns {string[]} Human-readable errors (empty = pass).
 */
export function enforceMutationFloors(scores, floors) {
  const errors = [];
  if (!floors || typeof floors !== 'object') return errors;
  const byId = new Map(
    (scores?.packages ?? []).filter((p) => p?.id).map((p) => [/** @type {string} */ (p.id), p]),
  );
  for (const [id, floor] of Object.entries(floors)) {
    if (id.startsWith('_') || id === 'approvedDeviation') continue;
    if (typeof floor !== 'number') continue;
    const row = byId.get(id);
    if (!row || typeof row.score !== 'number') continue;
    if (row.score + 1e-9 < floor) {
      errors.push(
        `mutation floor "${id}" not met: measured ${row.score.toFixed(2)} < floor ${floor}`,
      );
    }
  }
  return errors;
}

/**
 * Select seeds whose watch paths intersect the changed file set.
 * @param {string[]} changedFiles Paths relative to repo root.
 * @param {import('./seeds.mjs').MutationSeed[]} [seeds]
 * @param {string[]} [globalWatch]
 * @returns {import('./seeds.mjs').MutationSeed[]}
 */
export function selectAffectedSeeds(
  changedFiles,
  seeds = MUTATION_SEEDS,
  globalWatch = MUTATION_GLOBAL_WATCH,
) {
  const changed = new Set(changedFiles.map((f) => f.replace(/\\/g, '/')));
  if (globalWatch.some((g) => changed.has(g))) return [...seeds];
  return seeds.filter((seed) =>
    seed.watch.some((w) => changed.has(w) || [...changed].some((c) => c.startsWith(`${w}/`))),
  );
}

/**
 * List files changed vs a git base ref (triple-dot: merge-base…HEAD).
 * @param {string} base Git ref (e.g. origin/main).
 * @param {string} [cwd] Repo root.
 * @returns {string[]}
 */
export function listChangedFiles(base, cwd = root) {
  try {
    const out = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], {
      cwd,
      encoding: 'utf8',
    });
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    try {
      const out = execFileSync('git', ['diff', '--name-only', base], {
        cwd,
        encoding: 'utf8',
      });
      return out
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }
}

/**
 * @param {string} [floorsPath]
 * @returns {Record<string, unknown>}
 */
export function loadMutationFloors(floorsPath = path.join(root, 'tests/mutation-floors.json')) {
  if (!existsSync(floorsPath)) return {};
  return JSON.parse(readFileSync(floorsPath, 'utf8'));
}

function parseArgs(argv) {
  const out = {
    package: null,
    dryRun: false,
    help: false,
    affected: false,
    enforceFloors: false,
    base: 'origin/main',
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--package' && argv[i + 1]) out.package = argv[++i];
    else if (argv[i] === '--dry-run') out.dryRun = true;
    else if (argv[i] === '--affected') out.affected = true;
    else if (argv[i] === '--enforce-floors') out.enforceFloors = true;
    else if (argv[i] === '--base' && argv[i + 1]) out.base = argv[++i];
    else if (argv[i] === '--help' || argv[i] === '-h') out.help = true;
  }
  return out;
}

function findStrykerBin() {
  for (const candidate of [
    path.join(root, 'node_modules', '.bin', 'stryker'),
    path.join(root, 'node_modules', '@stryker-mutator', 'core', 'bin', 'stryker.js'),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * @param {import('./seeds.mjs').MutationSeed[]} seeds
 */
function runSeeds(seeds) {
  const stryker = findStrykerBin();
  if (!stryker) {
    console.error(
      'mutation: @stryker-mutator/core not installed (devDependency). Nightly installs it via bun install.',
    );
    return seeds.map((s) => ({
      id: s.id,
      label: s.label,
      score: null,
      status: 'unavailable',
      error: 'stryker binary missing',
    }));
  }

  /** @type {Array<{ id: string; label: string; score: number | null; status: string; reportPath?: string; error?: string }>} */
  const rows = [];
  for (const seed of seeds) {
    const pkgDir = path.join(root, seed.cwd);
    const configAbs = path.join(pkgDir, seed.config);
    if (!existsSync(configAbs)) {
      rows.push({
        id: seed.id,
        label: seed.label,
        score: null,
        status: 'failed',
        error: `missing ${seed.cwd}/${seed.config}`,
      });
      continue;
    }
    console.log(`mutation: running Stryker for ${seed.id} (cwd ${seed.cwd})…`);
    const result = spawnSync(process.execPath, [stryker, 'run', seed.config], {
      cwd: pkgDir,
      encoding: 'utf8',
      env: { ...process.env, FORCE_COLOR: '0' },
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);

    let score = null;
    let status = result.status === 0 ? 'ok' : 'failed';
    const reportAbs = path.join(root, seed.report);
    if (existsSync(reportAbs)) {
      try {
        const report = JSON.parse(readFileSync(reportAbs, 'utf8'));
        score = mutationScoreFromReport(report);
        if (score !== null) status = 'ok';
      } catch (err) {
        rows.push({
          id: seed.id,
          label: seed.label,
          score: null,
          status: 'failed',
          reportPath: seed.report,
          error: String(err),
        });
        continue;
      }
    }
    rows.push({
      id: seed.id,
      label: seed.label,
      score,
      status,
      reportPath: seed.report,
      error: result.status === 0 ? undefined : `stryker exit ${result.status}`,
    });
  }
  return rows;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      'Usage: node scripts/mutation/run.mjs [--package <label>] [--affected] [--base origin/main] [--enforce-floors] [--dry-run]',
    );
    process.exit(0);
  }

  /** @type {import('./seeds.mjs').MutationSeed[]} */
  let seeds;
  if (args.package) {
    seeds = MUTATION_SEEDS.filter((s) => s.label === args.package || s.id.includes(args.package));
    if (!seeds.length) {
      console.error(`mutation: unknown package filter ${args.package}`);
      process.exitCode = 1;
      return;
    }
  } else if (args.affected) {
    const changed = listChangedFiles(args.base);
    seeds = selectAffectedSeeds(changed);
    console.log(
      `mutation: --affected vs ${args.base}: ${changed.length} changed file(s), ${seeds.length} seed(s)`,
    );
    if (!seeds.length) {
      mkdirSync(path.join(root, 'artifacts/mutation'), { recursive: true });
      writeFileSync(
        path.join(root, 'artifacts/mutation/scores.json'),
        JSON.stringify(
          buildScoresArtifact([
            {
              id: '_none',
              label: 'none',
              score: null,
              status: 'skipped',
              error: 'no mutation seeds affected by diff',
            },
          ]),
          null,
          2,
        ),
      );
      console.log('mutation: no seeds affected — skipping Stryker (ok)');
      return;
    }
    for (const s of seeds) console.log(`  - ${s.id}`);
  } else {
    seeds = MUTATION_SEEDS;
  }

  mkdirSync(path.join(root, 'artifacts/mutation'), { recursive: true });

  if (args.dryRun) {
    const rows = seeds.map((s) => ({
      id: s.id,
      label: s.label,
      score: null,
      status: 'dry-run',
      reportPath: s.report,
    }));
    writeFileSync(
      path.join(root, 'artifacts/mutation/scores.json'),
      JSON.stringify(buildScoresArtifact(rows), null, 2),
    );
    console.log('mutation: dry-run wrote artifacts/mutation/scores.json');
    return;
  }

  const rows = runSeeds(seeds);
  const artifact = buildScoresArtifact(rows);
  writeFileSync(
    path.join(root, 'artifacts/mutation/scores.json'),
    JSON.stringify(artifact, null, 2),
  );
  console.log('mutation: wrote artifacts/mutation/scores.json');
  for (const row of rows) {
    console.log(
      `  - ${row.id}: ${row.score === null ? 'n/a' : `${row.score.toFixed(1)}%`} (${row.status})`,
    );
  }

  let failed = rows.some((r) => r.status === 'failed' || r.status === 'unavailable');

  if (args.enforceFloors) {
    const floors = loadMutationFloors();
    const floorErrors = enforceMutationFloors(artifact, floors);
    if (floorErrors.length) {
      for (const e of floorErrors) console.error(`mutation: ${e}`);
      failed = true;
    } else {
      console.log('mutation: floors met for measured packages');
    }
  }

  if (failed) process.exitCode = 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
