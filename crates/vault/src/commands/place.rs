//! `place.*`: somewhere the member keeps, and the offline gazetteer's word for it.
//!
//! **A place is one the member made** (D5, H3). It is an entity of kind `place` with a name (the
//! entity's title, so `entity.retitle` names one and a photograph or an event at it follows the
//! name into its search text), and coordinates, an address and a zone, all optional. Nothing
//! else creates one: a photograph carries where it was taken in its own `lat`/`lon` and never
//! makes a place titled with a coordinate, and the words a phone gives an event's location are
//! the event's `location`, not a place. A photograph, an event, a workout or a touch is attached
//! to a place by the member's choice.
//!
//! `locality` is **derived** — the nearest city the offline gazetteer matched — and written by
//! `place.locate` alone, so an edit cannot undo it and a member's address is never mistaken for
//! it. A place's coordinates are one point in the spatial index (the map reads
//! `index::viewport`); the commit maintains it from these rows.
//!
//! The trash and the purge are the shared verbs: a place in the trash is no longer drawn on the
//! map, and a purge lets go of the photographs and events that named it (they keep their
//! coordinates and their words).

use crate::commands::entity::{self, lookup_live};
use crate::commands::{
    CommandCondition, CommandCtx, CommandDefinition, Idempotency, deserialize_patch,
};
use crate::error::Result;
use crate::model::Kind;

/// The five columns that name a place: an event, one day of a series, a workout, a touch and a
/// photograph.
const PLACE_COLUMNS: [&str; 5] = ["event", "occurrence", "workout", "touch", "photo"];

fn pre_merge(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let (from, into) = (ctx.required_str("from")?, ctx.required_str("into")?);
    if from == into {
        return Ok(Some("a place cannot be merged into itself".to_owned()));
    }
    for id in [from, into] {
        let found = match lookup_live(ctx.connection(), id)? {
            Ok(found) => found,
            Err(sentence) => return Ok(Some(sentence)),
        };
        if found.kind != Kind::Place {
            return Ok(Some(format!(
                "“{}” is a {}, and only places are merged",
                found.title,
                found.kind.noun()
            )));
        }
    }
    Ok(None)
}

/// `place.merge`: the place `from` and the place `into` are one, and `into` stays. Everything that
/// was at `from` is at `into`, and then `from` is purged. Where `into` has no coordinates, address
/// or zone, it takes the ones `from` had.
fn merge(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let (loser, winner) = (ctx.required_str("from")?, ctx.required_str("into")?);
    let connection = ctx.connection();
    connection.execute(
        "UPDATE place SET
           lat = CASE WHEN place.lat IS NULL THEN l.lat ELSE place.lat END,
           lon = CASE WHEN place.lat IS NULL THEN l.lon ELSE place.lon END,
           address = COALESCE(place.address, l.address), zone = COALESCE(place.zone, l.zone)
         FROM (SELECT * FROM place WHERE id = ?1) AS l
         WHERE place.id = ?2",
        [loser, winner],
    )?;
    let mut moved = 0;
    for table in PLACE_COLUMNS {
        moved += connection.execute(
            &format!("UPDATE {table} SET place_id = ?2 WHERE place_id = ?1"),
            [loser, winner],
        )?;
    }
    let mut purged = Vec::new();
    entity::purge_one(ctx, loser, &mut purged)?;
    ctx.touch(winner)?;
    ctx.mark_for_index(winner);
    Ok(serde_json::json!({ "into": winner, "moved": moved }))
}

#[derive(serde::Deserialize)]
struct AddInput {
    id: Option<String>,
    title: String,
    lat: Option<f64>,
    lon: Option<f64>,
    address: Option<String>,
    zone: Option<String>,
}

fn pre_add(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let input: AddInput = ctx.parse_input()?;
    if input.title.trim().is_empty() {
        return Ok(Some("a place needs a name".to_owned()));
    }
    Ok((input.lat.is_some() != input.lon.is_some())
        .then(|| "a place's coordinates are a latitude and a longitude together".to_owned()))
}

fn add(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let input: AddInput = ctx.parse_input()?;
    let title = input.title.trim();
    let id = match input.id.as_deref() {
        Some(id) => {
            ctx.insert_entity_in(id, Kind::Place, title, None)?;
            id.to_owned()
        }
        None => ctx.insert_entity_under(Kind::Place, title, None)?,
    };
    ctx.connection().execute(
        "INSERT INTO place (id, lat, lon, address, zone) VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![id, input.lat, input.lon, input.address, input.zone],
    )?;
    Ok(serde_json::json!({ "id": id }))
}

/// A live place: a place in the trash is frozen, restore it first.
fn live_place(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    Ok(
        match lookup_live(ctx.connection(), ctx.required_str("id")?)? {
            Err(sentence) => Some(sentence),
            Ok(found) if found.kind != Kind::Place => Some(format!(
                "“{}” is a {}, not a place",
                found.title,
                found.kind.noun()
            )),
            Ok(_) => None,
        },
    )
}

fn pre_edit(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if let Some(sentence) = live_place(ctx)? {
        return Ok(Some(sentence));
    }
    if ctx
        .optional_str("title")
        .is_some_and(|title| title.trim().is_empty())
    {
        return Ok(Some("a place needs a name".to_owned()));
    }
    let given = |key: &str| ctx.input.get(key).is_some_and(|value| !value.is_null());
    Ok((given("lat") != given("lon"))
        .then(|| "a place's coordinates are a latitude and a longitude together".to_owned()))
}

