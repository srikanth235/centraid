//! `blob.stage`, `blob.collect`, `derivative.write` and `derivative.drop`: the
//! command door onto the blob plane ([`crate::blob`]).
//!
//! The core's stage door reaches the same functions through
//! [`crate::Vault::stage_bytes`]; a command is for a caller that wants the
//! gate.

use rusqlite::OptionalExtension;

use crate::blob;
use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency};
use crate::error::Result;

#[derive(serde::Deserialize)]
struct StageBlobInput {
    hash: String,
    size: Option<i64>,
}

fn stage(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let input: StageBlobInput = ctx.parse_input()?;
    let added = blob::stage(
        ctx.connection(),
        &input.hash,
        input.size.unwrap_or_default(),
    )?;
    Ok(serde_json::json!({ "added": added }))
}

#[derive(serde::Deserialize)]
struct CollectBlobInput {
    limit: Option<u64>,
}

fn collect(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let input: CollectBlobInput = ctx.parse_input()?;
    let limit = input.limit.and_then(|limit| usize::try_from(limit).ok());
    let released = match limit {
        Some(limit) => blob::collect_up_to(ctx.connection(), limit)?,
        None => blob::collect(ctx.connection())?,
    };
    // With a `limit`, a full piece says there may be more.
    let more = limit.is_some_and(|limit| released.len() >= limit);
    Ok(serde_json::json!({ "released": released, "more": more }))
}

fn pre_variant(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let variant = ctx.required_str("variant")?;
    let has_file = ctx.input.get("out").is_some_and(|out| !out.is_null());
    let has_text = ctx.input.get("text").is_some_and(|text| !text.is_null());
    // Whether a variant is a file is the lookup row's attribute (`derivative_variant.has_out`), not a
    // list kept here; an unknown variant is no row.
    let files: Option<bool> = ctx
        .connection()
        .query_row(
            "SELECT has_out FROM derivative_variant WHERE code = ?1",
            [variant],
            |row| row.get::<_, i64>(0).map(|has_out| has_out == 1),
        )
        .optional()?;
    let Some(files) = files else {
        return Ok(Some(format!("`{variant}` is not a kind of derivative")));
    };
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

/// A variant to drop is a lookup row; which kinds exist is the table's, not a list kept here.
fn pre_drop(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let variant = ctx.required_str("variant")?;
    let known: bool = ctx.connection().query_row(
        "SELECT EXISTS (SELECT 1 FROM derivative_variant WHERE code = ?1)",
        [variant],
        |row| row.get(0),
    )?;
    Ok((!known).then(|| format!("`{variant}` is not a kind of derivative")))
}

/// The file a variant of `blob` holds now (zero or one hash): what a write or a drop may release.
fn replaced_file(ctx: &CommandCtx<'_, '_>, blob: &str, variant: &str) -> Result<Vec<String>> {
    use rusqlite::OptionalExtension as _;
    let held: Option<Option<String>> = ctx
        .connection()
        .query_row(
            "SELECT out FROM derivative WHERE blob = ?1 AND variant = ?2",
            [blob, variant],
            |row| row.get(0),
        )
        .optional()?;
    Ok(held.flatten().into_iter().collect())
}

#[derive(serde::Deserialize)]
struct WriteDerivativeInput {
    blob: String,
    variant: String,
    out: Option<String>,
    out_size: Option<i64>,
    media_type: Option<String>,
    text: Option<String>,
}

fn write(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let input: WriteDerivativeInput = ctx.parse_input()?;
    let out = input.out.as_deref().map(|out| {
        (
            out,
            input.out_size.unwrap_or_default(),
            input.media_type.as_deref().unwrap_or_default(),
        )
    });
    // The file the variant held before this write is the one it may release.
    let replaced = replaced_file(ctx, &input.blob, &input.variant)?;
    blob::write_derivative(
        ctx.connection(),
        &ctx.now,
        &input.blob,
        &input.variant,
        out,
        input.text.as_deref(),
    )?;
    // The text and the caption are part of what the document or the photograph
    // is found by; the document itself did not change.
    for owner in blob::owners_of_blob(ctx.connection(), &input.blob)? {
        ctx.mark_for_index(&owner);
    }
    // A variant holds one file: the one it replaced is named by nothing now. Only that one is
    // asked about; the library is not walked for a thumbnail.
    let released = blob::collect_hashes(ctx.connection(), &replaced)?;
    Ok(serde_json::json!({ "blob": input.blob, "released": released }))
}

#[derive(serde::Deserialize)]
struct DropDerivativeInput {
    blob: String,
    variant: String,
}

fn drop_derivative(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let input: DropDerivativeInput = ctx.parse_input()?;
    let replaced = replaced_file(ctx, &input.blob, &input.variant)?;
    let removed = ctx.connection().execute(
        "DELETE FROM derivative WHERE blob = ?1 AND variant = ?2",
        [input.blob.as_str(), input.variant.as_str()],
    )?;
    for owner in blob::owners_of_blob(ctx.connection(), &input.blob)? {
        ctx.mark_for_index(&owner);
    }
    // The file the dropped variant held is named by nothing now.
    let released = blob::collect_hashes(ctx.connection(), &replaced)?;
    Ok(serde_json::json!({ "removed": removed > 0, "released": released }))
}

const WRITE_SCHEMA: &str = r#"{
  "type": "object",
  "required": ["blob", "variant"],
  "additionalProperties": false,
  "properties": {
    "blob": { "type": "string", "minLength": 64, "maxLength": 64 },
    "variant": { "type": "string",
                 "minLength": 1 },
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
    "variant": { "type": "string", "minLength": 1 }
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
            r#"{ "type": "object", "additionalProperties": false, "properties": {
              "limit": { "type": "integer", "minimum": 1 } } }"#,
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
            &[CommandCondition {
                predicate: "variant_is_known",
                check: pre_drop,
            }],
            drop_derivative,
        ),
    ]
}
