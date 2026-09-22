//! The tier-D parser's floor, asserted.
//!
//! Two properties, and they are not the same one:
//!
//! * **Nothing it emits is illegal.** Every canonical the parser produces must
//!   parse under `grammar/check.py` — the parser that GENERATED map.json's
//!   trees. An output the grammar refuses is a bug in this crate no score can
//!   excuse, and the assertion is zero, not a ratchet.
//! * **It does not get worse.** The skeleton-match rate per corpus is
//!   ratcheted at the measured figure, rounded DOWN to the nearest point, so a
//!   refactor that loses a reading fails here rather than in a report.
//!
//! Raise a ratchet only with the run that earned it.

use centraid_candidates::parse::score::{overall, parse_corpus, parse_registers, score, tally_by};

/// Measured 2026-09-21, after the write-verb table and the literal rules
/// landed (suite 58.9 / blind 55.6 / holdout 43.9). Lower bound, in percent,
/// on exact+skeleton, rounded DOWN to the nearest point.
const FLOORS: &[(&str, f64)] = &[("suite", 58.0), ("blind", 55.0), ("holdout", 43.0)];

fn python_is_here() -> bool {
    std::process::Command::new("python3")
        .arg("--version")
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false)
}

#[test]
fn every_output_is_legal_canonical() {
    if !python_is_here() {
        eprintln!("python3 is absent; the grammar cannot be consulted");
        return;
    }
    for corpus in ["suite", "blind", "holdout"] {
        let rows = score(&parse_corpus(corpus));
        let illegal: Vec<&str> = rows
            .iter()
            .filter(|row| row.verdict == "illegal")
            .map(|row| row.mine.as_deref().unwrap_or(""))
            .collect();
        assert!(
            illegal.is_empty(),
            "{corpus}: {} canonicals the grammar refuses: {illegal:?}",
            illegal.len()
        );
    }
    let rows = score(&parse_registers());
    let illegal = rows.iter().filter(|row| row.verdict == "illegal").count();
    assert_eq!(
        illegal, 0,
        "registers: {illegal} canonicals the grammar refuses"
    );
}

#[test]
fn skeleton_match_does_not_regress() {
    if !python_is_here() {
        return;
    }
    for (corpus, floor) in FLOORS {
        let rows = score(&parse_corpus(corpus));
        let rate = 100.0 * overall(&rows).skeleton_rate();
        assert!(
            rate >= *floor,
            "{corpus}: skeleton-match {rate:.1}% fell below the {floor:.1}% ratchet"
        );
    }
}

#[test]
fn every_register_is_measured() {
    if !python_is_here() {
        return;
    }
    let rows = score(&parse_registers());
    let by_register = tally_by(&rows, |row| row.register.clone());
    assert_eq!(
        by_register.len(),
        6,
        "registers.json publishes six registers; {} were scored",
        by_register.len()
    );
    // 2026-09-21: the whole-file floor, measured at 47.9%. Per-register
    // figures are in the report.
    let rate = 100.0 * overall(&rows).skeleton_rate();
    assert!(
        rate >= 47.0,
        "registers: skeleton-match {rate:.1}% below the 47.0% ratchet"
    );
}

#[test]
fn an_unreadable_sentence_abstains_rather_than_guessing() {
    use centraid_candidates::parse::{ParseState, Parser};
    let parser = Parser::new();
    let state = ParseState::default();
    let verdict = parser.parse("and those ones over there as well", &state);
    assert!(
        verdict.is_err(),
        "a sentence with nothing in the session to resolve must abstain, got {:?}",
        verdict.map(|(turn, _)| turn.to_string())
    );
}

#[test]
fn a_withdrawal_is_not_a_guess() {
    use centraid_candidates::parse::{ParseState, Parser};
    let parser = Parser::new();
    let mut state = ParseState::default();
    let _ = parser.run("what's on my calendar this week?", &mut state);
    let canonical = parser.run("ugh, never mind", &mut state).expect("parses");
    assert_eq!(canonical.to_string(), "nothing");
}
