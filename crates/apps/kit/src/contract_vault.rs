//! Reconstructing a fixture vault from `contracts/`.
//!
//! **Why this is in the kit and not in each app's test.** `sql-confinement`
//! scans every `.rs` file under `crates/`, tests included, and SQL lives only
//! under `crates/{ontology,vault,seat,search}` and `crates/apps/kit` (#1020
//! invariant). An app's parity test needs a vault to read and must not hold a
//! statement to make one, so the one builder lives here and every app crate
//! calls it. It is also why the `INSERT` below is the only insert the app plane
//! has.

use rusqlite::Connection;

use crate::error::{KitError, KitResult};

/// Build a vault from the committed DDL and a `rows.json` bundle.
///
/// **Why this is in the kit and not in each app's test.** `sql-confinement`
/// scans every `.rs` file under `crates/`, tests included, and SQL lives only
/// under `crates/{ontology,vault,seat,search}` and `crates/apps/kit` (#1020
/// invariant). An app's parity test needs a vault to read and must not hold a
/// statement to make one, so the one builder lives here and every app crate
/// calls it. It is also the reason the `INSERT` below is the only insert the
/// app plane has.
///
/// `ddl` is `contracts/schema/vault-ddl.sql` verbatim — the committed schema of
/// the #929 golden corpus, so no test holds a second copy of the model.
///
/// **The DDL is replayed in two passes, and the order is the point.** The file
/// is `sqlite_master` "ordered by type then name", which puts `CREATE INDEX`
/// and `CREATE TRIGGER` on `access_provenance` before the table itself exists.
/// Tables first, then everything else, is the only order that replays.
///
/// Two pragmas, both deliberate: foreign keys stay **off**, because a per-app
/// fixture carries only the tables that app reads while its rows reference
/// parents in bands it does not; and the triggers the DDL installs stay **on**,
/// because a trigger is part of what a row means — `updated_at` and
/// `row_version` are stamped by one, and a fixture without them would be
/// testing a different table.
pub fn open_contract_vault(ddl: &str, rows_json: &str) -> KitResult<Connection> {
    let connection =
        Connection::open_in_memory().map_err(|error| KitError::Door(error.to_string()))?;
    // Explicit, because rusqlite turns foreign keys ON for a new connection and
    // the doc comment above says they are off. A per-app fixture carries only
    // the tables that app reads.
    connection
        .execute_batch("PRAGMA foreign_keys = OFF;")
        .map_err(|error| KitError::Door(error.to_string()))?;
    replay_ddl(&connection, ddl)?;
    insert_rows(&connection, rows_json)?;
    Ok(connection)
}

/// One block of the generated DDL: its marker kind, the object it names, and
/// the statement.
struct DdlBlock {
    kind: &'static str,
    name: String,
    body: String,
}

fn ddl_blocks(ddl: &str) -> Vec<DdlBlock> {
    let mut blocks: Vec<DdlBlock> = Vec::new();
    let mut kind = "";
    let mut name = String::new();
    let mut body = String::new();
    let flush =
        |kind: &'static str, name: &mut String, body: &mut String, out: &mut Vec<DdlBlock>| {
            if !body.trim().is_empty() {
                out.push(DdlBlock {
                    kind,
                    name: std::mem::take(name),
                    body: std::mem::take(body),
                });
            }
        };
    for line in ddl.lines() {
        if let Some(rest) = line.strip_prefix("-- ") {
            let mut words = rest.split_whitespace();
            let marker = words.next().unwrap_or_default();
            let declared = words.next().unwrap_or_default();
            let next_kind = match marker {
                "table" => "table",
                "index" => "index",
                "trigger" => "trigger",
                "view" => "view",
                _ => "",
            };
            if !next_kind.is_empty() {
                flush(kind, &mut name, &mut body, &mut blocks);
                kind = next_kind;
                name = declared.to_owned();
                continue;
            }
        }
        // Every other comment line is prose in the generated header or inside a
        // statement; it rides along with the block it sits in.
        body.push_str(line);
        body.push('\n');
    }
    flush(kind, &mut name, &mut body, &mut blocks);
    blocks
}

