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
    // The trigger log #1014 retires. A log of the log is a loop; it leaves
    // with the last of its triggers.
    name === "replica_change"
  );
}

// AN ALLOW-LIST, NOT A DENY-LIST (#1014, G13). Until now `replicatedTablesOf`
// took every table the file carries and subtracted the private list, so a
// table added to the schema replicated to every seat by DEFAULT and the
// closed list above only caught the cases someone remembered to add to it.
// The default is now the other way round: a table replicates because it is
// named here, and a table that is named nowhere fails
// `unclassifiedTables` — see `private-tables.test.ts`.
//
// Ext bands are the one dynamic member: their physical names are generated
// (`ext_<app>_<table>` / `extdraft_<app>_<table>`, `schema/ext.ts`), so they
// are admitted by PREFIX rather than by name. Nothing else is.
const REPLICATED_TABLE_NAMES: ReadonlySet<string> = new Set([
  "access_agent",
  "access_app",
  "access_app_ext",
  "access_device",
  "access_provenance",
  "access_receipt",
  "access_seed_row",
  "agent_capability",
  "agent_command",
  "agent_command_invocation",
  "agent_evidence",
  "agent_explanation",
  "agent_invocation_check",
  "attachments",
  "audit_archive_manifest",
  "audit_archive_pass",
  "automation_state",
  "automation_trigger_cursor",
  "blob_custody_rollup",
  "blob_custody_state",
  "conversation_archive",
  "conversation_digest",
  "conversation_provider_consent",
  "conversation_turn_locks",
  "conversation_workspace_selection",
  "conversations",
  "core_account",
  "core_activity",
  "core_attachment",
  "core_collection",
  "core_collection_entry",
  "core_concept",
  "core_concept_scheme",
  "core_content_derivative",
  "core_content_item",
  "core_content_representation",
  "core_content_text",
  "core_document",
  "core_entity",
  "core_entity_kind",
  "core_entity_revision",
  "core_event",
  "core_link",
  "core_link_anchor",
  "core_party",
  "core_party_identifier",
  "core_place",
  "core_tag",
  "core_transaction",
  "core_vault",
  "enrich_derivation",
  "enrich_embedding",
  "enrich_policy",
  "enrich_policy_rule",
  "items",
  "knowledge_annotation",
  "knowledge_note",
  "locker_item",
  "locker_item_address",
  "locker_item_alias",
  "locker_item_field",
  "locker_item_passkey",
  "media_asset",
  "media_asset_phash",
  "media_face_cluster",
  "media_face_region",
  "media_memory",
  "media_memory_member",
  "notifications_notice",
  "people_important_date",
  "people_profile",
  "schedule_attendee",
  "schedule_calendar",
  "schedule_event_ext",
  "schedule_project",
  "schedule_recurrence_exception",
  "schedule_recurrence_exception_attendee",
  "schedule_section",
  "schedule_task",
  "share_authority",
  "share_authority_request",
  "share_authority_use",
  "share_subscription",
  "share_subscription_lineage",
  "share_subscription_member",
  "social_circle",
  "social_circle_member",
  "social_contact_channel",
  "social_message",
  "social_thread",
  "social_thread_participant",
  "sync_connection",
  "sync_connection_cursor",
  "sync_external_entity",
  "sync_import_batch",
  "sync_import_row",
  "tally_expense",
  "tally_expense_line_allocation",
  "tally_expense_line_item",
  "tally_expense_payer",
  "tally_expense_split",
  "tally_friend",
  "tally_group",
  "tally_nudge",
  "tally_obligation",
  "tally_recurring_expense",
  "tally_recurring_expense_split",
  "tally_settlement",
  "turns",
]);

/** An app's ext band: a generated physical name, admitted by prefix. */
function isExtBandTable(name: string): boolean {
  return name.startsWith("ext_") || name.startsWith("extdraft_");
}

/** Is this physical table one a seat's copy holds? */
export function isReplicatedTable(name: string): boolean {
  return REPLICATED_TABLE_NAMES.has(name) || isExtBandTable(name);
}

/**
 * Physical tables a fresh vault carries that are classified NOWHERE: not on
 * the replicated allow-list, not private, not a shadow/log-plane table. The
 * golden test asserts this is empty, so adding a table to the schema without
 * deciding whether it travels is a red build rather than a silent leak.
 */
