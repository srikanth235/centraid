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

use std::collections::BTreeSet;

use rusqlite::{Connection, OptionalExtension};
use serde_json::{Value as Json, json};

use crate::commands::edge::{self, Extras};
use crate::commands::entity::lookup_live;
use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency, Risk};
use crate::error::{Result, VaultError};
use crate::model::{DEFAULT_CALENDAR_ID, Kind, Rel};
use crate::time::occurrence::{SEARCH_WINDOW_DAYS, search_window};
use crate::time::recurrence::{ExpandInput, Occurrence, Semantics, expand, parse_instant_ms};
use crate::time::zone::{FireZone, parse_wall_iso};
use crate::time::{rrule, temporal};

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
    /// Minutes before it starts, a JSON array.
    pub reminders: Option<&'a str>,
    pub description: Option<&'a str>,
    pub place_id: Option<&'a str>,
    pub url: Option<&'a str>,
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
                            calendar_id, place_id, url, reminders, description)
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
            event.reminders,
            event.description,
        ],
    )?;
    Ok(id)
}

/// The vocabulary of `event.timing`, held equal to the CHECK by a test.
pub const TIMINGS: [Semantics; 3] = [Semantics::Zoned, Semantics::Floating, Semantics::AllDay];

/// The vocabulary of `event.status`, held equal to the CHECK by a test.
pub const STATUSES: [&str; 3] = ["confirmed", "tentative", "cancelled"];

/// The vocabulary of `edge.state` on an invitee, held equal to the CHECK by a test.
pub const ANSWERS: [&str; 4] = ["needs-action", "accepted", "declined", "tentative"];

fn parse_timing(word: &str) -> Option<Semantics> {
    TIMINGS.into_iter().find(|timing| timing.as_str() == word)
}

/// The times a command states, resolved to what the row stores.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Times {
    starts: String,
    ends: Option<String>,
    timing: Semantics,
    zone: Option<String>,
}

/// The event as it stands, for an edit to complete a half-stated change from.
struct Row {
    times: Times,
    rule: Option<String>,
    status: String,
}

fn row_of(connection: &Connection, id: &str) -> Result<Row> {
    connection
        .query_row(
            "SELECT starts, ends, timing, zone, rule, status FROM event WHERE id = ?1",
            [id],
            |row| {
                let timing: String = row.get(2)?;
                Ok(Row {
                    times: Times {
                        starts: row.get(0)?,
                        ends: row.get(1)?,
                        timing: Semantics::from_stored(Some(&timing)),
                        zone: row.get(3)?,
                    },
                    rule: row.get(4)?,
                    status: row.get(5)?,
                })
            },
        )
        .map_err(|_| VaultError::Invariant {
            context: format!("`{id}` is not an event, and a precondition said it was"),
        })
}

/// One time as the row will hold it, under `timing`: an instant stays one, a
/// wall clock in the zone becomes the instant it is, a floating time or a day
/// stays as written.
fn resolve_one(
    field: &str,
    value: &str,
    timing: Semantics,
    zone: Option<&FireZone>,
) -> std::result::Result<String, String> {
    let kind = temporal::classify(value);
    let shape = |wanted: &str| format!("`{field}` is {value}; with this timing it is {wanted}.");
    match timing {
        Semantics::AllDay => (kind == Some(temporal::Kind::LocalDate))
            .then(|| value.to_owned())
            .ok_or_else(|| shape("a date, YYYY-MM-DD")),
        Semantics::Floating => (kind == Some(temporal::Kind::FloatingDateTime))
            .then(|| value.to_owned())
            .ok_or_else(|| shape("a wall clock, YYYY-MM-DDTHH:MM[:SS]")),
        Semantics::Zoned => match kind {
            Some(temporal::Kind::Instant) => parse_instant_ms(value)
                .map(crate::clock::format_iso_ms)
                .ok_or_else(|| shape("an instant or a wall clock in its zone")),
            Some(temporal::Kind::FloatingDateTime) => {
                let zone = zone.ok_or("a zoned time needs the zone it is in.")?;
                let wall = parse_wall_iso(value)
                    .ok_or_else(|| shape("an instant or a wall clock in its zone"))?;
                zone.resolve_wall_time(wall)
                    .map(|resolved| resolved.instant)
                    .ok_or_else(|| format!("{value} does not exist in {zone}: the clocks skip it."))
            }
            _ => Err(shape("an instant or a wall clock in its zone")),
        },
    }
}

