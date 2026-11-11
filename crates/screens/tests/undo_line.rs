//! THE UNDO LINE (#1185), as Notes and Reminders offer it through the kit's one door (`kit::undo`):
//! an undoable act says what happened with "Undo"; the kit's `StatusActed` (one event for every
//! screen) runs the core's inverse and says "Undone" with nothing more to tap; an act the core has
//! no inverse for says its sentence with no verb; and an Undo whose record changed again is
//! refused in a plain sentence, with the later change kept. Every test goes through `Driver`, and
//! every assertion is on a value or a count, never a duration.

mod notes_support;
mod reminders_support;

#[allow(clippy::duplicate_mod)]
#[path = "schedule_routes/mod.rs"]
mod routes;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::agenda;
use centraid_screens::catalog::act;
use centraid_screens::field::Field;
use centraid_screens::testing::Driver;
use wire::notes_editor_event::{self as ee, Kind as N};
use wire::notes_home_event::{self as nh, Kind as H};
use wire::todo_detail_event as de;
use wire::todo_list_event as le;

/// The kit's one event for the status line's verb, sent to any screen.
fn status_acted(d: &mut Driver, instance: u64) {
    d.send(
        instance,
        wire::screen_event::Kind::StatusActed(wire::StatusActed {}),
    );
}

fn line(sentence: &str, action: &str) -> (String, String) {
    (sentence.to_owned(), action.to_owned())
}

fn said(status: Option<&wire::StatusLine>) -> (String, String) {
    let status = status.expect("a status line");
    (status.sentence.clone(), status.action_label.clone())
}

// --- Notes: the home -----------------------------------------------------------

fn notes_home(d: &mut Driver) -> u64 {
    notes_support::home(d, wire::NotesPlace::Notes)
}

#[test]
fn notes_a_pin_says_so_with_undo_and_undo_unpins_and_offers_nothing_more() {
    let mut d = notes_support::driver();
    notes_support::clear_notes(&d);
    let id = notes_support::note(&d, "Plans", "x");
    let i = notes_home(&mut d);
    notes_support::send_home(
        &mut d,
        i,
        H::Pin(nh::PinToggled {
            note_id: id.clone(),
        }),
    );
    assert!(notes_support::note_of(&d, &id).pinned);
    assert_eq!(
        said(notes_support::home_state(d.view(i)).status.as_ref()),
        line("Note pinned", "Undo")
    );

    status_acted(&mut d, i);
    assert!(!notes_support::note_of(&d, &id).pinned);
    assert_eq!(
        said(notes_support::home_state(d.view(i)).status.as_ref()),
        line("Undone", "")
    );
    // Nothing is on offer any more: a second tap changes nothing.
    status_acted(&mut d, i);
    assert!(!notes_support::note_of(&d, &id).pinned);
}

#[test]
fn notes_trashing_a_note_says_which_and_undo_brings_it_back() {
    let mut d = notes_support::driver();
    notes_support::clear_notes(&d);
    let id = notes_support::note(&d, "Old plan", "x");
    let i = notes_home(&mut d);
    notes_support::send_home(
        &mut d,
        i,
        H::Trash(nh::TrashAsked {
            note_id: id.clone(),
        }),
    );
    notes_support::send_home(&mut d, i, H::Confirmed(nh::Confirmed {}));
    assert_eq!(
        said(notes_support::home_state(d.view(i)).status.as_ref()),
        line("Old plan moved to trash", "Undo")
    );
    assert!(notes_support::titles(d.view(i)).is_empty());

    status_acted(&mut d, i);
    assert_eq!(notes_support::titles(d.view(i)), ["Old plan"]);
    assert_eq!(
        said(notes_support::home_state(d.view(i)).status.as_ref()),
        line("Undone", "")
    );
}

