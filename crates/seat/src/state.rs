//! `seat_state`: the singleton the seat keeps its own position in.
//!
//! Created on the seat file **after** the snapshot lands, and never shipped by
//! the gateway. That order is the contract: the snapshot is a copy of the
//! gateway's file, and a `seat_state` row inside it would be the *gateway's*
//! idea of a seat's position, which is not a thing that exists.

use rusqlite::Connection;

use crate::error::{Result, SeatError};

/// The DDL, as v0's (plane census §2.2).
///
/// `deferred_from` is nullable and the null is load-bearing: NULL is "nothing
/// owed" and `0` is a real seq. A default of 0 would make every fresh seat
/// believe it owed the whole log.
pub const SEAT_STATE_DDL: &str = r"
CREATE TABLE IF NOT EXISTS seat_state (
  singleton          INTEGER PRIMARY KEY CHECK (singleton = 1),
  vault_id           TEXT NOT NULL,
  epoch              TEXT NOT NULL,
  schema_epoch       INTEGER NOT NULL CHECK (schema_epoch >= 1),
  ddl_version        INTEGER NOT NULL DEFAULT 0 CHECK (ddl_version >= 0),
  applied_seq        INTEGER NOT NULL CHECK (applied_seq >= 0),
  applied_commit_seq INTEGER NOT NULL DEFAULT 0 CHECK (applied_commit_seq >= 0),
  gateway_watermark  INTEGER NOT NULL DEFAULT 0 CHECK (gateway_watermark >= 0),
  deferred_from      INTEGER,
  contents           TEXT NOT NULL DEFAULT 'full'
    CHECK (contents IN ('full', 'rows-minus-fts')),
  updated_at         TEXT NOT NULL
) STRICT;
";

/// What the seat believes about itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeatState {
    pub vault_id: String,
    pub epoch: String,
    pub schema_epoch: i64,
    pub ddl_version: i64,
    /// A `replica_log.seq`. The seat's cursor.
    pub applied_seq: i64,
    /// The commit that `applied_seq` belonged to. An overlay clears against
    /// THIS number, never against `applied_seq` (census seam 5).
    pub applied_commit_seq: i64,
    pub gateway_watermark: i64,
    /// `None` is "nothing owed"; `Some(0)` is a real seq.
    pub deferred_from: Option<i64>,
    pub contents: String,
    pub updated_at: String,
}

/// How much of the vault this seat holds.
pub const CONTENTS_FULL: &str = "full";
/// A seat whose FTS shadow content was left behind — rows but no search index.
pub const CONTENTS_ROWS_MINUS_FTS: &str = "rows-minus-fts";

/// Where a seat starts from, as one value.
///
/// One struct rather than seven positional arguments, and not only for
/// clippy's sake: `applied_seq` and `applied_commit_seq` are two `i64`s that
/// mean entirely different things (census seam 5), and two adjacent positional
/// `i64`s is precisely the shape in which they get swapped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeatPosition {
    pub vault_id: String,
    pub epoch: String,
    pub schema_epoch: i64,
    pub ddl_version: i64,
    /// A `replica_log.seq`.
    pub applied_seq: i64,
    /// The commit that seq belonged to.
    pub applied_commit_seq: i64,
}

/// Create the table and write the singleton, or update it in place.
///
/// `gateway_watermark` defaults to `applied_seq` (a seat that has caught up is
/// not behind) and `deferred_from` is cleared: an init is a statement of a
/// fresh position and a carried-over "you still owe me rows" would be about a
/// log that is gone.
pub fn init_seat_state(
    connection: &Connection,
    position: &SeatPosition,
    now: &str,
) -> Result<SeatState> {
    let SeatPosition {
        vault_id,
        epoch,
        schema_epoch,
        ddl_version,
        applied_seq,
        applied_commit_seq,
    } = position;
    connection.execute_batch(SEAT_STATE_DDL)?;
    connection
        .execute(
            "INSERT INTO seat_state
           (singleton, vault_id, epoch, schema_epoch, ddl_version, applied_seq,
            applied_commit_seq, gateway_watermark, deferred_from, contents, updated_at)
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?5, NULL, 'full', ?7)
         ON CONFLICT (singleton) DO UPDATE SET
           vault_id = excluded.vault_id,
           epoch = excluded.epoch,
           schema_epoch = excluded.schema_epoch,
           ddl_version = excluded.ddl_version,
           applied_seq = excluded.applied_seq,
           applied_commit_seq = excluded.applied_commit_seq,
           gateway_watermark = excluded.gateway_watermark,
           deferred_from = NULL,
           updated_at = excluded.updated_at",
            rusqlite::params![
                vault_id,
                epoch,
                schema_epoch,
                ddl_version,
                applied_seq,
                applied_commit_seq,
                now
            ],
        )
        .map_err(|error| SeatError::from_sqlite("initialising seat_state", error))?;
    seat_state(connection)
}

