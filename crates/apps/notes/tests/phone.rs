//! THE PHONE'S SHELVES (#1046): the library's sort and filters, the trash
//! shelf on its own, the notebook spine and its counts, the editor's note and
//! the Journal by local day — over the demo corpus and an empty vault, and
//! through a door that refuses.
//!
//! No SQL appears here: the corpus is `centraid_apps_kit::fixtures::notes_demo`,
//! as in `library.rs`.

use centraid_apps_kit::contract_vault::open_contract_vault;
use centraid_apps_kit::error::{KitError, KitResult};
use centraid_apps_kit::fixtures::{
    NOTES_DEMO_OWNER, notes_demo, seed_collection, seed_owner_party,
};
use centraid_apps_kit::page::{Page, PageRequest};
use centraid_apps_kit::reads::PageDoor;
use centraid_apps_kit::row::Row;
use centraid_apps_kit::statement::PageQuery;
use centraid_apps_kit::testdoor::TestDoor;
use centraid_apps_notes::cards::{NoCards, OwnerCards};
use centraid_apps_notes::derive::CheckTally;
use centraid_apps_notes::queries::{JournalEntry, load_library};
use centraid_apps_notes::{
    LibraryFilter, Sort, journal_days, load_editor_note, load_notebooks, load_trash, shape_library,
};
use centraid_vault::time::zone::FireZone;
use rusqlite::Connection;

const NOW: &str = "2099-06-01";

fn ddl() -> String {
    std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../contracts/schema/vault-ddl.sql"),
    )
    .expect("the committed DDL is readable")
}

fn vault() -> Connection {
    let connection = open_contract_vault(&ddl(), "[]").expect("the fixture vault is built");
    seed_owner_party(&connection, NOTES_DEMO_OWNER, "Priya", NOW).expect("the owner is seeded");
    notes_demo(&connection, NOW, NOTES_DEMO_OWNER).expect("the corpus is seeded");
    connection
}

fn empty_vault() -> Connection {
    let connection = open_contract_vault(&ddl(), "[]").expect("the fixture vault is built");
    seed_owner_party(&connection, NOTES_DEMO_OWNER, "Priya", NOW).expect("the owner is seeded");
    connection
}

fn titles(rows: &[centraid_apps_notes::queries::LibraryRow]) -> Vec<&str> {
    rows.iter()
        .map(|row| row.title.as_deref().unwrap_or_default())
        .collect()
}

/// A door that refuses every read, the way a revoked grant would.
struct Refusing;

impl PageDoor for Refusing {
    fn page(&self, _query: &PageQuery, _request: &PageRequest) -> KitResult<Page<Row>> {
        Err(KitError::Door("the grant was revoked".to_owned()))
    }
}

#[test]
fn the_shelf_leads_with_pins_under_every_sort_and_filters_the_window() {
    let connection = vault();
    let door = TestDoor::new(&connection);
    let cards = OwnerCards::new(&door);
    let (library, denial) = load_library(&door, &cards, None).expect("the library folds");
    assert!(denial.is_none());

    let by_title = shape_library(
        library.clone(),
        &LibraryFilter {
            sort: Sort::Title,
            ..LibraryFilter::default()
        },
    );
    assert_eq!(
        titles(&by_title.notes),
        [
            "Packing list, reusable",
            "Drive vs fly",
            "Mom's chili, written down properly",
            "Scratch — books people keep recommending",
            "Tahoe long weekend — shortlist",
            "Weeknight mac and cheese",
        ],
        "the pin first, then A to Z"
    );
    assert!(by_title.trash.is_empty(), "the trash is its own query");

    let pinned = shape_library(
        library.clone(),
        &LibraryFilter {
            pinned_only: true,
            ..LibraryFilter::default()
        },
    );
    assert_eq!(titles(&pinned.notes), ["Packing list, reusable"]);

    let travel = shape_library(
        library.clone(),
        &LibraryFilter {
            notebook_id: Some("notebook-000001".to_owned()),
            ..LibraryFilter::default()
        },
    );
    assert_eq!(
        titles(&travel.notes),
        [
            "Packing list, reusable",
            "Tahoe long weekend — shortlist",
            "Drive vs fly",
        ],
        "the trashed Reno note is not on the shelf"
    );

    let unfiled = shape_library(
        library.clone(),
        &LibraryFilter {
            unfiled_only: true,
            ..LibraryFilter::default()
        },
    );
    assert_eq!(
        titles(&unfiled.notes),
        ["Scratch — books people keep recommending"],
        "the unfiled journal entry is not on the shelf (D-1020-N3)"
    );

    let concept = library
        .tags
        .first()
        .expect("the corpus tags a note")
        .concept_id
        .clone();
    let tagged = shape_library(
        library,
        &LibraryFilter {
            tag_concept_ids: vec![concept.clone()],
            ..LibraryFilter::default()
        },
    );
    assert!(!tagged.notes.is_empty());
    assert!(
        tagged
            .notes
            .iter()
            .all(|row| row.tags.iter().any(|tag| tag.concept_id == concept))
    );
}

