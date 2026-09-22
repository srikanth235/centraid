//! # THE BINARIES, UNDER `cargo test`
//!
//! **Review item B15.** `run-blind`, `run-nulls` and `validate-suite` were
//! reports: somebody ran them, read them, and pasted the number into a
//! document. Nothing failed when the blind set stopped passing, when a case
//! stopped being guarded, or when a turn became free — the numbers simply got
//! quieter, because a report with no exit code is a report nobody reruns.
//!
//! So each one is asserted here, from the binary itself rather than from a
//! re-implementation of what it does: an exit code is the contract, and a test
//! that re-derived the answer in Rust would go green while the binary the
//! reader actually runs went wrong.
//!
//! **Cost.** Each of these builds its own seeded world — the binaries are
//! processes, and a process cannot borrow this test's `WorldTemplate`. That is
//! the price of asserting the SHIPPED thing; the properties that can be
//! proved in-process (the cost meter, the digest cache, the ranking scale)
//! live in `src/tests.rs`, where one world is shared by every test in the
//! file. `run-nulls` is the one exception and is named in the README: a full
//! sweep of thirteen instruments over ninety sessions is minutes of work, and
//! it carries its own exit code for CI instead of being spawned from here.

use std::path::PathBuf;
use std::process::Command;

fn manifest() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// Run one of this crate's binaries and hand back `(ok, stdout)`.
fn bin(name: &str, args: &[&str]) -> (bool, String) {
    let exe = match name {
        "run-blind" => env!("CARGO_BIN_EXE_run-blind"),
        "run-holdout" => env!("CARGO_BIN_EXE_run-holdout"),
        "validate-suite" => env!("CARGO_BIN_EXE_validate-suite"),
        "overlap-check" => env!("CARGO_BIN_EXE_overlap-check"),
        other => panic!("no such binary: {other}"),
    };
    let output = Command::new(exe)
        .args(args)
        .output()
        .unwrap_or_else(|error| panic!("{name} does not run: {error}"));
    let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&output.stderr));
    (output.status.success(), text)
}

/// **THE BLIND SET IS REACHABLE BY HAND, ALL OF IT.**
///
/// The same method rule as the primary corpus: a held-out set nobody has
/// proved reachable is a held-out set that will be blamed on the candidate.
#[test]
fn run_blind_passes_every_blind_session() {
    let (ok, text) = bin("run-blind", &[]);
    assert!(ok, "run-blind exited non-zero:\n{text}");
    // The headline line carries `<passed>/<total>`; the test asserts they are
    // EQUAL rather than asserting a literal, so adding a blind session cannot
    // be made green by editing a number in here.
    let headline = text
        .lines()
        .find(|line| line.contains("SESSIONS PASSED"))
        .unwrap_or_else(|| panic!("run-blind printed no headline:\n{text}"));
    let fraction = headline
        .split_whitespace()
        .find(|word| word.contains('/'))
        .unwrap_or_else(|| panic!("no <passed>/<total> in {headline:?}"));
    let (passed, total) = fraction
        .split_once('/')
        .unwrap_or_else(|| panic!("no <passed>/<total> in {fraction:?}"));
    assert_eq!(
        passed.trim(),
        total.trim(),
        "the blind reference no longer reaches every case: {headline}"
    );
    assert!(
        total.trim().parse::<usize>().unwrap_or(0) >= 60,
        "the blind set shrank: {headline}"
    );
}

