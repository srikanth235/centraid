//! THE PREDICTED WRITE, APPLIED IN PLACE (#1025 S7, item 4).
//!
//! A member types, taps save, and the row changes ON SCREEN AT ONCE — before
//! any network, and on a phone that has none. What they are looking at is the
//! replica, and the replica has their write in it, because the seat ran the
//! real handler and **applied what it produced**.
//!
//! ## WHY IT IS AN APPLY AND NOT AN OVERLAY
//!
//! The overlay was a column PAINT over a hand-written
//! `{entity: {rowId: {column: value}}}` payload, and two things were wrong with
//! it. The visible one: **nothing produced it** — `Request::Intent` set
//! `optimistic: None` under a paragraph explaining that guessing what a handler
//! will write is how a screen shows a value the gateway never agreed to. The
//! one underneath: **a projection cannot be written correctly per app**, so
//! every read had to be composed with it, every app's statement had to be
//! composable, and a row a write CREATED had no place in a keyset window at
//! all.
//!
//! A prediction is not a description of a write. It is the write. So the seat
//! executes the command against its own replica
//! ([`centraid_vault::Vault::predict`]), takes the row images the handler
//! produced — the same shape `replica_log` carries — and applies them through
//! **the same SQL renderer the gateway's own pages go through**
//! (`centraid_vault::log::apply`). Reads are then plain reads: there is no
//! composition anywhere, no per-app projection code, and a created row is in
//! its window because it is a row.
//!
//! ## WHAT MAKES IT TAKE-BACKABLE
//!
//! Every row the predicted apply touches has its PRIOR image journalled here
//! first, keyed by the intent. Three things consume that journal, and between
//! them a pending write can always be undone or superseded:
//!
//! * **The answer lands.** The applier upserts the gateway's canonical row and
//!   [`forget_rows`] drops the entry in the same transaction (R24). There is no
//!   instant at which the prediction and the truth are both visible, and none
//!   at which neither is.
//! * **A canonical page touches the row first.** TRUTH WINS: the same call
//!   drops the entry, because a prior image from before a commit the gateway
//!   has since made is not a state this device may return to.
//! * **The write is refused, or fails terminally.** [`restore`] puts the prior
//!   images back, newest first, and drops the entries.
//!
//! **A later intent's journal is rewritten rather than overwritten.** If X and
//! then Y both wrote one row, Y's journalled prior is X's RESULT; taking X back
//! must not wipe Y's prediction, so X's prior is written into Y's entry and the
//! row is left alone. When Y is later taken back it restores to the state
//! before either — which is the only answer that is right for both orders.
//!
//! ## THE INVARIANT
//!
//! **An empty outbox means an empty journal means a replica that is byte-equal
//! to the gateway's replicated tables.** That is one sentence and it is the
//! whole correctness claim: a seat's file differs from the gateway's only by
//! writes the gateway has not answered yet, and every one of those has an entry
//! here saying how to take it back.

use rusqlite::Connection;

use centraid_vault::log::LogOp;
use centraid_vault::log::apply::{apply_row_sql, delete_row_sql};
use centraid_vault::log::primary_key_of;
use centraid_vault::value::{
    RowImage, Value, key_from_json, key_to_json, row_image_from_json, row_image_to_json,
};

use crate::error::{Result, SeatError};

/// The DDL.
///
/// `ordinal` keeps the handler's own order within one intent, because restoring
/// runs backwards through it: two changes to one row in one command are two
/// changes in an order the handler chose, and the prior to restore is the first
/// one's.
pub const SEAT_PENDING_DDL: &str = r"
CREATE TABLE IF NOT EXISTS seat_pending_rows (
  intent_id   TEXT NOT NULL,
  ordinal     INTEGER NOT NULL,
  table_name  TEXT NOT NULL,
  pk_json     TEXT NOT NULL,
  -- NULL is a row that DID NOT EXIST before this write. Taking the write back
  -- deletes it; a NULL that meant `the columns were all null` would leave a
  -- ghost row behind on every predicted insert.
  prior_json  TEXT,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (intent_id, ordinal)
) STRICT;
CREATE INDEX IF NOT EXISTS seat_pending_rows_key_idx
  ON seat_pending_rows(table_name, pk_json);
";

/// One row a predicted write is about to change.
///
/// The seat's spelling of `centraid_vault`'s decoded change: this crate applies
/// it and journals it, and does not need the seq, the producer or the epoch a
/// real log row carries — a prediction has no position.
#[derive(Debug, Clone, PartialEq)]
pub struct PredictedRow {
    pub table: String,
    pub op: LogOp,
    pub primary_key: Vec<Value>,
    /// The NEW image for an insert or update; `None` for a delete.
    pub row: Option<RowImage>,
}

/// What a predicted apply changed.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Predicted {
    /// `(table, primary key)` per row, in apply order. The same list a real
    /// page's apply reports, and it is what the change stream is told — a
    /// member's own write moves their screen through the one consumer every
    /// other change moves it through, with no event kind of its own.
    pub touched: Vec<(String, Vec<Value>)>,
    /// Journal entries written.
    pub journalled: usize,
}

