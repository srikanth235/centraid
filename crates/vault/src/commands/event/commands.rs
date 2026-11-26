//! Preconditions, handlers, schemas, and definitions for `event.*` commands.

use serde_json::{Value as Json, json};

use crate::commands::entity::{self, STALE_GUARD, lookup_live, with_rev};
use crate::commands::reminder::{self, MAX_OFFSET_MIN};
use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency, Risk};
use crate::error::{Result, VaultError};
use crate::model::{DEFAULT_CALENDAR_ID, Kind};
use crate::time::rrule;

use super::guests::{self, GuestIn};
use super::split;
use super::times::{
    DayTimes, Times, day_times, occurrence_at, rekey_stranded, row_of, rule_refusal, times,
};
use super::{NewEvent, found};

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

/// A live place a command points at.
fn place_refusal(ctx: &CommandCtx<'_, '_>, id: &str) -> Result<Option<String>> {
    Ok(match lookup_live(ctx.connection(), id)? {
        Err(sentence) => Some(sentence),
        Ok(found) if found.kind != Kind::Place => Some(format!(
            "“{}” is a {}, not a place",
            found.title,
            found.kind.noun()
        )),
        Ok(_) => None,
    })
}

/// What a command's words about where and about whom point at: the place it names, the words it
/// gives for where, the guests it lists and the alerts it sets.
fn references_refusal(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if let Some(id) = ctx.optional_str("place_id")
        && let Some(sentence) = place_refusal(ctx, id)?
    {
        return Ok(Some(sentence));
    }
    if let Some(words) = ctx.optional_str("location")
        && words.trim().is_empty()
    {
        return Ok(Some(
            "where it is says something; clear it instead of leaving it blank".to_owned(),
        ));
    }
    if let Some(guests) = guests_stated(ctx)?
        && let Some(sentence) = guests::refusal(ctx.connection(), &guests)?
    {
        return Ok(Some(sentence));
    }
    if let Some(leads) = ctx.input.get("reminders").and_then(Json::as_array)
        && leads.iter().any(|lead| {
            !lead
                .as_i64()
                .is_some_and(|m| (0..=MAX_OFFSET_MIN).contains(&m))
        })
    {
        return Ok(Some(
            "a reminder comes 0 minutes to a year before, not after".to_owned(),
        ));
    }
    Ok(None)
}

fn guests_stated(ctx: &CommandCtx<'_, '_>) -> Result<Option<Vec<GuestIn>>> {
    match ctx.input.get("guests") {
        None | Some(Json::Null) => Ok(None),
        Some(list) => serde_json::from_value(list.clone())
            .map(Some)
            .map_err(|error| VaultError::InvalidInput {
                name: "guests".to_owned(),
                detail: error.to_string(),
            }),
    }
}

fn rule_stated_refusal(ctx: &CommandCtx<'_, '_>) -> Option<String> {
    ctx.optional_str("rule").and_then(rule_refusal)
}

fn pre_propose(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if ctx.required_str("title")?.trim().is_empty() {
        return Ok(Some("an event needs a title".to_owned()));
    }
    if let Some(id) = ctx.optional_str("id")
        && entity::find(ctx.connection(), id)?.is_some()
    {
        return Ok(Some("an event with that id already exists".to_owned()));
    }
    if let Some(sentence) = rule_stated_refusal(ctx) {
        return Ok(Some(sentence));
    }
    if let Some(sentence) = entity::home_refusal(
        ctx.connection(),
        Kind::Event,
        None,
        Some(
            ctx.optional_str("calendar_id")
                .unwrap_or(DEFAULT_CALENDAR_ID),
        ),
    )? {
        return Ok(Some(sentence));
    }
    if let Some(sentence) = references_refusal(ctx)? {
        return Ok(Some(sentence));
    }
    Ok(times(ctx, None).err())
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
    let row = row_of(ctx.connection(), ctx.required_str("id")?)?;
    Ok(times(ctx, Some(&row.times)).err())
}

