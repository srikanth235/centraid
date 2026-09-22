//! THE SECOND WORLD, PROVED — and proved DISJOINT from the first.
//!
//! `blind.json` holds out wording over the first world: a third of its handles
//! are rows `suite.json` also names, and half its requests share a three-gram
//! with a primary one. A candidate that memorised *this cast, this trip, this
//! dentist* transfers across it and the blind-versus-primary gap reports
//! generalisation nobody measured.
//!
//! [`Scenario::Second`] is what makes a SCENARIO holdout possible, and its
//! whole worth is the disjointness asserted below. A second world that quietly
//! reused a name — a merchant, a burst caption, a note template — would be the
//! wording holdout failing one level down, and it would be invisible in every
//! number the holdout produced.

use std::collections::{BTreeMap, BTreeSet};

use centraid_evalworld::{Inventory, Scenario, State, build_scenario};

/// The eight apps of the springboard.
const APPS: [&str; 8] = [
    "agenda", "docs", "locker", "notes", "people", "photos", "tally", "tasks",
];

fn second() -> (tempfile::TempDir, centraid_evalworld::World) {
    let dir = tempfile::tempdir().expect("a temp dir");
    let world = build_scenario(dir.path(), Scenario::Second).expect("the second world builds");
    (dir, world)
}

// ---------------------------------------------------------------------------
// WHAT A PROPER NOUN IS, for the purposes of the assertion below.
// ---------------------------------------------------------------------------

/// **A capitalised token that this world uses somewhere OTHER than at the
/// start of a label.**
///
/// A label is a sentence and its first word is capitalised by orthography, not
/// because it names anything: "Water the plants" and "Water bill 004" share a
/// verb and a utility, not a proper noun, and a check that called them a
/// collision would be a check nobody could keep green. So a token is admitted
/// to a world's proper-noun vocabulary only once that world has written it
/// capitalised in a NON-INITIAL position — "the Tahoe trip", "Dinner with
/// Neha", "call — Marco Ferreira" — and it is then compared at every position
/// it appears in.
///
/// Multi-word names survive the rule through their tails: "Emerald Bay" is
/// label-initial everywhere it appears, and `Bay` is not.
///
/// A ONE-LETTER TOKEN NAMES NOTHING. The English first-person pronoun is
/// capitalised mid-sentence in both worlds' ledgers ("Concert tickets I
/// fronted", "Rail tickets I fronted") and calling that a shared proper noun
/// would be the check mistaking English for a cast.
fn proper_nouns(inventory: &Inventory) -> BTreeSet<String> {
    let mut found = BTreeSet::new();
    for entity in &inventory.entities {
        for (position, token) in words(&entity.label).into_iter().enumerate() {
            if position > 0 && token.chars().count() > 1 && starts_upper(&token) {
                found.insert(token);
            }
        }
    }
    found
}

/// Every capitalised token of every label, wherever it sits.
fn capitalised_anywhere(inventory: &Inventory) -> BTreeSet<String> {
    let mut found = BTreeSet::new();
    for entity in &inventory.entities {
        for token in words(&entity.label) {
            if starts_upper(&token) {
                found.insert(token);
            }
        }
    }
    found
}

