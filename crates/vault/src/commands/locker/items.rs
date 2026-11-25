//! Item commands: `locker.add_item`, `locker.edit_item`, `locker.duplicate_item`,
//! `locker.counts` and `locker.export`.
//!
//! An item is an entity of its own kind like every other: its title, home, trash, star, archive,
//! tags, links, `[[title]]` and attachments are the vault's shared verbs (`entity.*`, `tag.*`,
//! `edge.add`, `link.add`), and this file adds only what an item's own rows are: its type, its
//! compromised flag and its fields.

use crate::commands::entity::{self, STALE_GUARD, with_rev};
use crate::commands::{
    CommandCondition, CommandCtx, CommandDefinition, Idempotency, Risk, arrival,
};
use crate::error::Result;
use crate::model::Kind;

use super::custody::{ITEM_LIVE_CHECK, NONE, assert_fresh_id, invalid, sentence_of};
use super::fields::{FieldIn, field_schema, refusal_of, write_all};
use super::schema::is_sealed_kind;
use super::{definition, item_type_of};

fn fields_of(ctx: &CommandCtx<'_, '_>, key: &str) -> Result<Vec<FieldIn>> {
    match ctx.input.get(key) {
        None => Ok(Vec::new()),
        Some(value) => serde_json::from_value(value.clone()).map_err(|error| {
            invalid(key, format!("a field list is malformed: {error}"))
        }),
    }
}

fn item_id_refusal(ctx: &CommandCtx<'_, '_>, key: &str) -> Result<Option<String>> {
    let id = ctx.required_str(key)?;
    if !crate::model::is_minted_id(id) {
        return Ok(Some("an item's id is a lowercase UUIDv7".to_owned()));
    }
    Ok(assert_fresh_id(ctx, key, id).err().map(sentence_of))
}

#[derive(serde::Deserialize)]
struct AddItemInput {
    item_id: String,
    #[serde(rename = "type")]
    item_type: String,
    title: String,
    compromised: Option<bool>,
}

pub(super) fn add_item() -> CommandDefinition {
    static PRE: &[CommandCondition] = &[
        CommandCondition {
            predicate: "item_id_is_fresh",
            check: |ctx| item_id_refusal(ctx, "item_id"),
        },
        CommandCondition {
            predicate: "fields_are_well_formed_and_secrets_are_sealed",
            check: |ctx| {
                let fields = fields_of(ctx, "fields")?;
                refusal_of(ctx, ctx.required_str("item_id")?, ctx.required_str("type")?, &fields)
            },
        },
    ];
    let mut definition = definition(
        "locker.add_item",
        concat!(
            r#"{
          "type": "object",
          "required": ["item_id", "type", "title"],
          "additionalProperties": false,
          "properties": {
            "item_id": { "type": "string", "minLength": 1, "maxLength": 64 },
            "type": { "type": "string", "enum": [
              "login", "card", "note", "identity", "wifi", "password",
              "ssh_key", "api_credential", "passport", "bank_account",
              "driving_licence", "software_licence", "crypto_wallet",
              "membership", "document"
            ] },
            "title": { "type": "string", "maxLength": 1000 },
            "compromised": { "type": "boolean" },
            "fields": { "type": "array", "maxItems": 200, "items": "#,
            field_schema!(),
            r#" },
            "#,
            arrival::arrived_property!(),
            r#"
          }
        }"#
        ),
        Idempotency::Once,
        PRE,
        NONE,
        |ctx| {
            let input: AddItemInput = ctx.parse_input()?;
            let fields = fields_of(ctx, "fields")?;
            ctx.insert_entity_as(&input.item_id, Kind::LockerItem, input.title.trim())?;
            ctx.connection().execute(
                "INSERT INTO locker_item (id, type, compromised) VALUES (?1, ?2, ?3)",
                rusqlite::params![
                    input.item_id,
                    input.item_type,
                    i64::from(input.compromised.unwrap_or(false))
                ],
            )?;
            let written = write_all(ctx, &input.item_id, &input.item_type, &fields)?;
            arrival::record(ctx, &input.item_id, Kind::LockerItem)?;
            Ok(serde_json::json!({ "item_id": input.item_id, "fields": written }))
        },
    );
    definition.sealed_input = &["fields[].value"];
    definition
}

#[derive(serde::Deserialize)]
struct EditItemInput {
    item_id: String,
    title: Option<String>,
    compromised: Option<bool>,
    #[serde(default)]
    remove: Vec<String>,
}

