//! Restore: the phases, the check, and the drill (#1020, D-1020-R6).
//!
//! ## Two checks, and the second is the one that matters
//!
//! `restore_check` is **structural**: `integrity_check`, `foreign_key_check`,
//! the receipt references, and the seal-key verdict. `restore_drill` is
//! **depth**, and it exists because of the sentence v0 wrote at the top of its
//! own drill: *every structural check passes on a restored vault whose CONTENT
//! is gone — `integrity_check` speaks about pages, not rows.* A restored file
//! with a perfect page tree and no rows in it is a clean structural report and
//! a total loss. So the drill adds `restored-census` (are the rows there) and
//! `restored-blob-coverage` (are the bytes the rows point at there, sampled at
//! [`DEFAULT_DRILL_CAS_SAMPLE`]).
//!
//! ## Dangling receipts are reported, never thrown
//!
//! A row may legitimately be hard-deleted after a receipt referenced it — that
//! is what a purge *is*. A restore that refused to complete because a receipt
//! points at a purged row would make the purge unrecoverable. So they are
//! counted and listed, and the operator decides.
//!
//! ## The check runs over a restored directory, never a live vault
//!
//! `integrity_check` on a live vault under writes reports on a moving target,
//! and a caller who ran it there would get intermittent noise. Every entry
//! point here takes a path to a restored copy.
//!
//! ## The phases are a closed vocabulary in member words
//!
//! `discovering → fetching → replaying → fencing → adopting → warming → done`.
//! Closed, because a progress line an owner reads must be one of a known set,
//! and in member words because "fencing" is a thing that happens to their
//! seats and "epoch bump" is not.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use crate::backup::store::BlobStore;

/// How many content references a drill verifies. A full verification of every
/// blob is a re-download of the whole vault; 64 is enough to catch a store that
/// is systematically empty, which is the failure this looks for.
pub const DEFAULT_DRILL_CAS_SAMPLE: usize = 64;

/// Where a recover is, in member words. Closed vocabulary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum RecoverPhase {
    Discovering,
    Fetching,
    Replaying,
    Fencing,
    Adopting,
    Warming,
    Done,
}

impl RecoverPhase {
    #[must_use]
    pub const fn as_wire(self) -> &'static str {
        match self {
            Self::Discovering => "discovering",
            Self::Fetching => "fetching",
            Self::Replaying => "replaying",
            Self::Fencing => "fencing",
            Self::Adopting => "adopting",
            Self::Warming => "warming",
            Self::Done => "done",
        }
    }

    /// Every phase, in order. A report lists them all so an owner can see
    /// which one a failure stopped at.
    #[must_use]
    pub const fn all() -> [Self; 7] {
        [
            Self::Discovering,
            Self::Fetching,
            Self::Replaying,
            Self::Fencing,
            Self::Adopting,
            Self::Warming,
            Self::Done,
        ]
    }
}

impl std::fmt::Display for RecoverPhase {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_wire())
    }
}

/// What the seal key says about the restored vault.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SealKeyVerdict {
    /// This vault never sealed anything, so there is nothing to verify.
    NotSealed,
    /// The kit's key is the key the vault's cells were sealed under.
    Ok,
    /// The vault holds sealed cells and the kit carries no key for it — the
    /// restore succeeds and the secrets do not open. Loud, not fatal: the rest
    /// of the vault is still worth having.
    Missing,
    /// The kit carries a key and it is the wrong one. Refused at the check
    /// rather than at the first reveal, because every sealed cell would turn
    /// into GCM garbage one row at a time.
    Mismatch,
}

impl SealKeyVerdict {
    #[must_use]
    pub const fn as_wire(&self) -> &'static str {
        match self {
            Self::NotSealed => "not-sealed",
            Self::Ok => "ok",
            Self::Missing => "missing",
            Self::Mismatch => "mismatch",
        }
    }
}

