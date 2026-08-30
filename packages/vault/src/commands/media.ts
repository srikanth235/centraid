// governance: allow-repo-hygiene file-size-limit one command pack per domain is the vault contract (registered as a unit, read wholesale); media owns the whole library loop (9 commands with their contracts), so it is large by design.
// Media commands (§08). Asset = meaning over bytes (`media_asset` on `core_content_item`). Last remaining renter decides byte soft-delete (#274). Purge (#711) ends grace early.

import type { DatabaseSync } from "node:sqlite";

import { validateDerivativeContribution } from "../blob/derivatives.js";
import {
  MAX_INLINE_DATA_URI_CHARS,
  mintContentFromDataUri,
} from "../blob/mint.js";
import type { Gateway } from "../gateway/gateway.js";
import type { CommandDefinition, HandlerCtx } from "../gateway/types.js";
import { CONTENT_REFERENCES } from "../schema/content-references.js";
import { cleanupPolyRefs } from "../schema/poly-refs.js";
import {
  loadEntityRevision,
  markEntityRevisionUndone,
  recordEntityRevision,
} from "./entity-revisions.js";
import { setStarred, starredExistsSql } from "./flags.js";
import { assertInlineDataUriWithinBudget } from "./inline-body-guard.js";

// Star rides the canonical content item, not the asset (#274 / #441 A2.1). `media_asset.favorite` is a single-writer mirror; postcondition asserts they agree.
const CONTENT_ITEM_TARGET_TYPE = "core.content_item";

/** Mirror the favorite bit onto the content item's starred flags tag. */
function mirrorFavoriteToTag(
  ctx: HandlerCtx,
  assetId: string,
  favorite: number
): void {
  const row = ctx.db
    .prepare("SELECT content_id FROM media_asset WHERE asset_id = ?")
    .get(assetId) as { content_id: string } | undefined;
  if (!row) return;
  setStarred(ctx, CONTENT_ITEM_TARGET_TYPE, row.content_id, favorite === 1);
}

/** Soft-deleted bytes linger this long before the lifecycle sweep purges. */
const PURGE_AFTER_DAYS = 30;

function actorPartyId(ctx: HandlerCtx): string {
  if (ctx.identity.partyId) return ctx.identity.partyId;
  const owner = ctx.db
    .prepare("SELECT owner_party_id FROM core_vault LIMIT 1")
    .get() as { owner_party_id: string | null } | undefined;
  if (!owner?.owner_party_id) throw new Error("vault has no owner");
  return owner.owner_party_id;
}

/** Deps for media writes outside the command pipeline (#721). Same row/rules as `media.add_asset`. */
export interface MediaWriteDeps {
  vault: DatabaseSync;
  now: string;
  newId: () => string;
  wrote: (entityType: string, entityId: string) => void;
}

function depsOf(ctx: HandlerCtx): MediaWriteDeps {
  return {
    vault: ctx.db,
    now: ctx.now,
    newId: () => ctx.newId(),
    wrote: (entityType, entityId) => {
      ctx.wrote(entityType, entityId);
    },
  };
}

export function assetKindFor(mediaType: string): string {
  if (mediaType.startsWith("video/")) return "video";
  if (mediaType.startsWith("audio/")) return "audio";
  if (mediaType.startsWith("image/")) return "photo";
  return "scan";
}

