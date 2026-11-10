//! CALENDAR'S SCREENS (#1135, split from Agenda in round 10 of #1173): the ids it registers and the
//! routes that open them. Calendar owns events and invites: Day, Week, Month, List, Year and Invites
//! on its [`HOME`], one occurrence ([`EVENT`]), the add sheet and event editor ([`EDITOR`]) and the
//! trash ([`TRASH`], the kit's one trash screen).
//!
//! Everything of the app is here: its home, the event page, the editor and the phone calendar's
//! follow. What it shares with Reminders (the rows of a reminder on a day, the repeat rule and its
//! sheet, the attachments page, the style sheet) is the kit's `kit::schedule`; a reminder on a
//! Calendar day carries the route Reminders registered for it, as data, and this module names none
//! of Reminders' own.

use crate::Registry;
pub mod editor;
pub mod event;
pub mod event_phone;
pub mod follow;
pub mod home;
pub mod hues;
pub mod routes;
pub mod trash;

/// Calendar's home.
pub const HOME: &str = "calendar.home";
/// One occurrence of an event.
pub const EVENT: &str = "calendar.event";
/// The add sheet and the event editor.
pub const EDITOR: &str = "calendar.editor";
/// The events in the trash (#1185).
pub const TRASH: &str = "calendar.trash";

/// Calendar's screens, registered under their route names.
#[must_use]
pub fn registry() -> Registry {
    Registry::default()
        .with(HOME, home::build)
        .with(EVENT, event::build)
        .with(EDITOR, editor::build)
        .with(TRASH, trash::build)
}
