//! The CONVERGENCE comparator, and the readers a convergence check needs.
//!
//! One comparator, every caller. Before this module existed the same walk was
//! written three times — inside `tests/gates.rs`, inside lane R's restore drill,
//! and inside `crates/sim`'s invariants — and the third copy was written because
//! the first two were `#[test]`-private. Three copies of a comparison is three
//! comparisons, and the one that is wrong is the one nobody re-reads.
//!
//! It lives here because it is SQL, and SQL lives in the five crates the
//! `sql-confinement` rule names. That rule is what surfaced the duplication:
//! `crates/sim` could not hold its own copy, and the right answer to "I cannot
//! put a query here" turned out to be "there should only have been one query".
//!
//! ## Values, not bytes
//!
//! Two SQLite files holding the same rows are not byte-identical — page order,
//! free pages and the WAL all differ, and a `VACUUM` changes the bytes without
//! changing an answer. So the comparison is per-table, per-row, per-column,
//! ordered by the whole projection, and a caller compares the two maps.

use std::collections::BTreeMap;

use rusqlite::Connection;

use crate::error::Result;
use crate::value::{RowImage, Value, row_image_to_json};

/// Every replicated table's rows, as comparable values.
///
/// Ordered by the whole projection, so two files holding the same rows in a
/// different physical order compare equal.
pub fn replicated_state(connection: &Connection) -> Result<BTreeMap<String, Vec<String>>> {
    let tables = {
        let mut statement = connection.prepare(
            r"SELECT name FROM sqlite_master
                WHERE type = 'table' AND name NOT LIKE 'sqlite\_%' ESCAPE '\'
                ORDER BY name",
        )?;
        statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };

    let mut state = BTreeMap::new();
    for table in tables {
        if !centraid_ontology::registries::is_replicated_table(&table) {
            continue;
        }
        let columns = crate::log::table_columns(connection, &table)?;
        let projection = columns
            .iter()
            .map(|column| crate::log::quoted(column))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "SELECT {projection} FROM {} ORDER BY {projection}",
            crate::log::quoted(&table)
        );
        let mut statement = connection.prepare(&sql)?;
        let rows = statement
            .query_map([], |row| {
                let mut image = RowImage::new();
                for (index, column) in columns.iter().enumerate() {
                    image.insert(
                        column.clone(),
                        Value::from_ref(row.get_ref(index)?).unwrap_or(Value::Null),
                    );
                }
                Ok(row_image_to_json(&image))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        state.insert(table, rows);
    }
    Ok(state)
}

/// One log row's position, for a contiguity check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LogPosition {
    pub seq: i64,
    pub commit_seq: i64,
}

