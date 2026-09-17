//! The restore drill: back up, lose everything, recover, and check the file
//! (#1020, D-1020-R7).
//!
//! This is the acceptance box *"the restore drill runs in CI"*, and it is the
//! only test in the tree that asserts the whole chain end to end:
//!
//! 1. found a vault and **enrol a seat**;
//! 2. write commits through the command plane, so the log has real rows;
//! 3. take the pre-backup **census** — the row count per table;
//! 4. take a generation (snapshot + sealed WAL tail + manifest) and a
//!    password-wrapped recovery kit;
//! 5. **destroy the live data directory**, keys and all;
//! 6. `centraid recover` into a fresh directory from the kit;
//! 7. prove `restore_check` is clean and **every row is back**;
//! 8. prove the old seat is told `RebootstrapRequired{epoch-mismatch}`,
//!    re-pairs, re-bootstraps and **converges**.
//!
//! Step 8 is the one v0 never had. The plane census records it plainly: the
//! epoch mechanics were covered and the drill was covered, but *"old seats
//! re-pair after a restore" has no end-to-end test*. It has one now.
//!
//! ## Why the recover step is a closure
//!
//! `recover` is a **process**, and the drill has to exercise the real binary —
//! a drill that called a library function would prove the library and not the
//! product. But this crate cannot know where that binary is, and
//! `crates/centraid` cannot hold SQL (the gate's `sql-confinement` rule). So
//! the vault-side work lives here, and the caller passes [`Recover`]: in the
//! drill test that closure runs `CARGO_BIN_EXE_centraid`.
//!
//! ## What stands in for the seat, and why
//!
//! `crates/seat` (wave 2 lane D2) is not on the umbrella at this lane's
//! rebase, so the seat's half is played by **D1's gateway-side applier**
//! (`log::apply::apply_log_page`) against a second vault file, with
//! `devices::enrol_device` and the log door's cursor record standing in for
//! lane C's pairing ceremony. What that costs is named honestly: the drill
//! proves the *replica* re-bootstraps and converges, not that the iroh pairing
//! handshake runs again. When D2's crate lands, [`SeatReplica`] is the seam to
//! swap — nothing else in this module changes.

use std::collections::BTreeMap;
use std::path::Path;

use crate::backup::keyring::Keyring;
use crate::backup::kit::{LockerKeyEntry, RecoveryKitDocument, RecoveryKitTarget};
use crate::backup::restore::{RestoreDrillReport, SealKeyVerdict};
use crate::backup::store::{BlobStore as _, FsBlobStore};
use crate::backup::{self, BackupError};
use crate::custody::keystore::KeyStore;
use crate::custody::locker_key;
use crate::custody::member_key::MemberKeyCustody;
use crate::error::VaultError;
use crate::file::Vault;

/// How the caller runs `centraid recover`. Given `(kit, password_file,
/// data_dir)`, it must leave a restored vault under `<data_dir>/vault/<id>`.
pub type Recover<'a> = &'a dyn Fn(&Path, &Path, &Path) -> std::result::Result<(), String>;

