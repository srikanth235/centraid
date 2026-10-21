//! `blob.stage`, `blob.collect`, `derivative.write` and `derivative.drop`: the
//! command door onto the blob plane ([`crate::blob`]).
//!
//! The core's stage door reaches the same functions through
//! [`crate::Vault::stage_bytes`]; a command is for a caller that wants the
//! journal.

use crate::blob;
use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency};
use crate::error::Result;

/// A sentence when the bytes a command names cannot be claimed: they are not
/// claimed yet and the command did not say how large they are.
///
/// **A command claims the bytes it names** (R-1135-5-9): the stage door only
/// hashes and stores, so bytes staged and never named leave no row and nothing to
/// collect, and no collector can race the command that is about to name them.
pub(crate) fn pre_claimable(ctx: &CommandCtx<'_, '_>, key: &str) -> Result<Option<String>> {
    let Some(hash) = ctx.optional_str(key) else {
        return Ok(None);
    };
    let held: i64 =
        ctx.connection()
            .query_row("SELECT COUNT(*) FROM blob WHERE hash = ?1", [hash], |row| {
                row.get(0)
            })?;
    let sized = ctx.input.get("size").is_some_and(|size| !size.is_null());
    Ok((held == 0 && !sized)
        .then(|| "those bytes have not been counted; say how large they are".to_owned()))
}

/// Claim the bytes a command names, at the size it counted (a hash already
/// claimed is left as it is, and its size must agree).
pub(crate) fn claim(ctx: &CommandCtx<'_, '_>, key: &str) -> Result<()> {
    if let Some(size) = ctx.input.get("size").and_then(serde_json::Value::as_i64) {
        blob::stage(ctx.connection(), ctx.required_str(key)?, size)?;
    }
    Ok(())
}

fn stage(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let size = ctx
        .input
        .get("size")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or_default();
    let added = blob::stage(ctx.connection(), ctx.required_str("hash")?, size)?;
    Ok(serde_json::json!({ "added": added }))
}

fn collect(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    Ok(serde_json::json!({ "collected": blob::collect(ctx.connection())? }))
}

fn pre_variant(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let variant = ctx.required_str("variant")?;
    let has_file = ctx.input.get("out").is_some_and(|out| !out.is_null());
    let has_text = ctx.input.get("text").is_some_and(|text| !text.is_null());
    let files = matches!(variant, "thumb" | "preview" | "poster");
    Ok(if files && !has_file {
        Some(format!("a {variant} is a picture and needs its bytes"))
    } else if !files && has_file {
        Some(format!(
            "a {variant} is a value stored with the row, not a file"
        ))
    } else if has_file
        && ctx
            .input
            .get("media_type")
            .and_then(serde_json::Value::as_str)
            .is_none()
    {
        Some("say what the bytes are".to_owned())
    } else if !files && !has_text {
        Some(format!("a {variant} needs its value"))
    } else {
        None
    })
}

fn write(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let hash = ctx.required_str("blob")?;
    let out = ctx
        .input
        .get("out")
        .and_then(serde_json::Value::as_str)
        .map(|out| {
            (
                out,
                ctx.input
                    .get("out_size")
                    .and_then(serde_json::Value::as_i64)
                    .unwrap_or_default(),
                ctx.optional_str("media_type").unwrap_or_default(),
            )
        });
    blob::write_derivative(
        ctx.connection(),
        &ctx.now,
        hash,
        ctx.required_str("variant")?,
        out,
        ctx.optional_str("text"),
    )?;
    // The text and the caption are part of what the document or the photograph
    // is found by; the document itself did not change.
    for owner in blob::owners_of_blob(ctx.connection(), hash)? {
        ctx.mark_for_index(&owner);
    }
    Ok(serde_json::json!({ "blob": hash }))
}

fn drop_derivative(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let hash = ctx.required_str("blob")?;
    let removed = ctx.connection().execute(
        "DELETE FROM derivative WHERE blob = ?1 AND variant = ?2",
        [hash, ctx.required_str("variant")?],
    )?;
    for owner in blob::owners_of_blob(ctx.connection(), hash)? {
        ctx.mark_for_index(&owner);
    }
    Ok(serde_json::json!({ "removed": removed > 0 }))
}

const WRITE_SCHEMA: &str = r#"{
  "type": "object",
  "required": ["blob", "variant"],
  "additionalProperties": false,
  "properties": {
    "blob": { "type": "string", "minLength": 64, "maxLength": 64 },
    "variant": { "type": "string",
                 "enum": ["thumb", "preview", "poster", "text", "caption", "phash", "thumbhash"] },
    "out": { "type": ["string", "null"], "minLength": 64, "maxLength": 64 },
    "out_size": { "type": "integer", "minimum": 0 },
    "media_type": { "type": ["string", "null"] },
    "text": { "type": ["string", "null"] }
  }
}"#;

const DROP_SCHEMA: &str = r#"{
  "type": "object",
  "required": ["blob", "variant"],
  "additionalProperties": false,
  "properties": {
    "blob": { "type": "string", "minLength": 64, "maxLength": 64 },
    "variant": { "type": "string",
                 "enum": ["thumb", "preview", "poster", "text", "caption", "phash", "thumbhash"] }
  }
}"#;

#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    vec![
        CommandDefinition::plain(
            "blob.stage",
            "blob",
            r#"{
              "type": "object",
              "required": ["hash", "size"],
              "additionalProperties": false,
              "properties": {
                "hash": { "type": "string", "minLength": 64, "maxLength": 64 },
                "size": { "type": "integer", "minimum": 0 }
              }
            }"#,
            Idempotency::Idempotent,
            &[],
            stage,
        ),
        CommandDefinition::plain(
            "blob.collect",
            "blob",
            r#"{ "type": "object", "additionalProperties": false, "properties": {} }"#,
            Idempotency::RetrySafe,
            &[],
            collect,
        ),
        CommandDefinition::plain(
            "derivative.write",
            "derivative",
            WRITE_SCHEMA,
            Idempotency::Idempotent,
            &[CommandCondition {
                predicate: "variant_has_its_value",
                check: pre_variant,
            }],
            write,
        ),
        CommandDefinition::plain(
            "derivative.drop",
            "derivative",
            DROP_SCHEMA,
            Idempotency::Idempotent,
            &[],
            drop_derivative,
        ),
    ]
}
