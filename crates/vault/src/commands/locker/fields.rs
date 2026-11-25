//! An item's fields: one uniform row per value (#1214, I2 to I5, I7).
//!
//! A field is built-in (a stable `field_key` of its item's type: [`super::schema`]) or custom (a
//! label and a kind, no key). Whatever it is, the database holds only its shape by `kind`, so the
//! rules of THIS file are the ones a sentence can say; the file refuses the same breaches
//! (`tests/schema_rules.rs`).
//!
//! **A write is planned, then made.** [`plan`] turns one input field and the row it names into
//! either a sentence or a [`Plan`]; the preconditions run it to refuse in the member's words, and
//! the handler runs it again to write what it planned, so the two cannot disagree.
//!
//! What follows from sealing, and is all Locker adds to an ordinary app's field:
//! - a sealed, one-time-code or file field's value arrives as `lk1:` ciphertext under the live key
//!   generation, bound to the field's id, or as the placeholder that leaves it alone;
//! - the vault cannot compare two ciphertexts, so a write that replaces a secret on an existing
//!   field says whether the value CHANGED (`changed`), and only a change moves `value_set_at`;
//! - a file's bytes are `lkf1` ciphertext in the blob store before the field names them
//!   (`blob`), and the file's name and media type are the sealed `value`.

use rusqlite::OptionalExtension;

use crate::commands::{CommandCtx, CommandDefinition, Idempotency};
use crate::custody::locker_key::is_locker_ciphertext;
use crate::custody::sealed_file;
use crate::error::Result;

use super::custody::{
    NONE, assert_fresh_id, assert_key_generation, assert_sealed_cell, assert_well_formed_id,
    invalid, sentence_of,
};
use super::schema::{
    FIELD_KINDS, SEALED_PLACEHOLDER, built_in, field_id_of, is_month_key, is_sealed_kind,
    normalise_date, position_of,
};
use super::{count, definition};

/// The most a plain value may weigh. A tunable budget, so it is the command's and not a CHECK.
pub const PLAIN_VALUE_BUDGET_BYTES: usize = 16 * 1024;

/// The most a sealed value (its ciphertext) may weigh.
pub const SEALED_VALUE_BUDGET_BYTES: usize = 128 * 1024;

/// One field as a command is given it.
#[derive(Debug, Clone, Default, serde::Deserialize)]
pub(super) struct FieldIn {
    /// The row's id. A single-instance built-in field's is derived (`<item>:<key>`); a sealed
    /// custom field's is the caller's, because its ciphertext is bound to it.
    pub field_id: Option<String>,
    /// A built-in field's stable key. Absent: a custom field.
    pub field_key: Option<String>,
    pub section: Option<String>,
    pub label: Option<String>,
    pub kind: Option<String>,
    /// Absent: leave the value. Empty: clear it. The placeholder: leave the secret alone.
    pub value: Option<String>,
    /// A `file` field's `lkf1` bytes, already in the content store.
    pub blob: Option<String>,
    pub position: Option<f64>,
    /// The generation the sealed value was sealed under.
    pub key_id: Option<String>,
    /// Whether the secret's value changed (a re-seal of the same secret says `false`).
    pub changed: Option<bool>,
}

/// The JSON schema of one field, spelled once for every command that takes fields.
macro_rules! field_schema {
    () => {
        r#"{
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "field_id": { "type": "string", "minLength": 1, "maxLength": 96 },
            "field_key": { "type": "string", "minLength": 1, "maxLength": 64 },
            "section": { "type": "string", "maxLength": 200 },
            "label": { "type": "string", "maxLength": 200 },
            "kind": { "type": "string", "enum": ["text", "sealed", "url", "date", "otp", "file"] },
            "value": { "type": "string" },
            "blob": { "type": "string", "minLength": 64, "maxLength": 64 },
            "position": { "type": "number" },
            "key_id": { "type": "string", "minLength": 1 },
            "changed": { "type": "boolean" }
          }
        }"#
    };
}
pub(super) use field_schema;