#[test]
fn the_trash_shelf_holds_the_trashed_note_and_never_a_journal_entry() {
    let connection = vault();
    let door = TestDoor::new(&connection);
    let (trash, denial) = load_trash(&door, &NoCards).expect("the trash folds");
    assert!(denial.is_none());
    assert_eq!(titles(&trash), ["Reno flights — cancelled"]);
    assert!(trash[0].deleted_at.is_some() && trash[0].purge_at.is_some());
}

#[test]
fn the_spine_counts_live_notes_and_names_parents() {
    let connection = vault();
    let door = TestDoor::new(&connection);
    let (spine, denial) = load_notebooks(&door).expect("the spine folds");
    assert!(denial.is_none());
    let counts: Vec<(&str, usize)> = spine
        .notebooks
        .iter()
        .map(|notebook| {
            (
                notebook.name.as_deref().unwrap_or_default(),
                notebook.note_count,
            )
        })
        .collect();
    assert_eq!(
        counts,
        [("Travel", 3), ("Recipes", 2)],
        "Travel's trashed note does not count"
    );
    assert!(
        spine
            .notebooks
            .iter()
            .all(|notebook| notebook.parent_notebook_id.is_none())
    );
}

#[test]
fn the_editor_note_carries_its_base_and_opens_a_journal_entry_by_id() {
    let connection = vault();
    let door = TestDoor::new(&connection);
    let (note, denial) = load_editor_note(&door, "note-000001").expect("the note folds");
    assert!(denial.is_none());
    assert!(note.found);
    assert_eq!(note.title, "Tahoe long weekend — shortlist");
    assert_eq!(note.format, "markdown");
    assert!(note.body.starts_with("## Stays"), "the WHOLE body");
    assert!(note.current_revision_id.is_some(), "the base revision");
    assert!(note.row_version >= 1);
    assert_eq!(note.notebook_id.as_deref(), Some("notebook-000001"));
    assert!(note.deleted_at.is_none());

    // THE ASYMMETRY (D-1020-N3): the journal entry is absent from every list
    // and opens by id.
    let (journal, _) = load_editor_note(&door, "note-000008").expect("the entry folds");
    assert!(journal.found);
    assert_eq!(journal.title, "Coffee with Marco");

    let (trashed, _) = load_editor_note(&door, "note-000007").expect("the note folds");
    assert!(trashed.found && trashed.deleted_at.is_some());

    let (missing, denial) = load_editor_note(&door, "note-nope").expect("a miss folds");
    assert!(denial.is_none());
    assert!(
        !missing.found,
        "a miss is not an empty note a save would write"
    );
    assert_eq!(missing.note_id, "note-nope");
}

#[test]
fn an_empty_vault_answers_empty_shelves_and_no_note() {
    let connection = empty_vault();
    let door = TestDoor::new(&connection);
    let (spine, denial) = load_notebooks(&door).expect("the spine folds");
    assert!(denial.is_none() && spine.notebooks.is_empty());
    let (trash, denial) = load_trash(&door, &NoCards).expect("the trash folds");
    assert!(denial.is_none() && trash.is_empty());
    let (note, denial) = load_editor_note(&door, "note-000001").expect("a miss folds");
    assert!(denial.is_none() && !note.found);
    let (library, _) = load_library(&door, &NoCards, None).expect("the library folds");
    let shaped = shape_library(library, &LibraryFilter::default());
    assert!(shaped.notes.is_empty() && !shaped.truncated);
}