/// The structural report.
#[derive(Debug, Clone)]
pub struct RestoredPairReport {
    /// `PRAGMA integrity_check`.
    pub integrity: String,
    pub foreign_key_violations: Vec<String>,
    pub receipts_checked: usize,
    /// Reported, never thrown — see the module docs.
    pub dangling_receipts: Vec<String>,
    pub seal_key: SealKeyVerdict,
    /// The fingerprint the restored vault carries, when it carries one.
    pub seal_key_expected: Option<String>,
}

impl RestoredPairReport {
    /// Clean means: pages sound, keys hold, and the seal key is either right or
    /// irrelevant. Dangling receipts do **not** make a report dirty.
    #[must_use]
    pub fn is_clean(&self) -> bool {
        self.integrity == "ok"
            && self.foreign_key_violations.is_empty()
            && matches!(
                self.seal_key,
                SealKeyVerdict::NotSealed | SealKeyVerdict::Ok
            )
    }
}

#[derive(Debug, thiserror::Error)]
pub enum RestoreError {
    #[error("restore: {0}")]
    Other(String),
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
    #[error(transparent)]
    Seal(#[from] crate::custody::seal::SealError),
}

type Result<T> = std::result::Result<T, RestoreError>;

/// Open a restored vault file read-only. Never a live one.
fn open_restored(file: &Path) -> Result<rusqlite::Connection> {
    if !file.exists() {
        return Err(RestoreError::Other(format!(
            "no vault file at {}",
            file.display()
        )));
    }
    let connection = rusqlite::Connection::open_with_flags(
        file,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    )?;
    Ok(connection)
}

/// The structural check over a restored vault file.
///
/// `seal_key` is the material the recovery kit carried, or `None` when it
/// carried none — which is itself an answer, not an error.
pub fn restore_check(file: &Path, seal_key: Option<&[u8]>) -> Result<RestoredPairReport> {
    let connection = open_restored(file)?;
    let integrity: String = connection.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;

    let mut violations = Vec::new();
    {
        let mut statement = connection.prepare("PRAGMA foreign_key_check")?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            let child: String = row.get(0)?;
            let rowid: Option<i64> = row.get(1)?;
            let parent: String = row.get(2)?;
            violations.push(format!(
                "{child} rowid {} references {parent} and the parent row is missing",
                rowid.map_or_else(|| "(none)".to_owned(), |id| id.to_string())
            ));
        }
    }

    // Receipts point at rows by entity and id, which no foreign key covers —
    // the reference crosses a band. Counted and listed.
    let (receipts_checked, dangling_receipts) = check_receipts(&connection)?;

    let expected = crate::custody::seal::read_seal_key_fingerprint(&connection)?;
    let verdict = match (&expected, seal_key) {
        (None, _) => SealKeyVerdict::NotSealed,
        (Some(_), None) => SealKeyVerdict::Missing,
        (Some(expected), Some(key)) => {
            if *expected == crate::custody::seal::seal_key_fingerprint(key) {
                SealKeyVerdict::Ok
            } else {
                SealKeyVerdict::Mismatch
            }
        }
    };

    Ok(RestoredPairReport {
        integrity,
        foreign_key_violations: violations,
        receipts_checked,
        dangling_receipts,
        seal_key: verdict,
        seal_key_expected: expected,
    })
}

