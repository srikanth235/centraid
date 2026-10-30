//! The to-do list pages, the project page and Catch up, through the door a shell
//! uses. Ports of the `TasksSpec` cases for `agenda.task_list`, `agenda.task.project` and
//! `agenda.task.catch_up`, plus the behaviours the old architecture only implied.

mod todo_support;

use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::agenda::{self, routes, todo::rows};
use centraid_screens::catalog::{act, load};
use centraid_screens::field::Field;
use centraid_screens::strings::Locale;
use todo_support::*;
use wire::todo_catch_up_event as cu;
use wire::todo_list_event as le;
use wire::todo_project_event as pe;

const EN: Locale = Locale::En;

fn checked(id: &str) -> le::Kind {
    le::Kind::RowChecked(le::RowChecked {
        task_id: id.to_owned(),
    })
}

// -----------------------------------------------------------------------------
// Rows
// -----------------------------------------------------------------------------

#[test]
fn a_projects_hue_is_a_colour_role_never_the_wheels_word() {
    let project = wire::AgendaTaskProject {
        project_id: "p1".into(),
        color: Some("var(--c-teal)".into()),
        ..Default::default()
    };
    assert_eq!(rows::hue_of("p1", Some(&project)), "cTeal");
    // No stored hue: the id's own, still a role.
    let own = rows::hue_of(
        "p1",
        Some(&wire::AgendaTaskProject {
            project_id: "p1".into(),
            ..Default::default()
        }),
    );
    assert!(own.starts_with('c') && own.len() > 1, "{own}");
    assert!(rows::hue_of("p1", None).starts_with('c'));
}

#[test]
fn a_rows_meta_line_names_the_age_only_from_the_cores_local_day() {
    let old = wire::AgendaTask {
        task_id: "b".into(),
        title: "Paint shed".into(),
        status: "open".into(),
        age_days: Some(200),
        created_at: Some("2025-10-31T23:30:00.000Z".into()),
        // 23:30 UTC on 31 October is 1 November in the member's zone: the core's day names the month.
        created_local_day: "2025-11-01".into(),
        ..Default::default()
    };
    let ctx = rows::Context {
        today: "2026-06-15",
        ..Default::default()
    };
    assert_eq!(rows::meta(EN, &old, &ctx), "sitting since November");
    // NO LOCAL DAY ANSWERED: the month is not guessed from a UTC instant.
    let unplaced = wire::AgendaTask {
        created_local_day: String::new(),
        ..old
    };
    assert_eq!(rows::meta(EN, &unplaced, &ctx), "");
}

#[test]
fn a_rows_meta_line_says_project_repeats_missed_effort_tags_and_family() {
    let behind = wire::AgendaTask {
        task_id: "a".into(),
        title: "Rent".into(),
        status: "open".into(),
        due_day: "2026-06-19".into(),
        days_from_today: Some(4),
        project_id: Some("p1".into()),
        repeats: true,
        recurrence_summary: Some("Monthly".into()),
        missed: 2,
        effort_min: Some(25),
        tags: vec![wire::AgendaTaskTag {
            concept_id: "c".into(),
            label: "home".into(),
        }],
        children: vec![
            wire::AgendaTask {
                task_id: "c1".into(),
                title: "Transfer".into(),
                status: "open".into(),
                ..Default::default()
            },
            wire::AgendaTask {
                task_id: "c2".into(),
                title: "Receipt".into(),
                status: "done".into(),
                ..Default::default()
            },
        ],
        done_children: 1,
        priority: 3,
        ..Default::default()
    };
    let projects = [wire::AgendaTaskProject {
        project_id: "p1".into(),
        name: "Home admin".into(),
        ..Default::default()
    }];
    let ctx = rows::Context::of("2026-06-15", &projects, &[]);
    assert_eq!(
        rows::meta(EN, &behind, &ctx),
        "Home admin · Monthly · missed 2 · next is Fri 19 June · ~25 min · #home · 1 of 2"
    );
    let row = rows::row(EN, &behind, &ctx, false);
    assert_eq!(row.priority_label, "Now");
    assert!(row.children.iter().all(|child| child.subtask));
}