fn pre_split(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if let Some(sentence) = pre_edit(ctx)? {
        return Ok(Some(sentence));
    }
    let row = row_of(ctx.connection(), ctx.required_str("id")?)?;
    let Some(rule) = row.rule.as_deref() else {
        return Ok(Some("That event does not repeat.".to_owned()));
    };
    if rrule::inspect(rule).is_err() {
        return Ok(Some(
            "That series repeats by a rule this vault cannot read, so it cannot be split."
                .to_owned(),
        ));
    }
    if occurrence_at(&row.times, rule, ctx.required_str("original_start")?).is_none() {
        return Ok(Some("That day is not one the event lands on.".to_owned()));
    }
    Ok(None)
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
    let (address, person) = (ctx.optional_str("address"), ctx.optional_str("person_id"));
    if address.is_none() && person.is_none() {
        return Ok(Some(
            "say which guest answers: a person or an address".to_owned(),
        ));
    }
    let invited: bool = ctx.connection().query_row(
        "SELECT EXISTS (SELECT 1 FROM event_guest
                         WHERE event_id = ?1
                           AND ((?2 IS NOT NULL AND address = ?2) OR (?3 IS NOT NULL AND person_id = ?3)))",
        rusqlite::params![id, address.map(guests::address_key), person],
        |row| row.get(0),
    )?;
    Ok((!invited).then(|| "That guest is not invited to this event.".to_owned()))
}

fn pre_add_guest(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if let Err(sentence) = live_event(ctx, "id")? {
        return Ok(Some(sentence));
    }
    if row_of(ctx.connection(), ctx.required_str("id")?)?.status == "cancelled" {
        return Ok(Some("That event is cancelled.".to_owned()));
    }
    let guest: GuestIn = ctx.parse_input()?;
    guests::refusal(ctx.connection(), &[guest])
}

fn pre_occurrence(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if let Err(sentence) = live_event(ctx, "id")? {
        return Ok(Some(sentence));
    }
    let id = ctx.required_str("id")?;
    let row = row_of(ctx.connection(), id)?;
    let Some(rule) = row.rule.as_deref() else {
        return Ok(Some("That event does not repeat.".to_owned()));
    };
    let (key, action) = (
        ctx.required_str("original_start")?,
        ctx.required_str("action")?,
    );
    if action == "restore" {
        return Ok(None);
    }
    if occurrence_at(&row.times, rule, key).is_none() {
        return Ok(Some("That day is not one the event lands on.".to_owned()));
    }
    if action != "override" {
        return Ok(None);
    }
    if let Err(sentence) = day_times(
        ctx.input.as_object().unwrap_or(&serde_json::Map::new()),
        &row.times,
    ) {
        return Ok(Some(sentence));
    }
    if let Some(words) = ctx.optional_str("location")
        && words.trim().is_empty()
    {
        return Ok(Some(
            "where it is says something; clear it instead of leaving it blank".to_owned(),
        ));
    }
    if let Some(place) = ctx.optional_str("place_id") {
        return place_refusal(ctx, place);
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

#[derive(serde::Deserialize)]
struct ProposeInput {
    id: Option<String>,
    title: String,
    rule: Option<String>,
    calendar_id: Option<String>,
    description: Option<String>,
    location: Option<String>,
    place_id: Option<String>,
    url: Option<String>,
    travel_min: Option<i64>,
    status: Option<String>,
    busy: Option<bool>,
    reminders: Option<Vec<i64>>,
    guests: Option<Vec<GuestIn>>,
}

fn propose(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let input: ProposeInput = ctx.parse_input()?;
    let times = times(ctx, None).map_err(|sentence| invalid("starts", sentence))?;
    let reminders = input.reminders.unwrap_or_default();
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
            location: input.location.as_deref().map(str::trim),
            place_id: input.place_id.as_deref(),
            url: input.url.as_deref(),
            travel_min: input.travel_min,
            status: input.status.as_deref(),
            busy: input.busy,
        },
    )?;
    let invited = input.guests.unwrap_or_default();
    guests::set_guests(ctx, &id, &invited)?;
    Ok(json!({ "id": id, "guests": invited.len() }))
}

