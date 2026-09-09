// Every `invalid` case is one of the four events this rule is for: a change
// that lands with no changelog line, a receipt that rules with no decisions
// row, a gate that widened with neither a ruling nor a fresh waiver note, and a
// waiver spent with no docket row.
import rule, { issuesOf } from "./registry-completeness.mjs";
import { ruleTester } from "../lib/rule.mjs";
import assert from "node:assert/strict";
import test from "node:test";

const receipt = {
  path: "receipts/issue-9-a-slug.md",
  name: "issue-9-a-slug.md",
  issue: 9,
  touched: true,
  recordsRuling: true,
  cost: null,
};

/**
 * A minimal arrival record.
 *
 * @param {object} [parts] Overrides for the interesting sections.
 * @returns {string} The record, as the JSON a rule lints.
 */
const record = (parts = {}) => {
  const {
    changelog = [9],
    decisions = [9],
    receipts = [receipt],
    docket = { path: ".governance/law/docket.json", exists: false, rows: [] },
    ...rest
  } = parts;
  return JSON.stringify(
    {
      schema: 3,
      range: { base: "a", head: "b", mergeBase: "a", hasBase: true },
      commits: [],
      files: [],
      pending: null,
      waivers: [],
      gates: [],
      registries: {
        receipts: { files: receipts, change: {} },
        changelog: { path: "CHANGELOG.md", touched: true, issues: changelog, lines: 1 },
        decisions: { path: "docs/decisions.md", touched: true, issues: decisions, lines: 1 },
        docket,
      },
      ci: { issueExists: null, issueIsProposal: null, prAuthorIsOwner: null },
      ...rest,
    },
    null,
    2
  );
};

ruleTester().run("registry-completeness", rule, {
  valid: [
    record(),
    // A receipt that records no ruling asks nothing of the decisions file.
    record({ decisions: [], receipts: [{ ...receipt, recordsRuling: false }] }),
    // A receipt this change did not touch is not this change's to account for.
    record({ decisions: [], changelog: [], receipts: [{ ...receipt, touched: false }] }),
    // A gate that only tightened is not an event.
    record({ gates: [{ path: "tests/floors.json", commits: ["a"], direction: "narrowed", deviation: "unchanged" }] }),
    // A widening authorised by a ruling …
    record({ gates: [{ path: "tests/floors.json", commits: ["a"], direction: "widened", deviation: "unchanged" }] }),
    // … or by the section's own approvedDeviation note moving.
    record({
      decisions: [],
      receipts: [{ ...receipt, recordsRuling: false }],
      gates: [{ path: "tests/floors.json", commits: ["a"], direction: "widened", deviation: "changed" }],
    }),
    // A waiver with the docket absent: reported on the front page, not here.
    record({
      waivers: [{ directive: "estate-separation", path: null, reason: "why", source: "commit:a" }],
    }),
    // No new work against the trunk means no events at all.
    record({ changelog: [], decisions: [], range: { base: "a", head: "a", mergeBase: null, hasBase: false } }),
    // Nothing binds this range to an issue, so nothing is asked of it.
    record({ changelog: [], decisions: [], receipts: [] }),
  ],
  invalid: [
    {
      code: record({ changelog: [] }),
      errors: [{ message: /CHANGELOG\.md carries no line citing #9/u }],
    },
    {
      code: record({ decisions: [] }),
      errors: [{ message: /records a ruling but docs\/decisions\.md carries no line citing #9/u }],
    },
    {
      code: record({
        decisions: [],
        receipts: [{ ...receipt, recordsRuling: false }],
        gates: [{ path: "tests/floors.json", commits: ["a"], direction: "widened", deviation: "unchanged" }],
      }),
      errors: [{ message: /tests\/floors\.json widened with no authorisation/u }],
    },
    {
      code: record({
        decisions: [],
        receipts: [{ ...receipt, recordsRuling: false }],
        gates: [{ path: "tests/budgets.json", commits: ["a"], direction: "mixed", deviation: "unchanged" }],
      }),
      errors: [{ message: /loosened at least one number/u }],
    },
    {
      // The docket exists and carries a row for some other directive.
      code: record({
        waivers: [{ directive: "estate-separation", path: null, reason: "why", source: "commit:a" }],
        docket: {
          path: ".governance/law/docket.json",
          exists: true,
          rows: [{ directive: "doc-integrity" }],
        },
      }),
      errors: [{ message: /carries no row for it/u }],
    },
  ],
});

test("the issue is the touched receipt's, and the subjects only when there is none", () => {
  const parsed = (text) => JSON.parse(text);
  assert.deepEqual(issuesOf(parsed(record())), [9]);
  assert.deepEqual(
    issuesOf(parsed(record({ receipts: [{ ...receipt, touched: false }] }))),
    [],
    "an untouched receipt binds nothing"
  );
  assert.deepEqual(
    issuesOf({
      commits: [
        { subject: "feat(x): a (#12)" },
        { subject: "fix(y): b (#12)" },
        { subject: "chore: no issue" },
      ],
    }),
    [12]
  );
});
