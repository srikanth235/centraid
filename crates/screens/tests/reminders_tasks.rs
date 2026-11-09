//! The new task sheet, the quick add's keyboard toolbar and the task page's
//! grouped cards (#1173), through the door a shell uses. Every assertion is a
//! value or a count, never a duration.

mod calendar_support;
mod reminders_support;

#[allow(clippy::duplicate_mod)]
#[path = "schedule_routes/mod.rs"]
mod routes;
use calendar_support::World;
use centraid_api_proto::core_v1 as wire;
use centraid_screens::Runtime;
use centraid_screens::agenda;
use centraid_screens::catalog::{act, load};
use centraid_screens::testing::Driver;
use reminders_support as ts;
use wire::AgendaEditorKind as Kind;
use wire::agenda_home_event::Kind as H;
use wire::screen_event::Kind as E;
use wire::todo_project_event as pe;

const DAY: &str = "2099-06-17";

// --- the new task sheet --------------------------------------------------------

#[test]
fn a_create_route_that_names_a_start_time_starts_there_and_ends_an_hour_on() {
    let mut world = World::new();
    let mut route = routes::editor("", "", None, DAY, Kind::Event);
    let Some(wire::route::Args::AgendaEditor(args)) = route.args.as_mut() else {
        panic!("an editor route");
    };
    args.start_time = "14:30".to_owned();
    let page = world.driver.push(agenda::TAB, route);
    let draft = world.draft(page);
    assert_eq!(
        (
            draft.start_day.as_str(),
            draft.start_time.as_str(),
            draft.end_day.as_str(),
            draft.end_time.as_str(),
        ),
        (DAY, "14:30", DAY, "15:30")
    );
    // The sheet opened so is not a change to discard.
    assert!(!world.editor_data(page).dirty);

    // A slot late in the evening carries the end over midnight.
    let mut late = routes::editor("", "", None, DAY, Kind::Event);
    let Some(wire::route::Args::AgendaEditor(args)) = late.args.as_mut() else {
        panic!("an editor route");
    };
    args.start_time = "23:30".to_owned();
    let page = world.driver.push(agenda::TAB, late);
    let draft = world.draft(page);
    assert_eq!(
        (draft.end_day.as_str(), draft.end_time.as_str()),
        ("2099-06-18", "00:30")
    );

    // A time that is not one leaves the editor's own default.
    let mut bad = routes::editor("", "", None, DAY, Kind::Event);
    let Some(wire::route::Args::AgendaEditor(args)) = bad.args.as_mut() else {
        panic!("an editor route");
    };
    args.start_time = "half past".to_owned();
    let page = world.driver.push(agenda::TAB, bad);
    assert_eq!(world.draft(page).start_time, "09:00");
}

// --- the keyboard toolbar --------------------------------------------------------

fn project_page(d: &mut Driver, name: &str) -> (u64, String) {
    let id = ts::project(d, name);
    let page = d.push(agenda::TAB, routes::project(&id, name));
    (page, id)
}

fn quick_tool(d: &mut Driver, page: u64, key: &str) {
    ts::send_project(
        d,
        page,
        pe::Kind::QuickTool(pe::QuickToolPicked {
            key: key.to_owned(),
        }),
    );
}

fn quick_due(d: &mut Driver, page: u64, key: &str) {
    ts::send_project(
        d,
        page,
        pe::Kind::QuickDue(pe::QuickDuePicked {
            key: key.to_owned(),
        }),
    );
}

fn quick_tag(d: &mut Driver, page: u64, text: &str) {
    ts::send_project(
        d,
        page,
        pe::Kind::QuickTag(pe::QuickTagAdded {
            text: text.to_owned(),
        }),
    );
}

fn type_title(d: &mut Driver, page: u64, title: &str) {
    ts::send_project(
        d,
        page,
        pe::Kind::QuickAddChanged(pe::QuickAddChanged {
            title: title.to_owned(),
        }),
    );
}

