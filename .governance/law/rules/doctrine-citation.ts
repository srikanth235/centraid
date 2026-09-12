// A change to a doctrine domain says which doctrine it answers to (#1005).
//
// The repository's decisions live in `docs/decisions.md`, and a pack names the
// handful of paths whose doctrine is written down there — the vault schema, the
// design tokens, the PR gate, the mobile replica, the law itself. This rule
// asks two questions, both of them about CITATION rather than about content:
//
//   a domain was touched  → the change cites that domain's decision anchor, or
//                           its issue, in a receipt it touched or in a commit
//                           body. Not "is the change right" — only "did the
//                           author say which settled question it is under".
//   a ruling was recorded → the paragraph that records it cites something. A
//                           receipt that writes `**W6-D1**` and nothing else
//                           has invented a rule nobody can trace, which is the
//                           exact shape #1002 landed with.
//
// The rule OBSERVES. Whether a citation is the right one is a reading, and a
// reading is the owner's; what a rule can see is whether there is one at all.
import { globToRegExp } from "../lib/digest.ts";
import { defineArrivalRule } from "../lib/rule.ts";
import type { Arrival } from "../lib/types.ts";

/**
 * The citations a change made, anywhere a reviewer would look for one.
 *
 * @param {object} arrival The record.
 * @returns {Set<string>} Issue references and decisions anchors.
 */
export function citationsOf(arrival: Arrival) {
  const cites = new Set();
  const scan = (text) => {
    for (const match of (text ?? "").matchAll(/#(?<number>[0-9]{2,7})\b/gu)) {
      cites.add(`#${match.groups?.number}`);
    }
    for (const match of (text ?? "").matchAll(/decisions\.md(?<anchor>#[a-z0-9-]+)/gu)) {
      cites.add(`docs/decisions.md${match.groups?.anchor}`);
    }
  };
  for (const commit of arrival.commits ?? []) scan(`${commit.subject}\n${commit.body}`);
  if (arrival.pending) scan(arrival.pending.message);
  for (const receipt of arrival.registries?.receipts?.files ?? []) {
    if (receipt.touched) for (const cite of receipt.cites ?? []) cites.add(cite);
  }
  return cites;
}

/**
 * The issue a decisions anchor ends with, when it ends with one.
 *
 * `#one-vault-every-seat-996` is the same citation as `#996`; a receipt that
 * names the issue has named the section, and demanding the anchor as well
 * would be demanding a spelling.
 *
 * @param {string} anchor The anchor.
 * @returns {string|null} `#N`, or null.
 */
export function issueOfAnchor(anchor: string) {
  const match = /-(?<number>[0-9]{2,7})$/u.exec(anchor ?? "");
  return match === null ? null : `#${match.groups?.number}`;
}

export default defineArrivalRule({
  id: "doctrine-citation",
  statute: "#doctrine-citation",
  door: "window",
  description: "A change to a settled domain names the decision it answers to.",
  observes:
    "that a change touching a doctrine domain cited that domain's decision, and that a ruling recorded in a receipt cites something — whether the citation is the RIGHT one is a reading, and a reading is the owner's",
  schema: [{ type: "object", additionalProperties: true }],
  check(arrival, ctx) {
    const domains = arrival.law?.domains ?? [];
    const touched = [
      ...(arrival.files ?? []),
      ...(arrival.pending?.files ?? []),
    ].map((row) => row.path);
    const cites = citationsOf(arrival);

    for (const [index, domain] of domains.entries()) {
      const matchers = (domain.paths ?? []).map(globToRegExp);
      const hits = touched.filter((file) => matchers.some((matcher) => matcher.test(file)));
      if (hits.length === 0) continue;
      const issue = issueOfAnchor(domain.decision);
      if (cites.has(`docs/decisions.md${domain.decision}`)) continue;
      if (issue !== null && cites.has(issue)) continue;
      ctx.report(
        ["law", "domains", index],
        `this change touches the '${domain.id}' domain (${hits[0]}${hits.length > 1 ? ` and ${hits.length - 1} more` : ""}) and cites neither docs/decisions.md${domain.decision} nor ${issue ?? "its issue"}. The doctrine for that domain is already settled; name it in the receipt or in a commit body so a reader can tell a change made under it from one that did not know it existed.`
      );
    }

    for (const [index, receipt] of (
      arrival.registries?.receipts?.files ?? []
    ).entries()) {
      if (!receipt.touched) continue;
      for (const [position, ruling] of (receipt.rulings ?? []).entries()) {
        if ((ruling.cites ?? []).length > 0) continue;
        ctx.report(
          ["registries", "receipts", "files", index, "rulings", position],
          `${receipt.path}:${ruling.line} records ruling ${ruling.id} and cites nothing. A ruling with no issue and no docs/decisions.md anchor is a rule nobody agreed to: the next reader cannot find where it was argued or whether it is still in force.`
        );
      }
    }
  },
});
