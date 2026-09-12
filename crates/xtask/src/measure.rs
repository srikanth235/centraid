//! `cargo xtask measure` — the edit-run loop, measured.
//!
//! "Compile time is the new Hermes" (#1020): the reason v0's TypeScript felt
//! fast was the edit-run loop, and a large Rust workspace can lose it. Five
//! numbers say whether it has been lost, and they are the ones a developer
//! actually waits on:
//!
//! * `cleanCheckSeconds` — `cargo check --workspace` from an empty `target/`.
//! * `incrementalCheckSeconds` — the same after a ONE-LINE edit in an APP
//!   crate. This is the number the structural answers in the issue (one crate
//!   per app, mold, sccache, optimised dependencies in the dev profile) exist
//!   to hold down, and the one number whose meaning is the promise itself.
//! * `singleCrateTestSeconds` — one crate's tests, the loop a red test puts you
//!   in, measured on the heaviest crate rather than the cheapest.
//! * `releaseBuildSeconds` — `cargo build --workspace --release` from an empty
//!   `target/release`, the one compile-time number a pull request goes red on.
//! * `coldLocalProfileSeconds` — `cargo xtask gate --profile local` on a tree
//!   with no debug artifacts: the first build after a clone or a `cargo clean`,
//!   which is NOT the warm feedback-time budget and has its own ceiling
//!   (D-1020-B2-1).
//!
//! Every key costs minutes and two of them delete build output, so `--only`
//! selects a subset: re-measuring one number must not force a re-measurement of
//! all of them on a container whose disk is shared.
//!
//! This subcommand is the ONLY writer of `contracts/ledgers/compile-time.json`.
//! A gate run measures and reports; it never writes, because a ratchet that
//! records whatever the last run cost is a log, not a ratchet.
//!
//! What the ledger stores is a **ceiling with stated headroom**, not the last
//! measurement — the same shape as `gate-budgets.json`, and for the same
//! reason: the workspace grows a crate a wave, so a ceiling pinned to today's
//! number would fail the gate the first time a crate landed, and the author
//! would learn to widen ledgers. `--write` therefore only ever LOWERS
//! `budgetSeconds`, and says so for every key it holds. The measurement itself
//! is printed, quoted in the ledger's `headroom` prose and in the receipt; it is
//! not a second number to ratchet.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Instant;

use anyhow::{Context, Result, bail};

use crate::gate::{COLD_LOCAL_KEY, DEFAULT_HARDWARE};
use crate::ledger::COMPILE_TIME;

/// The app crate whose one-line edit `incrementalCheckSeconds` is measured on.
///
/// The issue's number is "incremental `cargo check` after a one-line edit in an
/// APP crate", not in whichever member sorts first: an app crate is a leaf, and
/// a leaf is the case the "one crate per app" answer is supposed to protect. An
/// edit in a root library rebuilds everything downstream and is a different
/// measurement.
const APP_CRATE_ENTRY: [&str; 2] = [
    "crates/apps/tally/src/main.rs",
    "crates/apps/tally/src/lib.rs",
];

/// The crate `singleCrateTestSeconds` is measured on: the heaviest one, because
/// the number is a promise about the worst red-test loop and not the best.
/// `centraid-net` carries iroh, quinn and tokio; nothing else in the workspace
/// links more.
const HEAVIEST_CRATE: &str = "centraid-net";

/// One measurable key: its ledger name, the one line that says what it times,
/// and how it is taken.
struct Key {
    name: &'static str,
    what: &'static str,
    take: fn(&Path) -> Result<f64>,
}

const KEYS: [Key; 5] = [
    Key {
        name: "cleanCheckSeconds",
        what: "`cargo check --workspace` from an empty target/",
        take: take_clean_check,
    },
    Key {
        name: "incrementalCheckSeconds",
        what: "`cargo check --workspace` after one line appended to an app crate",
        take: take_incremental_check,
    },
    Key {
        name: "singleCrateTestSeconds",
        what: "`cargo test -p centraid-net`, the heaviest crate, link included",
        take: take_single_crate_test,
    },
    Key {
        name: "releaseBuildSeconds",
        what: "`cargo build --workspace --release` from an empty target/release",
        take: take_release_build,
    },
    Key {
        name: COLD_LOCAL_KEY,
        what: "`cargo xtask gate --profile local` with no debug artifacts on disk",
        take: take_cold_local_profile,
    },
];

