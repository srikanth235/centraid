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

use crate::clock::{Clock, ClockIds, Ids, SystemClock};
use crate::error::{Result, VaultError};
use crate::migrations::{APPLICATION_ID, head_version};

/// THE PAGE SIZE, PINNED (#1029 §1).
///
/// Capture ships **pages**, not WAL bytes, and a segment's addresses are page
/// numbers — so the page size is part of the segment format rather than a
/// tuning knob. A file founded at one size and read by a build that assumed
/// another would decode every segment at the wrong offset, and SQLite's
/// compiled default has changed once already (1024 → 4096 in 3.12). 4096 is
/// stated here so the file carries the decision rather than the build.
///
/// It can only be set on an EMPTY database: changing it afterwards needs a
/// `VACUUM`, which this vault never runs (see [`Self::apply_pragmas`]).
pub const PAGE_SIZE: i64 = 4096;

/// How far the WAL is truncated back to when the app checkpoints it.
///
/// Not a checkpoint trigger — [`Self::apply_pragmas`] turns SQLite's automatic
/// one off — but the ceiling a TRUNCATE leaves behind, so a vault that took one
/// large import does not keep the sidecar it needed for it for the life of the
/// phone. 64 MiB: large enough that an ordinary session never truncates, small
/// enough that the file is not a surprise in a storage listing.
pub const JOURNAL_SIZE_LIMIT: i64 = 64 * 1024 * 1024;

/// How a vault file was opened.
pub struct Vault {
    connection: Connection,
    path: PathBuf,
    schema_version: i64,
    clock: Box<dyn Clock>,
    ids: Box<dyn Ids>,
    /// Commit-guard depth. A nested `commit` is a deliberate no-op: the inner
    /// body runs inside the outer pair, and one pair is one transaction.
    pub(crate) depth: Cell<u32>,
    /// Read depth, so a nested read does not clear `query_only` early.
    read_depth: Cell<u32>,
    /// A fault to inject, for the snapshot builder's interrupted-build test.
    pub(crate) fault: Cell<Option<crate::snapshot::Fault>>,
    /// THE LOCAL CONTENT STORE, where bytes that are not text go.
    ///
    /// `core_content_item.content_uri` is `blob:blake3-<hex>` for anything
    /// binary, and the bytes themselves live here — a vault file is rows, and
    /// a photograph in a row is a photograph in the journal. See
    /// [`Vault::with_blobs`].
    blobs: Option<Box<dyn crate::backup::store::BlobStore + Send + Sync>>,
}

impl Vault {
    /// Found a new v1 vault: run the ladder from nothing, stamp the two
    /// pragmas, seed the replica plane.
    ///
    /// Refuses an existing file. A `create` that opened one would be an `open`
    /// with a different name, and the one thing a caller needs to know here is
    /// whether they just made a vault or found one.
    pub fn create(path: impl AsRef<Path>) -> Result<Self> {
        // RANDOM BY DEFAULT, AND MINTED OFF THE CLOCK. `SeededIds` used to be
        // the default here and its counter starts at zero per instance, so the
        // first write after any reopen collided with the first write of the
        // session before it — reproduced through the C ABI as
        // `Refused(code=63, entity id is already held by another kind)`
        // (#1020 wave 3, lane E finding 1). `SeededIds` is for the simulation
        // and the golden fixtures, both of which inject it.
        Self::create_with(path, Box::new(SystemClock), Box::new(ClockIds::system()))
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
        // THE HEADER PRAGMAS, AND ONLY HERE. `page_size` and `auto_vacuum` are
        // both recorded in the file header and both are silently ignored once a
        // page exists — and `journal_mode = wal` writes one. Founding is the
        // only moment either can be stated, which is why they are not in
        // [`Self::apply_pragmas`] with the rest: a pragma that can only be set
        // once must not sit in a function every open calls, where its failure
        // to take would look like success.
        connection.pragma_update(None, "page_size", PAGE_SIZE)?;
        // NO AUTO-VACUUM, AND `VACUUM` NEVER RUNS (#1029 §1). A vacuum
        // renumbers pages, and capture addresses segments BY page number: every
        // page in the file would read as changed, the range dedup would match
        // nothing, and the next backup would be a full copy of the vault. The
        // space a vacuum reclaims is worth less than that.
        connection.pragma_update(None, "auto_vacuum", "NONE")?;
        Self::apply_pragmas(&connection)?;
        connection.pragma_update(None, "application_id", APPLICATION_ID)?;
        // OFF for the ladder: the baseline creates 157 tables whose foreign
        // keys point at each other, and SQLite resolves an FK's target lazily,
        // so leaving enforcement on during creation would only make the order
        // matter for no benefit.
        connection.pragma_update(None, "foreign_keys", "OFF")?;
        crate::migrations::run_from(&connection, 0)?;
        // The registry the schema's own foreign keys point into, derived from
        // the DDL that was just run (D-1020-D1-15). Before `foreign_keys = ON`,
        // because `core_entity_kind` is what makes the first entity insert
        // legal and seeding it is not itself an entity write.
        crate::migrations::seed_entity_kinds(&connection)?;
        connection.pragma_update(None, "foreign_keys", "ON")?;

        Self::wrap(connection, path, head_version(), clock, ids)
    }