/// The times a command or a source states over `base` (an edit) or alone (a
/// proposal): the object's `starts`, `ends`, `timing` and `zone`. `Err` is the
/// sentence a member reads.
///
/// The timing is the one said; else the zone's presence says zoned; else the
/// event's own, when it has one; else the shape of `starts` (a date is all-day,
/// an instant zoned, anything else a wall clock). A zone is the one said, else
/// the event's own.
fn resolve_times(
    stated: &serde_json::Map<String, Json>,
    base: Option<&Times>,
) -> std::result::Result<Times, String> {
    let (starts, ends, timing_word, zone_word) = (
        stated.get("starts").and_then(Json::as_str),
        stated.get("ends"),
        stated.get("timing").and_then(Json::as_str),
        stated.get("zone"),
    );
    if let Some(base) = base
        && starts.is_none()
        && ends.is_none()
        && timing_word.is_none()
        && zone_word.is_none()
    {
        return Ok(base.clone());
    }
    let zone_name = match zone_word {
        Some(Json::String(name)) => Some(name.clone()),
        Some(_) => None,
        None => base.and_then(|base| base.zone.clone()),
    };
    let timing = match timing_word {
        Some(word) => parse_timing(word).ok_or_else(|| format!("`{word}` is not a timing."))?,
        None if matches!(zone_word, Some(Json::String(_))) => Semantics::Zoned,
        None if base.is_some() => base.map_or(Semantics::Floating, |base| base.timing),
        None => match starts.map(temporal::classify) {
            Some(Some(temporal::Kind::LocalDate)) => Semantics::AllDay,
            Some(Some(temporal::Kind::Instant)) => Semantics::Zoned,
            _ => Semantics::Floating,
        },
    };
    let zone = if timing == Semantics::Zoned {
        let name = zone_name.ok_or("A zoned event needs the zone it is in.")?;
        Some(FireZone::named(&name).map_err(|_| format!("{name} is not a time zone."))?)
    } else {
        if matches!(zone_word, Some(Json::String(_))) {
            return Err("A time in a zone is zoned; it cannot also be floating or all-day.".into());
        }
        None
    };
    let starts = match starts.or_else(|| base.map(|base| base.starts.as_str())) {
        Some(value) => resolve_one("starts", value, timing, zone.as_ref())?,
        None => return Err("An event needs a start.".to_owned()),
    };
    let ends = match ends {
        Some(Json::String(value)) => Some(resolve_one("ends", value, timing, zone.as_ref())?),
        Some(_) => None,
        None => base
            .and_then(|base| base.ends.clone())
            .map(|value| resolve_one("ends", &value, timing, zone.as_ref()))
            .transpose()?,
    };
    if let Some(ends) = &ends {
        let (before, after) = (&starts, ends);
        let ordered = if timing == Semantics::Zoned {
            parse_instant_ms(after) > parse_instant_ms(before)
        } else if timing == Semantics::AllDay {
            after >= before
        } else {
            after > before
        };
        if !ordered {
            return Err(if timing == Semantics::AllDay {
                "An all-day event must end on or after the day it starts."
            } else {
                "An event must end after it starts."
            }
            .to_owned());
        }
    }
    Ok(Times {
        starts,
        ends,
        timing,
        zone: zone.map(|zone| zone.name().to_owned()),
    })
}

fn times(ctx: &CommandCtx<'_, '_>, base: Option<&Times>) -> std::result::Result<Times, String> {
    resolve_times(
        ctx.input.as_object().unwrap_or(&serde_json::Map::new()),
        base,
    )
}

/// What a followed calendar states of an event, in the form the vault holds it:
/// a wall clock and its zone become the instant, so the statement a source makes
/// and the row it leaves compare equal.
pub(crate) fn shape(fields: &mut serde_json::Map<String, Json>) -> std::result::Result<(), String> {
    if !["starts", "ends", "timing", "zone"]
        .iter()
        .any(|key| fields.contains_key(*key))
    {
        return Ok(());
    }
    let at = resolve_times(fields, None)?;
    fields.insert("starts".to_owned(), at.starts.into());
    if fields.contains_key("ends") {
        fields.insert("ends".to_owned(), at.ends.into());
    }
    fields.insert("timing".to_owned(), at.timing.as_str().into());
    fields.insert("zone".to_owned(), at.zone.into());
    Ok(())
}

// ---------------------------------------------------------------------------
// A series
// ---------------------------------------------------------------------------

/// The days a series has between two instants, in its own zone, as the rule
/// produced them.
fn expand_series(
    times: &Times,
    rule: &str,
    from: &str,
    to: &str,
    at_most: usize,
) -> Vec<Occurrence> {
    let zone = times
        .zone
        .as_deref()
        .and_then(|name| FireZone::named(name).ok());
    let mut input = ExpandInput::new(rule, &times.starts, from, to)
        .with_semantics(times.timing)
        .at_most(at_most);
    input.zone = zone.as_ref();
    expand(&input)
}

/// The occurrence of the series the wall clock `original_start` names, or
/// `None` when the rule does not land there. The key is NOT an instant, so the
/// window comes from the shared adapter and the match is on `wall_start`.
fn occurrence_at(times: &Times, rule: &str, original_start: &str) -> Option<Occurrence> {
    let (from, to) = search_window(original_start, SEARCH_WINDOW_DAYS)?;
    expand_series(times, rule, &from, &to, 16)
        .into_iter()
        .find(|occurrence| occurrence.wall_start == original_start)
}

