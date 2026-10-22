//! THE YEAR-3 DOCS AXIS: 8,000 documents, and what Docs measures on them (#1020,
//! D-1020-DC5; rebuilt on the new model, #1135).
//!
//! `centraid_apps_kit::fixtures::year3_docs` writes the profile [`YEAR3_DOCS`]
//! declares: 8,000 documents (400 in the trash) over 400 folders four levels
//! deep, 600 stars, 4,000 labelled documents and 2,000 replaced versions. v0's
//! generator wrote no document rows at all, so the drive's 2,000-row window and
//! the share fold's cap had no golden artifact behind them. This is that
//! artifact, and this suite is what turns it into properties a count cannot
//! state: the window is walked and not clamped to one page, the trash and the
//! stars outlive the window, and a folder's path is walked up the tree.
//!
//! **A timing here is `ci-linux-x64-4c` and a DEBUG build.** Every number this
//! file prints is reported as *projected provenance* (D-1020-D3-7's pattern),
//! never as a ceiling.
//!
//! The full profile is `#[ignore]`d: it seeds 8,000 documents. A shrunken one in
//! the same shape runs unignored through the SAME statements, so the generator
//! cannot rot while the measured number waits for a machine.

use std::sync::Arc;
use std::time::Instant;

use centraid_apps_docs::queries::{
    DriveInput, ShelfArm, count_shelf_arm, load_document, load_drive, load_history, load_shelf_arm,
    statement_names,
};
use centraid_apps_kit::fixtures::{YEAR3_DOCS, Year3DocsCounts, Year3DocsShape, year3_docs};
use centraid_apps_kit::testdoor::TestDoor;
use centraid_vault::Vault;
use centraid_vault::clock::{FixedClock, SeededIds};

/// The seed every year-3 run uses, so two runs produce byte-identical rows.
const SEED: u64 = 679_003;

/// A smaller profile for the suite's own runtime, in the SHAPE of the declared
/// one. Every field is named on purpose: a field added to the shape fails this
/// literal rather than being inherited silently.
const SAMPLE: Year3DocsShape = Year3DocsShape {
    documents: 1_200,
    trashed: 60,
    starred: 90,
    folders: 60,
    folder_depth: 4,
    labels: 40,
    labelled: 600,
    extra_versions: 300,
};

struct Seeded {
    dir: std::path::PathBuf,
    vault: Vault,
    counts: Year3DocsCounts,
}

