//! # `run-ranking` — does the score RANK, or does it only floor?
//!
//! ```text
//! cargo run -p centraid-evalsuite --bin run-ranking
//! ```
//!
//! **The finding this answers (review item B14).** Every number this harness
//! had ever produced was either ~100% (the hand-written reference — the answer
//! key) or ~6% (instruments that understand nothing). Nothing had ever been
//! scored in between, so nothing established that the score has a SCALE: that
//! a runtime right four times in five sits above one right half the time, and
//! below the key.
//!
//! [`centraid_evalsuite::degraded::DegradedReference`] is the reference with a
//! dial. It answers correctly with probability `p` and otherwise falls to
//! `KeywordBoth`, the strongest instrument in `nulls` that is not the
//! reference wearing a defect. The sweep is nested and seeded: the same turns
//! degrade at every `p`, so the columns are comparable rather than three
//! independent samples.
//!
//! **Exit non-zero when either corpus is not monotone** in `p`, for strict
//! sessions or for the graded score. A suite that cannot tell 0.5 from 0.9 is
//! a suite nobody should rank candidates with, and that has to be a failure
//! rather than a paragraph.

use std::path::PathBuf;
use std::process::ExitCode;

use centraid_evalsuite::degraded::DegradedReference;
use centraid_evalsuite::reference::Reference;
use centraid_evalsuite::{CandidateRuntime, Suite, WorldTemplate, nulls, run};

#[path = "../blindref.rs"]
mod blindref;

/// The dial settings. `0.0` and `1.0` are the two ends the suite had already
/// been read at; the three in the middle are the ones nothing had ever
/// occupied.
const DIAL: &[f64] = &[0.0, 0.5, 0.7, 0.9, 1.0];
/// Fixed, so the table is reproducible by anybody.
const SEED: u64 = 0x5eed_0f13;

struct Row {
    p: f64,
    strict: f64,
    graded: f64,
    passed: usize,
    total: usize,
    calls: usize,
    rows: usize,
    millis: f64,
}

#[expect(
    clippy::cast_precision_loss,
    reason = "a pass rate over a corpus of tens of sessions"
)]
fn sweep(
    label: &str,
    suite: &Suite,
    template: &WorldTemplate,
    correct: &dyn CandidateRuntime,
) -> Result<Vec<Row>, String> {
    let fallback = nulls::Keyword::both();
    let mut rows = Vec::new();
    for &p in DIAL {
        let runtime = DegradedReference::new(correct, &fallback, p, SEED);
        let report = run(suite, template, &runtime)?;
        let (passed, total) = report.strict_sessions();
        let cost = report.cost();
        rows.push(Row {
            p,
            strict: passed as f64 * 100.0 / total as f64,
            graded: report.graded_score() * 100.0,
            passed,
            total,
            calls: cost.total.calls(),
            rows: cost.total.rows(),
            millis: cost.total.micros as f64 / 1000.0,
        });
        eprintln!("  {label}: p={p:.2} done");
    }
    Ok(rows)
}

fn print(label: &str, rows: &[Row]) {
    println!("\n== {label} ==\n");
    println!(
        "{:>6} {:>14} {:>10} {:>10} {:>10} {:>10}",
        "p", "sessions", "strict", "graded F1", "calls", "ms"
    );
    for row in rows {
        println!(
            "{:>6.2} {:>9}/{:<4} {:>9.1}% {:>9.1}% {:>10} {:>10.1}",
            row.p, row.passed, row.total, row.strict, row.graded, row.calls, row.millis
        );
    }
    let _ = rows.iter().map(|row| row.rows).sum::<usize>();
}

/// Non-decreasing, to a tolerance that is not a licence: a column that goes
/// DOWN as the candidate gets better is a broken score, and 0.0 is the only
/// slack a float comparison needs.
fn monotone(label: &str, rows: &[Row], what: &str, of: impl Fn(&Row) -> f64) -> Vec<String> {
    let mut broken = Vec::new();
    for pair in rows.windows(2) {
        if of(&pair[1]) + 1e-9 < of(&pair[0]) {
            broken.push(format!(
                "{label}: {what} FELL from {:.1}% at p={:.2} to {:.1}% at p={:.2}",
                of(&pair[0]),
                pair[0].p,
                of(&pair[1]),
                pair[1].p
            ));
        }
    }
    broken
}

fn load(path: &PathBuf, template: &WorldTemplate) -> Result<Suite, String> {
    let mut suite = Suite::read(path)?;
    suite.resolve(&template.inventory)?;
    Ok(suite)
}

fn main() -> ExitCode {
    let here = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let template = match WorldTemplate::build() {
        Ok(template) => template,
        Err(complaint) => {
            eprintln!("the world does not build: {complaint}");
            return ExitCode::FAILURE;
        }
    };
    println!(
        "world seeded — {} rows; dial {DIAL:?}, seed {SEED:#x}",
        template.inventory.entities.len()
    );

    let mut broken: Vec<String> = Vec::new();
    for (label, file, correct) in [
        (
            "PRIMARY CORPUS (suite.json)",
            "suite.json",
            &Reference as &dyn CandidateRuntime,
        ),
        (
            "BLIND CORPUS (blind.json)",
            "blind.json",
            &blindref::BlindReference as &dyn CandidateRuntime,
        ),
    ] {
        let suite = match load(&here.join(file), &template) {
            Ok(suite) => suite,
            Err(complaint) => {
                eprintln!("{file}: {complaint}");
                return ExitCode::FAILURE;
            }
        };
        let rows = match sweep(label, &suite, &template, correct) {
            Ok(rows) => rows,
            Err(complaint) => {
                eprintln!("{label}: the sweep did not finish: {complaint}");
                return ExitCode::FAILURE;
            }
        };
        print(label, &rows);
        broken.extend(monotone(label, &rows, "strict sessions", |row| row.strict));
        broken.extend(monotone(label, &rows, "graded F1", |row| row.graded));
    }

    println!(
        "\nRead this as a SCALE, not as a score of anything shipped: the dial is a\n\
         probability of answering correctly, not a model. What it establishes is that\n\
         both columns move with it on both corpora — the suite ranks, and does not\n\
         merely tell the answer key from an empty one.\n\
         The `calls` and `ms` columns are the cost of the same sweep, and they move the\n\
         OTHER way: keyword overlap is cheaper than being right, which is exactly why\n\
         cost is reported beside the score and never inside it."
    );

    if broken.is_empty() {
        println!("\nMONOTONE on both corpora, both columns.");
        return ExitCode::SUCCESS;
    }
    println!("\nNOT MONOTONE — the suite does not rank:");
    for line in &broken {
        println!("  {line}");
    }
    ExitCode::FAILURE
}
