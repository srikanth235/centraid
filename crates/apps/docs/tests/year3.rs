//! THE DEMO DRIVE AND THE YEAR-3 DOCS AXIS (#1020, D-1020-DC5, D-1020-D3-7).
//!
//! Two generators, two jobs:
//!
//! * [`centraid_apps_kit::fixtures::docs_demo`] is v0's own 82-line seed as a
//!   generator — the drive a member opens on their first day. What it proves
//!   here is that the rows it writes are the rows the four queries can read: a
//!   folder rail, a starred and labelled document with two versions, and a
//!   document at the drive's top level.
//! * [`centraid_apps_kit::fixtures::year3_docs`] is the VOLUME the app's
//!   ceilings are stated at. v0's year-3 generator writes **no `core_document`
//!   rows at all** (#1020 apps §5.2), so the drive's 2,000-row window and the
//!   share fold's 4,000-row cap had no golden artifact behind them. This is
//!   that artifact.
//!
//! The year-3 run is `#[ignore]`d for the reason Photos' is: it seeds 8,000
//! documents and is longer than the whole `local` gate budget. A SHRUNKEN axis
//! runs unignored, through the same statements, so the generator cannot rot
//! while the measured number waits for a machine.

use centraid_apps_docs::queries::{DriveInput, load_drive, load_history, statement_names};
use centraid_apps_kit::contract_vault::open_contract_vault;
use centraid_apps_kit::fixtures::{
    DEMO_DOCUMENTS, DEMO_FOLDERS, DEMO_MEDIA_TYPE, YEAR3_DOCS, YEAR3_OWNER_PARTY, Year3DocsShape,
    docs_demo, year3_docs,
};
use centraid_apps_kit::reads::read_pages;
use centraid_apps_kit::testdoor::TestDoor;
use std::fs;
use std::path::{Path, PathBuf};

/// A civil date the caller states, so the generator reads no clock.
const NOW: &str = "2099-06-01";
const OWNER: &str = "party-owner";

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .to_path_buf()
}

/// An empty vault carrying the committed model and no rows.
fn empty_vault() -> rusqlite::Connection {
    let ddl = fs::read_to_string(root().join("contracts/schema/vault-ddl.sql"))
        .expect("the committed DDL is readable");
    open_contract_vault(&ddl, "[]").expect("an empty fixture vault is built")
}

/// The owner every seeded row attributes to.
fn with_owner(connection: &rusqlite::Connection, party_id: &str) {
    centraid_apps_kit::fixtures::seed_owner_party(connection, party_id, "Priya", NOW)
        .expect("the owner lands");
}

#[test]
fn the_demo_drive_is_readable_through_the_four_queries() {
    let connection = empty_vault();
    with_owner(&connection, OWNER);
    let counts = docs_demo(&connection, NOW, OWNER).expect("the demo drive seeds");
    assert_eq!(counts.folders, DEMO_FOLDERS.len());
    assert_eq!(counts.documents, DEMO_DOCUMENTS.len());
    // One document carries a second version, so there is one more content item
    // and one more occurrence than there are documents.
    assert_eq!(counts.content_items, DEMO_DOCUMENTS.len() + 1);
    assert_eq!(counts.revisions, DEMO_DOCUMENTS.len() + 1);
    // Three filings, one star, one label.
    assert_eq!(counts.tags, DEMO_DOCUMENTS.len() + 2);

    let door = TestDoor::new(&connection);
    let (data, denial) = load_drive(
        &door,
        DriveInput::default(),
        &format!("{NOW}T09:00:00.000Z"),
    )
    .expect("the drive reads");
    assert!(denial.is_none(), "the demo drive is not denied: {denial:?}");
    assert_eq!(data.documents.len(), DEMO_DOCUMENTS.len());
    assert_eq!(data.folders.len(), DEMO_FOLDERS.len());
    assert!(data.root_folder_id.is_some(), "the drive has a top level");
    assert!(!data.truncated, "three documents is not a full window");
    assert!(data.shared_from_known, "nothing was denied");

    // THE ROW THAT IS ALL THREE FACTS AT ONCE — starred, labelled, and two
    // versions deep — which is the row a renderer gets wrong.
    let packing = data
        .documents
        .iter()
        .find(|row| row.title.as_deref() == Some("Tahoe packing list"))
        .expect("the packing list is in the drive");
    assert!(packing.starred);
    assert_eq!(
        packing
            .tags
            .iter()
            .map(|tag| tag.label.as_str())
            .collect::<Vec<_>>(),
        ["tahoe"],
        "the star and the folder tag are not labels"
    );
    assert_eq!(packing.media_type.as_deref(), Some(DEMO_MEDIA_TYPE));
    assert!(!packing.trashed);
    let (history, _) = load_history(&door, &packing.document_id).expect("the history reads");
    assert_eq!(history.versions.len(), 2, "the edit is a second version");
    assert!(history.versions[0].current);
    assert_ne!(
        history.versions[0].content_id, history.versions[1].content_id,
        "two versions are two content items"
    );

    // EVERY DOCUMENT IS FILED EXACTLY ONCE, which is what makes the folder rail
    // a projection of the tags rather than of a column.
    for row in &data.documents {
        assert!(
            row.folder_id.is_some(),
            "{:?} is not filed, and every demo document is",
            row.title
        );
    }
}