impl Drop for Seeded {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn seeded(shape: Year3DocsShape, seed: u64) -> Seeded {
    let dir = centraid_ontology::scratch::scratch_dir();
    std::fs::create_dir_all(&dir).expect("a scratch directory");
    let vault = Vault::create_with(
        dir.join("vault.db"),
        Box::new(Arc::new(FixedClock::frozen())),
        Box::new(SeededIds::new("year3")),
    )
    .expect("a vault");
    vault.found("Year 3", "Owner").expect("founded");
    let counts = vault
        .commit(|tx| Ok(year3_docs(tx.connection(), shape, seed).expect("seeded")))
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

#[test]
fn the_generator_writes_the_counts_it_declares() {
    let world = seeded(SAMPLE, SEED);
    let counts = world.counts;
    assert_eq!(counts.documents, SAMPLE.documents);
    assert_eq!(counts.trashed, SAMPLE.trashed);
    assert_eq!(counts.live_documents, SAMPLE.documents - SAMPLE.trashed);
    assert_eq!(counts.starred, SAMPLE.starred);
    assert_eq!(counts.folders, SAMPLE.folders);
    assert_eq!(counts.labelled, SAMPLE.labelled);
    // A replaced version is a second blob and the revision that holds it.
    assert_eq!(counts.blobs, SAMPLE.documents + SAMPLE.extra_versions);
    assert_eq!(counts.revisions, SAMPLE.extra_versions);
}

/// THE WINDOW IS WALKED, AND `truncated` IS THE PAGE'S OWN CURSOR.
///
/// 1,200 documents against a 200-row default window and a 600-row stated one:
/// a window longer than one 500-row page is reached by walking, not clamped, and
/// the newest documents are the ones in it.
#[test]
fn the_drive_walks_its_stated_window_and_reports_truncated_from_its_cursor() {
    let world = seeded(SAMPLE, SEED);
    let (whole, denial) = read(&world, |door| {
        load_drive(door, DriveInput { limit: Some(2_000) }).expect("the drive reads")
    });
    assert!(denial.is_none());
    // 1,200 documents fit inside a 2,000-row window: nothing is cut.
    assert_eq!(whole.documents.len(), SAMPLE.documents);
    assert!(!whole.truncated);
    assert_eq!(whole.folders.len(), SAMPLE.folders);

    let (wide, _) = read(&world, |door| {
        load_drive(door, DriveInput { limit: Some(600) }).expect("the drive reads")
    });
    // THE DECLARED WINDOW IS REACHED, not clamped to one page: 600 is longer
    // than the 500 rows a page serves.
    assert_eq!(wide.window, 600);
    assert_eq!(wide.documents.len(), 600, "the stated window is walked");
    assert!(wide.truncated, "there are 600 more");

    let (short, _) = read(&world, |door| {
        load_drive(door, DriveInput::default()).expect("the drive reads")
    });
    assert_eq!(short.window, 200);
    assert_eq!(short.documents.len(), 200);
    assert!(short.truncated);
    // The trash is the OLDEST rows, so the newest window holds none of it.
    assert!(short.documents.iter().all(|row| !row.trashed));
}

/// THE TRASH AND THE STARS ARE NOT THE WINDOW'S: each reads its own set, so a
/// starred document older than the window is still on the starred shelf.
#[test]
fn the_trash_and_the_stars_outlive_the_window() {
    let world = seeded(SAMPLE, SEED);
    let (trash, _) = read(&world, |door| {
        load_shelf_arm(door, ShelfArm::Trash, 500).expect("the trash reads")
    });
    assert_eq!(trash.documents.len(), SAMPLE.trashed);
    assert!(!trash.filled);
    assert!(
        trash
            .documents
            .iter()
            .all(|row| row.trashed && row.purge_at.is_some())
    );

    let (starred, _) = read(&world, |door| {
        load_shelf_arm(door, ShelfArm::Starred, 500).expect("the stars read")
    });
    // The first `trashed` documents are in the trash and the stars start at the
    // oldest: a star on a trashed document is not on the live shelf.
    assert_eq!(starred.documents.len(), SAMPLE.starred - SAMPLE.trashed);
    assert!(
        starred
            .documents
            .iter()
            .all(|row| row.starred && !row.trashed)
    );

    let (count, _) = read(&world, |door| {
        count_shelf_arm(door, ShelfArm::Recent, 100).expect("the count reads")
    });
    assert_eq!(count.rows, 100);
    assert!(count.filled, "a shelf longer than its window is a floor");
}

/// A DOCUMENT OPENS BY ID, FROM ANYWHERE IN THE DRIVE, and its path is walked
/// up the folder tree to the top level.
#[test]
fn a_document_beyond_the_window_opens_with_its_folder_path_and_its_history() {
    let world = seeded(SAMPLE, SEED);
    // The oldest live document with a replaced version: far beyond the window.
    let oldest = format!("document-{:06}", SAMPLE.trashed);
    let (opened, denial) = read(&world, |door| load_document(door, &oldest).expect("opens"));
    assert!(denial.is_none());
    let row = opened.row.expect("the document is found");
    assert_eq!(row.document_id, oldest);
    assert!(row.folder_id.is_some(), "every document is filed once");
    // A path is at most `folder_depth` folders, top level first.
    assert!(!opened.path.is_empty() && opened.path.len() <= SAMPLE.folder_depth);
    assert_eq!(
        opened.path.last().map(|f| f.folder_id.as_str()),
        row.folder_id.as_deref()
    );
    assert!(opened.path[0].parent_id.is_none());

    let (history, _) = read(&world, |door| load_history(door, &oldest).expect("history"));
    assert_eq!(
        history.versions.len(),
        2,
        "the head and one replaced version"
    );
    assert!(history.versions[0].current);
}

/// THE GENERATOR IS DETERMINISTIC: two runs of one seed write the same rows, and
/// a different seed writes a different drive.
#[test]
fn the_generator_writes_the_same_rows_twice() {
    let digest = |seed: u64| -> String {
        let world = seeded(
            Year3DocsShape {
                documents: 120,
                trashed: 10,
                starred: 20,
                folders: 8,
                folder_depth: 4,
                labels: 6,
                labelled: 40,
                extra_versions: 20,
            },
            seed,
        );
        let (data, _) = read(&world, |door| {
            load_drive(door, DriveInput::default()).expect("the drive reads")
        });
        format!(
            "{:?}",
            data.documents
                .iter()
                .map(|row| (
                    row.document_id.clone(),
                    row.folder_id.clone(),
                    row.starred,
                    row.tags.len()
                ))
                .collect::<Vec<_>>()
        )
    };
    assert_eq!(digest(SEED), digest(SEED));
    assert_ne!(digest(SEED), digest(42));
}

/// THE DECLARED PROFILE IS THE ONE THE RECEIPT REPORTS. Seeded once, counted,
/// and the drive read at its declared ceiling.
///
/// ```text
/// cargo test -p centraid-apps-docs --test year3 -- --ignored --nocapture
/// ```
#[test]
#[ignore = "seeds 8,000 documents; longer than the whole `local` gate budget"]
fn the_year3_docs_axis_measures_the_drives_own_ceilings() {
    let started = Instant::now();
    let world = seeded(YEAR3_DOCS, SEED);
    eprintln!(
        "year3 docs: seeded {:?} in {:?}",
        world.counts,
        started.elapsed()
    );
    assert_eq!(world.counts.documents, YEAR3_DOCS.documents);
    assert_eq!(world.counts.blobs, 10_000);

    let started = Instant::now();
    let (data, denial) = read(&world, |door| {
        load_drive(door, DriveInput { limit: Some(2_000) }).expect("the drive reads")
    });
    let read_time = started.elapsed();
    assert!(denial.is_none());
    assert!(data.truncated, "8,000 documents is four windows deep");
    // THE DECLARED WINDOW IS REACHED, not clamped to one page: v0 answers 500
    // here and calls it 2,000.
    assert_eq!(data.documents.len(), 2_000);
    eprintln!(
        "year3 docs: a 2,000-row drive answered {} documents and {} folders in {read_time:?}",
        data.documents.len(),
        data.folders.len()
    );

    let started = Instant::now();
    let (trash, _) = read(&world, |door| {
        load_shelf_arm(door, ShelfArm::Trash, 500).expect("the trash reads")
    });
    eprintln!(
        "year3 docs: the trash shelf answered {} documents in {:?}",
        trash.documents.len(),
        started.elapsed()
    );
    assert_eq!(trash.documents.len(), YEAR3_DOCS.trashed);
    eprintln!(
        "year3 docs: {} statements are named for the plan snapshot",
        statement_names().len()
    );
}
