//! A workout: what the health store measured of an activity of a workout kind.
//!
//! A workout is an `activity` (its kind, its span) with a `workout` row beside
//! it for the figures; the store's own id is the `source` that follows it
//! (`follow.health`). This module is what [`crate::commands::follow`] needs to
//! follow one: the **kind** a store's word becomes ([`shape`]) and the
//! **measures** that hang off the activity ([`MEASURES`]). The member edits
//! none of it in Centraid, so a measure is written as the store states it.

use rusqlite::OptionalExtension;
use rusqlite::types::Value as Sql;
use serde_json::{Map, Value as Json};

use crate::commands::CommandCtx;
use crate::commands::follow::Child;
use crate::commands::tag::ensure_concept;
use crate::error::Result;
use crate::model::Kind;

/// The columns of `workout`, in the form a record states them.
const COLUMNS: [&str; 6] = [
    "recorded_by",
    "moving_s",
    "distance_m",
    "energy_kcal",
    "heart_bpm",
    "climb_m",
];

/// The columns that hold whole numbers; the rest are reals.
const WHOLE: [&str; 2] = ["moving_s", "heart_bpm"];

/// The measures a workout carries, as the follow engine's child of an activity.
pub const MEASURES: Child = Child {
    name: "workout",
    read,
    canon,
    merge,
};

/// The measures a record states in the one form the engine compares: only what
/// is stated, numbers as reals, words squashed.
fn canon(value: &Json) -> Json {
    let mut out = Map::new();
    for column in COLUMNS {
        match value.get(column) {
            Some(Json::Number(number)) => {
                if let Some(real) = number.as_f64().and_then(serde_json::Number::from_f64) {
                    out.insert(column.to_owned(), Json::Number(real));
                }
            }
            Some(Json::String(text)) => {
                let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
                if !text.is_empty() {
                    out.insert(column.to_owned(), Json::String(text));
                }
            }
            _ => {}
        }
    }
    Json::Object(out)
}

fn read(connection: &rusqlite::Connection, id: &str) -> Result<Json> {
    let row: Option<Vec<Sql>> = connection
        .query_row(
            &format!("SELECT {} FROM workout WHERE id = ?1", COLUMNS.join(", ")),
            [id],
            |row| {
                (0..COLUMNS.len())
                    .map(|index| row.get::<_, Sql>(index))
                    .collect::<rusqlite::Result<Vec<_>>>()
            },
        )
        .optional()?;
    let mut out = Map::new();
    for (column, value) in COLUMNS.iter().zip(row.into_iter().flatten()) {
        let json = match value {
            Sql::Integer(number) => Json::from(number as f64),
            Sql::Real(number) => Json::from(number),
            Sql::Text(text) => Json::String(text),
            Sql::Null | Sql::Blob(_) => continue,
        };
        out.insert((*column).to_owned(), json);
    }
    Ok(Json::Object(out))
}

/// Write what the store stated of the activity's figures: the row is added or
/// brought level, and a figure the store no longer states is cleared.
fn merge(ctx: &CommandCtx<'_, '_>, id: &str, _: Option<&Json>, new: &Json) -> Result<bool> {
    let new = canon(new);
    let bind = |column: &str| -> Sql {
        match new.get(column) {
            Some(Json::Number(number)) if WHOLE.contains(&column) => {
                Sql::Integer(number.as_f64().unwrap_or_default().round() as i64)
            }
            Some(Json::Number(number)) => Sql::Real(number.as_f64().unwrap_or_default()),
            Some(Json::String(text)) => Sql::Text(text.clone()),
            _ => Sql::Null,
        }
    };
    let names = COLUMNS.join(", ");
    let marks = (2..=COLUMNS.len() + 1)
        .map(|index| format!("?{index}"))
        .collect::<Vec<_>>()
        .join(", ");
    let sets = COLUMNS
        .iter()
        .map(|column| format!("{column} = excluded.{column}"))
        .collect::<Vec<_>>()
        .join(", ");
    let excluded = COLUMNS
        .iter()
        .map(|column| format!("excluded.{column}"))
        .collect::<Vec<_>>()
        .join(", ");
    let mut values = vec![Sql::Text(id.to_owned())];
    values.extend(COLUMNS.iter().map(|column| bind(column)));
    let changed = ctx.connection().execute(
        &format!(
            "INSERT INTO workout (id, {names}) VALUES (?1, {marks})
             ON CONFLICT (id) DO UPDATE SET {sets}
              WHERE ({names}) IS NOT ({excluded})"
        ),
        rusqlite::params_from_iter(values),
    )?;
    Ok(changed > 0)
}

/// Read a store's record into the form the vault holds: the store's word for the
/// kind becomes the workout kind it names (minted when this vault has not met the
/// word), the instants become the one spelling the vault writes, and an
/// untitled workout is titled by its kind.
pub fn shape(
    ctx: &CommandCtx<'_, '_>,
    fields: &mut Map<String, Json>,
) -> std::result::Result<(), String> {
    let word = fields
        .remove("kind")
        .and_then(|kind| kind.as_str().map(str::to_owned))
        .ok_or("a workout states its kind")?;
    let kind = ensure_concept(ctx, Kind::WorkoutKind, &word).map_err(|error| error.to_string())?;
    let connection = ctx.connection();
    let named: String = connection
        .query_row("SELECT title FROM entity WHERE id = ?1", [&kind], |row| {
            row.get(0)
        })
        .map_err(|error| error.to_string())?;
    fields.entry("title").or_insert_with(|| Json::String(named));
    fields.insert("type_id".to_owned(), Json::String(kind));
    fields.insert(
        "type_kind".to_owned(),
        Json::String("workout_kind".to_owned()),
    );
    let mut span = Vec::new();
    for name in ["starts", "ends"] {
        let Some(text) = fields.get(name).and_then(Json::as_str) else {
            if name == "starts" {
                return Err("a workout states when it started".to_owned());
            }
            span.push(None);
            continue;
        };
        let instant: Option<String> = connection
            .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', ?1)", [text], |row| {
                row.get(0)
            })
            .map_err(|error| error.to_string())?;
        let instant = instant.ok_or_else(|| format!("`{text}` is not an instant"))?;
        fields.insert(name.to_owned(), Json::String(instant.clone()));
        span.push(Some(instant));
    }
    if let [Some(starts), Some(ends)] = span.as_slice()
        && ends < starts
    {
        return Err("a workout cannot end before it starts".to_owned());
    }
    Ok(())
}