/// Every log row's position in one epoch, ascending by `seq`.
pub fn log_positions(connection: &Connection, epoch: &str) -> Result<Vec<LogPosition>> {
    let mut statement = connection
        .prepare("SELECT seq, commit_seq FROM replica_log WHERE epoch = ?1 ORDER BY seq")?;
    Ok(statement
        .query_map([epoch], |row| {
            Ok(LogPosition {
                seq: row.get(0)?,
                commit_seq: row.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

/// The singleton's epoch, floor and recorded `commit_seq`.
///
/// A named reader, so a caller outside this crate does not need to know that
/// `replica_meta` is a table with a `singleton` column.
pub fn position(connection: &Connection) -> Result<(String, i64, i64)> {
    let meta = crate::log::store::meta(connection)?;
    Ok((meta.epoch, meta.floor_seq, meta.commit_seq))
}

/// The highest `commit_seq` the log carries, or zero.
pub fn highest_logged_commit(connection: &Connection) -> Result<i64> {
    Ok(connection.query_row(
        "SELECT COALESCE(MAX(commit_seq), 0) FROM replica_log",
        [],
        |row| row.get(0),
    )?)
}

/// Intent ids whose `(intent_id, payload_hash)` pair appears more than once.
///
/// The idempotency ledger's own invariant: one row per pair. A non-empty answer
/// means the same intent under the same payload was recorded twice.
pub fn duplicate_outcome_rows(connection: &Connection) -> Result<Vec<(String, String, i64)>> {
    let mut statement = connection.prepare(
        "SELECT intent_id, payload_hash, COUNT(*) FROM replica_intent_outcome
          GROUP BY intent_id, payload_hash HAVING COUNT(*) > 1 ORDER BY intent_id",
    )?;
    Ok(statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Intent ids holding more than one payload hash — the reuse the ledger exists
/// to refuse.
pub fn reused_intent_ids(connection: &Connection) -> Result<Vec<(String, i64)>> {
    let mut statement = connection.prepare(
        "SELECT intent_id, COUNT(DISTINCT payload_hash) FROM replica_intent_outcome
          GROUP BY intent_id HAVING COUNT(DISTINCT payload_hash) > 1 ORDER BY intent_id",
    )?;
    Ok(statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

/// What one executed intent's evidence looks like: its invocation and its
/// receipt, counted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IntentEvidence {
    pub intent_id: String,
    pub invocation_id: String,
    /// Must be exactly 1: an intent executed more than once, or not at all.
    pub invocations: i64,
    /// Must be exactly 1: neither duplicated nor lost by redelivery.
    pub receipts: i64,
}

/// The evidence for every executed intent.
pub fn executed_intent_evidence(connection: &Connection) -> Result<Vec<IntentEvidence>> {
    let mut statement = connection.prepare(
        "SELECT o.intent_id, o.invocation_id,
                (SELECT COUNT(*) FROM agent_command_invocation i
                  WHERE i.invocation_id = o.invocation_id),
                (SELECT COUNT(*) FROM access_receipt r
                  WHERE r.invocation_id = o.invocation_id)
           FROM replica_intent_outcome o
          WHERE o.status = 'executed' AND o.invocation_id IS NOT NULL
          ORDER BY o.intent_id",
    )?;
    Ok(statement
        .query_map([], |row| {
            Ok(IntentEvidence {
                intent_id: row.get(0)?,
                invocation_id: row.get(1)?,
                invocations: row.get(2)?,
                receipts: row.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

/// How many rows a table holds. For a test or a diagnostic that wants a count
/// without writing a query.
pub fn row_count(connection: &Connection, table: &str) -> Result<i64> {
    Ok(connection.query_row(
        &format!("SELECT COUNT(*) FROM {}", crate::log::quoted(table)),
        [],
        |row| row.get(0),
    )?)
}

/// How many invocations reached `executed`.
pub fn executed_invocations(connection: &Connection) -> Result<i64> {
    Ok(connection.query_row(
        "SELECT COUNT(*) FROM agent_command_invocation WHERE status = 'executed'",
        [],
        |row| row.get(0),
    )?)
}

impl crate::file::Vault {
    /// The vault's own party — the owner's, written at founding.
    ///
    /// A named reader because every caller outside this crate wanted it and
    /// each one was writing `SELECT self_party_id FROM core_vault LIMIT 1`.
    pub fn self_party_id(&self) -> Result<String> {
        self.read(|connection| {
            Ok(
                connection.query_row(
                    "SELECT self_party_id FROM core_vault LIMIT 1",
                    [],
                    |row| row.get(0),
                )?,
            )
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_comparator_walks_the_allow_list_and_not_the_tables_a_script_touched() {
        let dir = centraid_ontology::golden::scratch_dir();
        std::fs::create_dir_all(&dir).expect("the directory is made");
        let vault = crate::file::Vault::create(dir.join("v.db")).expect("a vault");
        vault.found("T", "O").expect("founded");
        let state = vault.read(replicated_state).expect("the state reads");
        assert!(
            state.len() > 100,
            "only {} table(s) were walked; the allow-list holds 109 and a comparator \
             that walks fewer is a comparison over less than it claims",
            state.len()
        );
        // A private table is NOT in the answer: it is not replicated, so a seat
        // does not have it and comparing it would always find a difference.
        assert!(!state.contains_key("locker_key"));
        assert!(state.contains_key("core_party"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_clean_ledger_reports_no_duplicates_and_no_reuse() {
        let dir = centraid_ontology::golden::scratch_dir();
        std::fs::create_dir_all(&dir).expect("made");
        let vault = crate::file::Vault::create(dir.join("v.db")).expect("a vault");
        vault.found("T", "O").expect("founded");
        vault
            .read(|connection| {
                assert!(duplicate_outcome_rows(connection)?.is_empty());
                assert!(reused_intent_ids(connection)?.is_empty());
                assert!(executed_intent_evidence(connection)?.is_empty());
                // And the positions read, on a vault whose log has rows.
                let (epoch, floor, commit_seq) = position(connection)?;
                assert!(!epoch.is_empty());
                assert_eq!(floor, 0, "an unpruned log has a floor of zero");
                assert!(commit_seq >= 1, "founding is a commit");
                assert!(!log_positions(connection, &epoch)?.is_empty());
                assert_eq!(highest_logged_commit(connection)?, commit_seq);
                Ok(())
            })
            .expect("the readers run");
        assert_eq!(
            vault.self_party_id().expect("the owner reads").len(),
            36,
            "a uuid"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
