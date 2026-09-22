//! # `run-nulls` — does the suite tell good from bad?
//!
//! The reference scores 129/129, which proves every case is reachable. This
//! runs the deliberately flawed candidates in [`nulls`] over the same suite
//! and prints the spread. What it is looking for:
//!
//! * **A floor.** How much of the suite does a system buy by doing nothing?
//! * **Dead weight.** Any turn no bad candidate fails is a turn that cannot
//!   discriminate, and is named here by id.
//! * **The anchored/abstract split.** `SearchOnly` versus `BoardOnly`, per
//!   category, as an empirical estimate of how many real requests are content-
//!   anchored and how many are filter-only.
//! * **Near-misses.** Where a candidate gets most of the ids and drops a
//!   specific kind of row — `s16`'s Locker row above all.
//!
//! ```text
//! cargo run -p centraid-evalsuite --bin run-nulls
//! ```
//!
//! It always exits zero. Nothing here is a gate; it is a measurement.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::process::ExitCode;

use centraid_evalsuite::{Report, Suite, WorldTemplate, nulls, reference::Reference, run};

/// Turn-level counts, which `Report::by_category` (sessions) does not give.
fn turn_tally(report: &Report) -> (usize, usize) {
    let mut passed = 0;
    let mut total = 0;
    for session in &report.sessions {
        for turn in &session.turns {
            total += 1;
            if turn.passed {
                passed += 1;
            }
        }
    }
    (passed, total)
}

fn turns_by_category(report: &Report) -> BTreeMap<String, (usize, usize)> {
    let mut tally: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    for session in &report.sessions {
        let entry = tally.entry(session.category.clone()).or_default();
        for turn in &session.turns {
            entry.1 += 1;
            if turn.passed {
                entry.0 += 1;
            }
        }
    }
    tally
}

/// Of every id the suite expects on a rows turn, how many did this candidate
/// return? The pass/fail verdict is all-or-nothing; this is not, and it is the
/// number that makes `SearchOnly` versus `BoardOnly` a measurement rather than
/// two low scores.
fn id_recall(report: &Report) -> BTreeMap<String, (usize, usize)> {
    let mut tally: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    for session in &report.sessions {
        for turn in &session.turns {
            if let Some(overlap) = &turn.overlap {
                let entry = tally.entry(session.category.clone()).or_default();
                entry.0 += overlap.hit;
                entry.1 += overlap.expected;
            }
        }
    }
    tally
}

/// `session/turn` keys of every turn this candidate passed.
fn passed_keys(report: &Report) -> BTreeSet<String> {
    let mut keys = BTreeSet::new();
    for session in &report.sessions {
        for (index, turn) in session.turns.iter().enumerate() {
            if turn.passed {
                keys.insert(format!("{}/t{}", session.id, index + 1));
            }
        }
    }
    keys
}

fn rate(part: usize, whole: usize) -> String {
    if whole == 0 {
        return "    —".to_owned();
    }
    #[expect(clippy::cast_precision_loss, reason = "counts of turns in one suite")]
    let value = part as f64 * 100.0 / whole as f64;
    format!("{value:>5.1}%")
}