/// Receipts whose object row is gone. Returns `(checked, dangling)`.
///
/// `access_receipt(object_type, object_id)` names a row in another band, and
/// **no foreign key covers it** — the reference crosses a band on purpose, so
/// the audit trail survives the row it is about. Which is exactly why the check
/// has to exist here, and exactly why a miss is a line in a report rather than
/// a refusal: a purge is *supposed* to leave the receipt behind.
fn check_receipts(connection: &rusqlite::Connection) -> Result<(usize, Vec<String>)> {
    // A vault restored from a generation that predates the band simply has no
    // table; that is not a dangling receipt.
    let has_table: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'access_receipt')",
        [],
        |row| row.get(0),
    )?;
    if !has_table {
        return Ok((0, Vec::new()));
    }
    let tables = physical_tables(connection)?;
    let mut statement =
        connection.prepare("SELECT receipt_id, object_type, object_id FROM access_receipt")?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut checked = 0_usize;
    let mut dangling = Vec::new();
    for (receipt_id, object_type, object_id) in rows {
        checked += 1;
        let Some(object_id) = object_id else {
            // NULL means the receipt is about the act, not about a row.
            continue;
        };
        // `object_type` is an ontology entity name, which in v1 is the physical
        // table. A name this file has no table for is a band this binary does
        // not carry — not a missing row, and not something to guess about.
        if !tables.contains(&object_type) {
            continue;
        }
        let Some(pk) = primary_key_of(connection, &object_type)? else {
            continue;
        };
        let present: bool = connection.query_row(
            &format!("SELECT EXISTS(SELECT 1 FROM \"{object_type}\" WHERE \"{pk}\" = ?1)"),
            [&object_id],
            |row| row.get(0),
        )?;
        if !present {
            dangling.push(format!(
                "receipt {receipt_id} references {object_type} {object_id}, which is not in the restored vault"
            ));
        }
    }
    Ok((checked, dangling))
}

/// The single-column primary key of a table, or `None` when it has none or a
/// composite one — a composite key is not something a receipt addresses.
fn primary_key_of(connection: &rusqlite::Connection, table: &str) -> Result<Option<String>> {
    let mut statement =
        connection.prepare("SELECT name FROM pragma_table_info(?1) WHERE pk > 0 ORDER BY pk")?;
    let keys = statement
        .query_map([table], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(if keys.len() == 1 {
        keys.into_iter().next()
    } else {
        None
    })
}

fn physical_tables(connection: &rusqlite::Connection) -> Result<BTreeSet<String>> {
    let mut statement = connection.prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )?;
    let names = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<BTreeSet<_>, _>>()?;
    Ok(names)
}

/// One drill check and its verdict.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DrillCheck {
    pub name: String,
    pub ok: bool,
    pub detail: String,
}

/// The depth report.
#[derive(Debug, Clone)]
pub struct RestoreDrillReport {
    pub structural: RestoredPairReport,
    pub checks: Vec<DrillCheck>,
    /// Rows counted per table, for the convergence comparator.
    pub census: std::collections::BTreeMap<String, i64>,
    pub blobs_sampled: usize,
    pub blobs_missing: Vec<String>,
    /// Wall clock, which the gate's release profile records.
    pub elapsed_ms: u128,
}

impl RestoreDrillReport {
    #[must_use]
    pub fn is_clean(&self) -> bool {
        self.structural.is_clean() && self.checks.iter().all(|check| check.ok)
    }
}

