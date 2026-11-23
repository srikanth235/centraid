//! Item lifecycle commands: `locker.add_item`, `locker.edit_item`, `locker.duplicate_item`,
//! `locker.counts`, and `locker.export`.

use std::collections::BTreeMap;

use crate::commands::{CommandCondition, CommandDefinition, Idempotency, Risk, arrival};
use crate::error::Result;
use crate::model::Kind;

use super::custody::{
    ADD_ITEM_PRE, DUPLICATE_ITEM_PRE, EDIT_ITEM_PRE, ITEM_EXISTS_SQL, NONE, assert_fresh_id,
    assert_key_generation, assert_sealed_cell, assert_sealed_cells, carries_secret,
    password_rotated,
};
use super::schema::{
    ALL_FIELDS, SEALED_ITEM_CELLS, SEALED_PLACEHOLDER, field_schema, field_values, is_sealed_kind,
    type_enum, type_fields,
};
use super::sidecars::{
    FieldWrite, mint_template_fields, set_addresses, set_alias, write_built_in_field, write_field,
};
use super::{count, definition, item_type_of};

#[derive(serde::Deserialize)]
struct AddItemInput {
    item_id: String,
    #[serde(rename = "type")]
    item_type: String,
    title: String,
    compromised: Option<bool>,
    alias: Option<String>,
    key_id: Option<String>,
}

pub(super) fn add_item() -> CommandDefinition {
    static POST: &[CommandCondition] = &[CommandCondition {
        predicate: "item_created",
        check: |ctx| {
            let item_id = ctx.required_str("item_id")?;
            let found = count(ctx, ITEM_EXISTS_SQL, &[item_id])?;
            Ok((found != 1).then(|| "the item was not saved".to_owned()))
        },
    }];
    let mut definition = definition(
        "locker.add_item",
        concat!(
            r#"{
          "type": "object",
          "required": ["item_id", "type", "title"],
          "additionalProperties": false,
          "properties": {
            "item_id": { "type": "string", "minLength": 1, "maxLength": 64 },
            "#,
            type_enum!(),
            r#"
            "title": { "type": "string", "minLength": 1 },
            "compromised": { "type": "boolean" },
            "alias": { "type": "string", "pattern": "^[A-Za-z0-9._-]{1,64}$" },
            "#,
            arrival::arrived_property!(),
            r#","#,
            field_schema!(),
            r#"
          }
        }"#
        ),
        Idempotency::Once,
        ADD_ITEM_PRE,
        POST,
        |ctx| {
            let input: AddItemInput = ctx.parse_input()?;
            assert_fresh_id(ctx, "item_id", &input.item_id)?;
            assert_sealed_cells(ctx, &SEALED_ITEM_CELLS)?;
            let secret = carries_secret(ctx, &SEALED_ITEM_CELLS);
            assert_key_generation(ctx, secret)?;

            let values = field_values(ctx, &input.item_type);
            let password = values
                .iter()
                .find(|(column, _)| *column == "password")
                .and_then(|(_, value)| value.clone());
            let compromised = i64::from(input.compromised.unwrap_or(false));
            // PASSWORD AGE IS SET-TIME, NEVER `updated_at`: a retag must not
            // make a three-year-old password look fresh (GAPS §3.3 #6d).
            let password_set_at = password.as_ref().map(|_| ctx.now.clone());

            // THE ENTITY FIRST, under the caller's id (D-1020-L9): the kind row
            // joins it by `(id, kind)`, and the title, the stamps and the trash
            // window are the entity's, like every kind's.
            ctx.insert_entity_as(&input.item_id, Kind::LockerItem, &input.title)?;
            ctx.connection().execute(
                "INSERT INTO locker_item (id, type, compromised, password_set_at)
                 VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![input.item_id, input.item_type, compromised, password_set_at],
            )?;

            // Only the type's own built-in fields are stored, uniformly in
            // `locker_item_field` keyed by `field_key`, so a member who filled
            // a login and switched to Wi-Fi never stores the login's fields.
            for (position, (column, value)) in values.iter().enumerate() {
                if let Some(value) = value.as_deref() {
                    write_built_in_field(
                        ctx,
                        &input.item_id,
                        column,
                        Some(value),
                        input.key_id.as_deref(),
                        i64::try_from(position).unwrap_or(0),
                    )?;
                }
            }

            if let Some(alias) = input.alias.as_deref() {
                set_alias(ctx, &input.item_id, alias)?;
            }
            // A type is a set of sections and fields: the nine expansion types
            // arrive as EMPTY template rows the member fills in, which is also
            // what lets an unknown type degrade to a note that still carries
            // them. Empty needs no key, so a vault with no `K` can still make
            // a passport item and list it.
            let minted = mint_template_fields(ctx, &input.item_id, &input.item_type)?;
            arrival::record(ctx, &input.item_id, Kind::LockerItem)?;
            Ok(serde_json::json!({ "item_id": input.item_id, "template_fields": minted }))
        },
    );
    definition.sealed_input = &SEALED_ITEM_CELLS;
    definition
}

