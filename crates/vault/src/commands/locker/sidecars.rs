//! Locker item sidecars: aliases, custom fields, additional addresses, passkeys, and memo.

use std::collections::BTreeSet;

use crate::commands::{CommandCtx, CommandDefinition, Idempotency};
use crate::error::Result;

use super::custody::{
    ITEM_LIVE, NONE, SET_FIELD_PRE, SET_PASSKEY_PRE, assert_key_generation, assert_sealed_cell,
    invalid,
};
use super::schema::{
    SEALED_PLACEHOLDER, built_in_field, built_in_field_id, is_sealed_kind, item_id_only,
    template_for,
};
use super::{count, definition, item_id_output};

/// Set or clear (`''`) the connector alias (#298).
///
/// Unique among **live** items; a trashed holder yields it. The mapping is a
/// registered table, so an app reads back what this writes.
pub(super) fn set_alias(ctx: &CommandCtx<'_, '_>, item_id: &str, alias: &str) -> Result<()> {
    ctx.connection().execute(
        "DELETE FROM locker_item_alias WHERE item_id = ?1",
        [item_id],
    )?;
    let trimmed = alias.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    let clash = count(
        ctx,
        "SELECT COUNT(*) FROM locker_item_alias a
           JOIN entity i ON i.id = a.item_id
          WHERE a.id = ?1 AND i.deleted_at IS NULL AND a.item_id <> ?2",
        &[trimmed, item_id],
    )?;
    if clash > 0 {
        return Err(invalid(
            "alias",
            format!("the alias \"{trimmed}\" is already used by another live item"),
        ));
    }
    // AN UPSERT AND NEVER `OR REPLACE` (#1047 R3). The row this displaces
    // belongs to a deleted item, and a REPLACE deletes it on SQLite's fast
    // path, which the `update_hook` never reports — so the running census
    // counted one alias more than the file held, the generation carried that
    // number, and a restore refused the vault. An update moves no count.
    ctx.connection().execute(
        "INSERT INTO locker_item_alias (id, item_id, created_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT (id) DO UPDATE
            SET item_id = excluded.item_id, created_at = excluded.created_at",
        rusqlite::params![trimmed, item_id, ctx.now],
    )?;
    Ok(())
}

/// One custom field, created or rewritten.
///
/// A rewrite keeps its `field_id`, which is what lets the round-tripped
/// placeholder mean *unchanged*: the ciphertext's AAD is bound to that id.
pub(super) struct FieldWrite<'a> {
    /// The id to write under. A rewrite keeps it; a **new** field carries the
    /// caller's, because a sealed value's AAD is bound to it (D-1020-L9). `None`
    /// asks the vault to mint one, which is allowed only for a field that
    /// holds no secret.
    pub(super) field_id: Option<&'a str>,
    pub(super) section: &'a str,
    pub(super) label: &'a str,
    pub(super) kind: &'a str,
    /// Ciphertext for a `sealed` kind, plaintext otherwise, or the placeholder.
    pub(super) value: Option<&'a str>,
    pub(super) position: i64,
}

