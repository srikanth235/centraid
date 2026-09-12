//! `cargo xtask measure` — the edit-run loop, measured.
//!
//! "Compile time is the new Hermes" (#1020): the reason v0's TypeScript felt
//! fast was the edit-run loop, and a large Rust workspace can lose it. Three
//! numbers say whether it has been lost, and they are the ones a developer
//! actually waits on:
//!
//! * `cleanCheckSeconds` — `cargo check --workspace` from an empty `target/`.
//! * `incrementalCheckSeconds` — the same after a ONE-LINE edit in a member
//!   crate. This is the number the structural answers in the issue (one crate
//!   per app, mold, sccache, optimised dependencies in the dev profile) exist
//!   to hold down.
//! * `singleCrateTestSeconds` — one crate's tests, the loop a red test puts you
//!   in.
//!
//! This subcommand is the ONLY writer of `contracts/ledgers/compile-time.json`.
//! A gate run measures and reports; it never writes, because a ratchet that
//! records whatever the last run cost is a log, not a ratchet.
//!
//! What the ledger stores is a **ceiling with stated headroom**, not the last
//! measurement — the same shape as `gate-budgets.json`, and for the same
//! reason: the workspace is one crate today and a dozen after wave 2, so a
//! ceiling pinned to today's number would fail the gate the first time a crate
//! landed, and the author would learn to widen ledgers. `--write` therefore
//! only ever LOWERS `budgetSeconds`, and says so for every key it holds. The
//! measurement itself is printed, quoted in the ledger's `headroom` prose and
//! in the receipt; it is not a second number to ratchet.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Instant;

use anyhow::{Context, Result, bail};

use crate::gate::DEFAULT_HARDWARE;
use crate::ledger::COMPILE_TIME;

/// The three keys, in the order they are printed and stored.
const KEYS: [&str; 3] = [
    "cleanCheckSeconds",
    "incrementalCheckSeconds",
    "singleCrateTestSeconds",
];

pub fn run(root: &Path, write: bool) -> Result<()> {
    let hardware =
        std::env::var("CENTRAID_GATE_HARDWARE").unwrap_or_else(|_| DEFAULT_HARDWARE.to_owned());
    println!("xtask measure — hardware {hardware}");

    let clean = time(root, "cargo", &["clean"]).and_then(|_| {
        println!("  target/ cleaned");
        time(root, "cargo", &["check", "--workspace"])
    })?;
    println!("  cleanCheckSeconds        {clean:>8.1}");

    let touched = touch_first_member(root)?;
    let incremental = time(root, "cargo", &["check", "--workspace"]);
    restore(&touched)?;
    let incremental = incremental?;
    println!(
        "  incrementalCheckSeconds  {incremental:>8.1}  (one line appended to {})",
        touched.relative
    );

    let single = time(root, "cargo", &["test", "-p", "xtask"])?;
    println!("  singleCrateTestSeconds   {single:>8.1}");

    if !write {
        println!("\n  not written — pass `--write` to update {COMPILE_TIME}");
        return Ok(());
    }
    let measured = [clean, incremental, single];
    let notes = merge(root, &hardware, &measured)?;
    println!("\n  {COMPILE_TIME} updated");
    for note in notes {
        println!("  {note}");
    }
    Ok(())
}

