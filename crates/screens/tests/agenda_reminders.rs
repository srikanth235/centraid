//! The Reminders half of the Agenda revamp (#1173), through the door a shell
//! uses: the band, the smart lists and their counts, the Flag and the Flagged
//! list, the swipe's Delete, drag to reorder, show and clear completed, a list's
//! colour on the one palette, and Catch up's new title.

mod todo_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::agenda::{self, routes};
use centraid_screens::catalog::act;
use centraid_screens::field::Field;
use todo_support::*;
use wire::todo_list_event as le;
use wire::todo_project_event as pe;

fn flag(id: &str, on: bool) -> le::Kind {
    le::Kind::RowFlagged(le::RowFlagged {
        task_id: id.to_owned(),
        flagged: on,
    })
}

fn titles(groups: &[wire::TodoRowGroup]) -> Vec<String> {
    rows(groups).iter().map(|r| r.title.clone()).collect()
}

#[test]
fn flagging_a_row_puts_it_in_the_flagged_list_and_undo_takes_it_out() {
    let mut d = driver();
    clear_tasks(&d);
    let keep = task(&d, "Call the bank");
    let _other = task(&d, "Water the plants");
    let all = d.push(agenda::TAB, routes::todo_list(wire::TodoView::All));
    send_list(&mut d, all, flag(&keep, true));
    let status = list(d.view(all)).status.clone().expect("a status line");
    assert_eq!(
        (status.sentence.as_str(), status.action_label.as_str()),
        ("Flagged", "Undo")
    );
    assert!(task_of(&d, &keep).flagged);
    let flagged_row = rows(&list_data(d.view(all)).groups)
        .into_iter()
        .find(|r| r.task_id == keep)
        .cloned()
        .unwrap();
    assert!(flagged_row.flagged);

    let flagged = d.push(agenda::TAB, routes::todo_list(wire::TodoView::Flagged));
    assert_eq!(list(d.view(flagged)).title, "Flagged");
    assert_eq!(
        titles(&list_data(d.view(flagged)).groups),
        ["Call the bank"]
    );

    send_list(&mut d, all, le::Kind::StatusActed(le::StatusActed {}));
    assert!(!task_of(&d, &keep).flagged);
    send_list(&mut d, flagged, le::Kind::Refreshed(le::Refreshed {}));
    assert!(list_data(d.view(flagged)).groups.is_empty());
    assert_eq!(
        list_data(d.view(flagged)).empty.as_ref().unwrap().headline,
        "Nothing is flagged."
    );
}

#[test]
fn unflagging_clears_the_flag() {
    let mut d = driver();
    clear_tasks(&d);
    let id = task(&d, "Renew passport");
    let i = d.push(agenda::TAB, routes::todo_list(wire::TodoView::All));
    send_list(&mut d, i, flag(&id, true));
    send_list(&mut d, i, flag(&id, false));
    assert!(!task_of(&d, &id).flagged);
    assert_eq!(
        list(d.view(i)).status.as_ref().unwrap().sentence,
        "Flag removed"
    );
}

#[test]
fn the_swipes_delete_trashes_the_task_and_undo_restores_it() {
    let mut d = driver();
    clear_tasks(&d);
    let id = task(&d, "Clear out the garage");
    let i = d.push(agenda::TAB, routes::todo_list(wire::TodoView::All));
    send_list(
        &mut d,
        i,
        le::Kind::RowDeleted(le::RowDeleted {
            task_id: id.clone(),
        }),
    );
    assert_eq!(
        list(d.view(i)).status.as_ref().unwrap().sentence,
        "Task deleted"
    );
    assert!(rows(&list_data(d.view(i)).groups).is_empty());
    send_list(&mut d, i, le::Kind::StatusActed(le::StatusActed {}));
    assert_eq!(rows(&list_data(d.view(i)).groups).len(), 1);
}

#[test]
fn today_holds_what_is_due_today_or_before_and_scheduled_what_has_a_date() {
    let mut d = driver();
    clear_tasks(&d);
    let today_id = add(
        &d,
        act::agenda::AddTask {
            title: "Due today".into(),
            due: due(&today(&d)),
            ..Default::default()
        },
    );
    let _later = add(
        &d,
        act::agenda::AddTask {
            title: "Due later".into(),
            due: due(&day(&d, 3)),
            ..Default::default()
        },
    );
    let _undated = task(&d, "No date");
    let t = d.push(agenda::TAB, routes::todo_list(wire::TodoView::Today));
    let state = list(d.view(t));
    assert_eq!(state.title, "Today");
    let data = list_data(d.view(t));
    assert_eq!(titles(&data.groups), ["Due today"]);
    assert_eq!(rows(&data.groups)[0].task_id, today_id);
    assert!(data.subtitle.ends_with("1 to do"), "{}", data.subtitle);

    let s = d.push(agenda::TAB, routes::todo_list(wire::TodoView::Scheduled));
    assert_eq!(
        titles(&list_data(d.view(s)).groups),
        ["Due today", "Due later"]
    );
}

