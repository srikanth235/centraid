//! Following: a store the phone owns (its contacts, a calendar, a folder of
//! files, the health store) or a statement a member imports, kept in step with
//! the vault without ever overwriting what the member did.
//!
//! **The merge is the vault's, in this one module**
//! ([#1135](https://github.com/srikanth235/centraid/issues/1135)). The
//! follower on the phone reads a store and sends records (an external id, an
//! origin, the fields the system owns) through one command per system,
//! `follow.<system>`. For each field the system owns:
//!
//! - if the vault's value equals what the source last **stated**, the member
//!   never changed it and the new value is written;
//! - if it differs, the member's value stands;
//!
//! and then `source.stated` becomes the new statement. A record that is new is
//! **matched** first, by the system's match key (a name; a title and a start; a
//! file name; a workout kind and its start) against rows nothing follows yet,
//! and only then added. A record gone from a *complete* read trashes its row if
//! the member never edited it, and otherwise forgets the source and keeps the
//! row (R-FP-3); a statement line is never removed. There is no fingerprint and
//! no detach.
//!
//! **A system's map is data** ([`SystemMap`]): which kind it fills, which
//! scalar columns it owns, what a new row needs that no record states, whether
//! a record's absence may take its row away. The engine knows no system by
//! name. The maps below carry the scalar columns of each system's kind row; the
//! rows that hang off them (a contact's points, an event's attendees, a
//! workout's measures) are added by the lane that owns the kind.

use rusqlite::{Connection, OptionalExtension};
use serde_json::{Map, Value as Json};

use crate::commands::contact_point;
use crate::commands::entity::{self, trash_stamp};
use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency};
use crate::error::{Result, VaultError};
use crate::model::{DEFAULT_CALENDAR_ID, Kind};

/// The origin a batch of records came from, as a map's defaults see it.
pub struct OriginRow {
    pub id: String,
    /// The calendar, folder or account this origin feeds.
    pub fills: Option<String>,
    /// The phone that last read it.
    pub device: Option<String>,
}

/// What a new row needs that no record states, given its origin.
pub type Defaults =
    fn(&Connection, &OriginRow) -> Result<Vec<(&'static str, rusqlite::types::Value)>>;

/// A field that is not a column but rows that hang off the one it fills (a
/// contact's points), kept by the module that owns them. A record states it as
/// one JSON value like any other field; the vault reads it back the same way,
/// and merges it with the member's changes by whatever rule suits its rows.
pub struct Child {
    pub name: &'static str,
    /// The value the vault holds now, in the form the source states it.
    pub read: fn(&Connection, &str) -> Result<Json>,
    /// A value in one form whatever its spelling, so two statements of the same
    /// rows compare equal.
    pub canon: fn(&Json) -> Json,
    /// Apply what the source says now, given what it said last (`None`: it has
    /// not spoken for this row before). Returns whether anything changed.
    pub merge: fn(&CommandCtx<'_, '_>, &str, Option<&Json>, &Json) -> Result<bool>,
}

/// One system, as data.
pub struct SystemMap {
    /// The `origin.system` CHECK's word, and the command's suffix.
    pub system: &'static str,
    pub command: &'static str,
    /// The kind of entity this system fills.
    pub kind: Kind,
    /// The kind an origin's `fills` must be, when it has one.
    pub fills: Option<Kind>,
    /// The columns of the kind's own table the system owns. `title` is always
    /// owned, and is the entity's.
    pub fields: &'static [&'static str],
    /// The fields that are rows of their own, after the columns.
    pub children: &'static [Child],
    /// The fields that identify a row nothing follows yet (`title` compares
    /// without regard to case). A record missing one is not matched.
    pub match_on: &'static [&'static str],
    /// Whether a record gone from a complete read may take its row away.
    pub removes: bool,
    pub defaults: Defaults,
}

impl SystemMap {
    /// Whether a record of this system may state `name`.
    fn states(&self, name: &str) -> bool {
        name == "title" || self.fields.contains(&name) || self.child(name).is_some()
    }

    fn child(&self, name: &str) -> Option<&Child> {
        self.children.iter().find(|child| child.name == name)
    }

