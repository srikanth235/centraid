//! The follow merge engine: origin upsert, matching, scalar/child merge,
//! tombstones, absence settling, and `apply`.

use rusqlite::{Connection, OptionalExtension};
use serde_json::{Map, Value as Json};

use crate::blob;
use crate::commands::entity::{self, trash_stamp};
use crate::commands::{CommandCtx, origin_cursor};
use crate::error::{Result, VaultError};
use crate::history::Actor;

use super::commands::{SystemRow, system_row};
use super::systems::stated_title;
use super::{DOUBTED_AT_LEAST, Gone, Home, Match, OriginRow, SystemMap};

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

pub(crate) fn to_sql(value: &Json) -> rusqlite::types::Value {
    match value {
        Json::Null => rusqlite::types::Value::Null,
        Json::Bool(flag) => rusqlite::types::Value::Integer(i64::from(*flag)),
        Json::Number(number) => number.as_i64().map_or_else(
            || rusqlite::types::Value::Real(number.as_f64().unwrap_or_default()),
            rusqlite::types::Value::Integer,
        ),
        Json::String(text) => rusqlite::types::Value::Text(text.clone()),
        other => rusqlite::types::Value::Text(other.to_string()),
    }
}

/// Whether two values say the same thing: a number is a number however it was
/// spelled, and a missing value is a null.
pub(super) fn same(left: Option<&Json>, right: Option<&Json>) -> bool {
    match (left.unwrap_or(&Json::Null), right.unwrap_or(&Json::Null)) {
        (Json::Number(a), Json::Number(b)) => a.as_f64() == b.as_f64(),
        (Json::Bool(a), Json::Number(b)) | (Json::Number(b), Json::Bool(a)) => {
            b.as_i64() == Some(i64::from(*a))
        }
        (a, b) => a == b,
    }
}

/// The columns a row holds now, for the fields named, as JSON.
pub(crate) fn current(
    connection: &Connection,
    map: &SystemMap,
    id: &str,
) -> Result<Map<String, Json>> {
    let mut out = Map::new();
    let title: String =
        connection.query_row("SELECT title FROM entity WHERE id = ?1", [id], |row| {
            row.get(0)
        })?;
    out.insert("title".to_owned(), Json::String(title));
    for child in map.children {
        out.insert(child.name.to_owned(), (child.read)(connection, id)?);
    }
    if map.fields.is_empty() {
        return Ok(out);
    }
    let columns = map
        .fields
        .iter()
        .map(|field| crate::log::quoted(field))
        .collect::<Vec<_>>()
        .join(", ");
    connection.query_row(
        &format!(
            "SELECT {columns} FROM {} WHERE id = ?1",
            crate::log::quoted(map.kind.host())
        ),
        [id],
        |row| {
            for (index, field) in map.fields.iter().enumerate() {
                let value = match row.get_ref(index)? {
                    rusqlite::types::ValueRef::Null | rusqlite::types::ValueRef::Blob(_) => {
                        Json::Null
                    }
                    rusqlite::types::ValueRef::Integer(number) => Json::from(number),
                    rusqlite::types::ValueRef::Real(number) => Json::from(number),
                    rusqlite::types::ValueRef::Text(text) => {
                        Json::String(String::from_utf8_lossy(text).into_owned())
                    }
                };
                out.insert((*field).to_owned(), value);
            }
            Ok(())
        },
    )?;
    Ok(out)
}

// ---------------------------------------------------------------------------
// The origin and the source
// ---------------------------------------------------------------------------

/// An origin the vault already has: its id, its home and its label.
pub(super) struct KnownOrigin {
    pub id: String,
    pub fills: Option<String>,
    pub label: String,
}

/// The origin a pass names, if the vault has one: by the system's `ref`, else by the home the
/// input names (one home is filled by one origin, whatever ref a read gives it: a statement of
/// the same account, a calendar read again by a new phone).
pub(super) fn known_origin(
    connection: &Connection,
    system: &str,
    reference: &str,
    fills: Option<&str>,
) -> Result<Option<KnownOrigin>> {
    let read = |row: &rusqlite::Row<'_>| {
        Ok(KnownOrigin {
            id: row.get(0)?,
            fills: row.get(1)?,
            label: row.get(2)?,
        })
    };
    let by_ref = connection
        .query_row(
            "SELECT id, fills, label FROM origin
              WHERE system = ?1 AND ref = ?2",
            [system, reference],
            read,
        )
        .optional()?;
    if by_ref.is_some() {
        return Ok(by_ref);
    }
    let Some(fills) = fills else {
        return Ok(None);
    };
    Ok(connection
        .query_row(
            "SELECT id, fills, label FROM origin
              WHERE system = ?1 AND fills = ?2",
            [system, fills],
            read,
        )
        .optional()?)
}

/// Point an origin at its home: `fills` and the home's kind move together, as the table's check
/// and its key to `origin_system(code, fills_kind)` want.
fn set_home(connection: &Connection, origin: &str, home: &str) -> Result<()> {
    connection.execute(
        "UPDATE origin SET fills = ?2, fills_kind = (SELECT kind FROM entity WHERE id = ?2)
          WHERE id = ?1",
        [origin, home],
    )?;
    Ok(())
}