/// The SHRUNKEN year-3 axis: the same generator and the same statements, at a
/// size the gate can afford.
#[test]
fn the_shrunken_axis_goes_through_the_same_statements() {
    let connection = empty_vault();
    let shape = Year3DocsShape {
        documents: 120,
        trashed: 10,
        starred: 20,
        folders: 8,
        folder_depth: 4,
        labels: 6,
        labelled: 40,
        extra_versions: 20,
        shares: 12,
        folder_shares: 6,
    };
    let counts = year3_docs(&connection, shape, 679_003).expect("the axis seeds");
    assert_eq!(counts.documents, shape.documents);
    assert_eq!(counts.trashed, shape.trashed);
    assert_eq!(counts.live_documents, shape.documents - shape.trashed);
    assert_eq!(counts.starred, shape.starred);
    assert_eq!(counts.folders, shape.folders);
    assert_eq!(counts.shares, shape.shares);
    // One content item per document, plus one for each second version.
    assert_eq!(
        counts.content_items,
        shape.documents + shape.extra_versions,
        "a second version is a second content item"
    );
    assert_eq!(counts.revisions, shape.documents + shape.extra_versions);

    let door = TestDoor::new(&connection);
    let (data, denial) =
        load_drive(&door, DriveInput::default(), "2097-06-01T09:00:00.000Z").expect("it reads");
    assert!(denial.is_none());
    // THE WINDOW IS THE DECLARED DEFAULT, and 120 documents fit inside it.
    assert_eq!(data.window, 200);
    assert!(!data.truncated);
    assert_eq!(data.documents.len(), shape.documents);
    // THE SHARE FOLD RAN over a four-level tree, and some of its answers came
    // through a folder.
    let entries: Vec<_> = data
        .documents
        .iter()
        .filter_map(|row| row.shared_with.data())
        .flatten()
        .collect();
    assert!(!entries.is_empty(), "the axis writes standing answers");
    assert!(
        entries
            .iter()
            .any(|entry| entry.via == centraid_apps_docs::shares::Via::Folder),
        "half the axis's answers are on folders"
    );
    // AND THE TRASH IS IN THE WINDOW, with purge dates.
    assert_eq!(
        data.documents.iter().filter(|row| row.trashed).count(),
        shape.trashed
    );
    assert!(
        data.documents
            .iter()
            .filter(|row| row.trashed)
            .all(|row| row.purge_at.is_some())
    );
}

