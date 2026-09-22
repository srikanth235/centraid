//! Crate tests.

use crate::{canon, map};

/// **THE ROUND TRIP.** Every canonical in `map.json` parses, and the tree it
/// parses to re-serializes to a string that parses to the same tree.
#[test]
fn every_canonical_round_trips() {
    let turns = map::read_all(&map::default_path()).expect("map.json reads");
    let mut parsed = 0usize;
    let mut failures = Vec::new();
    for turn in &turns {
        if !turn.covered {
            continue;
        }
        let tree = match canon::parse(&turn.canonical) {
            Ok(tree) => tree,
            Err(complaint) => {
                failures.push(format!(
                    "{}/{}.{}: does not parse: {complaint}\n    {}",
                    turn.corpus, turn.session, turn.turn, turn.canonical
                ));
                continue;
            }
        };
        let printed = tree.to_canonical();
        match canon::parse(&printed) {
            Ok(again) if again == tree => parsed += 1,
            Ok(_) => failures.push(format!(
                "{}/{}.{}: parse(serialize(t)) != t\n    {printed}",
                turn.corpus, turn.session, turn.turn
            )),
            Err(complaint) => failures.push(format!(
                "{}/{}.{}: serialize does not re-parse: {complaint}\n    {printed}",
                turn.corpus, turn.session, turn.turn
            )),
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    assert!(parsed >= 434, "only {parsed} canonicals round-tripped");
}

// ---------------------------------------------------------------------------
// THE RATCHET
//
// Each of these asserts the oracle's pass rate on one corpus is at least what
// it was when the executor landed. They are SLOW — each deals one private
// world per session and runs the whole corpus — and they are the reason a
// later change to `exec.rs` cannot quietly cost a session.
//
// A number here is a CEILING (the oracle is handed the gold canonical), never
// a candidate's score. Raising one is the point; lowering one is a regression
// and must be argued for in the PR, not edited away.
// ---------------------------------------------------------------------------

fn passed(corpus: &str) -> (usize, usize) {
    let report = crate::oracle_report(corpus).expect("the corpus runs");
    report.strict_sessions()
}

#[test]
fn the_oracle_holds_its_ground_on_the_suite() {
    let (passed, total) = passed("suite");
    assert_eq!(total, 120, "the suite changed size");
    assert!(passed >= 120, "suite: {passed}/{total}, the ratchet is 120");
}

#[test]
fn the_oracle_holds_its_ground_on_the_blind_set() {
    let (passed, total) = passed("blind");
    assert_eq!(total, 60, "the blind set changed size");
    assert!(passed >= 60, "blind: {passed}/{total}, the ratchet is 60");
}

#[test]
fn the_oracle_holds_its_ground_on_the_holdout() {
    let (passed, total) = passed("holdout");
    assert_eq!(total, 78, "the holdout changed size");
    assert!(passed >= 78, "holdout: {passed}/{total}, the ratchet is 78");
}
