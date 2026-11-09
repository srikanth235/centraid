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

use centraid_ontology::graph::COLUMN_LINKS;
pub use centraid_ontology::graph::Via;

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
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Joined {
    pub from: String,
    pub to: String,
    /// The edge's `rel`, or the column's relation word.
    pub relation: String,
    pub via: Via,
}

/// `column IN ids` over one table, under the caller's own predicate, to the end of the bound.
fn read_in(
    door: &dyn PageDoor,
    bound: FanOutBound,
    name: &str,
    table: &str,
    select: &str,
    order: (&str, &str),
    column: &str,
    ids: &[String],
    extra: Option<(String, Vec<PageBindValue>)>,
) -> KitResult<Vec<Row>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let fragment = in_list(column, ids)?;
    let (predicate, bind) = match extra {
        Some((clause, mut bind)) => {
            bind.extend(fragment.bind);
            (format!("{clause} AND {}", fragment.sql), bind)
        }
        None => (fragment.sql, fragment.bind),
    };
    read_pages(
        door,
        &PageQuery::new(name, select, table, PageOrder::asc(order.0, order.1))
            .filter(&predicate, bind),
        bound,
    )
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
    let ids = [id.to_owned()];
    let mut out = Vec::new();
    if !rels.is_empty() {
        let (clause, bind) = rel_clause(rels);
        for row in read_in(
            door,
            bound,
            "graph.in",
            "edge",
            "from_id, to_id, rel",
            ("to_id", "from_id"),
            "to_id",
            &ids,
            Some((clause, bind)),
        )? {
            if let (Some(from), Some(to), Some(relation)) = (
                text_of(&row, "from_id"),
                text_of(&row, "to_id"),
                text_of(&row, "rel"),
            ) {
                out.push(Joined {
                    from,
                    to,
                    relation,
                    via: Via::Edge,
                });
            }
        }
    }
    for link in COLUMN_LINKS.iter().filter(|link| link.to_kind == to_kind) {
        let select = format!("id, {}", link.column);
        for row in read_in(
            door,
            bound,
            "graph.column.in",
            link.table,
            &select,
            ("id", "id"),
            link.column,
            &ids,
            None,
        )? {
            if let Some(from) = text_of(&row, "id") {
                out.push(Joined {
                    from,
                    to: id.to_owned(),
                    relation: link.relation.to_owned(),
                    via: Via::Column,
                });
            }
        }
    }
    out.sort();
    out.dedup();
    Ok(out)
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
    let mut out = Vec::new();
    if !rels.is_empty() && !ids.is_empty() {
        let (clause, bind) = rel_clause(rels);
        for row in read_in(
            door,
            bound,
            "graph.out",
            "edge",
            "from_id, to_id, rel",
            ("from_id", "to_id"),
            "from_id",
            ids,
            Some((clause, bind)),
        )? {
            if let (Some(from), Some(to), Some(relation)) = (
                text_of(&row, "from_id"),
                text_of(&row, "to_id"),
                text_of(&row, "rel"),
            ) {
                out.push(Joined {
                    from,
                    to,
                    relation,
                    via: Via::Edge,
                });
            }
        }
    }
    for link in COLUMN_LINKS.iter().filter(|link| link.table == from_kind) {
        let select = format!("id, {}", link.column);
        for row in read_in(
            door,
            bound,
            "graph.column.out",
            link.table,
            &select,
            ("id", "id"),
            "id",
            ids,
            None,
        )? {
            if let (Some(from), Some(to)) = (text_of(&row, "id"), text_of(&row, link.column)) {
                out.push(Joined {
                    from,
                    to,
                    relation: link.relation.to_owned(),
                    via: Via::Column,
                });
            }
        }
    }
    out.sort();
    out.dedup();
    Ok(out)
}
