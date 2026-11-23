//! The vault's pages, read without a plaintext copy of the vault on disk
//! (#1191 B11; the pages are read on a pinned reader through `sqlite_dbpage`, see `.claude/skills/backup/phone.md`).
//!
//! A snapshot used to copy the vault with SQLite's online-backup API into a
//! scratch file and read that. This reads the pages themselves through
//! `sqlite_dbpage`, on a **pinned read-only connection**: a WAL read
//! transaction sees the file as it was when it began, however many commits land
//! after, so every page read is one moment of the vault, and nothing is written
//! anywhere. Memory is one 64 KiB range.
//!
//! ## THE PIN COVERS READING, HASHING AND SEALING, AND NEVER NETWORK I/O
//!
//! [`PinnedPages`] holds no store, no socket and no staging area. The caller reads a
//! range, hashes it, compares its name with the previous head's, seals it if it
//! changed, and drops the pin before it talks to a gateway. While the pin is open
//! the WAL cannot be checkpointed past its mark, so the `-wal` file grows by the
//! commits made meanwhile and is truncated by the first checkpoint after the pin
//! ends: the cost the online-backup copy paid, no more.
//!
//! ## WHAT THE TABLE DOES NOT DO
//!
//! `sqlite_dbpage` returns a page exactly as the file holds it and verifies
//! nothing, so [`PinnedPages::quick_check`] runs on the same pin after the last
//! range: a page that is damaged is found, and no head is signed over it.
//! `sqlite_dbpage` is writable by design; this connection is read-only, and the
//! vault's own writer sets `SQLITE_DBCONFIG_DEFENSIVE` so it cannot write it
//! either (`crate::file`).
//!
//! `db_hash` is the BLAKE3 over the pages in order. It is **not** the hash of an
//! online-backup copy: that copy bumps three counters on page 1 that the live
//! WAL file does not carry, and nothing may compare the two.

use std::collections::BTreeMap;
use std::path::Path;

use centraid_media::sealed::PlaintextHash;

use rusqlite::{Connection, OpenFlags};

use crate::backup::{Result, invariant};

/// A range: 64 KiB, a whole number of pages at any page size SQLite allows.
pub const RANGE_BYTES: u64 = 64 * 1024;

/// Why a pin was refused, as a type a caller can match on.
#[derive(Debug, thiserror::Error)]
pub enum PinError {
    /// The vault is not in WAL mode: a pin on a rollback journal would hold the writer out.
    #[error("the vault is not in WAL mode; a pinned read would hold the writer out")]
    NotWal,
    /// This build of SQLite was compiled without `SQLITE_ENABLE_DBPAGE_VTAB`.
    #[error("this build of SQLite cannot read pages (SQLITE_ENABLE_DBPAGE_VTAB)")]
    NoPageTable,
    /// The page size does not tile a 64 KiB range.
    #[error("the page size does not tile a 64 KiB range")]
    PageSize,
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
}

impl From<PinError> for crate::backup::PlaneError {
    fn from(error: PinError) -> Self {
        match error {
            PinError::Sqlite(error) => Self::from(error),
            other => invariant(other.to_string()),
        }
    }
}

