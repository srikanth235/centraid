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

use std::cell::{Cell, Ref, RefCell};
use std::path::{Path, PathBuf};

use rusqlite::Connection;

use crate::clock::{Clock, ClockIds, Ids, SystemClock};
use crate::error::{Result, VaultError};
use crate::format::{APPLICATION_ID, EARLIER_APPLICATION_ID, SCHEMA_DIGEST};
use crate::migrations::head_version;

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

/// How far the WAL is truncated back to after a checkpoint.
///
/// Not a checkpoint trigger — SQLite's automatic checkpoint is — but the
/// ceiling a checkpoint leaves behind, so a vault that took one large import
/// does not keep the sidecar it needed for it for the life of the phone.
/// 64 MiB: large enough that an ordinary session never truncates, small enough
/// that the file is not a surprise in a storage listing.
pub const JOURNAL_SIZE_LIMIT: i64 = 64 * 1024 * 1024;

/// Where a founding is built before it takes its name.
fn founding_path(path: &Path) -> PathBuf {
    let mut name = path
        .file_name()
        .map(std::ffi::OsString::from)
        .unwrap_or_default();
    name.push(".founding");
    path.with_file_name(name)
}

/// The paths this process is founding right now. An `open` of the same path must not remove the
/// side file a founding on another thread is still building.
static FOUNDING_NOW: std::sync::Mutex<Vec<PathBuf>> = std::sync::Mutex::new(Vec::new());

/// Held for the length of one founding; dropping it says the founding is over (done or failed).
struct Founding(PathBuf);

impl Founding {
    fn begin(path: &Path) -> Self {
        FOUNDING_NOW
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(path.to_path_buf());
        Self(path.to_path_buf())
    }

    fn is_under_way(path: &Path) -> bool {
        FOUNDING_NOW
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .any(|held| held == path)
    }
}

impl Drop for Founding {
    fn drop(&mut self) {
        let mut held = FOUNDING_NOW
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(at) = held.iter().position(|path| *path == self.0) {
            held.swap_remove(at);
        }
    }
}

/// Remove a founding's file and the sidecars SQLite made for it. Best effort: none may exist.
fn remove_founding_leftovers(side: &Path) {
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let mut name = side
            .file_name()
            .map(std::ffi::OsString::from)
            .unwrap_or_default();
        name.push(suffix);
        let _ = std::fs::remove_file(side.with_file_name(name));
    }
}

