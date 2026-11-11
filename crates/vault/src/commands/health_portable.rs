//! HEALTH AS A SPREADSHEET FILE (#1185): `health.export_csv`, the daily totals (every one or one
//! metric's) or the workouts (every one, or one: what a workout page shares) as one CSV file
//! (RFC 4180, see [`csv`](super::csv)). Writes nothing.
//!
//! Every value is the vault's own, as the store stated it: a daily total in the unit its metric
//! is kept in (named in the next column), a workout's start and end as the UTC instants it is
//! kept as, its distance in metres, its energy in kilocalories, its time in seconds. Nothing is
//! converted to the member's units or derived. Workouts in the trash are not in it.

use rusqlite::Connection;
use serde_json::Value as Json;

use crate::commands::csv::row;
use crate::commands::{CommandCtx, CommandDefinition, Idempotency, note};
use crate::error::Result;

const WORKOUTS: &str = "workouts";

/// A daily total's header row.
const MEASUREMENT_HEADER: [&str; 4] = ["Date", "Metric", "Value", "Unit"];

/// A workout's header row.
const WORKOUT_HEADER: [&str; 10] = [
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
];

/// A metric's name in a file's name and the unit its value is kept in.
fn metric(key: &str) -> (&'static str, &'static str) {
    match key {
        "steps" => ("Steps", "count"),
        "active_energy_kcal" => ("Active energy", "kcal"),
        "exercise_min" => ("Exercise", "min"),
        "sleep_min" => ("Sleep", "min"),
        "resting_hr_bpm" => ("Resting heart rate", "bpm"),
        _ => ("Weight", "kg"),
    }
}

/// A stored number as the file spells it: the shortest text that reads back as the same value.
fn number(value: f64) -> String {
    value.to_string()
}

fn optional<T>(value: Option<T>, spell: impl Fn(T) -> String) -> String {
    value.map(spell).unwrap_or_default()
}

fn measurements(connection: &Connection, only: Option<&str>) -> Result<(String, i64)> {
    let mut statement = connection.prepare_cached(
        "SELECT m.day, m.metric, m.value
           FROM measurement m
           JOIN entity p ON p.id = m.person_id
          WHERE p.deleted_at IS NULL AND (?1 IS NULL OR m.metric = ?1)
          ORDER BY m.day, m.metric, m.person_id",
    )?;
    let rows = statement
        .query_map([only], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, f64>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut text = row(&MEASUREMENT_HEADER);
    for (day, key, value) in &rows {
        text.push_str(&row(&[day, key, &number(*value), metric(key).1]));
    }
    Ok((text, i64::try_from(rows.len()).unwrap_or(i64::MAX)))
}

/// A workouts file: its text, how many workouts it holds and the title and day of the first (a
/// single workout's file name).
type Workouts = (String, i64, Option<(String, String)>);

fn workouts(connection: &Connection, one: Option<&str>) -> Result<Workouts> {
    let mut statement = connection.prepare_cached(
        "SELECT a.starts, a.ends, t.title, e.title, w.moving_s, w.distance_m, w.energy_kcal,
                w.heart_bpm, w.climb_m, w.recorded_by
           FROM activity a
           JOIN workout w ON w.id = a.id
           JOIN entity e ON e.id = a.id
           JOIN entity t ON t.id = a.type_id
          WHERE e.deleted_at IS NULL AND (?1 IS NULL OR a.id = ?1)
          ORDER BY a.starts, a.id",
    )?;
    let rows = statement
        .query_map([one], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<i64>>(4)?,
                row.get::<_, Option<f64>>(5)?,
                row.get::<_, Option<f64>>(6)?,
                row.get::<_, Option<i64>>(7)?,
                row.get::<_, Option<f64>>(8)?,
                row.get::<_, Option<String>>(9)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut text = row(&WORKOUT_HEADER);
    for (starts, ends, kind, title, moving, distance, energy, heart, climb, by) in &rows {
        text.push_str(&row(&[
            starts,
            ends.as_deref().unwrap_or_default(),
            kind,
            title,
            &optional(*moving, |n| n.to_string()),
            &optional(*distance, number),
            &optional(*energy, number),
            &optional(*heart, |n| n.to_string()),
            &optional(*climb, number),
            by.as_deref().unwrap_or_default(),
        ]));
    }
    let first = rows
        .first()
        .map(|found| (found.3.clone(), found.0.chars().take(10).collect()));
    Ok((text, i64::try_from(rows.len()).unwrap_or(i64::MAX), first))
}

/// `health.export_csv`: the daily totals (`what` = `measurements`, every metric or one `metric`)
/// or the workouts (`what` = `workouts`, every one or one `id`) as a spreadsheet file. Writes
/// nothing.
fn export_csv(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let connection = ctx.connection();
    let (name, text, count) = if ctx.required_str("what")? == WORKOUTS {
        let one = ctx.optional_str("id");
        let (text, count, first) = workouts(connection, one)?;
        let name = match (one, first) {
            (Some(_), Some((title, day))) => format!("{} {day}", note::portable_stem(&title)),
            _ => "Workouts".to_owned(),
        };
        (name, text, count)
    } else {
        let only = ctx.optional_str("metric");
        let (text, count) = measurements(connection, only)?;
        let name = only.map_or_else(
            || "Daily totals".to_owned(),
            |key| format!("{} by day", metric(key).0),
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

/// The command's input; its `metric` list is held equal to [`METRICS`] by a test.
const SCHEMA: &str = r#"{
  "type": "object",
  "required": ["what"],
  "additionalProperties": false,
  "properties": {
    "what": { "enum": ["measurements", "workouts"] },
    "metric": { "enum": ["steps", "active_energy_kcal", "exercise_min", "sleep_min", "resting_hr_bpm", "weight_kg", null] },
    "id": { "type": ["string", "null"] }
  }
}"#;

#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    vec![CommandDefinition::plain(
        "health.export_csv",
        "health",
        SCHEMA,
        Idempotency::Idempotent,
        &[],
        export_csv,
    )]
}

#[cfg(test)]
mod tests {
    use super::{SCHEMA, metric, number};
    use crate::commands::measurement::METRICS;

    #[test]
    fn every_metric_has_a_name_and_a_unit_and_numbers_read_back_as_stored() {
        for key in METRICS {
            let (name, unit) = metric(key);
            assert!(!name.is_empty() && !unit.is_empty(), "{key}");
        }
        let schema: serde_json::Value = serde_json::from_str(SCHEMA).expect("json");
        let listed: Vec<&str> = schema["properties"]["metric"]["enum"]
            .as_array()
            .expect("a list")
            .iter()
            .filter_map(serde_json::Value::as_str)
            .collect();
        assert_eq!(listed, METRICS, "the schema lists the vault's metrics");
        assert_eq!(number(7500.0), "7500");
        assert_eq!(number(72.45), "72.45");
    }
}
