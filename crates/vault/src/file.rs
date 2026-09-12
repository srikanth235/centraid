//! Opening and founding a v1 vault file, and the one writable connection.
//!
//! ## The guard is the write path, and it is a type (D-1020-D1-5)
//!
//! v0 learned this the expensive way: capture is per CONNECTION, four canonical
//! call sites simply lacked the commit pair, and every worker subprocess that
//! opened `vault.db` by path had no session watching it at all — silent,
//! permanent replication loss. The answer became `withReplicaCommit` plus a
//! lint rule reading the same invariant off the diff (plane census, honourable
//! mention 1).
//!
//! Here the invariant is the API's shape instead. [`Vault`] does not hand out a
//! writable `Connection`:
//!
//! - [`Vault::commit`] opens `BEGIN IMMEDIATE`, opens the sessions, and hands
//!   the body a [`crate::log::CommitTx`]. That is the only writable connection
//!   in the crate's public surface.
//! - [`Vault::read`] hands out a `&Connection` with `PRAGMA query_only = ON`
//!   set around the closure, so a write through it is refused by SQLite itself
//!   rather than by a reviewer.
//!
//! `tests/log_plane.rs` asserts both halves, and the receipt carries the grep
//! that shows no other public function returns a `Connection`.

use std::cell::Cell;
use std::path::{Path, PathBuf};

use rusqlite::Connection;

use crate::clock::{Clock, Ids, SeededIds, SystemClock};
use crate::error::{Result, VaultError};
use crate::migrations::{APPLICATION_ID, head_version};

/// How a vault file was opened.
pub struct Vault {
    connection: Connection,
    path: PathBuf,
    schema_version: i64,
    clock: Box<dyn Clock>,
    ids: Box<dyn Ids>,
    /// Commit-guard depth. A nested `commit` is a deliberate no-op, exactly as
    /// v0's `withReplicaCommit` nests: the inner body runs inside the outer
    /// pair, and one pair means one `commit_seq` for one logical commit.
    pub(crate) depth: Cell<u32>,
    /// Read depth, so a nested read does not clear `query_only` early.
    read_depth: Cell<u32>,
    /// A fault to inject, for the snapshot builder's interrupted-build test.
    pub(crate) fault: Cell<Option<crate::snapshot::Fault>>,
}

impl Vault {
    /// Found a new v1 vault: run the ladder from nothing, stamp the two
    /// pragmas, seed the replica plane.
    ///
    /// Refuses an existing file. A `create` that opened one would be an `open`
    /// with a different name, and the one thing a caller needs to know here is
    /// whether they just made a vault or found one.
    pub fn create(path: impl AsRef<Path>) -> Result<Self> {
        Self::create_with(path, Box::new(SystemClock), Box::new(SeededIds::new("v1")))
    }

    /// Found a vault against an injected clock and id source.
    pub fn create_with(
        path: impl AsRef<Path>,
        clock: Box<dyn Clock>,
        ids: Box<dyn Ids>,
    ) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        if path.exists() {
            return Err(VaultError::Invariant {
                context: format!("{} already exists; open it instead", path.display()),
            });
        }
        let connection = Connection::open(&path)?;
        connection.pragma_update(None, "journal_mode", "wal")?;
        connection.pragma_update(None, "application_id", APPLICATION_ID)?;
        // OFF for the ladder: the baseline creates 157 tables whose foreign
        // keys point at each other, and SQLite resolves an FK's target lazily,
        // so leaving enforcement on during creation would only make the order
        // matter for no benefit.
        connection.pragma_update(None, "foreign_keys", "OFF")?;
        crate::migrations::run_from(&connection, 0)?;
        connection.pragma_update(None, "foreign_keys", "ON")?;

