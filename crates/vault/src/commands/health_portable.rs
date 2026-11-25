//! HEALTH AS A SPREADSHEET FILE (#1185): `health.export_csv`, the daily totals (every one or one
//! metric's), the readings (every one or one metric's) or the workouts (every one, or one: what a
//! workout page shares) as one CSV file (RFC 4180, see [`csv`](super::csv)). Writes nothing.
//!
//! Every value is the vault's own, as the store stated it: a daily total or a reading in the unit
//! its metric is kept in (named in its own column, from `health_metric`), a workout's or a
//! reading's moment as the instant it is kept as but written in the member's own time (the
//! vault's zone) with its offset, like `2026-11-11T07:30:00+05:30`, a workout's distance in
//! metres, its energy in kilocalories, its time in seconds. Nothing is converted to the member's
//! units or derived. What is in the trash is not in it.
//!
//! The earlier versions of a workout or a reading are the shared history's (`history.*`), not a
//! file of this module's.

use rusqlite::{Connection, OptionalExtension};
use serde_json::Value as Json;

use crate::commands::csv::{self, row, text_row, words};
use crate::commands::note_portable::file_stem;
use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency};
use crate::error::Result;
use crate::time::recurrence::parse_instant_ms;
use crate::time::zone::{FireZone, wall_iso};

const WORKOUTS: &str = "workouts";
const READINGS: &str = "readings";

/// A daily total's header row.
const MEASUREMENT_HEADER: [&str; 4] = ["Date", "Metric", "Value", "Unit"];

/// A reading's header row.
const READING_HEADER: [&str; 6] = ["Time", "Metric", "Value", "Second value", "Unit", "Context"];

/// A workout's header row.
const WORKOUT_HEADER: [&str; 13] = [
    "Start",
    "End",
    "Type",
    "Title",
    "Moving time (s)",
    "Distance (m)",
    "Energy (kcal)",
    "Heart rate (bpm)",
    "Climb (m)",
    "Recorded by",
    "Place",
    "With",
    "Notes",
];

/// A metric's name for a file: the code's words ("resting_hr_bpm" reads "Resting hr bpm").
fn metric_name(code: &str) -> String {
    let mut name = code.replace('_', " ");
    if let Some(first) = name.get_mut(0..1) {
        first.make_ascii_uppercase();
    }
    name
}

/// The zone the member's times are written in: the vault's own, else UTC (as a task's repeat
/// does), so an unset zone is a stated offset and never a guess.
fn member_zone(connection: &Connection) -> Option<FireZone> {
    let vault: Option<String> = connection
        .query_row("SELECT zone FROM vault", [], |row| row.get(0))
        .optional()
        .ok()
        .flatten()
        .flatten();
    FireZone::resolve(None, vault.as_deref())
        .or_else(|_| FireZone::named("Etc/UTC"))
        .ok()
}

/// A stored instant as local ISO 8601 with its offset (an empty end stays empty).
fn local_time(zone: Option<&FireZone>, stored: &str) -> String {
    let (Some(zone), true) = (zone, stored.len() > 10) else {
        return stored.to_owned();
    };
    let Some(millis) = parse_instant_ms(stored) else {
        return stored.to_owned();
    };
    let minutes = zone.offset_minutes(millis);
    let sign = if minutes < 0 { '-' } else { '+' };
    let minutes = minutes.abs();
    format!(
        "{}{sign}{:02}:{:02}",
        wall_iso(zone.zoned_parts(millis), true),
        minutes / 60,
        minutes % 60
    )
}

/// A stored number as the file spells it: the shortest text that reads back as the same value.
fn number(value: f64) -> String {
    value.to_string()
}

fn optional<T>(value: Option<T>, spell: impl Fn(T) -> String) -> String {
    value.map(spell).unwrap_or_default()
}

