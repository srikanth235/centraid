//! The band's shape, as data a test can hold it to (#1020, D-1020-AS3).
//!
//! Everything here is a *name* or a *closed vocabulary*, never a statement.
//! The statements are in `contracts/migrations/001_baseline.sql`; these are the
//! assertions that say the baseline still carries the band v0 described, so a
//! future migration that drops a trigger or widens a CHECK is a red test rather
//! than a silent behaviour change.

use rusqlite::Connection;

use crate::error::{Result, VaultError};

/// The machinery band these tables belong to.
pub const BAND: &str = "ledger";

/// The fourteen physical tables, in `ledger.ts:23`–`:37`'s order.
pub const LEDGER_TABLES: [&str; 14] = [
    "conversations",
    "turns",
    "items",
    "attachments",
    "conversation_harness_sessions",
    "conversation_turn_locks",
    "conversation_workspace_selection",
    "harness_health",
    "conversation_provider_consent",
    "automation_state",
    "automation_trigger_cursor",
    "trigger_ingress",
    "conversation_archive",
    "conversation_digest",
];

/// The five tables the automations lane owns the store code over (§Cross-lane).
///
/// One band, one migration, one retention pass — and the prune must never touch
/// a live cursor, which is why the list is named here rather than inferred from
/// a prefix.
pub const AUTOMATION_OWNED: [&str; 5] = [
    "harness_health",
    "conversation_provider_consent",
    "automation_state",
    "automation_trigger_cursor",
    "trigger_ingress",
];

/// `conversations.kind`.
pub const CONVERSATION_KINDS: [&str; 3] = ["chat", "automation", "build"];

/// `turns.trigger`.
pub const TURN_TRIGGERS: [&str; 6] = [
    "scheduled",
    "manual",
    "replay",
    "on_failure",
    "compile",
    "interactive",
];

/// `turns.feedback`, which is also nullable.
pub const TURN_FEEDBACK: [&str; 2] = ["up", "down"];

/// `items.kind`.
pub const ITEM_KINDS: [&str; 4] = ["message_in", "step", "tool", "delegate"];

/// `items.cost_source`. NULL is legacy or unpriced and is **not** a third
/// value: a row with no source has no claim about where its cost came from.
pub const COST_SOURCES: [&str; 2] = ["harness", "estimated"];

/// `harness_health.failure_class`.
pub const FAILURE_CLASSES: [&str; 8] = [
    "spawn", "auth", "init", "timeout", "quota", "wedge", "exit", "unknown",
];

/// The two indexes whose predicates are load-bearing.
pub const LEDGER_INDEXES: [&str; 2] = ["idx_items_turn_call", "idx_items_run_rollup"];

/// The view seven correlated rollups per Insights load are served from.
pub const RUN_SUMMARY_VIEW: &str = "run_summary";

/// Every trigger the band carries: **two counters over `items` only**, and six
/// FTS maintainers.
///
/// Worth naming precisely, because it is a trap. Both counters maintain
/// `conversations.item_count`; **`turn_count` has no trigger at all**
/// (`ledger.ts:390`–`:402`), so the store increments it itself
/// ([`super::store::Store::open_turn`]). A port that assumed symmetry would
/// leave every conversation's turn count at zero, and the Insights list reads
/// it.
pub const LEDGER_TRIGGERS: [&str; 8] = [
    "conversation_item_count_ai",
    "conversation_item_count_ad",
    "fts_conversation_conv_ai",
    "fts_conversation_conv_au",
    "fts_conversation_conv_ad",
    "fts_conversation_turn_ad",
    "fts_conversation_item_ai",
    "fts_conversation_item_ad",
];

/// The band's own FTS index. One virtual table for the whole conversation —
/// title plus body — rather than one per level, which is why five of the six
/// triggers above are `UPDATE`s of a conversation row rather than inserts.
pub const FTS_TABLE: &str = "fts_conversation";

/// One object the band expects, and what it is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Object {
    pub name: String,
    pub kind: String,
    pub sql: String,
}

/// Every schema object whose name or definition mentions the band.
pub fn objects(connection: &Connection) -> Result<Vec<Object>> {
    let mut statement = connection
        .prepare(
            "SELECT name, type, COALESCE(sql, '') FROM sqlite_schema \
             WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .map_err(|error| VaultError::from_sqlite("reading the schema", error))?;
    let rows = statement
        .query_map([], |row| {
            Ok(Object {
                name: row.get(0)?,
                kind: row.get(1)?,
                sql: row.get(2)?,
            })
        })
        .map_err(|error| VaultError::from_sqlite("reading the schema", error))?;
    let mut found = Vec::new();
    for row in rows {
        found.push(row.map_err(|error| VaultError::from_sqlite("reading the schema", error))?);
    }
    Ok(found)
}

/// The band is registered as machinery and every one of its tables is local.
///
/// Read from the transcribed v0 registry rather than from a Rust list, so the
/// two cannot drift: a table added to the band in v0 and forgotten in
/// `localTables` would be a ledger row replicated to every seat.
pub fn assert_band_registration() -> Result<()> {
    let registries = centraid_ontology::registries::v0_registries();
    if !registries.machinery_bands.iter().any(|band| band == BAND) {
        return Err(VaultError::Invariant {
            context: format!("`{BAND}` is not registered as a machinery band"),
        });
    }
    let local = centraid_ontology::registries::local_table_names();
    let missing: Vec<&str> = LEDGER_TABLES
        .into_iter()
        .filter(|table| !local.iter().any(|name| name == table))
        .collect();
    if !missing.is_empty() {
        return Err(VaultError::Invariant {
            context: format!(
                "ledger tables missing from the local (never-replicated, never-exported) list: \
                 {missing:?}"
            ),
        });
    }
    Ok(())
}
