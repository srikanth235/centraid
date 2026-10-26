//! Support for the to-do pages' tests: arranging the vault through the typed
//! catalogue and reading the answers the pages are drawn from. Every test goes
//! through `Driver`, the door a shell uses.
#![allow(dead_code)]

use centraid_api_proto::core_v1 as wire;
use centraid_screens::agenda;
use centraid_screens::catalog::{act, load};
use centraid_screens::field::{Field, Keyed};
use centraid_screens::kit::act as kit_act;
use centraid_screens::kit::civil;
use centraid_screens::testing::Driver;
use wire::app_query_response::Answer;

pub fn driver() -> Driver {
    let mut driver = Driver::with_runtime(agenda::runtime());
    driver.start();
    driver
}

/// Write as another surface, and insist it committed.
pub fn arrange(d: &Driver, request: impl Into<wire::ActRequest>) -> wire::ActResponse {
    let response = d.act(
        request
            .into()
            .keyed(format!("arrange:{}", kit_act::fresh())),
    );
    assert_eq!(
        response.status,
        wire::ActStatus::Executed as i32,
        "arranging was refused: {}",
        response.reason
    );
    response
}

pub fn id_of(response: &wire::ActResponse) -> String {
    let value: serde_json::Value =
        serde_json::from_slice(&response.output).expect("the output is JSON");
    value["id"]
        .as_str()
        .expect("the output names an id")
        .to_owned()
}

pub fn add(d: &Driver, task: act::agenda::AddTask) -> String {
    id_of(&arrange(d, task))
}

pub fn task(d: &Driver, title: &str) -> String {
    add(
        d,
        act::agenda::AddTask {
            title: title.to_owned(),
            ..Default::default()
        },
    )
}

pub fn load_board(
    d: &Driver,
    view: load::agenda::BoardView,
    project: Option<&str>,
) -> wire::AgendaTaskBoard {
    let request = load::agenda::Board {
        limit: 500,
        project_id: project.map(str::to_owned),
        view: Some(view),
    };
    match answer(d, request) {
        Answer::AgendaTaskBoard(board) => board,
        other => panic!("a board answered {other:?}"),
    }
}

pub fn answer(d: &Driver, request: impl Into<wire::LoadRequest>) -> Answer {
    let mut request = request.into();
    request.zone = "UTC".to_owned();
    let answered = d
        .handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Load(Box::new(request))),
        })
        .expect("the load door answers");
    let Some(wire::response::Kind::Load(loaded)) = answered.kind else {
        panic!("a load answered {:?}", answered.kind);
    };
    loaded.answer.and_then(|a| a.answer).expect("an answer")
}

pub fn task_of(d: &Driver, id: &str) -> wire::AgendaTask {
    match answer(
        d,
        load::agenda::Task {
            task_id: id.to_owned(),
        },
    ) {
        Answer::AgendaTask(detail) => detail.task.expect("the task is live"),
        other => panic!("a task answered {other:?}"),
    }
}

/// The core's today, from the board it answers.
pub fn today(d: &Driver) -> String {
    load_board(d, load::agenda::BoardView::Anytime, None).today
}

pub fn day(d: &Driver, offset: i64) -> String {
    civil::plus_days(&today(d), offset).expect("a day")
}

/// Delete every task, so a test's own tasks are the only ones.
pub fn clear_tasks(d: &Driver) {
    for view in [
        load::agenda::BoardView::All,
        load::agenda::BoardView::Logbook,
    ] {
        let board = load_board(d, view, None);
        for group in &board.groups {
            for task in &group.tasks {
                arrange(
                    d,
                    act::agenda::DeleteTask {
                        task_id: task.task_id.clone(),
                    },
                );
            }
        }
    }
    let left = load_board(d, load::agenda::BoardView::All, None);
    assert!(
        left.groups.iter().all(|g| g.tasks.is_empty()),
        "the vault still has tasks"
    );
}

pub fn complete(d: &Driver, id: &str) {
    arrange(
        d,
        act::agenda::CompleteTask {
            task_id: id.to_owned(),
        },
    );
}

pub fn cancel(d: &Driver, id: &str) {
    arrange(
        d,
        act::agenda::CancelTask {
            task_id: id.to_owned(),
        },
    );
}

pub fn project(d: &Driver, title: &str) -> String {
    id_of(&arrange(
        d,
        act::agenda::CreateProject {
            title: title.to_owned(),
            ..Default::default()
        },
    ))
}

pub fn section(d: &Driver, project: &str, title: &str) -> String {
    id_of(&arrange(
        d,
        act::agenda::CreateSection {
            parent: project.to_owned(),
            title: title.to_owned(),
            ..Default::default()
        },
    ))
}

pub fn due(day: &str) -> Field<String> {
    Field::Is(day.to_owned())
}

// --- views -------------------------------------------------------------------

