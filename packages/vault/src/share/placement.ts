// Share-by-placement (#599 decision 11). Sharing is PLACEMENT, not filtering:
// nothing may query your vault, so an item is projected INTO the audience vault
// and its bytes hardlinked there. No row-level ACLs — the vault boundary is the
// isolation. The order is fixed: read the closure from the origin (no
// transaction), hardlink blobs, then ONE transaction in the audience vault.
// Blobs first because a link is idempotent; the origin is NEVER written, so no
// two-database transaction exists. Lives OUTSIDE the per-vault
// AsyncLocalStorage handler path — a share spans two vault scopes.

import type { DatabaseSync } from "node:sqlite";

import type { LocalBlobStore } from "../blob/local.js";
import { liveBlobShas } from "../blob/read.js";
import { VaultShareError } from "../errors.js";
import { beginReplicaCommit, endReplicaCommit } from "../replica/change-log.js";
import { placeBlob } from "./blobs.js";
import type { BlobPlacement } from "./blobs.js";
import type { ProjectedItem, ShareableItemType } from "./closure.js";
import { projectShareClosure } from "./project-closure.js";
import { readShareClosure } from "./read-closure.js";
import { deleteProjectedClosure } from "./removal.js";

export interface ShareVaultRef {
  vault: DatabaseSync;
  blobs: { local: LocalBlobStore };
  sealKey?: Buffer;
  identitySeed?: Buffer;
}

export interface ShareItemsToVaultInput {
  /** READ-ONLY throughout this flow. */
  origin: ShareVaultRef;
  originVaultId: string;
  /** The only vault written. */
  audience: ShareVaultRef;
  itemType: ShareableItemType;
  /** ORIGIN row ids; one closure covers the set. */
  itemIds: readonly string[];
  /** An attribution, never a principal this vault can look up (#726). */
  sharedBy: string;
  now?: () => number;
  /**
   * Gates the origin's `media.location` policy against `exif_json` (#726 P3
   * threat 8). Defaults false — only the edge plane opts in.
   */
  crossOwner?: boolean;
}

export interface UnshareFromVaultInput {
  /** The only vault written. */
  audience: ShareVaultRef;
  itemType: ShareableItemType;
  itemId: string;
}

export interface UnshareFromVaultResult {
  removed: boolean;
  /** The inode survives until the LAST vault lets go; origin bytes stay. */
  orphanedShas: string[];
}

export interface MoveOutOfVaultInput {
  source: ShareVaultRef;
  itemType: ShareableItemType;
  itemId: string;
}

export interface ShareOriginRecord {
  itemType: string;
  itemId: string;
  originVaultId: string;
  originItemId: string;
  sharedBy: string;
  sharedAt: number;
}

export function readShareOrigin(
  audience: DatabaseSync,
  itemType: string,
  itemId: string
): ShareOriginRecord | undefined {
  const row = audience
    .prepare(
      `SELECT origin_vault_id, origin_item_id, shared_by, shared_at
         FROM core_share_origin WHERE item_type = ? AND item_id = ?`
    )
    .get(itemType, itemId) as
    | {
        origin_vault_id: string;
        origin_item_id: string;
        shared_by: string;
        shared_at: number;
      }
    | undefined;
  if (!row) return undefined;
  return {
    itemType,
    itemId,
    originVaultId: row.origin_vault_id,
    originItemId: row.origin_item_id,
    sharedBy: row.shared_by,
    sharedAt: row.shared_at,
  };
}

export interface ShareItemsToVaultResult {
  itemType: ShareableItemType;
  /** One entry per requested id, in order. */
  items: ProjectedItem[];
  blobs: BlobPlacement[];
}

/**
 * Idempotent: re-sharing, even by a different member, dedupes onto existing
 * rows (`core_content_item.sha256` is UNIQUE) and keeps the first placement.
 */
