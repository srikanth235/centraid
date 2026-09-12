//! The commit pair, as a guard whose ordering cannot be forgotten (D-1020-D1-5).
//!
//! The sequence, and every step's order is load-bearing:
//!
//! 1. `BEGIN IMMEDIATE` — a write lock up front, so two writers do not
//!    discover each other halfway through.
//! 2. Open one session per capture table.
//! 3. Run the body, which writes through the connection the guard hands it.
//! 4. Take each session's changeset and DECODE IT, still inside the
//!    transaction: an insert's image is the row read back by primary key, and
//!    the read must precede any later statement that could move the row.
//! 5. Allocate `commit_seq = commit_seq + 1` and insert the log rows.
//! 6. `COMMIT`.
//! 7. Ring the doorbell — AFTER the commit, because a subscriber woken before
//!    it would read the old state and go back to sleep.
//!
//! On a failure anywhere in 3–5: **abandon the sessions BEFORE the ROLLBACK.**
//! SQLite's session extension does not un-record what a full rollback undid, so
//! a session left open across one replays the rolled-back changes into the next
//! commit. A SAVEPOINT rollback is different — the extension *does* un-record
//! it — which is why `ROLLBACK TO` keeps the pair and only a full ROLLBACK
//! breaks it.
//!
//! **Nesting is a deliberate no-op.** An inner `commit` runs its body inside
//! the outer pair and allocates no second `commit_seq`: one pair means one
//! commit position for one logical commit, which is what a seat applies in one
//! transaction.

use std::cell::RefCell;
use std::collections::HashSet;

use rusqlite::Connection;

use crate::error::{Result, VaultError};
use crate::file::Vault;
use crate::log::capture::{Capture, capture_tables};
use crate::log::store::{WriteOutcome, write_rows};
use crate::value::Value;

/// The writable connection a commit body is handed.
///
/// The ONLY one in this crate's public surface. It is deliberately not
/// `Deref<Target = Connection>`: a caller that wants the connection asks for it
/// by name, which is what makes the receipt's grep meaningful.
pub struct CommitTx<'guard, 'conn> {
    connection: &'conn Connection,
    capture: Option<&'guard RefCell<Capture<'conn>>>,
    producer: RefCell<String>,
}

impl<'conn> CommitTx<'_, 'conn> {
    /// The connection this commit writes through.
    #[must_use]
    pub const fn connection(&self) -> &'conn Connection {
        self.connection
    }

    /// Name the producer of this commit — a command name, an import, the
    /// enricher. The producer bound is denominated per producer, so this is how
    /// a bulk writer is recognised without guessing from row counts.
    pub fn set_producer(&self, producer: impl Into<String>) {
        *self.producer.borrow_mut() = producer.into();
    }

    /// Start watching a table this commit planted with DDL.
    ///
    /// Additive: the existing sessions keep everything they have recorded.
    /// Without this an ext band's first rows would never replicate, because
    /// the table did not exist when the sessions opened.
    pub fn watch_table(&self, table: &str) -> Result<()> {
        match self.capture {
            Some(capture) => capture.borrow_mut().watch(self.connection, table),
            // A nested commit shares the outer pair's sessions; the outer
            // guard is where a new table is attached.
            None => Ok(()),
        }
    }
}

/// A row this commit produced, with the version it landed at.
///
/// Read from the decoded images, never re-queried: the image is what the commit
/// actually wrote, and a second read could see a LATER commit's value and
/// settle an intent against work it did not do.
#[derive(Debug, Clone, PartialEq)]
pub struct ProducedRow {
    pub table: String,
    pub primary_key: Vec<Value>,
    /// Absent on a table with no `row_version` — a delete, or one of the 51
    /// replicated tables v0's gap register names.
    pub row_version: Option<i64>,
}

/// What a commit did.
#[derive(Debug, Clone)]
pub struct CommitResult<T> {
    pub value: T,
    /// `None` when the body wrote nothing a session saw — no rows, no
    /// `commit_seq`, no doorbell. An empty commit is not a commit.
    pub commit_seq: Option<i64>,
    pub rows: usize,
    pub tables: Vec<String>,
    pub compressed_bytes: usize,
    pub deferred: bool,
    pub produced: Vec<ProducedRow>,
}

