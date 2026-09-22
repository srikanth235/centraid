//! # `run-model` — a TRAINED MODEL's canonicals, scored through the executor
//!
//! ```text
//! cargo run -p centraid-candidates --bin run-model -- \
//!     --outputs experiments/canon-model/out/flan-t5-small.free.jsonl --corpus all
//! ```
//!
//! [`run-oracle`](../run-oracle.rs) prints the CEILING (gold canonical +
//! executor). This prints the same executor handed a fine-tuned seq2seq
//! model's own output, read from a JSONL file written before anything parsed
//! it. A missing or unparseable canonical is a FAILED turn and is counted as
//! one — nothing here repairs the model's string.

use std::process::ExitCode;

use centraid_evalsuite::Report;

#[expect(clippy::cast_precision_loss, reason = "a rate over tens of sessions")]
fn rate(passed: usize, total: usize) -> f64 {
    if total == 0 {
        return 0.0;
    }
    passed as f64 * 100.0 / total as f64
}

fn ms(micros: u128) -> f64 {
    #[expect(clippy::cast_precision_loss, reason = "a duration in microseconds")]
    let value = micros as f64 / 1000.0;
    value
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut corpora: Vec<String> = Vec::new();
    let mut outputs: Option<String> = None;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--outputs" => {
                index += 1;
                outputs = args.get(index).cloned();
            }
            "--corpus" => {
                index += 1;
                let name = args.get(index).cloned().unwrap_or_else(|| "suite".into());
                if name == "all" {
                    corpora.extend(["suite".into(), "blind".into(), "holdout".into()]);
                } else if matches!(name.as_str(), "suite" | "blind" | "holdout") {
                    corpora.push(name);
                } else {
                    eprintln!("--corpus must be suite, blind, holdout or all");
                    return ExitCode::FAILURE;
                }
            }
            other => {
                eprintln!("unknown argument {other:?}");
                return ExitCode::FAILURE;
            }
        }
        index += 1;
    }
    let Some(outputs) = outputs else {
        eprintln!("--outputs <model-output.jsonl> is required");
        return ExitCode::FAILURE;
    };
    if corpora.is_empty() {
        corpora.push("suite".into());
    }

    for corpus in &corpora {
        let report = match centraid_candidates::model_report(corpus, std::path::Path::new(&outputs))
        {
            Ok(report) => report,
            Err(complaint) => {
                eprintln!("{complaint}");
                return ExitCode::FAILURE;
            }
        };
        print_report(corpus, &report);
    }
    ExitCode::SUCCESS
}

fn print_report(corpus: &str, report: &Report) {
    let (passed, total) = report.strict_sessions();
    let (dedup_strict, dedup_units, dedup_grade) = report.deduplicated();
    println!("\n================ corpus: {corpus} ================");
    println!("candidate: {}", report.candidate);
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
}
