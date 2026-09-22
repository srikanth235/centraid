//! # `run-blind` — the blind set's reference gate
//!
//! `blind.json` is a SECOND corpus over the same world, written by a lane that
//! had not read `suite.json`. Its whole purpose is to be scored beside the
//! primary suite: a candidate that does well on one and badly on the other has
//! been fitted to a corpus rather than to the vault, and there is no other way
//! to see that happening.
//!
//! This runs the blind set's own hand-written reference over it and **exits
//! non-zero if anything fails**, exactly as `run-reference` does for the
//! primary suite. Until it is green, no number taken off the blind set means
//! anything: an unreachable case looks identical to a hard one in a
//! candidate's score.
//!
//! ```text
//! cargo run -p centraid-evalsuite --bin run-blind           # crates/evalsuite/blind.json
//! cargo run -p centraid-evalsuite --bin run-blind -- <path>
//! ```

use std::path::PathBuf;
use std::process::ExitCode;

use centraid_evalsuite::{Suite, WorldTemplate, run};

#[path = "../blindref.rs"]
mod blindref;

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
        || PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("blind.json"),
        PathBuf::from,
    );
    let mut suite = match Suite::read(&path) {
        Ok(suite) => suite,
        Err(complaint) => {
            eprintln!("the blind set does not read: {complaint}");
            return ExitCode::FAILURE;
        }
    };
    println!(
        "blind set {} — {} session(s), {} turn(s), today {}",
        path.display(),
        suite.sessions.len(),
        suite.sessions.iter().map(|s| s.turns.len()).sum::<usize>(),
        suite.today
    );

    let template = match WorldTemplate::build() {
        Ok(template) => template,
        Err(complaint) => {
            eprintln!("the world does not build: {complaint}");
            return ExitCode::FAILURE;
        }
    };
    println!(
        "world seeded — {} rows across {} app(s)",
        template.inventory.entities.len(),
        template.inventory.counts().len()
    );

    // THE HANDLES, RESOLVED. The blind set holds no uuid either: it names the
    // same rows through the same mechanism, so the two corpora survive the
    // world growing under them in exactly the same way.
    if let Err(complaint) = suite.resolve(&template.inventory) {
        eprintln!("the blind set does not resolve against this world:\n{complaint}");
        return ExitCode::FAILURE;
    }

    let report = match run(&suite, &template, &blindref::BlindReference) {
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

    println!("\n{:<20} {:>10} {:>10} {:>10}", "category", "sessions", "strict", "graded");
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
        println!("\n0 failures — every blind case is reachable by hand.");
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
