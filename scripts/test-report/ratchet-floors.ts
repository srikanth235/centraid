/**
 * Floors-up-only ratchet (#496 E4, extended #532).
 *
 *
 * Diffs against a git merge-base (default: origin/main):
 *   - `tests/floors.json#coverage` (up-only)
 *   - every claims flow `minimumTests` (up-only)
 *   - `tests/floors.json#mutation` (up-only mutation scores, #532)
 *   - perf budget numeric ceilings/floors (tighten-only / widen fails, #532)
 *
 * #915 Wave 4 merged twenty ledgers into four. The ceiling table below names
 * SECTIONS of `tests/budgets.json` rather than seven separate files, and each
 * section keeps its OWN `approvedDeviation` — merging the files must not merge
 * the waivers, or a reviewed widen of one ceiling would silently waive a drop
 * in another. `scripts/check-ledgers.mjs` (`bun run lint:ledgers`) holds the
 * rest of the merged shape (issue-and-expiry, the derived mirrors, the
 * inventory budgets); this module stays the numeric ratchet the report reads.
 *
 * Any decrease (or budget widen) fails unless the touched file's
 * `approvedDeviation` (flow-level: `approvedMinimumTestsDeviation`) was
 * CHANGED in the same change set — mere presence never waives, because the
 * field is a permanent provenance ledger and is non-empty forever (#781).
 *
 * Deletion of a floor scope, metric key, or flow `minimumTests` counts as a
 * decrease (cannot bypass the ratchet by deleting the key).
 *
 * Usage:
 *   node scripts/test-report/ratchet-floors.ts
 *   node scripts/test-report/ratchet-floors.ts --base origin/main
 *   node scripts/test-report/ratchet-floors.ts --base <sha>
 *
 * Pure comparison is exported for unit tests.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

import {
  PERF_BUDGET_SOURCES,
  diffPerfBudgetNumbers,
  deviationChanged,
  loadBudgetSource,
} from "./ratchet-budget.ts";
import { bags, dict, isRecord, items } from "./record.ts";
import type { Loose } from "./record.ts";

export {
  PERF_BUDGET_SOURCES,
  diffPerfBudgetNumbers,
  extractBudgetNumbersFromSource,
  flattenBudgetNumbers,
  deviationChanged,
  hasApprovedDeviation,
  isBudgetFloorKey,
} from "./ratchet-budget.ts";

const root = path.resolve(import.meta.dirname, "../..");

/**
 * Compare coverage floor objects for any downward movement or deletion.
 * @param {unknown} base Floors on the merge base.
 * @param {unknown} head Floors on the working tree.
 * @returns {string[]} Human-readable decrease errors.
 */
export function diffCoverageFloors(base: unknown, head: unknown): string[] {
  const errors: string[] = [];
  if (!base || typeof base !== "object" || !head || typeof head !== "object") {
    return errors;
  }
  const baseObj = dict(base);
  const headObj = dict(head);
  const keys = new Set([...Object.keys(baseObj), ...Object.keys(headObj)]);
  for (const key of keys) {
    if (key === "approvedDeviation" || key.startsWith("_")) continue;
    const b = baseObj[key];
    const h = headObj[key];
    if (typeof b === "number") {
      if (typeof h !== "number") {
        errors.push(`coverage floor "${key}" removed (was ${b})`);
      } else if (h < b) {
        errors.push(`coverage floor "${key}" decreased ${b} → ${h}`);
      }
      continue;
    }
    if (b && typeof b === "object") {
      if (!isRecord(h)) {
        errors.push(`coverage floor scope "${key}" removed`);
        continue;
      }
      const bb = dict(b);
      const hh = dict(h);
      for (const metric of new Set([...Object.keys(bb), ...Object.keys(hh)])) {
        if (typeof bb[metric] !== "number") continue;
        if (typeof hh[metric] !== "number") {
          errors.push(
            `coverage floor "${key}.${metric}" removed (was ${bb[metric]})`
          );
        } else if (Number(hh[metric]) < Number(bb[metric])) {
          errors.push(
            `coverage floor "${key}.${metric}" decreased ${bb[metric]} → ${hh[metric]}`
          );
        }
      }
    }
  }
  return errors;
}