#[test]
fn priority_runs_higher_more_urgent_and_anything_above_three_is_now() {
    for none in [0, -1] {
        assert_eq!(rows::priority_label(EN, none), "");
    }
    assert_eq!(rows::priority_label(EN, 1), "Soon");
    assert_eq!(rows::priority_label(EN, 2), "Next");
    assert_eq!(rows::priority_label(EN, 3), "Now");
    for high in [4, 5, 9] {
        assert_eq!(rows::priority_label(EN, high), "Now");
    }
}

// -----------------------------------------------------------------------------
// agenda.todo_list
// -----------------------------------------------------------------------------

#[test]
fn the_list_reads_its_view_and_names_it() {
    let mut d = driver();
    clear_tasks(&d);
    let idea = task(&d, "Someday idea");
    let dated = add(
        &d,
        act::agenda::AddTask {
            title: "Dated work".into(),
            due: due(&day(&d, 3)),
            ..Default::default()
        },
    );
    for (view, title, expect_idea, expect_dated) in [
        (wire::TodoView::Anytime, "Anytime", true, false),
        (wire::TodoView::All, "All", true, true),
        (wire::TodoView::Logbook, "Logbook", false, false),
        (wire::TodoView::Reminders, "Reminders", false, false),
    ] {
        let i = d.push(agenda::TAB, routes::todo_list(view));
        let state = list(d.view(i));
        assert_eq!(state.title, title);
        assert_eq!(state.view, view as i32);
        let data = list_data(d.view(i));
        let ids: Vec<&str> = rows(&data.groups)
            .iter()
            .map(|r| r.task_id.as_str())
            .collect();
        assert_eq!(ids.contains(&idea.as_str()), expect_idea, "{title}");
        assert_eq!(ids.contains(&dated.as_str()), expect_dated, "{title}");
    }
}

#[test]
fn the_logbook_draws_done_and_released_work_and_its_box_reopens() {
    let mut d = driver();
    clear_tasks(&d);
    let done = task(&d, "Filed taxes");
    let released = task(&d, "Old idea");
    complete(&d, &done);
    cancel(&d, &released);
    let i = d.push(agenda::TAB, routes::todo_list(wire::TodoView::Logbook));
    let data = list_data(d.view(i));
    let titles: Vec<&str> = data.groups.iter().map(|g| g.title.as_str()).collect();
    assert_eq!(titles, ["Done", "Won't do"]);
    let row = &group_titled(&data.groups, "Done").rows[0];
    assert_eq!(row.check, wire::TodoCheck::Done as i32);
    assert_eq!(row.check_label, "Reopen Filed taxes");
    assert_eq!(row.meta, "Today");
    assert!(!row.can_file);
    assert_eq!(
        group_titled(&data.groups, "Won't do").rows[0].check,
        wire::TodoCheck::WontDo as i32
    );

    send_list(&mut d, i, checked(&done));
    let after = list(d.view(i));
    assert_eq!(after.status.as_ref().unwrap().sentence, "Task reopened");
    let titles: Vec<&str> = list_data(d.view(i))
        .groups
        .iter()
        .map(|g| g.title.as_str())
        .collect();
    assert_eq!(titles, ["Won't do"]);
    assert_eq!(task_of(&d, &done).status, "open");
}

#[test]
fn checking_a_row_completes_it_and_undo_reopens_it() {
    let mut d = driver();
    clear_tasks(&d);
    let keep = task(&d, "Stays");
    let gone = task(&d, "Buy milk");
    let i = d.push(agenda::TAB, routes::todo_list(wire::TodoView::Anytime));
    send_list(&mut d, i, checked(&gone));
    let state = list(d.view(i));
    let status = state.status.as_ref().expect("a status line");
    assert_eq!(
        (status.sentence.as_str(), status.action_label.as_str()),
        ("Task done", "Undo")
    );
    assert_eq!(task_of(&d, &gone).status, "done");
    let ids: Vec<String> = rows(&list_data(d.view(i)).groups)
        .iter()
        .map(|r| r.task_id.clone())
        .collect();
    assert_eq!(
        ids,
        std::slice::from_ref(&keep),
        "a done row is drawn in the Logbook only"
    );

    send_list(&mut d, i, le::Kind::StatusActed(le::StatusActed {}));
    assert_eq!(task_of(&d, &gone).status, "open");
    assert!(list(d.view(i)).status.is_none());
    assert_eq!(rows(&list_data(d.view(i)).groups).len(), 2);
}