/// How many of the series' occurrence rows match no day of the series as it is.
fn stranded(connection: &Connection, id: &str, times: &Times, rule: Option<&str>) -> Result<usize> {
    let keys: Vec<String> = connection
        .prepare("SELECT DISTINCT original_start FROM occurrence WHERE series_id = ?1 ORDER BY 1")?
        .query_map([id], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let (Some(first), Some(last)) = (keys.first(), keys.last()) else {
        return Ok(0);
    };
    let Some(rule) = rule else {
        return Ok(keys.len());
    };
    let (Some((from, _)), Some((_, to))) = (
        search_window(first, SEARCH_WINDOW_DAYS),
        search_window(last, SEARCH_WINDOW_DAYS),
    ) else {
        return Ok(keys.len());
    };
    let live: BTreeSet<String> = expand_series(times, rule, &from, &to, 2_000)
        .into_iter()
        .map(|occurrence| occurrence.wall_start)
        .collect();
    Ok(keys.iter().filter(|key| !live.contains(*key)).count())
}

fn rule_refusal(rule: &str) -> Option<String> {
    rrule::inspect(rule)
        .err()
        .map(|refusal| format!("{rule}: {}", refusal.message()))
}

// ---------------------------------------------------------------------------
// Preconditions
// ---------------------------------------------------------------------------

fn live_event(ctx: &CommandCtx<'_, '_>, key: &str) -> Result<std::result::Result<(), String>> {
    Ok(
        match lookup_live(ctx.connection(), ctx.required_str(key)?)? {
            Err(sentence) => Err(sentence),
            Ok(found) if found.kind != Kind::Event => Err(format!(
                "“{}” is a {}, not an event",
                found.title,
                found.kind.noun()
            )),
            Ok(_) => Ok(()),
        },
    )
}

/// A live entity of one kind a command points at (a calendar, a place, a guest).
fn points_at(ctx: &CommandCtx<'_, '_>, id: &str, kind: Kind) -> Result<Option<String>> {
    Ok(match lookup_live(ctx.connection(), id)? {
        Err(sentence) => Some(sentence),
        Ok(found) if found.kind != kind => Some(format!(
            "“{}” is a {}, not a {}",
            found.title,
            found.kind.noun(),
            kind.noun()
        )),
        Ok(_) => None,
    })
}

/// What the references an event command carries point at: the calendar, the
/// place and every guest.
fn references_refusal(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    for (key, kind) in [("calendar_id", Kind::Calendar), ("place_id", Kind::Place)] {
        if let Some(id) = ctx.optional_str(key)
            && let Some(sentence) = points_at(ctx, id, kind)?
        {
            return Ok(Some(sentence));
        }
    }
    for guest in guests(ctx) {
        if let Some(sentence) = points_at(ctx, guest, Kind::Person)? {
            return Ok(Some(sentence));
        }
    }
    Ok(None)
}

fn rule_stated_refusal(ctx: &CommandCtx<'_, '_>) -> Option<String> {
    ctx.optional_str("rule").and_then(rule_refusal)
}

fn guests<'a>(ctx: &'a CommandCtx<'_, '_>) -> Vec<&'a str> {
    ctx.input
        .get("attendees")
        .and_then(Json::as_array)
        .into_iter()
        .flatten()
        .filter_map(Json::as_str)
        .collect()
}

/// A busy event does not land on another busy one: a timed pair that overlaps
/// is refused. A free event blocks nothing, so it conflicts with nothing; an
/// imported calendar's overlaps already happened and are not asked.
fn conflict_refusal(ctx: &CommandCtx<'_, '_>, times: &Times) -> Result<Option<String>> {
    let busy = ctx
        .input
        .get("busy")
        .and_then(Json::as_bool)
        .unwrap_or(true);
    let (Some(ends), true) = (&times.ends, busy && times.timing != Semantics::AllDay) else {
        return Ok(None);
    };
    let held: i64 = ctx.connection().query_row(
        "SELECT COUNT(*) FROM event v JOIN entity e ON e.id = v.id
          WHERE v.busy = 1 AND v.status <> 'cancelled' AND e.deleted_at IS NULL
            AND v.timing <> 'all-day' AND v.starts < ?1 AND v.ends > ?2",
        [ends, &times.starts],
        |row| row.get(0),
    )?;
    Ok((held > 0).then(|| "This time conflicts with another event on your calendar.".to_owned()))
}

fn pre_propose(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if ctx.required_str("title")?.trim().is_empty() {
        return Ok(Some("an event needs a title".to_owned()));
    }
    if let Some(id) = ctx.optional_str("id")
        && crate::commands::entity::find(ctx.connection(), id)?.is_some()
    {
        return Ok(Some("an event with that id already exists".to_owned()));
    }
    if let Some(sentence) = rule_stated_refusal(ctx) {
        return Ok(Some(sentence));
    }
    if let Some(sentence) = references_refusal(ctx)? {
        return Ok(Some(sentence));
    }
    match times(ctx, None) {
        Err(sentence) => Ok(Some(sentence)),
        Ok(times) => conflict_refusal(ctx, &times),
    }
}

