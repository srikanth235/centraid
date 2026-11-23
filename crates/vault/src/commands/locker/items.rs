//! Item lifecycle commands: `locker.add_item`, `locker.edit_item`, `locker.duplicate_item`,
//! `locker.counts`, and `locker.export`.

use crate::commands::{CommandCondition, CommandDefinition, Idempotency, Risk, arrival};
use crate::error::Result;
use crate::model::Kind;

use super::custody::{
    ADD_ITEM_PRE, DUPLICATE_ITEM_PRE, EDIT_ITEM_PRE, ITEM_EXISTS_SQL, NONE, assert_fresh_id,
    assert_key_generation, assert_sealed_cell, assert_sealed_cells, carries_secret, invalid,
    password_rotated,
};
use super::schema::{
    SEALED_ITEM_CELLS, SEALED_PLACEHOLDER, field_schema, field_values, is_sealed_kind, type_enum,
};
use super::sidecars::{FieldWrite, mint_template_fields, set_addresses, set_alias, write_field};
use super::{count, definition, item_type_of};

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
            let item_id = ctx.required_str("item_id")?.to_owned();
            let item_type = ctx.required_str("type")?.to_owned();
            let title = ctx.required_str("title")?.to_owned();
            assert_fresh_id(ctx, "item_id", &item_id)?;
            assert_sealed_cells(ctx, &SEALED_ITEM_CELLS)?;
            let secret = carries_secret(ctx, &SEALED_ITEM_CELLS);
            assert_key_generation(ctx, secret)?;
            let key_id = ctx.optional_str("key_id").map(str::to_owned);

            let values = field_values(ctx, &item_type);
            let password = values
                .iter()
                .find(|(column, _)| *column == "password")
                .and_then(|(_, value)| value.clone());

            // Only the type's own columns are written; everything else stays
            // NULL, so a member who filled a login and switched to Wi-Fi never
            // stores the login's fields.
            // THE ENTITY FIRST, under the caller's id (D-1020-L9): the kind row
            // joins it by `(id, kind)`, and the title, the stamps and the trash
            // window are the entity's, like every kind's.
            ctx.insert_entity_as(&item_id, Kind::LockerItem, &title)?;
            let mut columns: Vec<&str> = vec!["id", "type"];
            let mut binds: Vec<Box<dyn rusqlite::ToSql>> =
                vec![Box::new(item_id.clone()), Box::new(item_type.clone())];
            for (column, value) in &values {
                columns.push(column);
                binds.push(Box::new(value.clone()));
            }
            columns.push("compromised");
            binds.push(Box::new(i64::from(
                ctx.input
                    .get("compromised")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false),
            )));
            // PASSWORD AGE IS SET-TIME, NEVER `updated_at`: a retag must not
            // make a three-year-old password look fresh (GAPS §3.3 #6d).
            columns.push("password_set_at");
            binds.push(Box::new(password.as_ref().map(|_| ctx.now.clone())));
            columns.push("key_id");
            binds.push(Box::new(key_id));

            let placeholders: Vec<String> = (1..=columns.len())
                .map(|index| format!("?{index}"))
                .collect();
            let sql = format!(
                "INSERT INTO locker_item ({}) VALUES ({})",
                columns.join(", "),
                placeholders.join(", ")
            );
            let params: Vec<&dyn rusqlite::ToSql> =
                binds.iter().map(std::convert::AsRef::as_ref).collect();
            ctx.connection().execute(&sql, params.as_slice())?;

            if let Some(alias) = ctx.optional_str("alias") {
                set_alias(ctx, &item_id, alias)?;
            }
            // A type is a set of sections and fields: the nine expansion types
            // arrive as EMPTY template rows the member fills in, which is also
            // what lets an unknown type degrade to a note that still carries
            // them. Empty needs no key, so a vault with no `K` can still make
            // a passport item and list it.
            let minted = mint_template_fields(ctx, &item_id, &item_type)?;
            arrival::record(ctx, &item_id, Kind::LockerItem)?;
            Ok(serde_json::json!({ "item_id": item_id, "template_fields": minted }))
        },
    );
    definition.sealed_input = &SEALED_ITEM_CELLS;
    definition
}

