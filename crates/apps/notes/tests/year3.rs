//! YEAR-3 NOTES VOLUME, and the numbers the receipt reports (#1020, D-1020-N8).
//!
//! `crates/apps/kit::fixtures::year3_notes` writes the profile
//! [`YEAR3_NOTES`] declares: 10,000 notes against a 2,000-row window, 600 of
//! them carrying a 48 KiB body, 1,200 journal entries the four excluding folds
//! re-narrow over. This suite is what turns that into measurements.
//!
//! **A timing here is `ci-linux-x64-4c` and a DEBUG build.** Every number this
//! file prints is reported in the receipt as *projected provenance*
//! (D-1020-D3-7's pattern), never as a ceiling — the ledger's ceilings are the
//! root's and are measured on a release build.
//!
//! ## What is provable here, and what is not
//!
//! The **typing-latency target** (#1020 `:167`) is a round trip through the
//! editor's state machine on a reference device, and that machine is Kotlin
//! (`mobile/shared/src/commonMain/kotlin/dev/centraid/shared/screen/NotesEditorMachine.kt`)
//! with no Rust twin. What this box can measure is the half that IS Rust: the
//! editor's on-open pull over the largest body the product holds, and the
//! per-row derivation a shelf pays for every note in its window. Both are below;
//! the Kotlin half is an owner hand-off in `crates/apps/notes/README.md` with
//! the exact command.

use std::time::Instant;

use centraid_apps_kit::contract_vault::open_contract_vault;
use centraid_apps_kit::fixtures::{YEAR3_NOTES, Year3NotesShape, year3_notes};
use centraid_apps_kit::testdoor::TestDoor;
use centraid_apps_notes::cards::NoCards;
use centraid_apps_notes::derive::{check_of, preview_of};
use centraid_apps_notes::queries::{load_journal, load_library, load_note};

/// The seed every year-3 run uses, so two runs produce byte-identical rows.
const SEED: u64 = 679_003;

/// A smaller profile for the suite's own runtime, in the SHAPE of the declared
/// one. The declared profile is exercised by `the_declared_profile_seeds` alone,
/// because seeding 10,000 notes with 600 long bodies is the slow half.
const SAMPLE: Year3NotesShape = Year3NotesShape {
    notes: 2_400,
    trashed: 100,
    pinned: 50,
    journal_entries: 300,
    notebooks: 20,
    filed: 1_400,
    labels: 80,
    labelled: 700,
    extra_versions: 400,
    links: 300,
    anchored: 150,
    // Every field of the declared shape is named here, on purpose: a field added
    // to `Year3NotesShape` fails this literal rather than being inherited
    // silently, which is what "a count is not a distribution" means for a
    // sample that stands in for the profile.
    long_body_bytes: 48 * 1024,
    long_bodies: 60,
};

fn vault(shape: Year3NotesShape) -> rusqlite::Connection {
    let ddl = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../contracts/schema/vault-ddl.sql"),
    )
    .expect("the committed DDL is readable");
    let connection = open_contract_vault(&ddl, "[]").expect("the fixture vault is built");
    year3_notes(&connection, shape, SEED).expect("the year-3 corpus is seeded");
    connection
}

/// THE DECLARED PROFILE IS THE ONE THE RECEIPT REPORTS. Seeded once, counted,
/// and read at the declared window.
#[test]
fn the_declared_profile_seeds_and_the_library_walks_its_whole_window() {
    let connection = vault(YEAR3_NOTES);
    let counts = {
        let door = TestDoor::new(&connection);
        let started = Instant::now();
        let (library, denial) =
            load_library(&door, &NoCards, Some(2_000)).expect("the library folds");
        let elapsed = started.elapsed();
        assert!(denial.is_none());
        eprintln!(
            "year3 notes: library(limit=2000) folded {} rows + {} trashed in {elapsed:?}",
            library.notes.len(),
            library.trash.len()
        );
        (library.notes.len(), library.trash.len(), library.truncated)
    };
    let (notes, trash, truncated) = counts;

    // **THE DECLARED WINDOW IS WALKED, NOT CLAMPED** (D-1020-D3-12). v0 asks for
    // its 2,000-row window as ONE page and takes `.rows`, which `MAX_PAGE_ROWS`
    // clamps to 500 — so a v0 library at `limit: 2000` reads 500 notes while
    // declaring 2,000. Under 500 notes the two agree and every parity fixture is
    // in that range; at year-3 volume they do not, and this is the number.
    assert!(
        notes > 500,
        "a walked window reaches past one page; it reached {notes}"
    );
    // **AND IT MAY EXCEED THE WINDOW, BY UP TO THE PINNED SHELF.** "A bounded
    // recent window PLUS every pinned note" means the answer is the union of
    // two reads, so `notes` is 2,000 + the 200 pins that are older than the
    // window — which at this profile is every one of them. A port that clamped
    // the union to `window` would drop a pin, which is the bug the pinned shelf
    // exists to prevent.
    assert_eq!(
        notes, 2_200,
        "2,000 of the window plus the 200 pins that aged out of it"
    );
    assert!(truncated, "10,000 notes is longer than a 2,000-row window");
    assert!(
        trash <= 200,
        "the trash shelf is SHELF_ROWS, not the window"
    );
    eprintln!(
        "year3 notes: v0 would have folded 500 of the {notes} this window reaches \
         (D-1020-D3-12, the worse half)"
    );
}