/// The row a field writes to, as it is now.
#[derive(Debug, Clone)]
struct Existing {
    field_key: Option<String>,
    section: String,
    label: String,
    kind: String,
    value_text: Option<String>,
    value_sealed: Option<String>,
    value_blob: Option<String>,
    key_id: Option<String>,
    value_set_at: Option<String>,
    position: f64,
    created_at: String,
}

/// What a planned write does to the field's row.
#[derive(Debug, Clone)]
pub(super) enum Write {
    /// Take the row away (an empty built-in or sealed field holds no row).
    Delete,
    /// Make the row this.
    Row {
        value_text: Option<String>,
        value_sealed: Option<String>,
        value_blob: Option<String>,
        key_id: Option<String>,
        value_set_at: Option<String>,
    },
}

/// One field write, fully decided.
#[derive(Debug, Clone)]
pub(super) struct Plan {
    /// `None` for a new plain field whose id the handler mints.
    pub id: Option<String>,
    pub field_key: Option<String>,
    pub single: bool,
    pub claimed: bool,
    pub section: String,
    pub label: String,
    pub kind: String,
    pub position: f64,
    created_at: Option<String>,
    pub write: Write,
}

fn existing_of(ctx: &CommandCtx<'_, '_>, item_id: &str, id: &str) -> Result<Option<Existing>> {
    Ok(ctx
        .connection()
        .query_row(
            "SELECT field_key, section, label, kind, value_text, value_sealed, value_blob, key_id,
                    value_set_at, position, created_at
               FROM locker_item_field WHERE id = ?1 AND item_id = ?2",
            [id, item_id],
            |row| {
                Ok(Existing {
                    field_key: row.get(0)?,
                    section: row.get(1)?,
                    label: row.get(2)?,
                    kind: row.get(3)?,
                    value_text: row.get(4)?,
                    value_sealed: row.get(5)?,
                    value_blob: row.get(6)?,
                    key_id: row.get(7)?,
                    value_set_at: row.get(8)?,
                    position: row.get(9)?,
                    created_at: row.get(10)?,
                })
            },
        )
        .optional()?)
}

fn id_is_free(ctx: &CommandCtx<'_, '_>, id: &str) -> Result<std::result::Result<(), String>> {
    Ok(assert_fresh_id(ctx, "field_id", id)
        .err()
        .map_or(Ok(()), |error| Err(sentence_of(error))))
}

/// Whether `hash` is `lkf1` bytes the content store holds, and the sentence when it is not.
fn file_refusal(ctx: &CommandCtx<'_, '_>, hash: &str) -> Result<Option<String>> {
    let Some(store) = ctx.blobs() else {
        return Ok(Some(
            "this vault has nowhere to keep a file's bytes".to_owned(),
        ));
    };
    if !crate::blob::is_hash(hash) || !store.has(hash).unwrap_or(false) {
        return Ok(Some("those bytes are not in this vault's store".to_owned()));
    }
    let size = store.size(hash).unwrap_or(0);
    let mut head = [0_u8; sealed_file::HEADER_BYTES];
    let read = store
        .path_of(hash)
        .ok()
        .flatten()
        .and_then(|path| std::fs::File::open(path).ok())
        .and_then(|mut file| std::io::Read::read_exact(&mut file, &mut head).ok());
    if read.is_none() || !sealed_file::is_shaped_like_one(&head, size) {
        return Ok(Some(
            "a file is kept sealed: those bytes are not a file sealed under the Locker key"
                .to_owned(),
        ));
    }
    Ok(None)
}

