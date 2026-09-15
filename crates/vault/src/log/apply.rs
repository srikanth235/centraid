//! Replaying log rows into a copy — the applier, gateway-side.
//!
//! This is the seat's half of the plane and it lives here because the
//! CONVERGENCE gate needs it: "a copy taken at seq S and fed S..N equals the
//! gateway at the watermark" is only a claim until something replays the rows,
//! and a test that replays them with bespoke SQL proves nothing about the
//! applier a phone will run. `crates/seat` (lane D2) reuses this function
//! rather than writing a second one.
//!
//! ## Four rules, each one a bug someone already shipped
//!
//! 1. **`INSERT … ON CONFLICT DO UPDATE`, never `INSERT OR REPLACE`.** REPLACE
//!    deletes the conflicting row before inserting, and fires the delete
//!    triggers only under `recursive_triggers` — so on a seat, whose only
//!    triggers are FTS sync, the index silently drifts from the data.
//! 2. **One transaction per commit, with the cursor in it.** Applied rows and
//!    the position are one fact. Split them and a crash between the two either
//!    replays a commit or skips one, and only one of those is recoverable.
//! 3. **The epoch gate refuses a row from another epoch**, checked PER ROW,
//!    because a page header is what the gateway believes. Without it a schema
//!    mismatch is a silent no-op: rows land in tables whose shape has moved,
//!    and the first symptom is a query returning the wrong answer.
//! 4. **Table order, not dependency order, with foreign keys off.** A mirror
//!    does not re-decide what the writer committed; the log already carries
//!    every cascaded delete as its own row, so ordering by dependency would be
//!    re-deriving a conclusion it was handed.
//!
//! Idempotence under duplicate delivery is not an extra feature but the same
//! property twice: an insert of a row already present is the upsert's no-op,
//! and a delete of a row already gone deletes nothing. A batch delivered twice
//! lands the same state, and a cursor that refuses to move backwards keeps the
//! second delivery from undoing progress.

use std::collections::BTreeMap;

use rusqlite::Connection;

use crate::error::{Result, VaultError};
use crate::log::capture::{primary_key_of, quoted};
use crate::log::store::LogRow;
use crate::value::Value;

/// What one replay did.
#[derive(Debug, Clone, PartialEq)]
pub struct ApplyOutcome {
    pub applied: usize,
    pub commits: usize,
    /// `(table, pk)` per batch — what a screen redraws from; nothing polls.
    pub touched: Vec<(String, Vec<Value>)>,
    /// The highest seq applied, never below the cursor it was given.
    pub cursor: i64,
    pub applied_commit_seq: i64,
}

/// Replay `rows` into `target`, one transaction per commit.
///
/// `expected_epoch` is the epoch the target file believes it is in; a row from
/// another epoch is refused rather than applied.
pub fn apply_log_page(
    target: &Connection,
    rows: &[LogRow],
    expected_epoch: Option<&str>,
    cursor: i64,
) -> Result<ApplyOutcome> {
    // A mirror does not re-decide the writer's dependency order.
    target.pragma_update(None, "foreign_keys", "OFF")?;

    let mut grouped: BTreeMap<i64, Vec<&LogRow>> = BTreeMap::new();
    for row in rows {
        if let Some(expected) = expected_epoch
            && row.epoch != expected
        {
            return Err(VaultError::Invariant {
                context: format!(
                    "replica apply: row {} carries epoch `{}` and this file is `{expected}`",
                    row.seq, row.epoch
                ),
            });
        }
        grouped.entry(row.commit_seq).or_default().push(row);
    }

    let mut outcome = ApplyOutcome {
        applied: 0,
        commits: 0,
        touched: Vec::new(),
        cursor,
        applied_commit_seq: 0,
    };

    for (commit_seq, group) in grouped {
        target
            .execute_batch("BEGIN IMMEDIATE")
            .map_err(|error| VaultError::from_sqlite("opening an apply", error))?;
        let attempt = apply_one_commit(target, &group, &mut outcome);
        match attempt {
            Ok(()) => {
                // The cursor rides in the SAME transaction as the rows it
                // stands for. `MAX` is the never-backwards guard: a duplicate
                // delivery of an older batch cannot undo progress.
                target.execute(
                    "UPDATE replica_meta
                        SET floor_seq = MAX(floor_seq, 0), updated_at = updated_at
                      WHERE singleton = 1",
                    [],
                )?;
                target
                    .execute_batch("COMMIT")
                    .map_err(|error| VaultError::from_sqlite("committing an apply", error))?;
                outcome.commits += 1;
                outcome.applied_commit_seq = outcome.applied_commit_seq.max(commit_seq);
            }
            Err(error) => {
                let _ = target.execute_batch("ROLLBACK");
                return Err(error);
            }
        }
    }
    Ok(outcome)
}

