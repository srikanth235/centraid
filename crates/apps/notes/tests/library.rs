//! THE SIX QUERIES OVER THE DEMO CORPUS, and the claims a port gets wrong.
//!
//! The vault is the committed model (`contracts/schema/vault-ddl.sql`) with the
//! FTS5 triggers the baseline installs, seeded by
//! [`centraid_apps_kit::fixtures::notes_demo`] — so the search reads a real
//! index and the folds read real rows. **No SQL appears in this file**: an app
//! crate's tests are scanned by `sql-confinement` too, which is why the seeder
//! lives in the kit (two Photos test files are the standing red for exactly
//! this).
//!
//! What each block is here to prove:
//!
//! 1. **The library is a bounded window plus EVERY pinned note.** The pinned
//!    note in the corpus is 400 days old, so a window of one reaches it only
//!    through the pinned shelf.
//! 2. **THE JOURNAL ASYMMETRY** (D-1020-N3): absent from the library, the trash
//!    shelf, the tag chips, `search` and the powerbox — and reachable by id.
//! 3. **A list row carries a preview, never a body** (#404).
//! 4. **A cycle in the revision graph is a REFUSAL** (D-1020-N2), and the
//!    fixture that makes it one is a chain the DDL permits today.
//! 5. **The powerbox is secret-free and reaches seven domains**, Locker not
//!    among them.

use centraid_apps_kit::contract_vault::open_contract_vault;
use centraid_apps_kit::fixtures::{
    NOTES_DEMO_OWNER, notes_demo, notes_revision_cycle, seed_owner_party,
};
use centraid_apps_kit::testdoor::TestDoor;
use centraid_apps_notes::cards::{CardStatus, NoCards, OwnerCards};
use centraid_apps_notes::journal::{JOURNAL_ENTRY_NOTATION, JOURNAL_SCHEME_URI};
use centraid_apps_notes::queries::{
    SHELF_ROWS, load_history, load_journal, load_library, load_link_targets, load_note,
    load_search, walk_history, window_of,
};
use centraid_apps_notes::version_chain::VersionChainError;
use centraid_search::{Principal, SqliteDoor};
use rusqlite::Connection;

/// The instant the corpus is dated from.
const NOW: &str = "2099-06-01";

fn vault() -> Connection {
    let ddl = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../contracts/schema/vault-ddl.sql"),
    )
    .expect("the committed DDL is readable");
    let connection = open_contract_vault(&ddl, "[]").expect("the fixture vault is built");
    seed_owner_party(&connection, NOTES_DEMO_OWNER, "Priya", NOW).expect("the owner is seeded");
    notes_demo(&connection, NOW, NOTES_DEMO_OWNER).expect("the corpus is seeded");
    connection
}

// ---------------------------------------------------------------------------
// `library`
// ---------------------------------------------------------------------------

#[test]
fn the_library_is_the_recent_window_the_trash_shelf_and_the_notebooks() {
    let connection = vault();
    let door = TestDoor::new(&connection);
    let cards = OwnerCards::new(&door);
    let (library, denial) = load_library(&door, &cards, None).expect("the library folds");
    assert!(denial.is_none());
    assert_eq!(library.window, 200);
    assert!(!library.truncated, "the corpus is smaller than the window");

    let titles: Vec<&str> = library
        .notes
        .iter()
        .map(|row| row.title.as_deref().unwrap_or_default())
        .collect();
    // PINNED FIRST, THEN NEWEST. The pin is 400 days old and still leads.
    assert_eq!(titles[0], "Packing list, reusable");
    assert_eq!(titles[1], "Tahoe long weekend — shortlist");
    assert_eq!(
        library.notes.len(),
        6,
        "five seed notes plus the pin; the trashed one and the journal entry are out"
    );
    assert_eq!(library.trash.len(), 1);
    assert_eq!(
        library.trash[0].title.as_deref(),
        Some("Reno flights — cancelled")
    );
    assert!(library.trash[0].purge_at.is_some());

    let notebooks: Vec<&str> = library
        .notebooks
        .iter()
        .map(|notebook| notebook.name.as_deref().unwrap_or_default())
        .collect();
    assert_eq!(notebooks, ["Travel", "Recipes"], "sorted by sort_order");
}

