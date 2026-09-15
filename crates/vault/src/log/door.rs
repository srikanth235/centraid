//! The doors, as functions rather than routes (D-1020-D1-6).
//!
//! v0's log door is an HTTP handler. v1's is a function, called by the local
//! socket, by the iroh handler and by a test in-process — because the paging
//! rules are the hard part and three callers of one function cannot disagree
//! about them the way three handlers can.
//!
//! ## The paging rules, and why each exists (plane census seam 4)
//!
//! - **A page never ends mid-commit.** The tail of the last row's commit is
//!   appended whatever the limit says, because a seat applies one commit per
//!   transaction with its cursor in that transaction. Half a commit is a
//!   transaction it cannot close.
//! - **`local` rows are FILTERED, not gapped.** They occupy `seq` numbers a
//!   seat never sees, so `seq > since` must not be read as "the next row is
//!   `since + 1`".
//! - **`next` is the last SERVED seq when `has_more`, else the watermark.** A
//!   page whose rows were all filtered still advances, or a vault with a run of
//!   local rows would serve the same empty page forever.
//! - **`has_more` is a separate probe, not `rows.len() == limit`.** The tail
//!   append makes the row count an unreliable signal.
//! - **All four statements run in ONE read transaction.** Split apart, a prune
//!   landing between them yielded no rows, `has_more: false`, `next:
//!   watermark` — and the seat silently skipped a span.

use rusqlite::Connection;

use crate::error::{RebootstrapReason, Result, VaultError};
use crate::file::Vault;
use crate::log::store::{LOG_ROW_COLUMNS, LogRow, log_row_from, meta};

/// A position in the log: which epoch, and which `seq` within it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cursor {
    pub epoch: String,
    pub seq: i64,
}

/// The wire form: `<epoch>:<seq>`.
///
/// The epoch may contain no colon and the seq is decimal digits only — so a
/// cursor is unambiguous to split even though the epoch is opaque text.
#[must_use]
pub fn format_cursor(cursor: &Cursor) -> String {
    format!("{}:{}", cursor.epoch, cursor.seq)
}

/// Parse `<epoch>:<seq>`, with v0's validation.
pub fn parse_cursor(text: &str) -> Result<Cursor> {
    let invalid = || VaultError::InvalidCursor {
        found: text.to_owned(),
    };
    let (epoch, seq) = text.rsplit_once(':').ok_or_else(invalid)?;
    if epoch.is_empty() || epoch.contains(':') {
        return Err(invalid());
    }
    if seq.is_empty() || !seq.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(invalid());
    }
    let seq: i64 = seq.parse().map_err(|_| invalid())?;
    if seq > crate::value::MAX_SAFE_INTEGER {
        // A cursor crosses a wire a JS reader may still be on; past the safe
        // range the number it parses is not the number that was sent.
        return Err(invalid());
    }
    Ok(Cursor {
        epoch: epoch.to_owned(),
        seq,
    })
}

/// Where the log is: its epoch, the floor below which rows are gone, and the
/// watermark above which there are none.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogState {
    pub epoch: String,
    pub schema_epoch: i64,
    /// THE BUILD CONSTANT, not the file's column. A file's `ddl_version`
    /// records what wrote its rows; this says what this build serves.
    pub ddl_version: i64,
    pub floor: Cursor,
    pub watermark: Cursor,
    pub commit_seq: i64,
}

/// One page of the log.
#[derive(Debug, Clone)]
pub struct LogPage {
    pub vault_epoch: String,
    pub schema_epoch: i64,
    pub ddl_version: i64,
    pub floor: Cursor,
    pub watermark: Cursor,
    /// Where to ask from next.
    pub next: Cursor,
    pub has_more: bool,
    pub rows: Vec<LogRow>,
}

/// The largest page any caller may ask for.
#[must_use]
pub fn max_page() -> i64 {
    crate::log::constants().seat_log_max_page
}

/// Read the log's position.
pub fn log_state(vault: &Vault) -> Result<LogState> {
    vault.read(log_state_on)
}

