import { BLOB_MEDIUM_EDGE, BLOB_TINY_EDGE } from "@centraid/core/blob";

import type { VaultDb } from "../db.js";
import { nowIso } from "../ids.js";
import { stageBlobBytes } from "./staging.js";
import { shaOfBlobUri } from "./store.js";

export const TINY_EDGE = BLOB_TINY_EDGE;
export const MEDIUM_EDGE = BLOB_MEDIUM_EDGE;

export const PREVIEW_BACKFILL_BATCH = 24;
export const INGRESS_PREVIEW_MAX_BYTES = 32 * 1024 * 1024;

export const PREVIEW_LADDER: readonly {
  variant: "thumb" | "preview";
  maxEdge: number;
}[] = [
  { variant: "thumb", maxEdge: TINY_EDGE },
  { variant: "preview", maxEdge: MEDIUM_EDGE },
];

export interface PreviewOutput {
  bytes: Buffer;
  mediaType: string;
  width: number;
  height: number;
}

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
  skippedUnsupported: number;
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
    return 0;
  }
  let generated = 0;
  async function stageNextRung(index: number): Promise<void> {
    const rung = PREVIEW_LADDER[index];
    if (!rung) return;
    const output = await codec.downscale(
      input.bytes,
      input.mediaType,
      rung.maxEdge
    );
    if (!output) return;
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
      // Intentionally empty.
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
      // Intentionally empty.
    }
  }
  return generated;
}

function yieldTick(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

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

  const items = db.vault
    .prepare(
      `SELECT i.content_id, i.content_uri, i.media_type
         FROM core_content_item i
        WHERE i.content_uri LIKE 'blob:%'
          AND i.media_type LIKE 'image/%'
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
        ORDER BY i.created_at
        LIMIT ?`
    )
    .all(now, now, limit) as {
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
      const bytes =
        db.blobs.getSync(parentSha) ?? (await db.blobs.open(parentSha));
      if (!bytes) {
        result.missingBytes += 1;
        return processNextItem(index + 1);
      }
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
      if (unsupported) result.skippedUnsupported += 1;
    } catch {
      // Intentionally empty.
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
