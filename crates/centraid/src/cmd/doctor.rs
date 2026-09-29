//! `centraid doctor` (#1020, D-1020-G7).
//!
//! The verb an operator runs against a vault file when something is wrong —
//! a copy taken off the phone, or a vault a restore drill produced — and the
//! operator image's default command. The vault itself lives on the phone
//! (#1029); the laptop's gateway holds only sealed objects and has no vault
//! file for this to check. **One definition of "sound", not two**: it calls
//! `centraid_vault::backup::restore::restore_check`, the same function the
//! restore drill asserts on a recovered vault. A second set of checks written
//! for this verb would be a second idea of what a healthy vault is, and the
//! two would disagree on exactly the day it mattered.
//!
//! ## What it does and does not claim
//!
//! Clean means: `PRAGMA integrity_check` says `ok` and `PRAGMA
//! foreign_key_check` is empty. Dangling receipts are **reported and do not
//! make the report dirty** — that is `restore_check`'s ruling and this verb
//! does not override it. There is no key verdict: the vault seals nothing
//! under a key of its own (R-1047-D2).
//!
//! It opens the vault file READ-ONLY and takes no lock, so it never changes
//! the file it judges. It says nothing about a gateway: a gateway has no vault
//! file, and whether one is running is its service manager's to say.
//!
//! Facts to stderr, one JSON document to stdout — `cmd/mod.rs`'s rule.
//!
//! Exit codes: 0 clean, 1 refused (no vault, or a dirty report). A script
//! branches on those two numbers and nothing else.

use std::path::PathBuf;

use centraid_vault::backup::restore::restore_check;

use crate::exit;

pub struct DoctorArgs {
    pub data_dir: Option<PathBuf>,
    /// Print the JSON report on stdout even when it is clean. Off by default
    /// for a script, which wants an exit code and a quiet log.
    pub json: bool,
}

pub fn run(args: DoctorArgs) -> u8 {
    let data_dir = match args.data_dir {
        Some(dir) => dir,
        None => {
            eprintln!(
                "centraid: doctor needs --data-dir: it checks a vault file you name, and there \
                 is no default location (the vault lives on the phone)."
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

    let report = match restore_check(&file) {
        Ok(report) => report,
        Err(error) => {
            eprintln!("centraid: doctor: {error}");
            return exit::REFUSED;
        }
    };

    let clean = report.is_clean();

    let document = serde_json::json!({
        "vault": file.to_string_lossy(),
        "clean": clean,
        "integrity": report.integrity,
        "foreignKeyViolations": report.foreign_key_violations,
        "receiptsChecked": report.receipts_checked,
        "danglingReceipts": report.dangling_receipts,
    });

    if clean {
        eprintln!(
            "centraid: doctor: clean — pages sound, {} foreign keys hold, {} receipt(s) checked",
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
    println!("{document:#}");
    exit::REFUSED
}
