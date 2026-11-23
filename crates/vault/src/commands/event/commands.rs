//! Preconditions, handlers, schemas, and definitions for `event.*` commands.

use std::collections::BTreeSet;

use serde_json::{Value as Json, json};

use crate::commands::edge::{self, Extras};
use crate::commands::entity::{STALE_GUARD, lookup_live, with_rev};
use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency, Risk};
use crate::error::{Result, VaultError};
use crate::model::{Kind, Rel};
use crate::time::recurrence::Semantics;
use crate::time::rrule;

use super::times::{
    DayTimes, Times, day_times, occurrence_at, row_of, rule_refusal, stranded, times,
};
use super::{NewEvent, found, set_reminders};

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

fn reminders_of(ctx: &CommandCtx<'_, '_>) -> Vec<i64> {
    ctx.input
        .get("reminders")
        .and_then(Json::as_array)
        .map(|list| list.iter().filter_map(Json::as_i64).collect())
        .unwrap_or_default()
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

#[derive(serde::Deserialize)]
struct ProposeInput {
    id: Option<String>,
    title: String,
    rule: Option<String>,
    calendar_id: Option<String>,
    description: Option<String>,
    place_id: Option<String>,
    url: Option<String>,
    travel_min: Option<i64>,
    status: Option<String>,
    busy: Option<bool>,
}

fn propose(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let input: ProposeInput = ctx.parse_input()?;
    let times = times(ctx, None).map_err(|sentence| invalid("starts", sentence))?;
    let reminders = reminders_of(ctx);
    let rule = input.rule.as_deref().map(rrule::canonicalize);
    let id = found(
        ctx,
        &NewEvent {
            id: input.id.as_deref(),
            title: &input.title,
            starts: &times.starts,
            ends: times.ends.as_deref(),
            timing: times.timing,
            zone: times.zone.as_deref(),
            rule: rule.as_deref(),
            calendar_id: input.calendar_id.as_deref(),
            reminders: &reminders,
            description: input.description.as_deref(),
            place_id: input.place_id.as_deref(),
            url: input.url.as_deref(),
            travel_min: input.travel_min,
            status: input.status.as_deref(),
            busy: input.busy,
        },
    )?;
    let invited = guests(ctx);
    set_guests(ctx, &id, &invited)?;
    Ok(json!({ "id": id, "attendees": invited.len() }))
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
        set_reminders(connection, id, &reminders_of(ctx))?;
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
    Ok(answer)
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
      "description": "Minutes before it starts, one per alert (at most two in the editor). Held as a set and read longest lead first." },
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
