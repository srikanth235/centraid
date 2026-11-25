//! The lookup tables are fixed (#1214, K2): only a migration rung writes them.
//!
//! A growing vocabulary is a seeded lookup table, so that adding a value is an `INSERT` in a later
//! rung, `user_version` moves, and an older build refuses the file (`DowngradeRefused`). That only
//! holds if nothing else writes one: a value that arrived outside a rung would reach an older build
//! with no version to refuse it by. A migration runs on the connection before it is wrapped
//! ([`crate::file`]), so [`install`] puts a TEMP trigger on each lookup table of the wrapped
//! connection and every write the vault makes afterwards, through a command or raw SQL, is refused.

use rusqlite::Connection;

use crate::error::Result;

/// Every lookup table of the baseline, and the shape tables that are vocabularies like them
/// (`edge_shape` says which kinds a relation joins, `home_shape` which kind sits in which).
/// `tests/lookups.rs` holds this list to the founded file.
pub const LOOKUP_TABLES: [&str; 20] = [
    "entity_kind",
    "home_shape",
    "concept_kind",
    "container_kind",
    "palette",
    "arrival_via",
    "origin_system",
    "source_shape",
    "derivative_variant",
    "contact_point_kind",
    "photo_form",
    "account_type",
    "locker_type",
    "message_refusal",
    "message_notice",
    "person_form",
    "person_date_kind",
    "reminder_target",
    "health_metric",
    "edge_shape",
];

/// The sentence a refused write carries.
pub const REFUSAL: &str = "a lookup table is written only by a migration";

/// Refuse every write to a lookup table on this connection.
pub(crate) fn install(connection: &Connection) -> Result<()> {
    let mut sql = String::new();
    for table in LOOKUP_TABLES {
        for (name, event) in [
            ("insert", "INSERT"),
            ("update", "UPDATE"),
            ("delete", "DELETE"),
        ] {
            sql.push_str(&format!(
                "CREATE TEMP TRIGGER IF NOT EXISTS lookup_{table}_{name}_refused BEFORE {event} ON main.{table}
                   BEGIN SELECT RAISE(ABORT, '{REFUSAL}'); END;\n"
            ));
        }
    }
    connection.execute_batch(&sql)?;
    Ok(())
}