fn submit(d: &mut Driver, page: u64) {
    ts::send_project(
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

#[test]
fn the_toolbar_offers_date_tag_and_flag_and_nothing_that_does_nothing() {
    let mut d = ts::driver();
    let (page, _) = project_page(&mut d, "Garden");
    let quick = bar(&d, page);
    assert_eq!(
        quick
            .tools
            .iter()
            .map(|t| (t.key.as_str(), t.label.as_str(), t.icon_key.as_str(), t.on))
            .collect::<Vec<_>>(),
        [
            ("date", "Date", "Calendar", false),
            ("tag", "Tag", "Tag", false),
            ("flag", "Flag", "Flag", false)
        ]
    );
    assert_eq!(quick.staged_label, "");
    assert_eq!(quick.open_tool, "");
    assert!(quick.due_choices.is_empty());
    assert_eq!(quick.tag_placeholder, "Add a tag");
}

#[test]
fn the_toolbar_stages_a_due_a_tag_and_the_flag_and_return_adds_them_and_keeps_the_field() {
    let mut d = ts::driver();
    let (page, garden) = project_page(&mut d, "Garden");
    let tomorrow = ts::day(&d, 1);

    quick_tool(&mut d, page, "date");
    let quick = bar(&d, page);
    assert_eq!(quick.open_tool, "date");
    assert_eq!(
        quick
            .due_choices
            .iter()
            .map(|c| (c.key.as_str(), c.label.as_str(), c.selected))
            .collect::<Vec<_>>(),
        [
            ("today", "Today", false),
            ("tomorrow", "Tomorrow", false),
            ("weekend", "This weekend", false),
            ("next_week", "Next week", false),
            ("none", "No date", true)
        ]
    );
    quick_due(&mut d, page, "tomorrow");
    let quick = bar(&d, page);
    assert_eq!(quick.open_tool, "", "a pick closes the tray");
    assert_eq!(quick.staged_label, "Tomorrow");
    assert!(quick.tools[0].on);

    quick_tool(&mut d, page, "tag");
    assert_eq!(bar(&d, page).open_tool, "tag");
    quick_tag(&mut d, page, " #errand ");
    quick_tag(&mut d, page, "ERRAND");
    quick_tool(&mut d, page, "flag");
    let quick = bar(&d, page);
    assert_eq!(quick.staged_label, "Tomorrow · #errand · Flagged");
    assert!(quick.tools.iter().all(|t| t.on));

    type_title(&mut d, page, "Buy bulbs");
    submit(&mut d, page);

    let quick = bar(&d, page);
    assert_eq!(quick.title, "", "a committed add clears the field");
    assert_eq!(quick.staged_label, "");
    assert_eq!(quick.open_tool, "");
    assert!(quick.tools.iter().all(|t| !t.on));
    assert!(
        quick.focused && quick.drawn && quick.shown,
        "Return keeps the field"
    );
    assert!(!quick.can_submit);

    let row = ts::row_titled(&ts::project_data(d.view(page)).groups, "Buy bulbs").clone();
    let stored = ts::task_of(&d, &row.task_id);
    assert_eq!(stored.due_day, tomorrow);
    assert_eq!(stored.project_id.as_deref(), Some(garden.as_str()));
    assert!(stored.flagged);
    let tags: Vec<&str> = stored.tags.iter().map(|t| t.label.as_str()).collect();
    assert_eq!(tags, ["errand"]);

    // THE NEXT ONE carries nothing over.
    type_title(&mut d, page, "Water");
    submit(&mut d, page);
    let row = ts::row_titled(&ts::project_data(d.view(page)).groups, "Water").clone();
    let next = ts::task_of(&d, &row.task_id);
    assert_eq!(next.due_day, "");
    assert!(!next.flagged && next.tags.is_empty());
}

#[test]
fn the_flag_tool_is_a_switch_and_a_date_can_be_taken_back() {
    let mut d = ts::driver();
    let (page, _) = project_page(&mut d, "Garden");
    quick_tool(&mut d, page, "flag");
    assert!(bar(&d, page).tools[2].on);
    quick_tool(&mut d, page, "flag");
    assert!(!bar(&d, page).tools[2].on);
    quick_due(&mut d, page, "weekend");
    assert_eq!(bar(&d, page).staged_label, "This weekend");
    quick_due(&mut d, page, "none");
    assert_eq!(bar(&d, page).staged_label, "");
    // A tool or a choice the bar does not hold is nothing.
    quick_tool(&mut d, page, "photo");
    quick_due(&mut d, page, "someday");
    assert_eq!(bar(&d, page).staged_label, "");
    assert_eq!(bar(&d, page).open_tool, "");
}

#[test]
fn a_toolbar_staging_waits_through_a_blank_return_and_is_not_spent_by_it() {
    let mut d = ts::driver();
    let (page, _) = project_page(&mut d, "Garden");
    quick_tool(&mut d, page, "flag");
    submit(&mut d, page);
    assert_eq!(bar(&d, page).staged_label, "Flagged");
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
fn to_dos_quick_add_takes_the_same_toolbar_and_files_in_the_inbox() {
    let (mut d, id) = home();
    send_home(
        &mut d,
        id,
        H::QuickAddOpened(wire::agenda_home_event::QuickAddOpened {}),
    );
    assert_eq!(home_bar(&d, id).tools.len(), 3);
    send_home(
        &mut d,
        id,
        H::QuickTool(wire::agenda_home_event::QuickToolPicked {
            key: "date".to_owned(),
        }),
    );
    assert_eq!(home_bar(&d, id).open_tool, "date");
    assert_eq!(home_bar(&d, id).due_choices.len(), 5);
    send_home(
        &mut d,
        id,
        H::QuickDue(wire::agenda_home_event::QuickDuePicked {
            key: "today".to_owned(),
        }),
    );
    send_home(
        &mut d,
        id,
        H::QuickTag(wire::agenda_home_event::QuickTagAdded {
            text: "errand".to_owned(),
        }),
    );
    send_home(
        &mut d,
        id,
        H::QuickTool(wire::agenda_home_event::QuickToolPicked {
            key: "flag".to_owned(),
        }),
    );
    assert_eq!(home_bar(&d, id).staged_label, "Today · #errand · Flagged");
    send_home(
        &mut d,
        id,
        H::QuickAddChanged(wire::agenda_home_event::QuickAddChanged {
            title: "Zq Post the parcel".to_owned(),
        }),
    );
    send_home(
        &mut d,
        id,
        H::QuickAddSubmitted(wire::agenda_home_event::QuickAddSubmitted {}),
    );
    let quick = home_bar(&d, id);
    assert_eq!(quick.title, "");
    assert_eq!(quick.staged_label, "");
    assert!(quick.drawn && quick.focused, "Return keeps the field");

    let found: Vec<wire::AgendaTask> = ts::load_board(&d, load::reminders::BoardView::All, None)
        .groups
        .into_iter()
        .flat_map(|group| group.tasks)
        .filter(|task| task.title == "Zq Post the parcel")
        .collect();
    assert_eq!(found.len(), 1);
    let stored = &found[0];
    assert_eq!(stored.project_id, None, "the Inbox");
    assert_eq!(stored.due_day, ts::today(&d));
    assert!(stored.flagged);
    assert_eq!(stored.tags.len(), 1);
}

#[test]
fn a_toolbar_event_before_the_bar_is_drawn_is_nothing() {
    let (mut d, id) = home();
    send_home(
        &mut d,
        id,
        H::QuickTool(wire::agenda_home_event::QuickToolPicked {
            key: "flag".to_owned(),
        }),
    );
    assert_eq!(home_bar(&d, id).staged_label, "");
}

// --- the task page's cards -------------------------------------------------------

fn field<'a>(view: &'a wire::ViewState, key: &str) -> &'a wire::TodoField {
    ts::detail_data(view)
        .fields
        .iter()
        .find(|f| f.key == key)
        .unwrap_or_else(|| panic!("no field `{key}`"))
}

#[test]
fn the_details_are_grouped_in_two_cards_in_the_boards_order() {
    let mut d = ts::driver();
    let id = ts::task(&d, "Pay the electricity bill");
    let page = d.push(agenda::TAB, routes::task(&id));
    let fields = &ts::detail_data(d.view(page)).fields;
    let keys: Vec<&str> = fields.iter().map(|f| f.key.as_str()).collect();
    assert_eq!(
        keys,
        [
            "when", "time", "reminder", "repeats", "project", "flag", "priority", "effort", "tags"
        ]
    );
    // A card's heading rides the first field of the card, and no other.
    let groups: Vec<(&str, &str)> = fields
        .iter()
        .filter(|f| !f.group.is_empty())
        .map(|f| (f.key.as_str(), f.group.as_str()))
        .collect();
    assert_eq!(
        groups,
        [("when", "Date & time"), ("project", "Organisation")]
    );
    assert_eq!(field(d.view(page), "project").label, "List");
}

#[test]
fn a_repeating_task_keeps_its_anchor_in_the_date_card() {
    let mut d = ts::driver();
    let id = ts::add(
        &d,
        act::reminders::AddTask {
            title: "Rent".into(),
            due: ts::due(&ts::day(&d, 3)),
            rule: centraid_screens::field::Field::Is("FREQ=MONTHLY".into()),
            ..Default::default()
        },
    );
    let page = d.push(agenda::TAB, routes::task(&id));
    let keys: Vec<&str> = ts::detail_data(d.view(page))
        .fields
        .iter()
        .map(|f| f.key.as_str())
        .collect();
    assert_eq!(
        keys,
        [
            "when", "time", "reminder", "repeats", "anchor", "project", "flag", "priority",
            "effort", "tags"
        ]
    );
}

#[test]
fn the_flag_is_a_switch_whose_on_and_off_set_and_clear_it() {
    let mut d = ts::driver();
    let id = ts::task(&d, "Book the dentist");
    let page = d.push(agenda::TAB, routes::task(&id));
    let flag = field(d.view(page), "flag").clone();
    assert!(flag.toggle && !flag.on);
    assert_eq!(
        flag.choices
            .iter()
            .map(|c| c.key.as_str())
            .collect::<Vec<_>>(),
        ["on", "off"]
    );

    ts::choose(&mut d, page, "flag", "on");
    assert!(ts::task_of(&d, &id).flagged);
    let flag = field(d.view(page), "flag").clone();
    assert!(flag.on);
    assert_eq!(
        ts::detail(d.view(page))
            .status
            .as_ref()
            .map(|s| s.sentence.as_str()),
        Some("Flagged")
    );
    // Already on: nothing more is written.
    ts::choose(&mut d, page, "flag", "on");
    assert!(ts::task_of(&d, &id).flagged);

    ts::choose(&mut d, page, "flag", "off");
    assert!(!ts::task_of(&d, &id).flagged);
    assert!(!field(d.view(page), "flag").on);
    // A key the switch does not hold is nothing.
    ts::choose(&mut d, page, "flag", "maybe");
    assert!(!ts::task_of(&d, &id).flagged);
}
