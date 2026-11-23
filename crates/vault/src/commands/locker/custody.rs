//! Custody guards, preconditions, and the reveal/unlock stamps (`locker.totp_code`,
//! `locker.mark_used`, `locker.mark_unlocked`, `locker.mark_unlock_failed`).

use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency};
use crate::custody::locker_key::{assert_live_locker_key_id, is_locker_ciphertext};
use crate::error::{Result, VaultError};

use super::schema::{SEALED_ITEM_CELLS, SEALED_PLACEHOLDER, is_sealed_kind};
use super::{count, definition};

// ---------------------------------------------------------------------------
// The custody guards. These three are why this file exists in this shape.
// ---------------------------------------------------------------------------

pub(super) fn invalid(name: &str, detail: impl Into<String>) -> VaultError {
    VaultError::InvalidInput {
        name: name.to_owned(),
        detail: detail.into(),
    }
}

/// A CELL THE VAULT MAY STORE — ciphertext, or the placeholder, or nothing.
///
/// The member-facing sentence names the cell and **never quotes the value**,
/// because the one value this refusal is most likely to be handed is a
/// password. `MemberKeyPlaintext` in the census's vocabulary; the vault's own
/// error taxonomy calls it invalid input, which is what it is: a command plane
/// that accepted it would write a secret into the file and the backup.
pub(super) fn assert_sealed_cell(column: &str, value: Option<&str>) -> Result<()> {
    let Some(value) = value else {
        return Ok(());
    };
    if value.is_empty() || value == SEALED_PLACEHOLDER || is_locker_ciphertext(value) {
        return Ok(());
    }
    Err(invalid(
        column,
        format!(
            "`{column}` is a Locker secret and must arrive sealed under the member key — the \
             vault's commands hold no key and cannot seal one. It is sealed by the Locker \
             session that unlocked (#1047, D-6)."
        ),
    ))
}

/// Every sealed cell of an input, checked together, so a caller cannot pass
/// four of five.
pub(super) fn assert_sealed_cells(ctx: &CommandCtx<'_, '_>, columns: &[&str]) -> Result<()> {
    for column in columns {
        assert_sealed_cell(column, ctx.optional_str(column))?;
    }
    Ok(())
}

/// The key generation a sealed write names must be the vault's one.
///
/// Absent when the input carries no sealed cell at all — a retag is not a
/// secret write and must not need the key plane to exist.
pub(super) fn assert_key_generation(ctx: &CommandCtx<'_, '_>, carries_secret: bool) -> Result<()> {
    if !carries_secret {
        return Ok(());
    }
    let key_id = ctx.optional_str("key_id").ok_or_else(|| {
        invalid(
            "key_id",
            "a sealed cell must name the member key generation it was sealed under, so a \
             write under any other generation is refused rather than stored unopenable",
        )
    })?;
    assert_live_locker_key_id(ctx.connection(), key_id).map_err(|error| {
        // A vault with no key plane is `MemberKeyAbsent` in the census's words:
        // no Locker session has named a generation yet, so the vault holds no
        // secrets, and a write is refused rather than silently stored in the
        // clear.
        invalid("key_id", error.to_string())
    })
}

/// Whether this input carries any sealed cell at all.
pub(super) fn carries_secret(ctx: &CommandCtx<'_, '_>, columns: &[&str]) -> bool {
    columns.iter().any(|column| {
        ctx.optional_str(column)
            .is_some_and(|value| !value.is_empty() && value != SEALED_PLACEHOLDER)
    })
}

