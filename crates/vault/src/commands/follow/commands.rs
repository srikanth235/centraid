//! Follow query (`differences`) and command definitions (`follow.<map>`, `follow.stop`,
//! `follow.take_stated`, `follow.advance_cursor`).

use std::marker::PhantomData;

use rusqlite::{Connection, OptionalExtension};
use serde_json::Value as Json;

use crate::commands::{
    CommandCondition, CommandCtx, CommandDefinition, Idempotency, origin_cursor,
};
use crate::error::{Result, VaultError};

use super::merge::{current, known_origin, write_fields};
use super::{Gone, Maps, SYSTEMS, SystemMap, Systems, apply};

// ---------------------------------------------------------------------------
// What the system says that differs
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

/// A field whose held value differs from what one linked source last stated: "Phone says X".
#[derive(Debug, Clone, PartialEq)]
pub struct Difference {
    /// The origin whose source says it: an entity several stores state may differ from each of
    /// them, and each is reported on its own.
    pub origin: String,
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

/// One live source of an entity: its map, the source row, its origin and what it last stated.
pub(crate) struct Link<'m> {
    pub map: &'m SystemMap,
    pub origin: String,
    pub stated: Json,
}

/// Every live source link of an entity: the entity is live (not in the trash), the source is not
/// marked gone, its origin is not retired and a map of `maps` reads its system and kind.
/// Oldest first, so a question about "the" source of an entity with one answers the same.
pub(crate) fn live_links<'m>(
    connection: &Connection,
    maps: &'m [SystemMap],
    id: &str,
) -> Result<Vec<Link<'m>>> {
    let rows: Vec<(String, String, String, String)> = connection
        .prepare(
            "SELECT s.origin_id, s.system, s.entity_kind, s.stated
               FROM source s
               JOIN entity e ON e.id = s.entity_id
               JOIN origin o ON o.id = s.origin_id
              WHERE s.entity_id = ?1 AND s.gone_at IS NULL AND e.deleted_at IS NULL
                AND o.retired_at IS NULL
              ORDER BY s.seen_at, s.id",
        )?
        .query_map([id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows
        .into_iter()
        .filter_map(|(origin, system, kind, stated)| {
            let map = maps
                .iter()
                .find(|map| map.system == system && map.kind.as_str() == kind)?;
            Some(Link {
                map,
                origin,
                stated: serde_json::from_str(&stated).ok()?,
            })
        })
        .collect())
}

/// The fields a followed entity holds differently from what each of its sources last stated,
/// derived on each call from `source.stated` and the held rows (nothing is stored): the field is
/// "edited" exactly while the two differ, and follows again by itself once they are equal.
///
/// Only a field the source stated is reported (one it never stated has nothing to compare), and
/// only for an entity that is live with a live source link: a tombstone, a trashed row, a retired
/// origin's row and one nothing follows have no differences. A field that a system writes once and
/// never after (`fixed`) is not reported, for the source will not change it either. A series'
/// `overrides` are reported whole, not day by day.
///
/// # Errors
///
/// A database error.
pub fn differences(connection: &Connection, id: &str) -> Result<Vec<Difference>> {
    differences_in(SYSTEMS, connection, id)
}

/// [`differences`] over the maps `maps` (a lane's tests read their own).
///
/// # Errors
///
/// A database error.
pub fn differences_in(
    maps: &[SystemMap],
    connection: &Connection,
    id: &str,
) -> Result<Vec<Difference>> {
    let mut out = Vec::new();
    for link in live_links(connection, maps, id)? {
        differences_of(connection, &link, id, &mut out)?;
    }
    Ok(out)
}

fn differences_of(
    connection: &Connection,
    link: &Link<'_>,
    id: &str,
    out: &mut Vec<Difference>,
) -> Result<()> {
    let (map, stated) = (link.map, &link.stated);
    let now = current(connection, map, id)?;
    let names = std::iter::once("title")
        .chain(map.fields.iter().copied())
        .chain(map.children.iter().map(|child| child.name))
        .filter(|name| !map.fixed.contains(name));
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
                origin: link.origin.clone(),
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
            origin: link.origin.clone(),
            field: name.to_owned(),
            stated: said,
            held,
            items,
        });
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// What the file says a system is
// ---------------------------------------------------------------------------

