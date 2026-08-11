// governance: allow-repo-hygiene file-size-limit one command pack per domain is the vault contract (registered as a unit, read wholesale); media owns the whole library loop (9 commands with their contracts), so it is large by design.
// Media domain commands (§08): the command pack the Photos projection was
// parked on. An asset is meaning over bytes — media_media_asset decorates a
// canonical core_content_item (sha256-deduped data: URI, same custody as
// attachments) with capture time and dimensions; an album is a surface view
// over core_collection, the one owner-curation mechanism (issue #274) — the
// album commands keep their contracts while storage unifies, so a
// collection may also hold documents and notes. Deleting an asset removes
// the meaning rows and
// soft-deletes the bytes only when nothing else (an attachment, a note body,
// an avatar) still rents them — content items are canonical and shared, so
// the last reference decides, not the first delete. Purging (issue #711) is
// the owner's way to end that grace window early — see PURGE_ASSET for what
// it destroys, what it refuses, and why the bytes go to the sweep.

import type { DatabaseSync } from "node:sqlite";

import { validateDerivativeContribution } from "../blob/derivatives.js";
import {
  MAX_INLINE_DATA_URI_CHARS,
  mintContentFromDataUri,
} from "../blob/mint.js";
import type { Gateway } from "../gateway/gateway.js";
import type { CommandDefinition, HandlerCtx } from "../gateway/types.js";
import { cleanupPolyRefs } from "../schema/poly-refs.js";
import {
  loadEntityRevision,
  markEntityRevisionUndone,
  recordEntityRevision,
} from "./entity-revisions.js";
import { setStarred, starredExistsSql } from "./flags.js";
import { assertInlineDataUriWithinBudget } from "./inline-body-guard.js";

// The starred flag rides the CANONICAL content item, not the asset row (issue
// #274 kink 1 / #441 A2.1): favoriting a photo must surface it in every "what
// I starred" query — Docs' Starred section, the agent, the briefing — exactly
// as Docs/Locker/People/Social already do. media_media_asset.favorite stays as
// the Photos replica read model but becomes a mirror with a single writer: the
// tag is the truth, the column is a derived cache, and a postcondition asserts
// the two agree after every toggle.
const CONTENT_ITEM_TARGET_TYPE = "core.content_item";

/** Mirror the favorite bit onto the content item's starred flags tag. */
function mirrorFavoriteToTag(
  ctx: HandlerCtx,
  assetId: string,
  favorite: number
): void {
  const row = ctx.db
    .prepare("SELECT content_id FROM media_media_asset WHERE asset_id = ?")
    .get(assetId) as { content_id: string } | undefined;
  if (!row) return;
  setStarred(ctx, CONTENT_ITEM_TARGET_TYPE, row.content_id, favorite === 1);
}

/** Soft-deleted bytes linger this long before the lifecycle sweep purges. */
const PURGE_AFTER_DAYS = 30;

/** The acting party: the caller's own party, else the vault owner (apps). */
function actorPartyId(ctx: HandlerCtx): string {
  if (ctx.identity.partyId) return ctx.identity.partyId;
  const owner = ctx.db
    .prepare("SELECT owner_party_id FROM core_vault LIMIT 1")
    .get() as { owner_party_id: string | null } | undefined;
  if (!owner?.owner_party_id) throw new Error("vault has no owner");
  return owner.owner_party_id;
}

/**
 * What a media write needs when it runs OUTSIDE the command pipeline (issue
 * #721). The import spine's publishers hold a raw `DatabaseSync` and a
 * provenance collector instead of a `HandlerCtx`, but a photograph arriving
 * from a Takeout archive must become the SAME row, by the same rules, as one
 * arriving through `media.add_asset`. So every primitive below takes these
 * four things; the command handlers pass `ctx`, the publisher passes its own.
 */
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

/**
 * Round to ~11m precision (4 decimal places) for find-or-create IDENTITY —
 * photos taken a few meters apart at "the same place" share one core_place
 * row instead of minting a new one per shutter click. The row itself keeps
 * the PRECISE coordinates of whichever asset created it (issue #352).
 */
function roundCoord(v: number): number {
  return Math.round(v * 10_000) / 10_000;
}

/**
 * How close a photograph has to be to a place the member ALREADY NAMED before
 * it is treated as having been taken there, in degrees of latitude — about
 * 170 metres.
 *
 * Wide enough to cover a house and its garden, a school and its field, an
 * office and its car park: a photograph taken in the back yard should join
 * "Home", not mint "37.4419, -122.1430" beside it. Narrow enough that the next
 * building along is a different place. It is deliberately far looser than the
 * ~11m identity rung below, because these are two different questions — that
 * one asks "is this the same coordinate", this one asks "is this that place".
 */
const NAMED_PLACE_RADIUS_DEG = 0.0015;