pub fn list(v: &wire::ViewState) -> &wire::TodoListState {
    match &v.kind {
        Some(wire::view_state::Kind::TodoList(s)) => s,
        other => panic!("not a list: {other:?}"),
    }
}

pub fn list_data(v: &wire::ViewState) -> &wire::TodoListData {
    match &list(v).content {
        Some(wire::todo_list_state::Content::Data(data)) => data,
        other => panic!("the list has no data: {other:?}"),
    }
}

pub fn project_state(v: &wire::ViewState) -> &wire::TodoProjectState {
    match &v.kind {
        Some(wire::view_state::Kind::TodoProject(s)) => s,
        other => panic!("not a project: {other:?}"),
    }
}

pub fn project_data(v: &wire::ViewState) -> &wire::TodoProjectData {
    match &project_state(v).content {
        Some(wire::todo_project_state::Content::Data(data)) => data,
        other => panic!("the project has no data: {other:?}"),
    }
}

pub fn detail(v: &wire::ViewState) -> &wire::TodoDetailState {
    match &v.kind {
        Some(wire::view_state::Kind::TodoDetail(s)) => s,
        other => panic!("not a task: {other:?}"),
    }
}

pub fn detail_data(v: &wire::ViewState) -> &wire::TodoDetailData {
    match &detail(v).content {
        Some(wire::todo_detail_state::Content::Data(data)) => data,
        other => panic!("the task has no data: {other:?}"),
    }
}

pub fn catch_up(v: &wire::ViewState) -> &wire::TodoCatchUpState {
    match &v.kind {
        Some(wire::view_state::Kind::TodoCatchUp(s)) => s,
        other => panic!("not catch up: {other:?}"),
    }
}

pub fn catch_up_data(v: &wire::ViewState) -> &wire::TodoCatchUpData {
    match &catch_up(v).content {
        Some(wire::todo_catch_up_state::Content::Data(data)) => data,
        other => panic!("catch up has no data: {other:?}"),
    }
}

pub fn trash(v: &wire::ViewState) -> &wire::TrashView {
    match &v.kind {
        Some(wire::view_state::Kind::Trash(s)) => s,
        other => panic!("not a trash: {other:?}"),
    }
}

pub fn trash_data(v: &wire::ViewState) -> &wire::TrashData {
    match &trash(v).content {
        Some(wire::trash_view::Content::Data(data)) => data,
        other => panic!("the trash has no data: {other:?}"),
    }
}

/// Every row of a list, roots in order.
pub fn rows(groups: &[wire::TodoRowGroup]) -> Vec<&wire::TodoRow> {
    groups.iter().flat_map(|g| g.rows.iter()).collect()
}

pub fn row_titled<'a>(groups: &'a [wire::TodoRowGroup], title: &str) -> &'a wire::TodoRow {
    rows(groups)
        .into_iter()
        .find(|row| row.title == title)
        .unwrap_or_else(|| panic!("no row titled `{title}`"))
}

pub fn group_titled<'a>(groups: &'a [wire::TodoRowGroup], title: &str) -> &'a wire::TodoRowGroup {
    groups
        .iter()
        .find(|g| g.title == title)
        .unwrap_or_else(|| panic!("no group titled `{title}`"))
}

// --- events ------------------------------------------------------------------

pub fn send_list(d: &mut Driver, i: u64, kind: wire::todo_list_event::Kind) {
    d.send(
        i,
        wire::screen_event::Kind::TodoList(wire::TodoListEvent { kind: Some(kind) }),
    );
}

pub fn send_project(d: &mut Driver, i: u64, kind: wire::todo_project_event::Kind) {
    d.send(
        i,
        wire::screen_event::Kind::TodoProject(wire::TodoProjectEvent { kind: Some(kind) }),
    );
}

pub fn send_detail(d: &mut Driver, i: u64, kind: wire::todo_detail_event::Kind) {
    d.send(
        i,
        wire::screen_event::Kind::TodoDetail(wire::TodoDetailEvent { kind: Some(kind) }),
    );
}

pub fn send_catch_up(d: &mut Driver, i: u64, kind: wire::todo_catch_up_event::Kind) {
    d.send(
        i,
        wire::screen_event::Kind::TodoCatchUp(wire::TodoCatchUpEvent { kind: Some(kind) }),
    );
}

pub fn send_trash(d: &mut Driver, i: u64, kind: wire::trash_event::Kind) {
    d.send(
        i,
        wire::screen_event::Kind::Trash(wire::TrashEvent { kind: Some(kind) }),
    );
}

pub fn choose(d: &mut Driver, i: u64, field: &str, key: &str) {
    send_detail(
        d,
        i,
        wire::todo_detail_event::Kind::FieldChoice(wire::todo_detail_event::FieldChoice {
            field: field.to_owned(),
            key: key.to_owned(),
        }),
    );
}
