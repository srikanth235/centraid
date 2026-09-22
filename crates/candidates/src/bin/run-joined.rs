//! # `run-joined` — the tier-D parser wired to the executor, scored for real
//!
//! ```text
//! cargo run -p centraid-candidates --bin run-joined -- --corpus suite|blind|holdout
//! cargo run -p centraid-candidates --bin run-joined -- --registers
//! ```
//!
//! [`run-oracle`](../run-oracle.rs) prints a CEILING: the executor handed the
//! gold canonical. This prints a CANDIDATE: the same executor, with the gold
//! replaced by [`centraid_candidates::parse`]. The two are subtractable and
//! the difference is the price of the paraphrase step.
//!
//! ## The stage attribution is the point
//!
//! A pass rate says how much is broken. It does not say WHERE, and the two
//! halves of this candidate would be fixed by completely different work. So
//! every failing turn is put in one of five buckets, by comparing the raw
//! canonical the parser emitted against `grammar/map.json`'s gold — READ ONLY,
//! after the run, by this binary and never by the candidate:
//!
//! * `parse-unparsed` — the parser abstained. More lexicon, or a real model.
//! * `parse-wrong-skeleton` — it emitted a canonical of the wrong shape. A
//!   confident mistake, and the expensive kind.
//! * `parse-wrong-literal` — the shape matched gold and a LITERAL did not (a
//!   name the lexicon does not carry, a date read wrong). Still the parser's:
//!   the executor executed exactly what it was handed.
//! * `join-rejected` — the rules lane rendered a string `canon` cannot read.
//!   Neither half is wrong; the SEAM is.
//! * `exec-failed-on-correct-canonical` — the canonical matched gold and the
//!   executor still missed. The only bucket `exec.rs` can fix.
//! * `uncovered` — the grammar has no gold for the turn at all.
//!
//! That is the sentence this binary exists to print: *the next dollar goes
//! here*.

use std::collections::BTreeMap;
use std::process::ExitCode;
use std::sync::{Arc, Mutex};

use centraid_candidates::joined::{JoinedRow, Sink};
use centraid_candidates::parse::score::Row as ScoreRow;
use centraid_evalsuite::Report;

// ---------------------------------------------------------------------------
// THE FLOOR AND THE CEILING, so the candidate's number is never read alone.
//
// Floor: the best DEGENERATE instrument in `run-nulls` — an understander of
// nothing. Anything at or below it has demonstrated no comprehension.
// Ceiling: `run-oracle`, the same executor handed the gold canonical.
// ---------------------------------------------------------------------------
/// corpus -> (best null strict, best null graded %, oracle strict, total)
const BOOKENDS: &[(&str, usize, f64, usize, usize)] = &[
    // BoardOnly, the strongest null on the primary corpus (run-nulls, 120 sessions).
    ("suite", 5, 17.7, 114, 120),
    ("blind", 4, 14.8, 60, 60),
    ("holdout", 0, 0.0, 73, 78),
];

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
    let mut registers = false;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
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
            "--registers" => registers = true,
            other => {
                eprintln!("unknown argument {other:?}");
                return ExitCode::FAILURE;
            }
        }
        index += 1;
    }
    if corpora.is_empty() && !registers {
        corpora.push("suite".into());
    }

    let out = std::env::var("JOINED_LOG_DIR").unwrap_or_else(|_| ".".to_owned());

    for corpus in &corpora {
        let path = std::path::Path::new(&out).join(format!("joined-{corpus}.jsonl"));
        let sink = match Sink::to_file(&path) {
            Ok(sink) => Arc::new(Mutex::new(sink)),
            Err(complaint) => {
                eprintln!("{complaint}");
                return ExitCode::FAILURE;
            }
        };
        let report = match centraid_candidates::joined::corpus_report(corpus, &sink) {
            Ok(report) => report,
            Err(complaint) => {
                eprintln!("{complaint}");
                return ExitCode::FAILURE;
            }
        };
        let rows = sink.lock().expect("sink").rows().to_vec();
        print_report(corpus, &report);
        let verdicts = attribute(corpus, &rows, &report);
        rewrite_log(&path, &rows, &verdicts);
        println!("\nraw canonicals + verdicts: {}", path.display());
    }

    if registers {
        let path = std::path::Path::new(&out).join("joined-registers.jsonl");
        let sink = match Sink::to_file(&path) {
            Ok(sink) => Arc::new(Mutex::new(sink)),
            Err(complaint) => {
                eprintln!("{complaint}");
                return ExitCode::FAILURE;
            }
        };
        match centraid_candidates::joined::registers_report(&sink) {
            Ok((report, skipped)) => print_registers(&report, skipped),
            Err(complaint) => {
                eprintln!("{complaint}");
                return ExitCode::FAILURE;
            }
        }
        println!("\nraw canonicals: {}", path.display());
    }
    ExitCode::SUCCESS
}

