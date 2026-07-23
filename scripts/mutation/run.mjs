/**
 * Nightly mutation lane runner (#532).
 *
 * Runs StrykerJS from each seed package directory (package-local
 * `stryker.config.mjs` + `vitest.mutation.config.ts`) and writes a normalized
 * scores JSON under artifacts/mutation/ for the test-health report.
 *
 * Usage:
 *   node scripts/mutation/run.mjs
 *   node scripts/mutation/run.mjs --package vault
 *   node scripts/mutation/run.mjs --dry-run
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** @typedef {{ id: string; label: string; cwd: string; config: string; report: string }} MutationSeed */

/** @type {MutationSeed[]} */
export const MUTATION_SEEDS = [
  {
    id: 'packages/vault',
    label: 'vault',
    cwd: 'packages/vault',
    config: 'stryker.config.mjs',
    report: 'artifacts/mutation/vault-report.json',
  },
  {
    id: 'packages/client/src/replica',
    label: 'client-replica',
    cwd: 'packages/client',
    config: 'stryker.config.mjs',
    report: 'artifacts/mutation/client-replica-report.json',
  },
  {
    id: 'packages/automation',
    label: 'automation',
    cwd: 'packages/automation',
    config: 'stryker.config.mjs',
    report: 'artifacts/mutation/automation-report.json',
  },
  {
    id: 'packages/backup',
    label: 'backup',
    cwd: 'packages/backup',
    config: 'stryker.config.mjs',
    report: 'artifacts/mutation/backup-report.json',
  },
  {
    id: 'packages/blob-format',
    label: 'blob-format',
    cwd: 'packages/blob-format',
    config: 'stryker.config.mjs',
    report: 'artifacts/mutation/blob-format-report.json',
  },
  {
    id: 'packages/protocol',
    label: 'protocol',
    cwd: 'packages/protocol',
    config: 'stryker.config.mjs',
    report: 'artifacts/mutation/protocol-report.json',
  },
  {
    id: 'packages/tunnel',
    label: 'tunnel',
    cwd: 'packages/tunnel',
    config: 'stryker.config.mjs',
    report: 'artifacts/mutation/tunnel-report.json',
  },
  {
    id: 'packages/app-engine',
    label: 'app-engine',
    cwd: 'packages/app-engine',
    config: 'stryker.config.mjs',
    report: 'artifacts/mutation/app-engine-report.json',
  },
];

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
  // Stryker 9 files map: average file scores if present
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
    // Stryker 9 JSON report: per-file mutants[] with status, no rollup metrics.
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
        // Ignored / Pending do not count toward the score denominator.
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

function parseArgs(argv) {
  const out = { package: null, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--package' && argv[i + 1]) out.package = argv[++i];
    else if (argv[i] === '--dry-run') out.dryRun = true;
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

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      'Usage: node scripts/mutation/run.mjs [--package vault|client-replica|automation] [--dry-run]',
    );
    process.exit(0);
  }

  const seeds = args.package
    ? MUTATION_SEEDS.filter((s) => s.label === args.package || s.id.includes(args.package))
    : MUTATION_SEEDS;
  if (!seeds.length) {
    console.error(`mutation: unknown package filter ${args.package}`);
    process.exitCode = 1;
    return;
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

  const stryker = findStrykerBin();
  if (!stryker) {
    console.error(
      'mutation: @stryker-mutator/core not installed (devDependency). Nightly installs it via bun install.',
    );
    const rows = seeds.map((s) => ({
      id: s.id,
      label: s.label,
      score: null,
      status: 'unavailable',
      error: 'stryker binary missing',
    }));
    writeFileSync(
      path.join(root, 'artifacts/mutation/scores.json'),
      JSON.stringify(buildScoresArtifact(rows), null, 2),
    );
    process.exitCode = 1;
    return;
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

  writeFileSync(
    path.join(root, 'artifacts/mutation/scores.json'),
    JSON.stringify(buildScoresArtifact(rows), null, 2),
  );
  console.log('mutation: wrote artifacts/mutation/scores.json');
  for (const row of rows) {
    console.log(
      `  - ${row.id}: ${row.score === null ? 'n/a' : `${row.score.toFixed(1)}%`} (${row.status})`,
    );
  }
  if (rows.some((r) => r.status === 'failed' || r.status === 'unavailable')) {
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
