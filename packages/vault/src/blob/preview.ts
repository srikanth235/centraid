// The preview ladder (issue #405 §2): two sealed derivative rungs beside every
// image original — a TINY ~256 px thumbnail (~20-40 KB) for the browse grid
// and a MEDIUM ~2048 px preview (~300-500 KB) for the lightbox — so the
// browse surface never touches a multi-MB original just to paint a tile.
//
// Generation is HYBRID (issue #405 §2, "gateway-as-backstop"): a capable
// client produces both rungs at capture time on free edge CPU (photos
// upload.js — its canvas is the client's raster codec), and this module is
// the GATEWAY BACKSTOP for everything a client can't reach — imported
// libraries (Takeout), weak/old clients, server-side ingestion (connectors
// and automations writing blobs). Preview generation is inside the owner's
// trust boundary: the gateway already holds plaintext on ingest, so
// downscaling there leaks nothing to the provider (the E2EE gateway↔provider
// seam is untouched — derivatives replicate as sealed CAS blobs like every
// other byte).
//
// The one gap the backstop has to close is that the vault runtime carries NO
// raster codec (packages/vault stays dependency-light — uuid only), so the
// codec is an INJECTED interface: the gateway package owns the actual
// jpeg-js/pngjs implementation (packages/gateway/src/preview) and hands it in
// via VaultDb.previewCodec. This file is the dependency-free orchestration —
// it decides WHAT is missing and stages the results through the existing
// staging/promote path (variant/variant_of), so dedup, custody and
// replication all "just work" with no new plumbing.

import type { VaultDb } from '../db.js';
import { stageBlobBytes } from './staging.js';
import { shaOfBlobUri } from './store.js';

/** Tiny rung (issue #405 §2): the browse-grid thumbnail, ~256 px long edge. */
export const TINY_EDGE = 256;
/** Medium rung (issue #405 §2): the lightbox preview, ~2048 px long edge. */
export const MEDIUM_EDGE = 2048;

/**
 * How many image items the gateway backstop processes per sweep (issue #405
 * §2: "up to a bounded batch per sweep"). Preview generation is cheap CPU
 * QoS, never a foreground duty — a large Takeout import drains a batch at a
 * time across successive hourly sweeps rather than pinning a core on mount.
 */
export const PREVIEW_BACKFILL_BATCH = 24;

/**
 * The maps tiny→`thumb` and medium→`preview` onto the existing derivative
 * variant vocabulary (schema/blob.ts already spells both), so the ladder
 * needs NO schema change — a rung is just a (variant, maxEdge) pair.
 */
export const PREVIEW_LADDER: readonly { variant: 'thumb' | 'preview'; maxEdge: number }[] = [
  { variant: 'thumb', maxEdge: TINY_EDGE },
  { variant: 'preview', maxEdge: MEDIUM_EDGE },
];

/** A downscaled raster the codec produced — bytes plus the resulting size. */
export interface PreviewOutput {
  bytes: Buffer;
  /** Always a raster type the browse surface can paint (JPEG for v0). */
  mediaType: string;
  width: number;
  height: number;
}

/**
 * The injected raster codec (issue #405 §2). Decode + downscale + re-encode
 * one image to fit within `maxEdge` on its long side, WITHOUT upscaling (a
 * source already smaller than `maxEdge` re-encodes at its native size). The
 * implementation lives in the gateway package with its npm decoders; the
 * vault layer only ever sees this interface.
 *
 * Returns `null` for anything it cannot or will not process — an unsupported
 * type (GIF/WebP/video), a corrupt decode, or an input past the codec's
 * memory cap. `null` is not an error: the browse surface's placeholder
 * contract (issue #404, media.js `gridSrc`) already covers a missing thumb,
 * so a skipped item simply renders a placeholder.
 */
export interface PreviewCodec {
  downscale(source: Buffer, mediaType: string, maxEdge: number): PreviewOutput | null;
}

/** What one backstop pass touched — folded into the sweep receipt. */
export interface PreviewBackfillResult {
  /** Image items examined this pass (bounded by the batch cap). */
  scanned: number;
  /** Variant blobs actually staged (0-2 per scanned item). */
  generated: number;
  /** Items the codec declined outright (unsupported type / decode failure). */
  skippedUnsupported: number;
  /** Items whose original bytes were absent from BOTH tiers — an integrity gap. */
  missingBytes: number;
}

