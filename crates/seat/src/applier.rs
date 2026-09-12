//! The seat applier: the four rules, plus idempotent-by-seq.
//!
//! ## The four rules, each one a bug someone already shipped
//!
//! 1. **`INSERT … ON CONFLICT DO UPDATE`, never `INSERT OR REPLACE`.** REPLACE
//!    deletes the conflicting row first and fires the delete triggers only
//!    under `recursive_triggers` — so on a seat, whose only triggers are FTS
//!    sync, the index silently drifts from the data.
//! 2. **One transaction per commit, with the cursor in it.** The applied rows
//!    and the position are one fact. Split them and a crash between the two
//!    either replays a commit or skips one, and only one of those is
//!    recoverable.
//! 3. **The epoch gate refuses a row from another epoch, checked PER ROW** —
//!    the page header is what the gateway *believes*.
//! 4. **Table order, not dependency order, with foreign keys off.** A mirror
//!    does not re-decide what the writer committed; the log already carries
//!    every cascaded delete as its own row.
//!
//! ## And the fifth, which is the seat's own: idempotent BY SEQ
//!
//! A row at or below `applied_seq` is dropped **before it is bound**, not
//! merely allowed to be a harmless upsert. "Harmless" is false for a delete
//! followed by a re-insert: replay the delete and the re-inserted row is gone.
//! The statement renderer cannot save you here, so the filter is on the rows.
//!
//! ## Two hooks, and why they are two
//!
//! [`ApplyHooks::on_commit_in_transaction`] runs INSIDE the transaction that
//! carries the commit's rows, which is what lets an overlay be cleared
//! atomically with the rows that replace it — the one property that makes the
//! outbox sharing a *database* with the mirrored rows worth anything.
//! [`ApplyHooks::on_commit_durable`] runs AFTER `COMMIT`, because work told
//! before COMMIT has been told a fact that is not yet durable: a push
//! notification sent from inside the transaction survives a rollback and the
//! member is told about an edit that did not happen.
//!
//! ## The SQL is the gateway's
//!
//! [`centraid_vault::log::apply::apply_row_sql`] and `delete_row_sql` render
//! the statements. v0 had two hand-transcribed copies of the same four rules
//! and they drifted; this port has one renderer with two callers, and the
//! CONVERGENCE fixture runs through both.

use std::collections::BTreeMap;

use centraid_vault::log::apply::{apply_row_sql, delete_row_sql};
use centraid_vault::log::{LogOp, LogRow, primary_key_of};
use centraid_vault::value::Value;
use rusqlite::Connection;

use crate::error::{Result, SeatError};
use crate::state::{SeatState, seat_state};

/// What one apply pass did.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ApplyReport {
    /// Rows bound and executed. Excludes the ones dropped by rule 5.
    pub applied: usize,
    /// Rows dropped as already applied. A duplicate delivery reports its size
    /// here rather than reporting nothing, so "the page changed nothing" and
    /// "the page was empty" are different answers.
    pub duplicate: usize,
    pub commits: usize,
    /// `(table, pk)` per pass — what a screen redraws from. Nothing polls.
    pub touched: Vec<(String, Vec<Value>)>,
    /// The commit seqs this pass landed, ascending.
    pub commit_seqs: Vec<i64>,
    pub cursor: i64,
    pub applied_commit_seq: i64,
    /// Tables the pass wrote, deduplicated and ordered.
    pub tables: Vec<String>,
    /// A commit was over the defer threshold. A property of the COMMIT, riding
    /// on every row of it.
    pub deferred: bool,
    /// A `ddl` row ran. Never deferrable, whatever the commit says.
    pub ddl: bool,
}

/// What the applier tells the rest of the seat, and when.
///
/// Two closures rather than a trait: there is one implementor per seat and the
/// hooks capture the outbox by reference, which a trait object would make into
/// a lifetime argument for no gain.
#[derive(Default)]
pub struct ApplyHooks<'hook> {
    /// Called with each commit seq, INSIDE its transaction. An error here rolls
    /// the whole commit back — the overlay and the rows are one fact.
    #[allow(clippy::type_complexity)]
    pub on_commit_in_transaction: Option<&'hook mut dyn FnMut(&Connection, i64) -> Result<()>>,
    /// Called with each commit seq, AFTER `COMMIT`. Cannot fail the apply: the
    /// rows are durable and telling somebody about them is a separate concern.
    #[allow(clippy::type_complexity)]
    pub on_commit_durable: Option<&'hook mut dyn FnMut(i64)>,
}