#[test]
fn a_check_on_a_later_visit_is_not_a_replay_of_the_same_check_on_an_earlier_one() {
    // The vault journals an invoke key for good, and answers a second delivery
    // "replayed" without running it: a key counter restarted on every visit
    // would make the second check a silent no-op.
    let mut d = driver();
    clear_tasks(&d);
    let id = task(&d, "Again");
    let first = d.push(agenda::TAB, routes::todo_list(wire::TodoView::Anytime));
    send_list(&mut d, first, checked(&id));
    assert_eq!(task_of(&d, &id).status, "done");
    d.pop(agenda::TAB, first);
    arrange(
        &d,
        act::agenda::ReopenTask {
            task_id: id.clone(),
        },
    );
    let second = d.push(agenda::TAB, routes::todo_list(wire::TodoView::Anytime));
    send_list(&mut d, second, checked(&id));
    assert_eq!(task_of(&d, &id).status, "done");
}

#[test]
fn a_repeating_task_names_its_next_date_and_offers_no_undo() {
    let mut d = driver();
    clear_tasks(&d);
    let water = add(
        &d,
        act::agenda::AddTask {
            title: "Water the plants".into(),
            due: due(&day(&d, 2)),
            rule: Field::Is("FREQ=WEEKLY".into()),
            ..Default::default()
        },
    );
    let i = d.push(agenda::TAB, routes::todo_list(wire::TodoView::All));
    send_list(&mut d, i, checked(&water));
    let status = list(d.view(i)).status.clone().expect("a status line");
    assert!(
        status.sentence.starts_with("Task done · the next one is "),
        "{}",
        status.sentence
    );
    assert_eq!(
        status.action_label, "",
        "the engine already opened the next one"
    );
}

#[test]
fn reminders_name_a_moment_when_the_core_supplies_one_else_the_day() {
    let mut d = driver();
    clear_tasks(&d);
    let tomorrow = day(&d, 1);
    add(
        &d,
        act::agenda::AddTask {
            title: "Call".into(),
            due: due(&format!("{tomorrow}T09:00")),
            remind_before_min: Field::Is(30),
            ..Default::default()
        },
    );
    add(
        &d,
        act::agenda::AddTask {
            title: "Bins".into(),
            due: due(&day(&d, 2)),
            remind_before_min: Field::Is(0),
            ..Default::default()
        },
    );
    let i = d.push(agenda::TAB, routes::todo_list(wire::TodoView::Reminders));
    let data = list_data(d.view(i));
    let call = row_titled(&data.groups, "Call");
    assert!(
        call.meta.contains("reminder Tomorrow 08:30"),
        "{}",
        call.meta
    );
    let bins = row_titled(&data.groups, "Bins");
    assert!(bins.meta.contains("reminder on the day"), "{}", bins.meta);
    assert!(
        !bins.meta.contains("09:00"),
        "never an invented moment: {}",
        bins.meta
    );
}

#[test]
fn each_list_view_says_its_own_empty_sentence() {
    let mut d = driver();
    clear_tasks(&d);
    for (view, sentence) in [
        (wire::TodoView::Anytime, "Nothing undated is open."),
        (wire::TodoView::All, "Nothing is open."),
        (wire::TodoView::Logbook, "Nothing is done yet."),
        (wire::TodoView::Reminders, "No open task has a reminder."),
    ] {
        let i = d.push(agenda::TAB, routes::todo_list(view));
        let data = list_data(d.view(i));
        assert_eq!(
            data.empty.as_ref().expect("an empty state").headline,
            sentence
        );
        assert!(data.groups.is_empty());
        assert_eq!(data.count_label, "0 tasks");
    }
}

#[test]
fn a_window_that_is_not_everything_says_so_and_widens_on_show_more() {
    let mut d = driver();
    clear_tasks(&d);
    for n in 0..105 {
        task(&d, &format!("Idea {n:03}"));
    }
    let i = d.push(agenda::TAB, routes::todo_list(wire::TodoView::All));
    let data = list_data(d.view(i));
    assert_eq!(data.window_label, "100 tasks · more not shown");
    assert!(data.can_show_more);
    send_list(&mut d, i, le::Kind::NextPage(le::NextPageRequested {}));
    let data = list_data(d.view(i));
    assert_eq!(data.window_label, "");
    assert!(!data.can_show_more);
    assert_eq!(data.count_label, "105 tasks");
}

