//! `vault.rename`: the vault's own name, the one row `vault` holds.
//!
//! The vault is a singleton and not an entity, so none of the shared verbs
//! reach it. Its name lives here and nowhere else: a shell reads it back off
//! the file, so a rename inside the vault is the only rename there is.

use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency};
use crate::error::Result;

/// The longest a vault's name goes, in characters: it is drawn on the header.
const NAME_MAX: usize = 60;

fn rename(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let name = ctx.required_str("name")?.trim();
    let changed = ctx
        .connection()
        .execute("UPDATE vault SET name = ?1 WHERE name <> ?1", [name])?;
    Ok(serde_json::json!({ "name": name, "changed": changed > 0 }))
}

fn pre_name(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let name = ctx.required_str("name")?.trim();
    Ok(if name.is_empty() {
        Some("a vault's name has to have something in it".to_owned())
    } else if name.chars().count() > NAME_MAX {
        Some(format!("a vault's name is at most {NAME_MAX} characters"))
    } else {
        None
    })
}

const SCHEMA: &str = r#"{
  "type": "object",
  "required": ["name"],
  "additionalProperties": false,
  "properties": {
    "name": { "type": "string" }
  }
}"#;

#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    vec![CommandDefinition::plain(
        "vault.rename",
        "vault",
        SCHEMA,
        Idempotency::Idempotent,
        &[CommandCondition {
            predicate: "name_is_a_name",
            check: pre_name,
        }],
        rename,
    )]
}
