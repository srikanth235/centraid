//! THE UNDO LINE (#1185), as Notes and Reminders offer it through the kit's one door (`kit::undo`):
//! an undoable act says what happened with "Undo"; the kit's `StatusActed` (one event for every
//! screen) runs the core's inverse and says "Undone" with nothing more to tap; an act the core has
//! no inverse for says its sentence with no verb; and an Undo whose record changed again is
//! refused in a plain sentence, with the later change kept. Every test goes through `Driver`, and
//! every assertion is on a value or a count, never a duration.

mod calendar_support;
mod docs_support;
mod health_support;
mod locker_support;
mod money_support;
mod notes_support;
mod people_support;
mod photos_w2_support;
mod reminders_support;

#[allow(clippy::duplicate_mod)]
#[path = "schedule_routes/mod.rs"]
mod routes;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::agenda;
use centraid_screens::catalog::act;
use centraid_screens::field::{Field, Keyed};
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

// --- Calendar: the event page -----------------------------------------------------

fn calendar_event_line(world: &calendar_support::World, page: u64) -> (String, String) {
    said(world.event_state(page).status.as_ref())
}

fn calendar_review(world: &mut calendar_support::World) -> String {
    let priya = world.person("Maya Alvarez");
    let me = world.me.clone();
    world.propose(
        "Review",
        "2099-06-15T14:00:00",
        "2099-06-15T15:00:00",
        |p| p.attendees = Some(serde_json::to_string(&[&priya, &me]).expect("json")),
    )
}

#[test]
fn calendar_trashing_an_event_says_which_and_undo_brings_it_back() {
    let mut world = calendar_support::World::new();
    let id = calendar_review(&mut world);
    let page = world.open_event(&id, &id, None, "2099-06-15");
    world.send_event(
        page,
        wire::agenda_event_event::Kind::Action(wire::agenda_event_event::ActionPicked {
            key: "trash".to_owned(),
        }),
    );
    assert!(world.event_row(&id).is_none());
    assert_eq!(
        calendar_event_line(&world, page),
        line("Review moved to trash", "Undo")
    );

    status_acted(&mut world.driver, page);
    assert!(world.event_row(&id).is_some());
    assert_eq!(calendar_event_line(&world, page), line("Undone", ""));
}

#[test]
fn calendar_a_reply_says_so_and_undo_takes_it_back_and_a_later_change_refuses_it() {
    let mut world = calendar_support::World::new();
    let id = calendar_review(&mut world);
    let me = world.me.clone();
    let page = world.open_event(&id, &id, None, "2099-06-15");
    let reply = |world: &mut calendar_support::World, partstat: &str| {
        world.send_event(
            page,
            wire::agenda_event_event::Kind::Rsvp(wire::agenda_event_event::RsvpPicked {
                partstat: partstat.to_owned(),
            }),
        );
    };
    let partstat = |world: &calendar_support::World| {
        world
            .event_row(&id)
            .expect("the event")
            .attendees
            .iter()
            .find(|guest| guest.is_you)
            .expect("you")
            .partstat
            .clone()
    };
    let before = partstat(&world);
    reply(&mut world, "accepted");
    assert_eq!(
        calendar_event_line(&world, page),
        line("Reply changed", "Undo")
    );

    status_acted(&mut world.driver, page);
    assert_eq!(partstat(&world), before);
    assert_eq!(calendar_event_line(&world, page), line("Undone", ""));

    // Answered again, then changed from another surface: the Undo no longer fits.
    reply(&mut world, "tentative");
    world.act(act::calendar::Rsvp {
        event_id: id.clone(),
        person_id: me,
        state: act::calendar::RsvpState::Declined,
    });
    status_acted(&mut world.driver, page);
    let status = world.event_state(page).status.clone().expect("a line");
    assert!(status.refused);
    assert_eq!(status.action_label, "");
    assert_eq!(partstat(&world), "declined", "the later change stays");
}

// --- Docs: the drive -----------------------------------------------------------------

fn docs_line(d: &Driver, i: u64) -> (String, String) {
    said(docs_support::drive_state(d.view(i)).status.as_ref())
}

fn docs_has(d: &Driver, i: u64, title: &str) -> bool {
    docs_support::titles(d.view(i)).contains(&title.to_owned())
}

#[test]
fn docs_trashing_a_document_says_which_and_undo_brings_it_back() {
    let mut d = docs_support::driver();
    let i = docs_support::root(&d);
    let id = docs_support::text(&d, "Scratch", "words");
    docs_support::drive_send(
        &mut d,
        i,
        wire::docs_drive_event::Kind::Refreshed(wire::docs_drive_event::Refreshed {}),
    );
    docs_support::row_menu(&mut d, i, &id);
    docs_support::pick(&mut d, i, "trash");
    docs_support::confirm(&mut d, i);
    assert!(!docs_has(&d, i, "Scratch"));
    assert_eq!(docs_line(&d, i), line("Scratch moved to trash", "Undo"));

    status_acted(&mut d, i);
    assert!(docs_has(&d, i, "Scratch"));
    assert_eq!(docs_line(&d, i), line("Undone", ""));
}

