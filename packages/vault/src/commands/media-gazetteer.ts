// The derived-naming half of a place (issue #816).
//
// `media.name_place` in `media.ts` is where a MEMBER says what a place is
// called. This is the only other writer of a place's name-ish facts, and it is
// a machine: the opt-in `place-names` automation looks a coordinate up in a
// bundled settlement table on the member's own device and records what it found.
//
// THE TWO CLAIMS DO NOT COMPETE, so they do not share a column. "Grandma's
// house" and "Truckee, CA" are both true about the same point; the first is
// what the member calls it and the second is where it is. `core_place.name` is
// the member's, full stop — this command never writes it, never writes `kind`,
// and the read side (place-phrase.ts) ranks a member name above a derived one
// for display without either erasing the other. What this command owns is one
// key inside `address_json`:
//
//     { "gazetteer": { "name", "admin", "country", "distance_km",
//                      "source", "snapshot", "checked_at" } }
//
// A MISS IS A RESULT, NOT A GAP. Omit `name` and the record becomes
// `{ "checked_at": …, "none": true }` with the same source/snapshot stamps.
// Without that marker the automation's "places with no gazetteer key" selection
// would re-examine every mid-ocean and mid-desert coordinate on every fire,
// forever, and a bounded batch would never make progress past the first one.
//
// EVERY OTHER KEY IN `address_json` SURVIVES. The blob is shared with whatever
// wrote a street address, so the write is a merge of one key, done in SQL with
// `json_set` so the merge and the row's `json_valid` constraint are the same
// transaction.

import type { Gateway } from "../gateway/gateway.js";
import type { CommandDefinition, HandlerCtx } from "../gateway/types.js";

/** Where a gazetteer record may have come from. One vendored dataset today. */
const GAZETTEER_SOURCES = ["geonames-cities15000"];

/**
 * A settlement centroid may sit this far from the coordinate and still name it.
 *
 * The ceiling here is the CONTRACT, deliberately looser than the automation's
 * own 50 km acceptance radius (`packages/model-runtime/src/gazetteer.ts`): the
 * command's job is to refuse a distance that cannot be a neighbourhood claim at
 * all, not to re-litigate the recipe's judgement about where "near" stops. A
 * later engine may reasonably want a different radius; a value past this one is
 * not a radius, it is a bug.
 */
const MAX_DISTANCE_KM = 200;

const SET_PLACE_GAZETTEER: CommandDefinition = {
  name: "media.set_place_gazetteer",
  ownerSchema: "media",
  inputSchema: {
    type: "object",
    required: ["place_id", "source"],
    additionalProperties: false,
    properties: {
      place_id: { type: "string", minLength: 1 },
      // The PHRASE-READY display form — "Truckee, CA", not "Truckee". The read
      // side (`apps/photos/queries/_shared.ts`) prints `gazetteer.name` as it
      // stands, behind "near", so composing the qualifier is the writer's job
      // and this column is what a member will actually read. `admin` and
      // `country` below carry the same facts structurally, for a caller that
      // needs the parts rather than the sentence.
      //
      // Absent `name` = "nothing within range", recorded as the none-marker.
      // The 120-char ceiling is `media.name_place`'s: the two strings land in
      // the same headings, so they get the same signage limit.
      name: { type: "string", minLength: 1, maxLength: 120 },
      /** Two-letter state code where the dataset has a readable one. */
      admin: { type: "string", maxLength: 16 },
      /** ISO 3166-1 alpha-2. */
      country: { type: "string", maxLength: 2 },
      distance_km: { type: "number", minimum: 0, maximum: MAX_DISTANCE_KM },
      source: { type: "string", enum: GAZETTEER_SOURCES },
      /** The dataset snapshot the answer came from, as an ISO date. */
      snapshot: { type: "string", minLength: 1, maxLength: 32 },
    },
  },
  outputSchema: {
    type: "object",
    required: ["place_id", "matched"],
    properties: {
      place_id: { type: "string" },
      matched: { type: "boolean" },
      name: {},
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
  ],
  postconditions: [
    {
      // The record landed — a hit and a none-marker both stamp `checked_at`,
      // which is the field the automation's re-scan selection keys off, so it
      // is the one worth asserting. That `core_place.name` survives is a
      // property of the UPDATE naming one column and is pinned by test rather
      // than by SQL: no postcondition can compare against a pre-value.
      name: "gazetteer_recorded",
      sql: `SELECT count(*) AS n FROM core_place
             WHERE place_id = :place_id
               AND json_extract(address_json, '$.gazetteer.checked_at') IS NOT NULL`,
      column: "n",
      op: "eq",
      value: 1,
    },
  ],
  idempotency: "idempotent",
  risk: "low",
  handler: setPlaceGazetteer,
};

interface GazetteerInput {
  place_id: string;
  name?: string;
  admin?: string;
  country?: string;
  distance_km?: number;
  source: string;
  snapshot?: string;
}

function setPlaceGazetteer(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as unknown as GazetteerInput;
  const name = input.name?.trim() ?? "";
  const matched = name !== "";
  const record: Record<string, unknown> = matched
    ? {
        name,
        // Absent rather than empty: outside the United States the vendored
        // dataset has no readable admin code (see gazetteer-data.ts), and a
        // stored `""` would read as "checked, none" instead of "not a fact
        // this dataset carries".
        ...(input.admin === undefined || input.admin.trim() === ""
          ? {}
          : { admin: input.admin.trim() }),
        ...(input.country === undefined || input.country.trim() === ""
          ? {}
          : { country: input.country.trim() }),
        ...(input.distance_km === undefined
          ? {}
          : { distance_km: input.distance_km }),
        source: input.source,
        ...(input.snapshot === undefined ? {} : { snapshot: input.snapshot }),
        checked_at: ctx.now,
      }
    : {
        none: true,
        source: input.source,
        ...(input.snapshot === undefined ? {} : { snapshot: input.snapshot }),
        checked_at: ctx.now,
      };
  // `json_set` on `coalesce(address_json, '{}')` merges into whatever else the
  // blob holds and replaces only this key. A place with no address blob yet
  // gains one containing exactly this record.
  ctx.db
    .prepare(
      `UPDATE core_place
          SET address_json = json_set(
                coalesce(address_json, '{}'), '$.gazetteer', json(?))
        WHERE place_id = ?`
    )
    .run(JSON.stringify(record), input.place_id);
  ctx.wrote("core.place", input.place_id);
  ctx.cite({
    claim: matched
      ? `place ${input.place_id} is near ${name} per ${input.source}`
      : `place ${input.place_id} has no settlement within range per ${input.source}`,
    entityType: "core.place",
    entityId: input.place_id,
  });
  return {
    place_id: input.place_id,
    matched,
    ...(matched ? { name } : {}),
  };
}

/**
 * Register the derived place-naming command.
 *
 * A pack of its own rather than a tenth command in `media.ts` because the
 * member-authority rule is the whole point of the seam: one file is where a
 * person names a place, this one is where a machine annotates it, and the split
 * is what makes "the machine never touches `name`" checkable by reading a file
 * instead of auditing a function.
 */
export function registerMediaGazetteerCommands(gateway: Gateway): void {
  gateway.registerCommand(SET_PLACE_GAZETTEER);
}
