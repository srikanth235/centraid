//! CALENDAR'S SCREENS (#1135, split from Agenda in round 10 of #1173): the ids it registers and the
//! routes that open them. Calendar owns events and invites: Day, Week, Month, List, Year and Invites
//! on its [`HOME`], one occurrence ([`EVENT`]), the add sheet and event editor ([`EDITOR`]) and the
//! trash ([`TRASH`], the kit's one trash screen) and an event's earlier versions ([`EARLIER`], the
//! kit's one earlier-versions screen).
//!
//! Everything of the app is here: its home, the event page, the editor and the phone calendar's
//! follow. What it shares with Reminders (the rows of a reminder on a day, the repeat rule and its
//! sheet, the attachments page, the style sheet) is the kit's `kit::schedule`; a reminder on a
//! Calendar day carries the route Reminders registered for it, as data, and this module names none
//! of Reminders' own.

use crate::Registry;
use crate::catalog::load::calendar as query_cal;
use crate::kit::civil;

/// How far either side of today a calendar is looked through to learn whether it holds anything.
const HOLDS_DAYS: i64 = 366;

/// THE ONE QUESTION "DOES THE CALENDAR HOLD ANYTHING": the read of every event a year either side of
/// `today` (`YYYY-MM-DD`); the calendar holds something when its answer has an event. Calendar's
/// first-open card and Home's Calendar tile both ask it, so the two can never disagree about day zero.
#[must_use]
pub(crate) fn holds_query(today: &str) -> Option<query_cal::Upcoming> {
    let midnight = |days: i64| {
        civil::plus_days(today, days)
            .filter(|day| civil::epoch_day_of(day).is_some())
            .map(|day| format!("{day}T00:00:00Z"))
    };
    Some(query_cal::Upcoming {
        from: Some(midnight(-HOLDS_DAYS)?),
        to: Some(midnight(HOLDS_DAYS)?),
        alerts: None,
    })
}
pub mod earlier;
pub mod editor;
pub mod event;
pub mod event_phone;
pub mod export;
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
/// The earlier versions of an event (#1185).
pub const EARLIER: &str = "calendar.earlier";
/// The events in the trash (#1185).
pub const TRASH: &str = "calendar.trash";
/// Calendar's export of events as a calendar file (#1185).
pub const EXPORT: &str = "calendar.export";

/// Calendar's screens, registered under their route names.
#[must_use]
pub fn registry() -> Registry {
    Registry::default()
        .with(HOME, home::build)
        .with(EVENT, event::build)
        .with(EDITOR, editor::build)
        .with(TRASH, trash::build)
        .with(EARLIER, earlier::build)
        .with(EXPORT, export::build)
}