/**
 * Compare mutation-score floors for any downward movement or deletion (#532).
 * Same shape as coverage floors: top-level package keys → number scores.
 * @param {unknown} base Mutation floors on the merge base.
 * @param {unknown} head Mutation floors on the working tree.
 * @returns {string[]} Human-readable decrease errors.
 */
export function diffMutationFloors(base: unknown, head: unknown): string[] {
  return diffCoverageFloors(base, head).map((e) =>
    e.replace(/^coverage floor/u, "mutation floor")
  );
}

/**
 * Validate the retirement markers this change set ADDS, and return the set of
 * flow ids they authorize. Errors are pushed onto `errors`; a marker that fails
 * validation authorizes nothing, so the removal it was meant to cover is still
 * reported by the caller.
 * @param {{ removedMinimumTestsFlows?: Record<string, unknown> }} base Matrix on the merge base.
 * @param {{ removedMinimumTestsFlows?: Record<string, unknown> }} head Matrix on the working tree.
 * @param {Map<string, { id?: string; owner?: string; minimumTests?: number }>} baseMap Base flows by id.
 * @param {Map<string, unknown>} headMap Head flows by id.
 * @param {string[]} errors Sink for human-readable errors.
 * @returns {Set<string>} Flow ids whose removal is authorized.
 */
function retiredFlowMarkers(
  base: unknown,
  head: unknown,
  baseMap: Map<string, Loose>,
  headMap: Map<string, unknown>,
  errors: string[]
): Set<string> {
  const baseMarkers = dict(dict(base).removedMinimumTestsFlows);
  const headMarkers = dict(dict(head).removedMinimumTestsFlows);
  const authorized = new Set<string>();
  const owners = new Map<string, string>();
  for (const [id, raw] of Object.entries(headMarkers)) {
    if (id.startsWith("_")) continue;
    // Spent on a previous change set: the flow is gone from both sides, so
    // there is nothing left to authorize and nothing to re-litigate.
    if (Object.hasOwn(baseMarkers, id)) continue;
    const marker = dict(raw);
    const owner = typeof marker.owner === "string" ? marker.owner.trim() : "";
    const reason =
      typeof marker.reason === "string" ? marker.reason.trim() : "";
    const issue = typeof marker.issue === "string" ? marker.issue.trim() : "";
    const label = `removedMinimumTestsFlows["${id}"]`;
    let sound = true;
    if (!owner) {
      errors.push(`${label} must name the owner path of the deleted rig`);
      sound = false;
    }
    if (!reason) {
      errors.push(`${label} must give a reason citing the approval`);
      sound = false;
    }
    if (!/^#\d+$/u.test(issue)) {
      errors.push(
        `${label} must name its change set as an issue (e.g. "#927")`
      );
      sound = false;
    }
    const prev = baseMap.get(id);
    if (!prev) {
      errors.push(
        `${label} names "${id}", which the base does not declare — a retirement marker must name a flow that existed`
      );
      sound = false;
    } else if (headMap.has(id)) {
      errors.push(
        `${label} names "${id}", which the head still declares — retire the flow or drop the marker`
      );
      sound = false;
    } else if (owner && prev.owner !== undefined && prev.owner !== owner) {
      errors.push(
        `${label} names owner "${owner}" but flow "${id}" was owned by "${prev.owner}"`
      );
      sound = false;
    }
    if (owner) {
      const seen = owners.get(owner);
      if (seen === undefined) {
        owners.set(owner, id);
      } else {
        errors.push(
          `${label} and removedMinimumTestsFlows["${seen}"] both retire owner "${owner}"; one marker per deleted rig`
        );
        sound = false;
      }
    }
    if (sound) authorized.add(id);
  }
  return authorized;
}

