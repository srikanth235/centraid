//! The routes of both apps under one name, for the tests that drive a Calendar day and a Reminders
//! page side by side. The screens themselves never see this: each app's own `routes` module is the
//! one they use.
#![allow(dead_code, unused_imports)]

use centraid_api_proto::core_v1 as wire;
use centraid_screens::{calendar::routes as calendar, reminders::routes as reminders};

pub use calendar::{editor_at, event};
pub use reminders::{catch_up, home_adding, project, task, todo_list, trash};

/// A home, landing on `destination`: Reminders' for To-do (or a seeded quick add, which is Notes'
/// "Send to Reminders" door), Calendar's for every other place.
pub fn home(destination: wire::AgendaDestination, quick_add_title: &str) -> wire::Route {
    if destination == wire::AgendaDestination::Todo || !quick_add_title.is_empty() {
        wire::Route {
            sheet: false,
            screen: centraid_screens::reminders::HOME.to_owned(),
            args: Some(wire::route::Args::AgendaHome(wire::AgendaHomeRoute {
                destination: destination as i32,
                quick_add_title: quick_add_title.to_owned(),
                open_quick_add: false,
            })),
        }
    } else {
        calendar::home(destination)
    }
}

/// The add sheet of an event, or of a reminder when `kind` says so.
pub fn editor(
    event_id: &str,
    instance_key: &str,
    original_start_local: Option<&str>,
    day: &str,
    kind: wire::AgendaEditorKind,
) -> wire::Route {
    if kind == wire::AgendaEditorKind::Task {
        reminders::editor(day)
    } else {
        calendar::editor(event_id, instance_key, original_start_local, day)
    }
}