#[test]
fn a_task_another_surface_adds_arrives_without_a_refresh() {
    let mut d = driver();
    clear_tasks(&d);
    let i = d.push(agenda::TAB, routes::todo_list(wire::TodoView::Anytime));
    assert!(list_data(d.view(i)).empty.is_some());
    task(&d, "Fresh idea");
    d.pump(Duration::from_millis(400));
    assert_eq!(rows(&list_data(d.view(i)).groups)[0].title, "Fresh idea");
}

#[test]
fn a_refused_check_says_the_cores_sentence_and_keeps_the_list() {
    let mut d = driver();
    clear_tasks(&d);
    let id = task(&d, "Doomed");
    let i = d.push(agenda::TAB, routes::todo_list(wire::TodoView::Anytime));
    // The task is trashed behind the screen's back; its row is still drawn.
    arrange(
        &d,
        act::agenda::DeleteTask {
            task_id: id.clone(),
        },
    );
    send_list(&mut d, i, checked(&id));
    let status = list(d.view(i)).status.clone().expect("a status line");
    assert!(status.refused);
    assert!(!status.sentence.is_empty());
    assert!(status.action_label.is_empty());
}

#[test]
fn a_row_opens_its_task_page() {
    let mut d = driver();
    clear_tasks(&d);
    let id = task(&d, "Open me");
    let i = d.push(agenda::TAB, routes::todo_list(wire::TodoView::Anytime));
    let row = rows(&list_data(d.view(i)).groups)[0].clone();
    assert_eq!(row.route, Some(routes::task(&id)));
    let page = d.push(agenda::TAB, row.route.unwrap());
    assert_eq!(detail(d.view(page)).task_id, id);
}

// -----------------------------------------------------------------------------
// agenda.project
// -----------------------------------------------------------------------------

#[test]
fn a_project_draws_its_unsectioned_work_then_every_section_each_with_add_task() {
    let mut d = driver();
    let garden = project(&d, "Garden");
    let beds = section(&d, &garden, "Beds");
    add(
        &d,
        act::agenda::AddTask {
            title: "Order seeds".into(),
            project_id: Field::Is(garden.clone()),
            ..Default::default()
        },
    );
    let i = d.push(agenda::TAB, routes::project(&garden, "Garden"));
    let state = project_state(d.view(i));
    assert_eq!(state.title, "Garden");
    let data = project_data(d.view(i));
    assert!(data.found);
    let titles: Vec<&str> = data.groups.iter().map(|g| g.title.as_str()).collect();
    assert_eq!(titles, ["No section", "Beds"]);
    let verbs: Vec<String> = data.groups.iter().map(|g| g.verb_key.clone()).collect();
    assert_eq!(verbs, ["add:".to_owned(), format!("add:{beds}")]);
    assert!(
        data.groups[1].rows.is_empty(),
        "an empty section is drawn too"
    );
    // Inside the project, a row does not name the project again.
    assert_eq!(data.groups[0].rows[0].meta, "");
    assert_eq!(data.add_section_label, "Add section");
    assert!(data.empty.is_none());
    assert_eq!(data.count_label, "1 task");
}

#[test]
fn a_project_with_nothing_filed_says_so() {
    let mut d = driver();
    let empty = project(&d, "Someday");
    let i = d.push(agenda::TAB, routes::project(&empty, "Someday"));
    let data = project_data(d.view(i));
    assert!(data.found);
    assert!(data.groups.is_empty());
    assert_eq!(
        data.empty.as_ref().unwrap().headline,
        "Nothing is filed here yet."
    );
}

#[test]
fn a_project_the_answer_does_not_name_is_gone() {
    let mut d = driver();
    let i = d.push(agenda::TAB, routes::project("no-such-project", "Ghost"));
    let state = project_state(d.view(i));
    assert_eq!(
        state.title, "Ghost",
        "the route's name stands until the answer names it"
    );
    let data = project_data(d.view(i));
    assert!(!data.found);
    assert_eq!(
        data.empty.as_ref().unwrap().headline,
        "This project is gone."
    );
    let bar = state.quick_add.as_ref().unwrap();
    assert!(
        !bar.shown && !bar.drawn,
        "nothing can be added to a project that is gone"
    );
    // And a quick add into it is nothing.
    send_project(
        &mut d,
        i,
        pe::Kind::QuickAddChanged(pe::QuickAddChanged {
            title: "Lost".into(),
        }),
    );
    send_project(
        &mut d,
        i,
        pe::Kind::QuickAddSubmitted(pe::QuickAddSubmitted {}),
    );
    assert!(project_state(d.view(i)).status.is_none());
}

