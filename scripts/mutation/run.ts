/**
 * Mutation lane runner (#532).
 *
 * Runs StrykerJS from each seed package directory (package-local
 * `stryker.config.mjs` + `vitest.mutation.config.ts`) and writes a normalized
 * scores JSON under artifacts/mutation/ for the test-health report.
 *
 * Usage:
 *   node scripts/mutation/run.ts
 *   node scripts/mutation/run.ts --package vault
 *   node scripts/mutation/run.ts --affected [--base origin/main]
 *   node scripts/mutation/run.ts --enforce-floors
 *   node scripts/mutation/run.ts --dry-run
 *
 * Per-PR lane (`bun run test:mutation:pr`) is `--affected --enforce-floors`.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { MUTATION_GLOBAL_WATCH, MUTATION_SEEDS } from "./seeds.ts";
import type { MutationSeed } from "./seeds.ts";

export { MUTATION_GLOBAL_WATCH, MUTATION_SEEDS } from "./seeds.ts";
export type { MutationSeed } from "./seeds.ts";
const root = path.resolve(import.meta.dirname, "../..");

/**
 * Normalize a Stryker JSON report into a score percentage.
 * @param {unknown} report Stryker JSON report object.
 * @returns {number | null} Mutation score 0–100, or null if missing.
 */
