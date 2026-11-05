//! Reminder source fields, using the shared follower rather than a second writer.

use rusqlite::{Connection, OptionalExtension};
use serde_json::{Map, Value as Json, json};

use super::{CommandCtx, entity, follow, tag};
use crate::error::Result;
use crate::model::{Flag, Kind};
use crate::time::{rrule, temporal};

pub(crate) fn defaults(
    _: &Connection,
    origin: &follow::OriginRow,
) -> Result<Vec<(&'static str, rusqlite::types::Value)>> {
    Ok(origin
        .fills
        .clone()
        .map(|id| ("project_id", id.into()))
        .into_iter()
        .collect())
}

pub(crate) fn list(ctx: &CommandCtx<'_, '_>, home: &follow::Home<'_>) -> Result<String> {
    let connection = ctx.connection();
    if let Some(id) = home.fills {
        if let Some(held) = entity::find(connection, id)?
            && held.deleted_at.is_none()
            && home.was == Some(held.title.as_str())
            && held.title != home.label
        {
            connection.execute(
                "UPDATE entity SET title = ?2 WHERE id = ?1",
                [id, home.label],
            )?;
            ctx.touch(id)?;
        }
        return Ok(id.to_owned());
    }
    let id = ctx.insert_entity(Kind::Project, home.label)?;
    connection.execute(
        "INSERT INTO container (id, kind, position) VALUES (?1, 'project',
         (SELECT COALESCE(MAX(position), 0) + 1 FROM container WHERE kind = 'project'))",
        [&id],
    )?;
    Ok(id)
}

pub(crate) fn shape(
    ctx: &CommandCtx<'_, '_>,
    fields: &mut Map<String, Json>,
) -> std::result::Result<(), String> {
    let bad = |name: &str, detail: &str| format!("{name}: {detail}");
    if let Some(due) = fields.get("due").and_then(Json::as_str)
        && !matches!(
            temporal::classify(due),
            Some(
                temporal::Kind::LocalDate
                    | temporal::Kind::FloatingDateTime
                    | temporal::Kind::Instant
            )
        )
    {
        return Err(bad("due", "the reminder needs a real date or time"));
    }
    if let Some(rule) = fields.get("rule").and_then(Json::as_str) {
        rrule::inspect(rule)
            .map_err(|_| bad("rule", "the reminder's repeat rule is not supported"))?;
        if fields.get("due").is_none_or(Json::is_null) {
            return Err(bad("rule", "a repeating reminder needs a due date"));
        }
    }
    if fields.get("status").and_then(Json::as_str) == Some("done")
        && fields.get("done_at").is_none_or(Json::is_null)
    {
        fields.insert("done_at".to_owned(), json!(ctx.now));
    }
    Ok(())
}

pub(crate) fn canon(value: &Json) -> Json {
    value.clone()
}

pub(crate) fn alarms(connection: &Connection, id: &str) -> Result<Json> {
    let (raw, primary): (Option<String>, Option<i64>) = connection.query_row(
        "SELECT reminders, remind_before_min FROM task WHERE id = ?1",
        [id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    Ok(raw
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| json!(primary.into_iter().collect::<Vec<_>>())))
}

pub(crate) fn merge_alarms(
    ctx: &CommandCtx<'_, '_>,
    id: &str,
    was: Option<&Json>,
    new: &Json,
) -> Result<bool> {
    let held = super::calendar_sync::sorted(&alarms(ctx.connection(), id)?);
    if was.is_some_and(|was| super::calendar_sync::sorted(was) != held)
        || (was.is_none() && held != json!([]))
    {
        return Ok(false);
    }
    let new = super::calendar_sync::sorted(new);
    if held == new {
        return Ok(false);
    }
    let dated: bool = ctx.connection().query_row(
        "SELECT due IS NOT NULL FROM task WHERE id = ?1",
        [id],
        |row| row.get(0),
    )?;
    ctx.connection().execute(
        "UPDATE task SET reminders = ?2, remind_before_min = ?3 WHERE id = ?1",
        rusqlite::params![
            id,
            new.to_string(),
            dated
                .then(|| new
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Json::as_i64)
                    .filter(|n| *n >= 0)
                    .max())
                .flatten()
        ],
    )?;
    ctx.touch(id)?;
    Ok(true)
}

pub(crate) fn flagged(connection: &Connection, id: &str) -> Result<Json> {
    Ok(json!(connection.query_row("SELECT EXISTS(SELECT 1 FROM edge WHERE from_id = ?1 AND rel = 'tagged' AND to_id = 'flag:starred')", [id], |row| row.get::<_, bool>(0))?))
}

pub(crate) fn merge_flag(
    ctx: &CommandCtx<'_, '_>,
    id: &str,
    was: Option<&Json>,
    new: &Json,
) -> Result<bool> {
    let held = flagged(ctx.connection(), id)?;
    if was.is_some_and(|was| *was != held) || (was.is_none() && held == json!(true)) {
        return Ok(false);
    }
    tag::set_tagged(ctx, id, &Flag::Starred.id(), new.as_bool().unwrap_or(false))
}

pub(crate) fn parent(connection: &Connection, id: &str) -> Result<Json> {
    let key: Option<String> = connection
        .query_row(
            "SELECT s.external_id FROM task t JOIN source s ON s.entity_id = t.parent_id
         WHERE t.id = ?1 AND s.system = 'reminders'",
            [id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(key.map_or(Json::Null, Json::String))
}

pub(crate) fn merge_parent(
    ctx: &CommandCtx<'_, '_>,
    id: &str,
    was: Option<&Json>,
    new: &Json,
) -> Result<bool> {
    let connection = ctx.connection();
    let held = parent(connection, id)?;
    let current_id: Option<String> =
        connection.query_row("SELECT parent_id FROM task WHERE id = ?1", [id], |row| {
            row.get(0)
        })?;
    if was.is_some_and(|was| *was != held) || (was.is_none() && current_id.is_some()) {
        return Ok(false);
    }
    let reference = ctx
        .input
        .get("origin")
        .and_then(|origin| origin.get("ref"))
        .and_then(Json::as_str)
        .unwrap_or_default();
    let parent: Option<String> = match new.as_str().filter(|s| !s.is_empty()) {
        Some(key) => connection
            .query_row(
                "SELECT s.entity_id FROM source s JOIN origin o ON o.id = s.origin_id
             JOIN task t ON t.id = s.entity_id WHERE o.system = 'reminders' AND o.ref = ?1
             AND s.external_id = ?2 AND t.id <> ?3",
                [reference, key, id],
                |row| row.get(0),
            )
            .optional()?
            .flatten(),
        None => None,
    };
    if parent == current_id {
        return Ok(false);
    }
    connection.execute(
        "UPDATE task SET parent_id = ?2 WHERE id = ?1",
        rusqlite::params![id, parent],
    )?;
    ctx.touch(id)?;
    Ok(true)
}
