//! A faithful port of v0's `packages/vault/src/golden-snapshot.ts`.
//!
//! The corpus is a map from primary key to a digest over THE COLUMNS THAT
//! EXISTED AT FREEZE TIME, which is what makes three outcomes distinguishable:
//! a dropped ROW is data loss, a changed VALUE is an upgrade rewriting a
//! member's content, and a dropped COLUMN is its own class. Added rows and
//! columns are allowed — a backfill is doing its job.
//!
//! "Faithful" here means the digests are BYTE-COMPATIBLE with the frozen
//! manifest: the column order, the separator, the truncation to 16 hex
//! characters and the JS value spelling in [`crate::jsvalue`] are all
//! reproduced, because the manifest this compares against was written by the
//! TypeScript. A different-but-reasonable encoding would turn every row into a
//! finding.

use std::collections::{BTreeMap, BTreeSet};

use rusqlite::{Connection, OptionalExtension as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

use crate::error::Result;
use crate::jsvalue::{encode_value, js_number_to_string};

/// RUNTIME BOOKKEEPING, not member content: a row here is rewritten by the act
/// of OPENING the vault, so freezing it would go red for a reason unrelated to
/// an upgrade. Ported from `SNAPSHOT_EXCLUSIONS`; the reason travels with the
/// name because a list without reasons becomes a place to hide a failure.
pub const SNAPSHOT_EXCLUSIONS: &[(&str, &str)] = &[(
    "replica_meta",
    "the replica protocol's singleton: `active_commit_id`, `floor_seq`, \
     `commit_seq` and `updated_at` are rewritten by opening the vault, so it is \
     state ABOUT the vault rather than content IN it.",
)];

/// One table as it stood when the corpus was frozen.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableSnapshot {
    /// Column names captured at freeze time, sorted.
    pub columns: Vec<String>,
    /// The single-column primary key, or `None` when the table has none.
    #[serde(rename = "primaryKey")]
    pub primary_key: Option<String>,
    pub rows: i64,
    /// Primary key -> digest over `columns`. Empty when `primary_key` is none.
    pub digests: BTreeMap<String, String>,
}

/// Every non-empty table of a frozen vault, keyed by physical table name.
pub type VaultSnapshot = BTreeMap<String, TableSnapshot>;