#[test]
fn docs_a_star_says_so_and_undo_unstars() {
    let mut d = docs_support::driver();
    let i = docs_support::root(&d);
    let id = docs_support::text(&d, "Notes", "words");
    docs_support::drive_send(
        &mut d,
        i,
        wire::docs_drive_event::Kind::Refreshed(wire::docs_drive_event::Refreshed {}),
    );
    docs_support::row_menu(&mut d, i, &id);
    docs_support::pick(&mut d, i, "star");
    assert!(docs_support::row(d.view(i), "Notes").starred);
    assert_eq!(docs_line(&d, i), line("Document starred", "Undo"));

    status_acted(&mut d, i);
    assert!(!docs_support::row(d.view(i), "Notes").starred);
    assert_eq!(docs_line(&d, i), line("Undone", ""));
}

#[test]
fn docs_a_move_says_so_and_a_later_move_refuses_the_undo_plainly() {
    let mut d = docs_support::driver();
    let i = docs_support::root(&d);
    let first = docs_support::folder(&d, "Taxes", None);
    let second = docs_support::folder(&d, "Trips", None);
    let id = docs_support::text(&d, "Return", "numbers");
    docs_support::drive_send(
        &mut d,
        i,
        wire::docs_drive_event::Kind::Refreshed(wire::docs_drive_event::Refreshed {}),
    );
    docs_support::row_menu(&mut d, i, &id);
    docs_support::pick(&mut d, i, "move");
    docs_support::choose(&mut d, i, &first);
    assert_eq!(docs_support::row(d.view(i), "Return").folder_id, first);
    assert_eq!(docs_line(&d, i), line("Document moved", "Undo"));

    // Another surface files it elsewhere: the Undo no longer fits.
    docs_support::arrange(
        &d,
        act::docs::Move {
            document_id: id.clone(),
            folder_id: Some(second.clone()),
        },
    );
    status_acted(&mut d, i);
    let status = docs_support::drive_state(d.view(i))
        .status
        .clone()
        .expect("a line");
    assert!(status.refused);
    assert_eq!(status.action_label, "");
    assert_eq!(
        status.sentence,
        "This can no longer be undone: it has changed since."
    );
    docs_support::drive_send(
        &mut d,
        i,
        wire::docs_drive_event::Kind::Refreshed(wire::docs_drive_event::Refreshed {}),
    );
    assert_eq!(
        docs_support::row(d.view(i), "Return").folder_id,
        second,
        "the later move stays"
    );
}

// --- Health: a workout -------------------------------------------------------------

fn health_workouts(d: &Driver) -> Vec<String> {
    match health_support::answer(
        d,
        centraid_screens::catalog::load::health::Workouts {
            limit: 50,
            ..Default::default()
        },
    ) {
        wire::app_query_response::Answer::HealthWorkouts(found) => found
            .workouts
            .into_iter()
            .map(|workout| workout.activity_id)
            .collect(),
        other => panic!("workouts answered {other:?}"),
    }
}

fn health_page(d: &mut Driver) -> (u64, String) {
    health_support::connect_store(d);
    health_support::workout(
        d,
        "run",
        "run",
        "2026-11-08T06:40:00.000Z",
        "2026-11-08T07:11:00.000Z",
    );
    let id = health_workouts(d).pop().expect("a workout");
    let page = health_support::push(d, centraid_screens::health::routes::workout(&id, "Health"));
    (page, id)
}

fn health_line(d: &Driver, page: u64) -> (String, String) {
    said(health_support::workout_state(d.view(page)).status.as_ref())
}

fn health_trash(d: &mut Driver, page: u64) {
    d.send(
        page,
        wire::screen_event::Kind::HealthWorkout(wire::HealthWorkoutEvent {
            kind: Some(wire::health_workout_event::Kind::Trash(
                wire::health_workout_event::TrashTapped {},
            )),
        }),
    );
}

#[test]
fn health_trashing_a_workout_says_which_and_undo_brings_it_back() {
    let mut d = health_support::driver();
    let (page, _) = health_page(&mut d);
    health_trash(&mut d, page);
    assert!(health_workouts(&d).is_empty());
    let (sentence, action) = health_line(&d, page);
    assert!(sentence.ends_with(" moved to trash"), "{sentence}");
    assert_eq!(action, "Undo");

    status_acted(&mut d, page);
    assert_eq!(health_workouts(&d).len(), 1);
    assert_eq!(health_line(&d, page), line("Undone", ""));
    // Nothing is on offer any more: a second tap changes nothing.
    status_acted(&mut d, page);
    assert_eq!(health_workouts(&d).len(), 1);
}

#[test]
fn health_an_undo_after_the_workout_came_back_elsewhere_is_refused_plainly() {
    let mut d = health_support::driver();
    let (page, id) = health_page(&mut d);
    health_trash(&mut d, page);
    // Another surface restores it first: the Undo has nothing to put back.
    health_support::arrange(
        &d,
        act::health::RestoreWorkout {
            workout_id: id.clone(),
        },
    );
    status_acted(&mut d, page);
    let status = health_support::workout_state(d.view(page))
        .status
        .clone()
        .expect("a line");
    assert!(status.refused);
    assert_eq!(status.action_label, "");
    assert_eq!(status.sentence, "“Run” is not in the trash");
    assert_eq!(health_workouts(&d).len(), 1, "the workout stays");
}

// --- Locker: an item ------------------------------------------------------------------

