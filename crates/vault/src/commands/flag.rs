//! `flag.set` and `flag.clear`: starred, pinned, archived.
//!
//! A flag is one of three seeded concepts and setting it is a `tagged` edge to
//! it, on any entity that is not itself a word. A star, a pinned note, an
//! archived project and an archived category are the same row shape.

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