#[test]
fn the_quick_add_lands_in_the_project_and_in_the_section_pointed_at() {
    let mut d = driver();
    let garden = project(&d, "Garden");
    let beds = section(&d, &garden, "Beds");
    let i = d.push(agenda::TAB, routes::project(&garden, "Garden"));
    let bar = project_state(d.view(i)).quick_add.clone().unwrap();
    assert_eq!(bar.lands_label, "Add to Garden");
    // A PUSHED PAGE HAS NO PLUS: its bar is always drawn.
    assert!(bar.drawn && bar.shown && bar.add_label.is_empty());

    // Point the quick add at Beds.
    send_project(
        &mut d,
        i,
        pe::Kind::GroupVerb(pe::GroupVerb {
            key: format!("add:{beds}"),
        }),
    );
    let state = project_state(d.view(i));
    assert_eq!(
        state.quick_add.as_ref().unwrap().lands_label,
        "Add to Garden · Beds"
    );
    send_project(
        &mut d,
        i,
        pe::Kind::QuickAddChanged(pe::QuickAddChanged {
            title: "  Tulips ".into(),
        }),
    );
    assert!(
        project_state(d.view(i))
            .quick_add
            .as_ref()
            .unwrap()
            .can_submit
    );
    send_project(
        &mut d,
        i,
        pe::Kind::QuickAddSubmitted(pe::QuickAddSubmitted {}),
    );

    let state = project_state(d.view(i));
    assert_eq!(
        state.status.as_ref().unwrap().sentence,
        "Added to Garden · Beds"
    );
    assert_eq!(
        state.quick_add.as_ref().unwrap().title,
        "",
        "a committed add clears the field"
    );
    let data = project_data(d.view(i));
    let beds_group = group_titled(&data.groups, "Beds");
    assert_eq!(beds_group.rows.len(), 1);
    assert_eq!(beds_group.rows[0].title, "Tulips");
    let stored = task_of(&d, &beds_group.rows[0].task_id);
    assert_eq!(stored.project_id.as_deref(), Some(garden.as_str()));
    assert_eq!(stored.section_id.as_deref(), Some(beds.as_str()));

    // Back to the unsectioned work: "add:".
    send_project(
        &mut d,
        i,
        pe::Kind::GroupVerb(pe::GroupVerb { key: "add:".into() }),
    );
    send_project(
        &mut d,
        i,
        pe::Kind::QuickAddChanged(pe::QuickAddChanged {
            title: "Water".into(),
        }),
    );
    send_project(
        &mut d,
        i,
        pe::Kind::QuickAddSubmitted(pe::QuickAddSubmitted {}),
    );
    let data = project_data(d.view(i));
    assert_eq!(
        group_titled(&data.groups, "No section").rows[0].title,
        "Water"
    );
}

#[test]
fn a_blank_quick_add_is_nothing() {
    let mut d = driver();
    let garden = project(&d, "Garden");
    let i = d.push(agenda::TAB, routes::project(&garden, "Garden"));
    send_project(
        &mut d,
        i,
        pe::Kind::QuickAddChanged(pe::QuickAddChanged {
            title: "   ".into(),
        }),
    );
    assert!(
        !project_state(d.view(i))
            .quick_add
            .as_ref()
            .unwrap()
            .can_submit
    );
    send_project(
        &mut d,
        i,
        pe::Kind::QuickAddSubmitted(pe::QuickAddSubmitted {}),
    );
    assert!(project_state(d.view(i)).status.is_none());
    assert!(project_data(d.view(i)).groups.is_empty());
}

