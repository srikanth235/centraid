//! `measurement.record`: a person's daily totals, as a health store states them.
//!
//! Health follows the phone's health store one way (R-1127-1): HealthKit on iOS,
//! Health Connect on Android. The shell's follower reads a window of the store's
//! daily totals and sends the `(day, metric, value)` triples it found; this
//! command stores them and refuses what the schema forbids. Nothing is written
//! back to the store (R-1129-7).
//!
//! - **A batch is one commit.** A value the vault already holds is not written
//!   (so reading the same week twice changes nothing), a changed one is replaced,
//!   a new one added.
//! - **A day the store states is never deleted** (R-1129-3). A sum the store now
//!   reports nothing for is sent as `0` by the follower, and a last-value or average
//!   metric is never cleared (RP-K-3); both rules are the follower's, because only
//!   it knows what the store was asked. **The one exception is the member's own**
//!   ([#1166](https://github.com/srikanth235/centraid/issues/1166)): a figure they
//!   logged by hand (`measurement.log`) can be taken back (`measurement.clear`), and
//!   only while no health store is followed, so it can only ever remove a figure
//!   nothing states.
//! - **Days are store-agnostic**: a measurement is keyed by its person, day and
//!   metric, so the vault keeps the latest statement of each, whichever store
//!   made it.

use std::collections::BTreeSet;

use rusqlite::OptionalExtension;
use serde_json::{Value as Json, json};

use crate::commands::money::{is_day, is_live};
use crate::commands::{
    CommandCondition, CommandCtx, CommandDefinition, Idempotency, origin_cursor,
};
use crate::error::Result;
use crate::model::Kind;

/// The vocabulary of `measurement.metric`, held equal to the CHECK by a test.
pub const METRICS: [&str; 6] = [
    "steps",
    "active_energy_kcal",
    "exercise_min",
    "sleep_min",
    "resting_hr_bpm",
    "weight_kg",
];

/// The most `(day, metric)` values one command carries. A year of the six
/// metrics is 2,190, and the first connect backfills one year (owner answer 3).
pub const RECORD_MAX: usize = 4_000;

/// The subject a batch is about: the person it names, else the vault's owner.
fn subject(ctx: &CommandCtx<'_, '_>) -> Result<String> {
    Ok(match ctx.optional_str("person_id") {
        Some(person) => person.to_owned(),
        None => ctx
            .connection()
            .query_row("SELECT self_id FROM vault", [], |row| row.get(0))?,
    })
}

type Day = (String, String, f64);

fn days_of(ctx: &CommandCtx<'_, '_>) -> Vec<Day> {
    ctx.input
        .get("days")
        .and_then(Json::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            Some((
                entry.get("day")?.as_str()?.to_owned(),
                entry.get("metric")?.as_str()?.to_owned(),
                entry.get("value")?.as_f64()?,
            ))
        })
        .collect()
}

fn pre_record(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let connection = ctx.connection();
    let named = |name: &str| ctx.optional_str(name).is_some();
    let (cursor, store, device) = (named("cursor"), named("cursor_ref"), named("cursor_device"));
    if (cursor || store || device) && !(cursor && store && device) {
        return Ok(Some(
            "A cursor comes with the store it is for and the install that read it.".to_owned(),
        ));
    }
    if !is_live(connection, &subject(ctx)?, Kind::Person)? {
        return Ok(Some(
            "There is no such person to record days for.".to_owned(),
        ));
    }
    let mut seen = BTreeSet::new();
    for (day, metric, _) in days_of(ctx) {
        if !is_day(connection, &day)? {
            return Ok(Some(format!("`{day}` is not a calendar day.")));
        }
        if !seen.insert((day.clone(), metric.clone())) {
            return Ok(Some(format!(
                "`{metric}` is stated twice for {day}; a batch names each once."
            )));
        }
    }
    Ok(None)
}

#[derive(serde::Deserialize)]
struct DayInput {
    day: String,
    metric: String,
    value: f64,
}

#[derive(serde::Deserialize)]
struct RecordInput {
    person_id: Option<String>,
    cursor: Option<String>,
    cursor_ref: Option<String>,
    cursor_device: Option<String>,
    days: Vec<DayInput>,
}

fn subject_of(ctx: &CommandCtx<'_, '_>, person_id: Option<&str>) -> Result<String> {
    Ok(match person_id {
        Some(person) => person.to_owned(),
        None => ctx
            .connection()
            .query_row("SELECT self_id FROM vault", [], |row| row.get(0))?,
    })
}

