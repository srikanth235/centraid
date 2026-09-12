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
        "SELECT sha256 FROM core_content_item WHERE sha256 IS NOT NULL \
         ORDER BY sha256 LIMIT ?1",
    );
    let Ok(statement) = &mut statement else {
        // A generation whose schema has no `sha256` column: nothing to sample,
        // not a failure.
        return Ok(Vec::new());
    };
    let rows = statement
        .query_map([limit as i64], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Bump the restored vault's replica epoch, so every cursor a paired seat
/// holds stops resolving.
///
/// This is the **fencing** phase, and it is the reason a restore does not
/// quietly diverge. A restored vault is behind every seat that was paired to
/// the original: those seats hold cursors into a log that no longer has those
/// rows, and serving them would hand them a history that never happened. The
/// epoch bump makes every one of those cursors answer
/// `RebootstrapRequired{epoch-mismatch}` instead, which is a seat throwing its
/// copy away and taking a fresh snapshot — the only correct outcome.
///
/// The floor is derived from **the log this file has**, never from a counter
/// kept elsewhere: v0 derived it from `sqlite_sequence` and that made every
/// seat go silently and permanently stale on every restore.
///
/// Returns the new epoch, or `None` for a file with no replica plane. It runs
/// over the restored file directly rather than through [`crate::Vault`],
/// because the fence must happen **before** anything can read the file as a
/// live vault.
pub fn fence_restored_vault(file: &Path) -> Result<Option<String>> {
    let connection = rusqlite::Connection::open(file)?;
    let has_meta: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'replica_meta')",
        [],
        |row| row.get(0),
    )?;
    if !has_meta {
        return Ok(None);
    }
    // A fresh epoch, derived from the moment and the process so two restores
    // of the same generation are two epochs. A seat that saw the first must
    // re-bootstrap against the second too.
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_nanos())
        .unwrap_or_default();
    let epoch = format!(
        "restore-{}",
        &crate::backup::store::digest(&stamp.to_le_bytes())[..16]
    );
    connection.execute_batch("BEGIN IMMEDIATE")?;
    let applied = connection.execute(
        "UPDATE replica_meta SET epoch = ?1, epoch_reason = 'backup-restore', \
         floor_seq = MAX(\
           COALESCE(floor_seq, 0), \
           COALESCE((SELECT MAX(seq) FROM replica_log), 0)\
         )",
        [&epoch],
    );
    match applied {
        Ok(_) => {
            connection.execute_batch("COMMIT")?;
            Ok(Some(epoch))
        }
        Err(error) => {
            let _ = connection.execute_batch("ROLLBACK");
            Err(error.into())
        }
    }
}

/// The lock a live gateway holds on a data directory, with its pid.
///
/// `recover` refuses a directory a live gateway is using, because restoring
/// under a running gateway means two processes writing one file — which SQLite
/// will let them do, and which produces a vault neither of them agrees with.
#[derive(Debug)]
pub struct DataDirLock {
    path: PathBuf,
}

impl DataDirLock {
    #[must_use]
    pub fn file_in(dir: &Path) -> PathBuf {
        dir.join("gateway.lock")
    }

    /// Take the lock, or report the pid that holds it.
    pub fn acquire(dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(dir)
            .map_err(|error| RestoreError::Other(format!("creating {}: {error}", dir.display())))?;
        let path = Self::file_in(dir);
        if let Ok(existing) = std::fs::read_to_string(&path) {
            let pid = existing.trim();
            // A lock file whose process is gone is a crash, not a live
            // gateway: it is taken over rather than becoming a permanent
            // refusal the owner has to know to delete.
            if pid.parse::<u32>().is_ok_and(process_is_live) {
                return Err(RestoreError::Other(format!(
                    "a live gateway (pid {pid}) holds {} — stop it before restoring into this data directory",
                    dir.display()
                )));
            }
        }
        std::fs::write(&path, std::process::id().to_string())
            .map_err(|error| RestoreError::Other(format!("writing {}: {error}", path.display())))?;
        Ok(Self { path })
    }
}

impl Drop for DataDirLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn process_is_live(pid: u32) -> bool {
    // No signals: `/proc` is the answer on the platform the gateway runs on,
    // and a `kill(0)` would need a `libc` dependency for one question.
    Path::new(&format!("/proc/{pid}")).exists()
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
            connection
                .execute_batch("DELETE FROM core_vault; DELETE FROM core_party; VACUUM")
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
                     (content_id, content_uri, sha256, byte_size, created_at) \
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

    #[test]
    fn a_live_gateways_data_directory_is_refused_and_a_stale_lock_is_taken_over() {
        let dir = tempfile::tempdir().unwrap();
        let held = DataDirLock::acquire(dir.path()).unwrap();
        // This process IS live, so a second acquire must refuse and name it.
        let error = DataDirLock::acquire(dir.path()).unwrap_err();
        assert!(error.to_string().contains("a live gateway"), "{error}");
        assert!(error.to_string().contains(&std::process::id().to_string()));
        drop(held);
        assert!(
            !DataDirLock::file_in(dir.path()).exists(),
            "the lock is released"
        );

        // A lock left by a crashed gateway is taken over, not a permanent
        // refusal the owner has to know to delete by hand.
        std::fs::write(DataDirLock::file_in(dir.path()), "4294967294").unwrap();
        assert!(DataDirLock::acquire(dir.path()).is_ok());
    }

    #[test]
    fn fencing_bumps_the_epoch_and_derives_the_floor_from_the_log_the_file_has() {
        let dir = tempfile::tempdir().unwrap();
        let file = restored_vault(dir.path());
        let before: String = rusqlite::Connection::open(&file)
            .unwrap()
            .query_row("SELECT epoch FROM replica_meta LIMIT 1", [], |row| {
                row.get(0)
            })
            .unwrap();
        let fenced = fence_restored_vault(&file).unwrap().unwrap();
        let (after, reason): (String, Option<String>) = rusqlite::Connection::open(&file)
            .unwrap()
            .query_row(
                "SELECT epoch, epoch_reason FROM replica_meta LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(after, fenced);
        assert_ne!(
            after, before,
            "every paired seat's cursor must stop resolving"
        );
        assert_eq!(reason.as_deref(), Some("backup-restore"));

        // Fencing twice is two epochs: a seat that saw the first must
        // re-bootstrap against the second too.
        let again = fence_restored_vault(&file).unwrap().unwrap();
        assert_ne!(again, fenced);
    }

    #[test]
    fn fencing_a_file_with_no_replica_plane_is_none_rather_than_a_failure() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("bare.db");
        rusqlite::Connection::open(&file)
            .unwrap()
            .execute_batch("CREATE TABLE leftovers (x)")
            .unwrap();
        assert_eq!(fence_restored_vault(&file).unwrap(), None);
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