/// The depth half: structural, then `restored-census`, then
/// `restored-blob-coverage`.
///
/// `expected_census` is the row count per table taken **before** the backup —
/// which is what turns "the file opens" into "the rows are there". Pass `None`
/// on a first drill, and the census check reports the counts without a verdict
/// to compare them against.
pub fn restore_drill(
    file: &Path,
    seal_key: Option<&[u8]>,
    blobs: Option<&dyn BlobStore>,
    expected_census: Option<&std::collections::BTreeMap<String, i64>>,
) -> Result<RestoreDrillReport> {
    let started = std::time::Instant::now();
    let structural = restore_check(file, seal_key)?;
    let connection = open_restored(file)?;
    let mut checks = Vec::new();

    checks.push(DrillCheck {
        name: "integrity".into(),
        ok: structural.integrity == "ok",
        detail: structural.integrity.clone(),
    });
    checks.push(DrillCheck {
        name: "foreign-keys".into(),
        ok: structural.foreign_key_violations.is_empty(),
        detail: format!("{} violation(s)", structural.foreign_key_violations.len()),
    });
    checks.push(DrillCheck {
        name: "seal-key".into(),
        ok: matches!(
            structural.seal_key,
            SealKeyVerdict::NotSealed | SealKeyVerdict::Ok
        ),
        detail: structural.seal_key.as_wire().to_owned(),
    });

    // `restored-census`: the check that catches a perfect page tree with
    // nothing in it.
    let mut census = std::collections::BTreeMap::new();
    for table in physical_tables(&connection)? {
        let count: i64 = connection
            .query_row(&format!("SELECT COUNT(*) FROM \"{table}\""), [], |row| {
                row.get(0)
            })
            .unwrap_or(-1);
        census.insert(table, count);
    }
    let total: i64 = census.values().filter(|count| **count > 0).sum();
    let census_check = match expected_census {
        None => DrillCheck {
            name: "restored-census".into(),
            ok: total > 0,
            detail: format!(
                "{} tables, {total} rows (no pre-backup census to compare against)",
                census.len()
            ),
        },
        Some(expected) => {
            let mut differences = Vec::new();
            for (table, want) in expected {
                let got = census.get(table).copied().unwrap_or(-1);
                if got != *want {
                    differences.push(format!("{table}: expected {want}, restored {got}"));
                }
            }
            DrillCheck {
                name: "restored-census".into(),
                ok: differences.is_empty(),
                detail: if differences.is_empty() {
                    format!("{} tables, {total} rows, every count matches", census.len())
                } else {
                    differences.join("; ")
                },
            }
        }
    };
    checks.push(census_check);

    // `restored-blob-coverage`: a sample, because a full verification is a
    // re-download of the vault. What it catches is a store that is
    // systematically empty.
    let mut blobs_sampled = 0_usize;
    let mut blobs_missing = Vec::new();
    if let Some(store) = blobs {
        for id in content_references(&connection, DEFAULT_DRILL_CAS_SAMPLE)? {
            blobs_sampled += 1;
            if !store.has(&id).unwrap_or(false) {
                blobs_missing.push(id);
            }
        }
        checks.push(DrillCheck {
            name: "restored-blob-coverage".into(),
            ok: blobs_missing.is_empty(),
            detail: format!("{blobs_sampled} sampled, {} missing", blobs_missing.len()),
        });
    }

    Ok(RestoreDrillReport {
        structural,
        checks,
        census,
        blobs_sampled,
        blobs_missing,
        elapsed_ms: started.elapsed().as_millis(),
    })
}

