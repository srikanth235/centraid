//! Reading the history: the earlier versions of one entity, and what changed between them.
//!
//! A version is a `revision` row: the entity's state **before** the commit at `at` (by `cause`)
//! changed it. What that commit changed is derived here, at read time, by comparing the version
//! with the one that replaced it (the next row, or the state now for the newest): no diff is
//! stored, so there is no second truth to drift from the states.

use std::collections::{BTreeMap, BTreeSet};

use rusqlite::{Connection, OptionalExtension};
use serde_json::{Map, Value as Json};

use super::STATE_VIEW;
use super::shape::{CONTENT, Part, Shape, shape};
use crate::canonical::canonical_json;
use crate::commands::follow;
use crate::error::{Result, VaultError};

/// The most versions one page returns.
pub const MAX_PAGE: usize = 100;

/// Who made the change that replaced a version.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Who {
    /// The member (a command, an edit, a restore).
    Member,
    /// A phone store the vault follows (`contacts`, `calendar`, `files`, `health`, `statement`):
    /// the change is what the store said, not something the member did.
    Store(String),
}

impl Who {
    fn of(cause: &str) -> Self {
        follow::system_of(cause).map_or(Self::Member, |system| Self::Store(system.to_owned()))
    }

    #[must_use]
    pub fn to_json(&self) -> Json {
        match self {
            Self::Member => serde_json::json!({"kind": "member"}),
            Self::Store(system) => serde_json::json!({"kind": "store", "system": system}),
        }
    }
}

/// One field that differs between a version and the one that replaced it.
#[derive(Debug, Clone, PartialEq)]
pub struct Change {
    /// `entity.title`, `<kind table>.<column>`, `<child table>[<key>].<column>`, or a whole child
    /// row `<child table>[<key>]` (with `null` on the side that did not have it).
    pub field: String,
    /// The value in this version.
    pub before: Json,
    /// The value in the version that replaced it.
    pub after: Json,
}

/// One earlier version of an entity.
#[derive(Debug, Clone, PartialEq)]
pub struct Version {
    /// The version's number, counting up from one per entity: what a restore names.
    pub seq: i64,
    /// When it was replaced.
    pub at: String,
    /// When it became the record's state: when the version before it was replaced, or, for the
    /// first, when the record was made.
    pub since: String,
    /// Who made it the record's state: who replaced the version before it. The member for the
    /// first, whose making no commit names.
    pub since_by: Who,
    /// Who replaced it.
    pub by: Who,
    /// The command that replaced it, as the commit named it.
    pub cause: String,
    /// What the replacing commit changed, field by field; empty when the two states share no
    /// captured field (an older schema).
    pub changes: Vec<Change>,
}

/// A page of earlier versions, newest first.
#[derive(Debug, Clone, PartialEq)]
pub struct Earlier {
    pub versions: Vec<Version>,
    /// Pass as `before` for the next page; `None` when this is the last.
    pub next: Option<i64>,
}

impl Earlier {
    /// The wire form: `{"versions": [{seq, at, by, cause, changes: [{field, before, after}]}], "next"}`.
    #[must_use]
    pub fn to_json(&self) -> Json {
        serde_json::json!({
            "versions": self.versions.iter().map(|version| serde_json::json!({
                "seq": version.seq,
                "at": version.at,
                "since": version.since,
                "since_by": version.since_by.to_json(),
                "by": version.by.to_json(),
                "cause": version.cause,
                "changes": version.changes.iter().map(|change| serde_json::json!({
                    "field": change.field,
                    "before": change.before,
                    "after": change.after,
                })).collect::<Vec<_>>(),
            })).collect::<Vec<_>>(),
            "next": self.next,
        })
    }
}

/// A `revision` row, as its cells.
struct Row {
    seq: i64,
    at: String,
    cause: String,
    state: String,
    body: Option<String>,
    blob: Option<String>,
    media_type: Option<String>,
}

const ROW: &str = "seq, at, cause, state, body, blob, media_type";

fn row_of(row: &rusqlite::Row<'_>) -> rusqlite::Result<Row> {
    Ok(Row {
        seq: row.get(0)?,
        at: row.get(1)?,
        cause: row.get(2)?,
        state: row.get(3)?,
        body: row.get(4)?,
        blob: row.get(5)?,
        media_type: row.get(6)?,
    })
}

/// A version's whole state: the stored state with the content cells put back.
fn assemble(row: &Row) -> Result<Json> {
    let mut state: Json = serde_json::from_str(&row.state).map_err(|source| VaultError::Json {
        context: "a version's state".to_owned(),
        source,
    })?;
    for (table, column, cell) in CONTENT {
        let value = match cell {
            super::shape::Cell::Body => &row.body,
            super::shape::Cell::Blob => &row.blob,
            super::shape::Cell::MediaType => &row.media_type,
        };
        if let (Some(value), Some(root)) = (value, state.as_object_mut()) {
            root.entry((*table).to_owned())
                .or_insert_with(|| Json::Object(Map::new()))
                .as_object_mut()
                .map(|object| object.insert((*column).to_owned(), Json::String(value.clone())));
        }
    }
    Ok(state)
}

