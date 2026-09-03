import type { DatabaseSync } from "node:sqlite";

import type { LocalBlobStore } from "../blob/local.js";
import { liveBlobShas } from "../blob/read.js";
import { VaultShareError } from "../errors.js";
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
  origin: ShareVaultRef;
  originVaultId: string;
  audience: ShareVaultRef;
  itemType: ShareableItemType;
  itemIds: readonly string[];
  sharedBy: string;
  now?: () => number;
  crossOwner?: boolean;
  authority?: {
    principalKind: "person" | "circle" | "harness" | "device";
    principalId: string;
    verb: string;
  };
}

export interface UnshareFromVaultInput {
  audience: ShareVaultRef;
  itemType: ShareableItemType;
  itemId: string;
}

export interface UnshareFromVaultResult {
  removed: boolean;
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
  items: ProjectedItem[];
  blobs: BlobPlacement[];
}

export function shareItemsToVault(
  input: ShareItemsToVaultInput
): ShareItemsToVaultResult {
  if (input.origin.vault === input.audience.vault) {
    throw new VaultShareError(
      "cannot share a vault into itself — sharing crosses a vault boundary"
    );
  }
  assertPlacementAuthority(input);
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

export function unshareFromVault(
  input: UnshareFromVaultInput
): UnshareFromVaultResult {
  const audience = input.audience.vault;
  const origin = readShareOrigin(audience, input.itemType, input.itemId);
  if (!origin) {
    return { removed: false, orphanedShas: [] };
  }
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
  const live = liveBlobShas(audience);
  return { removed: true, orphanedShas: shas.filter((sha) => !live.has(sha)) };
}

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