export function unclassifiedTables(vault: DatabaseSync): string[] {
  return (
    prepared(
      vault,
      `SELECT name FROM sqlite_schema
          WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
          ORDER BY name`
    ).all() as { name: string }[]
  )
    .map((row) => row.name)
    .filter(
      (name) =>
        !isShadowTable(name) &&
        !isPrivateTable(name) &&
        !isReplicatedTable(name)
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
 * Every physical table a seat's copy holds: the file's tables intersected
 * with the allow-list above (plus the ext bands), which is where the FTS
 * shadow tables, the log plane and the private list all fall out.
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
    .filter((name) => isReplicatedTable(name) && !isPrivateTable(name));
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

// WHAT REPLICATES BUT NOT WHOLE (#1014, G14).
//
// The table list above is the only row-level filter a seat has (R1: the seat
// holds `vault.db` whole). It cannot express the one case that is neither
// "stays home" nor "travels intact": a REPLICATED table with one cell that
// carries more than the seat needs.
//
// `access_receipt.detail_json` is that cell. It is the Locker access
// history's source — `packages/blueprints/apps/locker/queries/access.ts`
// reads `columns`, `context`, `failing` and `code` out of it on the seat, so
// dropping the column would take a shipped screen with it. But it also
// carries `output`: the FULL RETURN VALUE of every command, kept so that a
// re-sent invocation can replay its answer without re-running
// (`gateway/execution.ts`, `receiptOutput`). Replay is a GATEWAY concern —
// `replayInvocation` runs on the gateway's own journal, never on a seat — so
// the output has no seat-side reader and every seat was carrying a verbatim
// copy of every command result the vault has ever produced.
//
// The exclusion is therefore stated at the JSON KEY, not the column, and it
// is declared here as data so the file-copy bootstrap and the log capture
// redact the same thing rather than two copies of the same judgement.
// `replicated-column-exclusions.test.ts` is that property as a test.
const REPLICATED_JSON_KEY_EXCLUSIONS: Readonly<
  Record<string, Readonly<Record<string, readonly string[]>>>
> = {
  access_receipt: {
    // Command output; gateway-only reader (`receiptOutput`).
    detail_json: ["output"],
  },
};

/** The tables that carry at least one excluded key — the cheap pre-check. */
export const REPLICATED_COLUMN_EXCLUSION_TABLES: ReadonlySet<string> = new Set(
  Object.keys(REPLICATED_JSON_KEY_EXCLUSIONS)
);

export interface ReplicatedColumnExclusion {
  readonly table: string;
  readonly column: string;
  readonly jsonKeys: readonly string[];
}

export const REPLICATED_COLUMN_EXCLUSIONS: readonly ReplicatedColumnExclusion[] =
  Object.entries(REPLICATED_JSON_KEY_EXCLUSIONS).flatMap(([table, columns]) =>
    Object.entries(columns).map(([column, jsonKeys]) => ({
      table,
      column,
      jsonKeys,
    }))
  );

/**
 * Redact one row image in place, for the LOG side.
 *
 * Returns whether anything changed, so a caller can keep the common path
 * allocation-free. The value is re-serialised only when a key was actually
 * present: a receipt with no `output` must come out byte-identical, or every
 * row's hash would move for a redaction that removed nothing.
 */
export function redactReplicatedRowImage(
  table: string,
  image: Record<string, unknown>
): boolean {
  const columns = REPLICATED_JSON_KEY_EXCLUSIONS[table];
  if (!columns) return false;
  let changed = false;
  for (const [column, keys] of Object.entries(columns)) {
    const value = image[column];
    if (typeof value !== "string" || value.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      // A non-JSON value in a JSON column is the CHECK constraint's problem,
      // not ours. Leaving it verbatim is the safe read here only because the
      // column is `json_valid`-constrained at the schema; if that ever moves,
      // this becomes a drop.
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      continue;
    const record = parsed as Record<string, unknown>;
    let removed = false;
    for (const key of keys) {
      if (!Object.hasOwn(record, key)) continue;
      delete record[key];
      removed = true;
    }
    if (!removed) continue;
    image[column] = JSON.stringify(record);
    changed = true;
  }
  return changed;
}