fn locker_item() -> (Driver, u64) {
    let mut d = locker_support::driver();
    locker_support::login(&d, "i1", "Bank");
    d.start();
    d.answer_effect(locker_support::passed(wire::Biometry::Face));
    let page = locker_support::push_item(&mut d, "i1");
    (d, page)
}

fn locker_line(d: &Driver, page: u64) -> (String, String) {
    said(locker_support::item(d, page).status.as_ref())
}

fn locker_action(d: &mut Driver, page: u64, key: &str) {
    locker_support::item_event(
        d,
        page,
        wire::locker_item_event::Kind::Action(wire::locker_item_event::ActionTapped {
            key: key.to_owned(),
        }),
    );
}

#[test]
fn locker_trashing_an_item_says_which_and_undo_brings_it_back() {
    let (mut d, page) = locker_item();
    locker_action(&mut d, page, "trash");
    assert_eq!(locker_line(&d, page), line("Bank moved to trash", "Undo"));
    assert!(!locker_support::item_data(&d, page).trashed_note.is_empty());

    status_acted(&mut d, page);
    assert!(locker_support::item_data(&d, page).trashed_note.is_empty());
    assert_eq!(locker_line(&d, page), line("Undone", ""));
}

#[test]
fn locker_a_star_says_so_and_undo_unstars() {
    let (mut d, page) = locker_item();
    locker_action(&mut d, page, "star");
    assert!(locker_support::item_data(&d, page).starred);
    assert_eq!(locker_line(&d, page), line("Item starred", "Undo"));

    status_acted(&mut d, page);
    assert!(!locker_support::item_data(&d, page).starred);
    assert_eq!(locker_line(&d, page), line("Undone", ""));
}

#[test]
fn locker_a_memo_says_so_and_a_later_edit_refuses_the_undo_plainly() {
    let (mut d, page) = locker_item();
    let send = |d: &mut Driver, kind: wire::locker_item_event::Kind| {
        locker_support::item_event(d, page, kind);
    };
    send(
        &mut d,
        wire::locker_item_event::Kind::MemoOpened(wire::locker_item_event::MemoOpened {}),
    );
    send(
        &mut d,
        wire::locker_item_event::Kind::MemoTyped(wire::locker_item_event::MemoTyped {
            text: "Branch code 12".to_owned(),
        }),
    );
    send(
        &mut d,
        wire::locker_item_event::Kind::MemoSaved(wire::locker_item_event::MemoSaved {}),
    );
    // The line names the memo, never its words.
    assert_eq!(locker_line(&d, page), line("Memo saved", "Undo"));

    // Another surface rewrites it: the Undo no longer fits, and the later memo stays.
    locker_support::arrange(
        &d,
        act::locker::SetMemo {
            item_id: "i1".to_owned(),
            note: "Branch code 99".to_owned(),
        },
    );
    status_acted(&mut d, page);
    let status = locker_support::item(&d, page).status.expect("a line");
    assert!(status.refused);
    assert_eq!(status.action_label, "");
    assert_eq!(
        status.sentence,
        "This can no longer be undone: it has changed since."
    );
}

// --- Money: accounts, categories, one transaction ---------------------------------------

fn money_accounts_page(d: &mut Driver) -> u64 {
    money_support::push(d, centraid_screens::money::routes::accounts("Money"))
}

fn money_accounts_state(d: &Driver, page: u64) -> &wire::MoneyAccountsState {
    match &d.view(page).kind {
        Some(wire::view_state::Kind::MoneyAccounts(state)) => state,
        other => panic!("not the accounts: {other:?}"),
    }
}

fn money_account_event(d: &mut Driver, page: u64, kind: wire::money_accounts_event::Kind) {
    money_support::event(
        d,
        page,
        wire::screen_event::Kind::MoneyAccounts(wire::MoneyAccountsEvent { kind: Some(kind) }),
    );
}

fn money_account_name(d: &Driver, id: &str) -> String {
    money_support::accounts(d)
        .into_iter()
        .find(|(account, _)| account == id)
        .map(|(_, name)| name)
        .expect("the account")
}

/// Rename the first account through its sheet; returns its id.
fn money_rename_first_account(d: &mut Driver, page: u64, name: &str) -> String {
    use wire::money_accounts_event as ae;
    let (id, _) = money_support::accounts(d).remove(0);
    money_account_event(
        d,
        page,
        ae::Kind::Account(ae::AccountTapped {
            account_id: id.clone(),
        }),
    );
    money_account_event(
        d,
        page,
        ae::Kind::Name(ae::NameEdited {
            text: name.to_owned(),
        }),
    );
    money_account_event(d, page, ae::Kind::Save(ae::Save {}));
    id
}

#[test]
fn money_renaming_an_account_says_so_and_undo_puts_the_name_back() {
    let mut d = money_support::driver();
    let page = money_accounts_page(&mut d);
    let (id, before) = money_support::accounts(&d).remove(0);
    money_rename_first_account(&mut d, page, "Renamed");
    assert_eq!(money_account_name(&d, &id), "Renamed");
    assert_eq!(
        said(money_accounts_state(&d, page).status.as_ref()),
        line("Account saved", "Undo")
    );

    status_acted(&mut d, page);
    assert_eq!(money_account_name(&d, &id), before);
    assert_eq!(
        said(money_accounts_state(&d, page).status.as_ref()),
        line("Undone", "")
    );
}

