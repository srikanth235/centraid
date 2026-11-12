//! A workout: what the health store measured of an activity of a workout kind.
//!
//! A workout is an `activity` (its kind, its span) with a `workout` row beside
//! it for the figures; the store's own id is the `source` that follows it
//! (`follow.health`). This module is what [`crate::commands::follow`] needs to
//! follow one: the **kind** a store's word becomes ([`shape`]) and the
//! **measures** that hang off the activity ([`MEASURES`]). A measure of a
//! followed workout is written as the store states it.
//!
//! **A member can log a workout by hand** (`workout.log`) and change one they
//! logged (`workout.edit`, [#1166](https://github.com/srikanth235/centraid/issues/1166)).
//! It is the same two rows with no `source`. A workout the health store follows
//! is refused by `workout.edit` with a sentence naming the store, because the
//! next read would state it again. The follower's merge keeps a figure the member set (one they logged on a row the store is only now matching, or changed since the store last stated it).

use std::collections::BTreeMap;

use rusqlite::OptionalExtension;
use rusqlite::types::Value as Sql;
use serde_json::{Map, Value as Json};

use crate::commands::follow::Child;
use crate::commands::tag::ensure_concept;
use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency};
use crate::error::{Result, VaultError};
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
    items: Some(items),
    take,
    stamp: None,
};

/// The measures by column.
fn items(value: &Json) -> BTreeMap<String, Json> {
    value
        .as_object()
        .into_iter()
        .flatten()
        .map(|(column, figure)| (column.clone(), figure.clone()))
        .collect()
}

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
fn merge(ctx: &CommandCtx<'_, '_>, id: &str, before: Option<&Json>, new: &Json) -> Result<bool> {
    // THE MEMBER'S FIGURE STANDS: a measure the member has set since the store last stated it, or
    // one they logged on a row the store is only now matching, is theirs; the store writes the
    // rest (the three-way merge of the module doc, per column).
    let held = canon(&read(ctx.connection(), id)?);
    let was = before.map(canon);
    let mut stated = canon(new);
    for column in COLUMNS.iter().skip(1) {
        let current = held.get(*column);
        let mine = match &was {
            Some(last) => last.get(*column) != current,
            // a row the store stated has its `recorded_by`; one the member logged has none
            None => current.is_some() && held.get("recorded_by").is_none(),
        };
        if mine {
            match current {
                Some(value) => stated[*column] = value.clone(),
                None => {
                    stated.as_object_mut().map(|map| map.remove(*column));
                }
            }
        }
    }
    store(ctx, id, &stated)
}

/// Make the measures what the store last stated (one column, or all): a figure the member changed
/// is put back, one they cleared comes back and one they added is cleared.
fn take(ctx: &CommandCtx<'_, '_>, id: &str, item: Option<&str>, stated: &Json) -> Result<bool> {
    let (said, mut target) = (canon(stated), canon(&read(ctx.connection(), id)?));
    for column in COLUMNS
        .iter()
        .filter(|column| item.is_none_or(|item| item == **column))
    {
        match said.get(*column) {
            Some(value) => target[*column] = value.clone(),
            None => {
                target.as_object_mut().map(|map| map.remove(*column));
            }
        }
    }
    store(ctx, id, &target)
}

