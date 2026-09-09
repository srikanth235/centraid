// System-of-record documents are append-only (#1005).
//
// Ported from the vendored `governance-kit/audit` shell directive of the same
// name. Once content lands on the trunk it is evidence of what was true then,
// and a later change set may only add to it. Three modes, unchanged:
//
//   frozen-files   <glob>            every matching file that existed at the
//                                    baseline is immutable; new files are free
//   append-only    <file>            the baseline blob must remain an exact
//                                    byte-prefix of the current one
//   frozen-section <file> <heading>  every non-blank line under that heading at
//                                    the baseline must still be there, verbatim
//
// The comparison itself happened in the generator (`registries.frozen`), which
// is what a rule cannot do; the judgement is here, which is what a generator
// should not do.
import { defineArrivalRule } from "../lib/rule.mjs";

/** How to waive one path, quoted in every message so the fix is in the finding. */
const waiverHint = (path) =>
  `waive with 'governance: allow-doc-integrity ${path} <reason>'`;

export default defineArrivalRule({
  id: "doc-integrity",
  statute: "#doc-integrity",
  door: "hook",
  description: "Frozen documents may only be added to, never rewritten or erased.",
  // The pack row carries this rule's configuration; the shape is the pack's
  // business, so the schema is permissive and the rule reads what it knows.
  schema: [{ type: "object", additionalProperties: true }],
  enforces:
    "a change set that rewrites or deletes a document already on the trunk cannot be committed",
  check(arrival, ctx) {
    const waived = new Set(
      arrival.waivers
        .filter((waiver) => waiver.directive === "doc-integrity" && waiver.reason !== "")
        .map((waiver) => waiver.path)
    );
    for (const [index, row] of (arrival.registries.frozen ?? []).entries()) {
      if (waived.has(row.path)) continue;
      const at = ["registries", "frozen", index];
      if (row.mode === "frozen-files") {
        if (row.deleted) {
          ctx.report(
            at,
            `frozen-files: past document '${row.path}' was deleted or renamed away; it is immutable once on the default branch (add a new file instead, or ${waiverHint(row.path)})`
          );
        } else if (row.baseSha !== row.headSha) {
          ctx.report(
            at,
            `frozen-files: '${row.path}' was modified; it is immutable once on the default branch (add a new file instead, or ${waiverHint(row.path)})`
          );
        }
        continue;
      }
      if (row.mode === "append-only") {
        if (row.deleted) {
          ctx.report(
            at,
            `append-only: '${row.path}' was deleted; it is an append-only ledger (${waiverHint(row.path)})`
          );
        } else if (!row.appendOnly?.prefixIntact) {
          ctx.report(
            at,
            `append-only: '${row.path}' rewrote or removed existing content; only appended lines are allowed (${waiverHint(row.path)})`
          );
        }
        continue;
      }
      if (row.mode === "frozen-section") {
        if (row.deleted) {
          ctx.report(
            at,
            `frozen-section: '${row.path}' was deleted (its '## ${row.heading}' history is frozen; ${waiverHint(row.path)})`
          );
          continue;
        }
        for (const line of row.section?.missingLines ?? []) {
          ctx.report(
            at,
            `frozen-section: a line under '## ${row.heading}' in '${row.path}' was edited or removed — that section is frozen history. Removed line: '${line}' (${waiverHint(row.path)})`
          );
        }
        continue;
      }
      ctx.report(
        at,
        `doc-integrity config: unknown mode '${row.mode}' (expected frozen-files | append-only | frozen-section)`
      );
    }
  },
});