fn log_state_on(connection: &Connection) -> Result<LogState> {
    let current = meta(connection)?;
    let highest: Option<i64> = connection.query_row(
        "SELECT MAX(seq) FROM replica_log WHERE epoch = ?1",
        [&current.epoch],
        |row| row.get(0),
    )?;
    // The watermark is the greater of the floor and the highest row: a vault
    // whose log was truncated to the floor has no rows and a real position.
    let watermark = highest.unwrap_or(0).max(current.floor_seq);
    Ok(LogState {
        epoch: current.epoch.clone(),
        schema_epoch: current.schema_epoch,
        ddl_version: crate::log::constants().ddl_version,
        floor: Cursor {
            epoch: current.epoch.clone(),
            seq: current.floor_seq,
        },
        watermark: Cursor {
            epoch: current.epoch,
            seq: watermark,
        },
        commit_seq: current.commit_seq,
    })
}

/// Serve one page from `since`, or refuse with the reason to re-bootstrap.
///
/// The three gates on the REQUEST, all before a row is read:
///
/// | reason | condition |
/// |---|---|
/// | `epoch-mismatch` | the cursor names another epoch |
/// | `retention` | the cursor is below the floor: those rows are gone |
/// | `cursor-ahead` | the cursor is above the watermark |
///
/// And a fourth gate on the ANSWER: every served row's epoch is checked against
/// the vault's. The header is what the gateway BELIEVES; the rows are what it
/// has, and a mismatch there is corruption, not a stale cursor.
pub fn read_log_page(vault: &Vault, since: &Cursor, limit: i64) -> Result<LogPage> {
    if limit < 1 || limit > max_page() {
        return Err(VaultError::Invariant {
            context: format!(
                "a log page limit must be 1..={}, and {limit} is not",
                max_page()
            ),
        });
    }
    vault.read(|connection| {
        // ONE READ TRANSACTION over all four statements. A prune landing
        // between them is the silent-skip bug this wraps.
        connection.execute_batch("BEGIN")?;
        let outcome = read_page_within(connection, since, limit);
        // ROLLBACK, not COMMIT: nothing was written and a read transaction
        // that commits is a write lock nobody asked for.
        let _ = connection.execute_batch("ROLLBACK");
        outcome
    })
}