/// Write the measures (in [`canon`]'s form) as the activity's row, adding it if it has none.
fn store(ctx: &CommandCtx<'_, '_>, id: &str, new: &Json) -> Result<bool> {
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

/// Every workout has its `workout` row, however little the store measured: a
/// walk with no figures is still a workout, and an activity of a workout kind
/// without the row is not one.
pub fn settle(ctx: &CommandCtx<'_, '_>, id: &str) -> Result<()> {
    ctx.connection()
        .execute("INSERT OR IGNORE INTO workout (id) VALUES (?1)", [id])?;
    Ok(())
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

// ---------------------------------------------------------------------------------------------
// a workout a member logs by hand
// ---------------------------------------------------------------------------------------------

/// `where` a workout of `id` is a live one, and the health origin that follows it if one does.
fn followed_by(connection: &rusqlite::Connection, id: &str) -> Result<Option<String>> {
    Ok(connection
        .query_row(
            "SELECT o.label FROM source s JOIN origin o ON o.id = s.origin_id
              WHERE s.entity_id = ?1 AND s.system = 'health' AND o.retired_at IS NULL",
            [id],
            |row| row.get(0),
        )
        .optional()?)
}

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
    Ok(None)
}

/// The measures an input states, as the columns they are: the figure, or `null` to clear one.
fn stated(ctx: &CommandCtx<'_, '_>) -> Vec<(&'static str, Sql)> {
    COLUMNS
        .iter()
        .skip(1) // `recorded_by` is the store's
        .filter_map(|column| {
            let value = ctx.input.get(*column)?;
            let bound = match value {
                Json::Null => Sql::Null,
                Json::Number(number) if WHOLE.contains(column) => {
                    Sql::Integer(number.as_f64()?.round() as i64)
                }
                Json::Number(number) => Sql::Real(number.as_f64()?),
                _ => return None,
            };
            Some((*column, bound))
        })
        .collect()
}

fn log(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let connection = ctx.connection();
    let word = ctx.optional_str("type").unwrap_or("workout");
    let kind = ensure_concept(ctx, Kind::WorkoutKind, word)?;
    let named: String =
        connection.query_row("SELECT title FROM entity WHERE id = ?1", [&kind], |row| {
            row.get(0)
        })?;
    let title = ctx
        .optional_str("title")
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .unwrap_or(&named);
    // the id the phone minted first when it named one (a card shows it before the tap)
    let id = match ctx.optional_str("id") {
        Some(id) => {
            ctx.insert_entity_as(id, Kind::Activity, title)?;
            id.to_owned()
        }
        None => ctx.insert_entity(Kind::Activity, title)?,
    };
    let starts = instant(connection, ctx.required_str("starts")?)?.map_err(|detail| {
        VaultError::InvalidInput {
            name: "starts".to_owned(),
            detail,
        }
    })?;
    let ends = match ctx.optional_str("ends") {
        Some(ends) => {
            Some(
                instant(connection, ends)?.map_err(|detail| VaultError::InvalidInput {
                    name: "ends".to_owned(),
                    detail,
                })?,
            )
        }
        None => None,
    };
    connection.execute(
        "INSERT INTO activity (id, type_id, type_kind, starts, ends)
         VALUES (?1, ?2, 'workout_kind', ?3, ?4)",
        rusqlite::params![id, kind, starts, ends],
    )?;
    settle(ctx, &id)?;
    set_measures(ctx, &id)?;
    ctx.touch(&id)?;
    Ok(serde_json::json!({ "id": id, "workout_id": id }))
}

fn set_measures(ctx: &CommandCtx<'_, '_>, id: &str) -> Result<()> {
    let measures = stated(ctx);
    if measures.is_empty() {
        return Ok(());
    }
    let sets = measures
        .iter()
        .enumerate()
        .map(|(at, (column, _))| format!("{column} = ?{}", at + 2))
        .collect::<Vec<_>>()
        .join(", ");
    let mut values = vec![Sql::Text(id.to_owned())];
    values.extend(measures.into_iter().map(|(_, value)| value));
    ctx.connection().execute(
        &format!("UPDATE workout SET {sets} WHERE id = ?1"),
        rusqlite::params_from_iter(values),
    )?;
    Ok(())
}

fn pre_edit(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let connection = ctx.connection();
    let id = ctx.required_str("id")?;
    let live: bool = connection.query_row(
        "SELECT EXISTS (SELECT 1 FROM entity e JOIN activity a ON a.id = e.id
                         WHERE e.id = ?1 AND e.deleted_at IS NULL AND a.type_kind = 'workout_kind')",
        [id],
        |row| row.get(0),
    )?;
    if !live {
        return Ok(Some("There is no such workout.".to_owned()));
    }
    if let Some(store) = followed_by(connection, id)? {
        return Ok(Some(format!(
            "This workout comes from {store}; change it there, not here."
        )));
    }
    let (starts, ends): (String, Option<String>) = connection.query_row(
        "SELECT starts, ends FROM activity WHERE id = ?1",
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
    let ends = match ctx.optional_str("ends") {
        Some(text) => match instant(connection, text)? {
            Ok(ends) => Some(ends),
            Err(sentence) => return Ok(Some(sentence)),
        },
        None => ends,
    };
    Ok(ends
        .filter(|ends| *ends < starts)
        .map(|_| "A workout cannot end before it starts.".to_owned()))
}

fn edit(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let connection = ctx.connection();
    let id = ctx.required_str("id")?;
    if let Some(title) = ctx
        .optional_str("title")
        .map(str::trim)
        .filter(|t| !t.is_empty())
    {
        connection.execute("UPDATE entity SET title = ?2 WHERE id = ?1", [id, title])?;
    }
    if let Some(word) = ctx.optional_str("type") {
        let kind = ensure_concept(ctx, Kind::WorkoutKind, word)?;
        connection.execute(
            "UPDATE activity SET type_id = ?2 WHERE id = ?1",
            [id, &kind],
        )?;
    }
    for (column, name) in [("starts", "starts"), ("ends", "ends")] {
        if let Some(text) = ctx.optional_str(name) {
            let instant =
                instant(connection, text)?.map_err(|detail| VaultError::InvalidInput {
                    name: name.to_owned(),
                    detail,
                })?;
            connection.execute(
                &format!("UPDATE activity SET {column} = ?2 WHERE id = ?1"),
                [id, &instant],
            )?;
        }
    }
    set_measures(ctx, id)?;
    ctx.touch(id)?;
    Ok(serde_json::json!({ "workout_id": id }))
}

#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    const LOG: &[CommandCondition] = &[CommandCondition {
        predicate: "a_workout_starts_on_a_day_and_does_not_end_before",
        check: pre_log,
    }];
    const EDIT: &[CommandCondition] = &[CommandCondition {
        predicate: "a_workout_the_member_logged_and_does_not_end_before",
        check: pre_edit,
    }];
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
                "title": { "type": "string", "minLength": 1, "maxLength": 200 },
                "starts": { "type": "string", "minLength": 1 },
                "ends": { "type": "string", "minLength": 1 },
                "moving_s": { "type": ["integer", "null"], "minimum": 1 },
                "distance_m": { "type": ["number", "null"], "minimum": 0 },
                "energy_kcal": { "type": ["number", "null"], "minimum": 0 },
                "heart_bpm": { "type": ["integer", "null"], "minimum": 1 },
                "climb_m": { "type": ["number", "null"], "minimum": 0 }
              }
            }"#,
            Idempotency::Idempotent,
            EDIT,
            edit,
        ),
    ]
}