thread_local! {
    static LIVE_PINS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Pins alive on this thread. A caller that is about to talk to a gateway asserts it is zero:
/// the pin never spans network I/O.
#[must_use]
pub fn live_pins() -> usize {
    LIVE_PINS.with(std::cell::Cell::get)
}

/// One moment of a vault, readable page by page until dropped.
#[derive(Debug)]
pub struct PinnedPages {
    connection: Connection,
    page_size: u64,
    page_count: u64,
    buffer: Vec<u8>,
    /// Statements run to read pages: one per range, counted for tests.
    reads: u64,
}

impl Drop for PinnedPages {
    fn drop(&mut self) {
        LIVE_PINS.with(|live| live.set(live.get().saturating_sub(1)));
    }
}

impl PinnedPages {
    /// Open `path` read-only and pin one read transaction.
    ///
    /// # Errors
    /// [`PinError::NotWal`], [`PinError::NoPageTable`] for a build without
    /// `SQLITE_ENABLE_DBPAGE_VTAB`, or SQLite's refusal.
    pub fn begin(path: &Path) -> std::result::Result<Self, PinError> {
        let connection = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        // R5: no connection to the vault file checkpoints on its own. (This one cannot write.)
        connection.pragma_update(None, "wal_autocheckpoint", 0)?;
        let journal: String = connection.query_row("PRAGMA journal_mode", [], |row| row.get(0))?;
        if !journal.eq_ignore_ascii_case("wal") {
            return Err(PinError::NotWal);
        }
        connection.execute_batch("BEGIN")?;
        // The first read is what takes the snapshot.
        connection.query_row("SELECT count(*) FROM sqlite_schema", [], |row| {
            row.get::<_, i64>(0)
        })?;
        let page_size = u64::try_from(
            connection.query_row("PRAGMA page_size", [], |row| row.get::<_, i64>(0))?,
        )
        .unwrap_or(0);
        let page_count = u64::try_from(
            connection.query_row("PRAGMA page_count", [], |row| row.get::<_, i64>(0))?,
        )
        .unwrap_or(0);
        if page_size == 0 || !RANGE_BYTES.is_multiple_of(page_size) {
            return Err(PinError::PageSize);
        }
        // Prove the table is there now, with a typed refusal, not later with a sqlite "no such table".
        connection
            .query_row(
                "SELECT count(*) FROM sqlite_dbpage WHERE pgno = 1",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|_| PinError::NoPageTable)?;
        LIVE_PINS.with(|live| live.set(live.get() + 1));
        Ok(Self {
            connection,
            page_size,
            page_count,
            buffer: vec![0; usize::try_from(RANGE_BYTES).unwrap_or(usize::MAX)],
            reads: 0,
        })
    }

    /// The page size in bytes.
    #[must_use]
    pub const fn page_size(&self) -> u64 {
        self.page_size
    }

    /// Pages in the vault at the pin.
    #[must_use]
    pub const fn page_count(&self) -> u64 {
        self.page_count
    }

    /// The vault's length at the pin.
    #[must_use]
    pub const fn len(&self) -> u64 {
        self.page_size * self.page_count
    }

    /// Whether the vault has no pages.
    #[must_use]
    pub const fn is_empty(&self) -> bool {
        self.page_count == 0
    }

    /// How many ranges the vault tiles into.
    #[must_use]
    pub const fn range_count(&self) -> u64 {
        self.len().div_ceil(RANGE_BYTES)
    }

    /// Statements run to read pages so far.
    #[must_use]
    pub const fn reads(&self) -> u64 {
        self.reads
    }

    /// Range `index`'s bytes: 64 KiB, or the short last range. Reuses one
    /// buffer, so the slice is valid until the next call.
    ///
    /// # Errors
    /// An index past the last range, a page the table did not return, or
    /// SQLite's refusal.
    pub fn range(&mut self, index: u64) -> Result<&[u8]> {
        if index >= self.range_count() {
            return Err(invariant("a range past the end of the vault"));
        }
        let pages_per_range = RANGE_BYTES / self.page_size;
        let first = index * pages_per_range + 1;
        let last = (first + pages_per_range - 1).min(self.page_count);
        let page = usize::try_from(self.page_size).unwrap_or(usize::MAX);
        let mut statement = self.connection.prepare_cached(
            "SELECT pgno, data FROM sqlite_dbpage WHERE pgno BETWEEN ?1 AND ?2 ORDER BY pgno",
        )?;
        let mut rows = statement.query([
            i64::try_from(first).unwrap_or(0),
            i64::try_from(last).unwrap_or(0),
        ])?;
        let mut expected = first;
        while let Some(row) = rows.next()? {
            let pgno = u64::try_from(row.get::<_, i64>(0)?).unwrap_or(0);
            let data = row
                .get_ref(1)?
                .as_blob()
                .map_err(|_| invariant("a page came back as something other than bytes"))?;
            if pgno != expected || data.len() != page {
                return Err(invariant("a page read did not return the page asked for"));
            }
            let at = usize::try_from(pgno - first).unwrap_or(usize::MAX) * page;
            self.buffer[at..at + page].copy_from_slice(data);
            expected += 1;
        }
        if expected != last + 1 {
            return Err(invariant(
                "the table returned fewer pages than the vault has",
            ));
        }
        self.reads += 1;
        let len = usize::try_from((last - first + 1) * self.page_size).unwrap_or(0);
        Ok(&self.buffer[..len])
    }

    /// BLAKE3 over every page in order: the manifest's `db_hash`. Reads the
    /// vault once; `each` sees every range as it goes by, so a caller can name
    /// ranges in the same pass.
    ///
    /// # Errors
    /// What [`Self::range`] refuses, or `each`'s.
    pub fn hash_with(
        &mut self,
        each: &mut dyn FnMut(u64, &[u8]) -> Result<()>,
    ) -> Result<[u8; 32]> {
        let mut whole = blake3::Hasher::new();
        for index in 0..self.range_count() {
            let bytes = self.range(index)?;
            whole.update(bytes);
            each(index, bytes)?;
        }
        Ok(*whole.finalize().as_bytes())
    }

    /// `PRAGMA user_version` at the pin.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn user_version(&self) -> Result<i64> {
        Ok(self
            .connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))?)
    }

    /// `vault.writes` and `vault.written_at` at the pin; a file with no vault row has run nothing.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn history(&self) -> Result<(u64, Option<u64>)> {
        use rusqlite::OptionalExtension as _;
        let row: Option<(i64, Option<String>)> = self
            .connection
            .query_row("SELECT writes, written_at FROM vault", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .optional()?;
        let (writes, at) = row.unwrap_or((0, None));
        Ok((
            u64::try_from(writes).unwrap_or(0),
            at.as_deref()
                .and_then(crate::clock::parse_iso_ms)
                .and_then(|at| u64::try_from(at).ok()),
        ))
    }

    /// Rows per table a member has rows in, counted at the pin.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn census(&self) -> Result<BTreeMap<String, i64>> {
        Ok(census_of(&self.connection)?)
    }

    /// Every blob the vault claims at the pin, by hash: the content a snapshot's rows name.
    ///
    /// # Errors
    /// SQLite's refusal, or a row whose hash cannot be named.
    pub fn blobs(&self) -> Result<Vec<(PlaintextHash, u64)>> {
        let mut statement = self
            .connection
            .prepare("SELECT hash, size FROM blob ORDER BY hash")?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter()
            .map(|(hash, size)| {
                let h = PlaintextHash::from_hex(&hash).map_err(|_| {
                    invariant(format!("a content row's hash `{hash}` cannot be named"))
                })?;
                let len = u64::try_from(size)
                    .map_err(|_| invariant(format!("content `{hash}` has a negative size")))?;
                Ok((h, len))
            })
            .collect()
    }

    /// The page where `table`'s b-tree begins (1-based), for a test that must damage one page and
    /// know which; `None` for a table the vault does not have.
    ///
    /// # Errors
    /// SQLite's refusal.
    #[doc(hidden)]
    pub fn root_page(&self, table: &str) -> Result<Option<u64>> {
        use rusqlite::OptionalExtension as _;
        let root: Option<i64> = self
            .connection
            .query_row(
                "SELECT rootpage FROM sqlite_schema WHERE name = ?1",
                [table],
                |row| row.get(0),
            )
            .optional()?;
        Ok(root.and_then(|root| u64::try_from(root).ok()))
    }

    /// `PRAGMA quick_check` on the pin: every page is read through SQLite's own
    /// pager and a damaged one is refused.
    ///
    /// # Errors
    /// `VaultError::Damaged` when a page is damaged.
    pub fn quick_check(&self) -> Result<()> {
        Ok(crate::file::quick_check(&self.connection)?)
    }

    /// End the pin.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn end(self) -> Result<()> {
        self.connection.execute_batch("ROLLBACK")?;
        Ok(())
    }
}

