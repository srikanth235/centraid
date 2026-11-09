//! THE VAULT AS ONE GRAPH, centred on its owner (#1173, O1).
//!
//! Two things join entities in the model, and a reader that wants "what is
//! joined to this person" must not know which: an **edge** (`about`, `with`,
//! `depicts`, `attendee`, `links`, `attached`, `contains`, `related`) and a
//! **foreign-key column** on a kind's own row (a note's notebook, a document's
//! folder, a line's account and category, an event's calendar and place). This
//! module is the one catalogue of both, and the one reading of them.
//!
//! - [`EDGE_RELATIONS`] and [`COLUMN_LINKS`] are data. A reader over a
//!   `PageDoor` (the app kit's `graph`) or over the assistant's `Door` plans its
//!   own reads from them and so cannot drift from this list.
//! - [`links_at`] reads both kinds of join for one entity from a connection, as
//!   the same [`Link`] the door-based readers build.
//! - [`Link::touches_locker`] is the wall: a link that starts or ends at a
//!   Locker item is Locker's alone. Every reader outside Locker drops it, as
//!   the page door does for an edge (`vault::page::locker_exclusion`).
//!
//! The graph is **derived**: no table holds it. A link read here is a row that
//! was written for its own sake (a command's edge, a kind's column) and is not
//! kept in step by anything.

use rusqlite::Connection;

use crate::error::Result;

/// How one join is stored.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Via {
    /// A row of `edge`.
    Edge,
    /// A column of the start's own kind row.
    Column,
}

/// One join, seen from either end.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Link {
    pub from: String,
    pub from_kind: String,
    pub to: String,
    pub to_kind: String,
    /// The edge's `rel` (`about`), or the column's relation word (`place`).
    pub relation: &'static str,
    pub via: Via,
}

impl Link {
    /// Whether either end is a Locker item: such a link is Locker's alone.
    #[must_use]
    pub fn touches_locker(&self) -> bool {
        self.from_kind == LOCKER_ITEM || self.to_kind == LOCKER_ITEM
    }
}

/// The kind row Locker keeps behind its wall.
pub const LOCKER_ITEM: &str = "locker_item";

/// The relations that are edges, in the CHECK's order. The model has these and
/// no others; `Rel::ALL` in `crates/vault` is held to this list by a test.
pub const EDGE_RELATIONS: [&str; 9] = [
    "contains", "tagged", "about", "links", "attached", "attendee", "with", "related", "depicts",
];

/// The edge relations that say a thing is *of* a person: what a person's
/// "In your vault" reads, and what a person's trash and merge reason about.
pub const PERSON_RELATIONS: [&str; 6] =
    ["about", "with", "depicts", "attendee", "links", "attached"];

/// A kind's column that points at another entity: the same fact an edge would
/// carry, stored on the row because it is single-valued and required to exist.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ColumnLink {
    /// The relation word the graph gives it.
    pub relation: &'static str,
    /// The kind's own table, which is also its kind.
    pub table: &'static str,
    pub column: &'static str,
    /// The kind the column points at.
    pub to_kind: &'static str,
}

/// Every column link. Held to the founded file by a test: each names a column
/// the baseline has, with a foreign key to `entity`.
pub const COLUMN_LINKS: [ColumnLink; 10] = [
    ColumnLink {
        relation: "calendar",
        table: "event",
        column: "calendar_id",
        to_kind: "calendar",
    },
    ColumnLink {
        relation: "place",
        table: "event",
        column: "place_id",
        to_kind: "place",
    },
    ColumnLink {
        relation: "place",
        table: "activity",
        column: "place_id",
        to_kind: "place",
    },
    ColumnLink {
        relation: "place",
        table: "photo",
        column: "place_id",
        to_kind: "place",
    },
    ColumnLink {
        relation: "project",
        table: "task",
        column: "project_id",
        to_kind: "project",
    },
    ColumnLink {
        relation: "parent",
        table: "task",
        column: "parent_id",
        to_kind: "task",
    },
    ColumnLink {
        relation: "notebook",
        table: "note",
        column: "notebook_id",
        to_kind: "notebook",
    },
    ColumnLink {
        relation: "folder",
        table: "document",
        column: "folder_id",
        to_kind: "folder",
    },
    ColumnLink {
        relation: "account",
        table: "txn",
        column: "account_id",
        to_kind: "account",
    },
    ColumnLink {
        relation: "category",
        table: "txn",
        column: "category_id",
        to_kind: "category",
    },
];

