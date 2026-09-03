import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const ROOT = path.resolve(import.meta.dirname, "../..");

export function readJson(relative, fallback = null) {
  try {
    return JSON.parse(readFileSync(path.join(ROOT, relative), "utf8"));
  } catch {
    return fallback;
  }
}

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

export function flowId(flowPath) {
  return path.basename(String(flowPath), ".mjs");
}

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

export async function deriveFuzzTargets() {
  const { FUZZ_TARGETS } = await import(
    path.join(ROOT, "scripts/fuzz/targets.mjs")
  );
  return FUZZ_TARGETS.map((target) => ({
    id: target.id,
    corpus: target.corpus ?? null,
  }));
}

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

export async function deriveVitestProjects() {
  const source = readFileSync(path.join(ROOT, "vitest.config.ts"), "utf8");
  const block = source.match(
    /export const coverageProjects = \[(?<body>[\s\S]*?)\];/u
  );
  if (!block) return [];
  return [...block.groups.body.matchAll(/"(?<name>[^"]+)"/gu)].map(
    (match) => match.groups.name
  );
}

export function deriveRigBudgets() {
  return readJson("tests/budgets.json", {}).qualityRigs?.rigs ?? {};
}

export function deriveExperienceBudgets() {
  const dir = path.join(ROOT, "tests/experience-budgets");
  if (!existsSync(dir)) return {};
  const out = {};
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    out[path.basename(name, ".json")] = readJson(
      `tests/experience-budgets/${name}`,
      {}
    );
  }
  return out;
}

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
