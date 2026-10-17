//! THE THREE SHELVES THAT READ FOR THEMSELVES (Q-1047-7, owner ruling
//! 2026-10-15).
//!
//! The drive's window is the newest `limit` documents FILED, and Trash, Starred
//! and Recent are not defined by when a document was filed. Cut from the window
//! they inherited its cut: a trashed document filed long ago was on no Trash
//! shelf and in no Trash count, and a star on an old document was no star. Each
//! of the three now reads its own set once the window says `truncated`, and the
//! window keeps only the two shelves it does define, All and Folders.
//!
//! The year-3 generator is what makes the failure reachable at a size a test can
//! afford: its trashed and starred documents are the OLDEST filed, so a small
//! window holds none of them — and each claim below is stated against that.

use centraid_apps_docs::phone::{Arms, Shelf, View, shelve, shelve_with_arms};
use centraid_apps_docs::queries::{
    DocumentRow, DriveInput, ShelfArm, count_shelf_arm, load_drive, load_shelf_arm,
};
use centraid_apps_kit::contract_vault::open_contract_vault;
use centraid_apps_kit::error::{KitError, KitResult};
use centraid_apps_kit::fixtures::{Year3DocsShape, year3_docs};
use centraid_apps_kit::page::{Page, PageRequest};
use centraid_apps_kit::reads::PageDoor;
use centraid_apps_kit::row::Row;
use centraid_apps_kit::statement::PageQuery;
use centraid_apps_kit::testdoor::TestDoor;
use centraid_vault::time::zone::FireZone;
use std::path::Path;

/// 80 documents. The first ten are trashed and the first twenty starred — so
/// ten are BOTH (a star survives the trash) — and they are the ten and twenty
/// OLDEST filed, which a 20-row window never reaches.
const SHAPE: Year3DocsShape = Year3DocsShape {
    documents: 80,
    trashed: 10,
    starred: 20,
    folders: 4,
    folder_depth: 2,
    labels: 3,
    labelled: 0,
    extra_versions: 0,
};

const NOW_MS: i64 = 4_000_000_000_000;

fn seeded() -> rusqlite::Connection {
    let ddl = std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../contracts/schema/vault-ddl.sql"),
    )
    .expect("the committed DDL is readable");
    let connection = open_contract_vault(&ddl, "[]").expect("an empty fixture vault is built");
    year3_docs(&connection, SHAPE, 679_003).expect("the axis seeds");
    connection
}

fn zone() -> FireZone {
    FireZone::named("Etc/UTC").expect("a zone")
}

fn titles(documents: &[DocumentRow]) -> Vec<String> {
    documents
        .iter()
        .filter_map(|row| row.title.clone())
        .collect()
}

/// THE RED THIS CLOSES: under a window of twenty the Trash shelf is empty and
/// its count is zero while ten documents sit in the trash. This is what the
/// window's own cut answers, and it is asserted so the arm below is read against
/// the failure it replaces.
#[test]
fn the_window_alone_answers_an_empty_trash_while_ten_documents_are_in_it() {
    let connection = seeded();
    let door = TestDoor::new(&connection);
    let (drive, denial) = load_drive(&door, DriveInput { limit: Some(20) }).expect("it reads");
    assert!(denial.is_none() && drive.truncated);
    let trash = View {
        shelf: Shelf::Trash,
        ..View::default()
    };
    let cut = shelve(&drive, &trash, &zone(), "2099-06-01", NOW_MS);
    assert!(cut.documents.is_empty(), "the window holds no trashed row");
    assert_eq!(cut.trash_count, 0);
    assert_eq!(cut.starred_count, 0, "and no star either");
}