/**
 * A place row whose name is just its own coordinates, e.g. "37.4419,
 * -122.1430". These are the labels this function mints when nothing better is
 * known, and they must NOT be treated as names — adopting one would spread a
 * meaningless string across a whole neighbourhood, and the geocoding sweep
 * looks for exactly this shape to find the rows still waiting for a real name.
 */
export function isCoordinateLabel(name: string | null | undefined): boolean {
  return /^-?\d{1,3}\.\d+,\s*-?\d{1,3}\.\d+$/u.test((name ?? "").trim());
}

/**
 * Find-or-create the core_place an asset's GPS names.
 *
 * Three steps, in falling order of how much the vault actually knows:
 *
 *   1. A place the member has NAMED, within ~170m. This is the one that makes
 *      Places readable on day one without any geocoding at all: the vault
 *      already holds named places from the rest of the product — a home, an
 *      office, a venue on an event — and a photograph taken at one of them
 *      belongs to it. Anything else means a member who has carefully named
 *      where they live still gets a shelf of coordinates.
 *   2. The exact rounded coordinate (~11m), which is the identity rung that
 *      keeps a burst of frames from minting a row per shutter click.
 *   3. Failing both, a new row labelled with its own coordinates. Reverse
 *      geocoding does not happen here — a command handler makes no network
 *      egress, and offline geocoding is the enrichment service's job (the
 *      `place-name` capability), which renames these rows later.
 *
 * `geo_lat`/`geo_lng` on a fresh row stay PRECISE; only identity is rounded.
 */