/// **No plaintext copy of the vault stays beside it** (#1191, V16). An earlier build wrote a
/// gzipped copy of the whole file, `locker_key` included, to `snapshots/` before a migration and
/// never read or deleted it. Its files are removed at open, and the directory with them when
/// nothing else is in it.
fn remove_pre_migration_copies(path: &Path) {
    let Some(dir) = path.parent().map(|parent| parent.join("snapshots")) else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("snapshot-") && name.ends_with(".db.gz")
            || name.starts_with("snapshot.building")
        {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    let _ = std::fs::remove_dir(&dir);
}

/// Flush a file's contents and length to the disk.
fn sync_file(path: &Path) -> Result<()> {
    std::fs::File::open(path)?.sync_all()?;
    Ok(())
}

/// Flush the directory entry of `path`, so a rename into it survives a power cut.
fn sync_directory(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        let parent = path.parent().filter(|p| !p.as_os_str().is_empty());
        std::fs::File::open(parent.unwrap_or_else(|| Path::new(".")))?.sync_all()?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

/// **THE QUICK CHECK** (#1191, V21): SQLite's `PRAGMA quick_check` reads every page of the file
/// once and every index entry against its row's existence, and answers `ok` or a list of what is
/// wrong. A vault that fails it is [`VaultError::Damaged`]: it is not written to, not backed up
/// and not restored over a good copy. The check costs one sequential read of the file.
pub(crate) fn quick_check(connection: &Connection) -> Result<()> {
    let mut statement = connection
        .prepare("PRAGMA quick_check")
        .map_err(VaultError::from)?;
    let mut rows = statement.query([]).map_err(VaultError::from)?;
    let mut found = Vec::new();
    while let Some(row) = rows.next().map_err(VaultError::from)? {
        let line: String = row.get(0).map_err(VaultError::from)?;
        if line != "ok" {
            found.push(line);
            if found.len() == 3 {
                break;
            }
        }
    }
    if found.is_empty() {
        Ok(())
    } else {
        Err(VaultError::Damaged {
            detail: found.join("; "),
        })
    }
}

/// How a vault file was opened.
pub struct Vault {
    connection: Held,
    path: PathBuf,
    schema_version: i64,
    clock: Box<dyn Clock>,
    ids: Box<dyn Ids>,
    /// Commit-guard depth. A nested `commit` is a deliberate no-op: the inner
    /// body runs inside the outer pair, and one pair is one transaction.
    pub(crate) depth: Cell<u32>,
    pub(crate) pending: RefCell<crate::log::guard::Pending>,
    /// Read depth, so a nested read does not clear `query_only` early.
    read_depth: Cell<u32>,
    /// The index's words, read through a cache that checks itself against the
    /// table ([`crate::words`]).
    words: crate::words::Words,
    /// The statements of the page reads since [`Vault::tap_pages`], while a test
    /// is asking what they plan to do ([`crate::plans`]); `None` otherwise, which
    /// is every run that is not a plan test.
    pub(crate) page_tap: RefCell<Option<Vec<crate::plans::TappedPage>>>,
    /// THE LOCAL CONTENT STORE, where bytes that are not text go.
    ///
    /// `core_content_item.content_uri` is `blob:blake3-<hex>` for anything
    /// binary, and the bytes themselves live here — a vault file is rows, and
    /// a photograph in a row is a photograph in the file. See
    /// [`Vault::with_blobs`].
    blobs: Option<Box<dyn crate::bytes::BlobStore + Send + Sync>>,
    /// The content store's directory, listed once for the whole of a sweep of unclaimed files
    /// ([`Vault::sweep_unclaimed_files`]): the batches of a pass resume from it by name, and it
    /// is dropped when the pass ends, so no batch lists the library again.
    pub(crate) sweep_listing: RefCell<Option<Vec<String>>>,
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
    ///
    /// **Founding is atomic** (#1191, V17). The file is made beside its final name
    /// (`<name>.founding`), run through the whole ladder, checkpointed into one file and
    /// closed, flushed to disk, and only then renamed to its name, the directory flushed. A
    /// process killed at any point leaves either no vault at the path (and a leftover the next
    /// founding or open removes) or a complete one; there is no half-founded file that can be
    /// neither created over nor opened.
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
        let side = founding_path(&path);
        let _founding = Founding::begin(&path);
        remove_founding_leftovers(&side);
        // A founding that fails (the disk is full, say) leaves no side file behind; one that is
        // killed leaves it for the next founding or open to remove.
        let laid = (|| -> Result<()> {
            {
                let connection = Connection::open(&side)?;
                // THE HEADER PRAGMAS, AND ONLY HERE. `page_size` and `auto_vacuum` are
                // both recorded in the file header and both are silently ignored once a
                // page exists — and `journal_mode = wal` writes one. Founding is the
                // only moment either can be stated, which is why they are not in
                // [`Self::apply_pragmas`] with the rest: a pragma that can only be set
                // once must not sit in a function every open calls, where its failure
                // to take would look like success.
                connection.pragma_update(None, "page_size", PAGE_SIZE)?;
                // NO AUTO-VACUUM, AND `VACUUM` NEVER RUNS (#1029 §1, #1080). A vacuum
                // renumbers pages, and a backup snapshot is the file cut into 64 KiB
                // ranges named by their bytes: every range would read as changed, no
                // name would match one the gateway holds, and the next backup would be
                // a full copy of the vault. The space a vacuum reclaims is worth less
                // than that.
                connection.pragma_update(None, "auto_vacuum", "NONE")?;
                Self::apply_pragmas(&connection)?;
                connection.pragma_update(None, "application_id", APPLICATION_ID)?;
                // OFF for the ladder: the baseline's tables point at each other (the
                // vault row at its owner, a kind row at its entity), SQLite resolves a
                // foreign key's target lazily, and the seeds are written in the order
                // that reads best rather than the order that satisfies a check.
                connection.pragma_update(None, "foreign_keys", "OFF")?;
                crate::migrations::run_from(&connection, 0)?;
                crate::stage::reached(crate::stage::Stage::FoundingLaidDown)?;
                // Everything in the one file: no `-wal` is left to rename away from it.
                connection.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
                connection
                    .close()
                    .map_err(|(_, error)| VaultError::from(error))?;
            }
            crate::stage::reached(crate::stage::Stage::FoundingCheckpointed)?;
            sync_file(&side)?;
            crate::stage::reached(crate::stage::Stage::FoundingFlushed)?;
            std::fs::rename(&side, &path)?;
            crate::stage::reached(crate::stage::Stage::FoundingRenamed)?;
            sync_directory(&path)?;
            Ok(())
        })();
        if let Err(error) = laid {
            if !path.exists() {
                remove_founding_leftovers(&side);
            }
            return Err(error);
        }
        let connection = Connection::open(&path)?;
        Self::apply_pragmas(&connection)?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        Self::wrap(connection, path, head_version(), clock, ids)
    }

    /// Open an existing v1 vault, migrating it forward if it is behind.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        // See `create`: a seeded default restarts its sequence on every open.
        Self::open_with(path, Box::new(SystemClock), Box::new(ClockIds::system()))
    }

    /// Open against an injected clock and id source.
    ///
    /// A founding that was killed leaves a `.founding` file beside the path; it is not a vault
    /// and is removed here. A file that SQLite calls malformed, or that fails the quick check,
    /// is [`VaultError::Damaged`]: it is not opened.
    pub fn open_with(
        path: impl AsRef<Path>,
        clock: Box<dyn Clock>,
        ids: Box<dyn Ids>,
    ) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        if !Founding::is_under_way(&path) {
            remove_founding_leftovers(&founding_path(&path));
        }
        if !path.exists() {
            return Err(VaultError::Missing { path });
        }
        remove_pre_migration_copies(&path);
        let connection = Connection::open(&path)?;

        // The tag first: `user_version` on a file that is not ours means
        // nothing, and "your file is at version 42" is a worse message than
        // "this is not a Centraid vault".
        let application_id: i64 = connection
            .query_row("PRAGMA application_id", [], |row| row.get(0))
            .map_err(VaultError::from)?;
        if application_id == EARLIER_APPLICATION_ID {
            return Err(VaultError::EarlierModel { path });
        }
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
        quick_check(&connection)?;

        if found < head_version() {
            // A MIGRATION RUNS ON THE OPENED CONNECTION AND THEN IS WRAPPED ONCE (#1191, V15, V16).
            // The file is the vault's only copy: there is no plaintext safety copy beside it (it held
            // every Locker table and was never used), and the ladder runs each rung in a
            // transaction of its own. Wrapping after the ladder installs the history and census
            // triggers against the migrated schema, and keeps the injected clock and id source and
            // the foreign keys the connection was opened with.
            connection.pragma_update(None, "foreign_keys", "OFF")?;
            let reached = crate::migrations::run_from(&connection, found)?;
            let broken = connection
                .prepare("PRAGMA foreign_key_check")?
                .query([])?
                .next()?
                .is_some();
            if broken {
                return Err(VaultError::Invariant {
                    context: "a migration left rows that break a foreign key".to_owned(),
                });
            }
            connection.pragma_update(None, "foreign_keys", "ON")?;
            let vault = Self::wrap(connection, path, reached, clock, ids)?;
            vault.check_schema()?;
            return Ok(vault);
        }

        let vault = Self::wrap(connection, path, found, clock, ids)?;
        vault.check_schema()?;
        Ok(vault)
    }

    /// THE FILE'S TABLES ARE THIS BUILD'S ([`crate::format`], #1146). A file at the head of the
    /// ladder whose schema digest is not [`SCHEMA_DIGEST`] was changed by something other than
    /// this build, and is refused rather than read.
    fn check_schema(&self) -> Result<()> {
        let found = crate::format::schema_digest(&self.connection())?;
        if found == SCHEMA_DIGEST {
            return Ok(());
        }
        Err(VaultError::SchemaMismatch {
            path: self.path.clone(),
            found,
            expected: SCHEMA_DIGEST.to_owned(),
        })
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
    /// - **`journal_mode = WAL`** — readers and the one writer do not block
    ///   each other, and the snapshot's online backup copies a consistent file
    ///   while the member keeps writing.
    /// - **`synchronous = FULL`, explicitly (F11).** Under `NORMAL` a commit is
    ///   acknowledged before its WAL frames reach the disk, so a crash between
    ///   the acknowledgement and the fsync loses a commit the member was told
    ///   had landed — and a snapshot taken in that window is a backup ahead of
    ///   the device it backs up. There is no correct recovery from that, so it
    ///   is not allowed to happen.
    /// - **Checkpoints are SQLite's own** (#1080). `wal_autocheckpoint` is left
    ///   at its default and a last close checkpoints the WAL away. The capture
    ///   that once read the WAL frame by frame — and so had to own every
    ///   checkpoint and keep the `-wal` across a close — is gone: a backup is
    ///   the online backup API's page-for-page copy of the file, which reads
    ///   through the WAL whatever its state (`.claude/skills/stack/sqlite/centraid.md`).
    /// - **`journal_size_limit`** — see [`JOURNAL_SIZE_LIMIT`].
    /// - **`secure_delete = ON`** (#1191, owner ruling 4). "Deleted for ever" has to erase from
    ///   this phone: SQLite overwrites the content of a deleted row with zeros as it frees the
    ///   cell, so the text of a purged item is not left in the free pages of the file or of its
    ///   WAL. (The search index keeps words in segments a delete only marks; a purge merges them,
    ///   [`crate::index::compact`].) It dirties a few more ranges for the next snapshot to
    ///   upload; that is the price of the promise.
    ///
    /// `page_size` and `auto_vacuum` are NOT here: both are header properties
    /// that only take on an empty file, so they are stated once in
    /// [`Self::create_with`] where the statement can actually succeed.
    fn apply_pragmas(connection: &Connection) -> Result<()> {
        // DEFENSIVE: `sqlite_dbpage`, which the snapshot reads pages through (#1191 B11), is writable
        // by design, and a write to it skips every check SQLite makes. This is the one connection
        // that writes the vault, so a raw page write through it is refused at the engine.
        connection.set_db_config(rusqlite::config::DbConfig::SQLITE_DBCONFIG_DEFENSIVE, true)?;
        connection.pragma_update(None, "journal_mode", "wal")?;
        connection.pragma_update(None, "synchronous", "FULL")?;
        connection.pragma_update(None, "secure_delete", "ON")?;
        connection.pragma_update(None, "journal_size_limit", JOURNAL_SIZE_LIMIT)?;
        // A DEVICE THAT CAN LIE ABOUT A FLUSH (V18): on Apple targets a plain `fsync` does not
        // reach the platter, `F_FULLFSYNC` does, and SQLite asks for it only when told to.
        #[cfg(target_vendor = "apple")]
        {
            connection.pragma_update(None, "fullfsync", "ON")?;
            connection.pragma_update(None, "checkpoint_fullfsync", "ON")?;
        }
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
        // **The one connection is SQLite's single writer** (D-1020-D2-9): reads
        // are `query_only` toggled on this same connection ([`Self::read`])
        // rather than served from a pool, and nothing else in the process
        // opens the file for writing. (The snapshot plane opens it READ-ONLY, on a reader of its
        // own, to copy it without holding this one: `backup::snapshot::copy_from`.)
        Self::apply_pragmas(&connection)?;
        crate::log::guard::install_without_rowid_census(&connection)?;
        crate::history::install(&connection)?;
        Ok(Self {
            connection: Held(RefCell::new(Some(connection))),
            path,
            schema_version,
            clock,
            ids,
            depth: Cell::new(0),
            pending: RefCell::default(),
            read_depth: Cell::new(0),
            words: crate::words::Words::default(),
            page_tap: RefCell::new(None),
            blobs: None,
            sweep_listing: RefCell::new(None),
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
    /// opener knows the layout it is opening into. Every opener hands over the
    /// device's ONE content store for this vault (D-1025-S3-1) —
    /// `<vault>.bytes`, behind `centraid_blobs::ContentBytes` — so a photograph
    /// this door spills is a photograph every read of this vault can locate,
    /// and an original the operating system's library holds is located there
    /// through the same door (#1080 ruling 6).
    #[must_use]
    pub fn with_blobs(mut self, blobs: Box<dyn crate::bytes::BlobStore + Send + Sync>) -> Self {
        self.blobs = Some(blobs);
        self
    }

    /// The local content store, if one was attached.
    #[must_use]
    pub fn blobs(&self) -> Option<&(dyn crate::bytes::BlobStore + Send + Sync)> {
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
        let scope = self.enter_read()?;
        let outcome = body(&self.connection.get());
        scope.leave()?;
        outcome
    }

    /// Open a read: `query_only` goes on for the outermost one. Inside a commit the
    /// connection is deliberately writable and turning `query_only` on would break the
    /// enclosing commit's writes, so there it is a scope that does nothing.
    ///
    /// The scope ends in [`ReadScope::leave`], which reports a failure to clear the pragma;
    /// dropping it any other way (an early return, a panic) clears it on a best-effort basis.
    pub(crate) fn enter_read(&self) -> Result<ReadScope<'_>> {
        if self.depth.get() > 0 {
            return Ok(ReadScope {
                vault: self,
                outermost: false,
                open: false,
            });
        }
        let outermost = self.read_depth.get() == 0;
        if outermost {
            self.connection
                .get()
                .pragma_update(None, "query_only", "ON")?;
        }
        self.read_depth.set(self.read_depth.get() + 1);
        Ok(ReadScope {
            vault: self,
            outermost,
            open: true,
        })
    }

    /// The words the index holds, as a list kept in memory and checked against
    /// the table on every use. Read it inside [`Self::read`]:
    /// `vault.read(|connection| Ok(vault.words().current(connection)?.to_vec()))`.
    #[must_use]
    pub const fn words(&self) -> &crate::words::Words {
        &self.words
    }

    /// The connection, for this crate's own internals only.
    ///
    /// Crate-private on purpose: the snapshot builder needs `VACUUM INTO`,
    /// which `query_only` forbids and which is not a write to the live file,
    /// and the log store needs to insert its rows inside the guard's
    /// transaction. Neither is a caller-facing write path.
    ///
    /// A shared borrow of the one connection, so keep it short: a hook goes in or out only when
    /// nothing holds one ([`Held::with_exclusive`]).
    pub(crate) fn connection(&self) -> Ref<'_, Connection> {
        self.connection.get()
    }

    /// The one place the connection is borrowed exclusively: to put a hook in or take it out
    /// (rusqlite 0.41 takes those on `&mut Connection`). Hold no [`Self::connection`] borrow
    /// across it; if one is held this is an error, not a race.
    pub(crate) fn with_exclusive_connection<T>(
        &self,
        body: impl FnOnce(&mut Connection) -> rusqlite::Result<T>,
    ) -> Result<T> {
        self.connection.with_exclusive(body)
    }

    /// Close the file, surfacing a failure to close rather than swallowing it.
    pub fn close(self) -> Result<()> {
        self.connection.close().map_err(VaultError::Sqlite)
    }

    /// CHECKPOINT AND CLOSE, so the `.db` **alone** is the whole vault, and a
    /// checkpoint that fails is an error rather than a `-wal` quietly left
    /// behind.
    ///
    /// A last [`Self::close`] checkpoints too (#1080 returned the vault to
    /// SQLite's checkpoint default), but it cannot say so when it fails, and a
    /// process whose ARTIFACT IS THE FILE needs to know: trap #2 of
    /// `.claude/skills/stack/sqlite/centraid.md` — "copying only `vault.db` without its
    /// `-wal` and `-shm`" — is `seed-demo-vault` leaving rows in a `-wal` that
    /// `mobile/scripts/demo-vault.sh` then dropped. So the log is checkpointed
    /// `TRUNCATE` here, which folds every frame into the database, and the
    /// connection is closed after it.
    pub fn finish(self) -> Result<()> {
        // The statistics first: the checkpoint folds what `PRAGMA optimize` wrote
        // into the file, so the `.db` alone carries them.
        self.connection.optimize();
        self.connection
            .get()
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
                row.get::<_, i64>(0)
            })
            .map_err(|error| VaultError::from_sqlite("checkpointing the log to finish", error))?;
        self.close()
    }
}