    /// Whether two values of the field say the same thing.
    fn agree(&self, name: &str, left: Option<&Json>, right: Option<&Json>) -> bool {
        match self.child(name) {
            Some(child) => same(
                left.map(child.canon).as_ref(),
                right.map(child.canon).as_ref(),
            ),
            None => same(left, right),
        }
    }
}

fn no_defaults(
    _: &Connection,
    _: &OriginRow,
) -> Result<Vec<(&'static str, rusqlite::types::Value)>> {
    Ok(Vec::new())
}

fn calendar_defaults(
    _: &Connection,
    origin: &OriginRow,
) -> Result<Vec<(&'static str, rusqlite::types::Value)>> {
    Ok(vec![(
        "calendar_id",
        origin
            .fills
            .clone()
            .unwrap_or_else(|| DEFAULT_CALENDAR_ID.to_owned())
            .into(),
    )])
}

fn folder_defaults(
    _: &Connection,
    origin: &OriginRow,
) -> Result<Vec<(&'static str, rusqlite::types::Value)>> {
    Ok(origin
        .fills
        .clone()
        .map(|folder| ("folder_id", folder.into()))
        .into_iter()
        .collect())
}

fn statement_defaults(
    connection: &Connection,
    origin: &OriginRow,
) -> Result<Vec<(&'static str, rusqlite::types::Value)>> {
    let Some(account) = origin.fills.clone() else {
        return Err(VaultError::InvalidInput {
            name: "origin".to_owned(),
            detail: "a statement is imported into an account".to_owned(),
        });
    };
    // A line is in the account's currency: one account, one currency.
    let currency: String = connection.query_row(
        "SELECT currency FROM account WHERE id = ?1",
        [&account],
        |row| row.get(0),
    )?;
    Ok(vec![
        ("account_id", account.into()),
        ("currency", currency.into()),
    ])
}

/// The five systems the vault follows.
pub const SYSTEMS: &[SystemMap] = &[
    SystemMap {
        system: "contacts",
        command: "follow.contacts",
        kind: Kind::Person,
        fills: None,
        fields: &["sort_name", "nickname", "role", "birthday"],
        children: &[Child {
            name: "points",
            read: contact_point::read,
            canon: contact_point::canon,
            merge: contact_point::merge,
        }],
        match_on: &["title"],
        removes: true,
        defaults: no_defaults,
    },
    SystemMap {
        system: "calendar",
        command: "follow.calendar",
        kind: Kind::Event,
        fills: Some(Kind::Calendar),
        fields: &[
            "starts",
            "ends",
            "timing",
            "zone",
            "rule",
            "rule_supported",
            "status",
            "busy",
            "url",
            "reminders",
            "description",
        ],
        children: &[],
        match_on: &["title", "starts"],
        removes: true,
        defaults: calendar_defaults,
    },
    SystemMap {
        system: "files",
        command: "follow.files",
        kind: Kind::Document,
        fills: Some(Kind::Folder),
        fields: &["blob", "media_type"],
        children: &[],
        match_on: &["title"],
        removes: true,
        defaults: folder_defaults,
    },
    SystemMap {
        system: "health",
        command: "follow.health",
        kind: Kind::Activity,
        fills: None,
        fields: &["type_id", "type_kind", "starts", "ends"],
        children: &[],
        match_on: &["type_id", "starts"],
        removes: true,
        defaults: no_defaults,
    },
    SystemMap {
        system: "statement",
        command: "follow.statement",
        kind: Kind::Txn,
        fills: Some(Kind::Account),
        fields: &["posted_on", "amount_minor", "status", "category_id"],
        children: &[],
        match_on: &[],
        // A statement line is never removed: a month later's statement does not
        // contain this month's.
        removes: false,
        defaults: statement_defaults,
    },
];

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

