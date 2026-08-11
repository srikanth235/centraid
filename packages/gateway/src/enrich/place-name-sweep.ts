// The place-name spec: what the generic capability sweep needs to turn a
// coordinate into somewhere a person recognises.
//
// THE PROBLEM THIS ANSWERS. `findOrCreatePlaceTx` (packages/vault, media.ts)
// mints a place row the moment a photograph arrives carrying GPS, and names it
// with its own coordinates — "39.0021, -120.1131" — because a command handler
// makes no network egress and had nothing better to say. That is correct and
// it is unreadable: the Places shelf came out as a column of numbers, which
// looks like an unbuilt feature and is really an unanswered question.
//
// WHY IT RIDES THIS SEAM. Every other capability here hands a model some of
// the owner's content; this one hands it two numbers the vault already
// computed. It belongs anyway, because it needs precisely the three things
// this seam provides and nothing else in the gateway does: an offline
// gazetteer far too heavy to ship inside a client, a versioned model id so a
// better index supersedes an older one's answers through the ordinary backfill
// rather than a migration, and a consent tier that decides whether it runs at
// all. The alternative was a sixth mechanism with its own config and its own
// failure vocabulary — which is exactly what issue #724 deleted.
//
// PHOTOS DOMAIN. A place row is minted by a photograph's GPS and read by the
// Photos shelf, and the question "may this gateway derive things from my
// photographs" is the one an owner already answered for pixels. Consent is
// read BEFORE the service is probed (see capability-sweep.ts), so a vault at
// `off` or `device` produces no request and no traffic — which matters more
// here than anywhere else in this file, because a coordinate leaving a host
// is the exact thing this product promises does not happen. It never does:
// `CENTRAID_ENRICH_URL` must resolve to loopback or the client reads the
// gateway as unconfigured.
//
// WHAT IT WILL NOT OVERWRITE. Only rows still wearing a coordinate label are
// ever renamed. A place the member named, or one adopted from elsewhere in the
// vault, is a human fact and outranks any gazetteer — so the backlog query
// carries the label shape as a SQL predicate rather than trusting the sweep
// to check afterwards. Getting that backwards would let a model quietly
// rename someone's "Home".

import type { VaultDb } from "@centraid/vault";

import { selectOpenRequests } from "./capability-sweep.js";
import type {
  CapabilitySweepApply,
  CapabilitySweepBacklog,
  CapabilitySweepSpec,
  CapabilitySweepTarget,
} from "./capability-sweep.js";

/** Place rows are keyed by `place_id`; this is how `enrich_derivation`
 *  records what family the target belongs to. */
const TARGET_TYPE = "core_place";

/** What `enrich_request.required_capability` calls an ask for this. */
const REQUEST_CAPABILITIES = ["place-name"] as const;

/**
 * A place row whose name is only its own coordinates, as SQL.
 *
 * SQLite has no regular expressions, so the shape is matched with GLOB: an
 * optional minus, digits, a dot, digits, a comma, a space, and the same
 * again. It has to agree with `isCoordinateLabel` in packages/vault's
 * media.ts, which is the function that WRITES these labels — the two are a
 * pair, and a change to the minted format has to move both. Kept as a
 * predicate in the query rather than a filter in JS so a vault full of named
 * places does not pay to read them all every pass.
 */
const COORDINATE_LABEL_GLOB = "[-0-9]*[0-9].[0-9]*, [-0-9]*[0-9].[0-9]*";

interface PlaceRow {
  place_id: string;
  geo_lat: number;
  geo_lng: number;
}

/**
 * Write the name onto the place row.
 *
 * A direct UPDATE rather than a command invocation, unlike the OCR sweep's
 * `core.set_extracted_text`: there is no `core.rename_place` verb in the
 * command surface to call (see `media.set_asset_place`'s doc comment — the
 * app plane can point an asset AT a place, never mint or rename one), and
 * inventing a whole owner-facing command as a side effect of a background
 * sweep would be a bigger claim than this issue is making. The write is
 * narrow and it runs inside the sweep's own transaction, alongside the
 * derivation stamp — same as every other spec's `apply`.
 */