/// Create the table if it is not there.
pub fn open(connection: &Connection) -> Result<()> {
    connection.execute_batch(SEAT_PENDING_DDL)?;
    Ok(())
}

/// Apply one intent's predicted page to the replica, journalling what it
/// replaced.
///
/// **In one transaction**, so a crash leaves either the write and its journal
/// or neither. The caller is `centraid_core`'s write door, which has already
/// queued the intent — and queues it in the same `apply_replica` body, so a row
/// with no journal and a journal with no row are both unreachable.
///
/// The cursor is NOT moved. A prediction has no position in the gateway's log
/// and `seat_state.applied_seq` is the gateway's number; advancing it would
/// make this device skip the commit that answers this very write.
pub fn apply_prediction(
    connection: &Connection,
    intent_id: &str,
    rows: &[PredictedRow],
    now: &str,
) -> Result<Predicted> {
    open(connection)?;
    let mut predicted = Predicted::default();
    if rows.is_empty() {
        return Ok(predicted);
    }
    // RULE 4, AS THE APPLIER HAS IT. A mirror does not re-decide what the
    // writer committed, and a prediction is the same shape: the handler already
    // satisfied the constraints on the gateway's own schema.
    connection.pragma_update(None, "foreign_keys", "OFF")?;
    connection
        .execute_batch("BEGIN IMMEDIATE")
        .map_err(|error| SeatError::from_sqlite("opening a predicted apply", error))?;
    let attempt = (|| -> Result<()> {
        for (ordinal, row) in rows.iter().enumerate() {
            let key = primary_key_of(connection, &row.table)?;
            let prior = read_row(connection, &row.table, &key, &row.primary_key)?;
            journal(connection, intent_id, ordinal, row, prior.as_ref(), now)?;
            write_row(connection, row, &key)?;
            predicted
                .touched
                .push((row.table.clone(), row.primary_key.clone()));
            predicted.journalled += 1;
        }
        Ok(())
    })();
    match attempt {
        Ok(()) => {
            connection
                .execute_batch("COMMIT")
                .map_err(|error| SeatError::from_sqlite("committing a predicted apply", error))?;
            Ok(predicted)
        }
        Err(error) => {
            // NOTHING HALF-APPLIED. The member's write is refused whole and the
            // replica is exactly what it was, which is the only state a screen
            // can be drawn from honestly.
            let _ = connection.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

/// Journal one row's prior image, rewriting a later intent's entry if there is
/// one.
fn journal(
    connection: &Connection,
    intent_id: &str,
    ordinal: usize,
    row: &PredictedRow,
    prior: Option<&RowImage>,
    now: &str,
) -> Result<()> {
    connection.execute(
        "INSERT OR REPLACE INTO seat_pending_rows
           (intent_id, ordinal, table_name, pk_json, prior_json, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![
            intent_id,
            i64::try_from(ordinal).unwrap_or(i64::MAX),
            row.table,
            key_to_json(&row.primary_key),
            prior.map(row_image_to_json),
            now,
        ],
    )?;
    Ok(())
}

/// The row as the replica holds it now, or `None` when it is not there.
fn read_row(
    connection: &Connection,
    table: &str,
    key: &[String],
    values: &[Value],
) -> Result<Option<RowImage>> {
    if key.len() != values.len() {
        return Err(SeatError::Invariant {
            context: format!(
                "`{table}` has {} key columns and the predicted row carries {}",
                key.len(),
                values.len()
            ),
        });
    }
    let predicate = key
        .iter()
        .enumerate()
        .map(|(index, column)| format!("{} = ?{}", centraid_vault::log::quoted(column), index + 1))
        .collect::<Vec<_>>()
        .join(" AND ");
    let sql = format!(
        "SELECT * FROM {} WHERE {predicate}",
        centraid_vault::log::quoted(table)
    );
    let binds: Vec<&dyn rusqlite::ToSql> = values
        .iter()
        .map(|value| value as &dyn rusqlite::ToSql)
        .collect();
    let mut statement = connection.prepare(&sql)?;
    let mut found = statement.query(binds.as_slice())?;
    let Some(row) = found.next()? else {
        return Ok(None);
    };
    let columns: Vec<String> = row
        .as_ref()
        .column_names()
        .into_iter()
        .map(str::to_owned)
        .collect();
    let mut image = RowImage::new();
    for (index, column) in columns.iter().enumerate() {
        image.insert(column.clone(), Value::from_ref(row.get_ref(index)?)?);
    }
    Ok(Some(image))
}

/// Write one predicted row, through the gateway's own statement renderer.
fn write_row(connection: &Connection, row: &PredictedRow, key: &[String]) -> Result<()> {
    if row.op == LogOp::Delete {
        let sql = delete_row_sql(&row.table, key)?;
        let binds: Vec<&dyn rusqlite::ToSql> = row
            .primary_key
            .iter()
            .map(|value| value as &dyn rusqlite::ToSql)
            .collect();
        connection
            .prepare_cached(&sql)?
            .execute(binds.as_slice())
            .map_err(|error| SeatError::from_sqlite("applying a predicted delete", error))?;
        return Ok(());
    }
    let Some(image) = row.row.as_ref() else {
        return Err(SeatError::Invariant {
            context: format!(
                "a predicted {} on `{}` carries no image",
                row.op.as_str(),
                row.table
            ),
        });
    };
    let columns: Vec<String> = image.keys().cloned().collect();
    let sql = apply_row_sql(&row.table, &columns, key)?;
    let values: Vec<&Value> = image.values().collect();
    let binds: Vec<&dyn rusqlite::ToSql> = values
        .iter()
        .map(|value| *value as &dyn rusqlite::ToSql)
        .collect();
    connection
        .prepare_cached(&sql)?
        .execute(binds.as_slice())
        .map_err(|error| SeatError::from_sqlite("applying a predicted row", error))?;
    Ok(())
}

/// TRUTH WINS: forget every pending entry for these rows.
///
/// Called by the applier, inside the transaction that lands a canonical page —
/// for the commit that ANSWERS a pending write (R24), and for any other commit
/// that happens to touch a row a prediction is holding. Both are the same
/// answer: the gateway has spoken about this row, so a prior image from before
/// it is not a state this device may return to.
pub fn forget_rows(connection: &Connection, table: &str, primary_key: &[Value]) -> Result<usize> {
    open(connection)?;
    Ok(connection.execute(
        "DELETE FROM seat_pending_rows WHERE table_name = ?1 AND pk_json = ?2",
        rusqlite::params![table, key_to_json(primary_key)],
    )?)
}

/// Forget one intent's remaining entries, without restoring anything.
///
/// What a SETTLEMENT does: the answering commit has landed and already dropped
/// the entries for every row it carried, and this clears the rest — rows the
/// prediction touched that the gateway's commit did not.
pub fn forget(connection: &Connection, intent_id: &str) -> Result<usize> {
    open(connection)?;
    Ok(connection.execute(
        "DELETE FROM seat_pending_rows WHERE intent_id = ?1",
        [intent_id],
    )?)
}

/// TAKE ONE PENDING WRITE BACK: restore its prior images and drop its entries.
///
/// What a refusal does. Newest entry first, so two changes to one row in one
/// command restore to the state before the first.
///
/// **A row a LATER intent also wrote is not restored**; that intent's own
/// journalled prior is rewritten to this one's instead. Restoring it would wipe
/// a prediction the member can still see and is still waiting on, and leaving
/// the later entry alone would make its eventual restore put back a value this
/// write invented. Rewriting is the only answer that is right for both.
pub fn restore(
    connection: &Connection,
    intent_id: &str,
    order_of: &dyn Fn(&str) -> i64,
) -> Result<usize> {
    open(connection)?;
    let mut statement = connection.prepare(
        "SELECT ordinal, table_name, pk_json, prior_json
           FROM seat_pending_rows WHERE intent_id = ?1
          ORDER BY ordinal DESC",
    )?;
    let entries: Vec<(i64, String, String, Option<String>)> = statement
        .query_map([intent_id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);

    let mine = order_of(intent_id);
    let mut restored = 0usize;
    for (_, table, pk_json, prior_json) in entries {
        let later: Option<String> = connection
            .query_row(
                "SELECT intent_id FROM seat_pending_rows
                  WHERE table_name = ?1 AND pk_json = ?2 AND intent_id <> ?3",
                rusqlite::params![table, pk_json, intent_id],
                |row| row.get(0),
            )
            .ok()
            .filter(|other: &String| order_of(other) > mine);
        if let Some(later) = later {
            // THE LATER WRITE KEEPS THE ROW AND INHERITS THE PRIOR.
            connection.execute(
                "UPDATE seat_pending_rows SET prior_json = ?1
                  WHERE intent_id = ?2 AND table_name = ?3 AND pk_json = ?4",
                rusqlite::params![prior_json, later, table, pk_json],
            )?;
            continue;
        }
        let key = key_from_json(&pk_json)?;
        let key_columns = primary_key_of(connection, &table)?;
        match prior_json {
            // THE ROW DID NOT EXIST. Taking the write back deletes it.
            None => {
                let sql = delete_row_sql(&table, &key_columns)?;
                let binds: Vec<&dyn rusqlite::ToSql> = key
                    .iter()
                    .map(|value| value as &dyn rusqlite::ToSql)
                    .collect();
                connection.prepare_cached(&sql)?.execute(binds.as_slice())?;
            }
            Some(prior) => {
                let image = row_image_from_json(&prior)?;
                write_row(
                    connection,
                    &PredictedRow {
                        table: table.clone(),
                        op: LogOp::Update,
                        primary_key: key,
                        row: Some(image),
                    },
                    &key_columns,
                )?;
            }
        }
        restored += 1;
    }
    forget(connection, intent_id)?;
    Ok(restored)
}

/// Whether this replica is holding any predicted write.
///
/// The other half of the invariant: an empty outbox must mean an empty journal.
pub fn is_empty(connection: &Connection) -> Result<bool> {
    open(connection)?;
    let held: i64 = connection.query_row("SELECT COUNT(*) FROM seat_pending_rows", [], |row| {
        row.get(0)
    })?;
    Ok(held == 0)
}
