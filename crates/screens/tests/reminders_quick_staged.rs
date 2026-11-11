//! The quick add's Link and Photo keys (#1185): a link or a photo is STAGED as a removable row in
//! the tray (`ListQuickStaged`), and Return makes the link and files the photo with the task, so
//! ONE Undo takes the whole add back. Over a real vault, through the door a shell uses, on a
//! project page and on To-do's home. Every assertion is a value or a count.

mod reminders_support;

#[allow(clippy::duplicate_mod)]
#[path = "schedule_routes/mod.rs"]
mod routes;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::Runtime;
use centraid_screens::agenda;
use centraid_screens::catalog::{act, load};
use centraid_screens::kit::read::{self, Reading};
use centraid_screens::testing::Driver;
use reminders_support as ts;
use wire::agenda_home_event::Kind as H;
use wire::app_query_response::Answer;
use wire::effect_result::Outcome as O;
use wire::link_event::Kind as L;
use wire::link_event::Picked;
use wire::screen_event::Kind as E;
use wire::todo_project_event as pe;

/// The id of a photo's bytes the vault never staged, as the screens' own tests name one.
fn blob(seed: &str) -> String {
    centraid_vault::blob::content_digest(seed.as_bytes())
}

fn project_page(d: &mut Driver) -> u64 {
    let id = ts::project(d, "Garden");
    d.push(agenda::TAB, routes::project(&id, "Garden"))
}

fn on_project(d: &mut Driver, page: u64, kind: pe::Kind) {
    ts::send_project(d, page, kind);
}

fn press(d: &mut Driver, page: u64, key: &str) {
    on_project(
        d,
        page,
        pe::Kind::QuickTool(pe::QuickToolPicked {
            key: key.to_owned(),
        }),
    );
}

fn on_link(d: &mut Driver, page: u64, kind: L) {
    on_project(
        d,
        page,
        pe::Kind::QuickLink(wire::LinkEvent { kind: Some(kind) }),
    );
}

/// The Link key, then the kind, then the item: the picker as a member walks it.
fn stage_link(d: &mut Driver, page: u64, kind: &str, id: &str) {
    press(d, page, "link");
    on_link(d, page, L::Pick(Picked { id: kind.into() }));
    on_link(d, page, L::Pick(Picked { id: id.into() }));
}

fn remove_row(d: &mut Driver, page: u64, key: &str) {
    on_project(
        d,
        page,
        pe::Kind::QuickStagedRemoved(pe::QuickStagedRemoved {
            key: key.to_owned(),
        }),
    );
}

fn type_title(d: &mut Driver, page: u64, title: &str) {
    on_project(
        d,
        page,
        pe::Kind::QuickAddChanged(pe::QuickAddChanged {
            title: title.to_owned(),
        }),
    );
}

fn submit(d: &mut Driver, page: u64) {
    on_project(
        d,
        page,
        pe::Kind::QuickAddSubmitted(pe::QuickAddSubmitted {}),
    );
}

fn bar(d: &Driver, page: u64) -> wire::TodoQuickAdd {
    ts::project_state(d.view(page))
        .quick_add
        .clone()
        .expect("the bar")
}

fn status(d: &Driver, page: u64) -> Option<wire::StatusLine> {
    ts::project_state(d.view(page)).status.clone()
}

fn note(d: &Driver, title: &str) -> String {
    ts::id_of(&ts::arrange(
        d,
        act::notes::CreateNote {
            title: title.to_owned(),
            body: "words".to_owned(),
            ..Default::default()
        },
    ))
}

/// The task a quick add made, by title.
fn made(d: &Driver, title: &str) -> Option<wire::AgendaTask> {
    ts::load_board(d, load::reminders::BoardView::All, None)
        .groups
        .into_iter()
        .flat_map(|group| group.tasks)
        .find(|task| task.title == title)
}

/// The titles of what `entity` is linked to, either end.
fn linked(d: &Driver, entity: &str) -> Vec<String> {
    match ts::answer(
        d,
        load::shell::Links {
            entity_id: entity.to_owned(),
        },
    ) {
        Answer::LinkedItems(found) => found.items.into_iter().map(|item| item.title).collect(),
        other => panic!("links answered {other:?}"),
    }
}

