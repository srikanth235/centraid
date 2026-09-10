// The preview ladder (#405): two sealed derivative rungs beside every image
// original. A capable client makes both at capture time; this is the GATEWAY
// BACKSTOP for what a client cannot reach. The vault carries NO raster codec,
// so it is INJECTED via `VaultDb.previewCodec`; results stage through the
// existing ingest/promote path, so dedup and replication need no new plumbing.

import { BLOB_MEDIUM_EDGE, BLOB_TINY_EDGE } from "@centraid/core/blob";

import type { VaultDb } from "../db.js";
import { nowIso } from "../ids.js";
import { contentMediaTypeSql } from "../schema/representation.js";
import {
  clearPreviewUnsupportedFor,
  hasDisplayRung,
  markPreviewUnsupportedFor,
  previewUnsupportedMarkerFor,
  PREVIEW_CODEC_MODEL_ID,
  PREVIEW_STATUS_CAPABILITY,
  PREVIEW_STATUS_VARIANT,
} from "./preview-status.js";
import type { PreviewUnsupportedMarker } from "./preview-status.js";
import { stageBlobBytes } from "./staging.js";
import { shaOfBlobUri } from "./store.js";

export const TINY_EDGE = BLOB_TINY_EDGE;
export const MEDIUM_EDGE = BLOB_MEDIUM_EDGE;

/** Cheap CPU QoS, never foreground: one batch per sweep (#405). */
export const PREVIEW_BACKFILL_BATCH = 24;
export const INGRESS_PREVIEW_MAX_BYTES = 32 * 1024 * 1024;

export const PREVIEW_LADDER: readonly {
  variant: "thumb" | "preview";
  maxEdge: number;
}[] = [
  { variant: "thumb", maxEdge: TINY_EDGE },
  { variant: "preview", maxEdge: MEDIUM_EDGE },
];

// ---------------------------------------------------------------------------
// "This original has no preview and never will" — the durable decline (#1011).
//
// A codec DECLINE and a rung that has NOT LANDED YET look identical from the
// read side: `ctx.vault.content({variant:"preview"})` answers `no-variant` for
// both. Every recognition recipe reads that as "come back later" and PARKS its
// cursor before the asset, so one undecodable original stopped the ambient walk
// of the whole library, permanently. The fix belongs in the derived ledger, not
// in three recipes: when the codec declines an original outright — no thumb, no
// preview, no phash, no thumbhash — the vault RECORDS that, and a recipe reads
// the record instead of guessing.
//
// The record is an `enrich_derivation` stamp, the ledger's existing provenance
// row: target `core.content_item` × this content, variant `preview`, capability
// `previews`, and a model id naming the CODEC VERSION that declined. That is
// the whole of the version keying: `stampDerivation` upserts on
// (target, variant, profile), the backfill skips only items already marked at
// the CURRENT version, and bumping `PREVIEW_CODEC_VERSION` (HEIC support
// arriving is exactly such a bump) makes every marker stale, so the backstop
// re-evaluates the library without any migration. A rung that later succeeds
// clears the marker in the same pass that produced it.
//
// Deliberately NOT a new `core_content_derivative` variant: that column's CHECK
// is enumerated in three tables, and a stamp already carries the two things the
// marker needs — a version-keyed model id and a delete that cascades with the
// content row.

// The marker's own storage lives in `preview-status.ts` (no module cycle with
// `staging.ts`, which must clear it when a CLIENT rung lands); re-exported here
// so this module stays the one place the ladder is read from.
export {
  PREVIEW_CODEC_VERSION,
  PREVIEW_CODEC_NAME,
  PREVIEW_CODEC_MODEL_ID,
  PREVIEW_STATUS_VARIANT,
  PREVIEW_STATUS_CAPABILITY,
  hasDisplayRung,
} from "./preview-status.js";
export type { PreviewUnsupportedMarker } from "./preview-status.js";

/** How long the ingress contributor waits for the claim that gives an original
 *  its content row. The marker hangs off the CONTENT, and a blob nobody claims
 *  is not content — so an unclaimed sha needs no marker at all. */