// ---------------------------------------------------------------------------
// The standard report
// ---------------------------------------------------------------------------

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

    if let Some((_, null_strict, null_graded, ceiling, _)) =
        BOOKENDS.iter().find(|row| row.0 == corpus)
    {
        println!(
            "\nFLOOR / JOINED / CEILING (strict sessions out of {total}):\n  \
             floor (best null)  {null_strict}/{total}  {:.1}%   graded {null_graded:.1}%\n  \
             joined (this run)  {passed}/{total}  {:.1}%   graded {:.1}%\n  \
             ceiling (oracle)   {ceiling}/{total}  {:.1}%",
            rate(*null_strict, total),
            rate(passed, total),
            report.graded_score() * 100.0,
            rate(*ceiling, total),
        );
    }

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

// ---------------------------------------------------------------------------
// The stage attribution
// ---------------------------------------------------------------------------

/// The gold canonical per `(session, turn)` for one corpus, read only.
fn gold(corpus: &str) -> BTreeMap<(String, usize), (String, bool)> {
    centraid_candidates::map::read(&centraid_candidates::map::default_path())
        .unwrap_or_default()
        .into_iter()
        .filter(|((c, _, _), _)| c == corpus)
        .map(|((_, session, turn), mapped)| ((session, turn), (mapped.canonical, mapped.covered)))
        .collect()
}

/// `(session, turn) -> (stage, parse verdict)`.
fn attribute(
    corpus: &str,
    rows: &[JoinedRow],
    report: &Report,
) -> BTreeMap<(String, usize), (String, String)> {
    let golds = gold(corpus);

    // The grammar's OWN parser decides whether a canonical matched — the same
    // `scorecheck.py` that scores `run-parse`, so the two lanes' verdicts are
    // computed by one authority and can be compared line for line.
    let scored: Vec<ScoreRow> = {
        let to_score: Vec<ScoreRow> = rows
            .iter()
            .map(|row| {
                let (canonical, covered) = golds
                    .get(&(row.session.clone(), row.turn))
                    .cloned()
                    .unwrap_or_default();
                ScoreRow {
                    id: format!("{}.{}", row.session, row.turn),
                    corpus: row.corpus.clone(),
                    category: String::new(),
                    register: "-".into(),
                    context_move: String::new(),
                    request: row.request.clone(),
                    gold: if covered { canonical } else { String::new() },
                    mine: row.canonical.clone(),
                    verdict: String::new(),
                    why: row.why.clone(),
                }
            })
            .collect();
        if python_is_here() {
            centraid_candidates::parse::score::score(&to_score)
        } else {
            eprintln!("python3 is absent; falling back to exact string equality");
            to_score
                .into_iter()
                .map(|mut row| {
                    row.verdict = match (&row.mine, row.gold.is_empty()) {
                        (None, _) => "unparsed",
                        (Some(_), true) => "skipped",
                        (Some(mine), false) if *mine == row.gold => "exact",
                        _ => "wrong",
                    }
                    .to_owned();
                    row
                })
                .collect()
        }
    };
    let parse_verdict: BTreeMap<String, String> = scored
        .iter()
        .map(|row| (row.id.clone(), row.verdict.clone()))
        .collect();

    let mut stages: BTreeMap<(String, usize), (String, String)> = BTreeMap::new();
    let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
    let mut failures: Vec<String> = Vec::new();
    let mut shapes: BTreeMap<String, (usize, String)> = BTreeMap::new();

    let raw: BTreeMap<(String, usize), &JoinedRow> = rows
        .iter()
        .map(|row| ((row.session.clone(), row.turn), row))
        .collect();

    for session in &report.sessions {
        for (at, turn) in session.turns.iter().enumerate() {
            let key = (session.id.clone(), at);
            let row = raw.get(&key);
            let verdict = parse_verdict
                .get(&format!("{}.{at}", session.id))
                .cloned()
                .unwrap_or_else(|| "unknown".to_owned());
            let joined_rejected = matches!(&turn.plan, centraid_evalsuite::Plan::Declined { reason }
                if reason.starts_with("unhandled: the join does not re-parse"));
            let covered = golds.get(&key).is_some_and(|(_, covered)| *covered);

            let stage = if turn.passed {
                "correct"
            } else if row.is_some_and(|row| row.canonical.is_none()) {
                "parse-unparsed"
            } else if joined_rejected {
                "join-rejected"
            } else if !covered {
                "uncovered"
            } else if verdict == "exact" {
                "exec-failed-on-correct-canonical"
            } else if verdict == "skeleton" {
                // The SHAPE was right and a literal was not — a name the
                // lexicon does not carry, a date read wrong. It is a parser
                // failure and must not be filed against the executor, which
                // executed exactly what it was handed.
                "parse-wrong-literal"
            } else {
                "parse-wrong-skeleton"
            };
            *counts.entry(stage).or_default() += 1;
            stages.insert(key.clone(), (stage.to_owned(), verdict.clone()));

            if turn.passed {
                continue;
            }
            let complaint = turn.complaint.clone().unwrap_or_default();
            let shape = shape_of(stage, &complaint);
            let entry = shapes.entry(shape).or_insert_with(|| {
                (
                    0,
                    format!(
                        "{}.{at} {:?}\n            canonical {}\n            gold      {}\n            {}",
                        session.id,
                        turn.request,
                        row.and_then(|r| r.canonical.clone())
                            .unwrap_or_else(|| format!("(abstained: {})", row.map_or("", |r| r.why.as_str()))),
                        golds.get(&key).map_or("(unmapped)", |(c, _)| c.as_str()),
                        truncate(&complaint, 200),
                    ),
                )
            });
            entry.0 += 1;
            failures.push(format!(
                "  {:<34} {:<32} {}.{at} [{}] {:?}",
                stage, verdict, session.id, session.category, turn.request
            ));
        }
    }

    let total: usize = counts.values().sum();
    println!("\nSTAGE ATTRIBUTION — where the next dollar goes ({total} turn(s)):");
    for stage in [
        "correct",
        "parse-unparsed",
        "parse-wrong-skeleton",
        "parse-wrong-literal",
        "join-rejected",
        "exec-failed-on-correct-canonical",
        "uncovered",
    ] {
        let count = counts.get(stage).copied().unwrap_or(0);
        println!("  {stage:<34} {count:>5}  {:>5.1}%", rate(count, total));
    }

    println!("\nTHE TEN MOST COMMON FAILURE SHAPES:");
    let mut ranked: Vec<(&String, &(usize, String))> = shapes.iter().collect();
    ranked.sort_by(|a, b| b.1.0.cmp(&a.1.0).then(a.0.cmp(b.0)));
    for (shape, (count, example)) in ranked.iter().take(10) {
        println!("  {count:>4}x  {shape}\n          e.g. {example}");
    }

    println!("\nFAILING TURNS BY STAGE ({}):", failures.len());
    failures.sort();
    for line in &failures {
        println!("{line}");
    }
    stages
}