fn pre_edit(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if let Err(sentence) = live_event(ctx, "id")? {
        return Ok(Some(sentence));
    }
    if ctx.input.get("title").is_some() && ctx.required_str("title")?.trim().is_empty() {
        return Ok(Some("an event needs a title".to_owned()));
    }
    if let Some(sentence) = rule_stated_refusal(ctx) {
        return Ok(Some(sentence));
    }
    if let Some(sentence) = references_refusal(ctx)? {
        return Ok(Some(sentence));
    }
    let id = ctx.required_str("id")?;
    let row = row_of(ctx.connection(), id)?;
    let after = match times(ctx, Some(&row.times)) {
        Ok(after) => after,
        Err(sentence) => return Ok(Some(sentence)),
    };
    let rule = match ctx.input.get("rule") {
        Some(Json::String(rule)) => Some(rule.as_str()),
        Some(_) => None,
        None => row.rule.as_deref(),
    };
    let n = stranded(ctx.connection(), id, &after, rule)?;
    Ok(
        (n > 0 && (after != row.times || rule != row.rule.as_deref())).then(|| {
            format!(
                "This change to the series leaves {n} changed or skipped day{} matching nothing: \
             put {} back first.",
                if n == 1 { "" } else { "s" },
                if n == 1 { "it" } else { "them" }
            )
        }),
    )
}

fn pre_cancel(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    live_event(ctx, "id").map(std::result::Result::err)
}

fn pre_respond(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if let Err(sentence) = live_event(ctx, "id")? {
        return Ok(Some(sentence));
    }
    let id = ctx.required_str("id")?;
    if row_of(ctx.connection(), id)?.status == "cancelled" {
        return Ok(Some("That event is cancelled.".to_owned()));
    }
    let invited: i64 = ctx.connection().query_row(
        "SELECT COUNT(*) FROM edge WHERE from_id = ?1 AND rel = 'attendee' AND to_id = ?2",
        [id, ctx.required_str("person_id")?],
        |row| row.get(0),
    )?;
    Ok((invited == 0).then(|| "That person is not invited to this event.".to_owned()))
}