#[test]
fn add_section_asks_for_a_name_and_creates_it_in_this_project() {
    let mut d = driver();
    let garden = project(&d, "Garden");
    let i = d.push(agenda::TAB, routes::project(&garden, "Garden"));
    send_project(&mut d, i, pe::Kind::AddSection(pe::AddSectionRequested {}));
    assert_eq!(
        project_state(d.view(i)).sheet,
        wire::todo_project_state::Sheet::AddSection as i32
    );
    send_project(
        &mut d,
        i,
        pe::Kind::SectionName(pe::SectionNameChanged { name: " ".into() }),
    );
    assert!(!project_state(d.view(i)).new_section_can_submit);
    send_project(
        &mut d,
        i,
        pe::Kind::SectionSubmitted(pe::SectionSubmitted {}),
    );
    assert_eq!(
        project_state(d.view(i)).sheet,
        wire::todo_project_state::Sheet::AddSection as i32,
        "a blank name is nothing"
    );
    send_project(
        &mut d,
        i,
        pe::Kind::SectionName(pe::SectionNameChanged {
            name: "Pots".into(),
        }),
    );
    assert!(project_state(d.view(i)).new_section_can_submit);
    send_project(
        &mut d,
        i,
        pe::Kind::SectionSubmitted(pe::SectionSubmitted {}),
    );
    let state = project_state(d.view(i));
    assert_eq!(state.sheet, wire::todo_project_state::Sheet::None as i32);
    assert_eq!(state.new_section_name, "");
    assert_eq!(state.status.as_ref().unwrap().sentence, "Section added");
    let data = project_data(d.view(i));
    let pots = group_titled(&data.groups, "Pots");
    assert_eq!(pots.verb_label, "Add task");
    assert!(pots.rows.is_empty());
}

#[test]
fn a_closed_sheet_forgets_its_words() {
    let mut d = driver();
    let garden = project(&d, "Garden");
    let i = d.push(agenda::TAB, routes::project(&garden, "Garden"));
    send_project(&mut d, i, pe::Kind::AddSection(pe::AddSectionRequested {}));
    send_project(
        &mut d,
        i,
        pe::Kind::SectionName(pe::SectionNameChanged {
            name: "Half".into(),
        }),
    );
    send_project(&mut d, i, pe::Kind::SheetClosed(pe::SheetClosed {}));
    let state = project_state(d.view(i));
    assert_eq!(
        (state.sheet, state.new_section_name.as_str()),
        (wire::todo_project_state::Sheet::None as i32, "")
    );
}

#[test]
fn rename_opens_on_the_name_and_retitles_the_project() {
    let mut d = driver();
    let garden = project(&d, "Garden");
    let i = d.push(agenda::TAB, routes::project(&garden, "Garden"));
    let data = project_data(d.view(i));
    assert_eq!(
        (data.rename_label.as_str(), data.rename_title.as_str()),
        ("Rename", "Rename project")
    );
    send_project(&mut d, i, pe::Kind::Rename(pe::RenameRequested {}));
    let state = project_state(d.view(i));
    assert_eq!(state.sheet, wire::todo_project_state::Sheet::Rename as i32);
    assert_eq!(state.rename_name, "Garden");
    assert!(!state.rename_can_submit, "the same name is nothing to save");
    send_project(
        &mut d,
        i,
        pe::Kind::RenameName(pe::RenameNameChanged {
            name: " Allotment ".into(),
        }),
    );
    assert!(project_state(d.view(i)).rename_can_submit);
    send_project(&mut d, i, pe::Kind::RenameSubmitted(pe::RenameSubmitted {}));
    let state = project_state(d.view(i));
    assert_eq!(state.title, "Allotment");
    assert_eq!(state.status.as_ref().unwrap().sentence, "Project renamed");
    assert_eq!(state.sheet, wire::todo_project_state::Sheet::None as i32);
}

#[test]
fn checking_a_project_row_completes_it_and_undo_brings_it_back() {
    let mut d = driver();
    let garden = project(&d, "Garden");
    let id = add(
        &d,
        act::agenda::AddTask {
            title: "Order seeds".into(),
            project_id: Field::Is(garden.clone()),
            ..Default::default()
        },
    );
    let i = d.push(agenda::TAB, routes::project(&garden, "Garden"));
    send_project(
        &mut d,
        i,
        pe::Kind::RowChecked(pe::RowChecked {
            task_id: id.clone(),
        }),
    );
    assert_eq!(
        project_state(d.view(i)).status.as_ref().unwrap().sentence,
        "Task done"
    );
    assert!(rows(&project_data(d.view(i)).groups).is_empty());
    send_project(&mut d, i, pe::Kind::StatusActed(pe::StatusActed {}));
    assert_eq!(rows(&project_data(d.view(i)).groups)[0].task_id, id);
}

