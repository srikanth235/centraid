// The deliberately unregistered half of vault.db (#916, ruling ONT-15). The
// entity catalog next door is the allow-list of what the ontology CONTAINS;
// this is the closed list of what it deliberately does NOT, so "unregistered"
// is a declaration with a reason rather than the absence of one.
//
// TWO WHOLE BANDS ARE EXCLUDED BY BAND, not table by table: `audit` and
// `ledger`, the two append-heavy bands that joined the one file under #916.
// Both are named from their band modules (`AUDIT_BAND_TABLES`,
// `LEDGER_BAND_TABLES`) so adding a table to either cannot silently add it to
// the portable export or to the replica — the exclusion follows the band.

import { AUDIT_BAND_TABLES } from "./audit.js";
import { LEDGER_BAND_TABLES } from "./ledger.js";

/**
 * The closed list of physical tables that live in vault.db and are
 * DELIBERATELY unregistered (#916, ruling ONT-15).
 *
 * An unregistered table is outside the canonical walk: no export, no replica
 * change-log trigger, no consent scope, no Atlas census. That is the right
 * answer for exactly two classes — bytes-and-transport internals that are
 * local to this device, and state a restore must NOT hand back — and the
 * wrong answer everywhere else, which is why #872 registered the locker
 * sidecars that had fallen out of it by accident. Until now the reason lived
 * in a per-file comment; here it is a declaration, so `lifecycle.test.ts` can
 * assert that every physical non-FTS table in a fresh vault is EITHER
 * registered OR named below, and a table that is neither fails the build
 * rather than going quietly missing from an export.
 *
 * Keyed by physical table name; the value is why it is out, in one clause.
 */
const BAND_EXCLUSIONS: [string, string][] = [
  ...AUDIT_BAND_TABLES.map(
    (t) =>
      [
        t,
        "the `audit` band — append-only evidence, never exported or replicated",
      ] as [string, string]
  ),
  ...LEDGER_BAND_TABLES.map(
    (t) =>
      [t, "the `ledger` band — the engine's conversation transcript"] as [
        string,
        string,
      ]
  ),
];

export const LOCAL_TABLES: ReadonlyMap<string, string> = new Map([
  ...BAND_EXCLUSIONS,
  // The entity supertype and its kind vocabulary (#916, rung ten). Both are
  // DERIVED: `core_entity` is rewritten row for row by the membership triggers
  // as a restore re-inserts the entity tables (carrying each row's own
  // `created_at`), and `core_entity_kind` is re-seeded from the registry on
  // every open. Registering them as a machinery band was not available — a
  // band's name is the physical prefix, and `core` is an ontology pack. See
  // schema/entity.ts.
  ["core_entity", "the supertype index, re-derived from the entity tables"],
  ["core_entity_kind", "the kind vocabulary, re-seeded from the registry"],
  // Content-addressed storage internals: what this device holds, where it put
  // it, and which key wraps it. A restore re-derives all of it from the bytes.
  ["blob_access", "local last-touch bookkeeping for cache eviction"],
  ["blob_content_key", "the wrapped per-object key, which never leaves"],
  ["blob_device_content_key", "one device's copy of a wrapped object key"],
  ["blob_device_wrap_key", "one device's key-wrapping salt and epoch"],
  ["blob_ingress_probe", "head/tail bytes of an upload still in flight"],
  [
    "blob_ingress_session",
    "an upload in flight — resumable on this device only",
  ],
  ["blob_orphan", "when this device first saw bytes with no live reference"],
  ["blob_outbox", "this device's queue of objects still to be replicated"],
  ["blob_replica", "which objects this device has proven are also remote"],
  ["blob_staging", "bytes staged for a command that has not committed yet"],
  // The replica protocol's own plane. Its whole job is to describe changes to
  // registered rows; a change log inside the export it feeds would be a loop.
  ["replica_change", "the change log itself — the mechanism, not the data"],
  ["replica_meta", "this vault's replica epoch, floor and trigger marker"],
  ["replica_intent_outcome", "device-scoped outcome of one submitted intent"],
  ["replica_invocation_commit", "the commit group one invocation wrote"],
  ["replica_parked_payload", "a sealed request awaiting the member's answer"],
  // `share_commons_device_reach`, `_steward_contact`, `_supersession` and
  // `_verified` LEFT this list (#916, R8 / review 6.4). They were here as
  // "device observation", but they are Commons CONTROL truth: a restore
  // without them hands back a seat that has forgotten which op hashes it
  // verified, which recovery it is the successor of, and how far behind its
  // steward it had fallen — and being unregistered also meant no replica
  // change-log trigger, so none of it reached a second device. They are
  // registered entities of the `share` band now.
  // By ruling (L-alias's neighbour, decisions.md): the locker's own unlock
  // credential is how THIS installation is opened, not a secret it holds.
  [
    "locker_auth_credential",
    "this installation's unlock credential, by ruling",
  ],
]);