fn record(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let input: RecordInput = ctx.parse_input()?;
    // THE STORE'S CURSOR RIDES WITH THE DAYS IT COVERS (#1183): one commit, so a refused batch
    // leaves the cursor where it was and a read that stopped part-way resumes from it.
    if let Some(cursor) = input.cursor.as_deref() {
        let cursor_ref =
            input
                .cursor_ref
                .as_deref()
                .ok_or_else(|| crate::error::VaultError::InvalidInput {
                    name: "cursor_ref".to_owned(),
                    detail: "a required string is missing".to_owned(),
                })?;
        let cursor_device = input.cursor_device.as_deref().ok_or_else(|| {
            crate::error::VaultError::InvalidInput {
                name: "cursor_device".to_owned(),
                detail: "a required string is missing".to_owned(),
            }
        })?;
        origin_cursor::advance(ctx, "health", cursor_ref, cursor_device, cursor)?;
    }
    let person = subject_of(ctx, input.person_id.as_deref())?;
    let connection = ctx.connection();
    let mut held = connection.prepare_cached(
        "SELECT value FROM measurement WHERE person_id = ?1 AND day = ?2 AND metric = ?3",
    )?;
    let mut write = connection.prepare_cached(
        "INSERT INTO measurement (person_id, day, metric, value) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (person_id, day, metric) DO UPDATE SET value = excluded.value",
    )?;
    let (mut written, mut unchanged) = (0_u64, 0_u64);
    for entry in input.days {
        let was: Option<f64> = held
            .query_row(rusqlite::params![person, entry.day, entry.metric], |row| {
                row.get(0)
            })
            .optional()?;
        if was.is_some_and(|was| was.to_bits() == entry.value.to_bits()) {
            unchanged += 1;
        } else {
            write.execute(rusqlite::params![
                person,
                entry.day,
                entry.metric,
                entry.value
            ])?;
            written += 1;
        }
    }
    if written > 0 {
        ctx.touch(&person)?;
    }
    Ok(json!({ "written": written, "unchanged": unchanged }))
}