/// One open read: the `query_only` pragma and the read depth it counts, undone when it ends.
pub(crate) struct ReadScope<'a> {
    vault: &'a Vault,
    outermost: bool,
    open: bool,
}

impl ReadScope<'_> {
    /// End the read, clearing `query_only` if this was the outermost one.
    pub(crate) fn leave(mut self) -> Result<()> {
        self.close()
    }

    fn close(&mut self) -> Result<()> {
        if !self.open {
            return Ok(());
        }
        self.open = false;
        let vault = self.vault;
        vault.read_depth.set(vault.read_depth.get() - 1);
        if self.outermost {
            vault
                .connection
                .get()
                .pragma_update(None, "query_only", "OFF")?;
        }
        Ok(())
    }
}

impl Drop for ReadScope<'_> {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

/// The vault's one connection, which learns the file's statistics before it goes.
///
/// `PRAGMA optimize` re-analyses only the tables whose shape changed enough
/// since they were last analysed, so a connection that runs it when it closes
/// leaves the planner what it needs to prefer an index over a scan without any
/// caller having to remember. It is the vault that closes a file, whether by
/// [`Vault::close`], [`Vault::finish`] or by being dropped, and every way goes
/// through here.
///
/// **It is a `RefCell` because rusqlite 0.41 made `update_hook` and `authorizer` take
/// `&mut Connection`** (a hook can re-enter the connection, so installing one claims it
/// exclusively). The vault's API is `&self` and its readers hold `&Connection` for the length
/// of a body, so the exclusive claim is taken only where a hook goes in or out
/// ([`Self::with_exclusive`]), and it is a runtime check: it fails with an error, never a
/// race, if a reader is still holding the connection. Everything else borrows it shared
/// ([`Self::get`]).
struct Held(RefCell<Option<Connection>>);