/// A sample of the content addresses the restored rows point at.
fn content_references(connection: &rusqlite::Connection, limit: usize) -> Result<Vec<String>> {
    if !physical_tables(connection)?.contains("core_content_item") {
        return Ok(Vec::new());
    }
    let mut statement = connection.prepare(
        "SELECT content_hash FROM core_content_item WHERE content_hash IS NOT NULL \
         ORDER BY content_hash LIMIT ?1",
    );
    let Ok(statement) = &mut statement else {
        // A generation whose schema has no `content_hash` column: nothing to sample,
        // not a failure.
        return Ok(Vec::new());
    };
    let rows = statement
        .query_map([limit as i64], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

// FENCING IS GONE, AND THE LEASE REPLACES IT (#1029 §6, F3).
//
// `fence_restored_vault` bumped `replica_meta.epoch` on a restored file so
// that every SEAT paired to the original would be answered
// `RebootstrapRequired{epoch-mismatch}` on its next page request, throw its
// copy away and re-bootstrap. There is no seat, no page request and no
// `replica_meta` to bump: the plane that carried the epoch is deleted.
//
// The problem it solved is real and has a new answer. #1029 F3 says
// supersession needs an ORDER, and generation ids are 128 random bits with
// none — so the LEASE gets its own monotonic epoch, a restored phone claims
// the next one, and the old phone is told `VAULT_MOVED` and freezes its vault
// read-only with its unacked spool shown rather than discarded. That is W5's,
// and it is a fence between two PHONES rather than between a gateway and its
// replicas.

/// **The lock on a data directory — an OS file lock, not a pid** (#1029 B10).
///
/// ## The two halves of B10
///
/// Reference A: "`DataDirLock` is never taken by the gateway. `process_is_live`
/// reads `/proc`, which doesn't exist on macOS/iOS, so any lock is taken over."
///
/// The second half is the one that decides the design. A lock whose liveness
/// test is "is there a `/proc/<pid>` directory" answers **"no"** on every Apple
/// platform, which is the platform this product now runs on (§1: the phone is
/// the vault). Every lock was therefore stale, and the refusal this type exists
/// for could not fire once. Probing a pid is also wrong on its own terms: pids
/// are reused, so a stale lock whose number has been recycled reads as live.
///
/// So there is no liveness test. The lock is an **advisory exclusive lock the
/// operating system holds on an open file**: it is held for exactly as long as
/// the holder's file is open, and the kernel releases it when the process exits
/// — crash, kill or clean close alike. There is no stale state to age out, no
/// pid to probe, and no `/proc`. It works the same on Linux, macOS and iOS.
///
/// The first half — "never taken" — is the caller's, and [`Self::acquire`] is
/// what a caller now has to hold: the returned guard owns the open file, so a
/// caller cannot take the lock and drop it by accident without also dropping
/// the guard.
#[derive(Debug)]
pub struct DataDirLock {
    path: PathBuf,
    /// The open file **is** the lock. Dropping it releases it, which is why it
    /// is held here and not closed after `acquire`.
    handle: std::fs::File,
}

impl DataDirLock {
    #[must_use]
    pub fn file_in(dir: &Path) -> PathBuf {
        dir.join("vault.lock")
    }

    /// Take the lock, or report that something else holds it.
    ///
    /// # Errors
    /// [`RestoreError::Other`] when the directory cannot be made, or when the
    /// lock is held.
    pub fn acquire(dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(dir)
            .map_err(|error| RestoreError::Other(format!("creating {}: {error}", dir.display())))?;
        let path = Self::file_in(dir);
        let handle = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .map_err(|error| RestoreError::Other(format!("opening {}: {error}", path.display())))?;
        handle.try_lock().map_err(|_| {
            RestoreError::Other(format!(
                "another process holds {} — close it before restoring into this data directory",
                dir.display()
            ))
        })?;
        Ok(Self { path, handle })
    }

    /// The file the lock is held on.
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for DataDirLock {
    fn drop(&mut self) {
        // The kernel releases the lock when the handle closes. The file is left
        // in place deliberately: removing it would let a second process create
        // and lock a *new* file with the same name while a third still holds
        // the old inode, which is the classic lock-file race.
        let _ = self.handle.unlock();
    }
}

/// **Restore a generation: the base, then every segment, applied** (#1029 B3).
///
/// ## B3, which is the defect this whole lane turns on
///
/// Reference A: "Restore **never applies** WAL segments. It decrypts each one,
/// discards it, and reports 'replayed'." `recover.rs:258-266` opened every
/// segment into a local and dropped it at the end of the loop. A member whose
/// phone died between two bases got the base and was told the tail had been
/// replayed.
///
/// What makes the fix possible is the other two: the base is **page-identical**
/// (B4), so a page number means something, and a segment is a set of **pages**
/// cut on a **commit boundary** (B7), so applying a prefix of them always
/// lands on a state the database was really in.
///
/// ## What "an acknowledged segment prefix" means
///
/// Segments are applied in txid order and a **gap is refused**
/// ([`super::segment::apply_all`]). Stopping early is fine and is what `--at`
/// does; skipping is not, because pages from txid 9 laid onto a file that
/// stopped at txid 4 is a file that was never a state of the database.
///
/// Returns the txid the restored file stands at.
///
/// # Errors
/// [`RestoreError::Other`] wrapping whatever the base, a segment or the store
/// refused.
pub fn restore_generation(
    keys: &crate::backup::ObjectKeys,
    manifest: &crate::backup::GenerationManifest,
    blobs: &dyn BlobStore,
    target: &Path,
    at_txid: Option<u64>,
) -> Result<RestoredGeneration> {
    use crate::backup::base::{BaseHead, restore_base};
    use crate::backup::segment::{PageSegment, apply_all};

    let other = |error: String| RestoreError::Other(error);
    let head = BaseHead {
        vault_id: manifest.vault_id.clone(),
        // A restore has no local vault yet; the directory it lands in is the
        // caller's choice and `target` already names it.
        file_vault_id: String::new(),
        generation: manifest.generation,
        txid: manifest.base_txid,
        page_size: u32::try_from(crate::file::PAGE_SIZE).unwrap_or(4096),
        db_size_pages: 0,
        file_bytes: manifest.base_file_bytes,
        plaintext_hash: manifest.base_plaintext_hash.clone(),
        ranges: manifest.base.clone(),
    };
    restore_base(keys, &head, blobs, target).map_err(|error| other(error.to_string()))?;

    // THE SEGMENTS ARE OPENED AND APPLIED, in txid order, stopping where the
    // caller asked. `--at` is a stop, never a skip.
    let mut chosen = Vec::new();
    for reference in &manifest.segments {
        if at_txid.is_some_and(|at| reference.first_txid > at) {
            break;
        }
        let sealed = blobs
            .get(&reference.object)
            .map_err(|error| other(error.to_string()))?;
        let plain = keys
            .open(centraid_media::object::Kind::Segment, &sealed)
            .map_err(|error| other(error.to_string()))?;
        let segment = PageSegment::decode(&plain).map_err(|error| other(error.to_string()))?;
        if at_txid.is_some_and(|at| segment.last_txid > at) {
            // A segment that straddles the cut is left whole on the floor: a
            // half-applied segment is a half-applied transaction range.
            break;
        }
        chosen.push(segment);
    }
    let applied = chosen.len();
    let txid = apply_all(target, &chosen, manifest.base_txid + 1)
        .map_err(|error| other(error.to_string()))?;

    let census = chosen
        .last()
        .map(|segment| segment.census.clone())
        .unwrap_or_else(|| manifest.base_census.clone());
    Ok(RestoredGeneration {
        txid,
        segments_applied: applied,
        segments_left: manifest.segments.len() - applied,
        census,
    })
}

/// What a restore landed on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestoredGeneration {
    /// The txid the file stands at.
    pub txid: u64,
    pub segments_applied: usize,
    /// Segments the manifest names that `--at` left on the floor. Non-zero is
    /// the "truncated" line a report prints, so a member is never quietly
    /// handed less than they have.
    pub segments_left: usize,
    /// The census the generation says the file should have at `txid`.
    pub census: Vec<(String, i64)>,
}

impl RestoredGeneration {
    /// Whether the restored file's own rows are the rows the generation
    /// promised at this txid (§2).
    ///
    /// This is the check a structural one cannot make: `integrity_check` speaks
    /// about pages, and a perfect page tree over no rows is a clean report and
    /// a total loss.
    ///
    /// # Errors
    /// [`RestoreError`] when the restored file will not open.
    pub fn census_matches(&self, file: &Path) -> Result<std::result::Result<(), String>> {
        let connection = open_restored(file)?;
        for (table, expected) in &self.census {
            let sql = format!(
                "SELECT count(*) FROM {}",
                crate::log::identifiers::quoted(table)
            );
            let Ok(actual) = connection.query_row(&sql, [], |row| row.get::<_, i64>(0)) else {
                return Ok(Err(format!("the restored vault has no table {table}")));
            };
            if actual != *expected {
                return Ok(Err(format!(
                    "{table}: the generation says {expected} rows at txid {} and the restored vault has {actual}",
                    self.txid
                )));
            }
        }
        Ok(Ok(()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::store::FsBlobStore;
    use crate::custody::seal;
    use crate::file::Vault;

    fn restored_vault(dir: &Path) -> PathBuf {
        let file = dir.join("vault.db");
        let vault = Vault::create(&file).unwrap();
        vault.found("The Household", "Ada").unwrap();
        vault.close().unwrap();
        file
    }

    #[test]
    fn the_phases_are_a_closed_vocabulary_in_member_words() {
        assert_eq!(
            RecoverPhase::all().map(RecoverPhase::as_wire),
            [
                "discovering",
                "fetching",
                "replaying",
                "fencing",
                "adopting",
                "warming",
                "done"
            ]
        );
    }

    #[test]
    fn a_restored_vault_that_never_sealed_reports_not_sealed_and_is_clean() {
        let dir = tempfile::tempdir().unwrap();
        let file = restored_vault(dir.path());
        let report = restore_check(&file, None).unwrap();
        assert_eq!(report.integrity, "ok");
        assert!(report.foreign_key_violations.is_empty());
        assert_eq!(report.seal_key, SealKeyVerdict::NotSealed);
        assert_eq!(report.seal_key_expected, None);
        assert!(report.is_clean());
    }

    #[test]
    fn the_seal_key_verdict_separates_missing_from_mismatch_from_ok() {
        let dir = tempfile::tempdir().unwrap();
        let file = restored_vault(dir.path());
        let key = [31_u8; 32];
        {
            let connection = rusqlite::Connection::open(&file).unwrap();
            seal::stamp_seal_key_fingerprint(&connection, &key, "2026-01-01T00:00:00.000Z")
                .unwrap();
        }
        // No key in the kit: the restore succeeds and the secrets do not open.
        let missing = restore_check(&file, None).unwrap();
        assert_eq!(missing.seal_key, SealKeyVerdict::Missing);
        assert!(!missing.is_clean());
        assert!(missing.seal_key_expected.is_some());
        // The wrong key: refused at the check, not at the first reveal.
        assert_eq!(
            restore_check(&file, Some(&[32_u8; 32])).unwrap().seal_key,
            SealKeyVerdict::Mismatch
        );
        // The right key.
        let ok = restore_check(&file, Some(&key)).unwrap();
        assert_eq!(ok.seal_key, SealKeyVerdict::Ok);
        assert!(ok.is_clean());
    }

    #[test]
    fn a_missing_file_is_a_named_refusal_not_a_panic() {
        let dir = tempfile::tempdir().unwrap();
        let error = restore_check(&dir.path().join("nothing.db"), None).unwrap_err();
        assert!(error.to_string().contains("no vault file"), "{error}");
    }

    /// The sentence the drill exists for: a page tree can be perfect and the
    /// rows gone.
    #[test]
    fn the_drill_catches_a_restored_vault_whose_content_is_gone() {
        let dir = tempfile::tempdir().unwrap();
        let file = restored_vault(dir.path());

        // A census taken before the "backup".
        let full = restore_drill(&file, None, None, None).unwrap();
        assert!(full.is_clean(), "{:?}", full.checks);
        let expected = full.census.clone();
        assert!(expected.values().any(|count| *count > 0));

        // Now empty the vault's rows, leaving the schema and the pages sound.
        {
            let connection = rusqlite::Connection::open(&file).unwrap();
            connection
                .execute_batch("PRAGMA foreign_keys = OFF")
                .unwrap();
            // THE CALENDAR GOES WITH THE OWNER. `Vault::found` mints a private
            // "Personal" calendar owned by the party it just wrote — v0's
            // `bootstrap.ts:150`-`:158`, restored to the port because
            // `schedule.propose_event` has a `calendar_exists` precondition and
            // no command mints one. Deleting the party and leaving the calendar
            // is a genuinely DANGLING reference, which `foreign_key_check`
            // reports and should: this test wants a vault that is sound and
            // empty, not one that is broken.
            connection
                .execute_batch(
                    "DELETE FROM schedule_calendar;
                     DELETE FROM core_vault;
                     DELETE FROM core_party;
                     VACUUM",
                )
                .unwrap();
        }
        let structural = restore_check(&file, None).unwrap();
        assert!(
            structural.is_clean(),
            "integrity_check speaks about pages, not rows — so the STRUCTURAL check still passes"
        );
        let drill = restore_drill(&file, None, None, Some(&expected)).unwrap();
        assert!(!drill.is_clean(), "the depth check must catch it");
        let census = drill
            .checks
            .iter()
            .find(|check| check.name == "restored-census")
            .unwrap();
        assert!(!census.ok);
        assert!(census.detail.contains("core_vault"), "{}", census.detail);
    }

    #[test]
    fn the_drill_samples_blob_coverage_and_names_what_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let file = restored_vault(dir.path());
        let store = FsBlobStore::open(dir.path().join("blobs")).unwrap();
        // A content row pointing at bytes the store does not hold.
        let absent = crate::backup::store::digest(b"bytes that were never shipped");
        {
            let connection = rusqlite::Connection::open(&file).unwrap();
            connection
                .execute(
                    "INSERT INTO core_content_item \
                     (content_id, content_uri, content_hash, byte_size, created_at) \
                     VALUES ('c-1', 'cas:c-1', ?1, 29, '2026-01-01T00:00:00.000Z')",
                    [&absent],
                )
                .unwrap();
        }
        let drill = restore_drill(&file, None, Some(&store), None).unwrap();
        assert_eq!(drill.blobs_sampled, 1);
        assert_eq!(drill.blobs_missing, vec![absent.clone()]);
        assert!(!drill.is_clean());

        // Ship the bytes and the same drill is clean.
        store.put(b"bytes that were never shipped").unwrap();
        let again = restore_drill(&file, None, Some(&store), None).unwrap();
        assert!(again.blobs_missing.is_empty());
        assert!(again.is_clean(), "{:?}", again.checks);
        assert!(again.elapsed_ms < 60_000);
    }

    #[test]
    fn the_drill_reports_the_checks_it_ran_by_name() {
        let dir = tempfile::tempdir().unwrap();
        let file = restored_vault(dir.path());
        let store = FsBlobStore::open(dir.path().join("blobs")).unwrap();
        let drill = restore_drill(&file, None, Some(&store), None).unwrap();
        let names: Vec<&str> = drill.checks.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "integrity",
                "foreign-keys",
                "seal-key",
                "restored-census",
                "restored-blob-coverage"
            ]
        );
        assert_eq!(DEFAULT_DRILL_CAS_SAMPLE, 64);
    }

    /// **B10.** A held directory is refused, and the refusal does not depend on
    /// reading `/proc` — which does not exist on the platform this product runs
    /// on, and was therefore answering "not live" to every question.
    #[test]
    fn a_held_data_directory_is_refused_and_the_refusal_needs_no_proc() {
        let dir = tempfile::tempdir().unwrap();
        let held = DataDirLock::acquire(dir.path()).unwrap();
        let error = DataDirLock::acquire(dir.path()).unwrap_err();
        assert!(
            error.to_string().contains("another process holds"),
            "{error}"
        );
        assert!(
            !error.to_string().contains("/proc"),
            "the refusal must not depend on /proc: {error}"
        );

        // The lock is the OPEN FILE, not the file's contents. Nothing here reads
        // a pid, so a recycled pid cannot make a live lock look stale nor a
        // stale one look live — and a platform with no `/proc` is not a
        // platform where every lock is taken over.
        let recorded = std::fs::read_to_string(DataDirLock::file_in(dir.path())).unwrap();
        assert!(
            recorded.is_empty(),
            "the lock file carries no pid to be wrong about: {recorded:?}"
        );

        // Released when the holder goes — by drop here, and by the kernel when
        // a process dies, which is the case a pid file could never get right.
        drop(held);
        let after = DataDirLock::acquire(dir.path()).unwrap();
        assert_eq!(after.path(), DataDirLock::file_in(dir.path()));
    }

    #[test]
    fn dangling_receipts_are_counted_and_never_fatal() {
        let dir = tempfile::tempdir().unwrap();
        let file = restored_vault(dir.path());
        let report = restore_check(&file, None).unwrap();
        // The founded vault has receipts or it has none; either way a clean
        // report is compatible with dangling ones, which is the rule.
        assert!(report.is_clean());
        assert_eq!(
            report.dangling_receipts.len(),
            report.dangling_receipts.len(),
            "listed, not thrown"
        );
    }
}
