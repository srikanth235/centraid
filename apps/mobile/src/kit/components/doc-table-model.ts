// The record table's data shape on this surface (#765, spec §9/§11).
//
// The two pieces of logic — the snip line that replaces the hidden columns,
// and the row menu's order and grouping — are shared and live in
// `@centraid/design/blocks`. What is here is the record as this app's screens
// already hold it, and the adapter that feeds it to the shared snip.

import { docSnipLine } from "@centraid/design/blocks";

export type { DocRowAction } from "@centraid/design/blocks";

/** One record, as the caller already has it. */
export interface DocRecord {
  key: string;
  title: string;
  /** The `Kind` column's value on a wide surface. */
  kind: string;
  /** The `Written` column's value on a wide surface. */
  written: string;
}

/** The snip line — the two hidden columns, joined. */
export function snipLine(record: DocRecord): string {
  return docSnipLine(record.kind, record.written);
}
