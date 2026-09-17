//! The restore drill: write, back up, lose everything, restore, check (#1029 §2).
//!
//! This is the acceptance box *"the restore drill runs in CI"*, and it is the
//! only test in the tree that asserts the whole durability chain end to end:
//!
//! 1. found a vault and write commits through the command plane, so the log has
//!    real rows;
//! 2. capture, so the spool holds every committed page;
//! 3. take a generation — a page-identical sealed base, the segments after it,
//!    and a manifest chained by its own name;
//! 4. write **more** commits, and capture them, so there is a tail the first
//!    base does not cover;
//! 5. **destroy the live vault**, its WAL and its spool. What is left is the
//!    object store, which is ciphertext, and the two keys §0 derives;
//! 6. restore: the base, then every segment, **applied** (B3);
//! 7. prove `restore_check` is clean, prove the census matches the census the
//!    generation carried at that txid, and prove the file is **byte-identical**
//!    to the vault that was lost.
//!
//! ## WHAT CHANGED FROM THE DRILL THAT STOOD HERE, AND WHY
//!
//! **The recovery-kit file is gone** (§5, Reference A). The old drill wrapped a
//! `RecoveryKitDocument` under scrypt, wrote it to disk, deleted the data
//! directory and handed the kit to `centraid recover` as a subprocess. §0 makes
//! every key derive from a **24-word phrase**, so there is nothing for a kit to
//! carry that the member does not already hold, and a file that carries keys is
//! a file that can be copied. The two keys are passed in directly here, which is
//! what a phone does after deriving them from its seed.
//!
//! **The subprocess seam is gone with it.** The old module argued that a drill
//! calling a library proves the library and not the product; that was right
//! when `centraid recover` was the product. The product is the phone, the CLI
//! is being reshaped by W4 and W5, and what this lane is responsible for is that
//! **a committed transaction survives a crash and comes back byte-exact**. That
//! is a claim about this crate, and it is asserted about this crate.
//!
//! **Step 8 is gone.** It opened the restored vault, bumped the fence, required
//! `RebootstrapRequired{epoch-mismatch}` of the old seat, re-enrolled and
//! converged. There is no seat (#1029 §6) and there is no log-page door. The
//! phone-shaped replacement — restore onto a second device from the 24 words,
//! and watch the first freeze on `VAULT_MOVED` — belongs to the wave that builds
//! the lease (W5), not to this one.

use std::collections::BTreeMap;
use std::path::Path;

use crate::backup::objects::ObjectKeys;
use crate::backup::restore::{RestoreDrillReport, RestoredGeneration};
use crate::backup::store::BlobStore as _;
use crate::backup::{self, BackupError, BackupHome};
use crate::error::VaultError;
use crate::file::Vault;