impl Vault {
    /// Run a write inside the commit pair.
    ///
    /// See the module docs for the order. A nested call runs the body inside
    /// the enclosing pair and reports `commit_seq: None` — the outer call is
    /// the one that allocates a position.
    pub fn commit<T>(
        &self,
        body: impl FnOnce(&CommitTx<'_, '_>) -> Result<T>,
    ) -> Result<CommitResult<T>> {
        let connection = self.connection();

        if self.depth.get() > 0 {
            let tx = CommitTx {
                connection,
                capture: None,
                producer: RefCell::new(String::new()),
            };
            let value = body(&tx)?;
            return Ok(CommitResult {
                value,
                commit_seq: None,
                rows: 0,
                tables: Vec::new(),
                compressed_bytes: 0,
                deferred: false,
                produced: Vec::new(),
            });
        }

        let local: Vec<String> = crate::log::local_tables().to_vec();
        let tables = capture_tables(connection, &local)?;
        let local_set: HashSet<String> = local.into_iter().collect();

        connection
            .execute_batch("BEGIN IMMEDIATE")
            .map_err(|error| VaultError::from_sqlite("opening a commit", error))?;
        self.depth.set(1);

        let capture = match Capture::open(connection, &tables) {
            Ok(capture) => RefCell::new(capture),
            Err(error) => {
                self.depth.set(0);
                let _ = connection.execute_batch("ROLLBACK");
                return Err(error);
            }
        };

        let outcome = (|| -> Result<(T, Option<WriteOutcome>, Vec<ProducedRow>)> {
            let (value, producer) = {
                let tx = CommitTx {
                    connection,
                    capture: Some(&capture),
                    producer: RefCell::new("unnamed".to_owned()),
                };
                let value = body(&tx)?;
                let producer = tx.producer.borrow().clone();
                (value, producer)
            };
            let (decoded, touched) = capture.borrow_mut().decode(connection, &local_set)?;
            if decoded.is_empty() {
                return Ok((value, None, Vec::new()));
            }
            let produced = decoded
                .iter()
                .filter(|row| !row.local)
                .map(|row| ProducedRow {
                    table: row.table.clone(),
                    primary_key: row.key.clone(),
                    row_version: match row.row.as_ref().and_then(|image| image.get("row_version")) {
                        Some(Value::Integer(version)) => Some(*version),
                        _ => None,
                    },
                })
                .collect();
            let written = write_rows(connection, self.clock(), &producer, None, &decoded, touched)?;
            Ok((value, Some(written), produced))
        })();

        // The sessions are one-shot per commit: dropping them here is how the
        // next transaction starts from empty rather than replaying this one.
        // On the error path this drop is what has to happen BEFORE the
        // ROLLBACK, which is why it is not left to the end of the function.
        drop(capture);
        self.depth.set(0);

        match outcome {
            Ok((value, written, produced)) => {
                connection
                    .execute_batch("COMMIT")
                    .map_err(|error| VaultError::from_sqlite("committing", error))?;
                if let Some(written) = &written {
                    tracing::debug!(
                        commit_seq = written.commit_seq,
                        rows = written.rows,
                        "replica commit"
                    );
                }
                Ok(CommitResult {
                    value,
                    commit_seq: written.as_ref().map(|written| written.commit_seq),
                    rows: written.as_ref().map_or(0, |written| written.rows),
                    tables: written
                        .as_ref()
                        .map(|written| written.tables.clone())
                        .unwrap_or_default(),
                    compressed_bytes: written
                        .as_ref()
                        .map_or(0, |written| written.compressed_bytes),
                    deferred: written.as_ref().is_some_and(|written| written.deferred),
                    produced,
                })
            }
            Err(error) => {
                let _ = connection.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    /// Is a commit open on this vault?
    #[must_use]
    pub fn in_commit(&self) -> bool {
        self.depth.get() > 0
    }
}