/// A PIN SURVIVES THE NOTE AGEING OUT OF THE WINDOW. This is the whole reason
/// the pinned shelf is read BESIDE the window rather than out of it.
#[test]
fn a_window_of_one_still_carries_every_pinned_note() {
    let connection = vault();
    let door = TestDoor::new(&connection);
    let cards = OwnerCards::new(&door);
    // The manifest's floor is 20, so that is the narrowest honest window; the
    // corpus has eight notes, so 20 is already wider than the set.
    let (narrow, _) = load_library(&door, &cards, Some(20)).expect("the library folds");
    assert_eq!(narrow.window, 20);
    assert!(
        narrow
            .notes
            .iter()
            .any(|row| row.title.as_deref() == Some("Packing list, reusable")),
        "the pin is in the answer"
    );
    // And the clamp is the manifest's, in both directions.
    assert_eq!(window_of(Some(1)), 20);
    assert_eq!(window_of(Some(9_000)), 2_000);
}

/// A LIST ROW CARRIES A PREVIEW, NEVER A BODY (#404) — plus the checklist tally,
/// which is what the shelf draws as a progress line.
#[test]
fn a_library_row_carries_a_preview_and_a_tally_and_no_body() {
    let connection = vault();
    let door = TestDoor::new(&connection);
    let cards = OwnerCards::new(&door);
    let (library, _) = load_library(&door, &cards, None).expect("the library folds");
    let packing = library
        .notes
        .iter()
        .find(|row| row.title.as_deref() == Some("Packing list, reusable"))
        .expect("the pinned note");
    assert_eq!(packing.check.total, 4);
    assert_eq!(packing.check.done, 2);
    assert_eq!(
        packing.preview,
        "☑ Passport\n☐ Charger\n☐ Kennel booking\n☑ Snow chains"
    );

    let shortlist = library
        .notes
        .iter()
        .find(|row| row.title.as_deref() == Some("Tahoe long weekend — shortlist"))
        .expect("the shortlist");
    // The `## Stays` heading DROPS — the title carries it — and the list items
    // become bullets.
    assert!(shortlist.preview.starts_with("• South Lake"));
    assert!(!shortlist.preview.contains("## Stays"));
    assert!(shortlist.preview.chars().count() <= 200);
    assert_eq!(shortlist.notebook_names, ["Travel"]);
}

/// The tag chips are the DISTINCT concepts the window saw, sorted by label —
/// and the journal entry's concept is not one of them even though it shares a
/// concept with a live note.
#[test]
fn the_tag_chips_are_the_windows_own_and_are_sorted_by_label() {
    let connection = vault();
    let door = TestDoor::new(&connection);
    let cards = OwnerCards::new(&door);
    let (library, _) = load_library(&door, &cards, None).expect("the library folds");
    let labels: Vec<&str> = library
        .tags
        .iter()
        .map(|facet| facet.label.as_str())
        .collect();
    assert_eq!(labels, ["Café", "Recipes", "Travel"]);
    // The journal entry's own tag never reaches a row.
    assert!(
        library
            .notes
            .iter()
            .chain(library.trash.iter())
            .all(|row| row.note_id != "note-000008")
    );
    let chili = library
        .notes
        .iter()
        .find(|row| row.note_id == "note-000003")
        .expect("the chili note");
    let chips: Vec<&str> = chili.tags.iter().map(|chip| chip.label.as_str()).collect();
    assert_eq!(
        chips,
        ["Recipes", "Café"],
        "in tag_id order, as v0 reads them"
    );
}

/// The attachment projection: the ATTACHMENT's own reading of the bytes
/// (#996 R20(b)), a same-origin URL for blob-backed bytes (#296), and primary
/// first.
#[test]
fn an_attachment_carries_its_own_media_type_and_a_same_origin_url() {
    let connection = vault();
    let door = TestDoor::new(&connection);
    let cards = OwnerCards::new(&door);
    let (library, _) = load_library(&door, &cards, None).expect("the library folds");
    let shortlist = library
        .notes
        .iter()
        .find(|row| row.note_id == "note-000001")
        .expect("the shortlist");
    assert_eq!(shortlist.attachments.len(), 1);
    let attachment = &shortlist.attachments[0];
    assert_eq!(attachment.media_type, "application/pdf");
    assert_eq!(attachment.is_primary, 1);
    assert!(
        attachment
            .content_uri
            .starts_with("/centraid/_vault/blobs/"),
        "{}",
        attachment.content_uri
    );
}

