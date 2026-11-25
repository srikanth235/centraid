//! What Locker's commands owe sealing, and the stamps the core's session writes
//! (`locker.totp_code`, `locker.mark_used`, `locker.mark_unlocked`, `locker.mark_unlock_failed`).
//!
//! Everything here follows from one sentence: *a sealed value is ciphertext under a key this crate
//! never holds*. So a command cannot read a secret and cannot write one in the clear either, and
//! the guards below are the whole of Locker's own rules; the rest is an ordinary app's.

use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency};
use crate::custody::locker_key::{assert_live_locker_key_id, is_locker_ciphertext};
use crate::error::{Result, VaultError};

use super::schema::SEALED_PLACEHOLDER;
use super::{count, definition};

pub(super) fn invalid(name: &str, detail: impl Into<String>) -> VaultError {
    VaultError::InvalidInput {
        name: name.to_owned(),
        detail: detail.into(),
    }
}

/// A VALUE THE VAULT MAY STORE IN A SEALED CELL: ciphertext, or the placeholder, or nothing.
///
/// The member-facing sentence names the cell and **never quotes the value**, because the one value
/// this refusal is most likely to be handed is a password. A command plane that accepted it would
/// write a secret into the file, its WAL and the backup.
pub(super) fn assert_sealed_cell(name: &str, value: Option<&str>) -> Result<()> {
    let Some(value) = value else {
        return Ok(());
    };
    if value.is_empty() || value == SEALED_PLACEHOLDER || is_locker_ciphertext(value) {
        return Ok(());
    }
    Err(invalid(
        name,
        format!(
            "`{name}` is a Locker secret and must arrive sealed under the member key: the \
             vault's commands hold no key and cannot seal one. It is sealed by the Locker \
             session that unlocked."
        ),
    ))
}

/// The key generation a sealed write names must be the vault's one. Absent when the input carries
/// no sealed value at all: a retag is not a secret write and must not need the key plane.
pub(super) fn assert_key_generation(
    key_id: Option<&str>,
    carries_secret: bool,
    ctx: &CommandCtx<'_, '_>,
) -> Result<()> {
    if !carries_secret {
        return Ok(());
    }
    let key_id = key_id.ok_or_else(|| {
        invalid(
            "key_id",
            "a sealed value must name the member key generation it was sealed under, so a \
             write under any other generation is refused rather than stored unopenable",
        )
    })?;
    assert_live_locker_key_id(ctx.connection(), key_id).map_err(|error| {
        // A vault with no key plane has no generation to name: no Locker session has opened yet,
        // so the vault holds no secrets and a write is refused rather than stored in the clear.
        invalid("key_id", error.to_string())
    })
}

/// A caller-minted id the vault will accept as the id a sealed value is bound to.
///
/// Two refusals, and they are different: a malformed id is a caller bug, and a taken id is a
/// collision. The id is unique across every table a value can be sealed against, so a ciphertext
/// can never be moved onto another row by choosing that row's id.
pub(super) fn assert_fresh_id(ctx: &CommandCtx<'_, '_>, name: &str, id: &str) -> Result<()> {
    assert_well_formed_id(name, id)?;
    let taken: i64 = ctx.connection().query_row(
        "SELECT (SELECT COUNT(*) FROM entity WHERE id = ?1)
              + (SELECT COUNT(*) FROM locker_item_field WHERE id = ?1)
              + (SELECT COUNT(*) FROM locker_item_passkey WHERE id = ?1)",
        [id],
        |row| row.get(0),
    )?;
    if taken > 0 {
        return Err(invalid(
            name,
            "that id is already in this vault; mint a fresh one",
        ));
    }
    Ok(())
}

pub(super) fn assert_well_formed_id(name: &str, id: &str) -> Result<()> {
    if id.is_empty()
        || id.len() > 96
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':'))
    {
        return Err(invalid(
            name,
            "an id is 1 to 96 characters of letters, digits, `-`, `_` or `:`",
        ));
    }
    Ok(())
}

/// The member-facing half of a refusal, for a precondition's sentence.
pub(super) fn sentence_of(error: VaultError) -> String {
    match error {
        VaultError::InvalidInput { detail, .. } => detail,
        other => other.to_string(),
    }
}

// ---------------------------------------------------------------------------
// Preconditions, shared
// ---------------------------------------------------------------------------

/// Live is the ENTITY's word: a Locker item's trash window is on its `entity` row, like every
/// kind's.
pub(super) const ITEM_LIVE_SQL: &str =
    "SELECT COUNT(*) FROM locker_item i JOIN entity e ON e.id = i.id
      WHERE i.id = ?1 AND e.deleted_at IS NULL";

pub(super) const ITEM_LIVE_CHECK: CommandCondition = CommandCondition {
    predicate: "item_live",
    check: |ctx| {
        let item_id = ctx.required_str("item_id")?;
        let found = count(ctx, ITEM_LIVE_SQL, &[item_id])?;
        Ok((found != 1).then(|| "that item is not in your locker".to_owned()))
    },
};

pub(super) static ITEM_LIVE: &[CommandCondition] = &[ITEM_LIVE_CHECK];

pub(super) static NONE: &[CommandCondition] = &[];

// ---------------------------------------------------------------------------
// The stamps
// ---------------------------------------------------------------------------