export function mutationScoreFromReport(report: unknown): number | null {
  if (!report || typeof report !== "object") return null;
  const r = report as Record<string, unknown>;
  if (typeof r.mutationScore === "number") return r.mutationScore;
  const metrics = r.metrics ?? r.totals;
  if (metrics && typeof metrics === "object") {
    const m = metrics as Record<string, unknown>;
    if (typeof m.mutationScore === "number") return m.mutationScore;
    if (
      typeof m.killed === "number" &&
      typeof m.totalValid === "number" &&
      m.totalValid > 0
    ) {
      return (m.killed / m.totalValid) * 100;
    }
    if (
      typeof m.killed === "number" &&
      typeof m.survived === "number" &&
      typeof m.timeout === "number"
    ) {
      const denom =
        m.killed + m.survived + m.timeout + (Number(m.noCoverage) || 0);
      if (denom > 0) return (m.killed / denom) * 100;
    }
  }
  if (r.files && typeof r.files === "object") {
    const fileEntries = Object.values(
      r.files as Record<
        string,
        { mutationScore?: number; mutants?: Array<{ status?: string }> }
      >
    );
    const scores = fileEntries
      .map((f) => f?.mutationScore)
      .filter((n) => typeof n === "number");
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
          status === "Killed" ||
          status === "Timeout" ||
          status === "RuntimeError" ||
          status === "CompileError"
        ) {
          killed += status === "Killed" || status === "Timeout" ? 1 : 0;
          valid += 1;
        } else if (status === "Survived" || status === "NoCoverage") {
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
export function buildScoresArtifact(rows: unknown): {
  generatedAt: string;
  lane: string;
  packages: unknown;
} {
  return {
    generatedAt: new Date().toISOString(),
    lane: "mutation",
    packages: rows,
  };
}

/**
 * Compare measured scores against floors.
 * @param {{ packages?: Array<{ id?: string; score?: number | null }> }} scores Artifact.
 * @param {Record<string, unknown>} floors the `tests/floors.json#mutation` shape.
 * @returns {string[]} Human-readable errors (empty = pass).
 */
/**
 * Assert every floor key (except meta) is a known MUTATION_SEEDS id.
 * @param {Record<string, unknown>} floors Mutation floors object from disk.
 * @param {import('./seeds.ts').MutationSeed[]} [seeds] Seed catalog (defaults to MUTATION_SEEDS).
 * @returns {string[]} Errors when a floor id is not in the seed catalog.
 */
export function assertFloorsSubsetOfSeeds(
  floors: Record<string, unknown>,
  seeds: MutationSeed[] = MUTATION_SEEDS
): string[] {
  const errors: string[] = [];
  if (!floors || typeof floors !== "object") return errors;
  const seedIds = new Set(seeds.map((s) => s.id));
  for (const id of Object.keys(floors)) {
    if (id.startsWith("_") || id === "approvedDeviation") continue;
    if (typeof floors[id] !== "number") continue;
    if (!seedIds.has(id)) {
      errors.push(
        `mutation floor "${id}" has no matching MUTATION_SEEDS entry (floors ⊆ seeds)`
      );
    }
  }
  return errors;
}

export function enforceMutationFloors(scores: unknown, floors: unknown) {
  const errors: string[] = [];
  if (!floors || typeof floors !== "object") return errors;
  const scoreRecord =
    scores && typeof scores === "object"
      ? (scores as Record<string, unknown>)
      : {};
  const packages = Array.isArray(scoreRecord["packages"])
    ? scoreRecord["packages"]
    : [];
  const byId = new Map(
    packages
      .filter((p: unknown) => typeof p === "object" && p !== null && "id" in p)
      .map((p: unknown) => {
        const row = p as { id: string; score?: number | null };
        return [row.id, row] as const;
      })
  );
  for (const [id, floor] of Object.entries(floors as Record<string, unknown>)) {
    if (id.startsWith("_") || id === "approvedDeviation") continue;
    if (typeof floor !== "number") continue;
    const row = byId.get(id);
    // #545 A5 — missing score is a gate failure (Stryker crash, renamed seed,
    // config drift). Previously `continue` left mutation-pr green.
    if (!row || typeof row.score !== "number") {
      errors.push(
        `mutation floor "${id}" has no measured score (seed missing, crashed, or skipped)`
      );
      continue;
    }
    if (row.score + 1e-9 < floor) {
      errors.push(
        `mutation floor "${id}" not met: measured ${row.score.toFixed(2)} < floor ${floor}`
      );
    }
  }
  return errors;
}

/**
 * Select seeds whose watch paths intersect the changed file set.
 * @param {string[]} changedFiles Paths relative to repo root.
 * @param {import('./seeds.ts').MutationSeed[]} [seeds] Seed list to filter (defaults to MUTATION_SEEDS).
 * @param {string[]} [globalWatch] Paths that force every seed when changed.
 * @returns {import('./seeds.ts').MutationSeed[]} Seeds that need re-mutation for the change set.
 */
export function selectAffectedSeeds(
  changedFiles: string[],
  seeds: MutationSeed[] = MUTATION_SEEDS,
  globalWatch: string[] = MUTATION_GLOBAL_WATCH
): MutationSeed[] {
  const changed = new Set(changedFiles.map((f) => f.replace(/\\/gu, "/")));
  if (globalWatch.some((g) => changed.has(g))) return [...seeds];
  return seeds.filter((seed) =>
    seed.watch.some(
      (w) => changed.has(w) || [...changed].some((c) => c.startsWith(`${w}/`))
    )
  );
}

/**
 * List files changed vs a git base ref (triple-dot: merge-base…HEAD).
 * @param {string} base Git ref (e.g. origin/main).
 * @param {string} [cwd] Repo root.
 * @returns {string[]} Paths relative to the repo root.
 */
export function listChangedFiles(base: string, cwd: string = root): string[] {
  try {
    const out = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], {
      cwd,
      encoding: "utf8",
    });
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    try {
      const out = execFileSync("git", ["diff", "--name-only", base], {
        cwd,
        encoding: "utf8",
      });
      return out
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }
}

/**
 * Load mutation score floors from disk.
 * @param {string} [floorsPath] Absolute path to the merged floors ledger.
 * @returns {Record<string, unknown>} The `mutation` section, or empty when missing.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function loadMutationFloors(
  floorsPath = path.join(root, "tests/floors.json")
): Record<string, unknown> {
  if (!existsSync(floorsPath)) return {};
  const parsed: unknown = JSON.parse(readFileSync(floorsPath, "utf8"));
  return isRecord(parsed) && isRecord(parsed.mutation) ? parsed.mutation : {};
}

/**
 * `tests/floors.json#<section>` tokens for the sections that differ from the
 * merge base, so a section of a merged ledger can be watched without watching
 * the whole file (#915 Wave 4).
 * @param {unknown} base the floors ledger on the merge base
 * @param {unknown} head the floors ledger in the working tree
 * @returns {string[]} one token per section whose content changed
 */
export function changedFloorSections(base: unknown, head: unknown): string[] {
  const baseRecord = isRecord(base) ? base : {};
  const headRecord = isRecord(head) ? head : {};
  const keys = new Set([
    ...Object.keys(baseRecord),
    ...Object.keys(headRecord),
  ]);
  return [...keys]
    .filter(
      (key) =>
        !key.startsWith("_") &&
        JSON.stringify(baseRecord[key]) !== JSON.stringify(headRecord[key])
    )
    .map((key) => `tests/floors.json#${key}`)
    .sort();
}

/**
 * Read a JSON file at a git ref, or null when it is not there.
 * @param {string} ref git ref
 * @param {string} relative repo-relative path
 * @param {string} [cwd] repo root
 * @returns {unknown} the parsed document, or null
 */
export function readJsonAtRef(
  ref: string,
  relative: string,
  cwd: string = root
): unknown {
  try {
    return JSON.parse(
      execFileSync("git", ["show", `${ref}:${relative}`], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
    );
  } catch {
    return null;
  }
}

function parseArgs(argv: string[]): {
  package?: string;
  dryRun: boolean;
  help: boolean;
  affected: boolean;
  enforceFloors: boolean;
  base: string;
} {
  const out: {
    package?: string;
    dryRun: boolean;
    help: boolean;
    affected: boolean;
    enforceFloors: boolean;
    base: string;
  } = {
    dryRun: false,
    help: false,
    affected: false,
    enforceFloors: false,
    base: "origin/main",
  };
  for (let i = 0; i < argv.length; i++) {
    const current = argv[i];
    const next = argv[i + 1];
    if (current === "--package" && next) {
      out.package = next;
      i += 1;
    } else if (current === "--dry-run") out.dryRun = true;
    else if (current === "--affected") out.affected = true;
    else if (current === "--enforce-floors") out.enforceFloors = true;
    else if (current === "--base" && next) {
      out.base = next;
      i += 1;
    } else if (argv[i] === "--help" || argv[i] === "-h") out.help = true;
  }
  return out;
}

function findStrykerBin() {
  for (const candidate of [
    path.join(root, "node_modules", ".bin", "stryker"),
    path.join(
      root,
      "node_modules",
      "@stryker-mutator",
      "core",
      "bin",
      "stryker.js"
    ),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Run Stryker for each seed and return score rows.
 * @param {import('./seeds.ts').MutationSeed[]} seeds Seeds to mutate.
 */
function runSeeds(seeds: MutationSeed[]) {
  const stryker = findStrykerBin();
  if (!stryker) {
    console.error(
      "mutation: @stryker-mutator/core not installed (devDependency). Nightly installs it via bun install."
    );
    return seeds.map((s) => ({
      id: s.id,
      label: s.label,
      score: null,
      status: "unavailable",
      error: "stryker binary missing",
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
        status: "failed",
        error: `missing ${seed.cwd}/${seed.config}`,
      });
      continue;
    }
    console.log(`mutation: running Stryker for ${seed.id} (cwd ${seed.cwd})…`);
    // One retry: CI hosts occasionally return "No tests were executed" on the
    // first dry-run under load even though the same vitest.mutation.config is
    // healthy (repro intermittent on ubuntu-latest for vault/automation).
    let result = spawnSync(process.execPath, [stryker, "run", seed.config], {
      cwd: pkgDir,
      encoding: "utf8",
      env: { ...process.env, FORCE_COLOR: "0" },
      maxBuffer: 64 * 1024 * 1024,
    });
    const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    if (
      result.status !== 0 &&
      /No tests were (?:executed|found)/iu.test(combined) &&
      !existsSync(path.join(root, seed.report))
    ) {
      console.warn(
        `mutation: ${seed.id} dry-run found no tests — retrying once…`
      );
      result = spawnSync(process.execPath, [stryker, "run", seed.config], {
        cwd: pkgDir,
        encoding: "utf8",
        env: { ...process.env, FORCE_COLOR: "0" },
        maxBuffer: 64 * 1024 * 1024,
      });
    }
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);

    let score = null;
    let status = result.status === 0 ? "ok" : "failed";
    const reportAbs = path.join(root, seed.report);
    if (existsSync(reportAbs)) {
      try {
        const report = JSON.parse(readFileSync(reportAbs, "utf8"));
        score = mutationScoreFromReport(report);
        if (score !== null) status = "ok";
      } catch (error) {
        rows.push({
          id: seed.id,
          label: seed.label,
          score: null,
          status: "failed",
          reportPath: seed.report,
          error: String(error),
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
      "Usage: node scripts/mutation/run.ts [--package <label>] [--affected] [--base origin/main] [--enforce-floors] [--dry-run]"
    );
    process.exit(0);
  }

  /** @type {import('./seeds.ts').MutationSeed[]} */
  let seeds;
  const packageFilter = args.package;
  if (packageFilter) {
    seeds = MUTATION_SEEDS.filter(
      (s) => s.label === packageFilter || s.id.includes(packageFilter)
    );
    if (!seeds.length) {
      console.error(`mutation: unknown package filter ${args.package}`);
      process.exitCode = 1;
      return;
    }
  } else if (args.affected) {
    let changed = listChangedFiles(args.base);
    // A merged ledger is watched by SECTION: expand tests/floors.json into the
    // sections that actually moved before the watch list is consulted.
    if (changed.includes("tests/floors.json")) {
      changed = [
        ...changed,
        ...changedFloorSections(
          readJsonAtRef(args.base, "tests/floors.json"),
          existsSync(path.join(root, "tests/floors.json"))
            ? JSON.parse(
                readFileSync(path.join(root, "tests/floors.json"), "utf8")
              )
            : null
        ),
      ];
    }
    seeds = selectAffectedSeeds(changed);
    console.log(
      `mutation: --affected vs ${args.base}: ${changed.length} changed file(s), ${seeds.length} seed(s)`
    );
    if (!seeds.length) {
      mkdirSync(path.join(root, "artifacts/mutation"), { recursive: true });
      writeFileSync(
        path.join(root, "artifacts/mutation/scores.json"),
        JSON.stringify(
          buildScoresArtifact([
            {
              id: "_none",
              label: "none",
              score: null,
              status: "skipped",
              error: "no mutation seeds affected by diff",
            },
          ]),
          null,
          2
        )
      );
      console.log("mutation: no seeds affected — skipping Stryker (ok)");
      return;
    }
    for (const s of seeds) console.log(`  - ${s.id}`);
  } else {
    seeds = MUTATION_SEEDS;
  }

  mkdirSync(path.join(root, "artifacts/mutation"), { recursive: true });

  if (args.dryRun) {
    const rows = seeds.map((s) => ({
      id: s.id,
      label: s.label,
      score: null,
      status: "dry-run",
      reportPath: s.report,
    }));
    writeFileSync(
      path.join(root, "artifacts/mutation/scores.json"),
      JSON.stringify(buildScoresArtifact(rows), null, 2)
    );
    console.log("mutation: dry-run wrote artifacts/mutation/scores.json");
    return;
  }

  const rows = runSeeds(seeds);
  const artifact = buildScoresArtifact(rows);
  writeFileSync(
    path.join(root, "artifacts/mutation/scores.json"),
    JSON.stringify(artifact, null, 2)
  );
  console.log("mutation: wrote artifacts/mutation/scores.json");
  for (const row of rows) {
    console.log(
      `  - ${row.id}: ${row.score === null ? "n/a" : `${row.score.toFixed(1)}%`} (${row.status})`
    );
  }

  let failed = rows.some(
    (r) => r.status === "failed" || r.status === "unavailable"
  );

  if (args.enforceFloors) {
    const floors = loadMutationFloors();
    // Only enforce floors for seeds that ran (affected / --package). Full
    // nightly runs every seed so every floor is checked.
    const ranIds = new Set(rows.map((r) => r.id));
    const floorsForRun = Object.fromEntries(
      Object.entries(floors).filter(([id, v]) => {
        if (id.startsWith("_") || id === "approvedDeviation") return true;
        if (typeof v !== "number") return true;
        return ranIds.has(id);
      })
    );
    const subsetErrors = assertFloorsSubsetOfSeeds(floors);
    const floorErrors = [
      ...subsetErrors,
      ...enforceMutationFloors(artifact, floorsForRun),
    ];
    if (floorErrors.length) {
      for (const e of floorErrors) console.error(`mutation: ${e}`);
      failed = true;
    } else {
      console.log("mutation: floors met for measured packages");
    }
  }

  if (failed) process.exitCode = 1;
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename;
if (isMain) {
  main();
}