/// A plain home for a follow that names none: an entity of the kind the system fills, titled by
/// the origin's label, when that kind is a container (a calendar, a folder, a project). Any other
/// kind (an account) needs its own fields, so the member names it or the map founds it.
fn found_container(
    ctx: &CommandCtx<'_, '_>,
    system: &SystemRow,
    label: &str,
    color: Option<&str>,
) -> Result<Option<String>> {
    let Some(kind) = system
        .fills_kind
        .as_deref()
        .and_then(crate::model::Kind::parse)
    else {
        return Ok(None);
    };
    if !kind.is_container() {
        return Ok(None);
    }
    let id = ctx.insert_entity(kind, label)?;
    ctx.connection().execute(
        "INSERT INTO container (id, kind, color) VALUES (?1, ?2, ?3)",
        rusqlite::params![id, kind.as_str(), color],
    )?;
    Ok(Some(id))
}

fn upsert_origin(ctx: &CommandCtx<'_, '_>, map: &SystemMap) -> Result<OriginRow> {
    let connection = ctx.connection();
    let system = system_row(connection, map.system)?.ok_or_else(|| VaultError::Invariant {
        context: format!(
            "`{}` is not an origin system, and a precondition said it was",
            map.system
        ),
    })?;
    let origin = ctx.input.get("origin").cloned().unwrap_or(Json::Null);
    let text = |key: &str| origin.get(key).and_then(Json::as_str).map(str::to_owned);
    let (reference, label) = (
        text("ref").unwrap_or_default(),
        text("label").unwrap_or_default(),
    );
    let fills = text("fills");
    let config = origin
        .get("config")
        .filter(|config| !config.is_null())
        .map(Json::to_string);
    // A system that names no device (a statement) is not a phone's: no phone is named anywhere.
    let device = if system.on_device {
        text("device_id")
    } else {
        None
    };
    let known = known_origin(connection, map.system, &reference, fills.as_deref())?;
    // A RETIRED ORIGIN IS REVIVED, never made again: Stop kept its row, its home and its sources,
    // so the same `ref` followed again finds all three.
    if let Some(KnownOrigin {
        fills: Some(old_home),
        ..
    }) = &known
        && fills.as_ref().is_some_and(|named| named != old_home)
    {
        return Err(VaultError::InvalidInput {
            name: "origin.fills".to_owned(),
            detail: "that store already fills another home; stop it first".to_owned(),
        });
    }
    let label_was = known.as_ref().map(|known| known.label.clone());
    let id = if let Some(KnownOrigin { id, .. }) = known {
        connection.execute(
            // A cursor is the word of the install that wrote it: an origin another install takes
            // over (`device_id` changes) keeps none of the last one's (#1183).
            "UPDATE origin SET label = ?2,
                    config = COALESCE(?4, config),
                    cursor = CASE WHEN device_id IS ?3 THEN cursor END,
                    device_id = ?3, retired_at = NULL
              WHERE id = ?1",
            rusqlite::params![id, label, device, config],
        )?;
        if let Some(home) = &fills {
            set_home(connection, &id, home)?;
        }
        id
    } else {
        let id = ctx.next_id();
        connection.execute(
            "INSERT INTO origin (id, system, ref, label, device_id, fills, fills_kind, config, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, (SELECT kind FROM entity WHERE id = ?6), ?7, ?8)",
            rusqlite::params![
                id, map.system, reference, label, device, fills, config, ctx.now
            ],
        )?;
        id
    };
    let held = |connection: &Connection| -> Result<(Option<String>, Option<String>)> {
        Ok(connection.query_row(
            "SELECT fills, device_id FROM origin WHERE id = ?1",
            [&id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?)
    };
    let (mut fills, device) = held(connection)?;
    // The colour is a key of the palette (a lookup), or none.
    let color = origin
        .get("color")
        .and_then(Json::as_str)
        .map(str::trim)
        .filter(|color| {
            connection
                .query_row(
                    "SELECT 1 FROM vocab WHERE domain = 'palette' AND code = ?1",
                    [color],
                    |_| Ok(()),
                )
                .optional()
                .ok()
                .flatten()
                .is_some()
        });
    // A system that fills a kind of home has one, found by the map (it keeps it too: one
    // calendar of the vault per phone calendar, with the phone's colour) or, with no map to say,
    // a plain container of the kind.
    let made = if let Some(founds) = map.founds {
        Some(founds(
            ctx,
            &Home {
                origin: &id,
                fills: fills.as_deref(),
                was: label_was.as_deref(),
                label: &label,
                color,
            },
        )?)
    } else if fills.is_none() {
        found_container(ctx, &system, &label, color)?
    } else {
        None
    };
    if let Some(made) = made
        && fills.as_deref() != Some(made.as_str())
    {
        set_home(connection, &id, &made)?;
        fills = Some(made);
    }
    Ok(OriginRow { id, fills, device })
}

/// What one batch did.
#[derive(Default)]
struct Tally {
    added: usize,
    matched: usize,
    updated: usize,
    unchanged: usize,
    trashed: usize,
    forgotten: usize,
    /// Rows a returned record brought back from the trash it made.
    restored: usize,
    /// Rows a read that lost most of an origin's rows would have trashed, left alone.
    doubted: usize,
    /// Records the system's shape could not read (a time the zone skips).
    refused: usize,
}

struct Record {
    external_id: String,
    device_id: Option<String>,
    /// The size of the bytes the record names (`claims`), counted by the phone.
    size: Option<i64>,
    fields: Map<String, Json>,
}

/// A record's identity: its id at the source and the phone it is on.
type RecordKey = (String, Option<String>);

/// The records a command carries, and the ones its system could not read.
fn records_of(
    ctx: &CommandCtx<'_, '_>,
    map: &SystemMap,
    on_device: bool,
) -> Result<(Vec<Record>, Vec<RecordKey>)> {
    let (mut records, mut refused) = (Vec::new(), Vec::new());
    for raw in ctx
        .input
        .get("records")
        .and_then(Json::as_array)
        .into_iter()
        .flatten()
    {
        let mut fields = raw
            .get("fields")
            .and_then(Json::as_object)
            .cloned()
            .unwrap_or_default();
        let record = Record {
            external_id: raw
                .get("external_id")
                .and_then(Json::as_str)
                .unwrap_or_default()
                .to_owned(),
            // A record names a device only for a system that names one (a statement line is an
            // account's, never a phone's: the `source` key refuses it too).
            device_id: raw
                .get("device_id")
                .and_then(Json::as_str)
                .filter(|_| on_device)
                .map(str::to_owned),
            size: raw.get("size").and_then(Json::as_i64),
            fields: Map::new(),
        };
        if (map.shape)(ctx, &mut fields).is_err() {
            refused.push((record.external_id, record.device_id));
            continue;
        }
        // What a record may state is what the vault holds, not what a phone
        // spelled: the check follows the shape.
        if let Some(unowned) = fields.keys().find(|name| !map.states(name)) {
            return Err(VaultError::InvalidInput {
                name: format!("fields.{unowned}"),
                detail: format!("`{}` does not state `{unowned}`", map.system),
            });
        }
        records.push(Record { fields, ..record });
    }
    Ok((records, refused))
}

/// A source row as a record finds it: its id, the row it follows (none for a
/// tombstone), what it last stated, and when the follower trashed the row for
/// its record's absence.
type SourceRow = (String, Option<String>, Json, Option<String>);

fn source_of(connection: &Connection, origin: &str, record: &Record) -> Result<Option<SourceRow>> {
    Ok(connection
        .query_row(
            "SELECT id, entity_id, stated, gone_at FROM source
              WHERE origin_id = ?1 AND external_id = ?2 AND ifnull(device_id, '') = ?3",
            rusqlite::params![
                origin,
                record.external_id,
                record.device_id.as_deref().unwrap_or("")
            ],
            |row| {
                let stated: String = row.get(2)?;
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    serde_json::from_str(&stated).unwrap_or(Json::Null),
                    row.get(3)?,
                ))
            },
        )
        .optional()?)
}

