//! The Notes editor (`notes.editor`): autosave, the create-then-edit life of a new
//! note, the pin, the powerbox, the derived title. Ports of the `NotesAppSpec`
//! editor cases, through `Driver`.

mod notes_support;

use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::act;
use centraid_screens::notes::{self, routes};
use centraid_screens::testing::Driver;
use notes_support::*;
use wire::notes_editor_event::{self as ev, Kind as N};

fn open_new(d: &mut Driver) -> u64 {
    d.push(notes::TAB, routes::new_note())
}

fn open(d: &mut Driver, id: &str) -> u64 {
    d.push(notes::TAB, routes::editor(id))
}

fn draft(v: &wire::ViewState) -> &wire::NotesEditorDraft {
    match &editor_state(v).content {
        Some(wire::notes_editor_state::Content::Draft(draft)) => draft,
        other => panic!("not a draft: {other:?}"),
    }
}

fn type_title(d: &mut Driver, i: u64, title: &str) {
    send_editor(
        d,
        i,
        N::Title(ev::TitleEdited {
            title: title.into(),
        }),
    );
}

fn type_body(d: &mut Driver, i: u64, body: &str) {
    send_editor(d, i, N::Body(ev::BodyEdited { body: body.into() }));
}

/// Let the debounce come due.
fn settle(d: &mut Driver) {
    d.pump(Duration::from_millis(1500));
}

fn link(v: &wire::ViewState) -> &wire::NotesLinkSheet {
    editor_state(v).link.as_ref().expect("the powerbox is open")
}

fn link_ids(v: &wire::ViewState) -> Vec<String> {
    match link(v).content.as_ref().unwrap() {
        wire::notes_link_sheet::Content::Data(data) => data
            .domains
            .iter()
            .flat_map(|domain| domain.rows.iter().map(|row| row.id.clone()))
            .collect(),
        other => panic!("no link data: {other:?}"),
    }
}

#[test]
fn a_new_note_reads_nothing_creates_on_first_save_then_edits() {
    let mut d = driver();
    clear_notes(&d);
    let i = open_new(&mut d);
    let state = editor_state(d.view(i));
    assert!(state.is_new && state.note_id.is_empty());
    assert_eq!(state.chrome.as_ref().unwrap().title, "New note");
    assert_eq!(state.chrome.as_ref().unwrap().close, "Cancel");
    assert_eq!(state.chrome.as_ref().unwrap().title_placeholder, "Title");
    assert_eq!(
        state.chrome.as_ref().unwrap().body_placeholder,
        "Write something"
    );
    assert!(!state.chrome.as_ref().unwrap().history_enabled);
    assert!(state.history.is_none());
    assert_eq!(draft(d.view(i)).title, "");

    type_title(&mut d, i, "Groceries");
    type_body(&mut d, i, "milk");
    assert_eq!(
        editor_state(d.view(i)).autosave.as_ref().unwrap().label,
        "Edited"
    );
    // Close stays Done after the first keystroke.
    assert_eq!(
        editor_state(d.view(i)).chrome.as_ref().unwrap().close,
        "Done"
    );
    // Nothing is in the vault until the debounce comes due.
    assert!(titles_in_library(&d).is_empty());
    settle(&mut d);
    let state = editor_state(d.view(i));
    assert!(!state.is_new && !state.note_id.is_empty());
    assert_eq!(state.autosave.as_ref().unwrap().label, "Saved");
    assert_eq!(state.chrome.as_ref().unwrap().status, "Saved");
    assert_eq!(state.chrome.as_ref().unwrap().title, "Note");
    assert!(state.chrome.as_ref().unwrap().history_enabled);
    assert_eq!(
        state.history,
        Some(routes::history(&state.note_id, "Groceries"))
    );
    let id = state.note_id.clone();
    let stored = note_of(&d, &id);
    assert_eq!(
        (stored.title.as_str(), stored.body.as_str()),
        ("Groceries", "milk")
    );
    assert_eq!(stored.format, "markdown");

    // THEN IT EDITS: the words typed after the create change the note it made.
    type_body(&mut d, i, "milk and eggs");
    settle(&mut d);
    assert_eq!(note_of(&d, &id).body, "milk and eggs");
    assert_eq!(
        titles_in_library(&d),
        ["Groceries"],
        "one note, never a second create"
    );
}

fn titles_in_library(d: &Driver) -> Vec<String> {
    let wire::app_query_response::Answer::NotesLibrary(library) = answer(
        d,
        centraid_screens::catalog::load::notes::Library {
            limit: 2000,
            ..Default::default()
        },
    ) else {
        panic!("the library answers");
    };
    library
        .notes
        .iter()
        .filter_map(|row| row.title.clone())
        .collect()
}