pub(super) fn edit_item() -> CommandDefinition {
    let mut definition = definition(
        "locker.edit_item",
        concat!(
            r#"{
          "type": "object",
          "description": "REPLACES, does not patch. Every field of the item's type (username, url, password, one-time-code seed, notes, and the rest of its type's columns) is rewritten from this input, and each one the input leaves out or leaves empty is CLEARED: an edit carrying only a password erases the username, address, seed and notes. Send the whole draft; a sealed secret you are keeping goes as the placeholder «sealed». Only the title, the alias (an empty one clears it) and the compromised flag (a changed password clears it) are left alone when omitted. Tags, the star and the archive are the vault's own (`tag.add`, `flag.set`); custom fields, addresses, the passkey and the memo are their own commands. None is touched here.",
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
            let item_id = ctx.required_str("item_id")?.to_owned();
            let item_type = item_type_of(ctx, &item_id)?;
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

            if let Some(title) = ctx.optional_str("title") {
                ctx.connection().execute(
                    "UPDATE entity SET title = ?2 WHERE id = ?1",
                    [item_id.as_str(), title],
                )?;
            }
            // THE COMPROMISED FLAG (#1047, R-1047-F7): the member's, set and
            // cleared by hand — nothing produces it automatically. A ROTATION
            // CLEARS IT, because the fix Review asks for ("change the
            // password") has been made; a write that states the flag itself
            // wins over that rule, since the member said so in the same breath.
            let stated = ctx
                .input
                .get("compromised")
                .and_then(serde_json::Value::as_bool);
            if let Some(compromised) = stated.or_else(|| rotated.then_some(false)) {
                push(
                    &mut sets,
                    &mut binds,
                    "compromised",
                    Box::new(i64::from(compromised)),
                );
            }

            // EDIT REPLACES THE TYPE'S FIELDS; IT DOES NOT PATCH THEM, AND SAYS SO
            // (L4, ruled 2026-10-15).
            //
            // `field_values` returns **every** column of the item's type,
            // `None` for the ones the input omits, and the handler writes all
            // of them. So an edit carrying only a password clears the
            // username, the url, the OTP seed and the notes.
            //
            // It is the contract and not an accident: the editor always sends
            // the whole draft (every key the type owns, a sealed one
            // round-tripped as the placeholder), so a replace is invisible to
            // it. A caller reading the optional fields as a patch API loses
            // data, which is why the semantics are stated where callers read:
            // this command's schema (`describe` serves it), the manifest's
            // `edit-item` description, the editor's proto comment and the
            // Locker README. A patch, if it is ever wanted, is a new command
            // and a proposal (#1047), not a quiet change to this one. The
            // title, the alias and the compromised flag are the
            // exceptions: omitted, they are left alone.
            // `an_edit_rewrites_the_types_fields_rather_than_patching_them`
            // pins it.
            //
            // A round-tripped placeholder is the one exception to the
            // clearing and is SKIPPED: that is what "leave this secret alone"
            // means, and it is the mechanism that lets an edit form exist
            // without holding the password.
            let mut changed: Vec<&str> = Vec::new();
            for (column, value) in field_values(ctx, &item_type) {
                if ctx.optional_str(column) == Some(SEALED_PLACEHOLDER) {
                    continue;
                }
                push(&mut sets, &mut binds, column, Box::new(value.clone()));
                changed.push(column);
            }
            // A ROTATION, distinguished from any other edit. The core says so
            // (see `password_rotated`); only a real change re-stamps the age.
            if rotated {
                let stamp = ctx
                    .optional_str("password")
                    .filter(|value| !value.is_empty())
                    .map(|_| ctx.now.clone());
                push(&mut sets, &mut binds, "password_set_at", Box::new(stamp));
            }
            if secret {
                let key_id = ctx.optional_str("key_id").map(str::to_owned);
                push(&mut sets, &mut binds, "key_id", Box::new(key_id));
            }

            if !sets.is_empty() {
                binds.push(Box::new(item_id.clone()));
                let sql = format!(
                    "UPDATE locker_item SET {} WHERE id = ?{}",
                    sets.join(", "),
                    binds.len()
                );
                let params: Vec<&dyn rusqlite::ToSql> =
                    binds.iter().map(std::convert::AsRef::as_ref).collect();
                ctx.connection().execute(&sql, params.as_slice())?;
            }
            ctx.touch(&item_id)?;

            if let Some(alias) = ctx.optional_str("alias") {
                // An EMPTY alias clears the binding, which is the paper cut
                // README-Locker §8 names: a member could set one and never
                // take it back.
                set_alias(ctx, &item_id, alias)?;
            }
            crate::commands::entity::with_rev(
                ctx,
                &item_id,
                serde_json::json!({
                    "item_id": item_id,
                    "rotated": rotated,
                    "columns": changed
                }),
            )
        },
    );
    definition.sealed_input = &SEALED_ITEM_CELLS;
    definition
}