/// Which way to read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    /// Links that start at the entity.
    Outgoing,
    /// Links that end at the entity.
    Incoming,
}

/// Every live link at `id`, edges and columns together, in a stable order.
///
/// An entity in the trash is not an end: a link to or from one is not read. A
/// link to a Locker item is read, flagged by [`Link::touches_locker`]; the
/// caller outside Locker drops it.
///
/// # Errors
/// Whatever SQLite refused.
pub fn links_at(connection: &Connection, id: &str, direction: Direction) -> Result<Vec<Link>> {
    let (own, other) = match direction {
        Direction::Outgoing => ("from_id", "to_id"),
        Direction::Incoming => ("to_id", "from_id"),
    };
    let mut links = Vec::new();
    let mut edges = connection.prepare_cached(&format!(
        "SELECT e.from_id, f.kind, e.to_id, t.kind, e.rel
           FROM edge e
           JOIN entity f ON f.id = e.from_id AND f.deleted_at IS NULL
           JOIN entity t ON t.id = e.to_id AND t.deleted_at IS NULL
          WHERE e.{own} = ?1 AND e.rel NOT IN ('tagged', 'contains', 'related')
          ORDER BY e.{other}, e.rel"
    ))?;
    let rows = edges.query_map([id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
        ))
    })?;
    for row in rows {
        let (from, from_kind, to, to_kind, rel) = row?;
        let Some(relation) = EDGE_RELATIONS.iter().find(|name| **name == rel) else {
            continue;
        };
        links.push(Link {
            from,
            from_kind,
            to,
            to_kind,
            relation,
            via: Via::Edge,
        });
    }
    for column in COLUMN_LINKS {
        let sql = match direction {
            Direction::Outgoing => {
                format!(
                    "SELECT k.id, f.kind, k.{c}, t.kind FROM {t} k
                       JOIN entity f ON f.id = k.id AND f.deleted_at IS NULL
                       JOIN entity t ON t.id = k.{c} AND t.deleted_at IS NULL
                      WHERE k.id = ?1",
                    t = column.table,
                    c = column.column
                )
            }
            Direction::Incoming => {
                format!(
                    "SELECT k.id, f.kind, k.{c}, t.kind FROM {t} k
                       JOIN entity f ON f.id = k.id AND f.deleted_at IS NULL
                       JOIN entity t ON t.id = k.{c} AND t.deleted_at IS NULL
                      WHERE k.{c} = ?1 ORDER BY k.id",
                    t = column.table,
                    c = column.column
                )
            }
        };
        let mut statement = connection.prepare_cached(&sql)?;
        let rows = statement.query_map([id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?;
        for row in rows {
            let (from, from_kind, to, to_kind) = row?;
            links.push(Link {
                from,
                from_kind,
                to,
                to_kind,
                relation: column.relation,
                via: Via::Column,
            });
        }
    }
    links.sort();
    links.dedup();
    Ok(links)
}

/// [`links_at`] for a reader that is not Locker: the same, without any link
/// that starts or ends at a Locker item.
///
/// # Errors
/// Whatever SQLite refused.
pub fn links_outside_locker(
    connection: &Connection,
    id: &str,
    direction: Direction,
) -> Result<Vec<Link>> {
    Ok(links_at(connection, id, direction)?
        .into_iter()
        .filter(|link| !link.touches_locker())
        .collect())
}
