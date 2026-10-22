//! The commit pair, as a guard whose ordering cannot be forgotten (D-1020-D1-5).
//!
//! Three steps, and that is now the whole of it
//! ([#1029](https://github.com/srikanth235/centraid/issues/1029) §1):
//!
//! 1. `BEGIN IMMEDIATE` — a write lock up front, so two writers do not
//!    discover each other halfway through.
//! 2. Run the body, which writes through the connection the guard hands it.
//! 3. `COMMIT`.
//!
//! ## What the middle used to be, and why it is gone
//!
//! Between 1 and 3 the guard opened one **session** per replicated table, ran
//! the body, decoded each session's changeset still inside the transaction,
//! allocated `commit_seq = commit_seq + 1`, wrote a full row image per change
//! into `replica_log`, and rang a doorbell. Every one of those steps existed to
//! serve a SEAT: a second host applying this vault's log page by page. There is
//! no second host (#1029 §6), so the log had exactly one writer and no reader,
//! and a full second copy of every row was being written to a table nothing
//! read. `commit_seq` went with it — it was the position a seat's cursor
//! chased.
//!
//! What the sessions also produced, and what the product genuinely needs, is
//! **which tables a commit touched**, so a screen knows to re-read.
//! [`ChangeCensus`] answers that from a rusqlite `update_hook` instead: the
//! hook fires per changed row, inside the transaction, and costs a table name
//! rather than a row image. A rollback reports nothing, because the census is
//! only read on the success path.
//!
//! The hook counts nothing else. A backup counts rows on its own scratch copy
//! of the file, off the request path
//! ([#1080](https://github.com/srikanth235/centraid/issues/1080)), so the
//! commit pair carries no row census.
//!
//! **Nesting is a deliberate no-op.** An inner `commit` runs its body inside
//! the outer pair: one pair is one transaction, and a nested one that opened
//! its own would be a `BEGIN` inside a `BEGIN`.

use std::cell::RefCell;
use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use rusqlite::hooks::Action;

use crate::error::{Result, VaultError};
use crate::file::Vault;
use crate::model::Kind;

/// The writable connection a commit body is handed.
///
/// The ONLY one in this crate's public surface. It is deliberately not
/// `Deref<Target = Connection>`: a caller that wants the connection asks for it
/// by name, which is what makes the receipt's grep meaningful.
pub struct CommitTx<'conn> {
    connection: &'conn Connection,
    producer: RefCell<String>,
    pending: &'conn RefCell<Pending>,
}

/// What a commit owes the search index: the entities it changed.
///
/// Held by the [`Vault`] rather than by one [`CommitTx`], so a commit nested
/// inside another still lands its ids on the outermost one's list.
#[derive(Debug, Default)]
pub struct Pending {
    /// Every id to re-index at commit.
    reindex: BTreeSet<String>,
    /// The ids already stamped in this commit, so a second touch does not bump
    /// `version` a second time: a commit is one change.
    stamped: BTreeSet<String>,
}

impl<'conn> CommitTx<'conn> {
    /// The connection this commit writes through.
    #[must_use]
    pub const fn connection(&self) -> &'conn Connection {
        self.connection
    }

    /// Name the producer of this commit — a command name, an import, the
    /// enricher. Kept for the diagnostic line a commit writes; nothing
    /// persists it since the log rows went.
    pub fn set_producer(&self, producer: impl Into<String>) {
        *self.producer.borrow_mut() = producer.into();
    }

    /// Stamp an entity as changed: `updated_at`, `version`, and a place on the
    /// list the search index is rebuilt from at commit. Once per commit per
    /// entity; a second call only keeps it on the list.
    ///
    /// # Errors
    /// [`VaultError::Invariant`] when there is no such entity.
    pub fn touch(&self, id: &str, now: &str) -> Result<()> {
        let first = self.pending.borrow_mut().stamped.insert(id.to_owned());
        if first {
            let changed = self.connection.execute(
                "UPDATE entity SET updated_at = ?2, version = version + 1 WHERE id = ?1",
                rusqlite::params![id, now],
            )?;
            if changed != 1 {
                self.pending.borrow_mut().stamped.remove(id);
                return Err(VaultError::Invariant {
                    context: format!("`{id}` is not an entity; there is nothing to touch"),
                });
            }
        }
        self.mark_for_index(id);
        Ok(())
    }

    /// An entity this commit inserted: it is already at its first version, so
    /// it is only owed an index row.
    pub fn born(&self, id: &str) {
        self.pending.borrow_mut().stamped.insert(id.to_owned());
        self.mark_for_index(id);
    }

    /// Insert an entity row: the first half of every kind's create, the half
    /// that is the same for all of them. The caller inserts the kind row next.
    ///
    /// # Errors
    /// Whatever SQLite refused: a duplicate id, a kind the CHECK does not know.
    pub fn insert_entity(&self, id: &str, kind: Kind, title: &str, now: &str) -> Result<()> {
        self.connection.execute(
            "INSERT INTO entity (id, kind, title, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)",
            rusqlite::params![id, kind.as_str(), title, now],
        )?;
        self.born(id);
        Ok(())
    }

    /// Re-index an entity whose own row did not change but whose search text
    /// did (the person a note stopped being `about`).
    pub fn mark_for_index(&self, id: &str) {
        self.pending.borrow_mut().reindex.insert(id.to_owned());
    }
}

