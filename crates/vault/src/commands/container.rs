//! `container.create`, `container.style` and `container.move`: notebooks, folders, albums, lists,
//! projects, sections, areas and calendars.
//!
//! One table hosts all eight and the item's own noun is its kind. Nesting is a
//! rule of the baseline (`container_parent_shape`): a folder in a folder, a
//! notebook in a notebook, a section in a project, a project in an area; the
//! precondition says it in a sentence first.
//!
//! A list (a project, or a list) and a calendar wear a colour of the eight-colour list palette and
//! an icon of a short curated set, both by key; `container.style` sets or clears them and
//! `container.create` takes them at birth. A followed calendar's colour is the phone's own spelling
//! and is read, never refused, wherever it was stored.

use rusqlite::OptionalExtension;

use crate::commands::entity::{lookup_live, require};
use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency};
use crate::error::{Result, VaultError};
use crate::model::Kind;

/// The eight list colours: the `[list]` palette of `design/tokens.toml`, which a list or a calendar
/// wears by key. A test holds this equal to the file.
pub const LIST_COLORS: [&str; 8] = [
    "blue",
    "mustard",
    "violet",
    "petrol",
    "indigo",
    "graphite",
    "raspberry",
    "orchid",
];

/// The party-wheel hues a followed phone calendar wears (`var(--c-<hue>)`), the shell's naming of
/// the phone's colour. A calendar the member makes wears a [`LIST_COLORS`] key.
pub const PHONE_CALENDAR_COLORS: [&str; 8] = [
    "var(--c-rose)",
    "var(--c-amber)",
    "var(--c-ochre)",
    "var(--c-forest)",
    "var(--c-teal)",
    "var(--c-slate)",
    "var(--c-indigo)",
    "var(--c-violet)",
];

/// The icons a list or a calendar may wear: keys of `design/icons.toml`, curated to the ones that
/// read as a place to put things. A test holds every key in the file.
pub const LIST_ICONS: [&str; 32] = [
    "Beaker",
    "Bell",
    "Bolt",
    "Book",
    "Bookmark",
    "Calendar",
    "CalendarBlank",
    "Camera",
    "Cloud",
    "Coin",
    "Compass",
    "Flag",
    "Folder",
    "Gift",
    "Globe",
    "Gym",
    "Habit",
    "Heart",
    "Home",
    "Inbox",
    "Journal",
    "List",
    "MapPin",
    "Moon",
    "Mood",
    "Music",
    "Pin",
    "Plant",
    "Receipt",
    "Star",
    "Sun",
    "Users",
];

/// Whether a container of `kind` wears a colour and an icon of the palette.
const fn is_styled(kind: Kind) -> bool {
    matches!(kind, Kind::List | Kind::Project | Kind::Calendar)
}

/// The sentence refusing a colour or an icon a list or a calendar cannot wear.
fn style_refusal(input: &serde_json::Value, kind: Kind) -> Option<String> {
    if let Some(color) = input.get("color").and_then(serde_json::Value::as_str)
        && is_styled(kind)
        && !LIST_COLORS.contains(&color)
    {
        return Some(format!(
            "“{color}” is not one of the list colours: {}",
            LIST_COLORS.join(", ")
        ));
    }
    if let Some(icon) = input.get("icon").and_then(serde_json::Value::as_str) {
        if !is_styled(kind) {
            return Some(format!("a {} does not wear an icon", kind.noun()));
        }
        if !LIST_ICONS.contains(&icon) {
            return Some(format!("“{icon}” is not an icon a list can wear"));
        }
    }
    None
}

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
    if let Some(sentence) = style_refusal(&ctx.input, kind) {
        return Ok(Some(sentence));
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
        "INSERT INTO container (id, kind, parent_id, color, icon, position)
         VALUES (?1, ?2, ?3, ?4, ?6, COALESCE(?5,
           (SELECT COALESCE(MAX(position), 0) + 1 FROM container
             WHERE kind = ?2 AND parent_id IS ?3)))",
        rusqlite::params![
            id,
            kind.as_str(),
            parent,
            ctx.input.get("color").and_then(serde_json::Value::as_str),
            position,
            ctx.input.get("icon").and_then(serde_json::Value::as_str)
        ],
    )?;
    Ok(serde_json::json!({ "id": id }))
}

fn pre_style(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let found = match lookup_live(ctx.connection(), ctx.required_str("id")?)? {
        Ok(found) => found,
        Err(sentence) => return Ok(Some(sentence)),
    };
    if !is_styled(found.kind) {
        return Ok(Some(format!(
            "a {} wears no colour or icon of its own",
            found.kind.noun()
        )));
    }
    if ctx.input.get("color").is_none() && ctx.input.get("icon").is_none() {
        return Ok(Some(
            "say a colour or an icon to set, or null to clear".to_owned(),
        ));
    }
    Ok(style_refusal(&ctx.input, found.kind))
}

/// `container.style`: a list's or a calendar's colour and icon. A key that is present is set
/// (`null` clears it) and one that is absent is left alone.
fn style(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let id = ctx.required_str("id")?;
    for column in ["color", "icon"] {
        if let Some(value) = ctx.input.get(column) {
            ctx.connection().execute(
                &format!("UPDATE container SET {column} = ?2 WHERE id = ?1"),
                rusqlite::params![id, value.as_str()],
            )?;
        }
    }
    ctx.touch(id)?;
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
                "icon": { "type": ["string", "null"] },
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
            "container.style",
            "container",
            r#"{
              "type": "object",
              "required": ["id"],
              "additionalProperties": false,
              "properties": {
                "id": { "type": "string", "minLength": 1 },
                "color": { "type": ["string", "null"] },
                "icon": { "type": ["string", "null"] }
              }
            }"#,
            Idempotency::Idempotent,
            &[CommandCondition {
                predicate: "container_wears_a_colour_and_the_style_is_the_palettes",
                check: pre_style,
            }],
            style,
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
