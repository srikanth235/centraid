// @ts-nocheck — RuleTester fixtures are partial arrival records.
// Every `invalid` case is a red the shell directive demonstrated: a duplicate
// issue number, a bad filename, a completed change with no receipt, a stub, a
// missing section, a fence with no outcome, and a missing Audit verdict.
import rule from "./receipt-per-issue.ts";
import { ruleTester } from "../lib/rule.ts";

const good = {
  path: "receipts/issue-7-a-slug.md",
  name: "issue-7-a-slug.md",
  addedInRange: true,
  addedInPending: false,
  fileWaiver: false,
  headings: ["What changed", "Verification", "Audit"],
  stub: false,
  verification: { hasFence: true, hasOutcome: true, hasUrl: false },
  audit: { hasVerdict: true },
};

/**
 * A minimal arrival record carrying a receipt registry.
 *
 * @param {object[]} files The receipts.
 * @param {object} [change] Overrides for the change facts.
 * @param {object} [extra] Overrides for the record.
 * @returns {string} The record, as the JSON a rule lints.
 */
const withReceipts = (files, change = {}, extra = {}) =>
  JSON.stringify(
    {
      schema: 6,
      commits: [],
      pending: null,
      waivers: [],
      registries: {
        receipts: {
          files,
          change: {
            // `completed` is derived from the range and the pending commit, not
            // from the branch the checkout is on (R-1005-27).
            completed: true,
            touchesReceipt: true,
            ...change,
          },
        },
      },
      ...extra,
    },
    null,
    2
  );

ruleTester().run("receipt-per-issue", rule, {
  valid: [
    withReceipts([good]),
    withReceipts([{ ...good, path: "receipts/issue-7.md", name: "issue-7.md" }]),
    // A durable URL is evidence on its own.
    withReceipts([{ ...good, verification: { hasFence: false, hasOutcome: false, hasUrl: true } }]),
    // Shape is demanded only of a receipt this change added.
    withReceipts([{ ...good, addedInRange: false, stub: true }]),
    // An intermediate commit may carry a stub.
    withReceipts([{ ...good, stub: true }], { completed: false }),
    // A head-of-file waiver exempts one receipt entirely.
    withReceipts([{ ...good, fileWaiver: true, name: "not-a-receipt.md", stub: true }]),
    // A completed change with no receipt, waived in a commit body.
    withReceipts([], { touchesReceipt: false }, {
      commits: [{ sha: "abc", subject: "chore: release (#1)", body: "", parents: ["p"], files: [] }],
      waivers: [{ directive: "receipt-per-issue", path: null, reason: "release commit", source: "commit:abc" }],
    }),
  ],
  invalid: [
    {
      code: withReceipts([good, { ...good, path: "receipts/issue-7-again.md", name: "issue-7-again.md" }]),
      errors: [{ message: /issue #7 already has a receipt at receipts\/issue-7-a-slug\.md/u }],
    },
    {
      code: withReceipts([{ ...good, path: "receipts/Notes.md", name: "Notes.md" }]),
      errors: [{ message: /receipt filename must match 'issue-<N>\.md'/u }],
    },
    {
      code: withReceipts([], { touchesReceipt: false }),
      errors: [{ message: /completed change touches no receipts\/issue-\*\.md/u }],
    },
    {
      code: withReceipts([{ ...good, stub: true }]),
      errors: [{ message: /session-only receipt stub cannot satisfy a completed change/u }],
    },
    {
      code: withReceipts([{ ...good, headings: ["Verification", "Audit"] }]),
      errors: [{ message: /missing a '## What changed' section/u }],
    },
    {
      code: withReceipts([{ ...good, verification: { hasFence: true, hasOutcome: false, hasUrl: false } }]),
      errors: [{ message: /a fence alone is not evidence/u }],
    },
    {
      code: withReceipts([{ ...good, headings: ["What changed", "Verification"] }]),
      errors: [{ message: /missing a '## Audit' section/u }],
    },
    {
      code: withReceipts([{ ...good, audit: { hasVerdict: false } }]),
      errors: [{ message: /records no PASS\/REFUTED verdict/u }],
    },
    {
      // A waiver in a merge commit does not excuse the change set.
      code: withReceipts([], { touchesReceipt: false }, {
        commits: [{ sha: "abc", subject: "Merge branch 'x'", body: "", parents: ["p", "q"], files: [] }],
        waivers: [{ directive: "receipt-per-issue", path: null, reason: "merge", source: "commit:abc" }],
      }),
      errors: 1,
    },
  ],
});
