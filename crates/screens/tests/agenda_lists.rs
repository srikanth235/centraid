//! Lists and calendars, made and restyled (#1173 wave 2): the one style sheet
//! (name, colour, icon) from Reminders' "Add List", from a list's "Edit List"
//! and from More's calendar rows, through the door a shell uses.

mod todo_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::agenda::{self, routes};
use centraid_screens::catalog::{act, load};
use centraid_screens::testing::Driver;
use centraid_vault::commands::container::{LIST_COLORS, LIST_ICONS};
use todo_support::*;
use wire::agenda_home_event::Kind as H;
use wire::agenda_home_state::{Content, Sheet};
use wire::todo_project_event as pe;

fn home_id(d: &Driver) -> u64 {
    d.navigation.as_ref().expect("navigation").tabs[0].entries[0].instance
}

fn home(d: &Driver) -> &wire::AgendaHomeState {
    match &d.view(home_id(d)).kind {
        Some(wire::view_state::Kind::AgendaHome(state)) => state,
        other => panic!("not Agenda's home: {other:?}"),
    }
}

fn send_home(d: &mut Driver, kind: H) {
    let id = home_id(d);
    d.send(
        id,
        wire::screen_event::Kind::AgendaHome(wire::AgendaHomeEvent { kind: Some(kind) }),
    );
}

fn style_of(d: &Driver) -> wire::AgendaStyleSheet {
    *home(d).style.clone().expect("the style sheet is up")
}

fn name_it(d: &mut Driver, name: &str) {
    send_home(
        d,
        H::StyleName(wire::agenda_home_event::StyleNameChanged {
            name: name.to_owned(),
        }),
    );
}

fn color_it(d: &mut Driver, key: &str) {
    send_home(
        d,
        H::StyleColor(wire::agenda_home_event::StyleColorPicked {
            key: key.to_owned(),
        }),
    );
}

fn icon_it(d: &mut Driver, key: &str) {
    send_home(
        d,
        H::StyleIcon(wire::agenda_home_event::StyleIconPicked {
            key: key.to_owned(),
        }),
    );
}

fn submit(d: &mut Driver) {
    send_home(
        d,
        H::StyleSubmitted(wire::agenda_home_event::StyleSubmitted {}),
    );
}

fn calendars(d: &Driver) -> Vec<wire::AgendaCalendar> {
    match answer(d, load::calendar::Upcoming::default()) {
        wire::app_query_response::Answer::AgendaUpcoming(upcoming) => upcoming.calendars,
        other => panic!("upcoming answered {other:?}"),
    }
}

fn projects(d: &Driver) -> Vec<wire::AgendaTaskProject> {
    load_board(d, load::reminders::BoardView::Anytime, None).projects
}

fn choices(d: &Driver) -> Vec<wire::AgendaCalendarChoice> {
    match &home(d).content {
        Some(Content::Data(data)) => data.calendars.clone(),
        other => panic!("expected data, found {other:?}"),
    }
}

/// A palette colour other than `not`: a list's derived colour is its id's, so a
/// test cannot name one.
fn other_than(not: &str) -> &'static str {
    LIST_COLORS
        .iter()
        .copied()
        .find(|key| *key != not)
        .expect("eight colours")
}

fn open_more(d: &mut Driver) {
    send_home(
        d,
        H::Band(wire::agenda_home_event::BandPicked {
            key: "more".to_owned(),
        }),
    );
}

fn more_row(d: &mut Driver, key: &str) {
    send_home(
        d,
        H::MoreRow(wire::agenda_home_event::MoreRowPicked {
            key: key.to_owned(),
        }),
    );
}

fn todo_home(d: &mut Driver) {
    send_home(
        d,
        H::Destination(wire::agenda_home_event::DestinationChanged {
            destination: wire::AgendaDestination::Todo as i32,
        }),
    );
}

