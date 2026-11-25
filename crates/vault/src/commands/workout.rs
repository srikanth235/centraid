//! `workout.*`: a workout is its own kind (L1): an entity of kind `workout` whose kind row holds its
//! span, its place, its figures and its own `notes`, and whose kind of workout (`type_id`) is a
//! `workout_kind` concept. The people it was done with are `with` edges.
//!
//! A member logs one by hand (`workout.log`) and changes it (`workout.edit`); the trash, a star,
//! a tag and a rename of the shared kind are the shared verbs. A workout the health store follows
//! is the same row with a `source`: **`workout.edit` does not refuse it** (L6, A12). The follower's
//! three-way merge ([`crate::commands::follow`]) keeps the figure the member set and shows the
//! store's as "Phone says X", field by field, so the member's edit and the store's next read no
//! longer contradict each other.
//!
//! What a record of the `health` store says of a workout becomes a row through [`MAP`] (the
//! engine reads the columns named in `fields`; there is no child: a figure is a column).
//!
//! **One read, "what happened on this day"** ([`on_day`]): the workouts that started in a span of
//! instants, an index walk of `workout_by_start`. People's `touch` is the other half of the same
//! read; Calendar's day view calls both.

use rusqlite::OptionalExtension;
use rusqlite::types::Value as Sql;
use serde_json::{Map, Value as Json};

use crate::commands::edge::{self, Extras};
use crate::commands::entity::{
    self, STALE_GUARD, lookup_live, require, with_rev,
};
use crate::commands::follow::{Gone, Match, OriginRow, SystemMap, canonical_instants};
use crate::commands::tag::ensure_concept;
use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency};
use crate::error::{Result, VaultError};
use crate::model::{Kind, Rel};

/// The most a workout's own words may weigh: a size budget, the command's on purpose (a column's
/// CHECK would have to be migrated to tune it).
pub const NOTES_BUDGET_BYTES: usize = 16 * 1024;

/// The most people one workout may be logged `with`.
pub const MAX_WITH: usize = 50;

/// The columns of `workout` a health store states, besides its kind and span: the figures.
pub const MEASURES: [&str; 6] = [
    "recorded_by",
    "moving_s",
    "distance_m",
    "energy_kcal",
    "heart_bpm",
    "climb_m",
];

// ---------------------------------------------------------------------------------------------
// following the health store: the map
// ---------------------------------------------------------------------------------------------

/// What the health store states of a workout: its kind (the store's word, placed by [`shape`]),
/// its span and its figures. A workout the store no longer holds stays, as the vault is the copy
/// that outlives the phone's store; a new phone finds it again by kind and minute.
pub const MAP: SystemMap = SystemMap {
    system: "health",
    command: "follow.health",
    kind: Kind::Workout,
    claims: None,
    fields: &[
        "type_id",
        "starts",
        "ends",
        "recorded_by",
        "moving_s",
        "distance_m",
        "energy_kcal",
        "heart_bpm",
        "climb_m",
    ],
    fixed: &[],
    children: &[],
    match_on: &[Match::Column("type_id"), Match::Minute("starts")],
    gone: Gone::Forget,
    window: Some("starts"),
    defaults: no_defaults,
    founds: None,
    shape,
    settle: nothing_to_settle,
    named: nothing_to_settle,
};

fn no_defaults(
    _: &rusqlite::Connection,
    _: &OriginRow,
) -> Result<Vec<(&'static str, rusqlite::types::Value)>> {
    Ok(Vec::new())
}

fn nothing_to_settle(_: &CommandCtx<'_, '_>, _: &str) -> Result<()> {
    Ok(())
}