/// The state of an entity now, as the history keeps states: `None` when there is no such entity.
///
/// # Errors
/// A database error.
pub fn current_state(connection: &Connection, id: &str) -> Result<Option<Json>> {
    let text: Option<Option<String>> = connection
        .query_row(
            &format!("SELECT state FROM temp.{STATE_VIEW} WHERE entity_id = ?1"),
            [id],
            |row| row.get(0),
        )
        .optional()?;
    text.flatten()
        .map(|text| {
            serde_json::from_str(&text).map_err(|source| VaultError::Json {
                context: "an entity's state".to_owned(),
                source,
            })
        })
        .transpose()
}

/// The state version `seq` of an entity holds, whole: `None` when the entity has no such version.
///
/// # Errors
/// A database error.
pub fn version_state(connection: &Connection, id: &str, seq: i64) -> Result<Option<Json>> {
    let row = connection
        .query_row(
            &format!("SELECT {ROW} FROM revision WHERE entity_id = ?1 AND seq = ?2"),
            rusqlite::params![id, seq],
            row_of,
        )
        .optional()?;
    row.as_ref().map(assemble).transpose()
}

/// How many earlier versions an entity holds: what a detail screen's "Earlier versions" entry
/// counts. It reads the entity's own rows (the key prefix), never the vault's.
///
/// # Errors
/// A database error.
pub fn count(connection: &Connection, id: &str) -> Result<u32> {
    let held: i64 = connection.query_row(
        "SELECT COUNT(*) FROM revision WHERE entity_id = ?1",
        [id],
        |row| row.get(0),
    )?;
    Ok(u32::try_from(held).unwrap_or(u32::MAX))
}

/// What a detail screen's "Earlier versions" entry counts: [`count`], except that an item in the
/// trash offers none (its versions come back with it). The one place that rule is decided.
///
/// # Errors
/// A database error.
pub fn offered(connection: &Connection, id: &str) -> Result<u32> {
    let trashed: bool = connection.query_row(
        "SELECT EXISTS (SELECT 1 FROM entity WHERE id = ?1 AND deleted_at IS NOT NULL)",
        [id],
        |row| row.get(0),
    )?;
    if trashed {
        Ok(0)
    } else {
        count(connection, id)
    }
}

/// The earlier versions of one entity, newest first, a page at a time (`before` is the `next` of
/// the page before; `limit` is at most [`MAX_PAGE`]). Each carries what changed when it was
/// replaced.
///
/// # Errors
/// A database error.
pub fn earlier_versions(
    connection: &Connection,
    id: &str,
    before: Option<i64>,
    limit: usize,
) -> Result<Earlier> {
    let limit = limit.clamp(1, MAX_PAGE);
    let shape = shape(connection)?;
    let rows: Vec<Row> = {
        let mut statement = connection.prepare_cached(&format!(
            "SELECT {ROW} FROM revision WHERE entity_id = ?1 AND seq < ?2
              ORDER BY seq DESC LIMIT ?3"
        ))?;
        statement
            .query_map(
                rusqlite::params![
                    id,
                    before.unwrap_or(i64::MAX),
                    i64::try_from(limit + 1).unwrap_or(i64::MAX)
                ],
                row_of,
            )?
            .collect::<rusqlite::Result<_>>()?
    };
    let more = rows.len() > limit;
    let shown = &rows[..rows.len().min(limit)];
    let Some(newest) = shown.first() else {
        return Ok(Earlier {
            versions: Vec::new(),
            next: None,
        });
    };
    // What replaced the newest version shown: the next row up, or the entity as it is.
    let mut replacement = match version_state(connection, id, newest.seq + 1)? {
        Some(state) => Some(state),
        None => current_state(connection, id)?,
    };
    // The version below the last one shown dates it: the extra row read, else the record's birth.
    let birth: (String, Who) = match rows.get(shown.len()) {
        Some(below) => (below.at.clone(), Who::of(&below.cause)),
        None => (
            connection
                .query_row("SELECT created_at FROM entity WHERE id = ?1", [id], |row| {
                    row.get(0)
                })
                .optional()?
                .unwrap_or_default(),
            Who::Member,
        ),
    };
    let mut versions = Vec::with_capacity(shown.len());
    for (index, row) in shown.iter().enumerate() {
        let state = assemble(row)?;
        let mut changes = replacement
            .as_ref()
            .map_or_else(Vec::new, |after| diff(shape, &state, after));
        // The diff is read on the ciphertexts (two seals of one value differ, which is how a
        // changed secret is seen); what leaves this function never carries one.
        changes.iter_mut().for_each(|change| mask(shape, change));
        versions.push(Version {
            seq: row.seq,
            at: row.at.clone(),
            since: shown
                .get(index + 1)
                .map_or_else(|| birth.0.clone(), |below| below.at.clone()),
            since_by: shown
                .get(index + 1)
                .map_or_else(|| birth.1.clone(), |below| Who::of(&below.cause)),
            by: Who::of(&row.cause),
            cause: row.cause.clone(),
            changes,
        });
        replacement = Some(state);
    }
    Ok(Earlier {
        next: more.then(|| shown.last().map(|row| row.seq)).flatten(),
        versions,
    })
}