/// A CALLER-MINTED ID THE VAULT WILL ACCEPT (D-1020-L9).
///
/// Two refusals, and they are different: a malformed id is a caller bug, and a
/// taken id is a collision. Neither is allowed to become a silent overwrite of
/// somebody's login.
pub(super) fn assert_fresh_id(ctx: &CommandCtx<'_, '_>, name: &str, id: &str) -> Result<()> {
    if id.is_empty()
        || id.len() > 64
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err(invalid(
            name,
            "an id is 1–64 characters of letters, digits, `-` or `_`",
        ));
    }
    let taken: i64 = ctx.connection().query_row(
        "SELECT (SELECT COUNT(*) FROM entity WHERE id = ?1)
              + (SELECT COUNT(*) FROM locker_item_field WHERE id = ?1)
              + (SELECT COUNT(*) FROM locker_item_address WHERE id = ?1)",
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

/// Whether the caller declared the password a real rotation (D-1020-L10b).
///
/// The command plane cannot compare two ciphertexts for equality — AES-GCM with
/// a fresh nonce per value means the same plaintext encrypts differently every
/// time — so *"only a real change re-stamps the age"* (v0's `rotated`) is a
/// fact only the core holding `K` can establish. It is therefore an explicit,
/// **required** claim whenever a password cell arrives, and it lands on the
/// invocation's receipt like any other input.
///
/// The alternative — re-stamp whenever a password cell arrives — was rejected
/// because it errs in the *permissive* direction: re-stamping makes a password
/// look fresh, so Review would stop warning about one a member only re-typed.
pub(super) fn password_rotated(ctx: &CommandCtx<'_, '_>) -> Result<bool> {
    let password = ctx
        .optional_str("password")
        .filter(|value| !value.is_empty() && *value != SEALED_PLACEHOLDER);
    if password.is_none() {
        return Ok(false);
    }
    ctx.input
        .get("password_rotated")
        .and_then(serde_json::Value::as_bool)
        .ok_or_else(|| {
            invalid(
                "password_rotated",
                "a write that carries a password must say whether the value CHANGED: the \
                 vault cannot compare two ciphertexts, and only a real change re-stamps \
                 the password's age (#1020, D-1020-L10b)",
            )
        })
}

// ---------------------------------------------------------------------------
// The preconditions, shared.
// ---------------------------------------------------------------------------

pub(super) const ITEM_EXISTS_SQL: &str = "SELECT COUNT(*) FROM locker_item WHERE id = ?1";
/// Live is the ENTITY's word: a Locker item's trash window is on its `entity`
/// row, like every kind's.
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
// THE CUSTODY PRECONDITIONS — a refusal is an OUTCOME, never an exception.
//
// These are preconditions and not handler checks, and the reason is the
// authority plane's own doctrine (`crates/vault/src/access.rs`): *an answer
// that arrives as a panic cannot be receipted.* A refused Locker write is the
// single most audit-worthy refusal this product has — somebody tried to put a
// plaintext secret on the host — so it lands as a `pre` check row with its
// predicate's name, denies with the member's sentence, and is receipted like
// every other deny. The handlers call the same guards a second time, which is
// unreachable and stays: a precondition somebody forgets to wire is then a
// hard error rather than a stored secret.
// ---------------------------------------------------------------------------

/// Every sealed cell of an item write is ciphertext, the placeholder, or
/// nothing.
pub(super) const SEALED_CELLS_ARE_CIPHERTEXT: CommandCondition = CommandCondition {
    predicate: "sealed_cells_are_ciphertext",
    check: |ctx| {
        Ok(assert_sealed_cells(ctx, &SEALED_ITEM_CELLS)
            .err()
            .map(sentence_of))
    },
};

/// The key generation a sealed write names is the live one.
pub(super) const KEY_GENERATION_IS_LIVE: CommandCondition = CommandCondition {
    predicate: "key_generation_is_live",
    check: |ctx| {
        Ok(
            assert_key_generation(ctx, carries_secret(ctx, &SEALED_ITEM_CELLS))
                .err()
                .map(sentence_of),
        )
    },
};

/// A password write says whether the value changed.
pub(super) const PASSWORD_ROTATION_IS_DECLARED: CommandCondition = CommandCondition {
    predicate: "password_rotation_is_declared",
    check: |ctx| Ok(password_rotated(ctx).err().map(sentence_of)),
};

/// The caller-minted `item_id` is fresh and well formed.
pub(super) const ITEM_ID_IS_FRESH: CommandCondition = CommandCondition {
    predicate: "item_id_is_fresh",
    check: |ctx| {
        let item_id = ctx.required_str("item_id")?;
        Ok(assert_fresh_id(ctx, "item_id", item_id)
            .err()
            .map(sentence_of))
    },
};

/// The caller-minted `new_item_id` of a duplicate is fresh and well formed.
pub(super) const NEW_ITEM_ID_IS_FRESH: CommandCondition = CommandCondition {
    predicate: "new_item_id_is_fresh",
    check: |ctx| {
        let item_id = ctx.required_str("new_item_id")?;
        Ok(assert_fresh_id(ctx, "new_item_id", item_id)
            .err()
            .map(sentence_of))
    },
};

/// An alias the caller asks for is not held by another live item.
pub(super) const ALIAS_IS_FREE: CommandCondition = CommandCondition {
    predicate: "alias_is_free",
    check: |ctx| {
        let Some(alias) = ctx.optional_str("alias") else {
            return Ok(None);
        };
        let trimmed = alias.trim();
        if trimmed.is_empty() {
            return Ok(None);
        }
        let item_id = ctx.optional_str("item_id").unwrap_or_default();
        let clash = count(
            ctx,
            "SELECT COUNT(*) FROM locker_item_alias a
               JOIN entity i ON i.id = a.item_id
              WHERE a.id = ?1 AND i.deleted_at IS NULL AND a.item_id <> ?2",
            &[trimmed, item_id],
        )?;
        Ok((clash > 0)
            .then(|| format!("the alias \"{trimmed}\" is already used by another live item")))
    },
};

/// A custom field's sealed value is ciphertext, and a NEW sealed field carries
/// the id it was sealed against.
pub(super) const FIELD_VALUE_IS_SEALED: CommandCondition = CommandCondition {
    predicate: "field_value_is_sealed",
    check: |ctx| {
        if !ctx.optional_str("kind").is_some_and(is_sealed_kind) {
            return Ok(None);
        }
        let value = ctx.optional_str("value");
        if let Err(error) = assert_sealed_cell("value", value) {
            return Ok(Some(sentence_of(error)));
        }
        let sealed_value =
            value.is_some_and(|value| !value.is_empty() && value != SEALED_PLACEHOLDER);
        if let Err(error) = assert_key_generation(ctx, sealed_value) {
            return Ok(Some(sentence_of(error)));
        }
        let item_id = ctx.required_str("item_id")?;
        match ctx.optional_str("field_id") {
            None if sealed_value => Ok(Some(
                "a new sealed custom field must carry the id it was sealed against, because \
                 the ciphertext's additional data binds it to that id (#1020, D-1020-L9)"
                    .to_owned(),
            )),
            None => Ok(None),
            Some(field_id) => {
                let existing = count(
                    ctx,
                    "SELECT COUNT(*) FROM locker_item_field
                      WHERE id = ?1 AND item_id = ?2",
                    &[field_id, item_id],
                )?;
                if existing > 0 {
                    return Ok(None);
                }
                Ok(assert_fresh_id(ctx, "field_id", field_id)
                    .err()
                    .map(sentence_of))
            }
        }
    },
};

/// A passkey's `private_key` is ciphertext under the live generation.
pub(super) const PASSKEY_IS_SEALED: CommandCondition = CommandCondition {
    predicate: "passkey_is_sealed",
    check: |ctx| {
        let private_key = ctx.optional_str("private_key");
        if let Err(error) = assert_sealed_cell("private_key", private_key) {
            return Ok(Some(sentence_of(error)));
        }
        let sealed =
            private_key.is_some_and(|value| !value.is_empty() && value != SEALED_PLACEHOLDER);
        Ok(assert_key_generation(ctx, sealed).err().map(sentence_of))
    },
};

/// The member-facing half of a refusal, for a precondition's sentence.
pub(super) fn sentence_of(error: VaultError) -> String {
    match error {
        VaultError::InvalidInput { detail, .. } => detail,
        other => other.to_string(),
    }
}

pub(super) static ADD_ITEM_PRE: &[CommandCondition] = &[
    ITEM_ID_IS_FRESH,
    SEALED_CELLS_ARE_CIPHERTEXT,
    KEY_GENERATION_IS_LIVE,
    PASSWORD_ROTATION_IS_DECLARED,
    ALIAS_IS_FREE,
];

pub(super) static EDIT_ITEM_PRE: &[CommandCondition] = &[
    crate::commands::entity::STALE_GUARD[0],
    crate::commands::entity::STALE_GUARD[1],
    ITEM_LIVE_CHECK,
    SEALED_CELLS_ARE_CIPHERTEXT,
    KEY_GENERATION_IS_LIVE,
    PASSWORD_ROTATION_IS_DECLARED,
    ALIAS_IS_FREE,
];

pub(super) static DUPLICATE_ITEM_PRE: &[CommandCondition] = &[
    ITEM_LIVE_CHECK,
    NEW_ITEM_ID_IS_FRESH,
    SEALED_CELLS_ARE_CIPHERTEXT,
    KEY_GENERATION_IS_LIVE,
];

pub(super) static SET_FIELD_PRE: &[CommandCondition] = &[ITEM_LIVE_CHECK, FIELD_VALUE_IS_SEALED];

pub(super) static SET_PASSKEY_PRE: &[CommandCondition] = &[ITEM_LIVE_CHECK, PASSKEY_IS_SEALED];

// ---------------------------------------------------------------------------
// The two derivations that left the command plane, and what they stamp.
// ---------------------------------------------------------------------------

/// Stamp an item as used: the instant the core opened one of its sealed cells.
///
/// **A use is not an edit.** This writes `locker_item.last_used_at` and nothing
/// else — not `ctx.touch`, so the entity's `updated_at` stays and
/// the item does not float to the top of the newest-updated shelf; not a
/// revision; and not `mark_for_index`, because no searchable text changed.
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

pub(super) fn totp_code() -> CommandDefinition {
    static PRE: &[CommandCondition] = &[CommandCondition {
        predicate: "item_has_seed",
        check: |ctx| {
            let item_id = ctx.required_str("item_id")?;
            // A custom one-time-code field names itself; the item must be live and the field a
            // sealed `otp` field of it.
            if let Some(field_id) = ctx.optional_str("field_id") {
                let found = count(
                    ctx,
                    "SELECT COUNT(*) FROM locker_item_field f JOIN entity e ON e.id = f.item_id
                      WHERE f.id = ?1 AND f.item_id = ?2 AND f.kind = 'otp'
                        AND f.value_sealed IS NOT NULL AND e.deleted_at IS NULL",
                    &[field_id, item_id],
                )?;
                return Ok(
                    (found != 1).then(|| "that item carries no one-time-code seed".to_owned())
                );
            }
            // THE PRESENCE OF A SEALED CELL IS A FACT THE COMMAND PLANE KNOWS.
            // `otp_seed IS NOT NULL` reads a column without reading a value,
            // which is exactly the line the trust premise draws: the command
            // plane serves ciphertext and knows it is there.
            let found = count(
                ctx,
                "SELECT COUNT(*) FROM locker_item i JOIN entity e ON e.id = i.id
                  WHERE i.id = ?1 AND e.deleted_at IS NULL AND i.otp_seed IS NOT NULL",
                &[item_id],
            )?;
            Ok((found != 1).then(|| "that item carries no one-time-code seed".to_owned()))
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
            let item_id = ctx.required_str("item_id")?.to_owned();
            // WHAT THIS COMMAND IS, AFTER THE CUSTODY CHANGE (D-1020-L6).
            //
            // v0 unsealed the seed here and returned six digits. The command
            // plane cannot unseal, so what it does is the half that is still
            // its own: it STAMPS the item as used (#1146). The digits are
            // computed by `crates/core::locker::phone` after this stamp lands,
            // over the `otp_seed` cell it opens under `K`, with
            // `crates/apps/locker::totp`'s RFC 6238 fold.
            stamp_use(ctx, &item_id)?;
            Ok(serde_json::json!({
                "item_id": item_id,
                "period": 30
            }))
        },
    )
}

/// The stamp a reveal in the core owes (D-1020-L3, #1146): run BEFORE the
/// core opens the cell, so a stamp that did not land is an error and no
/// plaintext exists. The input names the item and nothing of what was opened —
/// a stamp holds a time, not a column and not a value.
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
            let item_id = ctx.required_str("item_id")?.to_owned();
            stamp_use(ctx, &item_id)?;
            Ok(serde_json::json!({ "item_id": item_id, "last_used_at": ctx.now }))
        },
    )
}

/// The Locker's one key row is the home of its failed-unlock figures. A vault
/// that never named its generation has none, and refuses in the member's words.
const KEY_ROW_EXISTS: CommandCondition = CommandCondition {
    predicate: "locker_key_exists",
    check: |ctx| {
        let found = count(ctx, "SELECT COUNT(*) FROM locker_key", &[])?;
        Ok((found != 1)
            .then(|| "the Locker has no key yet, so there is no unlock to record".to_owned()))
    },
};

static KEY_ROW: &[CommandCondition] = &[KEY_ROW_EXISTS];

/// The phone allowed an unlock: reset the count of refused ones, keep the time
/// of the last, and answer what was cleared so the member can be told.
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

/// The phone refused an unlock: count it and date it. Its own command, because
/// the unlock it describes never reached the core and a refused command writes
/// nothing the next one can read.
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