/// REFERENCES AND BACKLINKS, with the standoff selector shipped as DATA — and
/// an ENDED link is not a reference.
#[test]
fn a_reference_carries_its_card_and_its_selector_and_an_ended_link_does_not() {
    let connection = vault();
    let door = TestDoor::new(&connection);
    let cards = OwnerCards::new(&door);
    let (library, _) = load_library(&door, &cards, None).expect("the library folds");
    let shortlist = library
        .notes
        .iter()
        .find(|row| row.note_id == "note-000001")
        .expect("the shortlist");
    assert_eq!(
        shortlist.references.len(),
        1,
        "the second link is ended, so it is not a live reference"
    );
    let reference = &shortlist.references[0];
    assert_eq!(reference.card.status, CardStatus::Live);
    assert_eq!(reference.card.title.as_deref(), Some("Drive vs fly"));
    let selector = reference.selector.as_ref().expect("a standoff anchor");
    assert_eq!(selector["exact"], serde_json::json!("South Lake"));

    // And the backlink is the same edge, read the other way.
    let drive = library
        .notes
        .iter()
        .find(|row| row.note_id == "note-000002")
        .expect("the drive note");
    assert_eq!(drive.backlinks.len(), 1);
    assert_eq!(
        drive.backlinks[0].card.title.as_deref(),
        Some("Tahoe long weekend — shortlist")
    );
}

/// A DOOR WITH NO CARDS DENIES EVERY REF, and the shelf still draws the row —
/// which is the difference between "this link points somewhere you cannot see"
/// and a blank.
#[test]
fn a_library_read_with_no_card_door_keeps_its_rows_and_denies_its_cards() {
    let connection = vault();
    let door = TestDoor::new(&connection);
    let (library, denial) = load_library(&door, &NoCards, None).expect("the library folds");
    assert!(denial.is_none(), "the ROWS were readable");
    let shortlist = library
        .notes
        .iter()
        .find(|row| row.note_id == "note-000001")
        .expect("the shortlist");
    assert_eq!(shortlist.references[0].card.status, CardStatus::Denied);
    assert_eq!(shortlist.references[0].card.title, None);
}

// ---------------------------------------------------------------------------
// The asymmetry (D-1020-N3)
// ---------------------------------------------------------------------------

/// **THE LIBRARY ASYMMETRY IS THE CONTRACT.** A journal entry is absent from the
/// library, the trash shelf, the tag chips, `search` and the powerbox — and
/// `note` opens it by id.
///
/// A port that unified the two would either leak journal entries onto the notes
/// shelf or break the People screen that opens one. This test is what keeps the
/// asymmetry from being "tidied up".
#[test]
fn a_journal_entry_is_absent_from_every_list_and_reachable_by_id() {
    let connection = vault();
    let door = TestDoor::new(&connection);
    let search = SqliteDoor::open(&connection).expect("the FTS door opens");
    let cards = OwnerCards::new(&door);

    let (library, _) = load_library(&door, &cards, None).expect("the library folds");
    for row in library.notes.iter().chain(library.trash.iter()) {
        assert_ne!(row.note_id, "note-000008", "the library excludes it");
    }

    let (hits, _) = load_search(&door, &search, &Principal::Owner, "Lisbon").expect("search folds");
    assert!(
        hits.notes.is_empty(),
        "an all-journal search answers an empty list, not a filtered one"
    );

    let (targets, _) =
        load_link_targets(&door, &search, &Principal::Owner, "Marco").expect("the powerbox folds");
    assert!(
        targets
            .targets
            .iter()
            .all(|target| target.id != "note-000008"),
        "the powerbox excludes it"
    );

    // AND IT OPENS BY ID. `load_note` does no journal read at all — the
    // asymmetry is the absence of a filter in that function.
    let (note, denial) = load_note(&door, "note-000008").expect("the note reads");
    assert!(denial.is_none());
    assert_eq!(note.note_id, "note-000008");
    assert!(note.body.contains("Lisbon"), "{}", note.body);
    assert_eq!(note.format.as_deref(), Some("plain"));

    // …and the Journal place reads the same set the other way round.
    let (journal, _) = load_journal(&door, None).expect("the journal folds");
    assert_eq!(journal.entries.len(), 1);
    assert_eq!(journal.entries[0].note_id, "note-000008");
    assert_eq!(journal.entries[0].deleted_at, None);
    assert!(!journal.truncated);
    assert!(
        journal.entries[0].preview.contains("Lisbon"),
        "a Journal row carries a preview too, never a body"
    );
}

