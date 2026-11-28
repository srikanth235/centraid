//! `measurement.*`: a person's DAILY TOTALS (F1): steps, sleep, energy, exercise minutes, resting,
//! lowest and highest heart rate. One figure per person, day and metric; **a day's total is not an
//! item** (no trash, no title, no earlier versions), a correction overwrites it, and `origin_id`
//! says which health store it came from (NULL: typed by hand).
//!
//! **Health holds daily totals and discrete readings and no raw sensor stream.** A heart rate
//! sampled every few seconds is never stored row by row: the phone sums it to that day's figures
//! and sends those ([`record`]); a batch that names one `(day, metric)` twice is refused, so a
//! series has nowhere to go. A thing measured at a moment (weight, blood pressure) is a
//! [`reading`](super::reading), an entity of its own.
//!
//! **What a metric is comes from the file, not from this crate**: `health_metric` says its
//! `cadence` (a `total` is a figure here, a `reading` is an entity), whether a reading has a second
//! figure and the unit it is kept in. No list of metrics, and no match on one, decides a shape here;
//! the table's own key refuses a metric that is not a daily total.
//!
//! - **Written by hand** (`measurement.log`, `measurement.clear`): allowed while a health store is
//!   followed. A figure typed over a store's day is an override: `value` differs from `stated`,
//!   what the store last said, and the next read keeps it. `measurement.clear` on a store's day
//!   puts `value` back to `stated`; on a hand-only figure it deletes the row.
//! - **Written by a health store** ([`record`]): `follow::write_day_totals` is the one writer of
//!   `measurement.origin_id` and `measurement.stated`. A batch is one commit, the store's cursor
//!   rides with the days it covers, a statement the vault already holds is not written (reading
//!   the same week twice changes nothing), a changed one is stated again, a new one added. A day
//!   the store states is never deleted: a sum the store now reports nothing for is sent as `0` by
//!   the follower.
//!
//! The reads a Health screen calls are [`trend`] (one metric across days) and [`totals_on`] (one
//! day's figures), each a bounded walk of an index, formatted in the member's [`Units`].

use std::collections::{BTreeMap, BTreeSet};

use rusqlite::OptionalExtension;
use serde_json::{Value as Json, json};

use crate::commands::follow::write_day_totals;
use crate::commands::{
    CommandCondition, CommandCtx, CommandDefinition, Idempotency, origin_cursor,
};
use crate::error::{Result, VaultError};
use crate::history::Actor;

/// The most `(day, metric)` values one command carries. A year of the seven metrics is 2,555, and
/// the first connect backfills one year (owner answer 3).
pub const RECORD_MAX: usize = 4_000;

/// The most days a trend read holds (a bit over a year of days).
pub const TREND_LIMIT: i64 = 400;

// ---------------------------------------------------------------------------------------------
// the member's units
// ---------------------------------------------------------------------------------------------

/// The units a member reads figures in. The vault keeps every figure in the unit its metric is
/// kept in (`health_metric.unit`: kilograms, degrees Celsius, metres); a read formats it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Units {
    #[default]
    Metric,
    Imperial,
}

impl Units {
    /// A figure kept in `unit`, spelled in this system: `72.4 kg` reads `159.6 lb` in imperial,
    /// `36.6 degC` reads `97.9 °F`. A unit with no other spelling (a count, minutes, a pressure)
    /// is written as it is kept. Keyed by the unit, never by the metric.
    #[must_use]
    pub fn show(self, unit: &str, value: f64, value2: Option<f64>) -> String {
        let (value, value2, unit) = match (self, unit) {
            (Self::Imperial, "kg") => (value * 2.204_622_621_8, None, "lb"),
            (Self::Imperial, "degC") => (value * 9.0 / 5.0 + 32.0, None, "°F"),
            (Self::Metric, "degC") => (value, None, "°C"),
            (_, other) => (value, value2, other),
        };
        let figure = value2.map_or_else(
            || number(value),
            |second| format!("{}/{}", number(value), number(second)),
        );
        match unit {
            "count" => figure,
            unit => format!("{figure} {unit}"),
        }
    }

    /// A distance kept in metres: kilometres or miles, to a tenth.
    #[must_use]
    pub fn distance(self, metres: f64) -> String {
        match self {
            Self::Metric if metres < 1_000.0 => format!("{} m", number(metres)),
            Self::Metric => format!("{} km", number(metres / 1_000.0)),
            Self::Imperial => format!("{} mi", number(metres / 1_609.344)),
        }
    }
}

