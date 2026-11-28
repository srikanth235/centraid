//! THE GENERAL LINK (#1185, #1214 A4): "what is this linked to" and "what can I link it to", for
//! every app, and the merge hook that moves one item's whole graph onto another.
//!
//! A link is one `link` row between two items of any **linkable** kind (`entity_kind.linkable`: a
//! Locker item, like any other item, is both a link end and a `[[title]]` target; a reading, a chat,
//! a container and a label are neither). It has no direction a member can see, so the table keeps
//! none: the lower id is `a`, a pair is one row whichever end is asked about, and a duplicate in
//! either direction is impossible (the key and `CHECK (a < b)`). A note's `[[title]]` links are not
//! this table: they are `mention` rows, owned by the note and rebuilt on every save; they are read
//! here only so a page lists everything it is linked to.
//!
//! **Both reads are bounded by construction**: a picker answers at most [`MAX_CANDIDATES`] rows, from
//! `entity_by_title_nocase` in name order, and a page of links reads at most [`MAX_LINKED`] rows from
//! each of the four places a link lives (`link` by `a`, by `b`, a note's mentions, mentions of it).

use rusqlite::{Connection, OptionalExtension};

use crate::error::{Result, VaultError};
use crate::model::Kind;

/// The most rows one picker answers: a sheet, not the vault.
pub const MAX_CANDIDATES: usize = 50;

/// The most links one page reads from each place. A member who links more than this to one item has
/// stopped using links as links.
pub const MAX_LINKED: usize = 200;

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
    pub kind: Kind,
    pub title: String,
    pub is_owner: bool,
    /// The link is written as `[[title]]` in a note's text (a `mention`), in either direction: the
    /// note's next save rebuilds it, so it is taken off by editing that text.
    pub in_text: bool,
}

/// The two ends of a link in the order the table keeps them: the lower id first.
#[must_use]
pub fn ordered<'a>(x: &'a str, y: &'a str) -> (&'a str, &'a str) {
    if x <= y { (x, y) } else { (y, x) }
}

/// A sentence when an item of this kind is not an end a link joins (`entity_kind.linkable`).
///
/// # Errors
/// A database error.
pub fn end_refusal(connection: &Connection, title: &str, kind: Kind) -> Result<Option<String>> {
    let linkable: Option<bool> = connection
        .query_row(
            "SELECT linkable FROM entity_kind WHERE code = ?1",
            [kind.as_str()],
            |row| row.get(0),
        )
        .optional()?;
    Ok((linkable != Some(true)).then(|| {
        format!(
            "“{title}” cannot be linked: a {} is not something a link joins",
            kind.noun()
        )
    }))
}

/// Link two items, whichever order they are given in. `true` when the link is new; a link that is
/// there already is left as it is.
///
/// # Errors
/// A database error, among them the database's own refusal of a pair that is not linkable.
pub fn add(connection: &Connection, x: &str, y: &str, now: &str) -> Result<bool> {
    let (a, b) = ordered(x, y);
    Ok(connection.execute(
        "INSERT INTO link (a, b, created_at) VALUES (?1, ?2, ?3) ON CONFLICT DO NOTHING",
        [a, b, now],
    )? > 0)
}

/// Take a link off from either end. `true` when there was one.
///
/// # Errors
/// A database error.
pub fn remove(connection: &Connection, x: &str, y: &str) -> Result<bool> {
    let (a, b) = ordered(x, y);
    Ok(connection.execute("DELETE FROM link WHERE a = ?1 AND b = ?2", [a, b])? > 0)
}

/// What a typed term matches: the title, folded to lower case, contains the term's words. An
/// empty term matches everything.
fn folded(term: &str) -> String {
    term.trim().to_lowercase()
}