pub(super) fn edit_item() -> CommandDefinition {
    static PRE: &[CommandCondition] = &[
        STALE_GUARD[0],
        STALE_GUARD[1],
        ITEM_LIVE_CHECK,
        CommandCondition {
            predicate: "fields_are_well_formed_and_secrets_are_sealed",
            check: |ctx| {
                let item_id = ctx.required_str("item_id")?;
                let item_type = item_type_of(ctx, item_id)?;
                let fields = fields_of(ctx, "fields")?;
                if let Some(sentence) = refusal_of(ctx, item_id, &item_type, &fields)? {
                    return Ok(Some(sentence));
                }
                let input: EditItemInput = ctx.parse_input()?;
                for id in &input.remove {
                    let own = super::count(
                        ctx,
                        "SELECT COUNT(*) FROM locker_item_field WHERE id = ?1 AND item_id = ?2",
                        &[id, item_id],
                    )?;
                    if own != 1 {
                        return Ok(Some("that is not one of this item's fields".to_owned()));
                    }
                }
                Ok(None)
            },
        },
    ];
    let mut definition = definition(
        "locker.edit_item",
        concat!(
            r#"{
          "type": "object",
          "description": "Changes what it is given and nothing else: the title, the compromised flag, the fields it lists (each as locker.set_field would) and the field ids it removes. One save is one version.",
          "required": ["item_id"],
          "additionalProperties": false,
          "properties": {
            "item_id": { "type": "string", "minLength": 1 },
            "expected_rev": { "type": "integer", "minimum": 0 },
            "title": { "type": "string", "maxLength": 1000 },
            "compromised": { "type": "boolean" },
            "fields": { "type": "array", "maxItems": 200, "items": "#,
            field_schema!(),
            r#" },
            "remove": { "type": "array", "maxItems": 200, "items": { "type": "string", "minLength": 1 } }
          }
        }"#
        ),
        Idempotency::Idempotent,
        PRE,
        NONE,
        |ctx| {
            let input: EditItemInput = ctx.parse_input()?;
            let item_type = item_type_of(ctx, &input.item_id)?;
            let fields = fields_of(ctx, "fields")?;
            if let Some(title) = input.title.as_deref() {
                entity::rename(ctx, &input.item_id, title.trim())?;
            }
            if let Some(compromised) = input.compromised {
                ctx.connection().execute(
                    "UPDATE locker_item SET compromised = ?2 WHERE id = ?1",
                    rusqlite::params![input.item_id, i64::from(compromised)],
                )?;
            }
            for id in &input.remove {
                ctx.connection().execute(
                    "DELETE FROM locker_item_field WHERE id = ?1 AND item_id = ?2",
                    [id, &input.item_id],
                )?;
            }
            let written = write_all(ctx, &input.item_id, &item_type, &fields)?;
            ctx.touch(&input.item_id)?;
            with_rev(
                ctx,
                &input.item_id,
                serde_json::json!({ "item_id": input.item_id, "fields": written }),
            )
        },
    );
    definition.sealed_input = &["fields[].value"];
    definition
}

#[derive(serde::Deserialize)]
struct DuplicateInput {
    item_id: String,
    new_item_id: String,
}

