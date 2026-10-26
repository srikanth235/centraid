//! AGENDA'S SCREENS (#1135): events and to-dos in one app. Every decision a
//! person sees is made here; SwiftUI and Compose draw [`wire::ViewState`].
//!
//! | Screen | Route name | Machine |
//! |---|---|---|
//! | Day · Schedule · Waiting · To-do, with Search and More | [`HOME`] | [`home`] |
//! | One occurrence of an event | [`EVENT`] | [`event`] |
//! | The add sheet (Event \| Task) and the event editor | [`EDITOR`] | [`editor`] |
//! | Anytime · All · Logbook · Reminders | [`TODO_LIST`] | [`list`] |
//! | One project | [`PROJECT`] | [`project`] |
//! | One task | [`TASK`] | [`detail`] |
//! | Catch up | [`CATCH_UP`] | [`catch_up`] |
//! | The trash | [`TRASH`] | [`trash`] |
//!
//! A row that opens a page carries the [`wire::Route`] to push (built by
//! [`routes`]), so a shell never names a screen.
//!
//! ## Where this lives
//!
//! Not in `crates/apps/agenda`: `centraid-core` depends on that crate for its
//! readers, and this crate depends on the core for `load` and `act`, so a
//! screen there would make a cycle. Everything Agenda-specific still has one
//! home: this module.

use centraid_api_proto::core_v1 as wire;

use crate::Registry;

pub mod calendar;
pub mod catch_up;
pub mod detail;
pub mod editor;
pub mod event;
pub mod home;
pub mod list;
pub mod project;
pub mod todo;
pub mod trash;

pub const HOME: &str = "agenda.home";
pub const EVENT: &str = "agenda.event";
pub const EDITOR: &str = "agenda.editor";
pub const TODO_LIST: &str = "agenda.todo_list";
pub const PROJECT: &str = "agenda.project";
pub const TASK: &str = "agenda.task";
pub const CATCH_UP: &str = "agenda.catch_up";
pub const TRASH: &str = "agenda.trash";

/// Every Agenda screen, registered under its route name.
#[must_use]
pub fn registry() -> Registry {
    Registry::default()
        .with(HOME, home::build)
        .with(EVENT, event::build)
        .with(EDITOR, editor::build)
        .with(TODO_LIST, list::build)
        .with(PROJECT, project::build)
        .with(TASK, detail::build)
        .with(CATCH_UP, catch_up::build)
        .with(TRASH, trash::build)
}

/// A runtime with Agenda's screens and one tab, `agenda`, rooted at its home.
/// The shell's real runtime composes [`registry`] with the other apps'; this is
/// what Agenda's own tests drive.
#[must_use]
pub fn runtime() -> crate::Runtime {
    crate::Runtime::new(
        registry(),
        vec![(
            TAB.to_owned(),
            routes::home(wire::AgendaDestination::Day, ""),
        )],
    )
}

/// The tab Agenda's home is the root of.
pub const TAB: &str = "agenda";

/// The routes Agenda's own screens hand to a shell inside a view state.
pub mod routes {
    use super::{CATCH_UP, EDITOR, EVENT, HOME, PROJECT, TASK, TODO_LIST, TRASH, wire};

    fn route(screen: &str, args: wire::route::Args) -> wire::Route {
        wire::Route {
            screen: screen.to_owned(),
            args: Some(args),
        }
    }

    /// Agenda's home, landing on `destination` at today.
    #[must_use]
    pub fn home(destination: wire::AgendaDestination, quick_add_title: &str) -> wire::Route {
        route(
            HOME,
            wire::route::Args::AgendaHome(wire::AgendaHomeRoute {
                destination: destination as i32,
                quick_add_title: quick_add_title.to_owned(),
            }),
        )
    }

    /// One occurrence of an event, drawn under `day`.
    #[must_use]
    pub fn event(
        event_id: &str,
        instance_key: &str,
        original_start_local: Option<&str>,
        day: &str,
    ) -> wire::Route {
        route(
            EVENT,
            wire::route::Args::AgendaEvent(wire::AgendaEventRoute {
                event_id: event_id.to_owned(),
                instance_key: instance_key.to_owned(),
                original_start_local: original_start_local.map(str::to_owned),
                day: day.to_owned(),
            }),
        )
    }

    /// The add sheet on `day` (an empty `event_id`), or the editor of an occurrence.
    #[must_use]
    pub fn editor(
        event_id: &str,
        instance_key: &str,
        original_start_local: Option<&str>,
        day: &str,
        kind: wire::AgendaEditorKind,
    ) -> wire::Route {
        route(
            EDITOR,
            wire::route::Args::AgendaEditor(wire::AgendaEditorRoute {
                event_id: event_id.to_owned(),
                instance_key: instance_key.to_owned(),
                original_start_local: original_start_local.map(str::to_owned),
                day: day.to_owned(),
                kind: kind as i32,
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

    /// One task. A task with no id names nothing, so callers do not push it.
    #[must_use]
    pub fn task(task_id: &str) -> wire::Route {
        route(
            TASK,
            wire::route::Args::TodoDetail(wire::TodoDetailRoute {
                task_id: task_id.to_owned(),
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
}
