// PROJECTION IS INGEST (issue #726 decision D11).
//
// A row that arrives over a share edge must take the SAME door an authored
// row takes at the audience. The closure deliberately carries no derived
// state (closure.ts exclusion 2) and NULLs every cross-vault foreign key, so a
// projected photograph lands with no place, no embedding and none of the
// origin's ontology — which is correct, and also means the audience must
// re-register it for itself, exactly as `stage-file.ts` → `publishBatch` does
// for a photograph the owner dropped on their own vault.
//
// Hooks run inside the projection's transaction (project-closure.ts), so a
// replicating device never sees the row before its registration.
//
// KEYED BY ENTITY TYPE, NEVER BY APP. `media.asset` is vault ontology;
// "Photos" is an app that happens to read it. The table below is closed and
// owned by vault core: an app's scope-kit `projectionIngest` declaration names
// an entity door, it does not register one — so no app id is representable
// here, let alone branched on. A record-only app declares nothing and gets
// nothing.

import type { DatabaseSync } from "node:sqlite";

import { mediaLocationPolicyForVault } from "../blob/staging.js";
import { findOrCreatePlaceTx } from "../commands/media.js";
import { uuidv7 } from "../ids.js";
import type { ProjectedItem, ShareableItemType } from "./closure.js";

/** The clock a hook writes with — the projection's, so one share is one instant. */
export interface ProjectionIngestContext {
  /** ISO 8601, the same instant the lineage row records. */
  now: string;
}

/**
 * Re-register one projected row in the audience vault. Runs INSIDE the
 * projection transaction and may only write the audience database.
 */
export type ProjectionIngestHook = (
  audience: DatabaseSync,
  item: ProjectedItem,
  ctx: ProjectionIngestContext
) => void;

/**
 * Read the EXIF the asset carries and file it under the AUDIENCE's places.
 *
 * The coordinates crossed on `exif_json` (the camera's testimony, structural);
 * the `place_id` did not, because a place id names a row in the origin's
 * graph. So the audience re-derives its own, through the same
 * `findOrCreatePlaceTx` an upload uses — a photo shared into Family lands at
 * the family's "12.9716, 77.5946", not at a dangling id.
 *
 * An audience whose media policy is `strip` gets NO place: its own door would
 * not have recorded one, and a share is not a way around a vault's own rule.
 */
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
    // Unparseable testimony is a fact about the origin's row, not a reason to
    // fail a share. The asset simply lands without a place.
    return;
  }
  const { latitude, longitude } = exif as {
    latitude?: number;
    longitude?: number;
  };
  if (typeof latitude !== "number" || typeof longitude !== "number") return;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
  const placeId = findOrCreatePlaceTx(
    // `wrote` is the command pipeline's provenance collector; a share is not a
    // command and emits no receipt, so the minted place is recorded by the
    // replica commit bracket around this transaction and nothing else.
    { vault: audience, now: ctx.now, newId: uuidv7, wrote: () => undefined },
    latitude,
    longitude
  );
  audience
    .prepare("UPDATE media_asset SET place_id = ? WHERE asset_id = ?")
    .run(placeId, assetId);
}

/**
 * The one contribution a projected asset structurally cannot have: its
 * EMBEDDING. Derivatives crossed, so previews/thumbs need nothing; captions
 * and faces are consent-gated enrichers and a placement must never manufacture
 * an owner's consent (`enrich_request.capability` is a consent record — see
 * schema/enrich.ts). An embedding is the ambient index the audience's own
 * sweep would compute anyway; the row only says "this one first", which is
 * what makes a just-shared photo findable instead of findable-next-sweep.
 *
 * `required_capability` stays NULL on purpose: a device lease lane row would
 * hand this to a paired device, and a projected asset is gateway work.
 */
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

/** The ingest door an item type takes at the audience, if it declares one. */
export function projectionIngest(
  itemType: ShareableItemType
): ProjectionIngestHook | undefined {
  return HOOKS.get(itemType);
}

/**
 * Run every declared door over what this projection wrote.
 *
 * A DEDUPED row is skipped: the audience already held it, so it already went
 * through this door once, and re-running would re-ask for work the vault may
 * have already done.
 */
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
