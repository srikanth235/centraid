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
//! and only then added. What a record gone from a *complete* read does is the
//! system's ([`Gone`]): contacts, events and files trash the row if the member
//! never edited it and otherwise forget the source and keep the row (R-FP-3);
//! the health store's workouts always keep the row and forget the source
//! (R-1129-14); a statement line is never removed. There is no fingerprint and
//! no detach.
//!
//! **Four guards, one each for the whole engine** ([#1146](https://github.com/srikanth235/centraid/issues/1146)):
//!
//! - *The owner is nobody's record.* A match never lands on the vault's owner,
//!   the owner never gains a source, and nothing takes the owner to the trash
//!   ([`entity::is_self`] is the one question all of them ask).
//! - *A read that lost most of what the vault follows is doubted.* A complete
//!   read that no longer holds at least [`DOUBTED_AT_LEAST`] of an origin's
//!   followed rows, and more than half of them, looks like a sync glitch (a
//!   calendar not yet downloaded, an unmounted card), not a mass delete: nothing
//!   is trashed or forgotten for it and the answer says how many rows it doubts
//!   (`doubted`). Contacts, events and files are all judged here and nowhere else.
//! - *What the follower trashed for a record's absence comes back with the
//!   record.* The source remembers when it trashed the row (`gone_at`); the same
//!   record in a later read restores the row if the member has not touched it.
//!   What the member trashed stays trashed.
//! - *Tombstones are found and forgotten.* A record another phone states is
//!   matched against the first phone's tombstones as well as its rows (a purged
//!   row is never revived under a new name), and a tombstone whose record is gone
//!   from a complete read goes with it.
//!
//! **A system's map is data** ([`SystemMap`]): which kind it fills, which
//! scalar columns it owns, what a new row needs that no record states, whether
//! a record's absence may take its row away. The engine knows no system by
//! name. The maps below carry the scalar columns of each system's kind row; the
//! rows that hang off them (a contact's points, an event's attendees, a
//! workout's measures) are added by the lane that owns the kind.

use rusqlite::{Connection, OptionalExtension};
use serde_json::{Map, Value as Json};

use crate::blob;
use crate::commands::entity::{self, trash_stamp};
use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency};
use crate::commands::{contact_point, document, event, workout};
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

/// What a record gone from a complete read does to its row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gone {
    /// Trash the row if the member never edited it; else forget the source and
    /// keep the row (R-FP-3).
    Trash,
    /// Forget the source and keep the row, edited or not: the vault is the
    /// copy that outlives the phone's store (R-1129-14).
    Forget,
    /// Nothing: a record's absence says nothing (a statement line is never
    /// removed, a month later's statement does not hold this month's).
    Keep,
}

/// One field of a record that identifies a row nothing follows yet.
#[derive(Debug, Clone, Copy)]
pub enum Match {
    /// The entity's title, without regard to case.
    Title,
    /// A column of the kind's own row, exactly.
    Column(&'static str),
    /// A column holding an instant, to the minute (`YYYY-MM-DDTHH:MM`): a phone
    /// that re-reads a workout may state the seconds differently.
    Minute(&'static str),
}

impl Match {
    /// The record field this key reads.
    const fn field(self) -> &'static str {
        match self {
            Self::Title => "title",
            Self::Column(name) | Self::Minute(name) => name,
        }
    }
}

/// What an origin of a system is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OriginOf {
    /// A store on a phone (an account of the address book, a calendar, a folder, the
    /// health store): named by the ref the phone gives it, and its records are a
    /// phone's, so they say which phone.
    Phone,
    /// An account's statements: **one origin per account**, whatever ref an import
    /// names, and no phone is named anywhere (a statement is not a phone store).
    Account,
}

/// The fewest followed rows a complete read must lose before it is doubted.
pub const DOUBTED_AT_LEAST: usize = 5;

