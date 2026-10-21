//! An event's row: how one is founded.
//!
//! Agenda owns the `event.*` commands; People founds events too (a yearly date
//! about a person is an `event` with an `about` edge, R-FP-2), so the row is
//! written in one place that both come to.

use crate::commands::CommandCtx;
use crate::error::Result;
use crate::model::{DEFAULT_CALENDAR_ID, Kind};

/// What a new event is told. `timing` is `zoned`, `floating` or `all-day`, and
/// a zoned event carries its zone and a UTC `starts`.
pub struct NewEvent<'a> {
    pub id: Option<&'a str>,
    pub title: &'a str,
    pub starts: &'a str,
    pub ends: Option<&'a str>,
    pub timing: &'a str,
    pub zone: Option<&'a str>,
    /// An RFC 5545 recurrence rule, when the event repeats.
    pub rule: Option<&'a str>,
    /// The calendar it is on; the vault's own when none is named.
    pub calendar_id: Option<&'a str>,
    /// Minutes before it starts, a JSON array.
    pub reminders: Option<&'a str>,
    pub description: Option<&'a str>,
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
        "INSERT INTO event (id, starts, ends, timing, zone, rule, calendar_id, reminders, description)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        rusqlite::params![
            id,
            event.starts,
            event.ends,
            event.timing,
            event.zone,
            event.rule,
            event.calendar_id.unwrap_or(DEFAULT_CALENDAR_ID),
            event.reminders,
            event.description,
        ],
    )?;
    Ok(id)
}
