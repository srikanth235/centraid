//! # `run-register` — what the suite costs when the member does not type like a corpus
//!
//! The suite is ONE VOICE: complete sentences, consistent nouns, no typos, no
//! dictation. Real members are not, and in the predecessor experiment register
//! cost more accuracy than any architectural choice did. `registers.json`
//! carries hand-written variants of the suite's own requests — terse
//! fragments, typos, speech, over-polite, imperative, elliptical — each one
//! keeping its turn's id, so the SAME expectation is scored against a
//! different surface.
//!
//! ```text
//! cargo run -p centraid-evalsuite --bin run-register             # every register
//! cargo run -p centraid-evalsuite --bin run-register -- typo     # just one
//! ```
//!
//! ## What the number means, and what it does not
//!
//! **The hand-written reference scores a FLAT ZERO DELTA here, and that is a
//! fact about the reference, not about register.** It resolves a turn by
//! `(session id, turn index)` and never looks at the words at all, so no
//! rewriting of the request can move it. That makes this run a CALIBRATION
//! rather than a result: the machinery is proved to swap text, resolve, run
//! and diff, and the corpus is proved to carry a variant for every turn.
//!
//! Point it at a candidate that reads the words and the delta becomes the
//! measurement — how much of its score was the vault and how much was the
//! corpus's one voice. A candidate whose delta is also zero has either
//! understood every register or keyed on position, and those two are told
//! apart by looking at what it did, not at this number.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::ExitCode;

use centraid_evalsuite::{Report, Suite, WorldTemplate, reference::Reference, run};
use serde::Deserialize;

/// One hand-written variant of one turn.
#[derive(Debug, Clone, Deserialize)]
struct Variant {
    session: String,
    /// 1-based, as the report keys turns.
    turn: usize,
    register: String,
    request: String,
}

#[derive(Debug, Clone, Deserialize)]
struct Registers {
    #[serde(default)]
    registers: BTreeMap<String, String>,
    variants: Vec<Variant>,
}

/// Swap in every variant of this register. Turns with no variant KEEP THEIR
/// BASE TEXT — a register is a way of speaking, not a complete second corpus,
/// and pretending otherwise would mix two changes into one number.
fn substitute(suite: &mut Suite, registers: &Registers, register: &str) -> usize {
    let mut swapped = 0;
    for variant in &registers.variants {
        if variant.register != register {
            continue;
        }
        if let Some(session) = suite
            .sessions
            .iter_mut()
            .find(|session| session.id == variant.session)
            && let Some(turn) = session.turns.get_mut(variant.turn - 1)
        {
            turn.request.clone_from(&variant.request);
            swapped += 1;
        }
    }
    swapped
}

#[expect(clippy::cast_precision_loss, reason = "tens of sessions")]
fn rate(passed: usize, total: usize) -> f64 {
    if total == 0 {
        return 0.0;
    }
    passed as f64 * 100.0 / total as f64
}

/// `session/turn` keys of every turn a run passed.
fn passed_keys(report: &Report) -> std::collections::BTreeSet<String> {
    let mut keys = std::collections::BTreeSet::new();
    for session in &report.sessions {
        for (index, turn) in session.turns.iter().enumerate() {
            if turn.passed {
                keys.insert(format!("{}/t{}", session.id, index + 1));
            }
        }
    }
    keys
}

fn main() -> ExitCode {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let suite_path = root.join("suite.json");
    let registers_path = root.join("registers.json");
    let wanted = std::env::args().nth(1);

    let base_suite = match Suite::read(&suite_path) {
        Ok(suite) => suite,
        Err(complaint) => {
            eprintln!("the suite does not read: {complaint}");
            return ExitCode::FAILURE;
        }
    };
    let registers: Registers = match std::fs::read_to_string(&registers_path)
        .map_err(|error| error.to_string())
        .and_then(|text| serde_json::from_str(&text).map_err(|error| error.to_string()))
    {
        Ok(registers) => registers,
        Err(complaint) => {
            eprintln!("{}: {complaint}", registers_path.display());
            return ExitCode::FAILURE;
        }
    };

    let template = match WorldTemplate::build() {
        Ok(template) => template,
        Err(complaint) => {
            eprintln!("the world does not build: {complaint}");
            return ExitCode::FAILURE;
        }
    };

    let mut base = base_suite.clone();
    if let Err(complaint) = base.resolve(&template.inventory) {
        eprintln!("the suite does not resolve:\n{complaint}");
        return ExitCode::FAILURE;
    }
    let base_report = match run(&base, &template, &Reference) {
        Ok(report) => report,
        Err(complaint) => {
            eprintln!("the base run did not finish: {complaint}");
            return ExitCode::FAILURE;
        }
    };
    let (base_passed, total) = base_report.strict_sessions();
    let base_turns = passed_keys(&base_report);
    println!("candidate: {}", base_report.candidate);
    println!(
        "BASE (the suite as written): {base_passed}/{total} sessions  {:.1}%, \
         {} turn(s) passed, graded {:.1}%",
        rate(base_passed, total),
        base_turns.len(),
        base_report.graded_score() * 100.0
    );
    println!(
        "\n{:<12} {:>9} {:>10} {:>9} {:>10} {:>8}",
        "register", "swapped", "sessions", "strict", "graded", "delta"
    );

    let mut names: Vec<String> = registers
        .variants
        .iter()
        .map(|variant| variant.register.clone())
        .collect();
    names.sort_unstable();
    names.dedup();
    if let Some(wanted) = wanted.as_ref() {
        names.retain(|name| name == wanted);
        if names.is_empty() {
            eprintln!("no register called {wanted:?} is in registers.json");
            return ExitCode::FAILURE;
        }
    }

    let mut lost: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for name in &names {
        let mut suite = base_suite.clone();
        let swapped = substitute(&mut suite, &registers, name);
        if let Err(complaint) = suite.resolve(&template.inventory) {
            eprintln!("{name}: the suite does not resolve:\n{complaint}");
            return ExitCode::FAILURE;
        }
        let report = match run(&suite, &template, &Reference) {
            Ok(report) => report,
            Err(complaint) => {
                eprintln!("{name}: the run did not finish: {complaint}");
                return ExitCode::FAILURE;
            }
        };
        let (passed, _) = report.strict_sessions();
        println!(
            "{name:<12} {swapped:>9} {:>10} {:>8.1}% {:>9.1}% {:>+8}",
            format!("{passed}/{total}"),
            rate(passed, total),
            report.graded_score() * 100.0,
            passed as i64 - base_passed as i64
        );
        lost.insert(
            name.clone(),
            base_turns
                .difference(&passed_keys(&report))
                .cloned()
                .collect(),
        );
    }

    println!("\nWHAT EACH REGISTER IS:");
    for name in &names {
        if let Some(description) = registers.registers.get(name) {
            println!("  {name:<12} {description}");
        }
    }

    // THE TURNS A REGISTER TOOK AWAY. A session rate says how much was lost;
    // this says WHERE, which is the only part a candidate's author can act on.
    println!("\nTURNS PASSED IN THE BASE RUN AND LOST UNDER THE REGISTER:");
    for (name, keys) in &lost {
        println!("  {name} — {} turn(s)", keys.len());
        if !keys.is_empty() {
            println!("      {}", keys.join(" "));
        }
    }
    ExitCode::SUCCESS
}