#[test]
fn a_smart_list_page_names_its_colour_and_the_add_sheet_its_plus_opens() {
    let mut d = driver();
    clear_tasks(&d);
    let _ = task(&d, "Anything");
    // The colour is the card's on the Reminders home, so the page's large title matches it.
    for (view, color) in [
        (wire::TodoView::Today, "listBlue"),
        (wire::TodoView::Scheduled, "listRaspberry"),
        (wire::TodoView::All, "appLocker"),
        (wire::TodoView::Flagged, "stateAmber"),
        (wire::TodoView::Logbook, "listGraphite"),
    ] {
        let t = d.push(agenda::TAB, routes::todo_list(view));
        let state = list(d.view(t));
        assert_eq!(state.color_key, color, "{view:?}");
        assert_eq!(state.add_label, "Add task");
        let route = state.add_route.as_ref().expect("the plus has a sheet");
        assert_eq!(
            route.screen,
            routes::editor(
                "",
                "",
                None,
                &today(&d),
                wire::AgendaEditorKind::Unspecified
            )
            .screen
        );
    }
    // A view with no colour of its own draws a plain title.
    let t = d.push(agenda::TAB, routes::todo_list(wire::TodoView::Anytime));
    assert_eq!(list(d.view(t)).color_key, "");
}

#[test]
fn the_reminders_home_counts_its_smart_lists_and_gives_each_list_a_palette_colour() {
    use wire::agenda_home_state::Content;
    let mut d = driver();
    clear_tasks(&d);
    let flagged_id = add(
        &d,
        act::agenda::AddTask {
            title: "Flag me".into(),
            due: due(&today(&d)),
            ..Default::default()
        },
    );
    let _ = task(&d, "Plain");
    arrange(
        &d,
        act::agenda::StarTask {
            task_id: flagged_id,
        },
    );
    let _errands = project(&d, "Errands");
    let i = d.push(agenda::TAB, routes::home(wire::AgendaDestination::Todo, ""));
    let state = match &d.view(i).kind {
        Some(wire::view_state::Kind::AgendaHome(state)) => state.clone(),
        other => panic!("not Agenda's home: {other:?}"),
    };
    let band: Vec<&str> = state.band.iter().map(|t| t.label.as_str()).collect();
    assert_eq!(band, ["Calendar", "Reminders", "Invites", "More"]);
    assert!(state.band[1].current);
    assert!(
        state.calendar_views.is_empty(),
        "Reminders has no view menu"
    );
    let Some(Content::Data(data)) = state.content else {
        panic!("data")
    };
    let todo = data.todo.unwrap();
    let cards: Vec<(String, String)> = todo
        .smart_lists
        .iter()
        .map(|c| (c.label.clone(), c.count.clone()))
        .collect();
    assert_eq!(
        cards,
        [
            ("Today".to_owned(), "1".to_owned()),
            ("Scheduled".to_owned(), "1".to_owned()),
            ("All".to_owned(), "2".to_owned()),
            ("Flagged".to_owned(), "1".to_owned()),
            ("Completed".to_owned(), String::new()),
        ]
    );
    assert_eq!(todo.my_lists_title, "My Lists");
    assert_eq!(todo.add_list_label, "Add List");
    let palette = [
        "blue",
        "mustard",
        "violet",
        "petrol",
        "indigo",
        "graphite",
        "raspberry",
        "orchid",
    ];
    for group in &todo.projects {
        for row in &group.rows {
            assert!(palette.contains(&row.list_color_key.as_str()));
        }
    }
}

#[test]
fn the_calendar_headers_layout_key_offers_day_week_month_list_and_year() {
    let mut d = driver();
    let i = d.push(agenda::TAB, routes::home(wire::AgendaDestination::Day, ""));
    let state = match &d.view(i).kind {
        Some(wire::view_state::Kind::AgendaHome(state)) => state.clone(),
        other => panic!("not Agenda's home: {other:?}"),
    };
    assert!(state.band[0].current);
    // Day and Week draw the board's header, whose layout key holds the views.
    let header = state
        .calendar_header
        .as_ref()
        .expect("Day draws the header");
    assert!(header.shown);
    assert!(
        state.calendar_views.is_empty(),
        "the old view menu is Month, List and Year only"
    );
    let menu: Vec<(&str, bool, i32)> = header
        .layouts
        .iter()
        .map(|v| (v.label.as_str(), v.current, v.destination))
        .collect();
    assert_eq!(
        menu,
        [
            ("Day", true, wire::AgendaDestination::Day as i32),
            ("Week", false, wire::AgendaDestination::Week as i32),
            ("Month", false, wire::AgendaDestination::Month as i32),
            ("List", false, wire::AgendaDestination::Schedule as i32),
            ("Year", false, wire::AgendaDestination::Year as i32),
        ]
    );
}