/** Yield the event loop between items — preview CPU never starves live work. */
function yieldTick(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * The gateway backstop pass (issue #405 §2): find live image content items
 * missing a tiny or medium rung, generate the gap through the injected codec,
 * and stage the result via the SAME `stageBlobBytes(variant, variantOf)` path
 * a client upload uses — which, because the parent is already claimed, folds
 * the derivative straight into `core_content_derivative` (staging.ts) so it
 * dedups, gets custody and replicates with no bespoke wiring.
 *
 * Bounded (`limit`, default `PREVIEW_BACKFILL_BATCH`) and idempotent: a rung
 * that already exists is never regenerated (only genuinely-missing variants
 * are produced), so a client-supplied thumb that beat the sweep always wins —
 * the backstop only fills holes. Per-item failures are counted, never fatal:
 * one unreadable image must not sink the batch, and a codec crash must not
 * fail the custody sweep this rides along with.
 */
export async function backfillPreviews(
  db: VaultDb,
  codec: PreviewCodec,
  options: { limit?: number } = {},
): Promise<PreviewBackfillResult> {
  const limit = options.limit ?? PREVIEW_BACKFILL_BATCH;
  const result: PreviewBackfillResult = {
    scanned: 0,
    generated: 0,
    skippedUnsupported: 0,
    missingBytes: 0,
  };
  if (limit <= 0) return result;

  // Live image originals missing at least one rung. `deleted_at IS NULL`
  // keeps the backstop off trashed items (they render from what they already
  // hold until purge); the raster filter is `media_type LIKE 'image/%'` so
  // video/audio never enter (video posters are a client-only concern in v0,
  // and the gateway video backstop is deliberately out — issue #405 §2).
  const items = db.vault
    .prepare(
      `SELECT i.content_id, i.content_uri, i.media_type
         FROM core_content_item i
        WHERE i.content_uri LIKE 'blob:%'
          AND i.media_type LIKE 'image/%'
          AND i.deleted_at IS NULL
          AND (
            NOT EXISTS (SELECT 1 FROM core_content_derivative d
                         WHERE d.content_id = i.content_id AND d.variant = 'thumb'
                           AND d.sha256 IS NOT NULL)
            OR NOT EXISTS (SELECT 1 FROM core_content_derivative d
                            WHERE d.content_id = i.content_id AND d.variant = 'preview'
                              AND d.sha256 IS NOT NULL)
          )
        ORDER BY i.created_at
        LIMIT ?`,
    )
    .all(limit) as { content_id: string; content_uri: string; media_type: string }[];

  for (const item of items) {
    result.scanned += 1;
    const parentSha = shaOfBlobUri(item.content_uri);
    if (!parentSha) continue;
    try {
      // Which rungs this item still lacks — recomputed per item so a
      // client-supplied variant that landed since the outer query is honored
      // (we never overwrite an existing rung).
      const missing = PREVIEW_LADDER.filter(
        (rung) => !hasVariant(db, item.content_id, rung.variant),
      );
      if (missing.length === 0) continue;
      // Local hit first; a remote-only original reads through custody.open at
      // backfill pace (the read-through re-caches it locally as a side effect).
      const bytes = db.blobs.getSync(parentSha) ?? (await db.blobs.open(parentSha));
      if (!bytes) {
        result.missingBytes += 1;
        continue;
      }
      let unsupported = false;
      for (const rung of missing) {
        const out = codec.downscale(bytes, item.media_type, rung.maxEdge);
        if (!out) {
          // A codec that declines the tiny rung declines the medium too —
          // it's the same decode. Skip the whole item, count it once.
          unsupported = true;
          break;
        }
        stageBlobBytes(db, {
          bytes: out.bytes,
          mediaType: out.mediaType,
          variant: rung.variant,
          variantOf: parentSha,
        });
        result.generated += 1;
      }
      if (unsupported) result.skippedUnsupported += 1;
    } catch {
      // Best-effort maintenance: one unreadable image (corrupt bytes, a decode
      // that threw) is counted implicitly by producing nothing and never
      // sinks the batch or the custody sweep this pass rides along with.
    }
    await yieldTick();
  }
  return result;
}

/** Whether a content item already carries a binary rung (sha present). */
function hasVariant(db: VaultDb, contentId: string, variant: 'thumb' | 'preview'): boolean {
  const row = db.vault
    .prepare(
      `SELECT 1 FROM core_content_derivative
        WHERE content_id = ? AND variant = ? AND sha256 IS NOT NULL LIMIT 1`,
    )
    .get(contentId, variant);
  return row !== undefined;
}
