import type { FilterClause } from "./gateway/types.js";

/** One extent as stored: SQLite rows carry `null`, DTOs `undefined` — both mean unset. @public */
export interface ScopeExtent {
  schema: string;
  table?: string | null | undefined;
  verbs: string;
  rowFilter?: readonly FilterClause[] | null | undefined;
  fieldMask?: readonly string[] | null | undefined;
}

const unsetToNull = <T>(value: T | null | undefined): T | null => value ?? null;

/** True when `outer` covers `inner` — ONE-directional; unset covers anything,
 * set row filters must be IDENTICAL, set masks subsets, verbs exact. @public */
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
