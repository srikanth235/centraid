// WHAT NEVER LEAVES THE GATEWAY (#996, ruling R3).
//
// A seat holds `vault.db` WHOLE — no row filters, no field masks, no app
// composition (R1). "Private" is therefore not a predicate evaluated per row;
// it is a CLOSED LIST OF TABLES, declared here as data so the snapshot
// builder, the capture side and the canary test all read the same list rather
// than three copies of the same judgement.
//
// THREE KINDS, AND ONLY THREE. Credentials and key material; the gateway's own
// job machinery; peer-link state. Everything else replicates — including the
// `audit` and `ledger` bands (OQ-1), and including `agent_command_invocation`,
// which five replicated tables key into (`access_receipt`,
// `agent_invocation_check`, `agent_evidence`, `agent_explanation` and
// `core_entity_revision.invocation_id`). Making that one private would break
// the single property this list exists to preserve: NO REPLICATED TABLE
// REFERENCES A PRIVATE ONE, so a seat's copy satisfies its own foreign keys.
// `assertNoReplicatedReferencesToPrivate` is that property as a test.
//
// A TABLE WITH REPLICATED REFERENCES IS SPLIT, NOT DROPPED. `access_device`
// and `access_agent` carry both an identity a replicated row points at and key
// material that must not travel, so each is split into a replicated identity
// projection and a private sibling (`schema/access.ts`); the sibling's name is
// on this list, the projection is not.

import type { DatabaseSync } from "node:sqlite";

import { prepared } from "../grant/prepared.js";

export type PrivateTableKind = "credential" | "gateway-job" | "peer-link";

export interface PrivateTableDeclaration {
  readonly table: string;
  readonly kind: PrivateTableKind;
  /** Why it stays on the gateway, in one clause. */
  readonly reason: string;
}

/**
 * The closed list, BY KIND. The kind is a property of the group, so it is
 * stated once and each table under it carries only its own one-clause reason;
 * ordered by kind, then by name inside a kind, so a diff of this file reads as
 * a decision rather than as a merge artefact.
 */
const PRIVATE_TABLES_BY_KIND: Readonly<
  Record<PrivateTableKind, Readonly<Record<string, string>>>
> = {
  // credentials and key material
  credential: {
    access_agent_secret: "an enrolled agent's host-side enrollment key",
    access_device_secret:
      "a device's public key and its gateway-side sync cursor",
    blob_content_key: "the wrapped per-object content key",
    blob_device_content_key: "one device's copy of a wrapped object key",
    blob_device_wrap_key: "one device's key-wrapping salt and epoch",
    locker_key:
      "which Locker key this gateway holds, and when it retired the one before",
    sync_connection_credential: "a third-party connection's stored secret",
  },
  // the gateway's own job machinery
  "gateway-job": {
    blob_access: "last-touch bookkeeping for THIS host's cache eviction",
    blob_ingress_probe: "head/tail bytes of an upload still in flight",
    blob_ingress_session: "an upload in flight — resumable on the gateway only",
    blob_outbox: "the gateway's queue of objects still to be replicated",
    blob_staging: "bytes staged for a command that has not committed yet",
    blob_orphan: "when THIS host first saw bytes with no live reference",
    blob_replica: "which objects THIS host has proven are also remote",
    conversation_harness_sessions: "a harness process's session handle",
    enrich_request: "the enrichment queue — work, not data",
    harness_health: "a harness process's liveness on this host",
    outbox_item: "the gateway's own delivery queue",
    replica_intent_outcome: "device-scoped outcome of one submitted intent",
    replica_invocation_commit: "the commit group one invocation wrote",
    replica_parked_payload: "a sealed request awaiting the member's answer",
    sync_connection_health: "a third-party connection's liveness on this host",
    sync_connection_run: "one poll of a third-party connection",
    trigger_ingress: "an inbound trigger the gateway has not run yet",
  },
  // peer-link state
  "peer-link": {
    share_delivery_config: "how this host reaches a peer",
    share_fulfillment: "one delivery attempt against a peer",
    share_party_vault_binding:
      "which vault a party is reachable at from this host",
  },
};

export const PRIVATE_TABLES: readonly PrivateTableDeclaration[] =
  Object.entries(PRIVATE_TABLES_BY_KIND).flatMap(([kind, tables]) =>
    Object.entries(tables).map(([table, reason]) => ({
      table,
      kind: kind as PrivateTableKind,
      reason,
    }))
  );

/** The list as a set of names — the form every consumer actually wants. */
export const PRIVATE_TABLE_NAMES: ReadonlySet<string> = new Set(
  PRIVATE_TABLES.map((entry) => entry.table)
);

export function isPrivateTable(table: string): boolean {
  return PRIVATE_TABLE_NAMES.has(table);
}

/** Physical tables that carry no data of their own. */
function isShadowTable(name: string): boolean {
  return (
    name.startsWith("fts_") ||
    name.startsWith("sqlite_") ||
    name === "replica_log" ||
    name === "replica_meta" ||
    // The mechanism #996 replaces. Still in the file, and a log of the log is
    // a loop; it leaves with the last of its triggers.
    name === "replica_change"
  );
}

// The answer changes only when the SCHEMA does, and `PRAGMA schema_version`
// is SQLite's own counter for exactly that — bumped by every table, index and
// trigger change, including one an ext band installs mid-session. Caching on
// it keeps the capture path off a catalog scan per commit without inventing a
// second notion of "the schema changed" that could disagree with SQLite's.
const REPLICATED = new WeakMap<
  DatabaseSync,
  { schemaVersion: number; tables: string[] }
>();

/**
 * Every physical table a seat's copy holds: the file's tables, minus the FTS
 * shadow tables (an index is not data — R1), minus the log plane's own
 * tables, minus this list.
 */
export function replicatedTablesOf(vault: DatabaseSync): string[] {
  const schemaVersion = (
    prepared(vault, "PRAGMA schema_version").get() as {
      schema_version: number;
    }
  ).schema_version;
  const cached = REPLICATED.get(vault);
  if (cached && cached.schemaVersion === schemaVersion) return cached.tables;
  const tables = (
    prepared(
      vault,
      `SELECT name FROM sqlite_schema
          WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
          ORDER BY name`
    ).all() as { name: string }[]
  )
    .map((row) => row.name)
    .filter((name) => !isShadowTable(name) && !isPrivateTable(name));
  REPLICATED.set(vault, { schemaVersion, tables });
  return tables;
}

export interface PrivateReferenceViolation {
  readonly from: string;
  readonly to: string;
  readonly column: string;
}

/**
 * THE PROPERTY THIS LIST EXISTS FOR: no replicated table declares a foreign
 * key into a private one, so a seat's copy satisfies the constraints the
 * gateway committed under even with `PRAGMA foreign_keys=OFF` (R4). A new
 * private table that breaks it must be SPLIT, the way `access_device` was.
 */
export function replicatedReferencesToPrivate(
  vault: DatabaseSync
): PrivateReferenceViolation[] {
  const violations: PrivateReferenceViolation[] = [];
  for (const table of replicatedTablesOf(vault)) {
    const keys = vault
      .prepare(`PRAGMA foreign_key_list(${JSON.stringify(table)})`)
      .all() as { table: string; from: string }[];
    for (const key of keys) {
      if (!isPrivateTable(key.table)) continue;
      violations.push({ from: table, to: key.table, column: key.from });
    }
  }
  return violations;
}
