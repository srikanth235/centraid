//! `contracts/assist/export/` is what `nativetools export` writes, committed.
//!
//! The Python side (the trainer, the data builders, `render.py`) and the
//! phone's assistant read the model-facing facts from these files: the tool
//! schemas, the kind card, the phrase and date tables, the error table, the
//! rendered prompts and the model's identity. A committed copy nobody
//! regenerates is a lie with a filename, so this test renders the export to a
//! scratch directory and diffs every file against the committed one, printing
//! the command that regenerates it and the first line that differs.

use std::path::{Path, PathBuf};

use centraid_nativetools::export;

const REGENERATE: &str =
    "cargo run -p centraid-nativetools --bin nativetools -- export contracts/assist/export";

fn committed_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../contracts/assist/export")
}

/// The first differing line of two texts, as a message a reviewer can act on.
fn first_difference(committed: &str, live: &str) -> Option<String> {
    let mut left = committed.lines();
    let mut right = live.lines();
    let mut number = 0;
    loop {
        number += 1;
        match (left.next(), right.next()) {
            (None, None) => return (committed != live).then(|| "the trailing newline".to_owned()),
            (Some(a), Some(b)) if a == b => {}
            (Some(a), Some(b)) => {
                return Some(format!(
                    "line {number}:\n  committed: {a}\n  live:      {b}"
                ));
            }
            (Some(a), None) => {
                return Some(format!(
                    "the committed file has extra lines from line {number}: {a}"
                ));
            }
            (None, Some(b)) => {
                return Some(format!(
                    "the live export has extra lines from line {number}: {b}"
                ));
            }
        }
    }
}

#[test]
fn the_committed_export_is_what_the_binary_writes() {
    let scratch = tempfile::tempdir().unwrap();
    let written = export::export(scratch.path()).expect("the export runs");
    let committed = committed_dir();
    let mut drift = Vec::new();
    for name in &written {
        let live = std::fs::read_to_string(scratch.path().join(name)).unwrap();
        match std::fs::read_to_string(committed.join(name)) {
            Err(error) => drift.push(format!("{name}: not committed ({error})")),
            Ok(fixture) => {
                if let Some(difference) = first_difference(&fixture, &live) {
                    drift.push(format!("{name}: first difference at {difference}"));
                }
            }
        }
    }
    // A committed file the export no longer writes is stale; the README is
    // the one file in the directory that is authored.
    for entry in std::fs::read_dir(&committed).expect("contracts/assist/export exists") {
        let name = entry.unwrap().file_name().to_string_lossy().into_owned();
        if name != "README.md" && !written.contains(&name.as_str()) {
            drift.push(format!("{name}: committed but no longer exported"));
        }
    }
    assert!(
        drift.is_empty(),
        "contracts/assist/export has drifted from `nativetools export`.\nRegenerate: {REGENERATE}\n{}",
        drift.join("\n")
    );
}
