// The cardinal rule, made mechanical (#1005).
//
// CONSTITUTION.md opened with a callout — "amendments must land in the same
// commit as the change to their enforcing test, no exceptions" — and nothing
// checked it. A cardinal rule enforced by attention is enforced by nobody; this
// rule is that callout, and the prose is now a citation of it.
//
// Three pairings, one shape each: the law moves with the evidence that it works.
//
//   rule → its test    a changed `rules/<id>.ts` without `rules/<id>.test.ts`
//                      in the same commit. A rule changed without its cases
//                      changed is not a reviewable change; it is a claim.
//   rule → its row     a NEW rule file with no row in any pack. A rule nothing
//                      enables is dead code that reads as law.
//   row  → its statute a rule's severity or door moving without CONSTITUTION.md
//                      moving too. Severity and door ARE the policy — a rule
//                      quietly demoted to `warn` is a repeal nobody announced.
//
// It runs at the hook door, where it is fatal, because all three are answerable
// from the change set alone and the author is still holding it. At the hook only
// the staged set is judged; in the window every commit of the range is.
import { defineArrivalRule } from "../lib/rule.ts";

/** Where a rule and its cases live. */
const RULE_FILE = /^\.governance\/law\/rules\/(?<id>[a-z0-9-]+)\.ts$/u;
const TEST_FILE = /^\.governance\/law\/rules\/(?<id>[a-z0-9-]+)\.test\.ts$/u;

/**
 * The rule ids a file list touches, split by which half of the pair they are.
 *
 * @param {{path: string, status: string}[]} files A commit's file rows.
 * @returns {{rules: Map<string, string>, tests: Set<string>}} ids → status.
 */
export function pairsIn(files: {path: string, status: string}[]) {
  const rules = new Map();
  const tests = new Set();
  for (const row of files ?? []) {
    const test = TEST_FILE.exec(row.path);
    if (test) {
      tests.add(test.groups.id);
      continue;
    }
    const rule = RULE_FILE.exec(row.path);
    if (rule) rules.set(rule.groups.id, row.status);
  }
  return { rules, tests };
}

export default defineArrivalRule({
  id: "amendment-pairing",
  statute: "#amendment-pairing",
  door: "hook",
  description: "The law moves with its test, its row and its statute.",
  enforces:
    "a rule changed without its cases, a new rule with no pack row, and a severity or door moved without the constitution section that states it",
  schema: [{ type: "object", additionalProperties: true }],
  check(arrival, ctx) {
    const atHook = arrival.stamp?.door === "hook";
    const declared = new Set(Object.keys(arrival.law?.rules ?? {}));
    const pending = arrival.pending?.files ?? [];
    const pendingPairs = pairsIn(pending);

    /**
     * Judge one commit-shaped file list.
     *
     * @param {object[]} files Its rows.
     * @param {(string|number)[]} at Where a finding lands.
     * @param {string} label How it is named.
     * @returns {void}
     */
    const judge = (files, at, label) => {
      const { rules, tests } = pairsIn(files);
      for (const [id, status] of rules) {
        // The staged set counts too: a rule and its cases split across the
        // commit being written and the one before it is still one act.
        if (!tests.has(id) && !pendingPairs.tests.has(id)) {
          ctx.report(
            at,
            `${label} changes .governance/law/rules/${id}.ts but not ${id}.test.ts. A rule changed without its cases is a claim, not a reviewable change — CONSTITUTION.md's amendment process is one commit, three edits.`
          );
        }
        if (status === "A" && !declared.has(id)) {
          ctx.report(
            at,
            `${label} adds .governance/law/rules/${id}.ts, which no pack enables. A rule nothing enables is dead code that reads as law; add a row to .governance/law/packs/<pack>.json, or 'severity: "off"' to repeal it on the record.`
          );
        }
      }
    };

    if (atHook) judge(pending, ["pending", "files"], "the staged change");
    else {
      for (const [index, commit] of (arrival.commits ?? []).entries()) {
        if (commit.parents.length > 1) continue;
        judge(commit.files, ["commits", index, "files"], commit.sha.slice(0, 8));
      }
      if (arrival.pending) judge(pending, ["pending", "files"], "the staged change");
    }

    // The statute moves with the law. Severity and door are read from both
    // sides of the merge-base, so this is a question about the change as a
    // whole and is asked once rather than per commit.
    const before = arrival.law?.rulesAtBase ?? {};
    const after = arrival.law?.rules ?? {};
    const constitutionMoved = [...(arrival.files ?? []), ...pending].some(
      (row) => row.path === "CONSTITUTION.md"
    );
    if (constitutionMoved) return;
    for (const id of Object.keys(after)) {
      const was = before[id];
      // A rule that did not exist at the baseline is an addition, and its
      // section is `constitution-coverage`'s question, not this one's.
      if (was === undefined) continue;
      const moved = ["severity", "door"].filter((field) => was[field] !== after[id][field]);
      if (moved.length === 0) continue;
      ctx.report(
        ["law", "rules", id],
        `${id}'s ${moved.join(" and ")} changed (${moved.map((field) => `${was[field]} → ${after[id][field]}`).join(", ")}) with no change to CONSTITUTION.md. Severity and door ARE the policy; a rule quietly demoted is a repeal nobody announced.`
      );
    }
  },
});