#[expect(clippy::too_many_lines, reason = "one report, printed in one place")]
/// **THIS BINARY HAS AN EXIT CODE NOW** (review item B15).
///
/// It was a report: somebody ran it, read it and quoted the number. The two
/// properties on this page are not observations, they are INVARIANTS — the
/// merge is a union of its doors, and no turn is free — and an invariant with
/// no exit code is an invariant that fails quietly. Both now fail the run.
fn main() -> ExitCode {
    let path = std::env::args().nth(1).map_or_else(
        || PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("suite.json"),
        PathBuf::from,
    );
    let mut suite = match Suite::read(&path) {
        Ok(suite) => suite,
        Err(complaint) => {
            eprintln!("the suite does not read: {complaint}");
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
    // THE HANDLES, RESOLVED — `suite.json` holds no uuid.
    if let Err(complaint) = suite.resolve(&template.inventory) {
        eprintln!("the suite does not resolve against this world:\n{complaint}");
        return ExitCode::FAILURE;
    }
    println!(
        "suite {} — {} session(s), {} turn(s)\n",
        path.display(),
        suite.sessions.len(),
        suite.sessions.iter().map(|s| s.turns.len()).sum::<usize>()
    );

    let mut reports: Vec<Report> = Vec::new();
    match run(&suite, &template, &Reference) {
        Ok(report) => reports.push(report),
        Err(complaint) => {
            eprintln!("the reference did not finish: {complaint}");
            return ExitCode::FAILURE;
        }
    }
    for runtime in nulls::roster() {
        match run(&suite, &template, runtime.as_ref()) {
            Ok(report) => reports.push(report),
            Err(complaint) => eprintln!("{} did not finish: {complaint}", runtime.name()),
        }
    }

    // HOW MANY TURNS THE FLOOR REACHES, COUNTED RATHER THAN REMEMBERED.
    //
    // This number was a LITERAL in two places in this file for two releases —
    // "38 of 129" — and it was wrong by one the day it was written and wrong
    // by more every time a case or an instrument was added. A measurement
    // spelled into a sentence is not a measurement. It is now the union of
    // the keys every degenerate instrument passes, recomputed on every run.
    //
    // **THE FLOOR IS THE INSTRUMENTS THAT UNDERSTAND NOTHING**, which is not
    // all of them. `CollateralDamage` delegates every turn to the hand-written
    // reference and then vandalises three bystanders, so it passes every read
    // turn the reference passes — it is the reference with a defect, not a
    // floor, and folding it in would report the floor as 103 of 129 and make
    // the suite look free.
    const NOT_A_FLOOR: &[&str] = &["CollateralDamage"];
    let floor_keys: BTreeSet<String> = reports
        .iter()
        .skip(1)
        .filter(|report| !NOT_A_FLOOR.contains(&report.candidate.as_str()))
        .flat_map(passed_keys)
        .collect();
    let total_turns: usize = suite.sessions.iter().map(|s| s.turns.len()).sum();

    // THE TWO INVARIANTS THIS RUN CAN FAIL ON. Declared here so the exit code
    // is visibly a function of what was measured rather than of where the
    // measurement happened to be printed.
    let mut union_violations = 0usize;
    let mut dead_weight: Vec<String> = Vec::new();

    // ---- THE HEADLINE IS A SESSION NUMBER (G4) -----------------------------
    // No bare turn count lives in this table: a turn-level rate is not a score
    // while that many turns fall to an instrument that understands nothing. It
    // is reported below, once, under a heading that says so.
    println!("== SCORES (sessions — the only headline) ==\n");
    println!(
        "{:<26} {:>12} {:>9} {:>16} {:>11}",
        "candidate", "sessions", "graded", "de-duplicated", "id recall"
    );
    for report in &reports {
        let (passed_sessions, total_sessions) = report.strict_sessions();
        let (dedup_strict, dedup_units, dedup_grade) = report.deduplicated();
        let recall = id_recall(report);
        let hit: usize = recall.values().map(|(hit, _)| hit).sum();
        let want: usize = recall.values().map(|(_, want)| want).sum();
        println!(
            "{:<26} {:>5}/{:<3} {:>8.1}% {:>7.1}/{:<3} {:>5.1}% {:>10}",
            report.candidate,
            passed_sessions,
            total_sessions,
            report.graded_score() * 100.0,
            dedup_strict,
            dedup_units,
            dedup_grade * 100.0,
            rate(hit, want),
        );
    }
    println!(
        "\n  sessions  = STRICT, all-or-nothing per turn. The headline, and it stays strict.\n  \
         graded    = mean session grade; a rows turn is scored F1 over its ids (G12).\n  \
         de-dup    = correlated sessions averaged into one unit first (G10).\n  \
         id recall = of every id the suite names, how many came back. NOT A SCORE:\n              \
         it pays nothing for precision, which is why EverythingOfEntity leads it\n              \
         while passing nothing. It is here to be compared against `graded`."
    );

    // WHY THE GRADED COLUMN IS F1 AND NOT RECALL — printed as evidence rather
    // than asserted, because the claim is the whole justification for adding
    // partial credit at all.
    // ---- WHAT EACH INSTRUMENT COST (review item A8) ------------------------
    // The column the harness could not print before: `EverythingOfEntity`
    // scans a whole board for every turn and `AlwaysClarify` opens no door at
    // all, and until now the only difference between them on this page was
    // the score. The brief asks for a runtime that answers on a phone at
    // interactive latency, so what an answer COST is reported beside what it
    // was worth — and never inside it.
    println!("\n== COST — MEASURED, NEVER SCORED ==\n");
    println!(
        "{:<26} {:>7} {:>9} {:>10} {:>9} {:>9} {:>9} {:>8}",
        "candidate", "calls", "rows", "total ms", "p50 ms", "p95 ms", "max ms", "writes"
    );
    for report in &reports {
        let cost = report.cost();
        let ms = |micros: u128| {
            #[expect(clippy::cast_precision_loss, reason = "a duration in microseconds")]
            let value = micros as f64 / 1000.0;
            value
        };
        println!(
            "{:<26} {:>7} {:>9} {:>10.1} {:>9.2} {:>9.2} {:>9.2} {:>8}",
            report.candidate,
            cost.total.calls(),
            cost.total.rows(),
            ms(cost.total.micros),
            ms(cost.micros.p50),
            ms(cost.micros.p95),
            ms(cost.micros.max),
            cost.total.writes(),
        );
    }
    println!(
        "\n  calls/rows = door calls made and rows handed back, over the whole suite.\n           ms         = the candidate's own wall clock; the harness's digest scans and\n                      the per-session world deal are excluded, because no shipped runtime\n                      pays them.\n           writes     = commands the vault EXECUTED (a refused command is a call, not a write).\n           THE SCAN-VERSUS-SEARCH QUESTION IS THIS TABLE: SearchOnly and BoardOnly answer\n           the same corpus through one door each, and their rows and ms columns are what\n           the difference costs."
    );

    println!("\n== DOES THE GRADED SCORE STILL PUNISH BREADTH-DUMPING? ==\n");
    println!(
        "{:<26} {:>10} {:>12} {:>14} {:>10}",
        "candidate", "sessions", "id recall", "row precision", "graded"
    );
    for report in &reports {
        let mut hit = 0_usize;
        let mut want = 0_usize;
        let mut answered = 0_usize;
        for session in &report.sessions {
            for turn in &session.turns {
                if let Some(overlap) = &turn.overlap {
                    hit += overlap.hit;
                    want += overlap.expected;
                    answered += overlap.answered;
                }
            }
        }
        let (passed_sessions, total_sessions) = report.strict_sessions();
        println!(
            "{:<26} {:>10} {:>12} {:>14} {:>9.1}%",
            report.candidate,
            format!("{passed_sessions}/{total_sessions}"),
            rate(hit, want),
            rate(hit, answered),
            report.graded_score() * 100.0
        );
    }
    println!(
        "\n  A metric that ranked a breadth-dumper above a candidate that answers\n  \
         precisely would be the wrong metric. Read the `row precision` column\n  \
         against `id recall`: any candidate whose recall is high and precision\n  \
         low must land LOW on `graded`, or F1 is not doing its job."
    );

    // ---- TURN COUNTS, ONCE, LABELLED -------------------------------------
    println!("\n== TURN COUNTS — NOT A SCORE, DO NOT QUOTE ==\n");
    println!(
        "  A turn number is meaningless on this suite: {} of {total_turns} turn(s) fall to\n  \
         some instrument that understands nothing and survive only because the\n  \
         SESSION around them fails. {} turn(s) ({}) cannot be scored on their own at all — they expect\n  \
         an empty answer, so answering nothing passes them.\n",
        floor_keys.len(),
        reports[0].combination_only().len(),
        reports[0]
            .combination_only()
            .iter()
            .map(|(key, _)| key.clone())
            .collect::<Vec<_>>()
            .join(", ")
    );
    for report in &reports {
        let (passed_turns, total_turns) = turn_tally(report);
        println!(
            "  {:<26} {passed_turns:>4} of {total_turns} turn(s)  (diagnostic only)",
            report.candidate
        );
    }

    // ---- Per-category, turns ----------------------------------------------
    let categories: Vec<String> = turns_by_category(&reports[0]).keys().cloned().collect();
    println!("\n== SESSIONS PASSED, PER CATEGORY (strict / graded) ==\n");
    print!("{:<24}", "category");
    for report in &reports {
        print!(" {:>17.17}", report.candidate);
    }
    println!();
    for category in &categories {
        print!("{category:<24}");
        for report in &reports {
            let found = report
                .by_category_graded()
                .into_iter()
                .find(|(name, ..)| name == category);
            let cell = found.map_or_else(
                || "—".to_owned(),
                |(_, passed, total, grade)| format!("{passed}/{total}  {:.0}%", grade * 100.0),
            );
            print!(" {cell:>17}");
        }
        println!();
    }

    println!("\n== turns passed, per category — DIAGNOSTIC, NOT A SCORE ==\n");
    print!("{:<24}", "category");
    for report in &reports {
        print!("{:>12.12}", report.candidate);
    }
    println!();
    for category in &categories {
        print!("{category:<24}");
        for report in &reports {
            let tally = turns_by_category(report);
            let (passed, total) = tally.get(category).copied().unwrap_or((0, 0));
            print!("{:>12}", format!("{passed}/{total}"));
        }
        println!();
    }

    // ---- The anchored/abstract split --------------------------------------
    println!("\n== ID RECALL, PER CATEGORY (SearchOnly vs BoardOnly) ==\n");
    let find = |name: &str| reports.iter().find(|report| report.candidate == name);
    if let (Some(search), Some(board), Some(both)) =
        (find("SearchOnly"), find("BoardOnly"), find("KeywordBoth"))
    {
        let (sr, br, kr) = (id_recall(search), id_recall(board), id_recall(both));
        println!(
            "{:<24} {:>8} {:>16} {:>16} {:>16}",
            "category", "ids", "SearchOnly", "BoardOnly", "both doors"
        );
        for category in &categories {
            let want = sr.get(category).map_or(0, |(_, want)| *want);
            if want == 0 {
                continue;
            }
            let cell = |map: &BTreeMap<String, (usize, usize)>| {
                let (hit, want) = map.get(category).copied().unwrap_or((0, 0));
                format!("{hit:>4}  {}", rate(hit, want))
            };
            println!(
                "{:<24} {want:>8} {:>16} {:>16} {:>16}",
                category,
                cell(&sr),
                cell(&br),
                cell(&kr)
            );
        }
    }

    // ---- The union check, and what search actually adds --------------------
    // A "both doors" column that is not an upper bound on either door cannot
    // support a claim about what a door contributes. This checks the property
    // by comparing missed-id SETS turn by turn, element for element, rather
    // than by comparing counts — counts agreeing hides a swap.
    println!("\n== UNION CHECK: is KeywordBoth really both doors? ==\n");
    if let (Some(search), Some(board), Some(both)) =
        (find("SearchOnly"), find("BoardOnly"), find("KeywordBoth"))
    {
        let missed = |report: &Report| -> BTreeMap<String, BTreeSet<String>> {
            let mut out = BTreeMap::new();
            for session in &report.sessions {
                for (index, turn) in session.turns.iter().enumerate() {
                    if let Some(overlap) = &turn.overlap {
                        out.insert(
                            format!("{}/t{}", session.id, index + 1),
                            overlap.missing.iter().cloned().collect(),
                        );
                    }
                }
            }
            out
        };
        let category_of: BTreeMap<String, String> = both
            .sessions
            .iter()
            .flat_map(|session| {
                session.turns.iter().enumerate().map(move |(index, _)| {
                    (
                        format!("{}/t{}", session.id, index + 1),
                        session.category.clone(),
                    )
                })
            })
            .collect();
        let (ms, mb, mo) = (missed(search), missed(board), missed(both));

        let mut violations = 0_usize;
        let mut search_adds: BTreeMap<String, Vec<(String, String)>> = BTreeMap::new();
        let mut board_adds: BTreeMap<String, usize> = BTreeMap::new();
        let mut identical = true;
        for (key, both_missing) in &mo {
            let search_missing = ms.get(key).cloned().unwrap_or_default();
            let board_missing = mb.get(key).cloned().unwrap_or_default();
            // Union property: Both may only miss what BOTH doors missed.
            let floor: BTreeSet<String> = search_missing
                .intersection(&board_missing)
                .cloned()
                .collect();
            for id in both_missing.difference(&floor) {
                violations += 1;
                println!("  VIOLATION {key}: KeywordBoth misses {id}, but a door found it");
            }
            if both_missing != &board_missing {
                identical = false;
            }
            // What search recovers that the boards do not.
            let category = category_of.get(key).cloned().unwrap_or_default();
            for id in board_missing.difference(&search_missing) {
                search_adds
                    .entry(category.clone())
                    .or_default()
                    .push((key.clone(), id.clone()));
            }
            *board_adds.entry(category.clone()).or_default() +=
                search_missing.difference(&board_missing).count();
        }
        if violations == 0 {
            println!("  OK — on every rows turn, KeywordBoth misses only what BOTH doors missed.");
        } else {
            println!("  {violations} VIOLATION(S) — the merge is still not a union.");
        }
        union_violations = violations;
        println!(
            "\n  missed-id sets, KeywordBoth vs BoardOnly: {}",
            if identical {
                "IDENTICAL on every turn — search adds nothing over the boards"
            } else {
                "DIFFER — search contributes ids the boards miss"
            }
        );
        println!("\n  IDS SEARCH RECOVERS THAT THE BOARDS MISS:");
        if search_adds.is_empty() {
            println!("    (none)");
        } else {
            for (category, items) in &search_adds {
                println!("    {category} (+{}):", items.len());
                for (key, id) in items {
                    println!("      {key}  {id}");
                }
            }
        }
        let total_board_adds: usize = board_adds.values().sum();
        println!(
            "\n  (for contrast, ids the BOARDS recover that search misses: {total_board_adds})"
        );
    }

    // ---- Decline precision and recall -------------------------------------
    println!("\n== DECLINING: PRECISION AND RECALL ==\n");
    // G11 — WHAT THESE COLUMNS CAN AND CANNOT TELL APART, printed before the
    // numbers so nobody reads decline precision as competence.
    for reason in ["clarify", "refuse", "none"] {
        let caveat = reports[0]
            .decline_scores()
            .into_iter()
            .find(|score| score.reason == reason)
            .map_or_else(String::new, |score| score.caveat().to_owned());
        println!("  {reason:<9} {caveat}");
    }
    println!(
        "\n  Every non-degenerate instrument below scores 0% recall on all three:\n  \
         a retrieval-only runtime never emits a decline, so these reasons separate\n  \
         exactly one thing — a candidate that CHOOSES to decline from one that does\n  \
         not. They measure nothing about how WELL it declines.\n"
    );
    println!(
        "{:<20} {:<9} {:>9} {:>8} {:>10} {:>8}",
        "candidate", "reason", "declined", "correct", "precision", "recall"
    );
    for report in &reports {
        for score in report.decline_scores() {
            if score.declined == 0 && score.wanted == 0 {
                continue;
            }
            let show = |value: Option<f64>| {
                value.map_or_else(
                    || "     —".to_owned(),
                    |value| format!("{:>5.1}%", value * 100.0),
                )
            };
            println!(
                "{:<20} {:<9} {:>9} {:>8} {:>10} {:>8}",
                report.candidate,
                score.reason,
                score.declined,
                score.correct,
                show(score.precision()),
                show(score.recall())
            );
        }
    }

    // ---- Dead weight -------------------------------------------------------
    // A turn EVERY degenerate candidate passes cannot discriminate. A turn no
    // bad candidate fails is worth nothing at all.
    println!("\n== WHAT THE FLOOR PASSES ==\n");
    let mut never_failed: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut by_candidate: Vec<(String, BTreeSet<String>)> = Vec::new();
    for report in reports.iter().skip(1) {
        by_candidate.push((report.candidate.clone(), passed_keys(report)));
    }
    for session in &reports[0].sessions {
        for (index, turn) in session.turns.iter().enumerate() {
            let key = format!("{}/t{}", session.id, index + 1);
            let passers: Vec<String> = by_candidate
                .iter()
                .filter(|(_, keys)| keys.contains(&key))
                .map(|(name, _)| name.clone())
                .collect();
            if passers.len() == by_candidate.len() {
                never_failed
                    .entry(format!("{key} [{}]", session.category))
                    .or_default()
                    .push(turn.request.clone());
            }
        }
    }
    for (name, keys) in &by_candidate {
        let list: Vec<&String> = keys.iter().collect();
        println!("{name} passes {} turn(s): {list:?}", keys.len());
    }
    println!("\nDEAD WEIGHT — turns EVERY flawed candidate passes:");
    if never_failed.is_empty() {
        println!("  (none — every turn is failed by at least one bad candidate)");
    } else {
        for (key, requests) in &never_failed {
            println!("  {key} {:?}", requests.first());
            dead_weight.push(key.clone());
        }
    }

    // ---- What the score does not cover ------------------------------------
    println!("\n== WHAT THE SUITE REFUSES TO SCORE ==\n");
    let combination = reports[0].combination_only();
    println!(
        "  SCOREABLE ONLY IN COMBINATION ({}): each expects an EMPTY answer.",
        combination.len()
    );
    for (key, request) in &combination {
        println!("    {key} {request:?}");
    }
    let undeclared = reports[0].undeclared_ordering();
    println!(
        "\n  UNDECLARED ORDERING ({}): `ordered: true`, no `order_by`. The sequence is\n  \
         scored strictly; the case never stated which sort it is scoring, so a\n  \
         candidate that sorted by another reasonable key fails an unwritten rule.",
        undeclared.len()
    );
    for (key, request) in &undeclared {
        println!("    {key} {request:?}");
    }
    println!(
        "\n  ORDER BETWEEN THE WRITES OF A write_set: REFUSED. Predicates read the vault\n  \
         after the turn, and two orderings of the same writes leave the same vault.\n  \
         A case that declares one fails with a complaint rather than being ignored."
    );
    let groups = reports[0].correlation_groups();
    println!("\n  CORRELATION GROUPS DECLARED: {}", groups.len());
    for (name, members) in &groups {
        println!("    {name}: {members:?}");
    }
    if groups.is_empty() {
        println!(
            "    (none — `s71`/`s02` and `s65`/`s09` are the same rows in two shapes and\n     \
             are therefore still counted twice by the raw column. The de-duplicated\n     \
             column equals the raw one until the suite declares them.)"
        );
    }

    // ---- THE WRITE HALF, AND WHAT THE CHANGED-ROW SET ADDED ---------------
    //
    // The new failure surface, by category and by kind. Two columns, because
    // they are two different findings: a turn that failed on its PREDICATE is
    // a write that did not happen or happened to the wrong row, and a turn
    // that failed on its LICENCE is a write that happened correctly and took
    // bystanders with it. Nothing in this crate could produce the second
    // column before the changed-row set existed (DEFECT #16).
    println!("\n== WRITE TURNS: WHY THEY FAIL ==\n");
    let write_keys: BTreeSet<String> = suite
        .sessions
        .iter()
        .flat_map(|session| {
            session
                .turns
                .iter()
                .enumerate()
                .filter(|(_, turn)| {
                    matches!(
                        turn.expected,
                        centraid_evalsuite::Expected::Write { .. }
                            | centraid_evalsuite::Expected::WriteSet { .. }
                    )
                })
                .map(move |(index, _)| format!("{}/t{}", session.id, index + 1))
        })
        .collect();
    println!(
        "  {} of {} turn(s) expect a write.\n",
        write_keys.len(),
        suite.sessions.iter().map(|s| s.turns.len()).sum::<usize>()
    );
    println!(
        "{:<26} {:>8} {:>12} {:>12} {:>12} {:>14}",
        "candidate", "passed", "predicate", "collateral", "read-wrote", "rows moved"
    );
    for report in &reports {
        let (mut passed, mut predicate, mut collateral, mut read_wrote, mut moved) =
            (0usize, 0usize, 0usize, 0usize, 0usize);
        for session in &report.sessions {
            for (index, turn) in session.turns.iter().enumerate() {
                let key = format!("{}/t{}", session.id, index + 1);
                if write_keys.contains(&key) {
                    moved += turn.changes.len();
                    match &turn.complaint {
                        None => passed += 1,
                        Some(complaint) if complaint.contains("no expectation licenses") => {
                            collateral += 1;
                        }
                        Some(_) => predicate += 1,
                    }
                } else if turn
                    .complaint
                    .as_ref()
                    .is_some_and(|complaint| complaint.contains("no vault change"))
                {
                    // A READ THAT WROTE. Its own column: it is not a write
                    // turn at all, and before the changed-row set it could
                    // not be a failure.
                    read_wrote += 1;
                }
            }
        }
        println!(
            "{:<26} {passed:>8} {predicate:>12} {collateral:>12} {read_wrote:>12} {moved:>14}",
            report.candidate
        );
    }
    println!(
        "\n  predicate  = the expected outcome did not hold (no write, or the wrong row).\n  \
         collateral = the expected outcome DID hold, and rows no expectation licenses\n               \
         moved with it. This column is the one a predicate cannot produce.\n  \
         read-wrote = an ids/value/no_action turn that changed the vault.\n  \
         rows moved = total rows the candidate moved across all write turns, as a\n               \
         blast radius beside the verdict."
    );

    // ---- Near-misses -------------------------------------------------------
    println!("\n== NEAR-MISSES (partly right rows) ==\n");
    for report in reports.iter().skip(1) {
        let partial = report.partial_rows();
        if partial.is_empty() {
            continue;
        }
        println!(
            "{} — {} partly-right turn(s):",
            report.candidate,
            partial.len()
        );
        for (session, turn) in partial {
            if let Some(overlap) = &turn.overlap {
                println!(
                    "  {} [{}] {}/{} ids, {} extra, missing {:?}",
                    session.id,
                    session.category,
                    overlap.hit,
                    overlap.expected,
                    overlap.extra.len(),
                    overlap.missing
                );
            }
        }
        println!();
    }

    // ---- THE EXIT CODE -----------------------------------------------------
    if union_violations == 0 && dead_weight.is_empty() {
        println!(
            "\nOK — the merge is a union of its doors, and every turn is failed by at \
             least one instrument that understands nothing."
        );
        return ExitCode::SUCCESS;
    }
    println!("\nFAIL:");
    if union_violations > 0 {
        println!("  {union_violations} union violation(s) — KeywordBoth is not both doors.");
    }
    if !dead_weight.is_empty() {
        println!(
            "  {} turn(s) passed by EVERY degenerate instrument: {dead_weight:?}\n  \
             A turn no bad candidate fails measures nothing. Either the case needs a \
             distractor the floor falls for, or it needs deleting.",
            dead_weight.len()
        );
    }
    ExitCode::FAILURE
}
