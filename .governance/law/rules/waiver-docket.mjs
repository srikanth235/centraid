// An exception nobody is tracking is not an exception but a hole (#1005).
//
// Every rule in this catalog can be waived, and that is deliberate: a law with
// no escape is a law people route around with `--no-verify`. What is not
// deliberate is a waiver that nobody ever revisits. `.governance/law/docket.json`
// is the register of standing exceptions, and this rule holds the two halves of
// it together:
//
//   the register  every row carries an id, the rule it excuses, the path it
//                 covers, a reason, the authority that granted it, who filed
//                 it, its issue and the date it expires. Ids are unique; an
//                 expired row is a finding.
//   the spending  every waiver an arrival spends — a `governance: allow-*`
//                 token in a commit body or on a line it added, an
//                 `eslint-disable` directive in a governance document — names
//                 a row that matches, that was already on the trunk at the
//                 merge-base, and that the owner has actually granted.
//
// The last clause is the point. A row filed and spent in the same arrival is a
// permission slip an agent wrote itself, and the only mechanical difference
// between that and a granted exception is which side of the merge-base the row
// was on. `registries.docket.rowsOnBase` is what the generator reads for it.
//
// Nothing here re-implements a suppression mechanism: ESLint's own
// `eslint-disable` IS the waiver primitive for the document rules, the config
// already reports an unused one as an error (`reportUnusedDisableDirectives`),
// and this rule only requires that the directive's `--` description names the
// docket row. The clock is an option the config injects, never something the
// rule reads.
import { globToRegExp } from "../lib/digest.mjs";
import { defineRule, locate } from "../lib/rule.mjs";

/** Every field a docket row must carry. */
export const FIELDS = Object.freeze([
  "id",
  "rule",
  "path",
  "reason",
  "authority",
  "filedBy",
  "issue",
  "expires",
]);

/** The authority string that means "written down, not yet granted". */
export const PENDING = "pending owner grant";

/**
 * An `eslint-disable*` directive, in a comment.
 *
 * The comment delimiter is required and a line carrying a backtick is skipped:
 * every constitution section QUOTES the directive, and prose about a
 * suppression is not one.
 */
const DISABLE = /(?:<!--|\/\*|\/\/)\s*eslint-disable(?:-next-line|-line)?\b[^\n]*/gu;

/**
 * Whether a docket row covers a path.
 *
 * A row with `path: null` covers every path the rule applies to; a row with a
 * glob covers what the glob matches. An exact path is the common case and
 * costs nothing to compare.
 *
 * @param {object} row The docket row.
 * @param {string|null} file The path the waiver was spent on.
 * @returns {boolean} Whether the row covers it.
 */
export function covers(row, file) {
  if (row.path === null || row.path === undefined) return true;
  if (file === null || file === undefined) return false;
  if (row.path === file) return true;
  return globToRegExp(row.path).test(file);
}

/**
 * The row a waiver names, or null.
 *
 * @param {object[]} rows The docket.
 * @param {object} waiver The waiver.
 * @returns {object|null} The matching row.
 */
export function rowFor(rows, waiver) {
  const candidates = (rows ?? []).filter(
    (row) => row.rule === waiver.directive && covers(row, waiver.path)
  );
  if (waiver.docket) return candidates.find((row) => row.id === waiver.docket) ?? null;
  return candidates[0] ?? null;
}

/**
 * Judge the register itself.
 *
 * @param {object} arrival The parsed docket, `{schema, rows}` or an array.
 * @param {string} today The date the config injected.
 * @param {(pointer: (string|number)[], message: string) => void} report Reporter.
 * @returns {void}
 */
function judgeDocket(arrival, today, report) {
  const rows = Array.isArray(arrival) ? arrival : (arrival?.rows ?? []);
  const seen = new Set();
  for (const [index, row] of rows.entries()) {
    for (const field of FIELDS) {
      if (!(field in (row ?? {}))) {
        report(["rows", index], `docket row ${index} has no '${field}'. Every field is required: a row missing one is an exception nobody can audit.`);
      }
    }
    if (typeof row?.id === "string") {
      if (seen.has(row.id)) {
        report(["rows", index, "id"], `docket id '${row.id}' is used twice. An id names one exception or it names nothing.`);
      }
      seen.add(row.id);
    }
    const expires = row?.expires;
    if (typeof expires !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(expires)) {
      report(["rows", index, "expires"], `docket row '${row?.id ?? index}' has no YYYY-MM-DD expiry. A standing exception with no date is a permanent one.`);
      continue;
    }
    if (expires < today) {
      report(["rows", index, "expires"], `docket row '${row?.id}' expired on ${expires}. Renew it with a stated reason, or delete it and the waiver it covers.`);
    }
  }
}