fn to_sql(value: &Json) -> rusqlite::types::Value {
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
fn same(left: Option<&Json>, right: Option<&Json>) -> bool {
    match (left.unwrap_or(&Json::Null), right.unwrap_or(&Json::Null)) {
        (Json::Number(a), Json::Number(b)) => a.as_f64() == b.as_f64(),
        (Json::Bool(a), Json::Number(b)) | (Json::Number(b), Json::Bool(a)) => {
            b.as_i64() == Some(i64::from(*a))
        }
        (a, b) => a == b,
    }
}

/// The columns a row holds now, for the fields named, as JSON.
fn current(connection: &Connection, map: &SystemMap, id: &str) -> Result<Map<String, Json>> {
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

fn upsert_origin(ctx: &CommandCtx<'_, '_>, map: &SystemMap) -> Result<OriginRow> {
    let connection = ctx.connection();
    let origin = ctx.input.get("origin").cloned().unwrap_or(Json::Null);
    let text = |key: &str| origin.get(key).and_then(Json::as_str).map(str::to_owned);
    let (reference, label) = (
        text("ref").unwrap_or_default(),
        text("label").unwrap_or_default(),
    );
    let fills = text("fills");
    if let Some(fills) = &fills {
        let found =
            entity::lookup(connection, fills)?.map_err(|sentence| VaultError::InvalidInput {
                name: "origin.fills".to_owned(),
                detail: sentence,
            })?;
        if map.fills != Some(found.kind) {
            return Err(VaultError::InvalidInput {
                name: "origin.fills".to_owned(),
                detail: format!(
                    "`{}` feeds a {}, not a {}",
                    map.system,
                    map.fills.map_or("nothing", Kind::as_str),
                    found.kind.noun()
                ),
            });
        }
    }
    let config = origin
        .get("config")
        .filter(|config| !config.is_null())
        .map(Json::to_string);
    let known: Option<String> = connection
        .query_row(
            "SELECT id FROM origin WHERE system = ?1 AND ref = ?2",
            [map.system, reference.as_str()],
            |row| row.get(0),
        )
        .optional()?;
    let id = if let Some(id) = known {
        connection.execute(
            "UPDATE origin SET label = ?2, device_id = ?3, fills = COALESCE(?4, fills),
                    config = COALESCE(?5, config)
              WHERE id = ?1",
            rusqlite::params![id, label, text("device_id"), fills, config],
        )?;
        id
    } else {
        let id = ctx.next_id();
        connection.execute(
            "INSERT INTO origin (id, system, ref, label, device_id, fills, config, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                id,
                map.system,
                reference,
                label,
                text("device_id"),
                fills,
                config,
                ctx.now
            ],
        )?;
        id
    };
    let (fills, device) = connection.query_row(
        "SELECT fills, device_id FROM origin WHERE id = ?1",
        [&id],
        |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, Option<String>>(1)?,
            ))
        },
    )?;
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
}

struct Record {
    external_id: String,
    device_id: Option<String>,
    fields: Map<String, Json>,
}

fn records_of(ctx: &CommandCtx<'_, '_>, map: &SystemMap) -> Result<Vec<Record>> {
    let mut records = Vec::new();
    for raw in ctx
        .input
        .get("records")
        .and_then(Json::as_array)
        .into_iter()
        .flatten()
    {
        let fields = raw
            .get("fields")
            .and_then(Json::as_object)
            .cloned()
            .unwrap_or_default();
        if let Some(unowned) = fields.keys().find(|name| !map.states(name)) {
            return Err(VaultError::InvalidInput {
                name: format!("fields.{unowned}"),
                detail: format!("`{}` does not state `{unowned}`", map.system),
            });
        }
        records.push(Record {
            external_id: raw
                .get("external_id")
                .and_then(Json::as_str)
                .unwrap_or_default()
                .to_owned(),
            device_id: raw
                .get("device_id")
                .and_then(Json::as_str)
                .map(str::to_owned),
            fields,
        });
    }
    Ok(records)
}

type SourceRow = (String, Option<String>, Json);

fn source_of(connection: &Connection, origin: &str, record: &Record) -> Result<Option<SourceRow>> {
    Ok(connection
        .query_row(
            "SELECT id, entity_id, stated FROM source
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
                ))
            },
        )
        .optional()?)
}

/// Write the fields to a row: the title on the entity, the rest on the kind's
/// own table; then touch it.
fn write_fields(
    ctx: &CommandCtx<'_, '_>,
    map: &SystemMap,
    id: &str,
    fields: &[(&str, &Json)],
) -> Result<()> {
    if fields.is_empty() {
        return Ok(());
    }
    let connection = ctx.connection();
    for (name, value) in fields {
        if *name == "title" {
            connection.execute(
                "UPDATE entity SET title = ?2 WHERE id = ?1",
                rusqlite::params![id, value.as_str().unwrap_or_default()],
            )?;
        } else {
            connection.execute(
                &format!(
                    "UPDATE {} SET {} = ?2 WHERE id = ?1",
                    crate::log::quoted(map.kind.host()),
                    crate::log::quoted(name)
                ),
                rusqlite::params![id, to_sql(value)],
            )?;
        }
    }
    ctx.touch(id)
}

