import type { DatabaseSync } from "node:sqlite";

import { mediaLocationPolicyForVault } from "../blob/staging.js";
import { findOrCreatePlaceTx } from "../commands/media.js";
import { uuidv7 } from "../ids.js";
import type { ProjectedItem, ShareableItemType } from "./closure.js";

export interface ProjectionIngestContext {
  now: string;
}

export type ProjectionIngestHook = (
  audience: DatabaseSync,
  item: ProjectedItem,
  ctx: ProjectionIngestContext
) => void;

function linkProjectedPlace(
  audience: DatabaseSync,
  assetId: string,
  ctx: ProjectionIngestContext
): void {
  if (mediaLocationPolicyForVault(audience) === "strip") return;
  const row = audience
    .prepare("SELECT exif_json, place_id FROM media_asset WHERE asset_id = ?")
    .get(assetId) as
    | { exif_json: string | null; place_id: string | null }
    | undefined;
  if (!row || row.place_id !== null || row.exif_json === null) return;
  let exif: { latitude?: unknown; longitude?: unknown };
  try {
    exif = JSON.parse(row.exif_json) as { latitude?: unknown };
  } catch {
    return;
  }
  const { latitude, longitude } = exif as {
    latitude?: number;
    longitude?: number;
  };
  if (typeof latitude !== "number" || typeof longitude !== "number") return;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
  const placeId = findOrCreatePlaceTx(
    { vault: audience, now: ctx.now, newId: uuidv7, wrote: () => undefined },
    latitude,
    longitude
  );
  audience
    .prepare("UPDATE media_asset SET place_id = ? WHERE asset_id = ?")
    .run(placeId, assetId);
}

function requestProjectedEnrichment(
  audience: DatabaseSync,
  assetId: string,
  ctx: ProjectionIngestContext
): void {
  const open = audience
    .prepare(
      `SELECT 1 AS present FROM enrich_request
        WHERE target_type = 'media.asset' AND target_id = ?
          AND contribution_variant = 'embedding' AND drained_at IS NULL`
    )
    .get(assetId);
  if (open) return;
  audience
    .prepare(
      `INSERT INTO enrich_request
         (request_id, target_type, target_id, reason, detail, required_capability,
          contribution_variant, capability, requested_at, drained_at)
       VALUES (?, 'media.asset', ?, 'projected', NULL, NULL,
               'embedding', NULL, ?, NULL)`
    )
    .run(uuidv7(), assetId, ctx.now);
}

const projectedAsset: ProjectionIngestHook = (audience, item, ctx) => {
  linkProjectedPlace(audience, item.itemId, ctx);
  requestProjectedEnrichment(audience, item.itemId, ctx);
};

const HOOKS = new Map<ShareableItemType, ProjectionIngestHook>([
  ["media.asset", projectedAsset],
]);

export function projectionIngest(
  itemType: ShareableItemType
): ProjectionIngestHook | undefined {
  return HOOKS.get(itemType);
}

export function runProjectionIngest(
  audience: DatabaseSync,
  projected: readonly ProjectedItem[],
  ctx: ProjectionIngestContext
): void {
  for (const item of projected) {
    if (item.deduped) continue;
    projectionIngest(item.itemType)?.(audience, item, ctx);
  }
}