/// Stamp an item as used: the instant the core opened one of its sealed cells.
///
/// **A use is not an edit.** This writes `locker_item.last_used_at` and nothing else: not
/// `ctx.touch`, so the entity's `updated_at` stays and the item does not float to the top of the
/// newest-updated shelf; not a revision (`history::NEVER_TOUCHES` holds the column out); and
/// nothing re-indexes, because no searchable text changed.
pub(super) fn stamp_use(ctx: &CommandCtx<'_, '_>, item_id: &str) -> Result<()> {
    let stamped = ctx.connection().execute(
        "UPDATE locker_item SET last_used_at = ?1 WHERE id = ?2",
        rusqlite::params![ctx.now, item_id],
    )?;
    if stamped == 1 {
        Ok(())
    } else {
        Err(VaultError::Invariant {
            context: format!("`{item_id}` is not a Locker item to stamp"),
        })
    }
}

#[derive(serde::Deserialize)]
struct ItemIdInput {
    item_id: String,
}

pub(super) fn totp_code() -> CommandDefinition {
    static PRE: &[CommandCondition] = &[CommandCondition {
        predicate: "item_has_seed",
        check: |ctx| {
            let item_id = ctx.required_str("item_id")?;
            // The item's one seed, or the one-time-code field the caller names. `kind = 'otp'`
            // reads a column without reading a value, which is the line the trust premise draws:
            // the command plane serves ciphertext and knows it is there.
            let found = match ctx.optional_str("field_id") {
                Some(field_id) => count(
                    ctx,
                    "SELECT COUNT(*) FROM locker_item_field f JOIN entity e ON e.id = f.item_id
                      WHERE f.id = ?1 AND f.item_id = ?2 AND f.kind = 'otp'
                        AND e.deleted_at IS NULL",
                    &[field_id, item_id],
                )?,
                None => count(
                    ctx,
                    "SELECT COUNT(*) FROM locker_item_field f JOIN entity e ON e.id = f.item_id
                      WHERE f.item_id = ?1 AND f.kind = 'otp' AND e.deleted_at IS NULL",
                    &[item_id],
                )?,
            };
            Ok((found == 0).then(|| "that item carries no one-time-code seed".to_owned()))
        },
    }];
    definition(
        "locker.totp_code",
        r#"{
          "type": "object",
          "required": ["item_id"],
          "additionalProperties": false,
          "properties": {
            "item_id": { "type": "string", "minLength": 1 },
            "field_id": { "type": "string", "minLength": 1 }
          }
        }"#,
        Idempotency::RetrySafe,
        PRE,
        NONE,
        |ctx| {
            let input: ItemIdInput = ctx.parse_input()?;
            // The command plane cannot unseal, so what it does is the half that is still its own:
            // it STAMPS the item as used. The digits are the core's, computed after this stamp
            // lands, over a seed only a core holding `K` can open.
            stamp_use(ctx, &input.item_id)?;
            Ok(serde_json::json!({ "item_id": input.item_id, "period": 30 }))
        },
    )
}

/// The stamp a reveal in the core owes: run BEFORE the core opens the cell, so a stamp that did
/// not land is an error and no plaintext exists. The input names the item and nothing of what was
/// opened: a stamp holds a time, not a field and not a value.
pub(super) fn mark_used() -> CommandDefinition {
    definition(
        "locker.mark_used",
        r#"{
          "type": "object",
          "required": ["item_id"],
          "additionalProperties": false,
          "properties": {
            "item_id": { "type": "string", "minLength": 1 }
          }
        }"#,
        Idempotency::Once,
        ITEM_LIVE,
        NONE,
        |ctx| {
            let input: ItemIdInput = ctx.parse_input()?;
            stamp_use(ctx, &input.item_id)?;
            Ok(serde_json::json!({ "item_id": input.item_id, "last_used_at": ctx.now }))
        },
    )
}

/// The Locker's one key row is the home of its failed-unlock figures. A vault that never named
/// its generation has none, and refuses in the member's words.
const KEY_ROW_EXISTS: CommandCondition = CommandCondition {
    predicate: "locker_key_exists",
    check: |ctx| {
        let found = count(ctx, "SELECT COUNT(*) FROM locker_key", &[])?;
        Ok((found != 1)
            .then(|| "the Locker has no key yet, so there is no unlock to record".to_owned()))
    },
};

static KEY_ROW: &[CommandCondition] = &[KEY_ROW_EXISTS];

/// The phone allowed an unlock: reset the count of refused ones, keep the time of the last, and
/// answer what was cleared so the member can be told.
pub(super) fn mark_unlocked() -> CommandDefinition {
    definition(
        "locker.mark_unlocked",
        r#"{
          "type": "object",
          "additionalProperties": false,
          "properties": {}
        }"#,
        Idempotency::Once,
        KEY_ROW,
        NONE,
        |ctx| {
            let (failed, at): (i64, Option<String>) = ctx.connection().query_row(
                "SELECT failed_unlocks, failed_unlock_at FROM locker_key",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            ctx.connection()
                .execute("UPDATE locker_key SET failed_unlocks = 0", [])?;
            Ok(serde_json::json!({ "failed_unlocks": failed, "failed_unlock_at": at }))
        },
    )
}

/// The phone refused an unlock: count it and date it. Its own command, because the unlock it
/// describes never reached the core and a refused command writes nothing the next one can read.
pub(super) fn mark_unlock_failed() -> CommandDefinition {
    definition(
        "locker.mark_unlock_failed",
        r#"{
          "type": "object",
          "additionalProperties": false,
          "properties": {}
        }"#,
        Idempotency::Once,
        KEY_ROW,
        NONE,
        |ctx| {
            ctx.connection().execute(
                "UPDATE locker_key SET failed_unlocks = failed_unlocks + 1, failed_unlock_at = ?1",
                [&ctx.now],
            )?;
            let failed: i64 =
                ctx.connection()
                    .query_row("SELECT failed_unlocks FROM locker_key", [], |row| {
                        row.get(0)
                    })?;
            Ok(serde_json::json!({ "failed_unlocks": failed, "failed_unlock_at": ctx.now }))
        },
    )
}
