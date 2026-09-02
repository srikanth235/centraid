#!/usr/bin/env node
/**
 * New-test burn-in: every test file this diff adds or modifies, run 3× alone (#915).
 *
 * THE GAP THIS CLOSES. `author ≠ auditor` is enforced for the PRODUCT — mutation
 * seeds, diff coverage, the e2e alarm — and not at all for the TESTS themselves.
 * A newly written test runs exactly once before it is merged, inside a full
 * suite, sharing a worker pool with a thousand siblings. A test that passes
 * because a sibling seeded a fixture, because a timer happened to fire, or
 * because it is 1-in-3 flaky, passes that one run and then costs everybody a
 * re-run habit for months. The cheapest falsifier is repetition in isolation:
 * three runs, alone, and any disagreement between them is the test telling you
 * it is not deterministic.
 *
 * ANY DISAGREEMENT IS RED, not just a failure. A file that fails 3/3 is a broken
 * test and the author sees it anyway; a file that passes twice and fails once is
 * the expensive one, and it is exactly what a single run cannot see.
 *
 * WHAT IT REFUSES TO RUN. Playwright and Maestro specs match `*.spec.*` and
 * `*.test.*` too, and running them here would boot browsers and emulators on the
 * PR gate — the opposite of the merge diet this lane ships inside. The nightly
 * rigs are refused for the opposite reason: they are FED by an artifact another
 * job publishes, and several fail on purpose under CI when it is absent. Both
 * are skipped with a printed reason rather than silently dropped, because a skip
 * nobody can see is indistinguishable from a check that never looked.
 *
 * Usage:
 *   node scripts/ci/burn-in.mjs [--base origin/main] [--runs 3] [--list]
 *   node scripts/ci/burn-in.mjs --files packages/core/src/a.test.ts
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const VITEST = path.join(root, "node_modules/vitest/vitest.mjs");

/** Extensions a Vitest project can actually load. */
export const BURN_IN_EXTENSIONS = Object.freeze([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

/**
 * Directory prefixes whose `*.spec.*` / `*.test.*` files are driven by a
 * browser or a device, not by Vitest. Kept as a literal list rather than a
 * clever heuristic: a wrong guess here either boots an emulator on the PR gate
 * or silently skips a real unit test, and both are worse than a list somebody
 * has to extend on purpose.
 */
export const DEVICE_DRIVEN_PREFIXES = Object.freeze([
  "tests/e2e/",
  "tests/agent-e2e-mobile/",
  "tests/agent-e2e-shared/",
  "tests/agent-e2e-compat/",
  "apps/web/tests/e2e/",
  "apps/desktop/tests/e2e/",
  "apps/extension/tests/e2e/",
]);

/**
 * Directory prefixes whose tests are NIGHTLY RIGS, fed by an artifact another
 * job publishes (`artifacts/perf-input/…`, the scale fixtures). Several of them
 * fail on purpose when `CI` is set and that artifact is absent, because at
 * rung 4 a missing artifact means the gate guarded nothing — so at rung 2,
 * where the artifact does not exist and cannot, a burn-in run measures the
 * absence rather than the test, three times. Their own lanes (`test:perf`,
 * `test:scale`) run them whole where the inputs are.
 */
export const NIGHTLY_RIG_PREFIXES = Object.freeze([
  "tests/perf/",
  "tests/scale/",
]);

/**
 * Why a changed file is not a burn-in candidate, or null when it is one.
 *
 * @param {string} file Repository-relative path.
 * @returns {string|null} Human-readable skip reason, or null to burn it in.
 */
export function skipReason(file) {
  const name = path.basename(file);
  if (!/\.(?:test|spec)\./u.test(name)) return "not a test file";
  if (!BURN_IN_EXTENSIONS.includes(path.extname(file)))
    return `${path.extname(file) || "no"} extension is not a Vitest module`;
  for (const prefix of DEVICE_DRIVEN_PREFIXES) {
    if (file.startsWith(prefix))
      return `driven by Playwright/Maestro (${prefix}), not Vitest`;
  }
  if (file.includes("/e2e/"))
    return "driven by Playwright/Maestro (/e2e/ path)";
  for (const prefix of NIGHTLY_RIG_PREFIXES) {
    if (file.startsWith(prefix))
      return `a nightly rig fed by another job's artifact (${prefix}); it runs whole on rung 4`;
  }
  return null;
}

/**
 * Split `git diff --name-only` output into burn-in candidates and skips.
 *
 * @param {string} stdout Raw diff output, one path per line.
 * @returns {{files: string[], skipped: {file: string, why: string}[]}} Partitioned paths.
 */
export function partitionChangedFiles(stdout) {
  const files = [];
  const skipped = [];
  for (const line of (stdout ?? "").split("\n")) {
    const file = line.trim();
    if (!file) continue;
    const name = path.basename(file);
    if (!/\.(?:test|spec)\./u.test(name)) continue;
    const why = skipReason(file);
    if (why) skipped.push({ file, why });
    else files.push(file);
  }
  return { files, skipped };
}

/**
 * The nearest ancestor directory that owns a `package.json`.
 *
 * Vitest resolves aliases, setup files and environment from the project it is
 * invoked in, so a test run from the repo root can pass or fail for reasons
 * that have nothing to do with the test. Running from the owning package is
 * what makes the three runs comparable to the run the suite does.
 *
 * @param {string} file Repository-relative path.
 * @param {(candidate: string) => boolean} hasPackageJson Existence probe, injected for tests.
 * @returns {string} Repository-relative package directory (`.` for the root).
 */
export function nearestPackageDir(file, hasPackageJson) {
  let dir = path.dirname(file);
  while (dir && dir !== "." && dir !== path.sep) {
    if (hasPackageJson(path.join(dir, "package.json"))) return dir;
    dir = path.dirname(dir);
  }
  return ".";
}

/**
 * The verdict for one file's repeated runs.
 *
 * @param {boolean[]} outcomes One boolean per run, true when the run passed.
 * @returns {{ok: boolean, why: string}} Verdict plus the sentence to print.
 */
export function verdictForRuns(outcomes) {
  const passed = outcomes.filter(Boolean).length;
  if (passed === outcomes.length)
    return { ok: true, why: `${passed}/${outcomes.length} passed` };
  if (passed === 0)
    return {
      ok: false,
      why: `failed all ${outcomes.length} runs — the test is broken, not flaky`,
    };
  return {
    ok: false,
    why: `DISAGREED across runs (${passed}/${outcomes.length} passed) — a non-deterministic test is a re-run habit with a green check on it`,
  };
}

/**
 * How each candidate is actually RUN, in first-match order.
 *
 * A monorepo does not have one test runner. The `scripts/**` unit tests are
 * driven by `node --test` (see the `scripts:test` script); the report and
 * mutation helpers, the release guards and the three suites under `tests/` each
 * have a Vitest config that the ROOT config does not load. Burning a file in
 * from the wrong place does not fail on the test: Vitest collects zero files
 * and exits non-zero, which this lane then reports as "the test is broken" for
 * a test that is fine. Kept as a literal first-match list for the same reason
 * DEVICE_DRIVEN_PREFIXES is — a wrong guess here is a false red on somebody
 * else's PR — and the bare `scripts/` catch-all must stay last.
 */
export const RUNNERS = Object.freeze([
  {
    prefix: "scripts/test-report/",
    runner: "vitest",
    config: "scripts/test-report/vitest.config.ts",
  },
  {
    prefix: "scripts/mutation/",
    runner: "vitest",
    config: "scripts/test-report/vitest.config.ts",
  },
  {
    prefix: "scripts/release/",
    runner: "vitest",
    config: "scripts/release/vitest.config.ts",
  },
  {
    prefix: "scripts/fuzz/",
    runner: "vitest",
    config: "scripts/fuzz/vitest.config.ts",
  },
  { prefix: "scripts/", runner: "node" },
  {
    prefix: "tests/integration-mobile/",
    runner: "vitest",
    config: "tests/integration-mobile/vitest.config.ts",
  },
  // tests/perf and tests/scale are not here on purpose: skipReason refuses
  // them upstream as nightly rigs, so no plan can reach them.
  {
    prefix: "tests/quality/",
    runner: "vitest",
    config: "vitest.quality.config.ts",
  },
]);

/**
 * The run plan for one candidate: which runner, from where, with what filter.
 *
 * Anything the table does not claim is a package-owned Vitest test, and runs
 * from its owning package for the reason nearestPackageDir documents.
 *
 * @param {string} file Repository-relative path.
 * @param {(candidate: string) => boolean} hasPackageJson Existence probe, injected for tests.
 * @returns {{runner: "node"|"vitest", cwd: string, filter: string, config?: string}} Run plan.
 */
export function planRun(file, hasPackageJson) {
  for (const entry of RUNNERS) {
    if (!file.startsWith(entry.prefix)) continue;
    if (entry.runner === "node")
      return { runner: "node", cwd: ".", filter: file };
    return { runner: "vitest", cwd: ".", filter: file, config: entry.config };
  }
  const dir = nearestPackageDir(file, hasPackageJson);
  return {
    runner: "vitest",
    cwd: dir,
    filter: path.relative(dir === "." ? "" : dir, file) || file,
  };
}

/**
 * The argv for one run of a plan, passed to `process.execPath`.
 *
 * @param {{runner: "node"|"vitest", filter: string, config?: string}} plan Run plan.
 * @returns {string[]} Node argv.
 */
export function argvFor(plan) {
  if (plan.runner === "node") return ["--test", plan.filter];
  return [
    VITEST,
    "run",
    ...(plan.config ? ["--config", plan.config] : []),
    plan.filter,
    "--no-coverage",
  ];
}

function parseArgs(argv) {
  const out = { base: "origin/main", runs: 3, files: null, list: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--base" && argv[i + 1]) out.base = argv[++i];
    else if (argv[i] === "--runs" && argv[i + 1]) out.runs = Number(argv[++i]);
    else if (argv[i] === "--files" && argv[i + 1])
      out.files = argv[++i]
        .split(",")
        .map((f) => f.trim())
        .filter(Boolean);
    else if (argv[i] === "--list") out.list = true;
  }
  return out;
}

function changedTestFiles(base) {
  // `A...B` is the merge-base diff: the files THIS branch changed, not the ones
  // main moved underneath it. `--diff-filter=AM` drops deletions and renames'
  // old halves, which have nothing to run.
  const result = spawnSync(
    "git",
    ["diff", "--name-only", "--diff-filter=AM", `${base}...HEAD`],
    { cwd: root, encoding: "utf8" }
  );
  if (result.status !== 0) {
    console.error(
      `::warning title=burn-in could not read the diff::\`git diff ${base}...HEAD\` exited ${result.status}; falling back to the working-tree diff against ${base}`
    );
    const fallback = spawnSync(
      "git",
      ["diff", "--name-only", "--diff-filter=AM", base],
      { cwd: root, encoding: "utf8" }
    );
    return fallback.stdout ?? "";
  }
  return result.stdout ?? "";
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const { files, skipped } = args.files
    ? partitionChangedFiles(args.files.join("\n"))
    : partitionChangedFiles(changedTestFiles(args.base));

  for (const entry of skipped) {
    console.log(`burn-in: skipping ${entry.file} — ${entry.why}`);
  }
  if (files.length === 0) {
    console.log(
      "burn-in: nothing to burn in (no added or modified Vitest test files)"
    );
    return;
  }
  const plans = files.map((file) => ({
    file,
    plan: planRun(file, (candidate) => existsSync(path.join(root, candidate))),
  }));
  if (args.list) {
    for (const { file, plan } of plans) {
      const where = plan.config ? ` --config ${plan.config}` : "";
      console.log(`${file}: ${plan.runner}${where} (cwd ${plan.cwd})`);
    }
    return;
  }

  /** @type {{file: string, why: string}[]} */
  const failures = [];
  for (const { file, plan } of plans) {
    /** @type {boolean[]} */
    const outcomes = [];
    for (let attempt = 1; attempt <= args.runs; attempt += 1) {
      const run = spawnSync(process.execPath, argvFor(plan), {
        cwd: path.join(root, plan.cwd),
        stdio: "inherit",
      });
      outcomes.push(run.status === 0);
    }
    const verdict = verdictForRuns(outcomes);
    console.log(`burn-in: ${file} — ${verdict.why}`);
    if (!verdict.ok) failures.push({ file, why: verdict.why });
  }

  if (failures.length === 0) {
    console.log(
      `burn-in: ${files.length} file(s) each passed ${args.runs}/${args.runs} runs in isolation`
    );
    return;
  }
  for (const failure of failures) {
    console.error(
      `::error title=New-test burn-in::${failure.file} ${failure.why}`
    );
  }
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main();
}
