//! THE ROUTES CALENDAR'S SCREENS HAND A SHELL inside a view state: a row that opens a page carries the
//! [`wire::Route`] to push, so a shell never names a screen.

use super::{EDITOR, EVENT, HOME};
use centraid_api_proto::core_v1 as wire;

fn route(screen: &str, args: wire::route::Args) -> wire::Route {
    wire::Route {
        sheet: false,
        screen: screen.to_owned(),
        args: Some(args),
    }
}

/// Calendar's home, landing on `destination` at today.
#[must_use]
pub fn home(destination: wire::AgendaDestination) -> wire::Route {
    route(
        HOME,
        wire::route::Args::AgendaHome(wire::AgendaHomeRoute {
            destination: destination as i32,
            quick_add_title: String::new(),
            open_quick_add: false,
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
) -> wire::Route {
    route(
        EDITOR,
        wire::route::Args::AgendaEditor(wire::AgendaEditorRoute {
            event_id: event_id.to_owned(),
            instance_key: instance_key.to_owned(),
            original_start_local: original_start_local.map(str::to_owned),
            day: day.to_owned(),
            kind: wire::AgendaEditorKind::Event as i32,
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
