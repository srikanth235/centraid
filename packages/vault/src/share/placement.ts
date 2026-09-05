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
import { grantPlacementAuthority } from "../grant/grant-authority.js";
import { LIVE_AUTHORITY_SQL } from "../grant/grant-store.js";
import { beginReplicaCommit, endReplicaCommit } from "../replica/change-log.js";
import { placeBlob } from "./blobs.js";
import type { BlobPlacement } from "./blobs.js";
import {
  isShareableItemType,
  shareableItemTypeOfEntity,
  shareOriginEntityType,
} from "./closure.js";
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

export interface MoveItemsOutOfVaultInput {
  source: ShareVaultRef;
  itemType: ShareableItemType;
  /** The whole set leaves in ONE transaction — a half-moved album is not a state. */
  itemIds: readonly string[];
}

export interface PlaceItemsInVaultInput extends Omit<
  ShareItemsToVaultInput,
  "authority"
> {
  /** `move` releases the source after the projection commits. */
  kind: "add" | "move";
  /** The audience vault's own party — the principal the placement runs as. */
  audiencePartyId: string;
  grantedAt?: string;
}

export interface PlaceItemsInVaultResult extends ShareItemsToVaultResult {
  /** Ids of the projected rows in the AUDIENCE vault. */
  targetItemIds: string[];
  /** Non-empty only for a move: bytes the source no longer references. */
  orphanedShas: string[];
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
         FROM core_share_origin WHERE target_type = ? AND target_id = ?`
    )
    .get(
      isShareableItemType(itemType)
        ? shareOriginEntityType(itemType)
        : itemType,
      itemId
    ) as
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
 * Refuses to touch a row the audience AUTHORED (no `core_share_origin`
 * record): unshare removes placements, never someone's own data.
 */
export function unshareFromVault(
  input: UnshareFromVaultInput
): UnshareFromVaultResult {
  const audience = input.audience.vault;
  const origin = readShareOrigin(audience, input.itemType, input.itemId);
  if (!origin) {
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
    const collected = new Set(removal.shas);
    audience
      .prepare(
        "DELETE FROM core_share_origin WHERE target_type = ? AND target_id = ?"
      )
      .run(shareOriginEntityType(input.itemType), input.itemId);
    // THE SHARE'S OWN MEMBERSHIP, NOT THE VAULT'S (#916, adversarial BUG-9).
    // Removal walked LIVE membership — the album's collection entries — so an
    // audience who trashed a projected photograph (which removes its entry)
    // left removal nothing to find: the album went, and the asset and its
    // bytes stayed behind to be restored afterwards. Every row a projection
    // wrote carries a `core_share_origin` row now, so what the closure walk
    // could not reach is swept here, from the SAME share, and only while it is
    // reachable from nothing else in this vault.
    for (const row of strandedProjections(audience, origin)) {
      const itemType = shareableItemTypeOfEntity(row.target_type);
      if (!itemType) continue;
      const swept = deleteProjectedClosure(audience, itemType, row.target_id);
      if (!swept.removed) continue;
      for (const sha of swept.shas) collected.add(sha);
      audience
        .prepare(
          "DELETE FROM core_share_origin WHERE target_type = ? AND target_id = ?"
        )
        .run(row.target_type, row.target_id);
    }
    shas = [...collected];
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
 * Rows this share placed that nothing in the audience vault still reaches: not
 * filed in a live collection, not the current content of a live document, not
 * the bytes behind a live asset. A projected row the audience detached from
 * its container is exactly this, and is what the live-membership walk missed.
 */
function strandedProjections(
  audience: DatabaseSync,
  origin: ShareOriginRecord
): { target_type: string; target_id: string }[] {
  return audience
    .prepare(
      `SELECT o.target_type, o.target_id FROM core_share_origin o
        WHERE o.origin_vault_id = ? AND o.shared_by = ?
          AND o.target_type IN ('media.asset','core.document','core.content_item')
          AND NOT EXISTS (
            SELECT 1 FROM core_collection_entry e
             WHERE e.target_type = o.target_type AND e.target_id = o.target_id)
          AND NOT EXISTS (
            SELECT 1 FROM core_document d
             WHERE o.target_type = 'core.content_item'
               AND d.current_content_id = o.target_id)
          AND NOT EXISTS (
            SELECT 1 FROM media_asset a
             WHERE o.target_type = 'core.content_item'
               AND a.content_id = o.target_id)`
    )
    .all(origin.originVaultId, origin.sharedBy) as {
    target_type: string;
    target_id: string;
  }[];
}

/**
 * Source side of a completed cross-vault MOVE. Unlike unshare this removes
 * AUTHORED items: the caller must durably prove the target projection
 * committed first, and this stays separate so no ordinary share path reaches
 * authored deletion. The whole SET leaves in one transaction (#928 A7) —
 * moving an album is one act, and a crash between two of its photographs is
 * not a state anything downstream knows how to resume from.
 */
export function moveItemsOutOfVault(
  input: MoveItemsOutOfVaultInput
): UnshareFromVaultResult {
  const source = input.source.vault;
  source.exec("BEGIN IMMEDIATE");
  let replicaCommit!: ReturnType<typeof beginReplicaCommit>;
  const shas: string[] = [];
  let removedAny = false;
  try {
    replicaCommit = beginReplicaCommit(source);
    const forget = source.prepare(
      "DELETE FROM core_share_origin WHERE target_type = ? AND target_id = ?"
    );
    for (const itemId of input.itemIds) {
      const removal = deleteProjectedClosure(source, input.itemType, itemId);
      forget.run(input.itemType, itemId);
      for (const sha of removal.shas) shas.push(sha);
      if (removal.removed) removedAny = true;
    }
    endReplicaCommit(source, replicaCommit);
    source.exec("COMMIT");
  } catch (error) {
    source.exec("ROLLBACK");
    throw error;
  }
  if (!removedAny) return { removed: false, orphanedShas: [] };
  const live = liveBlobShas(source);
  return { removed: true, orphanedShas: shas.filter((sha) => !live.has(sha)) };
}

/**
 * SAME-OWNER PLACEMENT, AS ONE CALL (#928 A7). The give plane's edge rows,
 * effect outbox, reducer and retry sweep are gone: a placement between two of
 * the owner's own vaults is not a distributed obligation, it is a projection
 * followed by a release, and both vaults are open in the same process.
 *
 * The order is the crash invariant and does not change: record the owner's
 * agreement in the ORIGIN, project into the AUDIENCE (its own transaction),
 * and only then release the source (one more). A crash between the two leaves
 * the item in both vaults — visible, recoverable, and never lost — which is
 * why the projection commits first.
 */
export function placeItemsInVault(
  input: PlaceItemsInVaultInput
): PlaceItemsInVaultResult {
  // The placement gate demands a live answer over every item, naming the
  // party the rows are placed FOR; the owner's act IS that answer.
  grantPlacementAuthority(input.origin.vault, {
    itemType: input.itemType,
    itemIds: input.itemIds,
    audiencePartyId: input.audiencePartyId,
    grantedAt: input.grantedAt ?? new Date().toISOString(),
  });
  const projected = shareItemsToVault({
    ...input,
    authority: {
      principalKind: "person",
      principalId: input.audiencePartyId,
      verb: "view",
    },
  });
  const released =
    input.kind === "move"
      ? moveItemsOutOfVault({
          source: input.origin,
          itemType: input.itemType,
          itemIds: input.itemIds,
        })
      : { removed: false, orphanedShas: [] };
  return {
    ...projected,
    targetItemIds: projected.items.map((item) => item.itemId),
    orphanedShas: released.orphanedShas,
  };
}
