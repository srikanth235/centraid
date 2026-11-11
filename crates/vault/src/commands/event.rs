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
use crate::commands::entity::{STALE_GUARD, lookup_live, with_rev};
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
                            calendar_id, place_id, url, reminders, description, travel_min)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
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
            event.travel_min,
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

/// What one day of a series states of its own times, over the series': only what was said
/// (the rest is the series'), and how the day reads when that is not the way its series does.
#[derive(Debug, Default, PartialEq, Eq)]
struct DayTimes {
    starts: Option<String>,
    ends: Option<String>,
    /// The day's own timing and, for a zoned one, its zone; `None` while it reads as its series
    /// does ([#1146](https://github.com/srikanth235/centraid/issues/1146)).
    own: Option<(Semantics, Option<String>)>,
}

/// The times a day states over its `series`: `Err` is the sentence a member reads.
///
/// The series' end is a LENGTH a day borrows (it is not stored on the day), so it is never
/// carried over a day's own start, nor into another timing where it would not read.
fn day_times(
    stated: &serde_json::Map<String, Json>,
    series: &Times,
) -> std::result::Result<DayTimes, String> {
    let said = |key: &str| stated.get(key).and_then(Json::as_str).is_some();
    let other_timing = stated
        .get("timing")
        .and_then(Json::as_str)
        .and_then(parse_timing)
        .is_some_and(|timing| timing != series.timing);
    let base = Times {
        ends: (!said("starts") && !other_timing)
            .then(|| series.ends.clone())
            .flatten(),
        ..series.clone()
    };
    let at = resolve_times(stated, Some(&base))?;
    let own = (at.timing != series.timing
        || (at.timing == Semantics::Zoned && at.zone != series.zone))
        .then(|| {
            (
                at.timing,
                at.zone.clone().filter(|_| at.timing == Semantics::Zoned),
            )
        });
    Ok(DayTimes {
        starts: said("starts").then_some(at.starts),
        ends: stated.contains_key("ends").then_some(at.ends).flatten(),
        own,
    })
}