/// Read a store's record into the form the vault holds: the store's word for the kind becomes the
/// workout kind it names (minted when this vault has not met the word), the instants become the
/// one spelling the vault writes, and an untitled workout is titled by its kind.
fn shape(
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
    if !fields.contains_key("starts") {
        return Err("a workout states when it started".to_owned());
    }
    canonical_instants(fields, &["starts", "ends"]);
    for name in ["starts", "ends"] {
        let Some(text) = fields.get(name).and_then(Json::as_str) else {
            continue;
        };
        // The one form the column holds: anything else is a record the vault cannot keep.
        let held: Option<String> = connection
            .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', ?1)", [text], |row| {
                row.get(0)
            })
            .map_err(|error| error.to_string())?;
        if held.as_deref() != Some(text) {
            return Err(format!("`{text}` is not an instant"));
        }
    }
    if let (Some(starts), Some(ends)) = (
        fields.get("starts").and_then(Json::as_str),
        fields.get("ends").and_then(Json::as_str),
    ) && ends < starts
    {
        return Err("a workout cannot end before it starts".to_owned());
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// a workout a member logs by hand
// ---------------------------------------------------------------------------------------------

/// An instant as the vault writes it, or the sentence that says it is not one.
fn instant(
    connection: &rusqlite::Connection,
    text: &str,
) -> Result<std::result::Result<String, String>> {
    let found: Option<String> =
        connection.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', ?1)", [text], |row| {
            row.get(0)
        })?;
    Ok(found.ok_or_else(|| format!("`{text}` is not a day or an instant.")))
}

/// A whole-number measure read from any JSON number, rounded (`142.0` is a valid integer).
fn whole<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<i64>, D::Error> {
    let number: Option<f64> = serde::Deserialize::deserialize(deserializer)?;
    Ok(number.filter(|n| n.is_finite()).map(|n| n.round() as i64))
}

/// [`whole`] with patch semantics: absent is `None`, `null` is `Some(None)`.
fn whole_patch<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<Option<i64>>, D::Error> {
    whole(deserializer).map(Some)
}

/// A sentence when the place is not a live place.
fn place_refusal(connection: &rusqlite::Connection, place: &str) -> Result<Option<String>> {
    Ok(match lookup_live(connection, place)? {
        Err(sentence) => Some(sentence),
        Ok(found) if found.kind != Kind::Place => {
            Some(format!("“{}” is a {}, not a place", found.title, found.kind.noun()))
        }
        Ok(_) => None,
    })
}

/// A sentence when the people a workout is `with` are not live people.
fn with_refusal(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let Some(people) = ctx.input.get("with").and_then(Json::as_array) else {
        return Ok(None);
    };
    if people.len() > MAX_WITH {
        return Ok(Some(format!(
            "a workout is with at most {MAX_WITH} people"
        )));
    }
    for person in people.iter().filter_map(Json::as_str) {
        match lookup_live(ctx.connection(), person)? {
            Err(sentence) => return Ok(Some(sentence)),
            Ok(found) if found.kind != Kind::Person => {
                return Ok(Some(format!(
                    "“{}” is a {}, not a person",
                    found.title,
                    found.kind.noun()
                )));
            }
            Ok(_) => {}
        }
    }
    Ok(None)
}

fn notes_refusal(ctx: &CommandCtx<'_, '_>) -> Option<String> {
    let notes = ctx.optional_str("notes")?;
    (notes.len() > NOTES_BUDGET_BYTES).then(|| {
        format!(
            "Those notes are {} bytes, over the {NOTES_BUDGET_BYTES}-byte budget for a workout.",
            notes.len()
        )
    })
}

fn pre_log(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let connection = ctx.connection();
    let starts = match instant(connection, ctx.required_str("starts")?)? {
        Ok(starts) => starts,
        Err(sentence) => return Ok(Some(sentence)),
    };
    if let Some(ends) = ctx.optional_str("ends") {
        match instant(connection, ends)? {
            Ok(ends) if ends < starts => {
                return Ok(Some("A workout cannot end before it starts.".to_owned()));
            }
            Ok(_) => {}
            Err(sentence) => return Ok(Some(sentence)),
        }
    }
    if let Some(place) = ctx.optional_str("place_id")
        && let Some(sentence) = place_refusal(connection, place)?
    {
        return Ok(Some(sentence));
    }
    if let Some(sentence) = notes_refusal(ctx) {
        return Ok(Some(sentence));
    }
    with_refusal(ctx)
}

#[derive(serde::Deserialize)]
struct LogWorkoutInput {
    id: Option<String>,
    #[serde(rename = "type")]
    workout_type: Option<String>,
    title: Option<String>,
    starts: String,
    ends: Option<String>,
    place_id: Option<String>,
    notes: Option<String>,
    #[serde(default)]
    with: Vec<String>,
    recorded_by: Option<String>,
    #[serde(default, deserialize_with = "whole")]
    moving_s: Option<i64>,
    distance_m: Option<f64>,
    energy_kcal: Option<f64>,
    #[serde(default, deserialize_with = "whole")]
    heart_bpm: Option<i64>,
    climb_m: Option<f64>,
}