/**
 * Compare matrix flow minimumTests floors for any downward movement or removal.
 * An ID rename must name its exact predecessor with
 * `replacesMinimumTestsFlow`; a prose deviation alone cannot let one new flow
 * absorb several removed floors.
 *
 * A flow can also be RETIRED OUTRIGHT, with no successor to carry its floor:
 * the test it fenced was deleted on purpose and nothing replaces it. The two
 * escapes above cannot say that — one needs a successor flow, the other needs
 * the row to survive, and a row whose owner no longer exists on disk is refused
 * by validate-claims.mjs. `removedMinimumTestsFlows` is that vocabulary: a map
 * from the retired flow's id to `{ owner, reason, issue }`, where `reason`
 * cites the approval and `issue` names the change set. The ratchet's property
 * is unchanged — no floor drops SILENTLY — because a marker is a reviewed line
 * in the diff naming what was deleted and why.
 *
 * A marker is ONE-SHOT, and it is checked only while it is new. A marker
 * present on the base as well as the head has already been spent: the flow it
 * retired is gone from both sides, there is no removal left to authorize, and
 * re-validating it would red every later PR on main. So only markers ADDED by
 * this change set are validated, and each must name a flow the base declared
 * and the head does not.
 * @param {{ flows?: Array<{ id?: string; surface?: string; dimension?: string; tier?: string; minimumTests?: number; approvedMinimumTestsDeviation?: string; replacesMinimumTestsFlow?: string }>, removedMinimumTestsFlows?: Record<string, { owner?: string; reason?: string; issue?: string }> }} base Matrix on the merge base.
 * @param {{ flows?: Array<{ id?: string; surface?: string; dimension?: string; tier?: string; minimumTests?: number; approvedMinimumTestsDeviation?: string; replacesMinimumTestsFlow?: string }>, removedMinimumTestsFlows?: Record<string, { owner?: string; reason?: string; issue?: string }> }} head Matrix on the working tree.
 * @returns {string[]} Human-readable decrease errors.
 */