/// What an edit (or a split) states: a key that is present is set (`null` clears it), one that is
/// absent is left alone. `original_start` names the day a split begins at.
#[derive(serde::Deserialize)]
pub(super) struct EditInput {
    pub(super) id: String,
    pub(super) original_start: Option<String>,
    pub(super) title: Option<String>,
    #[serde(default, deserialize_with = "crate::commands::deserialize_patch")]
    pub(super) description: Option<Option<String>>,
    #[serde(default, deserialize_with = "crate::commands::deserialize_patch")]
    pub(super) location: Option<Option<String>>,
    #[serde(default, deserialize_with = "crate::commands::deserialize_patch")]
    pub(super) place_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "crate::commands::deserialize_patch")]
    pub(super) url: Option<Option<String>>,
    pub(super) status: Option<String>,
    pub(super) busy: Option<bool>,
    #[serde(default, deserialize_with = "crate::commands::deserialize_patch")]
    pub(super) travel_min: Option<Option<i64>>,
    #[serde(default, deserialize_with = "crate::commands::deserialize_patch")]
    pub(super) reminders: Option<Option<Vec<i64>>>,
    #[serde(default, deserialize_with = "crate::commands::deserialize_patch")]
    pub(super) rule: Option<Option<String>>,
    #[serde(default, deserialize_with = "crate::commands::deserialize_patch")]
    pub(super) guests: Option<Option<Vec<GuestIn>>>,
}

impl EditInput {
    /// Whether the command states a time or a rule: what a split must move the days for.
    pub(super) fn states_when(&self, ctx: &CommandCtx<'_, '_>) -> bool {
        self.rule.is_some()
            || ["starts", "ends", "timing", "zone"]
                .iter()
                .any(|key| ctx.input.get(key).is_some())
    }
}

/// Set the event's own columns from what a command states, and its guests and alerts.
fn write_event(ctx: &CommandCtx<'_, '_>, input: &EditInput, after: &Times) -> Result<()> {
    let connection = ctx.connection();
    let id = input.id.as_str();
    let before = row_of(connection, id)?;
    let rule_after = match &input.rule {
        Some(rule) => rule.as_deref().map(rrule::canonicalize),
        None => before.rule.clone(),
    };
    // A day override is keyed by the series' own form of time and held to its timing by a key:
    // when the series changes form, or stops repeating, its days have nothing to name.
    if after.timing != before.times.timing || rule_after.is_none() {
        connection.execute("DELETE FROM occurrence WHERE series_id = ?1", [id])?;
    }
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
    if let Some(rule) = &input.rule {
        let rule = rule.as_deref().map(rrule::canonicalize);
        connection.execute(
            "UPDATE event SET rule = ?2, rule_supported = 1 WHERE id = ?1",
            rusqlite::params![id, rule],
        )?;
    }
    if rule_after.is_some() && (after != &before.times || rule_after != before.rule) {
        rekey_stranded(connection, id)?;
    }
    if let Some(description) = &input.description {
        connection.execute(
            "UPDATE event SET description = ?2 WHERE id = ?1",
            rusqlite::params![id, description],
        )?;
    }
    if let Some(location) = &input.location {
        connection.execute(
            "UPDATE event SET location = ?2 WHERE id = ?1",
            rusqlite::params![id, location.as_deref().map(str::trim)],
        )?;
    }
    if let Some(place_id) = &input.place_id {
        connection.execute(
            "UPDATE event SET place_id = ?2 WHERE id = ?1",
            rusqlite::params![id, place_id],
        )?;
    }
    if let Some(url) = &input.url {
        connection.execute(
            "UPDATE event SET url = ?2 WHERE id = ?1",
            rusqlite::params![id, url],
        )?;
    }
    if let Some(status) = &input.status {
        connection.execute(
            "UPDATE event SET status = ?2 WHERE id = ?1",
            rusqlite::params![id, status],
        )?;
    }
    if let Some(busy) = input.busy {
        connection.execute(
            "UPDATE event SET busy = ?2 WHERE id = ?1",
            rusqlite::params![id, busy],
        )?;
    }
    if let Some(travel_min) = input.travel_min {
        connection.execute(
            "UPDATE event SET travel_min = ?2 WHERE id = ?1",
            rusqlite::params![id, travel_min],
        )?;
    }
    if let Some(reminders) = &input.reminders {
        reminder::set_leads(ctx, id, reminders.as_deref().unwrap_or_default())?;
    }
    if let Some(title) = input.title.as_deref() {
        entity::rename(ctx, id, title.trim())?;
    }
    if let Some(guests) = &input.guests {
        guests::set_guests(ctx, id, guests.as_deref().unwrap_or_default())?;
    }
    ctx.touch(id)
}