/// What a sealed cell reads as in a [`Change`]: the vault's own placeholder, so a change to a
/// secret is shown as a change and its value (or its ciphertext) is shown to no one. A cell that
/// held nothing stays `null`, which is how a reader tells "set" from "changed".
pub const MASK: &str = crate::commands::locker::SEALED_PLACEHOLDER;

fn masked_cell(value: &Json) -> Json {
    if value.is_null() {
        Json::Null
    } else {
        Json::String(MASK.to_owned())
    }
}

/// Mask the sealed cells of one side of a change: the whole value of a sealed column, or the
/// sealed columns inside a whole row.
fn mask_side(shape: &Shape, table: &str, column: Option<&str>, value: &mut Json) {
    let Some(part) = shape.part(table) else {
        return;
    };
    match (column, value) {
        (Some(column), value) if super::shape::is_sealed(part.name, column) => {
            *value = masked_cell(value);
        }
        (None, Json::Object(row)) => {
            for (column, cell) in row.iter_mut() {
                if super::shape::is_sealed(part.name, column) {
                    *cell = masked_cell(cell);
                }
            }
        }
        _ => {}
    }
}

fn mask(shape: &Shape, change: &mut Change) {
    // `locker_item.password`, `locker_item_field[<id>].value_sealed`, `locker_item_field[<id>]`.
    let (head, column) = match change.field.split_once("].") {
        Some((head, column)) => (head, Some(column)),
        None => match change.field.split_once('.') {
            Some((head, column)) => (head, Some(column)),
            None => (change.field.trim_end_matches(']'), None),
        },
    };
    let table = head.split('[').next().unwrap_or(head);
    mask_side(shape, table, column, &mut change.before);
    mask_side(shape, table, column, &mut change.after);
}

fn same(left: &Json, right: &Json) -> bool {
    match (canonical_json(left), canonical_json(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => left == right,
    }
}

/// The fields two states differ in, in a stable order. A table or column only one of them
/// captured is not compared: it was not known then, which is not a change.
fn diff(shape: &Shape, before: &Json, after: &Json) -> Vec<Change> {
    let mut changes = Vec::new();
    let (Some(before), Some(after)) = (before.as_object(), after.as_object()) else {
        return changes;
    };
    let tables: BTreeSet<&String> = before
        .keys()
        .filter(|key| after.contains_key(*key))
        .collect();
    for table in tables {
        let (left, right) = (&before[table], &after[table]);
        if table == "entity" {
            columns(&mut changes, "entity", left, right, None);
            continue;
        }
        let Some(part) = shape.part(table) else {
            continue;
        };
        if part.is_one() {
            one(&mut changes, part, left, right);
        } else {
            many(&mut changes, part, left, right);
        }
    }
    changes
}

fn columns(
    changes: &mut Vec<Change>,
    prefix: &str,
    left: &Json,
    right: &Json,
    only: Option<&Part>,
) {
    let (Some(left), Some(right)) = (left.as_object(), right.as_object()) else {
        return;
    };
    for (column, was) in left {
        let Some(is) = right.get(column) else {
            continue;
        };
        if only.is_some_and(|part| !part.columns.contains(column)) || same(was, is) {
            continue;
        }
        changes.push(Change {
            field: format!("{prefix}.{column}"),
            before: was.clone(),
            after: is.clone(),
        });
    }
}

fn one(changes: &mut Vec<Change>, part: &Part, left: &Json, right: &Json) {
    match (left.is_null(), right.is_null()) {
        (true, true) => {}
        (false, false) => columns(changes, part.alias, left, right, Some(part)),
        _ => changes.push(Change {
            field: part.alias.to_owned(),
            before: left.clone(),
            after: right.clone(),
        }),
    }
}

/// The key a row of a child table goes by: its key columns' values, joined.
pub(super) fn key_of(part: &Part, row: &Json) -> String {
    part.key
        .iter()
        .map(|column| match row.get(column) {
            Some(Json::String(text)) => text.clone(),
            Some(other) => other.to_string(),
            None => String::new(),
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn many(changes: &mut Vec<Change>, part: &Part, left: &Json, right: &Json) {
    let index = |rows: &Json| -> BTreeMap<String, Json> {
        rows.as_array()
            .into_iter()
            .flatten()
            .map(|row| (key_of(part, row), row.clone()))
            .collect()
    };
    let (was, is) = (index(left), index(right));
    let keys: BTreeSet<&String> = was.keys().chain(is.keys()).collect();
    for key in keys {
        match (was.get(key), is.get(key)) {
            (Some(left), Some(right)) => {
                columns(
                    changes,
                    &format!("{}[{key}]", part.alias),
                    left,
                    right,
                    Some(part),
                );
            }
            (left, right) => changes.push(Change {
                field: format!("{}[{key}]", part.alias),
                before: left.cloned().unwrap_or(Json::Null),
                after: right.cloned().unwrap_or(Json::Null),
            }),
        }
    }
}