#[derive(serde::Deserialize)]
struct EditItemInput {
    item_id: String,
    title: Option<String>,
    compromised: Option<bool>,
    alias: Option<String>,
    key_id: Option<String>,
    password: Option<String>,
}

pub(super) fn edit_item() -> CommandDefinition {
    let mut definition = definition(
        "locker.edit_item",
        concat!(
            r#"{
          "type": "object",
          "description": "REPLACES, does not patch. Every field of the item's type (username, url, password, one-time-code seed, notes, and the rest of its type's fields) is rewritten from this input, and each one the input leaves out or leaves empty is CLEARED: an edit carrying only a password erases the username, address, seed and notes. Send the whole draft; a sealed secret you are keeping goes as the placeholder «sealed». Only the title, the alias (an empty one clears it) and the compromised flag (a changed password clears it) are left alone when omitted. Tags, the star and the archive are the vault's own (`tag.add`, `flag.set`); custom fields, addresses, the passkey and the memo are their own commands. None is touched here.",
          "required": ["item_id"],
          "additionalProperties": false,
          "properties": {
            "item_id": { "type": "string", "minLength": 1 },
            "title": { "type": "string", "minLength": 1 },
            "compromised": { "type": "boolean" },
            "expected_rev": { "type": "integer", "minimum": 0 },
            "alias": { "type": "string", "pattern": "^[A-Za-z0-9._-]{0,64}$" },
            "#,
            field_schema!(),
            r#"
          }
        }"#
        ),
        Idempotency::Idempotent,
        EDIT_ITEM_PRE,
        NONE,
        |ctx| {
            let input: EditItemInput = ctx.parse_input()?;
            let item_type = item_type_of(ctx, &input.item_id)?;
            assert_sealed_cells(ctx, &SEALED_ITEM_CELLS)?;
            let secret = carries_secret(ctx, &SEALED_ITEM_CELLS);
            assert_key_generation(ctx, secret)?;
            let rotated = password_rotated(ctx)?;

            let mut sets: Vec<String> = Vec::new();
            let mut binds: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
            let push = |sets: &mut Vec<String>,
                        binds: &mut Vec<Box<dyn rusqlite::ToSql>>,
                        column: &str,
                        value: Box<dyn rusqlite::ToSql>| {
                binds.push(value);
                sets.push(format!("{column} = ?{}", binds.len()));
            };

            if let Some(title) = input.title.as_deref() {
                ctx.connection().execute(
                    "UPDATE entity SET title = ?2 WHERE id = ?1",
                    [input.item_id.as_str(), title],
                )?;
            }
            // THE COMPROMISED FLAG (#1047, R-1047-F7): the member's, set and
            // cleared by hand — nothing produces it automatically. A ROTATION
            // CLEARS IT, because the fix Review asks for ("change the
            // password") has been made; a write that states the flag itself
            // wins over that rule, since the member said so in the same breath.
            if let Some(compromised) = input.compromised.or_else(|| rotated.then_some(false)) {
                push(
                    &mut sets,
                    &mut binds,
                    "compromised",
                    Box::new(i64::from(compromised)),
                );
            }
            // A ROTATION, distinguished from any other edit. The core says so
            // (see `password_rotated`); only a real change re-stamps the age.
            if rotated {
                let stamp = input
                    .password
                    .as_deref()
                    .filter(|value| !value.is_empty())
                    .map(|_| ctx.now.clone());
                push(&mut sets, &mut binds, "password_set_at", Box::new(stamp));
            }
            if !sets.is_empty() {
                binds.push(Box::new(input.item_id.clone()));
                let sql = format!(
                    "UPDATE locker_item SET {} WHERE id = ?{}",
                    sets.join(", "),
                    binds.len()
                );
                let params: Vec<&dyn rusqlite::ToSql> =
                    binds.iter().map(std::convert::AsRef::as_ref).collect();
                ctx.connection().execute(&sql, params.as_slice())?;
            }

            // EDIT REPLACES THE TYPE'S FIELDS; IT DOES NOT PATCH THEM, AND SAYS SO
            // (L4, ruled 2026-10-15). A round-tripped placeholder is the one
            // exception to the clearing and is SKIPPED: that is what "leave this
            // secret alone" means.
            let mut changed: Vec<&str> = Vec::new();
            for (position, (column, value)) in field_values(ctx, &item_type).into_iter().enumerate()
            {
                if ctx.optional_str(column) == Some(SEALED_PLACEHOLDER) {
                    continue;
                }
                write_built_in_field(
                    ctx,
                    &input.item_id,
                    column,
                    value.as_deref(),
                    input.key_id.as_deref(),
                    i64::try_from(position).unwrap_or(0),
                )?;
                changed.push(column);
            }
            ctx.touch(&input.item_id)?;

            if let Some(alias) = input.alias.as_deref() {
                // An EMPTY alias clears the binding, which is the paper cut
                // README-Locker §8 names: a member could set one and never
                // take it back.
                set_alias(ctx, &input.item_id, alias)?;
            }
            crate::commands::entity::with_rev(
                ctx,
                &input.item_id,
                serde_json::json!({
                    "item_id": input.item_id,
                    "rotated": rotated,
                    "columns": changed
                }),
            )
        },
    );
    definition.sealed_input = &SEALED_ITEM_CELLS;
    definition
}