/// A row of `origin_system`: the attributes the engine reads, never a Rust list.
pub(crate) struct SystemRow {
    pub fills_kind: Option<String>,
    pub can_retire: bool,
    pub on_device: bool,
}

pub(crate) fn system_row(connection: &Connection, system: &str) -> Result<Option<SystemRow>> {
    Ok(connection
        .query_row(
            "SELECT fills_kind, can_retire, on_device FROM origin_system WHERE code = ?1",
            [system],
            |row| {
                Ok(SystemRow {
                    fills_kind: row.get(0)?,
                    can_retire: row.get(1)?,
                    on_device: row.get(2)?,
                })
            },
        )
        .optional()?)
}

/// Whether `source_shape` says `system` yields `kind`.
pub(crate) fn yields(connection: &Connection, system: &str, kind: &str) -> Result<bool> {
    Ok(connection
        .query_row(
            "SELECT 1 FROM source_shape WHERE system = ?1 AND entity_kind = ?2",
            [system, kind],
            |_| Ok(true),
        )
        .optional()?
        .unwrap_or(false))
}

// ---------------------------------------------------------------------------
// The commands
// ---------------------------------------------------------------------------

fn map_of<M: Maps>(ctx: &CommandCtx<'_, '_>) -> Result<&'static SystemMap> {
    M::MAPS
        .iter()
        .find(|map| map.command == ctx.command)
        .ok_or_else(|| VaultError::Invariant {
            context: format!("`{}` follows no system", ctx.command),
        })
}

/// What a pass must be before it runs: it names a system the file knows, of a kind the file says
/// the system yields, with an origin whose home, device and cursor the system's row allows. Each
/// is also refused by the database (`origin`, `source`); the sentence is for the member.
fn pre_pass<M: Maps>(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let map = map_of::<M>(ctx)?;
    let connection = ctx.connection();
    let Some(system) = system_row(connection, map.system)? else {
        return Ok(Some(format!(
            "`{}` is not a store this vault follows",
            map.system
        )));
    };
    if !yields(connection, map.system, map.kind.as_str())? {
        return Ok(Some(format!(
            "`{}` does not bring in {}",
            map.system,
            map.kind.noun()
        )));
    }
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
        let hash = map
            .claims
            .and_then(|field| record.get("fields")?.get(field)?.as_str());
        if let Some(hash) = hash {
            let held: i64 = connection.query_row(
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
    if let Some(fills) = origin.get("fills").and_then(Json::as_str) {
        let Some(wanted) = &system.fills_kind else {
            return Ok(Some(format!(
                "`{}` fills nothing of the vault's",
                map.system
            )));
        };
        match crate::commands::entity::lookup(connection, fills)? {
            Err(sentence) => return Ok(Some(sentence)),
            Ok(found) if found.kind.as_str() != wanted => {
                return Ok(Some(format!(
                    "`{}` feeds a {}, not a {}",
                    map.system,
                    wanted.replace('_', " "),
                    found.kind.noun()
                )));
            }
            Ok(_) => {}
        }
    }
    // A home the engine cannot found itself (an account has fields of its own) is named once.
    if let Some(wanted) = system.fills_kind.as_deref()
        && origin.get("fills").and_then(Json::as_str).is_none()
        && map.founds.is_none()
        && !crate::model::Kind::parse(wanted).is_some_and(crate::model::Kind::is_container)
    {
        let known = known_origin(
            connection,
            map.system,
            origin.get("ref").and_then(Json::as_str).unwrap_or_default(),
            None,
        )?;
        if known.is_none_or(|known| known.fills.is_none()) {
            return Ok(Some(format!(
                "`{}` is imported into a {}: say which",
                map.system,
                wanted.replace('_', " ")
            )));
        }
    }
    if origin.get("cursor").is_some()
        && (!system.on_device
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

fn follow<M: Maps>(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    apply(ctx, map_of::<M>(ctx)?)
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
          "description": "The colour the phone paints the store with, as a key of the palette." },
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
      "description": "The source ids the store says were deleted since the cursor (a delta's, in place of a complete read): the row is kept and its source forgotten. Only for a map whose gone rows are kept." }
  }
}"#;

/// The input schema every pass command takes, for a lane that builds its own definition.
#[must_use]
pub const fn pass_schema() -> &'static str {
    SCHEMA
}

