//! `flag.set` and `flag.clear`: starred, pinned, archived.
//!
//! A flag is one of three seeded concepts and setting it is a `tagged` edge to
//! it, on any entity that is not itself a word. A star, a pinned note, an
//! archived project and an archived category are the same row shape.

use rusqlite::Connection;
use serde_json::Value as Json;

use crate::commands::tag::{pre_flaggable, set_tagged};
use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency};
use crate::error::{Result, VaultError};
use crate::model::Flag;

fn flag_of(ctx: &CommandCtx<'_, '_>) -> Result<Flag> {
    let word = ctx.required_str("flag")?;
    Flag::parse(word).ok_or_else(|| VaultError::InvalidInput {
        name: "flag".to_owned(),
        detail: format!("`{word}` is not starred, pinned or archived"),
    })
}

fn set(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let changed = set_tagged(ctx, ctx.required_str("id")?, &flag_of(ctx)?.id(), true)?;
    Ok(serde_json::json!({ "changed": changed }))
}

fn clear(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let changed = set_tagged(ctx, ctx.required_str("id")?, &flag_of(ctx)?.id(), false)?;
    Ok(serde_json::json!({ "changed": changed }))
}

// ---------------------------------------------------------------------------
// The star as a followed field (#1183): a store that has a flag (a phone reminder's) states
// whether the row is starred, and the follow engine merges it per field like a column.
// ---------------------------------------------------------------------------

/// Whether `id` is starred now, as the JSON bool a record states it as.
pub(crate) fn starred_read(connection: &Connection, id: &str) -> Result<Json> {
    let held: bool = connection.query_row(
        "SELECT EXISTS (SELECT 1 FROM edge WHERE from_id = ?1 AND rel = 'tagged' AND to_id = ?2)",
        [id, &Flag::Starred.id()],
        |row| row.get(0),
    )?;
    Ok(Json::Bool(held))
}

/// A star in one form whatever its spelling: absent or null is not starred.
pub(crate) fn starred_canon(value: &Json) -> Json {
    Json::Bool(match value {
        Json::Bool(flag) => *flag,
        Json::Number(number) => number.as_i64().is_some_and(|n| n != 0),
        _ => false,
    })
}

fn starred_is(value: &Json) -> bool {
    starred_canon(value) == Json::Bool(true)
}

/// The store's new word on the star, for a row the member has not starred or unstarred since the
/// store last spoke (`stated`; a store that never spoke of it said "not starred"). The member's
/// own star, or their removal of it, stands.
pub(crate) fn starred_merge(
    ctx: &CommandCtx<'_, '_>,
    id: &str,
    stated: Option<&Json>,
    new: &Json,
) -> Result<bool> {
    let held = starred_is(&starred_read(ctx.connection(), id)?);
    if held != stated.is_some_and(starred_is) {
        return Ok(false);
    }
    set_tagged(ctx, id, &Flag::Starred.id(), starred_is(new))
}

/// Make the star what the store last stated.
pub(crate) fn starred_take(
    ctx: &CommandCtx<'_, '_>,
    id: &str,
    _item: Option<&str>,
    stated: &Json,
) -> Result<bool> {
    set_tagged(ctx, id, &Flag::Starred.id(), starred_is(stated))
}

const SCHEMA: &str = r#"{
  "type": "object",
  "required": ["id", "flag"],
  "additionalProperties": false,
  "properties": {
    "id": { "type": "string", "minLength": 1 },
    "flag": { "type": "string", "enum": ["starred", "pinned", "archived"] }
  }
}"#;

#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    const TAKES: &[CommandCondition] = &[CommandCondition {
        predicate: "entity_takes_a_flag",
        check: pre_flaggable,
    }];
    vec![
        CommandDefinition::plain(
            "flag.set",
            "flag",
            SCHEMA,
            Idempotency::Idempotent,
            TAKES,
            set,
        ),
        CommandDefinition::plain(
            "flag.clear",
            "flag",
            SCHEMA,
            Idempotency::Idempotent,
            TAKES,
            clear,
        ),
    ]
}
