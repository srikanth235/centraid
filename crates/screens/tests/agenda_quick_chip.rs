//! THE DATE CHIP IN QUICK ADD (#1173 Wave 3), through the door a shell uses.
//!
//! Dates are relative to the core's own `today`, read from the vault under
//! test; nothing here reads a clock or asserts on one.

mod todo_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::agenda::{self, routes};
use centraid_screens::catalog::load;
use centraid_screens::testing::Driver;
use centraid_screens::{Runtime, agenda::TAB};
use todo_support::*;
use wire::AgendaDestination as Dest;
use wire::agenda_home_event as he;
use wire::agenda_home_event::Kind as H;
use wire::agenda_home_state::Content;
use wire::screen_event::Kind as E;
use wire::todo_project_event as pe;

/// Agenda's To-do, with the bar open.
fn home() -> (Driver, u64) {
    let mut d = Driver::with_runtime(Runtime::new(
        agenda::registry(),
        vec![(TAB.to_owned(), routes::home(Dest::Todo, ""))],
    ));
    d.start();
    let id = d.navigation.as_ref().expect("navigation").tabs[0].entries[0].instance;
    send_home(&mut d, id, H::QuickAddOpened(he::QuickAddOpened {}));
    (d, id)
}

fn send_home(d: &mut Driver, id: u64, kind: H) {
    d.send(
        id,
        E::AgendaHome(wire::AgendaHomeEvent { kind: Some(kind) }),
    );
}

fn type_home(d: &mut Driver, id: u64, words: &str) {
    send_home(
        d,
        id,
        H::QuickAddChanged(he::QuickAddChanged {
            title: words.to_owned(),
        }),
    );
}

fn bar(d: &Driver, id: u64) -> wire::TodoQuickAdd {
    match &d.view(id).kind {
        Some(wire::view_state::Kind::AgendaHome(state)) => {
            assert!(matches!(state.content, Some(Content::Data(_))));
            state.quick_add.clone().expect("the quick add")
        }
        other => panic!("not Agenda's home: {other:?}"),
    }
}

fn submit_home(d: &mut Driver, id: u64) {
    send_home(d, id, H::QuickAddSubmitted(he::QuickAddSubmitted {}));
}

fn open_task(d: &Driver, title: &str) -> wire::AgendaTask {
    let board = load_board(d, load::reminders::BoardView::All, None);
    board
        .groups
        .iter()
        .flat_map(|group| group.tasks.iter())
        .find(|task| task.title == title)
        .unwrap_or_else(|| panic!("no task titled {title:?}"))
        .clone()
}

fn no_task(d: &Driver, title: &str) {
    let board = load_board(d, load::reminders::BoardView::All, None);
    assert!(
        board
            .groups
            .iter()
            .flat_map(|group| group.tasks.iter())
            .all(|task| task.title != title),
        "a task titled {title:?} exists"
    );
}

#[test]
fn a_typed_day_and_time_show_as_a_chip_and_save_as_a_dated_task() {
    let (mut d, id) = home();
    type_home(&mut d, id, "Zq Call mom tomorrow 9am");
    let chip = bar(&d, id).chip.expect("a chip");
    assert_eq!(chip.label, "Tomorrow, 09:00");
    assert_eq!(chip.title, "Zq Call mom");
    assert_eq!(chip.dismiss_label, "Keep as text");
    assert_eq!(chip.spoken, "Due Tomorrow, 09:00. Saves as Zq Call mom.");
    assert_eq!(chip.saves_as, "Saves as “Zq Call mom”, due Tomorrow, 09:00");
    assert!(!chip.repeats);
    // The field still holds what the member typed.
    assert_eq!(bar(&d, id).title, "Zq Call mom tomorrow 9am");

    submit_home(&mut d, id);
    let task = open_task(&d, "Zq Call mom");
    assert_eq!(task.due_day, day(&d, 1));
    assert_eq!(task.due_time, "09:00");
    assert!(!task.repeats);
    assert_eq!(bar(&d, id).title, "");
    assert!(bar(&d, id).chip.is_none());
}

#[test]
fn the_cross_keeps_the_words_as_the_title_with_no_day() {
    let (mut d, id) = home();
    type_home(&mut d, id, "Zq Pay rent tomorrow");
    assert!(bar(&d, id).chip.is_some());
    send_home(
        &mut d,
        id,
        H::QuickAddChipDismissed(wire::QuickAddChipDismissed {}),
    );
    assert!(bar(&d, id).chip.is_none());
    submit_home(&mut d, id);
    let task = open_task(&d, "Zq Pay rent tomorrow");
    assert_eq!(task.due_day, "");
    no_task(&d, "Zq Pay rent");
}

