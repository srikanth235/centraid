// A ruling that is not written down where rulings live did not happen (#1005).
//
// The repository is its own system of record, and the registry estate is where
// the record lives: receipts, `CHANGELOG.md`, `docs/decisions.md`, the docket.
// This rule is entirely EVENT-DRIVEN. It never asks a change to file anything
// it did not do; it asks only that what it DID do is findable by someone who
// was not there. Four events, four questions:
//
//   a change landed      → the changelog names the issue
//   a receipt records a  → docs/decisions.md carries a line citing that issue
//     ruling
//   a gate widened       → a ruling authorises it, or the ledger's own
//                          `approvedDeviation` note moved
//
// A waiver's docket row was a fifth question here until #1005 lane D, and is
// now `waiver-docket`'s alone. Two rules answering one question is how the
// quieter one goes stale, and the docket rule asks the sharper version of it —
// not "is there a row" but "was the row granted before this change spent it".
//
// That the change carries a receipt AT ALL is `receipt-per-issue`'s question
// and is not re-asked here; this rule reads the receipt the other rule already
// demanded.
//
// The host backing is real: `governance` is a required check on the default
// branch (docs/decisions.md § The PR gate loop), so a finding here does block a
// merge. That is why it is declared `error` and `estate-separation` is not.
import { defineArrivalRule } from "../lib/rule.mjs";

/** Issue numbers named by a commit subject's `(#N)`. */
const SUBJECT_ISSUE = /\(#(?<number>[0-9]+)\)/u;

/**
 * The issues this arrival is about.
 *
 * The receipt filename is the authority — it is the one place the change binds
 * itself to an issue in a way a squash cannot lose. Subjects are the fallback
 * for a range that touched no receipt.
 *
 * @param {object} arrival The record.
 * @returns {number[]} Sorted, de-duplicated issue numbers.
 */
export function issuesOf(arrival) {
  const fromReceipts = (arrival.registries?.receipts?.files ?? [])
    .filter((receipt) => receipt.touched && receipt.issue !== null)
    .map((receipt) => receipt.issue);
  if (fromReceipts.length > 0) return [...new Set(fromReceipts)].sort((a, b) => a - b);
  const fromSubjects = (arrival.commits ?? [])
    .map((commit) => SUBJECT_ISSUE.exec(commit.subject)?.groups.number)
    .filter(Boolean)
    .map(Number);
  return [...new Set(fromSubjects)].sort((a, b) => a - b);
}

export default defineArrivalRule({
  id: "registry-completeness",
  statute: "#registry-completeness",
  door: "window",
  description: "What a change decided is recorded where decisions live.",
  enforces:
    "a change that lands, rules or widens a gate without the matching registry entry — the required `governance` check carries it",
  observes:
    "whether the entry says anything true; a line citing the issue is findable, which is all a rule can see",
  schema: [{ type: "object", additionalProperties: true }],
  check(arrival, ctx) {
    const registries = arrival.registries;
    if (!registries) return;
    // Nothing to compare against means no events: the same skip the ported
    // directives make when a branch has no work against the trunk.
    if (arrival.range && arrival.range.hasBase === false && !arrival.pending) return;
    const issues = issuesOf(arrival);
    if (issues.length === 0) return;
    const cited = new Set(registries.decisions?.issues);
    const inChangelog = new Set(registries.changelog?.issues);

    for (const issue of issues) {
      if (inChangelog.has(issue)) continue;
      ctx.report(
        ["registries", "changelog", "issues"],
        `CHANGELOG.md carries no line citing #${issue}. A change that reached the trunk and left no entry is a change nobody downstream can find; add a bullet under '## [Unreleased]' linking the issue.`
      );
    }

    for (const [index, receipt] of (registries.receipts?.files ?? []).entries()) {
      if (!receipt.touched || !receipt.recordsRuling || receipt.issue === null) continue;
      if (cited.has(receipt.issue)) continue;
      ctx.report(
        ["registries", "receipts", "files", index],
        `${receipt.path} records a ruling but docs/decisions.md carries no line citing #${receipt.issue}. A receipt is evidence; the adjudication layer is where a reader looks for what is in force (CLAUDE.md § Docs).`
      );
    }

    for (const [index, gate] of (arrival.gates ?? []).entries()) {
      if (gate.direction !== "widened" && gate.direction !== "mixed") continue;
      const ruled = issues.some((issue) => cited.has(issue));
      if (ruled || gate.deviation === "changed") continue;
      ctx.report(
        ["gates", index],
        `${gate.path} ${gate.direction === "mixed" ? "loosened at least one number" : "widened"} with no authorisation: docs/decisions.md cites none of ${issues.map((issue) => `#${issue}`).join(", ")}, and the ledger's own approvedDeviation note did not change (presence never waives — #781). Record the ruling or extend the section's note.`
      );
    }
  },
});