/// One system, as data.
pub struct SystemMap {
    /// The `origin.system` CHECK's word, and the command's suffix.
    pub system: &'static str,
    pub command: &'static str,
    /// The kind of entity this system fills.
    pub kind: Kind,
    /// The kind an origin's `fills` must be, when it has one.
    pub fills: Option<Kind>,
    /// Whose origin it is.
    pub origin: OriginOf,
    /// The field naming bytes the command claims in its own commit (a record
    /// then says their `size`), so no step between staging and naming leaves them
    /// unreferenced.
    pub claims: Option<&'static str>,
    /// The columns of the kind's own table the system owns. `title` is always
    /// owned, and is the entity's.
    pub fields: &'static [&'static str],
    /// The fields (`title` among them) that are written when a row is added and
    /// never after: a statement line is never edited, whatever a later
    /// statement says.
    pub fixed: &'static [&'static str],
    /// The fields that are rows of their own, after the columns.
    pub children: &'static [Child],
    /// The fields that identify a row nothing follows yet. A record missing one
    /// is not matched.
    pub match_on: &'static [Match],
    /// What a record gone from a complete read does to its row.
    pub gone: Gone,
    /// The column of the kind's own row that dates a record. A read that began at
    /// `since` speaks only for the rows dated at or after it, so an older row is
    /// not judged absent: a store read over a window knows nothing of what came
    /// before it.
    pub window: Option<&'static str>,
    pub defaults: Defaults,
    /// Read what a record states into the form the vault holds it (a wall clock
    /// and its zone become the instant, a store's word for a workout becomes a
    /// kind), so the statement and the row compare equal. A record it refuses is
    /// counted and left out.
    pub shape: Shape,
    /// What a row derives from what the source stated (a rule's support), run
    /// after the fields are written.
    pub settle: Settle,
    /// What a row keeps of what the source is about to replace (a file's old
    /// bytes, as a revision), run on a row that exists before its fields are
    /// written.
    pub replaced: Replaced,
}

/// See [`SystemMap::shape`].
pub type Shape = fn(&CommandCtx<'_, '_>, &mut Map<String, Json>) -> std::result::Result<(), String>;

/// See [`SystemMap::settle`].
pub type Settle = fn(&CommandCtx<'_, '_>, &str) -> Result<()>;

/// See [`SystemMap::replaced`].
pub type Replaced = fn(&CommandCtx<'_, '_>, &str, &[(&str, &Json)]) -> Result<()>;

fn as_stated(_: &CommandCtx<'_, '_>, _: &mut Map<String, Json>) -> std::result::Result<(), String> {
    Ok(())
}

fn event_shape(
    _: &CommandCtx<'_, '_>,
    fields: &mut Map<String, Json>,
) -> std::result::Result<(), String> {
    event::shape(fields)
}

fn nothing_to_settle(_: &CommandCtx<'_, '_>, _: &str) -> Result<()> {
    Ok(())
}

