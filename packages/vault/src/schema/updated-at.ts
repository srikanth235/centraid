/** Canonical SQLite expression used by editable domain-row timestamps. */
export const UPDATED_AT_DEFAULT = "(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))";

/** The column every touched table carries (#996, R6). */
export const ROW_VERSION_COLUMN =
  "row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1)";

/**
 * Keep `updated_at` meaningful for every write path, including Atlas Browse,
 * imports, and future sync code that does not know a domain command's shape —
 * and, since #996 (R6), BUMP `row_version` in the same trigger.
 *
 * ONE TRIGGER, TWO FACTS, BECAUSE THEY ARE THE SAME FACT: "this row changed".
 * A second trigger would be a second chance to forget one, and the version an
 * intent's conflict check compares against would then be true for some writers
 * and not others.
 *
 * THE GUARD MOVED FROM `updated_at` TO `row_version`. It still makes the
 * self-update terminate under recursive triggers, and it still lets an
 * importer preserve an explicit newer timestamp — but a writer that sets
 * `updated_at` by hand no longer skips the version bump, which is exactly the
 * writer a stale-base check must not miss. A caller that sets `row_version`
 * itself — the seat applier replaying the gateway's own value (R5) — is the
 * one path that passes through untouched, and that is the point: a mirror
 * carries the origin's version, it does not mint its own.
 *
 * WHAT THIS STILL DOES NOT GUARANTEE: MONOTONICITY ACROSS A RE-INSERT (#1014,
 * G10). `row_version` starts at 1 on every INSERT, so a row deleted and
 * re-created under the same primary key comes back at 1 and a base version of
 * 1 captured before the delete passes the conflict check against a row that is
 * not the one it was written against — the classic ABA. Two shapes were
 * considered and both were rejected FOR NOW rather than accepted quietly:
 *
 *   - a global version floor in `replica_meta`, lifted on every insert. It
 *     costs an extra UPDATE of the row AND of `replica_meta` on every INSERT
 *     into every replicated table, on the import and enrichment paths that
 *     write in thousands.
 *   - a per-row tombstone table an AFTER INSERT trigger probes. Cheaper on the
 *     common path, but it is a new unbounded table, and nothing ships here as
 *     "bounded by X" without a production caller pruning it and a test over
 *     that caller.
 *
 * Neither is a line in this file: both are a ladder rung over ~170 tables with
 * a schema-fingerprint re-freeze and a measured insert path behind them. What
 * IS closed here is coverage (`REPLICA_ROW_VERSION_GAP` below) and the ext
 * band (`schema/ext.ts`), which is where the silent overwrite was actually
 * reachable. The gateway names `row_version` in a SET clause nowhere but the
 * two triggers in this file and in `ext.ts` — the bypass is the seat applier's
 * alone.
 */
export function touchUpdatedAt(
  table: string,
  primaryKey: string | readonly string[]
): string {
  return `
CREATE TRIGGER ${table}_touch_updated_at
AFTER UPDATE ON ${table}
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE ${table}
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE ${pkMatch(table, typeof primaryKey === "string" ? [primaryKey] : primaryKey)};
END;`;
}

function pkMatch(table: string, primaryKey: readonly string[]): string {
  if (primaryKey.length === 0)
    throw new Error(`${table}: a lifecycle trigger needs a primary key`);
  return primaryKey.map((column) => `${column} = NEW.${column}`).join(" AND ");
}

/**
 * THE REPLICATED TABLES THAT STILL CARRY NO `row_version` (#1014, G11).
 *
 * `row_version` is per-table opt-in and nothing checked the coverage, so the
 * set below drifted into existence unnoticed: a seat editing one of these rows
 * has no version to state as a base, and the gateway's conflict check falls
 * back to `MAX(seq) FROM replica_change` — a transport position, in units the
 * seat does not speak. Two seats editing one such row: last writer wins.
 *
 * THIS IS A REGISTER OF CURRENT STATE, NOT A PERMISSION. `row-version-canary
 * .test.ts` asserts BOTH directions against a freshly migrated file: every
 * replicated table either carries the column or is named here, AND no table
 * named here still carries it. So a NEW table cannot be added without the
 * column unless someone writes its name down, and an entry cannot rot after
 * the column arrives. The list only ever shrinks.
 *
 * Two different reasons live in it, and telling them apart takes reading the
 * table's own DDL rather than a label here that would go stale:
 *   - append-only bands (`access_receipt`, `audit_archive_*`, `agent_*`
 *     evidence, `access_provenance`): a row is written once and never edited,
 *     so a version would be the constant 1 and no intent bases a write on one.
 *   - genuinely mutable rows (`core_entity`, `access_device`, `conversations`,
 *     `sync_connection`, `share_authority`, …): these are the gap, and closing
 *     them is a ladder rung with a schema-fingerprint re-freeze behind it, not
 *     a line in this file.
 *
 * The ext band is NOT in this list and must never be: #1014 G8 gave every ext
 * physical the column and the trigger, in `schema/ext.ts`.
 */
export const REPLICA_ROW_VERSION_GAP: readonly string[] = [
  "access_agent",
  "access_app",
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
  "core_collection_entry",
  "core_concept_scheme",
  "core_entity",
  "core_entity_kind",
  "enrich_derivation",
  "enrich_embedding",
  "items",
  "locker_item_address",
  "locker_item_alias",
  "media_memory",
  "media_memory_member",
  "notifications_notice",
  "schedule_calendar",
  "share_authority",
  "share_authority_request",
  "share_authority_use",
  "share_subscription_lineage",
  "share_subscription_member",
  "sync_connection",
  "sync_external_entity",
  "sync_import_batch",
  "sync_import_row",
  "turns",
];