/// What `task` holds as attachments.
fn attachments(d: &Driver, task: &str) -> usize {
    let mut request = load::calendar::Attachments {
        item_id: task.to_owned(),
        after: None,
        limit: 10,
    }
    .request();
    request.app = "reminders".to_owned();
    match ts::answer(d, request) {
        Answer::AgendaAttachments(page) => page.attachments.len(),
        other => panic!("attachments answered {other:?}"),
    }
}

/// The photos the vault keeps (the live shelf).
fn shelf(d: &Driver) -> usize {
    d.with_ctx(|ctx| {
        match read::read(
            ctx,
            load::photos::Shelf {
                limit: 500,
                view: load::photos::ShelfView::Live,
                after: None,
                id: None,
            },
            |answer| match answer {
                Answer::PhotosShelf(shelf) => Some(*shelf),
                _ => None,
            },
        ) {
            Reading::Data(shelf) => shelf.cells.len(),
            _ => panic!("the shelf reads"),
        }
    })
}

/// The phone's answer to the Photo key: a pick by value, as a shell gives one.
fn answer_pick(d: &mut Driver, page: u64, outcome: O) {
    let at = d
        .effects
        .iter()
        .position(|request| request.instance == page)
        .expect("the page asked the phone for a picker");
    let request = d.effects.remove(at);
    d.send(
        page,
        E::EffectResult(wire::EffectResult {
            effect_id: request.effect_id,
            outcome: Some(outcome),
        }),
    );
}

fn picked(seed: &str, name: &str) -> O {
    O::FilePicked(wire::FilePicked {
        blob: blob(seed),
        byte_size: 4_096,
        name: name.to_owned(),
        media_type: String::new(),
    })
}

fn pick_photo(d: &mut Driver, page: u64, seed: &str, name: &str) {
    press(d, page, "photo");
    answer_pick(d, page, picked(seed, name));
}

fn undo(d: &mut Driver, page: u64) {
    d.send(page, E::StatusActed(wire::StatusActed {}));
}

#[test]
fn a_picked_link_waits_as_a_removable_row_and_nothing_is_made_until_return() {
    let mut d = ts::driver();
    let trip = note(&d, "Lisbon trip");
    let page = project_page(&mut d);

    press(&mut d, page, "link");
    let picker = bar(&d, page).link_picker.expect("the picker is up");
    assert!(picker.open, "the kinds first");
    on_link(&mut d, page, L::Pick(Picked { id: "note".into() }));
    let picker = bar(&d, page).link_picker.expect("the notes");
    assert!(picker.candidates.iter().any(|row| row.id == trip));
    on_link(&mut d, page, L::Pick(Picked { id: trip.clone() }));

    let quick = bar(&d, page);
    assert!(quick.link_picker.is_none(), "a pick closes the sheet");
    assert_eq!(quick.staged_group_label, "Staged for the next reminder");
    let [row] = quick.staged_rows.as_slice() else {
        panic!("one staged row: {:?}", quick.staged_rows)
    };
    assert_eq!(row.key, format!("link:{trip}"));
    assert_eq!(row.kind_label, "Link \u{b7} Note");
    assert_eq!(row.title, "Lisbon trip");
    assert_eq!(row.remove_label, "Remove Lisbon trip");
    assert!(quick.tools[3].on, "the Link key is lit");

    // Nothing is linked yet: the note's own links are empty.
    assert!(linked(&d, &trip).is_empty());

    type_title(&mut d, page, "Book the flights");
    submit(&mut d, page);
    let task = made(&d, "Book the flights").expect("the task");
    assert_eq!(linked(&d, &task.task_id), ["Lisbon trip"]);
    assert_eq!(linked(&d, &trip), ["Book the flights"], "either end");
    assert!(bar(&d, page).staged_rows.is_empty(), "the add spent it");
    assert!(!bar(&d, page).tools[3].on);
}

