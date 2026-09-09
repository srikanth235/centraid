// Every `invalid` case is a red the shell directive demonstrated: a frozen
// receipt modified, one deleted, an append-only ledger rewritten, and a line
// removed from a frozen section.
import rule from "./doc-integrity.mjs";
import { ruleTester } from "../lib/rule.mjs";

/**
 * A minimal arrival record carrying one frozen-registry row.
 *
 * @param {object} row The row.
 * @param {object[]} [waivers] Waivers in scope.
 * @returns {string} The record, as the JSON a rule lints.
 */
const withFrozen = (row, waivers = []) =>
  JSON.stringify(
    { schema: 2, commits: [], pending: null, waivers, registries: { frozen: [row] } },
    null,
    2
  );

const receipt = { path: "receipts/issue-1.md", mode: "frozen-files", heading: null, baseSha: "aaa", headSha: "aaa", deleted: false };
const ledger = { path: "COSTS.md", mode: "append-only", heading: null, baseSha: "aaa", headSha: "bbb", deleted: false, appendOnly: { prefixIntact: true } };
const section = { path: "CONSTITUTION.md", mode: "frozen-section", heading: "Evolution Log", baseSha: "aaa", headSha: "bbb", deleted: false, section: { missingLines: [] } };

ruleTester().run("doc-integrity", rule, {
  valid: [
    withFrozen(receipt),
    withFrozen(ledger),
    withFrozen(section),
    // An empty registry is what "no new work against the trunk" looks like.
    JSON.stringify({ schema: 2, commits: [], pending: null, waivers: [], registries: { frozen: [] } }),
    // A path-scoped waiver with a reason exempts exactly that path.
    withFrozen({ ...receipt, headSha: "bbb" }, [
      { directive: "doc-integrity", path: "receipts/issue-1.md", reason: "coordinated rewrite", source: "pending" },
    ]),
  ],
  invalid: [
    {
      code: withFrozen({ ...receipt, headSha: "bbb" }),
      errors: [{ message: /frozen-files: 'receipts\/issue-1\.md' was modified/u }],
    },
    {
      code: withFrozen({ ...receipt, headSha: null, deleted: true }),
      errors: [{ message: /was deleted or renamed away/u }],
    },
    {
      // A waiver for a different path does not travel.
      code: withFrozen({ ...receipt, headSha: "bbb" }, [
        { directive: "doc-integrity", path: "COSTS.md", reason: "unrelated", source: "pending" },
      ]),
      errors: 1,
    },
    {
      // A waiver with no reason is not a waiver.
      code: withFrozen({ ...receipt, headSha: "bbb" }, [
        { directive: "doc-integrity", path: "receipts/issue-1.md", reason: "", source: "pending" },
      ]),
      errors: 1,
    },
    {
      code: withFrozen({ ...ledger, appendOnly: { prefixIntact: false } }),
      errors: [{ message: /append-only: 'COSTS\.md' rewrote or removed existing content/u }],
    },
    {
      code: withFrozen({ ...ledger, headSha: null, deleted: true }),
      errors: [{ message: /append-only: 'COSTS\.md' was deleted/u }],
    },
    {
      code: withFrozen({ ...section, section: { missingLines: ["- 2026-01-01 @someone — a ruling"] } }),
      errors: [{ message: /Removed line: '- 2026-01-01 @someone — a ruling'/u }],
    },
    {
      code: withFrozen({ ...section, headSha: null, deleted: true }),
      errors: [{ message: /frozen-section: 'CONSTITUTION\.md' was deleted/u }],
    },
    {
      code: withFrozen({ ...receipt, mode: "nonsense" }),
      errors: [{ message: /unknown mode 'nonsense'/u }],
    },
  ],
});