#[test]
fn notes_an_undo_of_a_note_that_changed_again_is_refused_plainly_and_loses_nothing() {
    let mut d = notes_support::driver();
    notes_support::clear_notes(&d);
    let id = notes_support::note(&d, "Recipe", "x");
    let first = notes_support::notebook(&d, "Recipes");
    let second = notes_support::notebook(&d, "Travel");
    let i = notes_home(&mut d);
    notes_support::send_home(
        &mut d,
        i,
        H::FileInto(nh::FileIntoOpened {
            note_id: id.clone(),
        }),
    );
    notes_support::send_home(
        &mut d,
        i,
        H::NotebookChosen(nh::NotebookChosen { notebook_id: first }),
    );
    assert_eq!(
        said(notes_support::home_state(d.view(i)).status.as_ref()),
        line("Note moved", "Undo")
    );

    // Another surface files it somewhere else: the Undo no longer fits.
    notes_support::arrange(
        &d,
        act::notes::MoveNote {
            note_id: id.clone(),
            notebook_id: Field::Is(second.clone()),
        },
    );
    status_acted(&mut d, i);
    let status = notes_support::home_state(d.view(i))
        .status
        .clone()
        .expect("a line");
    assert!(status.refused);
    assert_eq!(
        status.sentence,
        "This can no longer be undone: it has changed since."
    );
    assert_eq!(status.action_label, "");
    assert_eq!(
        notes_support::library_rows(d.view(i))[0].notebook_id,
        second
    );
}

// --- Notes: the editor -----------------------------------------------------------

#[test]
fn notes_a_tag_in_the_editor_says_so_with_undo_and_undo_removes_it() {
    let mut d = notes_support::driver();
    let id = notes_support::note(&d, "Plans", "x");
    let i = d.push("notes", centraid_screens::notes::routes::editor(&id));
    notes_support::send_editor(
        &mut d,
        i,
        N::TagAdded(ee::TagAdded {
            label: "travel".to_owned(),
        }),
    );
    let chrome = notes_support::editor_state(d.view(i))
        .chrome
        .clone()
        .expect("chrome");
    assert_eq!(
        (chrome.status.as_str(), chrome.status_action.as_str()),
        ("Tag added", "Undo")
    );

    status_acted(&mut d, i);
    let state = notes_support::editor_state(d.view(i));
    let chrome = state.chrome.clone().expect("chrome");
    assert_eq!(
        (chrome.status.as_str(), chrome.status_action.as_str()),
        ("Undone", "")
    );
    assert!(notes_support::note_of(&d, &id).tags.is_empty());
}

// --- Notes: an act that asks first has no Undo ------------------------------------

#[test]
fn notes_an_import_asks_first_so_it_offers_no_undo() {
    let mut d = notes_support::driver();
    let i = d.push("notes", centraid_screens::notes::routes::import("Notes"));
    d.send(
        i,
        wire::screen_event::Kind::Transfer(wire::TransferEvent {
            key: "folder".to_owned(),
        }),
    );
    d.answer_effect(wire::effect_result::Outcome::BytesPicked(
        wire::BytesPicked {
            files: vec![wire::PickedBytes {
                name: "Trip/Paris.md".to_owned(),
                media_type: String::new(),
                content: b"Stay in Paris".to_vec(),
            }],
            ..wire::BytesPicked::default()
        },
    ));
    d.send(
        i,
        wire::screen_event::Kind::Transfer(wire::TransferEvent {
            key: "import".to_owned(),
        }),
    );
    let Some(wire::view_state::Kind::Transfer(view)) = &d.view(i).kind else {
        panic!("not a transfer");
    };
    let status = view.status.clone().expect("the import says what it did");
    assert_eq!(
        status.action_label, "",
        "an import is asked first and has no Undo"
    );
    assert!(!status.refused);
}

// --- Reminders -------------------------------------------------------------------

fn list_status(d: &Driver, i: u64) -> Option<wire::StatusLine> {
    reminders_support::list(d.view(i)).status.clone()
}

#[test]
fn reminders_a_flag_says_so_with_undo_and_undo_clears_it() {
    let mut d = reminders_support::driver();
    reminders_support::clear_tasks(&d);
    let id = reminders_support::task(&d, "Buy milk");
    let i = d.push(agenda::TAB, routes::todo_list(wire::TodoView::Anytime));
    reminders_support::send_list(
        &mut d,
        i,
        le::Kind::RowFlagged(le::RowFlagged {
            task_id: id.clone(),
            flagged: true,
        }),
    );
    assert!(reminders_support::task_of(&d, &id).flagged);
    assert_eq!(said(list_status(&d, i).as_ref()), line("Flagged", "Undo"));

    status_acted(&mut d, i);
    assert!(!reminders_support::task_of(&d, &id).flagged);
    assert_eq!(said(list_status(&d, i).as_ref()), line("Undone", ""));
}