/// The things of kind `kind` a link may END at, in name order, whose title holds `term` (any
/// case); at most `limit` (never more than [`MAX_CANDIDATES`]). A trashed item is not offered, nor
/// one with no title to pick it by. The member's own person comes first when it matches.
///
/// A kind that is not an item a link joins (`entity_kind.linkable` is 0) offers nothing, by the
/// query's join and not by a list in Rust.
///
/// # Errors
/// A database error.
pub fn candidates(
    connection: &Connection,
    kind: &str,
    term: &str,
    limit: usize,
) -> Result<Vec<Candidate>> {
    let limit = limit.clamp(1, MAX_CANDIDATES);
    let needle = folded(term);
    let mut found: Vec<Candidate> = Vec::new();
    let mut statement = connection.prepare_cached(
        "SELECT e.id, e.title, e.id = (SELECT self_id FROM vault)
           FROM entity e JOIN entity_kind k ON k.code = e.kind AND k.linkable = 1
          WHERE e.kind = ?1 AND e.deleted_at IS NULL
            AND (?2 = '' OR instr(lower(e.title), ?2) > 0)
            AND trim(e.title) <> ''
          ORDER BY e.title COLLATE NOCASE, e.created_at, e.id
          LIMIT ?3",
    )?;
    let rows = statement.query_map(
        rusqlite::params![kind, needle, i64::try_from(limit).unwrap_or(i64::MAX)],
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
    // The owner leads, whatever their name sorts to: one more read, by primary key. The vault's
    // `self_kind` names the kind the owner is.
    let owner_kind: Option<String> = connection
        .query_row("SELECT self_kind FROM vault", [], |row| row.get(0))
        .optional()?;
    if owner_kind.as_deref() == Some(kind) && !found.iter().any(|c| c.is_owner) {
        let owner = connection
            .query_row(
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
            )
            .optional()?;
        if let Some(owner) = owner {
            found.insert(0, owner);
            found.truncate(limit);
        }
    } else if let Some(at) = found.iter().position(|c| c.is_owner) {
        let owner = found.remove(at);
        found.insert(0, owner);
    }
    Ok(found)
}

/// What the entity `id` is linked to, from either end, in name order, each thing once: at most
/// [`MAX_LINKED`] from each place. A hand-made link is read from `link` (the pair is one row, so a
/// page asks `a = id` and `b = id`); a `[[title]]` is read from `mention` both ways (the notes the
/// page mentions, the notes that mention it) and says `in_text`. A trashed item is left out.
///
/// # Errors
/// A database error.
pub fn linked(connection: &Connection, id: &str) -> Result<Vec<Linked>> {
    let cap = i64::try_from(MAX_LINKED).unwrap_or(i64::MAX);
    let mut found: Vec<Linked> = Vec::new();
    for (statement, in_text) in [
        (
            "SELECT e.id, e.kind, e.title, e.id = (SELECT self_id FROM vault)
               FROM link l JOIN entity e ON e.id = l.b
              WHERE l.a = ?1 AND e.deleted_at IS NULL LIMIT ?2",
            false,
        ),
        (
            "SELECT e.id, e.kind, e.title, e.id = (SELECT self_id FROM vault)
               FROM link l JOIN entity e ON e.id = l.a
              WHERE l.b = ?1 AND e.deleted_at IS NULL LIMIT ?2",
            false,
        ),
        (
            "SELECT e.id, e.kind, e.title, e.id = (SELECT self_id FROM vault)
               FROM mention m JOIN entity e ON e.id = m.to_id
              WHERE m.note_id = ?1 AND e.deleted_at IS NULL LIMIT ?2",
            true,
        ),
        (
            "SELECT e.id, e.kind, e.title, e.id = (SELECT self_id FROM vault)
               FROM mention m JOIN entity e ON e.id = m.note_id
              WHERE m.to_id = ?1 AND e.deleted_at IS NULL LIMIT ?2",
            true,
        ),
    ] {
        let mut prepared = connection.prepare_cached(statement)?;
        let rows = prepared.query_map(rusqlite::params![id, cap], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, bool>(3)?,
            ))
        })?;
        for row in rows {
            let (other, kind, title, is_owner) = row?;
            let Some(kind) = Kind::parse(&kind) else {
                continue;
            };
            if let Some(seen) = found.iter_mut().find(|seen| seen.id == other) {
                // Written in a note's text in either direction is written in the text.
                seen.in_text |= in_text;
                continue;
            }
            found.push(Linked {
                id: other,
                kind,
                title,
                is_owner,
                in_text,
            });
        }
    }
    found.sort_by_cached_key(|row| (!row.is_owner, row.title.to_lowercase(), row.id.clone()));
    Ok(found)
}