/// The edit of a whole event, or of a whole series.
pub(super) fn apply_edit(ctx: &CommandCtx<'_, '_>, input: &EditInput) -> Result<()> {
    let row = row_of(ctx.connection(), &input.id)?;
    let after = times(ctx, Some(&row.times)).map_err(|sentence| invalid("starts", sentence))?;
    write_event(ctx, input, &after)
}

fn edit(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let input: EditInput = ctx.parse_input()?;
    apply_edit(ctx, &input)?;
    with_rev(ctx, &input.id, json!({ "id": input.id }))
}

fn split_command(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let input: EditInput = ctx.parse_input()?;
    let answer = split::split(ctx, &input)?;
    with_rev(ctx, &input.id, answer)
}

#[derive(serde::Deserialize)]
struct CancelEventInput {
    id: String,
}

fn cancel(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let input: CancelEventInput = ctx.parse_input()?;
    ctx.connection().execute(
        "UPDATE event SET status = 'cancelled' WHERE id = ?1",
        [input.id.as_str()],
    )?;
    Ok(json!({ "id": input.id }))
}

#[derive(serde::Deserialize)]
struct RespondInput {
    id: String,
    address: Option<String>,
    person_id: Option<String>,
    status: String,
}

fn respond(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let input: RespondInput = ctx.parse_input()?;
    guests::respond(
        ctx,
        &input.id,
        input.address.as_deref(),
        input.person_id.as_deref(),
        &input.status,
    )?;
    Ok(json!({ "id": input.id, "status": input.status }))
}

#[derive(serde::Deserialize)]
struct AddGuestInput {
    id: String,
    #[serde(flatten)]
    guest: GuestIn,
}

fn add_guest(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let input: AddGuestInput = ctx.parse_input()?;
    let added = guests::add_guest(ctx, &input.id, input.guest)?;
    Ok(json!({ "id": input.id, "added": added }))
}

#[derive(serde::Deserialize)]
struct EditOccurrenceInput {
    id: String,
    original_start: String,
    action: String,
    title: Option<String>,
    description: Option<String>,
    url: Option<String>,
    location: Option<String>,
    place_id: Option<String>,
}

/// What happened to one day of a series: skipped, moved or renamed, or put back.
fn edit_occurrence(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let input: EditOccurrenceInput = ctx.parse_input()?;
    let id = input.id.as_str();
    let key = input.original_start.as_str();
    let connection = ctx.connection();
    if input.action == "restore" {
        connection.execute(
            "DELETE FROM occurrence WHERE series_id = ?1 AND original_start = ?2",
            [id, key],
        )?;
    } else {
        let skipped = input.action == "skip";
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
        fn said(skipped: bool, value: &Option<String>) -> Option<&str> {
            (!skipped).then_some(value.as_deref()).flatten()
        }
        connection.execute(
            "INSERT INTO occurrence (series_id, series_timing, original_start, cancelled, starts,
                                     ends, timing, zone, title, description, url, location,
                                     place_id)
             SELECT ?1, timing, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12
               FROM event WHERE id = ?1
             ON CONFLICT (series_id, original_start)
             DO UPDATE SET cancelled = ?3, starts = ?4, ends = ?5, timing = ?6, zone = ?7,
                           title = ?8, description = ?9, url = ?10, location = ?11, place_id = ?12",
            rusqlite::params![
                id,
                key,
                skipped,
                day.starts,
                day.ends,
                day.own.as_ref().map(|(timing, _)| timing.as_str()),
                day.own.as_ref().and_then(|(_, zone)| zone.as_deref()),
                said(skipped, &input.title),
                said(skipped, &input.description),
                said(skipped, &input.url),
                said(skipped, &input.location).map(str::trim),
                said(skipped, &input.place_id),
            ],
        )?;
    }
    ctx.touch(id)?;
    with_rev(ctx, id, json!({ "id": id, "original_start": key }))
}

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