/// Every column a duplicate copies verbatim, minus the sealed ones.
const PLAIN_COPY_COLUMNS: [&str; 13] = [
    "type",
    "username",
    "url",
    "notes",
    "cardholder",
    "expiry",
    "brand",
    "fullname",
    "email",
    "phone",
    "address",
    "network",
    "compromised",
];

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
            let source_id = ctx.required_str("item_id")?.to_owned();
            let item_id = ctx.required_str("new_item_id")?.to_owned();
            assert_fresh_id(ctx, "new_item_id", &item_id)?;
            assert_sealed_cells(ctx, &SEALED_ITEM_CELLS)?;
            let secret = carries_secret(ctx, &SEALED_ITEM_CELLS);
            assert_key_generation(ctx, secret)?;

            // CLONE-AND-EDIT FOR SIBLING ACCOUNTS (GAPS §3.3 #10), and the one
            // v0 rule that could not survive the custody change: v0 unsealed
            // each secret here and wrote it back as plaintext for the seal
            // sweep to re-seal under the NEW row's id, "so no secret
            // round-trips through the client". The ciphertext's AAD binds it to
            // the old row, and the command plane cannot re-seal — so the core
            // re-encrypts under the new id and sends the cells, which is why
            // the new id is the caller's (D-1020-L9). The promise that changes
            // is "no secret round-trips through the client"; the promise that
            // survives, and is the stronger one, is that no secret is ever
            // readable by the command plane or anything it writes.
            let mut columns: Vec<String> = vec!["id".to_owned()];
            let source_title: String = ctx.connection().query_row(
                "SELECT title FROM entity WHERE id = ?1",
                [&source_id],
                |row| row.get(0),
            )?;
            let title = format!("{source_title} copy");
            ctx.insert_entity_as(&item_id, Kind::LockerItem, &title)?;
            let mut binds: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(item_id.clone())];
            for column in PLAIN_COPY_COLUMNS {
                // AS A VALUE, NOT AS A STRING. `compromised` is an INTEGER and
                // `NOT NULL`; reading it into an `Option<String>` fails, and a
                // `.ok().flatten()` around that failure turns the flag into a
                // NULL the column's own constraint then refuses. Found by
                // `a_duplicate_takes_the_re_sealed_cells_and_leaves_the_alias_behind`.
                let value: rusqlite::types::Value = ctx.connection().query_row(
                    &format!("SELECT {column} FROM locker_item WHERE id = ?1"),
                    [&source_id],
                    |row| row.get(0),
                )?;
                columns.push(column.to_owned());
                binds.push(Box::new(value));
            }
            for column in SEALED_ITEM_CELLS {
                let value = ctx
                    .optional_str(column)
                    .filter(|value| !value.is_empty() && *value != SEALED_PLACEHOLDER)
                    .map(str::to_owned);
                columns.push(column.to_owned());
                binds.push(Box::new(value));
            }
            let password_set_at: Option<String> = ctx.connection().query_row(
                "SELECT password_set_at FROM locker_item WHERE id = ?1",
                [&source_id],
                |row| row.get(0),
            )?;
            columns.push("password_set_at".to_owned());
            binds.push(Box::new(password_set_at));
            columns.push("key_id".to_owned());
            binds.push(Box::new(ctx.optional_str("key_id").map(str::to_owned)));

            let placeholders: Vec<String> = (1..=columns.len())
                .map(|index| format!("?{index}"))
                .collect();
            let params: Vec<&dyn rusqlite::ToSql> =
                binds.iter().map(std::convert::AsRef::as_ref).collect();
            ctx.connection().execute(
                &format!(
                    "INSERT INTO locker_item ({}) VALUES ({})",
                    columns.join(", "),
                    placeholders.join(", ")
                ),
                params.as_slice(),
            )?;

            // The custom fields, re-sealed by the core against their own new
            // ids for the same AAD reason.
            let mut copied = 0_usize;
            if let Some(fields) = ctx
                .input
                .get("fields")
                .and_then(serde_json::Value::as_array)
            {
                for field in fields {
                    let field_id = field
                        .get("field_id")
                        .and_then(serde_json::Value::as_str)
                        .ok_or_else(|| invalid("fields", "every field names a `field_id`"))?;
                    let kind = field
                        .get("kind")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("text");
                    let value = field.get("value").and_then(serde_json::Value::as_str);
                    if is_sealed_kind(kind) {
                        assert_sealed_cell("fields[].value", value)?;
                    }
                    assert_fresh_id(ctx, "fields[].field_id", field_id)?;
                    write_field(
                        ctx,
                        &item_id,
                        &FieldWrite {
                            field_id: Some(field_id),
                            section: field
                                .get("section")
                                .and_then(serde_json::Value::as_str)
                                .unwrap_or(""),
                            label: field
                                .get("label")
                                .and_then(serde_json::Value::as_str)
                                .unwrap_or_default(),
                            kind,
                            value,
                            position: field
                                .get("position")
                                .and_then(serde_json::Value::as_i64)
                                .unwrap_or(0),
                        },
                    )?;
                    copied += 1;
                }
            }

            // The addresses copy as they are — no secret is involved.
            let addresses = {
                let mut statement = ctx.connection().prepare(
                    "SELECT url FROM locker_item_address
                      WHERE item_id = ?1 ORDER BY position, id",
                )?;
                let rows = statement.query_map([&source_id], |row| row.get::<_, String>(0))?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            };
            set_addresses(ctx, &item_id, &addresses)?;
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

