//! YEAR-3 NOTES VOLUME, and the numbers the receipt reports (#1020, D-1020-N8;
//! rebuilt on the new model, #1135).
//!
//! `centraid_apps_kit::fixtures::year3_notes` writes the profile
//! [`YEAR3_NOTES`] declares: 10,000 notes against a 2,000-row window, 600 of them
//! carrying a 48 KiB body, 1,200 memos the excluding reads re-narrow over, 200
//! pins older than the window. This suite is what turns that into
//! measurements and asserts the two properties a count cannot: the pinned
//! shelf outlives the window, and a memo is on no shelf.
//!
//! **A timing here is `ci-linux-x64-4c` and a DEBUG build.** Every number this
//! file prints is reported as *projected provenance* (D-1020-D3-7's pattern),
//! never as a ceiling.
//!
//! The typing-latency target is a round trip through the editor's state machine
//! on a reference device, and that machine is Kotlin with no Rust twin. What this
//! box can measure is the half that is Rust: the editor's on-open pull over the
//! largest body the product holds, and the per-row derivation a shelf pays.

use std::sync::Arc;
use std::time::Instant;

use centraid_apps_kit::fixtures::{YEAR3_NOTES, Year3NotesShape, year3_notes};
use centraid_apps_kit::testdoor::TestDoor;
use centraid_apps_notes::queries::{load_journal, load_library, load_note};
use centraid_vault::Vault;
use centraid_vault::clock::{FixedClock, SeededIds};

/// The seed every year-3 run uses, so two runs produce byte-identical rows.
const SEED: u64 = 679_003;

/// A smaller profile for the suite's own runtime, in the SHAPE of the declared
/// one. Every field is named on purpose: a field added to the shape fails this
/// literal rather than being inherited silently.
const SAMPLE: Year3NotesShape = Year3NotesShape {
    notes: 2_400,
    trashed: 100,
    pinned: 50,
    memos: 300,
    notebooks: 20,
    filed: 1_400,
    tags: 80,
    tagged: 700,
    revisions: 400,
    links: 300,
    anchored: 150,
    long_body_bytes: 48 * 1024,
    long_bodies: 60,
};

struct Seeded {
    dir: std::path::PathBuf,
    vault: Vault,
    counts: centraid_apps_kit::fixtures::Year3NotesCounts,
}

impl Drop for Seeded {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn seeded(shape: Year3NotesShape) -> Seeded {
    let dir = centraid_ontology::scratch::scratch_dir();
    std::fs::create_dir_all(&dir).expect("a scratch directory");
    let vault = Vault::create_with(
        dir.join("vault.db"),
        Box::new(Arc::new(FixedClock::frozen())),
        Box::new(SeededIds::new("year3")),
    )
    .expect("a vault");
    vault.found("Year 3", "Owner").expect("founded");
    let owner = vault.self_id().expect("a read").expect("an owner");
    let counts = vault
        .commit(|tx| Ok(year3_notes(tx.connection(), &owner, shape, SEED).expect("seeded")))
        .expect("the corpus lands")
        .value;
    Seeded { dir, vault, counts }
}

fn read<T>(world: &Seeded, body: impl FnOnce(&TestDoor<'_>) -> T) -> T {
    world
        .vault
        .read(|connection| Ok(body(&TestDoor::new(connection))))
        .expect("a read")
}

/// THE WINDOW IS WALKED, THE PINS COME BESIDE IT, AND NO MEMO IS ON THE SHELF.
#[test]
fn the_library_walks_its_window_reads_every_pin_beside_it_and_leaves_the_memos_out() {
    let world = seeded(SAMPLE);
    let started = Instant::now();
    let (library, denial) = read(&world, |door| {
        load_library(door, Some(2_000)).expect("folds")
    });
    let elapsed = started.elapsed();
    assert!(denial.is_none());
    eprintln!(
        "year3 notes (sample): library(limit=2000) folded {} rows + {} trashed in {elapsed:?}",
        library.notes.len(),
        library.trash.len()
    );
    // A page is 500 rows (`MAX_PAGE_ROWS`); a walked window reaches past one.
    assert!(library.notes.len() > 500, "reached {}", library.notes.len());
    assert!(library.notes.iter().all(|row| !row.note_id.is_empty()) && library.trash.len() <= 200);
    // THE PINS: every one is older than the window and every one is on the shelf.
    let pinned = library.notes.iter().filter(|row| row.pinned).count();
    assert_eq!(
        pinned, SAMPLE.pinned,
        "a pin survives its note ageing out of the window"
    );
    // THE SHELF HOLDS NO MEMO: what it holds is the live notes that are about nothing.
    assert!(library.notes.len() <= world.counts.live_shelf_notes);
    assert_eq!(library.trash.len(), SAMPLE.trashed);
}

#[test]
fn the_journal_is_the_memos_and_only_the_memos_and_a_memo_opens_by_id() {
    let world = seeded(SAMPLE);
    let (journal, denial) = read(&world, |door| {
        load_journal(door, Some(2_000)).expect("reads")
    });
    assert!(denial.is_none());
    assert_eq!(journal.entries.len(), SAMPLE.memos);
    assert!(!journal.truncated);
    let (library, _) = read(&world, |door| {
        load_library(door, Some(2_000)).expect("folds")
    });
    let on_shelf: std::collections::BTreeSet<&str> = library
        .notes
        .iter()
        .map(|row| row.note_id.as_str())
        .collect();
    assert!(
        journal
            .entries
            .iter()
            .all(|entry| !on_shelf.contains(entry.note_id.as_str())),
        "a memo is on one place"
    );
    // THE BY-ID DOOR DOES NO MEMO READ: a People screen opens one.
    let first = &journal.entries[0].note_id;
    let (note, _) = read(&world, |door| load_note(door, first).expect("opens"));
    assert_eq!(&note.note_id, first);
    assert!(!note.body.is_empty());
}

/// THE DECLARED PROFILE IS THE ONE THE RECEIPT REPORTS. Seeded once, counted,
/// read at the declared window, and the largest body opened.
#[test]
#[ignore = "the declared 10,000-note profile; run for the receipt's numbers"]
fn the_declared_profile_seeds_and_the_numbers_are_printed() {
    let started = Instant::now();
    let world = seeded(YEAR3_NOTES);
    eprintln!(
        "year3 notes: seeded {:?} in {:?}",
        world.counts,
        started.elapsed()
    );
    let started = Instant::now();
    let (library, denial) = read(&world, |door| {
        load_library(door, Some(2_000)).expect("folds")
    });
    let fold = started.elapsed();
    assert!(denial.is_none());
    eprintln!(
        "year3 notes: library(limit=2000) folded {} rows + {} trashed in {fold:?}",
        library.notes.len(),
        library.trash.len()
    );
    assert!(
        library.truncated,
        "10,000 notes is longer than a 2,000-row window"
    );
    assert_eq!(
        library.notes.iter().filter(|row| row.pinned).count(),
        YEAR3_NOTES.pinned
    );
    // The editor's on-open pull over a long body.
    let long = (0..YEAR3_NOTES.notes)
        .step_by(YEAR3_NOTES.notes / YEAR3_NOTES.long_bodies)
        .map(|index| format!("note-{index:06}"))
        .next_back()
        .expect("a long note");
    let started = Instant::now();
    let (note, _) = read(&world, |door| load_note(door, &long).expect("opens"));
    eprintln!(
        "year3 notes: note() over a {} byte body in {:?}",
        note.body.len(),
        started.elapsed()
    );
    assert!(note.body.len() >= YEAR3_NOTES.long_body_bytes - 100);
}