#[test]
fn the_trash_reads_its_own_set_and_its_count_is_the_whole_trash() {
    let connection = seeded();
    let door = TestDoor::new(&connection);
    let (arm, denial) = load_shelf_arm(&door, ShelfArm::Trash, 20).expect("the arm reads");
    assert!(denial.is_none());
    assert_eq!(arm.documents.len(), 10);
    assert!(arm.documents.iter().all(|row| row.trashed));
    assert!(!arm.filled, "ten trashed documents fit a window of twenty");
    // Each is decorated as a drive row is: filed, dated, and carrying the date
    // its grace window ends.
    assert!(
        arm.documents
            .iter()
            .all(|row| row.folder_id.is_some() && row.purge_at.is_some())
    );

    // THROUGH THE SHELF: the window's answer with the arm laid over it.
    let (drive, _) = load_drive(&door, DriveInput { limit: Some(20) }).expect("it reads");
    let arms = Arms {
        shelf: Some(arm),
        ..Arms::default()
    };
    let view = View {
        shelf: Shelf::Trash,
        ..View::default()
    };
    let shelf = shelve_with_arms(&drive, &arms, &view, &zone(), "2099-06-01", NOW_MS);
    assert_eq!(shelf.documents.len(), 10);
    assert_eq!(
        shelf.all_count, 20,
        "All is still the window's: it defines that shelf"
    );
    assert!(!arms.truncated(&Shelf::Trash, true));
}

#[test]
fn a_starred_document_in_the_trash_is_not_on_the_starred_shelf() {
    let connection = seeded();
    let door = TestDoor::new(&connection);
    let (arm, denial) = load_shelf_arm(&door, ShelfArm::Starred, 20).expect("the arm reads");
    assert!(denial.is_none());
    // Twenty stars, ten of them on trashed documents (a star survives trash).
    assert_eq!(arm.documents.len(), 10);
    assert!(arm.documents.iter().all(|row| row.starred && !row.trashed));
    assert!(!arm.filled);
    let names = titles(&arm.documents);
    assert!(names.contains(&"Document 000010".to_owned()));
    assert!(names.contains(&"Document 000019".to_owned()));
    assert!(
        !names.contains(&"Document 000009".to_owned()),
        "starred, but trashed"
    );
}

/// THE ARM STOPS AT ITS WINDOW AND SAYS SO: `filled` is the read's own cursor,
/// and the shelf reports `truncated` from it.
#[test]
fn an_arm_longer_than_its_window_says_it_is_truncated() {
    let connection = seeded();
    let door = TestDoor::new(&connection);

    let (starred, _) = load_shelf_arm(&door, ShelfArm::Starred, 4).expect("the arm reads");
    assert_eq!(starred.documents.len(), 4);
    assert!(starred.filled, "ten live stars, a window of four");
    // NEWEST-STARRED FIRST: the star lands when the document is filed in this
    // corpus, so the four are the four newest of the ten.
    assert_eq!(
        titles(&starred.documents),
        [
            "Document 000019",
            "Document 000018",
            "Document 000017",
            "Document 000016"
        ]
    );

    let (trash, _) = load_shelf_arm(&door, ShelfArm::Trash, 4).expect("the arm reads");
    assert_eq!(trash.documents.len(), 4);
    assert!(trash.filled);

    let arms = Arms {
        shelf: Some(starred),
        ..Arms::default()
    };
    assert!(
        arms.truncated(&Shelf::Starred, false),
        "the arm's own cursor"
    );
    assert!(
        !arms.truncated(&Shelf::Recent, true),
        "Recent is the newest fifty by definition, never a cut"
    );
    assert!(
        Arms::default().truncated(&Shelf::All, true),
        "and a shelf with no arm says what the window says"
    );
}

/// RECENT IS THE NEWEST FIFTY LIVE DOCUMENTS, whatever the window held: the
/// window's twenty are the newest filed, so they are the newest created too —
/// and the thirty after them are the ones the window could not give.
#[test]
fn recent_reads_the_newest_fifty_live_documents_beyond_the_window() {
    let connection = seeded();
    let door = TestDoor::new(&connection);
    let (arm, denial) = load_shelf_arm(&door, ShelfArm::Recent, 50).expect("the arm reads");
    assert!(denial.is_none());
    assert_eq!(arm.documents.len(), 50);
    assert!(arm.filled, "seventy live documents, a window of fifty");
    assert!(arm.documents.iter().all(|row| !row.trashed));
    assert_eq!(
        arm.documents.first().and_then(|row| row.title.as_deref()),
        Some("Document 000079"),
        "newest created first"
    );
    assert_eq!(
        arm.documents.last().and_then(|row| row.title.as_deref()),
        Some("Document 000030")
    );

    // THE SHELF'S OWN FOLD keeps it fifty and in that order, so the window's
    // twenty cannot be what the shelf shows.
    let (drive, _) = load_drive(&door, DriveInput { limit: Some(20) }).expect("it reads");
    let arms = Arms {
        shelf: Some(arm),
        ..Arms::default()
    };
    let view = View {
        shelf: Shelf::Recent,
        ..View::default()
    };
    let shelf = shelve_with_arms(&drive, &arms, &view, &zone(), "2099-06-01", NOW_MS);
    assert_eq!(shelf.documents.len(), 50);
    assert_eq!(drive.documents.len(), 20, "the window alone held twenty");
}