fn pre_occurrence(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if let Err(sentence) = live_event(ctx, "id")? {
        return Ok(Some(sentence));
    }
    let id = ctx.required_str("id")?;
    let row = row_of(ctx.connection(), id)?;
    let (scope, action) = (ctx.required_str("scope")?, ctx.required_str("action")?);
    if scope == "series" {
        return Ok((action == "restore").then(|| "Only a skipped or moved day is put back.".into()));
    }
    let Some(rule) = row.rule.as_deref() else {
        return Ok(Some("That event does not repeat.".to_owned()));
    };
    if action == "restore" {
        return Ok(None);
    }
    if occurrence_at(&row.times, rule, ctx.required_str("original_start")?).is_none() {
        return Ok(Some("That day is not one the event lands on.".to_owned()));
    }
    if action == "override"
        && let Err(sentence) = times(ctx, Some(&row.times))
    {
        return Ok(Some(sentence));
    }
    Ok(None)
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

fn invalid(name: &str, detail: String) -> VaultError {
    VaultError::InvalidInput {
        name: name.to_owned(),
        detail,
    }
}

fn reminders_of(ctx: &CommandCtx<'_, '_>) -> Option<String> {
    ctx.input
        .get("reminders")
        .filter(|minutes| minutes.as_array().is_some_and(|list| !list.is_empty()))
        .map(Json::to_string)
}

/// Make the event's guests exactly `wanted`: a guest already invited keeps their
/// answer, a new one has not answered, one left out is taken off the list.
fn set_guests(ctx: &CommandCtx<'_, '_>, id: &str, wanted: &[&str]) -> Result<()> {
    let kept: BTreeSet<&str> = wanted.iter().copied().collect();
    let held: Vec<String> = ctx
        .connection()
        .prepare("SELECT to_id FROM edge WHERE from_id = ?1 AND rel = 'attendee'")?
        .query_map([id], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for guest in held.iter().filter(|guest| !kept.contains(guest.as_str())) {
        ctx.connection().execute(
            "DELETE FROM edge WHERE from_id = ?1 AND rel = 'attendee' AND to_id = ?2",
            [id, guest],
        )?;
    }
    for guest in kept
        .iter()
        .filter(|guest| !held.iter().any(|held| held == *guest))
    {
        edge::put(
            ctx,
            id,
            Rel::Attendee,
            guest,
            None,
            &Extras {
                state: Some("needs-action"),
                ..Extras::default()
            },
        )?;
    }
    Ok(())
}

fn propose(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let times = times(ctx, None).map_err(|sentence| invalid("starts", sentence))?;
    let reminders = reminders_of(ctx);
    let id = found(
        ctx,
        &NewEvent {
            id: ctx.optional_str("id"),
            title: ctx.required_str("title")?,
            starts: &times.starts,
            ends: times.ends.as_deref(),
            timing: times.timing,
            zone: times.zone.as_deref(),
            rule: ctx.optional_str("rule").map(rrule::canonicalize).as_deref(),
            calendar_id: ctx.optional_str("calendar_id"),
            reminders: reminders.as_deref(),
            description: ctx.optional_str("description"),
            place_id: ctx.optional_str("place_id"),
            url: ctx.optional_str("url"),
            status: ctx.optional_str("status"),
            busy: ctx.input.get("busy").and_then(Json::as_bool),
        },
    )?;
    set_guests(ctx, &id, &guests(ctx))?;
    Ok(json!({ "id": id, "attendees": guests(ctx).len() }))
}

/// Set the event's own columns from what a command states: a key that is
/// present is set (`null` clears it), one that is absent is left alone.
fn write_event(ctx: &CommandCtx<'_, '_>, id: &str, after: &Times) -> Result<()> {
    let connection = ctx.connection();
    connection.execute(
        "UPDATE event SET starts = ?2, ends = ?3, timing = ?4, zone = ?5 WHERE id = ?1",
        rusqlite::params![
            id,
            after.starts,
            after.ends,
            after.timing.as_str(),
            after.zone
        ],
    )?;
    for column in [
        "description",
        "place_id",
        "url",
        "calendar_id",
        "status",
        "busy",
    ] {
        if let Some(value) = ctx.input.get(column) {
            connection.execute(
                &format!("UPDATE event SET {column} = ?2 WHERE id = ?1"),
                rusqlite::params![id, crate::commands::follow::to_sql(value)],
            )?;
        }
    }
    if ctx.input.get("reminders").is_some() {
        connection.execute(
            "UPDATE event SET reminders = ?2 WHERE id = ?1",
            rusqlite::params![id, reminders_of(ctx)],
        )?;
    }
    if let Some(rule) = ctx.input.get("rule") {
        let rule = rule.as_str().map(rrule::canonicalize);
        connection.execute(
            "UPDATE event SET rule = ?2, rule_supported = 1 WHERE id = ?1",
            rusqlite::params![id, rule],
        )?;
    }
    if let Some(title) = ctx.optional_str("title") {
        connection.execute(
            "UPDATE entity SET title = ?2 WHERE id = ?1",
            [id, title.trim()],
        )?;
    }
    if ctx.input.get("attendees").is_some() {
        set_guests(ctx, id, &guests(ctx))?;
    }
    ctx.touch(id)
}

fn edit(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let id = ctx.required_str("id")?;
    let row = row_of(ctx.connection(), id)?;
    let after = times(ctx, Some(&row.times)).map_err(|sentence| invalid("starts", sentence))?;
    write_event(ctx, id, &after)?;
    Ok(json!({ "id": id }))
}

fn cancel(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let id = ctx.required_str("id")?;
    ctx.connection()
        .execute("UPDATE event SET status = 'cancelled' WHERE id = ?1", [id])?;
    ctx.touch(id)?;
    Ok(json!({ "id": id }))
}

fn respond(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let (id, person, state) = (
        ctx.required_str("id")?,
        ctx.required_str("person_id")?,
        ctx.required_str("state")?,
    );
    edge::put(
        ctx,
        id,
        Rel::Attendee,
        person,
        None,
        &Extras {
            state: Some(state),
            ..Extras::default()
        },
    )?;
    ctx.touch(id)?;
    Ok(json!({ "id": id, "state": state }))
}

/// What happened to one day of a series, or to the series as a whole.
fn edit_occurrence(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let id = ctx.required_str("id")?;
    let (scope, action) = (ctx.required_str("scope")?, ctx.required_str("action")?);
    let answer = json!({ "id": id, "scope": scope });
    if scope == "series" {
        // The whole series: skipping it is cancelling it, and a change to it is
        // an edit of the event's own times and words.
        if action == "skip" {
            cancel(ctx)?;
        } else {
            let row = row_of(ctx.connection(), id)?;
            let after = times(ctx, Some(&row.times)).map_err(|s| invalid("starts", s))?;
            write_event(ctx, id, &after)?;
        }
        return Ok(answer);
    }
    let key = ctx.required_str("original_start")?;
    let connection = ctx.connection();
    if action == "restore" {
        connection.execute(
            "DELETE FROM occurrence WHERE series_id = ?1 AND original_start = ?2 AND scope = ?3",
            [id, key, scope],
        )?;
    } else {
        let skipped = action == "skip";
        let (mut starts, mut ends) = (None, None);
        if !skipped {
            let row = row_of(connection, id)?;
            let at = times(ctx, Some(&row.times)).map_err(|s| invalid("starts", s))?;
            // Only what was stated is the day's own; the rest is the series'.
            if ctx.optional_str("starts").is_some() {
                starts = Some(at.starts);
            }
            if ctx.optional_str("ends").is_some() {
                ends = at.ends;
            }
        }
        connection.execute(
            "INSERT INTO occurrence (series_id, original_start, scope, cancelled, starts, ends,
                                     title, description)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT (series_id, original_start, scope)
             DO UPDATE SET cancelled = ?4, starts = ?5, ends = ?6, title = ?7, description = ?8",
            rusqlite::params![
                id,
                key,
                scope,
                skipped,
                starts,
                ends,
                if skipped {
                    None
                } else {
                    ctx.optional_str("title")
                },
                if skipped {
                    None
                } else {
                    ctx.optional_str("description")
                },
            ],
        )?;
    }
    ctx.touch(id)?;
    Ok(answer)
}

// ---------------------------------------------------------------------------
// The follower's `settle`, and its `overrides`
// ---------------------------------------------------------------------------

/// What a followed event derives from what its source stated: whether its rule
/// is one the expander can expand. A source states the rule; it does not know
/// the engine.
pub(crate) fn settle(ctx: &CommandCtx<'_, '_>, id: &str) -> Result<()> {
    let rule: Option<String> = ctx
        .connection()
        .query_row("SELECT rule FROM event WHERE id = ?1", [id], |row| {
            row.get(0)
        })
        .optional()?
        .flatten();
    ctx.connection().execute(
        "UPDATE event SET rule_supported = ?2 WHERE id = ?1",
        rusqlite::params![id, rule.is_none_or(|rule| rrule::inspect(&rule).is_ok())],
    )?;
    Ok(())
}

/// What happened to one day of a series, as the row holds it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Day {
    cancelled: bool,
    starts: Option<String>,
    ends: Option<String>,
    title: Option<String>,
    description: Option<String>,
}