#[derive(serde::Deserialize)]
struct EditInput {
    id: String,
    title: Option<String>,
    #[serde(default, deserialize_with = "deserialize_patch")]
    lat: Option<Option<f64>>,
    #[serde(default, deserialize_with = "deserialize_patch")]
    lon: Option<Option<f64>>,
    #[serde(default, deserialize_with = "deserialize_patch")]
    address: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_patch")]
    zone: Option<Option<String>>,
}

/// `place.edit`: its name, where it is, its address, its zone. A name goes through the one rename
/// path, so what waits for that title resolves.
fn edit(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let input: EditInput = ctx.parse_input()?;
    if let Some(title) = input.title.as_deref() {
        entity::rename(ctx, &input.id, title.trim())?;
    }
    if let (Some(lat), Some(lon)) = (input.lat, input.lon) {
        // One statement: the table holds a latitude and a longitude together after it.
        ctx.connection().execute(
            "UPDATE place SET lat = ?2, lon = ?3 WHERE id = ?1",
            rusqlite::params![input.id, lat, lon],
        )?;
    }
    if let Some(address) = input.address {
        ctx.connection().execute(
            "UPDATE place SET address = ?2 WHERE id = ?1",
            rusqlite::params![input.id, address],
        )?;
    }
    if let Some(zone) = input.zone {
        ctx.connection().execute(
            "UPDATE place SET zone = ?2 WHERE id = ?1",
            rusqlite::params![input.id, zone],
        )?;
    }
    ctx.touch(&input.id)?;
    Ok(serde_json::json!({ "id": input.id }))
}

#[derive(serde::Deserialize)]
struct LocateInput {
    id: String,
    locality: Option<String>,
}

fn pre_locate(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let input: LocateInput = ctx.parse_input()?;
    Ok(
        match crate::commands::entity::lookup(ctx.connection(), &input.id)? {
            Err(sentence) => Some(sentence),
            Ok(found) if found.kind != Kind::Place => Some(format!(
                "“{}” is a {}, not a place",
                found.title,
                found.kind.noun()
            )),
            Ok(_) => None,
        },
    )
}

/// Record the gazetteer's answer: the nearest city, or none (`null`).
fn locate(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let input: LocateInput = ctx.parse_input()?;
    let locality = input
        .locality
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty());
    ctx.connection().execute(
        "UPDATE place SET locality = ?2 WHERE id = ?1",
        rusqlite::params![input.id, locality],
    )?;
    Ok(serde_json::json!({ "id": input.id, "matched": locality.is_some() }))
}

#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    const ADD: &[CommandCondition] = &[CommandCondition {
        predicate: "place_has_a_name_and_whole_coordinates",
        check: pre_add,
    }];
    const EDIT: &[CommandCondition] = &[CommandCondition {
        predicate: "place_is_live_named_and_whole_coordinates",
        check: pre_edit,
    }];
    const LOCATE: &[CommandCondition] = &[CommandCondition {
        predicate: "entity_is_a_place",
        check: pre_locate,
    }];
    const MERGE: &[CommandCondition] = &[CommandCondition {
        predicate: "both_are_places",
        check: pre_merge,
    }];
    let mut merge_place = CommandDefinition::plain(
        "place.merge",
        "place",
        r#"{
          "type": "object",
          "required": ["from", "into"],
          "additionalProperties": false,
          "properties": {
            "from": { "type": "string", "minLength": 1 },
            "into": { "type": "string", "minLength": 1 }
          }
        }"#,
        Idempotency::Once,
        MERGE,
        merge,
    );
    merge_place.risk = crate::commands::Risk::Medium;
    merge_place.confirm = true;
    vec![
        merge_place,
        CommandDefinition::plain(
            "place.add",
            "place",
            r#"{
              "type": "object",
              "required": ["title"],
              "additionalProperties": false,
              "properties": {
                "id": { "type": "string", "minLength": 1 },
                "title": { "type": "string", "maxLength": 120 },
                "lat": { "type": ["number", "null"], "minimum": -90, "maximum": 90 },
                "lon": { "type": ["number", "null"], "minimum": -180, "maximum": 180 },
                "address": { "type": ["string", "null"], "maxLength": 1000 },
                "zone": { "type": ["string", "null"] }
              }
            }"#,
            Idempotency::Once,
            ADD,
            add,
        ),
        CommandDefinition::plain(
            "place.edit",
            "place",
            r#"{
              "type": "object",
              "required": ["id"],
              "additionalProperties": false,
              "properties": {
                "id": { "type": "string", "minLength": 1 },
                "title": { "type": "string", "maxLength": 120 },
                "lat": { "type": ["number", "null"], "minimum": -90, "maximum": 90 },
                "lon": { "type": ["number", "null"], "minimum": -180, "maximum": 180 },
                "address": { "type": ["string", "null"], "maxLength": 1000 },
                "zone": { "type": ["string", "null"] }
              }
            }"#,
            Idempotency::Idempotent,
            EDIT,
            edit,
        ),
        CommandDefinition::plain(
            "place.locate",
            "place",
            r#"{
              "type": "object",
              "required": ["id"],
              "additionalProperties": false,
              "properties": {
                "id": { "type": "string", "minLength": 1 },
                "locality": { "type": ["string", "null"], "maxLength": 200 }
              }
            }"#,
            Idempotency::Idempotent,
            LOCATE,
            locate,
        ),
    ]
}