#[test]
fn money_a_later_rename_refuses_the_undo_plainly_and_stays() {
    let mut d = money_support::driver();
    let page = money_accounts_page(&mut d);
    let id = money_rename_first_account(&mut d, page, "Renamed");

    // Another surface renames it again: the Undo no longer fits, and the later name stays.
    let response = d.act(
        wire::ActRequest::from(act::money::EditAccount {
            account_id: id.clone(),
            title: Some("Renamed elsewhere".to_owned()),
            ..Default::default()
        })
        .keyed("arrange:money-rename".to_owned()),
    );
    assert_eq!(response.status, wire::ActStatus::Executed as i32);
    status_acted(&mut d, page);
    let status = money_accounts_state(&d, page)
        .status
        .clone()
        .expect("a line");
    assert!(status.refused);
    assert_eq!(status.action_label, "");
    assert!(!status.sentence.is_empty());
    assert_eq!(money_account_name(&d, &id), "Renamed elsewhere");
}

#[test]
fn money_adding_a_category_says_so_and_undo_archives_it() {
    use wire::money_categories_event as ce;
    let mut d = money_support::driver();
    let page = money_support::push(&mut d, centraid_screens::money::routes::categories("Money"));
    let pet = |d: &Driver| -> Option<bool> {
        let Some(wire::view_state::Kind::MoneyCategories(state)) = &d.view(page).kind else {
            panic!("not the categories");
        };
        let Some(wire::money_categories_state::Content::Data(data)) = &state.content else {
            panic!("no categories data");
        };
        data.groups
            .iter()
            .flat_map(|group| &group.rows)
            .find(|row| row.label == "Pet sitting")
            .map(|row| row.archived)
    };
    let status = |d: &Driver| -> (String, String) {
        let Some(wire::view_state::Kind::MoneyCategories(state)) = &d.view(page).kind else {
            panic!("not the categories");
        };
        said(state.status.as_ref())
    };
    let send = |d: &mut Driver, kind: ce::Kind| {
        money_support::event(
            d,
            page,
            wire::screen_event::Kind::MoneyCategories(wire::MoneyCategoriesEvent {
                kind: Some(kind),
            }),
        );
    };
    let group = {
        let Some(wire::view_state::Kind::MoneyCategories(state)) = &d.view(page).kind else {
            panic!("not the categories");
        };
        let Some(wire::money_categories_state::Content::Data(data)) = &state.content else {
            panic!("no categories data");
        };
        data.groups[0].group_id.clone()
    };
    send(&mut d, ce::Kind::Add(ce::AddTapped {}));
    send(
        &mut d,
        ce::Kind::Name(ce::NameEdited {
            text: "Pet sitting".to_owned(),
        }),
    );
    send(&mut d, ce::Kind::Group(ce::GroupPicked { group_id: group }));
    send(&mut d, ce::Kind::Save(ce::Save {}));
    assert_eq!(pet(&d), Some(false));
    assert_eq!(status(&d), line("Category added", "Undo"));

    status_acted(&mut d, page);
    assert_eq!(
        pet(&d),
        Some(true),
        "Undo archives it: a category has no trash"
    );
    assert_eq!(status(&d), line("Undone", ""));
}

// --- People: the home's star, the editor's cadence --------------------------------------

#[test]
fn people_a_star_says_so_and_undo_removes_it() {
    use wire::people_home_event as ev;
    let mut d = people_support::clean();
    let dana = people_support::person(&d, "Dana");
    let home = people_support::begin(&mut d);
    people_support::send_home(
        &mut d,
        home,
        ev::Kind::Star(ev::StarToggled {
            party_id: dana.clone(),
        }),
    );
    let starred = |d: &Driver| {
        people_support::sheet_of(d, &dana)
            .sheet
            .and_then(|sheet| sheet.person)
            .is_some_and(|person| person.starred)
    };
    assert!(starred(&d));
    assert_eq!(
        said(people_support::home_state(d.view(home)).status.as_ref()),
        line("Dana starred", "Undo")
    );

    status_acted(&mut d, home);
    assert!(!starred(&d));
    assert_eq!(
        said(people_support::home_state(d.view(home)).status.as_ref()),
        line("Undone", "")
    );
}

fn people_cadence(d: &Driver, id: &str) -> i64 {
    people_support::sheet_of(d, id)
        .sheet
        .and_then(|sheet| sheet.person)
        .expect("a live person")
        .cadence_days
}

#[test]
fn people_a_cadence_says_so_and_undo_puts_the_old_one_back() {
    use wire::people_editor_event as ev;
    let mut d = people_support::clean();
    let id = people_support::person(&d, "Dana");
    let before = people_cadence(&d, &id);
    d.start();
    let page = d.push(
        centraid_screens::people::TAB,
        centraid_screens::people::routes::editor(&id),
    );
    people_support::send_editor(
        &mut d,
        page,
        ev::Kind::Cadence(ev::CadencePicked { days: 30 }),
    );
    assert_eq!(people_cadence(&d, &id), 30);
    assert_eq!(
        said(people_support::editor_state(d.view(page)).status.as_ref()),
        line("Cadence changed", "Undo")
    );

    status_acted(&mut d, page);
    assert_eq!(people_cadence(&d, &id), before);
    assert_eq!(
        said(people_support::editor_state(d.view(page)).status.as_ref()),
        line("Undone", "")
    );
}

