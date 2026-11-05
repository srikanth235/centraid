//! Calendar child fields and native write plans. The commit guard remains the vault writer.

use super::{CommandCtx, CommandDefinition, Idempotency, follow};
use crate::error::Result;
use crate::model::Kind;
use rusqlite::{Connection, OptionalExtension};
use serde_json::{Value as Json, json};

/// A phone snapshot covers a moving window, not every event the calendar has
/// ever held. Absence outside that window is no evidence of deletion.
pub(super) fn outside_window(ctx: &CommandCtx<'_, '_>, id: &str) -> Result<bool> {
    let (start, end, timing, zone, rule): (
        String,
        Option<String>,
        String,
        Option<String>,
        Option<String>,
    ) = ctx.connection().query_row(
        "SELECT starts, ends, timing, zone, rule FROM event WHERE id = ?1",
        [id],
        |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        },
    )?;
    Ok(outside_statement(
        ctx,
        &json!({"starts":start,"ends":end,"timing":timing,"zone":zone,"rule":rule}),
    ))
}

pub(super) fn outside_statement(ctx: &CommandCtx<'_, '_>, statement: &Json) -> bool {
    use crate::time::{
        recurrence::{ExpandInput, Semantics, expand, parse_instant_ms, shift_temporal},
        zone::{FireZone, parse_wall_iso, wall_epoch},
    };
    let config = &ctx.input["origin"]["config"];
    let (Some(from), Some(to)) = (config["read_from"].as_str(), config["read_to"].as_str()) else {
        return false;
    };
    // Native windows begin in the device's civil zone. The extra day is
    // conservative at both boundaries, including a DST transition.
    let from = shift_temporal(from, -86_400_000);
    let to = shift_temporal(to, 86_400_000);
    let Some(start) = statement["starts"].as_str() else {
        return true;
    };
    let end = statement["ends"].as_str().unwrap_or(start);
    if let Some(rule) = statement["rule"].as_str() {
        if crate::time::rrule::inspect(rule).is_err() {
            return true;
        }
        let zone = statement["zone"]
            .as_str()
            .and_then(|zone| FireZone::named(zone).ok());
        let mut input = ExpandInput::new(rule, start, &from, &to)
            .with_semantics(Semantics::from_stored(statement["timing"].as_str()))
            .at_most(1);
        input.zone = zone.as_ref();
        return expand(&input).is_empty();
    }
    let millis =
        |value: &str| parse_instant_ms(value).or_else(|| parse_wall_iso(value).map(wall_epoch));
    millis(start)
        .zip(millis(&to))
        .is_some_and(|(start, to)| start > to)
        || millis(end)
            .zip(millis(&from))
            .is_some_and(|(end, from)| end < from)
}

pub(crate) fn reminders(connection: &Connection, id: &str) -> Result<Json> {
    let raw: Option<String> =
        connection.query_row("SELECT reminders FROM event WHERE id = ?1", [id], |row| {
            row.get(0)
        })?;
    Ok(raw
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| json!([])))
}

pub(crate) fn sorted(value: &Json) -> Json {
    let mut values: Vec<i64> = value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Json::as_i64)
        .collect();
    values.sort_unstable();
    values.dedup();
    json!(values)
}

pub(crate) fn location(connection: &Connection, id: &str) -> Result<Json> {
    let name: Option<String> = connection.query_row(
        "SELECT p.title FROM event v LEFT JOIN entity p ON p.id = v.place_id WHERE v.id = ?1",
        [id],
        |row| row.get(0),
    )?;
    Ok(name.map_or(Json::Null, Json::String))
}

pub(crate) fn place_name(value: &Json) -> Json {
    value
        .as_str()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map_or(Json::Null, |name| json!(name.to_lowercase()))
}

pub(crate) fn merge_location(
    ctx: &CommandCtx<'_, '_>,
    id: &str,
    was: Option<&Json>,
    new: &Json,
) -> Result<bool> {
    let held = location(ctx.connection(), id)?;
    if was.is_some_and(|was| place_name(was) != place_name(&held))
        || (was.is_none() && !held.is_null())
    {
        return Ok(false);
    }
    if place_name(&held) == place_name(new) {
        return Ok(false);
    }
    let place = new
        .as_str()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(|name| super::place::find_or_found_named(ctx, name))
        .transpose()?;
    ctx.connection().execute(
        "UPDATE event SET place_id = ?2 WHERE id = ?1",
        rusqlite::params![id, place],
    )?;
    ctx.touch(id)?;
    Ok(true)
}

