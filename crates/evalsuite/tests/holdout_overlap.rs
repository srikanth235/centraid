//! **THE HOLDOUT IS A SCENARIO HOLDOUT, AND THIS IS WHAT SAYS SO.**
//!
//! `blind.json` was built to be held out and holds out only the WORDING: a
//! third of its handles are rows `suite.json` also names, and more than half
//! its requests share a three-gram with a primary one. A fine-tune that
//! memorised *the dentist is Neha Rao, the trip is Tahoe* transfers across it
//! unpunished, and the blind-versus-primary gap then reports generalisation
//! that was never measured.
//!
//! `holdout.json` is written over a SECOND WORLD
//! ([`centraid_evalworld::Scenario::Second`]) whose cast, places, weekend away
//! and collisions share nothing with the first. The two properties that make
//! that claim true are checked here rather than asserted in prose:
//!
//! 1. **No request in the holdout names a proper noun either of the other two
//!    corpora names.** A shared name is the whole leak: it is what lets a
//!    model resolve an anchor without retrieving anything.
//! 2. **The three-gram overlap is REPORTED, and held far below the blind
//!    set's.** Some overlap is English — "how much did I", "what's in the" —
//!    and a corpus with none would be a corpus written in a dialect nobody
//!    speaks. What matters is the gap, so both numbers are printed side by
//!    side and the holdout's is capped.
//!
//! **This file reads `suite.json` as DATA and never as a corpus.** It
//! tokenises the three files and compares them; the lane that authored
//! `holdout.json` did not open `suite.json` at all. That distinction is the
//! point of the exercise and is worth keeping in the one place that has to
//! touch all three.

use std::collections::BTreeSet;
use std::path::PathBuf;

/// The three corpora, by path.
fn corpus(name: &str) -> serde_json::Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(name);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

/// Every request of a corpus, in order.
fn requests(corpus: &serde_json::Value) -> Vec<String> {
    corpus["sessions"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .flat_map(|session| {
            session["turns"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or_default()
                .iter()
                .filter_map(|turn| turn["request"].as_str().map(str::to_owned))
        })
        .collect()
}

/// **THE CALENDAR VOCABULARY, WHICH IS SHARED BY CONSTRUCTION.**
///
/// Weekday and month names are capitalised, are proper nouns in the
/// dictionary's sense, and are published in the README's temporal convention
/// as the words every corpus over this vault uses to name a day. A check that
/// called "Friday" a leak would be a check mistaking the calendar for a cast,
/// and the only way to satisfy it would be to stop asking about days.
const CALENDAR: &[&str] = &[
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];

/// The proper nouns a set of requests uses.
///
/// A capitalised token that appears somewhere OTHER than at the start of a
/// sentence — the first word of a sentence is capitalised by orthography, not
/// because it names anything. One-letter tokens and the contractions of the
/// first-person pronoun are English rather than names, and the calendar
/// vocabulary above is shared on purpose.
fn proper_nouns(requests: &[String]) -> BTreeSet<String> {
    let mut found = BTreeSet::new();
    for request in requests {
        for (position, token) in words(request).into_iter().enumerate() {
            let bare = token.trim_end_matches('\'').to_owned();
            if position == 0
                || bare.chars().count() < 2
                || !bare.chars().next().is_some_and(char::is_uppercase)
                || bare.starts_with("I'")
                || CALENDAR.contains(&bare.as_str())
            {
                continue;
            }
            found.insert(bare);
        }
    }
    found
}

fn words(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    for character in text.chars() {
        if character.is_alphabetic() || character == '\'' || character == '\u{2019}' {
            current.push(character);
        } else if !current.is_empty() {
            out.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

/// Lower-cased word tokens, punctuation dropped.
fn normalised(request: &str) -> Vec<String> {
    request
        .to_lowercase()
        .split(|character: char| !(character.is_alphanumeric() || character == '\''))
        .filter(|token| !token.is_empty())
        .map(str::to_owned)
        .collect()
}

fn three_grams(request: &str) -> BTreeSet<String> {
    let tokens = normalised(request);
    tokens
        .windows(3)
        .map(|window| window.join(" "))
        .collect()
}

/// What share of `rows` share a three-gram with anything in `reference`.
fn overlap(rows: &[String], reference: &BTreeSet<String>) -> (usize, usize, f64) {
    let hit = rows
        .iter()
        .filter(|request| three_grams(request).iter().any(|gram| reference.contains(gram)))
        .count();
    #[expect(clippy::cast_precision_loss, reason = "a share of a hundred-odd requests")]
    let rate = if rows.is_empty() {
        0.0
    } else {
        hit as f64 * 100.0 / rows.len() as f64
    };
    (hit, rows.len(), rate)
}

fn grams_of(rows: &[String]) -> BTreeSet<String> {
    rows.iter().flat_map(|request| three_grams(request)).collect()
}

#[test]
fn the_holdout_shares_no_proper_noun_with_either_other_corpus() {
    let suite = requests(&corpus("suite.json"));
    let blind = requests(&corpus("blind.json"));
    let holdout = requests(&corpus("holdout.json"));

    let mut theirs = proper_nouns(&suite);
    theirs.append(&mut proper_nouns(&blind));
    let ours = proper_nouns(&holdout);

    let shared: Vec<&String> = ours.intersection(&theirs).collect();
    assert!(
        shared.is_empty(),
        "the holdout names {} proper noun(s) the other corpora also name, so a candidate \
         fitted to their cast can resolve an anchor here without retrieving anything: {shared:?}",
        shared.len()
    );
    // AND BOTH SETS ARE REAL. A corpus whose requests named nobody would pass
    // the line above vacuously and would also not be a corpus.
    assert!(
        ours.len() >= 15 && theirs.len() >= 15,
        "one of the corpora names almost nobody — {} here, {} there",
        ours.len(),
        theirs.len()
    );
}

/// **THE NUMBER THE REVIEW ASKED FOR, PRINTED BESIDE THE ONE IT COMPLAINED
/// ABOUT.**
///
/// The cap is generous on purpose: a shared three-gram is usually English, and
/// the finding was never "the blind set shares phrases" but "the blind set
/// shares SUBJECTS". The assertion is that the holdout is in a different class
/// from the blind set, not that it is in a different language.
#[test]
fn the_holdout_shares_far_fewer_three_grams_than_the_blind_set_does() {
    let suite = requests(&corpus("suite.json"));
    let blind = requests(&corpus("blind.json"));
    let holdout = requests(&corpus("holdout.json"));

    let primary = grams_of(&suite);
    let mut both = primary.clone();
    both.extend(grams_of(&blind));

    let (blind_hit, blind_total, blind_rate) = overlap(&blind, &primary);
    let (ours_hit, ours_total, ours_rate) = overlap(&holdout, &primary);
    let (all_hit, all_total, all_rate) = overlap(&holdout, &both);

    println!("3-GRAM OVERLAP WITH THE PRIMARY SUITE");
    println!("  blind.json    {blind_hit}/{blind_total} = {blind_rate:.1}%");
    println!("  holdout.json  {ours_hit}/{ours_total} = {ours_rate:.1}%");
    println!("  holdout.json vs suite AND blind  {all_hit}/{all_total} = {all_rate:.1}%");

    assert!(
        ours_rate < blind_rate / 2.0,
        "the holdout shares a three-gram with the primary suite in {ours_rate:.1}% of its \
         requests against the blind set's {blind_rate:.1}% — it was supposed to be in a \
         different class, not the same one"
    );
    assert!(
        ours_rate <= 30.0,
        "{ours_rate:.1}% of holdout requests share a three-gram with the primary suite"
    );
}