function applyPlaceName(
  db: VaultDb,
  input: CapabilitySweepApply<"place-name">
): unknown {
  const { name, region } = input.result;
  // HONEST EMPTY. An index with nothing near an ocean coordinate answers
  // `null`, and that still stamps — the target is done, this model has
  // nothing to say about it, and the backfill must not return to it every
  // pass forever. Writing "Unknown" instead would be a fabricated name in a
  // section head, indistinguishable from a real one.
  if (name === null) return { named: false };

  // The guard is repeated here even though the backlog query already carries
  // it. Between selection and write sits a network round trip, and a member
  // who named this place during it must win — the query is an optimisation,
  // this is the rule.
  const updated = db.vault
    .prepare(
      `UPDATE core_place
          SET name = ?
        WHERE place_id = ?
          AND (name IS NULL OR trim(name) = '' OR name GLOB ?)`
    )
    .run(name, input.target.id, COORDINATE_LABEL_GLOB);
  if (updated.changes === 0)
    return { named: false, reason: "renamed-by-owner" };
  return {
    named: true,
    name,
    ...(region == null ? {} : { region }),
    ...(input.result.confidence === undefined
      ? {}
      : { confidence: input.result.confidence }),
  };
}

/**
 * Coordinate-labelled places → a human name, on the shared sweep.
 *
 * A plain spec object rather than a factory: unlike the OCR and transcript
 * specs this one needs no `Gateway` and no credential, because it writes one
 * column on one row rather than driving a command through the pipeline.
 */
export const PLACE_NAME_SWEEP_SPEC: CapabilitySweepSpec<"place-name"> = {
  capability: "place-name",
  policyDomain: "photos",
  targetType: TARGET_TYPE,
  variant: "name",

  selectBacklog: (db: VaultDb, input): CapabilitySweepBacklog => {
    const requests = selectOpenRequests(db, {
      targetType: TARGET_TYPE,
      capabilityNames: REQUEST_CAPABILITIES,
      limit: input.limit,
      now: input.now,
    });

    const backfillLimit = Math.max(0, input.limit - requests.order.length);
    // Places that HAVE coordinates, are still wearing a coordinate label, and
    // carry no stamp from the model running now — either never named, or
    // named by a gazetteer this one supersedes.
    const backfill = (
      db.vault
        .prepare(
          `SELECT p.place_id AS place_id
             FROM core_place p
             LEFT JOIN enrich_derivation d
               ON d.target_type = ? AND d.target_id = p.place_id
                  AND d.variant = 'name' AND d.model = ?
            WHERE p.geo_lat IS NOT NULL AND p.geo_lng IS NOT NULL
              AND (p.name IS NULL OR trim(p.name) = ''
                   OR p.name GLOB ?)
              AND d.derivation_id IS NULL
            ORDER BY p.place_id
            LIMIT ?`
        )
        .all(
          TARGET_TYPE,
          input.model,
          COORDINATE_LABEL_GLOB,
          backfillLimit
        ) as unknown as { place_id: string }[]
    ).map((row) => row.place_id);
    const exhausted = backfillLimit > 0 && backfill.length < backfillLimit;

    const targets: CapabilitySweepTarget[] = [
      ...requests.order.map((id) => ({
        id,
        requestIds: requests.byTarget.get(id) ?? [],
      })),
      ...backfill
        .filter((id) => !requests.byTarget.has(id))
        .map((id) => ({ id, requestIds: [] })),
    ];
    return { targets, domainRequestIds: requests.domain, exhausted };
  },

  // No blob is read and no `await` is needed, but the signature is the shared
  // one — a spec that returned a bare value would be the only one of six with
  // a different contract, for no gain.
  buildItem: async (db: VaultDb, target: CapabilitySweepTarget) => {
    const row = db.vault
      .prepare(
        `SELECT place_id, geo_lat, geo_lng FROM core_place WHERE place_id = ?`
      )
      .get(target.id) as PlaceRow | undefined;
    // A place whose coordinates vanished between selection and here is a skip,
    // not a failure: the row is simply no longer answerable.
    if (
      !row ||
      typeof row.geo_lat !== "number" ||
      typeof row.geo_lng !== "number"
    )
      return null;
    return { id: target.id, lat: row.geo_lat, lng: row.geo_lng };
  },

  apply: applyPlaceName,
};