/// **THE SCENARIO HOLDOUT IS REACHABLE BY HAND, ALL OF IT.**
///
/// `holdout.json` is the third corpus and the only one written over the SECOND
/// seeded world — a disjoint cast, places, weekend away and collision
/// structure, so that one corpus holds out the SCENARIO and not only the
/// wording (`blind.json` shares 58% of its three-grams with the primary set).
/// The gate is the same as the blind set's and for the same reason: an
/// unreachable case looks exactly like a hard one in a candidate's score, and
/// a corpus nobody has proved reachable will be blamed on the candidate.
///
/// It builds a world of its own, which is the price of asserting the SHIPPED
/// binary rather than a re-implementation of it.
#[test]
fn run_holdout_passes_every_holdout_session() {
    let (ok, text) = bin("run-holdout", &[]);
    assert!(ok, "run-holdout exited non-zero:\n{text}");
    let headline = text
        .lines()
        .find(|line| line.contains("SESSIONS PASSED"))
        .unwrap_or_else(|| panic!("run-holdout printed no headline:\n{text}"));
    let fraction = headline
        .split_whitespace()
        .find(|word| word.contains('/'))
        .unwrap_or_else(|| panic!("no <passed>/<total> in {headline:?}"));
    let (passed, total) = fraction
        .split_once('/')
        .unwrap_or_else(|| panic!("no <passed>/<total> in {fraction:?}"));
    assert_eq!(
        passed.trim(),
        total.trim(),
        "the holdout reference no longer reaches every case: {headline}"
    );
    assert!(
        total.trim().parse::<usize>().unwrap_or(0) >= 60,
        "the holdout set shrank: {headline}"
    );
    // AND IT IS THE SECOND WORLD. A holdout accidentally scored against world
    // 1 would fail on every handle at once, but a holdout scored against a
    // world 2 that had drifted back towards world 1 would simply get easier.
    assert!(
        text.contains("centraid-evalworld/2"),
        "run-holdout did not deal the second world:\n{text}"
    );
}

/// **ALL THREE CORPORA VALIDATE.** Handles resolve to exactly one row, every write
/// predicate exists and discriminates, every aggregate is recomputed from the
/// world or excused by name, and no case is satisfied by the untouched world.
#[test]
fn validate_suite_is_clean_on_all_three_corpora() {
    // THREE CORPORA, AND THE THIRD IS OVER A WORLD OF ITS OWN. `--world 2`
    // is not decoration: it decides which inventory the handles resolve
    // against and which world the untouched-world check deals, and a holdout
    // validated against world 1 would fail on every handle at once.
    for (corpus, world_flag, built) in [
        ("suite.json", None, "../../target/eval-world/inventory.json"),
        ("blind.json", None, "../../target/eval-world/inventory.json"),
        (
            "holdout.json",
            Some("2"),
            "../../target/eval-world-2/inventory.json",
        ),
    ] {
        let world = manifest().join(built);
        let suite = manifest().join(corpus);
        let mut args: Vec<String> = vec![suite.display().to_string()];
        if world.exists() {
            args.push(world.display().to_string());
        }
        if let Some(which) = world_flag {
            args.push("--world".to_owned());
            args.push(which.to_owned());
        }
        let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
        let (ok, text) = bin("validate-suite", &borrowed);
        assert!(ok, "validate-suite refuses {corpus}:\n{text}");
    }
}

/// **THE LEAK CHECK CATCHES A LEAK.**
///
/// A checker nobody has shown to fail is a checker that reports "clean"
/// whatever it is handed. This builds a training file out of the corpus's own
/// first request and requires the run to fail on it.
#[test]
fn overlap_check_fails_on_a_planted_collision() {
    let suite: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(manifest().join("suite.json")).expect("read"))
            .expect("suite parses");
    let stolen = suite["sessions"][0]["turns"][0]["request"]
        .as_str()
        .expect("a first request")
        .to_owned();
    let dir = tempfile::tempdir().expect("a temp dir");
    let planted = dir.path().join("train.jsonl");
    std::fs::write(
        &planted,
        format!(
            "{}\n{}\n",
            serde_json::json!({"request": stolen, "template_id": "leaky#0"}),
            serde_json::json!({"request": "something nobody in the corpus says", "template_id": "fine#0"}),
        ),
    )
    .expect("write");
    let (ok, text) = bin("overlap-check", &[&planted.display().to_string()]);
    assert!(
        !ok,
        "overlap-check passed a training file holding a corpus request verbatim:\n{text}"
    );
    // NOT a count: two sessions of the primary corpus open with the same
    // sentence ("what's on my calendar this week?" — `s01` and `s77`), so a
    // planted collision can name more than one turn. What the test asserts is
    // that the stolen request itself is named.
    assert!(
        text.contains(&format!("{stolen:?}")),
        "the collision was not named:\n{text}"
    );

    // AND IT DOES NOT CRY WOLF. The same file without the stolen request has
    // to pass, or the check is just a failing build.
    let clean = dir.path().join("clean.jsonl");
    std::fs::write(
        &clean,
        format!(
            "{}\n",
            serde_json::json!({"request": "something nobody in the corpus says", "template_id": "fine#0"})
        ),
    )
    .expect("write");
    let (ok, text) = bin("overlap-check", &[&clean.display().to_string()]);
    assert!(ok, "overlap-check failed a clean training file:\n{text}");
}