pub(super) fn duplicate_item() -> CommandDefinition {
    static PRE: &[CommandCondition] = &[
        ITEM_LIVE_CHECK,
        CommandCondition {
            predicate: "new_item_id_is_fresh",
            check: |ctx| item_id_refusal(ctx, "new_item_id"),
        },
        CommandCondition {
            predicate: "fields_are_well_formed_and_secrets_are_sealed",
            check: |ctx| {
                let item_type = item_type_of(ctx, ctx.required_str("item_id")?)?;
                let fields = fields_of(ctx, "fields")?;
                refusal_of(ctx, ctx.required_str("new_item_id")?, &item_type, &fields)
            },
        },
    ];
    let mut definition = definition(
        "locker.duplicate_item",
        concat!(
            r#"{
          "type": "object",
          "description": "A copy takes the source's plain fields, its tags and its type. Each secret (a sealed field, a one-time-code seed, a file) is sent by the core RE-SEALED against the copy's own field ids, in `fields`: a ciphertext is bound to its row and cannot be copied. The alias is not copied (one item holds it).",
          "required": ["item_id", "new_item_id"],
          "additionalProperties": false,
          "properties": {
            "item_id": { "type": "string", "minLength": 1 },
            "new_item_id": { "type": "string", "minLength": 1, "maxLength": 64 },
            "fields": { "type": "array", "maxItems": 200, "items": "#,
            field_schema!(),
            r#" }
          }
        }"#
        ),
        Idempotency::Once,
        PRE,
        NONE,
        |ctx| {
            let input: DuplicateInput = ctx.parse_input()?;
            let (source_title, source_type, compromised): (String, String, i64) =
                ctx.connection().query_row(
                    "SELECT e.title, i.type, i.compromised FROM locker_item i
                       JOIN entity e ON e.id = i.id WHERE i.id = ?1",
                    [&input.item_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )?;
            let title = format!("{source_title} copy");
            ctx.insert_entity_as(&input.new_item_id, Kind::LockerItem, &title)?;
            ctx.connection().execute(
                "INSERT INTO locker_item (id, type, compromised) VALUES (?1, ?2, ?3)",
                rusqlite::params![input.new_item_id, source_type, compromised],
            )?;
            // The plain fields come verbatim; the core's re-sealed secrets follow.
            let plain: Vec<(Option<String>, String, String, String, f64, String)> = {
                let mut statement = ctx.connection().prepare(
                    "SELECT field_key, section, label, kind, position, value_text
                       FROM locker_item_field
                      WHERE item_id = ?1 AND claimed = 0 AND value_text IS NOT NULL
                      ORDER BY position, id",
                )?;
                let rows = statement.query_map([&input.item_id], |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                })?;
                rows.collect::<rusqlite::Result<_>>()?
            };
            let mut copied = Vec::new();
            for (key, section, label, kind, position, value) in plain {
                let field = FieldIn {
                    field_key: key,
                    section: Some(section),
                    label: Some(label),
                    kind: Some(kind),
                    value: Some(value),
                    position: Some(position),
                    ..FieldIn::default()
                };
                copied.extend(write_all(ctx, &input.new_item_id, &source_type, &[field])?);
            }
            let resealed = fields_of(ctx, "fields")?;
            copied.extend(write_all(ctx, &input.new_item_id, &source_type, &resealed)?);
            // The source's tags come along; its star and archive do not. The copy is a new thing.
            ctx.connection().execute(
                "INSERT INTO edge (from_id, rel, to_id, created_at)
                 SELECT ?2, 'tagged', e.to_id, ?3 FROM edge e
                  WHERE e.from_id = ?1 AND e.rel = 'tagged'",
                rusqlite::params![input.item_id, input.new_item_id, ctx.now],
            )?;
            Ok(serde_json::json!({
                "item_id": input.new_item_id,
                "title": title,
                "fields": copied,
            }))
        },
    );
    definition.sealed_input = &["fields[].value"];
    definition
}