fn read_page_within(connection: &Connection, since: &Cursor, limit: i64) -> Result<LogPage> {
    let state = log_state_on(connection)?;
    if since.epoch != state.epoch {
        return Err(VaultError::RebootstrapRequired {
            reason: RebootstrapReason::EpochMismatch,
        });
    }
    if since.seq < state.floor.seq {
        return Err(VaultError::RebootstrapRequired {
            reason: RebootstrapReason::Retention,
        });
    }
    if since.seq > state.watermark.seq {
        return Err(VaultError::RebootstrapRequired {
            reason: RebootstrapReason::CursorAhead,
        });
    }

    let sql = format!(
        "SELECT {LOG_ROW_COLUMNS} FROM replica_log
           WHERE epoch = ?1 AND seq > ?2 AND seq <= ?3 AND local = 0
           ORDER BY seq LIMIT ?4"
    );
    let mut statement = connection.prepare_cached(&sql)?;
    let mut rows: Vec<LogRow> = statement
        .query_map(
            rusqlite::params![state.epoch, since.seq, state.watermark.seq, limit],
            |row| Ok(log_row_from(row)),
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?
        .into_iter()
        .collect::<Result<Vec<_>>>()?;

    // THE TAIL OF THE LAST ROW'S COMMIT, whatever the limit says.
    if let Some(last) = rows.last() {
        let commit = last.commit_seq;
        let last_seq = last.seq;
        let tail_sql = format!(
            "SELECT {LOG_ROW_COLUMNS} FROM replica_log
               WHERE epoch = ?1 AND commit_seq = ?2 AND seq > ?3 AND seq <= ?4 AND local = 0
               ORDER BY seq"
        );
        let mut tail = connection.prepare_cached(&tail_sql)?;
        let extra: Vec<LogRow> = tail
            .query_map(
                rusqlite::params![state.epoch, commit, last_seq, state.watermark.seq],
                |row| Ok(log_row_from(row)),
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .collect::<Result<Vec<_>>>()?;
        rows.extend(extra);
    }

    let served_through = rows.last().map_or(since.seq, |row| row.seq);
    // A SEPARATE PROBE, because the tail append makes the row count a lie.
    let has_more: bool = connection.query_row(
        "SELECT EXISTS (
             SELECT 1 FROM replica_log
              WHERE epoch = ?1 AND seq > ?2 AND seq <= ?3 AND local = 0 LIMIT 1
         )",
        rusqlite::params![state.epoch, served_through, state.watermark.seq],
        |row| row.get::<_, i64>(0).map(|flag| flag != 0),
    )?;

    // THE FOURTH GATE, on the answer. Checked per row because the page header
    // is what the gateway believes.
    if let Some(stray) = rows.iter().find(|row| row.epoch != state.epoch) {
        return Err(VaultError::Invariant {
            context: format!(
                "log row {} carries epoch `{}` and the vault is in `{}`",
                stray.seq, stray.epoch, state.epoch
            ),
        });
    }

    let next = Cursor {
        epoch: state.epoch.clone(),
        // A page whose rows were ALL filtered still advances: without this a
        // run of local rows serves the same empty page forever.
        seq: if has_more {
            served_through
        } else {
            state.watermark.seq
        },
    };
    Ok(LogPage {
        vault_epoch: state.epoch,
        schema_epoch: state.schema_epoch,
        ddl_version: state.ddl_version,
        floor: state.floor,
        watermark: state.watermark,
        next,
        has_more,
        rows,
    })
}

/// Record where a seat says it has reached.
///
/// **Never backwards.** A cursor that moved back would un-pin the retention
/// floor and then re-pin it, which is a floor that oscillates; and a seat that
/// re-sent an old position (a retry, a restored file) would strand itself. The
/// guard is in the WHERE clause, not in a read-then-write, so two doors racing
/// cannot both win.
///
/// Best-effort by design: this runs AFTER the page was served, and a failure to
/// record must not un-serve it. Returns whether it wrote.
///
/// The recorded value is `since` — the position the device HAS — not the
/// watermark it was served. The distinction is the whole reason the retention
/// hold works: a seat holds the floor at what it has applied.
pub fn record_seat_cursor(vault: &Vault, device_id: &str, since: i64) -> Result<bool> {
    let now = vault.clock().now_text();
    let changed = vault.connection().execute(
        "UPDATE access_device_secret
            SET sync_cursor = ?1, sync_cursor_at = ?2
          WHERE device_id = ?3
            AND (sync_cursor IS NULL OR CAST(sync_cursor AS INTEGER) <= ?1)",
        rusqlite::params![since, now, device_id],
    )?;
    Ok(changed > 0)
}

/// The lowest LIVE seat cursor, or `None` when none pins the floor.
///
/// "Live" is the 14-day hold: a cursor with no stamp, or one last seen longer
/// ago than that, does not pin. Otherwise a phone that was lost a year ago
/// would hold the log at its last position forever.
pub fn lowest_seat_cursor(vault: &Vault, now_ms: i64) -> Result<Option<i64>> {
    let hold_ms = crate::log::constants().seat_hold_days * 86_400_000;
    let cutoff = crate::clock::format_iso_ms(now_ms - hold_ms);
    vault.read(|connection| {
        let lowest: Option<i64> = connection.query_row(
            "SELECT MIN(CAST(sync_cursor AS INTEGER)) FROM access_device_secret
              WHERE sync_cursor IS NOT NULL
                AND sync_cursor_at IS NOT NULL
                AND sync_cursor_at >= ?1",
            [&cutoff],
            |row| row.get(0),
        )?;
        Ok(lowest)
    })
}

/// Translate a `seq` hold into commit units.
///
/// THE R6 MISTAKE IN MINIATURE — 432 AGAINST 2. A seat's cursor is a
/// `replica_log.seq`; a retention decision denominated in commits needs the
/// `commit_seq` that seq belongs to. Comparing one against the other compares a
/// row position against a transaction number.
///
/// Returns 0 when the cursor is below every row this epoch holds, which means
/// "this hold pins nothing in commit terms".
pub fn lowest_seat_commit_seq(connection: &Connection, epoch: &str, seq: i64) -> Result<i64> {
    let commit: Option<i64> = connection.query_row(
        "SELECT commit_seq FROM replica_log
          WHERE epoch = ?1 AND seq <= ?2 ORDER BY seq DESC LIMIT 1",
        rusqlite::params![epoch, seq],
        |row| row.get(0),
    )?;
    Ok(commit.unwrap_or(0))
}

/// What a prune did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PruneOutcome {
    /// The seq the floor moved to.
    pub floor: i64,
    /// Rows deleted in this epoch.
    pub deleted: i64,
    /// Rows deleted because they belonged to a FOREIGN epoch, whatever age.
    pub foreign_deleted: i64,
    /// The live cursor that held the floor back, if one did.
    pub held_by_seat: Option<i64>,
}