const STOP_SCHEMA: &str = r#"{
  "type": "object",
  "required": ["system", "ref"],
  "additionalProperties": false,
  "properties": {
    "system": { "type": "string", "minLength": 1 },
    "ref": { "type": "string", "minLength": 1 }
  }
}"#;

/// A system whose follow cannot end is refused with a sentence: `origin_system.can_retire` says
/// so, and so does the `origin` table (`retired_at` is keyed to it).
fn pre_stop(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let system = ctx.required_str("system")?;
    Ok(match system_row(ctx.connection(), system)? {
        None => Some(format!("`{system}` is not a store this vault follows")),
        Some(row) if !row.can_retire => Some(format!(
            "following `{system}` has no end to stop: it is an account's, not a phone store"
        )),
        Some(_) => None,
    })
}

#[derive(serde::Deserialize)]
struct StopFollowInput {
    system: String,
    #[serde(rename = "ref")]
    reference: String,
}

/// Stop following one origin: it is RETIRED, not deleted. **Every row stays** and is the member's own
/// from now on (nothing is trashed, and a followed row's "Phone says" lines go), and the origin keeps
/// its home (`fills`) and its sources, so following the same `ref` again finds both: no second
/// calendar, folder or project, and no record added twice. Its cursor goes, so a followed-again
/// store starts with a complete read. Stopping what is not followed (never followed, or already
/// retired) is nothing. A reconnected folder's NEW origin finds the rows the retired one filled by
/// the record's match key, as it finds any row nothing follows, and takes their sources over.
fn stop(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let input: StopFollowInput = ctx.parse_input()?;
    let connection = ctx.connection();
    let stopped = connection.execute(
        "UPDATE origin SET retired_at = ?3, cursor = NULL
          WHERE system = ?1 AND ref = ?2 AND retired_at IS NULL",
        rusqlite::params![input.system, input.reference, ctx.now],
    )?;
    Ok(serde_json::json!({ "stopped": stopped > 0 }))
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
      "description": "For a field made of items, the one item to take (a key `follow::differences` reports); leave out for the whole field." },
    "origin": { "type": "string", "minLength": 1,
      "description": "Which store's word to take, when more than one states the field (the `origin` `follow::differences` reports)." }
  }
}"#;

/// The links of `id` that state `field` and may be taken from, given the origin the caller named.
fn takeable<'m>(
    maps: &'m [SystemMap],
    connection: &Connection,
    id: &str,
    field: &str,
    origin: Option<&str>,
) -> Result<Vec<Link<'m>>> {
    Ok(live_links(connection, maps, id)?
        .into_iter()
        .filter(|link| {
            link.map.states(field)
                && !link.map.fixed.contains(&field)
                && link.stated.get(field).is_some()
                && origin.is_none_or(|origin| link.origin == origin)
        })
        .collect())
}

