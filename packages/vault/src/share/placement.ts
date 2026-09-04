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
import { LIVE_AUTHORITY_SQL } from "../grant/grant-store.js";
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
  /**
   * The AUTHORITY this placement runs under (#916, adversarial review WEAK).
   * `shareItemsToVault` is a library export and was gated on NOTHING: any
   * caller holding both vault handles could place rows in someone else's vault
   * without an answer standing anywhere.
   *
   * Every item must carry a LIVE, granted `share_authority` before a byte
   * lands. Naming the principal narrows that to "and it is THIS one's" — which
   * a caller that resolved an audience can say and a fan-out over a circle
   * cannot, so it is optional and never a way to widen.
   */
  authority?: {
    principalKind: "person" | "circle" | "harness" | "device";
    principalId: string;
    verb: string;
  };
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

/**
 * A LIVE answer over every item, in the origin, before anything is placed
 * (#916). "The audience already has it" must never be how a share happens.
 */
function assertPlacementAuthority(input: ShareItemsToVaultInput): void {
  const named = input.authority;
  const stands = input.origin.vault.prepare(
    `SELECT count(*) AS n FROM share_authority
      WHERE subject_type = ? AND subject_id = ?
        AND decision = 'granted' AND ${LIVE_AUTHORITY_SQL}
        AND (? IS NULL OR (principal_kind = ? AND principal_id = ? AND verb = ?))`
  );
  for (const itemId of input.itemIds) {
    const row = stands.get(
      input.itemType,
      itemId,
      named ? 1 : null,
      named?.principalKind ?? null,
      named?.principalId ?? null,
      named?.verb ?? null
    ) as { n: number };
    if (row.n === 0)
      throw new VaultShareError(
        named
          ? `no live share authority lets ${named.principalKind} ${named.principalId} ${named.verb} ${input.itemType} ${itemId}`
          : `no live share authority stands over ${input.itemType} ${itemId}: a placement carries what the member agreed to, never the caller's word for it`
      );
  }
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
  assertPlacementAuthority(input);
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
        "DELETE FROM core_share_origin WHERE target_type = ? AND target_id = ?"
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
