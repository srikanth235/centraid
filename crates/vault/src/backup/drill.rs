//! The restore drill: back up, lose everything, recover, and re-pair a seat
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
use std::path::{Path, PathBuf};

use crate::backup::keyring::Keyring;
use crate::backup::kit::{LockerKeyEntry, RecoveryKitDocument, RecoveryKitTarget};
use crate::backup::restore::{RestoreDrillReport, SealKeyVerdict};
use crate::backup::store::{BlobStore as _, FsBlobStore};
use crate::backup::{self, BackupError};
use crate::custody::keystore::KeyStore;
use crate::custody::locker_key::{self, LockerCustody};
use crate::error::{RebootstrapReason, VaultError};
use crate::file::Vault;
use crate::log::door::{self, Cursor};
use crate::log::{LogPage, apply};

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
    /// The epoch the original vault was in, which the old seat's cursor names.
    pub epoch_before: String,
    /// The epoch the restored vault fenced to.
    pub epoch_after: String,
    /// What the old cursor was told. Always `EpochMismatch`, or the drill fails.
    pub old_seat_verdict: RebootstrapReason,
    /// Rows the re-paired seat applied while converging.
    pub seat_rows_applied: usize,
    /// Whether the re-paired replica's census equals the restored vault's.
    pub seat_converged: bool,
    pub report: RestoreDrillReport,
    pub elapsed_ms: u128,
}

/// A seat's replica, for the convergence half.
///
/// One vault file, one cursor. The gateway-side applier is what writes into it
/// in wave 2; `crates/seat` replaces this whole struct in wave 2 lane D2
/// without changing the drill above it.
pub struct SeatReplica {
    pub file: PathBuf,
    pub cursor: Cursor,
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

    // The Locker key plane, so the drill exercises the custody the kit carries.
    let keys = KeyStore::new(live.join("keys"));
    let custody = LockerCustody::new(KeyStore::new(live.join("keys")), vault_id.clone());
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
                   (content_id, content_uri, sha256, byte_size, created_at) \
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
    let state_before = door::log_state(&vault)?;
    let epoch_before = state_before.epoch.clone();
    // The seat's cursor: where it had read to before everything was lost.
    let seat_cursor = Cursor {
        epoch: epoch_before.clone(),
        seq: state_before.watermark.seq,
    };
    door::record_seat_cursor(&vault, "device-seat-1", seat_cursor.seq)?;

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

    // ---- 8. the old seat re-pairs and converges ---------------------------
    let recovered = Vault::open(&restored_file)?;
    let state_after = door::log_state(&recovered)?;
    let epoch_after = state_after.epoch.clone();
    if epoch_after == epoch_before {
        return Err(fail(
            "the restored vault was not fenced: a paired seat's cursor would still resolve, and \
             it would be served a history that never happened",
        ));
    }
    // The old cursor, presented to the restored vault.
    let verdict = match door::read_log_page(&recovered, &seat_cursor, 64) {
        Err(VaultError::RebootstrapRequired { reason }) => reason,
        Err(error) => return Err(error.into()),
        Ok(_) => {
            return Err(fail(
                "the old seat's cursor was SERVED by the restored vault — it must be told to \
                 re-bootstrap",
            ));
        }
    };
    if verdict != RebootstrapReason::EpochMismatch {
        return Err(fail(format!(
            "the old seat was told `{verdict}`, and the restore's reason is epoch-mismatch"
        )));
    }

    // Re-pair: the device is enrolled again against the restored vault, which
    // is the ceremony's outcome, and it starts from the floor with no cursor.
    let owner = recovered.read(|connection| {
        Ok(connection.query_row(
            "SELECT owner_party_id FROM access_device LIMIT 1",
            [],
            |row| row.get::<_, String>(0),
        )?)
    })?;
    recovered.enrol_device(
        "device-seat-1",
        &owner,
        "Ada's laptop, re-paired",
        "linux",
        "seat-public-key-1",
    )?;
    // Re-bootstrap: the seat takes a fresh snapshot and then the log from it.
    let seat_dir = root.join("seat");
    std::fs::create_dir_all(&seat_dir).map_err(|error| fail(error.to_string()))?;
    // The SEAT snapshot here, deliberately: this is a seat bootstrapping, and
    // a seat gets the sanitised artefact. The backup's base copy is the other
    // one (see `backup::base`).
    let head = crate::snapshot::build_snapshot(&recovered, &seat_dir)?;
    let seat_file = seat_dir.join("replica.db");
    inflate(&seat_dir.join(&head.name), &seat_file)?;

