//! `container.create`, `container.style` and `container.move`: notebooks, folders, albums, lists,
//! task lists and calendars.
//!
//! One table hosts all six and the item's own noun is its kind. A container's home is the one
//! every row has, `entity.parent_id` (a folder in a folder, a notebook in a notebook): which kind
//! goes inside which is `home_shape`. The preconditions say each refusal in a sentence first
//! ([`home_refusal`]); the database refuses the same rows.
//!
//! A list (a task list, or a list) and a calendar wear a colour of the eight-colour list palette and
//! an icon of a short curated set, both by key; `container.style` sets or clears them and
//! `container.create` takes them at birth. A followed calendar's colour is a key of the palette
//! too (the party wheel) and is read, never refused, wherever it was stored.

use crate::commands::entity::{home_refusal, lookup_live, move_home};
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

/// The party-wheel hues a followed phone calendar wears, as keys of the `palette` table (J1): the
/// phone's own colour, mapped to the nearest hue. A calendar the member makes wears a
/// [`LIST_COLORS`] key.
pub const PHONE_CALENDAR_COLORS: [&str; 8] = [
    "rose", "amber", "ochre", "forest", "teal", "slate", "indigo", "violet",
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
    matches!(kind, Kind::List | Kind::TaskList | Kind::Calendar)
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
            detail: format!(
                "`{word}` is not a notebook, folder, album, list, task list or calendar"
            ),
        })
}

fn parent_refusal(
    ctx: &CommandCtx<'_, '_>,
    kind: Kind,
    id: Option<&str>,
) -> Result<Option<String>> {
    home_refusal(ctx.connection(), kind, id, ctx.optional_str("parent"))
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

#[derive(serde::Deserialize)]
struct CreateContainerInput {
    id: Option<String>,
    kind: String,
    title: String,
    parent: Option<String>,
    color: Option<String>,
    icon: Option<String>,
    position: Option<f64>,
}

fn create(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let input: CreateContainerInput = ctx.parse_input()?;
    let kind = kind_of(&input.kind)?;
    let title = input.title.trim();
    let parent = input.parent.as_deref();
    let id = match input.id.as_deref() {
        Some(id) => {
            ctx.insert_entity_in(id, kind, title, parent)?;
            id.to_owned()
        }
        None => ctx.insert_entity_under(kind, title, parent)?,
    };
    ctx.connection().execute(
        "INSERT INTO container (id, kind, color, icon, position)
         VALUES (?1, ?2, ?3, ?6, COALESCE(?5,
           (SELECT COALESCE(MAX(c.position), 0) + 1 FROM container c JOIN entity e ON e.id = c.id
             WHERE c.kind = ?2 AND e.parent_id IS ?4)))",
        rusqlite::params![
            id,
            kind.as_str(),
            input.color,
            parent,
            input.position,
            input.icon,
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

#[derive(serde::Deserialize)]
struct StyleContainerInput {
    id: String,
    #[serde(default, deserialize_with = "crate::commands::deserialize_patch")]
    color: Option<Option<String>>,
    #[serde(default, deserialize_with = "crate::commands::deserialize_patch")]
    icon: Option<Option<String>>,
}

/// `container.style`: a list's or a calendar's colour and icon. A key that is present is set
/// (`null` clears it) and one that is absent is left alone.
fn style(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let input: StyleContainerInput = ctx.parse_input()?;
    if let Some(color) = input.color {
        ctx.connection().execute(
            "UPDATE container SET color = ?2 WHERE id = ?1",
            rusqlite::params![input.id, color],
        )?;
    }
    if let Some(icon) = input.icon {
        ctx.connection().execute(
            "UPDATE container SET icon = ?2 WHERE id = ?1",
            rusqlite::params![input.id, icon],
        )?;
    }
    ctx.touch(&input.id)?;
    Ok(serde_json::json!({ "id": input.id }))
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

#[derive(serde::Deserialize)]
struct MoveContainerInput {
    id: String,
    parent: Option<String>,
    position: Option<f64>,
}

fn move_container(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let input: MoveContainerInput = ctx.parse_input()?;
    // The home is the one path every row moves by; a container also has its place among its
    // siblings.
    move_home(ctx, &input.id, input.parent.as_deref())?;
    ctx.connection().execute(
        "UPDATE container SET position = COALESCE(?2,
                  (SELECT COALESCE(MAX(c.position), 0) + 1 FROM container c
                     JOIN entity e ON e.id = c.id
                    WHERE c.kind = container.kind AND e.parent_id IS ?3 AND c.id <> ?1))
          WHERE id = ?1",
        rusqlite::params![input.id, input.position, input.parent],
    )?;
    Ok(serde_json::json!({ "id": input.id }))
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
                          "enum": ["notebook", "folder", "album", "list", "task_list", "calendar"] },
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