/// Decide one field write. `Ok(Err(sentence))` is a refusal in the member's words.
#[allow(clippy::too_many_lines)]
pub(super) fn plan(
    ctx: &CommandCtx<'_, '_>,
    item_id: &str,
    item_type: &str,
    input: &FieldIn,
) -> Result<std::result::Result<Plan, String>> {
    macro_rules! refuse {
        ($($arg:tt)*) => { return Ok(Err(format!($($arg)*))) };
    }
    if let Some(id) = input.field_id.as_deref()
        && let Err(error) = assert_well_formed_id("field_id", id)
    {
        refuse!("{}", sentence_of(error));
    }

    // What the field IS: a built-in's stable shape, or a custom field's own.
    let built = match input.field_key.as_deref() {
        Some(key) => match built_in(item_type, key) {
            Some(field) => Some(field),
            None => refuse!("`{key}` is not one of the fields of a {item_type}"),
        },
        None => None,
    };
    let mut id = input.field_id.clone();
    if let Some(field) = built
        && field.single
    {
        let fixed = field_id_of(item_id, field.key);
        if id.as_deref().is_some_and(|given| given != fixed) {
            refuse!("the id of the item's {} is `{fixed}`", field.label);
        }
        id = Some(fixed);
    }
    let found = match id.as_deref() {
        Some(id) => existing_of(ctx, item_id, id)?,
        None => None,
    };
    // A custom write naming a built-in row by its id is a write to that built-in.
    let built = built.or_else(|| {
        found
            .as_ref()
            .and_then(|row| row.field_key.as_deref())
            .and_then(|key| built_in(item_type, key))
    });

    let kind = match (&found, built) {
        (Some(row), _) => row.kind.clone(),
        (None, Some(field)) => field.kind.to_owned(),
        (None, None) => match input.kind.as_deref() {
            Some(kind) if FIELD_KINDS.contains(&kind) => kind.to_owned(),
            Some(kind) => refuse!("`{kind}` is not a kind of field"),
            None => refuse!("a field needs a kind: text, sealed, url, date, one-time code or file"),
        },
    };
    if input.kind.as_deref().is_some_and(|given| given != kind) {
        refuse!("a field's kind cannot change: take it away and add another");
    }
    let sealed = is_sealed_kind(&kind);
    let label = input
        .label
        .as_deref()
        .map(str::trim)
        .map(str::to_owned)
        .or_else(|| found.as_ref().map(|row| row.label.clone()))
        .or_else(|| built.map(|field| field.label.to_owned()))
        .unwrap_or_default();
    if label.is_empty() {
        refuse!("a field needs a label");
    }
    let section = input
        .section
        .clone()
        .or_else(|| found.as_ref().map(|row| row.section.clone()))
        .or_else(|| built.map(|field| field.section.to_owned()))
        .unwrap_or_default();
    let position = input
        .position
        .or_else(|| found.as_ref().map(|row| row.position))
        .or_else(|| built.map(|field| position_of(item_type, field.key)))
        .unwrap_or(0.0);
    let single = built.is_some_and(|field| field.single);
    let claimed = built.is_some_and(|field| field.claimed);
    let field_key = built.map(|field| field.key.to_owned());

    // A new field's id.
    if found.is_none() {
        match id.as_deref() {
            Some(new) => {
                // A single built-in's derived id is free by construction (no row has it); a
                // caller's own must be fresh across every table a value is sealed against.
                if !single && let Err(sentence) = id_is_free(ctx, new)? {
                    refuse!("{sentence}");
                }
            }
            None if sealed => refuse!(
                "a new sealed field must carry the id it was sealed against, because the \
                 ciphertext's additional data binds it to that id"
            ),
            None => {}
        }
    }

    let carries_new_secret = sealed
        && input
            .value
            .as_deref()
            .is_some_and(|value| !value.is_empty() && value != SEALED_PLACEHOLDER);
    let mut plan = Plan {
        id,
        field_key,
        single,
        claimed,
        section,
        label,
        kind: kind.clone(),
        position,
        created_at: found.as_ref().map(|row| row.created_at.clone()),
        write: Write::Delete,
    };

    if input.blob.is_some() && kind != "file" {
        refuse!("only a file field names stored bytes");
    }

    if sealed {
        let value = input.value.as_deref();
        if let Err(error) = assert_sealed_cell("value", value) {
            refuse!("{}", sentence_of(error));
        }
        match value {
            // Clear: a sealed field holds no empty row.
            Some("") => {
                if input.blob.is_some() {
                    refuse!("a file cleared takes no new bytes");
                }
                plan.write = Write::Delete;
                return Ok(Ok(plan));
            }
            // Leave alone (or only the metadata changes).
            None | Some(SEALED_PLACEHOLDER) => {
                let Some(row) = &found else {
                    refuse!(
                        "there is no saved {} to keep; type it, or leave it empty",
                        plan.label
                    );
                };
                if input.blob.is_some() {
                    refuse!("new bytes for a file come with its new sealed name");
                }
                plan.write = Write::Row {
                    value_text: None,
                    value_sealed: row.value_sealed.clone(),
                    value_blob: row.value_blob.clone(),
                    key_id: row.key_id.clone(),
                    value_set_at: row.value_set_at.clone(),
                };
                return Ok(Ok(plan));
            }
            Some(cipher) => {
                if cipher.len() > SEALED_VALUE_BUDGET_BYTES {
                    refuse!(
                        "that value is over the {SEALED_VALUE_BUDGET_BYTES}-byte budget for a sealed field"
                    );
                }
                if let Err(error) =
                    assert_key_generation(input.key_id.as_deref(), carries_new_secret, ctx)
                {
                    refuse!("{}", sentence_of(error));
                }
                let blob = if kind == "file" {
                    match (input.blob.as_deref(), &found) {
                        (Some(hash), _) => {
                            if let Some(sentence) = file_refusal(ctx, hash)? {
                                refuse!("{sentence}");
                            }
                            Some(hash.to_owned())
                        }
                        // A renamed file keeps its bytes.
                        (None, Some(row)) if row.value_blob.is_some() => row.value_blob.clone(),
                        (None, _) => refuse!("a file field needs its sealed bytes"),
                    }
                } else {
                    None
                };
                let replaced_bytes =
                    blob.is_some() && found.as_ref().is_some_and(|row| row.value_blob != blob);
                let set_at = match &found {
                    None => ctx.now.clone(),
                    Some(row) => match input.changed {
                        None => refuse!(
                            "say whether the {} changed: the vault cannot compare two sealed \
                             values, and only a real change moves the date it was last set",
                            plan.label
                        ),
                        Some(true) => ctx.now.clone(),
                        Some(false) if replaced_bytes => {
                            refuse!("a file with new bytes is a changed file: say so")
                        }
                        Some(false) => row.value_set_at.clone().unwrap_or_else(|| ctx.now.clone()),
                    },
                };
                plan.write = Write::Row {
                    value_text: None,
                    value_sealed: Some(cipher.to_owned()),
                    value_blob: blob,
                    key_id: input.key_id.clone(),
                    value_set_at: Some(set_at),
                };
                return Ok(Ok(plan));
            }
        }
    }

    // A plain field: text, a url or a date.
    let value = match input.value.as_deref() {
        None => found.as_ref().and_then(|row| row.value_text.clone()),
        Some(text) => {
            let text = text.trim();
            (!text.is_empty()).then(|| text.to_owned())
        }
    };
    let Some(mut value) = value else {
        // Nothing to hold: a built-in field keeps no empty row; a custom one is the member's own
        // label and stays.
        plan.write = if built.is_some() {
            Write::Delete
        } else {
            Write::Row {
                value_text: None,
                value_sealed: None,
                value_blob: None,
                key_id: None,
                value_set_at: None,
            }
        };
        return Ok(Ok(plan));
    };
    if value.len() > PLAIN_VALUE_BUDGET_BYTES {
        refuse!("that value is over the {PLAIN_VALUE_BUDGET_BYTES}-byte budget for a field");
    }
    if is_locker_ciphertext(&value) {
        refuse!("a plain field never holds a sealed value: put a secret in a sealed field");
    }
    if kind == "date" {
        let wanted = if is_month_key(item_type, plan.field_key.as_deref().unwrap_or("")) {
            normalise_date(&value)
        } else {
            let valid: bool =
                ctx.connection()
                    .query_row("SELECT date(?1) IS ?1", [&value], |row| row.get(0))?;
            valid.then(|| value.clone())
        };
        match wanted {
            Some(date) => value = date,
            None => refuse!(
                "“{value}” is not a date; write it as 2027-08-31{}",
                if is_month_key(item_type, plan.field_key.as_deref().unwrap_or("")) {
                    " or 08/27"
                } else {
                    ""
                }
            ),
        }
    }
    if claimed {
        let well_formed = !value.is_empty()
            && value.len() <= 64
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'));
        if !well_formed {
            refuse!("an alias is 1 to 64 letters, digits, `.`, `_` or `-`");
        }
        let taken: bool = ctx.connection().query_row(
            "SELECT EXISTS (SELECT 1 FROM locker_item_field
              WHERE claimed = 1 AND value_text = ?1 COLLATE NOCASE AND id IS NOT ?2)",
            rusqlite::params![value, plan.id],
            |row| row.get(0),
        )?;
        if taken {
            refuse!("the alias \"{value}\" is already used by another item");
        }
    }
    plan.write = Write::Row {
        value_text: Some(value),
        value_sealed: None,
        value_blob: None,
        key_id: None,
        value_set_at: None,
    };
    Ok(Ok(plan))
}