const CLAIM_WAIT_ATTEMPTS = 20;
const CLAIM_WAIT_MS = 50;

function contentIdForSha(db: VaultDb, sha256: string): string | undefined {
  const row = db.vault
    .prepare(
      "SELECT content_id FROM core_content_item WHERE sha256 = ? AND deleted_at IS NULL LIMIT 1"
    )
    .get(sha256) as { content_id: string } | undefined;
  return row?.content_id;
}

export function previewUnsupportedMarker(
  db: VaultDb,
  contentId: string
): PreviewUnsupportedMarker | null {
  return previewUnsupportedMarkerFor(db.vault, contentId);
}

export function markPreviewUnsupported(
  db: VaultDb,
  contentId: string,
  now?: string
): void {
  markPreviewUnsupportedFor(db.vault, contentId, now);
}

/**
 * Settle one pass's verdict. THE CODEC IS NOT THE ONLY PRODUCER (#1011): the
 * phone decodes the HEVC-coded HEIC sharp's libheif cannot and contributes JPEG
 * rungs through the variant door on its own schedule. So "this codec declined"
 * only becomes "this content has no preview" when the row carries no display
 * rung at all — otherwise the decline is stale news and the marker is retired.
 */
function settlePreviewVerdict(
  db: VaultDb,
  contentId: string,
  declined: boolean,
  now?: string
): void {
  if (declined && !hasDisplayRung(db.vault, contentId)) {
    markPreviewUnsupportedFor(db.vault, contentId, now);
    return;
  }
  clearPreviewUnsupportedFor(db.vault, contentId);
}

export function clearPreviewUnsupported(db: VaultDb, contentId: string): void {
  clearPreviewUnsupportedFor(db.vault, contentId);
}

export interface PreviewOutput {
  bytes: Buffer;
  mediaType: string;
  width: number;
  height: number;
}

/**
 * Fit one image within `maxEdge` on its long side, never UPSCALING. `null` is a
 * refusal, not an error: the item renders its placeholder (#404).
 */
export interface PreviewCodec {
  downscale: (
    source: Buffer,
    mediaType: string,
    maxEdge: number
  ) => PreviewOutput | null | Promise<PreviewOutput | null>;
  perceptualHash: (
    source: Buffer,
    mediaType: string
  ) => string | null | Promise<string | null>;
  thumbhash: (
    source: Buffer,
    mediaType: string
  ) => string | null | Promise<string | null>;
}

export interface PreviewBackfillResult {
  scanned: number;
  generated: number;
  phashesGenerated: number;
  thumbhashesGenerated: number;
  /** The codec declined the item. */
  skippedUnsupported: number;
  /** Absent from BOTH tiers — an integrity gap. */
  missingBytes: number;
}

interface PreviewBackfillItem {
  content_id: string;
  media_type: string;
}

async function stageMissingPreviewRungs(
  db: VaultDb,
  codec: PreviewCodec,
  item: PreviewBackfillItem,
  bytes: Buffer,
  parentSha: string,
  missing: readonly (typeof PREVIEW_LADDER)[number][],
  result: PreviewBackfillResult,
  rungIndex = 0
): Promise<boolean> {
  const rung = missing[rungIndex];
  if (!rung) return false;
  const out = await codec.downscale(bytes, item.media_type, rung.maxEdge);
  if (!out) return true;
  stageBlobBytes(db, {
    bytes: out.bytes,
    mediaType: out.mediaType,
    variant: rung.variant,
    variantOf: parentSha,
  });
  result.generated += 1;
  return stageMissingPreviewRungs(
    db,
    codec,
    item,
    bytes,
    parentSha,
    missing,
    result,
    rungIndex + 1
  );
}

export interface IngressPreviewInput {
  sha256: string;
  bytes: Buffer;
  mediaType: string;
  stagedBy?: string;
}