/// THE EDITOR'S ON-OPEN PULL over the largest body the product holds.
///
/// 48 KiB is the biggest note the command will write — the inline budget is
/// 64 KiB and the fixture's long body is under it — so this is the worst case a
/// member can reach, not an invented one.
#[test]
fn the_editors_on_open_pull_over_a_long_body_is_measured() {
    let connection = vault(SAMPLE);
    let door = TestDoor::new(&connection);
    // Note 0 carries the long body by the generator's own rule.
    let started = Instant::now();
    let (note, denial) = load_note(&door, "note-000000").expect("the note reads");
    let elapsed = started.elapsed();
    assert!(denial.is_none());
    assert_eq!(
        note.body.len(),
        SAMPLE.long_body_bytes,
        "the largest body the product holds"
    );
    eprintln!(
        "year3 notes: note(48 KiB body) round trip in {elapsed:?} on ci-linux-x64-4c (debug)"
    );
}

/// THE PER-ROW DERIVATION a shelf pays for every note in its window.
///
/// A list row carries a 200-character preview and a checklist tally, and both
/// are computed from the WHOLE decoded body — which at the year-3 profile means
/// the fold reads 28 MB of text to draw 120 KB of shelf. That ratio is the whole
/// reason `preview` exists, and this is what one row of it costs.
#[test]
fn the_preview_derivation_over_a_long_body_is_measured() {
    let body = "lorem ipsum dolor sit amet ".repeat(48 * 1024 / 27);
    let started = Instant::now();
    let preview = preview_of(&body);
    let tally = check_of(&body);
    let elapsed = started.elapsed();
    assert_eq!(preview.chars().count(), 200);
    assert_eq!(tally.total, 0);
    eprintln!("year3 notes: preview+tally over a 48 KiB body in {elapsed:?}");

    // A CHECKLIST-HEAVY body is the other shape, and the tally walks every line.
    let checklist = "- [ ] follow up\n- [x] filed\n".repeat(2_000);
    let started = Instant::now();
    let tally = check_of(&checklist);
    eprintln!(
        "year3 notes: tally over {} checklist lines in {:?}",
        tally.total,
        started.elapsed()
    );
    assert_eq!(tally.total, 4_000);
    assert_eq!(tally.done, 2_000);
}

/// THE JOURNAL EXCLUSION'S OWN COST. Every one of the four excluding folds
/// re-narrows over this set in memory, so its size is part of the library's
/// cost — and the Journal place reads the same set the other way round.
#[test]
fn the_journal_set_is_read_once_and_excluded_four_ways() {
    let connection = vault(SAMPLE);
    let door = TestDoor::new(&connection);
    let started = Instant::now();
    let (journal, denial) = load_journal(&door, Some(2_000)).expect("the journal folds");
    let elapsed = started.elapsed();
    assert!(denial.is_none());
    assert_eq!(
        journal.entries.len(),
        SAMPLE.journal_entries,
        "every journal entry the profile declares"
    );
    assert!(!journal.truncated, "300 entries fits a 2,000-row window");
    eprintln!(
        "year3 notes: journal({} entries) folded in {elapsed:?}",
        journal.entries.len()
    );

    // And none of them is in the library.
    let (library, _) = load_library(&door, &NoCards, Some(2_000)).expect("the library folds");
    let journal_ids: std::collections::BTreeSet<&str> = journal
        .entries
        .iter()
        .map(|entry| entry.note_id.as_str())
        .collect();
    assert!(
        library
            .notes
            .iter()
            .chain(library.trash.iter())
            .all(|row| !journal_ids.contains(row.note_id.as_str()))
    );
}

/// THE GENERATOR IS DETERMINISTIC. Two runs of one seed produce the same rows,
/// because "a fixture that is not byte-reproducible is not an artifact".
#[test]
fn two_runs_of_one_seed_write_the_same_corpus() {
    let shape = Year3NotesShape {
        notes: 200,
        trashed: 10,
        pinned: 5,
        journal_entries: 20,
        notebooks: 4,
        filed: 100,
        labels: 8,
        labelled: 60,
        extra_versions: 20,
        links: 30,
        anchored: 10,
        long_bodies: 4,
        ..SAMPLE
    };
    let read = |connection: &rusqlite::Connection| {
        let door = TestDoor::new(connection);
        let (library, _) = load_library(&door, &NoCards, Some(2_000)).expect("the library folds");
        library
    };
    let first = read(&vault(shape));
    let second = read(&vault(shape));
    assert_eq!(first, second, "two runs of one seed disagree");
}