const ADD_GUEST_SCHEMA: &str = r#"{ "type": "object", "required": ["id"], "additionalProperties": false,
  "description": "One guest is a person or an address: a person with no email is a guest too.",
  "properties": {
    "id": { "type": "string", "minLength": 1 },
    "address": { "type": "string", "minLength": 1 },
    "person_id": { "type": "string", "minLength": 1 },
    "name": { "type": ["string", "null"] },
    "role": { "type": "string", "enum": ["required", "optional", "non-participant"] },
    "status": { "type": "string", "enum": ["needs-action", "accepted", "declined", "tentative"] },
    "organizer": { "type": "boolean" } } }"#;

macro_rules! guests_schema {
    () => {
        r#"{ "type": ["array", "null"],
      "description": "The whole list: a guest left out is taken off, one already invited keeps their answer unless this states it. A guest is a person or an address.",
      "items": { "type": "object", "additionalProperties": false,
        "properties": {
          "address": { "type": "string", "minLength": 1, "description": "An email address: a guest's identity on the event, in People or not." },
          "name": { "type": ["string", "null"] },
          "role": { "type": "string", "enum": ["required", "optional", "non-participant"] },
          "status": { "type": "string", "enum": ["needs-action", "accepted", "declined", "tentative"] },
          "organizer": { "type": "boolean" },
          "person_id": { "type": "string", "minLength": 1 } } } }"#
    };
}

const PROPOSE_SCHEMA: &str = concat!(
    r#"{
  "type": "object", "required": ["title", "starts"], "additionalProperties": false,
  "properties": {
    "id": { "type": "string", "minLength": 1 },
    "title": { "type": "string", "maxLength": 1000 },
    "description": { "type": ["string", "null"] },
    "starts": { "type": "string", "minLength": 1,
      "description": "An instant (...Z), a wall clock in `zone`, a floating wall clock to the minute, or a date for an all-day event." },
    "ends": { "type": ["string", "null"],
      "description": "Exclusive for a timed event; the LAST day, inclusive, for an all-day one." },
    "timing": { "type": "string", "enum": ["zoned", "floating", "all-day"] },
    "zone": { "type": ["string", "null"], "description": "An IANA zone; with it a wall clock is that zone's." },
    "rule": { "type": ["string", "null"], "description": "An RFC 5545 recurrence rule." },
    "calendar_id": { "type": "string", "minLength": 1, "description": "The calendar it is on (its home); the vault's own when none." },
    "location": { "type": ["string", "null"], "description": "Free text for where; it never becomes a place." },
    "place_id": { "type": ["string", "null"], "description": "A place the member has." },
    "url": { "type": ["string", "null"] },
    "travel_min": { "type": ["integer", "null"], "minimum": 0,
      "description": "Minutes of travel to allow before it starts." },
    "reminders": { "type": ["array", "null"], "items": { "type": "integer", "minimum": 0, "maximum": 525600 },
      "description": "Minutes before it starts, one per alert. An event has no alert unless it is given one." },
    "guests": "#,
    guests_schema!(),
    r#",
    "status": { "type": "string", "enum": ["confirmed", "tentative", "cancelled"] },
    "busy": { "type": "boolean" }
  }
}"#
);