#[test]
fn people_a_later_cadence_refuses_the_undo_plainly_and_stays() {
    use wire::people_editor_event as ev;
    let mut d = people_support::clean();
    let id = people_support::person(&d, "Dana");
    d.start();
    let page = d.push(
        centraid_screens::people::TAB,
        centraid_screens::people::routes::editor(&id),
    );
    people_support::send_editor(
        &mut d,
        page,
        ev::Kind::Cadence(ev::CadencePicked { days: 30 }),
    );

    // Another surface changes it again: the Undo no longer fits, and the later cadence stays.
    people_support::arrange(
        &d,
        act::people::SetCadence {
            person_id: id.clone(),
            cadence_days: 7,
            expected_rev: None,
        },
    );
    status_acted(&mut d, page);
    let status = people_support::editor_state(d.view(page))
        .status
        .clone()
        .expect("a line");
    assert!(status.refused);
    assert_eq!(status.action_label, "");
    assert!(!status.sentence.is_empty());
    assert_eq!(people_cadence(&d, &id), 7);
}

// --- Photos: the lightbox's favourite, a shelf's album rename ---------------------------

fn photos_lightbox(d: &Driver, page: u64) -> &wire::PhotosLightboxState {
    match &d.view(page).kind {
        Some(wire::view_state::Kind::PhotosLightbox(state)) => state,
        other => panic!("not the lightbox: {other:?}"),
    }
}

fn photos_favorite_on(d: &Driver, page: u64) -> bool {
    use wire::photos_lightbox_verb::Kind as V;
    let state = photos_lightbox(d, page);
    state
        .toolbar
        .iter()
        .chain(state.menu.iter())
        .find(|verb| verb.kind == V::Favorite as i32)
        .expect("a favourite verb")
        .on
}

fn photos_tap_favorite(d: &mut Driver, page: u64) {
    use wire::photos_lightbox_event as ev;
    use wire::photos_lightbox_verb::Kind as V;
    d.send(
        page,
        wire::screen_event::Kind::PhotosLightbox(wire::PhotosLightboxEvent {
            kind: Some(ev::Kind::Verb(ev::VerbTapped {
                kind: V::Favorite as i32,
            })),
        }),
    );
}

#[test]
fn photos_a_favourite_says_so_and_undo_takes_it_back() {
    let mut d = photos_w2_support::driver();
    let id = photos_w2_support::photo(&d, "undo-favourite");
    let page = d.push(
        "photos",
        centraid_screens::photos::routes::lightbox(&id, &[], ""),
    );
    photos_tap_favorite(&mut d, page);
    assert!(photos_favorite_on(&d, page));
    assert_eq!(
        said(photos_lightbox(&d, page).status.as_ref()),
        line("Added to Favorites.", "Undo")
    );

    status_acted(&mut d, page);
    assert!(!photos_favorite_on(&d, page));
    assert_eq!(
        said(photos_lightbox(&d, page).status.as_ref()),
        line("Undone", "")
    );
}

fn photos_shelf(d: &Driver, page: u64) -> &wire::PhotosShelfState {
    match &d.view(page).kind {
        Some(wire::view_state::Kind::PhotosShelf(state)) => state,
        other => panic!("not a shelf: {other:?}"),
    }
}

fn photos_rename_album(d: &mut Driver, page: u64, title: &str) {
    use wire::photos_shelf_event as ev;
    for kind in [
        ev::Kind::PromptOpened(ev::PromptOpened {
            prompt: wire::photos_shelf_state::Prompt::RenameAlbum as i32,
        }),
        ev::Kind::AlbumRenamed(ev::AlbumRenamed {
            title: title.to_owned(),
        }),
    ] {
        d.send(
            page,
            wire::screen_event::Kind::PhotosShelf(wire::PhotosShelfEvent { kind: Some(kind) }),
        );
    }
}

fn photos_album_page(d: &mut Driver) -> (String, u64) {
    let album = photos_w2_support::album(d, "Trip");
    let photo = photos_w2_support::photo(d, "undo-album");
    photos_w2_support::put_in(d, &album, &photo);
    let page = d.push(
        "photos",
        centraid_screens::photos::routes::shelf(wire::PhotosShelfKind::Album, &album, ""),
    );
    (album, page)
}

#[test]
fn photos_an_album_rename_says_so_and_undo_puts_the_name_back() {
    let mut d = photos_w2_support::driver();
    let (_, page) = photos_album_page(&mut d);
    photos_rename_album(&mut d, page, "Portugal");
    assert_eq!(photos_shelf(&d, page).title, "Portugal");
    assert_eq!(
        said(photos_shelf(&d, page).status.as_ref()),
        line("Album renamed", "Undo")
    );

    status_acted(&mut d, page);
    assert_eq!(photos_shelf(&d, page).title, "Trip");
    assert_eq!(
        said(photos_shelf(&d, page).status.as_ref()),
        line("Undone", "")
    );
}

#[test]
fn photos_a_later_rename_refuses_the_undo_plainly_and_stays() {
    let mut d = photos_w2_support::driver();
    let (album, page) = photos_album_page(&mut d);
    photos_rename_album(&mut d, page, "Portugal");

    // Another surface renames it again: the Undo no longer fits, and the later name stays.
    photos_w2_support::arrange(
        &d,
        act::photos::RenameAlbum {
            album_id: album,
            title: "Elsewhere".to_owned(),
            expected_rev: None,
        },
    );
    status_acted(&mut d, page);
    let status = photos_shelf(&d, page).status.clone().expect("a line");
    assert!(status.refused);
    assert_eq!(status.action_label, "");
    assert!(!status.sentence.is_empty());
    // The page reads again, and the later name is what the vault holds.
    d.send(page, wire::screen_event::Kind::Appeared(wire::Appeared {}));
    assert_eq!(photos_shelf(&d, page).title, "Elsewhere");
}

