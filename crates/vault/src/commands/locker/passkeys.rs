//! An item's passkeys (#1214, I6): several to an item, each a row.
//!
//! STORAGE ONLY: this mints no challenge, signs nothing and speaks no WebAuthn. The site
//! (`rp_id`) is plain and searched, so passkey sign-in finds an item by the site it is for
//! (`locker_item_passkey_by_rp`); the `private_key` is `lk1:` ciphertext bound to the passkey's id,
//! kept in history as that ciphertext and never shown, indexed or turned into anything else.

use rusqlite::OptionalExtension;

use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency};
use crate::error::Result;

use super::custody::{
    ITEM_LIVE_CHECK, NONE, assert_fresh_id, assert_key_generation, assert_sealed_cell, sentence_of,
};
use super::fields::SEALED_VALUE_BUDGET_BYTES;
use super::schema::SEALED_PLACEHOLDER;
use super::{count, definition};

#[derive(serde::Deserialize)]
struct SetPasskeyInput {
    item_id: String,
    passkey_id: Option<String>,
    rp_id: String,
    user_handle: Option<String>,
    display_name: Option<String>,
    credential_id: Option<String>,
    algorithm: Option<String>,
    private_key: Option<String>,
    key_id: Option<String>,
}

type ExistingPasskey = (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    String,
);

fn sealing_value(input: &SetPasskeyInput) -> bool {
    input
        .private_key
        .as_deref()
        .is_some_and(|value| !value.is_empty() && value != SEALED_PLACEHOLDER)
}

fn refusal(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let input: SetPasskeyInput = ctx.parse_input()?;
    if input.rp_id.trim().is_empty() {
        return Ok(Some("a passkey is for a site".to_owned()));
    }
    if let Err(error) = assert_sealed_cell("private_key", input.private_key.as_deref()) {
        return Ok(Some(sentence_of(error)));
    }
    if input
        .private_key
        .as_deref()
        .is_some_and(|key| key.len() > SEALED_VALUE_BUDGET_BYTES)
    {
        return Ok(Some(format!(
            "that value is over the {SEALED_VALUE_BUDGET_BYTES}-byte budget for a sealed field"
        )));
    }
    if let Err(error) = assert_key_generation(input.key_id.as_deref(), sealing_value(&input), ctx) {
        return Ok(Some(sentence_of(error)));
    }
    let existing = match input.passkey_id.as_deref() {
        Some(id) => count(
            ctx,
            "SELECT COUNT(*) FROM locker_item_passkey WHERE id = ?1 AND item_id = ?2",
            &[id, &input.item_id],
        )?,
        None => 0,
    };
    match input.passkey_id.as_deref() {
        None if sealing_value(&input) => Ok(Some(
            "a new passkey must carry the id its key was sealed against, because the \
             ciphertext's additional data binds it to that id"
                .to_owned(),
        )),
        Some(id) if existing == 0 => Ok(assert_fresh_id(ctx, "passkey_id", id)
            .err()
            .map(sentence_of)),
        _ => Ok(None),
    }
}

