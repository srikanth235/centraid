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
use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency};
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

fn record(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let person = subject(ctx)?;
    let connection = ctx.connection();
    let mut held = connection.prepare_cached(
        "SELECT value FROM measurement WHERE person_id = ?1 AND day = ?2 AND metric = ?3",
    )?;
    let mut write = connection.prepare_cached(
        "INSERT INTO measurement (person_id, day, metric, value) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (person_id, day, metric) DO UPDATE SET value = excluded.value",
    )?;
    let (mut written, mut unchanged) = (0_u64, 0_u64);
    for (day, metric, value) in days_of(ctx) {
        let was: Option<f64> = held
            .query_row(rusqlite::params![person, day, metric], |row| row.get(0))
            .optional()?;
        if was.is_some_and(|was| was.to_bits() == value.to_bits()) {
            unchanged += 1;
        } else {
            write.execute(rusqlite::params![person, day, metric, value])?;
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
            "SELECT label FROM origin WHERE system = 'health' ORDER BY created_at LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()?)
}

/// The `(day, metric)` a `measurement.log` names: `day` and `metric`, or the `id` chat reads a
/// figure's row by, `<day>:<metric>`.
fn named(ctx: &CommandCtx<'_, '_>) -> Option<(String, String)> {
    if let (Some(day), Some(metric)) = (ctx.optional_str("day"), ctx.optional_str("metric")) {
        return Some((day.to_owned(), metric.to_owned()));
    }
    let (day, metric) = ctx.optional_str("id")?.split_once(':')?;
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

fn log(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let (day, metric) = named(ctx).unwrap_or_default();
    let person = subject(ctx)?;
    let value = ctx
        .input
        .get("value")
        .and_then(Json::as_f64)
        .unwrap_or_default();
    let connection = ctx.connection();
    connection.execute(
        "INSERT INTO measurement (person_id, day, metric, value) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (person_id, day, metric) DO UPDATE SET value = excluded.value",
        rusqlite::params![person, day, metric, value],
    )?;
    ctx.touch(&person)?;
    Ok(json!({ "id": format!("{day}:{metric}"), "day": day, "metric": metric, "value": value }))
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

/// Take back a figure the member logged: the row goes, and nothing else.
fn clear(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let (day, metric) = named(ctx).unwrap_or_default();
    let person = subject(ctx)?;
    ctx.connection().execute(
        "DELETE FROM measurement WHERE person_id = ?1 AND day = ?2 AND metric = ?3",
        rusqlite::params![person, day, metric],
    )?;
    ctx.touch(&person)?;
    Ok(json!({ "id": format!("{day}:{metric}"), "day": day, "metric": metric }))
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