/**
 * Judge what the arrival spent.
 *
 * @param {object} arrival The arrival record.
 * @param {(pointer: (string|number)[], message: string) => void} report Reporter.
 * @returns {void}
 */
function judgeSpending(arrival, report) {
  const docket = arrival.registries?.docket;
  // Until the register exists there is no row to be missing. The front page
  // says "docket not yet established" instead, which is the difference between
  // a missing institution and a missing entry.
  if (!docket?.exists) return;
  const onBase = new Set(docket.rowsOnBase);
  for (const [index, waiver] of (arrival.waivers ?? []).entries()) {
    const row = rowFor(docket.rows, waiver);
    const where = `'${waiver.directive}'${waiver.path ? ` on ${waiver.path}` : ""} (${waiver.source})`;
    if (row === null) {
      report(["waivers", index], `${where} was waived, but ${docket.path} carries no row for it. File a row — id, rule, path, reason, authority, who filed it, its issue and an expiry — or drop the waiver.`);
      continue;
    }
    if (!onBase.has(row.id)) {
      report(["waivers", index], `${where} names docket row ${row.id}, which this same change filed. A row granted and spent in one arrival is a permission slip its author wrote itself; land the row first, and let the owner grant it.`);
      continue;
    }
    if (row.authority === PENDING) {
      report(["waivers", index], `${where} names docket row ${row.id}, whose authority is still '${PENDING}'. The row records the ask; only the owner's grant answers it.`);
    }
  }
}

export default defineRule({
  id: "waiver-docket",
  statute: "#waiver-docket",
  door: "hook",
  surface: "all",
  clock: true,
  description: "Every exception spent names a row in the register of exceptions.",
  enforces:
    "at the hook door, an `eslint-disable` directive in a governance document that does not name its docket row, and a docket row with a missing field, a duplicate id or no expiry",
  observes:
    "at the window door, whether the row a waiver names was on the trunk before the change spent it and whether the owner granted it — self-granting is visible mechanically, and settling it is the owner's",
  schema: [{ type: "object", additionalProperties: true }],
  create(context) {
    const file = context.filename.replaceAll("\\", "/");
    const today = context.options[0]?.today ?? "0000-00-00";
    if (file.endsWith("docket.json")) {
      return {
        Document(node) {
          const parsed = JSON.parse(context.sourceCode.getText());
          judgeDocket(parsed, today, (pointer, message) =>
            context.report({ node: locate(node, pointer) ?? node, message })
          );
        },
      };
    }
    if (file.endsWith("arrival.json")) {
      return {
        Document(node) {
          const arrival = JSON.parse(context.sourceCode.getText());
          // At the hook the author holds only the commit being written; a
          // finding about a row that landed three commits ago would block a
          // commit no edit to it could fix (estate-separation, same reason).
          if (arrival.stamp?.door === "hook") return;
          judgeSpending(arrival, (pointer, message) =>
            context.report({ node: locate(node, pointer) ?? node, message })
          );
        },
      };
    }
    // Any other document the law lints: the `eslint-disable` directives in it
    // must say which docket row permits them.
    // `root` is the markdown language's document node; `Document` is the JSON
    // language's. Declaring both is what lets one rule read either surface.
    const suppressions = () => {
      for (const [index, text] of context.sourceCode.getText().split("\n").entries()) {
        if (text.includes("`")) continue;
        const match = DISABLE.exec(text);
        DISABLE.lastIndex = 0;
        if (match === null) continue;
        if (/--[^\n]*\bdocket:D-[0-9]+\b/u.test(match[0])) continue;
        const line = index + 1;
        context.report({
          loc: { start: { line, column: 0 }, end: { line, column: 1 } },
          message:
            "this 'eslint-disable' names no docket row. Write it as '-- docket:D-<n> <why>' and file the row in .governance/law/docket.json; a suppression with no register entry is an exception nobody is tracking.",
        });
      }
    };
    return { root: suppressions, Document: suppressions };
  },
});