#[test]
fn a_staged_link_is_taken_back_by_its_x_or_by_picking_it_again() {
    let mut d = ts::driver();
    let trip = note(&d, "Lisbon trip");
    let page = project_page(&mut d);
    stage_link(&mut d, page, "note", &trip);
    remove_row(&mut d, page, &format!("link:{trip}"));
    assert!(bar(&d, page).staged_rows.is_empty());

    stage_link(&mut d, page, "note", &trip);
    // The picker marks the staged note, and a tap on it takes it off.
    press(&mut d, page, "link");
    on_link(&mut d, page, L::Pick(Picked { id: "note".into() }));
    let picker = bar(&d, page).link_picker.expect("the notes");
    assert!(picker.candidates.iter().any(|row| row.selected));
    on_link(&mut d, page, L::Pick(Picked { id: trip.clone() }));
    assert!(bar(&d, page).staged_rows.is_empty());

    type_title(&mut d, page, "Plain");
    submit(&mut d, page);
    let task = made(&d, "Plain").expect("the task");
    assert!(linked(&d, &task.task_id).is_empty());
}

#[test]
fn a_picked_photo_waits_as_a_row_and_return_files_and_attaches_it_and_one_undo_takes_all_back() {
    let mut d = ts::driver();
    let trip = note(&d, "Lisbon trip");
    let page = project_page(&mut d);
    let before = shelf(&d);

    press(&mut d, page, "photo");
    assert!(
        d.effects.iter().any(|request| {
            request.instance == page
                && matches!(
                    request.effect.as_ref().and_then(|e| e.kind.as_ref()),
                    Some(wire::effect::Kind::PickFile(pick))
                        if pick.kind == wire::pick_file::Kind::Photo as i32
                )
        }),
        "the page asks the phone for one image"
    );
    answer_pick(&mut d, page, picked("passport", "IMG_0042.jpg"));
    let quick = bar(&d, page);
    let [row] = quick.staged_rows.as_slice() else {
        panic!("one staged row: {:?}", quick.staged_rows)
    };
    assert_eq!(row.kind_label, "Photo");
    assert_eq!(row.title, "IMG_0042.jpg");
    assert_eq!(row.remove_label, "Remove IMG_0042.jpg");
    assert!(quick.tools[4].on);
    assert_eq!(shelf(&d), before, "nothing is filed before Return");

    stage_link(&mut d, page, "note", &trip);
    type_title(&mut d, page, "Get passport photos");
    submit(&mut d, page);
    let task = made(&d, "Get passport photos").expect("the task");
    assert_eq!(attachments(&d, &task.task_id), 1);
    assert_eq!(shelf(&d), before + 1, "the photo is filed in Photos");
    assert_eq!(linked(&d, &task.task_id), ["Lisbon trip"]);
    let line = status(&d, page).expect("the add's line");
    assert_eq!(line.action_label, "Undo");
    assert!(!line.refused);

    // ONE Undo: the link off, the photo trashed with it, the task trashed.
    undo(&mut d, page);
    assert!(
        made(&d, "Get passport photos").is_none(),
        "the task is gone"
    );
    assert_eq!(attachments(&d, &task.task_id), 0);
    assert_eq!(
        shelf(&d),
        before,
        "the filed photo went to the trash with it"
    );
    assert!(linked(&d, &trip).is_empty());
}

#[test]
fn a_staged_photo_is_taken_back_by_its_x_and_the_same_photo_is_not_staged_twice() {
    let mut d = ts::driver();
    let page = project_page(&mut d);
    let before = shelf(&d);
    pick_photo(&mut d, page, "passport", "IMG_0042.jpg");
    pick_photo(&mut d, page, "passport", "IMG_0042.jpg");
    assert_eq!(bar(&d, page).staged_rows.len(), 1);
    pick_photo(&mut d, page, "visa", "IMG_0043.jpg");
    assert_eq!(bar(&d, page).staged_rows.len(), 2);
    remove_row(&mut d, page, &format!("photo:{}", blob("passport")));
    let rows = bar(&d, page).staged_rows;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].title, "IMG_0043.jpg");

    remove_row(&mut d, page, &format!("photo:{}", blob("visa")));
    type_title(&mut d, page, "Plain");
    submit(&mut d, page);
    let task = made(&d, "Plain").expect("the task");
    assert_eq!(attachments(&d, &task.task_id), 0);
    assert_eq!(shelf(&d), before, "a photo taken back is never filed");
}

#[test]
fn a_photo_with_no_file_name_is_just_a_photo() {
    let mut d = ts::driver();
    let page = project_page(&mut d);
    pick_photo(&mut d, page, "scan", "");
    let rows = bar(&d, page).staged_rows;
    assert_eq!(rows[0].title, "Photo");
    assert_eq!(rows[0].remove_label, "Remove Photo");
}