fn add(
    ctx: &CommandCtx<'_, '_>,
    map: &SystemMap,
    origin: &OriginRow,
    record: &Record,
) -> Result<String> {
    let title = record
        .fields
        .get("title")
        .and_then(Json::as_str)
        .ok_or_else(|| VaultError::InvalidInput {
            name: "fields.title".to_owned(),
            detail: format!("a followed {} needs a title", map.kind.noun()),
        })?;
    let id = ctx.insert_entity(map.kind, title)?;
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
    merge_children(ctx, map, &id, None, &record.fields)?;
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

fn link(
    ctx: &CommandCtx<'_, '_>,
    map: &SystemMap,
    origin: &OriginRow,
    record: &Record,
    entity_id: &str,
) -> Result<()> {
    ctx.connection().execute(
        "INSERT INTO source (id, origin_id, system, external_id, device_id, entity_id, entity_kind,
                             stated, seen_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        rusqlite::params![
            ctx.next_id(),
            origin.id,
            map.system,
            record.external_id,
            record.device_id,
            entity_id,
            map.kind.as_str(),
            Json::Object(record.fields.clone()).to_string(),
            ctx.now
        ],
    )?;
    Ok(())
}

/// The first row of this kind that nothing follows and the record's match key
/// names. A row followed only by another phone's id (a vault restored onto a new
/// phone) is not followed: its source is that phone's, and the row is the new
/// phone's to re-find.
fn match_existing(
    connection: &Connection,
    map: &SystemMap,
    record: &Record,
) -> Result<Option<String>> {
    if map.match_on.is_empty()
        || map
            .match_on
            .iter()
            .any(|name| !record.fields.contains_key(*name))
    {
        return Ok(None);
    }
    let mut clauses = Vec::new();
    let mut values: Vec<rusqlite::types::Value> = vec![
        map.kind.as_str().to_owned().into(),
        record.device_id.clone().into(),
    ];
    for name in map.match_on {
        let value = to_sql(&record.fields[*name]);
        values.push(value);
        clauses.push(if *name == "title" {
            format!("e.title = ?{} COLLATE NOCASE", values.len())
        } else {
            format!("k.{} IS ?{}", crate::log::quoted(name), values.len())
        });
    }
    let sql = format!(
        "SELECT e.id FROM entity e JOIN {} k ON k.id = e.id
          WHERE e.kind = ?1 AND e.deleted_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM source s WHERE s.entity_id = e.id
                              AND (?2 IS NULL OR s.device_id IS NULL OR s.device_id = ?2))
            AND {}
          ORDER BY e.created_at, e.id LIMIT 1",
        crate::log::quoted(map.kind.host()),
        clauses.join(" AND ")
    );
    Ok(connection
        .query_row(&sql, rusqlite::params_from_iter(values), |row| row.get(0))
        .optional()?)
}

fn merge_record(
    ctx: &CommandCtx<'_, '_>,
    map: &SystemMap,
    origin: &OriginRow,
    record: &Record,
    tally: &mut Tally,
) -> Result<()> {
    let connection = ctx.connection();
    let Some((source_id, entity_id, stated)) = source_of(connection, &origin.id, record)? else {
        // A record the vault has not seen: match it to a row of the member's
        // own first, and only then add one.
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
        } else {
            let id = add(ctx, map, origin, record)?;
            link(ctx, map, origin, record, &id)?;
            tally.added += 1;
        }
        return Ok(());
    };
    // A tombstone: the row was purged, and the source never takes another.
    let Some(entity_id) = entity_id else {
        connection.execute(
            "UPDATE source SET seen_at = ?2 WHERE id = ?1",
            [&source_id, &ctx.now],
        )?;
        tally.unchanged += 1;
        return Ok(());
    };
    let held = entity::require(connection, &entity_id)?;
    // The member trashed it: that stands, and the statement is left where it
    // was so a restore finds a row that still compares as untouched.
    if held.deleted_at.is_some() {
        connection.execute(
            "UPDATE source SET seen_at = ?2 WHERE id = ?1",
            [&source_id, &ctx.now],
        )?;
        tally.unchanged += 1;
        return Ok(());
    }
    let now = current(connection, map, &entity_id)?;
    let mut writes: Vec<(&str, &Json)> = Vec::new();
    for (name, new) in record
        .fields
        .iter()
        .filter(|(name, _)| map.child(name).is_none())
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
    statement.extend(record.fields.clone());
    connection.execute(
        "UPDATE source SET stated = ?2, seen_at = ?3 WHERE id = ?1",
        rusqlite::params![source_id, Json::Object(statement).to_string(), ctx.now],
    )?;
    if writes.is_empty() && !rows_changed {
        tally.unchanged += 1;
    } else {
        tally.updated += 1;
    }
    Ok(())
}