    /// Open an existing v1 vault, migrating it forward if it is behind.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        // See `create`: a seeded default restarts its sequence on every open.
        Self::open_with(path, Box::new(SystemClock), Box::new(ClockIds::system()))
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

        Self::apply_pragmas(&connection)?;
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
                Box::new(ClockIds::system()),
            );
        }

        Self::wrap(connection, path, found, clock, ids)
    }

    /// THE PRAGMA SET, IN ONE PLACE, ON EVERY CONNECTION THIS CRATE OPENS
    /// (#1029 §1).
    ///
    /// Stated rather than inherited. Everything below except `journal_mode` was
    /// previously left at whatever the linked SQLite was compiled with, which
    /// means the vault's durability was a property of the build and not of the
    /// product — and `synchronous` in particular defaults to `NORMAL` under WAL,
    /// which is the one setting F11 forbids.
    ///
    /// - **`journal_mode = WAL`** — the WAL is the phone's commit log, and what
    ///   capture reads.
    /// - **`synchronous = FULL`, explicitly (F11).** The durability order is
    ///   "the WAL is durable before the spool". Under `NORMAL` a commit is
    ///   acknowledged before its WAL frames reach the disk, so a crash between
    ///   the acknowledgement and the fsync leaves the spool holding a commit the
    ///   phone itself lost — a backup ahead of the device it backs up. There is
    ///   no correct recovery from that, so it is not allowed to happen.
    /// - **`wal_autocheckpoint = 0`** — the app owns checkpoints. SQLite's
    ///   automatic one fires inside whichever commit happens to cross the
    ///   threshold, which is precisely the moment capture has not sealed the
    ///   tail; the WAL then restarts under it and two different byte ranges
    ///   seal under one address.
    /// - **`journal_size_limit`** — see [`JOURNAL_SIZE_LIMIT`].
    /// - **`SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE`** — a last close must never
    ///   checkpoint away a WAL the spool has not sealed. This is the half
    ///   `docs/traps/wal-checkpoint.md` records as a real defect.
    /// - **No `secure_delete`.** The file is plaintext to whoever can read it,
    ///   so zeroing freed cells buys nothing — and it dirties pages capture then
    ///   has to ship.
    ///
    /// `page_size` and `auto_vacuum` are NOT here: both are header properties
    /// that only take on an empty file, so they are stated once in
    /// [`Self::create_with`] where the statement can actually succeed.
    fn apply_pragmas(connection: &Connection) -> Result<()> {
        connection.pragma_update(None, "journal_mode", "wal")?;
        connection.pragma_update(None, "synchronous", "FULL")?;
        connection.pragma_update(None, "wal_autocheckpoint", 0)?;
        connection.pragma_update(None, "journal_size_limit", JOURNAL_SIZE_LIMIT)?;
        connection.set_db_config(
            rusqlite::config::DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE,
            true,
        )?;
        // The busy timeout has to be set on every connection or a second writer
        // fails instantly instead of waiting.
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        Ok(())
    }

    fn wrap(
        connection: Connection,
        path: PathBuf,
        schema_version: i64,
        clock: Box<dyn Clock>,
        ids: Box<dyn Ids>,
    ) -> Result<Self> {
        // ONE OPENER, ONE PRAGMA SET, ONE CONNECTION PER VAULT — and this is the
        // funnel all three meet in (#1029 §1). Every `Vault` in the process
        // comes through here, so a connection that reached a caller without the
        // set below is a connection that was never wrapped.
        //
        // **The one connection is an invariant now, not a convenience.** It used
        // to be justified by SQLite's single writer (D-1020-D2-9); under capture
        // it is stronger than that, and in both directions:
        //
        // - A separate READER connection makes a TRUNCATE checkpoint partial —
        //   SQLite will not reset a WAL any connection still has a snapshot in —
        //   so the checkpoint half-succeeds, the tail is never sealed at a known
        //   offset, and capture loops over the same range.
        // - A second OPENER arrives with the compiled default
        //   `wal_autocheckpoint` (1000 pages) rather than the 0 set above, and
        //   restarts the WAL underneath a capture that is mid-segment.
        //
        // So reads are `query_only` toggled on this same connection
        // ([`Self::read`]) rather than served from a pool, and nothing else in
        // the process opens the file.
        Self::apply_pragmas(&connection)?;
        Ok(Self {
            connection,
            path,
            schema_version,
            clock,
            ids,
            depth: Cell::new(0),
            read_depth: Cell::new(0),
            fault: Cell::new(None),
            blobs: None,
        })
    }

    /// ATTACH THE LOCAL CONTENT STORE. Without one, this vault can hold text
    /// and nothing else.
    ///
    /// A vault file is rows. Text bodies stay in the row — the FTS triggers
    /// decode them in-transaction and cannot do I/O — and every other kind of
    /// byte spills here, with the row keeping only `blob:blake3-<hex>`.
    ///
    /// **Optional, and honestly so.** A vault with no store refuses binary
    /// inline bytes rather than writing a `core_content_item` whose
    /// `content_uri` names bytes nothing kept — a library of rows with no
    /// photographs in it. `pre_inline_bytes_are_storable` is that refusal and
    /// it now asks THIS.
    ///
    /// It is the OPENER's decision where the store lives, because only the
    /// opener knows the layout it is opening into. Since #1025 S3 every opener
    /// hands over the SAME store the byte plane moves bytes on — `<vault>.bytes`,
    /// iroh's, behind `centraid_core::bytes::ContentBytes` — so a photograph
    /// this door spills is a photograph a seat can fetch, and one a seat
    /// fetched is a photograph this vault can locate. The flat
    /// `<vault>.blobs/` CAS and `Vault::blobs_root_for` that named it are gone
    /// (D-1025-S3-1).
    #[must_use]
    pub fn with_blobs(
        mut self,
        blobs: Box<dyn crate::backup::store::BlobStore + Send + Sync>,
    ) -> Self {
        self.blobs = Some(blobs);
        self
    }

    /// The local content store, if one was attached.
    #[must_use]
    pub fn blobs(&self) -> Option<&(dyn crate::backup::store::BlobStore + Send + Sync)> {
        self.blobs.as_deref()
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

    /// THE CONNECTION A REPLICA'S APPLIER WRITES THROUGH (#1025 S5).
    ///
    /// A seat's sync pass is not a read and it is not a command: it applies the
    /// gateway's log to the mirror, one transaction per commit, with its own
    /// rules (`centraid_seat::applier`) — so it needs the file's ONE connection
    /// and it needs it writable.
    ///
    /// **The defect this closes.** `centraid_core::Handle::sync_now` handed the
    /// pass `Vault::read`'s connection, which sets `PRAGMA query_only = ON` for
    /// the duration. Every apply therefore failed, the failure landed in
    /// `PassReport::stale`, and `SyncOutcome` has no field for it — so a pass
    /// through the core reported a reached gateway, zero rows and no error, on
    /// every window, forever. Every test that ever saw a row arrive drove
    /// `SeatLink` over a connection of its own.
    ///
    /// Why the one connection rather than a second: SQLite allows one writer
    /// and this object holds it. A connection opened alongside would contend
    /// with its owner and the loser would be whichever asked second.
    ///
    /// **Refused inside a read or a commit**, which is the whole of its safety:
    /// a write under an outer `read` would be the escape hatch `query_only`
    /// exists to prevent, and one inside a commit guard would put a mirror's
    /// rows in an author's transaction.
    pub fn apply_replica<T>(&self, body: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        if self.depth.get() > 0 || self.read_depth.get() > 0 {
            return Err(VaultError::Invariant {
                context: "a replica apply was attempted inside a read or a commit".to_owned(),
            });
        }
        body(&self.connection)
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
    use crate::clock::{FixedClock, SeededIds};

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

    /// Every pragma #1029 §1 names, asserted on a FRESHLY OPENED vault.
    ///
    /// Read off the connection rather than off the source: the point of stating
    /// them is that the file and the connection carry the decision, and a test
    /// that re-read the constants would pass against a build that set none of
    /// them.
    #[test]
    fn a_founded_vault_carries_the_whole_pragma_set() {
        let dir = scratch();
        std::fs::create_dir_all(&dir).expect("the scratch dir is made");
        let path = dir.join("vault.db");
        let vault = Vault::create_with(
            &path,
            Box::new(FixedClock::frozen()),
            Box::new(SeededIds::new("test")),
        )
        .expect("a vault is founded");
        assert_eq!(pragma_text(&vault, "journal_mode"), "wal");
        // FULL is 2. Explicit, never the compiled default — under WAL that
        // default is NORMAL, which is the one setting F11 forbids.
        assert_eq!(pragma_int(&vault, "synchronous"), 2, "synchronous = FULL");
        assert_eq!(
            pragma_int(&vault, "wal_autocheckpoint"),
            0,
            "the app owns checkpoints"
        );
        assert_eq!(pragma_int(&vault, "journal_size_limit"), JOURNAL_SIZE_LIMIT);
        assert_eq!(pragma_int(&vault, "page_size"), PAGE_SIZE);
        assert_eq!(pragma_int(&vault, "auto_vacuum"), 0, "auto_vacuum = NONE");
        // NOT SET, and that is the assertion. The file is plaintext to whoever
        // can read it, so zeroing freed cells buys nothing and dirties pages
        // capture must then ship.
        assert_eq!(pragma_int(&vault, "secure_delete"), 0, "no secure_delete");
        assert!(
            vault
                .connection()
                .db_config(rusqlite::config::DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE)
                .expect("the db config reads"),
            "a last close must not checkpoint away a WAL the spool has not sealed"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A SECOND OPEN CHANGES NOTHING SILENTLY.
    ///
    /// The failure this guards is the one `docs/traps/wal-checkpoint.md`
    /// records: a second opener arrives with the compiled-in
    /// `wal_autocheckpoint` and restarts the WAL under a capture that is
    /// mid-segment. Every connection comes through `wrap`, so every connection
    /// carries the same set — and the header pragmas survive because they are
    /// in the file.
    #[test]
    fn a_second_open_carries_the_same_pragma_set_and_changes_no_header() {
        let dir = scratch();
        std::fs::create_dir_all(&dir).expect("the scratch dir is made");
        let path = dir.join("vault.db");
        let founded = Vault::create_with(
            &path,
            Box::new(FixedClock::frozen()),
            Box::new(SeededIds::new("test")),
        )
        .expect("a vault is founded");
        founded.close().expect("the founding connection closes");

        let reopened = Vault::open(&path).expect("the vault opens again");
        assert_eq!(pragma_text(&reopened, "journal_mode"), "wal");
        assert_eq!(pragma_int(&reopened, "synchronous"), 2);
        assert_eq!(
            pragma_int(&reopened, "wal_autocheckpoint"),
            0,
            "a second opener must not bring the compiled default back"
        );
        assert_eq!(
            pragma_int(&reopened, "journal_size_limit"),
            JOURNAL_SIZE_LIMIT
        );
        assert_eq!(pragma_int(&reopened, "page_size"), PAGE_SIZE);
        assert_eq!(pragma_int(&reopened, "auto_vacuum"), 0);
        assert_eq!(pragma_int(&reopened, "secure_delete"), 0);
        assert!(
            reopened
                .connection()
                .db_config(rusqlite::config::DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE)
                .expect("the db config reads")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn pragma_int(vault: &Vault, name: &str) -> i64 {
        vault
            .connection()
            .query_row(&format!("PRAGMA {name}"), [], |row| row.get(0))
            .unwrap_or_else(|error| panic!("PRAGMA {name} reads: {error}"))
    }

    fn pragma_text(vault: &Vault, name: &str) -> String {
        vault
            .connection()
            .query_row(&format!("PRAGMA {name}"), [], |row| row.get(0))
            .unwrap_or_else(|error| panic!("PRAGMA {name} reads: {error}"))
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

    /// THE REOPEN COLLISION (#1020 wave 3, lane E finding 1).
    ///
    /// `Vault::open` and `Vault::create` defaulted to `SeededIds::new("v1")`,
    /// whose counter starts at zero per INSTANCE — so the first write after any
    /// reopen asked for an id the first session had already used. Lane E
    /// reproduced it from Kotlin through the real C ABI:
    ///
    /// ```text
    /// Refused(code=63, detail=entity id is already held by another kind: core_party (#916))
    /// ```
    ///
    /// A gateway that restarts fails its next write, which is the whole shape
    /// of the bug: nothing is wrong with the file and nothing is wrong with the
    /// request. Every test in this crate founded a FRESH file, so none of them
    /// could see it.
    #[test]
    fn the_first_write_after_a_reopen_does_not_collide_with_the_first_session() {
        let dir = scratch();
        std::fs::create_dir_all(&dir).expect("the scratch dir is made");
        let path = dir.join("vault.db");

        // Session one: found the vault (two minted ids — the vault row and its
        // owner party) and close the file.
        let vault = Vault::create(&path).expect("a founded vault");
        vault.found("Test", "Test Owner").expect("it founds");
        vault.close().expect("it closes");

        // Session two: the same file, a fresh source of ids. Two writes,
        // because `found` minted two: with a per-instance counter the first
        // reopened id is the vault row's and the second is the owner party's.
        let vault = Vault::open(&path).expect("it reopens");
        let now = vault.clock().now_text();
        for label in ["after-reopen-1", "after-reopen-2"] {
            let id = vault.ids().next();
            vault
                .commit(|tx| {
                    tx.set_producer("test.reopen");
                    tx.connection().execute(
                        "INSERT INTO core_party
                           (party_id, kind, display_name, created_at, updated_at)
                         VALUES (?1, 'person', ?2, ?3, ?3)",
                        rusqlite::params![id, label, now],
                    )?;
                    Ok(())
                })
                .unwrap_or_else(|error| {
                    panic!("the write `{label}` after a reopen was refused: {error}")
                });
        }

        // And the ids really are fresh rather than merely accepted.
        let parties: i64 =
            vault
                .read(|connection| {
                    Ok(connection
                        .query_row("SELECT count(*) FROM core_party", [], |row| row.get(0))?)
                })
                .expect("the count reads");
        assert_eq!(
            parties, 3,
            "the owner plus the two written after the reopen"
        );
        vault.close().expect("it closes");
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