#[test]
fn a_calendar_is_made_with_a_name_a_colour_and_an_icon() {
    let mut d = driver();
    open_more(&mut d);
    let more = home(&d).more_rows.clone();
    assert!(
        more.iter().any(|row| row.key == "new-calendar"),
        "More offers New Calendar"
    );
    more_row(&mut d, "new-calendar");
    assert_eq!(home(&d).sheet, Sheet::NewCalendar as i32);
    let sheet = style_of(&d);
    assert_eq!(sheet.title, "New Calendar");
    assert_eq!(sheet.submit_label, "Create");
    assert!(!sheet.can_submit, "no name yet");
    assert_eq!(sheet.colors.len(), 8);
    assert_eq!(sheet.icons.len(), LIST_ICONS.len());
    assert!(sheet.no_icon_selected);

    name_it(&mut d, "  Gym classes ");
    color_it(&mut d, "raspberry");
    icon_it(&mut d, "Gym");
    let sheet = style_of(&d);
    assert!(sheet.can_submit);
    assert_eq!(sheet.color_key, "raspberry");
    assert_eq!(sheet.icon_key, "Gym");
    assert!(!sheet.no_icon_selected);
    assert!(
        sheet
            .colors
            .iter()
            .any(|swatch| swatch.key == "raspberry" && swatch.selected)
    );
    assert_eq!(sheet.colors.iter().filter(|c| c.selected).count(), 1);
    submit(&mut d);

    assert_eq!(home(&d).sheet, Sheet::None as i32);
    assert_eq!(
        home(&d).status.as_ref().map(|s| s.sentence.as_str()),
        Some("Calendar created")
    );
    let made = calendars(&d)
        .into_iter()
        .find(|calendar| calendar.name.as_deref() == Some("Gym classes"))
        .expect("the calendar is in the vault, trimmed");
    assert_eq!(made.color.as_deref(), Some("raspberry"));
    assert_eq!(made.icon.as_deref(), Some("Gym"));
    // The view state carries the keys, and More's row wears them.
    let choice = choices(&d)
        .into_iter()
        .find(|choice| choice.calendar_id == made.calendar_id)
        .expect("a choice");
    assert_eq!(choice.color_key, "raspberry");
    assert_eq!(choice.icon_key, "Gym");
    open_more(&mut d);
    let row = home(&d)
        .more_rows
        .iter()
        .find(|row| row.key == format!("calendar-{}", made.calendar_id))
        .cloned()
        .expect("the calendar's More row");
    assert_eq!(
        (row.color_key.as_str(), row.icon_key.as_str()),
        ("raspberry", "Gym")
    );
    assert_eq!(row.edit_label, "Edit Gym classes");
}

#[test]
fn a_calendar_is_renamed_and_restyled_and_its_icon_cleared() {
    let mut d = driver();
    let id = id_of(&arrange(
        &d,
        act::calendar::CreateCalendar {
            title: "Work".to_owned(),
            color: centraid_screens::field::Field::Is(act::calendar::CreateCalendarColor::Violet),
            icon: centraid_screens::field::Field::Is("Book".to_owned()),
            ..Default::default()
        },
    ));
    d.pump(std::time::Duration::from_millis(400));
    send_home(
        &mut d,
        H::CalendarEdit(wire::agenda_home_event::CalendarEditRequested {
            calendar_id: id.clone(),
        }),
    );
    assert_eq!(home(&d).sheet, Sheet::EditCalendar as i32);
    let sheet = style_of(&d);
    assert_eq!(sheet.title, "Edit Calendar");
    assert_eq!(sheet.submit_label, "Save");
    assert_eq!(sheet.name, "Work");
    assert_eq!(sheet.color_key, "violet");
    assert_eq!(sheet.icon_key, "Book");
    assert!(
        sheet.can_submit,
        "Save is armed by the name, as the board draws it"
    );

    name_it(&mut d, "Day job");
    color_it(&mut d, "petrol");
    icon_it(&mut d, "");
    let sheet = style_of(&d);
    assert!(sheet.can_submit && sheet.no_icon_selected);
    assert!(sheet.icons.iter().all(|icon| !icon.selected));
    submit(&mut d);
    assert_eq!(
        home(&d).status.as_ref().map(|s| s.sentence.as_str()),
        Some("Calendar updated")
    );
    let now = calendars(&d)
        .into_iter()
        .find(|calendar| calendar.calendar_id == id)
        .expect("still there");
    assert_eq!(now.name.as_deref(), Some("Day job"));
    assert_eq!(now.color.as_deref(), Some("petrol"));
    assert_eq!(now.icon, None, "the icon is cleared");
}

