// The durable "preview unsupported" record (#1011), factored OUT of
// `preview.ts` so the staging seam can retire a marker without a module cycle:
// `preview.ts` imports `staging.ts` (it stages its own rungs), and `staging.ts`
// must clear the marker the moment a rung — the GATEWAY's or a CLIENT's —
// lands on a claimed parent. `preview.ts` re-exports everything here, so the
// package surface is unchanged.

import type { DatabaseSync } from "node:sqlite";

import { stampDerivation } from "../enrich/derivation.js";

/** The codec generation. BUMP when the codec's format coverage changes. */
export const PREVIEW_CODEC_VERSION = 1;
export const PREVIEW_CODEC_NAME = "preview-codec";
export const PREVIEW_CODEC_MODEL_ID = `${PREVIEW_CODEC_NAME}@${PREVIEW_CODEC_VERSION}`;
export const PREVIEW_STATUS_VARIANT = "preview";
export const PREVIEW_STATUS_CAPABILITY = "previews";

export interface PreviewUnsupportedMarker {
  contentId: string;
  model: string;
  /** True when the marker names the codec generation running now. */
  current: boolean;
}

/** The marker on one content row, whatever codec generation wrote it. */
export function previewUnsupportedMarkerFor(
  vault: DatabaseSync,
  contentId: string
): PreviewUnsupportedMarker | null {
  const row = vault
    .prepare(
      `SELECT model FROM enrich_derivation
        WHERE target_type = 'core.content_item' AND target_id = ?
          AND variant = ? AND capability = ?
        LIMIT 1`
    )
    .get(contentId, PREVIEW_STATUS_VARIANT, PREVIEW_STATUS_CAPABILITY) as
    | { model: string }
    | undefined;
  if (!row) return null;
  return {
    contentId,
    model: row.model,
    current: row.model === PREVIEW_CODEC_MODEL_ID,
  };
}

export function markPreviewUnsupportedFor(
  vault: DatabaseSync,
  contentId: string,
  now?: string
): void {
  stampDerivation(vault, {
    targetType: "core.content_item",
    targetId: contentId,
    variant: PREVIEW_STATUS_VARIANT,
    capability: PREVIEW_STATUS_CAPABILITY,
    model: PREVIEW_CODEC_MODEL_ID,
    payload: { unsupported: true, codec: PREVIEW_CODEC_MODEL_ID },
    ...(now ? { now } : {}),
  });
}

/** A rung that landed retires the marker: the content is previewable now. */
export function clearPreviewUnsupportedFor(
  vault: DatabaseSync,
  contentId: string
): void {
  vault
    .prepare(
      `DELETE FROM enrich_derivation
        WHERE target_type = 'core.content_item' AND target_id = ?
          AND variant = ? AND capability = ?`
    )
    .run(contentId, PREVIEW_STATUS_VARIANT, PREVIEW_STATUS_CAPABILITY);
}

/**
 * A DISPLAY RUNG EXISTS, so "unsupported" is false whoever produced it (#1011).
 *
 * The gateway codec is not the only producer: the phone decodes the HEVC-coded
 * HEIC that sharp's libheif cannot and contributes JPEG rungs through the
 * variant door. Both the ingress contributor and the sweep consult this before
 * stamping, so a client rung that beat them is never overwritten by a decline
 * the gateway would otherwise have recorded on its own inability.
 */
export function hasDisplayRung(
  vault: DatabaseSync,
  contentId: string
): boolean {
  return (
    vault
      .prepare(
        `SELECT 1 FROM core_content_derivative
          WHERE content_id = ? AND variant IN ('thumb','preview')
            AND sha256 IS NOT NULL LIMIT 1`
      )
      .get(contentId) !== undefined
  );
}