impl Held {
    /// Borrow the connection for reading and writing through its `&self` API.
    fn get(&self) -> Ref<'_, Connection> {
        Ref::map(self.0.borrow(), |slot| {
            // `None` only after `close` took it, and `close` consumed the holder.
            slot.as_ref()
                .expect("the connection is held until the vault closes")
        })
    }

    /// Borrow the connection exclusively, for the one call that needs `&mut`.
    ///
    /// Callers install or remove a hook and nothing else, and must hold no [`Self::get`]
    /// borrow while they do.
    fn with_exclusive<T>(
        &self,
        body: impl FnOnce(&mut Connection) -> rusqlite::Result<T>,
    ) -> Result<T> {
        let mut slot = self.0.try_borrow_mut().map_err(|_| VaultError::Invariant {
            context: "a hook was changed while the connection was in use".to_owned(),
        })?;
        let connection = slot
            .as_mut()
            .expect("the connection is held until the vault closes");
        Ok(body(connection)?)
    }

    /// Learn the statistics. **Its failure is ignored, on purpose.** It is
    /// advisory (a plan without statistics is a slower plan, never a wrong
    /// answer), it runs on the way out of a file that may already be failing (a
    /// full disk, a connection dropped by a panic mid-commit), and the one thing
    /// a close must not do is fail for the sake of an optimisation.
    fn optimize(&self) {
        if let Ok(slot) = self.0.try_borrow()
            && let Some(connection) = slot.as_ref()
        {
            crate::index::optimize(connection);
        }
    }

    fn close(mut self) -> std::result::Result<(), rusqlite::Error> {
        self.optimize();
        match self.0.get_mut().take() {
            Some(connection) => connection.close().map_err(|(_, error)| error),
            None => Ok(()),
        }
    }
}