/// Fold the WAL of the vault at `path` into its file, on a connection of its own, so a test can
/// damage a page of the file and be sure the damage is not shadowed by a newer copy in the WAL.
///
/// # Errors
/// SQLite's refusal.
#[doc(hidden)]
pub fn fold_wal(path: &Path) -> Result<()> {
    let connection = Connection::open(path)?;
    connection.pragma_update(None, "wal_autocheckpoint", 0)?;
    connection.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
        row.get::<_, i64>(0)
    })?;
    Ok(())
}

/// Rows per table: the census a root records and a restore checks. Every ordinary table, counted
/// on the connection it is given.
///
/// # Errors
/// SQLite's refusal.
pub fn census_of(connection: &Connection) -> rusqlite::Result<BTreeMap<String, i64>> {
    let tables: Vec<String> = {
        let mut statement = connection.prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
              ORDER BY name",
        )?;
        statement
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?
    };
    let mut census = BTreeMap::new();
    for table in tables {
        let quoted = table.replace('"', "\"\"");
        // A virtual table whose module is absent cannot be counted; it is absent from both ends.
        if let Ok(rows) =
            connection.query_row(&format!("SELECT count(*) FROM \"{quoted}\""), [], |row| {
                row.get::<_, i64>(0)
            })
        {
            census.insert(table, rows);
        }
    }
    Ok(census)
}