#[test]
fn a_note_with_neither_a_title_nor_a_line_is_not_yet_a_note() {
    let mut d = driver();
    let i = open_new(&mut d);
    type_body(&mut d, i, "   ");
    settle(&mut d);
    let autosave = editor_state(d.view(i)).autosave.clone().unwrap();
    assert!(autosave.refused);
    assert_eq!(autosave.label, "Write a line first.");
    assert_eq!(
        editor_state(d.view(i)).chrome.as_ref().unwrap().status,
        "Write a line first."
    );
    // The words stay on screen.
    assert_eq!(draft(d.view(i)).body, "   ");
    assert!(editor_state(d.view(i)).is_new);
}

#[test]
fn leaving_saves_what_is_unsaved() {
    let mut d = driver();
    let i = open_new(&mut d);
    type_body(&mut d, i, "Left unsaved on purpose");
    let before = titles_in_library(&d);
    assert!(!before.contains(&"Left unsaved on purpose".to_owned()));
    d.pop(notes::TAB, i);
    assert!(titles_in_library(&d).contains(&"Left unsaved on purpose".to_owned()));
}

#[test]
fn an_existing_note_opens_on_its_words_and_saves_the_title_alone() {
    let mut d = driver();
    let id = note(&d, "Plans", "first draft");
    let i = open(&mut d, &id);
    assert_eq!(draft(d.view(i)).title, "Plans");
    assert_eq!(draft(d.view(i)).body, "first draft");
    assert_eq!(
        editor_state(d.view(i)).chrome.as_ref().unwrap().close,
        "Cancel"
    );
    assert!(
        editor_state(d.view(i))
            .chrome
            .as_ref()
            .unwrap()
            .history_enabled
    );
    type_title(&mut d, i, "Plans v2");
    settle(&mut d);
    let stored = note_of(&d, &id);
    assert_eq!(
        (stored.title.as_str(), stored.body.as_str()),
        ("Plans v2", "first draft")
    );
    // CLOSE STAYS DONE after the autosave and the re-read that follows.
    assert_eq!(
        editor_state(d.view(i)).chrome.as_ref().unwrap().close,
        "Done"
    );
    assert_eq!(draft(d.view(i)).title, "Plans v2");
}

#[test]
fn a_change_from_the_vault_never_takes_the_words_being_typed() {
    let mut d = driver();
    let id = note(&d, "Plans", "first draft");
    let i = open(&mut d, &id);
    type_body(&mut d, i, "my typing");
    // Another surface edits the note while words are unsaved.
    arrange(
        &d,
        act::notes::EditNote {
            note_id: id.clone(),
            title: Some("Elsewhere".into()),
            ..Default::default()
        },
    );
    d.pump(Duration::from_millis(200));
    assert_eq!(draft(d.view(i)).body, "my typing");
    assert!(
        editor_state(d.view(i))
            .autosave
            .as_ref()
            .unwrap()
            .remote_changed
    );
    settle(&mut d);
    // Saved, then the vault is read again: both edits stand.
    let stored = note_of(&d, &id);
    assert_eq!(stored.body, "my typing");
    assert_eq!(draft(d.view(i)).title, "Elsewhere");
}

#[test]
fn a_pin_is_its_own_write_sent_at_once() {
    let mut d = driver();
    let id = note(&d, "Plans", "x");
    let i = open(&mut d, &id);
    assert_eq!(
        editor_state(d.view(i)).chrome.as_ref().unwrap().pin_label,
        "Pin"
    );
    send_editor(&mut d, i, N::Pin(ev::PinToggled {}));
    assert!(note_of(&d, &id).pinned);
    assert!(draft(d.view(i)).pinned);
    assert_eq!(
        editor_state(d.view(i)).chrome.as_ref().unwrap().pin_label,
        "Unpin"
    );
    send_editor(&mut d, i, N::Pin(ev::PinToggled {}));
    assert!(!note_of(&d, &id).pinned);
}

#[test]
fn a_pin_chosen_before_the_note_exists_lands_once_its_create_does() {
    let mut d = driver();
    let i = open_new(&mut d);
    type_body(&mut d, i, "Pinned from the start");
    send_editor(&mut d, i, N::Pin(ev::PinToggled {}));
    assert!(draft(d.view(i)).pinned);
    settle(&mut d);
    let id = editor_state(d.view(i)).note_id.clone();
    assert!(!id.is_empty());
    assert!(note_of(&d, &id).pinned);
}