pub(crate) fn measurements(connection: &Connection, only: Option<&str>) -> Result<(String, i64)> {
    // One person at a time, by the table's primary key (person, day, metric): a read of every
    // measurement in one statement is a scan of the biggest table a vault holds.
    let people = connection
        .prepare_cached(
            "SELECT id FROM entity WHERE kind = 'person' AND deleted_at IS NULL ORDER BY id",
        )?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut statement = connection.prepare_cached(
        "SELECT m.day, m.metric, m.value, h.unit FROM measurement m
           JOIN health_metric h ON h.code = m.metric
          WHERE m.person_id = ?1 AND (?2 IS NULL OR m.metric = ?2)",
    )?;
    let mut rows = Vec::new();
    for person in &people {
        for found in statement.query_map(rusqlite::params![person, only], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, f64>(2)?,
                row.get::<_, String>(3)?,
            ))
        })? {
            rows.push((person.as_str(), found?));
        }
    }
    // The file reads by day, then metric, then person.
    rows.sort_by(|a, b| (&a.1.0, &a.1.1, a.0).cmp(&(&b.1.0, &b.1.1, b.0)));
    let rows: Vec<(String, String, f64, String)> =
        rows.into_iter().map(|(_, found)| found).collect();
    let mut text = text_row(&MEASUREMENT_HEADER);
    for (day, key, value, unit) in &rows {
        text.push_str(&row(&[
            words(day),
            words(&metric_name(key)),
            csv::number(&number(*value)),
            words(unit),
        ]));
    }
    Ok((text, i64::try_from(rows.len()).unwrap_or(i64::MAX)))
}

