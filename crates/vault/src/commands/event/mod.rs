//! `event.*`: an event's own verbs, and the one place an event row is founded.
//!
//! An event is an entity of kind `event` whose time lives on its kind row; the
//! calendar it is on is a column, its guests are `attendee` edges to people (the
//! guest's answer is the edge's `state`), a file attached to it is an `attached`
//! edge, and a person a yearly date is about is an `about` edge. What a member
//! does to an event that is not about its time is a shared verb: the trash
//! (`entity.trash`, `entity.restore`), a tag, an attachment (`edge.add`), a
//! calendar's name (`entity.retitle`). What is here is what only an event has.
//!
//! ## When an event is
//!
//! `timing` says which of three readings `starts` is under: **zoned**, a real
//! instant (`…Z`) expanded in the event's own `zone`; **floating**, a wall clock
//! that is 09:00 wherever the member is; **all-day**, a date, whose `ends` is the
//! LAST day, inclusive. A command states its times as an instant, or as a wall
//! clock in `zone` (the phone has no zone engine: it knows the member's wall
//! clock and the device's zone, and this module is the one place that turns the
//! pair into an instant). A wall clock the zone skips is refused rather than
//! nudged; one it repeats takes the earlier instant.
//!
//! ## A series and what happened to one of its days
//!
//! `rule` makes an event a series, expanded by [`crate::time`] and never stored.
//! What happened to one day of it is an `occurrence` row keyed by the
//! SERIES-LOCAL wall clock the rule produced (`original_start`, never the
//! resolved instant): `cancelled`, or moved and renamed. A row of `scope =
//! 'future'` reaches that day and every one after it, moving them by the same
//! amount. A change to the series that would leave a row matching nothing is
//! refused, because a skip that matches no day is a skip that silently comes
//! back.
//!
//! ## Rules the member writes are refused, not kept
//!
//! A repeat rule outside the expander's subset is refused where it is written;
//! a followed calendar's rule is kept verbatim and flagged (`rule_supported`),
//! because a calendar's rule must neither be thrown away nor expanded to the
//! wrong dates.

mod commands;
mod follow;
mod guests;
mod times;

use std::collections::BTreeSet;

use rusqlite::Connection;

use crate::commands::CommandCtx;
use crate::error::Result;
use crate::model::{DEFAULT_CALENDAR_ID, Kind};
use crate::time::recurrence::Semantics;
use crate::time::rrule;

pub use commands::definitions;
pub(crate) use follow::{overrides_canon, overrides_merge, overrides_read, overrides_take, settle};
pub use guests::PERSON_OF_EMAIL;
pub(crate) use guests::{
    attendees_canon, attendees_items, attendees_merge, attendees_read, attendees_stamp,
    attendees_take,
};
pub(crate) use times::{
    reminders_canon, reminders_merge, reminders_read, reminders_take, shape, shape_overlay,
};

// ---------------------------------------------------------------------------
// When
// ---------------------------------------------------------------------------

/// What a new event is told. `timing` is the reading `starts` is under; a zoned
/// event carries its zone and a UTC `starts`.
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
    /// Minutes before it starts; a minute once.
    pub reminders: &'a [i64],
    pub description: Option<&'a str>,
    pub place_id: Option<&'a str>,
    pub url: Option<&'a str>,
    /// Minutes of travel to allow before it starts.
    pub travel_min: Option<i64>,
    /// `confirmed` when none is said.
    pub status: Option<&'a str>,
    /// Whether it blocks its time; it does when none is said.
    pub busy: Option<bool>,
}

/// Found an event: the entity and the kind row. Returns its id.
pub fn found(ctx: &CommandCtx<'_, '_>, event: &NewEvent<'_>) -> Result<String> {
    let title = event.title.trim();
    let id = match event.id {
        Some(id) => {
            ctx.insert_entity_as(id, Kind::Event, title)?;
            id.to_owned()
        }
        None => ctx.insert_entity(Kind::Event, title)?,
    };
    ctx.connection().execute(
        "INSERT INTO event (id, starts, ends, timing, zone, rule, rule_supported, status, busy,
                            calendar_id, place_id, url, description, travel_min)
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
            event.calendar_id.unwrap_or(DEFAULT_CALENDAR_ID),
            event.place_id,
            event.url,
            event.description,
            event.travel_min,
        ],
    )?;
    set_reminders(ctx.connection(), &id, event.reminders)?;
    Ok(id)
}

/// The alerts an event holds, minutes before it starts, smallest first: the set the vault compares
/// and merges on. A reader that shows them goes through `alerts::longest_first`.
pub(crate) fn reminders_held(connection: &Connection, id: &str) -> Result<Vec<i64>> {
    connection
        .prepare_cached("SELECT offset_min FROM reminder WHERE entity_id = ?1 ORDER BY offset_min")?
        .query_map([id], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()
        .map_err(Into::into)
}

/// Make the event's alerts exactly `wanted` (a minute once). Returns whether anything changed.
pub(crate) fn set_reminders(connection: &Connection, id: &str, wanted: &[i64]) -> Result<bool> {
    let wanted: BTreeSet<i64> = wanted.iter().copied().collect();
    let held: BTreeSet<i64> = reminders_held(connection, id)?.into_iter().collect();
    for gone in held.difference(&wanted) {
        connection.execute(
            "DELETE FROM reminder WHERE entity_id = ?1 AND offset_min = ?2",
            rusqlite::params![id, gone],
        )?;
    }
    for added in wanted.difference(&held) {
        connection.execute(
            "INSERT INTO reminder (entity_id, offset_min) VALUES (?1, ?2)",
            rusqlite::params![id, added],
        )?;
    }
    Ok(wanted != held)
}

/// The vocabulary of `event.timing`, held equal to the CHECK by a test.
pub const TIMINGS: [Semantics; 3] = [Semantics::Zoned, Semantics::Floating, Semantics::AllDay];

/// The vocabulary of `event.status`, held equal to the CHECK by a test.
pub const STATUSES: [&str; 3] = ["confirmed", "tentative", "cancelled"];

/// The vocabulary of `edge.state` on an invitee, held equal to the CHECK by a test.
pub const ANSWERS: [&str; 4] = ["needs-action", "accepted", "declined", "tentative"];