pub(super) fn write_field(
    ctx: &CommandCtx<'_, '_>,
    item_id: &str,
    write: &FieldWrite<'_>,
) -> Result<String> {
    // "Does this id already name a row on this item" is a LOOKUP, not a
    // precondition: the same call creates and rewrites, and which one it did
    // is the answer to this query rather than a mode the caller declares.
    let existing: Option<(Option<String>, Option<String>, String)> =
        write.field_id.and_then(|field_id| {
            ctx.connection()
                .query_row(
                    "SELECT value_sealed, value_text, created_at
                       FROM locker_item_field WHERE id = ?1 AND item_id = ?2",
                    rusqlite::params![field_id, item_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .ok()
        });
    let field_id = match write.field_id {
        Some(field_id) => field_id.to_owned(),
        None => ctx.next_id(),
    };
    // A `sealed` field and a one-time-code (`otp`) field both keep their value only as `lk1:`
    // ciphertext in `value_sealed`; `otp` keeps its kind so a page shows a rolling code.
    let sealed = is_sealed_kind(write.kind);
    let supplied = write.value.filter(|value| !value.is_empty());
    let unchanged = supplied == Some(SEALED_PLACEHOLDER);
    let value_sealed: Option<String> = if sealed {
        if unchanged {
            existing
                .as_ref()
                .and_then(|(value_sealed, _, _)| value_sealed.clone())
        } else {
            supplied.map(str::to_owned)
        }
    } else {
        None
    };
    // The schema says an `otp` field holds a seed; say it in a sentence before it says it in SQL.
    if write.kind == "otp" && value_sealed.is_none() {
        return Err(invalid(
            "value",
            "a one-time-code field needs its setup key; there is nothing to keep without one",
        ));
    }
    let value_text: Option<String> = if sealed {
        None
    } else if unchanged {
        existing
            .as_ref()
            .and_then(|(_, value_text, _)| value_text.clone())
    } else {
        supplied.map(str::to_owned)
    };
    let created_at = existing
        .as_ref()
        .map_or_else(|| ctx.now.clone(), |(_, _, created_at)| created_at.clone());
    ctx.connection().execute(
        "INSERT INTO locker_item_field
           (id, item_id, section, label, kind, value_text, value_sealed,
            position, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(id) DO UPDATE SET
           section = excluded.section,
           label = excluded.label,
           kind = excluded.kind,
           value_text = excluded.value_text,
           value_sealed = excluded.value_sealed,
           position = excluded.position,
           updated_at = excluded.updated_at",
        rusqlite::params![
            field_id,
            item_id,
            write.section,
            write.label,
            write.kind,
            value_text,
            value_sealed,
            write.position,
            created_at,
            ctx.now
        ],
    )?;
    Ok(field_id)
}

/// Upsert or clear one built-in named field (`field_key IS NOT NULL`) in
/// `locker_item_field`. Absent/empty values remove the row so sparse fields
/// occupy no rows and `otp` fields always carry ciphertext.
pub(super) fn write_built_in_field(
    ctx: &CommandCtx<'_, '_>,
    item_id: &str,
    field_key: &str,
    value: Option<&str>,
    key_id: Option<&str>,
    position: i64,
) -> Result<()> {
    let Some(supplied) = value.filter(|value| !value.is_empty()) else {
        ctx.connection().execute(
            "DELETE FROM locker_item_field WHERE item_id = ?1 AND field_key = ?2",
            rusqlite::params![item_id, field_key],
        )?;
        return Ok(());
    };
    let meta = built_in_field(field_key)
        .ok_or_else(|| invalid(field_key, format!("unknown Locker field `{field_key}`")))?;
    let id = built_in_field_id(item_id, field_key);
    let sealed = is_sealed_kind(meta.kind);
    let (value_text, value_sealed, stored_key_id) = if sealed {
        (None, Some(supplied), key_id)
    } else {
        (Some(supplied), None, None)
    };
    ctx.connection().execute(
        "INSERT INTO locker_item_field
           (id, item_id, field_key, section, label, kind, value_text, value_sealed,
            position, created_at, updated_at, key_id)
         VALUES (?1, ?2, ?3, '', ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?10)
         ON CONFLICT(id) DO UPDATE SET
           label = excluded.label,
           kind = excluded.kind,
           value_text = excluded.value_text,
           value_sealed = excluded.value_sealed,
           position = excluded.position,
           updated_at = excluded.updated_at,
           key_id = excluded.key_id",
        rusqlite::params![
            id,
            item_id,
            field_key,
            meta.label,
            meta.kind,
            value_text,
            value_sealed,
            position,
            ctx.now,
            stored_key_id
        ],
    )?;
    Ok(())
}

/// The template rows a type arrives with, as **empty** fields the member fills.
///
/// Empty is the point: a template field carries no value, so minting one needs
/// no key and a vault with no `K` can still create a passport item and list it.
pub(super) fn mint_template_fields(
    ctx: &CommandCtx<'_, '_>,
    item_id: &str,
    item_type: &str,
) -> Result<usize> {
    let template = template_for(item_type);
    for (index, (section, label, kind)) in template.iter().enumerate() {
        write_field(
            ctx,
            item_id,
            &FieldWrite {
                field_id: None,
                section,
                label,
                kind,
                value: None,
                position: i64::try_from(index).unwrap_or(0),
            },
        )?;
    }
    Ok(template.len())
}

/// Replace the item's ADDITIONAL addresses; the primary stays on the item.
pub(super) fn set_addresses(
    ctx: &CommandCtx<'_, '_>,
    item_id: &str,
    addresses: &[String],
) -> Result<i64> {
    ctx.connection().execute(
        "DELETE FROM locker_item_address WHERE item_id = ?1",
        [item_id],
    )?;
    let mut position = 0_i64;
    let mut seen: BTreeSet<String> = BTreeSet::new();
    for url in addresses {
        let url = url.trim();
        if url.is_empty() || !seen.insert(url.to_owned()) {
            continue;
        }
        let address_id = ctx.next_id();
        ctx.connection().execute(
            "INSERT INTO locker_item_address
               (id, item_id, url, position, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![address_id, item_id, url, position, ctx.now],
        )?;
        position += 1;
    }
    Ok(position)
}

/// Replace the owner's plaintext memo, a column of the item.
///
/// Plaintext on purpose: a secret goes in a **sealed field**. A memo is the
/// thing a member wants to read back and find, and it is part of the item's
/// search text (`index::text_of`), which holds no sealed cell.
fn replace_memo(ctx: &CommandCtx<'_, '_>, item_id: &str, note: &str) -> Result<()> {
    let body = note.trim();
    ctx.connection().execute(
        "UPDATE locker_item SET memo = ?2 WHERE id = ?1",
        rusqlite::params![item_id, (!body.is_empty()).then_some(body)],
    )?;
    Ok(())
}

pub(super) fn set_field() -> CommandDefinition {
    let mut definition = definition(
        "locker.set_field",
        r#"{
          "type": "object",
          "required": ["item_id", "label", "kind"],
          "additionalProperties": false,
          "properties": {
            "item_id": { "type": "string", "minLength": 1 },
            "field_id": { "type": "string", "minLength": 1, "maxLength": 64 },
            "section": { "type": "string" },
            "label": { "type": "string", "minLength": 1 },
            "kind": { "type": "string", "enum": ["text", "sealed", "url", "date", "otp"] },
            "value": { "type": "string" },
            "position": { "type": "integer", "minimum": 0 },
            "key_id": { "type": "string", "minLength": 1 }
          }
        }"#,
        Idempotency::Idempotent,
        SET_FIELD_PRE,
        NONE,
        |ctx| {
            let item_id = ctx.required_str("item_id")?.to_owned();
            let kind = ctx.required_str("kind")?.to_owned();
            let label = ctx.required_str("label")?.to_owned();
            let value = ctx.optional_str("value").map(str::to_owned);
            let field_id = ctx.optional_str("field_id").map(str::to_owned);
            let sealed_value = is_sealed_kind(&kind)
                && value
                    .as_deref()
                    .is_some_and(|value| !value.is_empty() && value != SEALED_PLACEHOLDER);
            if is_sealed_kind(&kind) {
                assert_sealed_cell("value", value.as_deref())?;
            }
            assert_key_generation(ctx, sealed_value)?;
            // A NEW sealed field needs the caller's id, for the AAD reason.
            if sealed_value && field_id.is_none() {
                return Err(invalid(
                    "field_id",
                    "a new sealed custom field must carry the id it was sealed against, \
                     because the ciphertext's additional data binds it to that id \
                     (#1020, D-1020-L9)",
                ));
            }
            let written = write_field(
                ctx,
                &item_id,
                &FieldWrite {
                    field_id: field_id.as_deref(),
                    section: ctx.optional_str("section").unwrap_or(""),
                    label: &label,
                    kind: &kind,
                    value: value.as_deref(),
                    position: ctx
                        .input
                        .get("position")
                        .and_then(serde_json::Value::as_i64)
                        .unwrap_or(0),
                },
            )?;
            // A sealed field's `key_id` is stamped on the field row, like
            // every sealed cell's, so the generation guard can check it.
            if sealed_value {
                ctx.connection().execute(
                    "UPDATE locker_item_field SET key_id = ?1 WHERE id = ?2",
                    rusqlite::params![ctx.optional_str("key_id"), written],
                )?;
            }
            Ok(serde_json::json!({ "field_id": written, "item_id": item_id }))
        },
    );
    definition.sealed_input = &["value"];
    definition
}

pub(super) fn remove_field() -> CommandDefinition {
    definition(
        "locker.remove_field",
        r#"{
          "type": "object",
          "required": ["item_id", "field_id"],
          "additionalProperties": false,
          "properties": {
            "item_id": { "type": "string", "minLength": 1 },
            "field_id": { "type": "string", "minLength": 1 }
          }
        }"#,
        Idempotency::Idempotent,
        ITEM_LIVE,
        NONE,
        |ctx| {
            let item_id = ctx.required_str("item_id")?.to_owned();
            let field_id = ctx.required_str("field_id")?.to_owned();
            ctx.connection().execute(
                "DELETE FROM locker_item_field WHERE id = ?1 AND item_id = ?2 AND field_key IS NULL",
                rusqlite::params![field_id, item_id],
            )?;
            Ok(serde_json::json!({ "field_id": field_id, "item_id": item_id }))
        },
    )
}

pub(super) fn set_addresses_command() -> CommandDefinition {
    definition(
        "locker.set_addresses",
        r#"{
          "type": "object",
          "required": ["item_id", "addresses"],
          "additionalProperties": false,
          "properties": {
            "item_id": { "type": "string", "minLength": 1 },
            "addresses": { "type": "array", "items": {
              "type": "object",
              "required": ["url"],
              "additionalProperties": false,
              "properties": {
                "url": { "type": "string", "minLength": 1 }
              }
            } }
          }
        }"#,
        Idempotency::Idempotent,
        ITEM_LIVE,
        NONE,
        |ctx| {
            let item_id = ctx.required_str("item_id")?.to_owned();
            let addresses: Vec<String> = ctx
                .input
                .get("addresses")
                .and_then(serde_json::Value::as_array)
                .map(|list| {
                    list.iter()
                        .filter_map(|address| Some(address.get("url")?.as_str()?.to_owned()))
                        .collect()
                })
                .unwrap_or_default();
            // `locker_item.url` stays the PRIMARY, so the connector binding
            // and Review's unsecured-address check keep working. No secret is involved, which is why this one takes the
            // whole list.
            let written = set_addresses(ctx, &item_id, &addresses)?;
            Ok(serde_json::json!({ "item_id": item_id, "count": written }))
        },
    )
}

pub(super) fn set_passkey() -> CommandDefinition {
    let mut definition = definition(
        "locker.set_passkey",
        r#"{
          "type": "object",
          "required": ["item_id", "rp_id"],
          "additionalProperties": false,
          "properties": {
            "item_id": { "type": "string", "minLength": 1 },
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
        SET_PASSKEY_PRE,
        NONE,
        |ctx| {
            let item_id = ctx.required_str("item_id")?.to_owned();
            let private_key = ctx.optional_str("private_key").map(str::to_owned);
            assert_sealed_cell("private_key", private_key.as_deref())?;
            let sealed = private_key
                .as_deref()
                .is_some_and(|value| !value.is_empty() && value != SEALED_PLACEHOLDER);
            assert_key_generation(ctx, sealed)?;

            // STORAGE ONLY: this mints no challenge, signs nothing and speaks
            // no WebAuthn. The slot's `item_id` is its own primary key, so the
            // core already knows the id it seals against — no new id is needed.
            let existing: Option<(Option<String>, Option<String>, String)> = ctx
                .connection()
                .query_row(
                    "SELECT private_key, key_id, created_at
                       FROM locker_item_passkey WHERE item_id = ?1",
                    [&item_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .ok();
            // THE PLACEHOLDER KEEPS THE KEY AND THE GENERATION IT WAS SEALED
            // UNDER (#1047 T2). A rename sends `«sealed»` and no `key_id`,
            // because a caller that never held the key has no generation to
            // name; writing the input's absent `key_id` over the stored one
            // left a ciphertext that named no generation.
            let (stored, stored_key_id) = if private_key.as_deref() == Some(SEALED_PLACEHOLDER) {
                existing.as_ref().map_or((None, None), |(key, key_id, _)| {
                    (key.clone(), key_id.clone())
                })
            } else {
                let key = private_key.filter(|value| !value.is_empty());
                let key_id = key
                    .as_ref()
                    .and_then(|_| ctx.optional_str("key_id").map(str::to_owned));
                (key, key_id)
            };
            let created_at = existing
                .as_ref()
                .map_or_else(|| ctx.now.clone(), |(_, _, created)| created.clone());
            ctx.connection().execute(
                "INSERT INTO locker_item_passkey
                   (item_id, rp_id, user_handle, display_name, credential_id, algorithm,
                    private_key, key_id, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                 ON CONFLICT(item_id) DO UPDATE SET
                   rp_id = excluded.rp_id,
                   user_handle = excluded.user_handle,
                   display_name = excluded.display_name,
                   credential_id = excluded.credential_id,
                   algorithm = excluded.algorithm,
                   private_key = excluded.private_key,
                   key_id = excluded.key_id,
                   updated_at = excluded.updated_at",
                rusqlite::params![
                    item_id,
                    ctx.required_str("rp_id")?,
                    ctx.optional_str("user_handle"),
                    ctx.optional_str("display_name"),
                    ctx.optional_str("credential_id"),
                    ctx.optional_str("algorithm"),
                    stored,
                    stored_key_id,
                    created_at,
                    ctx.now
                ],
            )?;
            Ok(item_id_output(&item_id))
        },
    );
    definition.sealed_input = &["private_key"];
    definition
}

pub(super) fn clear_passkey() -> CommandDefinition {
    definition(
        "locker.clear_passkey",
        item_id_only!(),
        Idempotency::Idempotent,
        ITEM_LIVE,
        NONE,
        |ctx| {
            let item_id = ctx.required_str("item_id")?.to_owned();
            ctx.connection().execute(
                "DELETE FROM locker_item_passkey WHERE item_id = ?1",
                [&item_id],
            )?;
            Ok(item_id_output(&item_id))
        },
    )
}

pub(super) fn set_memo() -> CommandDefinition {
    definition(
        "locker.set_memo",
        r#"{
          "type": "object",
          "required": ["item_id", "note"],
          "additionalProperties": false,
          "properties": {
            "item_id": { "type": "string", "minLength": 1 },
            "note": { "type": "string" }
          }
        }"#,
        Idempotency::Idempotent,
        ITEM_LIVE,
        NONE,
        |ctx| {
            let item_id = ctx.required_str("item_id")?.to_owned();
            // An owner remark is a `knowledge.annotation` (#310) and is
            // PLAINTEXT. Secrets go in sealed fields, which stay out of every
            // index; a memo is plain and is part of the item's search text
            // (`index::text_of`). An empty note clears it.
            replace_memo(ctx, &item_id, ctx.required_str("note")?)?;
            Ok(item_id_output(&item_id))
        },
    )
}