/// An FTS5 shadow table, which the virtual table creates for itself.
///
/// `sqlite_master` lists them, so the generated DDL lists them, and replaying
/// one after its virtual table exists is "table already exists". v0 has the
/// same problem from the other side and answers it the same way: its snapshot
/// pipeline identifies FTS objects by the `fts_…` shape rather than by name
/// (`packages/vault/src/replica/seat-snapshot.ts:8-37`).
fn is_fts_shadow(name: &str) -> bool {
    name.starts_with("fts_")
        && ["_config", "_content", "_data", "_docsize", "_idx"]
            .iter()
            .any(|suffix| name.ends_with(suffix))
}

/// An object SQLite owns and refuses to be handed back.
///
/// `sqlite_sequence` is created by SQLite itself for `AUTOINCREMENT` and its
/// name is reserved, so replaying the row `sqlite_master` holds for it is an
/// error. It is the schema's, not the model's.
fn is_sqlite_internal(name: &str) -> bool {
    name.starts_with("sqlite_")
}

fn replay_ddl(connection: &Connection, ddl: &str) -> KitResult<()> {
    let blocks = ddl_blocks(ddl);
    // Tables first: the file is `sqlite_master` ordered by type then name, so
    // an index or a trigger on `access_provenance` comes before that table.
    for wanted in ["table", "view", "index", "trigger"] {
        for block in &blocks {
            if block.kind != wanted || is_fts_shadow(&block.name) || is_sqlite_internal(&block.name)
            {
                continue;
            }
            connection
                .execute_batch(&block.body)
                .map_err(|error| KitError::Door(format!("{wanted} {}: {error}", block.name)))?;
        }
    }
    Ok(())
}

fn insert_rows(connection: &Connection, rows_json: &str) -> KitResult<()> {
    let bundle: serde_json::Value =
        serde_json::from_str(rows_json).map_err(|error| KitError::Door(error.to_string()))?;
    let tables = bundle
        .as_array()
        .ok_or_else(|| KitError::Door("a rows bundle is a list of tables".to_owned()))?;
    for table in tables {
        let name = table["table"]
            .as_str()
            .ok_or_else(|| KitError::Door("a table entry names its table".to_owned()))?;
        let columns: Vec<&str> = table["columns"]
            .as_array()
            .ok_or_else(|| KitError::Door(format!("{name} has no column list")))?
            .iter()
            .filter_map(serde_json::Value::as_str)
            .collect();
        let values = table["rows"]
            .as_array()
            .ok_or_else(|| KitError::Door(format!("{name} has no row list")))?;
        if values.is_empty() {
            continue;
        }
        let placeholders = vec!["?"; columns.len()].join(", ");
        let statement = format!(
            "INSERT INTO {name} ({}) VALUES ({placeholders})",
            columns.join(", ")
        );
        let mut prepared = connection
            .prepare(&statement)
            .map_err(|error| KitError::Door(format!("{name}: {error}")))?;
        for row in values {
            let cells: Vec<rusqlite::types::Value> = row
                .as_array()
                .ok_or_else(|| KitError::Door(format!("{name}: a row is a list of cells")))?
                .iter()
                .map(cell_of)
                .collect();
            prepared
                .execute(rusqlite::params_from_iter(cells))
                .map_err(|error| KitError::Door(format!("{name}: {error}")))?;
        }
    }
    Ok(())
}

/// A JSON cell as SQLite binds it.
///
/// `true`/`false` bind as 1/0, because that is how v0 encodes a boolean on the
/// wire and "never `true`/`false`" is the row-JSON rule (#1020 plane seam 2).
fn cell_of(cell: &serde_json::Value) -> rusqlite::types::Value {
    match cell {
        serde_json::Value::Null => rusqlite::types::Value::Null,
        serde_json::Value::Bool(flag) => rusqlite::types::Value::Integer(i64::from(*flag)),
        serde_json::Value::Number(number) => number.as_i64().map_or_else(
            || {
                number
                    .as_f64()
                    .map_or(rusqlite::types::Value::Null, rusqlite::types::Value::Real)
            },
            rusqlite::types::Value::Integer,
        ),
        serde_json::Value::String(text) => rusqlite::types::Value::Text(text.clone()),
        // A nested object or array in a cell is the vault's own JSON column,
        // stored as text exactly as it was read.
        other => rusqlite::types::Value::Text(other.to_string()),
    }
}
