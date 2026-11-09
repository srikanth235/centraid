//! THE ROUTES REMINDERS' SCREENS HAND A SHELL inside a view state: a row that opens a page carries the
//! [`wire::Route`] to push, so a shell never names a screen.

use super::{CATCH_UP, EDITOR, HOME, PROJECT, TODO_LIST, TRASH};
use centraid_api_proto::core_v1 as wire;

pub use crate::kit::schedule::routes::task;

fn route(screen: &str, args: wire::route::Args) -> wire::Route {
    wire::Route {
        sheet: false,
        screen: screen.to_owned(),
        args: Some(args),
    }
}

/// Reminders' home: the smart lists and My Lists.
#[must_use]
pub fn home() -> wire::Route {
    route(
        HOME,
        wire::route::Args::AgendaHome(wire::AgendaHomeRoute {
            destination: wire::AgendaDestination::Todo as i32,
            quick_add_title: String::new(),
            open_quick_add: false,
        }),
    )
}

/// Reminders with its quick-add bar open, drawn and focused, and holding `title`
/// (which may be empty). Nothing is written until the member taps Add.
#[must_use]
pub fn home_adding(title: &str) -> wire::Route {
    route(
        HOME,
        wire::route::Args::AgendaHome(wire::AgendaHomeRoute {
            destination: wire::AgendaDestination::Todo as i32,
            quick_add_title: title.to_owned(),
            open_quick_add: true,
        }),
    )
}

/// The new-reminder sheet, its due day starting on `day`.
#[must_use]
pub fn editor(day: &str) -> wire::Route {
    route(
        EDITOR,
        wire::route::Args::AgendaEditor(wire::AgendaEditorRoute {
            day: day.to_owned(),
            kind: wire::AgendaEditorKind::Task as i32,
            ..wire::AgendaEditorRoute::default()
        }),
    )
}

/// The Anytime, All, Logbook or Reminders page.
#[must_use]
pub fn todo_list(view: wire::TodoView) -> wire::Route {
    route(
        TODO_LIST,
        wire::route::Args::TodoList(wire::TodoListRoute { view: view as i32 }),
    )
}

/// One project; `name` rides along so the head has words before the read lands.
#[must_use]
pub fn project(project_id: &str, name: &str) -> wire::Route {
    route(
        PROJECT,
        wire::route::Args::TodoProject(wire::TodoProjectRoute {
            project_id: project_id.to_owned(),
            name: name.to_owned(),
        }),
    )
}

#[must_use]
pub fn catch_up() -> wire::Route {
    route(
        CATCH_UP,
        wire::route::Args::TodoCatchUp(wire::TodoCatchUpRoute {}),
    )
}

#[must_use]
pub fn trash() -> wire::Route {
    route(TRASH, wire::route::Args::Trash(wire::TrashRoute {}))
}