pub(crate) fn merge_reminders(
    ctx: &CommandCtx<'_, '_>,
    id: &str,
    was: Option<&Json>,
    new: &Json,
) -> Result<bool> {
    let held = sorted(&reminders(ctx.connection(), id)?);
    if was.is_some_and(|was| sorted(was) != held) || (was.is_none() && held != json!([])) {
        return Ok(false);
    }
    let new = sorted(new);
    if held == new {
        return Ok(false);
    }
    ctx.connection().execute(
        "UPDATE event SET reminders = ?2 WHERE id = ?1",
        [id, &new.to_string()],
    )?;
    ctx.touch(id)?;
    Ok(true)
}

pub(crate) fn attendees(connection: &Connection, id: &str) -> Result<Json> {
    let mut stmt = connection.prepare("SELECT e.title, COALESCE((SELECT value FROM contact_point WHERE person_id = e.id AND kind = 'email' AND preferred = 1), (SELECT value FROM contact_point WHERE person_id = e.id AND kind = 'email' ORDER BY normalized LIMIT 1), ''), COALESCE(g.state, 'needs-action') FROM edge g JOIN entity e ON e.id = g.to_id WHERE g.from_id = ?1 AND g.rel = 'attendee' ORDER BY g.to_id")?;
    let values = stmt.query_map([id], |row| Ok(json!({"name": row.get::<_, String>(0)?, "email": row.get::<_, String>(1)?, "state": row.get::<_, String>(2)?})))?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(guests(&json!(values)))
}

pub(crate) fn guests(value: &Json) -> Json {
    let mut values: Vec<Json> = value.as_array().into_iter().flatten().map(|guest| json!({
        "name": guest.get("name").and_then(Json::as_str).unwrap_or_default(),
        "email": guest.get("email").and_then(Json::as_str).unwrap_or_default().trim().to_lowercase(),
        "state": guest.get("state").and_then(Json::as_str).filter(|s| ["accepted", "declined", "tentative"].contains(s)).unwrap_or("needs-action")
    })).filter(|g| !g["email"].as_str().unwrap_or_default().is_empty()).collect();
    values.sort_by_key(|g| g["email"].as_str().unwrap_or_default().to_owned());
    values.dedup_by(|a, b| a["email"] == b["email"]);
    json!(values)
}

/// Names label People, where a member can rename a contact independently of an
/// invitation. Calendar membership and response belong to the attendee edge.
pub(crate) fn guest_keys(value: &Json) -> Json {
    let mut value = guests(value);
    for guest in value.as_array_mut().into_iter().flatten() {
        guest.as_object_mut().map(|guest| guest.remove("name"));
    }
    value
}

