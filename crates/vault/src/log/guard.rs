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
//! The capture hook #1029 §2 wants — the one that spools changed PAGES before a
//! checkpoint — is **not** here. W3 places it, and this module leaves the seam
//! rather than half-building it.
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

/// The writable connection a commit body is handed.
///
/// The ONLY one in this crate's public surface. It is deliberately not
/// `Deref<Target = Connection>`: a caller that wants the connection asks for it
/// by name, which is what makes the receipt's grep meaningful.
pub struct CommitTx<'conn> {
    connection: &'conn Connection,
    producer: RefCell<String>,
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

/// The set the hook fills and the guard reads.
type Census = Arc<Mutex<(BTreeSet<String>, usize)>>;

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
        let census: Census = Arc::new(Mutex::new((BTreeSet::new(), 0)));
        if let Err(error) = install_hook(connection, &census) {
            self.depth.set(0);
            let _ = connection.execute_batch("ROLLBACK");
            return Err(error);
        }

        let outcome = (|| -> Result<T> {
            let tx = CommitTx {
                connection,
                producer: RefCell::new("unnamed".to_owned()),
            };
            let value = body(&tx)?;
            Ok(value)
        })();

        self.depth.set(0);

        match outcome {
            Ok(value) => {
                connection
                    .execute_batch("COMMIT")
                    .map_err(|error| VaultError::from_sqlite("committing", error))?;
                // READ AFTER THE COMMIT, and cleared only then. A census read
                // before it would be a screen redrawn from a transaction that
                // could still roll back.
                let (tables, rows) = take_census(connection, &census);
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

    /// EVERY ROW THIS VAULT HOLDS, BY TABLE (#1029 §1, F4).
    ///
    /// The running census a phone compares against: the shrink guard's
    /// phone-side warning is "the total is below half of what it was, or one
    /// app's rows are down more than 90%", and that question cannot be asked
    /// of a gateway holding ciphertext — only here, where the rows are
    /// readable.
    ///
    /// `sqlite_%` tables are excluded: they are SQLite's own bookkeeping and a
    /// member has no app whose rows they are.
    pub fn census(&self) -> Result<Vec<(String, i64)>> {
        self.read(|connection| {
            let mut statement = connection.prepare(
                r"SELECT name FROM sqlite_master
                    WHERE type = 'table'
                      AND name NOT LIKE 'sqlite\_%' ESCAPE '\'
                    ORDER BY name",
            )?;
            let tables: Vec<String> = statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let mut census = Vec::with_capacity(tables.len());
            for table in tables {
                let sql = format!(
                    "SELECT count(*) FROM {}",
                    crate::log::identifiers::quoted(&table)
                );
                let rows: i64 = connection.query_row(&sql, [], |row| row.get(0))?;
                census.push((table, rows));
            }
            Ok(census)
        })
    }
}

/// FTS5's own shadow tables, by suffix.
///
/// An FTS5 virtual table is backed by `<name>_content`, `_data`, `_docsize`,
/// `_idx` and `_config`, and every insert into an indexed table writes them
/// through a trigger. They are SQLite's bookkeeping for the index, not rows a
/// screen reads — and the base table's own entry in the census already says
/// that its rows moved. Reporting them would make every write to an indexed
/// table name four extra "tables" no shell has ever heard of.
const FTS_SHADOW_SUFFIXES: [&str; 5] = ["_content", "_data", "_docsize", "_idx", "_config"];

/// Whether a table name is a change a screen could care about.
fn is_reportable(table: &str) -> bool {
    if table.starts_with("sqlite_") {
        return false;
    }
    !(table.starts_with("fts_")
        && FTS_SHADOW_SUFFIXES
            .iter()
            .any(|suffix| table.ends_with(suffix)))
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
                held.1 += 1;
                if !held.0.contains(table) {
                    held.0.insert(table.to_owned());
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
fn take_census(connection: &Connection, census: &Census) -> (Vec<String>, usize) {
    let _ = connection.update_hook(None::<fn(Action, &str, &str, i64)>);
    let Ok(mut held) = census.lock() else {
        return (Vec::new(), 0);
    };
    let tables = std::mem::take(&mut held.0).into_iter().collect();
    let rows = std::mem::replace(&mut held.1, 0);
    (tables, rows)
}

#[cfg(test)]
mod tests {
    use super::is_reportable;

    /// A shadow table is the index, not the rows. The base table's own entry
    /// is what a screen reads, and it is already in the census.
    #[test]
    fn ftss_shadow_tables_and_sqlites_own_are_not_reported() {
        assert!(is_reportable("core_party"));
        assert!(is_reportable("fts_core_party"), "the virtual table itself");
        for shadow in [
            "fts_core_party_content",
            "fts_core_party_data",
            "fts_core_party_docsize",
            "fts_core_party_idx",
            "fts_core_party_config",
        ] {
            assert!(!is_reportable(shadow), "{shadow}");
        }
        assert!(!is_reportable("sqlite_sequence"));
        // A table that merely ENDS in a shadow suffix without the `fts_`
        // prefix is an ordinary table and is reported.
        assert!(is_reportable("media_asset_data"));
    }
}
