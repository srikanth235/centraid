// Share-by-placement (issue #599 decision 11) — the vault-side mechanism the
// gateway's cross-vault share plane calls.
//
// The standing product promise is that *no one can ever query your vault —
// what others see is only what you placed where they are*. So sharing is
// PLACEMENT, not filtering: an item is projected into the audience vault (a
// vault IS the audience — Family, Partner-only) and its bytes are hardlinked
// into that vault's CAS. There are no row-level ACLs anywhere; the vault
// boundary is the isolation.
//
// The shape of one share — the LOCAL COMPOSITION of the two halves the split
// in issue #726 made independent (read-closure.ts / project-closure.ts):
//
//   (a) read the closure out of the origin (read-only, no transaction there);
//   (b) hardlink its blobs from the origin CAS into the audience CAS
//       (share/blobs.ts), copying only where the filesystem refuses to link;
//   (c) ONE transaction in the AUDIENCE vault: the projected rows, the
//       `core_share_origin` provenance record, and the audience's own ingest
//       re-registration of what arrived.
//
// Byte custody is the half that does NOT generalise to a wire: a hardlink
// needs both CAS directories on one filesystem. P3's tunnel replaces (b) and
// leaves (a) and (c) exactly as they are.
//
// The origin vault is never written — sharing needs only READ there — so there
// is no two-database transaction and no new recovery machinery. Blobs go
// first because a link is idempotent; a failure between (a) and (b) leaves at
// most an orphaned link that the audience vault's own orphan-grace sweep
// already reclaims.
//
// Permissions are the caller's (gateway) business and introduce nothing new:
// placing INTO a vault is a write to it, so it needs `write` there; the origin
// needs only your own read access.
//
// This module deliberately sits OUTSIDE the per-vault AsyncLocalStorage
// handler path: a share spans two vault scopes, so it belongs beside that
// path, not inside it.

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

/**
 * The narrow slice of an open vault a share touches: its canonical database
 * and its local CAS. `VaultDb` satisfies this structurally, so the gateway
 * passes its live handles unchanged.
 */
export interface ShareVaultRef {
  vault: DatabaseSync;
  blobs: { local: LocalBlobStore };
  /** Per-vault DEK used only to re-seal a shared Locker item for its audience. */
  sealKey?: Buffer;
  /** Optional vault signing seed used to authenticate commons member intents. */
  identitySeed?: Buffer;
}

export interface ShareToVaultInput {
  /** The vault the item lives in. READ-ONLY throughout this flow. */
  origin: ShareVaultRef;
  /** Gateway id of the origin vault, recorded as provenance in the audience. */
  originVaultId: string;
  /** The vault the item is placed into — the only vault written. */
  audience: ShareVaultRef;
  /** Logical entity name of the item being shared. */
  itemType: ShareableItemType;
  /** The item's row id in the ORIGIN vault. */
  itemId: string;
  /**
   * Written into `core_share_origin.shared_by` (issue #726 Finding 6 — the
   * household L2 member-principal layer this field name once implied is
   * gone). An owner id for a co-hosted edge, or a `peer:<vaultId>` string
   * naming the remote vault a give arrived from — an attribution, not a
   * principal this vault can look up.
   */
  sharedBy: string;
  /** Injectable clock, epoch ms. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * True when the audience is not this owner's own vault (#726 P3 threat 8) —
   * forwarded to `readShareClosure`, which gates the origin's `media.location`
   * policy against `exif_json` on that basis. Defaults false: the placement
   * plane's callers are same-owner by construction (ownership already gates
   * that route), so only the cross-vault edge plane opts in.
   */
  crossOwner?: boolean;
}

export interface ShareToVaultResult {
  itemType: ShareableItemType;
  /** The projection's row id in the AUDIENCE vault. */
  itemId: string;
  /** True when the audience vault already held this item — an idempotent re-share. */
  deduped: boolean;
  /** Every content address the closure needed, and how it got there. */
  blobs: BlobPlacement[];
}

export interface UnshareFromVaultInput {
  /** The vault the projection lives in — the only vault written. */
  audience: ShareVaultRef;
  itemType: ShareableItemType;
  /** The projection's row id in the AUDIENCE vault. */
  itemId: string;
}