/// WHICH TABLES A COMMIT TOUCHED, AND HOW MANY ROWS IT MOVED (#1029 §1).
///
/// Collected by a rusqlite `update_hook` for the length of one commit. The
/// hook fires once per inserted, updated or deleted row, inside the
/// transaction, and is handed the table name — so this is a set of names and a
/// count, never a row image.
///
/// **It is behind an `Arc<Mutex<…>>` because the hook is not.** `update_hook`
/// takes a `'static` closure and the guard is a stack frame; the `Arc` is what
/// lets the closure and the guard hold the same set, and the `Mutex` is what
/// makes the closure `Send`. There is no contention: one writer, one commit.
#[derive(Debug, Default)]
pub struct ChangeCensus {
    /// The tables this commit changed, in name order.
    pub tables: Vec<String>,
    /// How many rows the hook saw. One per changed row, so a statement that
    /// updated forty rows counts forty.
    pub rows: usize,
}

/// What a commit did.
#[derive(Debug, Clone)]
pub struct CommitResult<T> {
    pub value: T,
    /// Rows the `update_hook` saw. Zero is an honest answer: a body that wrote
    /// nothing moved nothing.
    pub rows: usize,
    /// The tables that changed, in name order. **This is what a change event
    /// is made of** — the shell re-reads the screens that read these tables.
    pub tables: Vec<String>,
}

/// What the hook fills and the guard reads: the tables and the row count.
///
/// The signed per-table delta that moved a running row census stood here
/// too; the census is counted on the backup snapshot's scratch copy now, off
/// the request path, and the counter went
/// ([#1080](https://github.com/srikanth235/centraid/issues/1080)).
#[derive(Debug, Default)]
struct Tally {
    tables: BTreeSet<String>,
    rows: usize,
}

/// The tally the hook fills and the guard reads.
type Census = Arc<Mutex<Tally>>;