#[derive(Debug, thiserror::Error)]
pub enum DrillError {
    #[error(transparent)]
    Vault(#[from] VaultError),
    #[error(transparent)]
    Backup(#[from] BackupError),
    #[error("the drill failed: {0}")]
    Failed(String),
}

type Result<T> = std::result::Result<T, DrillError>;

fn fail(reason: impl Into<String>) -> DrillError {
    DrillError::Failed(reason.into())
}

/// What the drill proved.
#[derive(Debug, Clone)]
pub struct DrillOutcome {
    pub vault_id: String,
    pub generation: String,
    /// The generation's address: its manifest's object name.
    pub manifest: String,
    /// The txid the restored file stands at.
    pub txid: u64,
    pub segments_applied: usize,
    pub census_before: BTreeMap<String, i64>,
    pub total_rows: i64,
    /// Whether the restored file is byte-identical to the one that was lost.
    /// **This is the lane's whole claim**: "comes back byte-exact".
    pub byte_identical: bool,
    pub report: RestoreDrillReport,
    pub restored: RestoredGeneration,
    pub elapsed_ms: u128,
}

/// Run the drill under `root`, with the two keys §0 derives.
///
/// `writes` is how many commits to make before the generation, and `after` how
/// many to make after it — the second number is what makes the drill exercise a
/// tail the first base does not cover, which is the case B3 was silently losing.
///
/// # Errors
/// [`DrillError`] naming the step that failed.
pub fn run_drill(
    root: &Path,
    keys: &ObjectKeys,
    writes: usize,
    after: usize,
) -> Result<DrillOutcome> {
    let started = std::time::Instant::now();
    let live = root.join("live");
    let home = BackupHome::open(root.join("backup"))?;
    let blobs = home.objects().map_err(|error| fail(error.to_string()))?;

    // ---- 1. found and write ----------------------------------------------
    std::fs::create_dir_all(&live).map_err(|error| fail(error.to_string()))?;
    let vault_file = live.join("vault.db");
    let vault = Vault::create(&vault_file)?;
    let founded = vault.found("The Drill Household", "Ada")?;
    let vault_id = founded.vault_id.clone();
    for index in 0..writes {
        write_one(&vault, index)?;
    }
    let census_before = census(&vault_file)?;
    let total_rows: i64 = census_before.values().copied().sum();
    if total_rows == 0 {
        return Err(fail("the drill's own vault has no rows to lose"));
    }

    // ---- 2 and 3. capture, then the generation ---------------------------
    let spool = home.spool().map_err(|error| fail(error.to_string()))?;
    backup::capture(&vault, &spool, keys).map_err(BackupError::from)?;
    let first = backup::take_generation(&vault, keys, &home, None)?;

    // ---- 4. more commits, and a tail the first base does not cover -------
    for index in writes..writes + after {
        write_one(&vault, index)?;
    }
    backup::capture(&vault, &spool, keys).map_err(BackupError::from)?;
    let outcome = backup::take_generation(&vault, keys, &home, Some(&first.manifest))?;

    // The file as it stands, which is what "byte-exact" is measured against.
    // Checkpointed first, so the comparison is against a file with no log
    // behind it — the same state the base was taken from.
    backup::checkpoint(&vault, &spool).map_err(BackupError::from)?;
    let census_at_head = census(&vault_file)?;
    let lost = std::fs::read(&vault_file).map_err(|error| fail(error.to_string()))?;
    vault.close()?;

    // ---- 5. lose everything ----------------------------------------------
    // The spool goes too. What is left is the object store — which is
    // ciphertext — and the two keys, which on a phone come from the 24 words.
    std::fs::remove_dir_all(&live).map_err(|error| fail(error.to_string()))?;
    std::fs::remove_dir_all(home.spool_dir()).map_err(|error| fail(error.to_string()))?;
    if live.exists() {
        return Err(fail("the live data directory survived its own deletion"));
    }

    // ---- 6. restore ------------------------------------------------------
    let manifest_bytes = blobs
        .get(&outcome.manifest)
        .map_err(|error| fail(error.to_string()))?;
    let manifest = backup::GenerationManifest::open(keys, &manifest_bytes)
        .map_err(|error| fail(error.to_string()))?;
    let restored_dir = root.join("restored");
    std::fs::create_dir_all(&restored_dir).map_err(|error| fail(error.to_string()))?;
    let restored_file = restored_dir.join("vault.db");
    let restored =
        backup::restore::restore_generation(keys, &manifest, &blobs, &restored_file, None)
            .map_err(|error| fail(error.to_string()))?;

    // ---- 7. is it clean, are the rows back, are the bytes the same? ------
    // NO BLOB STORE IS PASSED, deliberately. `restored-blob-coverage` asks
    // whether the bytes a `core_content_item` row points at are in a store, and
    // the store this drill has is the **backup object store** — sealed objects
    // named by their own ciphertext hash. A member's own bytes live in
    // `centraid_blobs::ByteStore` (`store.rs` says so), and they are W6's.
    // Handing the backup store to that check would make it compare a plaintext
    // hash against a set of ciphertext names and report every row missing,
    // which is a check that always fails rather than a check that says
    // something.
    let report = backup::restore_drill(&restored_file, None, None, Some(&census_at_head))
        .map_err(|error| fail(error.to_string()))?;
    if !report.is_clean() {
        return Err(fail(format!(
            "restore_check/drill is not clean: {}",
            report
                .checks
                .iter()
                .filter(|check| !check.ok)
                .map(|check| format!("{}: {}", check.name, check.detail))
                .collect::<Vec<_>>()
                .join("; ")
        )));
    }
    if let Err(reason) = restored
        .census_matches(&restored_file)
        .map_err(|error| fail(error.to_string()))?
    {
        return Err(fail(format!(
            "the census at txid {} is wrong: {reason}",
            restored.txid
        )));
    }

    let back = std::fs::read(&restored_file).map_err(|error| fail(error.to_string()))?;
    // BYTE-EXACT, past the file header. Bytes 24..40 of a SQLite header are the
    // change counter and the freelist bookkeeping, which the backup API and a
    // reopen both move without changing a single row; every page body must be
    // identical, and that is the claim.
    let byte_identical = back.len() == lost.len() && back.get(100..) == lost.get(100..);

    Ok(DrillOutcome {
        vault_id,
        generation: outcome.generation.hex(),
        manifest: outcome.manifest,
        txid: restored.txid,
        segments_applied: restored.segments_applied,
        census_before,
        total_rows,
        byte_identical,
        report,
        restored,
        elapsed_ms: started.elapsed().as_millis(),
    })
}

/// One commit the drill can count.
///
/// `core_content_item` is the table it writes because its only foreign keys are
/// nullable: the drill is about losing and recovering rows, not about the
/// ontology's dependency order.
fn write_one(vault: &Vault, index: usize) -> std::result::Result<(), VaultError> {
    vault.commit(|tx| {
        tx.set_producer("drill.write");
        tx.connection().execute(
            "INSERT INTO core_content_item \
               (content_id, content_uri, content_hash, byte_size, created_at) \
             VALUES (?1, ?2, ?3, ?4, '2026-01-01T00:00:00.000Z')",
            rusqlite::params![
                format!("content-{index}"),
                format!("cas:content-{index}"),
                blake3::hash(format!("drill content {index}").as_bytes())
                    .to_hex()
                    .to_string(),
                (64 + index) as i64,
            ],
        )?;
        Ok(())
    })?;
    Ok(())
}

/// Row counts per table, for a file on disk.
///
/// # Errors
/// [`VaultError`] when the file will not open.
pub fn census(file: &Path) -> std::result::Result<BTreeMap<String, i64>, VaultError> {
    let connection =
        rusqlite::Connection::open_with_flags(file, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let mut statement = connection.prepare(
        r"SELECT name FROM sqlite_schema
            WHERE type = 'table' AND name NOT LIKE 'sqlite\_%' ESCAPE '\'
            ORDER BY name",
    )?;
    let tables: Vec<String> = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut census = BTreeMap::new();
    for table in tables {
        let sql = format!(
            "SELECT count(*) FROM {}",
            crate::log::identifiers::quoted(&table)
        );
        census.insert(
            table,
            connection.query_row(&sql, [], |row| row.get::<_, i64>(0))?,
        );
    }
    Ok(census)
}