#[test]
fn closing_a_calendar_sheet_returns_to_more_and_writes_nothing() {
    let mut d = driver();
    open_more(&mut d);
    more_row(&mut d, "new-calendar");
    name_it(&mut d, "Zq Never made");
    send_home(
        &mut d,
        H::SheetClosed(wire::agenda_home_event::SheetClosed {}),
    );
    assert_eq!(home(&d).sheet, Sheet::More as i32);
    assert!(home(&d).style.is_none());
    assert!(
        calendars(&d)
            .iter()
            .all(|calendar| calendar.name.as_deref() != Some("Zq Never made"))
    );
}

#[test]
fn a_list_is_made_with_a_colour_and_an_icon_from_add_list() {
    let mut d = driver();
    todo_home(&mut d);
    send_home(
        &mut d,
        H::SheetOpened(wire::agenda_home_event::SheetOpened {
            sheet: Sheet::NewProject as i32,
        }),
    );
    assert_eq!(home(&d).sheet, Sheet::NewProject as i32);
    let sheet = style_of(&d);
    assert_eq!(sheet.title, "New List");
    assert!(!style_of(&d).can_submit);
    name_it(&mut d, "Garden");
    color_it(&mut d, "petrol");
    icon_it(&mut d, "Plant");
    assert_eq!(style_of(&d).name, "Garden");
    assert!(style_of(&d).can_submit);
    submit(&mut d);
    assert_eq!(home(&d).sheet, Sheet::None as i32);
    assert_eq!(
        home(&d).status.as_ref().map(|s| s.sentence.as_str()),
        Some("List created")
    );
    let made = projects(&d)
        .into_iter()
        .find(|project| project.name == "Garden")
        .expect("the list");
    assert_eq!(made.color.as_deref(), Some("petrol"));
    assert_eq!(made.icon.as_deref(), Some("Plant"));
    // My Lists draws the icon and the colour key.
    let Some(Content::Data(data)) = &home(&d).content else {
        panic!("data");
    };
    let row = data
        .todo
        .as_ref()
        .expect("to-do")
        .projects
        .iter()
        .flat_map(|group| &group.rows)
        .find(|row| {
            row.route
                .as_ref()
                .is_some_and(|r| r.screen == "agenda.project")
                && row.row.as_ref().is_some_and(|r| r.id == made.project_id)
        })
        .expect("the row");
    assert_eq!(row.icon_key, "Plant");
    assert_eq!(row.list_color_key, "petrol");
}

#[test]
fn a_list_is_restyled_from_its_page_and_an_unstyled_one_keeps_its_derived_colour() {
    let mut d = driver();
    let id = project(&d, "Allotment");
    d.pump(std::time::Duration::from_millis(400));
    let i = d.push(agenda::TAB, routes::project(&id, "Allotment"));
    let data = project_data(d.view(i));
    assert_eq!(data.style_label, "Edit List");
    assert_eq!(data.icon_key, "");
    let derived = data.list_color_key.clone();
    assert!(LIST_COLORS.contains(&derived.as_str()));

    send_project(&mut d, i, pe::Kind::StyleRequested(pe::StyleRequested {}));
    let state = project_state(d.view(i));
    assert_eq!(state.sheet, wire::todo_project_state::Sheet::Style as i32);
    let sheet = state.style.clone().expect("the sheet");
    assert_eq!(sheet.title, "Edit List");
    assert_eq!(sheet.name, "Allotment");
    assert_eq!(
        sheet.color_key, derived,
        "the derived colour is the selected one"
    );
    assert!(
        sheet.can_submit,
        "an edit's Save is armed with a name, as the board draws it"
    );

    // An icon alone writes no colour: the list stays unstyled in colour.
    send_project(
        &mut d,
        i,
        pe::Kind::StyleIcon(pe::StyleIconPicked { key: "Home".into() }),
    );
    assert!(project_state(d.view(i)).style.as_ref().unwrap().can_submit);
    send_project(&mut d, i, pe::Kind::StyleSubmitted(pe::StyleSubmitted {}));
    let stored = projects(&d)
        .into_iter()
        .find(|p| p.project_id == id)
        .expect("the list");
    assert_eq!(stored.icon.as_deref(), Some("Home"));
    assert_eq!(stored.color, None, "no colour was chosen, none is stored");
    let data = project_data(d.view(i));
    assert_eq!(data.icon_key, "Home");
    assert_eq!(data.list_color_key, derived);
    assert_eq!(
        project_state(d.view(i)).status.as_ref().unwrap().sentence,
        "List updated"
    );

    // Name, colour and clearing the icon, in one Save.
    let other = other_than(&derived);
    send_project(&mut d, i, pe::Kind::StyleRequested(pe::StyleRequested {}));
    send_project(
        &mut d,
        i,
        pe::Kind::StyleName(pe::StyleNameChanged {
            name: "Plot 7".into(),
        }),
    );
    send_project(
        &mut d,
        i,
        pe::Kind::StyleColor(pe::StyleColorPicked { key: other.into() }),
    );
    send_project(
        &mut d,
        i,
        pe::Kind::StyleIcon(pe::StyleIconPicked { key: String::new() }),
    );
    send_project(&mut d, i, pe::Kind::StyleSubmitted(pe::StyleSubmitted {}));
    let state = project_state(d.view(i));
    assert_eq!(state.title, "Plot 7");
    let data = project_data(d.view(i));
    assert_eq!(data.list_color_key, other);
    assert_eq!(data.icon_key, "");
    let stored = projects(&d)
        .into_iter()
        .find(|p| p.project_id == id)
        .expect("the list");
    assert_eq!(stored.color.as_deref(), Some(other));
    assert_eq!(stored.icon, None);
}