/// What a source's `overrides` field says: over the window `from`..`to` (UTC
/// instants) it showed these days of the series as the rule has them (`shown`,
/// by the series-local wall clock), and these as moved or renamed (`moved`). A
/// day of the window the rule produces and the source showed neither way was
/// skipped there. The phone has no rule engine, so it states what it SEES and
/// the vault, which has one, works out what that means.
struct Observed {
    from: String,
    to: String,
    shown: BTreeSet<String>,
    moved: Vec<Json>,
}

fn observed(statement: &Json) -> Option<Observed> {
    let text = |key: &str| statement.get(key)?.as_str().map(str::to_owned);
    let list = |key: &str| statement.get(key).and_then(Json::as_array).cloned();
    Some(Observed {
        from: text("from")?,
        to: text("to")?,
        shown: list("shown")?
            .iter()
            .filter_map(|key| key.as_str().map(str::to_owned))
            .collect(),
        moved: list("moved").unwrap_or_default(),
    })
}

/// The days of the window the rule produces, and what became of each as the
/// statement says: the rows a source that said it would have left.
struct Derived {
    window: BTreeSet<String>,
    rows: std::collections::BTreeMap<String, Day>,
}

fn derive(connection: &Connection, id: &str, said: &Observed) -> Result<Derived> {
    let (times, rule, title, description): (Times, Option<String>, String, Option<String>) = {
        let row = row_of(connection, id)?;
        let (title, description) = connection.query_row(
            "SELECT e.title, v.description FROM event v JOIN entity e ON e.id = v.id WHERE v.id = ?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        (row.times, row.rule, title, description)
    };
    let mut derived = Derived {
        window: BTreeSet::new(),
        rows: std::collections::BTreeMap::new(),
    };
    let Some(rule) = rule.filter(|rule| rrule::inspect(rule).is_ok()) else {
        return Ok(derived);
    };
    let zone = times
        .zone
        .as_deref()
        .and_then(|name| FireZone::named(name).ok());
    let at = |value: Option<&str>| {
        value.and_then(|value| resolve_one("starts", value, times.timing, zone.as_ref()).ok())
    };
    let moved: std::collections::BTreeMap<&str, &Json> = said
        .moved
        .iter()
        .filter_map(|day| Some((day.get("original_start")?.as_str()?, day)))
        .collect();
    for occurrence in expand_series(&times, &rule, &said.from, &said.to, 2_000) {
        let key = occurrence.wall_start;
        derived.window.insert(key.clone());
        let day = if let Some(day) = moved.get(key.as_str()) {
            let text = |name: &str, own: Option<&str>| {
                let said = day
                    .get(name)
                    .and_then(Json::as_str)
                    .filter(|text| !text.is_empty());
                said.filter(|said| Some(*said) != own).map(str::to_owned)
            };
            let text_of = |name: &str| day.get(name).and_then(Json::as_str);
            let starts = at(text_of("starts")).filter(|starts| *starts != occurrence.start);
            Day {
                cancelled: false,
                ends: starts.as_ref().and_then(|_| at(text_of("ends"))),
                starts,
                title: text("title", Some(&title)),
                description: text("description", description.as_deref()),
            }
        } else if said.shown.contains(&key) {
            continue;
        } else {
            Day {
                cancelled: true,
                starts: None,
                ends: None,
                title: None,
                description: None,
            }
        };
        // A day the phone calls moved and says nothing different of is the series' own.
        if day.starts.is_some() || day.cancelled || day.title.is_some() || day.description.is_some()
        {
            derived.rows.insert(key, day);
        }
    }
    Ok(derived)
}

/// The rows an event's days hold now, by series-local wall clock.
fn held(connection: &Connection, id: &str) -> Result<std::collections::BTreeMap<String, Day>> {
    connection
        .prepare(
            "SELECT original_start, cancelled, starts, ends, title, description FROM occurrence
              WHERE series_id = ?1 AND scope = 'occurrence'",
        )?
        .query_map([id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                Day {
                    cancelled: row.get(1)?,
                    starts: row.get(2)?,
                    ends: row.get(3)?,
                    title: row.get(4)?,
                    description: row.get(5)?,
                },
            ))
        })?
        .collect::<rusqlite::Result<_>>()
        .map_err(Into::into)
}