/// The store that states these figures, when the vault follows one: a figure in a store's window
/// is stated again at the next read, so a hand-written value would not last.
fn followed_by(connection: &rusqlite::Connection) -> Result<Option<String>> {
    Ok(connection
        .query_row(
            "SELECT label FROM origin WHERE system = 'health' AND retired_at IS NULL
              ORDER BY created_at LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()?)
}

/// The `(day, metric)` a `measurement.log` names: `day` and `metric`, or the `id` chat reads a
/// figure's row by, `<day>:<metric>`.
fn named(ctx: &CommandCtx<'_, '_>) -> Option<(String, String)> {
    named_parts(
        ctx.optional_str("id"),
        ctx.optional_str("day"),
        ctx.optional_str("metric"),
    )
}

fn named_parts(
    id: Option<&str>,
    day: Option<&str>,
    metric: Option<&str>,
) -> Option<(String, String)> {
    if let (Some(day), Some(metric)) = (day, metric) {
        return Some((day.to_owned(), metric.to_owned()));
    }
    let (day, metric) = id?.split_once(':')?;
    Some((day.to_owned(), metric.to_owned()))
}

fn pre_log(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let connection = ctx.connection();
    let Some((day, metric)) = named(ctx) else {
        return Ok(Some("Name the day and the metric.".to_owned()));
    };
    if !METRICS.contains(&metric.as_str()) {
        return Ok(Some(format!(
            "`{metric}` is not a daily figure; they are {}.",
            METRICS.join(", ")
        )));
    }
    if !is_day(connection, &day)? {
        return Ok(Some(format!("`{day}` is not a calendar day.")));
    }
    if let Some(store) = followed_by(connection)? {
        return Ok(Some(format!(
            "These figures come from {store}; change them there, not here."
        )));
    }
    Ok(None)
}

#[derive(serde::Deserialize)]
struct LogMeasurementInput {
    person_id: Option<String>,
    id: Option<String>,
    day: Option<String>,
    metric: Option<String>,
    value: Option<f64>,
}

fn log(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let input: LogMeasurementInput = ctx.parse_input()?;
    let (day, metric) = named_parts(
        input.id.as_deref(),
        input.day.as_deref(),
        input.metric.as_deref(),
    )
    .unwrap_or_default();
    let person = subject_of(ctx, input.person_id.as_deref())?;
    let value = input.value.unwrap_or_default();
    let connection = ctx.connection();
    let replaced: Option<f64> = connection
        .query_row(
            "SELECT value FROM measurement WHERE person_id = ?1 AND day = ?2 AND metric = ?3",
            rusqlite::params![person, day, metric],
            |row| row.get(0),
        )
        .optional()?;
    connection.execute(
        "INSERT INTO measurement (person_id, day, metric, value) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (person_id, day, metric) DO UPDATE SET value = excluded.value",
        rusqlite::params![person, day, metric, value],
    )?;
    ctx.touch(&person)?;
    // `replaced` is the figure this one took the place of, `null` when the day held none: a
    // measurement is outside the history, so the answer is how an Undo puts it back.
    Ok(json!({
        "id": format!("{day}:{metric}"), "day": day, "metric": metric, "value": value,
        "replaced": replaced
    }))
}

fn pre_clear(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let connection = ctx.connection();
    let Some((day, metric)) = named(ctx) else {
        return Ok(Some("Name the day and the metric.".to_owned()));
    };
    if let Some(store) = followed_by(connection)? {
        return Ok(Some(format!(
            "These figures come from {store}; change them there, not here."
        )));
    }
    let held: bool = connection.query_row(
        "SELECT EXISTS (SELECT 1 FROM measurement WHERE person_id = ?1 AND day = ?2 AND metric = ?3)",
        rusqlite::params![subject(ctx)?, day, metric],
        |row| row.get(0),
    )?;
    Ok((!held).then(|| format!("There is no {metric} figure for {day}.")))
}

#[derive(serde::Deserialize)]
struct ClearMeasurementInput {
    person_id: Option<String>,
    id: Option<String>,
    day: Option<String>,
    metric: Option<String>,
}

/// Take back a figure the member logged: the row goes, and nothing else.
fn clear(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let input: ClearMeasurementInput = ctx.parse_input()?;
    let (day, metric) = named_parts(
        input.id.as_deref(),
        input.day.as_deref(),
        input.metric.as_deref(),
    )
    .unwrap_or_default();
    let person = subject_of(ctx, input.person_id.as_deref())?;
    let replaced: Option<f64> = ctx
        .connection()
        .query_row(
            "SELECT value FROM measurement WHERE person_id = ?1 AND day = ?2 AND metric = ?3",
            rusqlite::params![person, day, metric],
            |row| row.get(0),
        )
        .optional()?;
    ctx.connection().execute(
        "DELETE FROM measurement WHERE person_id = ?1 AND day = ?2 AND metric = ?3",
        rusqlite::params![person, day, metric],
    )?;
    ctx.touch(&person)?;
    // The figure that went, so taking the clearing back logs it again.
    Ok(json!({
        "id": format!("{day}:{metric}"), "day": day, "metric": metric, "replaced": replaced
    }))
}

#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    const CLEAR: &[CommandCondition] = &[CommandCondition {
        predicate: "a_figure_the_member_logged_and_no_store_states",
        check: pre_clear,
    }];
    const LOG: &[CommandCondition] = &[CommandCondition {
        predicate: "a_figure_names_a_day_and_a_metric_and_no_store_states_it",
        check: pre_log,
    }];
    const RECORD: &[CommandCondition] = &[CommandCondition {
        predicate: "days_are_calendar_days_named_once",
        check: pre_record,
    }];
    vec![
        CommandDefinition::plain(
            "measurement.clear",
            "measurement",
            r#"{
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "person_id": { "type": "string", "minLength": 1 },
            "id": { "type": "string", "minLength": 1 },
            "day": { "type": "string", "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" },
            "metric": {
              "enum": ["steps", "active_energy_kcal", "exercise_min", "sleep_min",
                       "resting_hr_bpm", "weight_kg"]
            }
          }
        }"#,
            Idempotency::Idempotent,
            CLEAR,
            clear,
        ),
        CommandDefinition::plain(
            "measurement.log",
            "measurement",
            r#"{
          "type": "object",
          "required": ["value"],
          "additionalProperties": false,
          "properties": {
            "person_id": { "type": "string", "minLength": 1 },
            "id": { "type": "string", "minLength": 1 },
            "day": { "type": "string", "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" },
            "metric": {
              "enum": ["steps", "active_energy_kcal", "exercise_min", "sleep_min",
                       "resting_hr_bpm", "weight_kg"]
            },
            "value": { "type": "number", "minimum": 0 }
          }
        }"#,
            Idempotency::Idempotent,
            LOG,
            log,
        ),
        CommandDefinition::plain(
            "measurement.record",
            "measurement",
            r#"{
          "type": "object",
          "required": ["days"],
          "additionalProperties": false,
          "properties": {
            "person_id": { "type": "string", "minLength": 1 },
            "cursor": { "type": "string", "minLength": 1, "maxLength": 4096,
              "description": "The store's cursor once these days are in: it moves in this commit." },
            "cursor_ref": { "type": "string", "minLength": 1,
              "description": "The store's origin the cursor is for; required with cursor." },
            "cursor_device": { "type": "string", "minLength": 1,
              "description": "The install that read the store; required with cursor." },
            "days": {
              "type": "array",
              "maxItems": 4000,
              "items": {
                "type": "object",
                "required": ["day", "metric", "value"],
                "additionalProperties": false,
                "properties": {
                  "day": { "type": "string", "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" },
                  "metric": {
                    "enum": ["steps", "active_energy_kcal", "exercise_min", "sleep_min",
                             "resting_hr_bpm", "weight_kg"]
                  },
                  "value": { "type": "number", "minimum": 0 }
                }
              }
            }
          }
        }"#,
            Idempotency::Idempotent,
            RECORD,
            record,
        ),
    ]
}