// --- Attachments (the kit's section, on the event page) ----------------------------------

fn attachment_status(world: &calendar_support::World, page: u64) -> Option<(String, String)> {
    let section = world
        .event_data(page)
        .attachments
        .as_ref()
        .expect("a section");
    section
        .status
        .as_ref()
        .map(|s| (s.sentence.clone(), s.action_label.clone()))
}

fn attachment_count(world: &calendar_support::World, page: u64) -> usize {
    world
        .event_data(page)
        .attachments
        .as_ref()
        .expect("a section")
        .items
        .len()
}

fn on_attachments(
    world: &mut calendar_support::World,
    page: u64,
    kind: wire::agenda_attachment_event::Kind,
) {
    world.send_event(
        page,
        wire::agenda_event_event::Kind::Attachment(wire::AgendaAttachmentEvent {
            kind: Some(kind),
        }),
    );
}

#[test]
fn attachments_attaching_says_so_and_undo_detaches_and_removing_says_so_and_undo_reattaches() {
    use wire::agenda_attachment_event::Kind as A;
    let mut world = calendar_support::World::new();
    let id = calendar_review(&mut world);
    let page = world.open_event(&id, &id, None, "2099-06-15");

    on_attachments(&mut world, page, A::AddFile(Default::default()));
    world
        .driver
        .answer_effect(wire::effect_result::Outcome::FilePicked(wire::FilePicked {
            blob: "d".repeat(64),
            byte_size: 2048,
            name: "Menu.pdf".to_owned(),
            media_type: "application/pdf".to_owned(),
        }));
    assert_eq!(attachment_count(&world, page), 1);
    assert_eq!(
        attachment_status(&world, page),
        Some(line("Attachment added", "Undo"))
    );

    // The section's own verb (it draws its own line) takes the attach back.
    on_attachments(&mut world, page, A::StatusDismissed(Default::default()));
    assert_eq!(attachment_count(&world, page), 0);
    assert_eq!(attachment_status(&world, page), Some(line("Undone", "")));

    // Attach again, then remove it: that says so with Undo, and Undo attaches it back.
    on_attachments(&mut world, page, A::AddFile(Default::default()));
    world
        .driver
        .answer_effect(wire::effect_result::Outcome::FilePicked(wire::FilePicked {
            blob: "d".repeat(64),
            byte_size: 2048,
            name: "Menu.pdf".to_owned(),
            media_type: "application/pdf".to_owned(),
        }));
    let attached = world.event_data(page).attachments.as_ref().unwrap().items[0]
        .attachment_id
        .clone();
    on_attachments(
        &mut world,
        page,
        A::RemoveAsked(wire::agenda_attachment_event::RemoveAsked {
            attachment_id: attached,
        }),
    );
    on_attachments(&mut world, page, A::RemoveConfirmed(Default::default()));
    assert_eq!(attachment_count(&world, page), 0);
    assert_eq!(
        attachment_status(&world, page),
        Some(line("Attachment removed", "Undo"))
    );
    on_attachments(&mut world, page, A::StatusDismissed(Default::default()));
    assert_eq!(attachment_count(&world, page), 1);
    assert_eq!(attachment_status(&world, page), Some(line("Undone", "")));
}

// --- A save that closes its page leaves its Undo on the page beneath ------------------------

/// The editor says it is done, and the shell pops it.
fn pop_editor(world: &mut calendar_support::World, editor: u64) {
    world.driver.pop(agenda::TAB, editor);
}

#[test]
fn calendar_an_event_saved_from_its_editor_leaves_event_saved_with_undo_on_the_event_page() {
    let mut world = calendar_support::World::new();
    let id = calendar_review(&mut world);
    let page = world.open_event(&id, &id, None, "2099-06-15");
    let before = world.event_row(&id).expect("event").summary.clone();
    let editor = world.open_edit(&id, &id, None, "2099-06-15");
    world.title(editor, "Review, moved");
    world.save(editor);
    assert!(world.editor_state(editor).dismissed, "the editor finishes");
    assert_ne!(world.event_row(&id).expect("event").summary, before);

    pop_editor(&mut world, editor);
    assert_eq!(
        calendar_event_line(&world, page),
        line("Event saved", "Undo")
    );
    status_acted(&mut world.driver, page);
    assert_eq!(world.event_row(&id).expect("event").summary, before);
    assert_eq!(calendar_event_line(&world, page), line("Undone", ""));
}

