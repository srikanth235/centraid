//! # `run-reference` — the gate the model never gets past until this is green
//!
//! Runs the hand-written reference over the suite against a freshly dealt
//! world per session, and **exits non-zero if anything fails**. That exit code
//! is the method rule made mechanical: no model run is meaningful until every
//! case in the suite is proved reachable by hand.
//!
//! ```text
//! cargo run -p centraid-evalsuite --bin run-reference           # crates/evalsuite/suite.json
//! cargo run -p centraid-evalsuite --bin run-reference -- <path> # some other suite
//! ```
//!
//! A failing line is not a bug in the reference until somebody has checked
//! which it is. Either the resolution is missing or wrong, or **the case is
//! unreachable** — the expected outcome cannot be produced through the doors
//! that exist. The second is a finding about the product's read and write
//! surface, and papering over it by relaxing the case would hide exactly the
//! thing this run is for.

use std::path::PathBuf;
use std::process::ExitCode;

use centraid_evalsuite::{Suite, WorldTemplate, reference::Reference, run};

#[expect(
    clippy::cast_precision_loss,
    reason = "a pass rate over a suite of tens of sessions"
)]
fn session_rate(passed: usize, total: usize) -> f64 {
    if total == 0 {
        return 0.0;
    }
    passed as f64 * 100.0 / total as f64
}

