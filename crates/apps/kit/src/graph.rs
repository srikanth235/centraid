//! THE GRAPH READ, THROUGH THE DOOR (#1173, O1).
//!
//! `centraid_ontology::graph` is the catalogue of how entities are joined: the
//! edge relations and the foreign-key columns that say the same kind of thing. An
//! app reads over a [`PageDoor`], one table at a time, so it cannot call the
//! connection reader; this is that reader over the door, planned from the same
//! catalogue. People's "In your vault", Notes' "About" and anything else that asks
//! "what is joined to this" come through here and not through an `edge` read of
//! their own, so a new relation or column is added to one list.
//!
//! The door is the wall: an edge that starts or ends at a Locker item is never
//! served to a read that is not Locker's, so nothing here filters it again and
//! nothing here can leak it.

use centraid_ontology::graph::{self, ColumnLink};
pub use centraid_ontology::graph::{EdgeRow, End, GraphSource, Via};

use crate::error::KitResult;
use crate::reads::{FanOutBound, PageDoor, in_list, read_pages};
use crate::row::Row;
use crate::row::text_of;
use crate::statement::{PageBindValue, PageOrder, PageQuery};

/// The vault's owner: the one person every "about me" edge ends at. None before a vault is
/// founded. The app's manifest must read `vault`.
///
/// # Errors
///
/// The kit's own refusals; a door's refusal is `KitError::Door`.
pub fn owner(door: &dyn PageDoor) -> KitResult<Option<String>> {
    let page = door.page(
        &PageQuery::new(
            "graph.owner",
            "self_id",
            "vault",
            PageOrder::asc("self_id", "self_id"),
        ),
        &crate::page::PageRequest::first(1),
    )?;
    Ok(page.rows.first().and_then(|row| text_of(row, "self_id")))
}

/// One join, read: the id at each end and how it is stored.
pub use centraid_ontology::graph::Join as Joined;

/// One `column IN ids` read: which table, what to select, how to order, and which column the
/// ids name.
struct Lookup<'a> {
    name: &'a str,
    table: &'a str,
    select: &'a str,
    order: (&'a str, &'a str),
    column: &'a str,
}

impl Lookup<'_> {
    /// The rows, under the caller's own predicate, to the end of the bound.
    fn read(
        &self,
        door: &dyn PageDoor,
        bound: FanOutBound,
        ids: &[String],
        extra: Option<(String, Vec<PageBindValue>)>,
    ) -> KitResult<Vec<Row>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let fragment = in_list(self.column, ids)?;
        let (predicate, bind) = match extra {
            Some((clause, mut bind)) => {
                bind.extend(fragment.bind);
                (format!("{clause} AND {}", fragment.sql), bind)
            }
            None => (fragment.sql, fragment.bind),
        };
        read_pages(
            door,
            &PageQuery::new(
                self.name,
                self.select,
                self.table,
                PageOrder::asc(self.order.0, self.order.1),
            )
            .filter(&predicate, bind),
            bound,
        )
    }
}

fn rel_clause(rels: &[&str]) -> (String, Vec<PageBindValue>) {
    let marks = vec!["?"; rels.len()].join(", ");
    (
        format!("rel IN ({marks})"),
        rels.iter()
            .map(|rel| PageBindValue::Text((*rel).to_owned()))
            .collect(),
    )
}

/// The catalogue's reader over a door: [`GraphSource`] answers each read as a keyset walk of one
/// table, to the end of the bound.
pub struct DoorSource<'a> {
    door: &'a dyn PageDoor,
    bound: FanOutBound,
}

impl<'a> DoorSource<'a> {
    /// A source over `door`, whose every read walks at most `bound`.
    #[must_use]
    pub fn new(door: &'a dyn PageDoor, bound: FanOutBound) -> Self {
        Self { door, bound }
    }
}

impl GraphSource for DoorSource<'_> {
    type Error = crate::error::KitError;

    fn edges(&self, end: End, ids: &[String], rels: &[&str]) -> KitResult<Vec<EdgeRow>> {
        let (clause, bind) = rel_clause(rels);
        let (name, order, column) = match end {
            End::To => ("graph.in", ("to_id", "from_id"), "to_id"),
            End::From => ("graph.out", ("from_id", "to_id"), "from_id"),
        };
        let rows = Lookup {
            name,
            table: "edge",
            select: "from_id, to_id, rel, anchor, wikilink",
            order,
            column,
        }
        .read(self.door, self.bound, ids, Some((clause, bind)))?;
        Ok(rows
            .iter()
            .filter_map(|row| {
                Some(EdgeRow {
                    from: text_of(row, "from_id")?,
                    to: text_of(row, "to_id")?,
                    rel: text_of(row, "rel")?,
                    anchor: centraid_ontology::graph::selector_of(
                        text_of(row, "anchor"),
                        text_of(row, "wikilink").as_deref(),
                    ),
                })
            })
            .collect())
    }

    fn column_rows(
        &self,
        link: &ColumnLink,
        end: End,
        ids: &[String],
    ) -> KitResult<Vec<(String, String)>> {
        let select = format!("id, {}", link.column);
        let (name, column) = match end {
            End::To => ("graph.column.in", link.column),
            End::From => ("graph.column.out", "id"),
        };
        let rows = Lookup {
            name,
            table: link.table,
            select: &select,
            order: ("id", "id"),
            column,
        }
        .read(self.door, self.bound, ids, None)?;
        Ok(rows
            .iter()
            .filter_map(|row| Some((text_of(row, "id")?, text_of(row, link.column)?)))
            .collect())
    }
}

/// The joins that END at `id`, by `rels` (edge relations) and by every column of
/// the catalogue that points at a kind named `to_kind`.
///
/// # Errors
///
/// The kit's own refusals; a door's refusal is `KitError::Door`.
pub fn incoming(
    door: &dyn PageDoor,
    bound: FanOutBound,
    id: &str,
    to_kind: &str,
    rels: &[&str],
) -> KitResult<Vec<Joined>> {
    graph::incoming(&DoorSource::new(door, bound), id, to_kind, rels)
}

/// The joins that START at any of `ids`, which are all of kind `from_kind`: by
/// `rels` (edge relations) and by the columns of that kind's own row.
///
/// # Errors
///
/// The kit's own refusals; a door's refusal is `KitError::Door`.
pub fn outgoing(
    door: &dyn PageDoor,
    bound: FanOutBound,
    ids: &[String],
    from_kind: &str,
    rels: &[&str],
) -> KitResult<Vec<Joined>> {
    graph::outgoing(&DoorSource::new(door, bound), ids, from_kind, rels)
}