fn nothing_replaced(_: &CommandCtx<'_, '_>, _: &str, _: &[(&str, &Json)]) -> Result<()> {
    Ok(())
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

/// A child that is only ever stated, never a row of the vault's: what the
/// source last said of it, read back from `source.stated`. The member cannot
/// edit it, so the row always agrees with what was stated, and a changed
/// statement is recorded by the engine and written nowhere else.
fn stated_read(connection: &Connection, id: &str, name: &str) -> Result<Json> {
    let stated: Option<String> = connection
        .query_row(
            "SELECT stated FROM source WHERE entity_id = ?1",
            [id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(stated
        .and_then(|text| serde_json::from_str::<Json>(&text).ok())
        .and_then(|stated| stated.get(name).cloned())
        .unwrap_or(Json::Null))
}

fn stated_canon(value: &Json) -> Json {
    value.clone()
}

fn stated_merge(_: &CommandCtx<'_, '_>, _: &str, _: Option<&Json>, _: &Json) -> Result<bool> {
    Ok(false)
}

/// A file's size and modification time as the phone last stated them.
///
/// The phone's cheap pre-check rides in the statement: a rescan of an unchanged
/// folder reads no bytes, because the phone asks the vault what each file last
/// stated (`source.stated`) and stages a file only when its size or time moved.
const STAT: Child = Child {
    name: "stat",
    read: |connection, id| stated_read(connection, id, "stat"),
    canon: stated_canon,
    merge: stated_merge,
};

/// What a statement said of a line beyond what the model keeps: its memo, its
/// check number, the bank's own type and the file format it came in.
const LINE: Child = Child {
    name: "line",
    read: |connection, id| stated_read(connection, id, "line"),
    canon: stated_canon,
    merge: stated_merge,
};

/// The five systems the vault follows.
pub const SYSTEMS: &[SystemMap] = &[
    SystemMap {
        system: "contacts",
        command: "follow.contacts",
        kind: Kind::Person,
        fills: None,
        origin: OriginOf::Phone,
        claims: None,
        fields: &["sort_name", "nickname", "role", "birthday"],
        fixed: &[],
        children: &[Child {
            name: "points",
            read: contact_point::read,
            canon: contact_point::canon,
            merge: contact_point::merge,
        }],
        match_on: &[Match::Title],
        gone: Gone::Trash,
        window: None,
        defaults: no_defaults,
        shape: as_stated,
        settle: nothing_to_settle,
        replaced: nothing_replaced,
    },
    SystemMap {
        system: "calendar",
        command: "follow.calendar",
        kind: Kind::Event,
        fills: Some(Kind::Calendar),
        origin: OriginOf::Phone,
        claims: None,
        fields: &[
            "description",
            "starts",
            "ends",
            "timing",
            "zone",
            "rule",
            "busy",
        ],
        fixed: &[],
        children: &[Child {
            name: "overrides",
            read: event::overrides_read,
            canon: event::overrides_canon,
            merge: event::overrides_merge,
        }],
        match_on: &[Match::Title, Match::Column("starts")],
        gone: Gone::Trash,
        window: None,
        defaults: calendar_defaults,
        shape: event_shape,
        settle: event::settle,
        replaced: nothing_replaced,
    },
    SystemMap {
        system: "files",
        command: "follow.files",
        kind: Kind::Document,
        fills: Some(Kind::Folder),
        origin: OriginOf::Phone,
        claims: Some("blob"),
        fields: &["blob", "media_type"],
        fixed: &[],
        children: &[STAT],
        match_on: &[Match::Title],
        gone: Gone::Trash,
        window: None,
        defaults: folder_defaults,
        shape: as_stated,
        settle: nothing_to_settle,
        replaced: document::keep_replaced_by_write,
    },
    // A workout: an activity of a workout kind, its span, and what the store
    // measured. A record states the store's word for the kind and the vault
    // places it ([`workout::shape`]); the member edits none of it, and one gone
    // from the phone stays (R-1129-14).
    SystemMap {
        system: "health",
        command: "follow.health",
        kind: Kind::Activity,
        fills: None,
        origin: OriginOf::Phone,
        claims: None,
        fields: &["type_id", "type_kind", "starts", "ends"],
        fixed: &[],
        children: &[workout::MEASURES],
        match_on: &[Match::Column("type_id"), Match::Minute("starts")],
        gone: Gone::Forget,
        window: Some("starts"),
        defaults: no_defaults,
        shape: workout::shape,
        settle: workout::settle,
        replaced: nothing_replaced,
    },
    // A line of a statement: its title is the bank's words until the member
    // renames it, its day and amount are the bank's and never edited, and the
    // category is the member's to change.
    SystemMap {
        system: "statement",
        command: "follow.statement",
        kind: Kind::Txn,
        fills: Some(Kind::Account),
        origin: OriginOf::Account,
        claims: None,
        fields: &["posted_on", "amount_minor", "category_id"],
        fixed: &["title", "posted_on", "amount_minor"],
        children: &[LINE],
        match_on: &[],
        gone: Gone::Keep,
        window: None,
        defaults: statement_defaults,
        shape: as_stated,
        settle: nothing_to_settle,
        replaced: nothing_replaced,
    },
];

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
    let account_origin = map.origin == OriginOf::Account;
    // A statement is not a phone store: no phone is named on its origin.
    let device = if account_origin {
        None
    } else {
        text("device_id")
    };
    let known: Option<String> = if account_origin {
        let Some(fills) = &fills else {
            return Err(VaultError::InvalidInput {
                name: "origin.fills".to_owned(),
                detail: format!("`{}` is imported into an account", map.system),
            });
        };
        connection
            .query_row(
                "SELECT id FROM origin WHERE system = ?1 AND fills = ?2",
                [map.system, fills.as_str()],
                |row| row.get(0),
            )
            .optional()?
    } else {
        connection
            .query_row(
                "SELECT id FROM origin WHERE system = ?1 AND ref = ?2",
                [map.system, reference.as_str()],
                |row| row.get(0),
            )
            .optional()?
    };
    let id = if let Some(id) = known {
        if account_origin {
            // The account names its origin (its bank number, its name): an
            // import neither renames nor re-keys it.
            connection.execute(
                "UPDATE origin SET config = COALESCE(?2, config) WHERE id = ?1",
                rusqlite::params![id, config],
            )?;
        } else {
            connection.execute(
                "UPDATE origin SET label = ?2, device_id = ?3, fills = COALESCE(?4, fills),
                        config = COALESCE(?5, config)
                  WHERE id = ?1",
                rusqlite::params![id, label, device, fills, config],
            )?;
        }
        id
    } else {
        let id = ctx.next_id();
        connection.execute(
            "INSERT INTO origin (id, system, ref, label, device_id, fills, config, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                id, map.system, reference, label, device, fills, config, ctx.now
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
fn records_of(ctx: &CommandCtx<'_, '_>, map: &SystemMap) -> Result<(Vec<Record>, Vec<RecordKey>)> {
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
            // A statement line is an account's, never a phone's.
            device_id: raw
                .get("device_id")
                .and_then(Json::as_str)
                .filter(|_| map.origin == OriginOf::Phone)
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
fn write_fields(
    ctx: &CommandCtx<'_, '_>,
    map: &SystemMap,
    id: &str,
    fields: &[(&str, &Json)],
) -> Result<()> {
    if fields.is_empty() {
        return Ok(());
    }
    (map.replaced)(ctx, id, fields)?;
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
    (map.settle)(ctx, id)?;
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
    (map.settle)(ctx, &id)?;
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
    // The owner is nobody's record: no source ever names them.
    if entity::is_self(ctx.connection(), entity_id)? {
        return Err(VaultError::Invariant {
            context: "a source never names the vault's owner".to_owned(),
        });
    }
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
/// the row is the new phone's to re-find.
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
                "UPDATE source SET external_id = ?2, device_id = ?3, stated = ?4, seen_at = ?5
                  WHERE id = ?1",
                rusqlite::params![
                    tombstone,
                    record.external_id,
                    record.device_id,
                    Json::Object(record.fields.clone()).to_string(),
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
        connection.execute(
            "UPDATE source SET seen_at = ?2 WHERE id = ?1",
            [&source_id, &ctx.now],
        )?;
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
            connection.execute(
                "UPDATE source SET seen_at = ?2 WHERE id = ?1",
                [&source_id, &ctx.now],
            )?;
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
    for (name, value) in &record.fields {
        // A field written once and never after keeps the source's first words:
        // a statement line's payee is the bank's, whatever a later import (its
        // rules, the member's rename) calls it.
        if map.fixed.contains(&name.as_str()) && statement.contains_key(name) {
            continue;
        }
        statement.insert(name.clone(), value.clone());
    }
    connection.execute(
        "UPDATE source SET stated = ?2, seen_at = ?3, gone_at = NULL WHERE id = ?1",
        rusqlite::params![source_id, Json::Object(statement).to_string(), ctx.now],
    )?;
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

/// Apply one batch of records from a system.
pub fn apply(ctx: &CommandCtx<'_, '_>, map: &SystemMap) -> Result<serde_json::Value> {
    let origin = upsert_origin(ctx, map)?;
    let (records, refused) = records_of(ctx, map)?;
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
          "size": { "type": ["integer", "null"], "minimum": 0,
            "description": "How large the bytes a record names are, counted by the phone; the command claims them." },
          "fields": { "type": "object" }
        }
      }
    },
    "complete": { "type": "boolean" },
    "since": { "type": "string" }
  }
}"#;

const STOP_SCHEMA: &str = r#"{
  "type": "object",
  "required": ["system", "ref"],
  "additionalProperties": false,
  "properties": {
    "system": { "type": "string", "enum": ["contacts", "calendar", "files", "health", "statement"] },
    "ref": { "type": "string", "minLength": 1 }
  }
}"#;

fn pre_stop(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    Ok((ctx.required_str("system")? == "statement").then(|| {
        "a statement is an account's, not a phone store; there is nothing to stop following"
            .to_owned()
    }))
}

/// Stop following one origin: the sources that name its rows are forgotten and
/// the origin is retired. **Every row stays** and is the member's own from now
/// on; nothing is trashed. Stopping what is not followed is nothing.
fn stop(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let (system, reference) = (ctx.required_str("system")?, ctx.required_str("ref")?);
    let connection = ctx.connection();
    let origin: Option<String> = connection
        .query_row(
            "SELECT id FROM origin WHERE system = ?1 AND ref = ?2",
            [system, reference],
            |row| row.get(0),
        )
        .optional()?;
    let Some(origin) = origin else {
        return Ok(serde_json::json!({ "stopped": false, "forgotten": 0 }));
    };
    let forgotten = connection.execute("DELETE FROM source WHERE origin_id = ?1", [&origin])?;
    connection.execute("DELETE FROM origin WHERE id = ?1", [&origin])?;
    Ok(serde_json::json!({ "stopped": true, "forgotten": forgotten }))
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
    definitions
}