pub fn run(root: &Path, write: bool, only: &[String]) -> Result<()> {
    let hardware =
        std::env::var("CENTRAID_GATE_HARDWARE").unwrap_or_else(|_| DEFAULT_HARDWARE.to_owned());
    let selected = select(only)?;
    println!(
        "xtask measure — hardware {hardware} · {} of {} key(s)",
        selected.len(),
        KEYS.len()
    );

    let mut measured: Vec<(&'static str, f64)> = Vec::new();
    for key in &selected {
        println!("  measuring {:<24} {}", key.name, key.what);
        let seconds = (key.take)(root).with_context(|| format!("measuring {}", key.name))?;
        println!("  {:<24} {seconds:>8.1}", key.name);
        measured.push((key.name, seconds));
    }

    if !write {
        println!("\n  not written — pass `--write` to update {COMPILE_TIME}");
        return Ok(());
    }
    let notes = merge(root, &hardware, &measured)?;
    println!("\n  {COMPILE_TIME} updated");
    for note in notes {
        println!("  {note}");
    }
    Ok(())
}

/// The keys named by `--only`, or all of them. An unknown key is an error and
/// not a silent no-op: a typo that measured nothing and wrote nothing would look
/// exactly like a clean run.
fn select(only: &[String]) -> Result<Vec<&'static Key>> {
    if only.is_empty() {
        return Ok(KEYS.iter().collect());
    }
    let mut chosen = Vec::new();
    for wanted in only {
        let key = KEYS
            .iter()
            .find(|key| key.name == wanted.trim())
            .with_context(|| {
                format!(
                    "`{wanted}` is not a measurable key. Known keys: {}",
                    KEYS.iter()
                        .map(|key| key.name)
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            })?;
        chosen.push(key);
    }
    Ok(chosen)
}

// ---------------------------------------------------------------------------
// The measurements
// ---------------------------------------------------------------------------

fn take_clean_check(root: &Path) -> Result<f64> {
    time(root, "cargo", &["clean"])?;
    println!("    target/ cleaned");
    time(root, "cargo", &["check", "--workspace"])
}

fn take_incremental_check(root: &Path) -> Result<f64> {
    // The warm state this number means anything in: an edit against a tree that
    // has already been checked. Taken here rather than assumed, so the key can
    // be measured on its own with `--only`.
    time(root, "cargo", &["check", "--workspace"])?;
    let touched = touch_app_crate(root)?;
    let elapsed = time(root, "cargo", &["check", "--workspace"]);
    restore(&touched)?;
    println!("    one line appended to {} and restored", touched.relative);
    elapsed
}

fn take_single_crate_test(root: &Path) -> Result<f64> {
    time(root, "cargo", &["test", "-p", HEAVIEST_CRATE])
}

fn take_release_build(root: &Path) -> Result<f64> {
    remove(&root.join("target/release"))?;
    println!("    target/release removed");
    time(root, "cargo", &["build", "--workspace", "--release"])
}

/// The first build after a clone, timed the way a developer experiences it.
///
/// `target/debug` goes, which takes this binary with it — the child `cargo
/// xtask` rebuilds it, and that rebuild is inside the number ON PURPOSE: on a
/// fresh clone the gate runner is one of the things you wait for. The child's
/// own output is not suppressed, so its `cold` line and per-step table are part
/// of the evidence this subcommand leaves behind.
fn take_cold_local_profile(root: &Path) -> Result<f64> {
    remove(&root.join("target/debug"))?;
    println!("    target/debug removed — the gate runner is rebuilt inside this number");
    let started = Instant::now();
    let status = Command::new("cargo")
        .args(["xtask", "gate", "--profile", "local"])
        .current_dir(root)
        .status()
        .context("spawn `cargo xtask gate --profile local`")?;
    let elapsed = started.elapsed().as_secs_f64();
    if !status.success() {
        bail!(
            "`cargo xtask gate --profile local` failed on the cold tree — the measurement is the wall clock of a PASSING run, and a failing gate has a red step to fix first"
        );
    }
    Ok(elapsed)
}

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

/// Lower each ceiling the measurement beats; hold every other one.
///
/// Returns one note per key — what happened and why — because a writer that
/// changes a ratchet silently is how a ratchet stops meaning anything.
fn merge(root: &Path, hardware: &str, measured: &[(&'static str, f64)]) -> Result<Vec<String>> {
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
    for (key, seconds) in measured {
        let rounded = (seconds * 10.0).round() / 10.0;
        // A key that is not in the ledger yet is inserted WITHOUT a
        // `budgetSeconds`, so the match below reads `None` and reports `SET`.
        // Seeding it with the measurement here would make every new key report
        // `HELD at <the measurement>` — a ceiling pinned to one run while the
        // note claimed nothing had moved.
        let slot = entry
            .entry((*key).to_owned())
            .or_insert_with(|| serde_json::json!({ "headroom": "" }));
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
                    "LOWERED {key} {was:.1} -> {rounded:.1} (measured {seconds:.1})"
                ));
            }
            Some(was) => notes.push(format!(
                "HELD {key} at {was:.1}; measured {seconds:.1}. The ceiling only falls, and a measurement above it is a regression to fix, not a number to record."
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

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

struct Touched {
    path: PathBuf,
    relative: String,
    original: String,
}

/// Append one comment line to an app crate's entry file.
fn touch_app_crate(root: &Path) -> Result<Touched> {
    let path = APP_CRATE_ENTRY
        .iter()
        .map(|candidate| root.join(candidate))
        .find(|candidate| candidate.is_file())
        .with_context(|| {
            format!(
                "none of {} exists — `incrementalCheckSeconds` is the edit-run loop of an APP crate and there is no app crate to edit",
                APP_CRATE_ENTRY.join(", ")
            )
        })?;
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

/// Remove a build directory that may not be there. An absent directory is the
/// state this asks for, so it is not an error.
fn remove(path: &Path) -> Result<()> {
    match fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("remove {}", path.display())),
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_selection_measures_every_key() {
        let all = select(&[]).expect("all keys");
        assert_eq!(all.len(), KEYS.len());
    }

    #[test]
    fn a_selection_measures_exactly_what_it_names() {
        let chosen =
            select(&[COLD_LOCAL_KEY.to_owned(), "cleanCheckSeconds".to_owned()]).expect("two keys");
        assert_eq!(
            chosen.iter().map(|key| key.name).collect::<Vec<_>>(),
            [COLD_LOCAL_KEY, "cleanCheckSeconds"]
        );
    }

    /// A typo must not measure nothing quietly: a run that wrote no key and
    /// reported success is indistinguishable from a clean measurement.
    #[test]
    fn an_unknown_key_is_an_error_that_lists_the_known_ones() {
        let error = match select(&["coldLocalSeconds".to_owned()]) {
            Ok(chosen) => panic!("an unknown key must not select {} key(s)", chosen.len()),
            Err(error) => error,
        };
        let text = format!("{error:#}");
        assert!(text.contains("is not a measurable key"), "{text}");
        assert!(text.contains(COLD_LOCAL_KEY), "{text}");
    }

    /// `--write` is a ratchet, not a recorder: it lowers what the measurement
    /// beat, holds what it did not, and sets only what was never stated.
    #[test]
    fn the_writer_lowers_holds_and_sets_but_never_raises() {
        let root = crate::testing::fixture_dir("measure-merge");
        fs::create_dir_all(root.join("contracts/ledgers")).expect("create the ledger dir");
        fs::write(
            root.join(COMPILE_TIME),
            r#"{"measurements":{"h":{"cleanCheckSeconds":{"budgetSeconds":180,"headroom":"x"},"releaseBuildSeconds":{"budgetSeconds":600,"headroom":"x"}}}}"#,
        )
        .expect("seed the ledger");
        let notes = merge(
            &root,
            "h",
            &[
                ("cleanCheckSeconds", 90.04),
                ("releaseBuildSeconds", 900.0),
                (COLD_LOCAL_KEY, 300.0),
            ],
        )
        .expect("merge");
        assert!(
            notes[0].starts_with("LOWERED cleanCheckSeconds 180.0 -> 90.0"),
            "{notes:?}"
        );
        assert!(
            notes[1].starts_with("HELD releaseBuildSeconds at 600.0"),
            "{notes:?}"
        );
        assert!(
            notes[2].starts_with("SET coldLocalProfileSeconds to 300.0"),
            "{notes:?}"
        );
        let written = fs::read_to_string(root.join(COMPILE_TIME)).expect("read back");
        let document: serde_json::Value = serde_json::from_str(&written).expect("valid json");
        let flat = crate::ledger::numbers(&document);
        assert_eq!(flat["measurements.h.cleanCheckSeconds.budgetSeconds"], 90.0);
        assert_eq!(
            flat["measurements.h.releaseBuildSeconds.budgetSeconds"], 600.0,
            "a measurement above the ceiling is a regression, not a new ceiling"
        );
    }
}
