/**
 * Scoped diff-coverage runner (#576).
 *
 * Produces the coverage map `diff-coverage.mjs` scores, doing the least work
 * that can produce a correct verdict:
 *
 *   1. No instrumentable file changed (docs, config, tests-only)? Skip
 *      everything — `evaluateDiffCoverage` already passes a zero-line diff, so
 *      running 5,948 tests to learn that is pure cost.
 *   2. Otherwise run ONLY the vitest projects owning the changed files,
 *      instrumented, via vitest.diff-coverage.config.ts.
 *
 * Measured on this repo (M-series Mac): the full instrumented run is 418s on
 * every push. Scoped to the one package a gateway change touches it is 219s,
 * and a diff with no instrumentable source in it — docs, config, workflow, or
 * tests-only — costs 3s, almost all of it the `git fetch`.
 *
 * The full repo-wide `bun run coverage` remains the authority: it is what the
 * CI `verify` job runs, what enforces the seeded floors, and what catches a
 * file covered only by another package's tests. This lane is the fast local
 * preview of that gate, not a replacement for it.
 *
 * Usage:
 *   node scripts/test-report/diff-coverage-run.mjs
 *   node scripts/test-report/diff-coverage-run.mjs --dependents
 *   node scripts/test-report/diff-coverage-run.mjs --base origin/main
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isInstrumentableSource } from './diff-coverage.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * @param {string[]} argv Raw argv slice.
 * @returns {{ base: string | null; dependents: boolean }} Parsed options.
 */
function parseArgs(argv) {
  const out = { base: /** @type {string | null} */ (null), dependents: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base' && argv[i + 1]) out.base = argv[++i];
    else if (argv[i] === '--dependents') out.dependents = true;
  }
  return out;
}

/**
 * @param {string[]} args git arguments.
 * @returns {string} stdout, or '' when git fails.
 */
function git(args) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return '';
  }
}

/**
 * Mirrors diff-coverage.mjs's own base resolution so the two lanes can never
 * score against different merge bases.
 * @param {string | null} explicit Explicit --base value.
 * @returns {string | null} A resolvable ref, or null.
 */
function resolveBase(explicit) {
  if (explicit) return explicit;
  for (const candidate of ['origin/main', 'main', 'origin/master', 'master']) {
    if (git(['rev-parse', '--verify', candidate]).trim()) return candidate;
  }
  return null;
}

/**
 * Changed paths across the merge-base range plus the working tree, matching the
 * union diff-coverage.mjs scores locally (committed + staged + unstaged).
 * @param {string} baseRef Base ref.
 * @returns {string[]} Repo-relative paths, deduped.
 */
function changedFiles(baseRef) {
  const names = [
    ...git(['diff', '--name-only', `${baseRef}...HEAD`]).split('\n'),
    ...git(['diff', '--name-only']).split('\n'),
    ...git(['diff', '--cached', '--name-only']).split('\n'),
  ];
  return [...new Set(names.map((n) => n.trim()).filter(Boolean))];
}

/**
 * Map a repo-relative source path to the workspace directory owning it.
 * @param {string} filePath Repo-relative path.
 * @returns {string | null} e.g. "packages/gateway", or null.
 */
function workspaceDirOf(filePath) {
  const m = /^((?:packages|apps)\/[^/]+)\//.exec(filePath);
  return m ? m[1] : null;
}

/**
 * @param {string} dir Workspace directory.
 * @returns {string | null} The package name vitest uses as its project name.
 */
function projectNameOf(dir) {
  const manifest = path.join(root, dir, 'package.json');
  if (!existsSync(manifest)) return null;
  // A workspace with no vitest config contributes no project to the root run,
  // so naming it in --project would make vitest fail on an unknown project.
  const hasVitest = ['vitest.config.ts', 'vitest.config.mts', 'vitest.config.js'].some((f) =>
    existsSync(path.join(root, dir, f)),
  );
  if (!hasVitest) return null;
  try {
    const name = JSON.parse(readFileSync(manifest, 'utf8')).name;
    return typeof name === 'string' && name ? name : null;
  } catch {
    return null;
  }
}

/**
 * Expand a package set to include everything that depends on it, using turbo as
 * the authority so this agrees with `test:affected:full`.
 * @param {string} baseRef Base ref.
 * @returns {string[] | null} Package names, or null when turbo cannot answer.
 */
function dependentsOf(baseRef) {
  const res = spawnSync(
    'bunx',
    ['turbo', 'run', 'test', `--filter=...[${baseRef}]`, '--dry=json'],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (res.status !== 0 || !res.stdout) return null;
  try {
    const parsed = JSON.parse(res.stdout);
    const packages = parsed?.packages;
    return Array.isArray(packages) ? packages.filter((p) => typeof p === 'string') : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} command Command to run.
 * @param {string[]} args Arguments.
 * @returns {number} Exit status.
 */
function run(command, args) {
  const res = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  return res.status ?? 1;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  // Best-effort: a stale origin/main only makes the diff larger, never wrong.
  // NOT --depth=1 — against a full local clone that truncates origin/main into
  // a shallow ref and destroys the merge base (#568 learned this the hard way).
  git(['fetch', '--no-tags', 'origin', 'main']);

  const baseRef = resolveBase(args.base);
  if (!baseRef) {
    console.error('diff-coverage-run: no base ref found; pass --base <ref>');
    return 1;
  }

  const changed = changedFiles(baseRef);
  const instrumentable = changed.filter(isInstrumentableSource);
  if (instrumentable.length === 0) {
    console.log(
      `diff-coverage-run: no instrumentable source changed vs ${baseRef} (${changed.length} file(s) in the diff) — nothing to score`,
    );
    return 0;
  }

  /** @type {Set<string>} */
  const projects = new Set();
  for (const file of instrumentable) {
    const dir = workspaceDirOf(file);
    if (!dir) continue;
    const name = projectNameOf(dir);
    if (name) projects.add(name);
  }

  if (args.dependents) {
    const expanded = dependentsOf(baseRef);
    if (expanded) {
      for (const name of expanded) projects.add(name);
    } else {
      console.warn(
        'diff-coverage-run: turbo could not resolve dependents — scoring changed packages only',
      );
    }
  }

  if (projects.size === 0) {
    console.error(
      `diff-coverage-run: ${instrumentable.length} instrumentable file(s) changed but no vitest project owns them:\n  ${instrumentable.join('\n  ')}`,
    );
    return 1;
  }

  const names = [...projects].sort();
  console.log(`diff-coverage-run: ${names.length} project(s) — ${names.join(', ')}`);

  // Handler tests load built workers from dist, so dist must match src. turbo
  // caches this, so it is ~free on a repeat run.
  const buildStatus = run('bunx', ['turbo', 'run', 'build', ...names.map((n) => `--filter=${n}`)]);
  if (buildStatus !== 0) return buildStatus;

  const testStatus = run('node', [
    'node_modules/vitest/vitest.mjs',
    'run',
    '--config',
    'vitest.diff-coverage.config.ts',
    '--coverage',
    ...names.map((n) => `--project=${n}`),
  ]);
  if (testStatus !== 0) return testStatus;

  return run('node', ['scripts/test-report/diff-coverage.mjs', '--base', baseRef]);
}

process.exitCode = main();