/// Make a planned write. The first half of every field write the handlers share.
pub(super) fn apply(ctx: &CommandCtx<'_, '_>, item_id: &str, planned: &Plan) -> Result<String> {
    let id = planned.id.clone().unwrap_or_else(|| ctx.next_id());
    match &planned.write {
        Write::Delete => {
            ctx.connection().execute(
                "DELETE FROM locker_item_field WHERE id = ?1 AND item_id = ?2",
                [id.as_str(), item_id],
            )?;
        }
        Write::Row {
            value_text,
            value_sealed,
            value_blob,
            key_id,
            value_set_at,
        } => {
            if let Some(hash) = value_blob {
                let size = ctx
                    .blobs()
                    .and_then(|store| store.size(hash).ok())
                    .unwrap_or(0);
                crate::blob::stage(
                    ctx.connection(),
                    hash,
                    i64::try_from(size).unwrap_or(i64::MAX),
                )?;
            }
            ctx.connection().execute(
                "INSERT INTO locker_item_field
                   (id, item_id, field_key, single, claimed, section, label, kind, value_text,
                    value_sealed, value_blob, key_id, value_set_at, position, created_at,
                    updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
                 ON CONFLICT(id) DO UPDATE SET
                   section = excluded.section,
                   label = excluded.label,
                   value_text = excluded.value_text,
                   value_sealed = excluded.value_sealed,
                   value_blob = excluded.value_blob,
                   key_id = excluded.key_id,
                   value_set_at = excluded.value_set_at,
                   position = excluded.position,
                   updated_at = excluded.updated_at",
                rusqlite::params![
                    id,
                    item_id,
                    planned.field_key,
                    planned.single,
                    planned.claimed,
                    planned.section,
                    planned.label,
                    planned.kind,
                    value_text,
                    value_sealed,
                    value_blob,
                    key_id,
                    value_set_at,
                    planned.position,
                    planned
                        .created_at
                        .clone()
                        .unwrap_or_else(|| ctx.now.clone()),
                    ctx.now,
                ],
            )?;
        }
    }
    Ok(id)
}

/// The sentence the first refused field of a batch says, if any.
pub(super) fn refusal_of(
    ctx: &CommandCtx<'_, '_>,
    item_id: &str,
    item_type: &str,
    fields: &[FieldIn],
) -> Result<Option<String>> {
    for field in fields {
        if let Err(sentence) = plan(ctx, item_id, item_type, field)? {
            return Ok(Some(sentence));
        }
    }
    Ok(None)
}

/// Plan and make every field of a batch, in order; returns the ids written.
pub(super) fn write_all(
    ctx: &CommandCtx<'_, '_>,
    item_id: &str,
    item_type: &str,
    fields: &[FieldIn],
) -> Result<Vec<String>> {
    let mut ids = Vec::with_capacity(fields.len());
    for field in fields {
        let planned = plan(ctx, item_id, item_type, field)?
            .map_err(|sentence| invalid("fields", sentence))?;
        ids.push(apply(ctx, item_id, &planned)?);
    }
    Ok(ids)
}

// ---------------------------------------------------------------------------
// locker.set_field and locker.remove_field
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize)]
struct SetFieldInput {
    item_id: String,
    #[serde(flatten)]
    field: FieldIn,
}