export function diffMinimumTests(base: unknown, head: unknown): string[] {
  const errors: string[] = [];
  const baseFlows = bags(dict(base).flows);
  const headFlows = bags(dict(head).flows);
  const baseMap = new Map(
    baseFlows.filter((f) => f.id).map((f) => [String(f.id), f])
  );
  const headMap = new Map(
    headFlows.filter((f) => f.id).map((f) => [String(f.id), f])
  );
  const retired = retiredFlowMarkers(base, head, baseMap, headMap, errors);
  const replacements = new Map();
  // A marker is SPENT once the change set that used it lands: the same flow, on
  // the base, already carries the identical `replacesMinimumTestsFlow`, and the
  // predecessor it names is long gone. Left in place it reported "unknown
  // predecessor" on every later branch — a red on a tree nobody had touched —
  // so the shape checks below run only over markers this diff INTRODUCED or
  // MOVED. A spent marker can still grant nothing: the removal loop only
  // consults `replacements` for a flow present on the base, and a spent
  // marker's predecessor is not. Re-spending one (pointing a second flow at the
  // same predecessor) puts a NEW marker in the group, which re-arms the whole
  // group including its spent members.
  const spent = new Set();
  for (const candidate of headFlows) {
    if (
      typeof candidate?.replacesMinimumTestsFlow !== "string" ||
      !String(candidate.replacesMinimumTestsFlow).trim()
    ) {
      continue;
    }
    const previousId = candidate.replacesMinimumTestsFlow.trim();
    if (
      candidate.id !== undefined &&
      String(
        dict(baseMap.get(String(candidate.id))).replacesMinimumTestsFlow
      ).trim() === previousId
    ) {
      spent.add(candidate);
    }
    const claimed = replacements.get(previousId) ?? [];
    claimed.push(candidate);
    replacements.set(previousId, claimed);
  }
  for (const [previousId, candidates] of replacements) {
    if (candidates.every((candidate: Loose) => spent.has(candidate))) continue;
    if (!baseMap.has(previousId)) {
      errors.push(`flow replacement names unknown predecessor "${previousId}"`);
    } else if (headMap.has(previousId)) {
      errors.push(
        `flow replacement names retained predecessor "${previousId}"`
      );
    }
    if (candidates.length > 1) {
      errors.push(
        `flow "${previousId}" has multiple replacements (${candidates
          .map((candidate: Loose) => `"${candidate.id ?? "<missing id>"}"`)
          .join(", ")}); ID renames must be one-to-one`
      );
    }
  }
  for (const prev of baseFlows) {
    if (!prev?.id || prev.minimumTests === undefined) continue;
    const prevId = String(prev.id);
    const flow = headMap.get(prevId);
    if (!flow || flow.minimumTests === undefined) {
      // Retired outright, named and reasoned in the diff. The marker was
      // validated above, including that it names THIS rig.
      if (retired.has(prevId)) continue;
      const candidates = replacements.get(prevId) ?? [];
      const candidate = candidates.length === 1 ? candidates[0] : undefined;
      const approvedReplacement =
        candidate?.id !== undefined &&
        candidate.id !== prev.id &&
        !baseMap.has(candidate.id) &&
        candidate.surface === prev.surface &&
        candidate.dimension === prev.dimension &&
        candidate.tier === prev.tier &&
        typeof candidate.minimumTests === "number" &&
        Number(candidate.minimumTests) >= Number(prev.minimumTests) &&
        typeof candidate.approvedMinimumTestsDeviation === "string" &&
        candidate.approvedMinimumTestsDeviation.trim();
      if (approvedReplacement) continue;
      if (
        flow &&
        typeof flow.approvedMinimumTestsDeviation === "string" &&
        flow.approvedMinimumTestsDeviation.trim()
      ) {
        continue;
      }
      if (flow) {
        errors.push(
          `flow "${prev.id}" minimumTests removed (was ${prev.minimumTests}; add approvedMinimumTestsDeviation to allow)`
        );
      } else {
        errors.push(
          `flow "${prev.id}" removed (had minimumTests ${prev.minimumTests}); add one approved replacement with replacesMinimumTestsFlow: "${prev.id}" or restore the flow`
        );
      }
      continue;
    }
    if (Number(flow.minimumTests) < Number(prev.minimumTests)) {
      if (
        typeof flow.approvedMinimumTestsDeviation === "string" &&
        flow.approvedMinimumTestsDeviation.trim()
      ) {
        continue;
      }
      errors.push(
        `flow "${flow.id}" minimumTests decreased ${prev.minimumTests} → ${flow.minimumTests} (add approvedMinimumTestsDeviation to allow)`
      );
    }
  }
  return errors;
}

/**
 * Whether a budget leaf key is a floor (higher is tighter) rather than a
 * ceiling (lower is tighter). Keys starting with `min` (camelCase min*) are
 * floors; everything else is treated as a ceiling.
 * @param {string} key Leaf property name (last path segment).
 * @returns {boolean} Return value.
 */

/**
 * Run the full floors-up-only ratchet.
 * @param {object} opts Comparison inputs.
 * @param {unknown} opts.baseFloors Floors JSON on the merge base.
 * @param {unknown} opts.headFloors Floors on the working tree.
 * @param {object} opts.baseMatrix Matrix JSON on the merge base.
 * @param {object} opts.headMatrix Matrix JSON on the working tree.
 * @param {unknown} [opts.baseMutation] Mutation floors on merge base (null = first land).
 * @param {unknown} [opts.headMutation] Mutation floors on head.
 * @param {Array<{ label: string; base: Record<string, number>; head: Record<string, number>; approvedDeviation?: string; baseApprovedDeviation?: string }>} [opts.perfBudgets] Perf budget comparison entries.
 * @returns {{ errors: string[]; waived: boolean }} Return value.
 */
