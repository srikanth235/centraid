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
    open_contract_vault_without(ddl, rows_json, &FrozenRowMapping::NONE)
}

/// WHERE A FROZEN BUNDLE AND THE SCHEMA NO LONGER AGREE.
///
/// `rows.json` is a frozen golden (TESTING.md, "Fixtures and parity") and is
/// never edited. Rung five drops the planes v1 does not have (#1029), so three
/// bundles now carry rows for a table that is gone and one carries a column
/// that is gone; rung six adds a required column two bundles cannot carry. A
/// test states its own mapping here, in its own file, and the builder skips —
/// or supplies — exactly what the mapping names.
///
/// **It is a gate, not a silencer.** A name here that the schema still has is a
/// refusal, and so is a supplied column the schema lacks or the bundle already
/// carries: a mapping cannot outlive its reason, and nothing is skipped because
/// an insert happened to fail.
#[derive(Debug, Clone, Copy)]
pub struct FrozenRowMapping<'a> {
    /// Tables the bundle carries and the schema does not.
    pub tables_gone: &'a [&'a str],
    /// `(table, column)` pairs the bundle carries and the table does not.
    pub columns_gone: &'a [(&'a str, &'a str)],
    /// `(table, column, value)`: a REQUIRED column the table gained after the
    /// bundle froze, and the one value every row of that table in THIS bundle
    /// takes. Rung six's `core_collection.kind` is the case: v0's Notes bundle
    /// holds only notebooks and its Photos bundle only albums, so the test
    /// states which, rather than the builder guessing.
    pub columns_added: &'a [(&'a str, &'a str, &'a str)],
}

impl FrozenRowMapping<'_> {
    /// Nothing is skipped: the bundle and the schema agree.
    pub const NONE: FrozenRowMapping<'static> = FrozenRowMapping {
        tables_gone: &[],
        columns_gone: &[],
        columns_added: &[],
    };
}

/// The same, with a stated mapping for what rung five dropped and rung six
/// added.
///
/// # Errors
///
/// [`KitError::Door`] when the mapping names something the schema still has,
/// or supplies a column it does not — see [`FrozenRowMapping`] — and for
/// anything SQLite refuses.
pub fn open_contract_vault_without(
    ddl: &str,
    rows_json: &str,
    mapping: &FrozenRowMapping<'_>,
) -> KitResult<Connection> {
    let connection =
        Connection::open_in_memory().map_err(|error| KitError::Door(error.to_string()))?;
    // Explicit, because rusqlite turns foreign keys ON for a new connection and
    // the doc comment above says they are off. A per-app fixture carries only
    // the tables that app reads.
    connection
        .execute_batch("PRAGMA foreign_keys = OFF;")
        .map_err(|error| KitError::Door(error.to_string()))?;
    replay_ddl(&connection, ddl)?;
    check_mapping(&connection, mapping)?;
    insert_rows(&connection, rows_json, mapping)?;
    Ok(connection)
}

/// A mapping that names something the schema still has is a refusal.
fn check_mapping(connection: &Connection, mapping: &FrozenRowMapping<'_>) -> KitResult<()> {
    for table in mapping.tables_gone {
        let present: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                [table],
                |row| row.get(0),
            )
            .map_err(|error| KitError::Door(error.to_string()))?;
        if present > 0 {
            return Err(KitError::Door(format!(
                "the mapping says `{table}` is gone and the schema still has it"
            )));
        }
    }
    for (table, column) in mapping.columns_gone {
        if columns_of(connection, table)?
            .iter()
            .any(|have| have == column)
        {
            return Err(KitError::Door(format!(
                "the mapping says `{table}.{column}` is gone and the table still has it"
            )));
        }
    }
    for (table, column, _) in mapping.columns_added {
        if !columns_of(connection, table)?
            .iter()
            .any(|have| have == column)
        {
            return Err(KitError::Door(format!(
                "the mapping supplies `{table}.{column}` and the table has no such column"
            )));
        }
    }
    Ok(())
}

/// The columns a table declares, as SQLite reports them.
fn columns_of(connection: &Connection, table: &str) -> KitResult<Vec<String>> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|error| KitError::Door(error.to_string()))?;
    let names = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| KitError::Door(error.to_string()))?
        .collect::<rusqlite::Result<Vec<String>>>()
        .map_err(|error| KitError::Door(error.to_string()))?;
    Ok(names)
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
/// one after its virtual table exists is "table already exists". This
/// function identifies FTS objects by the `fts_…` shape rather than by name.
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

