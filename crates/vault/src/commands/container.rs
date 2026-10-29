//! `container.create` and `container.move`: notebooks, folders, albums, lists,
//! projects, sections, areas and calendars.
//!
//! One table hosts all eight and the item's own noun is its kind. Nesting is a
//! rule of the baseline (`container_parent_shape`): a folder in a folder, a
//! notebook in a notebook, a section in a project, a project in an area; the
//! precondition says it in a sentence first.

use rusqlite::OptionalExtension;

use crate::commands::entity::{lookup_live, require};
use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency};
use crate::error::{Result, VaultError};
use crate::model::Kind;

fn kind_of(word: &str) -> Result<Kind> {
    Kind::parse(word)
        .filter(|kind| kind.is_container())
        .ok_or_else(|| VaultError::InvalidInput {
            name: "kind".to_owned(),
            detail: format!("`{word}` is not a notebook, folder, album, list, project, section, area or calendar"),
        })
}

/// Whether a container of `kind` may sit inside one of `parent`.
const fn nests(kind: Kind, parent: Kind) -> bool {
    matches!(
        (kind, parent),
        (Kind::Folder, Kind::Folder)
            | (Kind::Notebook, Kind::Notebook)
            | (Kind::Section, Kind::Project)
            | (Kind::Project, Kind::Area)
    )
}

fn parent_refusal(
    ctx: &CommandCtx<'_, '_>,
    kind: Kind,
    id: Option<&str>,
) -> Result<Option<String>> {
    let Some(parent_id) = ctx.input.get("parent").and_then(serde_json::Value::as_str) else {
        // A section is only ever a project's.
        return Ok((kind == Kind::Section).then(|| "a section belongs to a project".to_owned()));
    };
    let parent = match lookup_live(ctx.connection(), parent_id)? {
        Ok(parent) => parent,
        Err(sentence) => return Ok(Some(sentence)),
    };
    if !nests(kind, parent.kind) {
        return Ok(Some(format!(
            "a {} does not go inside a {}",
            kind.noun(),
            parent.kind.noun()
        )));
    }
    if let Some(id) = id {
        // Climb from the new parent: finding the container itself means it
        // would end up inside itself.
        let inside: bool = ctx.connection().query_row(
            "WITH RECURSIVE up(id) AS (
               SELECT ?1 UNION SELECT c.parent_id FROM container c JOIN up ON c.id = up.id
                WHERE c.parent_id IS NOT NULL)
             SELECT EXISTS (SELECT 1 FROM up WHERE id = ?2)",
            [parent_id, id],
            |row| row.get(0),
        )?;
        if inside {
            return Ok(Some(format!("“{}” cannot go inside itself", parent.title)));
        }
    }
    Ok(None)
}

fn pre_create(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let kind = kind_of(ctx.required_str("kind")?)?;
    if ctx.required_str("title")?.trim().is_empty() {
        return Ok(Some(format!("a {} needs a name", kind.noun())));
    }
    parent_refusal(ctx, kind, None)
}

fn create(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let kind = kind_of(ctx.required_str("kind")?)?;
    let title = ctx.required_str("title")?.trim();
    let parent = ctx.input.get("parent").and_then(serde_json::Value::as_str);
    let id = match ctx.optional_str("id") {
        Some(id) => {
            ctx.insert_entity_as(id, kind, title)?;
            id.to_owned()
        }
        None => ctx.insert_entity(kind, title)?,
    };
    let position = ctx
        .input
        .get("position")
        .and_then(serde_json::Value::as_f64);
    ctx.connection().execute(
        "INSERT INTO container (id, kind, parent_id, color, position)
         VALUES (?1, ?2, ?3, ?4, COALESCE(?5,
           (SELECT COALESCE(MAX(position), 0) + 1 FROM container
             WHERE kind = ?2 AND parent_id IS ?3)))",
        rusqlite::params![
            id,
            kind.as_str(),
            parent,
            ctx.input.get("color").and_then(serde_json::Value::as_str),
            position
        ],
    )?;
    Ok(serde_json::json!({ "id": id }))
}

fn pre_move(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let found = match lookup_live(ctx.connection(), ctx.required_str("id")?)? {
        Ok(found) => found,
        Err(sentence) => return Ok(Some(sentence)),
    };
    if !found.kind.is_container() {
        return Ok(Some(format!("a {} is not a container", found.kind.noun())));
    }
    parent_refusal(ctx, found.kind, Some(&found.id))
}