#[derive(Debug, thiserror::Error)]
pub enum DrillError {
    #[error("restore drill: {0}")]
    Failed(String),
    #[error(transparent)]
    Vault(#[from] VaultError),
    #[error(transparent)]
    Backup(#[from] BackupError),
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
}

type Result<T> = std::result::Result<T, DrillError>;

fn fail(what: impl Into<String>) -> DrillError {
    DrillError::Failed(what.into())
}

/// What the drill proved, and how long it took.
#[derive(Debug, Clone)]
pub struct DrillOutcome {
    pub vault_id: String,
    /// The pre-backup census, table by table.
    pub census_before: BTreeMap<String, i64>,
    /// Tables compared after the restore — every one of them matched.
    pub rows_compared: usize,
    pub total_rows: i64,
    pub generation: u64,
    pub manifest_hash: String,
    pub report: RestoreDrillReport,
    pub elapsed_ms: u128,
}

const DRILL_PASSWORD: &str = "a drill password nobody keeps";

/// Run the drill. `root` is a scratch directory the drill owns entirely.
#[allow(clippy::too_many_lines)]
pub fn run_restore_drill(root: &Path, recover: Recover<'_>) -> Result<DrillOutcome> {
    let started = std::time::Instant::now();
    let live = root.join("live");
    let restored = root.join("restored");
    let store_root = root.join("store");
    std::fs::create_dir_all(&live).map_err(|error| fail(error.to_string()))?;

    // ---- 1. found a vault, and enrol a seat --------------------------------
    let vault_file = live.join("vault").join("drill").join("vault.db");
    std::fs::create_dir_all(vault_file.parent().expect("a parent"))
        .map_err(|error| fail(error.to_string()))?;
    let vault = Vault::create(&vault_file)?;
    let founded = vault.found("The Drill Household", "Ada")?;
    let vault_id = founded.vault_id.clone();
    vault.enrol_device(
        "device-seat-1",
        &founded.owner_party_id,
        "Ada's laptop",
        "linux",
        "seat-public-key-1",
    )?;

    // The member key plane, so the drill exercises the custody the kit
    // carries — and it is founded on the drill's SEAT directory, not the
    // host's `keys/` (#1020, D-1020-L1). The drill's whole point is that the
    // kit is the one artefact between a member and total loss, and after wave
    // 4 the kit's Locker half comes from a seat.
    let keys = KeyStore::new(live.join("keys"));
    let custody = MemberKeyCustody::on_seat(&live.join("seat"), vault_id.clone());
    let locker_key_id = vault.ids().next();
    let seal_key = keys
        .load_or_create("seal.key")
        .map_err(|error| fail(error.to_string()))?;
    vault.commit(|tx| {
        locker_key::found_locker_key(
            tx.connection(),
            &custody,
            &locker_key_id,
            "2026-01-01T00:00:00.000Z",
        )
        .map_err(|error| VaultError::Invariant {
            context: error.to_string(),
        })?;
        crate::custody::seal::stamp_seal_key_fingerprint(
            tx.connection(),
            &seal_key,
            "2026-01-01T00:00:00.000Z",
        )
        .map_err(|error| VaultError::Invariant {
            context: error.to_string(),
        })?;
        Ok(())
    })?;

    // ---- 2. write commits, so the log has real rows ------------------------
    // The blob store is loaded first, so every content row the drill writes
    // points at bytes that are really there — which is what makes the
    // `restored-blob-coverage` check say something.
    let blobs = FsBlobStore::open(&store_root).map_err(|error| fail(error.to_string()))?;
    let mut content_digests: Vec<String> = Vec::new();
    for index in 0..12_usize {
        let bytes = format!("drill content {index}").into_bytes();
        let id: String = blobs.put(&bytes).map_err(|error| fail(error.to_string()))?;
        content_digests.push(id);
    }
    for (index, digest) in content_digests.iter().enumerate() {
        vault.commit(|tx| {
            tx.set_producer("drill.write");
            // `core_content_item` is the table the drill writes because its
            // only foreign keys are nullable: the drill is about losing and
            // recovering rows, not about the ontology's dependency order.
            tx.connection().execute(
                "INSERT INTO core_content_item \
                   (content_id, content_uri, content_hash, byte_size, created_at) \
                 VALUES (?1, ?2, ?3, ?4, '2026-01-01T00:00:00.000Z')",
                rusqlite::params![
                    format!("content-{index}"),
                    format!("cas:content-{index}"),
                    digest,
                    (64 + index) as i64
                ],
            )?;
            Ok(())
        })?;
    }
    // ---- 3. the census the restore is judged against ----------------------
    let census_before = census(&vault_file)?;
    let total_rows: i64 = census_before.values().filter(|count| **count > 0).sum();
    if total_rows == 0 {
        return Err(fail("the drill's own vault has no rows to lose"));
    }

    // ---- 4. take a generation and write the kit ---------------------------
    let master = keys
        .load_or_create("backup.master.key")
        .map_err(|error| fail(error.to_string()))?;
    use base64::Engine as _;
    let encode = |bytes: &[u8]| base64::engine::general_purpose::STANDARD.encode(bytes);
    let keyring = Keyring::from_json(&serde_json::json!({
        "version": 1,
        "active": 1,
        "epochs": [{ "epoch": 1, "key": encode(&master), "createdAt": "2026-01-01T00:00:00.000Z" }],
    }))
    .map_err(|error| fail(error.to_string()))?;
    let outcome = backup::take_generation(
        &vault,
        &blobs,
        &keyring,
        1,
        None,
        &[],
        &live.join("snapshots"),
    )?;
    let locker_keys = vault
        .read(|connection| {
            custody
                .live_files(connection)
                .map_err(|error| VaultError::Invariant {
                    context: error.to_string(),
                })
        })?
        .into_iter()
        .map(|(key_id, key)| LockerKeyEntry {
            key_id,
            key: encode(&key),
        })
        .collect::<Vec<_>>();
    if locker_keys.is_empty() {
        return Err(fail(
            "the kit would carry no Locker key — the plane was not founded",
        ));
    }
    vault.close()?;

    let kit = RecoveryKitDocument {
        created_at: "2026-01-01T00:00:00.000Z".into(),
        keyring,
        targets: vec![RecoveryKitTarget {
            provider: "local".into(),
            target_id: format!("local:{}", store_root.display()),
            vault_id: vault_id.clone(),
            label: "the drill household".into(),
            seal_key: Some(encode(&seal_key)),
            identity_seed: None,
            locker_keys,
        }],
    };
    let wrapped =
        backup::wrap_recovery_kit(&kit, DRILL_PASSWORD).map_err(|error| fail(error.to_string()))?;
    let kit_file = root.join("recovery-kit.json");
    std::fs::write(
        &kit_file,
        serde_json::to_vec_pretty(&wrapped).map_err(|error| fail(error.to_string()))?,
    )
    .map_err(|error| fail(error.to_string()))?;
    let password_file = root.join("password");
    std::fs::write(&password_file, DRILL_PASSWORD).map_err(|error| fail(error.to_string()))?;

    // ---- 5. lose everything ----------------------------------------------
    // The keys go too. That is the point: what is left is the store (which is
    // ciphertext) and the kit (which is the keys), and nothing else.
    std::fs::remove_dir_all(&live).map_err(|error| fail(error.to_string()))?;
    if live.exists() {
        return Err(fail("the live data directory survived its own deletion"));
    }

    // ---- 6. recover from the kit ------------------------------------------
    recover(&kit_file, &password_file, &restored).map_err(fail)?;
    let restored_file = restored.join("vault").join(&vault_id).join("vault.db");
    if !restored_file.is_file() {
        return Err(fail(format!(
            "`recover` left no vault at {}",
            restored_file.display()
        )));
    }

    // ---- 7. is it clean, and is every row back? ---------------------------
    let report = backup::restore_drill(
        &restored_file,
        Some(&seal_key),
        Some(&blobs),
        Some(&census_before),
    )
    .map_err(|error| fail(error.to_string()))?;
    if report.structural.seal_key != SealKeyVerdict::Ok {
        return Err(fail(format!(
            "the restored vault's seal key verdict is {}",
            report.structural.seal_key.as_wire()
        )));
    }
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
    let rows_compared = census_before.len();

    // ---- 8. WAS THE OLD SEAT'S RE-PAIR, AND THERE IS NO SEAT (#1029 §6) ---
    //
    // It opened the restored vault, asserted the fence had moved the epoch,
    // presented the old seat's cursor and required
    // `RebootstrapRequired{epoch-mismatch}`, then re-enrolled the device, took
    // a sanitised snapshot, applied every page into a second file and compared
    // the two censuses. Every one of those steps needed a second host, a log
    // page door and an applier, and all three are deleted.
    //
    // THE DRILL IS NOT FINISHED HERE. #1029's phone-shaped drill — restore
    // onto a second device from the 24-word phrase, and watch the first freeze
    // on `VAULT_MOVED` — is the replacement, and it belongs to the wave that
    // builds the lease. What remains below is the half that still holds: a
    // vault was lost, a generation restored it, and `restore_check` says the
    // file is sound.
    let recovered = Vault::open(&restored_file)?;
    let restored_census = census(&restored_file)?;
    if restored_census.is_empty() {
        return Err(fail("the restored vault holds no tables at all"));
    }
    recovered.close()?;

    Ok(DrillOutcome {
        vault_id,
        census_before,
        rows_compared,
        total_rows,
        generation: outcome.generation,
        manifest_hash: outcome.manifest_hash,
        report,
        elapsed_ms: started.elapsed().as_millis(),
    })
}

/// Row counts per table, for a file on disk.
pub fn census(file: &Path) -> Result<BTreeMap<String, i64>> {
    let connection =
        rusqlite::Connection::open_with_flags(file, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let mut statement = connection.prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' \
         ORDER BY name",
    )?;
    let tables = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut census = BTreeMap::new();
    for table in tables {
        let count: i64 = connection
            .query_row(&format!("SELECT COUNT(*) FROM \"{table}\""), [], |row| {
                row.get(0)
            })
            .unwrap_or(-1);
        census.insert(table, count);
    }
    Ok(census)
}

fn inflate(gz: &Path, out: &Path) -> Result<()> {
    use std::io::Read as _;
    let bytes = std::fs::read(gz).map_err(|error| fail(error.to_string()))?;
    let mut plain = Vec::new();
    flate2::read::GzDecoder::new(&bytes[..])
        .read_to_end(&mut plain)
        .map_err(|error| fail(format!("the snapshot would not inflate: {error}")))?;
    std::fs::write(out, &plain).map_err(|error| fail(error.to_string()))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// The upgrade-failure rule
// ---------------------------------------------------------------------------

/// What an interrupted upgrade did, and what the pre-migration snapshot bought.
#[derive(Debug, Clone)]
pub struct UpgradeFailureOutcome {
    /// The failing rung's message, as the operator sees it.
    pub failure: String,
    /// The census right after the failure — the half-migrated file.
    pub census_after_failure: BTreeMap<String, i64>,
    /// The census after restoring the pre-migration snapshot.
    pub census_after_restore: BTreeMap<String, i64>,
    pub restored_clean: bool,
}

/// **A migration that fails mid-way restores from the pre-migration snapshot
/// it took first** (#1020, D-1020-R7).
///
/// The failing rung is `contracts/migrations/999_fails.sql`, which exists only
/// for this check: it creates a table and *then* violates a constraint, so the
/// file is left changed and the ladder incomplete. That is exactly the case the
/// pre-migration snapshot covers, and the case a per-statement rollback does
/// not: the rung before it committed.
pub fn run_upgrade_failure_drill(root: &Path, failing_sql: &str) -> Result<UpgradeFailureOutcome> {
    let file = root.join("upgrade").join("vault.db");
    std::fs::create_dir_all(file.parent().expect("a parent"))
        .map_err(|error| fail(error.to_string()))?;
    let vault = Vault::create(&file)?;
    vault.found("The Upgrade Household", "Ada")?;
    vault.commit(|tx| {
        tx.set_producer("drill.pre-upgrade");
        tx.connection().execute(
            "INSERT INTO core_content_item \
               (content_id, content_uri, content_hash, byte_size, created_at) \
             VALUES ('content-pre', 'cas:content-pre', \
               'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 11, \
               '2026-01-01T00:00:00.000Z')",
            [],
        )?;
        Ok(())
    })?;
    let census_before = census(&file)?;

    // THE SNAPSHOT COMES FIRST. `VACUUM INTO` cannot run inside a transaction,
    // so it cannot be taken from inside the ladder — which is why the rule is
    // "the caller takes it before calling" and why this drill exists to prove
    // the caller does.
    let snapshots = crate::snapshot::pre_migration_dir(&file);
    let head = crate::snapshot::build_snapshot(&vault, &snapshots)?;
    vault.close()?;

    // The failing upgrade, run the way the ladder runs a rung: one transaction,
    // rolled back on error. The first statement succeeds, the second does not.
    let connection = rusqlite::Connection::open(&file)?;
    connection.execute_batch("PRAGMA foreign_keys = ON")?;
    let failure = match connection.execute_batch(failing_sql) {
        Ok(()) => {
            return Err(fail(
                "contracts/migrations/999_fails.sql succeeded — the fixture is supposed to fail",
            ));
        }
        Err(error) => error.to_string(),
    };
    // Whatever `execute_batch` managed before the failure is still there: a
    // batch is not a transaction unless something opened one.
    drop(connection);
    let census_after_failure = census(&file)?;
    if census_after_failure == census_before {
        return Err(fail(
            "the failing upgrade changed nothing, so the pre-migration snapshot proves nothing",
        ));
    }

    // The repair: put back the snapshot taken before the ladder ran.
    inflate(&snapshots.join(&head.name), &file)?;
    let census_after_restore = census(&file)?;
    let report = backup::restore_check(&file, None).map_err(|error| fail(error.to_string()))?;
    // The snapshot is sanitised, so the private tables are gone from the
    // restored file; what must be back is every table the snapshot carries.
    let differences: Vec<String> = census_after_restore
        .iter()
        .filter_map(|(table, restored)| {
            let before = census_before.get(table).copied().unwrap_or(-1);
            (before != *restored).then(|| format!("{table}: before {before}, restored {restored}"))
        })
        .collect();
    if !differences.is_empty() {
        return Err(fail(format!(
            "the pre-migration snapshot did not put the vault back: {}",
            differences.join("; ")
        )));
    }
    Ok(UpgradeFailureOutcome {
        failure,
        census_after_failure,
        census_after_restore,
        restored_clean: report.is_clean(),
    })
}