fn insert_rows(
    connection: &Connection,
    rows_json: &str,
    mapping: &FrozenRowMapping<'_>,
) -> KitResult<()> {
    let bundle: serde_json::Value =
        serde_json::from_str(rows_json).map_err(|error| KitError::Door(error.to_string()))?;
    let tables = bundle
        .as_array()
        .ok_or_else(|| KitError::Door("a rows bundle is a list of tables".to_owned()))?;
    for table in tables {
        let name = table["table"]
            .as_str()
            .ok_or_else(|| KitError::Door("a table entry names its table".to_owned()))?;
        if mapping.tables_gone.contains(&name) {
            continue;
        }
        let declared: Vec<&str> = table["columns"]
            .as_array()
            .ok_or_else(|| KitError::Door(format!("{name} has no column list")))?
            .iter()
            .filter_map(serde_json::Value::as_str)
            .collect();
        // The cells of a dropped column are dropped with it, by INDEX, so a
        // row's remaining cells still line up with the columns they belong to.
        let dropped: Vec<usize> = declared
            .iter()
            .enumerate()
            .filter(|(_, column)| {
                mapping
                    .columns_gone
                    .iter()
                    .any(|(table, gone)| *table == name && gone == *column)
            })
            .map(|(index, _)| index)
            .collect();
        // A supplied column the bundle ALREADY carries is a refusal: the
        // mapping would be overriding frozen cells, not filling a gap.
        let supplied: Vec<(&str, &str)> = mapping
            .columns_added
            .iter()
            .filter(|(table, _, _)| *table == name)
            .map(|(_, column, value)| (*column, *value))
            .collect();
        if let Some((column, _)) = supplied
            .iter()
            .find(|(column, _)| declared.contains(column))
        {
            return Err(KitError::Door(format!(
                "the mapping supplies `{name}.{column}` and the bundle already carries it"
            )));
        }
        let columns: Vec<&str> = declared
            .iter()
            .enumerate()
            .filter(|(index, _)| !dropped.contains(index))
            .map(|(_, column)| *column)
            .chain(supplied.iter().map(|(column, _)| *column))
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
        // A ROW THAT REFERS TO A LATER ROW IS DEFERRED, NEVER SKIPPED.
        //
        // `rows.json` is frozen (TESTING.md, "Fixtures and parity") and its row
        // order is v0's read order, not a dependency order:
        // `contracts/apps/notes/rows.json` carries a `core_entity_revision`
        // whose parent is a row further down. That cost nothing while the
        // fixture vault was built from a schema with no guards. The vault a
        // test builds is now the schema a real vault founds
        // (`contracts/schema/vault-ddl.sql`, #1029), and rung two's
        // `core_entity_revision_parent_is_same_object` looks the parent up at
        // insert time (#1020, D-1020-N2).
        //
        // So a refused row goes to the back of the queue and the pass runs
        // again; a pass that places nothing raises its first refusal unchanged.
        // Every row in the file still lands, and a refusal that is not about
        // ordering still fails — this reorders the inserts, it does not filter
        // them, and it never edits the frozen file.
        let mut pending: Vec<&serde_json::Value> = values.iter().collect();
        while !pending.is_empty() {
            let before = pending.len();
            let mut deferred: Vec<&serde_json::Value> = Vec::new();
            let mut first_refusal: Option<String> = None;
            for row in std::mem::take(&mut pending) {
                let cells: Vec<rusqlite::types::Value> = row
                    .as_array()
                    .ok_or_else(|| KitError::Door(format!("{name}: a row is a list of cells")))?
                    .iter()
                    .enumerate()
                    .filter(|(index, _)| !dropped.contains(index))
                    .map(|(_, cell)| cell_of(cell))
                    .chain(
                        supplied
                            .iter()
                            .map(|(_, value)| rusqlite::types::Value::Text((*value).to_owned())),
                    )
                    .collect();
                if let Err(error) = prepared.execute(rusqlite::params_from_iter(cells)) {
                    first_refusal.get_or_insert_with(|| format!("{name}: {error}"));
                    deferred.push(row);
                }
            }
            if deferred.len() == before {
                return Err(KitError::Door(first_refusal.unwrap_or_else(|| {
                    format!("{name}: a pass placed no row and named no refusal")
                })));
            }
            pending = deferred;
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