#[test]
fn reminders_a_swipe_delete_names_the_task_and_undo_restores_it() {
    let mut d = reminders_support::driver();
    reminders_support::clear_tasks(&d);
    let id = reminders_support::task(&d, "Old chore");
    let i = d.push(agenda::TAB, routes::todo_list(wire::TodoView::Anytime));
    reminders_support::send_list(
        &mut d,
        i,
        le::Kind::RowDeleted(le::RowDeleted {
            task_id: id.clone(),
        }),
    );
    assert_eq!(
        said(list_status(&d, i).as_ref()),
        line("Old chore moved to trash", "Undo")
    );
    status_acted(&mut d, i);
    assert_eq!(reminders_support::task_of(&d, &id).title, "Old chore");
    assert_eq!(said(list_status(&d, i).as_ref()), line("Undone", ""));
}

#[test]
fn reminders_a_repeating_completion_says_so_but_offers_no_undo() {
    let mut d = reminders_support::driver();
    reminders_support::clear_tasks(&d);
    let today = reminders_support::today(&d);
    let id = reminders_support::add(
        &d,
        act::reminders::AddTask {
            title: "Water".to_owned(),
            due: reminders_support::due(&today),
            rule: Field::Is("FREQ=DAILY".to_owned()),
            ..Default::default()
        },
    );
    let i = d.push(agenda::TAB, routes::todo_list(wire::TodoView::All));
    reminders_support::send_list(
        &mut d,
        i,
        le::Kind::RowChecked(le::RowChecked { task_id: id }),
    );
    let status = list_status(&d, i).expect("a status line");
    assert_eq!(status.action_label, "");
    assert!(
        status.sentence.starts_with("Task done"),
        "{}",
        status.sentence
    );
    // With nothing on offer the kit's event changes nothing.
    status_acted(&mut d, i);
    assert!(
        list_status(&d, i)
            .expect("the line stays")
            .sentence
            .starts_with("Task done")
    );
}

#[test]
fn reminders_an_undo_of_a_task_that_changed_again_is_refused_plainly_and_loses_nothing() {
    let mut d = reminders_support::driver();
    reminders_support::clear_tasks(&d);
    let id = reminders_support::task(&d, "Rent");
    let i = d.push(agenda::TAB, routes::task(&id));
    reminders_support::choose(&mut d, i, "when", "tomorrow");
    let tomorrow = reminders_support::day(&d, 1);
    assert_eq!(
        said(reminders_support::detail(d.view(i)).status.as_ref()),
        line("Task updated", "Undo")
    );

    // Another surface moves it again: the Undo no longer fits.
    let later = reminders_support::day(&d, 5);
    reminders_support::arrange(
        &d,
        act::reminders::EditTask {
            task_id: id.clone(),
            due: reminders_support::due(&later),
            ..Default::default()
        },
    );
    status_acted(&mut d, i);
    let status = reminders_support::detail(d.view(i))
        .status
        .clone()
        .expect("a line");
    assert!(status.refused);
    assert_eq!(
        status.sentence,
        "This can no longer be undone: it has changed since."
    );
    assert_eq!(status.action_label, "");
    let due = reminders_support::task_of(&d, &id).due_local;
    assert!(due.starts_with(&later), "{due} is not {later}");
    assert_ne!(tomorrow, later);
}

#[test]
fn reminders_a_tag_added_on_the_task_page_says_so_and_undo_removes_it() {
    let mut d = reminders_support::driver();
    reminders_support::clear_tasks(&d);
    let id = reminders_support::task(&d, "Pack");
    let i = d.push(agenda::TAB, routes::task(&id));
    reminders_support::send_detail(
        &mut d,
        i,
        de::Kind::TagAdded(de::TagAdded {
            label: "trip".to_owned(),
        }),
    );
    assert_eq!(
        said(reminders_support::detail(d.view(i)).status.as_ref()),
        line("Tag added", "Undo")
    );
    status_acted(&mut d, i);
    assert!(reminders_support::task_of(&d, &id).tags.is_empty());
    assert_eq!(
        said(reminders_support::detail(d.view(i)).status.as_ref()),
        line("Undone", "")
    );
}