pub(crate) fn merge_attendees(
    ctx: &CommandCtx<'_, '_>,
    id: &str,
    was: Option<&Json>,
    new: &Json,
) -> Result<bool> {
    let connection = ctx.connection();
    let held = attendees(connection, id)?;
    if was.is_some_and(|was| guest_keys(was) != guest_keys(&held))
        || (was.is_none() && held != json!([]))
    {
        return Ok(false);
    }
    let wanted = guests(new);
    if guest_keys(&held) == guest_keys(&wanted) {
        return Ok(false);
    }
    connection.execute(
        "DELETE FROM edge WHERE from_id = ?1 AND rel = 'attendee'",
        [id],
    )?;
    for guest in wanted.as_array().into_iter().flatten() {
        let email = guest["email"].as_str().unwrap_or_default();
        let name = guest["name"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or(email);
        let known: Option<String> = connection.query_row("SELECT p.person_id FROM contact_point p JOIN entity e ON e.id = p.person_id WHERE p.kind = 'email' AND p.normalized = ?1 AND e.deleted_at IS NULL ORDER BY e.created_at, e.id LIMIT 1", [email], |row| row.get(0)).optional()?;
        let person = if let Some(person) = known {
            person
        } else {
            let person = ctx.insert_entity(Kind::Person, name)?;
            connection.execute(
                "INSERT INTO person (id, sort_name) VALUES (?1, ?2)",
                [&person, name],
            )?;
            connection.execute("INSERT INTO contact_point (id, person_id, kind, value, normalized, preferred, position) VALUES (?1, ?2, 'email', ?3, ?3, 1, 0)", rusqlite::params![ctx.next_id(), person, email])?;
            ctx.touch(&person)?;
            person
        };
        connection.execute("INSERT INTO edge (from_id, rel, to_id, state, created_at) VALUES (?1, 'attendee', ?2, ?3, ?4)", rusqlite::params![id, person, guest["state"].as_str(), ctx.now])?;
    }
    ctx.touch(id)?;
    Ok(true)
}

pub(super) fn writes(
    ctx: &CommandCtx<'_, '_>,
    map: &follow::SystemMap,
    origin: &follow::OriginRow,
    records: &[follow::Record],
) -> Result<Json> {
    let connection = ctx.connection();
    let mut out = Vec::new();
    for record in records {
        let source: Option<(Option<String>, Option<String>, String)> = connection.query_row("SELECT entity_id, gone_at, stated FROM source WHERE origin_id = ?1 AND external_id = ?2 AND ifnull(device_id, '') = ?3", rusqlite::params![origin.id, record.external_id, record.device_id.as_deref().unwrap_or("")], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).optional()?;
        let Some((entity, gone, _)) = source else {
            continue;
        };
        let deleted = match entity.as_deref() {
            None => true,
            Some(id) => {
                let (deleted, cancelled): (Option<String>, bool) = connection.query_row(
                    "SELECT e.deleted_at, v.status = 'cancelled' FROM entity e JOIN event v ON v.id = e.id WHERE e.id = ?1",
                    [id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?;
                cancelled || (deleted.is_some() && deleted != gone)
            }
        };
        let desired = entity
            .as_deref()
            .map(|id| follow::current(connection, map, id))
            .transpose()?
            .unwrap_or_default();
        let fields: Vec<String> = record
            .fields
            .iter()
            .filter(|(key, value)| {
                key.as_str() != "overrides" && !map.agree(key, desired.get(*key), Some(value))
            })
            .map(|(key, _)| key.clone())
            .collect();
        if deleted || !fields.is_empty() {
            out.push(json!({"entity_id": entity, "external_id": record.external_id, "deleted": deleted, "fields": fields, "desired": desired}));
        } else if let (Some(id), Some(statement)) =
            (entity.as_deref(), record.fields.get("overrides"))
        {
            for mut day in super::event::override_writes(connection, id, statement, &desired)? {
                day["entity_id"] = json!(id);
                day["external_id"] = json!(record.external_id);
                out.push(day);
            }
        }
    }
    if let Some(calendar) = &origin.fills {
        let mut stmt = connection.prepare("SELECT v.id FROM event v JOIN entity e ON e.id = v.id WHERE v.calendar_id = ?1 AND e.deleted_at IS NULL AND v.status <> 'cancelled' AND NOT EXISTS(SELECT 1 FROM source s WHERE s.entity_id = v.id) ORDER BY v.rowid LIMIT 128")?;
        let new = stmt
            .query_map([calendar], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for id in new {
            let desired = follow::current(connection, map, &id)?;
            let fields: Vec<&String> = desired
                .keys()
                .filter(|key| key.as_str() != "overrides")
                .collect();
            out.push(json!({"entity_id": id, "external_id": "", "deleted": false, "fields": fields, "desired": desired}));
        }
    }
    Ok(json!(out))
}

fn acknowledged(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let connection = ctx.connection();
    let reference = ctx.required_str("origin")?;
    let origin: String = connection.query_row(
        "SELECT id FROM origin WHERE system = 'calendar' AND ref = ?1",
        [reference],
        |row| row.get(0),
    )?;
    let id = ctx.required_str("entity_id")?;
    let external = ctx.required_str("external_id")?;
    let device = ctx.optional_str("device_id");
    let fields = ctx
        .input
        .get("fields")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let exists: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM event v JOIN origin o ON o.fills = v.calendar_id WHERE o.id = ?1 AND v.id = ?2)", [&origin, id], |row| row.get(0))?;
    if !exists {
        return Ok(json!({"linked": false}));
    }
    let current: Option<(String, String)> = connection
        .query_row(
            "SELECT id, stated FROM source WHERE entity_id = ?1 AND origin_id = ?2",
            [id, &origin],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if let Some((source, stated)) = current {
        let mut stated: Json = serde_json::from_str(&stated).unwrap_or_else(|_| json!({}));
        for (key, value) in fields.as_object().into_iter().flatten() {
            stated[key] = value.clone();
        }
        connection.execute(
            "UPDATE source SET stated = ?2, seen_at = ?3, external_id = ?4, device_id = ?5 WHERE id = ?1",
            rusqlite::params![source, stated.to_string(), ctx.now, external, device],
        )?;
    } else {
        connection.execute("INSERT INTO source (id, origin_id, system, external_id, device_id, entity_id, entity_kind, stated, seen_at) VALUES (?1, ?2, 'calendar', ?3, ?4, ?5, 'event', ?6, ?7)", rusqlite::params![ctx.next_id(), origin, external, device, id, fields.to_string(), ctx.now])?;
    }
    Ok(json!({"linked": true}))
}

pub fn definitions() -> Vec<CommandDefinition> {
    vec![CommandDefinition::plain(
        "follow.calendar_written",
        "follow",
        r#"{"type":"object","additionalProperties":false,"required":["origin","entity_id","external_id","fields"],"properties":{"origin":{"type":"string"},"entity_id":{"type":"string"},"external_id":{"type":"string","minLength":1},"device_id":{"type":["string","null"]},"fields":{"type":"object"}}}"#,
        Idempotency::Idempotent,
        &[],
        acknowledged,
    )]
}
