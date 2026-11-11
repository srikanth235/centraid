//! `history.*`: put an earlier value back (#1185).
//!
//! History itself is not a command: the commit door keeps every record's earlier state
//! ([`crate::history`]). What a member does with it is two verbs, both ordinary writes that make a
//! version of their own, so a restore is undone by restoring again (and a third keeps words a stale save
//! could not):
//!
//! - `history.restore_version`: the record goes back to what version `seq` held, field by field
//!   and row by row.
//! - `history.keep_version`: the words a refused stale save held, kept as the newest earlier version beside
//!   the record as it is (the record is not changed).
//! - `history.undo`: the record goes back to its newest earlier version, "undo the last change".
//!   It is the generic inverse of every edit; it is not idempotent (twice undoes then redoes).
//!   Given `seq` it undoes THAT change and nothing else: the version must still be the newest, so
//!   a record changed again since is refused ([`CHANGED_SINCE`]) rather than losing the later change.
//!
//! The versions are read with [`crate::history::earlier_versions`] through [`crate::Vault::read`].

use crate::commands::entity::lookup_live;
use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency};
use crate::error::Result;
use crate::history::{self, Scope};

fn alive(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    Ok(lookup_live(ctx.connection(), ctx.required_str("id")?)?.err())
}

fn newest(ctx: &CommandCtx<'_, '_>) -> Result<Option<i64>> {
    Ok(ctx.connection().query_row(
        "SELECT MAX(seq) FROM revision WHERE entity_id = ?1",
        [ctx.required_str("id")?],
        |row| row.get(0),
    )?)
}

fn pre_restore(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if let Some(sentence) = alive(ctx)? {
        return Ok(Some(sentence));
    }
    let held: i64 = ctx.connection().query_row(
        "SELECT COUNT(*) FROM revision WHERE entity_id = ?1 AND seq = ?2",
        rusqlite::params![ctx.required_str("id")?, ctx.input["seq"].as_i64()],
        |row| row.get(0),
    )?;
    Ok((held == 0).then(|| "That version is not in this record's history.".to_owned()))
}

/// What an undo that names its version says when the record has changed again since.
pub const CHANGED_SINCE: &str = "This can no longer be undone: it has changed since.";

fn pre_undo(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if let Some(sentence) = alive(ctx)? {
        return Ok(Some(sentence));
    }
    let Some(newest) = newest(ctx)? else {
        return Ok(Some(
            "There is no earlier version to go back to.".to_owned(),
        ));
    };
    Ok(ctx
        .input
        .get("seq")
        .and_then(serde_json::Value::as_i64)
        .filter(|seq| *seq != newest)
        .map(|_| CHANGED_SINCE.to_owned()))
}

fn answer(id: &str, seq: i64, restored: Option<history::Restored>) -> serde_json::Value {
    let restored = restored.unwrap_or(history::Restored {
        restored: false,
        kept_current: Vec::new(),
    });
    serde_json::json!({
        "id": id,
        "seq": seq,
        "restored": restored.restored,
        "kept_current": restored.kept_current,
    })
}

fn restore_version(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let id = ctx.required_str("id")?;
    let seq = ctx.input["seq"].as_i64().unwrap_or_default();
    Ok(answer(
        id,
        seq,
        history::restore_version(ctx, id, seq, Scope::All)?,
    ))
}

fn undo(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let id = ctx.required_str("id")?;
    let seq = newest(ctx)?.unwrap_or_default();
    Ok(answer(
        id,
        seq,
        history::restore_version(ctx, id, seq, Scope::All)?,
    ))
}

fn fields(ctx: &CommandCtx<'_, '_>) -> serde_json::Map<String, serde_json::Value> {
    ctx.input
        .get("fields")
        .and_then(serde_json::Value::as_object)
        .cloned()
        .unwrap_or_default()
}

/// The overlay's field for a text document's words: not a column, the words themselves, which the
/// handler writes into the content store and keeps by their hash.
const DOCUMENT_TEXT: &str = "document.text";

/// The record is there (in the trash or not: a record trashed elsewhere keeps the words that
/// were being written to it) and each field is one its history keeps. A sealed cell of a Locker
/// item is never one: the vault holds no key, so a secret the member typed is not kept this way (the
/// overlay refuses it), and a Locker item's plain fields are kept like any other record's.
fn pre_keep(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let id = ctx.required_str("id")?;
    let Some(found) = crate::commands::entity::find(ctx.connection(), id)? else {
        return Ok(Some(format!("there is nothing with the id `{id}`")));
    };
    let mut overlay = fields(ctx);
    if let Some(words) = overlay.remove(DOCUMENT_TEXT) {
        let text_document = found.kind == crate::model::Kind::Document
            && words.is_string()
            && ctx.blobs().is_some()
            && crate::commands::document::media_type_of(ctx, id)?
                .is_some_and(|media_type| media_type.starts_with("text/"));
        if !text_document {
            return Ok(Some(format!(
                "`{DOCUMENT_TEXT}` is the words of a text document"
            )));
        }
    }
    history::overlay_refusal(ctx.connection(), id, &overlay)
}

fn keep_version(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let id = ctx.required_str("id")?;
    let mut overlay = fields(ctx);
    if let Some(words) = overlay.remove(DOCUMENT_TEXT) {
        let hash = crate::commands::document::write_words(ctx, words.as_str().unwrap_or_default())?;
        overlay.insert("document.blob".to_owned(), hash.into());
    }
    let kept = history::keep_overlay(ctx.connection(), id, &overlay, &ctx.now, ctx.command)?;
    Ok(match kept {
        history::Kept::Version(seq) => serde_json::json!({ "id": id, "kept": true, "seq": seq }),
        history::Kept::Same => serde_json::json!({ "id": id, "kept": false }),
    })
}

const KEEP: &[CommandCondition] = &[CommandCondition {
    predicate: "the record is there and each field is one its history keeps",
    check: pre_keep,
}];

const RESTORE: &[CommandCondition] = &[CommandCondition {
    predicate: "the record is live and the version is in its history",
    check: pre_restore,
}];

const UNDO: &[CommandCondition] = &[CommandCondition {
    predicate: "the record is live and has an earlier version",
    check: pre_undo,
}];

#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    vec![
        CommandDefinition::plain(
            "history.restore_version",
            "history",
            r#"{
              "type": "object",
              "required": ["id", "seq"],
              "additionalProperties": false,
              "properties": {
                "id": { "type": "string", "minLength": 1 },
                "seq": { "type": "integer", "minimum": 1 }
              }
            }"#,
            Idempotency::Idempotent,
            RESTORE,
            restore_version,
        ),
        CommandDefinition::plain(
            "history.keep_version",
            "history",
            r#"{
              "type": "object",
              "required": ["id", "fields"],
              "additionalProperties": false,
              "properties": {
                "id": { "type": "string", "minLength": 1 },
                "fields": { "type": "object", "minProperties": 1 }
              }
            }"#,
            Idempotency::Once,
            KEEP,
            keep_version,
        ),
        CommandDefinition::plain(
            "history.undo",
            "history",
            r#"{
              "type": "object",
              "required": ["id"],
              "additionalProperties": false,
              "properties": {
                "id": { "type": "string", "minLength": 1 },
                "seq": { "type": "integer", "minimum": 1 }
              }
            }"#,
            Idempotency::Once,
            UNDO,
            undo,
        ),
    ]
}
