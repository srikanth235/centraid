//! `event.*`: an event's own verbs, and the one place an event row is founded.
//!
//! An event is an entity of kind `event` whose time lives on its kind row. **The calendar it is on
//! is its home** (`entity.parent_id`, A19: a calendar is a holder, and an event needs one), so a
//! move to another calendar is the shared `entity.move`; its guests are `event_guest` rows (A6);
//! its alerts are `reminder` rows (D2); a file attached to it is an `attached` edge. What a member
//! does to an event that is not about its time is a shared verb: the trash (`entity.trash`,
//! `entity.restore`), a tag, an attachment (`edge.add`), a move (`entity.move`), a calendar's name
//! (`entity.retitle`). What is here is what only an event has.
//!
//! ## When an event is (A2, D1)
//!
//! `timing` says which of three readings `starts` is under: **zoned**, a real instant
//! (`YYYY-MM-DDTHH:MM:SS.fffZ`) expanded in the event's own `zone`; **floating**, a wall clock to
//! the minute (`YYYY-MM-DDTHH:MM`) that is 09:00 wherever the member is; **all-day**, a date, whose
//! `ends` is the LAST day, inclusive. A command states its times as an instant, or as a wall clock
//! in `zone` (the phone has no zone engine: it knows the member's wall clock and the device's zone,
//! and this module is the one place that turns the pair into an instant). A wall clock the zone
//! skips is refused rather than nudged; one it repeats takes the earlier instant. The database
//! refuses a time of the wrong form for its timing.
//!
//! ## Where it is (D5)
//!
//! `location` is the free text a member or a phone wrote ("Room 4", "the usual café"): it never
//! becomes a place. `place_id` is only a place the member already has.
//!
//! ## Busy time may overlap (L3)
//!
//! Nothing refuses an event for landing on another: an overlap is a thing the calendar reads and
//! says ([`reads::overlaps`]), not a refusal.
//!
//! ## A series and what happened to one of its days (L4)
//!
//! `rule` makes an event a series, expanded by [`crate::time`] and never stored. What happened to
//! ONE day of it is an `occurrence` row keyed by the SERIES-LOCAL wall clock the rule produced
//! (`original_start`, never the resolved instant): `cancelled`, or moved and renamed. There is no
//! scope: **"this and following" splits the series** the RFC 5545 way ([`split`]): the old series'
//! `rule` ends at the day before the split and a new `event` starts at the split day, with whatever
//! the member changed, a change of timing included. The two halves keep no link.
//!
//! ## Rules the member writes are refused, not kept
//!
//! A repeat rule outside the expander's subset is refused where it is written; a followed
//! calendar's rule is kept verbatim and flagged (`rule_supported`), because a calendar's rule must
//! neither be thrown away nor expanded to the wrong dates.

mod commands;
mod follow;
mod guests;
pub mod reads;
mod split;
mod times;

use rusqlite::Connection;

use crate::commands::{CommandCtx, reminder};
use crate::error::Result;
use crate::model::{DEFAULT_CALENDAR_ID, Kind};
use crate::time::recurrence::Semantics;
use crate::time::rrule;

pub use commands::definitions;
pub(crate) use follow::{
    follow_home, overrides_canon, overrides_merge, overrides_read, overrides_take, reminders_canon,
    reminders_merge, reminders_read, reminders_take, settle, shape,
};
pub use guests::{GUEST_ADDRESS_KIND, GUESTS, GuestIn, address_key, guests_of, person_of_address};
pub(crate) use guests::{guests_canon, guests_items, guests_merge, guests_read, guests_take};

/// What a new event is told. `timing` is the reading `starts` is under; a zoned event carries its
/// zone and a UTC `starts`.
#[derive(Default)]
pub struct NewEvent<'a> {
    pub id: Option<&'a str>,
    pub title: &'a str,
    pub starts: &'a str,
    pub ends: Option<&'a str>,
    pub timing: Semantics,
    pub zone: Option<&'a str>,
    /// An RFC 5545 recurrence rule, when the event repeats.
    pub rule: Option<&'a str>,
    /// The calendar it is on; the vault's own when none is named.
    pub calendar_id: Option<&'a str>,
    /// Minutes before it starts; a minute once. An event has no default alert.
    pub reminders: &'a [i64],
    pub description: Option<&'a str>,
    /// What a person wrote for where (free text, D5).
    pub location: Option<&'a str>,
    /// A place the member has.
    pub place_id: Option<&'a str>,
    pub url: Option<&'a str>,
    /// Minutes of travel to allow before it starts.
    pub travel_min: Option<i64>,
    /// `confirmed` when none is said.
    pub status: Option<&'a str>,
    /// Whether it blocks its time; it does when none is said.
    pub busy: Option<bool>,
}

/// Found an event: the entity (born in its calendar) and the kind row. Returns its id.
///
/// # Errors
/// SQLite's refusal, or a sentence for a calendar that cannot hold it.
pub fn found(ctx: &CommandCtx<'_, '_>, event: &NewEvent<'_>) -> Result<String> {
    let title = event.title.trim();
    let calendar = event.calendar_id.unwrap_or(DEFAULT_CALENDAR_ID);
    let id = match event.id {
        Some(id) => id.to_owned(),
        None => ctx.next_id(),
    };
    ctx.insert_entity_in(&id, Kind::Event, title, Some(calendar))?;
    ctx.connection().execute(
        "INSERT INTO event (id, starts, ends, timing, zone, rule, rule_supported, status, busy,
                            location, place_id, url, description, travel_min)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        rusqlite::params![
            id,
            event.starts,
            event.ends,
            event.timing.as_str(),
            event.zone,
            event.rule,
            event.rule.is_none_or(|rule| rrule::inspect(rule).is_ok()),
            event.status.unwrap_or("confirmed"),
            event.busy.unwrap_or(true),
            event.location,
            event.place_id,
            event.url,
            event.description,
            event.travel_min,
        ],
    )?;
    reminder::set_leads(ctx, &id, event.reminders)?;
    Ok(id)
}

/// The alerts an event holds, minutes before it starts, smallest first: the set the vault compares
/// and merges on. A reader that shows them goes through `alerts::longest_first`.
///
/// # Errors
/// SQLite's refusal.
pub fn reminders_held(connection: &Connection, id: &str) -> Result<Vec<i64>> {
    connection
        .prepare_cached(
            "SELECT offset_min FROM reminder
              WHERE entity_id = ?1 AND date_id IS NULL AND field_id IS NULL ORDER BY offset_min",
        )?
        .query_map([id], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()
        .map_err(Into::into)
}

/// The vocabulary of `event.timing`, held equal to the CHECK by a test.
pub const TIMINGS: [Semantics; 3] = [Semantics::Zoned, Semantics::Floating, Semantics::AllDay];

/// The vocabulary of `event.status`, held equal to the CHECK by a test.
pub const STATUSES: [&str; 3] = ["confirmed", "tentative", "cancelled"];

/// The vocabulary of `event_guest.status`, held equal to the CHECK by a test.
pub const ANSWERS: [&str; 4] = ["needs-action", "accepted", "declined", "tentative"];

/// The vocabulary of `event_guest.role`, held equal to the CHECK by a test.
pub const ROLES: [&str; 3] = ["required", "optional", "non-participant"];