#[derive(serde::Deserialize)]
struct DuplicateFieldInput {
    field_id: String,
    #[serde(default)]
    section: String,
    #[serde(default)]
    label: String,
    kind: Option<String>,
    value: Option<String>,
    position: Option<i64>,
}

#[derive(serde::Deserialize)]
struct DuplicateItemInput {
    item_id: String,
    new_item_id: String,
    key_id: Option<String>,
    #[serde(default)]
    fields: Vec<DuplicateFieldInput>,
}

pub(super) fn duplicate_item() -> CommandDefinition {
    let mut definition = definition(
        "locker.duplicate_item",
        concat!(
            r#"{
          "type": "object",
          "required": ["item_id", "new_item_id"],
          "additionalProperties": false,
          "properties": {
            "item_id": { "type": "string", "minLength": 1 },
            "new_item_id": { "type": "string", "minLength": 1, "maxLength": 64 },
            "fields": { "type": "array", "items": {
              "type": "object",
              "required": ["field_id", "section", "label", "kind"],
              "additionalProperties": false,
              "properties": {
                "field_id": { "type": "string", "minLength": 1, "maxLength": 64 },
                "section": { "type": "string" },
                "label": { "type": "string", "minLength": 1 },
                "kind": { "type": "string",
                  "enum": ["text", "sealed", "url", "date", "otp"] },
                "value": { "type": "string" },
                "position": { "type": "integer", "minimum": 0 }
              }
            } },
            "#,
            field_schema!(),
            r#"
          }
        }"#
        ),
        Idempotency::Once,
        DUPLICATE_ITEM_PRE,
        NONE,
        |ctx| {
            let input: DuplicateItemInput = ctx.parse_input()?;
            let source_id = &input.item_id;
            let item_id = &input.new_item_id;
            assert_fresh_id(ctx, "new_item_id", item_id)?;
            assert_sealed_cells(ctx, &SEALED_ITEM_CELLS)?;
            let secret = carries_secret(ctx, &SEALED_ITEM_CELLS);
            assert_key_generation(ctx, secret)?;

            // CLONE-AND-EDIT FOR SIBLING ACCOUNTS (GAPS §3.3 #10): the core
            // re-encrypts every secret under the new field id and sends the
            // cells, so the command plane never reads a secret.
            let source_title: String = ctx.connection().query_row(
                "SELECT title FROM entity WHERE id = ?1",
                [source_id],
                |row| row.get(0),
            )?;
            let (source_type, compromised, password_set_at): (String, i64, Option<String>) =
                ctx.connection().query_row(
                    "SELECT type, compromised, password_set_at FROM locker_item WHERE id = ?1",
                    [source_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )?;
            let title = format!("{source_title} copy");
            ctx.insert_entity_as(item_id, Kind::LockerItem, &title)?;
            ctx.connection().execute(
                "INSERT INTO locker_item (id, type, compromised, password_set_at)
                 VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![item_id, source_type, compromised, password_set_at],
            )?;

            // Copy plain built-in fields verbatim from the source item.
            let plain_fields: Vec<(String, Option<String>, i64)> = {
                let mut statement = ctx.connection().prepare(
                    "SELECT field_key, value_text, CAST(position AS INTEGER)
                       FROM locker_item_field
                      WHERE item_id = ?1 AND field_key IS NOT NULL
                        AND kind NOT IN ('sealed', 'otp')
                      ORDER BY position, id",
                )?;
                let rows = statement.query_map([source_id], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                })?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            };
            for (field_key, value_text, position) in plain_fields {
                if let Some(value) = value_text.as_deref() {
                    write_built_in_field(ctx, item_id, &field_key, Some(value), None, position)?;
                }
            }
            // Write any re-sealed built-in secret cells the core sent.
            let owned = type_fields(&source_type);
            for column in SEALED_ITEM_CELLS {
                if !owned.contains(&column) {
                    continue;
                }
                if let Some(value) = ctx
                    .optional_str(column)
                    .filter(|value| !value.is_empty() && *value != SEALED_PLACEHOLDER)
                {
                    let position = owned
                        .iter()
                        .position(|known| *known == column)
                        .and_then(|pos| i64::try_from(pos).ok())
                        .unwrap_or(0);
                    write_built_in_field(
                        ctx,
                        item_id,
                        column,
                        Some(value),
                        input.key_id.as_deref(),
                        position,
                    )?;
                }
            }

            // The custom fields, re-sealed by the core against their own new
            // ids for the same AAD reason.
            let mut copied = 0_usize;
            for field in &input.fields {
                let kind = field.kind.as_deref().unwrap_or("text");
                if is_sealed_kind(kind) {
                    assert_sealed_cell("fields[].value", field.value.as_deref())?;
                }
                assert_fresh_id(ctx, "fields[].field_id", &field.field_id)?;
                write_field(
                    ctx,
                    item_id,
                    &FieldWrite {
                        field_id: Some(&field.field_id),
                        section: &field.section,
                        label: &field.label,
                        kind,
                        value: field.value.as_deref(),
                        position: field.position.unwrap_or(0),
                    },
                )?;
                copied += 1;
            }

            // The addresses copy as they are — no secret is involved.
            let addresses = {
                let mut statement = ctx.connection().prepare(
                    "SELECT url FROM locker_item_address
                      WHERE item_id = ?1 ORDER BY position, id",
                )?;
                let rows = statement.query_map([source_id], |row| row.get::<_, String>(0))?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            };
            set_addresses(ctx, item_id, &addresses)?;
            // The source's TAGS come along (`tagged` edges to tags); its star
            // and archive are flags and do not. The copy is a new thing.
            ctx.connection().execute(
                "INSERT INTO edge (from_id, rel, to_id, created_at)
                 SELECT ?2, 'tagged', e.to_id, ?3
                   FROM edge e JOIN entity t ON t.id = e.to_id
                  WHERE e.from_id = ?1 AND e.rel = 'tagged' AND t.kind = 'tag'",
                rusqlite::params![source_id, item_id, ctx.now],
            )?;
            // NOT starred, NOT archived, and the alias is NOT copied: an alias
            // is unique among live items, so a copy carrying it would steal
            // the connector binding.
            Ok(serde_json::json!({
                "item_id": item_id,
                "title": title,
                "fields": copied
            }))
        },
    );
    // The five cells, and the custom fields the copy re-sealed: a nested
    // ciphertext is scrubbed out of a message like a top-level one.
    definition.sealed_input = &[
        "password",
        "otp_seed",
        "card_number",
        "cvv",
        "content",
        "fields[].value",
    ];
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
            // A COUNT runs INSIDE the vault so the answer is exact without
            // shipping every row to get it — the alternative was reading the
            // 2,000-row ceiling back just to take its length, which is what
            // makes the foot line ("300 of 312") circular.
            let one = |sql: &str| -> Result<i64> {
                Ok(ctx.connection().query_row(sql, [], |row| row.get(0))?)
            };
            // Archived is the vault's flag: a `tagged` edge to `flag:archived`.
            // Trash wins over it, as for every kind: a trashed item is counted
            // as trashed whether or not it is also archived.
            const ARCHIVED: &str = "EXISTS (SELECT 1 FROM edge a WHERE a.from_id = i.id
                    AND a.rel = 'tagged' AND a.to_id = 'flag:archived')";
            let mut statement = ctx.connection().prepare(&format!(
                "SELECT i.type, COUNT(*) FROM locker_item i JOIN entity e ON e.id = i.id
                  WHERE e.deleted_at IS NULL AND NOT {ARCHIVED}
                  GROUP BY i.type ORDER BY i.type"
            ))?;
            let by_type: Vec<serde_json::Value> = statement
                .query_map([], |row| {
                    Ok(serde_json::json!({
                        "type": row.get::<_, String>(0)?,
                        "n": row.get::<_, i64>(1)?
                    }))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(serde_json::json!({
                "live": one(&format!(
                    "SELECT COUNT(*) FROM locker_item i JOIN entity e ON e.id = i.id
                      WHERE e.deleted_at IS NULL AND NOT {ARCHIVED}"
                ))?,
                "archived": one(&format!(
                    "SELECT COUNT(*) FROM locker_item i JOIN entity e ON e.id = i.id
                      WHERE e.deleted_at IS NULL AND {ARCHIVED}"
                ))?,
                "trashed": one(
                    "SELECT COUNT(*) FROM locker_item i JOIN entity e ON e.id = i.id
                      WHERE e.deleted_at IS NOT NULL",
                )?,
                "by_type": by_type,
            }))
        },
    )
}