export function shareItemsToVault(
  input: ShareItemsToVaultInput
): ShareItemsToVaultResult {
  if (input.origin.vault === input.audience.vault) {
    throw new VaultShareError(
      "cannot share a vault into itself — sharing crosses a vault boundary"
    );
  }
  // Resolve out of the origin BEFORE touching the audience, so an unknown item
  // is refused with nothing placed anywhere.
  const closure = readShareClosure(input.origin.vault, {
    originVaultId: input.originVaultId,
    itemType: input.itemType,
    itemIds: input.itemIds,
    crossOwner: input.crossOwner === true,
  });

  const blobs: BlobPlacement[] = closure.blobs.map((entry) => ({
    sha256: entry.sha256,
    mode: placeBlob(
      input.origin.blobs.local,
      input.audience.blobs.local,
      entry.sha256
    ),
  }));

  const projection = projectShareClosure(input.audience.vault, closure, {
    sharedBy: input.sharedBy,
    now: input.now,
    keys:
      input.origin.sealKey && input.audience.sealKey
        ? { origin: input.origin.sealKey, audience: input.audience.sealKey }
        : undefined,
  });
  return { itemType: input.itemType, items: projection.items, blobs };
}

/**
 * Refuses to touch a row the audience AUTHORED (no `core_share_origin`
 * record): unshare removes placements, never someone's own data.
 */
export function unshareFromVault(
  input: UnshareFromVaultInput
): UnshareFromVaultResult {
  const audience = input.audience.vault;
  if (!readShareOrigin(audience, input.itemType, input.itemId)) {
    return { removed: false, orphanedShas: [] };
  }
  // Savepoint when a caller already owns the audience transaction (commons
  // scrub+re-project): stays atomic, never double-opens BEGIN.
  const nested = audience.isTransaction;
  audience.exec(nested ? "SAVEPOINT unshare_from_vault" : "BEGIN IMMEDIATE");
  let replicaCommit!: ReturnType<typeof beginReplicaCommit>;
  let shas: string[];
  try {
    replicaCommit = beginReplicaCommit(audience);
    const removal = deleteProjectedClosure(
      audience,
      input.itemType,
      input.itemId
    );
    audience
      .prepare(
        "DELETE FROM core_share_origin WHERE item_type = ? AND item_id = ?"
      )
      .run(input.itemType, input.itemId);
    shas = removal.shas;
    endReplicaCommit(audience, replicaCommit);
    audience.exec(nested ? "RELEASE unshare_from_vault" : "COMMIT");
  } catch (error) {
    audience.exec(nested ? "ROLLBACK TO unshare_from_vault" : "ROLLBACK");
    if (nested) audience.exec("RELEASE unshare_from_vault");
    throw error;
  }
  // Liveness is read AFTER the commit, so a sha another row still holds is
  // reported live rather than guessed at.
  const live = liveBlobShas(audience);
  return { removed: true, orphanedShas: shas.filter((sha) => !live.has(sha)) };
}

/**
 * Source side of a completed cross-vault MOVE. Unlike unshare this removes an
 * AUTHORED item: the caller must durably prove the target projection committed
 * first (the gateway placement ledger owns that ordering), and this stays
 * separate so no ordinary share path reaches authored deletion.
 */
export function moveOutOfVault(
  input: MoveOutOfVaultInput
): UnshareFromVaultResult {
  const source = input.source.vault;
  source.exec("BEGIN IMMEDIATE");
  let replicaCommit!: ReturnType<typeof beginReplicaCommit>;
  let shas: string[];
  try {
    replicaCommit = beginReplicaCommit(source);
    const removal = deleteProjectedClosure(
      source,
      input.itemType,
      input.itemId
    );
    source
      .prepare(
        "DELETE FROM core_share_origin WHERE item_type = ? AND item_id = ?"
      )
      .run(input.itemType, input.itemId);
    shas = removal.shas;
    endReplicaCommit(source, replicaCommit);
    source.exec("COMMIT");
    if (!removal.removed) return { removed: false, orphanedShas: [] };
  } catch (error) {
    source.exec("ROLLBACK");
    throw error;
  }
  const live = liveBlobShas(source);
  return { removed: true, orphanedShas: shas.filter((sha) => !live.has(sha)) };
}