#[expect(clippy::too_many_lines, reason = "one report, printed in one place")]
fn main() -> ExitCode {
    let path = std::env::args().nth(1).map_or_else(
        || PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("suite.json"),
        PathBuf::from,
    );
    let mut suite = match Suite::read(&path) {
        Ok(suite) => suite,
        Err(complaint) => {
            eprintln!("the suite does not read: {complaint}");
            if !path.exists() {
                eprintln!(
                    "(nothing is at {} yet — pass a path, e.g. src/fixture-suite.json)",
                    path.display()
                );
            }
            return ExitCode::FAILURE;
        }
    };
    println!(
        "suite {} — {} session(s), {} turn(s), today {}",
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

    // THE HANDLES, RESOLVED — before a single turn is judged. `suite.json`
    // holds no uuid, so until this runs the corpus names nothing.
    if let Err(complaint) = suite.resolve(&template.inventory) {
        eprintln!("the suite does not resolve against this world:\n{complaint}");
        return ExitCode::FAILURE;
    }

    let report = match run(&suite, &template, &Reference) {
        Ok(report) => report,
        Err(complaint) => {
            eprintln!("the run did not finish: {complaint}");
            return ExitCode::FAILURE;
        }
    };

    // ---- THE HEADLINE IS A SESSION NUMBER (G4) ----------------------------
    // 38 of this suite's 129 turns fall to some instrument that understands
    // nothing; they survive only because the sessions around them fail. So
    // there is no bare turn count on this page: a turn-level rate is not a
    // score and must not be quotable by accident.
    let (passed_sessions, total_sessions) = report.strict_sessions();
    let (dedup_strict, dedup_units, dedup_grade) = report.deduplicated();
    println!("\ncandidate: {}", report.candidate);
    println!(
        "\nSESSIONS PASSED (strict, the headline): {passed_sessions}/{total_sessions}  {:.1}%",
        session_rate(passed_sessions, total_sessions)
    );
    println!(
        "GRADED SESSION SCORE (F1 per rows turn):  {:.1}%   — partial credit, never a verdict",
        report.graded_score() * 100.0
    );
    println!(
        "DE-DUPLICATED (correlated pairs as one):  {dedup_strict:.1}/{dedup_units} strict, \
         {:.1}% graded",
        dedup_grade * 100.0
    );

    // ---- FAST IS A COLUMN (review item A8) --------------------------------
    // Beside the score and never inside it: what this candidate spent to
    // reach it. A runtime that opens every board and one that asks a single
    // question of the FTS plane score the same and cost two orders of
    // magnitude apart, and until this printed, the harness could not say so.
    print_cost(&report);

    println!(
        "\n{:<24} {:>10} {:>10} {:>10}",
        "category", "sessions", "strict", "graded"
    );
    for (category, passed, total, grade) in report.by_category_graded() {
        println!(
            "{category:<24} {:>10} {:>9.1}% {:>9.1}%",
            format!("{passed}/{total}"),
            session_rate(passed, total),
            grade * 100.0
        );
    }

    // THE CORRELATION GROUPS the suite declared (G10).
    let groups = report.correlation_groups();
    println!("\nCORRELATION GROUPS (counted once in the de-duplicated column):");
    if groups.is_empty() {
        println!(
            "  (none declared — every session counts for itself, and `s71`/`s02` \
             and `s65`/`s09` are therefore counted twice)"
        );
    } else {
        for (name, members) in &groups {
            println!("  {name}: {members:?}");
        }
    }

    // DECLINING, AS PRECISION AND RECALL — and what each reason can actually
    // tell apart (G11). The caveat is printed WITH the number, never under it:
    // decline precision is not competence, and 0% recall is not evidence.
    println!(
        "\n{:<10} {:>9} {:>8} {:>10} {:>8}",
        "decline", "declined", "correct", "precision", "recall"
    );
    for score in report.decline_scores() {
        let rate = |value: Option<f64>| {
            value.map_or_else(|| "     —".to_owned(), |value| format!("{:>5.1}%", value * 100.0))
        };
        println!(
            "{:<10} {:>9} {:>8} {:>10} {:>8}",
            score.reason,
            score.declined,
            score.correct,
            rate(score.precision()),
            rate(score.recall())
        );
        println!("{:<10} {}", "", score.caveat());
    }

    // ---- WHAT THESE NUMBERS DO NOT COVER ----------------------------------
    let combination = report.combination_only();
    println!(
        "\nSCOREABLE ONLY IN COMBINATION ({} turn(s)) — each expects an EMPTY answer, \
         so answering nothing passes it:",
        combination.len()
    );
    for (key, request) in &combination {
        println!("  {key} {request:?}");
    }

    let undeclared = report.undeclared_ordering();
    println!(
        "\nUNDECLARED ORDERING ({} turn(s)) — `ordered: true` with no `order_by`. \
         The sequence IS scored strictly; the case never said which sort it is:",
        undeclared.len()
    );
    for (key, request) in &undeclared {
        println!("  {key} {request:?}");
    }
    println!(
        "  (ordering BETWEEN the writes of a write_set is refused outright: \
         predicates read end state, and end state cannot witness write order.)"
    );

    // PARTLY RIGHT IS NOT THE SAME AS WRONG. The verdict stays all-or-nothing;
    // the graded column above is where partial rows are paid for, and this is
    // the per-id detail behind it.
    let partial = report.partial_rows();
    if !partial.is_empty() {
        println!("\nPARTLY RIGHT ({} turn(s)) — graded, never passed:", partial.len());
        for (session, turn) in partial {
            if let Some(overlap) = &turn.overlap {
                println!(
                    "  {} {:?}\n      {}/{} expected returned, {} extra, F1 {:.2}; missing {:?}",
                    session.id,
                    turn.request,
                    overlap.hit,
                    overlap.expected,
                    overlap.extra.len(),
                    overlap.f1(),
                    overlap.missing
                );
            }
        }
    }

    // A write_set that half-held is a DIAGNOSTIC and is paid nothing: half a
    // bulk edit is worse than none of it.
    let half_written = report.partial_write_sets();
    if !half_written.is_empty() {
        println!("\nHALF-APPLIED WRITE SETS — diagnostic, graded 0:");
        for (key, complaint) in &half_written {
            println!("  {key}  {complaint}");
        }
    }

    let failures = report.failures();
    if failures.is_empty() {
        println!("\n0 failures — every case is reachable by hand.");
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
    println!(
        "\nEach line is one of two things: a missing or wrong reference resolution, \
         or a case whose expected outcome no runtime could reach through the doors \
         that exist. Decide which before changing either."
    );
    ExitCode::FAILURE
}

/// The cost columns, for any report. Totals, per-door, and the per-turn
/// distribution — a mean would hide the one turn that scanned eight boards,
/// and that turn is the finding.
pub fn print_cost(report: &centraid_evalsuite::Report) {
    let cost = report.cost();
    let ms = |micros: u128| {
        #[expect(clippy::cast_precision_loss, reason = "a duration in microseconds")]
        let value = micros as f64 / 1000.0;
        value
    };
    println!(
        "\nCOST — measured, never scored ({} turn(s)):\n           {:<10} {:>9} {:>11} {:>12}",
        cost.turns, "door", "calls", "rows", "ms"
    );
    for (door, bill) in &cost.total.doors {
        println!(
            "  {door:<10} {:>9} {:>11} {:>12.1}",
            bill.calls,
            bill.rows,
            ms(bill.micros)
        );
    }
    println!(
        "  {:<10} {:>9} {:>11} {:>12.1}",
        "TOTAL",
        cost.total.calls(),
        cost.total.rows(),
        ms(cost.total.micros)
    );
    println!(
        "  per turn   p50/p95/max   calls {}/{}/{}   rows {}/{}/{}   ms {:.1}/{:.1}/{:.1}",
        cost.calls.p50,
        cost.calls.p95,
        cost.calls.max,
        cost.rows.p50,
        cost.rows.p95,
        cost.rows.max,
        ms(cost.micros.p50),
        ms(cost.micros.p95),
        ms(cost.micros.max)
    );
    println!(
        "  harness overhead, charged to nobody: {} full vault scan(s) costing {:.1} ms \
         (one per turn that moved a row, not one per turn), and {:.1} ms dealing one \
         private world per session",
        report.scans,
        ms(report.scan_micros),
        ms(report.setup_micros)
    );
    let worst = report.costliest(3);
    if !worst.is_empty() {
        println!("  costliest turns:");
        for (key, request, turn) in worst {
            println!(
                "    {key:<8} {:>7.1} ms  {:>3} call(s) {:>7} row(s)  {request:?}",
                ms(turn.micros),
                turn.calls(),
                turn.rows()
            );
        }
    }
}