#[test]
fn a_projects_rows_follow_changes_made_elsewhere() {
    let mut d = driver();
    let garden = project(&d, "Garden");
    let i = d.push(agenda::TAB, routes::project(&garden, "Garden"));
    arrange(
        &d,
        act::agenda::RenameList {
            list_id: garden.clone(),
            title: "Orchard".into(),
        },
    );
    d.pump(Duration::from_millis(400));
    assert_eq!(project_state(d.view(i)).title, "Orchard");
}

// -----------------------------------------------------------------------------
// agenda.catch_up
// -----------------------------------------------------------------------------

fn overdue(d: &centraid_screens::testing::Driver, title: &str, days_ago: i64) -> String {
    add(
        d,
        act::agenda::AddTask {
            title: title.into(),
            due: due(&day(d, -days_ago)),
            ..Default::default()
        },
    )
}

#[test]
fn catch_up_piles_what_came_due_and_names_the_absence() {
    let mut d = driver();
    clear_tasks(&d);
    let invoice = overdue(&d, "Invoice", 14);
    let call = overdue(&d, "Call", 5);
    // Repeating and behind, and repeating and on time.
    add(
        &d,
        act::agenda::AddTask {
            title: "Water".into(),
            due: due(&day(&d, -3)),
            rule: Field::Is("FREQ=DAILY".into()),
            ..Default::default()
        },
    );
    add(
        &d,
        act::agenda::AddTask {
            title: "Rent".into(),
            due: due(&day(&d, 4)),
            rule: Field::Is("FREQ=MONTHLY".into()),
            ..Default::default()
        },
    );
    let i = d.push(agenda::TAB, routes::catch_up());
    let state = catch_up(d.view(i));
    assert_eq!(state.chrome.as_ref().unwrap().title, "Reschedule");
    let data = catch_up_data(d.view(i));
    assert_eq!(data.head, "14 days away · 2 tasks came due");
    let keys: Vec<&str> = data.piles.iter().map(|p| p.key.as_str()).collect();
    assert_eq!(keys, ["dated", "repeating"]);
    assert_eq!(data.piles[0].title, "Came due");
    assert_eq!(data.piles[0].verb_label, "Complete all");
    let dated: Vec<&str> = data.piles[0]
        .rows
        .iter()
        .map(|r| r.task_id.as_str())
        .collect();
    assert!(dated.contains(&invoice.as_str()) && dated.contains(&call.as_str()));
    // The repeating pile keeps only what is behind.
    let repeating: Vec<&str> = data.piles[1]
        .rows
        .iter()
        .map(|r| r.title.as_str())
        .collect();
    assert_eq!(repeating, ["Water"]);
    assert!(data.empty.is_none());
}

#[test]
fn complete_all_asks_then_completes_the_pile_and_says_its_count() {
    let mut d = driver();
    clear_tasks(&d);
    let first = overdue(&d, "Invoice", 14);
    let second = overdue(&d, "Call", 5);
    let water = add(
        &d,
        act::agenda::AddTask {
            title: "Water".into(),
            due: due(&day(&d, -3)),
            rule: Field::Is("FREQ=DAILY".into()),
            ..Default::default()
        },
    );
    let i = d.push(agenda::TAB, routes::catch_up());
    send_catch_up(
        &mut d,
        i,
        cu::Kind::CompleteAll(cu::CompleteAllTapped {
            pile: "dated".into(),
        }),
    );
    let state = catch_up(d.view(i));
    let confirm = state.confirm.as_ref().expect("a confirm");
    assert_eq!(confirm.title, "Complete every task in this pile?");
    assert_eq!(confirm.confirm_label, "Complete all");
    assert!(!confirm.destructive);
    // Nothing is written until it is confirmed.
    assert_eq!(task_of(&d, &first).status, "open");

    // Dismissed, it asks nothing more.
    send_catch_up(&mut d, i, cu::Kind::Dismissed(cu::Dismissed {}));
    assert!(catch_up(d.view(i)).confirm.is_none());
    send_catch_up(
        &mut d,
        i,
        cu::Kind::CompleteAll(cu::CompleteAllTapped {
            pile: "dated".into(),
        }),
    );
    send_catch_up(&mut d, i, cu::Kind::Confirmed(cu::Confirmed {}));

    assert_eq!(task_of(&d, &first).status, "done");
    assert_eq!(task_of(&d, &second).status, "done");
    let state = catch_up(d.view(i));
    assert!(state.confirm.is_none());
    let status = state.status.as_ref().unwrap();
    assert_eq!(
        (status.sentence.as_str(), status.action_label.as_str()),
        ("2 tasks done", "")
    );
    let keys: Vec<&str> = catch_up_data(d.view(i))
        .piles
        .iter()
        .map(|p| p.key.as_str())
        .collect();
    assert_eq!(keys, ["repeating"]);
    assert_eq!(task_of(&d, &water).status, "open");

    // A bulk verb offers no Undo: the status line's tap is nothing.
    send_catch_up(&mut d, i, cu::Kind::StatusActed(cu::StatusActed {}));
    assert_eq!(task_of(&d, &first).status, "done");
}