/// A figure spelled to one decimal, the way a screen reads it: `72.0` is `72`, `72.45` is `72.5`.
fn number(value: f64) -> String {
    let text = format!("{value:.1}");
    text.strip_suffix(".0").map_or(text.clone(), str::to_owned)
}

// ---------------------------------------------------------------------------------------------
// the metrics the file knows
// ---------------------------------------------------------------------------------------------

/// What `health_metric` says of one metric.
struct Metric {
    cadence: String,
}

fn metric_row(connection: &rusqlite::Connection, code: &str) -> Result<Option<Metric>> {
    Ok(connection
        .query_row(
            "SELECT cadence FROM health_metric WHERE code = ?1",
            [code],
            |row| {
                Ok(Metric {
                    cadence: row.get(0)?,
                })
            },
        )
        .optional()?)
}

/// A sentence when `code` is not a metric whose figure arrives as a daily total.
fn total_refusal(connection: &rusqlite::Connection, code: &str) -> Result<Option<String>> {
    Ok(match metric_row(connection, code)? {
        None => Some(format!("`{code}` is not a figure Health keeps.")),
        Some(metric) if metric.cadence != "total" => Some(format!(
            "`{code}` is a reading, taken at a moment, not a daily total; add it as a reading."
        )),
        Some(_) => None,
    })
}

/// Whether `text` is a calendar day.
fn is_day(connection: &rusqlite::Connection, text: &str) -> Result<bool> {
    Ok(connection.query_row("SELECT date(?1) IS ?1", [text], |row| row.get(0))?)
}

/// A live person (a person row that is not in the trash).
fn is_live_person(connection: &rusqlite::Connection, id: &str) -> Result<bool> {
    Ok(connection
        .query_row(
            "SELECT 1 FROM entity WHERE id = ?1 AND kind = 'person' AND deleted_at IS NULL",
            [id],
            |_| Ok(true),
        )
        .optional()?
        .unwrap_or(false))
}

/// The subject a command is about: the person it names, else the vault's owner.
fn subject(ctx: &CommandCtx<'_, '_>) -> Result<String> {
    Ok(match ctx.optional_str("person_id") {
        Some(person) => person.to_owned(),
        None => ctx
            .connection()
            .query_row("SELECT self_id FROM vault", [], |row| row.get(0))?,
    })
}

// ---------------------------------------------------------------------------------------------
// written by a health store
// ---------------------------------------------------------------------------------------------

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

fn origin_input<'a>(ctx: &'a CommandCtx<'_, '_>, key: &str) -> Option<&'a str> {
    ctx.input
        .get("origin")
        .and_then(|origin| origin.get(key))
        .and_then(Json::as_str)
}

/// A sentence when the store the days come from is not a health store the member follows: one
/// that is stopped is followed again by a pass, not by a batch of totals.
fn origin_refusal(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let connection = ctx.connection();
    let (Some(system), Some(reference)) = (origin_input(ctx, "system"), origin_input(ctx, "ref"))
    else {
        return Ok(None);
    };
    let health: bool = connection.query_row(
        "SELECT EXISTS (SELECT 1 FROM source_shape WHERE system = ?1 AND entity_kind = 'reading')",
        [system],
        |row| row.get(0),
    )?;
    if !health {
        return Ok(Some(format!(
            "`{system}` is not a health store: it states no readings."
        )));
    }
    let retired: Option<bool> = connection
        .query_row(
            "SELECT retired_at IS NOT NULL FROM origin WHERE system = ?1 AND ref = ?2",
            [system, reference],
            |row| row.get(0),
        )
        .optional()?;
    Ok(match retired {
        Some(true) => Some("That health store is not followed now.".to_owned()),
        None if origin_input(ctx, "cursor").is_none() => {
            Some(format!("There is no store `{reference}`: follow it first."))
        }
        _ => None,
    })
}