/// A complete read that no longer holds a record: take its row away if the
/// member never touched it, and otherwise keep the row and forget the source.
fn settle_absent(
    ctx: &CommandCtx<'_, '_>,
    map: &SystemMap,
    origin: &OriginRow,
    seen: &[(String, Option<String>)],
    tally: &mut Tally,
) -> Result<()> {
    let connection = ctx.connection();
    let gone: Vec<(String, String, Option<String>, String, Json)> = connection
        .prepare(
            "SELECT id, external_id, device_id, entity_id, stated FROM source
              WHERE origin_id = ?1 AND entity_id IS NOT NULL",
        )?
        .query_map([&origin.id], |row| {
            let stated: String = row.get(4)?;
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                serde_json::from_str(&stated).unwrap_or(Json::Null),
            ))
        })?
        .collect::<rusqlite::Result<_>>()?;
    for (source_id, external_id, device_id, entity_id, stated) in gone {
        if seen.iter().any(|(seen_id, seen_device)| {
            *seen_id == external_id
                && seen_device.as_deref().unwrap_or("") == device_id.as_deref().unwrap_or("")
        }) {
            continue;
        }
        // Another phone's record is not judged lost by this phone's read: it is
        // forgotten and the row kept, for the new phone to re-find.
        if device_id.is_some() && device_id != origin.device {
            connection.execute("DELETE FROM source WHERE id = ?1", [&source_id])?;
            tally.forgotten += 1;
            continue;
        }
        let held = entity::require(connection, &entity_id)?;
        let now = current(connection, map, &entity_id)?;
        let edited = stated
            .as_object()
            .into_iter()
            .flatten()
            .any(|(name, said)| !map.agree(name, now.get(name.as_str()), Some(said)));
        if edited {
            connection.execute("DELETE FROM source WHERE id = ?1", [&source_id])?;
            tally.forgotten += 1;
        } else if held.deleted_at.is_none() {
            let stamp = trash_stamp(ctx)?;
            let mut trashed = Vec::new();
            entity::trash_one(ctx, &entity_id, &stamp, &mut trashed)?;
            tally.trashed += 1;
        }
    }
    Ok(())
}

/// Apply one batch of records from a system.
pub fn apply(ctx: &CommandCtx<'_, '_>, map: &SystemMap) -> Result<serde_json::Value> {
    let origin = upsert_origin(ctx, map)?;
    let records = records_of(ctx, map)?;
    let mut tally = Tally::default();
    let mut seen = Vec::with_capacity(records.len());
    for record in &records {
        merge_record(ctx, map, &origin, record, &mut tally)?;
        seen.push((record.external_id.clone(), record.device_id.clone()));
    }
    let complete = ctx
        .input
        .get("complete")
        .and_then(Json::as_bool)
        .unwrap_or(false);
    if complete && map.removes {
        settle_absent(ctx, map, &origin, &seen, &mut tally)?;
    }
    Ok(serde_json::json!({
        "origin": origin.id,
        "added": tally.added,
        "matched": tally.matched,
        "updated": tally.updated,
        "unchanged": tally.unchanged,
        "trashed": tally.trashed,
        "forgotten": tally.forgotten,
    }))
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
        "config": { "type": ["object", "null"] }
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
          "fields": { "type": "object" }
        }
      }
    },
    "complete": { "type": "boolean" }
  }
}"#;

#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    SYSTEMS
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
        .collect()
}
