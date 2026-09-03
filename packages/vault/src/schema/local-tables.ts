import { AUDIT_BAND_TABLES } from "./audit.js";
import { LEDGER_BAND_TABLES } from "./ledger.js";

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
  ["core_entity", "the supertype index, re-derived from the entity tables"],
  ["core_entity_kind", "the kind vocabulary, re-seeded from the registry"],
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
  ["replica_change", "the change log itself — the mechanism, not the data"],
  ["replica_meta", "this vault's replica epoch, floor and trigger marker"],
  ["replica_intent_outcome", "device-scoped outcome of one submitted intent"],
  ["replica_invocation_commit", "the commit group one invocation wrote"],
  ["replica_parked_payload", "a sealed request awaiting the member's answer"],
  [
    "locker_auth_credential",
    "this installation's unlock credential, by ruling",
  ],
]);
