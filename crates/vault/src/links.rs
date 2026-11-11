//! THE GENERAL LINK, READ (#1185): "what is this linked to" and "what can I link it to", for every
//! app.
//!
//! A link is one `links` edge between two items, set by hand with `edge.add`. It has no direction a
//! member can see: a link made on a note shows on the event it points at, and either page can take
//! it off. `edge.add` will not put a second edge in place when the other direction is there, and
//! `edge.remove` takes both off, so the two reads here are all a page needs.
//!
//! **A Locker item never turns up where the member is not in Locker.** It may start a link and can
//! never be the target of one (owner ruling D11), so a link FROM an item in Locker is read only for
//! that item's own page; an item's page elsewhere never lists a Locker item, and the picker never
//! offers one.
//!
//! **Both reads are bounded by construction**: a picker answers at most [`MAX_CANDIDATES`] rows,
//! from `entity_by_title_nocase` in name order, and a page of links reads at most [`MAX_LINKED`]
//! edges each way through `edge_key` and `edge_to`.

use rusqlite::Connection;

use crate::error::Result;
use crate::model::Kind;

/// The most rows one picker answers: a sheet, not the vault.
pub const MAX_CANDIDATES: usize = 50;

/// The most links one page reads each way. A member who links more than this to one item has
/// stopped using links as links.
pub const MAX_LINKED: usize = 200;

/// The word an app and the picker use for a kind of item: what [`Candidate`] and [`Linked`] carry
/// and what [`candidates`] takes. A transaction is a `transaction` and an activity that is a
/// workout is a `workout` (an interaction logged with a person is not an item a link joins).
pub const KEYS: [&str; 10] = [
    "person",
    "place",
    "event",
    "task",
    "note",
    "document",
    "photo",
    "account",
    "transaction",
    "workout",
];

/// The key of one kind of item, `None` for a kind no link joins.
#[must_use]
pub fn key_of(kind: Kind, is_workout: bool) -> Option<&'static str> {
    Some(match kind {
        Kind::Person => "person",
        Kind::Place => "place",
        Kind::Event => "event",
        Kind::Task => "task",
        Kind::Note => "note",
        Kind::Document => "document",
        Kind::Photo => "photo",
        Kind::Account => "account",
        Kind::Txn => "transaction",
        Kind::Activity if is_workout => "workout",
        Kind::LockerItem => "locker_item",
        _ => return None,
    })
}

/// One thing the picker offers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub id: String,
    pub title: String,
    /// The member's own person: the picker says "You" over it and lists it first.
    pub is_owner: bool,
}

/// One thing a page is linked to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Linked {
    pub id: String,
    /// One of [`KEYS`], or `locker_item` on a Locker item's own page.
    pub key: &'static str,
    pub title: String,
    pub is_owner: bool,
}

/// What a candidate's key means to the vault: the kind, and whether it must be a workout.
fn kind_of_key(key: &str) -> Option<(Kind, bool)> {
    Some(match key {
        "person" => (Kind::Person, false),
        "place" => (Kind::Place, false),
        "event" => (Kind::Event, false),
        "task" => (Kind::Task, false),
        "note" => (Kind::Note, false),
        "document" => (Kind::Document, false),
        "photo" => (Kind::Photo, false),
        "account" => (Kind::Account, false),
        "transaction" => (Kind::Txn, false),
        "workout" => (Kind::Activity, true),
        _ => return None,
    })
}

/// What a typed term matches: the title, folded to lower case, contains the term's words. An
/// empty term matches everything.
fn folded(term: &str) -> String {
    term.trim().to_lowercase()
}