/// The page's own header, separate from its rows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageHeader {
    pub epoch: String,
    pub schema_epoch: i64,
    pub ddl_version: i64,
    /// The gateway's watermark at the time the page was served. Recorded even
    /// when NOTHING was applied: a page of already-seen rows still tells the
    /// seat how far behind it is, and discarding that is how a caught-up seat
    /// reports itself as stale forever.
    pub watermark: i64,
}

/// Apply one page to `target`, one transaction per commit.
///
/// Returns [`SeatError::Drift`] before touching anything when the page's schema
/// epoch is not this file's: a re-bootstrap, not an apply.
pub fn apply_page(
    target: &Connection,
    header: &PageHeader,
    rows: &[LogRow],
    hooks: &mut ApplyHooks<'_>,
) -> Result<ApplyReport> {
    let state = seat_state(target)?;
    if header.schema_epoch != state.schema_epoch {
        return Err(SeatError::Drift {
            ours: state.schema_epoch,
            theirs: header.schema_epoch,
        });
    }

    // RULE 4. A mirror does not re-decide the writer's dependency order, so
    // the constraints the writer already satisfied are not re-checked here.
    target.pragma_update(None, "foreign_keys", "OFF")?;

    let mut report = ApplyReport {
        cursor: state.applied_seq,
        applied_commit_seq: state.applied_commit_seq,
        ..ApplyReport::default()
    };

    // RULE 3, on every row, and RULE 5 before binding.
    let mut grouped: BTreeMap<i64, Vec<&LogRow>> = BTreeMap::new();
    for row in rows {
        if row.epoch != state.epoch {
            return Err(SeatError::EpochGate {
                seq: row.seq,
                ours: state.epoch.clone(),
                theirs: row.epoch.clone(),
            });
        }
        if row.seq <= state.applied_seq {
            // RULE 5. Dropped BEFORE binding: "a harmless upsert" is not true
            // for a delete followed by a re-insert.
            report.duplicate += 1;
            continue;
        }
        grouped.entry(row.commit_seq).or_default().push(row);
    }

    for (commit_seq, group) in grouped {
        apply_one_commit(target, &state, commit_seq, &group, &mut report, hooks)?;
    }

    record_watermark(target, header, &report)?;
    Ok(report)
}

