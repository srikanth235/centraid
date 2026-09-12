// @ts-nocheck — RuleTester fixtures are partial arrival records.
// Every `invalid` case is a red this rule is for: the law and the product in
// one commit, the same mix split across two, a law commit answering an issue CI
// says is not a proposal, and the staged set the hook door judges.
import rule from "./estate-separation.ts";
import { ruleTester } from "../lib/rule.ts";

const law = { path: "tests/floors.json", status: "M", estate: "law" };
const territory = { path: "packages/server/src/index.ts", status: "M", estate: "territory" };
const registry = { path: "receipts/issue-9.md", status: "M", estate: "registry" };

/**
 * A commit, as the arrival record carries one.
 *
 * @param {string} sha Its oid.
 * @param {object[]} files Its tagged file rows.
 * @param {object} [extra] Overrides (`parents`, `body`, `subject`).
 * @returns {object} The commit.
 */
const commit = (sha, files, extra = {}) => ({
  sha,
  subject: "feat(x): a change (#9)",
  body: "",
  parents: ["p"],
  files,
  ...extra,
});

/**
 * A minimal arrival record.
 *
 * @param {object} parts The record's interesting sections.
 * @returns {string} The record, as the JSON a rule lints.
 */
const record = (parts) =>
  JSON.stringify(
    {
      schema: 3,
      commits: [],
      files: [],
      pending: null,
      waivers: [],
      ci: { issueExists: null, issueIsProposal: null, prAuthorIsOwner: null },
      ...parts,
    },
    null,
    2
  );

ruleTester().run("estate-separation", rule, {
  valid: [
    // The expected shape: a rule lands with the receipt that authorised it.
    record({ commits: [commit("a1", [law, registry])], files: [law, registry] }),
    record({ commits: [commit("a1", [territory, registry])], files: [territory, registry] }),
    // A merge commit's content is its parents'; `git diff-tree` prints no diff
    // for one, so the aggregate is empty and only the commit-level skip is
    // under test here.
    record({
      commits: [commit("m1", [law, territory], { parents: ["p", "q"] })],
      files: [],
    }),
    // Waived in the commit body — the escape is a reason, never a bare token.
    record({
      commits: [commit("a1", [law, territory])],
      files: [law, territory],
      waivers: [
        { directive: "estate-separation", path: null, reason: "retiring a ledger", source: "commit:a1" },
      ],
    }),
    // The staged set, waived in the message being written.
    record({
      pending: { message: "feat: x (#9)", files: [law, territory] },
      waivers: [
        { directive: "estate-separation", path: null, reason: "why", source: "pending" },
      ],
    }),
    // A law commit whose issue CI confirmed is a proposal.
    record({
      commits: [commit("a1", [law])],
      files: [law],
      ci: { issueExists: true, issueIsProposal: true, prAuthorIsOwner: true },
    }),
    // Offline, `issueIsProposal` is null and the rule is silent rather than
    // guessing that a change to the law came from the wrong kind of issue.
    record({ commits: [commit("a1", [law])], files: [law] }),
    // At the hook door only the staged set is judged: a finding about a commit
    // already made would block a commit no edit to it could fix.
    record({
      commits: [commit("a1", [law, territory])],
      files: [law, territory],
      stamp: { door: "hook" },
    }),
  ],
  invalid: [
    {
      code: record({
        pending: { message: "feat: x (#9)", files: [law, territory] },
        stamp: { door: "hook" },
      }),
      errors: [{ message: /the staged change edits the law and the territory/u }],
    },
    {
      code: record({ commits: [commit("a1", [law, territory])], files: [law, territory] }),
      errors: [{ message: /a1 edits the law and the territory in one commit/u }],
    },
    {
      // The split the commit level cannot see, and the window door can.
      code: record({
        commits: [commit("a1", [law]), commit("b2", [territory])],
        files: [law, territory],
      }),
      errors: [{ message: /split across commits/u }],
    },
    {
      code: record({ pending: { message: "feat: x (#9)", files: [law, territory] } }),
      errors: [{ message: /the staged change edits the law and the territory/u }],
    },
    {
      code: record({
        commits: [commit("a1", [law])],
        files: [law],
        ci: { issueExists: true, issueIsProposal: false, prAuthorIsOwner: true },
      }),
      errors: [{ message: /names an issue that is not a proposal/u }],
    },
    {
      // A waiver with no reason is not a waiver — the same rule the shell
      // directives held to.
      code: record({
        commits: [commit("a1", [law, territory])],
        files: [law, territory],
        waivers: [{ directive: "estate-separation", path: null, reason: "", source: "commit:a1" }],
      }),
      errors: 1,
    },
  ],
});