/// Write the fields to a row: the title on the entity, the rest on the kind's
/// own table; then touch it.
pub(super) fn write_fields(
    ctx: &CommandCtx<'_, '_>,
    map: &SystemMap,
    id: &str,
    fields: &[(&str, &Json)],
) -> Result<()> {
    if fields.is_empty() {
        return Ok(());
    }
    let connection = ctx.connection();
    // The kind's own columns go in ONE statement: a table's CHECKs judge the row after the
    // statement, so fields that only hold together (a task's status and the date it was done,
    // its rule and its due) are never seen half-written.
    let mut columns: Vec<(&str, rusqlite::types::Value)> = Vec::new();
    for (name, value) in fields {
        if *name == "title" {
            connection.execute(
                "UPDATE entity SET title = ?2 WHERE id = ?1",
                rusqlite::params![id, value.as_str().unwrap_or_default()],
            )?;
        } else {
            columns.push((name, to_sql(value)));
        }
    }
    if !columns.is_empty() {
        let sets = columns
            .iter()
            .enumerate()
            .map(|(index, (name, _))| format!("{} = ?{}", crate::log::quoted(name), index + 2))
            .collect::<Vec<_>>()
            .join(", ");
        let mut values: Vec<rusqlite::types::Value> = vec![id.to_owned().into()];
        values.extend(columns.into_iter().map(|(_, value)| value));
        connection.execute(
            &format!(
                "UPDATE {} SET {sets} WHERE id = ?1",
                crate::log::quoted(map.kind.host())
            ),
            rusqlite::params_from_iter(values),
        )?;
    }
    (map.settle)(ctx, id)?;
    ctx.touch(id)
}

