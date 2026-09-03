import type { DatabaseSync } from "node:sqlite";

import type { VaultDb } from "../db.js";
import { nowIso, uuidv7 } from "../ids.js";
import {
  BINARY_DERIVATIVE_SQL,
  DERIVATIVE_REGISTRY,
  isBinaryDerivative,
  isDerivativeVariant,
  validateDerivativeContribution,
} from "./derivatives.js";
import type { DerivativeVariant, ValidatedDerivative } from "./derivatives.js";
import { extractBlobMeta, sniffMediaType } from "./pipeline.js";
import { upsertContentEmbedding } from "./semantic-contributions.js";
import { sha256OfBytes } from "./store.js";

export const STAGING_TTL_HOURS = 24;

export function mediaLocationPolicyForVault(
  vault: DatabaseSync
): "keep" | "strip" {
  try {
    const row = vault
      .prepare("SELECT settings_json FROM core_vault LIMIT 1")
      .get() as { settings_json: string | null } | undefined;
    if (!row?.settings_json) return "keep";
    const parsed = JSON.parse(row.settings_json) as {
      media?: { location?: string };
    };
    return parsed.media?.location === "strip" ? "strip" : "keep";
  } catch {
    return "keep";
  }
}

export function mediaLocationPolicy(db: VaultDb): "keep" | "strip" {
  return mediaLocationPolicyForVault(db.vault);
}

export interface StageBlobOptions {
  bytes: Buffer;
  mediaType?: string;
  filename?: string;
  stagedBy?: string;
  heldByBatch?: string;
  variant?: DerivativeVariant;
  variantOf?: string;
  validateDerivative?: boolean;
}

export interface StagedBlob {
  sha256: string;
  mediaType: string;
  byteSize: number;
  meta: Record<string, unknown>;
  existingContentId: string | null;
}

export function stageBlobBytes(
  db: VaultDb,
  options: StageBlobOptions
): StagedBlob {
  if ((options.variant === undefined) !== (options.variantOf === undefined)) {
    throw new Error("variant and variant_of must be supplied together");
  }
  if (options.variant !== undefined && !isDerivativeVariant(options.variant)) {
    throw new Error("unknown derivative variant");
  }
  if (options.variantOf && !/^[0-9a-f]{64}$/u.test(options.variantOf)) {
    throw new Error("variant_of must be a lowercase sha256");
  }
  if (options.variantOf) {
    const parent = db.vault
      .prepare(
        `SELECT 1 AS present FROM blob_staging
          WHERE sha256 = ? AND variant IS NULL
         UNION ALL
        SELECT 1 AS present FROM core_content_item WHERE sha256 = ?
         LIMIT 1`
      )
      .get(options.variantOf, options.variantOf) as { present: 1 } | undefined;
    if (!parent)
      throw new Error("variant_of does not identify staged or claimed content");
  }
  let contribution: ValidatedDerivative | undefined;
  if (options.variant) {
    const spec = DERIVATIVE_REGISTRY[options.variant];
    if (spec.storage === "inline" || options.validateDerivative === true) {
      contribution = validateDerivativeContribution({
        variant: options.variant,
        bytes: options.bytes,
        ...(options.mediaType ? { mediaType: options.mediaType } : {}),
      });
    }
  }
  const binary =
    options.variant === undefined || isBinaryDerivative(options.variant);
  const ingested = binary
    ? db.blobs.ingestSync(options.bytes)
    : { sha256: sha256OfBytes(options.bytes), byteSize: options.bytes.length };
  const { sha256, byteSize } = ingested;
  const mediaType =
    contribution?.mediaType ??
    sniffMediaType(options.bytes, options.mediaType, options.filename);
  const meta = binary
    ? extractBlobMeta(options.bytes, mediaType, {
        keepLocation: mediaLocationPolicy(db) !== "strip",
      })
    : {};
  const existing = options.variant
    ? undefined
    : (db.vault
        .prepare("SELECT content_id FROM core_content_item WHERE sha256 = ?")
        .get(sha256) as { content_id: string } | undefined);
  db.vault.exec("SAVEPOINT stage_blob_bytes");
  try {
    db.vault
      .prepare(
        `INSERT INTO blob_staging (staging_id, sha256, media_type, byte_size, original_name, meta_json, staged_by, held_by_batch, variant, variant_of, inline_content, staged_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (${options.variant ? "variant_of, variant) WHERE variant IS NOT NULL" : "sha256) WHERE variant IS NULL"} DO UPDATE SET
         sha256 = excluded.sha256,
         media_type = excluded.media_type,
         byte_size = excluded.byte_size,
         original_name = COALESCE(excluded.original_name, blob_staging.original_name),
         meta_json = excluded.meta_json,
         staged_by = excluded.staged_by,
         held_by_batch = COALESCE(excluded.held_by_batch, blob_staging.held_by_batch),
         inline_content = excluded.inline_content,
         staged_at = excluded.staged_at`
      )
      .run(
        uuidv7(),
        sha256,
        mediaType,
        byteSize,
        options.filename ?? null,
        JSON.stringify(meta),
        options.stagedBy ?? null,
        options.heldByBatch ?? null,
        options.variant ?? null,
        options.variantOf ?? null,
        contribution?.textContent ?? null,
        nowIso()
      );
    if (options.variant && options.variantOf) {
      const parent = db.vault
        .prepare("SELECT content_id FROM core_content_item WHERE sha256 = ?")
        .get(options.variantOf) as { content_id: string } | undefined;
      if (parent) {
        const inline = contribution?.storage === "inline";
        db.vault
          .prepare(
            `INSERT INTO core_content_derivative
             (derivative_id, content_id, variant, sha256, media_type, byte_size, text_content, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (content_id, variant) DO UPDATE SET
             sha256 = excluded.sha256, media_type = excluded.media_type,
             byte_size = excluded.byte_size, text_content = excluded.text_content,
             created_at = excluded.created_at
           WHERE core_content_derivative.sha256 IS NOT excluded.sha256
              OR core_content_derivative.text_content IS NOT excluded.text_content
              OR core_content_derivative.media_type <> excluded.media_type`
          )
          .run(
            uuidv7(),
            parent.content_id,
            options.variant,
            inline ? null : sha256,
            mediaType,
            contribution?.byteSize ?? byteSize,
            contribution?.textContent ?? null,
            nowIso()
          );
        if (options.variant === "phash" && contribution?.textContent) {
          const assets = db.vault
            .prepare("SELECT asset_id FROM media_asset WHERE content_id = ?")
            .all(parent.content_id) as { asset_id: string }[];
          const upsertPhash = db.vault.prepare(
            `INSERT INTO media_asset_phash (asset_id, phash, computed_at) VALUES (?, ?, ?)
           ON CONFLICT (asset_id) DO UPDATE SET phash = excluded.phash,
             computed_at = excluded.computed_at WHERE media_asset_phash.phash <> excluded.phash`
          );
          for (const asset of assets) {
            upsertPhash.run(asset.asset_id, contribution.textContent, nowIso());
          }
        }
        if (options.variant === "embedding" && contribution?.textContent) {
          upsertContentEmbedding(db.vault, {
            contentId: parent.content_id,
            canonicalPayload: contribution.textContent,
            embeddingId: uuidv7(),
            createdAt: nowIso(),
          });
        }
        db.vault
          .prepare(
            "DELETE FROM blob_staging WHERE variant_of = ? AND variant = ?"
          )
          .run(options.variantOf, options.variant);
      }
    }
    db.vault.exec("RELEASE stage_blob_bytes");
  } catch (error) {
    db.vault.exec("ROLLBACK TO stage_blob_bytes");
    db.vault.exec("RELEASE stage_blob_bytes");
    throw error;
  }

  if (binary) db.blobTransfers.recordLocalReceipt(sha256, byteSize);

  return {
    sha256,
    mediaType,
    byteSize,
    meta,
    existingContentId: existing?.content_id ?? null,
  };
}

