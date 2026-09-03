/* oxlint-disable no-await-in-loop -- bounded vault walks preserve cursor and typed-write order */
/*
 * PLACE NAMES — rung 2 of the phrase ladder, off until a member turns it on.
 *
 * Reads places that have a coordinate and no gazetteer record yet, finds the
 * nearest settlement in a table bundled into this handler, and writes what it
 * found through `media.set_place_gazetteer`. That command writes one key inside
 * `address_json` and never `core_place.name`: a member's name for a place
 * outranks this and is never overwritten.
 *
 * NOTHING LEAVES THE DEVICE. This handler has no `ctx.fetch`, no `ctx.delegate`,
 * no import that opens a socket, and no import that touches the filesystem —
 * the dataset is a string constant inside the bundle. That is not a policy this
 * file promises, it is a property of what it links, and `place-names.test.ts`
 * asserts it against the bundled source rather than trusting the sentence.
 * Reverse geocoding as a service would answer better and would also be a live
 * feed of where a member sleeps, works, and takes their children; the trade is
 * not on offer here.
 *
 * WHY IT SHIPS DISABLED. A derived name is a guess about a place, and guessing
 * is the member's call to authorise, not the release's. `automation.json` says
 * `enabled: false`, and for the bundled recognition recipes the scheduler
 * honours exactly that bit: `build-gateway.ts`'s reconcile filters system
 * recognition rows on `row.enabled`, so a disabled recipe holds no scheduler
 * registration and bootstraps no data cursor while it is off.
 */
import {
  GAZETTEER_MAX_KM,
  GAZETTEER_SNAPSHOT,
  GAZETTEER_SOURCE,
  nearestSettlement,
} from "../src/gazetteer.js";

const BATCH = 64;
const PURPOSE = "dpv:ServiceProvision";

/** Does this row already carry a gazetteer verdict (a hit OR a miss)? */
function alreadyChecked(addressJson) {
  if (typeof addressJson !== "string" || addressJson === "") return false;
  let parsed;
  try {
    parsed = JSON.parse(addressJson);
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== "object") return false;
  const gazetteer = parsed.gazetteer;
  if (gazetteer === null || typeof gazetteer !== "object") return false;
  return (
    typeof gazetteer.checked_at === "string" && gazetteer.checked_at !== ""
  );
}

export default async function handler({ ctx, log }) {
  const priorSnapshot = await ctx.state.get("snapshot");
  if (priorSnapshot !== GAZETTEER_SNAPSHOT) {
    await ctx.state.set("cursor", "");
    await ctx.state.set("snapshot", GAZETTEER_SNAPSHOT);
  }
  const cursor = (await ctx.state.get("cursor")) ?? "";
  const read = await ctx.vault.read({
    entity: "core.place",
    where: [{ column: "place_id", op: "gt", value: cursor }],
    orderBy: { column: "place_id", dir: "asc" },
    limit: BATCH,
    purpose: PURPOSE,
  });
  const rows = read.rows ?? [];
  let named = 0;
  let none = 0;
  let skipped = 0;
  for (const place of rows) {
    const lat = place.geo_lat == null ? Number.NaN : Number(place.geo_lat);
    const lng = place.geo_lng == null ? Number.NaN : Number(place.geo_lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      skipped += 1;
      continue;
    }
    if (alreadyChecked(place.address_json)) {
      skipped += 1;
      continue;
    }
    const hit = nearestSettlement(lat, lng, GAZETTEER_MAX_KM);
    if (hit === null) {
      await ctx.vault.invoke({
        command: "media.set_place_gazetteer",
        input: {
          place_id: place.place_id,
          source: GAZETTEER_SOURCE,
          snapshot: GAZETTEER_SNAPSHOT,
        },
        purpose: PURPOSE,
      });
      none += 1;
      continue;
    }
    await ctx.vault.invoke({
      command: "media.set_place_gazetteer",
      input: {
        place_id: place.place_id,
        name: hit.displayName,
        ...(hit.admin === "" ? {} : { admin: hit.admin }),
        ...(hit.country === "" ? {} : { country: hit.country }),
        distance_km: hit.distanceKm,
        source: GAZETTEER_SOURCE,
        snapshot: GAZETTEER_SNAPSHOT,
      },
      purpose: PURPOSE,
    });
    log.info(`place ${place.place_id}: near ${hit.displayName}`);
    named += 1;
  }
  const last = rows.at(-1)?.place_id;
  if (last) await ctx.state.set("cursor", last);
  return {
    summary:
      `named ${named} places; ${none} with no settlement within ` +
      `${GAZETTEER_MAX_KM} km; skipped ${skipped}; bounded batch ` +
      `${rows.length}/${BATCH}`,
    output: {
      named,
      none,
      skipped,
      snapshot: GAZETTEER_SNAPSHOT,
      rearm: rows.length === BATCH,
    },
  };
}