#[test]
fn a_key_outside_the_palette_or_the_icons_is_nothing() {
    let mut d = driver();
    open_more(&mut d);
    more_row(&mut d, "new-calendar");
    color_it(&mut d, "chartreuse");
    icon_it(&mut d, "Rocket");
    let sheet = style_of(&d);
    assert_eq!(sheet.color_key, "blue");
    assert!(sheet.no_icon_selected);
}

#[test]
fn the_vaults_refusal_is_the_status_line_and_the_sheet_keeps_its_words() {
    let mut d = driver();
    let id = project(&d, "Doomed");
    d.pump(std::time::Duration::from_millis(400));
    let i = d.push(agenda::TAB, routes::project(&id, "Doomed"));
    send_project(&mut d, i, pe::Kind::StyleRequested(pe::StyleRequested {}));
    let sheet_color = project_state(d.view(i))
        .style
        .as_ref()
        .unwrap()
        .color_key
        .clone();
    // The list is trashed elsewhere while the sheet is up.
    arrange(
        &d,
        act::reminders::DeleteTask {
            task_id: id.clone(),
        },
    );
    d.pump(std::time::Duration::from_millis(400));
    let other = other_than(&sheet_color).to_owned();
    send_project(
        &mut d,
        i,
        pe::Kind::StyleColor(pe::StyleColorPicked { key: other }),
    );
    send_project(&mut d, i, pe::Kind::StyleSubmitted(pe::StyleSubmitted {}));
    let state = project_state(d.view(i));
    let status = state
        .status
        .as_ref()
        .unwrap_or_else(|| panic!("a status line: {state:?}"));
    assert!(status.refused, "{}", status.sentence);
    assert!(!status.sentence.is_empty());
    assert!(state.style.is_some(), "the sheet keeps the member's words");
}

#[test]
fn every_colour_and_icon_the_sheet_offers_exists_in_the_design_files() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let tokens = centraid_design::tokens::Tokens::load(&root).expect("design files");
    for key in LIST_COLORS {
        assert!(tokens.list.contains_key(key), "list colour {key}");
    }
    for key in LIST_ICONS {
        assert!(tokens.icons.contains_key(key), "icon {key}");
    }
    let mut d = driver();
    open_more(&mut d);
    more_row(&mut d, "new-calendar");
    let sheet = style_of(&d);
    for swatch in &sheet.colors {
        assert!(tokens.list.contains_key(&swatch.key), "{}", swatch.key);
        assert!(!swatch.label.is_empty() && swatch.label != swatch.key);
    }
    for icon in &sheet.icons {
        assert!(tokens.icons.contains_key(&icon.key), "{}", icon.key);
        assert!(!icon.label.is_empty());
    }
}
