//! Follow query (`differences`) and command definitions (`follow.*`, `follow.stop`, `follow.take_stated`).

use rusqlite::{Connection, OptionalExtension};
use serde_json::Value as Json;

use crate::commands::{
    CommandCondition, CommandCtx, CommandDefinition, Idempotency, origin_cursor,
};
use crate::error::{Result, VaultError};

use super::merge::{current, write_fields};
use super::{Gone, OriginOf, SYSTEMS, SystemMap, apply};

// ---------------------------------------------------------------------------
// What the phone says that differs
// ---------------------------------------------------------------------------

/// One item of a multi-valued field where the vault and the source disagree.
#[derive(Debug, Clone, PartialEq)]
pub struct ItemDifference {
    /// The key that names the item across statements: `kind:reach-key` for a contact point,
    /// the email (else `name:<name>`) for a guest, the column for a workout measure.
    pub key: String,
    /// The item as the source states it; `None` when the source never stated it (the member
    /// added it).
    pub stated: Option<Json>,
    /// The item as the vault holds it; `None` when the vault no longer holds it.
    pub held: Option<Json>,
}

/// A field whose held value differs from what the linked source last stated.
#[derive(Debug, Clone, PartialEq)]
pub struct Difference {
    /// The field's stable name: `title`, a column of the kind's own row (`birthday`,
    /// `starts`, ...), or a child (`points`, `attendees`, `overrides`, `workout`).
    pub field: String,
    /// The value the source last stated (a child in its canonical form).
    pub stated: Json,
    /// The value the vault holds.
    pub held: Json,
    /// For a field made of items, those that differ, in key order; empty for a field judged
    /// whole.
    pub items: Vec<ItemDifference>,
}

/// The system a `follow.<system>` pass command is for, `None` for any other command: what the
/// history reads to say a change came from a phone's store and not from the member.
pub(crate) fn system_of(command: &str) -> Option<&'static str> {
    SYSTEMS
        .iter()
        .find(|map| map.command == command)
        .map(|map| map.system)
}

