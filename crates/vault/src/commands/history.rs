//! `history.*`: put an earlier value back (#1185).
//!
//! History itself is not a command: the commit door keeps every record's earlier state
//! ([`crate::history`]). What a member does with it is two verbs, both ordinary writes that make a
//! version of their own, so a restore is undone by restoring again (and a third keeps words a stale save
//! could not):
//!
//! - `history.restore_version`: the record goes back to what version `seq` held, field by field
//!   and row by row, its home included when that home is still a live holder that may hold it
//!   (else the record stays where it is and `entity.parent_id` is named in `kept_current`).
//! - `history.keep_version`: the words a refused stale save held, kept as the newest earlier version beside
//!   the record as it is (the record is not changed). Each kept field is `table.column`; a sealed cell
//!   and a column that names bytes are refused.
//! - `history.undo`: the record goes back to its newest earlier version, "undo the last change".
//!   It is the generic inverse of every edit; it is not idempotent (twice undoes then redoes).
//!   Given `seq` it undoes THAT change and nothing else: the version is the newest, or the record is
//!   back to what that change left (a later change was taken back), or no later change touched a
//!   field that change moved (a star, a tag or an edit of another field since): then the fields it
//!   changed go back and the rest stays. A record whose same fields were changed again since is
//!   refused ([`CHANGED_SINCE`]) rather than losing the later change.
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
    if held == 0 {
        return Ok(Some(
            "That version is not in this record's history.".to_owned(),
        ));
    }
    let id = ctx.required_str("id")?;
    let connection = ctx.connection();
    let (Some(wanted), Some(now)) = (
        history::version_state(
            connection,
            id,
            ctx.input["seq"].as_i64().unwrap_or_default(),
        )?,
        history::current_state(connection, id)?,
    ) else {
        return Ok(None);
    };
    let fixed = STATEMENT_FIXED.iter().any(|column| {
        wanted["txn"].get(column) != now["txn"].get(column) && now["txn"].get(column).is_some()
    });
    Ok((fixed && is_statement_line(connection, id)?).then(|| STATEMENT_LINE_SAYS.to_owned()))
}

/// The columns of a line the bank stated that are never edited.
const STATEMENT_FIXED: [&str; 5] = [
    "account_id",
    "posted_on",
    "amount_minor",
    "original_amount_minor",
    "original_currency",
];

/// What a restore or an undo says when it would put the bank's figures back to what a hand line
/// said before a statement confirmed it.
const STATEMENT_LINE_SAYS: &str =
    "The bank stated this line, so its day, amount and account stay the bank's.";

fn is_statement_line(connection: &rusqlite::Connection, id: &str) -> Result<bool> {
    Ok(connection.query_row(
        "SELECT EXISTS (SELECT 1 FROM txn WHERE id = ?1 AND entered = 'statement')",
        [id],
        |row| row.get(0),
    )?)
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
    let Some(seq) = ctx.input.get("seq").and_then(serde_json::Value::as_i64) else {
        return Ok(None);
    };
    let id = ctx.required_str("id")?;
    if let Some(changes) = history::changes_by(ctx.connection(), id, seq)?
        && changes.iter().any(|change| {
            STATEMENT_FIXED
                .iter()
                .any(|column| change.field == format!("txn.{column}"))
        })
        && is_statement_line(ctx.connection(), id)?
    {
        return Ok(Some(STATEMENT_LINE_SAYS.to_owned()));
    }
    if seq == newest || changed_back_since(ctx, seq)? {
        return Ok(None);
    }
    // A later change to OTHER fields (a star, a tag, another edit) does not stand in the way of
    // taking this one back; one to the same field does, because undoing would lose it.
    let id = ctx.required_str("id")?;
    let held = history::changes_by(ctx.connection(), id, seq)?.is_some();
    Ok(
        (!held || history::changed_since(ctx.connection(), id, seq)?)
            .then(|| CHANGED_SINCE.to_owned()),
    )
}

/// Whether the record is, now, what the change that made version `seq` left it as: later changes
/// were made and then taken back (a gesture of two writes is taken back last write first, and the
/// second of those finds the record as the first left it), so the change can still be undone and
/// nothing later is lost.
fn changed_back_since(ctx: &CommandCtx<'_, '_>, seq: i64) -> Result<bool> {
    let id = ctx.required_str("id")?;
    let connection = ctx.connection();
    let (Some(after), Some(now)) = (
        history::version_state(connection, id, seq + 1)?,
        history::current_state(connection, id)?,
    ) else {
        return Ok(false);
    };
    let canonical = |state: &serde_json::Value| crate::canonical::canonical_json(state).ok();
    Ok(canonical(&after).is_some() && canonical(&after) == canonical(&now))
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

#[derive(serde::Deserialize)]
struct RestoreVersionInput {
    id: String,
    seq: Option<i64>,
}

fn restore_version(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let input: RestoreVersionInput = ctx.parse_input()?;
    let seq = input.seq.unwrap_or_default();
    Ok(answer(
        &input.id,
        seq,
        history::restore_version(ctx, &input.id, seq, Scope::All)?,
    ))
}

#[derive(serde::Deserialize)]
struct UndoInput {
    id: String,
    seq: Option<i64>,
}

fn undo(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let input: UndoInput = ctx.parse_input()?;
    // The change the caller named (still undoable: see `pre_undo`), else the newest.
    let seq = match input.seq {
        Some(seq) => seq,
        None => newest(ctx)?.unwrap_or_default(),
    };
    // The newest change, or one the record is back to (a later change was taken back): the whole
    // version. Any other named change is taken back alone, the fields it changed and nothing else.
    let whole = newest(ctx)? == Some(seq) || changed_back_since(ctx, seq)?;
    let restored = if whole {
        history::restore_version(ctx, &input.id, seq, Scope::All)?
    } else {
        history::restore_changes(ctx, &input.id, seq)?
    };
    Ok(answer(&input.id, seq, restored))
}

fn fields(ctx: &CommandCtx<'_, '_>) -> serde_json::Map<String, serde_json::Value> {
    ctx.input
        .get("fields")
        .and_then(serde_json::Value::as_object)
        .cloned()
        .unwrap_or_default()
}

/// The record is there (in the trash or not: a record trashed elsewhere keeps the words that
/// were being written to it) and each field is one its history keeps. A sealed cell of a Locker
/// item is never one: the vault holds no key, so a secret the member typed is not kept this way (the
/// overlay refuses it), and a Locker item's plain fields are kept like any other record's.
fn pre_keep(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    history::overlay_refusal(ctx.connection(), ctx.required_str("id")?, &fields(ctx))
}

#[derive(serde::Deserialize)]
struct KeepVersionInput {
    id: String,
    fields: serde_json::Map<String, serde_json::Value>,
}

fn keep_version(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let input: KeepVersionInput = ctx.parse_input()?;
    let overlay = input.fields;
    let kept = history::keep_overlay(
        ctx.connection(),
        &input.id,
        &overlay,
        &ctx.now,
        &ctx.settling_as(),
    )?;
    Ok(match kept {
        history::Kept::Version(seq) => {
            serde_json::json!({ "id": input.id, "kept": true, "seq": seq })
        }
        history::Kept::Same => serde_json::json!({ "id": input.id, "kept": false }),
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
