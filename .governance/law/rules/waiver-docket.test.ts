// @ts-nocheck — RuleTester fixtures are partial arrival records.
// Every `invalid` case is an exception nobody would be tracking: a register
// row with a field missing, a duplicate id, an expiry that has passed, a
// waiver with no row, a row the same change filed, a row the owner has not
// granted, and an `eslint-disable` that names no row at all.
import rule from "./waiver-docket.ts";
import { ruleTester } from "../lib/rule.ts";

const TODAY = { today: "2026-09-09" };
const DOCKET = "/repo/.governance/law/docket.json";
const ARRIVAL = "/repo/.governance/law/out/arrival.json";
const RECEIPT = "/repo/receipts/issue-1.md";

/**
 * A well-formed docket row.
 *
 * @param {object} [overrides] Fields to replace.
 * @returns {object} The row.
 */
const row = (overrides = {}) => ({
  id: "D-1",
  rule: "estate-separation",
  path: null,
  reason: "why",
  authority: "https://github.com/srikanth235/centraid/pull/1",
  filedBy: "owner",
  issue: "#1005",
  expires: "2027-01-01",
  ...overrides,
});

/** @param {object[]} rows The rows. @returns {string} The docket document. */
const docket = (rows) => JSON.stringify({ schema: 1, rows }, null, 2);

/**
 * An arrival record carrying a docket and some spending.
 *
 * @param {object} parts `waivers`, `rows`, `rowsOnBase`, `stamp`.
 * @returns {string} The record.
 */
const arrival = (parts) =>
  JSON.stringify(
    {
      schema: 4,
      waivers: parts.waivers ?? [],
      registries: {
        docket: {
          path: ".governance/law/docket.json",
          exists: parts.exists ?? true,
          rows: parts.rows ?? [],
          rowsOnBase: parts.rowsOnBase ?? [],
        },
      },
      ...(parts.stamp ? { stamp: parts.stamp } : {}),
    },
    null,
    2
  );

const waiver = (overrides = {}) => ({
  directive: "estate-separation",
  path: null,
  reason: "why",
  source: "commit:a1",
  docket: null,
  ...overrides,
});

ruleTester().run("waiver-docket (the register and the spending)", rule, {
  valid: [
    { code: docket([row()]), filename: DOCKET, options: [TODAY] },
    // Two rows for one rule are fine when their paths differ.
    {
      code: docket([row(), row({ id: "D-2", path: "CHANGELOG.md" })]),
      filename: DOCKET,
      options: [TODAY],
    },
    // Spent against a row that was already on the trunk and is granted.
    {
      code: arrival({ waivers: [waiver()], rows: [row()], rowsOnBase: ["D-1"] }),
      filename: ARRIVAL,
      options: [TODAY],
    },
    // No register yet: there is no row to be missing.
    {
      code: arrival({ waivers: [waiver()], exists: false }),
      filename: ARRIVAL,
      options: [TODAY],
    },
    // At the hook door the spending half is silent — the author holds only the
    // commit being written.
    {
      code: arrival({
        waivers: [waiver()],
        rows: [row()],
        rowsOnBase: [],
        stamp: { door: "hook" },
      }),
      filename: ARRIVAL,
      options: [TODAY],
    },
    // A path-scoped row covers the file it names, by glob.
    {
      code: arrival({
        waivers: [waiver({ directive: "no-hardcoded-colors", path: "apps/photos/Chrome.module.css" })],
        rows: [row({ id: "D-3", rule: "no-hardcoded-colors", path: "apps/**/*.module.css" })],
        rowsOnBase: ["D-3"],
      }),
      filename: ARRIVAL,
      options: [TODAY],
    },
  ],
  invalid: [
    {
      code: docket([{ id: "D-1", rule: "x", path: null, reason: "r", authority: "a", filedBy: "owner", issue: "#1" }]),
      filename: DOCKET,
      options: [TODAY],
      errors: [{ message: /no YYYY-MM-DD expiry/u }, { message: /has no 'expires'/u }],
    },
    {
      code: docket([row(), row({ path: "x" })]),
      filename: DOCKET,
      options: [TODAY],
      errors: [{ message: /docket id 'D-1' is used twice/u }],
    },
    {
      code: docket([row({ expires: "2026-09-08" })]),
      filename: DOCKET,
      options: [TODAY],
      errors: [{ message: /expired on 2026-09-08/u }],
    },
    {
      code: arrival({ waivers: [waiver()], rows: [], rowsOnBase: [] }),
      filename: ARRIVAL,
      options: [TODAY],
      errors: [{ message: /carries no row for it/u }],
    },
    {
      // Filed and spent in one arrival: the self-granted case.
      code: arrival({ waivers: [waiver()], rows: [row()], rowsOnBase: [] }),
      filename: ARRIVAL,
      options: [TODAY],
      errors: [{ message: /this same change filed/u }],
    },
    {
      code: arrival({
        waivers: [waiver()],
        rows: [row({ authority: "pending owner grant" })],
        rowsOnBase: ["D-1"],
      }),
      filename: ARRIVAL,
      options: [TODAY],
      errors: [{ message: /still 'pending owner grant'/u }],
    },
    {
      // The waiver names a row explicitly, and the row does not cover its path.
      code: arrival({
        waivers: [waiver({ docket: "D-2", path: "CHANGELOG.md" })],
        rows: [row({ id: "D-2", path: "QUALITY.md" })],
        rowsOnBase: ["D-2"],
      }),
      filename: ARRIVAL,
      options: [TODAY],
      errors: [{ message: /carries no row for it/u }],
    },
  ],
});

// The suppression half reads the document's TEXT, not an AST: a markdown
// comment is a directive to ESLint but has no node of its own, and the check is
// about the WORDS in the directive rather than about what it suppresses. The
// fixtures below use the block-comment form rather than the markdown one, for
// one mechanical reason: `RuleTester` refuses a real `<!-- eslint-disable -->`
// naming any rule but the one under test, so a markdown fixture would test
// `RuleTester` and not this rule. The end-to-end case is a real directive in a
// receipt, demonstrated by hand in the receipt's verification section.
ruleTester("documents").run("waiver-docket (the suppressions)", rule, {
  valid: [
    {
      code: "/* eslint-disable law/receipt-per-issue -- docket:D-9 the audit lands at close */\n",
      filename: RECEIPT,
      options: [TODAY],
    },
    { code: "# A receipt with nothing suppressed\n", filename: RECEIPT, options: [TODAY] },
    // Prose ABOUT a directive is not a directive: the constitution quotes the
    // syntax in every section it appears in.
    {
      code: "Write it as `<!-- eslint-disable law/x -->` and file the row.\n",
      filename: RECEIPT,
      options: [TODAY],
    },
  ],
  invalid: [
    {
      code: "/* eslint-disable law/receipt-per-issue */\n",
      filename: RECEIPT,
      options: [TODAY],
      errors: [{ message: /names no docket row/u }],
    },
    {
      // A description that is not a docket citation is still no citation.
      code: "/* eslint-disable-next-line law/doc-integrity -- it is fine, honest */\n",
      filename: RECEIPT,
      options: [TODAY],
      errors: [{ message: /names no docket row/u }],
    },
  ],
});