#[test]
fn a_denied_or_missing_picker_says_so_in_the_shared_words_and_a_closed_one_says_nothing() {
    let mut d = ts::driver();
    let page = project_page(&mut d);

    press(&mut d, page, "photo");
    answer_pick(
        &mut d,
        page,
        O::Failed(wire::EffectFailed {
            denied: true,
            ..Default::default()
        }),
    );
    let line = status(&d, page).expect("a refusal is said");
    assert_eq!(line.sentence, "Allow access in Settings to add it.");
    assert!(line.refused);
    assert!(bar(&d, page).staged_rows.is_empty());

    press(&mut d, page, "photo");
    answer_pick(
        &mut d,
        page,
        O::Failed(wire::EffectFailed {
            reason: centraid_screens::kit::attachments::UNAVAILABLE.to_owned(),
            ..Default::default()
        }),
    );
    assert_eq!(
        status(&d, page).expect("said").sentence,
        "This phone has no picker for that."
    );

    // THE MEMBER CLOSED THE PICKER: nothing happened, so nothing is said, and the key works again.
    let mut d = ts::driver();
    let page = project_page(&mut d);
    press(&mut d, page, "photo");
    answer_pick(
        &mut d,
        page,
        O::Failed(wire::EffectFailed {
            cancelled: true,
            ..Default::default()
        }),
    );
    assert!(status(&d, page).is_none());
    press(&mut d, page, "photo");
    assert!(
        d.effects.iter().any(|request| request.instance == page),
        "the key asks the phone again"
    );
}

#[test]
fn a_link_the_vault_refuses_says_so_in_its_own_words_and_the_task_stays() {
    let mut d = ts::driver();
    let trip = note(&d, "Lisbon trip");
    let page = project_page(&mut d);
    stage_link(&mut d, page, "note", &trip);
    // The note goes to the trash between the pick and Return.
    ts::arrange(
        &d,
        act::notes::DeleteNote {
            note_id: trip.clone(),
        },
    );
    type_title(&mut d, page, "Book the flights");
    submit(&mut d, page);

    let task = made(&d, "Book the flights").expect("the task stays");
    assert!(linked(&d, &task.task_id).is_empty());
    let line = status(&d, page).expect("said");
    assert_eq!(
        line.sentence,
        "Added, but the link to Lisbon trip did not save."
    );
    assert!(line.refused);
    assert!(bar(&d, page).staged_rows.is_empty(), "the task was made");
}

#[test]
fn a_photo_the_vault_refuses_says_so_in_its_own_words_and_the_task_stays() {
    let mut d = ts::driver();
    let page = project_page(&mut d);
    let before = shelf(&d);
    press(&mut d, page, "photo");
    // A pick whose bytes are no digest the vault knows.
    answer_pick(
        &mut d,
        page,
        O::FilePicked(wire::FilePicked {
            blob: "not-a-digest".to_owned(),
            byte_size: 12,
            name: "IMG_1.jpg".to_owned(),
            media_type: String::new(),
        }),
    );
    type_title(&mut d, page, "Get passport photos");
    submit(&mut d, page);

    let task = made(&d, "Get passport photos").expect("the task stays");
    assert_eq!(attachments(&d, &task.task_id), 0);
    assert_eq!(shelf(&d), before);
    let line = status(&d, page).expect("said");
    assert_eq!(line.sentence, "Added, but the photo did not attach.");
    assert!(line.refused);
    assert!(bar(&d, page).staged_rows.is_empty(), "the task was made");
}