/// The things of `key` a link may END at, in name order, whose title holds `term` (any case);
/// at most `limit` (never more than [`MAX_CANDIDATES`]). A trashed item is not offered. A place
/// with no name is not offered, nor a memo (a note written about the member themself, which no
/// page lists as a note). The member's own person comes first when it matches.
///
/// A key that is not an item a link may end at (`locker_item`, a word nobody knows) offers
/// nothing: a Locker item is never offered, by construction and not by a filter.
///
/// # Errors
/// A database error.
pub fn candidates(
    connection: &Connection,
    key: &str,
    term: &str,
    limit: usize,
) -> Result<Vec<Candidate>> {
    let Some((kind, workout)) = kind_of_key(key) else {
        return Ok(Vec::new());
    };
    let limit = limit.clamp(1, MAX_CANDIDATES);
    let needle = folded(term);
    let mut found: Vec<Candidate> = Vec::new();
    let mut statement = connection.prepare_cached(
        "SELECT e.id, e.title, e.id = (SELECT self_id FROM vault)
           FROM entity e
          WHERE e.kind = ?1 AND e.deleted_at IS NULL
            AND (?2 = '' OR instr(lower(e.title), ?2) > 0)
            AND (?3 = 0 OR EXISTS (SELECT 1 FROM workout w WHERE w.id = e.id))
            AND (?4 = 1 OR trim(e.title) <> '')
            AND NOT (e.kind = 'note'
                     AND EXISTS (SELECT 1 FROM edge m WHERE m.from_id = e.id AND m.rel = 'about'
                                    AND m.to_id = (SELECT self_id FROM vault)))
          ORDER BY e.title COLLATE NOCASE, e.created_at, e.id
          LIMIT ?5",
    )?;
    let rows = statement.query_map(
        rusqlite::params![
            kind.as_str(),
            needle,
            i64::from(workout),
            i64::from(kind != Kind::Place),
            i64::try_from(limit).unwrap_or(i64::MAX)
        ],
        |row| {
            Ok(Candidate {
                id: row.get(0)?,
                title: row.get(1)?,
                is_owner: row.get(2)?,
            })
        },
    )?;
    for row in rows {
        found.push(row?);
    }
    // The owner leads, whatever their name sorts to: one more read, by primary key.
    if kind == Kind::Person && !found.iter().any(|c| c.is_owner) {
        let owner = connection.query_row(
            "SELECT e.id, e.title FROM entity e
              WHERE e.id = (SELECT self_id FROM vault) AND e.deleted_at IS NULL
                AND (?1 = '' OR instr(lower(e.title), ?1) > 0)",
            [&needle],
            |row| {
                Ok(Candidate {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    is_owner: true,
                })
            },
        );
        match owner {
            Ok(owner) => {
                found.insert(0, owner);
                found.truncate(limit);
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => {}
            Err(other) => return Err(other.into()),
        }
    } else if let Some(at) = found.iter().position(|c| c.is_owner) {
        let owner = found.remove(at);
        found.insert(0, owner);
    }
    Ok(found)
}

/// What the entity `id` is linked to, both ways, in name order, each thing once: at most
/// [`MAX_LINKED`] from each direction. A trashed item is left out. On a Locker item's own page the
/// links it started are read; anywhere else a Locker item is left out (it is seen only inside
/// Locker).
///
/// # Errors
/// A database error.
pub fn linked(connection: &Connection, id: &str) -> Result<Vec<Linked>> {
    let cap = i64::try_from(MAX_LINKED).unwrap_or(i64::MAX);
    let mut found: Vec<Linked> = Vec::new();
    for (statement, locker_ok) in [
        (
            "SELECT e.id, e.kind, e.title, w.id IS NOT NULL, e.id = (SELECT self_id FROM vault)
               FROM edge g
               JOIN entity e ON e.id = g.to_id
               LEFT JOIN workout w ON w.id = e.id
              WHERE g.from_id = ?1 AND g.rel = 'links' AND e.deleted_at IS NULL
              LIMIT ?2",
            true,
        ),
        (
            "SELECT e.id, e.kind, e.title, w.id IS NOT NULL, e.id = (SELECT self_id FROM vault)
               FROM edge g
               JOIN entity e ON e.id = g.from_id
               LEFT JOIN workout w ON w.id = e.id
              WHERE g.to_id = ?1 AND g.rel = 'links' AND e.deleted_at IS NULL
                AND e.kind <> 'locker_item'
              LIMIT ?2",
            false,
        ),
    ] {
        let mut prepared = connection.prepare_cached(statement)?;
        let rows = prepared.query_map(rusqlite::params![id, cap], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, bool>(3)?,
                row.get::<_, bool>(4)?,
            ))
        })?;
        for row in rows {
            let (other, kind, title, workout, owner) = row?;
            let Some(kind) = Kind::parse(&kind) else {
                continue;
            };
            let Some(key) = key_of(kind, workout) else {
                continue;
            };
            // A Locker item is read only where the page is its own and the link is its own.
            if key == "locker_item" && !locker_ok {
                continue;
            }
            if found.iter().any(|seen| seen.id == other) {
                continue;
            }
            found.push(Linked {
                id: other,
                key,
                title,
                is_owner: owner,
            });
        }
    }
    found.sort_by_cached_key(|row| (!row.is_owner, row.title.to_lowercase(), row.id.clone()));
    Ok(found)
}