export interface UnshareFromVaultResult {
  /** False when there was no projection to remove. */
  removed: boolean;
  /**
   * Content addresses the audience vault no longer claims. Its own orphan
   * sweep unlinks them on schedule; the inode survives until the LAST vault
   * lets go, so the origin's bytes stay readable throughout.
   */
  orphanedShas: string[];
}

export interface MoveOutOfVaultInput {
  source: ShareVaultRef;
  itemType: ShareableItemType;
  itemId: string;
}

/** Read the provenance record for a projected row, or undefined. */
export interface ShareOriginRecord {
  itemType: string;
  itemId: string;
  originVaultId: string;
  originItemId: string;
  /** `core_share_origin.shared_by` — an owner id, or a `peer:<vaultId>`
   *  attribution. See `ShareToVaultInput.sharedBy`'s doc comment. */
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

export interface ShareItemsToVaultInput extends Omit<
  ShareToVaultInput,
  "itemId"
> {
  /** The items' row ids in the ORIGIN vault. One closure covers the set. */
  itemIds: readonly string[];
}

export interface ShareItemsToVaultResult {
  itemType: ShareableItemType;
  /** One entry per requested id, in the order asked for. */
  items: ProjectedItem[];
  /** Every content address the closure needed, and how it got there. */
  blobs: BlobPlacement[];
}

/**
 * Place a SET of items from `origin` into `audience` as one share: one
 * closure, one blob pass, one audience transaction. Rows shared between the
 * items (the bytes two photographs deduped onto, an album cover that is also
 * an entry) cross exactly once.
 *
 * Idempotent: re-sharing the same items — including by a DIFFERENT member —
 * dedupes onto the existing rows (`core_content_item.sha256` is UNIQUE) and
 * keeps the first placement record. One row, no duplicate, no error.
 */
export function shareItemsToVault(
  input: ShareItemsToVaultInput
): ShareItemsToVaultResult {
  if (input.origin.vault === input.audience.vault) {
    throw new VaultShareError(
      "cannot share a vault into itself — sharing crosses a vault boundary"
    );
  }
  // Resolve everything out of the origin BEFORE touching the audience, so an
  // unknown item is refused with nothing placed anywhere.
  const closure = readShareClosure(input.origin.vault, {
    originVaultId: input.originVaultId,
    itemType: input.itemType,
    itemIds: input.itemIds,
    crossOwner: input.crossOwner === true,
  });

  // (a) Bytes first — a link is idempotent, and a failure after this point
  // leaves at most an orphaned link the audience's own sweep reclaims.
  const blobs: BlobPlacement[] = closure.blobs.map((entry) => ({
    sha256: entry.sha256,
    mode: placeBlob(
      input.origin.blobs.local,
      input.audience.blobs.local,
      entry.sha256
    ),
  }));

  // (b) One transaction, audience vault only.
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
 * Place ONE item — the local composition of `readShareClosure` and
 * `projectShareClosure`, and the call the gateway's placement plane makes.
 */
export function shareToVault(input: ShareToVaultInput): ShareToVaultResult {
  const { itemId, ...rest } = input;
  const shared = shareItemsToVault({ ...rest, itemIds: [itemId] });
  const item = shared.items[0]!;
  return {
    itemType: input.itemType,
    itemId: item.itemId,
    deduped: item.deduped,
    blobs: shared.blobs,
  };
}

/**
 * Remove a projection from the audience vault. The origin row and its bytes
 * remain readable in the owner's vault, and re-sharing later is idempotent
 * again.
 *
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
  audience.exec("BEGIN IMMEDIATE");
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
    audience.exec("COMMIT");
  } catch (error) {
    audience.exec("ROLLBACK");
    throw error;
  }
  // Which of those addresses the vault no longer claims — read from the live
  // model AFTER the commit, so a sha some other row still holds is honestly
  // reported as still-live rather than guessed at.
  const live = liveBlobShas(audience);
  return { removed: true, orphanedShas: shas.filter((sha) => !live.has(sha)) };
}

/**
 * Remove the source side of a completed cross-vault MOVE.
 *
 * Unlike unshare this may remove an authored item. The caller must durably
 * prove that the target projection committed first; the gateway placement
 * ledger owns that ordering and replay. Kept explicit so no ordinary share
 * path can accidentally invoke authored deletion.
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