/// A failure's SHAPE: its stage plus the invariant head of its complaint, with
/// the row ids, counts and quoted literals that make every complaint unique
/// taken out. Grouping on the raw text would report 90 shapes of size one.
fn shape_of(stage: &str, complaint: &str) -> String {
    let head: String = complaint
        .split([':', ';'])
        .next()
        .unwrap_or(complaint)
        .chars()
        .filter(|c| !c.is_ascii_digit())
        .collect();
    let head = head
        .split_whitespace()
        .take(9)
        .collect::<Vec<_>>()
        .join(" ");
    format!("[{stage}] {head}")
}

fn truncate(text: &str, at: usize) -> String {
    let mut out = text.to_owned();
    if out.chars().count() > at {
        out = out.chars().take(at).collect::<String>() + "…";
    }
    out
}

fn python_is_here() -> bool {
    std::process::Command::new("python3")
        .arg("--version")
        .output()
        .is_ok_and(|out| out.status.success())
}

/// Rewrite the JSONL with the harness's verdict joined onto every raw row. The
/// file written DURING the run has `verdict: null` and is complete without
/// this: a crash cannot lose what the parser emitted.
fn rewrite_log(
    path: &std::path::Path,
    rows: &[JoinedRow],
    stages: &BTreeMap<(String, usize), (String, String)>,
) {
    let mut text = String::new();
    for row in rows {
        let mut row = row.clone();
        row.verdict = stages
            .get(&(row.session.clone(), row.turn))
            .map(|(stage, parse)| format!("{stage} (parse: {parse})"));
        if let Ok(line) = serde_json::to_string(&row) {
            text.push_str(&line);
            text.push('\n');
        }
    }
    let _ = std::fs::write(path, text);
}

// ---------------------------------------------------------------------------
// The registers
// ---------------------------------------------------------------------------

fn print_registers(report: &Report, skipped: usize) {
    let (passed, total) = report.strict_sessions();
    println!("\n================ registers ================");
    println!("candidate: {}", report.candidate);
    println!(
        "\nEvery variant as its own SINGLE-TURN session — no conversation to \
         resolve a pronoun against, so `elliptical` is a floor, not an estimate."
    );
    if skipped > 0 {
        println!("{skipped} variant(s) named a turn the suite does not have");
    }
    println!(
        "\nSTRICT: {passed}/{total}  {:.1}%   graded {:.1}%",
        rate(passed, total),
        report.graded_score() * 100.0
    );

    println!(
        "\n{:<14} {:>8} {:>9} {:>10}",
        "register", "n", "strict", "graded"
    );
    for (register, passed, total, grade) in report.by_category_graded() {
        println!(
            "{register:<14} {total:>8} {:>8.1}% {:>9.1}%",
            rate(passed, total),
            grade * 100.0
        );
    }

    let cost = report.cost();
    println!(
        "\nCOST: {} turn(s), {} door call(s), {:.1} ms total; per turn p50/p95/max \
         calls {}/{}/{}  ms {:.1}/{:.1}/{:.1}",
        cost.turns,
        cost.total.calls(),
        ms(cost.total.micros),
        cost.calls.p50,
        cost.calls.p95,
        cost.calls.max,
        ms(cost.micros.p50),
        ms(cost.micros.p95),
        ms(cost.micros.max)
    );
}