#[test]
fn a_changed_phrase_after_the_cross_brings_the_chip_back() {
    let (mut d, id) = home();
    type_home(&mut d, id, "Zq Water plants tomorrow");
    send_home(
        &mut d,
        id,
        H::QuickAddChipDismissed(wire::QuickAddChipDismissed {}),
    );
    assert!(bar(&d, id).chip.is_none());
    // The same words again stay dismissed.
    type_home(&mut d, id, "Zq Water plants tomorrow");
    assert!(bar(&d, id).chip.is_none());
    // More words change the phrase: the chip is read again.
    type_home(&mut d, id, "Zq Water plants tomorrow 6pm");
    let chip = bar(&d, id).chip.expect("the chip is back");
    assert_eq!(chip.label, "Tomorrow, 18:00");
    assert_eq!(chip.title, "Zq Water plants");
}

#[test]
fn a_repeat_saves_a_repeating_task_dated_on_its_first_day() {
    let (mut d, id) = home();
    type_home(&mut d, id, "Zq Team sync every monday");
    let chip = bar(&d, id).chip.expect("a chip");
    assert_eq!(chip.label, "Every Monday");
    assert_eq!(chip.title, "Zq Team sync");
    assert!(chip.repeats);
    assert_eq!(chip.spoken, "Every Monday. Saves as Zq Team sync.");
    submit_home(&mut d, id);
    let task = open_task(&d, "Zq Team sync");
    assert!(task.repeats);
    assert!(!task.due_day.is_empty(), "a repeat is never undated");
}

#[test]
fn words_that_are_not_a_date_show_no_chip_and_save_as_typed() {
    let (mut d, id) = home();
    type_home(&mut d, id, "Zq Meet at 6th street");
    assert!(bar(&d, id).chip.is_none());
    submit_home(&mut d, id);
    let task = open_task(&d, "Zq Meet at 6th street");
    assert_eq!(task.due_day, "");
    assert!(!task.repeats);
}

#[test]
fn seeded_words_are_read_too() {
    let mut d = Driver::with_runtime(Runtime::new(
        agenda::registry(),
        vec![(
            TAB.to_owned(),
            routes::home(Dest::Todo, "Zq Send card tomorrow"),
        )],
    ));
    d.start();
    let id = d.navigation.as_ref().expect("navigation").tabs[0].entries[0].instance;
    let chip = bar(&d, id).chip.expect("a chip for the seed");
    assert_eq!(chip.label, "Tomorrow");
    assert_eq!(chip.title, "Zq Send card");
}

fn project_bar(d: &Driver, i: u64) -> wire::TodoQuickAdd {
    project_state(d.view(i)).quick_add.clone().expect("the bar")
}

fn type_project(d: &mut Driver, i: u64, words: &str) {
    send_project(
        d,
        i,
        pe::Kind::QuickAddChanged(pe::QuickAddChanged {
            title: words.to_owned(),
        }),
    );
}

#[test]
fn the_project_pages_quick_add_reads_dates_the_same_way() {
    let mut d = driver();
    let garden = project(&d, "Zq Garden");
    let i = d.push(TAB, routes::project(&garden, "Zq Garden"));
    type_project(&mut d, i, "Zq Prune roses tomorrow 9am");
    let chip = project_bar(&d, i).chip.expect("a chip");
    assert_eq!(chip.label, "Tomorrow, 09:00");
    assert_eq!(chip.title, "Zq Prune roses");

    send_project(
        &mut d,
        i,
        pe::Kind::QuickAddSubmitted(pe::QuickAddSubmitted {}),
    );
    let board = load_board(&d, load::reminders::BoardView::Project, Some(&garden));
    let task = board
        .groups
        .iter()
        .flat_map(|group| group.tasks.iter())
        .find(|task| task.title == "Zq Prune roses")
        .expect("filed in the project");
    assert_eq!(task.due_day, day(&d, 1));
    assert_eq!(task.due_time, "09:00");
    assert!(project_bar(&d, i).chip.is_none());

    // The cross, then a changed phrase.
    type_project(&mut d, i, "Zq Mow lawn every day");
    assert!(project_bar(&d, i).chip.expect("a chip").repeats);
    send_project(
        &mut d,
        i,
        pe::Kind::QuickAddChipDismissed(wire::QuickAddChipDismissed {}),
    );
    assert!(project_bar(&d, i).chip.is_none());
    send_project(
        &mut d,
        i,
        pe::Kind::QuickAddSubmitted(pe::QuickAddSubmitted {}),
    );
    let board = load_board(&d, load::reminders::BoardView::Project, Some(&garden));
    let task = board
        .groups
        .iter()
        .flat_map(|group| group.tasks.iter())
        .find(|task| task.title == "Zq Mow lawn every day")
        .expect("saved as typed");
    assert!(!task.repeats);
    assert_eq!(task.due_day, "");
}