impl Vault {
    /// Run a write inside the commit pair.
    ///
    /// See the module docs for the order. A nested call runs the body inside
    /// the enclosing pair and reports an empty census — the outer call is the
    /// one that opened the transaction and the one the hook is counting for.
    pub fn commit<T>(
        &self,
        body: impl FnOnce(&CommitTx<'_>) -> Result<T>,
    ) -> Result<CommitResult<T>> {
        let connection = self.connection();

        if self.depth.get() > 0 {
            let tx = CommitTx {
                connection,
                producer: RefCell::new(String::new()),
                pending: &self.pending,
            };
            let value = body(&tx)?;
            return Ok(CommitResult {
                value,
                rows: 0,
                tables: Vec::new(),
            });
        }

        connection
            .execute_batch("BEGIN IMMEDIATE")
            .map_err(|error| VaultError::from_sqlite("opening a commit", error))?;
        self.depth.set(1);

        // THE HOOK IS INSTALLED INSIDE THE TRANSACTION and removed before the
        // guard returns, so a read between commits carries no hook at all and
        // one commit's census can never absorb another's.
        let census: Census = Arc::new(Mutex::new(Tally::default()));
        if let Err(error) = install_hook(connection, &census) {
            self.depth.set(0);
            let _ = connection.execute_batch("ROLLBACK");
            return Err(error);
        }

        *self.pending.borrow_mut() = Pending::default();
        let outcome = (|| -> Result<T> {
            let tx = CommitTx {
                connection,
                producer: RefCell::new("unnamed".to_owned()),
                pending: &self.pending,
            };
            let value = body(&tx)?;
            // The index is part of the commit: a change and its search rows
            // land together or not at all.
            let owed = std::mem::take(&mut self.pending.borrow_mut().reindex);
            crate::index::reindex(connection, &owed)?;
            Ok(value)
        })();

        self.depth.set(0);
        *self.pending.borrow_mut() = Pending::default();

        match outcome {
            Ok(value) => {
                connection
                    .execute_batch("COMMIT")
                    .map_err(|error| VaultError::from_sqlite("committing", error))?;
                // READ AFTER THE COMMIT, and cleared only then. A census read
                // before it would be a screen redrawn from a transaction that
                // could still roll back.
                let tally = take_census(connection, &census);
                let rows = tally.rows;
                let tables: Vec<String> = tally.tables.into_iter().collect();
                tracing::debug!(rows, tables = tables.len(), "commit");
                Ok(CommitResult {
                    value,
                    rows,
                    tables,
                })
            }
            Err(error) => {
                let _ = connection.execute_batch("ROLLBACK");
                // A ROLLBACK REPORTS NOTHING. The hook fired for every row the
                // body wrote and none of those rows exists any more, so the
                // census is dropped rather than returned.
                let _ = take_census(connection, &census);
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

/// FTS5's own shadow tables, by suffix.
///
/// `search` is backed by `search_content`, `_data`, `_docsize`, `_idx` and
/// `_config`. They are SQLite's bookkeeping for the index, and the index itself
/// is not rows a screen reads: it follows the entities the census already names.
const FTS_SHADOW_SUFFIXES: [&str; 5] = ["_content", "_data", "_docsize", "_idx", "_config"];

/// Whether a table is the search index, one of FTS5's shadows of it, or the
/// list of its words: derived rows the writer keeps and a rebuild rewrites,
/// not rows a member made.
pub(crate) fn is_index(table: &str) -> bool {
    table == "search"
        || table == "search_word"
        || (table.starts_with("search_")
            && FTS_SHADOW_SUFFIXES
                .iter()
                .any(|suffix| table.ends_with(suffix)))
}

/// Whether a table name is a change a screen could care about.
///
/// Not SQLite's own, not the search index, and not the journal, which every
/// command writes and no screen reads.
pub(crate) fn is_reportable(table: &str) -> bool {
    !table.starts_with("sqlite_") && table != "journal" && !is_index(table)
}

/// Point the connection's `update_hook` at `census` for the length of a commit.
fn install_hook(connection: &Connection, census: &Census) -> Result<()> {
    let shared = Arc::clone(census);
    connection.update_hook(Some(
        move |_action: Action, _database: &str, table: &str, _row_id: i64| {
            if !is_reportable(table) {
                return;
            }
            if let Ok(mut held) = shared.lock() {
                held.rows += 1;
                if !held.tables.contains(table) {
                    held.tables.insert(table.to_owned());
                }
            }
        },
    ))?;
    Ok(())
}

/// Take the census and remove the hook.
///
/// The hook is removed FIRST: the closure owns a clone of the `Arc`, and
/// leaving it installed would leave one commit's set alive to be written to by
/// the next statement on this connection.
fn take_census(connection: &Connection, census: &Census) -> Tally {
    let _ = connection.update_hook(None::<fn(Action, &str, &str, i64)>);
    let Ok(mut held) = census.lock() else {
        return Tally::default();
    };
    std::mem::take(&mut *held)
}

#[cfg(test)]
mod tests {
    use super::is_reportable;

    /// A shadow table is the index, not the rows. The base table's own entry
    /// is what a screen reads, and it is already in the census.
    #[test]
    fn the_index_the_journal_and_sqlites_own_are_not_reported() {
        assert!(is_reportable("note"));
        assert!(is_reportable("locker_item"));
        for hidden in [
            "search",
            "search_content",
            "search_data",
            "search_docsize",
            "search_idx",
            "search_config",
            "search_word",
            "journal",
            "sqlite_sequence",
        ] {
            assert!(!is_reportable(hidden), "{hidden}");
        }
        // A table that merely ENDS in a shadow suffix without the `search_`
        // prefix is an ordinary table and is reported.
        assert!(is_reportable("photo_data"));
    }
}
