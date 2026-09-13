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
use crate::page::{MAX_PAGE_ROWS, Page, PageRequest};
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

    /// The rows a page of this bound actually returns.
    ///
    /// `MAX_PAGE_ROWS` is a ceiling that **clamps** rather than refusing
    /// (`packages/core/src/page/window.ts:64-78`), so a bound asking for more
    /// per page silently gets 500.
    pub const fn reachable_page_size(&self) -> usize {
        if self.page_size < MAX_PAGE_ROWS {
            self.page_size
        } else {
            MAX_PAGE_ROWS
        }
    }

    /// The rows this bound can REACH before it errors.
    ///
    /// **This is a v0 finding, not a restatement** (D-1020-D3-12). v0 computes
    /// its ceiling as `pageSize * fanOutPages`
    /// (`paged-reads.ts:57`, `:136`) and its walk asks for `pageSize` per page
    /// — but the window clamps at `MAX_PAGE_ROWS`, so a bound with a page size
    /// over 500 reaches only `500 * fanOutPages` rows and then throws a message
    /// naming a number twice as large as the one it stopped at. Tally declares
    /// `LEDGER_FAN_OUT = {pageSize: 1000, fanOutPages: 8}` and states 8,000
    /// rows; it reaches 4,000. At 2,000 expenses with four sharers each — the
    /// window Tally's own ceiling is stated at — `loadTally` throws.
    ///
    /// A cap that lies about its own size is worse than a smaller cap, so this
    /// reports the reachable number and the error quotes it.
    pub const fn cap(&self) -> usize {
        self.reachable_page_size() * self.fan_out_pages
    }
}

/// The default fan-out: 500 rows a page, eight pages, so 4,000 joined rows
/// (`paged-reads.ts:62`). v0's own default is already at the window's ceiling,
/// which is why the arithmetic above is invisible until an app raises it.
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

/// A stated window, and whether it filled.
#[derive(Debug, Clone, PartialEq)]
pub struct Window {
    /// At most the requested number of rows, in the statement's own order.
    pub rows: Vec<Row>,
    /// `true` when the set is longer than the window — so a surface can say
    /// "this ledger is longer than what was read" rather than implying it read
    /// all of it.
    pub filled: bool,
}

/// Read a stated window of `rows`, whatever `MAX_PAGE_ROWS` is.
///
/// **This is the second half of the v0 finding in [`FanOutBound::cap`], and the
/// worse half** (D-1020-D3-12). `MAX_PAGE_ROWS` clamps a page to 500, and v0's
/// `loadTally` asks for its 2,000-row ledger window as ONE page and takes
/// `.rows` (`queries/dashboard.ts:267-280`) — so the dashboard reads **500
/// expenses while declaring 2,000**, discards the `next` cursor that says there
/// are more, and folds a BALANCE over what it got. That is exactly the failure
/// its own doctrine names four lines earlier: "a balance derived from a
/// silently short ledger is a WRONG NUMBER — not a slow screen"
/// (`:45-51`). Verified: at the year-3 Tally profile the ported statement
/// returns 500 of 1,960 live expenses in one page.
///
/// A window is a clamp for a LIST, where a member who scrolled fast is not
/// doing anything wrong. It cannot be a clamp for a FOLD. So a stated window is
/// walked to its stated size, and whether it filled is part of the answer.
pub fn read_window(door: &dyn PageDoor, query: &PageQuery, rows: usize) -> KitResult<Window> {
    let mut collected: Vec<Row> = Vec::new();
    let mut after = None;
    while collected.len() < rows {
        let want = (rows - collected.len()).min(MAX_PAGE_ROWS);
        let page = door.page(
            query,
            &PageRequest {
                limit: want,
                after: after.clone(),
            },
        )?;
        let short = page.rows.len() < want;
        collected.extend(page.rows);
        match page.next {
            // The rows ended inside the window: it did not fill.
            None => {
                return Ok(Window {
                    rows: collected,
                    filled: false,
                });
            }
            Some(next) => {
                if short {
                    // A page shorter than asked for with a cursor is a door
                    // that clamped below `MAX_PAGE_ROWS`; continuing would
                    // loop. Treat the window as filled and say so.
                    return Ok(Window {
                        rows: collected,
                        filled: true,
                    });
                }
                after = Some(next);
            }
        }
    }
    Ok(Window {
        rows: collected,
        filled: true,
    })
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

    /// A DEMONSTRATED RED for the worse half of D-1020-D3-12: one page of a
    /// 1,000-row window returns 500 rows and a cursor, which is what v0 takes
    /// and folds a balance over. `read_window` walks it.
    #[test]
    fn a_stated_window_is_walked_rather_than_clamped() {
        use crate::statement::PageOrder;
        use crate::testdoor::TestDoor;

        let connection = rusqlite::Connection::open_in_memory().expect("a database opens");
        connection
            .execute_batch(
                "CREATE TABLE t (pk TEXT PRIMARY KEY NOT NULL) STRICT;
                 WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1200)
                 INSERT INTO t SELECT printf('pk-%04d', i) FROM n;",
            )
            .expect("1,200 rows are seeded");
        let door = TestDoor::new(&connection);
        let statement = PageQuery::new("kit.window", "pk", "t", PageOrder::asc("pk", "pk"));

        // What v0 does: ask for the window as one page and take the rows.
        let clamped = door
            .page(&statement, &PageRequest::first(1_000))
            .expect("the door answers");
        assert_eq!(
            clamped.rows.len(),
            MAX_PAGE_ROWS,
            "a 1,000-row window is clamped to 500 in ONE page"
        );
        assert!(
            clamped.next.is_some(),
            "and the cursor that says there are more is the thing v0 discards"
        );

        // What the port does: walk the stated window to its stated size.
        let walked = read_window(&door, &statement, 1_000).expect("the window walks");
        assert_eq!(walked.rows.len(), 1_000);
        assert!(walked.filled, "1,200 rows is longer than the window");

        // And a window longer than the set does not fill, which is how a
        // surface tells "all of it" from "the first N of it".
        let whole = read_window(&door, &statement, 5_000).expect("the window walks");
        assert_eq!(whole.rows.len(), 1_200);
        assert!(!whole.filled);
    }

    #[test]
    fn the_stated_ceiling_is_the_reachable_one() {
        assert_eq!(JOIN_FAN_OUT.cap(), 4_000);
        // A DEMONSTRATED RED for D-1020-D3-12: v0 would call this 8,000, walk
        // 500 rows a page, reach 4,000 and throw a sentence naming 8,000.
        let v0s_ledger_fan_out = FanOutBound::new(1_000, 8);
        assert_eq!(v0s_ledger_fan_out.reachable_page_size(), MAX_PAGE_ROWS);
        assert_eq!(
            v0s_ledger_fan_out.cap(),
            4_000,
            "a cap must not name a number it cannot reach"
        );
    }
}
