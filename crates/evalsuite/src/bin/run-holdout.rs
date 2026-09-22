//! # `run-holdout` — the SCENARIO holdout's reference gate
//!
//! `holdout.json` is a THIRD corpus, and the only one of the three that is
//! written over a different world.
//!
//! | corpus | world | what it holds out |
//! |---|---|---|
//! | `suite.json` | 1 (Sam Whitaker) | nothing — it is the primary |
//! | `blind.json` | 1 (Sam Whitaker) | **the WORDING** |
//! | `holdout.json` | 2 (Dara Okonjo) | **the SCENARIO** |
//!
//! A third of `blind.json`'s handles are rows `suite.json` also names and half
//! its requests share a three-gram with a primary one, so a candidate that has
//! memorised *this cast, this trip, this dentist* transfers across it
//! unpunished. `holdout.json` names no person, place, trip or merchant either
//! of the others does; a candidate that scores well on the blind set and badly
//! here has learned the household rather than the vault, and there is no other
//! way to see that happening.
//!
//! This runs the holdout's own hand-written reference over it and **exits
//! non-zero if anything fails**, exactly as `run-reference` and `run-blind` do
//! for the other two. Until it is green, no number taken off the holdout means
//! anything: an unreachable case looks identical to a hard one in a
//! candidate's score.
//!
//! ```text
//! cargo run -p centraid-evalsuite --bin run-holdout           # crates/evalsuite/holdout.json
//! cargo run -p centraid-evalsuite --bin run-holdout -- <path>
//! ```

use std::path::PathBuf;
use std::process::ExitCode;

use centraid_evalsuite::holdoutref::HoldoutReference;
use centraid_evalsuite::{Suite, WorldTemplate, run};

#[expect(
    clippy::cast_precision_loss,
    reason = "a pass rate over a suite of tens of sessions"
)]
fn rate(passed: usize, total: usize) -> f64 {
    if total == 0 {
        return 0.0;
    }
    passed as f64 * 100.0 / total as f64
}

fn main() -> ExitCode {
    let path = std::env::args().nth(1).map_or_else(
        || PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("holdout.json"),
        PathBuf::from,
    );
    let mut suite = match Suite::read(&path) {
        Ok(suite) => suite,
        Err(complaint) => {
            eprintln!("the holdout set does not read: {complaint}");
            return ExitCode::FAILURE;
        }
    };
    println!(
        "holdout set {} — {} session(s), {} turn(s), today {}",
        path.display(),
        suite.sessions.len(),
        suite.sessions.iter().map(|s| s.turns.len()).sum::<usize>(),
        suite.today
    );

    // **THE SECOND WORLD.** A holdout over the first one would be a second
    // wording set; the whole claim of this corpus is the scenario it is
    // written against.
    let template = match WorldTemplate::build_scenario(centraid_evalworld::Scenario::Second) {
        Ok(template) => template,
        Err(complaint) => {
            eprintln!("the second world does not build: {complaint}");
            return ExitCode::FAILURE;
        }
    };
    println!(
        "world 2 seeded — {} rows across {} app(s), seed {}",
        template.inventory.entities.len(),
        template.inventory.counts().len(),
        template.inventory.seed
    );

    if let Err(complaint) = suite.resolve(&template.inventory) {
        eprintln!("the holdout set does not resolve against world 2:\n{complaint}");
        return ExitCode::FAILURE;
    }

    let report = match run(&suite, &template, &HoldoutReference) {
        Ok(report) => report,
        Err(complaint) => {
            eprintln!("the run did not finish: {complaint}");
            return ExitCode::FAILURE;
        }
    };

    let (passed, total) = report.strict_sessions();
    println!("\ncandidate: {}", report.candidate);
    println!(
        "\nSESSIONS PASSED (strict, the headline): {passed}/{total}  {:.1}%",
        rate(passed, total)
    );
    println!(
        "GRADED SESSION SCORE (F1 per rows turn):  {:.1}%",
        report.graded_score() * 100.0
    );

    println!(
        "\n{:<20} {:>10} {:>10} {:>10}",
        "category", "sessions", "strict", "graded"
    );
    for (category, passed, total, grade) in report.by_category_graded() {
        println!(
            "{category:<20} {:>10} {:>9.1}% {:>9.1}%",
            format!("{passed}/{total}"),
            rate(passed, total),
            grade * 100.0
        );
    }

    let combination = report.combination_only();
    if !combination.is_empty() {
        println!("\nSCOREABLE ONLY IN COMBINATION ({}):", combination.len());
        for (key, request) in &combination {
            println!("  {key} {request:?}");
        }
    }
    let undeclared = report.undeclared_ordering();
    if !undeclared.is_empty() {
        println!("\nUNDECLARED ORDERING ({}):", undeclared.len());
        for (key, request) in &undeclared {
            println!("  {key} {request:?}");
        }
    }
    let partial = report.partial_rows();
    if !partial.is_empty() {
        println!("\nPARTLY RIGHT ({} turn(s)):", partial.len());
        for (session, turn) in partial {
            if let Some(overlap) = &turn.overlap {
                println!(
                    "  {} {:?}\n      {}/{} returned, {} extra; missing {:?}",
                    session.id,
                    turn.request,
                    overlap.hit,
                    overlap.expected,
                    overlap.extra.len(),
                    overlap.missing
                );
            }
        }
    }

    let failures = report.failures();
    if failures.is_empty() {
        println!("\n0 failures — every holdout case is reachable by hand, in world 2.");
        return ExitCode::SUCCESS;
    }
    println!("\n{} FAILING SESSION(S):", failures.len());
    for session in failures {
        for turn in &session.turns {
            if let Some(complaint) = &turn.complaint {
                println!(
                    "  {} [{}] {:?}\n      {complaint}",
                    session.id, session.category, turn.request
                );
            }
        }
    }
    ExitCode::FAILURE
}