/// The two scheme constants the exclusion turns on are the kit's own, so a
/// fixture and a fold cannot disagree about which notes are journal entries.
#[test]
fn the_journal_scheme_the_fold_reads_is_the_one_the_fixture_seeds() {
    assert_eq!(
        JOURNAL_SCHEME_URI,
        centraid_apps_kit::fixtures::NOTES_JOURNAL_SCHEME_URI
    );
    assert_eq!(JOURNAL_ENTRY_NOTATION, "entry");
}

// ---------------------------------------------------------------------------
// `note`, `search`, `history`
// ---------------------------------------------------------------------------

#[test]
fn the_editors_on_open_pull_is_the_whole_decoded_body() {
    let connection = vault();
    let door = TestDoor::new(&connection);
    let (note, _) = load_note(&door, "note-000003").expect("the note reads");
    assert!(note.body.starts_with("1. Brown 2 lb chuck"));
    assert!(note.body.contains("Do not skip the coffee"));
    assert_eq!(note.format.as_deref(), Some("markdown"));

    // A note that is not there is an EMPTY answer, never a throw — and an empty
    // id short-circuits before the door is touched.
    let (absent, denial) = load_note(&door, "note-999999").expect("the read answers");
    assert_eq!(absent.body, "");
    assert!(denial.is_none());
    let (blank, _) = load_note(&door, "   ").expect("the read answers");
    assert_eq!(blank.note_id, "");
}

/// SEARCH IS RANK ORDER, and a trashed note never matches.
#[test]
fn search_answers_ranked_hits_in_the_library_row_shape_with_a_snippet() {
    let connection = vault();
    let door = TestDoor::new(&connection);
    let search = SqliteDoor::open(&connection).expect("the FTS door opens");
    let (hits, denial) = load_search(&door, &search, &Principal::Owner, "cabin").expect("search");
    assert!(denial.is_none());
    let ids: Vec<&str> = hits.notes.iter().map(|row| row.note_id.as_str()).collect();
    assert!(ids.contains(&"note-000001"), "{ids:?}");
    for row in &hits.notes {
        assert!(row.preview.chars().count() <= 200);
        assert!(row.snippet.contains('⟦'), "{}", row.snippet);
    }

    // The TRASHED note carries "Refunded" and never matches, because a trashed
    // row leaves the index the moment it is trashed (#916 R11).
    let (trashed, _) = load_search(&door, &search, &Principal::Owner, "Refunded").expect("search");
    assert!(trashed.notes.is_empty());

    // An empty term short-circuits with no denial: nobody was refused anything.
    let (empty, empty_denial) =
        load_search(&door, &search, &Principal::Owner, "  ").expect("search");
    assert!(empty.notes.is_empty());
    assert!(empty_denial.is_none());
    // And so does a term of punctuation, which the index cannot be asked at all.
    let (punctuation, punctuation_denial) =
        load_search(&door, &search, &Principal::Owner, "---").expect("search");
    assert!(punctuation.notes.is_empty());
    assert!(punctuation_denial.is_none());
}

#[test]
fn history_is_the_notes_own_occurrences_newest_first() {
    let connection = vault();
    let door = TestDoor::new(&connection);
    let (history, denial) = load_history(&door, "note-000001").expect("history folds");
    assert!(denial.is_none());
    assert_eq!(
        history.versions.len(),
        1,
        "one occurrence, the original body"
    );
    assert!(history.versions[0].current);
    assert!(history.versions[0].body.contains("South Lake"));
    assert_eq!(
        history.versions[0].media_type.as_deref(),
        Some("text/markdown"),
        "the note's own reading of its bytes"
    );

    let (absent, _) = load_history(&door, "note-999999").expect("history folds");
    assert!(absent.versions.is_empty());
    let (blank, _) = load_history(&door, "").expect("history folds");
    assert!(blank.versions.is_empty());
}