fn move_container(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let id = ctx.required_str("id")?;
    require(ctx.connection(), id)?;
    let parent = ctx.input.get("parent").and_then(serde_json::Value::as_str);
    let position = ctx
        .input
        .get("position")
        .and_then(serde_json::Value::as_f64);
    let kind: Option<String> = ctx
        .connection()
        .query_row("SELECT kind FROM container WHERE id = ?1", [id], |row| {
            row.get(0)
        })
        .optional()?;
    ctx.connection().execute(
        "UPDATE container SET parent_id = ?2,
                position = COALESCE(?3,
                  (SELECT COALESCE(MAX(position), 0) + 1 FROM container
                    WHERE kind = ?4 AND parent_id IS ?2))
          WHERE id = ?1",
        rusqlite::params![id, parent, position, kind],
    )?;
    ctx.touch(id)?;
    // A SECTION TAKES ITS TASKS WITH IT. A task names its project and its
    // section, and the baseline's trigger refuses a task whose section is in
    // another project; it fires on a write to the task, so moving the section
    // alone would leave its tasks (trashed ones too) pointing at the old
    // project, a state no task command could then edit.
    if kind.as_deref() == Some("section") {
        let tasks: Vec<String> = ctx
            .connection()
            .prepare("SELECT id FROM task WHERE section_id = ?1 AND project_id IS NOT ?2")?
            .query_map(rusqlite::params![id, parent], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        for task in tasks {
            ctx.connection().execute(
                "UPDATE task SET project_id = ?2 WHERE id = ?1",
                rusqlite::params![task, parent],
            )?;
            ctx.touch(&task)?;
        }
    }
    Ok(serde_json::json!({ "id": id }))
}

/// The calendar a followed phone calendar is, founded the first time the calendar is read and kept
/// every time after ([#1146](https://github.com/srikanth235/centraid/issues/1146)): a calendar of
/// the vault titled as the phone calls it, with the phone's colour. The phone's colour and name
/// follow it, except that a name the member changed stands, and a calendar the member trashed is
/// left where they put it. Events an older pass filed under the vault's own calendar move to it.
pub(crate) fn follow_calendar(
    ctx: &CommandCtx<'_, '_>,
    home: &crate::commands::follow::Home<'_>,
) -> Result<String> {
    let connection = ctx.connection();
    let title = home.label.trim();
    if let Some(fills) = home.fills {
        let Some(found) = crate::commands::entity::find(connection, fills)? else {
            return Ok(fills.to_owned());
        };
        if found.deleted_at.is_some() {
            return Ok(fills.to_owned());
        }
        if let Some(color) = home.color
            && connection.execute(
                "UPDATE container SET color = ?2 WHERE id = ?1 AND color IS NOT ?2",
                [fills, color],
            )? > 0
        {
            ctx.touch(fills)?;
        }
        if home.was == Some(found.title.as_str()) && found.title != title {
            connection.execute("UPDATE entity SET title = ?2 WHERE id = ?1", [fills, title])?;
            ctx.touch(fills)?;
        }
        return Ok(fills.to_owned());
    }
    let id = ctx.insert_entity(Kind::Calendar, title)?;
    connection.execute(
        "INSERT INTO container (id, kind, color, position)
         VALUES (?1, 'calendar', ?2,
           (SELECT COALESCE(MAX(position), 0) + 1 FROM container
             WHERE kind = 'calendar' AND parent_id IS NULL))",
        rusqlite::params![id, home.color],
    )?;
    let filed: Vec<String> = connection
        .prepare(
            "SELECT e.id FROM source s JOIN event e ON e.id = s.entity_id
              WHERE s.origin_id = ?1 AND e.calendar_id = ?2",
        )?
        .query_map([home.origin, crate::model::DEFAULT_CALENDAR_ID], |row| {
            row.get(0)
        })?
        .collect::<rusqlite::Result<_>>()?;
    for event in filed {
        connection.execute(
            "UPDATE event SET calendar_id = ?2 WHERE id = ?1",
            [&event, &id],
        )?;
        ctx.touch(&event)?;
    }
    Ok(id)
}

#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    vec![
        CommandDefinition::plain(
            "container.create",
            "container",
            r#"{
              "type": "object",
              "required": ["kind", "title"],
              "additionalProperties": false,
              "properties": {
                "id": { "type": "string", "minLength": 1 },
                "kind": { "type": "string",
                          "enum": ["notebook", "folder", "album", "list", "project", "section", "area", "calendar"] },
                "title": { "type": "string", "maxLength": 1000 },
                "parent": { "type": ["string", "null"] },
                "color": { "type": ["string", "null"] },
                "position": { "type": ["number", "null"] }
              }
            }"#,
            Idempotency::Once,
            &[CommandCondition {
                predicate: "container_has_a_name_and_a_place",
                check: pre_create,
            }],
            create,
        ),
        CommandDefinition::plain(
            "container.move",
            "container",
            r#"{
              "type": "object",
              "required": ["id"],
              "additionalProperties": false,
              "properties": {
                "id": { "type": "string", "minLength": 1 },
                "parent": { "type": ["string", "null"] },
                "position": { "type": ["number", "null"] }
              }
            }"#,
            Idempotency::Idempotent,
            &[CommandCondition {
                predicate: "container_can_go_there",
                check: pre_move,
            }],
            move_container,
        ),
    ]
}
