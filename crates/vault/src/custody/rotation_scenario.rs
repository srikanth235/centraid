//! THE ROTATION SCENARIO'S READS AND WRITES, and why they live here rather
//! than in the simulation that uses them (#1020, wave 4 lane Locker).
//!
//! `crates/sim/tests/rotation_across_seats.rs` drives a real key rotation
//! across three real seats against a real vault — founding a generation,
//! sealing a corpus under it, then running `locker.rotate_key` with an
//! interruption in each of six windows. To do that it has to plant a corpus
//! and read the key plane back, and **SQL lives only under
//! `crates/{ontology,vault,seat,search}` and `crates/apps/kit`**
//! (`cargo xtask rules`' `sql-confinement`, #1020): `crates/sim` is not one of
//! them.
//!
//! So the statements are here, next to the plane they read, and the simulation
//! calls them. That is the same reason `converge::row_count` exists — "for a
//! test or a diagnostic that wants a count without writing a query" — and it
//! is the right place on its own merits: every function below is a fact about
//! the **member-key plane**, and the plane's invariants are this module's
//! neighbours rather than a simulation's private knowledge.
//!
//! None of it is a shortcut around the command path. The rotation itself is
//! the real `locker.rotate_key`; what is here is the founding the seat does
//! before any command exists, and the three questions the scenario's
//! invariants ask after every step.

use rusqlite::Connection;

use crate::custody::locker_key::LOCKER_ENCRYPTED_COLUMNS;
use crate::error::{Result, VaultError};

/// Commit the generation a seat just minted.
///
/// **The key itself never arrives.** The vault learns that a generation exists
/// and when — the id and the instant, and nothing that opens a cell. That is
/// the whole shape of D-1020-L1: founding is on a seat, and this row is the
/// only trace of it the gateway ever holds.
pub fn found_generation(connection: &Connection, key_id: &str, created_at: &str) -> Result<()> {
    connection.execute(
        "INSERT INTO locker_key (key_id, created_at, retired_at)
         VALUES (?1, ?2, NULL)",
        (key_id, created_at),
    )?;
    Ok(())
}

/// Plant one login whose sealed cell is already ciphertext under `key_id`.
///
/// `sealed` is produced by the CALLER, on the seat, with the key — which is
/// why this function takes a string it cannot make. A gateway-side helper that
/// sealed its own argument would be the key door this wave deleted.
pub fn plant_sealed_login(
    connection: &Connection,
    item_id: &str,
    title: &str,
    at: &str,
    key_id: &str,
    sealed: &str,
) -> Result<()> {
    connection.execute(
        "INSERT INTO locker_item
           (item_id, type, title, created_at, updated_at, key_id, password)
         VALUES (?1, 'login', ?2, ?3, ?3, ?4, ?5)",
        rusqlite::params![item_id, title, at, key_id, sealed],
    )?;
    Ok(())
}

/// The one live generation, or `None` when the plane names none.
///
/// `None` is a real answer here and not an error: between the retire and the
/// insert of a rotation there is an instant with no live generation, and an
/// interruption in that window is one of the six the scenario replays.
pub fn live_generation(connection: &Connection) -> Result<Option<String>> {
    Ok(connection
        .query_row(
            "SELECT key_id FROM locker_key WHERE retired_at IS NULL",
            [],
            |row| row.get(0),
        )
        .ok())
}

/// How many generations are live. The invariant is "never two".
pub fn live_generations(connection: &Connection) -> Result<i64> {
    Ok(connection.query_row(
        "SELECT COUNT(*) FROM locker_key WHERE retired_at IS NULL",
        [],
        |row| row.get(0),
    )?)
}

/// One sealed cell: its table, its row, its ciphertext and the generation the
/// row names.
pub type SealedCell = (String, String, String, String);

/// Every sealed cell in the vault, with the generation its row names.
///
/// Walked from [`LOCKER_ENCRYPTED_COLUMNS`] rather than a list written here,
/// so a sealed column added to the registry is covered by the scenario's
/// invariants without anybody remembering to add it — the same reason
/// `locker.rotate_key`'s own pre-check walks the registry.
pub fn sealed_cells(connection: &Connection) -> Result<Vec<SealedCell>> {
    let mut out = Vec::new();
    for (table, pk, columns) in LOCKER_ENCRYPTED_COLUMNS {
        for column in *columns {
            let mut statement = connection.prepare(&format!(
                "SELECT {pk}, {column}, key_id FROM {table} WHERE {column} IS NOT NULL"
            ))?;
            let rows = statement.query_map([], |row| {
                Ok((
                    (*table).to_owned(),
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                ))
            })?;
            for row in rows {
                out.push(row?);
            }
        }
    }
    Ok(out)
}

/// The vault's own id, for an envelope's AAD.
pub fn vault_id(connection: &Connection) -> Result<String> {
    connection
        .query_row("SELECT vault_id FROM core_vault LIMIT 1", [], |row| {
            row.get(0)
        })
        .map_err(|error| VaultError::Invariant {
            context: format!("the vault names no id: {error}"),
        })
}