#[derive(serde::Deserialize)]
struct ExportLockerInput {
    include_trashed: Option<bool>,
}

pub(super) fn export() -> CommandDefinition {
    let mut definition = definition(
        "locker.export",
        r#"{
          "type": "object",
          "required": ["confirm"],
          "additionalProperties": false,
          "properties": {
            "confirm": { "type": "boolean", "const": true },
            "include_trashed": { "type": "boolean" },
            "include_history": { "type": "boolean" }
          }
        }"#,
        Idempotency::RetrySafe,
        // The gate is the schema's `const: true` plus `confirm` below, not a
        // SQL precondition: a precondition binds parameters as strings, so a
        // boolean read back through one would be theatre.
        NONE,
        NONE,
        |ctx| {
            let input: ExportLockerInput = ctx.parse_input()?;
            let include_trashed = input.include_trashed.unwrap_or(false);

            // A MASS UNSEAL IS A COMMAND AND NOT A QUERY, twice over: it is
            // confirmed and run before any cell opens. The command answers the
            // PLAIN half plus key generation addresses; the core holding `K`
            // unseals the secret cells into the exported file.
            let mut plain_by_item: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();
            let mut key_by_item: BTreeMap<String, String> = BTreeMap::new();
            {
                let mut statement = ctx.connection().prepare(
                    "SELECT item_id, field_key, value_text, key_id
                       FROM locker_item_field
                      WHERE field_key IS NOT NULL",
                )?;
                let rows = statement.query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                    ))
                })?;
                for row in rows {
                    let (item_id, field_key, value_text, key_id) = row?;
                    if let Some(value) = value_text
                        && !SEALED_ITEM_CELLS.contains(&field_key.as_str())
                    {
                        plain_by_item
                            .entry(item_id.clone())
                            .or_default()
                            .insert(field_key, value);
                    }
                    if let Some(key_id) = key_id {
                        key_by_item.entry(item_id).or_insert(key_id);
                    }
                }
            }

            let predicate = if include_trashed {
                ""
            } else {
                "WHERE e.deleted_at IS NULL"
            };
            let mut statement = ctx.connection().prepare(&format!(
                "SELECT i.id, i.type, e.title, i.compromised, i.password_set_at,
                        e.created_at, e.updated_at,
                        (SELECT a.created_at FROM edge a WHERE a.from_id = i.id
                           AND a.rel = 'tagged' AND a.to_id = 'flag:archived'),
                        e.deleted_at
                   FROM locker_item i JOIN entity e ON e.id = i.id
                 {predicate} ORDER BY e.created_at, i.id"
            ))?;
            let items: Vec<serde_json::Value> = statement
                .query_map([], |row| {
                    let item_id: String = row.get(0)?;
                    let mut item = serde_json::Map::new();
                    item.insert(
                        "item_id".to_owned(),
                        serde_json::Value::String(item_id.clone()),
                    );
                    item.insert(
                        "key_id".to_owned(),
                        key_by_item
                            .get(&item_id)
                            .cloned()
                            .map_or(serde_json::Value::Null, serde_json::Value::String),
                    );
                    let plain = plain_by_item.get(&item_id);
                    item.insert(
                        "type".to_owned(),
                        serde_json::Value::String(row.get::<_, String>(1)?),
                    );
                    item.insert(
                        "title".to_owned(),
                        serde_json::Value::String(row.get::<_, String>(2)?),
                    );
                    for field in ALL_FIELDS
                        .iter()
                        .copied()
                        .filter(|field| !SEALED_ITEM_CELLS.contains(field))
                    {
                        item.insert(
                            field.to_owned(),
                            plain
                                .and_then(|fields| fields.get(field))
                                .cloned()
                                .map_or(serde_json::Value::Null, serde_json::Value::String),
                        );
                    }
                    item.insert(
                        "compromised".to_owned(),
                        serde_json::Value::String(row.get::<_, i64>(3)?.to_string()),
                    );
                    for (index, name) in [
                        (4, "password_set_at"),
                        (5, "created_at"),
                        (6, "updated_at"),
                        (7, "archived_at"),
                        (8, "deleted_at"),
                    ] {
                        let value: Option<String> = row.get(index)?;
                        item.insert(
                            name.to_owned(),
                            value.map_or(serde_json::Value::Null, serde_json::Value::String),
                        );
                    }
                    Ok(serde_json::Value::Object(item))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;

            // AN EXPORT STAMPS NO ITEM (#1146): a file is not a use of any
            // one of them, and the Locker keeps no log of the file.
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