fn pre_record(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let connection = ctx.connection();
    if origin_input(ctx, "cursor").is_some() && origin_input(ctx, "device_id").is_none() {
        return Ok(Some(
            "A cursor comes with the install that read it.".to_owned(),
        ));
    }
    if !is_live_person(connection, &subject(ctx)?)? {
        return Ok(Some(
            "There is no such person to record days for.".to_owned(),
        ));
    }
    if let Some(sentence) = origin_refusal(ctx)? {
        return Ok(Some(sentence));
    }
    let mut seen = BTreeSet::new();
    for (day, metric, _) in days_of(ctx) {
        if !is_day(connection, &day)? {
            return Ok(Some(format!("`{day}` is not a calendar day.")));
        }
        if let Some(sentence) = total_refusal(connection, &metric)? {
            return Ok(Some(sentence));
        }
        // THE RULE THAT KEEPS A SENSOR STREAM OUT: one figure per day and metric, so a series of
        // samples has no way in.
        if !seen.insert((day.clone(), metric.clone())) {
            return Ok(Some(format!(
                "`{metric}` is stated twice for {day}; a batch names each once, as that day's total."
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
struct OriginInput {
    system: String,
    #[serde(rename = "ref")]
    reference: String,
    device_id: Option<String>,
    cursor: Option<String>,
}

#[derive(serde::Deserialize)]
struct RecordInput {
    origin: OriginInput,
    person_id: Option<String>,
    days: Vec<DayInput>,
}

/// A health store's daily totals, one commit: the store's cursor (when it rides along), then each
/// day's figures through [`write_day_totals`]. Answers how many figures were written and how many
/// the vault already held.
fn record(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let input: RecordInput = ctx.parse_input()?;
    let connection = ctx.connection();
    if let Some(cursor) = input.origin.cursor.as_deref() {
        let device = input.origin.device_id.as_deref().unwrap_or_default();
        origin_cursor::advance(
            ctx,
            &input.origin.system,
            &input.origin.reference,
            device,
            cursor,
        )?;
    }
    let origin: String = connection
        .query_row(
            "SELECT id FROM origin WHERE system = ?1 AND ref = ?2",
            [&input.origin.system, &input.origin.reference],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| VaultError::InvalidInput {
            name: "origin".to_owned(),
            detail: format!("there is no store `{}`", input.origin.reference),
        })?;
    // EVERY PASS IS THE STORE'S (B4), the totals of one included.
    ctx.tx.set_actor(Actor::Store {
        origin_id: origin.clone(),
    });
    let person = match input.person_id {
        Some(person) => person,
        None => subject(ctx)?,
    };
    let mut held = connection.prepare_cached(
        "SELECT stated, origin_id FROM measurement WHERE person_id = ?1 AND day = ?2 AND metric = ?3",
    )?;
    let (mut changed, mut unchanged) = (0_u64, 0_u64);
    let mut by_day: BTreeMap<String, Vec<(String, f64)>> = BTreeMap::new();
    for entry in input.days {
        let was: Option<(Option<f64>, Option<String>)> = held
            .query_row(rusqlite::params![person, entry.day, entry.metric], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .optional()?;
        if was.is_some_and(|(stated, by)| {
            stated.is_some_and(|stated| stated.to_bits() == entry.value.to_bits())
                && by.as_deref() == Some(origin.as_str())
        }) {
            unchanged += 1;
        } else {
            changed += 1;
            by_day
                .entry(entry.day)
                .or_default()
                .push((entry.metric, entry.value));
        }
    }
    let mut written = 0;
    for (day, totals) in &by_day {
        let totals: Vec<(&str, f64)> = totals
            .iter()
            .map(|(metric, value)| (metric.as_str(), *value))
            .collect();
        written += write_day_totals(connection, &origin, &person, day, &totals)?;
    }
    if changed > 0 {
        ctx.touch(&person)?;
    }
    Ok(json!({ "written": written, "unchanged": unchanged }))
}

// ---------------------------------------------------------------------------------------------
// written by hand
// ---------------------------------------------------------------------------------------------

/// The `(day, metric)` a command names: `day` and `metric`, or the `id` chat reads a figure's row
/// by, `<day>:<metric>`.
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
    if let Some(sentence) = total_refusal(connection, &metric)? {
        return Ok(Some(sentence));
    }
    if !is_day(connection, &day)? {
        return Ok(Some(format!("`{day}` is not a calendar day.")));
    }
    if !is_live_person(connection, &subject(ctx)?)? {
        return Ok(Some("There is no such person.".to_owned()));
    }
    Ok(None)
}

#[derive(serde::Deserialize)]
struct LogMeasurementInput {
    person_id: Option<String>,
    id: Option<String>,
    day: Option<String>,
    metric: Option<String>,
    value: f64,
}

/// A figure typed by hand: it is the day's figure of the metric. Over a store's day it becomes an
/// override and the store's statement stays beside it; a hand-only day keeps no origin.
fn log(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let input: LogMeasurementInput = ctx.parse_input()?;
    let (day, metric) = named_parts(
        input.id.as_deref(),
        input.day.as_deref(),
        input.metric.as_deref(),
    )
    .unwrap_or_default();
    let person = match input.person_id {
        Some(person) => person,
        None => subject(ctx)?,
    };
    let connection = ctx.connection();
    let replaced: Option<f64> = connection
        .query_row(
            "SELECT value FROM measurement WHERE person_id = ?1 AND day = ?2 AND metric = ?3",
            rusqlite::params![person, day, metric],
            |row| row.get(0),
        )
        .optional()?;
    connection.execute(
        "INSERT INTO measurement (person_id, day, metric, value, origin_id)
         VALUES (?1, ?2, ?3, ?4, NULL)
         ON CONFLICT (person_id, day, metric) DO UPDATE SET value = excluded.value",
        rusqlite::params![person, day, metric, input.value],
    )?;
    ctx.touch(&person)?;
    // `replaced` is the figure this one took the place of, `null` when the day held none: a
    // measurement is outside the history, so the answer is how an Undo puts it back.
    Ok(json!({
        "id": format!("{day}:{metric}"), "day": day, "metric": metric, "value": input.value,
        "replaced": replaced
    }))
}

fn pre_clear(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let connection = ctx.connection();
    let Some((day, metric)) = named(ctx) else {
        return Ok(Some("Name the day and the metric.".to_owned()));
    };
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

/// Take back a figure: a store's day is the store's again (`value` is `stated`), a hand-only
/// figure goes.
fn clear(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let input: ClearMeasurementInput = ctx.parse_input()?;
    let (day, metric) = named_parts(
        input.id.as_deref(),
        input.day.as_deref(),
        input.metric.as_deref(),
    )
    .unwrap_or_default();
    let person = match input.person_id {
        Some(person) => person,
        None => subject(ctx)?,
    };
    let replaced: Option<f64> = ctx
        .connection()
        .query_row(
            "SELECT value FROM measurement WHERE person_id = ?1 AND day = ?2 AND metric = ?3",
            rusqlite::params![person, day, metric],
            |row| row.get(0),
        )
        .optional()?;
    let key = rusqlite::params![person, day, metric];
    ctx.connection().execute(
        "UPDATE measurement SET value = stated
          WHERE person_id = ?1 AND day = ?2 AND metric = ?3 AND origin_id IS NOT NULL",
        key,
    )?;
    ctx.connection().execute(
        "DELETE FROM measurement
          WHERE person_id = ?1 AND day = ?2 AND metric = ?3 AND origin_id IS NULL",
        key,
    )?;
    ctx.touch(&person)?;
    // The figure that went, so taking the clearing back logs it again.
    Ok(json!({
        "id": format!("{day}:{metric}"), "day": day, "metric": metric, "replaced": replaced
    }))
}

// ---------------------------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------------------------

/// One day's figure of a metric, as a trend draws it.
#[derive(Debug, Clone, PartialEq)]
pub struct Point {
    pub day: String,
    pub metric: String,
    pub value: f64,
    /// The figure spelled in the member's units.
    pub shown: String,
    /// The store it came from, none when it was typed by hand.
    pub origin_id: Option<String>,
    /// What the store last said, spelled in the member's units: "Phone says". Set only when the
    /// member's figure differs from it.
    pub stated: Option<String>,
}

/// One metric of one person across `[from, to]` (days), oldest first: a walk of
/// `measurement_by_metric` (or the key), stopping at the limit.
pub const TREND_SQL: &str = "SELECT m.day, m.metric, m.value, h.unit, m.origin_id, m.stated
       FROM measurement m JOIN health_metric h ON h.code = m.metric
      WHERE m.metric = ?1 AND m.person_id = ?2 AND m.day >= ?3 AND m.day <= ?4
      ORDER BY m.day
      LIMIT 400";

/// A metric's trend over days for one person (the owner when `person` is none): up to
/// [`TREND_LIMIT`] days, each formatted in `units`.
///
/// # Errors
///
/// A read the file refuses.
pub fn trend(
    connection: &rusqlite::Connection,
    person: &str,
    metric: &str,
    from: &str,
    to: &str,
    units: Units,
) -> Result<Vec<Point>> {
    let mut statement = connection.prepare_cached(TREND_SQL)?;
    let rows = statement
        .query_map(rusqlite::params![metric, person, from, to], |row| {
            let (value, unit): (f64, String) = (row.get(2)?, row.get(3)?);
            Ok(Point {
                day: row.get(0)?,
                metric: row.get(1)?,
                value,
                shown: units.show(&unit, value, None),
                origin_id: row.get(4)?,
                stated: row
                    .get::<_, Option<f64>>(5)?
                    .filter(|stated| stated.to_bits() != value.to_bits())
                    .map(|stated| units.show(&unit, stated, None)),
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Every figure of one person's day (at most one per metric): a walk of the key's prefix.
pub const TOTALS_ON_SQL: &str = "SELECT m.day, m.metric, m.value, h.unit, m.origin_id, m.stated
       FROM measurement m JOIN health_metric h ON h.code = m.metric
      WHERE m.person_id = ?1 AND m.day = ?2
      ORDER BY m.metric";

/// A person's day: each metric's total, formatted in `units`.
///
/// # Errors
///
/// A read the file refuses.
pub fn totals_on(
    connection: &rusqlite::Connection,
    person: &str,
    day: &str,
    units: Units,
) -> Result<Vec<Point>> {
    let mut statement = connection.prepare_cached(TOTALS_ON_SQL)?;
    let rows = statement
        .query_map(rusqlite::params![person, day], |row| {
            let (value, unit): (f64, String) = (row.get(2)?, row.get(3)?);
            Ok(Point {
                day: row.get(0)?,
                metric: row.get(1)?,
                value,
                shown: units.show(&unit, value, None),
                origin_id: row.get(4)?,
                stated: row
                    .get::<_, Option<f64>>(5)?
                    .filter(|stated| stated.to_bits() != value.to_bits())
                    .map(|stated| units.show(&unit, stated, None)),
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    const CLEAR: &[CommandCondition] = &[CommandCondition {
        predicate: "a_figure_the_member_or_a_store_holds",
        check: pre_clear,
    }];
    const LOG: &[CommandCondition] = &[CommandCondition {
        predicate: "a_figure_names_a_day_and_a_daily_metric",
        check: pre_log,
    }];
    const RECORD: &[CommandCondition] = &[CommandCondition {
        predicate: "days_are_calendar_days_of_daily_metrics_named_once",
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
            "metric": { "type": "string", "minLength": 1 }
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
            "metric": { "type": "string", "minLength": 1 },
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
          "required": ["origin", "days"],
          "additionalProperties": false,
          "properties": {
            "person_id": { "type": "string", "minLength": 1 },
            "origin": {
              "type": "object",
              "required": ["system", "ref"],
              "additionalProperties": false,
              "properties": {
                "system": { "type": "string", "minLength": 1 },
                "ref": { "type": "string", "minLength": 1 },
                "device_id": { "type": "string", "minLength": 1,
                  "description": "The install that read the store; required with cursor." },
                "cursor": { "type": "string", "minLength": 1, "maxLength": 4096,
                  "description": "The store's cursor once these days are in: it moves in this commit." }
              }
            },
            "days": {
              "type": "array",
              "maxItems": 4000,
              "items": {
                "type": "object",
                "required": ["day", "metric", "value"],
                "additionalProperties": false,
                "properties": {
                  "day": { "type": "string", "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" },
                  "metric": { "type": "string", "minLength": 1 },
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

#[cfg(test)]
mod tests {
    use super::{Units, number};

    #[test]
    fn figures_read_in_the_members_units() {
        assert_eq!(number(72.0), "72");
        assert_eq!(number(72.45), "72.5");
        assert_eq!(Units::Metric.show("kg", 72.4, None), "72.4 kg");
        assert_eq!(Units::Imperial.show("kg", 72.4, None), "159.6 lb");
        assert_eq!(Units::Metric.show("degC", 36.6, None), "36.6 °C");
        assert_eq!(Units::Imperial.show("degC", 36.6, None), "97.9 °F");
        assert_eq!(
            Units::Imperial.show("mmHg", 120.0, Some(80.0)),
            "120/80 mmHg"
        );
        assert_eq!(Units::Metric.show("count", 8000.0, None), "8000");
        assert_eq!(Units::Metric.distance(5_300.0), "5.3 km");
        assert_eq!(Units::Metric.distance(800.0), "800 m");
        assert_eq!(Units::Imperial.distance(5_000.0), "3.1 mi");
    }
}