/// The statement a source made last, when the vault's rows are still what it
/// implies; otherwise the rows as they stand, which is a different thing. So an
/// untouched series reads as what its source said, and one whose days the
/// member changed reads as edited.
pub(crate) fn overrides_read(connection: &Connection, id: &str) -> Result<Json> {
    let said: Option<Json> = connection
        .query_row(
            "SELECT stated FROM source WHERE entity_id = ?1",
            [id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .and_then(|stated| serde_json::from_str::<Json>(&stated).ok())
        .and_then(|stated| stated.get("overrides").cloned());
    let Some(said) = said.filter(|said| !said.is_null()) else {
        return Ok(Json::Null);
    };
    let Some(seen) = observed(&said) else {
        return Ok(said);
    };
    let (derived, rows) = (derive(connection, id, &seen)?, held(connection, id)?);
    let inside = |rows: &std::collections::BTreeMap<String, Day>| -> Vec<(String, Day)> {
        rows.iter()
            .filter(|(key, _)| derived.window.contains(*key))
            .map(|(key, day)| (key.clone(), day.clone()))
            .collect()
    };
    Ok(if inside(&derived.rows) == inside(&rows) {
        said
    } else {
        json!({ "held": inside(&rows).iter().map(|(key, day)| json!([key, day.cancelled, day.starts, day.title])).collect::<Vec<_>>() })
    })
}

pub(crate) fn overrides_canon(statement: &Json) -> Json {
    statement.clone()
}

/// A three-way merge of a series' days: for each day of the window the rule
/// produces, the source's new word replaces the vault's row when the member
/// never changed it (the vault's row is what the source's last word implied),
/// and otherwise the member's stands. `stated` is what the source said last,
/// `None` when it has not spoken for this series before (then it only adds).
/// A day outside the window is not judged: the window slides a day at a time
/// and a skip that left it has not been undone.
pub(crate) fn overrides_merge(
    ctx: &CommandCtx<'_, '_>,
    id: &str,
    stated: Option<&Json>,
    new: &Json,
) -> Result<bool> {
    let connection = ctx.connection();
    let Some(now) = observed(new) else {
        return Ok(false);
    };
    let (after, rows) = (derive(connection, id, &now)?, held(connection, id)?);
    let before = stated
        .and_then(observed)
        .map(|said| derive(connection, id, &said))
        .transpose()?;
    let mut changed = false;
    for key in &after.window {
        let (wanted, have) = (after.rows.get(key), rows.get(key));
        if wanted == have {
            continue;
        }
        let ours = match &before {
            Some(before) if before.window.contains(key) => have == before.rows.get(key),
            _ => have.is_none(),
        };
        if !ours {
            continue;
        }
        match wanted {
            None => {
                connection.execute(
                    "DELETE FROM occurrence WHERE series_id = ?1 AND original_start = ?2
                                              AND scope = 'occurrence'",
                    [id, key],
                )?;
            }
            Some(day) => {
                connection.execute(
                    "INSERT INTO occurrence (series_id, original_start, scope, cancelled, starts,
                                             ends, title, description)
                     VALUES (?1, ?2, 'occurrence', ?3, ?4, ?5, ?6, ?7)
                     ON CONFLICT (series_id, original_start, scope)
                     DO UPDATE SET cancelled = ?3, starts = ?4, ends = ?5, title = ?6, description = ?7",
                    rusqlite::params![id, key, day.cancelled, day.starts, day.ends, day.title, day.description],
                )?;
            }
        }
        changed = true;
    }
    Ok(changed)
}

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

const PROPOSE_SCHEMA: &str = r#"{
  "type": "object", "required": ["title", "starts"], "additionalProperties": false,
  "properties": {
    "id": { "type": "string", "minLength": 1 },
    "title": { "type": "string", "maxLength": 1000 },
    "description": { "type": ["string", "null"] },
    "starts": { "type": "string", "minLength": 1,
      "description": "An instant (...Z), a wall clock in `zone`, a floating wall clock, or a date for an all-day event." },
    "ends": { "type": ["string", "null"],
      "description": "Exclusive for a timed event; the LAST day, inclusive, for an all-day one." },
    "timing": { "type": "string", "enum": ["zoned", "floating", "all-day"] },
    "zone": { "type": ["string", "null"], "description": "An IANA zone; with it a wall clock is that zone's." },
    "rule": { "type": ["string", "null"], "description": "An RFC 5545 recurrence rule." },
    "calendar_id": { "type": "string", "minLength": 1 },
    "place_id": { "type": ["string", "null"] },
    "url": { "type": ["string", "null"] },
    "reminders": { "type": ["array", "null"], "items": { "type": "integer", "minimum": 0 },
      "description": "Minutes before it starts." },
    "attendees": { "type": "array", "items": { "type": "string", "minLength": 1 } },
    "status": { "type": "string", "enum": ["confirmed", "tentative", "cancelled"] },
    "busy": { "type": "boolean" }
  }
}"#;

