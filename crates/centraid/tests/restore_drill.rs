//! The restore drill, against the **real binary** (#1020, D-1020-R7).
//!
//! `cargo xtask gate --profile release` runs this test as its `restore-drill`
//! step. It lives here, rather than in `crates/vault`, for one reason: this is
//! the package that owns the `centraid` binary, so `CARGO_BIN_EXE_centraid`
//! points at it and the recover phase is a **process** — the thing an operator
//! actually runs. A drill that called a library function would prove the
//! library and not the product.
//!
//! The vault-side work is in `centraid_vault::backup::drill`, because SQL lives
//! only under the crates the gate's `sql-confinement` rule allows, and this is
//! not one of them.

use std::path::Path;
use std::process::Command;

use centraid_vault::backup::drill;

/// Run `centraid recover` as a process, the way an operator does.
fn recover(kit: &Path, password_file: &Path, data_dir: &Path) -> Result<(), String> {
    let output = Command::new(env!("CARGO_BIN_EXE_centraid"))
        .args([
            "recover",
            "--kit",
            &kit.display().to_string(),
            "--password-file",
            &password_file.display().to_string(),
            "--data-dir",
            &data_dir.display().to_string(),
            "--yes",
        ])
        .output()
        .map_err(|error| format!("spawning centraid recover: {error}"))?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    eprintln!("--- centraid recover (stderr) ---\n{stderr}");
    eprintln!("--- centraid recover (stdout) ---\n{stdout}");
    if !output.status.success() {
        return Err(format!(
            "centraid recover exited {:?}: {stderr}",
            output.status.code()
        ));
    }
    // The report is JSON and nothing but JSON — a progress line on stdout
    // would make it unparseable exactly when it matters.
    let report: serde_json::Value = serde_json::from_str(stdout.trim())
        .map_err(|error| format!("the recover report is not JSON: {error}\n{stdout}"))?;
    assert_eq!(report["command"], "recover");
    assert_eq!(report["clean"], true, "{report:#}");
    assert_eq!(report["restoreCheck"]["sealKey"], "ok", "{report:#}");
    assert_eq!(
        report["phases"],
        serde_json::json!([
            "discovering",
            "fetching",
            "replaying",
            "fencing",
            "adopting",
            "warming",
            "done"
        ])
    );
    // NOTHING TO FENCE (#1029 §6, F3). The epoch bump made every paired SEAT
    // re-bootstrap, and there are none. The phase stays in the vocabulary — a
    // restore still has to say what it did at each step — and the lease epoch
    // a restored PHONE claims is W5's replacement for it.
    assert!(
        report["fencedEpoch"].is_null(),
        "there is no seat to fence out: {report:#}"
    );
    Ok(())
}

/// **The acceptance box**: the restore drill runs and the restored file is
/// sound.
///
/// It used to end "and it re-pairs a seat" — restore, present the old seat's
/// cursor, watch it be told to re-bootstrap, then converge a fresh replica.
/// That half is deleted with the seat (#1029 §6) and its replacement is the
/// phone-shaped drill #1029 describes, which needs the lease.
#[test]
fn the_restore_drill_restores_a_lost_vault() {
    let scratch = tempfile::tempdir().expect("scratch dir");
    let outcome = drill::run_restore_drill(scratch.path(), &recover).expect("the drill");

    // Every row is back.
    assert!(
        outcome.total_rows > 0 && outcome.rows_compared > 0,
        "{outcome:?}"
    );
    assert!(outcome.report.is_clean());
    assert!(
        outcome
            .report
            .checks
            .iter()
            .any(|check| check.name == "restored-census" && check.ok),
        "{:?}",
        outcome.report.checks
    );

    // THE SEAT HALF IS GONE (#1029 §6). It asserted that the restored vault
    // had fenced its epoch, that the old seat's cursor was answered
    // `RebootstrapRequired{epoch-mismatch}`, and that a re-paired replica
    // converged. There is no second host to fence out, no cursor to present
    // and no replica to converge — and what replaces it is the phone-shaped
    // drill #1029 describes: restore onto a second device from the 24-word
    // phrase and watch the first freeze on `VAULT_MOVED`. That drill needs the
    // lease, which is not built here.

    // The wall clock the release gate records.
    eprintln!(
        "restore-drill: {} ms — vault {}, generation {} ({}), {} tables compared, {} rows",
        outcome.elapsed_ms,
        outcome.vault_id,
        outcome.generation,
        &outcome.manifest_hash[..16],
        outcome.rows_compared,
        outcome.total_rows,
    );
}

/// The upgrade-failure rule: a migration that fails mid-way restores from the
/// pre-migration snapshot it took first.
#[test]
fn an_upgrade_that_fails_mid_way_restores_from_its_pre_migration_snapshot() {
    const FAILING: &str = include_str!("../../../contracts/migrations/999_fails.sql");
    let scratch = tempfile::tempdir().expect("scratch dir");
    let outcome = drill::run_upgrade_failure_drill(scratch.path(), FAILING).expect("the drill");
    assert!(
        outcome.failure.contains("NOT NULL"),
        "the fixture must fail for the reason it says: {}",
        outcome.failure
    );
    // The half-migrated file carried the scratch table; the restored one does
    // not, and every table the snapshot carries is back at its old count.
    assert!(
        outcome
            .census_after_failure
            .contains_key("drill_upgrade_scratch")
    );
    assert!(
        !outcome
            .census_after_restore
            .contains_key("drill_upgrade_scratch"),
        "the pre-migration snapshot predates the upgrade, so its table is gone"
    );
    assert!(outcome.restored_clean);
    eprintln!("upgrade-failure: restored away from `{}`", outcome.failure);
}

/// `--at` is a usage error when it does not parse, and exit 2 is what a script
/// must be able to tell apart from a refusal it should retry.
#[test]
fn a_bad_at_is_exit_two_and_touches_nothing() {
    let scratch = tempfile::tempdir().expect("scratch dir");
    let output = Command::new(env!("CARGO_BIN_EXE_centraid"))
        .args([
            "recover",
            "--kit",
            "/nonexistent/kit.json",
            "--password-file",
            "/nonexistent/password",
            "--data-dir",
            &scratch.path().display().to_string(),
            "--at",
            "yesterday",
            "--yes",
        ])
        .output()
        .expect("spawning centraid recover");
    assert_eq!(output.status.code(), Some(2), "{output:?}");
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("ISO-8601"),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    // And it stopped before touching the data directory — no lock file.
    assert!(!scratch.path().join("gateway.lock").exists());
}