export async function contributeIngressPreviews(
  db: VaultDb,
  codec: PreviewCodec,
  input: IngressPreviewInput
): Promise<number> {
  if (
    !input.mediaType.startsWith("image/") ||
    input.bytes.length === 0 ||
    input.bytes.length > INGRESS_PREVIEW_MAX_BYTES
  ) {
    // NOT a codec decline: an oversized or non-raster original is out of this
    // door's bounds, and the sweep still owns it. Marking here would tell every
    // recipe to skip content the backstop can still serve.
    return 0;
  }
  let generated = 0;
  // The tiny rung's decode is the medium rung's decode, so declining it is the
  // codec declining THE ORIGINAL — the fact the marker below records.
  let declined = false;
  async function stageNextRung(index: number): Promise<void> {
    const rung = PREVIEW_LADDER[index];
    if (!rung) return;
    const output = await codec.downscale(
      input.bytes,
      input.mediaType,
      rung.maxEdge
    );
    if (!output) {
      if (index === 0) declined = true;
      return;
    }
    stageBlobBytes(db, {
      bytes: output.bytes,
      mediaType: output.mediaType,
      variant: rung.variant,
      variantOf: input.sha256,
      validateDerivative: true,
      ...(input.stagedBy ? { stagedBy: input.stagedBy } : {}),
    });
    generated += 1;
    return stageNextRung(index + 1);
  }
  // A quality ladder: a declined rung stops the costlier ones after it.
  await stageNextRung(0);
  if (!hasStagedOrClaimedVariant(db, input.sha256, "phash")) {
    try {
      const phash = await codec.perceptualHash(input.bytes, input.mediaType);
      if (phash) {
        stageBlobBytes(db, {
          bytes: Buffer.from(phash),
          mediaType: "text/x-perceptual-hash",
          variant: "phash",
          variantOf: input.sha256,
          validateDerivative: true,
          ...(input.stagedBy ? { stagedBy: input.stagedBy } : {}),
        });
        generated += 1;
      }
    } catch {
      // A hash miss only removes a duplicate hint.
    }
  }
  if (!hasStagedOrClaimedVariant(db, input.sha256, "thumbhash")) {
    try {
      const thumbhash = await codec.thumbhash(input.bytes, input.mediaType);
      if (thumbhash) {
        stageBlobBytes(db, {
          bytes: Buffer.from(thumbhash),
          mediaType: "application/x-thumbhash",
          variant: "thumbhash",
          variantOf: input.sha256,
          validateDerivative: true,
          ...(input.stagedBy ? { stagedBy: input.stagedBy } : {}),
        });
        generated += 1;
      }
    } catch {
      // A missing placeholder means a blank tile until the thumb lands.
    }
  }
  await recordIngressPreviewStatus(db, input.sha256, declined);
  return generated;
}

/**
 * Settle the durable decline for one ingress contribution. The marker hangs off
 * the CONTENT row, and this contributor is fire-and-forget beside a claim it
 * does not order against, so it WAITS, bounded, for the content row to appear —
 * the same lateness the rungs themselves tolerate. A sha nobody ever claims is
 * not content and needs no marker; the sweep is the backstop either way.
 */
