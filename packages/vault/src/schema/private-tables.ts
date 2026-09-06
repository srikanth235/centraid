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

export type PrivateTableKind = "credential" | "gateway-job" | "peer-link";

export interface PrivateTableDeclaration {
  readonly table: string;
  readonly kind: PrivateTableKind;
  /** Why it stays on the gateway, in one clause. */
  readonly reason: string;
}

/**
 * The closed list. Ordered by kind, then by name inside a kind, so a diff of
 * this file reads as a decision rather than as a merge artefact.
 */
export const PRIVATE_TABLES: readonly PrivateTableDeclaration[] = [
  // ---- credentials and key material -------------------------------------
  {
    table: "access_agent_secret",
    kind: "credential",
    reason: "an enrolled agent's host-side enrollment key",
  },
  {
    table: "access_device_secret",
    kind: "credential",
    reason: "a device's public key and its gateway-side sync cursor",
  },
  {
    table: "blob_content_key",
    kind: "credential",
    reason: "the wrapped per-object content key",
  },
  {
    table: "blob_device_content_key",
    kind: "credential",
    reason: "one device's copy of a wrapped object key",
  },
  {
    table: "blob_device_wrap_key",
    kind: "credential",
    reason: "one device's key-wrapping salt and epoch",
  },
  {
    table: "locker_auth_credential",
    kind: "credential",
    reason: "this installation's unlock credential",
  },
  {
    table: "sync_connection_credential",
    kind: "credential",
    reason: "a third-party connection's stored secret",
  },
  // ---- the gateway's own job machinery -----------------------------------
  {
    table: "blob_ingress_probe",
    kind: "gateway-job",
    reason: "head/tail bytes of an upload still in flight",
  },
  {
    table: "blob_ingress_session",
    kind: "gateway-job",
    reason: "an upload in flight — resumable on the gateway only",
  },
  {
    table: "blob_outbox",
    kind: "gateway-job",
    reason: "the gateway's queue of objects still to be replicated",
  },
  {
    table: "blob_staging",
    kind: "gateway-job",
    reason: "bytes staged for a command that has not committed yet",
  },
  {
    table: "conversation_harness_sessions",
    kind: "gateway-job",
    reason: "a harness process's session handle",
  },
  {
    table: "enrich_request",
    kind: "gateway-job",
    reason: "the enrichment queue — work, not data",
  },
  {
    table: "harness_health",
    kind: "gateway-job",
    reason: "a harness process's liveness on this host",
  },
  {
    table: "outbox_item",
    kind: "gateway-job",
    reason: "the gateway's own delivery queue",
  },
  {
    table: "replica_intent_outcome",
    kind: "gateway-job",
    reason: "device-scoped outcome of one submitted intent",
  },
  {
    table: "replica_invocation_commit",
    kind: "gateway-job",
    reason: "the commit group one invocation wrote",
  },
  {
    table: "replica_parked_payload",
    kind: "gateway-job",
    reason: "a sealed request awaiting the member's answer",
  },
  {
    table: "sync_connection_health",
    kind: "gateway-job",
    reason: "a third-party connection's liveness on this host",
  },
  {
    table: "sync_connection_run",
    kind: "gateway-job",
    reason: "one poll of a third-party connection",
  },
  {
    table: "trigger_ingress",
    kind: "gateway-job",
    reason: "an inbound trigger the gateway has not run yet",
  },
  // ---- peer-link state ----------------------------------------------------
  {
    table: "share_delivery_config",
    kind: "peer-link",
    reason: "how this host reaches a peer",
  },
  {
    table: "share_fulfillment",
    kind: "peer-link",
    reason: "one delivery attempt against a peer",
  },
  {
    table: "share_party_vault_binding",
    kind: "peer-link",
    reason: "which vault a party is reachable at from this host",
  },
];

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
    name === "replica_meta"
  );
}

/**
 * Every physical table a seat's copy holds: the file's tables, minus the FTS
 * shadow tables (an index is not data — R1), minus the log plane's own two
 * tables, minus this list.
 */
export function replicatedTablesOf(vault: DatabaseSync): string[] {
  return (
    vault
      .prepare(
        `SELECT name FROM sqlite_schema
          WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
          ORDER BY name`
      )
      .all() as { name: string }[]
  )
    .map((row) => row.name)
    .filter((name) => !isShadowTable(name) && !isPrivateTable(name));
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