function purgeAt(now: string): string {
  return new Date(
    new Date(now).getTime() + PURGE_AFTER_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();
}

/** ~11m identity precision so burst photos share one `core_place`. Row keeps precise coords (#352). */
function roundCoord(v: number): number {
  return Math.round(v * 10_000) / 10_000;
}

/** ~170m: named-place adoption, looser than the ~11m identity rung. */
const NAMED_PLACE_RADIUS_DEG = 0.0015;

/** Coordinate-as-name is not a name — do not adopt it. */
export function isCoordinateLabel(name: string | null | undefined): boolean {
  return /^-?\d{1,3}\.\d+,\s*-?\d{1,3}\.\d+$/u.test((name ?? "").trim());
}

/** Find-or-create place: named within ~170m, else rounded identity (~11m), else a coordinate-labelled row. Coords stay precise. */
export function findOrCreatePlaceTx(
  deps: MediaWriteDeps,
  lat: number,
  lng: number
): string {
  const rLat = roundCoord(lat);
  const rLng = roundCoord(lng);
  // Bounding box (SQLite has no trig); divide lng by cos(lat) so the box stays square.
  const lngRadius =
    NAMED_PLACE_RADIUS_DEG / Math.max(0.05, Math.cos((lat * Math.PI) / 180));
  const named = deps.vault
    .prepare(
      `SELECT place_id, name FROM core_place
        WHERE geo_lat IS NOT NULL AND geo_lng IS NOT NULL
          AND geo_lat BETWEEN ? AND ?
          AND geo_lng BETWEEN ? AND ?
          AND name IS NOT NULL AND trim(name) <> ''
        ORDER BY (geo_lat - ?) * (geo_lat - ?) + (geo_lng - ?) * (geo_lng - ?)
        LIMIT 8`
    )
    .all(
      lat - NAMED_PLACE_RADIUS_DEG,
      lat + NAMED_PLACE_RADIUS_DEG,
      lng - lngRadius,
      lng + lngRadius,
      lat,
      lat,
      lng,
      lng
    ) as { place_id: string; name: string | null }[];
  const adoptable = named.find((row) => !isCoordinateLabel(row.name));
  if (adoptable) return adoptable.place_id;

  const existing = deps.vault
    .prepare(
      `SELECT place_id FROM core_place
        WHERE geo_lat IS NOT NULL AND geo_lng IS NOT NULL
          AND ROUND(geo_lat, 4) = ? AND ROUND(geo_lng, 4) = ?
        LIMIT 1`
    )
    .get(rLat, rLng) as { place_id: string } | undefined;
  if (existing) return existing.place_id;
  const placeId = deps.newId();
  deps.vault
    .prepare(
      `INSERT INTO core_place (place_id, name, kind, geo_lat, geo_lng, geohash, address_json, tz, parent_place_id, created_at)
       VALUES (?, ?, NULL, ?, ?, NULL, NULL, NULL, NULL, ?)`
    )
    .run(placeId, `${lat.toFixed(4)}, ${lng.toFixed(4)}`, lat, lng, deps.now);
  deps.wrote("core.place", placeId);
  return placeId;
}

export function exifJsonForMeta(meta: Record<string, unknown>): string | null {
  const exif = Object.fromEntries(
    Object.entries(meta).filter(([k, v]) => k !== "text" && v !== undefined)
  );
  return Object.keys(exif).length > 0 ? JSON.stringify(exif) : null;
}

export interface MediaAssetRow {
  assetId: string;
  contentId: string;
  kind: string;
  capturedAt: string | null;
  tzOffsetMin: number | null;
  captureGroupId: string | null;
  sourceAssetId: string | null;
  placeId: string | null;
  width: number | null;
  height: number | null;
  durationS: number | null;
  exifJson: string | null;
}

/** The one `media_asset` insert — `media.add_asset` and the import publisher share it. */
export function insertMediaAssetTx(
  vault: DatabaseSync,
  row: MediaAssetRow
): void {
  vault
    .prepare(
      `INSERT INTO media_asset (asset_id, content_id, kind, captured_at, tz_offset_min, capture_group_id, source_asset_id, place_id, camera_device_id, width, height, duration_s, exif_json, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL)`
    )
    .run(
      row.assetId,
      row.contentId,
      row.kind,
      row.capturedAt,
      row.tzOffsetMin,
      row.captureGroupId,
      row.sourceAssetId,
      row.placeId,
      row.width,
      row.height,
      row.durationS,
      row.exifJson
    );
}

/** UNIQUE `content_id`: adopt, do not duplicate. Do not stamp `source_asset_id` (#711) — these bytes already are that asset. */
export function adoptAssetForContentTx(
  deps: MediaWriteDeps,
  contentId: string,
  captureGroupId: string | null
): string | null {
  const existing = deps.vault
    .prepare(
      "SELECT asset_id, deleted_at, capture_group_id FROM media_asset WHERE content_id = ?"
    )
    .get(contentId) as
    | {
        asset_id: string;
        deleted_at: string | null;
        capture_group_id: string | null;
      }
    | undefined;
  if (!existing) return null;
  if (
    existing.deleted_at !== null ||
    (!existing.capture_group_id && captureGroupId)
  ) {
    deps.vault
      .prepare(
        `UPDATE media_asset
            SET deleted_at = NULL,
                purge_at = NULL,
                capture_group_id = COALESCE(capture_group_id, ?)
          WHERE asset_id = ?`
      )
      .run(captureGroupId, existing.asset_id);
    deps.wrote("media.asset", existing.asset_id);
  }
  return existing.asset_id;
}

/**
 * Does nothing rent these bytes any more? The LAST reference decides whether
 * bytes soft-delete, and the reference list is the one in
 * `schema/content-references.ts` (#883, ruling O-attach) rather than a copy
 * that could fall behind a new byte-bearing column.
 */
export function contentUnreferenced(
  ctx: HandlerCtx,
  contentId: string
): boolean {
  for (const ref of CONTENT_REFERENCES) {
    const live = ref.onlyLive ? ` AND ${ref.onlyLive}` : "";
    const row = ctx.db
      .prepare(
        `SELECT count(*) AS n FROM ${ref.table} WHERE ${ref.column} = ?${live}`
      )
      .get(contentId) as { n: number };
    if (row.n > 0) return false;
  }
  return true;
}

/** Collapse grace to now when unrented — handler has no CAS delete; sweep reclaims. */
function releaseContentNow(ctx: HandlerCtx, contentId: string): boolean {
  if (!contentUnreferenced(ctx, contentId)) return false;
  ctx.db
    .prepare(
      `UPDATE core_content_item
          SET deleted_at = COALESCE(deleted_at, ?), purge_at = ?
        WHERE content_id = ?`
    )
    .run(ctx.now, ctx.now, contentId);
  ctx.wrote("core.content_item", contentId);
  return true;
}

/** Soft-delete a content item's bytes if nothing rents them any more. */
export function releaseContentIfUnreferenced(
  ctx: HandlerCtx,
  contentId: string
): boolean {
  if (!contentUnreferenced(ctx, contentId)) return false;
  ctx.db
    .prepare(
      "UPDATE core_content_item SET deleted_at = ?, purge_at = ? WHERE content_id = ?"
    )
    .run(ctx.now, purgeAt(ctx.now), contentId);
  ctx.wrote("core.content_item", contentId);
  return true;
}

const ADD_ASSET: CommandDefinition = {
  name: "media.add_asset",
  ownerSchema: "media",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      /** Small inline bytes. Exactly one of data_uri / staged_sha (#296). */
      data_uri: { type: "string", minLength: 6 },
      /** Staged bytes: claim what POST /_vault/blobs hashed into the CAS. */
      staged_sha: { type: "string", minLength: 64, maxLength: 64 },
      kind: { type: "string", enum: ["photo", "video", "audio", "scan"] },
      captured_at: { type: "string" },
      // Capture-local UTC offset (#419), read off the same EXIF as the time.
      tz_offset_min: { type: "integer", minimum: -1080, maximum: 1080 },
      capture_group_id: { type: "string", minLength: 1, maxLength: 200 },
      // Edit lineage (#711): the asset these bytes were derived FROM. The
      // editor saves an edit as a new asset dated today, and this is what makes
      // that copy's provenance a fact rather than a promise.
      source_asset_id: { type: "string", minLength: 1, maxLength: 200 },
      title: { type: "string" },
      width: { type: "integer", minimum: 1 },
      height: { type: "integer", minimum: 1 },
      duration_s: { type: "number", minimum: 0 },
      // Caller-asserted location, not extraction — media.location strips GPS read from a file.
      latitude: { type: "number", minimum: -90, maximum: 90 },
      longitude: { type: "number", minimum: -180, maximum: 180 },
      // Perceptual hash (#299 §2, Tier 0) — hex, producer-agnostic.
      phash: {
        type: "string",
        minLength: 4,
        maxLength: 64,
        pattern: "^[0-9a-f]+$",
      },
      // ThumbHash placeholder (#419) — unpadded base64, lands as an inline
      // derivative beside the client's thumb.
      thumbhash: {
        type: "string",
        minLength: 6,
        maxLength: 100,
        pattern: "^[A-Za-z0-9+/]+$",
      },
    },
  },
  outputSchema: {
    type: "object",
    required: ["asset_id", "content_id"],
    properties: {
      asset_id: { type: "string" },
      content_id: { type: "string" },
      deduped: { type: "integer" },
    },
  },
  preconditions: [
    {
      name: "exactly_one_source",
      sql: "SELECT ((:data_uri IS NOT NULL) + (:staged_sha IS NOT NULL)) AS n",
      column: "n",
      op: "eq",
      value: 1,
    },
    {
      // A coordinate is a PAIR. Half of one is no location at all, and
      // dropping it silently would let a caller believe it placed a photograph
      // it had not.
      name: "coordinate_pair_complete",
      sql: "SELECT ((:latitude IS NULL) = (:longitude IS NULL)) AS n",
      column: "n",
      op: "eq",
      value: 1,
    },
    {
      name: "is_data_uri",
      sql: "SELECT CASE WHEN :data_uri IS NULL THEN 1 ELSE (:data_uri LIKE 'data:%') END AS n",
      column: "n",
      op: "eq",
      value: 1,
    },
    {
      // The inline door is for SMALL payloads (#296): a 4K video takes the
      // staging route, never command JSON — the journal records inputs.
      name: "within_size_cap",
      sql: `SELECT CASE WHEN :data_uri IS NULL THEN 1 ELSE (length(:data_uri) <= ${MAX_INLINE_DATA_URI_CHARS}) END AS n`,
      column: "n",
      op: "eq",
      value: 1,
    },
    {
      name: "staged_or_owned",
      sql: `SELECT CASE WHEN :staged_sha IS NULL THEN 1 ELSE
              (EXISTS(SELECT 1 FROM blob_staging WHERE sha256 = :staged_sha AND variant IS NULL)
               OR EXISTS(SELECT 1 FROM core_content_item WHERE sha256 = :staged_sha)) END AS n`,
      column: "n",
      op: "eq",
      value: 1,
    },
    {
      // A claimed source must be a real asset in THIS vault (#711). Named here
      // rather than left to the FK, so a mistyped lineage names the failing
      // precondition instead of a raw constraint error mid-insert.
      name: "source_asset_exists",
      sql: `SELECT CASE WHEN :source_asset_id IS NULL THEN 1 ELSE
              EXISTS(SELECT 1 FROM media_asset WHERE asset_id = :source_asset_id) END AS n`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  postconditions: [
    {
      name: "asset_backed_by_content",
      sql: `SELECT count(*) AS n FROM media_asset a
             JOIN core_content_item c ON c.content_id = a.content_id
            WHERE a.asset_id = :asset_id AND c.deleted_at IS NULL`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  idempotency: "once",
  risk: "low",
  handler: addAsset,
};

function addAsset(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as {
    data_uri?: string;
    staged_sha?: string;
    kind?: string;
    captured_at?: string;
    tz_offset_min?: number;
    capture_group_id?: string;
    source_asset_id?: string;
    title?: string;
    width?: number;
    height?: number;
    duration_s?: number;
    phash?: string;
    thumbhash?: string;
    latitude?: number;
    longitude?: number;
  };
  // Staged claims carry spool metadata (#296): the gateway sniffed the type and
  // read EXIF server-side. Explicit input still wins.
  const spoolMeta = input.staged_sha
    ? (ctx.blobs.staged(input.staged_sha)?.meta ?? {})
    : {};
  if (input.data_uri !== undefined)
    assertInlineDataUriWithinBudget(input.data_uri);
  const minted = input.staged_sha
    ? ctx.blobs.claimStaged(input.staged_sha, { title: input.title })
    : mintContentFromDataUri(ctx, input.data_uri!, { title: input.title });
  const contentId = minted.contentId;
  const deps = depsOf(ctx);
  const adopted = adoptAssetForContentTx(
    deps,
    contentId,
    input.capture_group_id ?? null
  );
  if (adopted) {
    return { asset_id: adopted, content_id: contentId, deduped: 1 };
  }
  const meta = spoolMeta as {
    width?: number;
    height?: number;
    duration_s?: number;
    captured_at?: string;
    has_location?: boolean;
    latitude?: number;
    longitude?: number;
  };
  const assetId = ctx.newId();
  // Spool GPS already passed the media.location policy gate at staging time
  // (pipeline.ts), so it only rides here when the owner kept it. An explicit
  // pair wins, like every other field on this command.
  const lat = input.latitude ?? meta.latitude;
  const lng = input.longitude ?? meta.longitude;
  const placeId =
    lat !== undefined && lng !== undefined
      ? findOrCreatePlaceTx(deps, lat, lng)
      : null;
  insertMediaAssetTx(ctx.db, {
    assetId,
    contentId,
    kind: input.kind ?? assetKindFor(minted.mediaType),
    capturedAt: input.captured_at ?? meta.captured_at ?? null,
    tzOffsetMin:
      input.tz_offset_min ??
      (meta as { tz_offset_min?: number }).tz_offset_min ??
      null,
    captureGroupId: input.capture_group_id ?? null,
    // Edit lineage (#711). Only the caller knows it — nothing in the bytes says
    // "I was cropped out of that one" — so there is deliberately no fallback.
    sourceAssetId: input.source_asset_id ?? null,
    placeId,
    width: input.width ?? meta.width ?? null,
    height: input.height ?? meta.height ?? null,
    durationS: input.duration_s ?? meta.duration_s ?? null,
    exifJson: exifJsonForMeta(meta),
  });
  // Perceptual hash (#299 §2, Tier 0): producer-agnostic like thumbs. Derived
  // data in a sidecar; near-duplicates are one vault_hamming JOIN away.
  const contributedPhash = ctx.db
    .prepare(
      `SELECT text_content FROM core_content_derivative
        WHERE content_id = ? AND variant = 'phash'`
    )
    .get(contentId) as { text_content: string | null } | undefined;
  const phash = input.phash ?? contributedPhash?.text_content ?? undefined;
  if (phash) {
    ctx.db
      .prepare(
        `INSERT INTO media_asset_phash (asset_id, phash, computed_at) VALUES (?, ?, ?)
         ON CONFLICT (asset_id) DO UPDATE SET phash = excluded.phash, computed_at = excluded.computed_at`
      )
      .run(assetId, phash, ctx.now);
  }
  // Device-contributed ThumbHash (#419) lands ONLY in the inline derivative
  // row. Canonicalize through the staging door's validator so a client-supplied
  // value is exactly the stored form.
  if (input.thumbhash) {
    const contribution = validateDerivativeContribution({
      variant: "thumbhash",
      bytes: Buffer.from(input.thumbhash, "utf8"),
    });
    ctx.db
      .prepare(
        `INSERT INTO core_content_derivative
           (derivative_id, content_id, variant, sha256, media_type, byte_size, text_content, created_at)
         VALUES (?, ?, 'thumbhash', NULL, ?, ?, ?, ?)
         ON CONFLICT (content_id, variant) DO UPDATE SET
           text_content = excluded.text_content, byte_size = excluded.byte_size,
           media_type = excluded.media_type, created_at = excluded.created_at`
      )
      .run(
        ctx.newId(),
        contentId,
        contribution.mediaType,
        contribution.byteSize,
        contribution.textContent ?? "",
        ctx.now
      );
  }
  ctx.wrote("media.asset", assetId);
  ctx.cite({
    claim: `${minted.mediaType} (${minted.byteSize} bytes) entered the library`,
    entityType: "media.asset",
    entityId: assetId,
  });
  return { asset_id: assetId, content_id: contentId, deduped: 0 };
}

const UPDATE_ASSET: CommandDefinition = {
  name: "media.update_asset",
  ownerSchema: "media",
  inputSchema: {
    type: "object",
    required: ["asset_id"],
    additionalProperties: false,
    properties: {
      asset_id: { type: "string", minLength: 1 },
      captured_at: { type: "string" },
      // The caption lives on the canonical content item as its title.
      title: { type: "string" },
      // First-class asset state (#419): favorite and archive are boolean
      // columns so the replica shape is self-contained — no core_tag
      // reconstruction. update_asset stays the general editor.
      favorite: { type: "integer", enum: [0, 1] },
      archived: { type: "integer", enum: [0, 1] },
    },
  },
  outputSchema: {
    type: "object",
    required: ["asset_id"],
    properties: { asset_id: { type: "string" } },
  },
  preconditions: [
    {
      name: "asset_exists",
      sql: "SELECT count(*) AS n FROM media_asset WHERE asset_id = :asset_id",
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  postconditions: [
    {
      name: "edits_applied",
      sql: `SELECT (
              (SELECT CASE WHEN :captured_at IS NULL THEN 1
                           ELSE EXISTS(SELECT 1 FROM media_asset WHERE asset_id = :asset_id AND captured_at = :captured_at) END)
              AND (SELECT CASE WHEN :title IS NULL THEN 1
                           ELSE EXISTS(SELECT 1 FROM media_asset a JOIN core_content_item c ON c.content_id = a.content_id
                                        WHERE a.asset_id = :asset_id AND c.title = :title) END)
              AND (SELECT CASE WHEN :favorite IS NULL THEN 1
                           ELSE EXISTS(SELECT 1 FROM media_asset WHERE asset_id = :asset_id AND favorite = :favorite) END)
              AND (SELECT CASE WHEN :archived IS NULL THEN 1
                           WHEN :archived = 1 THEN EXISTS(SELECT 1 FROM media_asset WHERE asset_id = :asset_id AND archived_at IS NOT NULL)
                           ELSE EXISTS(SELECT 1 FROM media_asset WHERE asset_id = :asset_id AND archived_at IS NULL) END)
            ) AS n`,
      column: "n",
      op: "eq",
      value: 1,
    },
    {
      // When this edit touched favorite, the column and the canonical starred
      // tag must agree (#441); a no-op when favorite was untouched.
      name: "favorite_mirrors_tag",
      sql: `SELECT (CASE WHEN :favorite IS NULL THEN 1
                    ELSE (SELECT count(*) FROM media_asset a
                           WHERE a.asset_id = :asset_id
                             AND (a.favorite = 1) = ${starredExistsSql(CONTENT_ITEM_TARGET_TYPE, "a.content_id")})
                    END) AS n`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  idempotency: "idempotent",
  risk: "low",
  handler: updateAsset,
};

function updateAsset(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as {
    asset_id: string;
    captured_at?: string;
    title?: string;
    favorite?: number;
    archived?: number;
  };
  if (input.captured_at !== undefined) {
    ctx.db
      .prepare("UPDATE media_asset SET captured_at = ? WHERE asset_id = ?")
      .run(input.captured_at, input.asset_id);
  }
  if (input.favorite !== undefined) {
    ctx.db
      .prepare("UPDATE media_asset SET favorite = ? WHERE asset_id = ?")
      .run(input.favorite, input.asset_id);
    mirrorFavoriteToTag(ctx, input.asset_id, input.favorite);
  }
  if (input.archived !== undefined) {
    ctx.db
      .prepare("UPDATE media_asset SET archived_at = ? WHERE asset_id = ?")
      .run(input.archived === 1 ? ctx.now : null, input.asset_id);
  }
  if (input.title !== undefined) {
    ctx.db
      .prepare(
        `UPDATE core_content_item SET title = ?
          WHERE content_id = (SELECT content_id FROM media_asset WHERE asset_id = ?)`
      )
      .run(input.title, input.asset_id);
  }
  ctx.wrote("media.asset", input.asset_id);
  return { asset_id: input.asset_id };
}

const SET_ASSET_PLACE: CommandDefinition = {
  name: "media.set_asset_place",
  ownerSchema: "media",
  inputSchema: {
    type: "object",
    required: ["asset_id"],
    additionalProperties: false,
    properties: {
      asset_id: { type: "string", minLength: 1 },
      // Omitted place_id CLEARS the asset's place (#352) — the same "omit to
      // reset" convention core.move_document uses for folder_id.
      place_id: { type: "string", minLength: 1 },
    },
  },
  outputSchema: {
    type: "object",
    required: ["asset_id"],
    // place_id is string | null; the validator's `type` is a single string, so
    // it is left unconstrained. outputSchema is documentation only — never
    // runtime-validated, unlike inputSchema.
    properties: { asset_id: { type: "string" }, place_id: {} },
  },
  preconditions: [
    {
      name: "asset_exists",
      sql: "SELECT count(*) AS n FROM media_asset WHERE asset_id = :asset_id",
      column: "n",
      op: "eq",
      value: 1,
    },
    {
      name: "place_exists_if_given",
      sql: `SELECT CASE WHEN :place_id IS NULL THEN 1
               ELSE EXISTS(SELECT 1 FROM core_place WHERE place_id = :place_id) END AS n`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  postconditions: [
    {
      name: "place_applied",
      sql: `SELECT count(*) AS n FROM media_asset
             WHERE asset_id = :asset_id
               AND ((:place_id IS NULL AND place_id IS NULL) OR place_id = :place_id)`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  idempotency: "idempotent",
  risk: "low",
  handler: setAssetPlace,
};

function setAssetPlace(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { asset_id: string; place_id?: string };
  const placeId = input.place_id ?? null;
  ctx.db
    .prepare("UPDATE media_asset SET place_id = ? WHERE asset_id = ?")
    .run(placeId, input.asset_id);
  ctx.wrote("media.asset", input.asset_id);
  ctx.cite({
    claim: placeId
      ? `asset ${input.asset_id} located at place ${placeId}`
      : `asset ${input.asset_id} location cleared`,
    entityType: "media.asset",
    entityId: input.asset_id,
  });
  return { asset_id: input.asset_id, place_id: placeId };
}

/** Place kinds a member may declare. CHECK also permits `'virtual'` — not offered (not a photo location). */
const PLACE_KINDS = ["home", "work", "venue", "city", "region", "other"];

/**
 * Name a place (#816) — the write that turns a coordinate into a location. Writes `name`/`kind` only;
 * do not clear `address_json`/`geohash`/`tz` (gazetteer has its own writers). Name outranks derived name for display only.
 */
const NAME_PLACE: CommandDefinition = {
  name: "media.name_place",
  ownerSchema: "media",
  inputSchema: {
    type: "object",
    required: ["place_id", "name"],
    additionalProperties: false,
    properties: {
      place_id: { type: "string", minLength: 1 },
      // 120 is a signage ceiling, not a storage one: a heading no surface can
      // draw is not a name anybody typed on purpose.
      name: { type: "string", minLength: 1, maxLength: 120 },
      kind: { type: "string", enum: PLACE_KINDS },
    },
  },
  outputSchema: {
    type: "object",
    required: ["place_id", "name"],
    properties: {
      place_id: { type: "string" },
      name: { type: "string" },
      kind: {},
    },
  },
  preconditions: [
    {
      name: "place_exists",
      sql: "SELECT count(*) AS n FROM core_place WHERE place_id = :place_id",
      column: "n",
      op: "eq",
      value: 1,
    },
    {
      // `minLength` catches `""`; only SQL catches "   ". A whitespace name
      // reads as named everywhere and says nothing.
      name: "name_not_blank",
      sql: "SELECT CASE WHEN trim(:name) <> '' THEN 1 ELSE 0 END AS n",
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  postconditions: [
    {
      name: "name_applied",
      sql: `SELECT count(*) AS n FROM core_place
             WHERE place_id = :place_id AND name = trim(:name)
               AND (:kind IS NULL OR kind = :kind)`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  idempotency: "idempotent",
  risk: "low",
  handler: namePlace,
};

function namePlace(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { place_id: string; name: string; kind?: string };
  const name = input.name.trim();
  // Two statements rather than one COALESCE, so an absent `kind` cannot be
  // confused with a member clearing it: this command cannot say "no kind", and
  // rewriting the column on every rename would undo a declared "this is home".
  ctx.db
    .prepare("UPDATE core_place SET name = ? WHERE place_id = ?")
    .run(name, input.place_id);
  if (input.kind !== undefined) {
    ctx.db
      .prepare("UPDATE core_place SET kind = ? WHERE place_id = ?")
      .run(input.kind, input.place_id);
  }
  ctx.wrote("core.place", input.place_id);
  ctx.cite({
    claim: input.kind
      ? `place ${input.place_id} named "${name}" by the member, kind ${input.kind}`
      : `place ${input.place_id} named "${name}" by the member`,
    entityType: "core.place",
    entityId: input.place_id,
  });
  return {
    place_id: input.place_id,
    name,
    kind: input.kind ?? null,
  };
}

const DELETE_ASSET: CommandDefinition = {
  name: "media.delete_asset",
  ownerSchema: "media",
  inputSchema: {
    type: "object",
    required: ["asset_id"],
    additionalProperties: false,
    properties: { asset_id: { type: "string", minLength: 1 } },
  },
  outputSchema: {
    type: "object",
    required: ["asset_id"],
    properties: {
      asset_id: { type: "string" },
      content_released: { type: "integer" },
    },
  },
  preconditions: [
    {
      // Only a live asset can be trashed — a double-delete must fail loudly
      // rather than silently re-stamp the trash date.
      name: "asset_exists_live",
      sql: `SELECT count(*) AS n FROM media_asset
             WHERE asset_id = :asset_id AND deleted_at IS NULL`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  postconditions: [
    {
      // The standard soft-delete pair (#274): the asset carries its own grace
      // window even when its bytes stay rented elsewhere.
      name: "asset_trashed",
      sql: `SELECT count(*) AS n FROM media_asset
             WHERE asset_id = :asset_id AND deleted_at IS NOT NULL AND purge_at IS NOT NULL`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  idempotency: "once",
  risk: "low",
  handler: deleteAsset,
};

function deleteAsset(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { asset_id: string };
  const asset = ctx.db
    .prepare("SELECT content_id FROM media_asset WHERE asset_id = ?")
    .get(input.asset_id) as { content_id: string } | undefined;
  if (!asset) throw new Error("asset vanished between check and execute");
  // Collections whose cover this was fall back to their next media entry
  // (covers are content ids — the asset's canonical bytes).
  const covered = ctx.db
    .prepare(
      "SELECT collection_id FROM core_collection WHERE cover_content_id = ?"
    )
    .all(asset.content_id) as { collection_id: string }[];
  ctx.db
    .prepare(
      `DELETE FROM core_collection_entry WHERE target_type = 'media.asset' AND target_id = ?`
    )
    .run(input.asset_id);
  for (const collection of covered) {
    ctx.db
      .prepare(
        `UPDATE core_collection SET cover_content_id =
           (SELECT a.content_id FROM core_collection_entry e
              JOIN media_asset a ON a.asset_id = e.target_id
             WHERE e.collection_id = ? AND e.target_type = 'media.asset'
             ORDER BY e.position LIMIT 1)
         WHERE collection_id = ?`
      )
      .run(collection.collection_id, collection.collection_id);
    ctx.wrote("core.collection", collection.collection_id);
  }
  // The asset row only TRASHES here — restore_asset (or re-uploading the same
  // bytes) brings it back with its metadata, and the lifecycle sweep purges it
  // alongside its content once the purge date passes.
  ctx.db
    .prepare(
      "UPDATE media_asset SET deleted_at = ?, purge_at = ? WHERE asset_id = ?"
    )
    .run(ctx.now, purgeAt(ctx.now), input.asset_id);
  ctx.wrote("media.asset", input.asset_id);
  const released = releaseContentIfUnreferenced(ctx, asset.content_id);
  ctx.cite({
    claim: `asset ${input.asset_id} moved to trash; bytes ${released ? "soft-deleted" : "still rented elsewhere"}`,
    entityType: "media.asset",
    entityId: input.asset_id,
  });
  return { asset_id: input.asset_id, content_released: released ? 1 : 0 };
}

const RESTORE_ASSET: CommandDefinition = {
  name: "media.restore_asset",
  ownerSchema: "media",
  inputSchema: {
    type: "object",
    required: ["asset_id"],
    additionalProperties: false,
    properties: { asset_id: { type: "string", minLength: 1 } },
  },
  outputSchema: {
    type: "object",
    required: ["asset_id"],
    properties: { asset_id: { type: "string" } },
  },
  preconditions: [
    {
      // Restoring a live asset fails loudly — trash is the only source.
      name: "asset_is_trashed",
      sql: `SELECT count(*) AS n FROM media_asset
             WHERE asset_id = :asset_id AND deleted_at IS NOT NULL`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  postconditions: [
    {
      name: "asset_live_with_live_content",
      sql: `SELECT count(*) AS n FROM media_asset a
             JOIN core_content_item c ON c.content_id = a.content_id
            WHERE a.asset_id = :asset_id AND a.deleted_at IS NULL AND a.purge_at IS NULL
              AND c.deleted_at IS NULL`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  idempotency: "once",
  risk: "low",
  handler: restoreAsset,
};

function restoreAsset(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { asset_id: string };
  const asset = ctx.db
    .prepare("SELECT content_id FROM media_asset WHERE asset_id = ?")
    .get(input.asset_id) as { content_id: string } | undefined;
  if (!asset) throw new Error("asset vanished between check and execute");
  ctx.db
    .prepare(
      "UPDATE media_asset SET deleted_at = NULL, purge_at = NULL WHERE asset_id = ?"
    )
    .run(input.asset_id);
  ctx.wrote("media.asset", input.asset_id);
  // Un-soft-delete the bytes too. Album membership is NOT restored, matching
  // the benchmark's trash model.
  ctx.db
    .prepare(
      `UPDATE core_content_item SET deleted_at = NULL, purge_at = NULL
        WHERE content_id = ? AND deleted_at IS NOT NULL`
    )
    .run(asset.content_id);
  ctx.wrote("core.content_item", asset.content_id);
  ctx.cite({
    claim: `asset ${input.asset_id} restored from trash with its bytes`,
    entityType: "media.asset",
    entityId: input.asset_id,
  });
  return { asset_id: input.asset_id };
}

/**
 * `media.purge_asset` — hard-delete an already-trashed asset (#711). No live-asset door.
 * Goes: faces, phash CASCADE, poly-refs (`cleanupPolyRefs`), cover hand-off. Bytes do NOT go here:
 * collapse content grace to now if unrented; sweep owns CAS. Independent lifecycles (#274).
 * `source_asset_id` self-FK: `no_derived_assets` refuses while any child names this source.
 * Not `confirm: true` — owner confirmation is in front of the command.
 */
const PURGE_ASSET: CommandDefinition = {
  name: "media.purge_asset",
  ownerSchema: "media",
  inputSchema: {
    type: "object",
    required: ["asset_id"],
    additionalProperties: false,
    properties: { asset_id: { type: "string", minLength: 1 } },
  },
  outputSchema: {
    type: "object",
    required: ["asset_id"],
    properties: {
      asset_id: { type: "string" },
      /** 1 when the bytes were handed to the sweep, 0 when still rented. */
      content_released: { type: "integer" },
    },
  },
  preconditions: [
    {
      name: "asset_is_trashed",
      sql: `SELECT count(*) AS n FROM media_asset
             WHERE asset_id = :asset_id AND deleted_at IS NOT NULL`,
      column: "n",
      op: "eq",
      value: 1,
      message:
        "Only a photograph that is already in the trash can be deleted forever.",
    },
    {
      name: "no_derived_assets",
      sql: `SELECT count(*) AS n FROM media_asset
             WHERE source_asset_id = :asset_id`,
      column: "n",
      op: "eq",
      value: 0,
      message:
        "An edited copy was made from this photograph. Delete the copy forever first, so its record of where it came from stays true.",
    },
  ],
  postconditions: [
    {
      name: "asset_destroyed",
      sql: "SELECT count(*) AS n FROM media_asset WHERE asset_id = :asset_id",
      column: "n",
      op: "eq",
      value: 0,
    },
    {
      // Nothing may still point at the row (#441): engine FKs, the self-FK and
      // every polymorphic mechanism in ONE predicate, so a sweep clause dropped
      // in a later edit fails here rather than in a member's library.
      name: "nothing_references_the_asset",
      sql: `SELECT (
              (SELECT count(*) FROM media_face_region WHERE asset_id = :asset_id)
            + (SELECT count(*) FROM media_asset_phash WHERE asset_id = :asset_id)
            + (SELECT count(*) FROM media_asset WHERE source_asset_id = :asset_id)
            + (SELECT count(*) FROM core_collection_entry
                WHERE target_type = 'media.asset' AND target_id = :asset_id)
            + (SELECT count(*) FROM core_tag
                WHERE target_type = 'media.asset' AND target_id = :asset_id)
            + (SELECT count(*) FROM knowledge_annotation
                WHERE target_type = 'media.asset' AND target_id = :asset_id)
            + (SELECT count(*) FROM core_link
                WHERE valid_to IS NULL
                  AND ((from_type = 'media.asset' AND from_id = :asset_id)
                    OR (to_type = 'media.asset' AND to_id = :asset_id)))
            ) AS n`,
      column: "n",
      op: "eq",
      value: 0,
    },
  ],
  idempotency: "once",
  risk: "high",
  handler: purgeAsset,
};

function purgeAsset(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { asset_id: string };
  const asset = ctx.db
    .prepare("SELECT content_id FROM media_asset WHERE asset_id = ?")
    .get(input.asset_id) as { content_id: string } | undefined;
  if (!asset) throw new Error("asset vanished between check and execute");
  // Covers hand off BEFORE the entries go, as delete_asset does: an asset can
  // be filed into an album while trashed, so membership may still exist.
  const covered = ctx.db
    .prepare(
      "SELECT collection_id FROM core_collection WHERE cover_content_id = ?"
    )
    .all(asset.content_id) as { collection_id: string }[];
  ctx.db
    .prepare(
      `DELETE FROM core_collection_entry
        WHERE target_type = 'media.asset' AND target_id = ?`
    )
    .run(input.asset_id);
  for (const collection of covered) {
    ctx.db
      .prepare(
        `UPDATE core_collection SET cover_content_id =
           (SELECT a.content_id FROM core_collection_entry e
              JOIN media_asset a ON a.asset_id = e.target_id
             WHERE e.collection_id = ? AND e.target_type = 'media.asset'
             ORDER BY e.position LIMIT 1)
         WHERE collection_id = ?`
      )
      .run(collection.collection_id, collection.collection_id);
    ctx.wrote("core.collection", collection.collection_id);
  }
  // Face regions have no ON DELETE CASCADE (the phash sidecar does), so they go
  // by hand with the same face-region poly sweep (#724) — no orphan face vector
  // may outlive the photograph it was cut from.
  const faceRegions = ctx.db
    .prepare("SELECT region_id FROM media_face_region WHERE asset_id = ?")
    .all(input.asset_id) as { region_id: string }[];
  for (const region of faceRegions)
    cleanupPolyRefs(ctx.db, ctx.now, "media.face_region", region.region_id);
  ctx.db
    .prepare("DELETE FROM media_face_region WHERE asset_id = ?")
    .run(input.asset_id);
  ctx.db
    .prepare("DELETE FROM media_asset WHERE asset_id = ?")
    .run(input.asset_id);
  cleanupPolyRefs(ctx.db, ctx.now, "media.asset", input.asset_id);
  ctx.wrote("media.asset", input.asset_id);
  const released = releaseContentNow(ctx, asset.content_id);
  ctx.cite({
    claim: `asset ${input.asset_id} deleted forever; bytes ${released ? "handed to the next storage sweep" : "still rented elsewhere"}`,
    entityType: "media.asset",
    entityId: input.asset_id,
  });
  return { asset_id: input.asset_id, content_released: released ? 1 : 0 };
}

const SET_FAVORITE: CommandDefinition = {
  name: "media.set_favorite",
  ownerSchema: "media",
  inputSchema: {
    type: "object",
    required: ["asset_id", "favorite"],
    additionalProperties: false,
    properties: {
      asset_id: { type: "string", minLength: 1 },
      favorite: { type: "integer", enum: [0, 1] },
    },
  },
  outputSchema: {
    type: "object",
    required: ["asset_id"],
    properties: { asset_id: { type: "string" }, favorite: { type: "integer" } },
  },
  preconditions: [
    {
      name: "asset_exists",
      sql: "SELECT count(*) AS n FROM media_asset WHERE asset_id = :asset_id",
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  postconditions: [
    {
      name: "favorite_applied",
      sql: "SELECT count(*) AS n FROM media_asset WHERE asset_id = :asset_id AND favorite = :favorite",
      column: "n",
      op: "eq",
      value: 1,
    },
    {
      // Column and canonical starred tag must never disagree — the column is a
      // mirror, the tag is the truth (#441).
      name: "favorite_mirrors_tag",
      sql: `SELECT count(*) AS n FROM media_asset a
             WHERE a.asset_id = :asset_id
               AND (a.favorite = 1) = ${starredExistsSql(CONTENT_ITEM_TARGET_TYPE, "a.content_id")}`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  idempotency: "idempotent",
  risk: "low",
  handler: setFavorite,
};

function setFavorite(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { asset_id: string; favorite: number };
  ctx.db
    .prepare("UPDATE media_asset SET favorite = ? WHERE asset_id = ?")
    .run(input.favorite, input.asset_id);
  mirrorFavoriteToTag(ctx, input.asset_id, input.favorite);
  ctx.wrote("media.asset", input.asset_id);
  return { asset_id: input.asset_id, favorite: input.favorite };
}

const SET_ARCHIVED: CommandDefinition = {
  name: "media.set_archived",
  ownerSchema: "media",
  inputSchema: {
    type: "object",
    required: ["asset_id", "archived"],
    additionalProperties: false,
    properties: {
      asset_id: { type: "string", minLength: 1 },
      archived: { type: "integer", enum: [0, 1] },
    },
  },
  outputSchema: {
    type: "object",
    required: ["asset_id"],
    properties: { asset_id: { type: "string" }, archived: { type: "integer" } },
  },
  preconditions: [
    {
      name: "asset_exists",
      sql: "SELECT count(*) AS n FROM media_asset WHERE asset_id = :asset_id",
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  postconditions: [
    {
      name: "archive_applied",
      sql: `SELECT count(*) AS n FROM media_asset
             WHERE asset_id = :asset_id
               AND ((:archived = 1 AND archived_at IS NOT NULL)
                 OR (:archived = 0 AND archived_at IS NULL))`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  idempotency: "idempotent",
  risk: "low",
  handler: setArchived,
};

function setArchived(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { asset_id: string; archived: number };
  ctx.db
    .prepare("UPDATE media_asset SET archived_at = ? WHERE asset_id = ?")
    .run(input.archived === 1 ? ctx.now : null, input.asset_id);
  ctx.wrote("media.asset", input.asset_id);
  return { asset_id: input.asset_id, archived: input.archived };
}

const CREATE_ALBUM: CommandDefinition = {
  name: "media.create_album",
  ownerSchema: "media",
  inputSchema: {
    type: "object",
    required: ["title"],
    additionalProperties: false,
    properties: { title: { type: "string", minLength: 1 } },
  },
  outputSchema: {
    type: "object",
    required: ["album_id"],
    properties: { album_id: { type: "string" } },
  },
  preconditions: [],
  postconditions: [
    {
      name: "album_created",
      sql: "SELECT count(*) AS n FROM core_collection WHERE collection_id = :album_id",
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  idempotency: "once",
  risk: "low",
  handler: createAlbum,
};

function createAlbum(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { title: string };
  const albumId = ctx.newId();
  ctx.db
    .prepare(
      // An album is a top-level collection; sort_order is sibling-scoped
      // (IS, not =, so NULL parents group together).
      `INSERT INTO core_collection (collection_id, owner_party_id, name, cover_content_id, parent_collection_id, sort_order, created_at)
       VALUES (?, ?, ?, NULL, NULL, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM core_collection
                                      WHERE parent_collection_id IS NULL), ?)`
    )
    .run(albumId, actorPartyId(ctx), input.title, ctx.now);
  ctx.wrote("core.collection", albumId);
  return { album_id: albumId };
}

const RENAME_ALBUM: CommandDefinition = {
  name: "media.rename_album",
  ownerSchema: "media",
  inputSchema: {
    type: "object",
    required: ["album_id", "title"],
    additionalProperties: false,
    properties: {
      album_id: { type: "string", minLength: 1 },
      title: { type: "string", minLength: 1 },
    },
  },
  outputSchema: {
    type: "object",
    required: ["album_id"],
    properties: { album_id: { type: "string" } },
  },
  preconditions: [
    {
      name: "album_exists",
      sql: "SELECT count(*) AS n FROM core_collection WHERE collection_id = :album_id",
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  postconditions: [
    {
      name: "title_applied",
      sql: "SELECT count(*) AS n FROM core_collection WHERE collection_id = :album_id AND name = :title",
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  idempotency: "idempotent",
  risk: "low",
  handler: renameAlbum,
};

function renameAlbum(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { album_id: string; title: string };
  ctx.db
    .prepare("UPDATE core_collection SET name = ? WHERE collection_id = ?")
    .run(input.title, input.album_id);
  ctx.wrote("core.collection", input.album_id);
  return { album_id: input.album_id };
}

const SET_ALBUM_COVER: CommandDefinition = {
  name: "media.set_album_cover",
  ownerSchema: "media",
  inputSchema: {
    type: "object",
    required: ["album_id", "asset_id"],
    additionalProperties: false,
    properties: {
      album_id: { type: "string", minLength: 1 },
      asset_id: { type: "string", minLength: 1 },
    },
  },
  outputSchema: {
    type: "object",
    required: ["album_id", "asset_id"],
    properties: { album_id: { type: "string" }, asset_id: { type: "string" } },
  },
  preconditions: [
    {
      name: "asset_is_album_member",
      sql: `SELECT count(*) AS n FROM core_collection_entry
             WHERE collection_id = :album_id AND target_type = 'media.asset' AND target_id = :asset_id`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  postconditions: [
    {
      name: "cover_applied",
      sql: `SELECT count(*) AS n FROM core_collection c
              JOIN media_asset a ON a.content_id = c.cover_content_id
             WHERE c.collection_id = :album_id AND a.asset_id = :asset_id`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  idempotency: "idempotent",
  risk: "low",
  handler: setAlbumCover,
};

function setAlbumCover(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { album_id: string; asset_id: string };
  ctx.db
    .prepare(
      `UPDATE core_collection SET cover_content_id =
         (SELECT content_id FROM media_asset WHERE asset_id = ?)
       WHERE collection_id = ?`
    )
    .run(input.asset_id, input.album_id);
  ctx.wrote("core.collection", input.album_id);
  return input;
}

interface AlbumSnapshot {
  album: {
    owner_party_id: string;
    name: string;
    cover_content_id: string | null;
    parent_collection_id: string | null;
    sort_order: number;
    created_at: string;
  };
  entries: Array<{
    entry_id: string;
    target_type: string;
    target_id: string;
    position: number;
    added_at: string;
  }>;
}

function albumSnapshot(ctx: HandlerCtx, albumId: string): AlbumSnapshot {
  const album = ctx.db
    .prepare(
      `SELECT owner_party_id, name, cover_content_id, parent_collection_id,
              sort_order, created_at
         FROM core_collection WHERE collection_id = ?`
    )
    .get(albumId) as AlbumSnapshot["album"] | undefined;
  if (!album) throw new Error("album not found");
  const entries = ctx.db
    .prepare(
      `SELECT entry_id, target_type, target_id, position, added_at
         FROM core_collection_entry
        WHERE collection_id = ?
        ORDER BY position, entry_id`
    )
    .all(albumId) as AlbumSnapshot["entries"];
  return { album, entries };
}

const DELETE_ALBUM: CommandDefinition = {
  name: "media.delete_album",
  ownerSchema: "media",
  inputSchema: {
    type: "object",
    required: ["album_id"],
    additionalProperties: false,
    properties: { album_id: { type: "string", minLength: 1 } },
  },
  outputSchema: {
    type: "object",
    required: ["album_id", "revision_id", "undo_until"],
    properties: {
      album_id: { type: "string" },
      revision_id: { type: "string" },
      undo_until: { type: "string" },
    },
  },
  preconditions: [
    {
      name: "album_exists",
      sql: "SELECT count(*) AS n FROM core_collection WHERE collection_id = :album_id",
      column: "n",
      op: "eq",
      value: 1,
    },
    {
      // The album surface manages flat collections only; a nested one came from
      // the notebook surface and keeps its children until they move.
      name: "album_has_no_children",
      sql: `SELECT count(*) AS n FROM core_collection
             WHERE parent_collection_id = :album_id`,
      column: "n",
      op: "eq",
      value: 0,
    },
  ],
  postconditions: [
    {
      // The curation is gone; the members it pointed at are untouched.
      name: "album_removed",
      sql: "SELECT count(*) AS n FROM core_collection WHERE collection_id = :album_id",
      column: "n",
      op: "eq",
      value: 0,
    },
  ],
  idempotency: "idempotent",
  risk: "medium",
  handler: deleteAlbum,
};

function deleteAlbum(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { album_id: string };
  const revision = recordEntityRevision(ctx, {
    entityType: "media.album",
    entityId: input.album_id,
    operation: "trash",
    snapshot: albumSnapshot(ctx, input.album_id),
  });
  ctx.db
    .prepare("DELETE FROM core_collection_entry WHERE collection_id = ?")
    .run(input.album_id);
  ctx.db
    .prepare("DELETE FROM core_collection WHERE collection_id = ?")
    .run(input.album_id);
  ctx.wrote("core.collection", input.album_id);
  return {
    album_id: input.album_id,
    revision_id: revision.revisionId,
    undo_until: revision.undoUntil,
  };
}

const RESTORE_ALBUM: CommandDefinition = {
  name: "media.restore_album",
  ownerSchema: "media",
  inputSchema: {
    type: "object",
    required: ["album_id", "revision_id"],
    additionalProperties: false,
    properties: {
      album_id: { type: "string", minLength: 1 },
      revision_id: { type: "string", minLength: 1 },
    },
  },
  outputSchema: {
    type: "object",
    required: ["album_id", "revision_id"],
    properties: {
      album_id: { type: "string" },
      revision_id: { type: "string" },
    },
  },
  preconditions: [
    {
      name: "album_is_absent",
      sql: "SELECT count(*) AS n FROM core_collection WHERE collection_id = :album_id",
      column: "n",
      op: "eq",
      value: 0,
    },
  ],
  postconditions: [
    {
      name: "album_restored",
      sql: "SELECT count(*) AS n FROM core_collection WHERE collection_id = :album_id",
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  idempotency: "once",
  risk: "low",
  handler: (ctx) => {
    const input = ctx.input as { album_id: string; revision_id: string };
    const revision = loadEntityRevision<AlbumSnapshot>(ctx, {
      entityType: "media.album",
      entityId: input.album_id,
      revisionId: input.revision_id,
    });
    const album = revision.snapshot.album;
    ctx.db
      .prepare(
        `INSERT INTO core_collection
          (collection_id, owner_party_id, name, cover_content_id,
           parent_collection_id, sort_order, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.album_id,
        album.owner_party_id,
        album.name,
        album.cover_content_id,
        album.parent_collection_id,
        album.sort_order,
        album.created_at
      );
    const insert = ctx.db.prepare(
      `INSERT INTO core_collection_entry
        (entry_id, collection_id, target_type, target_id, position, added_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const entry of revision.snapshot.entries)
      insert.run(
        entry.entry_id,
        input.album_id,
        entry.target_type,
        entry.target_id,
        entry.position,
        entry.added_at
      );
    ctx.wrote("core.collection", input.album_id);
    markEntityRevisionUndone(ctx, revision.revisionId);
    return {
      album_id: input.album_id,
      revision_id: revision.revisionId,
    };
  },
};

const ADD_TO_ALBUM: CommandDefinition = {
  name: "media.add_to_album",
  ownerSchema: "media",
  inputSchema: {
    type: "object",
    required: ["album_id", "asset_id"],
    additionalProperties: false,
    properties: {
      album_id: { type: "string", minLength: 1 },
      asset_id: { type: "string", minLength: 1 },
    },
  },
  outputSchema: {
    type: "object",
    required: ["entry_id"],
    properties: { entry_id: { type: "string" }, position: { type: "integer" } },
  },
  preconditions: [
    {
      name: "album_exists",
      sql: "SELECT count(*) AS n FROM core_collection WHERE collection_id = :album_id",
      column: "n",
      op: "eq",
      value: 1,
    },
    {
      name: "asset_exists",
      sql: "SELECT count(*) AS n FROM media_asset WHERE asset_id = :asset_id",
      column: "n",
      op: "eq",
      value: 1,
    },
    {
      // A receipted refusal beats a UNIQUE-constraint throw.
      name: "not_already_in_album",
      sql: `SELECT count(*) AS n FROM core_collection_entry
             WHERE collection_id = :album_id AND target_type = 'media.asset' AND target_id = :asset_id`,
      column: "n",
      op: "eq",
      value: 0,
    },
  ],
  postconditions: [
    {
      name: "entry_created",
      sql: `SELECT count(*) AS n FROM core_collection_entry
             WHERE collection_id = :album_id AND target_type = 'media.asset' AND target_id = :asset_id`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  idempotency: "idempotent",
  risk: "low",
  handler: addToAlbum,
};

function addToAlbum(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { album_id: string; asset_id: string };
  // Position is one ordered list per collection, across member types.
  const tail = ctx.db
    .prepare(
      "SELECT COALESCE(MAX(position) + 1, 0) AS p FROM core_collection_entry WHERE collection_id = ?"
    )
    .get(input.album_id) as { p: number };
  const entryId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO core_collection_entry (entry_id, collection_id, target_type, target_id, position, added_at)
       VALUES (?, ?, 'media.asset', ?, ?, ?)`
    )
    .run(entryId, input.album_id, input.asset_id, tail.p, ctx.now);
  ctx.wrote("core.collection_entry", entryId);
  // The first photo into a coverless collection becomes its cover — the cover
  // is the asset's canonical content item.
  ctx.db
    .prepare(
      `UPDATE core_collection SET cover_content_id =
         (SELECT content_id FROM media_asset WHERE asset_id = ?)
       WHERE collection_id = ? AND cover_content_id IS NULL`
    )
    .run(input.asset_id, input.album_id);
  return { entry_id: entryId, position: tail.p };
}

const REMOVE_FROM_ALBUM: CommandDefinition = {
  name: "media.remove_from_album",
  ownerSchema: "media",
  inputSchema: {
    type: "object",
    required: ["album_id", "asset_id"],
    additionalProperties: false,
    properties: {
      album_id: { type: "string", minLength: 1 },
      asset_id: { type: "string", minLength: 1 },
    },
  },
  outputSchema: {
    type: "object",
    required: ["album_id", "asset_id"],
    properties: { album_id: { type: "string" }, asset_id: { type: "string" } },
  },
  preconditions: [
    {
      name: "entry_exists",
      sql: `SELECT count(*) AS n FROM core_collection_entry
             WHERE collection_id = :album_id AND target_type = 'media.asset' AND target_id = :asset_id`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  postconditions: [
    {
      name: "entry_removed",
      sql: `SELECT count(*) AS n FROM core_collection_entry
             WHERE collection_id = :album_id AND target_type = 'media.asset' AND target_id = :asset_id`,
      column: "n",
      op: "eq",
      value: 0,
    },
  ],
  idempotency: "idempotent",
  risk: "low",
  handler: removeFromAlbum,
};

function removeFromAlbum(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { album_id: string; asset_id: string };
  const entry = ctx.db
    .prepare(
      `SELECT entry_id FROM core_collection_entry
        WHERE collection_id = ? AND target_type = 'media.asset' AND target_id = ?`
    )
    .get(input.album_id, input.asset_id) as { entry_id: string } | undefined;
  if (!entry) throw new Error("album entry vanished between check and execute");
  ctx.db
    .prepare("DELETE FROM core_collection_entry WHERE entry_id = ?")
    .run(entry.entry_id);
  // A cover that just left the collection hands off to the next media entry.
  const asset = ctx.db
    .prepare("SELECT content_id FROM media_asset WHERE asset_id = ?")
    .get(input.asset_id) as { content_id: string } | undefined;
  const collection = ctx.db
    .prepare(
      "SELECT cover_content_id FROM core_collection WHERE collection_id = ?"
    )
    .get(input.album_id) as { cover_content_id: string | null } | undefined;
  if (asset && collection?.cover_content_id === asset.content_id) {
    ctx.db
      .prepare(
        `UPDATE core_collection SET cover_content_id =
           (SELECT a.content_id FROM core_collection_entry e
              JOIN media_asset a ON a.asset_id = e.target_id
             WHERE e.collection_id = ? AND e.target_type = 'media.asset'
             ORDER BY e.position LIMIT 1)
         WHERE collection_id = ?`
      )
      .run(input.album_id, input.album_id);
  }
  ctx.wrote("core.collection_entry", entry.entry_id);
  return { album_id: input.album_id, asset_id: input.asset_id };
}

/**
 * Face-delete gate (#724 W5). Must cascade through every derived row keyed to that identity — no soft delete, no leftover vector.
 * Four mechanisms: `media_face_region` (both party columns), `enrich_embedding` (face_region), `enrich_derivation`, `media_face_cluster`.
 * Does NOT delete `core_party` — that is `people.trash_person`. `high` + `once` postcondition: zero rows across all four; a fifth mechanism without a clause fails the gate.
 */
const FORGET_PERSON: CommandDefinition = {
  name: "media.forget_person",
  ownerSchema: "media",
  inputSchema: {
    type: "object",
    required: ["party_id"],
    additionalProperties: false,
    properties: { party_id: { type: "string", minLength: 1 } },
  },
  outputSchema: {
    type: "object",
    required: ["party_id", "regions_forgotten"],
    properties: {
      party_id: { type: "string" },
      regions_forgotten: { type: "integer" },
      embeddings_forgotten: { type: "integer" },
    },
  },
  preconditions: [
    {
      name: "party_exists",
      sql: `SELECT count(*) AS n FROM core_party WHERE party_id = :party_id`,
      column: "n",
      op: "eq",
      value: 1,
      message:
        "That person is not in this library, so there is no face data to forget.",
    },
  ],
  postconditions: [
    {
      // The gate, in one predicate: every table that can name the party through
      // a face, counted together. A non-zero total is an incomplete cascade.
      name: "no_face_data_names_the_party",
      sql: `SELECT (
              (SELECT count(*) FROM media_face_region
                WHERE party_id = :party_id OR confirmed_by_party_id = :party_id)
            + (SELECT count(*) FROM enrich_embedding
                WHERE target_type = 'media.face_region'
                  AND target_id NOT IN (SELECT region_id FROM media_face_region))
            + (SELECT count(*) FROM enrich_derivation
                WHERE target_type = 'media.face_region'
                  AND target_id NOT IN (SELECT region_id FROM media_face_region))
            + (SELECT count(*) FROM media_face_cluster
                WHERE region_id NOT IN (SELECT region_id FROM media_face_region))
            ) AS n`,
      column: "n",
      op: "eq",
      value: 0,
    },
  ],
  // Retry-safe rather than `once`: a second call finds nothing and says so with
  // a zero count. Refusing it as a replay would leave a member unsure whether
  // the first landed with no way to make sure.
  idempotency: "retry-safe",
  risk: "high",
  confirm: true,
  handler: forgetPerson,
};

function forgetPerson(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { party_id: string };
  const regions = ctx.db
    .prepare(
      `SELECT region_id FROM media_face_region
        WHERE party_id = ? OR confirmed_by_party_id = ?
        ORDER BY region_id`
    )
    .all(input.party_id, input.party_id) as { region_id: string }[];

  const countVectors = ctx.db.prepare(
    `SELECT count(*) AS n FROM enrich_embedding
      WHERE target_type = 'media.face_region' AND target_id = ?`
  );
  let embeddings = 0;
  for (const region of regions) {
    embeddings += Number(
      (countVectors.get(region.region_id) as { n: number }).n
    );
    // Projection first (it FKs the region), then the region, then the registry
    // sweep for every polymorphic pointer — which is what carries the vectors
    // and stamps away, through the one registry complete by construction.
    ctx.db
      .prepare("DELETE FROM media_face_cluster WHERE region_id = ?")
      .run(region.region_id);
    ctx.db
      .prepare("DELETE FROM media_face_region WHERE region_id = ?")
      .run(region.region_id);
    cleanupPolyRefs(ctx.db, ctx.now, "media.face_region", region.region_id);
    // One provenance entry per forgotten region: the audit trail of a
    // destructive act is the one thing that must survive it.
    ctx.wrote("media.face_region", region.region_id);
  }
  ctx.cite({
    claim: `every face naming party ${input.party_id} was forgotten: ${regions.length} region(s), their vectors, their derivation stamps and their grouping`,
    entityType: "core.party",
    entityId: input.party_id,
  });
  return {
    party_id: input.party_id,
    regions_forgotten: regions.length,
    embeddings_forgotten: embeddings,
  };
}

export function registerMediaCommands(gateway: Gateway): void {
  gateway.registerCommand(ADD_ASSET);
  gateway.registerCommand(UPDATE_ASSET);
  gateway.registerCommand(SET_ASSET_PLACE);
  gateway.registerCommand(NAME_PLACE);
  gateway.registerCommand(SET_FAVORITE);
  gateway.registerCommand(SET_ARCHIVED);
  gateway.registerCommand(DELETE_ASSET);
  gateway.registerCommand(RESTORE_ASSET);
  gateway.registerCommand(PURGE_ASSET);
  gateway.registerCommand(CREATE_ALBUM);
  gateway.registerCommand(RENAME_ALBUM);
  gateway.registerCommand(SET_ALBUM_COVER);
  gateway.registerCommand(DELETE_ALBUM);
  gateway.registerCommand(RESTORE_ALBUM);
  gateway.registerCommand(ADD_TO_ALBUM);
  gateway.registerCommand(REMOVE_FROM_ALBUM);
  gateway.registerCommand(FORGET_PERSON);
}
