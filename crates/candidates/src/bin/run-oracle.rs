//! # `run-oracle` — the executor's ceiling, over any of the three corpora
//!
//! ```text
//! cargo run -p centraid-candidates --bin run-oracle -- --corpus suite
//! cargo run -p centraid-candidates --bin run-oracle -- --corpus blind
//! cargo run -p centraid-candidates --bin run-oracle -- --corpus holdout
//! ```
//!
//! It prints the standard report — the session headline, the graded score, the
//! cost columns — and then a PER-TURN FAILURE LIST, because the ceiling is only
//! useful if each thing under it is named.
//!
//! **The number this prints is a ceiling and not a candidate's score.** The
//! oracle is handed the gold canonical; only the executor is being measured.

use std::process::ExitCode;

use centraid_evalsuite::Report;

#[expect(
    clippy::cast_precision_loss,
    reason = "a pass rate over tens of sessions"
)]
fn rate(passed: usize, total: usize) -> f64 {
    if total == 0 {
        return 0.0;
    }
    passed as f64 * 100.0 / total as f64
}

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let mut corpus = "suite".to_owned();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--corpus" => corpus = args.next().unwrap_or_else(|| "suite".to_owned()),
            other => {
                eprintln!("unknown argument {other:?}; expected --corpus suite|blind|holdout");
                return ExitCode::FAILURE;
            }
        }
    }
    if !matches!(corpus.as_str(), "suite" | "blind" | "holdout") {
        eprintln!("--corpus must be suite, blind or holdout");
        return ExitCode::FAILURE;
    }
    let report = match centraid_candidates::oracle_report(&corpus) {
        Ok(report) => report,
        Err(complaint) => {
            eprintln!("{complaint}");
            return ExitCode::FAILURE;
        }
    };
    print_report(&corpus, &report);
    ExitCode::SUCCESS
}

fn print_report(corpus: &str, report: &Report) {
    let (passed, total) = report.strict_sessions();
    let (dedup_strict, dedup_units, dedup_grade) = report.deduplicated();
    println!("\ncorpus: {corpus}\ncandidate: {}", report.candidate);
    println!(
        "\nSESSIONS PASSED (strict, the headline): {passed}/{total}  {:.1}%",
        rate(passed, total)
    );
    println!(
        "GRADED SESSION SCORE (F1 per rows turn):  {:.1}%",
        report.graded_score() * 100.0
    );
    println!(
        "DE-DUPLICATED (correlated pairs as one):  {dedup_strict:.1}/{dedup_units} strict, \
         {:.1}% graded",
        dedup_grade * 100.0
    );
    let turns: usize = report.sessions.iter().map(|s| s.turns.len()).sum();
    let turns_passed: usize = report
        .sessions
        .iter()
        .flat_map(|s| &s.turns)
        .filter(|turn| turn.passed)
        .count();
    println!(
        "TURNS PASSED (diagnostic, never a score): {turns_passed}/{turns}  {:.1}%",
        rate(turns_passed, turns)
    );

    let cost = report.cost();
    let ms = |micros: u128| {
        #[expect(clippy::cast_precision_loss, reason = "a duration in microseconds")]
        let value = micros as f64 / 1000.0;
        value
    };
    println!(
        "\nCOST — measured, never scored ({} turn(s)):\n  {:<10} {:>9} {:>11} {:>12}",
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

    // THE ROUND TRIPS. Recursion compiles to a SEQUENCE of door reads
    // (GRAMMAR.md §4), so the door-call count per turn IS the depth budget the
    // grammar's §1 bound is a budget on. The distribution is the finding.
    let mut trips: Vec<usize> = report
        .sessions
        .iter()
        .flat_map(|session| &session.turns)
        .map(|turn| turn.cost.calls())
        .collect();
    trips.sort_unstable();
    let mut histogram = std::collections::BTreeMap::new();
    for count in &trips {
        *histogram.entry(*count).or_insert(0usize) += 1;
    }
    println!("\nROUND TRIPS PER TURN (door calls; the sequence compilation's cost):");
    for (count, how_many) in &histogram {
        println!("  {count:>3} call(s): {how_many:>4} turn(s)");
    }
    if let Some(max) = trips.last() {
        let total: usize = trips.iter().sum();
        #[expect(clippy::cast_precision_loss, reason = "a mean over hundreds of turns")]
        let mean = total as f64 / trips.len() as f64;
        println!(
            "  max {max}, median {}, mean {mean:.2}",
            trips[trips.len() / 2]
        );
    }

    println!(
        "\n{:<24} {:>10} {:>10} {:>10}",
        "category", "sessions", "strict", "graded"
    );
    for (category, passed, total, grade) in report.by_category_graded() {
        println!(
            "{category:<24} {:>10} {:>9.1}% {:>9.1}%",
            format!("{passed}/{total}"),
            rate(passed, total),
            grade * 100.0
        );
    }

    // THE CANONICAL BESIDE THE FAILURE. A failing turn is one of three things
    // (an executor bug, an underspecified rule, a door that cannot serve it)
    // and none of them can be told apart without the tree that was executed.
    let mapped = centraid_candidates::map::read(&centraid_candidates::map::default_path())
        .unwrap_or_default();
    let mut failures = Vec::new();
    for session in &report.sessions {
        for (at, turn) in session.turns.iter().enumerate() {
            if let Some(complaint) = &turn.complaint {
                let canonical = mapped
                    .get(&(corpus.to_owned(), session.id.clone(), at))
                    .map_or("(unmapped)", |found| found.canonical.as_str());
                let mut plan = format!("{:?}", turn.plan);
                plan.truncate(160);
                let mut complaint = complaint.clone();
                complaint.truncate(400);
                failures.push(format!(
                    "  {}.{at:<2} [{}] {:?}\n        canon {canonical}\n        plan  {plan}\n        {complaint}",
                    session.id, session.category, turn.request
                ));
            }
        }
    }
    println!("\nFAILING TURNS ({}):", failures.len());
    for line in &failures {
        println!("{line}");
    }
}