#[test]
fn calendar_a_new_event_leaves_event_saved_with_undo_on_the_home_and_undo_removes_it() {
    let mut world = calendar_support::World::with(centraid_screens::Registry::default().with(
        centraid_screens::calendar::HOME,
        centraid_screens::calendar::home::build,
    ));
    let home = world.driver.push(
        agenda::TAB,
        routes::home(wire::AgendaDestination::Month, ""),
    );
    let editor = world.open_new("2099-06-15", wire::AgendaEditorKind::Event);
    world.title(editor, "Picnic");
    world.save(editor);
    assert!(world.editor_state(editor).dismissed);
    assert!(
        !world
            .window("2099-06-01T00:00:00Z", "2099-07-01T00:00:00Z")
            .is_empty(),
        "the event is saved"
    );
    pop_editor(&mut world, editor);
    let home_line = |world: &calendar_support::World| match &world.driver.view(home).kind {
        Some(wire::view_state::Kind::AgendaHome(state)) => said(state.status.as_ref()),
        other => panic!("not the home: {other:?}"),
    };
    assert_eq!(home_line(&world), line("Event saved", "Undo"));
    status_acted(&mut world.driver, home);
    // Undo of a proposal cancels it: the event is still answered, as cancelled.
    assert!(
        world
            .window("2099-06-01T00:00:00Z", "2099-07-01T00:00:00Z")
            .iter()
            .all(|event| event.status.as_deref() == Some("cancelled"))
    );
    assert_eq!(home_line(&world), line("Undone", ""));
}

#[test]
fn calendar_a_cancelled_event_leaves_event_cancelled_on_the_home_and_undo_reinstates_it() {
    let mut world = calendar_support::World::with(centraid_screens::Registry::default().with(
        centraid_screens::calendar::HOME,
        centraid_screens::calendar::home::build,
    ));
    let id = calendar_review(&mut world);
    let home = world.driver.push(
        agenda::TAB,
        routes::home(wire::AgendaDestination::Month, ""),
    );
    let page = world.open_event(&id, &id, None, "2099-06-15");
    let pick = |key: &str| {
        wire::agenda_event_event::Kind::Action(wire::agenda_event_event::ActionPicked {
            key: key.to_owned(),
        })
    };
    world.send_event(page, pick("cancel"));
    world.send_event(
        page,
        wire::agenda_event_event::Kind::Confirmed(wire::agenda_event_event::Confirmed {}),
    );
    assert!(world.event_state(page).dismissed);
    world.driver.pop(agenda::TAB, page);
    let home_line = |world: &calendar_support::World| match &world.driver.view(home).kind {
        Some(wire::view_state::Kind::AgendaHome(state)) => said(state.status.as_ref()),
        other => panic!("not the home: {other:?}"),
    };
    assert_eq!(home_line(&world), line("Event cancelled", "Undo"));
    assert_eq!(
        world.event_row(&id).expect("event").status.as_deref(),
        Some("cancelled")
    );
    status_acted(&mut world.driver, home);
    assert_eq!(
        world.event_row(&id).expect("event").status.as_deref(),
        Some("confirmed")
    );
    assert_eq!(home_line(&world), line("Undone", ""));
}

// --- Money: a target sheet ----------------------------------------------------------------

#[test]
fn money_a_saved_target_leaves_target_saved_with_undo_on_the_home_and_undo_puts_the_old_one_back() {
    use wire::money_target_event as tg;
    let mut d = money_support::driver();
    let home = money_support::home(&d);
    let wire::app_query_response::Answer::MoneySpending(spending) = money_support::load_answer(
        &d,
        centraid_screens::catalog::load::money::Spending {
            month: String::new(),
        },
    ) else {
        panic!("not Spending");
    };
    let category = spending.categories.first().expect("a category");
    let route = || {
        centraid_screens::money::routes::target(
            &spending.month,
            &category.category_id,
            &category.currency,
        )
    };
    let target =
        |kind| wire::screen_event::Kind::MoneyTarget(wire::MoneyTargetEvent { kind: Some(kind) });
    let amount = |d: &Driver, page: u64| match &d.view(page).kind {
        Some(wire::view_state::Kind::MoneyTarget(state)) => state.amount_text.clone(),
        other => panic!("not a target: {other:?}"),
    };
    for text in ["100", "250"] {
        let page = money_support::push(&mut d, route());
        money_support::event(
            &mut d,
            page,
            target(tg::Kind::Amount(tg::AmountEdited { text: text.into() })),
        );
        money_support::event(&mut d, page, target(tg::Kind::Save(tg::Save {})));
        d.pop(centraid_screens::money::TAB, page);
        assert_eq!(
            said(money_support::home_state(d.view(home)).status.as_ref()),
            line("Target saved", "Undo")
        );
    }
    status_acted(&mut d, home);
    assert_eq!(
        said(money_support::home_state(d.view(home)).status.as_ref()),
        line("Undone", "")
    );
    let page = money_support::push(&mut d, route());
    assert_eq!(amount(&d, page), "100.00", "the first target is back");
}

// --- Locker: the editor ---------------------------------------------------------------------

#[test]
fn locker_a_saved_item_leaves_item_saved_with_undo_on_its_page_and_undo_restores_the_title() {
    use wire::locker_editor_event as le;
    let (mut d, page) = locker_item();
    let editor = d.push(
        centraid_screens::locker::TAB,
        centraid_screens::locker::routes::edit("i1"),
    );
    let send = |d: &mut Driver, kind| {
        d.send(
            editor,
            wire::screen_event::Kind::LockerEditor(wire::LockerEditorEvent { kind: Some(kind) }),
        );
    };
    send(
        &mut d,
        le::Kind::Typed(le::Typed {
            key: "title".to_owned(),
            value: "Bank, renamed".to_owned(),
        }),
    );
    send(&mut d, le::Kind::Save(le::SaveTapped {}));
    match &d.view(editor).kind {
        Some(wire::view_state::Kind::LockerEditor(state)) => assert!(state.finished),
        other => panic!("not the editor: {other:?}"),
    }
    d.pop(centraid_screens::locker::TAB, editor);
    assert_eq!(locker_line(&d, page), line("Item saved", "Undo"));
    assert_eq!(locker_support::item_data(&d, page).title, "Bank, renamed");

    status_acted(&mut d, page);
    assert_eq!(locker_support::item_data(&d, page).title, "Bank");
    assert_eq!(locker_line(&d, page), line("Undone", ""));
}