fn pre_take<M: Maps>(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let (id, field) = (ctx.required_str("entity")?, ctx.required_str("field")?);
    let connection = ctx.connection();
    let links = takeable(M::MAPS, connection, id, field, ctx.optional_str("origin"))?;
    let link = match links.as_slice() {
        [] => {
            return Ok(Some(if live_links(connection, M::MAPS, id)?.is_empty() {
                "that is not following anything on the phone, so there is nothing to take"
                    .to_owned()
            } else {
                format!("the phone has never said what its {field} should be")
            }));
        }
        [link] => link,
        _ => {
            return Ok(Some(format!(
                "more than one store states its {field}; say which one to take"
            )));
        }
    };
    let (map, stated) = (link.map, &link.stated);
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
    if map.claims == Some(field) {
        let held: i64 = connection.query_row(
            "SELECT COUNT(*) FROM blob WHERE hash = ?1",
            [stated[field].as_str().unwrap_or_default()],
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

#[derive(serde::Deserialize)]
struct TakeStatedInput {
    entity: String,
    field: String,
    item_key: Option<String>,
    origin: Option<String>,
}

/// Take what a source last stated for a field the member changed: the held field (or one held
/// item) becomes the stated value through the same writes the merge makes, as an ordinary edit
/// **by the member** (the member chose it; it is not the store's pass). The field then agrees
/// with the statement again, so it is no longer reported and the next pass treats it as untouched.
/// A field that already agrees is left alone.
fn take_stated<M: Maps>(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let input: TakeStatedInput = ctx.parse_input()?;
    let id = input.entity.as_str();
    let field = input.field.as_str();
    let connection = ctx.connection();
    let links = takeable(M::MAPS, connection, id, field, input.origin.as_deref())?;
    let [link] = links.as_slice() else {
        return Err(VaultError::Invariant {
            context: "a take names one live source link".to_owned(),
        });
    };
    let (map, said) = (
        link.map,
        link.stated.get(field).cloned().unwrap_or(Json::Null),
    );
    let changed = if let Some(child) = map.child(field) {
        let changed = (child.take)(ctx, id, input.item_key.as_deref(), &said)?;
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

/// `follow.advance_cursor` must name a phone's store: the file says which systems name a device.
fn pre_advance(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let system = ctx.required_str("system")?;
    Ok(match system_row(ctx.connection(), system)? {
        None => Some(format!("`{system}` is not a store this vault follows")),
        Some(row) if !row.on_device => {
            Some("a cursor is a phone store's, with the install that read it".to_owned())
        }
        Some(_) => None,
    })
}

/// The conditions of one set of maps, as constants a definition may borrow.
struct Conditions<M>(PhantomData<M>);

impl<M: Maps> Conditions<M> {
    const PASS: &'static [CommandCondition] = &[CommandCondition {
        predicate: "pass_is_of_a_system_and_kind_the_file_yields",
        check: pre_pass::<M>,
    }];
    const TAKE: &'static [CommandCondition] = &[CommandCondition {
        predicate: "field_is_one_a_store_stated_of_a_followed_row",
        check: pre_take::<M>,
    }];
}

const STOP_CONDITIONS: &[CommandCondition] = &[CommandCondition {
    predicate: "system_is_one_whose_follow_can_end",
    check: pre_stop,
}];

const ADVANCE_CONDITIONS: &[CommandCondition] = &[CommandCondition {
    predicate: "system_names_a_device",
    check: pre_advance,
}];

/// The follow commands of the product: one pass per map of [`SYSTEMS`], and the shared three.
#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    definitions_for::<Systems>()
}

/// The follow commands of a set of maps: what a lane's tests register beside the product's
/// shared verbs to prove a map of their own.
#[must_use]
pub fn definitions_for<M: Maps>() -> Vec<CommandDefinition> {
    let mut definitions: Vec<CommandDefinition> = M::MAPS
        .iter()
        .map(|map| {
            CommandDefinition::plain(
                map.command,
                "follow",
                SCHEMA,
                Idempotency::Idempotent,
                Conditions::<M>::PASS,
                follow::<M>,
            )
        })
        .collect();
    definitions.push(CommandDefinition::plain(
        "follow.stop",
        "follow",
        STOP_SCHEMA,
        Idempotency::Idempotent,
        STOP_CONDITIONS,
        stop,
    ));
    definitions.push(CommandDefinition::plain(
        "follow.take_stated",
        "follow",
        TAKE_SCHEMA,
        Idempotency::Idempotent,
        Conditions::<M>::TAKE,
        take_stated::<M>,
    ));
    // Where a read of a phone store got to, moved with no record riding along (#1183).
    definitions.push(CommandDefinition::plain(
        "follow.advance_cursor",
        "follow",
        origin_cursor::SCHEMA,
        Idempotency::Idempotent,
        ADVANCE_CONDITIONS,
        origin_cursor::advance_cursor,
    ));
    definitions
}
