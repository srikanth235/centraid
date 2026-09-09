// A change to the law is not a change to the product (#1005).
//
// The three estates are `law` (the rules a change is judged by), `registry`
// (the receipts, changelog, decisions and docket that record what happened) and
// `territory` (the product itself). This rule says one thing about them: a
// single commit may not edit the law and the territory together.
//
// The reason is that the two are reviewed by different questions. "Is this
// feature right?" and "should this rule exist?" have different evidence,
// different reviewers and different consequences for being wrong — and a diff
// that answers both at once gets the second question waved through on the
// strength of the first. A `law` + `registry` commit is fine and expected: a
// rule lands with the receipt and the ruling that authorised it.
//
// `law` + `territory` split across two commits of the same pull request is the
// same change wearing two hats, so the aggregate is judged as well. The commit
// -level check cannot see it; the window-door aggregate can.
//
// This rule OBSERVES at the window door and ENFORCES at the hook door, which is
// the one asymmetry in the catalog — see README.md § The two doors.
//
// The two doors also see different change sets, and that is not a softening.
// At the hook the only thing an author can still act on is the commit being
// written, so only the staged set is judged; a finding about a commit already
// made would block a commit that no edit to it could fix. In the window every
// commit of the range is under review, and so is the aggregate.
import { defineArrivalRule } from "../lib/rule.mjs";

/** How to waive, quoted in every message so the fix travels with the finding. */
const WAIVER = "governance: allow-estate-separation <reason>";

/**
 * The estates present in a file list, with the paths that put them there.
 *
 * @param {{path: string, estate: string}[]} rows Tagged file rows.
 * @returns {Map<string, string[]>} estate → paths, sorted as given.
 */
function byEstate(rows) {
  const map = new Map();
  for (const row of rows ?? []) {
    if (!map.has(row.estate)) map.set(row.estate, []);
    map.get(row.estate).push(row.path);
  }
  return map;
}

/**
 * Name a set of paths for a message, without printing a thousand of them.
 *
 * @param {string[]} paths The paths.
 * @returns {string} A quoted, truncated list.
 */
function name(paths) {
  const shown = paths.slice(0, 3).map((file) => `'${file}'`).join(", ");
  return paths.length > 3 ? `${shown} and ${paths.length - 3} more` : shown;
}

export default defineArrivalRule({
  id: "estate-separation",
  statute: "#estate-separation",
  door: "hook",
  description: "A commit edits the law or the product, never both.",
  enforces:
    "at the hook door, a commit whose files mix the law estate and the territory estate",
  observes:
    "at the window door, the same mix split across commits of one change — the aggregate is a finding, and only a person can say whether the split was accidental",
  schema: [{ type: "object", additionalProperties: true }],
  check(arrival, ctx) {
    const waived = new Set(
      (arrival.waivers ?? [])
        .filter((waiver) => waiver.directive === "estate-separation" && waiver.reason !== "")
        .map((waiver) => waiver.source)
    );
    const proposal = arrival.ci?.issueIsProposal ?? null;
    const atHook = arrival.stamp?.door === "hook";
    let mixedInOneCommit = false;

    /**
     * Judge one commit-shaped file list.
     *
     * @param {{path: string, estate: string}[]} files Its tagged rows.
     * @param {(string|number)[]} at Where a finding lands.
     * @param {string} label How the commit is named in a message.
     * @returns {void}
     */
    const judge = (files, at, label) => {
      const estates = byEstate(files);
      const law = estates.get("law") ?? [];
      const territory = estates.get("territory") ?? [];
      if (law.length === 0 || territory.length === 0) return;
      mixedInOneCommit = true;
      ctx.report(
        at,
        `${label} edits the law and the territory in one commit — law: ${name(law)}; territory: ${name(territory)}. Split them, or waive with '${WAIVER}' in the commit body.`
      );
    };

    for (const [index, commit] of atHook ? [] : (arrival.commits ?? []).entries()) {
      // A merge commit's content is its parents'; it has no diff of its own.
      if (commit.parents.length > 1) continue;
      if (waived.has(`commit:${commit.sha}`)) continue;
      judge(commit.files, ["commits", index, "files"], `${commit.sha.slice(0, 8)}`);
      // A commit that moves the law answers to a proposal, not to a bug or a
      // chore. `issueIsProposal` is a CI stamp; offline it is null and this
      // half of the rule is silent rather than guessing.
      if (
        proposal === false &&
        (commit.files ?? []).some((row) => row.estate === "law")
      ) {
        ctx.report(
          ["commits", index, "subject"],
          `${commit.sha.slice(0, 8)} moves the law but '${commit.subject}' names an issue that is not a proposal — a change to the rules starts from a proposal issue.`
        );
      }
    }

    if (arrival.pending && !waived.has("pending")) {
      judge(arrival.pending.files, ["pending", "files"], "the staged change");
    }

    // The aggregate catches only what the commit level cannot: the same mix
    // spread across two commits. Reporting it again when one commit already
    // mixed would be the same finding twice with a worse message.
    if (atHook || mixedInOneCommit || waived.size > 0) return;
    const estates = byEstate(arrival.files);
    const law = estates.get("law") ?? [];
    const territory = estates.get("territory") ?? [];
    if (law.length === 0 || territory.length === 0) return;
    ctx.report(
      ["files"],
      `this change edits the law and the territory, split across commits — law: ${name(law)}; territory: ${name(territory)}. One pull request answers one question; split it, or waive with '${WAIVER}'.`
    );
  },
});
