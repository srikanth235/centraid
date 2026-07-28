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
// The shape of one share:
//
//   (a) hardlink the closure's blobs from the origin CAS into the audience CAS
//       (share/blobs.ts), copying only where the filesystem refuses to link;
//   (b) ONE transaction in the AUDIENCE vault: the projected rows plus the
//       `core_share_origin` provenance record.
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
import { placeBlob } from "./blobs.js";
import type { BlobPlacement } from "./blobs.js";
import { projectShareClosure, readShareClosure } from "./closure.js";
import type { ShareableItemType } from "./closure.js";
import { deleteProjectedClosure } from "./removal.js";

/**
 * The narrow slice of an open vault a share touches: its canonical database
 * and its local CAS. `VaultDb` satisfies this structurally, so the gateway
 * passes its live handles unchanged.
 */
export interface ShareVaultRef {
  vault: DatabaseSync;
  blobs: { local: LocalBlobStore };
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
  /** The L2 member principal performing the placement. */
  sharedByMember: string;
  /** Injectable clock, epoch ms. Defaults to `Date.now`. */
  now?: () => number;
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

/** Read the provenance record for a projected row, or undefined. */
export interface ShareOriginRecord {
  itemType: string;
  itemId: string;
  originVaultId: string;
  originItemId: string;
  sharedByMember: string;
  sharedAt: number;
}

export function readShareOrigin(
  audience: DatabaseSync,
  itemType: string,
  itemId: string
): ShareOriginRecord | undefined {
  const row = audience
    .prepare(
      `SELECT origin_vault_id, origin_item_id, shared_by_member, shared_at
         FROM core_share_origin WHERE item_type = ? AND item_id = ?`
    )
    .get(itemType, itemId) as
    | {
        origin_vault_id: string;
        origin_item_id: string;
        shared_by_member: string;
        shared_at: number;
      }
    | undefined;
  if (!row) return undefined;
  return {
    itemType,
    itemId,
    originVaultId: row.origin_vault_id,
    originItemId: row.origin_item_id,
    sharedByMember: row.shared_by_member,
    sharedAt: row.shared_at,
  };
}

/**
 * Project one item from `origin` into `audience`, hardlinking its bytes.
 *
 * Idempotent: re-sharing the same item — including by a DIFFERENT member —
 * dedupes onto the existing row (`core_content_item.sha256` is UNIQUE) and
 * keeps the first placement record. One row, no duplicate, no error.
 */
export function shareToVault(input: ShareToVaultInput): ShareToVaultResult {
  if (input.origin.vault === input.audience.vault) {
    throw new VaultShareError(
      "cannot share a vault into itself — sharing crosses a vault boundary"
    );
  }
  // Resolve everything out of the origin BEFORE touching the audience, so an
  // unknown item is refused with nothing placed anywhere.
  const closure = readShareClosure(
    input.origin.vault,
    input.itemType,
    input.itemId
  );

  // (a) Bytes first — a link is idempotent, and a failure after this point
  // leaves at most an orphaned link the audience's own sweep reclaims.
  const blobs: BlobPlacement[] = closure.shas.map((sha256) => ({
    sha256,
    mode: placeBlob(
      input.origin.blobs.local,
      input.audience.blobs.local,
      sha256
    ),
  }));

  // (b) One transaction, audience vault only.
  const audience = input.audience.vault;
  audience.exec("BEGIN IMMEDIATE");
  try {
    const projection = projectShareClosure(audience, closure);
    audience
      .prepare(
        `INSERT INTO core_share_origin
           (item_type, item_id, origin_vault_id, origin_item_id, shared_by_member, shared_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (item_type, item_id) DO NOTHING`
      )
      .run(
        input.itemType,
        projection.itemId,
        input.originVaultId,
        closure.itemId,
        input.sharedByMember,
        (input.now ?? Date.now)()
      );
    audience.exec("COMMIT");
    return {
      itemType: input.itemType,
      itemId: projection.itemId,
      deduped: projection.deduped,
      blobs,
    };
  } catch (error) {
    // Roll the audience back to exactly where it was — the origin was never
    // written, so the whole share is undone bar the orphaned link above.
    audience.exec("ROLLBACK");
    throw error;
  }
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
  let shas: string[];
  try {
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