#[derive(Debug, Clone)]
pub struct SnapshotComparison {
    pub ok: bool,
    /// Human-readable, one per problem — the failure message IS this list.
    pub findings: Vec<String>,
    /// What was actually compared, so a vacuous pass is visible as one.
    pub compared: Compared,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Compared {
    pub tables: usize,
    pub rows: usize,
}

/// Tables whose contents are the corpus, ordered for a stable manifest.
pub fn snapshot_tables(db: &Connection) -> Result<Vec<String>> {
    let excluded: BTreeSet<&str> = SNAPSHOT_EXCLUSIONS.iter().map(|&(name, _)| name).collect();
    let mut statement = db.prepare(
        r"SELECT name FROM sqlite_master
            WHERE type = 'table'
              AND name NOT LIKE 'sqlite\_%' ESCAPE '\'
              AND name NOT LIKE 'fts\_%' ESCAPE '\'
            ORDER BY name",
    )?;
    let names = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(names
        .into_iter()
        .filter(|name| !excluded.contains(name.as_str()))
        .collect())
}

struct ColumnInfo {
    name: String,
    pk: i64,
}

fn columns_of(db: &Connection, table: &str) -> Result<Vec<ColumnInfo>> {
    // `PRAGMA table_info` takes no bind parameter, so the name is interpolated;
    // every caller's name comes from `sqlite_master`, and the quoting keeps an
    // identifier with a reserved word or a dot in it legal.
    let mut statement = db.prepare(&format!("PRAGMA table_info({})", quote_identifier(table)))?;
    let rows = statement
        .query_map([], |row| {
            Ok(ColumnInfo {
                name: row.get("name")?,
                pk: row.get("pk")?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// The primary-key column, or `None`.
///
/// A table without a single-column primary key cannot be diffed row by row, so
/// it is COUNTED instead of being dropped from the corpus.
pub fn primary_key_of(db: &Connection, table: &str) -> Result<Option<String>> {
    let keys: Vec<String> = columns_of(db, table)?
        .into_iter()
        .filter(|column| column.pk > 0)
        .map(|column| column.name)
        .collect();
    Ok(if keys.len() == 1 {
        keys.into_iter().next()
    } else {
        None
    })
}

/// The digest of one row's values, in the column order the caller passes.
pub fn digest_values<'a>(
    values: impl IntoIterator<Item = rusqlite::types::ValueRef<'a>>,
) -> String {
    let mut hash = Sha256::new();
    for value in values {
        // Type is part of the digest: SQLite holds `1` where `'1'` was, and a
        // migration that changed a column's affinity changed the data.
        hash.update(encode_value(value).as_bytes());
        hash.update(b"\0");
    }
    let full = hex::encode(hash.finalize());
    full[..16].to_owned()
}

/// Freeze one table: the column names captured, and a pk -> digest map.
pub fn snapshot_table(db: &Connection, table: &str) -> Result<TableSnapshot> {
    let mut columns: Vec<String> = columns_of(db, table)?
        .into_iter()
        .map(|column| column.name)
        .collect();
    columns.sort();
    let Some(primary_key) = primary_key_of(db, table)? else {
        let rows: i64 = db.query_row(
            &format!("SELECT COUNT(*) FROM {}", quote_identifier(table)),
            [],
            |row| row.get(0),
        )?;
        return Ok(TableSnapshot {
            columns,
            primary_key: None,
            rows,
            digests: BTreeMap::new(),
        });
    };
    let (digests, rows) = digests_of(db, table, &columns, &primary_key, true)?;
    let rows = i64::try_from(rows).unwrap_or(i64::MAX);
    Ok(TableSnapshot {
        columns,
        primary_key: Some(primary_key),
        rows,
        digests,
    })
}

/// Freeze every table with at least one row. An empty table pins nothing.
pub fn snapshot_vault(db: &Connection) -> Result<VaultSnapshot> {
    let mut snapshot = VaultSnapshot::new();
    for table in snapshot_tables(db)? {
        let table_snapshot = snapshot_table(db, &table)?;
        if table_snapshot.rows > 0 {
            snapshot.insert(table, table_snapshot);
        }
    }
    Ok(snapshot)
}

/// Compare a frozen snapshot against the same vault after today's code opened
/// it. The findings ARE the failure message, one clause per problem.
pub fn compare_snapshot(frozen: &VaultSnapshot, db: &Connection) -> Result<SnapshotComparison> {
    let mut findings: Vec<String> = Vec::new();
    let mut compared_tables = 0usize;
    let mut compared_rows = 0usize;

    for (table, snapshot) in frozen {
        let live: Option<i64> = db
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
                [table],
                |row| row.get(0),
            )
            .optional()?;
        if live.is_none() {
            findings.push(format!(
                "table `{table}` held {} row(s) at freeze time and does not exist after migrating — every row in it is gone",
                snapshot.rows
            ));
            continue;
        }
        let live_columns: BTreeSet<String> = columns_of(db, table)?
            .into_iter()
            .map(|column| column.name)
            .collect();
        let dropped: Vec<&str> = snapshot
            .columns
            .iter()
            .filter(|name| !live_columns.contains(name.as_str()))
            .map(String::as_str)
            .collect();
        if !dropped.is_empty() {
            findings.push(format!(
                "table `{table}` lost column(s) {} — if that retirement is intended, re-freeze the golden corpus in the release that does it",
                dropped.join(", ")
            ));
            continue;
        }
        let Some(primary_key) = snapshot.primary_key.as_deref() else {
            let count: i64 = db.query_row(
                &format!("SELECT COUNT(*) FROM {}", quote_identifier(table)),
                [],
                |row| row.get(0),
            )?;
            if count < snapshot.rows {
                findings.push(format!(
                    "table `{table}` (no single-column primary key, counted only) went from {} to {count} row(s)",
                    snapshot.rows
                ));
            }
            compared_tables += 1;
            continue;
        };
        let (after, _) = digests_of(db, table, &snapshot.columns, primary_key, false)?;
        let mut dropped_rows: Vec<&str> = Vec::new();
        let mut mutated_rows: Vec<&str> = Vec::new();
        for (key, digest) in &snapshot.digests {
            compared_rows += 1;
            match after.get(key) {
                None => dropped_rows.push(key),
                Some(current) if current != digest => mutated_rows.push(key),
                Some(_) => {}
            }
        }
        if !dropped_rows.is_empty() {
            findings.push(format!(
                "table `{table}`: {} row(s) present before the upgrade are GONE after it (e.g. {})",
                dropped_rows.len(),
                dropped_rows
                    .iter()
                    .take(3)
                    .copied()
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        if !mutated_rows.is_empty() {
            findings.push(format!(
                "table `{table}`: {} row(s) had their values REWRITTEN by the upgrade (e.g. {})",
                mutated_rows.len(),
                mutated_rows
                    .iter()
                    .take(3)
                    .copied()
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        compared_tables += 1;
    }

    Ok(SnapshotComparison {
        ok: findings.is_empty(),
        findings,
        compared: Compared {
            tables: compared_tables,
            rows: compared_rows,
        },
    })
}

/// The pk -> digest map of a table over exactly `columns`.
///
/// `ordered` exists only to mirror the TypeScript: the freezer reads
/// `ORDER BY <pk>` and the comparison reads unordered, and since the result is
/// a map keyed by primary key the order cannot change the answer. Keeping the
/// difference visible is cheaper than explaining later why the port "improved"
/// on the oracle.
fn digests_of(
    db: &Connection,
    table: &str,
    columns: &[String],
    primary_key: &str,
    ordered: bool,
) -> Result<(BTreeMap<String, String>, usize)> {
    let selected = columns
        .iter()
        .map(|name| quote_identifier(name))
        .collect::<Vec<_>>()
        .join(", ");
    let order = if ordered {
        format!(" ORDER BY {}", quote_identifier(primary_key))
    } else {
        String::new()
    };
    let key_index = columns
        .iter()
        .position(|name| name == primary_key)
        .expect("the primary key is one of the table's columns");
    let mut statement = db.prepare(&format!(
        "SELECT {selected} FROM {}{order}",
        quote_identifier(table)
    ))?;
    let mut rows = statement.query([])?;
    let mut digests = BTreeMap::new();
    let mut counted = 0usize;
    while let Some(row) = rows.next()? {
        counted += 1;
        let values: Vec<rusqlite::types::ValueRef<'_>> = (0..columns.len())
            .map(|index| row.get_ref(index))
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let key = js_string_of(values[key_index]);
        digests.insert(key, digest_values(values));
    }
    Ok((digests, counted))
}

/// `String(value)` with no type prefix — how the TypeScript keys the digest map
/// (`String(row[pk])`).
fn js_string_of(value: rusqlite::types::ValueRef<'_>) -> String {
    use rusqlite::types::ValueRef;
    match value {
        ValueRef::Null => "null".to_owned(),
        ValueRef::Integer(int) => int.to_string(),
        ValueRef::Real(real) => js_number_to_string(real),
        ValueRef::Text(text) => String::from_utf8_lossy(text).into_owned(),
        ValueRef::Blob(bytes) => bytes
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join(","),
    }
}

/// A SQLite identifier, double-quoted with any embedded quote doubled.
fn quote_identifier(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_digest_is_sixteen_hex_characters_over_the_null_separated_values() {
        use rusqlite::types::ValueRef;
        let digest = digest_values([ValueRef::Text(b"a"), ValueRef::Null]);
        assert_eq!(digest.len(), 16);
        assert!(digest.chars().all(|c| c.is_ascii_hexdigit()));
        // The separator matters: without it "a" + null and "an" + "ull" would
        // hash alike, which is the class of bug a fixture cannot show.
        assert_ne!(
            digest,
            digest_values([ValueRef::Text(b"a\0nul"), ValueRef::Text(b"l")])
        );
    }

    #[test]
    fn identifier_quoting_survives_a_quote() {
        assert_eq!(quote_identifier(r#"we"ird"#), r#""we""ird""#);
    }
}