pub(super) fn counts() -> CommandDefinition {
    definition(
        "locker.counts",
        r#"{ "type": "object", "additionalProperties": false, "properties": {} }"#,
        Idempotency::RetrySafe,
        NONE,
        NONE,
        |ctx| {
            let one = |sql: &str| -> Result<i64> {
                Ok(ctx.connection().query_row(sql, [], |row| row.get(0))?)
            };
            // Trash wins over archive, as for every kind.
            let mut statement = ctx.connection().prepare(
                "SELECT i.type, COUNT(*) FROM locker_item i JOIN entity e ON e.id = i.id
                  WHERE e.deleted_at IS NULL AND e.archived_at IS NULL
                  GROUP BY i.type ORDER BY i.type",
            )?;
            let by_type: Vec<serde_json::Value> = statement
                .query_map([], |row| {
                    Ok(serde_json::json!({
                        "type": row.get::<_, String>(0)?,
                        "n": row.get::<_, i64>(1)?
                    }))
                })?
                .collect::<rusqlite::Result<_>>()?;
            Ok(serde_json::json!({
                "live": one("SELECT COUNT(*) FROM locker_item i JOIN entity e ON e.id = i.id
                              WHERE e.deleted_at IS NULL AND e.archived_at IS NULL")?,
                "archived": one("SELECT COUNT(*) FROM locker_item i JOIN entity e ON e.id = i.id
                              WHERE e.deleted_at IS NULL AND e.archived_at IS NOT NULL")?,
                "trashed": one("SELECT COUNT(*) FROM locker_item i JOIN entity e ON e.id = i.id
                              WHERE e.deleted_at IS NOT NULL")?,
                "by_type": by_type,
            }))
        },
    )
}

/// LOCKER'S OWN EXPORT, the only way an item's contents leave the phone (nothing else reads a
/// Locker table: "Export everything" leaves Locker out and an item has no share).
///
/// It is a mass reveal of secrets, so it is confirmed, high-risk, and REFUSED on a phone with no
/// passcode (`device_passcode`, which the shell states from the platform: a phone with nothing
/// protecting it would hand the export to whoever holds it). The command answers the plain values
/// and each secret as the ciphertext it is, with its key generation and the field id it is bound
/// to; the core, which holds `K`, opens them into the file. The file's own bytes (a sealed file)
/// are named by hash and read from the store sealed, then opened by the core the same way.
/// An export stamps no item: a file is not a use of any one of them.
pub(super) fn export() -> CommandDefinition {
    static PRE: &[CommandCondition] = &[CommandCondition {
        predicate: "phone_has_a_passcode",
        check: |ctx| {
            let secured = ctx
                .input
                .get("device_passcode")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            Ok((!secured).then(|| {
                "Locker's export needs a passcode on this phone: set one in Settings, then \
                 try again"
                    .to_owned()
            }))
        },
    }];
    let mut definition = definition(
        "locker.export",
        r#"{
          "type": "object",
          "required": ["confirm", "device_passcode"],
          "additionalProperties": false,
          "properties": {
            "confirm": { "type": "boolean", "const": true },
            "device_passcode": { "type": "boolean" },
            "include_trashed": { "type": "boolean" }
          }
        }"#,
        Idempotency::RetrySafe,
        PRE,
        NONE,
        |ctx| {
            let include_trashed = ctx
                .input
                .get("include_trashed")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            let predicate = if include_trashed {
                ""
            } else {
                "WHERE e.deleted_at IS NULL"
            };
            let mut items_statement = ctx.connection().prepare(&format!(
                "SELECT i.id, i.type, e.title, i.compromised, e.created_at, e.updated_at,
                        e.archived_at, e.deleted_at, i.last_used_at
                   FROM locker_item i JOIN entity e ON e.id = i.id
                 {predicate} ORDER BY e.created_at, i.id"
            ))?;
            let mut fields = ctx.connection().prepare(
                "SELECT id, field_key, section, label, kind, value_text, value_sealed,
                        value_blob, key_id, value_set_at
                   FROM locker_item_field WHERE item_id = ?1 ORDER BY position, id",
            )?;
            let mut passkeys = ctx.connection().prepare(
                "SELECT id, rp_id, user_handle, display_name, credential_id, algorithm,
                        private_key, key_id FROM locker_item_passkey WHERE item_id = ?1 ORDER BY id",
            )?;
            let rows: Vec<[Option<String>; 9]> = items_statement
                .query_map([], |row| {
                    let mut cells: [Option<String>; 9] = Default::default();
                    cells[0] = Some(row.get(0)?);
                    cells[1] = Some(row.get(1)?);
                    cells[2] = Some(row.get(2)?);
                    cells[3] = Some(row.get::<_, i64>(3)?.to_string());
                    for (at, cell) in cells.iter_mut().enumerate().skip(4) {
                        *cell = row.get(at)?;
                    }
                    Ok(cells)
                })?
                .collect::<rusqlite::Result<_>>()?;
            let mut items = Vec::with_capacity(rows.len());
            for cells in rows {
                let item_id = cells[0].clone().unwrap_or_default();
                let field_rows: Vec<serde_json::Value> = fields
                    .query_map([&item_id], |row| {
                        let kind: String = row.get(4)?;
                        let mut field = serde_json::json!({
                            "field_id": row.get::<_, String>(0)?,
                            "field_key": row.get::<_, Option<String>>(1)?,
                            "section": row.get::<_, String>(2)?,
                            "label": row.get::<_, String>(3)?,
                            "kind": kind,
                            "value_set_at": row.get::<_, Option<String>>(9)?,
                        });
                        if is_sealed_kind(&kind) {
                            field["sealed"] = row.get::<_, Option<String>>(6)?.into();
                            field["key_id"] = row.get::<_, Option<String>>(8)?.into();
                            field["blob"] = row.get::<_, Option<String>>(7)?.into();
                        } else {
                            field["value"] = row.get::<_, Option<String>>(5)?.into();
                        }
                        Ok(field)
                    })?
                    .collect::<rusqlite::Result<_>>()?;
                let passkey_rows: Vec<serde_json::Value> = passkeys
                    .query_map([&item_id], |row| {
                        Ok(serde_json::json!({
                            "passkey_id": row.get::<_, String>(0)?,
                            "rp_id": row.get::<_, String>(1)?,
                            "user_handle": row.get::<_, Option<String>>(2)?,
                            "display_name": row.get::<_, Option<String>>(3)?,
                            "credential_id": row.get::<_, Option<String>>(4)?,
                            "algorithm": row.get::<_, Option<String>>(5)?,
                            "private_key": row.get::<_, Option<String>>(6)?,
                            "key_id": row.get::<_, Option<String>>(7)?,
                        }))
                    })?
                    .collect::<rusqlite::Result<_>>()?;
                items.push(serde_json::json!({
                    "item_id": item_id,
                    "type": cells[1],
                    "title": cells[2],
                    "compromised": cells[3],
                    "created_at": cells[4],
                    "updated_at": cells[5],
                    "archived_at": cells[6],
                    "deleted_at": cells[7],
                    "last_used_at": cells[8],
                    "fields": field_rows,
                    "passkeys": passkey_rows,
                }));
            }
            Ok(serde_json::json!({
                "exported_at": ctx.now,
                "item_count": items.len(),
                "items": items,
            }))
        },
    );
    definition.risk = Risk::High;
    definition.confirm = true;
    definition
}