#[test]
fn dragging_a_row_renumbers_the_list_and_the_list_draws_in_that_order() {
    let mut d = driver();
    let list_id = project(&d, "Reorder me");
    let ids: Vec<String> = ["Alpha", "Bravo", "Charlie"]
        .iter()
        .map(|title| {
            add(
                &d,
                act::agenda::AddTask {
                    title: (*title).into(),
                    project_id: Field::Is(list_id.clone()),
                    ..Default::default()
                },
            )
        })
        .collect();
    let i = d.push(agenda::TAB, routes::project(&list_id, "Reorder me"));
    assert_eq!(
        titles(&project_data(d.view(i)).groups),
        ["Alpha", "Bravo", "Charlie"]
    );
    // Charlie dropped before Alpha.
    send_project(
        &mut d,
        i,
        pe::Kind::RowMoved(pe::RowMoved {
            task_id: ids[2].clone(),
            before_id: ids[0].clone(),
        }),
    );
    assert_eq!(
        titles(&project_data(d.view(i)).groups),
        ["Charlie", "Alpha", "Bravo"]
    );
    assert_eq!(task_of(&d, &ids[2]).sort_order, 1);
    // Alpha to the end: only Bravo and Alpha change place.
    send_project(
        &mut d,
        i,
        pe::Kind::RowMoved(pe::RowMoved {
            task_id: ids[0].clone(),
            before_id: String::new(),
        }),
    );
    assert_eq!(
        titles(&project_data(d.view(i)).groups),
        ["Charlie", "Bravo", "Alpha"]
    );
    // A task added afterwards lands after the hand-ordered ones.
    let _ = add(
        &d,
        act::agenda::AddTask {
            title: "Delta".into(),
            project_id: Field::Is(list_id.clone()),
            ..Default::default()
        },
    );
    send_project(&mut d, i, pe::Kind::Refreshed(pe::Refreshed {}));
    assert_eq!(
        titles(&project_data(d.view(i)).groups),
        ["Charlie", "Bravo", "Alpha", "Delta"]
    );
}

#[test]
fn completed_work_is_counted_shown_and_cleared() {
    let mut d = driver();
    let list_id = project(&d, "Finish things");
    let make = |d: &_, title: &str| {
        add(
            d,
            act::agenda::AddTask {
                title: title.into(),
                project_id: Field::Is(list_id.clone()),
                ..Default::default()
            },
        )
    };
    let open = make(&d, "Still open");
    let a = make(&d, "Done one");
    let b = make(&d, "Done two");
    complete(&d, &a);
    complete(&d, &b);
    let i = d.push(agenda::TAB, routes::project(&list_id, "Finish things"));
    let done = project_data(d.view(i)).completed.clone().unwrap();
    assert_eq!(
        (done.count, done.count_label.as_str(), done.shown),
        (2, "2 completed", false)
    );
    assert!(done.rows.is_empty());

    send_project(
        &mut d,
        i,
        pe::Kind::CompletedToggled(pe::CompletedToggled {}),
    );
    let done = project_data(d.view(i)).completed.clone().unwrap();
    assert!(done.shown);
    assert_eq!(done.rows.len(), 2);

    send_project(
        &mut d,
        i,
        pe::Kind::CompletedCleared(pe::CompletedCleared {}),
    );
    assert_eq!(
        project_state(d.view(i)).status.as_ref().unwrap().sentence,
        "Completed cleared"
    );
    let done = project_data(d.view(i)).completed.clone().unwrap();
    assert_eq!(done.count, 0);
    assert_eq!(titles(&project_data(d.view(i)).groups), ["Still open"]);
    assert_eq!(task_of(&d, &open).status, "open");
}

#[test]
fn an_imported_red_list_is_drawn_raspberry_and_a_list_never_has_a_state_colour() {
    let mut d = driver();
    let red = arrange(
        &d,
        act::agenda::CreateProject {
            title: "Imported red".into(),
            // What the reminders import writes for a phone's red list.
            color: Field::Is(
                centraid_screens::imports::reminders::list_color("Imported red", "#FF3B30")
                    .expect("a colour"),
            ),
            ..Default::default()
        },
    );
    let id = id_of(&red);
    let i = d.push(agenda::TAB, routes::project(&id, "Imported red"));
    assert_eq!(project_data(d.view(i)).list_color_key, "raspberry");
}

#[test]
fn catch_up_is_titled_catch_up() {
    assert_eq!(
        centraid_screens::strings::task::catch_up(centraid_screens::strings::Locale::En),
        "Catch up"
    );
}