/// Make the people a workout is `with` exactly `people`: the others are joined, the rest let go.
fn set_with(ctx: &CommandCtx<'_, '_>, id: &str, people: &[String]) -> Result<()> {
    let connection = ctx.connection();
    let held = connection
        .prepare_cached("SELECT to_id FROM edge WHERE from_id = ?1 AND rel = 'with'")?
        .query_map([id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for gone in held.iter().filter(|held| !people.contains(held)) {
        connection.execute(
            "DELETE FROM edge WHERE from_id = ?1 AND rel = 'with' AND to_id = ?2",
            [id, gone.as_str()],
        )?;
    }
    for person in people.iter().filter(|person| !held.contains(person)) {
        edge::put(ctx, id, Rel::With, person, None, &Extras::default())?;
    }
    Ok(())
}

fn log(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let input: LogWorkoutInput = ctx.parse_input()?;
    let connection = ctx.connection();
    let word = input.workout_type.as_deref().unwrap_or("workout");
    let kind = ensure_concept(ctx, Kind::WorkoutKind, word)?;
    let named: String =
        connection.query_row("SELECT title FROM entity WHERE id = ?1", [&kind], |row| {
            row.get(0)
        })?;
    let title = input
        .title
        .as_deref()
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .unwrap_or(&named);
    // the id the phone minted first when it named one (a card shows it before the tap)
    let id = match input.id.as_deref() {
        Some(id) => {
            ctx.insert_entity_as(id, Kind::Workout, title)?;
            id.to_owned()
        }
        None => ctx.insert_entity(Kind::Workout, title)?,
    };
    let invalid = |name: &str, detail: String| VaultError::InvalidInput {
        name: name.to_owned(),
        detail,
    };
    let starts = instant(connection, &input.starts)?.map_err(|detail| invalid("starts", detail))?;
    let ends = match input.ends.as_deref() {
        Some(ends) => Some(instant(connection, ends)?.map_err(|detail| invalid("ends", detail))?),
        None => None,
    };
    connection.execute(
        "INSERT INTO workout (id, type_id, starts, ends, place_id, recorded_by, moving_s,
                              distance_m, energy_kcal, heart_bpm, climb_m, notes)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        rusqlite::params![
            id,
            kind,
            starts,
            ends,
            input.place_id,
            input.recorded_by,
            input.moving_s,
            input.distance_m,
            input.energy_kcal,
            input.heart_bpm,
            input.climb_m,
            input.notes.as_deref().filter(|notes| !notes.trim().is_empty()),
        ],
    )?;
    set_with(ctx, &id, &input.with)?;
    Ok(serde_json::json!({ "id": id, "workout_id": id }))
}

fn pre_edit(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let connection = ctx.connection();
    let id = ctx.required_str("id")?;
    match lookup_live(connection, id)? {
        Err(sentence) => return Ok(Some(sentence)),
        Ok(found) if found.kind != Kind::Workout => {
            return Ok(Some(format!(
                "“{}” is a {}, not a workout",
                found.title,
                found.kind.noun()
            )));
        }
        Ok(_) => {}
    }
    if ctx
        .input
        .get("title")
        .and_then(Json::as_str)
        .is_some_and(|title| title.trim().is_empty())
    {
        return Ok(Some("A workout's title cannot be blank.".to_owned()));
    }
    // NOTHING HERE REFUSES A FOLLOWED WORKOUT (L6): the merge keeps the member's figure.
    let (starts, ends): (String, Option<String>) = connection.query_row(
        "SELECT starts, ends FROM workout WHERE id = ?1",
        [id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let starts = match ctx.optional_str("starts") {
        Some(text) => match instant(connection, text)? {
            Ok(starts) => starts,
            Err(sentence) => return Ok(Some(sentence)),
        },
        None => starts,
    };
    let ends = match ctx.input.get("ends") {
        Some(Json::String(text)) => match instant(connection, text)? {
            Ok(ends) => Some(ends),
            Err(sentence) => return Ok(Some(sentence)),
        },
        Some(_) => None,
        None => ends,
    };
    if ends.is_some_and(|ends| ends < starts) {
        return Ok(Some("A workout cannot end before it starts.".to_owned()));
    }
    if let Some(place) = ctx.optional_str("place_id")
        && let Some(sentence) = place_refusal(connection, place)?
    {
        return Ok(Some(sentence));
    }
    if let Some(sentence) = notes_refusal(ctx) {
        return Ok(Some(sentence));
    }
    with_refusal(ctx)
}

#[derive(serde::Deserialize)]
struct EditWorkoutInput {
    id: String,
    #[serde(rename = "type")]
    workout_type: Option<String>,
    title: Option<String>,
    starts: Option<String>,
    #[serde(default, deserialize_with = "crate::commands::deserialize_patch")]
    ends: Option<Option<String>>,
    #[serde(default, deserialize_with = "crate::commands::deserialize_patch")]
    place_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "crate::commands::deserialize_patch")]
    notes: Option<Option<String>>,
    with: Option<Vec<String>>,
    #[serde(default, deserialize_with = "crate::commands::deserialize_patch")]
    recorded_by: Option<Option<String>>,
    #[serde(default, deserialize_with = "whole_patch")]
    moving_s: Option<Option<i64>>,
    #[serde(default, deserialize_with = "crate::commands::deserialize_patch")]
    distance_m: Option<Option<f64>>,
    #[serde(default, deserialize_with = "crate::commands::deserialize_patch")]
    energy_kcal: Option<Option<f64>>,
    #[serde(default, deserialize_with = "whole_patch")]
    heart_bpm: Option<Option<i64>>,
    #[serde(default, deserialize_with = "crate::commands::deserialize_patch")]
    climb_m: Option<Option<f64>>,
}

fn edit(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let input: EditWorkoutInput = ctx.parse_input()?;
    let connection = ctx.connection();
    if let Some(title) = input.title.as_deref().map(str::trim) {
        entity::rename(ctx, &input.id, title)?;
    }
    let mut sets: Vec<(&str, Sql)> = Vec::new();
    if let Some(word) = input.workout_type.as_deref() {
        sets.push(("type_id", Sql::Text(ensure_concept(ctx, Kind::WorkoutKind, word)?)));
    }
    for (column, value) in [("starts", input.starts.as_deref())] {
        if let Some(text) = value {
            let held = instant(connection, text)?.map_err(|detail| VaultError::InvalidInput {
                name: column.to_owned(),
                detail,
            })?;
            sets.push((column, Sql::Text(held)));
        }
    }
    if let Some(ends) = &input.ends {
        let held = match ends {
            Some(text) => Sql::Text(instant(connection, text)?.map_err(|detail| {
                VaultError::InvalidInput {
                    name: "ends".to_owned(),
                    detail,
                }
            })?),
            None => Sql::Null,
        };
        sets.push(("ends", held));
    }
    let text = |value: &Option<Option<String>>| {
        value.as_ref().map(|value| match value.as_deref().map(str::trim) {
            Some(text) if !text.is_empty() => Sql::Text(text.to_owned()),
            _ => Sql::Null,
        })
    };
    if let Some(value) = text(&input.place_id) {
        sets.push(("place_id", value));
    }
    if let Some(value) = text(&input.notes) {
        sets.push(("notes", value));
    }
    if let Some(value) = text(&input.recorded_by) {
        sets.push(("recorded_by", value));
    }
    for (column, value) in [
        ("moving_s", input.moving_s.map(|v| v.map_or(Sql::Null, Sql::Integer))),
        ("heart_bpm", input.heart_bpm.map(|v| v.map_or(Sql::Null, Sql::Integer))),
        ("distance_m", input.distance_m.map(|v| v.map_or(Sql::Null, Sql::Real))),
        ("energy_kcal", input.energy_kcal.map(|v| v.map_or(Sql::Null, Sql::Real))),
        ("climb_m", input.climb_m.map(|v| v.map_or(Sql::Null, Sql::Real))),
    ] {
        if let Some(value) = value {
            sets.push((column, value));
        }
    }
    if !sets.is_empty() {
        let assignments = sets
            .iter()
            .enumerate()
            .map(|(at, (column, _))| format!("{column} = ?{}", at + 2))
            .collect::<Vec<_>>()
            .join(", ");
        let mut values = vec![Sql::Text(input.id.clone())];
        values.extend(sets.into_iter().map(|(_, value)| value));
        // One statement: the table's checks judge the row after it (a span moved whole).
        connection.execute(
            &format!("UPDATE workout SET {assignments} WHERE id = ?1"),
            rusqlite::params_from_iter(values),
        )?;
    }
    if let Some(people) = &input.with {
        set_with(ctx, &input.id, people)?;
    }
    ctx.touch(&input.id)?;
    require(connection, &input.id)?;
    with_rev(
        ctx,
        &input.id,
        serde_json::json!({ "id": input.id, "workout_id": input.id }),
    )
}

// ---------------------------------------------------------------------------------------------
// what happened on a day
// ---------------------------------------------------------------------------------------------

/// The most workouts a day's read holds: a day has a handful, and a store that states a thousand
/// in one is read in pages by [`on_day`]'s caller moving `from`.
pub const DAY_LIMIT: i64 = 200;

/// The workouts that started in `[from, to)`, in the order they started: a walk of
/// `workout_by_start` that stops at [`DAY_LIMIT`]. Calendar's day view calls it with the day's two
/// instants (it owns the member's zone), and joins People's touches to the same day.
pub const ON_DAY_SQL: &str = "SELECT w.id, e.title, k.title, w.starts, w.ends, w.place_id,
            w.moving_s, w.distance_m, w.energy_kcal, w.heart_bpm, w.climb_m, w.recorded_by,
            w.notes
       FROM workout w
       JOIN entity e ON e.id = w.id
       JOIN entity k ON k.id = w.type_id
      WHERE w.starts >= ?1 AND w.starts < ?2 AND e.deleted_at IS NULL
      ORDER BY w.starts, w.id
      LIMIT 200";

/// One workout of a day, as the day's list shows it.
#[derive(Debug, Clone, PartialEq)]
pub struct DayWorkout {
    pub id: String,
    pub title: String,
    /// The kind of workout, as its concept is titled ("Run").
    pub kind: String,
    pub starts: String,
    pub ends: Option<String>,
    pub place_id: Option<String>,
    pub moving_s: Option<i64>,
    /// The distance as the member reads it, in their units.
    pub distance: Option<String>,
    pub energy_kcal: Option<f64>,
    pub heart_bpm: Option<i64>,
    pub climb_m: Option<f64>,
    pub recorded_by: Option<String>,
    pub notes: Option<String>,
}

/// What happened between two instants, of the workouts half: see [`ON_DAY_SQL`].
///
/// # Errors
///
/// A read the file refuses.
pub fn on_day(
    connection: &rusqlite::Connection,
    from: &str,
    to: &str,
    units: crate::commands::measurement::Units,
) -> Result<Vec<DayWorkout>> {
    let mut statement = connection.prepare_cached(ON_DAY_SQL)?;
    let rows = statement
        .query_map([from, to], |row| {
            Ok(DayWorkout {
                id: row.get(0)?,
                title: row.get(1)?,
                kind: row.get(2)?,
                starts: row.get(3)?,
                ends: row.get(4)?,
                place_id: row.get(5)?,
                moving_s: row.get(6)?,
                distance: row
                    .get::<_, Option<f64>>(7)?
                    .map(|metres| units.distance(metres)),
                energy_kcal: row.get(8)?,
                heart_bpm: row.get(9)?,
                climb_m: row.get(10)?,
                recorded_by: row.get(11)?,
                notes: row.get(12)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// The people a workout was done with, by the order they were joined.
///
/// # Errors
///
/// A read the file refuses.
pub fn people_with(connection: &rusqlite::Connection, id: &str) -> Result<Vec<String>> {
    Ok(connection
        .prepare_cached(
            "SELECT e.to_id FROM edge e JOIN entity p ON p.id = e.to_id
              WHERE e.from_id = ?1 AND e.rel = 'with' AND p.deleted_at IS NULL
              ORDER BY e.created_at, e.to_id",
        )?
        .query_map([id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Whether a workout of `id` is followed by a live store, and which: what "Phone says X" reads
/// beside.
///
/// # Errors
///
/// A read the file refuses.
pub fn followed_by(connection: &rusqlite::Connection, id: &str) -> Result<Option<String>> {
    Ok(connection
        .query_row(
            "SELECT o.label FROM source s JOIN origin o ON o.id = s.origin_id
              WHERE s.entity_id = ?1 AND o.retired_at IS NULL
              ORDER BY o.created_at LIMIT 1",
            [id],
            |row| row.get(0),
        )
        .optional()?)
}

#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    const LOG: &[CommandCondition] = &[CommandCondition {
        predicate: "a_workout_starts_on_a_day_and_does_not_end_before_in_a_place_with_people",
        check: pre_log,
    }];
    const EDIT: &[CommandCondition] = &[
        STALE_GUARD[0],
        STALE_GUARD[1],
        CommandCondition {
            predicate: "a_live_workout_that_does_not_end_before_it_starts",
            check: pre_edit,
        },
    ];
    vec![
        CommandDefinition::plain(
            "workout.log",
            "workout",
            r#"{
              "type": "object",
              "required": ["starts"],
              "additionalProperties": false,
              "properties": {
                "id": { "type": "string", "minLength": 1 },
                "type": { "type": "string", "minLength": 1, "maxLength": 40 },
                "title": { "type": "string", "minLength": 1, "maxLength": 200 },
                "starts": { "type": "string", "minLength": 1 },
                "ends": { "type": "string", "minLength": 1 },
                "place_id": { "type": "string", "minLength": 1 },
                "notes": { "type": "string" },
                "with": { "type": "array", "items": { "type": "string", "minLength": 1 }, "maxItems": 50 },
                "recorded_by": { "type": "string", "minLength": 1 },
                "moving_s": { "type": "integer", "minimum": 1 },
                "distance_m": { "type": "number", "minimum": 0 },
                "energy_kcal": { "type": "number", "minimum": 0 },
                "heart_bpm": { "type": "integer", "minimum": 1 },
                "climb_m": { "type": "number", "minimum": 0 }
              }
            }"#,
            Idempotency::Once,
            LOG,
            log,
        ),
        CommandDefinition::plain(
            "workout.edit",
            "workout",
            r#"{
              "type": "object",
              "required": ["id"],
              "additionalProperties": false,
              "properties": {
                "id": { "type": "string", "minLength": 1 },
                "type": { "type": "string", "minLength": 1, "maxLength": 40 },
                "title": { "type": "string", "maxLength": 200 },
                "starts": { "type": "string", "minLength": 1 },
                "ends": { "type": ["string", "null"], "minLength": 1 },
                "place_id": { "type": ["string", "null"], "minLength": 1 },
                "notes": { "type": ["string", "null"] },
                "with": { "type": "array", "items": { "type": "string", "minLength": 1 }, "maxItems": 50 },
                "recorded_by": { "type": ["string", "null"] },
                "moving_s": { "type": ["integer", "null"], "minimum": 1 },
                "distance_m": { "type": ["number", "null"], "minimum": 0 },
                "energy_kcal": { "type": ["number", "null"], "minimum": 0 },
                "heart_bpm": { "type": ["integer", "null"], "minimum": 1 },
                "climb_m": { "type": ["number", "null"], "minimum": 0 },
                "expected_rev": { "type": "integer", "minimum": 0 }
              }
            }"#,
            Idempotency::Idempotent,
            EDIT,
            edit,
        ),
    ]
}

#[cfg(test)]
mod whole_number_tests {
    use super::{EditWorkoutInput, LogWorkoutInput};
    use serde_json::json;

    #[test]
    fn whole_measures_read_integers_and_integer_valued_floats_alike() {
        for heart in [json!(142), json!(142.0)] {
            let log: LogWorkoutInput = serde_json::from_value(
                json!({ "starts": "2026-03-04", "moving_s": 1800.0, "heart_bpm": heart }),
            )
            .expect("log input");
            assert_eq!((log.moving_s, log.heart_bpm), (Some(1800), Some(142)));
            let edit: EditWorkoutInput = serde_json::from_value(
                json!({ "id": "w", "moving_s": 1800.0, "heart_bpm": heart }),
            )
            .expect("edit input");
            assert_eq!(
                (edit.moving_s, edit.heart_bpm),
                (Some(Some(1800)), Some(Some(142)))
            );
        }
        let edit: EditWorkoutInput =
            serde_json::from_value(json!({ "id": "w", "heart_bpm": null })).expect("edit input");
        assert_eq!((edit.moving_s, edit.heart_bpm), (None, Some(None)));
    }
}