/// What [`repoint`] moved.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Repointed {
    /// Links the survivor did not have and now does (one it had already is not counted).
    pub links: usize,
    /// Edges the survivor did not have and now does, whichever end or label it took.
    pub edges: usize,
    /// `[[title]]` mentions that now resolve to the survivor.
    pub mentions: usize,
}

/// THE MERGE HOOK: move every link, edge and mention of `from` onto `into`, leaving none of `from`'s
/// behind and no duplicate in either direction (People's merge calls it, then purges `from`).
///
/// * a link `from`—X becomes `into`—X, ordered again (a pair `into` already has is kept once; a link
///   between `from` and `into` themselves is dropped, a thing is not linked to itself);
/// * an edge of `from` (as its start, its end or the label it wears) is written again with `into` in
///   its place, keeping its position and anchor, and the old row is deleted (an edge's ends are
///   fixed, so it is never updated in place); one `into` already has is kept as it is, and one that
///   would join `into` to itself is dropped;
/// * a `[[title]]` that resolved to `from` resolves to `into`.
///
/// The two must be of one kind, so every edge keeps a shape; the owner's own person is not merged
/// away by any caller (`from` is purged afterwards, and a purge refuses the owner).
///
/// # Errors
/// A database error; an `InvalidInput` when the two are the same item or not of one kind.
pub fn repoint(connection: &Connection, from: &str, into: &str) -> Result<Repointed> {
    let kind_of = |id: &str| -> Result<Option<String>> {
        Ok(connection
            .query_row("SELECT kind FROM entity WHERE id = ?1", [id], |row| {
                row.get(0)
            })
            .optional()?)
    };
    if from == into {
        return Err(VaultError::InvalidInput {
            name: "into".to_owned(),
            detail: "an item cannot be merged into itself".to_owned(),
        });
    }
    let (Some(from_kind), Some(into_kind)) = (kind_of(from)?, kind_of(into)?) else {
        return Err(VaultError::InvalidInput {
            name: "into".to_owned(),
            detail: "both items must exist to be merged".to_owned(),
        });
    };
    if from_kind != into_kind {
        return Err(VaultError::InvalidInput {
            name: "into".to_owned(),
            detail: "only two items of one kind can be merged".to_owned(),
        });
    }
    // Links: the other end of each of `from`'s pairs, paired with `into` in the table's order.
    let links = connection.execute(
        "INSERT OR IGNORE INTO link (a, b, created_at)
         SELECT min(o.other, ?2), max(o.other, ?2), o.created_at
           FROM (SELECT CASE WHEN a = ?1 THEN b ELSE a END AS other, created_at
                   FROM link WHERE a = ?1 OR b = ?1) o
          WHERE o.other <> ?2",
        [from, into],
    )?;
    connection.execute("DELETE FROM link WHERE a = ?1 OR b = ?1", [from])?;
    // Edges: `from` as the start, as the end, as the label.
    let mut edges = 0;
    for sql in [
        "INSERT OR IGNORE INTO edge (from_id, rel, to_id, label_id, position, anchor, created_at)
         SELECT ?2, rel, to_id, label_id, position, anchor, created_at FROM edge
          WHERE from_id = ?1 AND to_id <> ?2",
        "INSERT OR IGNORE INTO edge (from_id, rel, to_id, label_id, position, anchor, created_at)
         SELECT from_id, rel, ?2, label_id, position, anchor, created_at FROM edge
          WHERE to_id = ?1 AND from_id <> ?2",
        "INSERT OR IGNORE INTO edge (from_id, rel, to_id, label_id, position, anchor, created_at)
         SELECT from_id, rel, to_id, ?2, position, anchor, created_at FROM edge
          WHERE label_id = ?1",
    ] {
        edges += connection.execute(sql, [from, into])?;
    }
    connection.execute(
        "DELETE FROM edge WHERE from_id = ?1 OR to_id = ?1 OR label_id = ?1",
        [from],
    )?;
    let mentions = connection.execute(
        "UPDATE mention SET to_id = ?2 WHERE to_id = ?1",
        [from, into],
    )?;
    Ok(Repointed {
        links,
        edges,
        mentions,
    })
}