/// Truncate the log, honouring the commit edge and the live cursors.
///
/// There is **no compaction**: a log row is a full image, so folding buys
/// nothing a truncation does not. Two things the floor may not cross:
///
/// - **A commit edge.** The floor lands at the END of the previous commit, so a
///   straddled commit stays whole and a seat never receives half of one.
/// - **A live seat's cursor.** A seat that is behind holds the floor where it
///   is; the LOWEST live cursor wins, not the lowest cursor.
pub fn prune(vault: &Vault, now_ms: i64) -> Result<PruneOutcome> {
    let constants = crate::log::constants();
    let held = lowest_seat_cursor(vault, now_ms)?;
    let connection = vault.connection();
    connection
        .execute_batch("BEGIN IMMEDIATE")
        .map_err(|error| VaultError::from_sqlite("opening a prune", error))?;
    let outcome = prune_within(connection, now_ms, held, constants);
    match &outcome {
        Ok(_) => connection
            .execute_batch("COMMIT")
            .map_err(|error| VaultError::from_sqlite("committing a prune", error))?,
        Err(_) => {
            let _ = connection.execute_batch("ROLLBACK");
        }
    }
    outcome
}

fn prune_within(
    connection: &Connection,
    now_ms: i64,
    held: Option<i64>,
    constants: &centraid_ontology::registries::ReplicaConstants,
) -> Result<PruneOutcome> {
    let current = meta(connection)?;

    // 1. EVERY ROW OF A FOREIGN EPOCH GOES, WHATEVER ITS AGE. An epoch bump
    //    already told every seat to re-bootstrap, so the old epoch's rows are
    //    not retention — they are garbage.
    let foreign_deleted = i64::try_from(connection.execute(
        "DELETE FROM replica_log WHERE epoch <> ?1",
        [&current.epoch],
    )?)
    .unwrap_or(0);

    // 2. By age.
    let cutoff = crate::clock::format_iso_ms(now_ms - constants.log_retention_days * 86_400_000);
    let by_age: i64 = connection
        .query_row(
            "SELECT COALESCE(MAX(seq), 0) FROM replica_log
              WHERE epoch = ?1 AND committed_at < ?2",
            rusqlite::params![current.epoch, cutoff],
            |row| row.get(0),
        )
        .unwrap_or(0);

    // 3. By count: the seq at OFFSET total - maxRows - 1, when over the bound.
    let total: i64 = connection.query_row(
        "SELECT COUNT(*) FROM replica_log WHERE epoch = ?1",
        [&current.epoch],
        |row| row.get(0),
    )?;
    let by_count: i64 = if total > constants.log_retention_max_rows {
        let offset = total - constants.log_retention_max_rows - 1;
        connection
            .query_row(
                "SELECT seq FROM replica_log WHERE epoch = ?1 ORDER BY seq LIMIT 1 OFFSET ?2",
                rusqlite::params![current.epoch, offset],
                |row| row.get(0),
            )
            .unwrap_or(0)
    } else {
        0
    };

    // 4. The greater of the two, then clamped by the live hold.
    let mut through = by_age.max(by_count);
    if let Some(held) = held {
        through = through.min(held);
    }

    // 5. THE COMMIT EDGE: move back to the end of the previous commit so the
    //    straddled commit stays whole.
    through = commit_edge_at_or_below(connection, &current.epoch, through)?;

    if through <= current.floor_seq {
        return Ok(PruneOutcome {
            floor: current.floor_seq,
            deleted: 0,
            foreign_deleted,
            held_by_seat: held,
        });
    }

    let deleted = i64::try_from(connection.execute(
        "DELETE FROM replica_log WHERE epoch = ?1 AND seq <= ?2",
        rusqlite::params![current.epoch, through],
    )?)
    .unwrap_or(0);
    connection.execute(
        "UPDATE replica_meta SET floor_seq = MAX(floor_seq, ?1) WHERE singleton = 1",
        [through],
    )?;
    Ok(PruneOutcome {
        floor: through,
        deleted,
        foreign_deleted,
        held_by_seat: held,
    })
}

