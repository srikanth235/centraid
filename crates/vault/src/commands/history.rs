//! `history.*`: put an earlier value back (#1185).
//!
//! History itself is not a command: the commit door keeps every record's earlier state
//! ([`crate::history`]). What a member does with it is two verbs, both ordinary writes that make a
//! version of their own, so a restore is undone by restoring again:
//!
//! - `history.restore_version`: the record goes back to what version `seq` held, field by field
//!   and row by row.
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
