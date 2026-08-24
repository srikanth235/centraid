// The scope-extent algebra shared by every consent plane (#308 A3/A4).
//
// A scope extent is (schema, table?, verbs, rowFilter?, fieldMask?) — the same
// five columns `consent_grant_scope` and `consent_scope_tombstone` store and
// the same five fields a manifest declares. Two planes ask the SAME question
// of them — the install-grant top-up ("is this declared scope already
// covered?") and the consent memory ("does this approval clear that
// tombstone?") — so the answer lives here once. A second, drifting copy is how
// the two planes come to disagree about what the owner said.

import type { FilterClause } from "./gateway/types.js";

/**
 * One scope extent in whichever shape its store hands it over: SQLite rows
 * carry `null` for an unset column, manifests and DTOs carry `undefined`.
 * Both mean the same thing here — unset — and both are accepted.
 *
 * The gateway's install/consent planes compare extents with this.
 * @public
 */
export interface ScopeExtent {
  schema: string;
  table?: string | null | undefined;
  verbs: string;
  rowFilter?: readonly FilterClause[] | null | undefined;
  fieldMask?: readonly string[] | null | undefined;
}

const unsetToNull = <T>(value: T | null | undefined): T | null => value ?? null;

/**
 * Does `outer` already cover everything `inner` asks for?
 *
 * Covering is deliberately ONE-directional — a broad extent covers a narrow
 * one, never the reverse:
 *   - an unset table (schema-wide) covers any table of that schema;
 *   - an unset row filter (all rows) covers a filtered extent, and two set
 *     filters must be identical (the vault does not reason about filter
 *     implication, so anything else is "not covered");
 *   - an unset field mask (all fields) covers any mask, and a set mask covers
 *     only a subset mask.
 * `verbs` must match exactly: read/act/reveal grading is the caller's job
 * (`verbAllowed` in gateway/consent.ts), not an extent property.
 *
 * The gateway's install/consent planes compare extents with this.
 * @public
 */
export function scopeCovers(outer: ScopeExtent, inner: ScopeExtent): boolean {
  if (outer.schema !== inner.schema || outer.verbs !== inner.verbs)
    return false;
  const outerTable = unsetToNull(outer.table);
  if (outerTable !== null && outerTable !== unsetToNull(inner.table))
    return false;
  const outerRows = unsetToNull(outer.rowFilter);
  if (outerRows !== null) {
    const innerRows = unsetToNull(inner.rowFilter);
    if (JSON.stringify(outerRows) !== JSON.stringify(innerRows)) return false;
  }
  const outerFields = unsetToNull(outer.fieldMask);
  if (outerFields !== null) {
    const innerFields = unsetToNull(inner.fieldMask);
    if (innerFields === null) return false;
    const allowed = new Set(outerFields);
    if (!innerFields.every((field) => allowed.has(field))) return false;
  }
  return true;
}
