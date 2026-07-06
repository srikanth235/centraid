// Blob staging (issue #296 §3): raw bytes arriving is NOT a vault write —
// the command that claims them is. Both ingress doors (the HTTP upload route
// and the import spine's stageBlobFromFile) land here: hash into the local
// CAS, run the spool pipeline (sniff/EXIF/text), record a `blob_staging`
// row. No receipt, no content item, invisible to the ontology. A command
// (core.attach / core.add_document / media.add_asset) later promotes the
// staged sha into a `core_content_item` in-transaction and mints the
// receipt; unclaimed rows sweep after a TTL.

import type { DatabaseSync } from 'node:sqlite';
import type { VaultDb } from '../db.js';
import { nowIso, uuidv7 } from '../ids.js';
import { extractBlobMeta, sniffMediaType } from './pipeline.js';
import { blobUriFor } from './store.js';

/** Staged bytes linger this long before the sweep reclaims them. */
export const STAGING_TTL_HOURS = 24;

/** The `media.location` vault setting: `keep` (default) or `strip`. */
export function mediaLocationPolicy(db: VaultDb): 'keep' | 'strip' {
  try {
    const row = db.vault.prepare('SELECT settings_json FROM core_vault LIMIT 1').get() as
      | { settings_json: string | null }
      | undefined;
    if (!row?.settings_json) return 'keep';
    const parsed = JSON.parse(row.settings_json) as { media?: { location?: string } };
    return parsed.media?.location === 'strip' ? 'strip' : 'keep';
  } catch {
    return 'keep';
  }
}

export interface StageBlobOptions {
  bytes: Buffer;
  /** Caller-declared type — a hint; content sniffing wins when it knows. */
  mediaType?: string;
  /** Original filename, kept for the claim's default title. */
  filename?: string;
  /** Row id of whoever staged (device/app/agent) — audit color, not consent. */
  stagedBy?: string;
  /** Pin past the TTL while an import draft batch references these bytes. */
  heldByBatch?: string;
  /** Stage as a derivative of `variantOf` — claimed alongside its parent. */
  variant?: 'thumb' | 'preview';
  variantOf?: string;
}

export interface StagedBlob {
  sha256: string;
  mediaType: string;
  byteSize: number;
  /** Extracted spool metadata (dimensions, captured_at, text presence…). */
  meta: Record<string, unknown>;
  /** A live content item already owns these bytes — attach by content_id. */
  existingContentId: string | null;
}

/**
 * The one ingress everything uses: hash raw bytes into the local CAS, sniff
 * the real media type, extract spool metadata, upsert the staging row.
 * Synchronous by design — the local tier is the spool, remote replication is
 * a sweep — so the import spine can call it mid-parse.
 */
