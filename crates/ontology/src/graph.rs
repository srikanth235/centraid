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
//!   `PageDoor` (the app kit's `graph`) plans its reads from them and so cannot
//!   drift from this list.
//! - [`incoming`] and [`outgoing`] are that planning, once: which edge relations
//!   and which columns answer "what ends here" and "what starts here", over any
//!   [`GraphSource`]. A source only answers one question, "these rows, for these
//!   ids", in its own way (a connection joins, a door reads a table at a time),
//!   so the two cannot disagree on WHAT is read.
//! - [`links_at`] reads both kinds of join for one entity from a connection, as
//!   the same [`Link`] the door-based readers build.
//! - [`Link::touches_locker`] is the wall: a link that starts or ends at a
//!   Locker item is Locker's alone. Every reader outside Locker drops it, as
//!   the page door does for an edge (`vault::page::locker_exclusion`).
//!
//! The graph is **derived**: no table holds it. A link read here is a row that
//! was written for its own sake (a command's edge, a kind's column) and is not
//! kept in step by anything.

use std::collections::{BTreeMap, BTreeSet};

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
    let end = match direction {
        Direction::Outgoing => End::From,
        Direction::Incoming => End::To,
    };
    // The edges that join (a tag, a container and a `related` pair are not what is joined).
    let rels: Vec<&str> = EDGE_RELATIONS
        .iter()
        .copied()
        .filter(|rel| !matches!(*rel, "tagged" | "contains" | "related"))
        .collect();
    let found = around(&ConnectionSource(connection), id, end, &rels)?;
    // An end is a live entity of some kind: a join to or from the trash is not read.
    let ends: Vec<String> = found
        .iter()
        .flat_map(|join| [join.from.clone(), join.to.clone()])
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let kinds = live_kinds(connection, &ends)?;
    let mut links = Vec::new();
    for join in found {
        let (Some(from_kind), Some(to_kind)) = (kinds.get(&join.from), kinds.get(&join.to)) else {
            continue;
        };
        let word = match join.via {
            Via::Edge => EDGE_RELATIONS.iter().find(|name| **name == join.relation),
            Via::Column => COLUMN_LINKS
                .iter()
                .map(|link| &link.relation)
                .find(|name| **name == join.relation),
        };
        let Some(relation) = word else {
            continue;
        };
        links.push(Link {
            from: join.from,
            from_kind: from_kind.clone(),
            to: join.to,
            to_kind: to_kind.clone(),
            relation,
            via: join.via,
        });
    }
    links.sort();
    links.dedup();
    Ok(links)
}

/// The kind of each of `ids` that is a live entity; one that is in the trash or is no entity is
/// not in the answer.
fn live_kinds(connection: &Connection, ids: &[String]) -> Result<BTreeMap<String, String>> {
    let mut kinds = BTreeMap::new();
    for chunk in ids.chunks(400) {
        let mut statement = connection.prepare(&format!(
            "SELECT id, kind FROM entity WHERE deleted_at IS NULL AND id IN ({})",
            marks(chunk.len())
        ))?;
        let rows = statement.query_map(
            rusqlite::params_from_iter(chunk.iter().map(String::as_str)),
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )?;
        for row in rows {
            let (id, kind) = row?;
            kinds.insert(id, kind);
        }
    }
    Ok(kinds)
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

/// Which end of a join a read starts from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum End {
    /// The ids are where the joins start: an edge's `from_id`, a kind's own row.
    From,
    /// The ids are where the joins end: an edge's `to_id`, the row a column points at.
    To,
}

/// One edge row as a source answers it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EdgeRow {
    pub from: String,
    pub to: String,
    /// The edge's `rel`.
    pub rel: String,
    /// The edge's anchor, as the text of its JSON (a link written in a note's words carries one).
    pub anchor: Option<String>,
}

/// One join, read: the id at each end and how it is stored.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Join {
    pub from: String,
    pub to: String,
    /// The edge's `rel`, or the column's relation word.
    pub relation: String,
    pub via: Via,
}

/// Where a reader of the graph gets its rows. A source answers two questions and plans nothing:
/// which edge relations and which columns are read is [`incoming`] and [`outgoing`]'s, from the
/// catalogue.
pub trait GraphSource {
    /// What a read can refuse with.
    type Error;

    /// The edges of the relations in `rels` whose `end` is one of `ids`, in the order of the
    /// other end. `ids` and `rels` are not empty.
    ///
    /// # Errors
    /// The source's own refusal.
    fn edges(
        &self,
        end: End,
        ids: &[String],
        rels: &[&str],
    ) -> std::result::Result<Vec<EdgeRow>, Self::Error>;