/// Read the singleton, or say it is missing.
pub fn seat_state(connection: &Connection) -> Result<SeatState> {
    connection
        .query_row(
            "SELECT vault_id, epoch, schema_epoch, ddl_version, applied_seq,
                    applied_commit_seq, gateway_watermark, deferred_from, contents, updated_at
               FROM seat_state WHERE singleton = 1",
            [],
            |row| {
                Ok(SeatState {
                    vault_id: row.get(0)?,
                    epoch: row.get(1)?,
                    schema_epoch: row.get(2)?,
                    ddl_version: row.get(3)?,
                    applied_seq: row.get(4)?,
                    applied_commit_seq: row.get(5)?,
                    gateway_watermark: row.get(6)?,
                    deferred_from: row.get(7)?,
                    contents: row.get(8)?,
                    updated_at: row.get(9)?,
                })
            },
        )
        .map_err(|error| {
            // Two different SQLite answers, one seat fact: there is no position
            // recorded here. "No such table" is the snapshot that landed before
            // anything initialised it; "no rows" is the table without its
            // singleton. Neither may become a default position.
            if matches!(error, rusqlite::Error::QueryReturnedNoRows)
                || error.to_string().contains("no such table: seat_state")
            {
                SeatError::StateMissing
            } else {
                SeatError::Sqlite(error)
            }
        })
}

/// How far behind the gateway a seat is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Watermark {
    /// The highest position either side knows about.
    pub head: i64,
    pub applied: i64,
    /// `head - applied`, never negative. A DISTANCE IN LOG POSITIONS — not in
    /// rows, not in time. A seat 400 positions behind may be one commit behind
    /// or four hundred, and a member is owed neither number as "seconds".
    pub behind: i64,
}

/// Derive the watermark from a state row.
///
/// `head` is `max(gateway_watermark, applied_seq)`: a seat that applied a page
/// whose watermark the gateway has since raised is not ahead of itself, and a
/// seat whose recorded gateway watermark is stale is not behind by a negative
/// amount.
#[must_use]
pub fn watermark(state: &SeatState) -> Watermark {
    let head = state.gateway_watermark.max(state.applied_seq);
    Watermark {
        head,
        applied: state.applied_seq,
        behind: (head - state.applied_seq).max(0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> Connection {
        Connection::open_in_memory().expect("an in-memory file opens")
    }

    fn position(epoch: &str, applied_seq: i64, applied_commit_seq: i64) -> SeatPosition {
        SeatPosition {
            vault_id: "v".to_owned(),
            epoch: epoch.to_owned(),
            schema_epoch: 4,
            ddl_version: 0,
            applied_seq,
            applied_commit_seq,
        }
    }

    #[test]
    fn an_uninitialised_file_says_the_state_is_missing_rather_than_guessing() {
        let connection = scratch();
        assert!(matches!(
            seat_state(&connection),
            Err(SeatError::StateMissing)
        ));
        connection
            .execute_batch(SEAT_STATE_DDL)
            .expect("the DDL runs");
        // The table exists and the row does not: still missing, not a default.
        assert!(matches!(
            seat_state(&connection),
            Err(SeatError::StateMissing)
        ));
    }

    #[test]
    fn init_defaults_the_gateway_watermark_to_the_applied_seq_and_clears_the_defer() {
        let connection = scratch();
        let state = init_seat_state(
            &connection,
            &position("e", 42, 7),
            "2026-01-01T00:00:00.000Z",
        )
        .expect("init runs");
        assert_eq!(state.gateway_watermark, 42);
        assert_eq!(state.applied_commit_seq, 7);
        assert_eq!(state.deferred_from, None);
        assert_eq!(watermark(&state).behind, 0);
    }

    #[test]
    fn a_second_init_replaces_the_row_rather_than_refusing_it() {
        let connection = scratch();
        init_seat_state(&connection, &position("e", 42, 7), "t").expect("init runs");
        connection
            .execute(
                "UPDATE seat_state SET deferred_from = 0 WHERE singleton = 1",
                [],
            )
            .expect("a defer is owed");
        let again =
            init_seat_state(&connection, &position("e2", 0, 0), "t2").expect("re-init runs");
        assert_eq!(again.epoch, "e2");
        // NULL, not 0. A carried-over defer would be about a log that is gone.
        assert_eq!(again.deferred_from, None);
    }

    #[test]
    fn behind_is_a_distance_in_log_positions_and_never_negative() {
        let state = SeatState {
            vault_id: "v".to_owned(),
            epoch: "e".to_owned(),
            schema_epoch: 4,
            ddl_version: 0,
            applied_seq: 500,
            applied_commit_seq: 9,
            // A STALE recorded watermark, below what the seat has applied.
            gateway_watermark: 100,
            deferred_from: None,
            contents: CONTENTS_FULL.to_owned(),
            updated_at: "t".to_owned(),
        };
        let mark = watermark(&state);
        assert_eq!(mark.head, 500);
        assert_eq!(mark.behind, 0);
    }

    #[test]
    fn deferred_from_zero_is_a_real_seq_and_not_nothing_owed() {
        let connection = scratch();
        init_seat_state(&connection, &position("e", 5, 1), "t").expect("init runs");
        connection
            .execute(
                "UPDATE seat_state SET deferred_from = 0 WHERE singleton = 1",
                [],
            )
            .expect("the update runs");
        assert_eq!(
            seat_state(&connection).expect("it reads").deferred_from,
            Some(0)
        );
    }
}