// --- Reminders: the add sheet ---------------------------------------------------------------

#[test]
fn reminders_a_task_added_from_the_sheet_leaves_its_line_with_undo_on_the_list_and_undo_removes_it()
{
    use wire::agenda_editor_event as ee;
    let mut d = reminders_support::driver();
    reminders_support::clear_tasks(&d);
    let list = d.push(agenda::TAB, routes::todo_list(wire::TodoView::Today));
    let today = reminders_support::today(&d);
    let sheet = d.push(
        agenda::TAB,
        centraid_screens::reminders::routes::editor(&today),
    );
    let send = |d: &mut Driver, kind| {
        d.send(
            sheet,
            wire::screen_event::Kind::AgendaEditor(wire::AgendaEditorEvent { kind: Some(kind) }),
        );
    };
    send(
        &mut d,
        ee::Kind::Title(ee::TitleChanged {
            text: "Book flights".to_owned(),
        }),
    );
    send(&mut d, ee::Kind::Save(ee::SaveTapped {}));
    match &d.view(sheet).kind {
        Some(wire::view_state::Kind::AgendaEditor(state)) => assert!(state.dismissed),
        other => panic!("not the sheet: {other:?}"),
    }
    d.pop(agenda::TAB, sheet);
    let status = list_status(&d, list).expect("a line");
    assert!(status.sentence.starts_with("Added to"), "{status:?}");
    assert_eq!(status.action_label, "Undo");
    let titles = |d: &Driver| -> Vec<String> {
        reminders_support::rows(reminders_support::list_groups(d.view(list)))
            .iter()
            .map(|row| row.title.clone())
            .collect()
    };
    assert!(titles(&d).contains(&"Book flights".to_owned()));

    status_acted(&mut d, list);
    assert_eq!(said(list_status(&d, list).as_ref()), line("Undone", ""));
    assert!(!titles(&d).contains(&"Book flights".to_owned()));
}

#[test]
fn a_handed_line_is_taken_once_and_a_navigation_that_is_not_a_pop_drops_it() {
    let mut world = calendar_support::World::new();
    let id = calendar_review(&mut world);
    let other = world.propose(
        "Other",
        "2099-06-16T14:00:00",
        "2099-06-16T15:00:00",
        |_| {},
    );
    let page = world.open_event(&id, &id, None, "2099-06-15");

    // Taken once: after Undo, hearing the data change again does not bring the line back.
    let editor = world.open_edit(&id, &id, None, "2099-06-15");
    world.title(editor, "First");
    world.save(editor);
    pop_editor(&mut world, editor);
    assert_eq!(
        calendar_event_line(&world, page),
        line("Event saved", "Undo")
    );
    status_acted(&mut world.driver, page);
    world.driver.send(
        page,
        wire::screen_event::Kind::DataChanged(wire::DataChanged::default()),
    );
    assert_eq!(calendar_event_line(&world, page), line("Undone", ""));

    // Dropped: a push that is not a pop comes between the save and the pop.
    let editor = world.open_edit(&id, &id, None, "2099-06-15");
    world.title(editor, "Second");
    world.save(editor);
    world.open_event(&other, &other, None, "2099-06-16");
    pop_editor(&mut world, editor);
    assert_eq!(
        calendar_event_line(&world, page),
        line("Undone", ""),
        "the line did not reach a screen it was not left for"
    );
}

#[test]
fn locker_an_item_saved_with_new_tags_is_taken_back_with_its_tags_by_one_undo() {
    use wire::locker_editor_event as le;
    let (mut d, page) = locker_item();
    let editor = d.push(
        centraid_screens::locker::TAB,
        centraid_screens::locker::routes::edit("i1"),
    );
    let send = |d: &mut Driver, kind| {
        d.send(
            editor,
            wire::screen_event::Kind::LockerEditor(wire::LockerEditorEvent { kind: Some(kind) }),
        );
    };
    send(
        &mut d,
        le::Kind::Typed(le::Typed {
            key: "title".to_owned(),
            value: "Bank, renamed".to_owned(),
        }),
    );
    send(
        &mut d,
        le::Kind::Tags(le::TagsTyped {
            text: "money".to_owned(),
        }),
    );
    send(&mut d, le::Kind::Save(le::SaveTapped {}));
    d.pop(centraid_screens::locker::TAB, editor);
    assert_eq!(locker_line(&d, page), line("Item saved", "Undo"));
    assert_eq!(locker_support::item_data(&d, page).tags, ["money"]);

    status_acted(&mut d, page);
    let data = locker_support::item_data(&d, page);
    assert_eq!((data.title.as_str(), data.tags.len()), ("Bank", 0));
    assert_eq!(locker_line(&d, page), line("Undone", ""));
}