    /// The rows of `link.table` the column links, as `(row id, the column's value)`: for
    /// [`End::From`] the rows whose own id is one of `ids`, for [`End::To`] the rows whose column
    /// holds one of `ids`. A row whose column is empty is not answered. `ids` is not empty.
    ///
    /// # Errors
    /// The source's own refusal.
    fn column_rows(
        &self,
        link: &ColumnLink,
        end: End,
        ids: &[String],
    ) -> std::result::Result<Vec<(String, String)>, Self::Error>;
}

/// The joins at `ids` from `end`: the edges of `rels`, and the catalogue's columns `columns`
/// accepts. Each as the pair of ids a column row answers, in the direction the join points.
fn joins<S: GraphSource>(
    source: &S,
    end: End,
    ids: &[String],
    rels: &[&str],
    columns: impl Fn(&ColumnLink) -> bool,
) -> std::result::Result<Vec<Join>, S::Error> {
    let mut out = Vec::new();
    if ids.is_empty() {
        return Ok(out);
    }
    if !rels.is_empty() {
        for edge in source.edges(end, ids, rels)? {
            out.push(Join {
                from: edge.from,
                to: edge.to,
                relation: edge.rel,
                via: Via::Edge,
            });
        }
    }
    for link in COLUMN_LINKS.iter().filter(|link| columns(link)) {
        for (from, to) in source.column_rows(link, end, ids)? {
            out.push(Join {
                from,
                to,
                relation: link.relation.to_owned(),
                via: Via::Column,
            });
        }
    }
    out.sort();
    out.dedup();
    Ok(out)
}

/// The joins that END at `id`, by `rels` (edge relations) and by every column of the catalogue
/// that points at a kind named `to_kind`. Sorted, each once.
///
/// # Errors
/// The source's own refusal.
pub fn incoming<S: GraphSource>(
    source: &S,
    id: &str,
    to_kind: &str,
    rels: &[&str],
) -> std::result::Result<Vec<Join>, S::Error> {
    joins(source, End::To, &[id.to_owned()], rels, |link| {
        link.to_kind == to_kind
    })
}

/// The joins that START at any of `ids`, which are all of kind `from_kind`: by `rels` (edge
/// relations) and by the columns of that kind's own row. Sorted, each once.
///
/// # Errors
/// The source's own refusal.
pub fn outgoing<S: GraphSource>(
    source: &S,
    ids: &[String],
    from_kind: &str,
    rels: &[&str],
) -> std::result::Result<Vec<Join>, S::Error> {
    joins(source, End::From, ids, rels, |link| link.table == from_kind)
}

/// The joins at `id` from `end` when the id's kind is not known: the edges of `rels` and EVERY
/// column of the catalogue (a column that is not the id's kind's answers nothing). Sorted, each
/// once.
///
/// # Errors
/// The source's own refusal.
pub fn around<S: GraphSource>(
    source: &S,
    id: &str,
    end: End,
    rels: &[&str],
) -> std::result::Result<Vec<Join>, S::Error> {
    joins(source, end, &[id.to_owned()], rels, |_| true)
}

/// The catalogue's reads over one open connection: an edge or a column is a statement of its own,
/// named by the catalogue and never by the caller.
pub struct ConnectionSource<'a>(pub &'a Connection);

fn marks(count: usize) -> String {
    vec!["?"; count].join(", ")
}

impl GraphSource for ConnectionSource<'_> {
    type Error = crate::error::OntologyError;

    fn edges(&self, end: End, ids: &[String], rels: &[&str]) -> Result<Vec<EdgeRow>> {
        let (own, other) = match end {
            End::From => ("from_id", "to_id"),
            End::To => ("to_id", "from_id"),
        };
        let mut statement = self.0.prepare(&format!(
            "SELECT from_id, to_id, rel, anchor FROM edge
              WHERE {own} IN ({}) AND rel IN ({})
              ORDER BY {other}, rel",
            marks(ids.len()),
            marks(rels.len())
        ))?;
        let binds = ids.iter().map(String::as_str).chain(rels.iter().copied());
        let rows = statement.query_map(rusqlite::params_from_iter(binds), |row| {
            Ok(EdgeRow {
                from: row.get(0)?,
                to: row.get(1)?,
                rel: row.get(2)?,
                anchor: row.get(3)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    fn column_rows(
        &self,
        link: &ColumnLink,
        end: End,
        ids: &[String],
    ) -> Result<Vec<(String, String)>> {
        let held = match end {
            End::From => "id",
            End::To => link.column,
        };
        let mut statement = self.0.prepare(&format!(
            "SELECT id, {c} FROM {t} WHERE {held} IN ({}) AND {c} IS NOT NULL ORDER BY id",
            marks(ids.len()),
            t = link.table,
            c = link.column
        ))?;
        let rows = statement.query_map(
            rusqlite::params_from_iter(ids.iter().map(String::as_str)),
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
}