#[test]
fn the_bar_stays_open_with_a_link_staged_and_an_empty_title() {
    let (mut d, id) = home();
    let trip = note(&d, "Lisbon trip");
    send_home(
        &mut d,
        id,
        H::QuickAddOpened(wire::agenda_home_event::QuickAddOpened {}),
    );
    send_home(
        &mut d,
        id,
        H::QuickTool(wire::agenda_home_event::QuickToolPicked {
            key: "link".to_owned(),
        }),
    );
    // THE PICKER TOOK THE KEYBOARD: the field closes, and the bar must survive it.
    send_home(
        &mut d,
        id,
        H::QuickAddClosed(wire::agenda_home_event::QuickAddClosed {}),
    );
    assert!(home_bar(&d, id).drawn, "a picker is up");
    send_home(
        &mut d,
        id,
        H::QuickLink(wire::LinkEvent {
            kind: Some(L::Pick(Picked { id: "note".into() })),
        }),
    );
    send_home(
        &mut d,
        id,
        H::QuickLink(wire::LinkEvent {
            kind: Some(L::Pick(Picked { id: trip.clone() })),
        }),
    );
    send_home(
        &mut d,
        id,
        H::QuickAddClosed(wire::agenda_home_event::QuickAddClosed {}),
    );
    let quick = home_bar(&d, id);
    assert!(quick.drawn, "a staged link keeps the bar");
    assert_eq!(quick.staged_rows.len(), 1);
}

fn home() -> (Driver, u64) {
    let mut driver = Driver::with_runtime(Runtime::new(
        agenda::registry(),
        vec![(
            agenda::TAB.to_owned(),
            routes::home(wire::AgendaDestination::Todo, ""),
        )],
    ));
    driver.start();
    let id = driver.navigation.as_ref().expect("navigation").tabs[0].entries[0].instance;
    (driver, id)
}

fn send_home(d: &mut Driver, id: u64, kind: H) {
    d.send(
        id,
        E::AgendaHome(wire::AgendaHomeEvent { kind: Some(kind) }),
    );
}

fn home_bar(d: &Driver, id: u64) -> wire::TodoQuickAdd {
    match &d.view(id).kind {
        Some(wire::view_state::Kind::AgendaHome(state)) => {
            state.quick_add.clone().expect("the bar")
        }
        other => panic!("not Agenda's home: {other:?}"),
    }
}

#[test]
fn to_dos_home_stages_a_link_and_a_photo_and_files_them_with_the_task_in_the_inbox() {
    let (mut d, id) = home();
    let trip = note(&d, "Lisbon trip");
    let before = shelf(&d);
    send_home(
        &mut d,
        id,
        H::QuickAddOpened(wire::agenda_home_event::QuickAddOpened {}),
    );
    send_home(
        &mut d,
        id,
        H::QuickTool(wire::agenda_home_event::QuickToolPicked {
            key: "link".to_owned(),
        }),
    );
    for pick in ["note", trip.as_str()] {
        send_home(
            &mut d,
            id,
            H::QuickLink(wire::LinkEvent {
                kind: Some(L::Pick(Picked { id: pick.into() })),
            }),
        );
    }
    send_home(
        &mut d,
        id,
        H::QuickTool(wire::agenda_home_event::QuickToolPicked {
            key: "photo".to_owned(),
        }),
    );
    answer_pick(&mut d, id, picked("passport", "IMG_0042.jpg"));
    let quick = home_bar(&d, id);
    assert_eq!(
        quick
            .staged_rows
            .iter()
            .map(|row| (row.kind_label.as_str(), row.title.as_str()))
            .collect::<Vec<_>>(),
        [
            ("Link \u{b7} Note", "Lisbon trip"),
            ("Photo", "IMG_0042.jpg")
        ]
    );

    send_home(
        &mut d,
        id,
        H::QuickAddChanged(wire::agenda_home_event::QuickAddChanged {
            title: "Zq Get passport photos".to_owned(),
        }),
    );
    send_home(
        &mut d,
        id,
        H::QuickAddSubmitted(wire::agenda_home_event::QuickAddSubmitted {}),
    );
    let task = made(&d, "Zq Get passport photos").expect("the task");
    assert_eq!(task.project_id, None, "the Inbox");
    assert_eq!(attachments(&d, &task.task_id), 1);
    assert_eq!(linked(&d, &task.task_id), ["Lisbon trip"]);
    assert_eq!(shelf(&d), before + 1);
    let quick = home_bar(&d, id);
    assert!(quick.staged_rows.is_empty());
    assert!(quick.drawn && quick.focused, "Return keeps the field");
}

#[test]
fn a_toolbar_key_the_bar_does_not_hold_is_nothing() {
    let mut d = ts::driver();
    let page = project_page(&mut d);
    press(&mut d, page, "sparkle");
    let quick = bar(&d, page);
    assert!(quick.staged_rows.is_empty() && quick.link_picker.is_none());
    assert!(quick.tools.iter().all(|tool| !tool.on));
}