/// The plain columns an export carries verbatim.
const PLAIN_EXPORT_COLUMNS: [&str; 19] = [
    "type",
    "title",
    "username",
    "url",
    "notes",
    "cardholder",
    "expiry",
    "brand",
    "fullname",
    "email",
    "phone",
    "address",
    "network",
    "compromised",
    "password_set_at",
    "created_at",
    "updated_at",
    "archived_at",
    "deleted_at",
];

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
            let include_trashed = ctx
                .input
                .get("include_trashed")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);

            // A MASS UNSEAL IS A COMMAND AND NOT A QUERY, twice over, and both
            // reasons survive the custody change: it is confirmed and run
            // before any cell opens, so a core that opened them first would
            // have skipped the member's confirmation. Ordinary app reads return
            // sealed columns as placeholders.
            //
            // WHAT CHANGED (D-1020-L7): v0 unsealed every cell here and
            // returned the plaintext. The command plane cannot, so the command
            // answers the PLAIN half plus the ciphertext's addresses, and a
            // core holding `K` produces the file. The confirm and
            // the `high` risk stay exactly where they were, because what is
            // being authorised is unchanged: every secret the locker holds,
            // in the clear, in a file.
            // The title, the stamps and the trash window are the entity's; the
            // archive is the vault's flag, stated as the day it was set.
            let projection = PLAIN_EXPORT_COLUMNS
                .iter()
                .map(|column| match *column {
                    "title" | "created_at" | "updated_at" | "deleted_at" => format!("e.{column}"),
                    "archived_at" => "(SELECT a.created_at FROM edge a WHERE a.from_id = i.id
                          AND a.rel = 'tagged' AND a.to_id = 'flag:archived')"
                        .to_owned(),
                    other => format!("i.{other}"),
                })
                .collect::<Vec<_>>()
                .join(", ");
            let predicate = if include_trashed {
                ""
            } else {
                "WHERE e.deleted_at IS NULL"
            };
            let mut statement = ctx.connection().prepare(&format!(
                "SELECT i.id, i.key_id, {projection}
                   FROM locker_item i JOIN entity e ON e.id = i.id
                 {predicate} ORDER BY e.created_at, i.id"
            ))?;
            let items: Vec<serde_json::Value> = statement
                .query_map([], |row| {
                    let mut item = serde_json::Map::new();
                    item.insert(
                        "item_id".to_owned(),
                        serde_json::Value::String(row.get::<_, String>(0)?),
                    );
                    item.insert(
                        "key_id".to_owned(),
                        row.get::<_, Option<String>>(1)?
                            .map_or(serde_json::Value::Null, serde_json::Value::String),
                    );
                    for (index, column) in PLAIN_EXPORT_COLUMNS.iter().enumerate() {
                        let value: Option<String> =
                            row.get::<_, Option<String>>(index + 2).or_else(|_| {
                                row.get::<_, Option<i64>>(index + 2)
                                    .map(|value| value.map(|value| value.to_string()))
                            })?;
                        item.insert(
                            (*column).to_owned(),
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
                // A REVISION'S SNAPSHOT IS THE ONE THING ONLY AN EXPORT
                // UNSEALS, and it stays that way: the unsealing is outside
                // the command plane, in the phone core holding `K`, after
                // this command ran. There is no field saying where: one
                // device, one side that can unseal (Q-1047-13).
            }))
        },
    );
    definition.risk = Risk::High;
    definition.confirm = true;
    definition
}
