//! CALENDAR'S SCREENS (#1135, split from Agenda in round 10 of #1173): the ids it registers and the
//! routes that open them. Calendar owns events and invites: Day, Week, Month, List, Year and Invites
//! on its [`HOME`], one occurrence ([`EVENT`]) and the add sheet and event editor ([`EDITOR`]).
//!
//! The machines behind them are in `crate::agenda`, the module the two apps share because the home,
//! the attachments page, the style sheet, the repeat words and the notification and widget services
//! are built once for both. This module names none of Reminders': a reminder on a Calendar day carries
//! the route Reminders registered for it, as data.

use crate::Registry;
use crate::agenda::{editor, event, home};

/// Calendar's home.
pub const HOME: &str = "calendar.home";
/// One occurrence of an event.
pub const EVENT: &str = "calendar.event";
/// The add sheet and the event editor.
pub const EDITOR: &str = "calendar.editor";

/// Calendar's screens, registered under their route names.
#[must_use]
pub fn registry() -> Registry {
    Registry::default()
        .with(HOME, home::build_calendar)
        .with(EVENT, event::build)
        .with(EDITOR, editor::build)
}