const EDIT_SCHEMA: &str = r#"{
  "type": "object", "required": ["id"], "additionalProperties": false,
  "properties": {
    "id": { "type": "string", "minLength": 1 },
    "title": { "type": "string", "maxLength": 1000 },
    "description": { "type": ["string", "null"] },
    "starts": { "type": "string", "minLength": 1 },
    "ends": { "type": ["string", "null"] },
    "timing": { "type": "string", "enum": ["zoned", "floating", "all-day"] },
    "zone": { "type": ["string", "null"] },
    "rule": { "type": ["string", "null"] },
    "calendar_id": { "type": "string", "minLength": 1 },
    "place_id": { "type": ["string", "null"] },
    "url": { "type": ["string", "null"] },
    "reminders": { "type": ["array", "null"], "items": { "type": "integer", "minimum": 0 } },
    "attendees": { "type": "array", "items": { "type": "string", "minLength": 1 } },
    "status": { "type": "string", "enum": ["confirmed", "tentative", "cancelled"] },
    "busy": { "type": "boolean" }
  }
}"#;

const OCCURRENCE_SCHEMA: &str = r#"{
  "type": "object", "required": ["id", "original_start", "scope", "action"], "additionalProperties": false,
  "properties": {
    "id": { "type": "string", "minLength": 1 },
    "original_start": { "type": "string", "minLength": 1,
      "description": "The series-local wall clock the rule produced for the day." },
    "scope": { "type": "string", "enum": ["occurrence", "future", "series"] },
    "action": { "type": "string", "enum": ["skip", "override", "restore"] },
    "title": { "type": "string" },
    "description": { "type": "string" },
    "starts": { "type": "string", "minLength": 1 },
    "ends": { "type": ["string", "null"] },
    "timing": { "type": "string", "enum": ["zoned", "floating", "all-day"] },
    "zone": { "type": ["string", "null"] }
  }
}"#;

#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    const PROPOSE: &[CommandCondition] = &[CommandCondition {
        predicate: "event_has_a_title_a_time_and_a_free_slot",
        check: pre_propose,
    }];
    const EDIT: &[CommandCondition] = &[CommandCondition {
        predicate: "event_is_live_and_its_change_resolves",
        check: pre_edit,
    }];
    const CANCEL: &[CommandCondition] = &[CommandCondition {
        predicate: "event_is_live",
        check: pre_cancel,
    }];
    const RESPOND: &[CommandCondition] = &[CommandCondition {
        predicate: "guest_is_invited_and_event_is_not_cancelled",
        check: pre_respond,
    }];
    const OCCURRENCE: &[CommandCondition] = &[CommandCondition {
        predicate: "day_is_one_the_series_lands_on",
        check: pre_occurrence,
    }];
    // An edit, a cancellation and a change to one day each restate a commitment
    // other people may hold: they are medium risk.
    let medium = |definition: CommandDefinition| CommandDefinition {
        risk: Risk::Medium,
        ..definition
    };
    vec![
        CommandDefinition::plain(
            "event.propose",
            "event",
            PROPOSE_SCHEMA,
            Idempotency::Once,
            PROPOSE,
            propose,
        ),
        medium(CommandDefinition::plain(
            "event.edit",
            "event",
            EDIT_SCHEMA,
            Idempotency::Idempotent,
            EDIT,
            edit,
        )),
        medium(CommandDefinition::plain(
            "event.cancel",
            "event",
            r#"{ "type": "object", "required": ["id"], "additionalProperties": false,
                 "properties": { "id": { "type": "string", "minLength": 1 } } }"#,
            Idempotency::RetrySafe,
            CANCEL,
            cancel,
        )),
        CommandDefinition::plain(
            "event.respond",
            "event",
            r#"{ "type": "object", "required": ["id", "person_id", "state"], "additionalProperties": false,
                 "properties": {
                   "id": { "type": "string", "minLength": 1 },
                   "person_id": { "type": "string", "minLength": 1 },
                   "state": { "type": "string", "enum": ["accepted", "declined", "tentative"] } } }"#,
            Idempotency::Idempotent,
            RESPOND,
            respond,
        ),
        medium(CommandDefinition::plain(
            "event.edit_occurrence",
            "event",
            OCCURRENCE_SCHEMA,
            Idempotency::Idempotent,
            OCCURRENCE,
            edit_occurrence,
        )),
    ]
}