#[test]
fn a_title_derived_from_the_body_stays_derived_after_the_re_read() {
    let mut d = driver();
    let i = open_new(&mut d);
    type_body(&mut d, i, "Milk and eggs\nsecond line");
    settle(&mut d);
    let id = editor_state(d.view(i)).note_id.clone();
    // The vault names it for its first line; the field stays empty.
    assert_eq!(note_of(&d, &id).title, "Milk and eggs");
    assert_eq!(draft(d.view(i)).title, "");
    // A later first-line edit renames the note.
    type_body(&mut d, i, "Bread and eggs\nsecond line");
    settle(&mut d);
    assert_eq!(note_of(&d, &id).title, "Bread and eggs");
    assert_eq!(draft(d.view(i)).title, "");
    // A name from anywhere else is adopted.
    arrange(
        &d,
        act::notes::EditNote {
            note_id: id.clone(),
            title: Some("Shopping".into()),
            ..Default::default()
        },
    );
    assert_eq!(note_of(&d, &id).title, "Shopping");
    d.pump(Duration::from_millis(400));
    assert_eq!(draft(d.view(i)).title, "Shopping");
}

#[test]
fn a_cleared_name_saves_as_cleared_the_first_line_when_there_is_one_else_empty() {
    let mut d = driver();
    let id = note(&d, "Named", "line one\nline two");
    let i = open(&mut d, &id);
    type_title(&mut d, i, "");
    settle(&mut d);
    assert_eq!(note_of(&d, &id).title, "line one");
    // No first line: a changed title is sent empty.
    let bare = note(&d, "Bare", "");
    let j = open(&mut d, &bare);
    type_title(&mut d, j, "");
    settle(&mut d);
    assert_eq!(note_of(&d, &bare).title, "");
}

#[test]
fn the_body_is_always_here_so_a_cleared_body_is_saved_as_empty() {
    let mut d = driver();
    let id = note(&d, "Keep", "words");
    let i = open(&mut d, &id);
    type_body(&mut d, i, "");
    settle(&mut d);
    assert_eq!(note_of(&d, &id).body, "");
}

#[test]
fn a_note_that_is_not_here_or_is_in_the_trash_is_a_sentence_not_an_empty_editor() {
    let mut d = driver();
    let gone = open(&mut d, "no-such-note");
    match &editor_state(d.view(gone)).content {
        Some(wire::notes_editor_state::Content::Failure(failure)) => {
            assert_eq!(failure.sentence, "This note isn't on this phone.");
        }
        other => panic!("not a failure: {other:?}"),
    }
    let id = note(&d, "Doomed", "x");
    arrange(
        &d,
        act::notes::DeleteNote {
            note_id: id.clone(),
        },
    );
    let trashed = open(&mut d, &id);
    match &editor_state(d.view(trashed)).content {
        Some(wire::notes_editor_state::Content::Failure(failure)) => {
            assert_eq!(failure.sentence, "This note is in the trash.");
        }
        other => panic!("not a failure: {other:?}"),
    }
}

#[test]
fn send_to_agenda_is_a_route_to_agendas_todo_with_the_words_waiting() {
    let mut d = driver();
    let id = note(&d, "Call the plumber", "tomorrow morning");
    let i = open(&mut d, &id);
    let state = editor_state(d.view(i));
    assert_eq!(
        state.chrome.as_ref().unwrap().send_to_agenda_label,
        "Send to Agenda"
    );
    assert_eq!(
        state.send_to_agenda,
        Some(centraid_screens::agenda::routes::home(
            wire::AgendaDestination::Todo,
            "Call the plumber"
        ))
    );
    // With no title, the body's first line.
    let untitled = open_new(&mut d);
    assert!(editor_state(d.view(untitled)).send_to_agenda.is_none());
    type_body(&mut d, untitled, "Buy stamps\nand envelopes");
    assert_eq!(
        editor_state(d.view(untitled)).send_to_agenda,
        Some(centraid_screens::agenda::routes::home(
            wire::AgendaDestination::Todo,
            "Buy stamps"
        ))
    );
}

// ---------------------------------------------------------------------------
// The powerbox
// ---------------------------------------------------------------------------