fn add(
    ctx: &CommandCtx<'_, '_>,
    map: &SystemMap,
    origin: &OriginRow,
    record: &Record,
) -> Result<String> {
    // A kind that may not be named (a reading) states no title: the row's is empty, and the
    // table says whether that is allowed.
    let title = record
        .fields
        .get("title")
        .and_then(Json::as_str)
        .unwrap_or_default();
    // The row sits in the home the origin fills when the kind may sit in a home of that kind
    // (`home_shape`: an event in a calendar, a document in a folder, a task in a project); a kind
    // the origin's home is not the home of (a line of an account) reads it in its defaults.
    let home = match origin.fills.as_deref() {
        Some(home) => ctx
            .connection()
            .query_row(
                "SELECT 1 FROM home_shape h JOIN entity e ON e.kind = h.home_kind
                  WHERE h.kind = ?1 AND e.id = ?2",
                [map.kind.as_str(), home],
                |_| Ok(()),
            )
            .optional()?
            .map(|()| home),
        None => None,
    };
    let id = ctx.insert_entity_under(map.kind, title, home)?;
    let mut columns: Vec<(&str, rusqlite::types::Value)> = record
        .fields
        .iter()
        .filter(|(name, _)| *name != "title" && map.child(name).is_none())
        .map(|(name, value)| (name.as_str(), to_sql(value)))
        .collect();
    for (column, value) in (map.defaults)(ctx.connection(), origin)? {
        if !columns.iter().any(|(given, _)| *given == column) {
            columns.push((column, value));
        }
    }
    let names = columns
        .iter()
        .map(|(name, _)| crate::log::quoted(name))
        .collect::<Vec<_>>();
    let marks = (0..columns.len())
        .map(|index| format!("?{}", index + 2))
        .collect::<Vec<_>>();
    let mut values: Vec<rusqlite::types::Value> = vec![id.clone().into()];
    values.extend(columns.into_iter().map(|(_, value)| value));
    ctx.connection().execute(
        &format!(
            "INSERT INTO {} (id{}{}) VALUES (?1{}{})",
            crate::log::quoted(map.kind.host()),
            if names.is_empty() { "" } else { ", " },
            names.join(", "),
            if marks.is_empty() { "" } else { ", " },
            marks.join(", ")
        ),
        rusqlite::params_from_iter(values),
    )?;
    (map.settle)(ctx, &id)?;
    merge_children(ctx, map, &id, None, &record.fields)?;
    (map.named)(ctx, &id)?;
    Ok(id)
}

/// Apply the children a record states to a row. Returns whether anything changed.
fn merge_children(
    ctx: &CommandCtx<'_, '_>,
    map: &SystemMap,
    id: &str,
    stated: Option<&Json>,
    fields: &Map<String, Json>,
) -> Result<bool> {
    let mut changed = false;
    for (name, new) in fields {
        let Some(child) = map.child(name) else {
            continue;
        };
        let before = stated.and_then(|stated| stated.get(name.as_str()));
        if before.is_none_or(|before| !map.agree(name, Some(before), Some(new))) {
            changed |= (child.merge)(ctx, id, before, new)?;
        }
    }
    if changed {
        ctx.touch(id)?;
    }
    Ok(changed)
}

/// The fields of a record as the source link keeps them: each child that notes something
/// ([`Child::stamp`]) carries its note. `stated` is what the link kept before (`None` for a
/// record the link is new for).
fn statement_fields(
    connection: &Connection,
    map: &SystemMap,
    stated: Option<&Json>,
    fields: &Map<String, Json>,
) -> Result<Map<String, Json>> {
    let mut out = fields.clone();
    for (name, value) in fields {
        let Some(stamp) = map.child(name).and_then(|child| child.stamp) else {
            continue;
        };
        let before = stated.and_then(|stated| stated.get(name.as_str()));
        // The same test `merge_children` makes: a child that agrees was not merged.
        let merged = before.is_none_or(|before| !map.agree(name, Some(before), Some(value)));
        out.insert(name.clone(), stamp(connection, before, value, merged)?);
    }
    Ok(out)
}

fn link(
    ctx: &CommandCtx<'_, '_>,
    map: &SystemMap,
    origin: &OriginRow,
    record: &Record,
    entity_id: &str,
) -> Result<()> {
    // The owner is nobody's record: no source ever names them.
    if entity::is_self(ctx.connection(), entity_id)? {
        return Err(VaultError::Invariant {
            context: "a source never names the vault's owner".to_owned(),
        });
    }
    let stated = Json::Object(statement_fields(
        ctx.connection(),
        map,
        None,
        &record.fields,
    )?);
    ctx.connection().execute(
        "INSERT INTO source (id, origin_id, system, external_id, device_id, entity_id, entity_kind,
                             stated, stated_title, seen_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        rusqlite::params![
            ctx.next_id(),
            origin.id,
            map.system,
            record.external_id,
            record.device_id,
            entity_id,
            map.kind.as_str(),
            stated.to_string(),
            stated_title(&stated),
            ctx.now
        ],
    )?;
    Ok(())
}