/// The highest seq at or below `through` that is the LAST row of its commit.
///
/// A floor inside a commit means a seat that asks from it receives the second
/// half of a transaction, which it cannot apply as one. Returns 0 when no
/// commit ends at or below `through`.
fn commit_edge_at_or_below(connection: &Connection, epoch: &str, through: i64) -> Result<i64> {
    if through <= 0 {
        return Ok(0);
    }
    let commit_at: Option<i64> = connection.query_row(
        "SELECT commit_seq FROM replica_log WHERE epoch = ?1 AND seq <= ?2
          ORDER BY seq DESC LIMIT 1",
        rusqlite::params![epoch, through],
        |row| row.get(0),
    )?;
    let Some(commit_at) = commit_at else {
        return Ok(0);
    };
    // Does that commit extend past `through`? If it does, fall back to the end
    // of the one before it.
    let commit_high: i64 = connection.query_row(
        "SELECT COALESCE(MAX(seq), 0) FROM replica_log WHERE epoch = ?1 AND commit_seq = ?2",
        rusqlite::params![epoch, commit_at],
        |row| row.get(0),
    )?;
    if commit_high <= through {
        return Ok(commit_high);
    }
    let previous: Option<i64> = connection.query_row(
        "SELECT MAX(seq) FROM replica_log WHERE epoch = ?1 AND commit_seq < ?2",
        rusqlite::params![epoch, commit_at],
        |row| row.get(0),
    )?;
    Ok(previous.unwrap_or(0))
}

/// Rotate the epoch, telling every seat to re-bootstrap.
///
/// **The floor is derived FROM THE LOG the file has.** v0's earlier derivation
/// read `sqlite_sequence`, which made seats go silently and permanently stale
/// on every schema change and every backup restore: the sequence counter is
/// about a table that no longer exists, and the log is the thing a cursor
/// points into. So `floor = max(existing floor, MAX(seq) in the log)`.
pub fn bump_epoch(vault: &Vault, reason: &str) -> Result<LogState> {
    let epoch = vault.ids().next();
    // Validate through the cursor formatter BEFORE persisting: an epoch with a
    // colon in it makes every cursor in the field ambiguous, and the check is
    // free here and impossible later.
    parse_cursor(&format_cursor(&Cursor {
        epoch: epoch.clone(),
        seq: 0,
    }))?;
    let now = vault.clock().now_text();
    let connection = vault.connection();
    connection
        .execute_batch("BEGIN IMMEDIATE")
        .map_err(|error| VaultError::from_sqlite("opening an epoch bump", error))?;
    let outcome = (|| -> Result<()> {
        let highest: i64 =
            connection.query_row("SELECT COALESCE(MAX(seq), 0) FROM replica_log", [], |row| {
                row.get(0)
            })?;
        connection.execute(
            "UPDATE replica_meta
                SET epoch = ?1,
                    floor_seq = MAX(floor_seq, ?2),
                    epoch_reason = ?3,
                    epoch_started_at = ?4,
                    updated_at = ?4,
                    active_commit_id = NULL
              WHERE singleton = 1",
            rusqlite::params![epoch, highest, reason, now],
        )?;
        Ok(())
    })();
    match outcome {
        Ok(()) => {
            connection
                .execute_batch("COMMIT")
                .map_err(|error| VaultError::from_sqlite("committing an epoch bump", error))?;
            log_state(vault)
        }
        Err(error) => {
            let _ = connection.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cursor_round_trips_and_the_bad_shapes_are_refused() {
        let cursor = Cursor {
            epoch: "abc-def".to_owned(),
            seq: 42,
        };
        assert_eq!(format_cursor(&cursor), "abc-def:42");
        assert_eq!(parse_cursor("abc-def:42").expect("parses"), cursor);
        assert_eq!(parse_cursor("abc-def:0").expect("parses").seq, 0);
        for bad in [
            "",
            "abc-def",
            ":42",
            "abc:def:42",
            "abc:-1",
            "abc: 42",
            "abc:4 2",
            "abc:",
            "abc:9007199254740992",
        ] {
            assert!(parse_cursor(bad).is_err(), "`{bad}` must not parse");
        }
    }
}