fn apply_one_commit(
    target: &Connection,
    group: &[&LogRow],
    outcome: &mut ApplyOutcome,
) -> Result<()> {
    for row in group {
        if row.op == crate::log::LogOp::Ddl {
            // A `ddl` row carries its statement in the image, under `sql`.
            if let Some(Value::Text(statement)) =
                row.row.as_ref().and_then(|image| image.get("sql"))
            {
                target.execute_batch(statement)?;
            }
            continue;
        }
        let key = primary_key_of(target, &row.table)?;
        if row.op == crate::log::LogOp::Delete {
            let sql = delete_row_sql(&row.table, &key)?;
            let binds: Vec<&dyn rusqlite::ToSql> = row
                .primary_key
                .iter()
                .map(|value| value as &dyn rusqlite::ToSql)
                .collect();
            target
                .prepare_cached(&sql)?
                .execute(binds.as_slice())
                .map_err(|error| VaultError::from_sqlite("applying a delete", error))?;
        } else {
            let Some(image) = row.row.as_ref() else {
                return Err(VaultError::Invariant {
                    context: format!(
                        "replica apply: {} row {} on `{}` carries no image",
                        row.op.as_str(),
                        row.seq,
                        row.table
                    ),
                });
            };
            let columns: Vec<String> = image.keys().cloned().collect();
            let sql = apply_row_sql(&row.table, &columns, &key)?;
            let values: Vec<&Value> = columns
                .iter()
                .map(|column| image.get(column).expect("the key came from the map"))
                .collect();
            let binds: Vec<&dyn rusqlite::ToSql> = values
                .iter()
                .map(|value| *value as &dyn rusqlite::ToSql)
                .collect();
            target
                .prepare_cached(&sql)?
                .execute(binds.as_slice())
                .map_err(|error| VaultError::from_sqlite("applying a row", error))?;
        }
        outcome
            .touched
            .push((row.table.clone(), row.primary_key.clone()));
        outcome.applied += 1;
        outcome.cursor = outcome.cursor.max(row.seq);
    }
    Ok(())
}

/// The statement a copy applies an insert or update row with.
pub fn apply_row_sql(table: &str, columns: &[String], primary_key: &[String]) -> Result<String> {
    if columns.is_empty() {
        return Err(VaultError::Invariant {
            context: format!("replica apply: `{table}` row image has no columns"),
        });
    }
    if primary_key.is_empty() {
        return Err(VaultError::Invariant {
            context: format!("replica apply: `{table}` has no declared primary key"),
        });
    }
    let assignable: Vec<&String> = columns
        .iter()
        .filter(|column| !primary_key.contains(column))
        .collect();
    let tail = if assignable.is_empty() {
        // A row that is nothing but its key still has to land. DO NOTHING is
        // the correct no-op, and it is not the same statement as DO UPDATE with
        // an empty SET, which is a syntax error.
        "NOTHING".to_owned()
    } else {
        let sets = assignable
            .iter()
            .map(|column| format!("{0} = excluded.{0}", quoted(column)))
            .collect::<Vec<_>>()
            .join(", ");
        format!("UPDATE SET {sets}")
    };
    Ok(format!(
        "INSERT INTO {} ({})\nVALUES ({})\nON CONFLICT ({}) DO {tail}",
        quoted(table),
        columns
            .iter()
            .map(|column| quoted(column))
            .collect::<Vec<_>>()
            .join(", "),
        vec!["?"; columns.len()].join(", "),
        primary_key
            .iter()
            .map(|column| quoted(column))
            .collect::<Vec<_>>()
            .join(", "),
    ))
}

/// The statement a copy applies a delete row with.
pub fn delete_row_sql(table: &str, primary_key: &[String]) -> Result<String> {
    if primary_key.is_empty() {
        return Err(VaultError::Invariant {
            context: format!("replica apply: `{table}` has no declared primary key"),
        });
    }
    let predicate = primary_key
        .iter()
        .map(|column| format!("{} = ?", quoted(column)))
        .collect::<Vec<_>>()
        .join(" AND ");
    Ok(format!("DELETE FROM {} WHERE {predicate}", quoted(table)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_upsert_never_says_replace() {
        let sql = apply_row_sql(
            "core_party",
            &["party_id".to_owned(), "display_name".to_owned()],
            &["party_id".to_owned()],
        )
        .expect("it renders");
        assert!(sql.contains("ON CONFLICT (\"party_id\") DO UPDATE SET"));
        assert!(sql.contains("\"display_name\" = excluded.\"display_name\""));
        // RULE 1. A seat's only triggers are FTS sync, and REPLACE fires the
        // delete ones only under `recursive_triggers`.
        assert!(!sql.contains("REPLACE"));
        // The key is never in the SET clause: assigning it from `excluded`
        // would be a no-op at best and a rename at worst.
        assert!(!sql.contains("\"party_id\" = excluded"));
    }

    #[test]
    fn a_key_only_row_does_nothing_rather_than_setting_nothing() {
        let sql = apply_row_sql("t", &["id".to_owned()], &["id".to_owned()]).expect("renders");
        assert!(sql.ends_with("DO NOTHING"));
        assert!(!sql.contains("UPDATE SET"));
    }

    #[test]
    fn a_composite_key_names_every_column_in_both_places() {
        let sql = apply_row_sql(
            "t",
            &["a".to_owned(), "b".to_owned(), "c".to_owned()],
            &["a".to_owned(), "b".to_owned()],
        )
        .expect("renders");
        assert!(sql.contains("ON CONFLICT (\"a\", \"b\")"));
        assert_eq!(
            delete_row_sql("t", &["a".to_owned(), "b".to_owned()]).expect("renders"),
            "DELETE FROM \"t\" WHERE \"a\" = ? AND \"b\" = ?"
        );
    }
}