/// The system and statement of the live source link of an entity: the entity is live (not in the
/// trash), its source link is still there, and it names a system the vault follows.
pub(crate) fn live_link(
    connection: &Connection,
    id: &str,
) -> Result<Option<(&'static SystemMap, Json)>> {
    let row: Option<(String, String)> = connection
        .query_row(
            "SELECT s.system, s.stated FROM source s JOIN entity e ON e.id = s.entity_id
              WHERE s.entity_id = ?1 AND s.gone_at IS NULL AND e.deleted_at IS NULL
                AND s.origin_id IN (SELECT id FROM origin WHERE retired_at IS NULL)
              LIMIT 1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    Ok(row.and_then(|(system, stated)| {
        let map = SYSTEMS.iter().find(|map| map.system == system)?;
        Some((map, serde_json::from_str(&stated).ok()?))
    }))
}

/// The fields a followed entity holds differently from what its source last stated, derived on
/// each call from `source.stated` and the held rows (nothing is stored): the field is "edited"
/// exactly while the two differ, and follows again by itself once they are equal.
///
/// Only a field the source stated is reported (one it never stated has nothing to compare), and
/// only for an entity that is live with a live source link: a tombstone, a trashed row and one
/// nothing follows have no differences. A field that a system writes
/// once and never after (`fixed`) is not reported, for the source will not change it either.
/// A series' `overrides` are reported whole, not day by day: a day's change is not a thing the
/// screens name one at a time.
///
/// # Errors
///
/// A database error.
pub fn differences(connection: &Connection, id: &str) -> Result<Vec<Difference>> {
    let Some((map, stated)) = live_link(connection, id)? else {
        return Ok(Vec::new());
    };
    let now = current(connection, map, id)?;
    let names = std::iter::once("title")
        .chain(map.fields.iter().copied())
        .chain(map.children.iter().map(|child| child.name))
        .filter(|name| !map.fixed.contains(name));
    let mut out = Vec::new();
    for name in names {
        let Some(said) = stated.get(name) else {
            continue;
        };
        let held = now.get(name);
        if map.agree(name, held, Some(said)) {
            continue;
        }
        let Some(child) = map.child(name) else {
            out.push(Difference {
                field: name.to_owned(),
                stated: said.clone(),
                held: held.cloned().unwrap_or(Json::Null),
                items: Vec::new(),
            });
            continue;
        };
        let (said, held) = (
            (child.canon)(said),
            (child.canon)(held.unwrap_or(&Json::Null)),
        );
        let items = child.items.map_or_else(Vec::new, |items| {
            let (stated_items, held_items) = (items(&said), items(&held));
            stated_items
                .keys()
                .chain(held_items.keys())
                .collect::<std::collections::BTreeSet<_>>()
                .into_iter()
                .filter(|key| stated_items.get(*key) != held_items.get(*key))
                .map(|key| ItemDifference {
                    key: key.clone(),
                    stated: stated_items.get(key).cloned(),
                    held: held_items.get(key).cloned(),
                })
                .collect()
        });
        out.push(Difference {
            field: name.to_owned(),
            stated: said,
            held,
            items,
        });
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// The commands
// ---------------------------------------------------------------------------

fn map_of(ctx: &CommandCtx<'_, '_>) -> Result<&'static SystemMap> {
    SYSTEMS
        .iter()
        .find(|map| map.command == ctx.command)
        .ok_or_else(|| VaultError::Invariant {
            context: format!("`{}` follows no system", ctx.command),
        })
}

fn pre_records(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let records = ctx.input.get("records").and_then(Json::as_array);
    for record in records.into_iter().flatten() {
        let id = record
            .get("external_id")
            .and_then(Json::as_str)
            .unwrap_or_default();
        if id.trim().is_empty() {
            return Ok(Some("every record needs an id from its source".to_owned()));
        }
        // Bytes a record names are claimed by this command: they must be held
        // already or come with the size the phone counted.
        let hash = map_of(ctx)?
            .claims
            .and_then(|field| record.get("fields")?.get(field)?.as_str());
        if let Some(hash) = hash {
            let held: i64 = ctx.connection().query_row(
                "SELECT COUNT(*) FROM blob WHERE hash = ?1",
                [hash],
                |row| row.get(0),
            )?;
            let sized = record.get("size").is_some_and(|size| !size.is_null());
            if held == 0 && !sized {
                return Ok(Some(
                    "those bytes have not been counted; say how large they are".to_owned(),
                ));
            }
        }
    }
    let origin = ctx.input.get("origin").cloned().unwrap_or(Json::Null);
    for key in ["ref", "label"] {
        if origin
            .get(key)
            .and_then(Json::as_str)
            .is_none_or(|text| text.trim().is_empty())
        {
            return Ok(Some(format!("the origin needs a `{key}`")));
        }
    }
    let map = map_of(ctx)?;
    if origin.get("cursor").is_some()
        && (map.origin != OriginOf::Phone
            || origin
                .get("device_id")
                .and_then(Json::as_str)
                .is_none_or(|device| device.trim().is_empty()))
    {
        return Ok(Some(
            "a cursor is a phone store's, with the install that read it".to_owned(),
        ));
    }
    if ctx.input.get("gone").is_some() && map.gone != Gone::Forget {
        return Ok(Some(format!(
            "`{}` forgets no deleted record: its rows follow a complete read",
            map.system
        )));
    }
    Ok(None)
}

fn follow(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    apply(ctx, map_of(ctx)?)
}

const SCHEMA: &str = r#"{
  "type": "object",
  "required": ["origin", "records"],
  "additionalProperties": false,
  "properties": {
    "origin": {
      "type": "object",
      "required": ["ref", "label"],
      "additionalProperties": false,
      "properties": {
        "ref": { "type": "string" },
        "label": { "type": "string" },
        "device_id": { "type": ["string", "null"] },
        "fills": { "type": ["string", "null"] },
        "color": { "type": ["string", "null"], "maxLength": 64,
          "description": "The colour the phone paints the store with, as the design wheel names it." },
        "config": { "type": ["object", "null"] },
        "cursor": { "type": "string", "minLength": 1, "maxLength": 4096,
          "description": "Where this read of the store got to: it moves in this commit, as the install named by device_id read it (a phone store's, never an account's)." }
      }
    },
    "records": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["external_id", "fields"],
        "additionalProperties": false,
        "properties": {
          "external_id": { "type": "string" },
          "device_id": { "type": ["string", "null"] },
          "size": { "type": ["integer", "null"], "minimum": 0,
            "description": "How large the bytes a record names are, counted by the phone; the command claims them." },
          "fields": { "type": "object" }
        }
      }
    },
    "complete": { "type": "boolean" },
    "since": { "type": "string" },
    "gone": { "type": "array", "items": { "type": "string" },
      "description": "The source ids the store says were deleted since the cursor (a delta's, in place of a complete read): the row is kept and its source forgotten. Only for a system whose gone rows are kept." }
  }
}"#;

const STOP_SCHEMA: &str = r#"{
  "type": "object",
  "required": ["system", "ref"],
  "additionalProperties": false,
  "properties": {
    "system": { "type": "string", "enum": ["contacts", "calendar", "files", "health", "statement", "phone_reminders"] },
    "ref": { "type": "string", "minLength": 1 }
  }
}"#;

fn pre_stop(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    Ok((ctx.required_str("system")? == "statement").then(|| {
        "a statement is an account's, not a phone store; there is nothing to stop following"
            .to_owned()
    }))
}

/// Stop following one origin: it is RETIRED, not deleted. **Every row stays** and is the member's own
/// from now on (nothing is trashed, and a followed row's "Phone says" lines go), and the origin keeps
/// its home (`fills`) and its sources, so following the same `ref` again finds both: no second
/// calendar, folder or project, and no record added twice. Its cursor goes, so a followed-again
/// store starts with a complete read. Stopping what is not followed (never followed, or already
/// retired) is nothing. A reconnected folder's NEW origin finds the rows the retired one filled by
/// the record's match key, as it finds any row nothing follows, and takes their sources over.
fn stop(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let (system, reference) = (ctx.required_str("system")?, ctx.required_str("ref")?);
    let connection = ctx.connection();
    let origin: Option<String> = connection
        .query_row(
            "SELECT id FROM origin WHERE system = ?1 AND ref = ?2 AND retired_at IS NULL",
            [system, reference],
            |row| row.get(0),
        )
        .optional()?;
    let Some(origin) = origin else {
        return Ok(serde_json::json!({ "stopped": false, "forgotten": 0 }));
    };
    connection.execute(
        "UPDATE origin SET retired_at = ?2, cursor = NULL
          WHERE id = ?1",
        rusqlite::params![origin, ctx.now],
    )?;
    Ok(serde_json::json!({ "stopped": true, "forgotten": 0 }))
}

