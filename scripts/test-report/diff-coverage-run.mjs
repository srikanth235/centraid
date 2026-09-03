import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { isInstrumentableSource } from "./diff-coverage.mjs";

const root = path.resolve(import.meta.dirname, "../..");

export function parseArgs(argv) {
  const out = { base: /** @type {string | null} */ (null), dependents: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--base" && argv[i + 1]) out.base = argv[++i];
    else if (argv[i] === "--dependents") out.dependents = true;
  }
  return out;
}

function git(args) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

export function resolveBase(explicit) {
  if (explicit) return explicit;
  for (const candidate of ["origin/main", "main", "origin/master", "master"]) {
    if (git(["rev-parse", "--verify", candidate]).trim()) return candidate;
  }
  return null;
}

export function changedFiles(baseRef) {
  const names = [
    ...git(["diff", "--name-only", `${baseRef}...HEAD`]).split("\n"),
    ...git(["diff", "--name-only"]).split("\n"),
    ...git(["diff", "--cached", "--name-only"]).split("\n"),
  ];
  return [...new Set(names.map((n) => n.trim()).filter(Boolean))];
}

export function workspaceDirOf(filePath) {
  const m = /^(?<workspaceDir>(?:packages|apps|tools)\/[^/]+)\//u.exec(
    filePath
  );
  return m?.groups?.workspaceDir ?? null;
}

export function projectNameOf(dir) {
  const manifest = path.join(root, dir, "package.json");
  if (!existsSync(manifest)) return null;
  const hasVitest = [
    "vitest.config.ts",
    "vitest.config.mts",
    "vitest.config.js",
  ].some((f) => existsSync(path.join(root, dir, f)));
  if (!hasVitest) return null;
  try {
    const name = JSON.parse(readFileSync(manifest, "utf8")).name;
    return typeof name === "string" && name ? name : null;
  } catch {
    return null;
  }
}

export function vitestProjectNames(names) {
  return names.flatMap((name) =>
    name === "@centraid/mobile" ? [name, "@centraid/mobile-rn"] : [name]
  );
}

function dependentsOf(baseRef) {
  const res = spawnSync(
    "bun",
    ["run", "turbo", "run", "test", `--filter=...[${baseRef}]`, "--dry=json"],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  if (res.status !== 0 || !res.stdout) return null;
  try {
    const parsed = JSON.parse(res.stdout);
    const packages = parsed?.packages;
    return Array.isArray(packages)
      ? packages.filter((p) => typeof p === "string")
      : null;
  } catch {
    return null;
  }
}

export function run(command, args) {
  const res = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  return res.status ?? 1;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  git(["fetch", "--no-tags", "origin", "main"]);

  const baseRef = resolveBase(args.base);
  if (!baseRef) {
    console.error("diff-coverage-run: no base ref found; pass --base <ref>");
    return 1;
  }

  const changed = changedFiles(baseRef);
  const instrumentable = changed.filter(isInstrumentableSource);
  if (instrumentable.length === 0) {
    console.log(
      `diff-coverage-run: no instrumentable source changed vs ${baseRef} (${changed.length} file(s) in the diff) — nothing to score`
    );
    return 0;
  }

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
        "diff-coverage-run: turbo could not resolve dependents — scoring changed packages only"
      );
    }
  }

  if (projects.size === 0) {
    console.error(
      `diff-coverage-run: ${instrumentable.length} instrumentable file(s) changed but no vitest project owns them:\n  ${instrumentable.join("\n  ")}`
    );
    return 1;
  }

  const names = [...projects].sort();
  const testProjectNames = vitestProjectNames(names);
  console.log(
    `diff-coverage-run: ${testProjectNames.length} project(s) — ${testProjectNames.join(", ")}`
  );

  const buildStatus = run("bun", [
    "run",
    "turbo",
    "run",
    "build",
    ...names.map((n) => `--filter=${n}`),
  ]);
  if (buildStatus !== 0) return buildStatus;

  const testStatus = run("node", [
    "node_modules/vitest/vitest.mjs",
    "run",
    "--config",
    "vitest.diff-coverage.config.ts",
    "--coverage",
    ...testProjectNames.map((n) => `--project=${n}`),
  ]);
  if (testStatus !== 0) return testStatus;

  return run("node", [
    "scripts/test-report/diff-coverage.mjs",
    "--base",
    baseRef,
  ]);
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename;
if (isMain) {
  process.exitCode = main();
}
