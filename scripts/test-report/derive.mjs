/**
 * The derived half of the report's inputs (#915 Wave 3, contract C3).
 *
 * `tests/claims.json` holds only what a machine cannot derive. Everything a
 * machine CAN read off the repo is read here, at report time, so no hand-typed
 * copy of it can drift: journeys and their budgets from the mobile roster,
 * mutation seeds from the seed catalog, fuzz targets from the target catalog,
 * Vitest projects from `vitest.config.ts`, Stryker configs by glob, and the
 * quality-rig and experience budgets from their ledgers.
 *
 * Every function here is deterministic and offline — the constitution's
 * `coverage-scope-reachability` directive shells out to `derive-flows.mjs`,
 * which sits on top of this module, so a network call or a clock read would
 * make a governance check nondeterministic.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const ROOT = path.resolve(import.meta.dirname, "../..");

/** Read and parse a repo-relative JSON file, or return `fallback`. */
export function readJson(relative, fallback = null) {
  try {
    return JSON.parse(readFileSync(path.join(ROOT, relative), "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * The mobile roster.
 *
 * SHIM (#915): the roster reader `tests/agent-e2e-mobile/lib/roster.mjs` is
 * being written by the MOBILE slice in the same wave. Until it exists this
 * reads `roster.json` directly and normalises the fields the report needs;
 * once the module lands, `loadRoster()` from it is used instead and this
 * fallback can be deleted.
 */
export async function loadRoster() {
  const modulePath = path.join(ROOT, "tests/agent-e2e-mobile/lib/roster.mjs");
  if (existsSync(modulePath)) {
    const module = await import(modulePath);
    if (typeof module.loadRoster === "function") return module.loadRoster();
  }
  return readJson("tests/agent-e2e-mobile/roster.json", {
    lanes: {},
    flows: {},
  });
}

/** The flow id a roster path denotes: `flows/pairing-canary.mjs` → `pairing-canary`. */
export function flowId(flowPath) {
  return path.basename(String(flowPath), ".mjs");
}

/**
 * The suites the roster declares, normalised for §5.
 *
 * `tests/agent-e2e-mobile/roster.json` is THE roster since #915 Wave 2: a
 * suite carries its own tighten-only `budgetMs`, its budget doc, the rungs and
 * platforms it runs on, and its flow list. Nothing is read off a runner file
 * any more — `run-roster.mjs` reads the same rows this does.
 *
 * @param {object} roster the parsed mobile roster
 * @returns {{id: string, runner: string|null, budgetMs: number|null, lane: string|null, platform: string|null, rungs: number[], flows: string[]}[]} one entry per suite the roster declares
 */
export function readSuiteRunners(roster = null) {
  const source =
    roster ?? readJson("tests/agent-e2e-mobile/roster.json", { suites: {} });
  return Object.entries(source.suites ?? {})
    .map(([id, suite]) => ({
      id,
      runner: suite.doc ?? null,
      budgetMs: Number(suite.budgetMs ?? 0) || null,
      lane: suite.lane ?? null,
      platform: [suite.platform ?? []].flat()[0] ?? null,
      rungs: [suite.rungs ?? []].flat().map(Number),
      flows: [suite.flows ?? []].flat(),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Journeys for §5, grouped by suite. Suite budgets are tighten-only and live
 * with the suite; a flow appears once, under each suite that schedules it.
 * @param {object} roster the parsed mobile roster
 * @param {ReturnType<typeof readSuiteRunners>} [suites] the roster's suites, injected so a test can supply its own
 */
export function deriveJourneys(roster, suites = readSuiteRunners(roster)) {
  return suites
    .map((suite) => ({
      id: suite.id,
      runner: suite.runner,
      rung: Math.min(...(suite.rungs.length > 0 ? suite.rungs : [4])),
      platform: suite.platform ?? "android",
      budgetMs: suite.budgetMs,
      budgetDoc: roster.suites?.[suite.id]?.doc ?? null,
      flows: suite.flows.map((file) => {
        const entry =
          roster.flows?.[`tests/agent-e2e-mobile/flows/${file}`] ?? {};
        return {
          id: flowId(file),
          path: `tests/agent-e2e-mobile/flows/${file}`,
          claim: entry.claim ?? "",
          status: entry.status ?? "scheduled",
          budgetMs: Number(entry.budgetMs ?? 0) || null,
        };
      }),
    }))
    .sort((a, b) => a.rung - b.rung || a.id.localeCompare(b.id));
}

/** The mutation seed catalog, as `{id, label, cwd, config}` rows. */
export async function deriveSeeds() {
  const { MUTATION_SEEDS } = await import(
    path.join(ROOT, "scripts/mutation/seeds.mjs")
  );
  return MUTATION_SEEDS.map((seed) => ({
    id: seed.id,
    label: seed.label,
    cwd: seed.cwd,
    config: seed.config,
  }));
}

/** The fuzz target catalog, as `{id, corpus}` rows. */
export async function deriveFuzzTargets() {
  const { FUZZ_TARGETS } = await import(
    path.join(ROOT, "scripts/fuzz/targets.mjs")
  );
  return FUZZ_TARGETS.map((target) => ({
    id: target.id,
    corpus: target.corpus ?? null,
  }));
}

/** Every committed `stryker.config.mjs`, as package-relative paths. */
export function deriveStrykerConfigs() {
  const packages = path.join(ROOT, "packages");
  const found = [];
  for (const entry of readdirSync(packages, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const config = path.join(packages, entry.name, "stryker.config.mjs");
    if (existsSync(config))
      found.push(`packages/${entry.name}/stryker.config.mjs`);
  }
  return found.sort();
}

/** The Vitest projects the repo-wide run covers. */
export async function deriveVitestProjects() {
  // Parsed from the source rather than imported: `vitest.config.ts` pulls in
  // TypeScript-only modules that a plain node process cannot load.
  const source = readFileSync(path.join(ROOT, "vitest.config.ts"), "utf8");
  const block = source.match(
    /export const coverageProjects = \[(?<body>[\s\S]*?)\];/u
  );
  if (!block) return [];
  return [...block.groups.body.matchAll(/"(?<name>[^"]+)"/gu)].map(
    (match) => match.groups.name
  );
}

/** Quality-rig budgets, keyed by rig path (`tests/journeys.json#rigs`). */
export function deriveRigBudgets() {
  return readJson("tests/journeys.json", {}).rigs ?? {};
}

/**
 * The journey ledger's entries, grouped by surface so the report page keeps
 * its per-surface section (#927). The grouping is derived from each entry's
 * own `surface`, so a new surface needs no edit here.
 */
export function deriveExperienceBudgets() {
  const entries = readJson("tests/journeys.json", {}).entries ?? {};
  const out = {};
  for (const [key, entry] of Object.entries(entries))
    (out[entry.surface] ??= {})[key] = entry;
  return out;
}

/**
 * Flow ownership: the claims file's hand-typed flows plus every committed
 * mobile flow from the roster. This is the view the constitution's
 * `coverage-scope-reachability` directive reads.
 * @param {object} claims a parsed claims file
 * @param {object} roster the parsed mobile roster
 */
export function deriveFlows(claims, roster) {
  const flows = (claims.flows ?? []).map((flow) => ({
    id: flow.id,
    owner: flow.owner,
    surface: flow.surface ?? null,
    dimension: flow.dimension ?? null,
    tier: flow.tier ?? null,
    minimumTests: flow.minimumTests ?? null,
  }));
  const seen = new Set(flows.map((flow) => flow.id));
  for (const flowPath of Object.keys(roster.flows ?? {})) {
    const id = flowId(flowPath);
    if (seen.has(id)) continue;
    seen.add(id);
    flows.push({
      id,
      owner: flowPath,
      surface: "mobile",
      dimension: "journey",
      tier: "e2e",
      minimumTests: null,
    });
  }
  return flows.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Everything derived, in one call, for the read model.
 * @param {object} claims a validated claims file
 */
export async function deriveAll(claims) {
  const roster = await loadRoster();
  return {
    roster,
    journeys: deriveJourneys(roster),
    flows: deriveFlows(claims, roster),
    seeds: await deriveSeeds(),
    fuzzTargets: await deriveFuzzTargets(),
    strykerConfigs: deriveStrykerConfigs(),
    vitestProjects: await deriveVitestProjects(),
    rigBudgets: deriveRigBudgets(),
    experienceBudgets: deriveExperienceBudgets(),
  };
}
