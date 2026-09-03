#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const VITEST = path.join(root, "node_modules/vitest/vitest.mjs");

export const BURN_IN_EXTENSIONS = Object.freeze([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

export const DEVICE_DRIVEN_PREFIXES = Object.freeze([
  "tests/e2e/",
  "tests/agent-e2e-mobile/",
  "tests/agent-e2e-shared/",
  "tests/agent-e2e-compat/",
  "apps/web/tests/e2e/",
  "apps/desktop/tests/e2e/",
  "apps/extension/tests/e2e/",
]);

export const NIGHTLY_RIG_PREFIXES = Object.freeze([
  "tests/perf/",
  "tests/scale/",
]);

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

export function parseShard(value) {
  const match = /^(?<shard>\d+)\/(?<total>\d+)$/u.exec(String(value).trim());
  if (!match)
    throw new Error(`--shard wants "i/N", got ${JSON.stringify(value)}`);
  const shard = Number(match.groups.shard);
  const total = Number(match.groups.total);
  if (total < 1) throw new Error(`--shard total must be >= 1, got ${total}`);
  if (shard < 1 || shard > total)
    throw new Error(`--shard ${shard}/${total} is out of range: 1..${total}`);
  return { shard, total };
}

export function selectShard(files, shard, total) {
  if (total <= 1) return [...files];
  return [...files].sort().filter((_, index) => index % total === shard - 1);
}

const VITEST_PROJECT_CONFIGS = Object.freeze([
  "vitest.config.ts",
  "vitest.config.mts",
  "vitest.config.js",
  "vitest.config.mjs",
  "vite.config.ts",
  "vite.config.mts",
  "vite.config.js",
  "vite.config.mjs",
]);

export function nearestVitestProjectDir(file, hasFile) {
  let dir = path.dirname(file);
  while (dir && dir !== "." && dir !== path.sep) {
    if (
      hasFile(path.join(dir, "package.json")) &&
      VITEST_PROJECT_CONFIGS.some((name) => hasFile(path.join(dir, name)))
    )
      return dir;
    dir = path.dirname(dir);
  }
  return ".";
}

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
  {
    prefix: "tests/quality/",
    runner: "vitest",
    config: "vitest.quality.config.ts",
  },
]);

export function planRun(file, hasFile) {
  for (const entry of RUNNERS) {
    if (!file.startsWith(entry.prefix)) continue;
    if (entry.runner === "node")
      return { runner: "node", cwd: ".", filter: file };
    return { runner: "vitest", cwd: ".", filter: file, config: entry.config };
  }
  const dir = nearestVitestProjectDir(file, hasFile);
  return {
    runner: "vitest",
    cwd: dir,
    filter: path.relative(dir === "." ? "" : dir, file) || file,
  };
}

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
  const out = {
    base: "origin/main",
    runs: 3,
    files: null,
    list: false,
    shard: 1,
    total: 1,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--base" && argv[i + 1]) out.base = argv[++i];
    else if (argv[i] === "--runs" && argv[i + 1]) out.runs = Number(argv[++i]);
    else if (argv[i] === "--shard" && argv[i + 1])
      Object.assign(out, parseShard(argv[++i]));
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
  const { files: candidates, skipped } = args.files
    ? partitionChangedFiles(args.files.join("\n"))
    : partitionChangedFiles(changedTestFiles(args.base));

  for (const entry of skipped) {
    console.log(`burn-in: skipping ${entry.file} — ${entry.why}`);
  }
  const files = selectShard(candidates, args.shard, args.total);
  const of =
    args.total > 1
      ? ` (shard ${args.shard}/${args.total}: ${files.length} of ${candidates.length} candidate(s))`
      : "";
  if (files.length === 0) {
    console.log(
      candidates.length === 0
        ? `burn-in: nothing to burn in (no added or modified Vitest test files)${of}`
        : `burn-in: this shard's slice is empty — ${candidates.length} candidate(s) across ${args.total} shards${of}`
    );
    return;
  }
  console.log(`burn-in: ${files.length} file(s) to burn in${of}`);
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

  const failures = [];
  for (const { file, plan } of plans) {
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
      `burn-in: ${files.length} file(s) each passed ${args.runs}/${args.runs} runs in isolation${of}`
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
  try {
    main();
  } catch (error) {
    console.error(`::error title=New-test burn-in::${error.message}`);
    process.exitCode = 2;
  }
}
