import { readFileSync } from "node:fs";
import path from "node:path";

const MOBILE_DIR = "tests/agent-e2e-mobile";
const FLOWS_DIR = `${MOBILE_DIR}/flows`;
const ROSTER_PATH = `${MOBILE_DIR}/roster.json`;

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

export const RUNGS = [2, 3, 4, 5];
export const PLATFORMS = ["android", "ios"];

let cached;

export function loadRoster(root = ROOT) {
  if (root === ROOT && cached) return cached;
  const parsed = JSON.parse(
    readFileSync(path.resolve(root, ROSTER_PATH), "utf8")
  );
  if (root === ROOT) cached = parsed;
  return parsed;
}

export function flowPath(file) {
  return `${FLOWS_DIR}/${file}`;
}

export function flowFile(rel) {
  return rel.slice(rel.lastIndexOf("/") + 1);
}

function matches(spec, { rung, platform }) {
  if (rung != null && !spec.rungs.includes(rung)) return false;
  if (platform != null && !spec.platform.includes(platform)) return false;
  return true;
}

export function suitesFor({ rung, platform, suite, roster } = {}) {
  const table = (roster ?? loadRoster()).suites;
  const ids = Object.keys(table).filter((id) =>
    matches(table[id], { rung, platform })
  );
  if (suite == null) return ids;
  return ids.filter((id) => id === suite);
}

export function suiteSpec(suite, roster) {
  return (roster ?? loadRoster()).suites[suite];
}

export function suiteBudgetMs(suite, roster) {
  return suiteSpec(suite, roster)?.budgetMs;
}

export function plan({ rung, platform, suite, roster } = {}) {
  const tree = roster ?? loadRoster();
  return suitesFor({ rung, platform, suite, roster: tree }).map((id) => {
    const spec = tree.suites[id];
    return {
      suite: id,
      budgetMs: spec.budgetMs,
      lane: spec.lane,
      canaryCount: spec.canaryCount,
      reuseAfter: spec.reuseAfter,
      onBudgetBreach: spec.onBudgetBreach,
      doc: spec.doc,
      rungs: spec.rungs,
      platform: spec.platform,
      flows: spec.flows.map((file) => ({
        file,
        path: flowPath(file),
        ...tree.flows[flowPath(file)],
      })),
    };
  });
}

export function flowsFor({ rung, platform, suite, roster } = {}) {
  const tree = roster ?? loadRoster();
  const byPath = new Map();
  for (const entry of plan({ rung, platform, suite, roster: tree })) {
    for (const flow of entry.flows) {
      const seen = byPath.get(flow.path);
      if (seen) {
        seen.suites.push(entry.suite);
        continue;
      }
      byPath.set(flow.path, { ...flow, suites: [entry.suite] });
    }
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export function lanesFor({ rung, roster } = {}) {
  const lanes = (roster ?? loadRoster()).lanes;
  return Object.fromEntries(
    Object.entries(lanes).filter(
      ([, lane]) => rung == null || lane.rung === rung
    )
  );
}

export function validateRoster(roster = loadRoster()) {
  const findings = [];
  const suites = roster.suites ?? {};
  const flows = roster.flows ?? {};
  const lanes = roster.lanes ?? {};

  for (const [id, spec] of Object.entries(suites)) {
    const at = `suites.${id}`;
    if (!(spec.budgetMs > 0))
      findings.push(
        `${at} declares no positive budgetMs. Every suite owes an aggregate ceiling — a roster nothing prices is a roster that can grow without anyone deciding to spend it.`
      );
    if (!Array.isArray(spec.rungs) || spec.rungs.length === 0)
      findings.push(`${at} declares no rungs; it can never be selected.`);
    for (const rung of spec.rungs ?? [])
      if (!RUNGS.includes(rung))
        findings.push(
          `${at} claims rung ${rung}; the ladder's device rungs are ${RUNGS.join(", ")}.`
        );
    for (const platform of spec.platform ?? [])
      if (!PLATFORMS.includes(platform))
        findings.push(`${at} claims platform "${platform}".`);
    if (!Array.isArray(spec.flows) || spec.flows.length === 0)
      findings.push(`${at} declares an empty member list.`);
    if (!spec.doc) findings.push(`${at} names no budget doc.`);
    if (spec.canaryCount > 0 && spec.reuseAfter === 0)
      findings.push(
        `${at} short-circuits on a canary it also lets later members reuse from index 0; reuseAfter must be at least canaryCount.`
      );
    const seen = new Set();
    for (const file of spec.flows ?? []) {
      if (seen.has(file))
        findings.push(
          `${at} lists ${file} twice; a member runs once per suite.`
        );
      seen.add(file);
      const row = flows[flowPath(file)];
      if (!row) {
        findings.push(
          `${at} schedules ${file}, which has no ${ROSTER_PATH} flows[] row. A suite member with no claim cannot be judged.`
        );
        continue;
      }
      if (!(row.budgetMs > 0))
        findings.push(`flows.${flowPath(file)} declares no positive budgetMs.`);
      else if (row.budgetMs > spec.budgetMs)
        findings.push(
          `flows.${flowPath(file)} budgets ${row.budgetMs / 1000}s inside ${at}, whose whole aggregate ceiling is ${spec.budgetMs / 1000}s. A member that cannot fit its own suite is a member the deadline will always starve.`
        );
    }
  }

  const membership = new Map();
  for (const [id, spec] of Object.entries(suites))
    for (const file of spec.flows ?? []) {
      const key = flowPath(file);
      if (!membership.has(key)) membership.set(key, []);
      membership.get(key).push(id);
    }
  for (const [rel, row] of Object.entries(flows)) {
    const mine = membership.get(rel) ?? [];
    const want = {
      suite: mine,
      rungs: [...new Set(mine.flatMap((id) => suites[id].rungs))].sort(),
      platform: [...new Set(mine.flatMap((id) => suites[id].platform))].sort(),
    };
    for (const key of ["suite", "rungs", "platform"])
      if (JSON.stringify(row[key]) !== JSON.stringify(want[key]))
        findings.push(
          `flows.${rel}.${key} is ${JSON.stringify(row[key])} but its suite membership derives ${JSON.stringify(want[key])}. These fields are derived from suites[]; fix the membership or the field, not the reader.`
        );
    if (mine.length === 0 && row.status !== "exploratory")
      findings.push(
        `flows.${rel} is \`${row.status}\` but belongs to no suite. Put it in one, or demote it to \`exploratory\` and accept that nothing enforces it.`
      );
  }

  for (const [id, lane] of Object.entries(lanes)) {
    if (!RUNGS.includes(lane.rung))
      findings.push(
        `lanes.${id} declares rung ${lane.rung}; the ladder's device rungs are ${RUNGS.join(", ")}.`
      );
    if (lane.rung === 2 && lane.blocking !== true)
      findings.push(
        `lanes.${id} sits on rung 2 (the required PR check) but is not \`blocking\`. Rung 2 is the rung that blocks; a non-blocking one is rung 3.`
      );
    if (lane.rung > 2 && lane.blocking === true)
      findings.push(
        `lanes.${id} is \`blocking\` on rung ${lane.rung}. Only rung 2 blocks a merge — a blocking lane above it is a merge gate nobody declared.`
      );
  }

  return findings;
}
