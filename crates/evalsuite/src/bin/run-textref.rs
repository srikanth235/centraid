//! # `run-textref` — the second reference, scored for DISAGREEMENT
//!
//! [`centraid_evalsuite::reference::Reference`] is a position oracle: told
//! which session and turn it is answering. It proves every case *reachable*
//! and can say nothing about whether a case's expected answer is the answer
//! to the case's own sentence, because it never reads one.
//! [`centraid_evalsuite::reference::textref`] does read the sentence and is
//! never told anything else.
//!
//! ```bash
//! cargo run -p centraid-evalsuite --bin run-textref            # suite.json then blind.json
//! cargo run -p centraid-evalsuite --bin run-textref -- <path>  # one corpus
//! ```
//!
//! **A high score here is not the goal and would be a smell.** The output
//! that matters is the DISAGREEMENT LEDGER: every turn where a plain reading
//! of the words landed somewhere the case did not. Each one is adjudicated by
//! hand — the case is wrong, or the rules are — and the ruling is recorded in
//! `DEFECTS.md`. An ABSTENTION (`Declined { reason: "abstain" }`) is the
//! rules saying they do not implement this shape of sentence; it always fails
//! the turn, and it is evidence about the rules, never about the case.
//!
//! The exit code is **not** a pass/fail on the corpus. It is non-zero only
//! when the run could not be made at all.

use std::path::PathBuf;
use std::process::ExitCode;

use centraid_evalsuite::reference::textref::{ABSTAIN, TextReference};
use centraid_evalsuite::{Plan, Suite, WorldTemplate, run};

fn corpora() -> Vec<PathBuf> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    std::env::args().nth(1).map_or_else(
        || vec![root.join("suite.json"), root.join("blind.json")],
        |path| vec![PathBuf::from(path)],
    )
}

fn main() -> ExitCode {
    let template = match WorldTemplate::build() {
        Ok(template) => template,
        Err(complaint) => {
            eprintln!("the world does not build: {complaint}");
            return ExitCode::FAILURE;
        }
    };

    let mut totals = (0usize, 0usize, 0usize);
    for path in corpora() {
        let mut suite = match Suite::read(&path) {
            Ok(suite) => suite,
            Err(complaint) => {
                eprintln!("the corpus does not read: {complaint}");
                return ExitCode::FAILURE;
            }
        };
        if let Err(complaint) = suite.resolve(&template.inventory) {
            eprintln!("the corpus does not resolve against this world:\n{complaint}");
            return ExitCode::FAILURE;
        }
        let report = match run(&suite, &template, &TextReference) {
            Ok(report) => report,
            Err(complaint) => {
                eprintln!("the run did not finish: {complaint}");
                return ExitCode::FAILURE;
            }
        };

        let (mut agreed, mut disagreed, mut abstained) = (0usize, 0usize, 0usize);
        let mut ledger: Vec<String> = Vec::new();
        for session in &report.sessions {
            for turn in &session.turns {
                let abstention = matches!(
                    &turn.plan,
                    Plan::Declined { reason } if reason == ABSTAIN
                );
                if turn.passed {
                    agreed += 1;
                } else if abstention {
                    abstained += 1;
                } else {
                    disagreed += 1;
                    ledger.push(format!(
                        "  {} {:?}\n      textref: {}\n      case:    {}",
                        session.id,
                        turn.request,
                        describe(&turn.plan),
                        turn.complaint.as_deref().unwrap_or("—")
                    ));
                }
            }
        }
        let turns = agreed + disagreed + abstained;
        println!("\n=== {} — {turns} turn(s)", path.display());
        println!("AGREED      {agreed}");
        println!("DISAGREED   {disagreed}   <- adjudicate every one of these");
        println!("ABSTAINED   {abstained}   (no rule for this shape of sentence; not evidence about the case)");
        println!("\nDISAGREEMENT LEDGER:");
        if ledger.is_empty() {
            println!("  (none)");
        }
        for line in &ledger {
            println!("{line}");
        }
        totals.0 += agreed;
        totals.1 += disagreed;
        totals.2 += abstained;
    }

    println!(
        "\nACROSS EVERY CORPUS: agreed {}, disagreed {}, abstained {}",
        totals.0, totals.1, totals.2
    );
    println!(
        "The agreement count is a RATCHET — `crate::tests` refuses a drop. \
         It is not a score: a text-only rules engine that agreed with everything \
         would only mean the corpus had been written to it."
    );
    ExitCode::SUCCESS
}

fn describe(plan: &Plan) -> String {
    match plan {
        Plan::Ids(ids) => format!("{} row(s) {ids:?}", ids.len()),
        Plan::Value(value) => format!("value {value}"),
        Plan::Wrote => "wrote".to_owned(),
        Plan::Declined { reason } => format!("declined {reason:?}"),
    }
}