/// A SMALLER WINDOW IS A SHORTER PAGE, and `truncated` is the page's own cursor
/// rather than a row count — which is what `rows.len() >= window` cannot say.
#[test]
fn a_window_smaller_than_the_drive_reports_truncated_from_its_cursor() {
    let connection = empty_vault();
    let shape = Year3DocsShape {
        documents: 80,
        trashed: 0,
        starred: 0,
        folders: 4,
        folder_depth: 2,
        labels: 2,
        labelled: 0,
        extra_versions: 0,
        shares: 0,
        folder_shares: 0,
    };
    year3_docs(&connection, shape, 679_003).expect("the axis seeds");
    let door = TestDoor::new(&connection);

    let (whole, _) = load_drive(&door, DriveInput::default(), "2097-06-01T09:00:00.000Z")
        .expect("the drive reads");
    assert_eq!(whole.documents.len(), 80);
    assert!(!whole.truncated, "80 documents fit in a 200-row window");

    let (short, _) = load_drive(
        &door,
        DriveInput { limit: Some(20) },
        "2097-06-01T09:00:00.000Z",
    )
    .expect("the drive reads");
    assert_eq!(short.window, 20);
    assert!(short.truncated, "there are sixty more");
    // AT MOST the window: the filing page is what bounds the row count, and two
    // documents share every filing instant so the keyset's pk tiebreak is
    // exercised at the boundary.
    assert!(short.documents.len() <= 20);
    assert!(!short.documents.is_empty());
}

/// The generator is DETERMINISTIC BY CONSTRUCTION: two runs of one seed write
/// the same rows, because a fixture that is not byte-reproducible is not an
/// artifact.
#[test]
fn the_generator_writes_the_same_rows_twice() {
    let shape = Year3DocsShape {
        documents: 40,
        trashed: 4,
        starred: 6,
        folders: 4,
        folder_depth: 2,
        labels: 4,
        labelled: 20,
        extra_versions: 8,
        shares: 4,
        folder_shares: 2,
    };
    let digest = |seed: u64| -> String {
        let connection = empty_vault();
        year3_docs(&connection, shape, seed).expect("the axis seeds");
        let door = TestDoor::new(&connection);
        let rows = read_pages(
            &door,
            &centraid_apps_docs::queries::taxonomy_concepts_statement(),
            centraid_apps_docs::queries::DOC_PAIR_BOUND,
        )
        .expect("the taxonomy reads");
        let (data, _) = load_drive(&door, DriveInput::default(), "2097-06-01T09:00:00.000Z")
            .expect("the drive reads");
        format!(
            "{}|{}|{:?}",
            rows.len(),
            data.documents.len(),
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
    assert_eq!(digest(679_003), digest(679_003));
    // And a DIFFERENT seed writes a different drive, so the seed is doing work.
    assert_ne!(digest(679_003), digest(42));
}

/// THE MEASURED RUN. Ignored for the reason Photos' is: 8,000 documents, 10,000
/// content items and 2,000 standing answers is longer than the whole `local`
/// gate budget, and the number it produces belongs in the journey ledger under
/// the root's own measurement.
///
/// ```text
/// cargo test -p centraid-apps-docs --test year3 -- --ignored --nocapture
/// ```
#[test]
#[ignore = "seeds 8,000 documents; longer than the whole `local` gate budget"]
fn the_year3_docs_axis_measures_the_drives_own_ceilings() {
    let connection = empty_vault();
    let started = std::time::Instant::now();
    let counts = year3_docs(&connection, YEAR3_DOCS, 679_003).expect("the axis seeds");
    let seeded = started.elapsed();
    assert_eq!(counts.documents, YEAR3_DOCS.documents);

    let door = TestDoor::new(&connection);
    let at = std::time::Instant::now();
    let (data, denial) = load_drive(
        &door,
        DriveInput { limit: Some(2_000) },
        "2097-06-01T09:00:00.000Z",
    )
    .expect("the drive reads");
    let read = at.elapsed();
    assert!(denial.is_none());
    assert!(data.truncated, "8,000 documents is four windows deep");
    // THE DECLARED WINDOW IS REACHED, not clamped to one page (D-1020-DC10).
    // v0 answers 500 here and calls it 2,000.
    assert_eq!(
        data.documents.len(),
        2_000,
        "the stated window is walked, and 500 is what one page would have given"
    );

    println!("year3 docs: seeded {counts:?} in {seeded:?}");
    println!(
        "year3 docs: a 2,000-row drive answered {} documents and {} folders in {read:?}",
        data.documents.len(),
        data.folders.len()
    );
    println!(
        "year3 docs: {} statements are named for the plan snapshot",
        statement_names().len()
    );
    println!("year3 docs: owner party is {YEAR3_OWNER_PARTY}");
}
