// THE ROSTER READER (#915 Wave 2) — one file answers "what runs on which rung".
//
// Before this, four documents described what the phone must do and nothing held
// them against each other: seven `run-*-suite.mjs` files each carried a `FLOWS`
// literal and a `BUDGET_MS` literal that three separate gates read back by
// REGEX off disk, `roster.json` carried the claims, the budget docs carried the
// arithmetic, and the workflows carried the wiring. A rung concept existed in
// none of them. `roster.json` is now the single source and this module is the
// only reader of it — every consumer (the runner, the four linters, the budget
// ratchet, and the report's journey table) goes through these functions rather
// than parsing the file again in its own dialect.
//
// PURE AND SYNCHRONOUS. It reads one JSON file and answers questions about it;
// it spawns nothing and knows nothing about Maestro. That is what lets
// `run-roster.mjs --dry-run`, the linters and the unit suite all drive the same
// code on a machine with no device attached.
//
// THE TWO CEILINGS ARE NOT THE SAME CEILING — see `$budgets` in roster.json.
// `suiteBudgetMs()` is the aggregate deadline `lib/run-suite.mjs` enforces;
// a flow's own `budgetMs` is its marginal cost with no fresh pairing in it.

import { readFileSync } from "node:fs";
import path from "node:path";

const MOBILE_DIR = "tests/agent-e2e-mobile";
const FLOWS_DIR = `${MOBILE_DIR}/flows`;
const ROSTER_PATH = `${MOBILE_DIR}/roster.json`;

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

/** The rungs of the ladder a mobile suite may sit on (#915). Rung 0 and 1 are
 *  hooks and rung 5 is weekly; no device suite belongs to either today, and the
 *  closed set is what stops a typo inventing a rung nothing runs. */
export const RUNGS = [2, 3, 4, 5];
export const PLATFORMS = ["android", "ios"];

let cached;

/**
 * The parsed roster. Cached per process: every consumer reads the same tree, and
 * a linter that re-read it per rule would be able to disagree with itself.
 *
 * @param {string} [root] repo root, for tests driving a fixture tree
 */
export function loadRoster(root = ROOT) {
  if (root === ROOT && cached) return cached;
  const parsed = JSON.parse(
    readFileSync(path.resolve(root, ROSTER_PATH), "utf8")
  );
  if (root === ROOT) cached = parsed;
  return parsed;
}

/** Repo-relative flow path from a bare `foo.mjs` member name. */
export function flowPath(file) {
  return `${FLOWS_DIR}/${file}`;
}

/** Bare member name from a repo-relative flow path. */
export function flowFile(rel) {
  return rel.slice(rel.lastIndexOf("/") + 1);
}

function matches(spec, { rung, platform }) {
  if (rung != null && !spec.rungs.includes(rung)) return false;
  if (platform != null && !spec.platform.includes(platform)) return false;
  return true;
}

/**
 * The suite ids selected by a rung/platform filter, in ROSTER ORDER.
 *
 * Roster order is the execution order of a lane that runs more than one suite,
 * which is why this returns an array rather than a set: `probes-suite` runs
 * before `photos` on the nightly because the probes must not inherit a pairing.
 */
export function suitesFor({ rung, platform, suite, roster } = {}) {
  const table = (roster ?? loadRoster()).suites;
  const ids = Object.keys(table).filter((id) =>
    matches(table[id], { rung, platform })
  );
  if (suite == null) return ids;
  return ids.filter((id) => id === suite);
}

/** One suite's spec, or `undefined`. */
export function suiteSpec(suite, roster) {
  return (roster ?? loadRoster()).suites[suite];
}

/** A suite's AGGREGATE wall-clock ceiling in ms — the deadline, not a verdict. */
export function suiteBudgetMs(suite, roster) {
  return suiteSpec(suite, roster)?.budgetMs;
}

/**
 * The run plan: the suites a lane invocation covers, each with its ordered
 * members resolved to repo-relative paths and their roster rows attached.
 *
 * This is the shape `run-roster.mjs --dry-run` prints and the shape
 * `scripts/lint-e2e-wiring.mjs` folds into lane reachability, so the two can
 * never disagree about what an invocation schedules.
 */
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

/**
 * Every flow a rung/platform/suite filter reaches, DEDUPED by path and sorted,
 * each carrying its roster row plus the suites that reach it.
 *
 * Deduped because a flow legitimately sits in several suites — `cold-start` is
 * in four — and the callers that want "is this flow scheduled anywhere at rung
 * 2" would otherwise have to dedupe identically in four places. Callers that
 * need execution order want `plan()` instead.
 */
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

/** The declared lanes at a rung (all of them when `rung` is omitted). */
export function lanesFor({ rung, roster } = {}) {
  const lanes = (roster ?? loadRoster()).lanes;
  return Object.fromEntries(
    Object.entries(lanes).filter(
      ([, lane]) => rung == null || lane.rung === rung
    )
  );
}

/**
 * Every internal-consistency defect in the roster, as printable strings.
 *
 * This is the half that replaces what the seven runner files used to enforce by
 * existing: a `FLOWS` literal could not name a journey that was not there, and
 * a suite could not be scheduled without a file to schedule it from. A single
 * JSON document can express all of those mistakes, so they are checked here and
 * called from `scripts/lint-e2e-wiring.mjs` (which owns the wiring half) and
 * from this module's own unit suite.
 */
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

  // Every flow's derived `suite` / `rungs` / `platform` must agree with the
  // suite table. They are DERIVED and stored, because the report and the
  // linters read a flow row directly; storing them means they can drift, so
  // they are checked here rather than trusted.
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
