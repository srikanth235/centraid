//! `centraid doctor` (#1020, D-1020-G7).
//!
//! The verb an operator runs when something is wrong, and the verb the Docker
//! image's `HEALTHCHECK` runs on a timer. **One definition of "sound", not
//! two**: it calls `centraid_vault::backup::restore::restore_check`, the same
//! function the restore drill asserts on a recovered vault (wave 2 lane R). A
//! second set of checks written for the health check would be a second idea of
//! what a healthy vault is, and the two would disagree on exactly the day it
//! mattered.
//!
//! ## What it does and does not claim
//!
//! Clean means: `PRAGMA integrity_check` says `ok`, `PRAGMA foreign_key_check`
//! is empty, and the seal-key fingerprint in the file is either absent (an
//! unsealed vault is an answer, not a fault) or matches. Dangling receipts are
//! **reported and do not make the report dirty** — that is `restore_check`'s
//! ruling and this verb does not override it.
//!
//! It opens the vault file READ-ONLY and takes no lock, so running it against a
//! gateway that is serving is safe. It therefore says nothing about whether a
//! gateway is *running*: for the container health check that is the point, since
//! the process being alive is what Docker already knows and the file being
//! sound is what it cannot.
//!
//! Facts to stderr, one JSON document to stdout — `cmd/mod.rs`'s rule.
//!
//! Exit codes: 0 clean, 1 refused (no vault, or a dirty report). A health check
//! branches on those two numbers and nothing else.

use std::path::PathBuf;

use centraid_vault::backup::restore::{SealKeyVerdict, restore_check};

use crate::exit;

pub struct DoctorArgs {
    pub data_dir: Option<PathBuf>,
    /// Print the JSON report on stdout even when it is clean. Off by default
    /// for the health check, which wants an exit code and a quiet log.
    pub json: bool,
}

pub fn run(args: DoctorArgs) -> u8 {
    let data_dir = match args.data_dir {
        Some(dir) => dir,
        None => {
            eprintln!(
                "centraid: doctor needs --data-dir: there is no default vault location for a \
                 gateway that can hold several (see `centraid gateway --help`)."
            );
            return exit::REFUSED;
        }
    };
    let file = match super::sole_vault_file(&data_dir) {
        Ok(file) => file,
        Err(why) => {
            eprintln!("centraid: doctor: {why}");
            return exit::REFUSED;
        }
    };

    // `seal_key` is None: doctor is unprivileged by design. It reads the
    // fingerprint the file carries and reports `missing` rather than unwrapping
    // the keystore, because a health check that needed the keystore secret
    // would be a privileged path running every thirty seconds.
    let report = match restore_check(&file, None) {
        Ok(report) => report,
        Err(error) => {
            eprintln!("centraid: doctor: {error}");
            return exit::REFUSED;
        }
    };

    let seal = match report.seal_key {
        SealKeyVerdict::NotSealed => "not-sealed",
        SealKeyVerdict::Ok => "ok",
        SealKeyVerdict::Missing => "missing",
        SealKeyVerdict::Mismatch => "mismatch",
    };
    // A `missing` seal key means the file says it is sealed and doctor was not
    // given the key. That is this verb's normal state, not a fault, and
    // `is_clean()` would call it dirty — so the verdict is computed here and the
    // difference is stated rather than hidden.
    let clean = report.integrity == "ok"
        && report.foreign_key_violations.is_empty()
        && !matches!(report.seal_key, SealKeyVerdict::Mismatch);

    let document = serde_json::json!({
        "vault": file.to_string_lossy(),
        "clean": clean,
        "integrity": report.integrity,
        "foreignKeyViolations": report.foreign_key_violations,
        "receiptsChecked": report.receipts_checked,
        "danglingReceipts": report.dangling_receipts,
        "sealKey": seal,
    });

    if clean {
        eprintln!(
            "centraid: doctor: clean — pages sound, {} foreign keys hold, {} receipt(s) checked, seal key {seal}",
            report.foreign_key_violations.len(),
            report.receipts_checked
        );
        if args.json {
            println!("{document:#}");
        }
        return exit::OK;
    }

    eprintln!("centraid: doctor: NOT clean.");
    if report.integrity != "ok" {
        eprintln!("centraid:   integrity_check: {}", report.integrity);
    }
    for violation in &report.foreign_key_violations {
        eprintln!("centraid:   foreign key: {violation}");
    }
    if matches!(report.seal_key, SealKeyVerdict::Mismatch) {
        eprintln!(
            "centraid:   seal key: the fingerprint in this vault is not the one the keystore \
             holds. This is a vault restored from someone else's kit, or a keystore that was \
             replaced — `centraid recover` is the verb, not a repair."
        );
    }
    println!("{document:#}");
    exit::REFUSED
}