async function recordIngressPreviewStatus(
  db: VaultDb,
  sha256: string,
  declined: boolean,
  attempt = 0
): Promise<void> {
  const contentId = contentIdForSha(db, sha256);
  if (contentId) {
    settlePreviewVerdict(db, contentId, declined);
    return;
  }
  // Only a DECLINE is worth waiting for. A contribution that produced rungs has
  // nothing to clear on a content row that does not exist yet.
  if (!declined || attempt + 1 >= CLAIM_WAIT_ATTEMPTS) return;
  await delay(CLAIM_WAIT_MS);
  return recordIngressPreviewStatus(db, sha256, declined, attempt + 1);
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function yieldTick(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * Bounded and idempotent: an existing contribution is never regenerated, so a
 * client-supplied thumb that beat the sweep wins. Per-item failures are
 * counted, never fatal — a codec crash must not fail the custody sweep this
 * rides along with (#405, #414).
 */
export async function backfillPreviews(
  db: VaultDb,
  codec: PreviewCodec,
  options: { limit?: number; now?: string } = {}
): Promise<PreviewBackfillResult> {
  const limit = options.limit ?? PREVIEW_BACKFILL_BATCH;
  const result: PreviewBackfillResult = {
    scanned: 0,
    generated: 0,
    phashesGenerated: 0,
    thumbhashesGenerated: 0,
    skippedUnsupported: 0,
    missingBytes: 0,
  };
  if (limit <= 0) return result;
  const now = options.now ?? nowIso();

  // `deleted_at IS NULL` keeps the backstop off trashed items; the raster
  // filter keeps video out — a video backstop is a non-goal (#405).
  const items = db.vault
    .prepare(
      `SELECT i.content_id, i.content_uri,
              ${contentMediaTypeSql("i.content_id")} AS media_type
         FROM core_content_item i
        WHERE i.content_uri LIKE 'blob:%'
          AND ${contentMediaTypeSql("i.content_id")} LIKE 'image/%'
          AND i.deleted_at IS NULL
          AND (
            (NOT EXISTS (SELECT 1 FROM core_content_derivative d
                          WHERE d.content_id = i.content_id AND d.variant = 'thumb'
                            AND d.sha256 IS NOT NULL)
             AND NOT EXISTS (SELECT 1 FROM enrich_request r
                              WHERE r.target_type = 'core.content_item'
                                AND r.target_id = i.content_id
                                AND r.contribution_variant = 'thumb'
                                AND r.drained_at IS NULL AND r.lease_expires_at > ?))
            OR (NOT EXISTS (SELECT 1 FROM core_content_derivative d
                             WHERE d.content_id = i.content_id AND d.variant = 'preview'
                               AND d.sha256 IS NOT NULL)
                AND NOT EXISTS (SELECT 1 FROM enrich_request r
                                 WHERE r.target_type = 'core.content_item'
                                   AND r.target_id = i.content_id
                                   AND r.contribution_variant = 'preview'
                                   AND r.drained_at IS NULL AND r.lease_expires_at > ?))
            OR NOT EXISTS (SELECT 1 FROM core_content_derivative d
                            WHERE d.content_id = i.content_id AND d.variant = 'phash'
                              AND d.text_content IS NOT NULL)
            OR NOT EXISTS (SELECT 1 FROM core_content_derivative d
                            WHERE d.content_id = i.content_id AND d.variant = 'thumbhash'
                              AND d.text_content IS NOT NULL)
          )
          -- The durable decline (#1011): an original THIS codec generation
          -- already declined is not retried every sweep. Keyed by the model id,
          -- so bumping PREVIEW_CODEC_VERSION re-selects the whole marked set.
          AND NOT EXISTS (SELECT 1 FROM enrich_derivation ed
                           WHERE ed.target_type = 'core.content_item'
                             AND ed.target_id = i.content_id
                             AND ed.variant = ? AND ed.capability = ?
                             AND ed.model = ?)
        ORDER BY i.created_at
        LIMIT ?`
    )
    .all(
      now,
      now,
      PREVIEW_STATUS_VARIANT,
      PREVIEW_STATUS_CAPABILITY,
      PREVIEW_CODEC_MODEL_ID,
      limit
    ) as {
    content_id: string;
    content_uri: string;
    media_type: string;
  }[];

  async function processNextItem(index: number): Promise<void> {
    const item = items[index];
    if (!item) return;
    result.scanned += 1;
    const parentSha = shaOfBlobUri(item.content_uri);
    if (!parentSha) return processNextItem(index + 1);
    try {
      // Recomputed per item: an existing rung is never overwritten.
      const missing = PREVIEW_LADDER.filter(
        (rung) =>
          !hasVariant(db, item.content_id, rung.variant) &&
          !hasLiveDeviceLease(db, item.content_id, rung.variant, now)
      );
      const missingPhash = !hasVariant(db, item.content_id, "phash");
      const missingThumbhash = !hasVariant(db, item.content_id, "thumbhash");
      if (missing.length === 0 && !missingPhash && !missingThumbhash) {
        return processNextItem(index + 1);
      }
      // A remote-only original reads through custody.open at backfill pace.
      const bytes =
        db.blobs.getSync(parentSha) ?? (await db.blobs.open(parentSha));
      if (!bytes) {
        result.missingBytes += 1;
        return processNextItem(index + 1);
      }
      // Declining the tiny rung declines the medium: same decode.
      let unsupported = await stageMissingPreviewRungs(
        db,
        codec,
        item,
        bytes,
        parentSha,
        missing,
        result
      );
      if (missingPhash) {
        const phash = await codec.perceptualHash(bytes, item.media_type);
        if (phash && !hasVariant(db, item.content_id, "phash")) {
          stageBlobBytes(db, {
            bytes: Buffer.from(phash),
            mediaType: "text/x-perceptual-hash",
            variant: "phash",
            variantOf: parentSha,
            validateDerivative: true,
          });
          result.phashesGenerated += 1;
        } else if (!phash && missing.length === 0) {
          unsupported = true;
        }
      }
      if (missingThumbhash && !unsupported) {
        const thumbhash = await codec.thumbhash(bytes, item.media_type);
        if (thumbhash && !hasVariant(db, item.content_id, "thumbhash")) {
          stageBlobBytes(db, {
            bytes: Buffer.from(thumbhash),
            mediaType: "application/x-thumbhash",
            variant: "thumbhash",
            variantOf: parentSha,
            validateDerivative: true,
          });
          result.thumbhashesGenerated += 1;
        } else if (!thumbhash && missing.length === 0 && !missingPhash) {
          unsupported = true;
        }
      }
      if (unsupported && !hasDisplayRung(db.vault, item.content_id)) {
        result.skippedUnsupported += 1;
      }
      // A rung landed (or was already there, the client's included): retire any
      // marker an older codec generation left, so the content reads as
      // previewable again.
      settlePreviewVerdict(db, item.content_id, unsupported, now);
    } catch {
      // One unreadable image never sinks the batch or the custody sweep.
    }
    await yieldTick();
    return processNextItem(index + 1);
  }
  await processNextItem(0);
  return result;
}

function hasVariant(
  db: VaultDb,
  contentId: string,
  variant: "thumb" | "preview" | "phash" | "thumbhash"
): boolean {
  const row = db.vault
    .prepare(
      `SELECT 1 FROM core_content_derivative
        WHERE content_id = ? AND variant = ?
          AND CASE WHEN variant IN ('phash','thumbhash') THEN text_content IS NOT NULL
                   ELSE sha256 IS NOT NULL END
        LIMIT 1`
    )
    .get(contentId, variant);
  return row !== undefined;
}

function hasStagedOrClaimedVariant(
  db: VaultDb,
  parentSha: string,
  variant: "phash" | "thumbhash"
): boolean {
  const staged = db.vault
    .prepare(
      `SELECT 1 FROM blob_staging
        WHERE variant_of = ? AND variant = ? AND inline_content IS NOT NULL LIMIT 1`
    )
    .get(parentSha, variant);
  if (staged) return true;
  const claimed = db.vault
    .prepare("SELECT content_id FROM core_content_item WHERE sha256 = ?")
    .get(parentSha) as { content_id: string } | undefined;
  return claimed ? hasVariant(db, claimed.content_id, variant) : false;
}

function hasLiveDeviceLease(
  db: VaultDb,
  contentId: string,
  variant: "thumb" | "preview",
  now: string
): boolean {
  return (
    db.vault
      .prepare(
        `SELECT 1 FROM enrich_request
          WHERE target_type = 'core.content_item' AND target_id = ?
            AND contribution_variant = ? AND drained_at IS NULL
            AND lease_expires_at > ? LIMIT 1`
      )
      .get(contentId, variant, now) !== undefined
  );
}