/// What a followed calendar states of an event, in the form the vault holds it:
/// a wall clock and its zone become the instant, so the statement a source makes
/// and the row it leaves compare equal.
pub(crate) fn shape(fields: &mut serde_json::Map<String, Json>) -> std::result::Result<(), String> {
    if let Some(alerts) = fields.get("reminders") {
        let alerts = alerts_text(alerts)?;
        fields.insert("reminders".to_owned(), alerts);
    }
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

/// What a refused save of an event keeps, in the form the vault holds it (`history.keep_version`):
/// the overlay's times (`event.starts`, `event.ends`, `event.timing`, `event.zone`) and alerts
/// (`event.reminders`) are stated as a source states them, so a wall clock and its zone become the
/// instant the row would hold and the alerts the one text of the column. A refused change to one day
/// is `occurrence`, an object stated as `event.edit_occurrence` states it (`original_start`, `scope`
/// and what the day changes), which becomes the row that command would have written. `Err` is a
/// sentence.
pub(crate) fn shape_overlay(
    connection: &rusqlite::Connection,
    id: &str,
    overlay: &mut serde_json::Map<String, Json>,
) -> std::result::Result<(), String> {
    const OWN: [&str; 5] = ["starts", "ends", "timing", "zone", "reminders"];
    let mut stated = serde_json::Map::new();
    for name in OWN {
        if let Some(value) = overlay.remove(&format!("event.{name}")) {
            stated.insert(name.to_owned(), value);
        }
    }
    shape(&mut stated)?;
    for (name, value) in stated {
        overlay.insert(format!("event.{name}"), value);
    }
    if let Some(day) = overlay.get(crate::history::DAY).and_then(Json::as_object) {
        let row = day_row(connection, id, day)?;
        overlay.insert(crate::history::DAY.to_owned(), row);
    }
    Ok(())
}

/// The `occurrence` row `event.edit_occurrence` (`override`) writes for what `day` states: only
/// what was stated is the day's own, the rest is the series'.
fn day_row(
    connection: &rusqlite::Connection,
    id: &str,
    day: &serde_json::Map<String, Json>,
) -> std::result::Result<Json, String> {
    let (Some(key), Some(scope)) = (
        day.get("original_start").and_then(Json::as_str),
        day.get("scope").and_then(Json::as_str),
    ) else {
        return Err(
            "`occurrence` names the day and whether it is the day or the days from it".into(),
        );
    };
    if !["occurrence", "future"].contains(&scope) {
        return Err("`occurrence` is one day or the days from it".to_owned());
    }
    let series =
        row_of(connection, id).map_err(|_| format!("there is nothing with the id `{id}`"))?;
    if series.rule.is_none() {
        return Err("That event does not repeat.".to_owned());
    }
    let times = day_times(day, &series.times)?;
    let said = |name: &str| day.get(name).and_then(Json::as_str);
    Ok(json!({
        "original_start": key, "scope": scope, "cancelled": 0,
        "starts": times.starts, "ends": times.ends,
        "timing": times.own.as_ref().map(|(timing, _)| timing.as_str()),
        "zone": times.own.as_ref().and_then(|(_, zone)| zone.as_deref()),
        "title": said("title"), "description": said("description"),
        "url": said("url"), "place_id": said("place_id"),
    }))
}

/// The alerts a source states (minutes before it starts), in the one text the `reminders` column
/// holds: a JSON array in the order stated, a minute once. No alert is `null`.
fn alerts_text(alerts: &Json) -> std::result::Result<Json, String> {
    let list: Vec<i64> = match alerts {
        Json::Null => return Ok(Json::Null),
        // Already the column's own text (a statement read back).
        Json::String(text) => match serde_json::from_str::<Json>(text) {
            Ok(Json::Array(list)) => list.iter().filter_map(Json::as_i64).collect(),
            _ => return Err("reminders are minutes before the start".to_owned()),
        },
        Json::Array(list) => list
            .iter()
            .map(|minutes| {
                minutes
                    .as_i64()
                    .filter(|minutes| *minutes >= 0)
                    .ok_or_else(|| "reminders are minutes before the start".to_owned())
            })
            .collect::<std::result::Result<_, _>>()?,
        _ => return Err("reminders are minutes before the start".to_owned()),
    };
    let mut seen = BTreeSet::new();
    let list: Vec<i64> = list
        .into_iter()
        .filter(|minutes| seen.insert(*minutes))
        .collect();
    Ok(if list.is_empty() {
        Json::Null
    } else {
        Json::String(json!(list).to_string())
    })
}

// ---------------------------------------------------------------------------
// The guests a phone states
// ---------------------------------------------------------------------------

/// One guest a phone states, in the one form two statements of the same guest share: an email
/// (lower case), a name and an answer of [`ANSWERS`].
fn guest_canon(guest: &Json) -> Json {
    let text = |key: &str| {
        guest
            .get(key)
            .and_then(Json::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
    };
    let state = text("state")
        .filter(|state| ANSWERS.contains(state))
        .unwrap_or("needs-action");
    let mut out = serde_json::Map::new();
    if let Some(name) = text("name") {
        out.insert("name".to_owned(), name.into());
    }
    if let Some(email) = text("email") {
        out.insert("email".to_owned(), email.to_lowercase().into());
    }
    out.insert("state".to_owned(), state.into());
    Json::Object(out)
}

/// `attendees`, canonical: each guest in its one form, in a stable order.
pub(crate) fn attendees_canon(statement: &Json) -> Json {
    let Some(list) = statement.as_array() else {
        return statement.clone();
    };
    let mut guests: Vec<Json> = list.iter().map(guest_canon).collect();
    guests.sort_by_key(Json::to_string);
    Json::Array(guests)
}

/// The guests of a canonical list by the key that names each across statements: their email, or
/// their name when they have none.
pub(crate) fn attendees_items(guests: &Json) -> std::collections::BTreeMap<String, Json> {
    let mut out = std::collections::BTreeMap::new();
    for guest in guests.as_array().into_iter().flatten() {
        let key = guest
            .get("email")
            .and_then(Json::as_str)
            .map(str::to_owned)
            .or_else(|| {
                guest
                    .get("name")
                    .and_then(Json::as_str)
                    .map(|name| format!("name:{}", name.to_lowercase()))
            });
        if let Some(key) = key {
            out.entry(key).or_insert_with(|| guest.clone());
        }
    }
    out
}

/// The live person an email is, by an exact match with one of their email points.
fn person_of_email(connection: &Connection, email: &str) -> Result<Option<String>> {
    let key = crate::commands::contact_point::reach_key("email", email);
    Ok(connection
        .query_row(
            "SELECT p.person_id FROM contact_point p JOIN entity e ON e.id = p.person_id
              WHERE p.kind = 'email' AND p.normalized = ?1 AND e.deleted_at IS NULL
              ORDER BY p.person_id LIMIT 1",
            [&key],
            |row| row.get(0),
        )
        .optional()?)
}

/// The people the guests of a statement are, by an exact email match with a live person's email,
/// with the answer each gave.
fn matched_guests(
    connection: &Connection,
    statement: Option<&Json>,
) -> Result<std::collections::BTreeMap<String, String>> {
    let mut people = std::collections::BTreeMap::new();
    for guest in statement.and_then(Json::as_array).into_iter().flatten() {
        let guest = guest_canon(guest);
        let (Some(email), Some(state)) = (
            guest.get("email").and_then(Json::as_str),
            guest.get("state").and_then(Json::as_str),
        ) else {
            continue;
        };
        if let Some(person) = person_of_email(connection, email)? {
            people.insert(person, state.to_owned());
        }
    }
    Ok(people)
}

/// The people the guests of a statement were matched to when the statement was merged
/// ([`attendees_stamp`]), with the answer each gave. A guest with no note matched nobody then.
fn merged_guests(statement: Option<&Json>) -> std::collections::BTreeMap<String, String> {
    let mut people = std::collections::BTreeMap::new();
    for guest in statement.and_then(Json::as_array).into_iter().flatten() {
        let Some(person) = guest.get("person").and_then(Json::as_str) else {
            continue;
        };
        let state = guest_canon(guest)
            .get("state")
            .and_then(Json::as_str)
            .unwrap_or("needs-action")
            .to_owned();
        people.insert(person.to_owned(), state);
    }
    people
}

/// Note on each stated guest the person it was matched to when the statement was merged (a
/// `person` key; [`guest_canon`] leaves it out, so it never counts as a difference). A pass that
/// did not merge the guests keeps the notes already there. This is what lets a later merge tell a
/// guest the member took off (matched then, no edge now) from one who matches a person only now
/// (matched then: nobody), and so attach her.
pub(crate) fn attendees_stamp(
    connection: &Connection,
    before: Option<&Json>,
    now: &Json,
    merged: bool,
) -> Result<Json> {
    let Some(list) = now.as_array() else {
        return Ok(now.clone());
    };
    let noted = |email: &str| {
        before
            .and_then(Json::as_array)
            .into_iter()
            .flatten()
            .find(|guest| guest_canon(guest).get("email").and_then(Json::as_str) == Some(email))
            .and_then(|guest| guest.get("person").cloned())
    };
    let mut out = Vec::with_capacity(list.len());
    for guest in list {
        let mut guest = guest.clone();
        let email = guest_canon(&guest)
            .get("email")
            .and_then(Json::as_str)
            .map(str::to_owned);
        if let Some(object) = guest.as_object_mut() {
            object.remove("person");
            let person = match email.as_deref() {
                Some(email) if merged => person_of_email(connection, email)?.map(Json::String),
                Some(email) => noted(email),
                None => None,
            };
            if let Some(person) = person {
                object.insert("person".to_owned(), person);
            }
        }
        out.push(guest);
    }
    Ok(Json::Array(out))
}

/// The answer each person the event has an `attendee` edge to holds now (a blank answer is
/// `needs-action`, as a statement spells it).
fn held_guests(
    connection: &Connection,
    id: &str,
) -> Result<std::collections::BTreeMap<String, String>> {
    connection
        .prepare_cached(
            "SELECT to_id, state FROM edge WHERE from_id = ?1 AND rel = 'attendee' ORDER BY to_id",
        )?
        .query_map([id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })?
        .map(|row| {
            row.map(|(person, state)| {
                (
                    person,
                    state
                        .filter(|state| ANSWERS.contains(&state.as_str()))
                        .unwrap_or_else(|| "needs-action".to_owned()),
                )
            })
        })
        .collect::<rusqlite::Result<_>>()
        .map_err(Into::into)
}

/// The guests the event holds, in the form a phone states them: the guests the source last stated
/// stand as stated unless they are a person's, and a person's carry the answer the vault holds (a
/// guest whose edge the member took away is not there); a person the member added as a guest
/// follows, by name and first email.
pub(crate) fn attendees_read(connection: &Connection, id: &str) -> Result<Json> {
    let stated: Option<String> = connection
        .query_row(
            "SELECT stated FROM source WHERE entity_id = ?1",
            [id],
            |row| row.get(0),
        )
        .optional()?;
    let stated = stated
        .and_then(|text| serde_json::from_str::<Json>(&text).ok())
        .and_then(|stated| stated.get("attendees").cloned());
    let mut held = held_guests(connection, id)?;
    let mut covered = std::collections::BTreeSet::new();
    let mut out = Vec::new();
    for guest in stated
        .as_ref()
        .and_then(Json::as_array)
        .into_iter()
        .flatten()
    {
        let noted = guest
            .get("person")
            .and_then(Json::as_str)
            .map(str::to_owned);
        let mut guest = guest_canon(guest);
        // The person the guest was merged as, else (never merged as anyone) the person the
        // member made of her since, if they hold her as a guest.
        let (person, merged) = match noted {
            Some(person) => (Some(person), true),
            None => {
                let today = match guest.get("email").and_then(Json::as_str) {
                    Some(email) => person_of_email(connection, email)?,
                    None => None,
                };
                (today.filter(|person| held.contains_key(person)), false)
            }
        };
        let Some(person) = person else {
            out.push(guest);
            continue;
        };
        // A person's guest carries the answer held, and a guest merged as a person is not there
        // when the edge is gone. The people the member added are the edges left once the stated
        // guests are accounted for.
        if let Some(state) = held.get(&person) {
            guest["state"] = Json::String(state.clone());
            out.push(guest);
        } else if !merged {
            out.push(guest);
        }
        covered.insert(person);
    }
    held.retain(|person, _| !covered.contains(person));
    for (person, state) in held {
        let (name, email): (String, Option<String>) = connection.query_row(
            "SELECT e.title, (SELECT value FROM contact_point
                               WHERE person_id = e.id AND kind = 'email'
                               ORDER BY position, id LIMIT 1)
               FROM entity e WHERE e.id = ?1",
            [&person],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let mut guest = json!({ "name": name, "state": state });
        if let Some(email) = email {
            guest["email"] = Json::String(email.to_lowercase());
        }
        out.push(guest_canon(&guest));
    }
    Ok(attendees_canon(&Json::Array(out)))
}

/// The follower's `attendees` merge, **per guest**: a guest the phone states whose email is a
/// person's becomes that person's `attendee` edge, with the answer the phone states; one the
/// phone no longer states is taken off. A guest the member has not changed (the edge holds the
/// answer the phone last stated, or there is no edge and the phone had no answer) takes the
/// phone's word; one the member changed (answered differently, took off, or added) stands. A
/// guest nobody's email matches mints no person and stays in the statement
/// ([`attendees_read`]). Guests are read from the phone and never written to it.
///
/// What the phone "had" said is the guests the last merge matched to people, as noted in the
/// statement ([`attendees_stamp`]), not who the guests match today: a guest whose email became a
/// person's after that merge was never attached or taken off, so she is attached now. A statement
/// from before the notes were kept notes nobody, so each of its guests is attached once.
pub(crate) fn attendees_merge(
    ctx: &CommandCtx<'_, '_>,
    id: &str,
    before: Option<&Json>,
    now: &Json,
) -> Result<bool> {
    let connection = ctx.connection();
    let wanted = matched_guests(connection, Some(now))?;
    let had = merged_guests(before);
    let held = held_guests(connection, id)?;
    let people: std::collections::BTreeSet<&String> = wanted.keys().chain(had.keys()).collect();
    let mut changed = false;
    for person in people {
        let (mine, said, wants) = (held.get(person), had.get(person), wanted.get(person));
        // The member changed this guest, or there is nothing to change: it stands.
        if mine != said || mine == wants {
            continue;
        }
        match wants {
            None => {
                changed |= connection.execute(
                    "DELETE FROM edge WHERE from_id = ?1 AND rel = 'attendee' AND to_id = ?2",
                    [id, person],
                )? > 0;
            }
            Some(state) => {
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
                changed = true;
            }
        }
    }
    Ok(changed)
}

/// Make the guests what the phone last stated (one guest, named by its [`attendees_items`] key,
/// or all): a person's answer is put back, a guest the member added is taken off, and one they took
/// off is invited again with the stated answer. A guest nobody's email matches is only in the
/// statement and has nothing to put back. Returns whether an edge changed.
pub(crate) fn attendees_take(
    ctx: &CommandCtx<'_, '_>,
    id: &str,
    item: Option<&str>,
    stated: &Json,
) -> Result<bool> {
    let connection = ctx.connection();
    let wanted = matched_guests(connection, Some(stated))?;
    let held = held_guests(connection, id)?;
    // The key each person goes by: the stated guest's email, else how the read names a guest the
    // member added.
    let mut keys = std::collections::BTreeMap::new();
    for guest in stated.as_array().into_iter().flatten() {
        let guest = guest_canon(guest);
        if let Some(email) = guest.get("email").and_then(Json::as_str)
            && let Some(person) = person_of_email(connection, email)?
        {
            keys.entry(person).or_insert_with(|| email.to_owned());
        }
    }
    for person in held.keys() {
        if keys.contains_key(person) {
            continue;
        }
        let name: String =
            connection.query_row("SELECT title FROM entity WHERE id = ?1", [person], |row| {
                row.get(0)
            })?;
        let email: Option<String> = connection
            .query_row(
                "SELECT value FROM contact_point WHERE person_id = ?1 AND kind = 'email'
                  ORDER BY position, id LIMIT 1",
                [person],
                |row| row.get(0),
            )
            .optional()?;
        let key = email.map_or_else(
            || format!("name:{}", name.to_lowercase()),
            |email| email.to_lowercase(),
        );
        keys.insert(person.clone(), key);
    }
    let people: std::collections::BTreeSet<&String> = wanted.keys().chain(held.keys()).collect();
    let mut changed = false;
    for person in people {
        if item.is_some_and(|item| keys.get(person).map(String::as_str) != Some(item)) {
            continue;
        }
        let (mine, wants) = (held.get(person), wanted.get(person));
        if mine == wants {
            continue;
        }
        match wants {
            None => {
                changed |= connection.execute(
                    "DELETE FROM edge WHERE from_id = ?1 AND rel = 'attendee' AND to_id = ?2",
                    [id, person],
                )? > 0;
            }
            Some(state) => {
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
                changed = true;
            }
        }
    }
    Ok(changed)
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

/// The distinct keys the series' occurrence rows carry, in order.
fn override_keys(connection: &Connection, id: &str) -> Result<Vec<String>> {
    Ok(connection
        .prepare("SELECT DISTINCT original_start FROM occurrence WHERE series_id = ?1 ORDER BY 1")?
        .query_map([id], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?)
}

/// The days the series produces over the span its `keys` cover, by series-local
/// wall clock; `None` when the span cannot be searched (the caller then treats
/// every key as stranded).
fn live_days(times: &Times, rule: &str, keys: &[String]) -> Option<BTreeSet<String>> {
    let (first, last) = (keys.first()?, keys.last()?);
    let ((from, _), (_, to)) = (
        search_window(first, SEARCH_WINDOW_DAYS)?,
        search_window(last, SEARCH_WINDOW_DAYS)?,
    );
    Some(
        expand_series(times, rule, &from, &to, 2_000)
            .into_iter()
            .map(|occurrence| occurrence.wall_start)
            .collect(),
    )
}

/// How many of the series' occurrence rows match no day of the series as it is.
fn stranded(connection: &Connection, id: &str, times: &Times, rule: Option<&str>) -> Result<usize> {
    let keys = override_keys(connection, id)?;
    if keys.is_empty() {
        return Ok(0);
    }
    let Some(live) = rule.and_then(|rule| live_days(times, rule, &keys)) else {
        return Ok(keys.len());
    };
    Ok(keys.iter().filter(|key| !live.contains(*key)).count())
}

/// A followed series whose rule or start moved: every override that no day of the
/// series lands on any more is **re-keyed** to the day the series now has on the
/// same date when there is exactly one (a standup moved from nine to ten keeps its
/// skipped week), and dropped otherwise, so the series never holds a row no
/// occurrence will read ([#1146](https://github.com/srikanth235/centraid/issues/1146)).
/// A series whose rule the expander cannot read is left as it is.
fn rekey_stranded(connection: &Connection, id: &str) -> Result<()> {
    let keys = override_keys(connection, id)?;
    if keys.is_empty() {
        return Ok(());
    }
    let row = row_of(connection, id)?;
    let live = match row.rule.as_deref() {
        None => BTreeSet::new(),
        Some(rule) if rrule::inspect(rule).is_err() => return Ok(()),
        Some(rule) => live_days(&row.times, rule, &keys).unwrap_or_default(),
    };
    for key in keys.iter().filter(|key| !live.contains(*key)) {
        let date = key.get(..10).unwrap_or(key);
        let same_date: Vec<&String> = live
            .iter()
            .filter(|day| day.get(..10).unwrap_or(day) == date)
            .collect();
        match same_date.as_slice() {
            [target] => {
                // A day the target already has an override for keeps its own.
                connection.execute(
                    "UPDATE OR IGNORE occurrence SET original_start = ?3
                      WHERE series_id = ?1 AND original_start = ?2",
                    rusqlite::params![id, key, target],
                )?;
                connection.execute(
                    "DELETE FROM occurrence WHERE series_id = ?1 AND original_start = ?2",
                    [id, key],
                )?;
            }
            _ => {
                connection.execute(
                    "DELETE FROM occurrence WHERE series_id = ?1 AND original_start = ?2",
                    [id, key],
                )?;
            }
        }
    }
    Ok(())
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
    Ok(times(ctx, None).err())
}

/// A busy event does not land on another busy one: its own condition, so a caller that can lift
/// the refusal by choosing another time (the on-device assistant asks) tells it from every other
/// by the id and not by the sentence.
fn pre_free_slot(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    match times(ctx, None) {
        // the title-and-time condition has already said so
        Err(_) => Ok(None),
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
    if action != "override" {
        return Ok(None);
    }
    let day = match day_times(
        ctx.input.as_object().unwrap_or(&serde_json::Map::new()),
        &row.times,
    ) {
        Ok(day) => day,
        Err(sentence) => return Ok(Some(sentence)),
    };
    if scope == "future" && day.own.is_some() {
        return Ok(Some(
            "A change of timing is for one day, not for every day after.".to_owned(),
        ));
    }
    if let Some(place) = ctx.optional_str("place_id") {
        return points_at(ctx, place, Kind::Place);
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
            travel_min: ctx.input.get("travel_min").and_then(Json::as_i64),
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
        "travel_min",
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
    with_rev(ctx, id, json!({ "id": id }))
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

/// What happened to one day of a series, or to the series as a whole; with the event's revision
/// when the change named the one it replaces.
fn edit_occurrence(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let id = ctx.required_str("id")?;
    with_rev(ctx, id, change_occurrence(ctx)?)
}

fn change_occurrence(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
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
        let mut day = DayTimes::default();
        if !skipped {
            let row = row_of(connection, id)?;
            // Only what was stated is the day's own; the rest is the series'.
            day = day_times(
                ctx.input.as_object().unwrap_or(&serde_json::Map::new()),
                &row.times,
            )
            .map_err(|s| invalid("starts", s))?;
        }
        let said = |name: &str| {
            if skipped {
                None
            } else {
                ctx.optional_str(name)
            }
        };
        connection.execute(
            "INSERT INTO occurrence (series_id, original_start, scope, cancelled, starts, ends,
                                     timing, zone, title, description, url, place_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT (series_id, original_start, scope)
             DO UPDATE SET cancelled = ?4, starts = ?5, ends = ?6, timing = ?7, zone = ?8,
                           title = ?9, description = ?10, url = ?11, place_id = ?12",
            rusqlite::params![
                id,
                key,
                scope,
                skipped,
                day.starts,
                day.ends,
                day.own.as_ref().map(|(timing, _)| timing.as_str()),
                day.own.as_ref().and_then(|(_, zone)| zone.as_deref()),
                said("title"),
                said("description"),
                said("url"),
                said("place_id"),
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
    // The rule or the start may have moved: no day is left that nothing reads.
    rekey_stranded(ctx.connection(), id)
}

/// What happened to one day of a series, as the row holds it.
#[derive(Debug, Clone)]
struct Day {
    cancelled: bool,
    starts: Option<String>,
    ends: Option<String>,
    /// How the day reads when it is not as its series does, and the zone of a zoned one.
    timing: Option<String>,
    zone: Option<String>,
    title: Option<String>,
    description: Option<String>,
    url: Option<String>,
    /// The NAME of the day's own place: a phone states a place by its words, and the vault finds
    /// or founds the place only when it writes the day.
    place: Option<String>,
}

impl PartialEq for Day {
    fn eq(&self, other: &Self) -> bool {
        let place = |day: &Self| day.place.as_deref().map(|name| name.trim().to_lowercase());
        (
            self.cancelled,
            &self.starts,
            &self.ends,
            &self.timing,
            &self.zone,
        ) == (
            other.cancelled,
            &other.starts,
            &other.ends,
            &other.timing,
            &other.zone,
        ) && (&self.title, &self.description, &self.url)
            == (&other.title, &other.description, &other.url)
            && place(self) == place(other)
    }
}

impl Eq for Day {}

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
    let (times, rule, title, description, url): (
        Times,
        Option<String>,
        String,
        Option<String>,
        Option<String>,
    ) = {
        let row = row_of(connection, id)?;
        let (title, description, url) = connection.query_row(
            "SELECT e.title, v.description, v.url FROM event v JOIN entity e ON e.id = v.id
              WHERE v.id = ?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        (row.times, row.rule, title, description, url)
    };
    let mut derived = Derived {
        window: BTreeSet::new(),
        rows: std::collections::BTreeMap::new(),
    };
    let Some(rule) = rule.filter(|rule| rrule::inspect(rule).is_ok()) else {
        return Ok(derived);
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
            // The day's own timing, when the phone says one that is not its series'.
            let timing = text_of("timing")
                .and_then(parse_timing)
                .unwrap_or(times.timing);
            let day_zone = if timing == Semantics::Zoned {
                text_of("zone")
                    .map(str::to_owned)
                    .or_else(|| times.zone.clone())
            } else {
                None
            };
            let own =
                timing != times.timing || (timing == Semantics::Zoned && day_zone != times.zone);
            let zone = day_zone
                .as_deref()
                .and_then(|name| FireZone::named(name).ok());
            let at = |value: Option<&str>| {
                value.and_then(|value| resolve_one("starts", value, timing, zone.as_ref()).ok())
            };
            let starts = at(text_of("starts")).filter(|starts| own || *starts != occurrence.start);
            Day {
                cancelled: false,
                ends: starts.as_ref().and_then(|_| at(text_of("ends"))),
                starts,
                timing: own.then(|| timing.as_str().to_owned()),
                zone: day_zone.filter(|_| own && timing == Semantics::Zoned),
                title: text("title", Some(&title)),
                description: text("description", description.as_deref()),
                url: text("url", url.as_deref()),
                place: text("location", None),
            }
        } else if said.shown.contains(&key) {
            continue;
        } else {
            Day {
                cancelled: true,
                starts: None,
                ends: None,
                timing: None,
                zone: None,
                title: None,
                description: None,
                url: None,
                place: None,
            }
        };
        // A day the phone calls moved and says nothing different of is the series' own.
        if day.starts.is_some()
            || day.cancelled
            || day.title.is_some()
            || day.description.is_some()
            || day.url.is_some()
            || day.place.is_some()
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
            "SELECT o.original_start, o.cancelled, o.starts, o.ends, o.timing, o.zone, o.title,
                    o.description, o.url, p.title
               FROM occurrence o LEFT JOIN entity p ON p.id = o.place_id
              WHERE o.series_id = ?1 AND o.scope = 'occurrence'",
        )?
        .query_map([id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                Day {
                    cancelled: row.get(1)?,
                    starts: row.get(2)?,
                    ends: row.get(3)?,
                    timing: row.get(4)?,
                    zone: row.get(5)?,
                    title: row.get(6)?,
                    description: row.get(7)?,
                    url: row.get(8)?,
                    place: row.get(9)?,
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
        json!({ "held": inside(&rows).iter().map(|(key, day)| json!([key, day.cancelled, day.starts, day.title, day.timing, day.url, day.place])).collect::<Vec<_>>() })
    })
}

pub(crate) fn overrides_canon(statement: &Json) -> Json {
    statement.clone()
}

/// Make one day of a series what the rule and a statement imply (`None`: no row of its own).
fn write_day(ctx: &CommandCtx<'_, '_>, id: &str, key: &str, wanted: Option<&Day>) -> Result<()> {
    let connection = ctx.connection();
    match wanted {
        None => {
            connection.execute(
                "DELETE FROM occurrence WHERE series_id = ?1 AND original_start = ?2
                                          AND scope = 'occurrence'",
                [id, key],
            )?;
        }
        Some(day) => {
            let place = day
                .place
                .as_deref()
                .map(|name| crate::commands::place::find_or_found_named(ctx, name))
                .transpose()?;
            connection.execute(
                "INSERT INTO occurrence (series_id, original_start, scope, cancelled, starts,
                                         ends, timing, zone, title, description, url, place_id)
                 VALUES (?1, ?2, 'occurrence', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                 ON CONFLICT (series_id, original_start, scope)
                 DO UPDATE SET cancelled = ?3, starts = ?4, ends = ?5, timing = ?6, zone = ?7,
                               title = ?8, description = ?9, url = ?10, place_id = ?11",
                rusqlite::params![
                    id,
                    key,
                    day.cancelled,
                    day.starts,
                    day.ends,
                    day.timing,
                    day.zone,
                    day.title,
                    day.description,
                    day.url,
                    place
                ],
            )?;
        }
    }
    Ok(())
}

/// Put a series' days back to what its source's statement implies, every day of the window the
/// statement covers: the member's skips and changes there are undone. Returns whether a day changed.
pub(crate) fn overrides_take(
    ctx: &CommandCtx<'_, '_>,
    id: &str,
    _item: Option<&str>,
    stated: &Json,
) -> Result<bool> {
    let connection = ctx.connection();
    let Some(said) = observed(stated) else {
        return Ok(false);
    };
    let (after, rows) = (derive(connection, id, &said)?, held(connection, id)?);
    let mut changed = false;
    for key in &after.window {
        let wanted = after.rows.get(key);
        if wanted != rows.get(key) {
            write_day(ctx, id, key, wanted)?;
            changed = true;
        }
    }
    Ok(changed)
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
        write_day(ctx, id, key, wanted)?;
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
    "travel_min": { "type": ["integer", "null"], "minimum": 0,
      "description": "Minutes of travel to allow before it starts." },
    "reminders": { "type": ["array", "null"], "items": { "type": "integer", "minimum": 0 },
      "description": "Minutes before it starts, one per alert: the first and a second." },
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
    "travel_min": { "type": ["integer", "null"], "minimum": 0 },
    "reminders": { "type": ["array", "null"], "items": { "type": "integer", "minimum": 0 } },
    "attendees": { "type": "array", "items": { "type": "string", "minLength": 1 } },
    "status": { "type": "string", "enum": ["confirmed", "tentative", "cancelled"] },
    "busy": { "type": "boolean" },
    "expected_rev": { "type": "integer", "minimum": 0 }
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
    "timing": { "type": "string", "enum": ["zoned", "floating", "all-day"],
      "description": "How this one day reads, when not as its series does." },
    "zone": { "type": ["string", "null"] },
    "url": { "type": ["string", "null"], "description": "This day's own link; the series' when none." },
    "place_id": { "type": ["string", "null"], "description": "This day's own place; the series' when none." },
    "expected_rev": { "type": "integer", "minimum": 0 }
  }
}"#;

#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    const PROPOSE: &[CommandCondition] = &[
        CommandCondition {
            predicate: "event_has_a_title_and_a_time",
            check: pre_propose,
        },
        CommandCondition {
            predicate: "no_busy_conflict",
            check: pre_free_slot,
        },
    ];
    const EDIT: &[CommandCondition] = &[
        STALE_GUARD[0],
        STALE_GUARD[1],
        CommandCondition {
            predicate: "event_is_live_and_its_change_resolves",
            check: pre_edit,
        },
    ];
    const CANCEL: &[CommandCondition] = &[CommandCondition {
        predicate: "event_is_live",
        check: pre_cancel,
    }];
    const RESPOND: &[CommandCondition] = &[CommandCondition {
        predicate: "guest_is_invited_and_event_is_not_cancelled",
        check: pre_respond,
    }];
    const OCCURRENCE: &[CommandCondition] = &[
        STALE_GUARD[0],
        STALE_GUARD[1],
        CommandCondition {
            predicate: "day_is_one_the_series_lands_on",
            check: pre_occurrence,
        },
    ];
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
