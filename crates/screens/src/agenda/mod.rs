//! THE SCREENS OF CALENDAR AND REMINDERS (#1135, split in round 10 of #1173): two apps that were one
//! "Agenda". Every decision a person sees is made here; SwiftUI and Compose draw [`wire::ViewState`].
//! The module keeps its old name because both apps share one home machine ([`home`]), built once for
//! each app ([`home::App`]); the screen ids, the vault apps and the manifests are two.
//!
//! | Screen | Route name | Machine |
//! |---|---|---|
//! | Calendar: Day · Week · Month · List · Year · Invites, with Search and Calendars | [`HOME`] | [`home`] |
//! | One occurrence of an event | [`EVENT`] | [`event`] |
//! | The add sheet and the event editor | [`EDITOR`] | [`editor`] |
//! | Reminders: the smart lists, My Lists, with Search and More | [`REMINDERS_HOME`] | [`home`] |
//! | Anytime · All · Logbook · Reminders | [`TODO_LIST`] | [`list`] |
//! | One project | [`PROJECT`] | [`project`] |
//! | One task | [`TASK`] | [`detail`] |
//! | Catch up | [`CATCH_UP`] | [`catch_up`] |
//! | The trash | [`TRASH`] | [`trash`] |
//! | Reminders and alerts, as notifications (a service, no view) | [`notify::NAME`] | [`notify`] |
//!
//! A row that opens a page carries the [`wire::Route`] to push (built by
//! [`routes`]), so a shell never names a screen.
//!
//! ## Where this lives
//!
//! Not in `crates/apps/calendar` or `crates/apps/reminders`: `centraid-core` depends on those crates
//! for their readers, and this crate depends on the core for `load` and `act`, so a screen there
//! would make a cycle. Everything of the two apps still has one home: this module.

use centraid_api_proto::core_v1 as wire;

use crate::Registry;

mod attachments;
pub mod calendar;
pub mod calendar_push;
pub mod catch_up;
pub mod detail;
pub mod editor;
pub mod event;
pub mod glance;
pub mod home;
pub mod list;
pub mod notify;
pub mod project;
pub mod rule_words;
mod style;
pub mod todo;
pub mod trash;

pub use crate::calendar::{EDITOR, EVENT, HOME};
pub use crate::reminders::{CATCH_UP, HOME as REMINDERS_HOME, PROJECT, TASK, TODO_LIST, TRASH};

/// Every Calendar and Reminders screen, registered under its route name.
#[must_use]
pub fn registry() -> Registry {
    crate::calendar::registry()
        .merge(crate::reminders::registry())
        .with(notify::NAME, notify::build)
}

/// A runtime with the two apps' screens and one tab, `calendar`, rooted at Calendar's home.
/// The shell's real runtime composes [`registry`] with the other apps'; this is
/// what these apps' own tests drive.
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

/// The tab Calendar's home is the root of.
pub const TAB: &str = "calendar";
/// The tab Reminders' home is the root of.
pub const REMINDERS_TAB: &str = "reminders";

/// The routes Agenda's own screens hand to a shell inside a view state.
pub mod routes {
    use super::{
        CATCH_UP, EDITOR, EVENT, HOME, PROJECT, REMINDERS_HOME, TASK, TODO_LIST, TRASH, wire,
    };

    fn route(screen: &str, args: wire::route::Args) -> wire::Route {
        wire::Route {
            sheet: false,
            screen: screen.to_owned(),
            args: Some(args),
        }
    }

    /// A home, landing on `destination` at today: Calendar's for a calendar place, Reminders' for
    /// To-do.
    #[must_use]
    pub fn home(destination: wire::AgendaDestination, quick_add_title: &str) -> wire::Route {
        route(
            if destination == wire::AgendaDestination::Todo || !quick_add_title.is_empty() {
                REMINDERS_HOME
            } else {
                HOME
            },
            wire::route::Args::AgendaHome(wire::AgendaHomeRoute {
                destination: destination as i32,
                quick_add_title: quick_add_title.to_owned(),
                open_quick_add: false,
            }),
        )
    }

    /// Reminders with its quick-add bar open, drawn and focused, and holding `title`
    /// (which may be empty). Nothing is written until the member taps Add.
    #[must_use]
    pub fn home_adding(title: &str) -> wire::Route {
        route(
            REMINDERS_HOME,
            wire::route::Args::AgendaHome(wire::AgendaHomeRoute {
                destination: wire::AgendaDestination::Todo as i32,
                quick_add_title: title.to_owned(),
                open_quick_add: true,
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
                start_time: String::new(),
            }),
        )
    }

    /// The add sheet for a new EVENT on `day` starting at `start_time` (`HH:MM`):
    /// the slot a long press on the hour grid named, already snapped.
    #[must_use]
    pub fn editor_at(day: &str, start_time: &str) -> wire::Route {
        route(
            EDITOR,
            wire::route::Args::AgendaEditor(wire::AgendaEditorRoute {
                day: day.to_owned(),
                kind: wire::AgendaEditorKind::Event as i32,
                start_time: start_time.to_owned(),
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