#[test]
fn complete_all_of_one_task_says_task_done() {
    let mut d = driver();
    clear_tasks(&d);
    overdue(&d, "Invoice", 9);
    let i = d.push(agenda::TAB, routes::catch_up());
    send_catch_up(
        &mut d,
        i,
        cu::Kind::CompleteAll(cu::CompleteAllTapped {
            pile: "dated".into(),
        }),
    );
    send_catch_up(&mut d, i, cu::Kind::Confirmed(cu::Confirmed {}));
    assert_eq!(
        catch_up(d.view(i)).status.as_ref().unwrap().sentence,
        "1 task done"
    );
}

#[test]
fn a_pile_that_is_not_there_asks_nothing() {
    let mut d = driver();
    clear_tasks(&d);
    let i = d.push(agenda::TAB, routes::catch_up());
    send_catch_up(
        &mut d,
        i,
        cu::Kind::CompleteAll(cu::CompleteAllTapped {
            pile: "dated".into(),
        }),
    );
    assert!(catch_up(d.view(i)).confirm.is_none());
    send_catch_up(&mut d, i, cu::Kind::Confirmed(cu::Confirmed {}));
    assert!(catch_up(d.view(i)).status.is_none());
}

#[test]
fn nothing_overdue_says_so_and_names_no_absence() {
    let mut d = driver();
    clear_tasks(&d);
    task(&d, "Undated");
    let i = d.push(agenda::TAB, routes::catch_up());
    let data = catch_up_data(d.view(i));
    assert_eq!(data.empty.as_ref().unwrap().headline, "Nothing is overdue.");
    assert_eq!(data.head, "");
    assert!(data.piles.is_empty());
}

#[test]
fn a_catch_up_row_checks_off_with_undo_and_opens_its_task() {
    let mut d = driver();
    clear_tasks(&d);
    let id = overdue(&d, "Invoice", 2);
    let i = d.push(agenda::TAB, routes::catch_up());
    let row = catch_up_data(d.view(i)).piles[0].rows[0].clone();
    assert_eq!(row.route, Some(routes::task(&id)));
    send_catch_up(
        &mut d,
        i,
        cu::Kind::RowChecked(cu::RowChecked {
            task_id: id.clone(),
        }),
    );
    let status = catch_up(d.view(i)).status.clone().unwrap();
    assert_eq!(
        (status.sentence.as_str(), status.action_label.as_str()),
        ("Task done", "Undo")
    );
    assert!(catch_up_data(d.view(i)).piles.is_empty());
    send_catch_up(&mut d, i, cu::Kind::StatusActed(cu::StatusActed {}));
    assert_eq!(task_of(&d, &id).status, "open");
    assert_eq!(catch_up_data(d.view(i)).piles[0].rows[0].task_id, id);
}

#[test]
fn the_board_view_of_the_project_page_is_the_projects_own() {
    // The page asks for ONE project's board: a task filed elsewhere is not on it.
    let mut d = driver();
    let garden = project(&d, "Garden");
    let other = project(&d, "House");
    add(
        &d,
        act::agenda::AddTask {
            title: "Mop".into(),
            project_id: Field::Is(other),
            ..Default::default()
        },
    );
    let i = d.push(agenda::TAB, routes::project(&garden, "Garden"));
    assert!(rows(&project_data(d.view(i)).groups).is_empty());
    let board = load_board(&d, load::agenda::BoardView::Project, Some(&garden));
    assert!(board.groups.iter().all(|g| g.tasks.is_empty()));
}
