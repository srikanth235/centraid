// The machine half of naming a place (#816). `core_place.name` is the MEMBER's:
// this command never writes it or `kind`, owning only `$.gazetteer` inside
// `address_json`, and every other key there survives. A MISS IS A RESULT — with
// no `name` it writes a none-marker, or the automation's "no gazetteer key"
// selection re-examines every mid-ocean coordinate forever.

import type { Gateway } from "../gateway/gateway.js";
import type { CommandDefinition, HandlerCtx } from "../gateway/types.js";

const GAZETTEER_SOURCES = ["geonames-cities15000"];

/** Refuses what cannot be a neighbourhood claim; the recipe's radius is tighter. */
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
      // PHRASE-READY — "Truckee, CA", not "Truckee": the read side prints it
      // as it stands, so the qualifier is the writer's job.
      name: { type: "string", minLength: 1, maxLength: 120 },
      admin: { type: "string", maxLength: 16 },
      country: { type: "string", maxLength: 2 },
      distance_km: { type: "number", minimum: 0, maximum: MAX_DISTANCE_KM },
      source: { type: "string", enum: GAZETTEER_SOURCES },
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
      // `checked_at` is what the re-scan keys off. `core_place.name` surviving
      // is pinned by test: no postcondition sees a pre-value.
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
        // A stored `""` reads as "checked, none", not "not a fact here".
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

/** Its own pack: the split makes "the machine never touches `name`" readable. */
export function registerMediaGazetteerCommands(gateway: Gateway): void {
  gateway.registerCommand(SET_PLACE_GAZETTEER);
}