        let vault = Self::wrap(connection, path, head_version(), clock, ids)?;
        crate::log::seed_replica_meta(&vault)?;
        Ok(vault)
    }

    /// Open an existing v1 vault, migrating it forward if it is behind.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        Self::open_with(path, Box::new(SystemClock), Box::new(SeededIds::new("v1")))
    }

    /// Open against an injected clock and id source.
    pub fn open_with(
        path: impl AsRef<Path>,
        clock: Box<dyn Clock>,
        ids: Box<dyn Ids>,
    ) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        if !path.exists() {
            return Err(VaultError::Missing { path });
        }
        let connection = Connection::open(&path)?;

        // The tag first: `user_version` on a file that is not ours means
        // nothing, and "your file is at version 42" is a worse message than
        // "this is not a Centraid vault".
        let application_id: i64 =
            connection.query_row("PRAGMA application_id", [], |row| row.get(0))?;
        if application_id != APPLICATION_ID {
            return Err(VaultError::NotAVault {
                path,
                found: application_id,
                expected: APPLICATION_ID,
            });
        }

        let found: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if found > head_version() {
            return Err(VaultError::DowngradeRefused {
                path,
                found,
                expected: head_version(),
            });
        }

        connection.pragma_update(None, "journal_mode", "wal")?;
        connection.pragma_update(None, "foreign_keys", "ON")?;

        if found < head_version() {
            // THE ONE-SNAPSHOT RULE. The pre-migration safety copy is the same
            // artifact as a backup and a seat's bootstrap, and it is taken
            // BEFORE the ladder runs — an upgrade that fails mid-migration
            // restores from it, which is the restore drill's own path (#1020,
            // Compatibility). It cannot be taken from inside `run_from`:
            // `VACUUM INTO` may not run in a transaction.
            let staging = crate::snapshot::pre_migration_dir(&path);
            let vault = Self::wrap(connection, path.clone(), found, clock, ids)?;
            crate::snapshot::build_snapshot(&vault, &staging)?;
            crate::migrations::run_from(vault.connection(), found)?;
            let reached: i64 = vault
                .connection()
                .query_row("PRAGMA user_version", [], |row| row.get(0))?;
            return Self::wrap(
                Connection::open(&path)?,
                path,
                reached,
                Box::new(SystemClock),
                Box::new(SeededIds::new("v1")),
            );
        }

        Self::wrap(connection, path, found, clock, ids)
    }

    fn wrap(
        connection: Connection,
        path: PathBuf,
        schema_version: i64,
        clock: Box<dyn Clock>,
        ids: Box<dyn Ids>,
    ) -> Result<Self> {
        // The seat floor rules out plenty of SQL; nothing here needs to know
        // that, but the busy timeout does have to be set on every connection
        // or a second writer fails instantly instead of waiting.
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        Ok(Self {
            connection,
            path,
            schema_version,
            clock,
            ids,
            depth: Cell::new(0),
            read_depth: Cell::new(0),
            fault: Cell::new(None),
        })
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The `user_version` this file carries — v1's own axis, counting v1's
    /// migrations, never a v0 rung number (D-1020-D1-2).
    #[must_use]
    pub const fn schema_version(&self) -> i64 {
        self.schema_version
    }

    #[must_use]
    pub fn clock(&self) -> &dyn Clock {
        self.clock.as_ref()
    }

    #[must_use]
    pub fn ids(&self) -> &dyn Ids {
        self.ids.as_ref()
    }

    /// Run a READ against the file.
    ///
    /// `PRAGMA query_only = ON` is set for the duration, so this connection
    /// cannot be the one a write escapes through. Nested reads are counted, so
    /// an inner read does not clear the pragma while an outer one is still
    /// running.
    pub fn read<T>(&self, body: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        if self.depth.get() > 0 {
            // Inside a commit the connection is deliberately writable; turning
            // `query_only` on here would break the enclosing commit's writes.
            return body(&self.connection);
        }
        let outermost = self.read_depth.get() == 0;
        if outermost {
            self.connection.pragma_update(None, "query_only", "ON")?;
        }
        self.read_depth.set(self.read_depth.get() + 1);
        let outcome = body(&self.connection);
        self.read_depth.set(self.read_depth.get() - 1);
        if outermost {
            self.connection.pragma_update(None, "query_only", "OFF")?;
        }
        outcome
    }

    /// The connection, for this crate's own internals only.
    ///
    /// Crate-private on purpose: the snapshot builder needs `VACUUM INTO`,
    /// which `query_only` forbids and which is not a write to the live file,
    /// and the log store needs to insert its rows inside the guard's
    /// transaction. Neither is a caller-facing write path.
    pub(crate) const fn connection(&self) -> &Connection {
        &self.connection
    }

    /// Close the file, surfacing a failure to close rather than swallowing it.
    pub fn close(self) -> Result<()> {
        self.connection
            .close()
            .map_err(|(_, error)| VaultError::Sqlite(error))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock::FixedClock;

    fn scratch() -> PathBuf {
        centraid_ontology::golden::scratch_dir()
    }

    #[test]
    fn a_founded_vault_carries_both_pragmas_and_the_head_version() {
        let dir = scratch();
        std::fs::create_dir_all(&dir).expect("the scratch dir is made");
        let vault = Vault::create_with(
            dir.join("vault.db"),
            Box::new(FixedClock::frozen()),
            Box::new(SeededIds::new("test")),
        )
        .expect("a vault is founded");
        assert_eq!(vault.schema_version(), head_version());
        let application_id: i64 = vault
            .read(|connection| {
                Ok(connection.query_row("PRAGMA application_id", [], |row| row.get(0))?)
            })
            .expect("the pragma reads");
        assert_eq!(application_id, APPLICATION_ID);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_read_connection_refuses_a_write() {
        // THE INVARIANT AS A TYPE (D-1020-D1-5). Not "no caller writes here" —
        // SQLite itself refuses.
        let dir = scratch();
        std::fs::create_dir_all(&dir).expect("the scratch dir is made");
        let vault = Vault::create_with(
            dir.join("vault.db"),
            Box::new(FixedClock::frozen()),
            Box::new(SeededIds::new("test")),
        )
        .expect("a vault is founded");
        let outcome = vault.read(|connection| {
            connection
                .execute("UPDATE core_vault SET display_name = 'x'", [])
                .map_err(VaultError::Sqlite)
        });
        let error = outcome.expect_err("a write through a read connection must be refused");
        assert!(
            error.to_string().contains("readonly") || error.to_string().contains("read-only"),
            "SQLite refused with `{error}`, which does not name the reason"
        );
        // And the pragma is back off afterwards, or the next commit would fail.
        let restored: i64 = vault
            .read(|connection| Ok(connection.query_row("PRAGMA query_only", [], |row| row.get(0))?))
            .expect("the pragma reads");
        assert_eq!(restored, 1, "inside a read it is ON");
        let outside: i64 = vault
            .connection()
            .query_row("PRAGMA query_only", [], |row| row.get(0))
            .expect("the pragma reads");
        assert_eq!(outside, 0, "outside a read it is OFF again");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_file_that_is_not_ours_is_refused_before_its_version_is_read() {
        let dir = scratch();
        std::fs::create_dir_all(&dir).expect("the scratch dir is made");
        let path = dir.join("other.db");
        let connection = Connection::open(&path).expect("a plain database opens");
        connection
            .pragma_update(None, "user_version", 99)
            .expect("the stamp writes");
        drop(connection);
        match Vault::open(&path) {
            Err(VaultError::NotAVault {
                found, expected, ..
            }) => {
                assert_eq!(found, 0);
                assert_eq!(expected, APPLICATION_ID);
            }
            other => panic!("expected NotAVault, got {other:?}", other = other.err()),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_file_a_newer_build_wrote_is_refused_as_a_downgrade() {
        let dir = scratch();
        std::fs::create_dir_all(&dir).expect("the scratch dir is made");
        let path = dir.join("vault.db");
        let vault = Vault::create_with(
            &path,
            Box::new(FixedClock::frozen()),
            Box::new(SeededIds::new("test")),
        )
        .expect("a vault is founded");
        vault.close().expect("it closes");
        let connection = Connection::open(&path).expect("it reopens");
        let ahead = head_version() + 1;
        connection
            .pragma_update(None, "user_version", ahead)
            .expect("the stamp writes");
        drop(connection);
        match Vault::open(&path) {
            Err(VaultError::DowngradeRefused {
                found, expected, ..
            }) => {
                assert_eq!(found, ahead);
                assert_eq!(expected, head_version());
            }
            other => panic!("expected DowngradeRefused, got {:?}", other.err()),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn creating_over_an_existing_file_is_refused() {
        let dir = scratch();
        std::fs::create_dir_all(&dir).expect("the scratch dir is made");
        let path = dir.join("vault.db");
        Vault::create(&path)
            .expect("the first founding works")
            .close()
            .expect("it closes");
        assert!(Vault::create(&path).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