/// THE RAIL COUNTS THE WHOLE VAULT'S STARS AND TRASH, whichever shelf is open.
#[test]
fn the_counts_come_from_the_arms_and_not_from_the_window() {
    let connection = seeded();
    let door = TestDoor::new(&connection);
    let (trash, denial) = count_shelf_arm(&door, ShelfArm::Trash, 20).expect("it counts");
    assert!(denial.is_none());
    assert_eq!((trash.rows, trash.filled), (10, false));
    let (starred, _) = count_shelf_arm(&door, ShelfArm::Starred, 20).expect("it counts");
    assert_eq!((starred.rows, starred.filled), (10, false));
    let (capped, _) = count_shelf_arm(&door, ShelfArm::Starred, 6).expect("it counts");
    assert_eq!(
        (capped.rows, capped.filled),
        (6, true),
        "a count that stopped at its window is a floor, and says so"
    );

    let (drive, _) = load_drive(&door, DriveInput { limit: Some(20) }).expect("it reads");
    let arms = Arms {
        starred: Some(starred),
        trash: Some(trash),
        ..Arms::default()
    };
    let shelf = shelve_with_arms(
        &drive,
        &arms,
        &View::default(),
        &zone(),
        "2099-06-01",
        NOW_MS,
    );
    assert_eq!(shelf.trash_count, 10);
    assert_eq!(shelf.starred_count, 10);
    assert_eq!(shelf.documents.len(), 20, "All is the window's own rows");
}

/// WITH NO ARMS A DRIVE IS CUT EXACTLY AS IT WAS, which is what keeps every
/// non-truncated drive — and the parity corpus — unmoved.
#[test]
fn a_drive_with_no_arms_shelves_exactly_as_before() {
    let connection = seeded();
    let door = TestDoor::new(&connection);
    let (drive, _) = load_drive(&door, DriveInput { limit: Some(200) }).expect("it reads");
    assert!(!drive.truncated);
    for shelf in [Shelf::All, Shelf::Starred, Shelf::Recent, Shelf::Trash] {
        let view = View {
            shelf,
            ..View::default()
        };
        assert_eq!(
            shelve_with_arms(
                &drive,
                &Arms::default(),
                &view,
                &zone(),
                "2099-06-01",
                NOW_MS
            ),
            shelve(&drive, &view, &zone(), "2099-06-01", NOW_MS)
        );
    }
}

/// A door that refuses every read, as a revoked grant would.
struct Refusing;

impl PageDoor for Refusing {
    fn page(&self, _query: &PageQuery, _request: &PageRequest) -> KitResult<Page<Row>> {
        Err(KitError::Door("the grant was revoked".to_owned()))
    }
}

/// A DENIAL IS A STATE, NOT AN ERROR — for an arm as for every other loader.
#[test]
fn a_denied_door_answers_a_denial_from_every_arm() {
    for arm in [ShelfArm::Trash, ShelfArm::Starred, ShelfArm::Recent] {
        let (data, denial) = load_shelf_arm(&Refusing, arm, 20).expect("not an error");
        assert!(data.documents.is_empty() && !data.filled, "{arm:?}");
        assert_eq!(
            denial.and_then(|denial| denial.message).as_deref(),
            Some("the grant was revoked"),
            "{arm:?}"
        );
        let (count, denial) = count_shelf_arm(&Refusing, arm, 20).expect("not an error");
        assert_eq!(count.rows, 0);
        assert!(denial.is_some(), "{arm:?}");
    }
}