macro_rules! edit_schema {
    ($required:literal, $key:literal) => {
        concat!(
            r#"{
  "type": "object", "required": "#,
            $required,
            r#", "additionalProperties": false,
  "properties": {
    "id": { "type": "string", "minLength": 1 },
    "#,
            $key,
            r#"
    "title": { "type": "string", "maxLength": 1000 },
    "description": { "type": ["string", "null"] },
    "starts": { "type": "string", "minLength": 1 },
    "ends": { "type": ["string", "null"] },
    "timing": { "type": "string", "enum": ["zoned", "floating", "all-day"] },
    "zone": { "type": ["string", "null"] },
    "rule": { "type": ["string", "null"] },
    "location": { "type": ["string", "null"] },
    "place_id": { "type": ["string", "null"] },
    "url": { "type": ["string", "null"] },
    "travel_min": { "type": ["integer", "null"], "minimum": 0 },
    "reminders": { "type": ["array", "null"], "items": { "type": "integer", "minimum": 0, "maximum": 525600 } },
    "guests": "#,
            guests_schema!(),
            r#",
    "status": { "type": "string", "enum": ["confirmed", "tentative", "cancelled"] },
    "busy": { "type": "boolean" },
    "expected_rev": { "type": "integer", "minimum": 0 }
  }
}"#
        )
    };
}

const EDIT_SCHEMA: &str = edit_schema!(r#"["id"]"#, "");

const SPLIT_SCHEMA: &str = edit_schema!(
    r#"["id", "original_start"]"#,
    r#""original_start": { "type": "string", "minLength": 1,
      "description": "The series-local wall clock of the first day the change is for." },"#
);

const OCCURRENCE_SCHEMA: &str = r#"{
  "type": "object", "required": ["id", "original_start", "action"], "additionalProperties": false,
  "properties": {
    "id": { "type": "string", "minLength": 1 },
    "original_start": { "type": "string", "minLength": 1,
      "description": "The series-local wall clock the rule produced for the day." },
    "action": { "type": "string", "enum": ["skip", "override", "restore"] },
    "title": { "type": "string" },
    "description": { "type": "string" },
    "starts": { "type": "string", "minLength": 1 },
    "ends": { "type": ["string", "null"] },
    "timing": { "type": "string", "enum": ["zoned", "floating", "all-day"],
      "description": "How this one day reads, when not as its series does." },
    "zone": { "type": ["string", "null"] },
    "url": { "type": "string", "description": "This day's own link; the series' when none." },
    "location": { "type": "string", "description": "This day's own words for where; the series' when none." },
    "place_id": { "type": "string", "description": "This day's own place; the series' when none." },
    "expected_rev": { "type": "integer", "minimum": 0 }
  }
}"#;

#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    const PROPOSE: &[CommandCondition] = &[CommandCondition {
        predicate: "event_has_a_title_a_calendar_and_a_time",
        check: pre_propose,
    }];
    const EDIT: &[CommandCondition] = &[
        STALE_GUARD[0],
        STALE_GUARD[1],
        CommandCondition {
            predicate: "event_is_live_and_its_change_resolves",
            check: pre_edit,
        },
    ];
    const SPLIT: &[CommandCondition] = &[
        STALE_GUARD[0],
        STALE_GUARD[1],
        CommandCondition {
            predicate: "series_has_that_day_and_the_change_resolves",
            check: pre_split,
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
    const ADD_GUEST: &[CommandCondition] = &[CommandCondition {
        predicate: "event_is_live_and_the_guest_is_a_person_or_an_address",
        check: pre_add_guest,
    }];
    const OCCURRENCE: &[CommandCondition] = &[
        STALE_GUARD[0],
        STALE_GUARD[1],
        CommandCondition {
            predicate: "day_is_one_the_series_lands_on",
            check: pre_occurrence,
        },
    ];
    // An edit, a cancellation, a split and a change to one day each restate a commitment other
    // people may hold: they are medium risk.
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
            "event.split",
            "event",
            SPLIT_SCHEMA,
            Idempotency::Once,
            SPLIT,
            split_command,
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
            r#"{ "type": "object", "required": ["id", "status"], "additionalProperties": false,
                 "properties": {
                   "id": { "type": "string", "minLength": 1 },
                   "address": { "type": "string", "minLength": 1 },
                   "person_id": { "type": "string", "minLength": 1 },
                   "status": { "type": "string", "enum": ["accepted", "declined", "tentative"] } } }"#,
            Idempotency::Idempotent,
            RESPOND,
            respond,
        ),
        CommandDefinition::plain(
            "event.add_guest",
            "event",
            ADD_GUEST_SCHEMA,
            Idempotency::Idempotent,
            ADD_GUEST,
            add_guest,
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