pub(super) fn set_passkey() -> CommandDefinition {
    static PRE: &[CommandCondition] = &[
        ITEM_LIVE_CHECK,
        CommandCondition {
            predicate: "passkey_is_for_a_site_and_its_key_is_sealed",
            check: refusal,
        },
    ];
    let mut definition = definition(
        "locker.set_passkey",
        r#"{
          "type": "object",
          "required": ["item_id", "rp_id"],
          "additionalProperties": false,
          "properties": {
            "item_id": { "type": "string", "minLength": 1 },
            "passkey_id": { "type": "string", "minLength": 1, "maxLength": 96 },
            "rp_id": { "type": "string", "minLength": 1 },
            "user_handle": { "type": "string" },
            "display_name": { "type": "string" },
            "credential_id": { "type": "string" },
            "algorithm": { "type": "string" },
            "private_key": { "type": "string" },
            "key_id": { "type": "string", "minLength": 1 }
          }
        }"#,
        Idempotency::Idempotent,
        PRE,
        NONE,
        |ctx| {
            let input: SetPasskeyInput = ctx.parse_input()?;
            let id = input.passkey_id.clone().unwrap_or_else(|| ctx.next_id());
            let existing: Option<ExistingPasskey> = ctx
                .connection()
                .query_row(
                    "SELECT user_handle, display_name, credential_id, algorithm,
                            private_key, key_id, created_at FROM locker_item_passkey
                      WHERE id = ?1 AND item_id = ?2",
                    [&id, &input.item_id],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                            row.get(5)?,
                            row.get(6)?,
                        ))
                    },
                )
                .optional()?;
            // The placeholder, or no key, keeps the key and the generation it was sealed under
            // (a rename sends no `key_id`: a caller that never held the key has none to name).
            let (stored, stored_key_id) = match input.private_key.as_deref() {
                Some(SEALED_PLACEHOLDER) | None => existing
                    .as_ref()
                    .map_or((None, None), |(_, _, _, _, key, key_id, _)| {
                        (key.clone(), key_id.clone())
                    }),
                Some("") => (None, None),
                Some(key) => (Some(key.to_owned()), input.key_id.clone()),
            };
            let created_at = existing.as_ref().map_or_else(
                || ctx.now.clone(),
                |(_, _, _, _, _, _, created)| created.clone(),
            );
            let user_handle = input
                .user_handle
                .or_else(|| existing.as_ref().and_then(|row| row.0.clone()));
            let display_name = input
                .display_name
                .or_else(|| existing.as_ref().and_then(|row| row.1.clone()));
            let credential_id = input
                .credential_id
                .or_else(|| existing.as_ref().and_then(|row| row.2.clone()));
            let algorithm = input
                .algorithm
                .or_else(|| existing.as_ref().and_then(|row| row.3.clone()));
            ctx.connection().execute(
                "INSERT INTO locker_item_passkey
                   (id, item_id, rp_id, user_handle, display_name, credential_id, algorithm,
                    private_key, key_id, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                 ON CONFLICT(id) DO UPDATE SET
                   rp_id = excluded.rp_id,
                   user_handle = excluded.user_handle,
                   display_name = excluded.display_name,
                   credential_id = excluded.credential_id,
                   algorithm = excluded.algorithm,
                   private_key = excluded.private_key,
                   key_id = excluded.key_id,
                   updated_at = excluded.updated_at",
                rusqlite::params![
                    id,
                    input.item_id,
                    input.rp_id.trim(),
                    user_handle,
                    display_name,
                    credential_id,
                    algorithm,
                    stored,
                    stored_key_id,
                    created_at,
                    ctx.now
                ],
            )?;
            ctx.touch(&input.item_id)?;
            Ok(serde_json::json!({ "item_id": input.item_id, "passkey_id": id }))
        },
    );
    definition.sealed_input = &["private_key"];
    definition
}

#[derive(serde::Deserialize)]
struct RemovePasskeyInput {
    item_id: String,
    passkey_id: String,
}

pub(super) fn remove_passkey() -> CommandDefinition {
    static PRE: &[CommandCondition] = &[
        ITEM_LIVE_CHECK,
        CommandCondition {
            predicate: "passkey_is_the_items_own",
            check: |ctx| {
                let found = count(
                    ctx,
                    "SELECT COUNT(*) FROM locker_item_passkey WHERE id = ?1 AND item_id = ?2",
                    &[
                        ctx.required_str("passkey_id")?,
                        ctx.required_str("item_id")?,
                    ],
                )?;
                Ok((found != 1).then(|| "that is not one of this item's passkeys".to_owned()))
            },
        },
    ];
    definition(
        "locker.remove_passkey",
        r#"{
          "type": "object",
          "required": ["item_id", "passkey_id"],
          "additionalProperties": false,
          "properties": {
            "item_id": { "type": "string", "minLength": 1 },
            "passkey_id": { "type": "string", "minLength": 1 }
          }
        }"#,
        Idempotency::Idempotent,
        PRE,
        NONE,
        |ctx| {
            let input: RemovePasskeyInput = ctx.parse_input()?;
            ctx.connection().execute(
                "DELETE FROM locker_item_passkey WHERE id = ?1 AND item_id = ?2",
                [&input.passkey_id, &input.item_id],
            )?;
            ctx.touch(&input.item_id)?;
            Ok(serde_json::json!({ "item_id": input.item_id, "passkey_id": input.passkey_id }))
        },
    )
}