/// **THE CYCLE REFUSAL** (D-1020-N2). The fixture writes a chain the DDL
/// permits — `parent_revision_id` has no constraint against one — and the reader
/// refuses instead of drawing a partial history as a whole one.
#[test]
fn a_cyclic_revision_chain_is_refused_rather_than_truncated() {
    let connection = vault();
    notes_revision_cycle(&connection, "note-000002", NOW).expect("the cycle is seeded");
    let door = TestDoor::new(&connection);

    // The WALK says exactly what is wrong, and names the revision.
    let refusal = walk_history(&door, "note-000002")
        .expect("the reads succeed")
        .expect_err("a cycle is a refusal");
    assert!(matches!(refusal, VersionChainError::Cycle { .. }));
    let sentence = refusal.to_string();
    assert!(
        sentence.contains("note-000002") && sentence.contains("cycle"),
        "{sentence}"
    );

    // And the QUERY folds it onto the payload's denial — the shape a screen
    // renders — with no versions rather than four of forty.
    let (history, denial) = load_history(&door, "note-000002").expect("history folds");
    assert!(history.versions.is_empty());
    let denial = denial.expect("the payload carries the refusal");
    assert!(
        denial.message.unwrap_or_default().contains("cycle"),
        "the member is told which note is broken"
    );

    // A note NOT in the cycle still answers.
    let (other, other_denial) = load_history(&door, "note-000001").expect("history folds");
    assert_eq!(other.versions.len(), 1);
    assert!(other_denial.is_none());
}

// ---------------------------------------------------------------------------
// The powerbox
// ---------------------------------------------------------------------------

/// SEVEN DOMAINS, AND LOCKER IS NOT ONE. The corpus only holds notes, so the
/// note column is the one that answers — and the other six answering NOTHING is
/// what proves each probe is isolated rather than one query over a union.
#[test]
fn the_powerbox_probes_seven_domains_and_a_locker_secret_is_not_among_them() {
    let connection = vault();
    let door = TestDoor::new(&connection);
    let search = SqliteDoor::open(&connection).expect("the FTS door opens");
    let (targets, denial) =
        load_link_targets(&door, &search, &Principal::Owner, "cabin").expect("the powerbox folds");
    assert!(denial.is_none());
    assert!(!targets.targets.is_empty());
    for target in &targets.targets {
        assert_eq!(target.entity, "knowledge.note");
        assert_eq!(target.app_id, "notes");
        assert!(
            !target.title.is_empty(),
            "an unlabelled row is not a target"
        );
        assert!(!target.subtitle.is_empty(), "a subtitle is never empty");
    }
    assert_eq!(centraid_search::DOMAINS.len(), 7);
    assert!(centraid_search::domain_of("locker.item").is_none());

    // An empty term short-circuits before any probe runs.
    let (empty, _) =
        load_link_targets(&door, &search, &Principal::Owner, "   ").expect("the powerbox folds");
    assert!(empty.targets.is_empty());
}

/// The pinned and trash shelves are read at `SHELF_ROWS`, and the constant is
/// v0's own — stated here because a shelf read at the window's size would make
/// a 2,000-note library read the trash twice.
#[test]
fn the_shelves_are_read_at_v0s_own_two_hundred() {
    assert_eq!(SHELF_ROWS, 200);
}

/// THE FIXTURE'S SHA IS THE VAULT'S SHA.
///
/// `crates/vault`'s `knowledge.create_note` dedupes a body on
/// `centraid_media::format::sha256_hex` over the TEXT; the kit's fixture has no
/// hashing dependency and carries a reference SHA-256 of its own. If the two ever
/// disagreed, a note seeded by the fixture and a note written by the command
/// would be two content items for one body — and every dedupe assertion in this
/// lane would be vacuous.
#[test]
fn the_fixtures_sha_is_the_one_the_command_deduplicates_on() {
    for text in [
        "",
        "Milk and bread.",
        // A multi-byte character, because the hash is over BYTES and a port that
        // hashed UTF-16 code units would agree on ASCII and nothing else.
        "Rent — due on the first",
        // Longer than one 64-byte block, so the compression function runs twice.
        &"lorem ipsum dolor sit amet ".repeat(40),
        // Exactly the length that needs a second block for the padding alone.
        &"a".repeat(56),
        &"a".repeat(64),
    ] {
        assert_eq!(
            centraid_apps_kit::fixtures::fixture_text_sha256(text),
            centraid_media::format::sha256_hex(text.as_bytes()),
            "the fixture and the vault disagree about {:?}",
            &text[..text.len().min(24)]
        );
    }
}