#[test]
fn the_powerbox_reads_link_targets_grouped_by_domain() {
    let mut d = driver();
    let target = note(&d, "Middlemarch", "a novel");
    let id = note(&d, "Reading", "see");
    let i = open(&mut d, &id);
    send_editor(&mut d, i, N::LinkRequested(ev::LinkRequested {}));
    let sheet = link(d.view(i));
    assert_eq!(sheet.title, "Link to");
    assert_eq!(sheet.search_placeholder, "Search everything");
    assert_eq!(
        sheet.foot,
        "Locker items link by name; their secrets stay locked."
    );
    send_editor(
        &mut d,
        i,
        N::LinkTerm(ev::LinkTerm {
            term: "middlemarch".into(),
        }),
    );
    assert!(link_ids(d.view(i)).contains(&target));
    match link(d.view(i)).content.as_ref().unwrap() {
        wire::notes_link_sheet::Content::Data(data) => {
            let notes_group = data
                .domains
                .iter()
                .find(|domain| domain.head.as_ref().unwrap().title == "Notes")
                .expect("a Notes group");
            let row = notes_group
                .rows
                .iter()
                .find(|row| row.id == target)
                .unwrap();
            assert_eq!(row.title, "Middlemarch");
            // The index names the app where a row has no column of its own, so the
            // row says what KIND of thing it is.
            assert_eq!(row.subtitle, "Note");
            assert_eq!(row.app_id, "notes");
        }
        other => panic!("{other:?}"),
    }
    // Nothing matches: one sentence.
    send_editor(
        &mut d,
        i,
        N::LinkTerm(ev::LinkTerm {
            term: "zzqxvv".into(),
        }),
    );
    match link(d.view(i)).content.as_ref().unwrap() {
        wire::notes_link_sheet::Content::Data(data) => {
            assert_eq!(
                data.empty.as_ref().unwrap().body,
                "Nothing matches that search."
            );
        }
        other => panic!("{other:?}"),
    }
    send_editor(&mut d, i, N::LinkDismissed(ev::LinkDismissed {}));
    assert!(editor_state(d.view(i)).link.is_none());
}

#[test]
fn a_pick_lands_the_link_at_the_end_set_apart_and_autosaves() {
    let mut d = driver();
    let target = note(&d, "Middlemarch", "a novel");
    let id = note(&d, "Reading", "Finished");
    let i = open(&mut d, &id);
    send_editor(&mut d, i, N::LinkRequested(ev::LinkRequested {}));
    send_editor(
        &mut d,
        i,
        N::LinkTerm(ev::LinkTerm {
            term: "middlemarch".into(),
        }),
    );
    send_editor(&mut d, i, N::LinkPicked(ev::LinkPicked { id: target }));
    assert!(editor_state(d.view(i)).link.is_none());
    assert_eq!(draft(d.view(i)).body, "Finished [[Middlemarch]]");
    settle(&mut d);
    assert_eq!(note_of(&d, &id).body, "Finished [[Middlemarch]]");
}

#[test]
fn typing_two_brackets_opens_the_powerbox_and_a_pick_replaces_them() {
    let mut d = driver();
    let target = note(&d, "Middlemarch", "a novel");
    let id = note(&d, "Reading", "See ");
    let i = open(&mut d, &id);
    type_body(&mut d, i, "See [[");
    assert!(editor_state(d.view(i)).link.is_some());
    send_editor(
        &mut d,
        i,
        N::LinkTerm(ev::LinkTerm {
            term: "middlemarch".into(),
        }),
    );
    send_editor(&mut d, i, N::LinkPicked(ev::LinkPicked { id: target }));
    assert_eq!(draft(d.view(i)).body, "See [[Middlemarch]]");
    settle(&mut d);
    assert_eq!(note_of(&d, &id).body, "See [[Middlemarch]]");
    // A `[[` already in the note never reopens it.
    type_body(&mut d, i, "See [[Middlemarch]]!");
    assert!(editor_state(d.view(i)).link.is_none());
}

#[test]
fn a_tag_is_its_own_write_added_and_removed_at_once_and_waits_for_the_first_save() {
    let mut d = driver();
    // A note not yet created has nothing to tag: the field is not offered.
    let fresh = open_new(&mut d);
    assert_eq!(
        editor_state(d.view(fresh))
            .chrome
            .as_ref()
            .unwrap()
            .tag_placeholder,
        ""
    );
    send_editor(
        &mut d,
        fresh,
        N::TagAdded(ev::TagAdded {
            label: "early".into(),
        }),
    );
    assert!(editor_state(d.view(fresh)).tags.is_empty());

    let id = note(&d, "Plans", "x");
    let i = open(&mut d, &id);
    assert_eq!(
        editor_state(d.view(i))
            .chrome
            .as_ref()
            .unwrap()
            .tag_placeholder,
        "Add a tag"
    );
    send_editor(
        &mut d,
        i,
        N::TagAdded(ev::TagAdded {
            label: "  work ".into(),
        }),
    );
    let tags = &editor_state(d.view(i)).tags;
    assert_eq!(tags.len(), 1);
    assert_eq!(
        (tags[0].label.as_str(), tags[0].remove_label.as_str()),
        ("work", "Remove tag")
    );
    assert_eq!(note_of(&d, &id).tags.len(), 1);
    // A blank label writes nothing.
    send_editor(
        &mut d,
        i,
        N::TagAdded(ev::TagAdded {
            label: "   ".into(),
        }),
    );
    assert_eq!(editor_state(d.view(i)).tags.len(), 1);
    send_editor(
        &mut d,
        i,
        N::TagRemoved(ev::TagRemoved {
            label: "work".into(),
        }),
    );
    assert!(editor_state(d.view(i)).tags.is_empty());
    assert!(note_of(&d, &id).tags.is_empty());
}
