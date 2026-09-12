//! PAGED READS, AS AN APP WRITES THEM (#996 rulings R8 and W4-D2).
//!
//! Ported from `packages/blueprints/apps/_shared/paged-reads.ts`. A door hands
//! back ONE page, because a handler that could ask for everything is a handler
//! somebody eventually will. What an app wants on top of that is one of two
//! things, and both are here so neither is re-invented per app:
//!
//! - **A join over a set already bounded.** The set is bounded by the window,
//!   not by the table, so the read is finite and the only honest way to fetch it
//!   is [`read_pages`], which walks until the pages run out. The walk is capped,
//!   and the cap is not a silent truncation.
//! - **An `IN` list.** [`in_list`] builds the placeholders and the binds
//!   together so the two cannot get out of step, and refuses an empty set rather
//!   than emitting `IN ()`.
//!
//! **Why this is not the truncation flag with extra steps.** The flag declared
//! that the caller did not care where the answer stopped. A walk states where it
//! stops, states it at the call site, and **errors** rather than returning a
//! short answer that looks whole (`paged-reads.ts:21-24`).

use crate::error::{KitError, KitResult};
use crate::page::{Page, PageRequest};
use crate::row::Row;
use crate::statement::{PageBindValue, PageQuery};

/// The one door an app reads through.
///
/// An app crate depends on this trait and on nothing that holds a file: SQL is
/// confined to `crates/{ontology,vault,seat,search}` and `crates/apps/kit`
/// (#1020 invariant), so `crates/apps/tally` can hold statements-as-data and
/// never a statement. The implementations are the vault's own paged door and,
/// for tests and fixture generation, [`crate::testdoor`].
pub trait PageDoor {
    /// One page of one statement, under the caller's principal. The principal
    /// is the implementation's business: a door that needs one holds it.
    fn page(&self, query: &PageQuery, request: &PageRequest) -> KitResult<Page<Row>>;
}

/// One `IN (…)` fragment and the binds it takes, built together.
#[derive(Debug, Clone, PartialEq)]
pub struct InListFragment {
    /// `column IN (?, ?, ?)`.
    pub sql: String,
    pub bind: Vec<PageBindValue>,
}

/// An `IN` over a bounded set of ids.
///
/// Refuses an empty set: `IN ()` matches nothing, which is the right ANSWER for
/// an empty set and the wrong SHAPE for a handler to have written — the caller
/// should not be reading at all (`paged-reads.ts:36-43`).
pub fn in_list(column: &str, ids: &[String]) -> KitResult<InListFragment> {
    if ids.is_empty() {
        return Err(KitError::EmptyInList {
            column: column.to_owned(),
        });
    }
    let placeholders = vec!["?"; ids.len()].join(", ");
    Ok(InListFragment {
        sql: format!("{column} IN ({placeholders})"),
        bind: ids
            .iter()
            .map(|id| PageBindValue::Text(id.clone()))
            .collect(),
    })
}

/// How far a fan-out may walk before it is a question about an unbounded set.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FanOutBound {
    /// Rows per page.
    pub page_size: usize,
    /// Pages, at most. `page_size * fan_out_pages` is the stated ceiling.
    pub fan_out_pages: usize,
}

impl FanOutBound {
    pub const fn new(page_size: usize, fan_out_pages: usize) -> Self {
        Self {
            page_size,
            fan_out_pages,
        }
    }

    pub const fn cap(&self) -> usize {
        self.page_size * self.fan_out_pages
    }
}

/// The default fan-out: 500 rows a page, eight pages, so 4,000 joined rows
/// (`paged-reads.ts:62`).
pub const JOIN_FAN_OUT: FanOutBound = FanOutBound::new(500, 8);

/// THE ROW A SCREEN WAS OPENED ON.
///
/// Half the reads in these apps are "the one row this id names", and written out
/// as a page each is eleven lines of order clause for a set whose size is one.
/// The window is 1 and the ORDER BY is the primary key, so the cursor is
/// degenerate ON PURPOSE: there is no second page to reach
/// (`paged-reads.ts:75-82`).
pub fn read_by_id(
    door: &dyn PageDoor,
    name: &str,
    select: &str,
    from: &str,
    id_column: &str,
    id: &str,
) -> KitResult<Option<Row>> {
    let query = PageQuery::new(
        name,
        select,
        from,
        crate::statement::PageOrder::asc(id_column, id_column),
    )
    .filter(
        &format!("{id_column} = ?"),
        vec![PageBindValue::Text(id.to_owned())],
    );
    let page = door.page(&query, &PageRequest::first(1))?;
    Ok(page.rows.into_iter().next())
}

/// Walk a handler's pages to the end of a bounded set.
///
/// The cap **errors**. Returning what it had would be the truncation flag again:
/// a short answer that reads as a whole one, with the app deciding what to do
/// about a fact it was never told (`paged-reads.ts:106-112`). v0 throws; the
/// port returns `Err(KitError::FanOutExceeded)`, and the member-visible outcome
/// is the same — the surface renders the failure, not a wrong number.
pub fn read_pages(
    door: &dyn PageDoor,
    query: &PageQuery,
    bound: FanOutBound,
) -> KitResult<Vec<Row>> {
    let mut rows = Vec::new();
    let mut after = None;
    for _ in 0..bound.fan_out_pages {
        // A keyset walk is sequential BY CONSTRUCTION: page n+1's cursor is
        // page n's last row, so there is nothing here to run concurrently.
        let request = PageRequest {
            limit: bound.page_size,
            after: after.clone(),
        };
        let page = door.page(query, &request)?;
        rows.extend(page.rows);
        match page.next {
            None => return Ok(rows),
            Some(next) => after = Some(next),
        }
    }
    Err(KitError::FanOutExceeded {
        query: query.name.clone(),
        cap: bound.cap(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_in_list_is_not_a_read() {
        assert!(matches!(
            in_list("party_id", &[]),
            Err(KitError::EmptyInList { .. })
        ));
    }

    #[test]
    fn in_list_builds_placeholders_and_binds_together() {
        let fragment = in_list("party_id", &["a".to_owned(), "b".to_owned()]).unwrap();
        assert_eq!(fragment.sql, "party_id IN (?, ?)");
        assert_eq!(fragment.bind.len(), 2);
    }

    #[test]
    fn the_stated_ceiling_is_page_size_times_pages() {
        assert_eq!(JOIN_FAN_OUT.cap(), 4_000);
    }
}