export function ratchetFloors({
  baseFloors,
  headFloors,
  baseMatrix,
  headMatrix,
  baseMutation = null,
  headMutation = null,
  perfBudgets = [],
}: {
  baseFloors?: unknown;
  headFloors?: unknown;
  baseMatrix?: unknown;
  headMatrix?: unknown;
  baseMutation?: unknown;
  headMutation?: unknown;
  perfBudgets?: unknown;
}): { errors: string[]; waived: boolean } {
  const floors = diffCoverageFloors(baseFloors, headFloors);
  const mins = diffMinimumTests(baseMatrix, headMatrix);
  const mutation =
    baseMutation && headMutation
      ? diffMutationFloors(baseMutation, headMutation)
      : [];
  const perf: string[] = [];
  for (const raw of items(perfBudgets)) {
    const entry = dict(raw);
    const errs = diffPerfBudgetNumbers(
      dict(entry.base) as Record<string, number>,
      dict(entry.head) as Record<string, number>,
      String(entry.label ?? "perf budget")
    );
    if (
      errs.length &&
      entry.approvedDeviation &&
      String(entry.approvedDeviation).trim() &&
      entry.approvedDeviation !== (entry.baseApprovedDeviation ?? "")
    ) {
      continue;
    }
    perf.push(...errs);
  }

  let remainingFloors = floors;
  let remainingMutation = mutation;
  if (floors.length > 0 && deviationChanged(baseFloors, headFloors))
    remainingFloors = [];
  if (mutation.length > 0 && deviationChanged(baseMutation, headMutation))
    remainingMutation = [];

  const remaining = [
    ...remainingFloors,
    ...remainingMutation,
    ...mins,
    ...perf,
  ];
  const anyWaived =
    (floors.length > 0 && remainingFloors.length === 0) ||
    (mutation.length > 0 && remainingMutation.length === 0);
  return { errors: remaining, waived: anyWaived };
}