fn type_of(ctx: &CommandCtx<'_, '_>, item_id: &str) -> Result<String> {
    super::item_type_of(ctx, item_id)
}

pub(super) fn set_field() -> CommandDefinition {
    static PRE: &[crate::commands::CommandCondition] = &[
        super::custody::ITEM_LIVE_CHECK,
        crate::commands::CommandCondition {
            predicate: "field_is_well_formed_and_sealed_when_secret",
            check: |ctx| {
                let input: SetFieldInput = ctx.parse_input()?;
                let item_type = type_of(ctx, &input.item_id)?;
                refusal_of(
                    ctx,
                    &input.item_id,
                    &item_type,
                    std::slice::from_ref(&input.field),
                )
            },
        },
    ];
    let mut definition = definition(
        "locker.set_field",
        r#"{
          "type": "object",
          "required": ["item_id"],
          "additionalProperties": false,
          "properties": {
            "item_id": { "type": "string", "minLength": 1 },
            "field_id": { "type": "string", "minLength": 1, "maxLength": 96 },
            "field_key": { "type": "string", "minLength": 1, "maxLength": 64 },
            "section": { "type": "string", "maxLength": 200 },
            "label": { "type": "string", "maxLength": 200 },
            "kind": { "type": "string", "enum": ["text", "sealed", "url", "date", "otp", "file"] },
            "value": { "type": "string" },
            "blob": { "type": "string", "minLength": 64, "maxLength": 64 },
            "position": { "type": "number" },
            "key_id": { "type": "string", "minLength": 1 },
            "changed": { "type": "boolean" }
          }
        }"#,
        Idempotency::Idempotent,
        PRE,
        NONE,
        |ctx| {
            let input: SetFieldInput = ctx.parse_input()?;
            let item_type = type_of(ctx, &input.item_id)?;
            let ids = write_all(ctx, &input.item_id, &item_type, &[input.field])?;
            ctx.touch(&input.item_id)?;
            Ok(serde_json::json!({ "item_id": input.item_id, "field_id": ids[0] }))
        },
    );
    definition.sealed_input = &["value"];
    definition
}

#[derive(serde::Deserialize)]
struct RemoveFieldInput {
    item_id: String,
    field_id: String,
}

pub(super) fn remove_field() -> CommandDefinition {
    static PRE: &[crate::commands::CommandCondition] = &[
        super::custody::ITEM_LIVE_CHECK,
        crate::commands::CommandCondition {
            predicate: "field_is_the_items_own",
            check: |ctx| {
                let found = count(
                    ctx,
                    "SELECT COUNT(*) FROM locker_item_field WHERE id = ?1 AND item_id = ?2",
                    &[ctx.required_str("field_id")?, ctx.required_str("item_id")?],
                )?;
                Ok((found != 1).then(|| "that is not one of this item's fields".to_owned()))
            },
        },
    ];
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
        PRE,
        NONE,
        |ctx| {
            let input: RemoveFieldInput = ctx.parse_input()?;
            ctx.connection().execute(
                "DELETE FROM locker_item_field WHERE id = ?1 AND item_id = ?2",
                [&input.field_id, &input.item_id],
            )?;
            ctx.touch(&input.item_id)?;
            Ok(serde_json::json!({ "field_id": input.field_id, "item_id": input.item_id }))
        },
    )
}