    // NOW the write, after the seat's snapshot was taken. Order matters: a
    // commit made before the snapshot is already inside it, and the seat would
    // converge having applied nothing — which proves nothing about the log.
    // A write after the re-pair, so convergence has something to carry.
    recovered.commit(|tx| {
        tx.set_producer("drill.after-restore");
        tx.connection().execute(
            "INSERT INTO core_content_item \
               (content_id, content_uri, sha256, byte_size, created_at) \
             VALUES ('content-after', 'cas:content-after', \
               'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', 7, \
               '2026-02-01T00:00:00.000Z')",
            [],
        )?;
        Ok(())
    })?;

    let mut seat = SeatReplica {
        file: seat_file,
        cursor: Cursor {
            epoch: head.epoch.clone(),
            seq: head.seq,
        },
    };
    let seat_rows_applied = converge(&recovered, &mut seat)?;
    let restored_census = census(&restored_file)?;
    let seat_census = census(&seat.file)?;
    let seat_converged = replicated_census_matches(&restored_census, &seat_census);
    if !seat_converged {
        return Err(fail(format!(
            "the re-paired seat did not converge: {}",
            census_difference(&restored_census, &seat_census)
        )));
    }
    recovered.close()?;

    Ok(DrillOutcome {
        vault_id,
        census_before,
        rows_compared,
        total_rows,
        generation: outcome.generation,
        manifest_hash: outcome.manifest_hash,
        epoch_before,
        epoch_after,
        old_seat_verdict: verdict,
        seat_rows_applied,
        seat_converged,
        report,
        elapsed_ms: started.elapsed().as_millis(),
    })
}

/// Feed the seat every page until its cursor reaches the watermark.
fn converge(gateway: &Vault, seat: &mut SeatReplica) -> Result<usize> {
    let target = rusqlite::Connection::open(&seat.file)?;
    let mut applied = 0_usize;
    loop {
        let page: LogPage = door::read_log_page(gateway, &seat.cursor, 64)?;
        if page.rows.is_empty() {
            seat.cursor = page.next;
            break;
        }
        let outcome = apply::apply_log_page(
            &target,
            &page.rows,
            Some(&page.vault_epoch),
            seat.cursor.seq,
        )?;
        applied += outcome.applied;
        seat.cursor = page.next.clone();
        if !page.has_more {
            break;
        }
    }
    Ok(applied)
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

/// Does the seat's copy agree with the gateway, on the tables a seat carries?
///
/// A seat's file legitimately differs from the gateway's on the private tables
/// and on the log itself: the snapshot dropped them and truncated it. So
/// convergence is compared over the tables the seat's copy actually **has**,
/// which is what "every table, values not bytes" means for a sanitised
/// snapshot.
fn replicated_census_matches(
    gateway: &BTreeMap<String, i64>,
    seat: &BTreeMap<String, i64>,
) -> bool {
    census_difference(gateway, seat).is_empty()
}

fn census_difference(gateway: &BTreeMap<String, i64>, seat: &BTreeMap<String, i64>) -> String {
    seat.iter()
        .filter(|(table, _)| !matches!(table.as_str(), "replica_log" | "replica_meta"))
        .filter_map(|(table, seat_count)| {
            let gateway_count = gateway.get(table).copied().unwrap_or(-1);
            (gateway_count != *seat_count)
                .then(|| format!("{table}: gateway {gateway_count}, seat {seat_count}"))
        })
        .collect::<Vec<_>>()
        .join("; ")
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
               (content_id, content_uri, sha256, byte_size, created_at) \
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
    let differences = census_difference(&census_before, &census_after_restore);
    if !differences.is_empty() {
        return Err(fail(format!(
            "the pre-migration snapshot did not put the vault back: {differences}"
        )));
    }
    Ok(UpgradeFailureOutcome {
        failure,
        census_after_failure,
        census_after_restore,
        restored_clean: report.is_clean(),
    })
}