/// Lower each ceiling the measurement beats; hold every other one.
///
/// Returns one note per key — what happened and why — because a writer that
/// changes a ratchet silently is how a ratchet stops meaning anything.
fn merge(root: &Path, hardware: &str, measured: &[f64; 3]) -> Result<Vec<String>> {
    let path = root.join(COMPILE_TIME);
    let mut document: serde_json::Value = match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).with_context(|| format!("{COMPILE_TIME} JSON"))?,
        Err(_) => serde_json::json!({
            "_comment": "Down-only (#1020). `budgetSeconds` is a ceiling on the edit-run loop and may only fall; `cargo xtask measure --write` is its only writer and only ever lowers it. `headroom` states what the gap between the ceiling and the measured number is for. Keyed by hardware class, in the vocabulary of tests/journeys.json.",
            "measurements": {}
        }),
    };
    let mut notes = Vec::new();
    let fresh = document
        .get("measurements")
        .and_then(|measurements| measurements.get(hardware))
        .is_none();
    let entry = document
        .get_mut("measurements")
        .and_then(serde_json::Value::as_object_mut)
        .context("the ledger has no `measurements` object")?
        .entry(hardware.to_owned())
        .or_insert_with(|| serde_json::json!({}));
    let entry = entry
        .as_object_mut()
        .context("the hardware entry is not an object")?;
    if fresh {
        notes.push(format!(
            "SEEDED a new hardware entry `{hardware}` from the measurements. State the headroom for each key by hand before committing — a ceiling with no stated headroom is a ceiling nobody can widen honestly."
        ));
    }
    for (index, key) in KEYS.iter().enumerate() {
        let rounded = (measured[index] * 10.0).round() / 10.0;
        let slot = entry
            .entry((*key).to_owned())
            .or_insert_with(|| serde_json::json!({ "budgetSeconds": rounded, "headroom": "" }));
        let slot = slot
            .as_object_mut()
            .with_context(|| format!("`{key}` is not an object"))?;
        let committed = slot
            .get("budgetSeconds")
            .and_then(serde_json::Value::as_f64);
        match committed {
            Some(was) if rounded < was => {
                slot.insert("budgetSeconds".to_owned(), serde_json::Value::from(rounded));
                notes.push(format!(
                    "LOWERED {key} {was:.1} -> {rounded:.1} (measured {:.1})",
                    measured[index]
                ));
            }
            Some(was) => notes.push(format!(
                "HELD {key} at {was:.1}; measured {:.1}. The ceiling only falls, and a measurement above it is a regression to fix, not a number to record.",
                measured[index]
            )),
            None => {
                slot.insert("budgetSeconds".to_owned(), serde_json::Value::from(rounded));
                notes.push(format!("SET {key} to {rounded:.1}"));
            }
        }
    }
    let mut text = serde_json::to_string_pretty(&document)?;
    text.push('\n');
    fs::write(&path, text).with_context(|| format!("write {COMPILE_TIME}"))?;
    Ok(notes)
}

struct Touched {
    path: PathBuf,
    relative: String,
    original: String,
}

/// Append one comment line to the first workspace member's entry file.
fn touch_first_member(root: &Path) -> Result<Touched> {
    let crates = root.join("crates");
    let mut candidates: Vec<PathBuf> = Vec::new();
    let Ok(entries) = fs::read_dir(&crates) else {
        bail!("no crates/ directory to touch");
    };
    for entry in entries.flatten() {
        for name in ["src/lib.rs", "src/main.rs"] {
            let candidate = entry.path().join(name);
            if candidate.is_file() {
                candidates.push(candidate);
            }
        }
    }
    candidates.sort();
    let path = candidates
        .into_iter()
        .next()
        .context("no member crate with a src/lib.rs or src/main.rs to touch")?;
    let original = fs::read_to_string(&path)?;
    let mut touched = original.clone();
    touched.push_str("// `cargo xtask measure` touched this line and restored it.\n");
    fs::write(&path, touched)?;
    let relative = path
        .strip_prefix(root)
        .unwrap_or(&path)
        .to_string_lossy()
        .replace('\\', "/");
    Ok(Touched {
        path,
        relative,
        original,
    })
}

fn restore(touched: &Touched) -> Result<()> {
    fs::write(&touched.path, &touched.original)
        .with_context(|| format!("restore {}", touched.relative))
}

fn time(root: &Path, program: &str, args: &[&str]) -> Result<f64> {
    let started = Instant::now();
    let output = Command::new(program)
        .args(args)
        .current_dir(root)
        .output()
        .with_context(|| format!("spawn `{program} {}`", args.join(" ")))?;
    if !output.status.success() {
        bail!(
            "`{program} {}` failed:\n{}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
    }
    Ok(started.elapsed().as_secs_f64())
}