#[test]
fn a_refused_read_is_a_denial_beside_the_empty_shape() {
    let (spine, denial) = load_notebooks(&Refusing).expect("a refusal is a value");
    assert!(spine.notebooks.is_empty());
    assert_eq!(
        denial.and_then(|denial| denial.message).as_deref(),
        Some("the grant was revoked")
    );
    let (trash, denial) = load_trash(&Refusing, &NoCards).expect("a refusal is a value");
    assert!(trash.is_empty() && denial.is_some());
    let (note, denial) = load_editor_note(&Refusing, "note-000001").expect("a refusal is a value");
    assert!(!note.found && denial.is_some());
}

fn entry(note_id: &str, created_at: &str) -> JournalEntry {
    JournalEntry {
        note_id: note_id.to_owned(),
        title: Some(note_id.to_owned()),
        format: Some("plain".to_owned()),
        created_at: Some(created_at.to_owned()),
        updated_at: Some(created_at.to_owned()),
        deleted_at: None,
        preview: String::new(),
        check: CheckTally::default(),
    }
}

/// THE DAY IS THE ZONE'S, ACROSS A DST EDGE. New York springs forward at
/// 07:00Z on 8 March 2099. The same UTC hour, 04:30Z, is 23:30 on the 7th the
/// night before (UTC-5) and 00:30 on the 9th the night after (UTC-4) — so a
/// fixed offset would put one of them on the wrong day, and a UTC reading
/// would put both on the 8th.
#[test]
fn journal_days_are_local_days_across_a_dst_edge() {
    let zone = FireZone::named("America/New_York").expect("a known zone");
    let days = journal_days(
        vec![
            entry("before", "2099-03-08T04:30:00.000Z"),
            entry("after", "2099-03-09T04:30:00.000Z"),
            entry("after-late", "2099-03-09T15:00:00.000Z"),
        ],
        &zone,
    );
    let shape: Vec<(&str, Vec<(&str, &str)>)> = days
        .iter()
        .map(|day| {
            (
                day.day.as_str(),
                day.entries
                    .iter()
                    .map(|placed| (placed.entry.note_id.as_str(), placed.local_time.as_str()))
                    .collect(),
            )
        })
        .collect();
    assert_eq!(
        shape,
        [
            (
                "2099-03-09",
                vec![("after-late", "11:00"), ("after", "00:30")]
            ),
            ("2099-03-07", vec![("before", "23:30")]),
        ],
        "newest day first, newest entry first, and no day for the 8th"
    );

    let utc = FireZone::named("UTC").expect("a known zone");
    let flat = journal_days(
        vec![
            entry("before", "2099-03-08T04:30:00.000Z"),
            entry("after", "2099-03-09T04:30:00.000Z"),
        ],
        &utc,
    );
    assert_eq!(
        flat.iter().map(|day| day.day.as_str()).collect::<Vec<_>>(),
        ["2099-03-09", "2099-03-08"]
    );
    assert!(journal_days(Vec::new(), &zone).is_empty());
}

/// AN ALBUM IS NEVER A NOTEBOOK (rung six). `core_collection` holds Photos'
/// albums too; the spine and the library's own notebook list read
/// `kind = 'notebook'`, so an album — even an empty one, even one that shares a
/// notebook's name — is on neither.
#[test]
fn an_album_is_on_neither_the_spine_nor_the_library_list() {
    let connection = vault();
    seed_collection(
        &connection,
        "album-portugal",
        NOTES_DEMO_OWNER,
        "album",
        "Portugal",
        NOW,
    )
    .expect("the album is seeded");
    seed_collection(
        &connection,
        "album-travel",
        NOTES_DEMO_OWNER,
        "album",
        "Travel",
        NOW,
    )
    .expect("a same-named album is seeded");
    let door = TestDoor::new(&connection);

    let (spine, denial) = load_notebooks(&door).expect("the spine folds");
    assert!(denial.is_none());
    let ids: Vec<&str> = spine
        .notebooks
        .iter()
        .map(|notebook| notebook.notebook_id.as_str())
        .collect();
    assert!(
        ids.iter().all(|id| !id.starts_with("album-")),
        "the spine lists an album: {ids:?}"
    );
    assert_eq!(ids.len(), 2, "exactly the demo's two notebooks: {ids:?}");

    let (library, denial) = load_library(&door, &NoCards, None).expect("the library reads");
    assert!(denial.is_none());
    let names: Vec<&str> = library
        .notebooks
        .iter()
        .map(|notebook| notebook.notebook_id.as_str())
        .collect();
    assert!(
        names.iter().all(|id| !id.starts_with("album-")),
        "the library offers an album: {names:?}"
    );
}