fn words(label: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    for character in label.chars() {
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

fn starts_upper(token: &str) -> bool {
    token.chars().next().is_some_and(char::is_uppercase)
}

// ---------------------------------------------------------------------------
// The assertions.
// ---------------------------------------------------------------------------

/// **THE ONE PROPERTY THE SECOND WORLD EXISTS FOR.**
///
/// Not "the casts differ" — the whole vocabularies, story and long tail alike,
/// across all eight apps. A tail that reused a merchant or a burst caption
/// would hand a fine-tune a word it had already been fitted to, and the
/// holdout corpus written over this world would be measuring the same thing
/// `blind.json` measures.
#[test]
fn the_two_worlds_share_no_proper_noun() {
    let first_dir = tempfile::tempdir().expect("a temp dir");
    let first = build_scenario(first_dir.path(), Scenario::First).expect("the first world builds");
    let (_second_dir, second) = second();

    let ours = proper_nouns(&second.inventory);
    let theirs = proper_nouns(&first.inventory);
    let shared: Vec<&String> = ours.intersection(&theirs).collect();
    assert!(
        shared.is_empty(),
        "the two worlds share {} proper noun(s), so the holdout would be a wording holdout \
         after all: {shared:?}",
        shared.len()
    );
    // AND THE VOCABULARIES ARE BOTH REAL. A world whose labels held no
    // capitalised token at all would pass the line above vacuously.
    assert!(
        ours.len() >= 40 && theirs.len() >= 40,
        "one of the worlds has almost no names in it — {} and {}",
        ours.len(),
        theirs.len()
    );

    // WHAT IS LEFT OVER IS REPORTED, NOT HIDDEN. These are the ordinary
    // English words both worlds capitalise at the start of a label; the test
    // does not forbid them and a reader should be able to see what they are.
    let ours_anywhere = capitalised_anywhere(&second.inventory);
    let theirs_anywhere = capitalised_anywhere(&first.inventory);
    let incidental: Vec<&String> = ours_anywhere.intersection(&theirs_anywhere).collect();
    println!(
        "label-initial words the two worlds share ({}): {incidental:?}",
        incidental.len()
    );
}

/// The second world is the same SHAPE and the same SIZE CLASS as the first.
///
/// A holdout over a thinner world would score a different question: "open
/// every board and read every label" is free at a hundred rows, and the gap
/// between the two corpora would then be a gap between two world sizes.
#[test]
fn the_second_world_is_the_first_world_s_size_class() {
    let (_dir, world) = second();
    let rows = world.inventory.entities.len();
    assert!(
        (4_000..8_000).contains(&rows),
        "the second world holds {rows} rows; the first holds about five thousand and the two \
         have to be comparable"
    );
    let counts: BTreeMap<String, usize> = world.inventory.counts().into_iter().collect();
    for app in APPS {
        let held = counts.get(app).copied().unwrap_or_default();
        assert!(
            held > 0,
            "the second world has no rows in {app}; a missing app scores every candidate as \
             perfect at it"
        );
    }
}

/// The planted ambiguities of the SECOND world, as floors.
///
/// Written as `>=` for the reason the first world's are: adding to the world
/// must not break them, and removing from it must.
#[test]
fn the_second_world_s_ambiguities_are_planted() {
    let (_dir, world) = second();
    let inventory = &world.inventory;

    // The subject that reaches across the apps, as "dentist" does in world 1.
    assert!(
        inventory.matching("optometrist").len() >= 6,
        "only {} rows say 'optometrist'",
        inventory.matching("optometrist").len()
    );

    // TWO WHOLE PEOPLE CALLED YUSUF, both live, plus a Tally friend who is a
    // bare first name. A first name that resolves is a first name nobody has
    // to disambiguate.
    let yusufs: Vec<_> = inventory
        .entities
        .iter()
        .filter(|row| {
            row.entity == "core.party" && row.state == State::Live && row.label.starts_with("Yusuf")
        })
        .collect();
    assert!(
        yusufs.len() >= 3,
        "only {} live parties are called Yusuf",
        yusufs.len()
    );

    // TWO LIVE HALLAS AND A TRASHED MISSPELLING.
    let hallas: Vec<_> = inventory
        .entities
        .iter()
        .filter(|row| row.entity == "core.party" && row.label.starts_with("Halla"))
        .collect();
    assert!(
        hallas.iter().filter(|row| row.state == State::Live).count() >= 3,
        "too few live Hallas"
    );
    assert!(
        hallas.iter().any(|row| row.state == State::Trashed),
        "the misspelled duplicate is not in the trash"
    );

    // AN EVENT AND A PLACE SHARING A NAME.
    let glass_beach: BTreeSet<&str> = inventory
        .matching("Glass Beach")
        .into_iter()
        .map(|row| row.entity.as_str())
        .collect();
    assert!(
        glass_beach.contains("core.event") && glass_beach.contains("core.place"),
        "'Glass Beach' is not both an event and a place: {glass_beach:?}"
    );

    // A TASK AND AN EVENT SHARING A TITLE.
    let cottage: BTreeSet<&str> = inventory
        .entities
        .iter()
        .filter(|row| row.label == "Reserve the Mendocino cottage")
        .map(|row| row.entity.as_str())
        .collect();
    assert!(
        cottage.contains("schedule.task") && cottage.contains("core.event"),
        "'Reserve the Mendocino cottage' is not both a task and an event: {cottage:?}"
    );

    // A PLACE WITH SEVERAL PHOTOGRAPHS — the row that tells a reader who walks
    // an asset's place apart from one that matches a title.
    let ridge = inventory
        .entities
        .iter()
        .filter(|row| row.entity == "core.place" && row.label == "Pygmy forest ridge")
        .count();
    assert_eq!(ridge, 1, "the two coast frames did not collapse into one place");

    // FIVE OBLIGATIONS ACROSS AT LEAST THREE PEOPLE, AND BOTH DIRECTIONS.
    let obligations: Vec<_> = inventory
        .entities
        .iter()
        .filter(|row| row.entity == "tally.obligation" && row.state == State::Live)
        .collect();
    assert!(
        obligations.len() >= 5,
        "only {} live obligations",
        obligations.len()
    );
    let parties: BTreeSet<&str> = obligations
        .iter()
        .filter_map(|row| row.facts.get("party").map(String::as_str))
        .collect();
    assert!(
        parties.len() >= 3,
        "the obligations name only {} people",
        parties.len()
    );
    assert!(
        obligations
            .iter()
            .any(|row| row.facts.get("direction").map(String::as_str) == Some("owe")),
        "no obligation points AT the owner, so `direction` is not load-bearing"
    );

    // FOUR ALBUMS. One makes "what album is that in" answerable by returning
    // the only album there is.
    let albums = inventory
        .entities
        .iter()
        .filter(|row| row.entity == "media.album" && row.state == State::Live)
        .count();
    assert!(albums >= 4, "only {albums} albums");

    // SOFT-DELETED ROWS ACROSS THE APPS.
    let trashed_apps: BTreeSet<&str> = inventory
        .entities
        .iter()
        .filter(|row| row.state == State::Trashed)
        .map(|row| row.app.as_str())
        .collect();
    assert!(
        trashed_apps.len() >= 6,
        "only {} app(s) hold a trashed row: {trashed_apps:?}",
        trashed_apps.len()
    );
}

/// The two worlds mint DIFFERENT IDS, and the same seed replays the second.
///
/// The id seeds differ on purpose: a row of one world carrying an id a row of
/// the other carries would make a handle resolved against the wrong inventory
/// silently score something.
#[test]
fn the_second_world_replays_and_does_not_collide_with_the_first() {
    let (_first_dir, first) = second();
    let (_second_dir, again) = second();
    let left: Vec<&str> = first
        .inventory
        .entities
        .iter()
        .map(|row| row.id.as_str())
        .collect();
    let right: Vec<&str> = again
        .inventory
        .entities
        .iter()
        .map(|row| row.id.as_str())
        .collect();
    assert_eq!(left, right, "the second world does not replay");
    assert_eq!(
        first.inventory.seed, "centraid-evalworld/2",
        "the second world is built under the first world's seed"
    );
}