fn apply_one_commit(
    target: &Connection,
    state: &SeatState,
    commit_seq: i64,
    group: &[&LogRow],
    report: &mut ApplyReport,
    hooks: &mut ApplyHooks<'_>,
) -> Result<()> {
    target
        .execute_batch("BEGIN IMMEDIATE")
        .map_err(|error| SeatError::from_sqlite("opening an apply", error))?;

    let attempt = (|| -> Result<()> {
        let mut highest = report.cursor;
        for row in group {
            apply_one_row(target, row, report)?;
            highest = highest.max(row.seq);
        }
        // The overlay clears INSIDE the transaction that carries the rows.
        if let Some(hook) = hooks.on_commit_in_transaction.as_deref_mut() {
            hook(target, commit_seq)?;
        }
        // RULE 2. One statement, and it is in this transaction.
        target
            .execute(
                "UPDATE seat_state
                    SET applied_seq = MAX(applied_seq, ?1),
                        applied_commit_seq = MAX(applied_commit_seq, ?2),
                        ddl_version = ?3,
                        updated_at = ?4
                  WHERE singleton = 1",
                rusqlite::params![highest, commit_seq, state.ddl_version, now_text(target)?],
            )
            .map_err(|error| SeatError::from_sqlite("recording the seat cursor", error))?;
        report.cursor = report.cursor.max(highest);
        report.applied_commit_seq = report.applied_commit_seq.max(commit_seq);
        Ok(())
    })();

    match attempt {
        Ok(()) => {
            target
                .execute_batch("COMMIT")
                .map_err(|error| SeatError::from_sqlite("committing an apply", error))?;
            report.commits += 1;
            report.commit_seqs.push(commit_seq);
            // AFTER COMMIT, and it cannot fail the apply.
            if let Some(hook) = hooks.on_commit_durable.as_deref_mut() {
                hook(commit_seq);
            }
            Ok(())
        }
        Err(error) => {
            // THE COMMIT ROLLS BACK WHOLE. `applied_seq` is unchanged, so the
            // next pass resumes from the same cursor — which is what makes the
            // disk-full case recoverable rather than a re-bootstrap.
            let _ = target.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

fn apply_one_row(target: &Connection, row: &LogRow, report: &mut ApplyReport) -> Result<()> {
    // A `ddl` row is never deferrable, whatever the commit's flag says: a seat
    // that skipped the schema statement would apply the next commit's rows to a
    // table that does not have the column yet.
    if row.op == LogOp::Ddl {
        let Some(Value::Text(statement)) = row.row.as_ref().and_then(|image| image.get("sql"))
        else {
            return Err(SeatError::Invariant {
                context: format!("ddl row {} carries no `sql` in its image", row.seq),
            });
        };
        target
            .execute_batch(statement)
            .map_err(|error| SeatError::from_sqlite("running a ddl row", error))?;
        report.ddl = true;
        note(report, row);
        return Ok(());
    }

    report.deferred |= row.deferred;
    let key = primary_key_of(target, &row.table)?;

    if row.op == LogOp::Delete {
        let sql = delete_row_sql(&row.table, &key)?;
        let binds: Vec<&dyn rusqlite::ToSql> = row
            .primary_key
            .iter()
            .map(|value| value as &dyn rusqlite::ToSql)
            .collect();
        target
            .prepare_cached(&sql)?
            .execute(binds.as_slice())
            .map_err(|error| SeatError::from_sqlite("applying a delete", error))?;
    } else {
        let Some(image) = row.row.as_ref() else {
            return Err(SeatError::Invariant {
                context: format!(
                    "{} row {} on `{}` carries no image",
                    row.op.as_str(),
                    row.seq,
                    row.table
                ),
            });
        };
        let columns: Vec<String> = image.keys().cloned().collect();
        // RULE 1, rendered by the gateway's own function.
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
            .map_err(|error| SeatError::from_sqlite("applying a row", error))?;
    }
    note(report, row);
    Ok(())
}

fn note(report: &mut ApplyReport, row: &LogRow) {
    report
        .touched
        .push((row.table.clone(), row.primary_key.clone()));
    if !report.tables.contains(&row.table) {
        report.tables.push(row.table.clone());
    }
    report.applied += 1;
}

/// Record the page's watermark, whatever was applied.
///
/// Its own statement, outside the per-commit transactions, because it is a fact
/// about the PAGE and not about any commit in it — and because an unapplied
/// page (every row a duplicate) still carries one.
fn record_watermark(target: &Connection, header: &PageHeader, report: &ApplyReport) -> Result<()> {
    let now = now_text(target)?;
    target
        .execute(
            "UPDATE seat_state
                SET gateway_watermark = MAX(gateway_watermark, ?1),
                    ddl_version = MAX(ddl_version, ?2),
                    updated_at = ?3
              WHERE singleton = 1",
            rusqlite::params![header.watermark, header.ddl_version, now],
        )
        .map_err(|error| SeatError::from_sqlite("recording the gateway watermark", error))?;
    let _ = report;
    Ok(())
}

/// The seat's own clock, read through SQLite so it is the same text the DDL's
/// defaults would have written.
fn now_text(connection: &Connection) -> Result<String> {
    Ok(
        connection.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')", [], |row| {
            row.get(0)
        })?,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A page header for a file at `epoch`.
    fn header(epoch: &str, watermark: i64) -> PageHeader {
        PageHeader {
            epoch: epoch.to_owned(),
            schema_epoch: 4,
            ddl_version: 0,
            watermark,
        }
    }

    fn row(seq: i64, commit_seq: i64, epoch: &str, op: LogOp, id: &str) -> LogRow {
        let mut image = centraid_vault::RowImage::new();
        image.insert("id".to_owned(), Value::Text(id.to_owned()));
        image.insert("value".to_owned(), Value::Text(format!("v{seq}")));
        LogRow {
            seq,
            commit_seq,
            epoch: epoch.to_owned(),
            schema_epoch: 4,
            ddl_version: 0,
            table: "mirror".to_owned(),
            op,
            primary_key: vec![Value::Text(id.to_owned())],
            row: (op != LogOp::Delete).then_some(image),
            prior: None,
            indirect: false,
            producer: "test".to_owned(),
            deferred: false,
            local: false,
            committed_at: "2026-01-01T00:00:00.000Z".to_owned(),
        }
    }

    fn seat() -> Connection {
        let connection = Connection::open_in_memory().expect("opens");
        connection
            .execute_batch("CREATE TABLE mirror (id TEXT PRIMARY KEY, value TEXT) STRICT;")
            .expect("the mirror table");
        crate::state::init_seat_state(
            &connection,
            &crate::state::SeatPosition {
                vault_id: "v".to_owned(),
                epoch: "e".to_owned(),
                schema_epoch: 4,
                ddl_version: 0,
                applied_seq: 0,
                applied_commit_seq: 0,
            },
            "t",
        )
        .expect("the seat state");
        connection
    }

    fn value_of(connection: &Connection, id: &str) -> Option<String> {
        connection
            .query_row("SELECT value FROM mirror WHERE id = ?1", [id], |row| {
                row.get(0)
            })
            .ok()
    }

    #[test]
    fn one_transaction_per_commit_and_the_cursor_rides_in_it() {
        let connection = seat();
        let rows = [
            row(1, 1, "e", LogOp::Insert, "a"),
            row(2, 1, "e", LogOp::Insert, "b"),
            row(3, 2, "e", LogOp::Insert, "c"),
        ];
        let report = apply_page(
            &connection,
            &header("e", 3),
            &rows,
            &mut ApplyHooks::default(),
        )
        .expect("it applies");
        assert_eq!(report.commits, 2);
        assert_eq!(report.applied, 3);
        assert_eq!(report.commit_seqs, [1, 2]);
        let state = seat_state(&connection).expect("it reads");
        assert_eq!(state.applied_seq, 3);
        assert_eq!(state.applied_commit_seq, 2);
    }

    /// RULE 5. The property the seq filter exists for, which the upsert cannot
    /// provide: a delete replayed after a re-insert would remove live data.
    #[test]
    fn a_replayed_delete_after_a_reinsert_does_not_remove_the_live_row() {
        let connection = seat();
        let first = [
            row(1, 1, "e", LogOp::Insert, "a"),
            row(2, 2, "e", LogOp::Delete, "a"),
        ];
        apply_page(
            &connection,
            &header("e", 2),
            &first,
            &mut ApplyHooks::default(),
        )
        .expect("it applies");
        assert_eq!(value_of(&connection, "a"), None);

        let reinsert = [row(3, 3, "e", LogOp::Insert, "a")];
        apply_page(
            &connection,
            &header("e", 3),
            &reinsert,
            &mut ApplyHooks::default(),
        )
        .expect("it applies");
        assert_eq!(value_of(&connection, "a").as_deref(), Some("v3"));

        // The gateway redelivers the whole span. Without rule 5 the delete at
        // seq 2 lands again and the row the seat just learned about is gone.
        let redelivered = [
            row(1, 1, "e", LogOp::Insert, "a"),
            row(2, 2, "e", LogOp::Delete, "a"),
            row(3, 3, "e", LogOp::Insert, "a"),
        ];
        let report = apply_page(
            &connection,
            &header("e", 3),
            &redelivered,
            &mut ApplyHooks::default(),
        )
        .expect("it applies");
        assert_eq!(report.applied, 0);
        assert_eq!(report.duplicate, 3);
        assert_eq!(value_of(&connection, "a").as_deref(), Some("v3"));
    }

    #[test]
    fn the_same_page_twice_changes_nothing_and_says_so() {
        let connection = seat();
        let rows = [row(1, 1, "e", LogOp::Insert, "a")];
        let first = apply_page(
            &connection,
            &header("e", 1),
            &rows,
            &mut ApplyHooks::default(),
        )
        .expect("it applies");
        let second = apply_page(
            &connection,
            &header("e", 1),
            &rows,
            &mut ApplyHooks::default(),
        )
        .expect("it applies");
        assert_eq!(first.applied, 1);
        assert_eq!(second.applied, 0);
        assert_eq!(second.duplicate, 1);
        // "Changed nothing" and "was empty" are DIFFERENT answers.
        assert_eq!(second.commits, 0);
    }

    #[test]
    fn a_row_from_another_epoch_is_refused_per_row_and_nothing_lands() {
        let connection = seat();
        let rows = [
            row(1, 1, "e", LogOp::Insert, "a"),
            // The HEADER says `e`; this row does not. The header is what the
            // gateway believes.
            row(2, 1, "other", LogOp::Insert, "b"),
        ];
        let error = apply_page(
            &connection,
            &header("e", 2),
            &rows,
            &mut ApplyHooks::default(),
        )
        .expect_err("the gate refuses");
        assert!(matches!(error, SeatError::EpochGate { seq: 2, .. }));
        assert_eq!(value_of(&connection, "a"), None, "nothing was applied");
        assert_eq!(seat_state(&connection).expect("reads").applied_seq, 0);
    }

    #[test]
    fn a_schema_epoch_mismatch_is_drift_and_refuses_before_touching_anything() {
        let connection = seat();
        let mut drifted = header("e", 1);
        drifted.schema_epoch = 5;
        let rows = [row(1, 1, "e", LogOp::Insert, "a")];
        assert!(matches!(
            apply_page(&connection, &drifted, &rows, &mut ApplyHooks::default()),
            Err(SeatError::Drift { ours: 4, theirs: 5 })
        ));
        assert_eq!(value_of(&connection, "a"), None);
    }

    #[test]
    fn the_in_transaction_hook_sees_the_rows_and_can_roll_them_back() {
        let connection = seat();
        let rows = [row(1, 1, "e", LogOp::Insert, "a")];
        let mut seen: Vec<i64> = Vec::new();
        {
            let mut hook = |connection: &Connection, commit_seq: i64| -> Result<()> {
                // THE ROWS ARE VISIBLE HERE. That is the property.
                let value: String = connection
                    .query_row("SELECT value FROM mirror WHERE id = 'a'", [], |row| {
                        row.get(0)
                    })
                    .expect("the row is in this transaction");
                assert_eq!(value, "v1");
                seen.push(commit_seq);
                Ok(())
            };
            let mut hooks = ApplyHooks {
                on_commit_in_transaction: Some(&mut hook),
                on_commit_durable: None,
            };
            apply_page(&connection, &header("e", 1), &rows, &mut hooks).expect("it applies");
        }
        assert_eq!(seen, [1]);
    }

    #[test]
    fn a_failing_in_transaction_hook_rolls_the_whole_commit_back() {
        let connection = seat();
        let rows = [row(1, 1, "e", LogOp::Insert, "a")];
        let mut hook = |_: &Connection, _: i64| -> Result<()> {
            Err(SeatError::Invariant {
                context: "the overlay could not be cleared".to_owned(),
            })
        };
        let mut hooks = ApplyHooks {
            on_commit_in_transaction: Some(&mut hook),
            on_commit_durable: None,
        };
        assert!(apply_page(&connection, &header("e", 1), &rows, &mut hooks).is_err());
        // The overlay and the rows are ONE FACT: neither landed.
        assert_eq!(value_of(&connection, "a"), None);
        assert_eq!(seat_state(&connection).expect("reads").applied_seq, 0);
    }

    #[test]
    fn the_durable_hook_runs_after_commit_and_only_for_committed_work() {
        let connection = seat();
        let rows = [
            row(1, 1, "e", LogOp::Insert, "a"),
            row(2, 2, "e", LogOp::Insert, "b"),
        ];
        let mut told: Vec<i64> = Vec::new();
        {
            let mut durable = |commit_seq: i64| told.push(commit_seq);
            let mut hooks = ApplyHooks {
                on_commit_in_transaction: None,
                on_commit_durable: Some(&mut durable),
            };
            apply_page(&connection, &header("e", 2), &rows, &mut hooks).expect("it applies");
        }
        assert_eq!(told, [1, 2]);
    }

    /// An unapplied page still records its watermark. Without this a caught-up
    /// seat reports itself stale forever.
    #[test]
    fn an_unapplied_page_still_records_the_gateway_watermark() {
        let connection = seat();
        let report = apply_page(
            &connection,
            &header("e", 4_000),
            &[],
            &mut ApplyHooks::default(),
        )
        .expect("an empty page applies");
        assert_eq!(report.applied, 0);
        let state = seat_state(&connection).expect("reads");
        assert_eq!(state.gateway_watermark, 4_000);
        assert_eq!(crate::state::watermark(&state).behind, 4_000);
    }

    #[test]
    fn the_watermark_never_moves_backwards() {
        let connection = seat();
        apply_page(
            &connection,
            &header("e", 500),
            &[],
            &mut ApplyHooks::default(),
        )
        .expect("applies");
        apply_page(
            &connection,
            &header("e", 100),
            &[],
            &mut ApplyHooks::default(),
        )
        .expect("applies");
        assert_eq!(
            seat_state(&connection).expect("reads").gateway_watermark,
            500
        );
    }

    #[test]
    fn a_ddl_row_runs_its_statement_and_is_never_skipped_as_deferred() {
        let connection = seat();
        let mut ddl = row(1, 1, "e", LogOp::Ddl, "ignored");
        let mut image = centraid_vault::RowImage::new();
        image.insert(
            "sql".to_owned(),
            Value::Text("ALTER TABLE mirror ADD COLUMN added TEXT".to_owned()),
        );
        ddl.row = Some(image);
        // The commit says "defer me". A ddl row does not get to be deferred.
        ddl.deferred = true;
        let report = apply_page(
            &connection,
            &header("e", 1),
            &[ddl],
            &mut ApplyHooks::default(),
        )
        .expect("it applies");
        assert!(report.ddl);
        assert!(
            centraid_vault::log::table_columns(&connection, "mirror")
                .expect("columns read")
                .iter()
                .any(|column| column == "added")
        );
    }

    #[test]
    fn the_defer_flag_is_a_property_of_the_commit_and_rides_on_every_row() {
        let connection = seat();
        let mut rows = [
            row(1, 1, "e", LogOp::Insert, "a"),
            row(2, 1, "e", LogOp::Insert, "b"),
        ];
        for entry in &mut rows {
            entry.deferred = true;
        }
        let report = apply_page(
            &connection,
            &header("e", 2),
            &rows,
            &mut ApplyHooks::default(),
        )
        .expect("it applies");
        assert!(report.deferred);
    }

    #[test]
    fn commits_are_applied_in_ascending_order_whatever_order_the_rows_arrived_in() {
        let connection = seat();
        // Out of order on the wire; the grouping is a BTreeMap for exactly
        // this reason — a later commit applied first would overwrite an
        // earlier one's value with a stale image.
        let rows = [
            row(3, 2, "e", LogOp::Insert, "a"),
            row(1, 1, "e", LogOp::Insert, "a"),
        ];
        let report = apply_page(
            &connection,
            &header("e", 3),
            &rows,
            &mut ApplyHooks::default(),
        )
        .expect("it applies");
        assert_eq!(report.commit_seqs, [1, 2]);
        assert_eq!(value_of(&connection, "a").as_deref(), Some("v3"));
    }

    #[test]
    fn a_missing_seat_state_is_said_rather_than_defaulted() {
        let connection = Connection::open_in_memory().expect("opens");
        assert!(matches!(
            apply_page(
                &connection,
                &header("e", 0),
                &[],
                &mut ApplyHooks::default()
            ),
            Err(SeatError::StateMissing)
        ));
    }
}