function readJsonAt(ref: string, relPath: string): unknown {
  try {
    const raw = execFileSync("git", ["show", `${ref}:${relPath}`], {
      cwd: root,
      encoding: "utf8",
      // A path absent on the base is the FIRST-LAND case, handled by the
      // callers; git's "exists on disk, but not in <ref>" on stderr would read
      // as a gate failure in the log when it is nothing of the sort.
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 8 * 1024 * 1024,
    });
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function resolveBase(explicit?: string | null) {
  if (explicit) return explicit;
  for (const candidate of ["origin/main", "main", "origin/master", "master"]) {
    try {
      execFileSync("git", ["rev-parse", "--verify", candidate], {
        cwd: root,
        stdio: ["ignore", "pipe", "ignore"],
      });
      return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

function parseArgs(argv: string[]) {
  const out: { base: string | null; help: boolean } = {
    base: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const current = argv[i];
    const next = argv[i + 1];
    if (current === "--base" && next) {
      out.base = next;
      i += 1;
    } else if (current === "--help" || current === "-h") {
      out.help = true;
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      "Usage: node scripts/test-report/ratchet-floors.ts [--base <ref>]"
    );
    process.exit(0);
  }
  const baseRef = resolveBase(args.base);
  if (!baseRef) {
    console.error(
      "ratchet-floors: no merge base found (tried origin/main, main, origin/master, master). Fetch the default branch or pass --base <ref>."
    );
    process.exitCode = 1;
    return;
  }

  const floorsPath = "tests/floors.json";
  const matrixPath = "tests/claims.json";
  if (
    !existsSync(path.join(root, floorsPath)) ||
    !existsSync(path.join(root, matrixPath))
  ) {
    console.error(
      `ratchet-floors: missing ${floorsPath} or ${matrixPath} in working tree`
    );
    process.exitCode = 1;
    return;
  }
  const floorsDoc = dict(
    JSON.parse(readFileSync(path.join(root, floorsPath), "utf8")) as unknown
  );
  const headFloors = floorsDoc.coverage;
  const headMatrix = JSON.parse(
    readFileSync(path.join(root, matrixPath), "utf8")
  ) as unknown;
  // #915 Wave 4 merged tests/coverage-floors.json and tests/mutation-floors.json
  // into tests/floors.json. The base side falls back to the OLD paths so the
  // very commit that renamed them cannot lower a floor unwatched — without this
  // the ratchet would go silent for exactly one merge.
  const baseFloorsDoc = readJsonAt(baseRef, floorsPath);
  const baseFloors =
    dict(baseFloorsDoc).coverage ??
    readJsonAt(baseRef, "tests/coverage-floors.json");
  // #915 renamed tests/matrix.json to tests/claims.json. The `flows[]`
  // minimumTests floors moved file, not value, so the base side falls back to
  // the old path: without this the ratchet would go silent for exactly one
  // merge, which is when a floor could be lowered unwatched.
  const baseMatrix =
    readJsonAt(baseRef, matrixPath) ?? readJsonAt(baseRef, "tests/matrix.json");

  const headMutation = floorsDoc.mutation ?? null;
  const baseMutation =
    dict(baseFloorsDoc).mutation ??
    readJsonAt(baseRef, "tests/mutation-floors.json");

  if (!baseFloors || !baseMatrix) {
    if (!baseFloors && !baseMatrix) {
      console.log(
        `ratchet-floors: ${floorsPath} and ${matrixPath} absent on ${baseRef}; nothing to ratchet (first land)`
      );
      return;
    }
    console.error(
      `ratchet-floors: ${baseFloors ? matrixPath : floorsPath} missing on ${baseRef} while present on head — refusing silent skip`
    );
    process.exitCode = 1;
    return;
  }

  // Mutation floors: first land (absent on base) is fine; once both sides have
  // the file, decreases require approvedDeviation.
  if (headMutation && !baseMutation) {
    console.log(
      `ratchet-floors: ${floorsPath}#mutation absent on ${baseRef}; mutation floors first land (ok)`
    );
  }

  const perfBudgets: Array<{
    label: string;
    base: Record<string, number>;
    head: Record<string, number>;
    approvedDeviation?: string;
    baseApprovedDeviation?: string;
  }> = [];
  for (const source of PERF_BUDGET_SOURCES) {
    const abs = path.join(root, source.path);
    const head = loadBudgetSource(abs, source, null);
    const base = loadBudgetSource(abs, source, baseRef);
    if (Object.keys(base.numbers).length === 0) {
      // First land of this budget file — nothing to ratchet.
      continue;
    }
    perfBudgets.push({
      label: source.section ? `${source.path}#${source.section}` : source.path,
      base: base.numbers,
      head: head.numbers,
      approvedDeviation: head.approvedDeviation,
      baseApprovedDeviation: base.approvedDeviation,
    });
  }

  const { errors, waived } = ratchetFloors({
    baseFloors,
    headFloors,
    baseMatrix,
    headMatrix,
    baseMutation: baseMutation && headMutation ? baseMutation : null,
    headMutation: baseMutation && headMutation ? headMutation : null,
    perfBudgets,
  });
  if (errors.length) {
    console.error(
      `ratchet-floors: floors/budgets may only tighten (base ${baseRef})`
    );
    for (const e of errors) console.error(`  - ${e}`);
    console.error(
      "To lower a floor or widen a budget deliberately, EXTEND the touched file's approvedDeviation with the new rationale (mere presence of old ledger text never waives — #781) or set approvedMinimumTestsDeviation on the same flow. An ID rename also requires an exact one-to-one replacesMinimumTestsFlow mapping."
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    waived
      ? `ratchet-floors: ok (decrease(s) waived by a CHANGED approvedDeviation vs ${baseRef})`
      : `ratchet-floors: ok (no decreases vs ${baseRef})`
  );
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename;
if (isMain) {
  main();
}
