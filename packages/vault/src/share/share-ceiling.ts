/*
 * TWO PROPERTIES THAT OUTLIVE THE FRAME (#996, R10).
 *
 * `subscription-frame.ts` carried both, and the predicate transport that
 * replaced it has to keep them or deleting the composer would quietly delete a
 * ceiling and an enforcement point along with it:
 *
 *   1. THE ONE CEILING (#929). `share_delivery_config.max_size_bytes` is the
 *      per-grant answer; the constant below is the fail-closed default when a
 *      grant declares none — generous yet finite, and the same number the three
 *      ceilings it replaced all fell back to. It is judged BEFORE any
 *      transport, so an over-ceiling grant leaves no fulfillment row and dials
 *      nobody.
 *   2. THE SEALED REGISTRY IS A PIPELINE PROPERTY. A sealed column must travel
 *      as ciphertext or not at all. Plaintext here would make a subscription a
 *      seventh enforcement point that silently is not one — so the rows are
 *      checked on the way out, by ENTITY, not by a hard-coded table.
 */

import type { DatabaseSync } from "node:sqlite";

import { VaultShareError } from "../errors.js";
import { isSealedValue, sealedColumnsOf } from "../schema/sealed.js";
import type { ShareRowImage } from "./closure-outputs.js";
import type { ShareableItemType } from "./closure.js";
import { readShareClosure } from "./read-closure.js";

export const SHARE_DEFAULT_MAX_SIZE_BYTES = 4 * 1024 * 1024 * 1024;

export class ShareSizeCeilingError extends Error {
  constructor(
    readonly authorityId: string,
    readonly currentSizeBytes: number,
    readonly maxSizeBytes: number
  ) {
    super(
      `share grant ${authorityId} is ${currentSizeBytes} bytes, above its ${maxSizeBytes} byte maximum`
    );
    this.name = "ShareSizeCeilingError";
  }
}

/**
 * What holding this grant costs the audience: the rows of its closure plus the
 * manifest's bytes, deduped by sha — one photograph shared twice is one.
 *
 * MEASURED ON THE CLOSURE, not on a pass's outputs. The ceiling is a property
 * of the GRANT ("this subject is too big to hand anyone"), so it must not
 * depend on how far along one audience happens to be: an audience that is
 * merely up to date would otherwise measure zero and pass a ceiling the grant
 * has never been under.
 */
export function shareClosureSizeBytes(closure: {
  rows: unknown;
  blobs: readonly { sha256: string; size: number }[];
}): number {
  const blobSizes = new Map<string, number>();
  for (const blob of closure.blobs) blobSizes.set(blob.sha256, blob.size);
  return (
    Buffer.byteLength(JSON.stringify(closure.rows), "utf8") +
    [...blobSizes.values()].reduce((sum, size) => sum + size, 0)
  );
}

/**
 * JUDGED ONCE PER PASS, BEFORE ANY AUDIENCE IS CONSULTED. An over-ceiling
 * grant must leave no fulfillment row and dial no transport — including when
 * every peer is unreachable, which is the case a check inside the delivery
 * loop silently skips.
 */
export function assertShareCeiling(
  origin: DatabaseSync,
  input: {
    authorityId: string;
    originVaultId: string;
    subjectType: ShareableItemType;
    subjectId: string;
    maxSizeBytes?: number | null;
  }
): void {
  assertClosureWithinCeiling(
    input.authorityId,
    readShareClosure(origin, {
      originVaultId: input.originVaultId,
      itemType: input.subjectType,
      itemIds: [input.subjectId],
      crossOwner: true,
    }),
    input.maxSizeBytes
  );
}

export function assertClosureWithinCeiling(
  authorityId: string,
  closure: {
    rows: unknown;
    blobs: readonly { sha256: string; size: number }[];
  },
  maxSizeBytes?: number | null
): void {
  const sizeBytes = shareClosureSizeBytes(closure);
  const ceiling = maxSizeBytes ?? SHARE_DEFAULT_MAX_SIZE_BYTES;
  if (sizeBytes > ceiling)
    throw new ShareSizeCeilingError(authorityId, sizeBytes, ceiling);
}

/**
 * Logical entity for a physical table, spelled the way `sealedColumnsOf` reads
 * it. The registry keys on the ontology's name, and the outputs carry physical
 * tables, so the one underscore that separates the schema from the entity is
 * the whole translation.
 */
function entityOf(table: string): string {
  const cut = table.indexOf("_");
  return cut === -1 ? table : `${table.slice(0, cut)}.${table.slice(cut + 1)}`;
}

export function assertSealedColumnsStaySealed(
  rows: readonly ShareRowImage[]
): void {
  for (const row of rows) {
    const sealed = sealedColumnsOf(entityOf(row.table));
    if (sealed.length === 0) continue;
    for (const column of sealed) {
      const value = row.row[column];
      if (value === null || value === undefined) continue;
      if (typeof value === "string" && isSealedValue(value)) continue;
      throw new VaultShareError(
        `${entityOf(row.table)}.${column} would leave the origin unsealed; a subscription carries ciphertext or nothing`
      );
    }
  }
}