export function stageBlobBytes(db: VaultDb, options: StageBlobOptions): StagedBlob {
  const { sha256, byteSize } = db.blobs.ingestSync(options.bytes);
  const mediaType = sniffMediaType(options.bytes, options.mediaType, options.filename);
  // GPS policy gates HERE (issue #296 §4): `media.location = 'strip'` means
  // extraction never writes coordinates anywhere downstream.
  const meta = extractBlobMeta(options.bytes, mediaType, {
    keepLocation: mediaLocationPolicy(db) !== 'strip',
  });
  const existing = db.vault
    .prepare('SELECT content_id FROM core_content_item WHERE sha256 = ?')
    .get(sha256) as { content_id: string } | undefined;
  db.vault
    .prepare(
      `INSERT INTO blob_staging (sha256, media_type, byte_size, original_name, meta_json, staged_by, held_by_batch, variant, variant_of, staged_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (sha256) DO UPDATE SET
         media_type = excluded.media_type,
         original_name = COALESCE(excluded.original_name, blob_staging.original_name),
         meta_json = excluded.meta_json,
         staged_by = excluded.staged_by,
         held_by_batch = COALESCE(excluded.held_by_batch, blob_staging.held_by_batch),
         variant = COALESCE(excluded.variant, blob_staging.variant),
         variant_of = COALESCE(excluded.variant_of, blob_staging.variant_of),
         staged_at = excluded.staged_at`,
    )
    .run(
      sha256,
      mediaType,
      byteSize,
      options.filename ?? null,
      JSON.stringify(meta),
      options.stagedBy ?? null,
      options.heldByBatch ?? null,
      options.variant ?? null,
      options.variantOf ?? null,
      nowIso(),
    );
  // A derivative arriving AFTER its parent was already claimed (a slow
  // thumb upload racing the claim) registers immediately — otherwise it
  // would sit unclaimed until the TTL reaped it.
  if (options.variant && options.variantOf) {
    const parent = db.vault
      .prepare('SELECT content_id FROM core_content_item WHERE sha256 = ?')
      .get(options.variantOf) as { content_id: string } | undefined;
    if (parent) {
      db.vault
        .prepare(
          `INSERT INTO core_content_derivative
             (derivative_id, content_id, variant, sha256, media_type, byte_size, text_content, created_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
           ON CONFLICT (content_id, variant) DO UPDATE SET
             sha256 = excluded.sha256, media_type = excluded.media_type,
             byte_size = excluded.byte_size, created_at = excluded.created_at`,
        )
        .run(uuidv7(), parent.content_id, options.variant, sha256, mediaType, byteSize, nowIso());
      db.vault.prepare('DELETE FROM blob_staging WHERE sha256 = ?').run(sha256);
    }
  }

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

/** The staging row a command is about to claim, or null. */
export function stagedInfoTx(vault: DatabaseSync, sha256: string): StagedRow | null {
  const row = vault
    .prepare(
      'SELECT sha256, media_type, byte_size, original_name, meta_json FROM blob_staging WHERE sha256 = ?',
    )
    .get(sha256) as StagedRow | undefined;
  return row ?? null;
}

/**
 * Claim staged bytes inside a command's transaction: the staging row goes,
 * the caller writes the content item. blob_staging lives in vault.db, so a
 * rolled-back command leaves the stage intact.
 */
export function claimStagedTx(vault: DatabaseSync, sha256: string): void {
  vault.prepare('DELETE FROM blob_staging WHERE sha256 = ?').run(sha256);
}

/** `content_uri` a claimed sha gets — exported for the command handlers. */
export function stagedContentUri(sha256: string): string {
  return blobUriFor(sha256);
}

export interface StagingSweepResult {
  /** Staging rows past the TTL — rows dropped, unrented bytes reclaimed. */
  expired: string[];
}

/**
 * The staging TTL sweep: unclaimed, unheld rows past the TTL drop, and their
 * bytes leave the local CAS unless a content item independently owns the
 * same sha (dedup: claiming bytes elsewhere must survive a stale stage).
 */
export function sweepBlobStaging(
  db: VaultDb,
  options: { ttlHours?: number; now?: string } = {},
): StagingSweepResult {
  const now = options.now ?? nowIso();
  const cutoff = new Date(
    Date.parse(now) - (options.ttlHours ?? STAGING_TTL_HOURS) * 3_600_000,
  ).toISOString();
  const rows = db.vault
    .prepare('SELECT sha256 FROM blob_staging WHERE staged_at <= ? AND held_by_batch IS NULL')
    .all(cutoff) as { sha256: string }[];
  const expired: string[] = [];
  for (const row of rows) {
    db.vault.prepare('DELETE FROM blob_staging WHERE sha256 = ?').run(row.sha256);
    const owned = db.vault
      .prepare('SELECT count(*) AS n FROM core_content_item WHERE sha256 = ?')
      .get(row.sha256) as { n: number };
    if (owned.n === 0) db.blobs.deleteLocalSync(row.sha256);
    expired.push(row.sha256);
  }
  return { expired };
}

/** Release an import batch's hold (publish or discard) — TTL resumes. */
export function releaseBatchHold(vault: DatabaseSync, batchId: string): void {
  vault
    .prepare('UPDATE blob_staging SET held_by_batch = NULL WHERE held_by_batch = ?')
    .run(batchId);
}