export function findOrCreatePlaceTx(
  deps: MediaWriteDeps,
  lat: number,
  lng: number
): string {
  const rLat = roundCoord(lat);
  const rLng = roundCoord(lng);
  // Step 1. A bounding box, not a great-circle distance: SQLite has no
  // trigonometry without an extension, the box is indexable, and at this
  // radius the difference between a box and a circle is metres. Longitude is
  // divided by the cosine of the latitude so the box stays roughly square on
  // the ground instead of stretching east-west as it moves north.
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

/**
 * The columns the spool learned from the bytes, minus the raw text feed —
 * the camera's testimony, kept whole on the asset row. Shared so an import
 * and an upload record the same testimony in the same shape.
 */
export function exifJsonForMeta(meta: Record<string, unknown>): string | null {
  const exif = Object.fromEntries(
    Object.entries(meta).filter(([k, v]) => k !== "text" && v !== undefined)
  );
  return Object.keys(exif).length > 0 ? JSON.stringify(exif) : null;
}

/** One row of `media_media_asset` — the shape both writers fill in. */
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

/**
 * The ONE insert into `media_media_asset`. Both doors into the library —
 * `media.add_asset` and the import spine's publisher — write through here, so
 * a column added to the table can never land on one path and not the other.
 */
export function insertMediaAssetTx(
  vault: DatabaseSync,
  row: MediaAssetRow
): void {
  vault
    .prepare(
      `INSERT INTO media_media_asset (asset_id, content_id, kind, captured_at, tz_offset_min, capture_group_id, source_asset_id, place_id, camera_device_id, width, height, duration_s, exif_json, deleted_at)
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

/**
 * `media_media_asset.content_id` is UNIQUE — the same bytes are one asset. If
 * an asset already owns this content item, adopt it instead of minting a
 * second: a trashed one comes back to life (re-upload = restore), and a
 * capture group learned later COALESCE-merges onto it, which is how a Live
 * Photo whose video half arrives in a second import completes its pair.
 *
 * Deliberately does NOT stamp `source_asset_id` (issue #711): these bytes
 * already ARE that asset, so this call created nothing to have a lineage.
 * Overwriting an existing asset's provenance from a later arrival would
 * rewrite history, and the honest record of a dedupe is that it deduped.
 *
 * Returns the adopted asset id, or null when these bytes are new here.
 */
export function adoptAssetForContentTx(
  deps: MediaWriteDeps,
  contentId: string,
  captureGroupId: string | null
): string | null {
  const existing = deps.vault
    .prepare(
      "SELECT asset_id, deleted_at, capture_group_id FROM media_media_asset WHERE content_id = ?"
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
        `UPDATE media_media_asset
            SET deleted_at = NULL,
                purge_at = NULL,
                capture_group_id = COALESCE(capture_group_id, ?)
          WHERE asset_id = ?`
      )
      .run(captureGroupId, existing.asset_id);
    deps.wrote("media.media_asset", existing.asset_id);
  }
  return existing.asset_id;
}

/**
 * Every canonical table that can rent a content item besides the media
 * asset itself. The last reference decides whether bytes soft-delete.
 */
const CONTENT_REFERENCES: {
  table: string;
  column: string;
  onlyLive?: string;
}[] = [
  { table: "core_attachment", column: "content_id" },
  { table: "core_party", column: "avatar_content_id" },
  // A trashed note is not a rental (issue #308 A6) — its body releases with
  // it, and knowledge.restore_note un-trashes both.
  {
    table: "knowledge_note",
    column: "body_content_id",
    onlyLive: "deleted_at IS NULL",
  },
  { table: "social_message", column: "body_content_id" },
  { table: "business_invoice", column: "pdf_content_id" },
  { table: "home_warranty", column: "terms_content_id" },
  { table: "home_maintenance_plan", column: "instructions_content_id" },
  // A trashed asset is not a rental — it must not keep its bytes alive, or
  // trash could never release anything.
  {
    table: "media_media_asset",
    column: "content_id",
    onlyLive: "deleted_at IS NULL",
  },
  // A document's CURRENT content is a rental like any other (issue #352).
  // Superseded revisions are NOT covered here — they are protected by the
  // dedicated chain-aware check the document purge pass runs instead
  // (gateway/duties.ts), because "still part of some live document's
  // history" cannot be expressed as a single-column FK lookup. A trashed
  // document still lives (only purge releases it, see documents.ts).
  { table: "core_document", column: "current_content_id" },
];

/** True when no canonical row still points at this content item. */
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

/**
 * Collapse a content item's grace window to NOW when nothing rents it any
 * more, so the next lifecycle sweep purges the row, its derivatives and its
 * CAS blobs (`purgeContentItem` in gateway/duties.ts). This is how an
 * owner-driven purge frees bytes: a command handler cannot delete from the
 * CAS itself, and deleting the row here would strand the blob with nothing
 * left to drive its reclamation. Bytes still rented elsewhere are untouched.
 */
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
      // Capture-local UTC offset in minutes (issue #419): the client reads it
      // off the same EXIF the capture time came from.
      tz_offset_min: { type: "integer", minimum: -1080, maximum: 1080 },
      capture_group_id: { type: "string", minLength: 1, maxLength: 200 },
      // Edit lineage (issue #711): the asset these bytes were derived FROM.
      // The photo editor saves an edit as a new asset dated today, and this
      // is what makes that copy's provenance a fact instead of a promise.
      source_asset_id: { type: "string", minLength: 1, maxLength: 200 },
      title: { type: "string" },
      width: { type: "integer", minimum: 1 },
      height: { type: "integer", minimum: 1 },
      duration_s: { type: "number", minimum: 0 },
      // WHERE THIS WAS TAKEN, asserted by the caller rather than read out of
      // the bytes. Every other spool-derived field on this command already
      // has an explicit override — capture time, dimensions, duration, the
      // timezone offset — and the coordinate pair was the one that did not,
      // which meant the inline door (`data_uri`) could never produce a place
      // at all: `spoolMeta` is `{}` unless the bytes came through staging, so
      // Places was unreachable for anything a caller uploaded inline.
      //
      // This is an ASSERTION, not an extraction, and the distinction is the
      // whole reason it is safe to accept here. The media.location policy
      // gate in the staging pipeline exists to drop GPS the owner chose not
      // to keep when it is read OUT of a file; a caller typing a coordinate
      // is stating a fact it already holds, exactly as it states a capture
      // time. Spool metadata still wins nothing it did not win before —
      // explicit input takes precedence, same as every field above.
      latitude: { type: "number", minimum: -90, maximum: 90 },
      longitude: { type: "number", minimum: -180, maximum: 180 },
      // Perceptual hash (issue #299 §2, Tier 0) — hex, producer-agnostic:
      // the client canvas computes a dHash beside its thumb today.
      phash: {
        type: "string",
        minLength: 4,
        maxLength: 64,
        pattern: "^[0-9a-f]+$",
      },
      // ThumbHash placeholder (issue #419) — unpadded base64, produced beside
      // the client's thumb from the same decode; lands as an inline derivative.
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
      // A coordinate is a PAIR. Half of one is not a weaker location, it is
      // no location at all, and silently dropping it would let a caller
      // believe it had placed a photograph it had not. Refuse instead.
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
      // The inline door is for SMALL payloads (issue #296): a 4K video takes
      // the staging route, never command JSON (the journal records inputs).
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
      // A claimed source must be a real asset in THIS vault (issue #711).
      // Named here rather than left to the FK so a caller that mistypes a
      // lineage gets a refusal that says which precondition failed, not a
      // raw constraint error from the middle of the insert.
      name: "source_asset_exists",
      sql: `SELECT CASE WHEN :source_asset_id IS NULL THEN 1 ELSE
              EXISTS(SELECT 1 FROM media_media_asset WHERE asset_id = :source_asset_id) END AS n`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  postconditions: [
    {
      name: "asset_backed_by_content",
      sql: `SELECT count(*) AS n FROM media_media_asset a
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
  // Staged claims carry spool metadata (issue #296 §4): the gateway sniffed
  // the type and read EXIF server-side, so capture time and dimensions no
  // longer depend on the caller supplying them. Explicit input still wins.
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
  // GPS from the spool already passed the media.location policy gate at
  // staging time (pipeline.ts) — those coordinates only ride here when the
  // owner kept them. An explicit pair wins over the spool's, like every other
  // field on this command; see the schema note for why asserting a coordinate
  // is a different act from extracting one.
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
    // Edit lineage (issue #711). Only the caller knows it — nothing in the
    // bytes or the EXIF says "I was cropped out of that one" — so there is
    // no spool fallback here on purpose.
    sourceAssetId: input.source_asset_id ?? null,
    placeId,
    width: input.width ?? meta.width ?? null,
    height: input.height ?? meta.height ?? null,
    durationS: input.duration_s ?? meta.duration_s ?? null,
    exifJson: exifJsonForMeta(meta),
  });
  // Perceptual hash (issue #299 §2, Tier 0): producer-agnostic like thumbs —
  // the client canvas computes a dHash beside its thumbnail today. Derived
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
  // Device-contributed ThumbHash (issue #419): lands ONLY in the inline
  // derivative row (no sidecar). Canonicalize through the same validator the
  // staging door uses so a client-supplied value is exactly the stored form.
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
  ctx.wrote("media.media_asset", assetId);
  ctx.cite({
    claim: `${minted.mediaType} (${minted.byteSize} bytes) entered the library`,
    entityType: "media.media_asset",
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
      // First-class asset state (issue #419): favorite and archive are now
      // boolean columns on the asset itself so the replica shape is
      // self-contained — no core_tag reconstruction. set_favorite/set_archived
      // are the focused toggles; update_asset stays the general editor.
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
      sql: "SELECT count(*) AS n FROM media_media_asset WHERE asset_id = :asset_id",
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
                           ELSE EXISTS(SELECT 1 FROM media_media_asset WHERE asset_id = :asset_id AND captured_at = :captured_at) END)
              AND (SELECT CASE WHEN :title IS NULL THEN 1
                           ELSE EXISTS(SELECT 1 FROM media_media_asset a JOIN core_content_item c ON c.content_id = a.content_id
                                        WHERE a.asset_id = :asset_id AND c.title = :title) END)
              AND (SELECT CASE WHEN :favorite IS NULL THEN 1
                           ELSE EXISTS(SELECT 1 FROM media_media_asset WHERE asset_id = :asset_id AND favorite = :favorite) END)
              AND (SELECT CASE WHEN :archived IS NULL THEN 1
                           WHEN :archived = 1 THEN EXISTS(SELECT 1 FROM media_media_asset WHERE asset_id = :asset_id AND archived_at IS NOT NULL)
                           ELSE EXISTS(SELECT 1 FROM media_media_asset WHERE asset_id = :asset_id AND archived_at IS NULL) END)
            ) AS n`,
      column: "n",
      op: "eq",
      value: 1,
    },
    {
      // When this edit touched favorite, the column and the canonical starred
      // tag must agree (issue #441 A2.1); a no-op when favorite was untouched.
      name: "favorite_mirrors_tag",
      sql: `SELECT (CASE WHEN :favorite IS NULL THEN 1
                    ELSE (SELECT count(*) FROM media_media_asset a
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
      .prepare(
        "UPDATE media_media_asset SET captured_at = ? WHERE asset_id = ?"
      )
      .run(input.captured_at, input.asset_id);
  }
  if (input.favorite !== undefined) {
    ctx.db
      .prepare("UPDATE media_media_asset SET favorite = ? WHERE asset_id = ?")
      .run(input.favorite, input.asset_id);
    mirrorFavoriteToTag(ctx, input.asset_id, input.favorite);
  }
  if (input.archived !== undefined) {
    ctx.db
      .prepare(
        "UPDATE media_media_asset SET archived_at = ? WHERE asset_id = ?"
      )
      .run(input.archived === 1 ? ctx.now : null, input.asset_id);
  }
  if (input.title !== undefined) {
    ctx.db
      .prepare(
        `UPDATE core_content_item SET title = ?
          WHERE content_id = (SELECT content_id FROM media_media_asset WHERE asset_id = ?)`
      )
      .run(input.title, input.asset_id);
  }
  ctx.wrote("media.media_asset", input.asset_id);
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
      // Omitted place_id clears the asset's place (issue #352) — the same
      // "omit to reset" convention core.move_document uses for folder_id.
      place_id: { type: "string", minLength: 1 },
    },
  },
  outputSchema: {
    type: "object",
    required: ["asset_id"],
    // place_id is string | null (cleared) — the validator's `type` is a
    // single string (json-schema.ts), so left unconstrained here; outputSchema
    // is documentation only (never runtime-validated, unlike inputSchema).
    properties: { asset_id: { type: "string" }, place_id: {} },
  },
  preconditions: [
    {
      name: "asset_exists",
      sql: "SELECT count(*) AS n FROM media_media_asset WHERE asset_id = :asset_id",
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
      sql: `SELECT count(*) AS n FROM media_media_asset
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
    .prepare("UPDATE media_media_asset SET place_id = ? WHERE asset_id = ?")
    .run(placeId, input.asset_id);
  ctx.wrote("media.media_asset", input.asset_id);
  ctx.cite({
    claim: placeId
      ? `asset ${input.asset_id} located at place ${placeId}`
      : `asset ${input.asset_id} location cleared`,
    entityType: "media.media_asset",
    entityId: input.asset_id,
  });
  return { asset_id: input.asset_id, place_id: placeId };
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
      // Only a live asset can be trashed — a double-delete fails loudly
      // instead of silently re-stamping the trash date.
      name: "asset_exists_live",
      sql: `SELECT count(*) AS n FROM media_media_asset
             WHERE asset_id = :asset_id AND deleted_at IS NULL`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  postconditions: [
    {
      // The standard soft-delete pair (issue #274): the asset carries its
      // own grace window even when its bytes stay rented elsewhere.
      name: "asset_trashed",
      sql: `SELECT count(*) AS n FROM media_media_asset
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
    .prepare("SELECT content_id FROM media_media_asset WHERE asset_id = ?")
    .get(input.asset_id) as { content_id: string } | undefined;
  if (!asset) throw new Error("asset vanished between check and execute");
  // Collections whose cover this was fall back to their next remaining
  // media entry (covers are content ids — the asset's canonical bytes).
  const covered = ctx.db
    .prepare(
      "SELECT collection_id FROM core_collection WHERE cover_content_id = ?"
    )
    .all(asset.content_id) as { collection_id: string }[];
  ctx.db
    .prepare(
      `DELETE FROM core_collection_entry WHERE target_type = 'media.media_asset' AND target_id = ?`
    )
    .run(input.asset_id);
  for (const collection of covered) {
    ctx.db
      .prepare(
        `UPDATE core_collection SET cover_content_id =
           (SELECT a.content_id FROM core_collection_entry e
              JOIN media_media_asset a ON a.asset_id = e.target_id
             WHERE e.collection_id = ? AND e.target_type = 'media.media_asset'
             ORDER BY e.position LIMIT 1)
         WHERE collection_id = ?`
      )
      .run(collection.collection_id, collection.collection_id);
    ctx.wrote("core.collection", collection.collection_id);
  }
  // The asset row itself only trashes — restore_asset (or re-uploading the
  // same bytes) brings it back with its metadata; the lifecycle sweep purges
  // it alongside its content once the purge date passes.
  ctx.db
    .prepare(
      "UPDATE media_media_asset SET deleted_at = ?, purge_at = ? WHERE asset_id = ?"
    )
    .run(ctx.now, purgeAt(ctx.now), input.asset_id);
  ctx.wrote("media.media_asset", input.asset_id);
  const released = releaseContentIfUnreferenced(ctx, asset.content_id);
  ctx.cite({
    claim: `asset ${input.asset_id} moved to trash; bytes ${released ? "soft-deleted" : "still rented elsewhere"}`,
    entityType: "media.media_asset",
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
      sql: `SELECT count(*) AS n FROM media_media_asset
             WHERE asset_id = :asset_id AND deleted_at IS NOT NULL`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  postconditions: [
    {
      name: "asset_live_with_live_content",
      sql: `SELECT count(*) AS n FROM media_media_asset a
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
    .prepare("SELECT content_id FROM media_media_asset WHERE asset_id = ?")
    .get(input.asset_id) as { content_id: string } | undefined;
  if (!asset) throw new Error("asset vanished between check and execute");
  ctx.db
    .prepare(
      "UPDATE media_media_asset SET deleted_at = NULL, purge_at = NULL WHERE asset_id = ?"
    )
    .run(input.asset_id);
  ctx.wrote("media.media_asset", input.asset_id);
  // Un-soft-delete the bytes too — same path the re-upload restore takes.
  // Album membership is not restored, matching the benchmark's trash model.
  ctx.db
    .prepare(
      `UPDATE core_content_item SET deleted_at = NULL, purge_at = NULL
        WHERE content_id = ? AND deleted_at IS NOT NULL`
    )
    .run(asset.content_id);
  ctx.wrote("core.content_item", asset.content_id);
  ctx.cite({
    claim: `asset ${input.asset_id} restored from trash with its bytes`,
    entityType: "media.media_asset",
    entityId: input.asset_id,
  });
  return { asset_id: input.asset_id };
}

/**
 * `media.purge_asset` — destroy one ALREADY-TRASHED asset now, instead of
 * waiting out its 30-day grace window (issue #711). This is the only
 * owner-driven hard delete in the media pack, and everything about its shape
 * follows from that:
 *
 *  * ONLY TRASH. `asset_is_trashed` demands `deleted_at IS NOT NULL`, so a
 *    live asset — or an id that names nothing — is REFUSED by name rather
 *    than skipped. There is no "purge anything" door; the trash is the door.
 *  * WHAT GOES. Face regions (derived data about these pixels), the phash
 *    sidecar (`ON DELETE CASCADE`), and every polymorphic pointer at the
 *    asset — album membership, tags, annotations, attachments, embeddings,
 *    sync-map rows, shares — via the A1 registry (`cleanupPolyRefs`), which
 *    is the same complete sweep the lifecycle purge runs. An album whose
 *    cover this was hands off to its next member first, exactly as
 *    `delete_asset` does, so the album goes on having a face.
 *  * WHAT DOES NOT GO: THE BYTES, HERE. A command handler has no CAS delete
 *    (`HandlerCtx.blobs` stages, claims and spills — it never reclaims), and
 *    deleting `core_content_item` from here would strand its blob with no row
 *    left to drive `purgeContentItem`. So the bytes are handed to the sweep
 *    that owns them: the content item's grace window is collapsed to NOW when
 *    nothing else rents it, and the next lifecycle sweep purges the row,
 *    its derivatives and its blobs together. The member's copy says exactly
 *    this — the photograph leaves the library at once, the bytes are
 *    reclaimed by the next storage sweep. Bytes still rented by an
 *    attachment, an avatar or a note body are left alone: asset meaning and
 *    byte custody have independent lifecycles (issue #274).
 *  * EDIT LINEAGE. `media_media_asset.source_asset_id` (issue #711) is a
 *    self-FK, and a purge that broke it would have to either forge or destroy
 *    a fact. NULLing the child's column is a forgery: the schema says NULL
 *    means "camera original or import", so a cropped copy would start
 *    claiming it was shot that way. Cascading the purge into the child
 *    destroys a photograph the member never put in the trash. So the third
 *    option is the honest one — `no_derived_assets` REFUSES while any other
 *    asset still names this one as its source, live or trashed, and says so.
 *    The member purges the edit first; `emptyTrashOrder` on both clients puts
 *    derived copies ahead of their sources so a trash holding both empties in
 *    one pass. (`PRAGMA foreign_keys` is ON, so the DELETE would fail anyway
 *    — a named refusal beats a raw constraint string.)
 *
 * Not `confirm: true`. Parking would mean a member pressing "Empty trash"
 * got a queue of decisions instead of an empty trash — the confirmation for
 * an owner-initiated destruction belongs in front of the owner, before the
 * command fires, which is where both clients put it. `atlas.delete_row`, the
 * other owner-driven hard delete, is `risk: "high"` without `confirm` for the
 * same reason.
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
      sql: `SELECT count(*) AS n FROM media_media_asset
             WHERE asset_id = :asset_id AND deleted_at IS NOT NULL`,
      column: "n",
      op: "eq",
      value: 1,
      message:
        "Only a photograph that is already in the trash can be deleted forever.",
    },
    {
      name: "no_derived_assets",
      sql: `SELECT count(*) AS n FROM media_media_asset
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
      sql: "SELECT count(*) AS n FROM media_media_asset WHERE asset_id = :asset_id",
      column: "n",
      op: "eq",
      value: 0,
    },
    {
      // Nothing may still point at the row (issue #441 A1). Engine FKs, the
      // self-FK, and every polymorphic mechanism in one predicate: a sweep
      // clause quietly dropped in a later edit fails here rather than in a
      // member's library six months on.
      name: "nothing_references_the_asset",
      sql: `SELECT (
              (SELECT count(*) FROM media_face_region WHERE asset_id = :asset_id)
            + (SELECT count(*) FROM media_asset_phash WHERE asset_id = :asset_id)
            + (SELECT count(*) FROM media_media_asset WHERE source_asset_id = :asset_id)
            + (SELECT count(*) FROM core_collection_entry
                WHERE target_type = 'media.media_asset' AND target_id = :asset_id)
            + (SELECT count(*) FROM core_tag
                WHERE target_type = 'media.media_asset' AND target_id = :asset_id)
            + (SELECT count(*) FROM knowledge_annotation
                WHERE target_type = 'media.media_asset' AND target_id = :asset_id)
            + (SELECT count(*) FROM core_link
                WHERE valid_to IS NULL
                  AND ((from_type = 'media.media_asset' AND from_id = :asset_id)
                    OR (to_type = 'media.media_asset' AND to_id = :asset_id)))
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
    .prepare("SELECT content_id FROM media_media_asset WHERE asset_id = ?")
    .get(input.asset_id) as { content_id: string } | undefined;
  if (!asset) throw new Error("asset vanished between check and execute");
  // Album covers hand off BEFORE the entries go, exactly as delete_asset
  // does: an asset can be filed into an album while it sits in the trash, so
  // membership is not guaranteed to have been dropped at trash time.
  const covered = ctx.db
    .prepare(
      "SELECT collection_id FROM core_collection WHERE cover_content_id = ?"
    )
    .all(asset.content_id) as { collection_id: string }[];
  ctx.db
    .prepare(
      `DELETE FROM core_collection_entry
        WHERE target_type = 'media.media_asset' AND target_id = ?`
    )
    .run(input.asset_id);
  for (const collection of covered) {
    ctx.db
      .prepare(
        `UPDATE core_collection SET cover_content_id =
           (SELECT a.content_id FROM core_collection_entry e
              JOIN media_media_asset a ON a.asset_id = e.target_id
             WHERE e.collection_id = ? AND e.target_type = 'media.media_asset'
             ORDER BY e.position LIMIT 1)
         WHERE collection_id = ?`
      )
      .run(collection.collection_id, collection.collection_id);
    ctx.wrote("core.collection", collection.collection_id);
  }
  // Face regions have no ON DELETE CASCADE (the phash sidecar does), so they
  // go by hand — the same pair the lifecycle sweep deletes in duties.ts, with
  // the same face-region poly sweep (issue #724 W5) so no orphan face vector
  // outlives the photograph it was cut from.
  const faceRegions = ctx.db
    .prepare("SELECT region_id FROM media_face_region WHERE asset_id = ?")
    .all(input.asset_id) as { region_id: string }[];
  for (const region of faceRegions)
    cleanupPolyRefs(ctx.db, ctx.now, "media.face_region", region.region_id);
  ctx.db
    .prepare("DELETE FROM media_face_region WHERE asset_id = ?")
    .run(input.asset_id);
  ctx.db
    .prepare("DELETE FROM media_media_asset WHERE asset_id = ?")
    .run(input.asset_id);
  cleanupPolyRefs(ctx.db, ctx.now, "media.media_asset", input.asset_id);
  ctx.wrote("media.media_asset", input.asset_id);
  const released = releaseContentNow(ctx, asset.content_id);
  ctx.cite({
    claim: `asset ${input.asset_id} deleted forever; bytes ${released ? "handed to the next storage sweep" : "still rented elsewhere"}`,
    entityType: "media.media_asset",
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
      sql: "SELECT count(*) AS n FROM media_media_asset WHERE asset_id = :asset_id",
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  postconditions: [
    {
      name: "favorite_applied",
      sql: "SELECT count(*) AS n FROM media_media_asset WHERE asset_id = :asset_id AND favorite = :favorite",
      column: "n",
      op: "eq",
      value: 1,
    },
    {
      // The column and the canonical starred tag must never disagree — the
      // column is a mirror, the tag is the truth (issue #441 A2.1).
      name: "favorite_mirrors_tag",
      sql: `SELECT count(*) AS n FROM media_media_asset a
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
    .prepare("UPDATE media_media_asset SET favorite = ? WHERE asset_id = ?")
    .run(input.favorite, input.asset_id);
  mirrorFavoriteToTag(ctx, input.asset_id, input.favorite);
  ctx.wrote("media.media_asset", input.asset_id);
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
      sql: "SELECT count(*) AS n FROM media_media_asset WHERE asset_id = :asset_id",
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  postconditions: [
    {
      name: "archive_applied",
      sql: `SELECT count(*) AS n FROM media_media_asset
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
    .prepare("UPDATE media_media_asset SET archived_at = ? WHERE asset_id = ?")
    .run(input.archived === 1 ? ctx.now : null, input.asset_id);
  ctx.wrote("media.media_asset", input.asset_id);
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
             WHERE collection_id = :album_id AND target_type = 'media.media_asset' AND target_id = :asset_id`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  postconditions: [
    {
      name: "cover_applied",
      sql: `SELECT count(*) AS n FROM core_collection c
              JOIN media_media_asset a ON a.content_id = c.cover_content_id
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
         (SELECT content_id FROM media_media_asset WHERE asset_id = ?)
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
      // The album surface only manages flat collections; a nested one came
      // from the notebook surface and keeps its children until they move.
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
      sql: "SELECT count(*) AS n FROM media_media_asset WHERE asset_id = :asset_id",
      column: "n",
      op: "eq",
      value: 1,
    },
    {
      // A receipted refusal beats a UNIQUE-constraint throw.
      name: "not_already_in_album",
      sql: `SELECT count(*) AS n FROM core_collection_entry
             WHERE collection_id = :album_id AND target_type = 'media.media_asset' AND target_id = :asset_id`,
      column: "n",
      op: "eq",
      value: 0,
    },
  ],
  postconditions: [
    {
      name: "entry_created",
      sql: `SELECT count(*) AS n FROM core_collection_entry
             WHERE collection_id = :album_id AND target_type = 'media.media_asset' AND target_id = :asset_id`,
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
       VALUES (?, ?, 'media.media_asset', ?, ?, ?)`
    )
    .run(entryId, input.album_id, input.asset_id, tail.p, ctx.now);
  ctx.wrote("core.collection_entry", entryId);
  // The first photo into a coverless collection becomes its cover — the
  // cover is the asset's canonical content item.
  ctx.db
    .prepare(
      `UPDATE core_collection SET cover_content_id =
         (SELECT content_id FROM media_media_asset WHERE asset_id = ?)
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
             WHERE collection_id = :album_id AND target_type = 'media.media_asset' AND target_id = :asset_id`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  postconditions: [
    {
      name: "entry_removed",
      sql: `SELECT count(*) AS n FROM core_collection_entry
             WHERE collection_id = :album_id AND target_type = 'media.media_asset' AND target_id = :asset_id`,
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
        WHERE collection_id = ? AND target_type = 'media.media_asset' AND target_id = ?`
    )
    .get(input.album_id, input.asset_id) as { entry_id: string } | undefined;
  if (!entry) throw new Error("album entry vanished between check and execute");
  ctx.db
    .prepare("DELETE FROM core_collection_entry WHERE entry_id = ?")
    .run(entry.entry_id);
  // A cover that just left the collection hands off to the next media entry.
  const asset = ctx.db
    .prepare("SELECT content_id FROM media_media_asset WHERE asset_id = ?")
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
              JOIN media_media_asset a ON a.asset_id = e.target_id
             WHERE e.collection_id = ? AND e.target_type = 'media.media_asset'
             ORDER BY e.position LIMIT 1)
         WHERE collection_id = ?`
      )
      .run(input.album_id, input.album_id);
  }
  ctx.wrote("core.collection_entry", entry.entry_id);
  return { album_id: input.album_id, asset_id: input.asset_id };
}

/**
 * THE FACE-DELETE GATE (issue #724 W5; SECURITY.md, "Derived data and
 * sensitive enrichments"). Face data is the most sensitive derived class this
 * product holds, and the condition for shipping face detection at all was that
 * "delete this person" provably cascades through every derived row keyed to
 * that identity — not soft-deletes, not hides, not leaves a vector behind that
 * a later search can resurface.
 *
 * WHAT IT FORGETS, AND WHY THAT IS FOUR TABLES AND NOT ONE. A person's face
 * data is spread across four mechanisms, each of which is enough on its own to
 * reconstruct the fact this command destroys:
 *
 *   - `media_face_region` — the boxes. Both party columns are matched, not
 *     just `party_id`: a row the member CONFIRMED carries their identity in
 *     `confirmed_by_party_id` too, and a cascade that cleared one column would
 *     leave the other saying the person is in the photograph.
 *   - `enrich_embedding` (`media.face_region` targets) — the vectors. An
 *     orphan face vector is the worst leftover of the four: it is the thing
 *     that lets a NEW photograph of the same person be matched back to them
 *     after they were forgotten.
 *   - `enrich_derivation` — the stamps. Left behind, they tell the next sweep
 *     those regions are current, so the faces are never re-derived and the
 *     member's own library disagrees with itself about whether it looked.
 *   - `media_face_cluster` — the grouping projection. Rebuildable, but a stale
 *     row names a deleted region as a group member.
 *
 * WHAT IT DOES NOT DO. It does not delete the `core_party`. Forgetting who is
 * in your photographs and deleting a person from your address book are two
 * different acts, and conflating them would make the destructive one a side
 * effect of the reversible one. `people.trash_person` owns the other.
 *
 * WHY `high` AND WHY A `once`-SHAPED POSTCONDITION. There is no undo: the
 * vectors are gone and the boxes with them. An agent proposing it parks for
 * the owner, structurally, exactly as `sync.set_connection_trust` does. The
 * postcondition asserts ZERO rows across all four tables — the same
 * "nothing may still point at the row" shape `media.purge_asset` uses, so a
 * fifth mechanism added later without a clause here fails at the gate rather
 * than in a member's library six months on.
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
      // The gate, in one predicate. Every table that can name the party
      // through a face, counted together: a non-zero total is an incomplete
      // cascade and the command refuses to commit.
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
  // Retry-safe rather than `once`: a second call finds nothing left and says
  // so with a zero count. Refusing it as a replay would leave a member who is
  // unsure whether the first one landed with no way to make sure.
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
    // The projection first (it FKs the region), then the region, then the
    // registry sweep for every polymorphic pointer at it — which is what
    // carries the vectors and the stamps away, through the one registry that
    // is complete by construction rather than by a remembered clause here.
    ctx.db
      .prepare("DELETE FROM media_face_cluster WHERE region_id = ?")
      .run(region.region_id);
    ctx.db
      .prepare("DELETE FROM media_face_region WHERE region_id = ?")
      .run(region.region_id);
    cleanupPolyRefs(ctx.db, ctx.now, "media.face_region", region.region_id);
    // One provenance entry per forgotten region — the audit trail of a
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

/** Register the media domain's commands on a gateway. */
export function registerMediaCommands(gateway: Gateway): void {
  gateway.registerCommand(ADD_ASSET);
  gateway.registerCommand(UPDATE_ASSET);
  gateway.registerCommand(SET_ASSET_PLACE);
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