export interface StagedRow {
  sha256: string;
  media_type: string;
  byte_size: number;
  original_name: string | null;
  meta_json: string;
}

export function stagedInfoTx(
  vault: DatabaseSync,
  sha256: string
): StagedRow | null {
  const row = vault
    .prepare(
      "SELECT sha256, media_type, byte_size, original_name, meta_json FROM blob_staging WHERE sha256 = ? AND variant IS NULL"
    )
    .get(sha256) as StagedRow | undefined;
  return row ?? null;
}

export interface StagingSweepResult {
  expired: string[];
}

export function sweepBlobStaging(
  db: VaultDb,
  options: { ttlHours?: number; now?: string } = {}
): StagingSweepResult {
  const now = options.now ?? nowIso();
  const cutoff = new Date(
    Date.parse(now) - (options.ttlHours ?? STAGING_TTL_HOURS) * 3_600_000
  ).toISOString();
  const rows = db.vault
    .prepare(
      "SELECT staging_id, sha256, variant FROM blob_staging WHERE staged_at <= ? AND held_by_batch IS NULL"
    )
    .all(cutoff) as {
    staging_id: string;
    sha256: string;
    variant: DerivativeVariant | null;
  }[];
  const expired: string[] = [];
  for (const row of rows) {
    db.vault
      .prepare("DELETE FROM blob_staging WHERE staging_id = ?")
      .run(row.staging_id);
    const casBacked = row.variant === null || isBinaryDerivative(row.variant);
    const rented = casBacked
      ? (db.vault
          .prepare(
            `SELECT
               (SELECT count(*) FROM core_content_item WHERE sha256 = ?) +
               (SELECT count(*) FROM core_content_derivative WHERE sha256 = ?) +
               (SELECT count(*) FROM blob_staging
                 WHERE sha256 = ? AND (variant IS NULL OR variant IN (${BINARY_DERIVATIVE_SQL}))) AS n`
          )
          .get(row.sha256, row.sha256, row.sha256) as { n: number })
      : { n: 1 };
    if (rented.n === 0) db.blobs.deleteLocalSync(row.sha256);
    expired.push(row.sha256);
  }
  return { expired };
}

export function releaseBatchHold(vault: DatabaseSync, batchId: string): void {
  vault
    .prepare(
      "UPDATE blob_staging SET held_by_batch = NULL WHERE held_by_batch = ?"
    )
    .run(batchId);
}
