//! The JOINED candidate's floor, asserted.
//!
//! `parse_ratchet.rs` ratchets the parser alone against `check.py`; the
//! oracle's ratchets in `src/tests.rs` ratchet the executor alone against the
//! gold canonical. This ratchets the ONE NUMBER a ship decision would read:
//! the rules parser wired to the executor, scored through the harness against
//! the seeded vault, with no gold anywhere in the loop.
//!
//! Two properties, and they are not the same one:
//!
//! * **It does not get worse.** The strict session count per corpus is pinned
//!   at what it measured on 2026-09-21. Lowering one is a regression to be
//!   argued for in the PR, never edited away; raising one is the point.
//! * **Every turn produces a well-formed plan.** Across all three corpora AND
//!   all 349 register variants — 434 turns of member text through a parser
//!   that indexes, slices and unwraps — nothing panics, and every `Declined`
//!   carries a reason from the executor's own vocabulary. A `Declined` with an
//!   empty or unrecognised reason is a candidate that failed to have an
//!   opinion, which the harness would silently score as an honest abstention.
//!
//! These are SLOW: each deals one private world per session.

use std::sync::{Arc, Mutex};

use centraid_candidates::joined::{Sink, corpus_report, registers_report};
use centraid_evalsuite::{Plan, Report};

/// Measured 2026-09-21, after the write-verb table and the literal rules
/// landed. `(corpus, strict sessions, total sessions)`.
const RATCHET: &[(&str, usize, usize)] =
    &[("suite", 53, 120), ("blind", 34, 60), ("holdout", 31, 78)];

/// The executor's whole decline vocabulary (`exec::Stop::plan`), plus the
/// join's own refusal. Anything else is a reason nobody wrote on purpose.
fn reason_is_known(reason: &str) -> bool {
    matches!(reason, "clarify" | "refuse" | "none") || reason.starts_with("unhandled: ")
}

/// Every plan is one of the four variants, spelled out so that adding a fifth
/// breaks this test rather than slipping past it.
fn every_plan_is_well_formed(report: &Report, what: &str) {
    let mut counts = [0usize; 4];
    for session in &report.sessions {
        for turn in &session.turns {
            match &turn.plan {
                Plan::Ids(_) => counts[0] += 1,
                Plan::Wrote => counts[1] += 1,
                Plan::Value(number) => {
                    assert!(
                        number.is_finite(),
                        "{what}: {} answered a non-finite value",
                        session.id
                    );
                    counts[2] += 1;
                }
                Plan::Declined { reason } => {
                    assert!(
                        reason_is_known(reason),
                        "{what}: {} declined with an unrecognised reason {reason:?}",
                        session.id
                    );
                    counts[3] += 1;
                }
            }
        }
    }
    let total: usize = counts.iter().sum();
    assert!(total > 0, "{what}: no turn ran at all");
    eprintln!(
        "{what}: {total} turn(s) — ids {}, wrote {}, value {}, declined {}",
        counts[0], counts[1], counts[2], counts[3]
    );
}

fn run(corpus: &str) -> Report {
    let sink = Arc::new(Mutex::new(Sink::in_memory()));
    let report = corpus_report(corpus, &sink).expect("the corpus runs");
    // The raw canonical is saved for every turn, whether or not it parsed.
    let turns: usize = report.sessions.iter().map(|s| s.turns.len()).sum();
    assert_eq!(
        sink.lock().expect("sink").rows().len(),
        turns,
        "{corpus}: a turn ran without its raw canonical being recorded"
    );
    report
}

fn ratchet(corpus: &str) {
    let (_, floor, size) = RATCHET
        .iter()
        .find(|row| row.0 == corpus)
        .expect("a ratchet for every corpus");
    let report = run(corpus);
    every_plan_is_well_formed(&report, corpus);
    let (passed, total) = report.strict_sessions();
    assert_eq!(total, *size, "{corpus} changed size");
    assert!(
        passed >= *floor,
        "{corpus}: {passed}/{total} strict, the ratchet is {floor}"
    );
}

#[test]
fn the_join_holds_its_ground_on_the_suite() {
    ratchet("suite");
}

#[test]
fn the_join_holds_its_ground_on_the_blind_set() {
    ratchet("blind");
}

#[test]
fn the_join_holds_its_ground_on_the_holdout() {
    ratchet("holdout");
}

/// The 349 register variants, each as its own single-turn session. The floor
/// here is the WELL-FORMEDNESS property, not a score: a terse fragment or a
/// dictated run-on is exactly the input most likely to walk a hand-written
/// rule off the end of a slice.
#[test]
fn every_register_variant_produces_a_plan() {
    let sink = Arc::new(Mutex::new(Sink::in_memory()));
    let (report, skipped) = registers_report(&sink).expect("the registers run");
    assert_eq!(
        skipped, 0,
        "{skipped} variant(s) named a turn the suite lacks"
    );
    assert_eq!(report.sessions.len(), 349, "registers.json changed size");
    every_plan_is_well_formed(&report, "registers");
    let (passed, total) = report.strict_sessions();
    // 2026-09-21. Lifted out of their conversations, so this is a floor.
    assert!(
        passed >= 126,
        "registers: {passed}/{total} strict, the ratchet is 126"
    );
}