/// The live readings, oldest first (every metric, or one).
pub(crate) fn readings(connection: &Connection, only: Option<&str>) -> Result<(String, i64)> {
    let mut statement = connection.prepare_cached(
        "SELECT r.at, r.metric, r.value, r.value2, h.unit, r.context
           FROM reading r
           JOIN entity e ON e.id = r.id
           JOIN health_metric h ON h.code = r.metric
          WHERE e.deleted_at IS NULL AND (?1 IS NULL OR r.metric = ?1)
          ORDER BY r.at, r.id",
    )?;
    let rows = statement
        .query_map([only], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, f64>(2)?,
                row.get::<_, Option<f64>>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, Option<String>>(5)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let zone = member_zone(connection);
    let mut text = text_row(&READING_HEADER);
    for (at, metric, value, second, unit, context) in &rows {
        text.push_str(&row(&[
            words(&local_time(zone.as_ref(), at)),
            words(&metric_name(metric)),
            csv::number(&number(*value)),
            csv::number(&optional(*second, number)),
            words(unit),
            words(context.as_deref().unwrap_or_default()),
        ]));
    }
    Ok((text, i64::try_from(rows.len()).unwrap_or(i64::MAX)))
}

/// A workouts file: its text, how many workouts it holds and the title and day of the first (a
/// single workout's file name).
type Workouts = (String, i64, Option<(String, String)>);

pub(crate) fn workouts(connection: &Connection, one: Option<&str>) -> Result<Workouts> {
    let mut statement = connection.prepare_cached(
        "SELECT w.starts, w.ends, t.title, e.title, w.moving_s, w.distance_m, w.energy_kcal,
                w.heart_bpm, w.climb_m, w.recorded_by,
                (SELECT p.title FROM entity p WHERE p.id = w.place_id),
                (SELECT group_concat(q.title, '; ') FROM edge ed JOIN entity q ON q.id = ed.to_id
                  WHERE ed.from_id = w.id AND ed.rel = 'with'),
                w.notes
           FROM workout w
           JOIN entity e ON e.id = w.id
           JOIN entity t ON t.id = w.type_id
          WHERE e.deleted_at IS NULL AND (?1 IS NULL OR w.id = ?1)
          ORDER BY w.starts, w.id",
    )?;
    let rows = statement
        .query_map([one], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                (
                    row.get::<_, Option<i64>>(4)?,
                    row.get::<_, Option<f64>>(5)?,
                    row.get::<_, Option<f64>>(6)?,
                    row.get::<_, Option<i64>>(7)?,
                    row.get::<_, Option<f64>>(8)?,
                ),
                (
                    row.get::<_, Option<String>>(9)?,
                    row.get::<_, Option<String>>(10)?,
                    row.get::<_, Option<String>>(11)?,
                    row.get::<_, Option<String>>(12)?,
                ),
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let zone = member_zone(connection);
    let mut text = text_row(&WORKOUT_HEADER);
    for (starts, ends, kind, title, (moving, distance, energy, heart, climb), words_of) in &rows {
        let (by, place, with, notes) = words_of;
        text.push_str(&row(&[
            words(&local_time(zone.as_ref(), starts)),
            words(&local_time(
                zone.as_ref(),
                ends.as_deref().unwrap_or_default(),
            )),
            words(kind),
            words(title),
            csv::number(&optional(*moving, |n| n.to_string())),
            csv::number(&optional(*distance, number)),
            csv::number(&optional(*energy, number)),
            csv::number(&optional(*heart, |n| n.to_string())),
            csv::number(&optional(*climb, number)),
            words(by.as_deref().unwrap_or_default()),
            words(place.as_deref().unwrap_or_default()),
            words(with.as_deref().unwrap_or_default()),
            words(notes.as_deref().unwrap_or_default()),
        ]));
    }
    let first = rows
        .first()
        .map(|found| (found.3.clone(), found.0.chars().take(10).collect()));
    Ok((text, i64::try_from(rows.len()).unwrap_or(i64::MAX), first))
}

/// A sentence when `metric` is not one the file knows, or not of the cadence `what` holds.
fn pre_export(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let Some(metric) = ctx.optional_str("metric") else {
        return Ok(None);
    };
    let what = ctx.required_str("what")?;
    if what == WORKOUTS {
        return Ok(Some("A workouts file has no metric to pick.".to_owned()));
    }
    let wanted = if what == READINGS { "reading" } else { "total" };
    let cadence: Option<String> = ctx
        .connection()
        .query_row(
            "SELECT cadence FROM health_metric WHERE code = ?1",
            [metric],
            |row| row.get(0),
        )
        .optional()?;
    Ok(match cadence {
        None => Some(format!("`{metric}` is not a figure Health keeps.")),
        Some(found) if found != wanted => Some(format!(
            "`{metric}` is a {}, not a {}.",
            if found == "reading" { "reading" } else { "daily total" },
            if wanted == "reading" { "reading" } else { "daily total" },
        )),
        Some(_) => None,
    })
}

/// `health.export_csv`: the daily totals (`what` = `measurements`, every metric or one `metric`),
/// the readings (`what` = `readings`, the same) or the workouts (`what` = `workouts`, every one or
/// one `id`) as a spreadsheet file. Writes nothing.
fn export_csv(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let connection = ctx.connection();
    let what = ctx.required_str("what")?;
    let (name, text, count) = if what == WORKOUTS {
        let one = ctx.optional_str("id");
        let (text, count, first) = workouts(connection, one)?;
        let name = match (one, first) {
            (Some(_), Some((title, day))) => format!("{} {day}", file_stem(&title)),
            _ => "Workouts".to_owned(),
        };
        (name, text, count)
    } else if what == READINGS {
        let only = ctx.optional_str("metric");
        let (text, count) = readings(connection, only)?;
        let name = only.map_or_else(
            || "Readings".to_owned(),
            |key| format!("{} readings", metric_name(key)),
        );
        (name, text, count)
    } else {
        let only = ctx.optional_str("metric");
        let (text, count) = measurements(connection, only)?;
        let name = only.map_or_else(
            || "Daily totals".to_owned(),
            |key| format!("{} by day", metric_name(key)),
        );
        (name, text, count)
    };
    Ok(serde_json::json!({
        "name": format!("{name}.csv"),
        "media_type": "text/csv",
        "count": count,
        "content": base64::Engine::encode(&base64::engine::general_purpose::STANDARD, text),
    }))
}

/// The command's input. A metric is a row of `health_metric`, so the schema lists none: the
/// precondition asks the file.
const SCHEMA: &str = r#"{
  "type": "object",
  "required": ["what"],
  "additionalProperties": false,
  "properties": {
    "what": { "enum": ["measurements", "readings", "workouts"] },
    "metric": { "type": ["string", "null"] },
    "id": { "type": ["string", "null"] }
  }
}"#;

#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    const EXPORT: &[CommandCondition] = &[CommandCondition {
        predicate: "a_metric_is_one_the_file_knows_of_the_kind_the_file_holds",
        check: pre_export,
    }];
    vec![CommandDefinition::plain(
        "health.export_csv",
        "health",
        SCHEMA,
        Idempotency::Idempotent,
        EXPORT,
        export_csv,
    )]
}

#[cfg(test)]
mod tests {
    use super::{metric_name, number};

    #[test]
    fn names_and_numbers_read_back_as_stored() {
        assert_eq!(metric_name("steps"), "Steps");
        assert_eq!(metric_name("resting_hr_bpm"), "Resting hr bpm");
        assert_eq!(number(7500.0), "7500");
        assert_eq!(number(72.45), "72.45");
    }
}
