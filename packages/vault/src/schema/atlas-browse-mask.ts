import type { DatabaseSync } from 'node:sqlite';

import { SEALED_PLACEHOLDER, sealedColumnsOf } from './sealed.js';

/** Mask sealed cells in-place — the same placeholder the read path shows. */
export function maskSealed(
  vault: DatabaseSync,
  logical: string,
  rows: Record<string, unknown>[],
): void {
  const sealed = sealedColumnsOf(logical, vault);
  if (sealed.length === 0) return;
  for (const row of rows) {
    for (const col of sealed) {
      const value = row[col];
      if (value != null && value !== '') row[col] = SEALED_PLACEHOLDER;
    }
  }
}