const TAKE_SCHEMA: &str = r#"{
  "type": "object",
  "required": ["entity", "field"],
  "additionalProperties": false,
  "properties": {
    "entity": { "type": "string", "minLength": 1 },
    "field": { "type": "string", "minLength": 1,
      "description": "A name `follow::differences` reports: `title`, a column, or a child such as `points`." },
    "item_key": { "type": "string", "minLength": 1,
      "description": "For a field made of items, the one item to take (a key `follow::differences` reports); leave out for the whole field." }
  }
}"#;

fn pre_take(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let (id, field) = (ctx.required_str("entity")?, ctx.required_str("field")?);
    let connection = ctx.connection();
    let Some((map, stated)) = live_link(connection, id)? else {
        return Ok(Some(
            "that is not following anything on the phone, so there is nothing to take".to_owned(),
        ));
    };
    if !map.states(field) || map.fixed.contains(&field) || stated.get(field).is_none() {
        return Ok(Some(format!(
            "the phone has never said what its {field} should be"
        )));
    }
    if let Some(item) = ctx.optional_str("item_key") {
        let Some(items) = map.child(field).and_then(|child| child.items) else {
            return Ok(Some(format!(
                "the {field} is taken as a whole, not item by item"
            )));
        };
        let child = map.child(field).ok_or_else(|| VaultError::Invariant {
            context: "a field with items is a child".to_owned(),
        })?;
        let held = (child.read)(connection, id)?;
        let known = |value: &Json| items(&(child.canon)(value)).contains_key(item);
        if !known(&held) && !known(&stated[field]) {
            return Ok(Some(format!("there is no `{item}` in the {field}")));
        }
    }
    if field == "blob" {
        let held: i64 = connection.query_row(
            "SELECT COUNT(*) FROM blob WHERE hash = ?1",
            [stated["blob"].as_str().unwrap_or_default()],
            |row| row.get(0),
        )?;
        if held == 0 {
            return Ok(Some(
                "the file the phone last stated is no longer held".to_owned(),
            ));
        }
    }
    Ok(None)
}

/// Take what the source last stated for a field the member changed: the held field (or one held
/// item) becomes the stated value through the same writes the merge makes, as an ordinary edit. The
/// field then agrees with the statement again, so it is no longer reported and the next pass
/// treats it as untouched. A field that already agrees is left alone.
fn take_stated(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let (id, field) = (ctx.required_str("entity")?, ctx.required_str("field")?);
    let connection = ctx.connection();
    let (map, stated) = live_link(connection, id)?.ok_or_else(|| VaultError::Invariant {
        context: "a take names a live source link".to_owned(),
    })?;
    let said = stated.get(field).cloned().unwrap_or(Json::Null);
    let changed = if let Some(child) = map.child(field) {
        let changed = (child.take)(ctx, id, ctx.optional_str("item_key"), &said)?;
        if changed {
            ctx.touch(id)?;
        }
        changed
    } else if map.agree(field, current(connection, map, id)?.get(field), Some(&said)) {
        false
    } else {
        write_fields(ctx, map, id, &[(field, &said)])?;
        true
    };
    Ok(serde_json::json!({ "id": id, "field": field, "changed": changed }))
}

#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    let mut definitions: Vec<CommandDefinition> = SYSTEMS
        .iter()
        .map(|map| {
            CommandDefinition::plain(
                map.command,
                "follow",
                SCHEMA,
                Idempotency::Idempotent,
                &[CommandCondition {
                    predicate: "records_say_where_they_came_from",
                    check: pre_records,
                }],
                follow,
            )
        })
        .collect();
    definitions.push(CommandDefinition::plain(
        "follow.stop",
        "follow",
        STOP_SCHEMA,
        Idempotency::Idempotent,
        &[CommandCondition {
            predicate: "system_is_a_phone_store",
            check: pre_stop,
        }],
        stop,
    ));
    definitions.push(CommandDefinition::plain(
        "follow.take_stated",
        "follow",
        TAKE_SCHEMA,
        Idempotency::Idempotent,
        &[CommandCondition {
            predicate: "field_is_one_the_phone_stated_of_a_followed_row",
            check: pre_take,
        }],
        take_stated,
    ));
    // Where a read of a phone store got to, moved with no record riding along (#1183).
    definitions.push(CommandDefinition::plain(
        "follow.advance_cursor",
        "follow",
        origin_cursor::SCHEMA,
        Idempotency::Idempotent,
        &[],
        origin_cursor::advance_cursor,
    ));
    definitions
}