/// Claim the bytes a record names, at the size the phone counted, in this
/// command's own commit: nothing between staging and naming leaves them
/// unreferenced for a collector to take.
fn claim(ctx: &CommandCtx<'_, '_>, map: &SystemMap, record: &Record) -> Result<()> {
    let Some(hash) = map
        .claims
        .and_then(|field| record.fields.get(field))
        .and_then(Json::as_str)
    else {
        return Ok(());
    };
    if let Some(size) = record.size {
        blob::stage(ctx.connection(), hash, size)?;
    }
    Ok(())
}

/// Whether every match key of the map is stated by the record.
fn matchable(map: &SystemMap, record: &Record) -> bool {
    !map.match_on.is_empty()
        && map
            .match_on
            .iter()
            .all(|key| record.fields.contains_key(key.field()))
}

/// The first row of this kind that nothing follows and the record's match key
/// names, never the owner. A row followed only by another phone's id (a vault
/// restored onto a new phone) is not followed: its source is that phone's, and
/// the row is the new phone's to re-find. A row whose only sources belong to a RETIRED origin is
/// not followed either (a reconnected folder's new origin re-finds what the old one filled).
fn match_existing(
    connection: &Connection,
    map: &SystemMap,
    record: &Record,
) -> Result<Option<String>> {
    if !matchable(map, record) {
        return Ok(None);
    }
    let mut clauses = Vec::new();
    let mut values: Vec<rusqlite::types::Value> = vec![
        map.kind.as_str().to_owned().into(),
        record.device_id.clone().into(),
    ];
    for key in map.match_on {
        let value = to_sql(&record.fields[key.field()]);
        values.push(value);
        let at = values.len();
        clauses.push(match key {
            Match::Title => format!("e.title = ?{at} COLLATE NOCASE"),
            Match::Column(name) => format!("k.{} IS ?{at}", crate::log::quoted(name)),
            Match::Minute(name) => format!(
                "substr(k.{}, 1, 16) IS substr(?{at}, 1, 16)",
                crate::log::quoted(name)
            ),
        });
    }
    let sql = format!(
        "SELECT e.id FROM entity e JOIN {} k ON k.id = e.id
          WHERE e.kind = ?1 AND e.deleted_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM source s WHERE s.entity_id = e.id
                              AND s.origin_id IN (SELECT id FROM origin WHERE retired_at IS NULL)
                              AND (?2 IS NULL OR s.device_id IS NULL OR s.device_id = ?2))
            AND {}
          ORDER BY e.created_at, e.id",
        crate::log::quoted(map.kind.host()),
        clauses.join(" AND ")
    );
    let candidates = connection
        .prepare(&sql)?
        .query_map(rusqlite::params_from_iter(values), |row| {
            row.get::<_, String>(0)
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for id in candidates {
        if !entity::is_self(connection, &id)? {
            return Ok(Some(id));
        }
    }
    Ok(None)
}

/// Whether a record's value for a match key is the one a tombstone last stated.
fn key_agrees(key: Match, stated: Option<&Json>, now: &Json) -> bool {
    let (Some(stated), now) = (stated, now) else {
        return false;
    };
    match key {
        Match::Title => matches!(
            (stated.as_str(), now.as_str()),
            (Some(a), Some(b)) if a.to_lowercase() == b.to_lowercase()
        ),
        Match::Column(_) => same(Some(stated), Some(now)),
        Match::Minute(_) => matches!(
            (stated.as_str(), now.as_str()),
            (Some(a), Some(b)) if a.chars().take(16).eq(b.chars().take(16))
        ),
    }
}

/// The tombstone of another phone's record that this record is: a row purged
/// from the vault whose source remembers the words the first phone stated. A
/// second phone re-finds it by the same key it re-finds rows by, so a purged row
/// is not added back under the new phone's ids.
fn match_tombstone(
    connection: &Connection,
    map: &SystemMap,
    origin: &OriginRow,
    record: &Record,
) -> Result<Option<String>> {
    if !matchable(map, record) {
        return Ok(None);
    }
    let rows: Vec<(String, Json)> = connection
        .prepare(
            "SELECT id, stated FROM source
              WHERE origin_id = ?1 AND entity_id IS NULL
                AND device_id IS NOT NULL AND device_id IS NOT ?2
              ORDER BY seen_at, id",
        )?
        .query_map(rusqlite::params![origin.id, record.device_id], |row| {
            let stated: String = row.get(1)?;
            Ok((
                row.get(0)?,
                serde_json::from_str(&stated).unwrap_or(Json::Null),
            ))
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows
        .into_iter()
        .find(|(_, stated)| {
            map.match_on
                .iter()
                .all(|key| key_agrees(*key, stated.get(key.field()), &record.fields[key.field()]))
        })
        .map(|(id, _)| id))
}

/// Whether the member changed any field the source last stated of a row.
fn edited(connection: &Connection, map: &SystemMap, id: &str, stated: &Json) -> Result<bool> {
    let now = current(connection, map, id)?;
    Ok(stated
        .as_object()
        .into_iter()
        .flatten()
        .any(|(name, said)| !map.agree(name, now.get(name.as_str()), Some(said))))
}

/// A pass read a record that changes nothing about its source link. `seen_at` is when the link
/// last changed (it was made, re-pointed or re-stated), and the only readers that need more are
/// a statement's: Money's "last import" is the newest line a statement spoke of, so an import of
/// the same statement again still dates it. A phone store's pass is not an event anyone reads, so
/// an unchanged record there writes nothing (`match_tombstone` only orders by it, with the id
/// breaking ties).
fn spoke_of(ctx: &CommandCtx<'_, '_>, map: &SystemMap, source_id: &str) -> Result<()> {
    if map.system == "statement" {
        ctx.connection().execute(
            "UPDATE source SET seen_at = ?2 WHERE id = ?1",
            [source_id, &ctx.now],
        )?;
    }
    Ok(())
}

fn merge_record(
    ctx: &CommandCtx<'_, '_>,
    map: &SystemMap,
    origin: &OriginRow,
    record: &Record,
    tally: &mut Tally,
) -> Result<()> {
    let connection = ctx.connection();
    let Some((source_id, entity_id, stated, gone_at)) = source_of(connection, &origin.id, record)?
    else {
        // A record the vault has not seen: match it to a row of the member's
        // own first, then to another phone's tombstone, and only then add one.
        if let Some(id) = match_existing(connection, map, record)? {
            let held = current(connection, map, &id)?;
            // The row is the member's, so what it holds stands; a blank takes
            // the source's word.
            let blanks: Vec<(&str, &Json)> = record
                .fields
                .iter()
                .filter(|(name, value)| {
                    map.child(name).is_none()
                        && !value.is_null()
                        && held.get(name.as_str()).is_none_or(Json::is_null)
                })
                .map(|(name, value)| (name.as_str(), value))
                .collect();
            write_fields(ctx, map, &id, &blanks)?;
            merge_children(ctx, map, &id, None, &record.fields)?;
            // Another phone's source for the row is replaced by this one's.
            connection.execute("DELETE FROM source WHERE entity_id = ?1", [&id])?;
            link(ctx, map, origin, record, &id)?;
            tally.matched += 1;
        } else if let Some(tombstone) = match_tombstone(connection, map, origin, record)? {
            // The row this record is was purged: the tombstone now answers to
            // this phone's id, and the row stays purged.
            connection.execute(
                "UPDATE source SET external_id = ?2, device_id = ?3, stated = ?4, stated_title = ?5,
                        seen_at = ?6
                  WHERE id = ?1",
                rusqlite::params![
                    tombstone,
                    record.external_id,
                    record.device_id,
                    Json::Object(record.fields.clone()).to_string(),
                    record.fields.get("title").and_then(Json::as_str),
                    ctx.now
                ],
            )?;
            tally.unchanged += 1;
        } else {
            let id = add(ctx, map, origin, record)?;
            link(ctx, map, origin, record, &id)?;
            tally.added += 1;
        }
        return Ok(());
    };
    // A tombstone: the row was purged, and the source never takes another.
    let Some(entity_id) = entity_id else {
        spoke_of(ctx, map, &source_id)?;
        tally.unchanged += 1;
        return Ok(());
    };
    let held = entity::require(connection, &entity_id)?;
    if held.deleted_at.is_some() {
        // The trash this follower made for the record's absence is undone by the
        // record's return, if the member has not touched the row since. The trash
        // the member made stands, and the statement is left where it was so a
        // restore finds a row that still compares as untouched.
        if gone_at != held.deleted_at || edited(connection, map, &entity_id, &stated)? {
            spoke_of(ctx, map, &source_id)?;
            tally.unchanged += 1;
            return Ok(());
        }
        entity::restore_one(ctx, &entity_id)?;
        tally.restored += 1;
    }
    let now = current(connection, map, &entity_id)?;
    let mut writes: Vec<(&str, &Json)> = Vec::new();
    for (name, new) in record
        .fields
        .iter()
        .filter(|(name, _)| map.child(name).is_none() && !map.fixed.contains(&name.as_str()))
    {
        let mine = now.get(name.as_str());
        let theirs = stated.get(name.as_str());
        // Never edited: the vault still holds what the source last said. A field
        // the source has not stated before, over a blank, is the same case.
        let untouched = same(mine, theirs) || (theirs.is_none() && mine.is_none_or(Json::is_null));
        if untouched && !same(mine, Some(new)) {
            writes.push((name.as_str(), new));
        }
    }
    write_fields(ctx, map, &entity_id, &writes)?;
    let rows_changed = merge_children(ctx, map, &entity_id, Some(&stated), &record.fields)?;
    let mut statement = stated.as_object().cloned().unwrap_or_default();
    let fields = statement_fields(connection, map, Some(&stated), &record.fields)?;
    for (name, value) in &fields {
        // A field written once and never after keeps the source's first words:
        // a statement line's payee is the bank's, whatever a later import (its
        // rules, the member's rename) calls it.
        if map.fixed.contains(&name.as_str()) && statement.contains_key(name) {
            continue;
        }
        statement.insert(name.clone(), value.clone());
    }
    // A record that says what it said, on a link that is not marked gone, changes nothing:
    // one comparison and no write.
    let statement = Json::Object(statement);
    if statement != stated || gone_at.is_some() {
        connection.execute(
            "UPDATE source SET stated = ?2, stated_title = ?3, seen_at = ?4, gone_at = NULL
              WHERE id = ?1",
            rusqlite::params![
                source_id,
                statement.to_string(),
                stated_title(&statement),
                ctx.now
            ],
        )?;
    } else {
        spoke_of(ctx, map, &source_id)?;
    }
    if writes.is_empty() && !rows_changed {
        tally.unchanged += 1;
    } else {
        tally.updated += 1;
    }
    Ok(())
}

/// A source the read could judge: what it follows and what it last stated.
struct Followed {
    id: String,
    external_id: String,
    device_id: Option<String>,
    entity_id: Option<String>,
    stated: Json,
}

/// Whether a row is dated before the read began, so the read could not have held
/// it.
fn before_window(
    connection: &Connection,
    map: &SystemMap,
    entity_id: &str,
    since: Option<&str>,
) -> Result<bool> {
    let (Some(column), Some(since)) = (map.window, since) else {
        return Ok(false);
    };
    let dated: Option<String> = connection
        .query_row(
            &format!(
                "SELECT {} FROM {} WHERE id = ?1",
                crate::log::quoted(column),
                crate::log::quoted(map.kind.host())
            ),
            [entity_id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(dated.as_deref().is_some_and(|dated| dated < since))
}

/// A complete read that no longer holds a record: take its row away if the
/// member never touched it, and otherwise keep the row and forget the source.
/// The one guard against a read that lost most of what the origin follows lives
/// here ([`DOUBTED_AT_LEAST`]), and a tombstone whose record is gone goes too.
fn settle_absent(
    ctx: &CommandCtx<'_, '_>,
    map: &SystemMap,
    origin: &OriginRow,
    seen: &[(String, Option<String>)],
    since: Option<&str>,
    tally: &mut Tally,
) -> Result<()> {
    let connection = ctx.connection();
    let rows: Vec<Followed> = connection
        .prepare(
            "SELECT id, external_id, device_id, entity_id, stated FROM source
              WHERE origin_id = ?1",
        )?
        .query_map([&origin.id], |row| {
            let stated: String = row.get(4)?;
            Ok(Followed {
                id: row.get(0)?,
                external_id: row.get(1)?,
                device_id: row.get(2)?,
                entity_id: row.get(3)?,
                stated: serde_json::from_str(&stated).unwrap_or(Json::Null),
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    let absent = |row: &Followed| {
        !seen.iter().any(|(seen_id, seen_device)| {
            *seen_id == row.external_id
                && seen_device.as_deref().unwrap_or("") == row.device_id.as_deref().unwrap_or("")
        })
    };
    // Another phone's record is not judged lost by this phone's read.
    let other_phone = |row: &Followed| row.device_id.is_some() && row.device_id != origin.device;

    // THE ONE GUARD: how much of what this read could have held did it lose?
    if map.gone == Gone::Trash {
        let (mut followed, mut lost) = (0usize, 0usize);
        for row in &rows {
            let Some(entity_id) = &row.entity_id else {
                continue;
            };
            if other_phone(row)
                || before_window(connection, map, entity_id, since)?
                || entity::require(connection, entity_id)?.deleted_at.is_some()
            {
                continue;
            }
            followed += 1;
            lost += usize::from(absent(row));
        }
        if lost >= DOUBTED_AT_LEAST && lost * 2 > followed {
            tally.doubted = lost;
            return Ok(());
        }
    }

    for row in rows.iter().filter(|row| absent(row)) {
        let Some(entity_id) = &row.entity_id else {
            // A tombstone whose record is gone is forgotten; the table does not
            // grow with every contact the member ever purged. A record dated
            // before the read began is not one the read could have held.
            let dated = map
                .window
                .and_then(|column| row.stated.get(column))
                .and_then(Json::as_str);
            if since.is_none_or(|since| dated.is_none_or(|dated| dated >= since)) {
                connection.execute("DELETE FROM source WHERE id = ?1", [&row.id])?;
            }
            continue;
        };
        if before_window(connection, map, entity_id, since)? {
            continue;
        }
        // Another phone's record is forgotten and the row kept, for the new
        // phone to re-find; the owner is nobody's record.
        if other_phone(row) || entity::is_self(connection, entity_id)? {
            connection.execute("DELETE FROM source WHERE id = ?1", [&row.id])?;
            tally.forgotten += 1;
            continue;
        }
        // A record several stores state is not gone while another still states it: only this
        // store's link goes, and the row stays followed by the rest (A9).
        let stated_elsewhere: bool = connection.query_row(
            "SELECT EXISTS (SELECT 1 FROM source s JOIN origin o ON o.id = s.origin_id
                             WHERE s.entity_id = ?1 AND s.id <> ?2 AND s.gone_at IS NULL
                               AND o.retired_at IS NULL)",
            [entity_id, &row.id],
            |found| found.get(0),
        )?;
        if stated_elsewhere {
            connection.execute("DELETE FROM source WHERE id = ?1", [&row.id])?;
            tally.forgotten += 1;
            continue;
        }
        let held = entity::require(connection, entity_id)?;
        if map.gone == Gone::Forget || edited(connection, map, entity_id, &row.stated)? {
            connection.execute("DELETE FROM source WHERE id = ?1", [&row.id])?;
            tally.forgotten += 1;
        } else if held.deleted_at.is_none() {
            let stamp = trash_stamp(ctx)?;
            let mut trashed = Vec::new();
            entity::trash_one(ctx, entity_id, &stamp, &mut trashed)?;
            connection.execute(
                "UPDATE source SET gone_at = ?2 WHERE id = ?1",
                [&row.id, &stamp.0],
            )?;
            tally.trashed += 1;
        }
    }
    Ok(())
}

/// The records the store says were deleted (`gone`, a delta's word for what a complete read finds
/// absent): each row is kept and its source forgotten, the same end a complete read gives a record
/// of a system that keeps what the phone loses. Only this phone's: another phone's source is its own.
fn forget_gone(ctx: &CommandCtx<'_, '_>, origin: &OriginRow, tally: &mut Tally) -> Result<()> {
    let ids = ctx.input.get("gone").and_then(Json::as_array);
    for id in ids.into_iter().flatten().filter_map(Json::as_str) {
        tally.forgotten += ctx.connection().execute(
            "DELETE FROM source WHERE origin_id = ?1 AND external_id = ?2
                AND ifnull(device_id, '') = ?3 AND entity_id IS NOT NULL",
            rusqlite::params![origin.id, id, origin.device.as_deref().unwrap_or_default()],
        )?;
    }
    Ok(())
}

/// A followed home the member trashed stays trashed: a pass is not a restore, and a row the
/// store states into it now goes to the trash with it, under the home's own stamp and naming it
/// (`trashed_by`, A13), so one restore of the home brings back exactly what went with it.
fn keep_in_a_trashed_home(ctx: &CommandCtx<'_, '_>, origin: &OriginRow) -> Result<()> {
    let Some(home) = origin.fills.as_deref() else {
        return Ok(());
    };
    let connection = ctx.connection();
    let stamp: Option<(String, Option<String>)> = connection
        .query_row(
            "SELECT deleted_at, purge_at FROM entity WHERE id = ?1 AND deleted_at IS NOT NULL",
            [home],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((deleted_at, purge_at)) = stamp else {
        return Ok(());
    };
    connection.execute(
        "UPDATE entity SET deleted_at = ?3, purge_at = ?4, trashed_by = ?1
          WHERE deleted_at IS NULL AND parent_id = ?1
            AND id IN (SELECT entity_id FROM source
                        WHERE origin_id = ?2 AND entity_id IS NOT NULL)",
        rusqlite::params![home, origin.id.as_str(), deleted_at, purge_at],
    )?;
    Ok(())
}

/// Apply one batch of records from a system.
pub fn apply(ctx: &CommandCtx<'_, '_>, map: &SystemMap) -> Result<serde_json::Value> {
    let origin = upsert_origin(ctx, map)?;
    // EVERY PASS IS THE STORE'S (B4): the revisions this commit writes say `store` and name the
    // origin, said here, where the origin is known, and never read off the command's name.
    ctx.tx.set_actor(Actor::Store {
        origin_id: origin.id.clone(),
    });
    // THE STORE'S CURSOR RIDES WITH THE RECORDS IT COVERS (#1183): one commit.
    if let Some(cursor) = ctx
        .input
        .get("origin")
        .and_then(|origin| origin.get("cursor"))
        .and_then(Json::as_str)
    {
        origin_cursor::move_to(ctx.connection(), &origin.id, cursor)?;
    }
    let on_device = system_row(ctx.connection(), map.system)?.is_some_and(|row| row.on_device);
    let (records, refused) = records_of(ctx, map, on_device)?;
    let mut tally = Tally {
        refused: refused.len(),
        ..Tally::default()
    };
    // A record the system could not read is still there: its row is not absent.
    let mut seen = refused;
    seen.reserve(records.len());
    for record in &records {
        claim(ctx, map, record)?;
        merge_record(ctx, map, &origin, record, &mut tally)?;
        seen.push((record.external_id.clone(), record.device_id.clone()));
    }
    keep_in_a_trashed_home(ctx, &origin)?;
    forget_gone(ctx, &origin, &mut tally)?;
    let complete = ctx
        .input
        .get("complete")
        .and_then(Json::as_bool)
        .unwrap_or(false);
    if complete && map.gone != Gone::Keep {
        settle_absent(
            ctx,
            map,
            &origin,
            &seen,
            ctx.optional_str("since"),
            &mut tally,
        )?;
    }
    Ok(serde_json::json!({
        "origin": origin.id,
        "added": tally.added,
        "matched": tally.matched,
        "updated": tally.updated,
        "unchanged": tally.unchanged,
        "trashed": tally.trashed,
        "forgotten": tally.forgotten,
        "restored": tally.restored,
        "doubted": tally.doubted,
        "refused": tally.refused,
    }))
}