impl Drop for Held {
    fn drop(&mut self) {
        self.optimize();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock::{FixedClock, SeededIds};

    fn scratch() -> PathBuf {
        centraid_ontology::scratch::scratch_dir()
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
        // SQLite's own default (#1080): nothing reads the WAL frame by frame,
        // so nothing has to own its checkpoints.
        assert_eq!(
            pragma_int(&vault, "wal_autocheckpoint"),
            1000,
            "checkpoints are SQLite's own"
        );
        assert_eq!(pragma_int(&vault, "journal_size_limit"), JOURNAL_SIZE_LIMIT);
        assert_eq!(pragma_int(&vault, "page_size"), PAGE_SIZE);
        assert_eq!(pragma_int(&vault, "auto_vacuum"), 0, "auto_vacuum = NONE");
        // ON: a deleted row's content is zeroed as its cell is freed (#1191, V14).
        assert_eq!(pragma_int(&vault, "secure_delete"), 1, "secure_delete = ON");
        // On Apple targets a flush must reach the platter (V18). Not run on Linux CI: unverified
        // until a macOS or device run.
        #[cfg(target_vendor = "apple")]
        {
            assert_eq!(pragma_int(&vault, "fullfsync"), 1, "fullfsync");
            assert_eq!(
                pragma_int(&vault, "checkpoint_fullfsync"),
                1,
                "checkpoint_fullfsync"
            );
        }
        assert!(
            !vault
                .connection()
                .db_config(rusqlite::config::DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE)
                .expect("the db config reads"),
            "a last close checkpoints: nothing waits on the `-wal` any more"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A SECOND OPEN CHANGES NOTHING SILENTLY. Every connection comes through
    /// `wrap`, so every connection carries the same set — `synchronous = FULL`
    /// above all, which is a connection setting and not a header one — and
    /// the header pragmas survive because they are in the file.
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
        assert_eq!(pragma_int(&reopened, "wal_autocheckpoint"), 1000);
        assert_eq!(
            pragma_int(&reopened, "journal_size_limit"),
            JOURNAL_SIZE_LIMIT
        );
        assert_eq!(pragma_int(&reopened, "page_size"), PAGE_SIZE);
        assert_eq!(pragma_int(&reopened, "auto_vacuum"), 0);
        assert_eq!(pragma_int(&reopened, "secure_delete"), 1);
        assert!(
            !reopened
                .connection()
                .db_config(rusqlite::config::DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE)
                .expect("the db config reads")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// THE DURABILITY HALF, AND TRAP #2 (#1080). A last close folds the WAL
    /// into the file, so the `.db` alone carries every committed row — a copy
    /// of it without its sidecars is the whole vault, which is the copy
    /// `.claude/skills/stack/sqlite/centraid.md` records going wrong while closes left
    /// the `-wal` behind on purpose.
    #[test]
    fn a_last_close_folds_the_wal_into_the_file() {
        let dir = scratch();
        std::fs::create_dir_all(&dir).expect("the scratch dir is made");
        let path = dir.join("vault.db");
        let vault = Vault::create_with(
            &path,
            Box::new(FixedClock::frozen()),
            Box::new(SeededIds::new("test")),
        )
        .expect("a vault is founded");
        vault.found("Durable", "Owner").expect("founded");
        vault.close().expect("the last connection closes");

        let wal = dir.join("vault.db-wal");
        assert!(
            !wal.exists() || std::fs::metadata(&wal).expect("the wal stats").len() == 0,
            "a last close checkpoints the WAL away"
        );
        let copy = dir.join("copy");
        std::fs::create_dir_all(&copy).expect("the copy dir is made");
        std::fs::copy(&path, copy.join("vault.db")).expect("the file alone copies");
        let reopened = Vault::open(copy.join("vault.db")).expect("the copy opens");
        let name: String = reopened
            .read(|connection| {
                Ok(connection.query_row("SELECT name FROM vault", [], |row| row.get(0))?)
            })
            .expect("the vault row reads");
        assert_eq!(name, "Durable", "the `.db` alone carries the founding");
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
                .execute("UPDATE vault SET name = 'x'", [])
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

        // Session one: found the vault (one minted id — the self person) and close the file.
        let vault = Vault::create(&path).expect("a founded vault");
        vault.found("Test", "Test Owner").expect("it founds");
        vault.close().expect("it closes");

        // Session two: the same file, a fresh source of ids. A per-instance
        // counter would hand out the id founding already used for the self person.
        let vault = Vault::open(&path).expect("it reopens");
        let now = vault.clock().now_text();
        for label in ["after-reopen-1", "after-reopen-2"] {
            let id = vault.ids().next();
            vault
                .commit(|tx| {
                    tx.set_producer("test.reopen");
                    tx.insert_entity(&id, crate::model::Kind::Person, label, &now)?;
                    tx.connection()
                        .execute("INSERT INTO person (id) VALUES (?1)", [&id])?;
                    Ok(())
                })
                .unwrap_or_else(|error| {
                    panic!("the write `{label}` after a reopen was refused: {error}")
                });
        }

        // And the ids really are fresh rather than merely accepted.
        let parties: i64 = vault
            .read(|connection| {
                Ok(connection.query_row("SELECT count(*) FROM person", [], |row| row.get(0))?)
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

    /// A file BELOW the head (here the lowest rung, a tagged file with no tables) is migrated by
    /// `open_with`, and the vault that comes back keeps what it was opened with: foreign keys on,
    /// the injected clock and the injected ids (#1191, V15). And no copy of it is made: the
    /// directory holds the vault and its sidecars only (V16), and a `snapshots/` left by an
    /// earlier build is removed.
    #[test]
    fn a_migrated_vault_reopens_with_foreign_keys_its_clock_and_its_ids_and_leaves_no_copy() {
        let dir = scratch();
        std::fs::create_dir_all(&dir).expect("the scratch dir is made");
        let path = dir.join("vault.db");
        {
            let lower = Connection::open(&path).expect("a file");
            lower
                .pragma_update(None, "application_id", APPLICATION_ID)
                .expect("tagged");
            lower
                .pragma_update(None, "journal_mode", "wal")
                .expect("wal");
            let rung: i64 = lower
                .query_row("PRAGMA user_version", [], |row| row.get(0))
                .expect("a version");
            assert_eq!(rung, 0, "below the head");
        }
        // What an earlier build left beside a vault it migrated.
        let old = dir.join("snapshots");
        std::fs::create_dir_all(&old).expect("a directory");
        std::fs::write(
            old.join("snapshot-0123456789abcdef.db.gz"),
            b"a plaintext copy",
        )
        .expect("a copy");

        let clock = std::sync::Arc::new(FixedClock::at(1_800_000_000_000));
        let vault = Vault::open_with(
            &path,
            Box::new(std::sync::Arc::clone(&clock)),
            Box::new(SeededIds::new("rung")),
        )
        .expect("the lower file opens, migrated");
        assert_eq!(vault.schema_version(), head_version());
        assert_eq!(pragma_int(&vault, "foreign_keys"), 1, "foreign keys are on");
        // A write is stamped by the injected clock and the injected id source.
        let founded = vault.found("Home", "Ada").expect("founds");
        assert_eq!(
            founded.self_id,
            SeededIds::new("rung").next(),
            "the first id is the injected source's"
        );
        let stamped: String = vault
            .read(|connection| {
                Ok(connection.query_row("SELECT created_at FROM vault", [], |row| row.get(0))?)
            })
            .expect("a stamp");
        assert_eq!(
            stamped,
            clock.now_text(),
            "the injected clock stamped the write"
        );
        // Foreign keys do refuse: a person row naming no entity is not taken.
        let refused = vault.commit(|tx| {
            tx.connection()
                .execute("INSERT INTO person (id) VALUES ('nobody')", [])?;
            Ok(())
        });
        assert!(
            refused.is_err(),
            "foreign keys are enforced on the migrated vault"
        );
        vault.close().expect("it closes");

        let mut names: Vec<String> = std::fs::read_dir(&dir)
            .expect("the directory lists")
            .map(|entry| {
                entry
                    .expect("an entry")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        names.sort();
        assert!(
            names.iter().all(|name| name.starts_with("vault.db")),
            "no file other than the vault and its sidecars: {names:?}"
        );
        assert!(!old.exists(), "the earlier build's copies are gone");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A founding that was killed leaves its side file; the next open and the next founding
    /// remove it, and neither mistakes it for a vault.
    #[test]
    fn a_leftover_founding_is_removed_by_open_and_by_the_next_founding() {
        let dir = scratch();
        std::fs::create_dir_all(&dir).expect("the scratch dir is made");
        let path = dir.join("vault.db");
        let side = founding_path(&path);
        std::fs::write(&side, b"half a founding").expect("a leftover");
        assert!(matches!(
            Vault::open(&path),
            Err(VaultError::Missing { .. })
        ));
        assert!(!side.exists(), "open removed it");
        std::fs::write(&side, b"half a founding").expect("a leftover");
        Vault::create(&path)
            .expect("founds over it")
            .close()
            .expect("closes");
        assert!(!side.exists());
        assert!(Vault::open(&path).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A page of the file really damaged: `open` answers `Damaged` and does not open it.
    #[test]
    fn a_damaged_page_is_refused_at_open_as_damaged() {
        let dir = scratch();
        std::fs::create_dir_all(&dir).expect("the scratch dir is made");
        let path = dir.join("vault.db");
        let vault = Vault::create(&path).expect("founds");
        vault.found("Home", "Ada").expect("founds");
        vault.close().expect("closes");
        // Overwrite a page in the middle of the file (page 5 of a founded file is table content).
        let mut bytes = std::fs::read(&path).expect("reads");
        let page = usize::try_from(PAGE_SIZE).expect("a size");
        assert!(
            bytes.len() > 6 * page,
            "the founded file has pages to damage"
        );
        for byte in &mut bytes[4 * page..5 * page] {
            *byte = 0xA5;
        }
        std::fs::write(&path, bytes).expect("writes");
        match Vault::open(&path) {
            Err(VaultError::Damaged { .. }) => {}
            Err(other) => panic!("expected Damaged, got {other}"),
            Ok(_) => panic!("a damaged vault opened"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
