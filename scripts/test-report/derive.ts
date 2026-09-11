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

import { bags, dict } from "./record.ts";
import type { Loose } from "./record.ts";

export const ROOT = path.resolve(import.meta.dirname, "../..");

/** Read and parse a repo-relative JSON file, or return `fallback`. */
export function readJson(relative: string, fallback: unknown = null): unknown {
  try {
    return JSON.parse(
      readFileSync(path.join(ROOT, relative), "utf8")
    ) as unknown;
  } catch {
    return fallback;
  }
}

/**
 * The mobile roster.
 *
 * SHIM (#915): the roster reader `tests/agent-e2e-mobile/lib/roster.ts` is
 * being written by the MOBILE slice in the same wave. Until it exists this
 * reads `roster.json` directly and normalises the fields the report needs;
 * once the module lands, `loadRoster()` from it is used instead and this
 * fallback can be deleted.
 */
export async function loadRoster() {
  const modulePath = path.join(ROOT, "tests/agent-e2e-mobile/lib/roster.ts");
  if (existsSync(modulePath)) {
    const module = await import(modulePath);
    if (typeof module.loadRoster === "function") return module.loadRoster();
  }
  return readJson("tests/agent-e2e-mobile/roster.json", {
    lanes: {},
    flows: {},
  });
}

/** The flow id a roster path denotes: `flows/pairing-canary.ts` → `pairing-canary`. */
export function flowId(flowPath: unknown) {
  return path.basename(String(flowPath)).replace(/\.(?:mjs|ts)$/u, "");
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
export function readSuiteRunners(roster: unknown = null): {
  id: string;
  runner: string | null;
  budgetMs: number | null;
  lane: string | null;
  platform: string | null;
  rungs: number[];
  flows: string[];
}[] {
  const source = dict(
    roster ?? readJson("tests/agent-e2e-mobile/roster.json", { suites: {} })
  );
  return Object.entries(dict(source.suites))
    .map(([id, raw]) => {
      const suite = dict(raw);
      const platform = [suite.platform ?? []].flat()[0];
      return {
        id,
        runner: typeof suite.doc === "string" ? suite.doc : null,
        budgetMs: Number(suite.budgetMs ?? 0) || null,
        lane: typeof suite.lane === "string" ? suite.lane : null,
        platform: platform == null ? null : String(platform),
        rungs: [suite.rungs ?? []].flat().map(Number),
        flows: [suite.flows ?? []].flat().map(String),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Journeys for §5, grouped by suite. Suite budgets are tighten-only and live
 * with the suite; a flow appears once, under each suite that schedules it.
 * @param {object} roster the parsed mobile roster
 * @param {ReturnType<typeof readSuiteRunners>} [suites] the roster's suites, injected so a test can supply its own
 */
export function deriveJourneys(
  roster: unknown,
  suites: ReturnType<typeof readSuiteRunners> = readSuiteRunners(roster)
) {
  const source = dict(roster);
  const suitesById = dict(source.suites);
  const flowsByPath = dict(source.flows);
  return suites
    .map((suite) => ({
      id: suite.id,
      runner: suite.runner,
      rung: Math.min(...(suite.rungs.length > 0 ? suite.rungs : [4])),
      platform: suite.platform ?? "android",
      budgetMs: suite.budgetMs,
      budgetDoc: dict(suitesById[suite.id]).doc ?? null,
      flows: suite.flows.map((file) => {
        const entry = dict(flowsByPath[`tests/agent-e2e-mobile/flows/${file}`]);
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
    path.join(ROOT, "scripts/mutation/seeds.ts")
  );
  return MUTATION_SEEDS.map((seed: Loose) => {
    const row = dict(seed);
    return {
      id: row.id,
      label: row.label,
      cwd: row.cwd,
      config: row.config,
    };
  });
}

/** The fuzz target catalog, as `{id, corpus}` rows. */
export async function deriveFuzzTargets() {
  const { FUZZ_TARGETS } = await import(
    path.join(ROOT, "scripts/fuzz/targets.ts")
  );
  return FUZZ_TARGETS.map((target: unknown) => {
    const row = dict(target);
    return {
      id: row.id,
      corpus: row.corpus ?? null,
    };
  });
}

/** Every committed `stryker.config.mjs`, as package-relative paths. */
export function deriveStrykerConfigs() {
  const packages = path.join(ROOT, "packages");
  const found: string[] = [];
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
  const body = block.groups?.body;
  if (!body) return [];
  return [...body.matchAll(/"(?<name>[^"]+)"/gu)].map(
    (match) => match.groups?.name ?? ""
  );
}

/** Quality-rig budgets, keyed by rig path (`tests/journeys.json#rigs`). */
export function deriveRigBudgets() {
  return dict(dict(readJson("tests/journeys.json", {})).rigs);
}

/**
 * The journey ledger's entries, grouped by surface so the report page keeps
 * its per-surface section (#927). The grouping is derived from each entry's
 * own `surface`, so a new surface needs no edit here.
 */
export function deriveExperienceBudgets() {
  const ledger = dict(readJson("tests/journeys.json", {}));
  const out: Record<string, Loose> = {};
  for (const [key, raw] of Object.entries(dict(ledger.entries))) {
    const entry = dict(raw);
    const surface = String(entry.surface ?? "");
    out[surface] ??= {};
    dict(out[surface])[key] = entry;
  }
  return out;
}

/**
 * Flow ownership: the claims file's hand-typed flows plus every committed
 * mobile flow from the roster. This is the view the constitution's
 * `coverage-scope-reachability` directive reads.
 * @param {object} claims a parsed claims file
 * @param {object} roster the parsed mobile roster
 */
export function deriveFlows(claims: unknown, roster: unknown) {
  const claimDoc = dict(claims);
  const rosterDoc = dict(roster);
  const flows = bags(claimDoc.flows).map((flow) => ({
    id: String(flow.id ?? ""),
    owner: flow.owner,
    surface: flow.surface ?? null,
    dimension: flow.dimension ?? null,
    tier: flow.tier ?? null,
    minimumTests: flow.minimumTests ?? null,
  }));
  const seen = new Set(flows.map((flow) => flow.id));
  for (const flowPath of Object.keys(dict(rosterDoc.flows))) {
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
export async function deriveAll(claims: Loose) {
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
