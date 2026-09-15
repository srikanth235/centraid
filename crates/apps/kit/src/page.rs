//! THE PAGE (#996 ruling R8, ported verbatim for #1020).
//!
//! One shape, used by every app on every seat, and there is no unpaged variant
//! of it. Ported from `packages/core/src/page/window.ts`, which states the three
//! rules this module keeps:
//!
//! 1. **`limit` is required, no default.** "A default is how an unbounded read
//!    gets written by accident" (`window.ts:43-44`). It replaced roughly two
//!    hundred unbounded reads. In Rust the type cannot make a field required
//!    *and* absent, so `PageRequest` has no `Default` and no builder that omits
//!    it — a window is constructed by naming its size.
//! 2. **Keyset, never offset** (`window.ts:15-18`). The cursor is the sort key
//!    itself, so a continuation is one index seek; nothing handed to a caller
//!    can be turned back into an offset.
//! 3. **The pk is in the key because the sort key is not unique**
//!    (`window.ts:20-24`). Two rows can share a timestamp; keyed on the
//!    timestamp alone a page boundary silently repeats or drops one.

use crate::error::{KitError, KitResult};

/// Where a page stopped: the last row's sort key and primary key.
///
/// **Typed-but-stringified, on purpose and for now.** v0's cursor is two
/// strings (`window.ts:37`) and the sort key is `String(value)` whatever the
/// column's type was, compared by SQLite under the column's own affinity. That
/// happens to work and is written down nowhere (#1020, apps seam 7). The port
/// keeps the shape byte-for-byte because the parity fixtures compare cursors;
/// a typed, versioned, opaque cursor is a finding filed against this lane, not
/// a change made inside it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct PageCursor {
    #[serde(rename = "sortKey")]
    pub sort_key: String,
    pub pk: String,
}

/// A window, and where to start it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageRequest {
    pub limit: usize,
    /// `None` means the first page.
    pub after: Option<PageCursor>,
}

impl PageRequest {
    /// The first page of `limit` rows.
    pub fn first(limit: usize) -> Self {
        Self { limit, after: None }
    }

    /// The page after `cursor`.
    pub fn after(limit: usize, cursor: PageCursor) -> Self {
        Self {
            limit,
            after: Some(cursor),
        }
    }
}

/// One page of rows, and the cursor to continue from.
///
/// `next` is **`None` when the rows ended** — never a `truncated` boolean. The
/// two states a caller has to tell apart are "continue from here" and "there is
/// nothing after this", and a cursor is exactly that pair (`window.ts:52-58`).
#[derive(Debug, Clone, PartialEq)]
pub struct Page<Row> {
    pub rows: Vec<Row>,
    pub next: Option<PageCursor>,
}

/// The handler host's one measured safety net: a CEILING that clamps, not a
/// policy that refuses (`window.ts:64-78`). Five hundred rows is two orders of
/// magnitude over the largest screenful any first-party app draws.
pub const MAX_PAGE_ROWS: usize = 500;

/// The number of rows a handler asks the store for: the window plus ONE.
///
/// That extra row is the probe, and it is the only thing separating "the window
/// filled" from "the rows ended here" (`window.ts:80-88`). It is dropped in
/// [`page_of`] and never reaches a caller.
pub fn probe_limit(request: &PageRequest) -> KitResult<usize> {
    if request.limit < 1 {
        return Err(KitError::BadLimit {
            limit: request.limit,
        });
    }
    Ok(request.limit.min(MAX_PAGE_ROWS) + 1)
}

/// The page a store's [`probe_limit`] rows make: the probe dropped, and the
/// cursor derived from the last row that survived.
///
/// `key_of` is the handler's own ORDER BY restated as a function, so the cursor
/// and the ordering come from one place rather than two that can drift apart.
pub fn page_of<Row, F>(fetched: Vec<Row>, request: &PageRequest, key_of: F) -> KitResult<Page<Row>>
where
    F: Fn(&Row) -> KitResult<PageCursor>,
{
    if request.limit < 1 {
        return Err(KitError::BadLimit {
            limit: request.limit,
        });
    }
    let window = request.limit.min(MAX_PAGE_ROWS);
    let filled = fetched.len() > window;
    let mut rows = fetched;
    rows.truncate(window);
    let next = match (filled, rows.last()) {
        (true, Some(last)) => Some(key_of(last)?),
        _ => None,
    };
    Ok(Page { rows, next })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(row: &(String, String)) -> KitResult<PageCursor> {
        Ok(PageCursor {
            sort_key: row.0.clone(),
            pk: row.1.clone(),
        })
    }

    #[test]
    fn a_zero_window_is_refused_by_both_ends() {
        let request = PageRequest::first(0);
        assert!(matches!(
            probe_limit(&request),
            Err(KitError::BadLimit { limit: 0 })
        ));
        assert!(matches!(
            page_of(Vec::<(String, String)>::new(), &request, key),
            Err(KitError::BadLimit { limit: 0 })
        ));
    }

    #[test]
    fn the_probe_is_the_window_plus_one_and_the_ceiling_clamps() {
        assert_eq!(probe_limit(&PageRequest::first(10)).unwrap(), 11);
        assert_eq!(probe_limit(&PageRequest::first(10_000)).unwrap(), 501);
    }

    #[test]
    fn next_is_absent_when_the_rows_ended() {
        let rows = vec![("a".to_owned(), "1".to_owned())];
        let page = page_of(rows, &PageRequest::first(2), key).unwrap();
        assert_eq!(page.rows.len(), 1);
        assert_eq!(page.next, None);
    }

    #[test]
    fn the_probe_row_is_dropped_and_becomes_the_cursor_of_the_last_survivor() {
        let rows = vec![
            ("a".to_owned(), "1".to_owned()),
            ("b".to_owned(), "2".to_owned()),
            ("c".to_owned(), "3".to_owned()),
        ];
        let page = page_of(rows, &PageRequest::first(2), key).unwrap();
        assert_eq!(page.rows.len(), 2);
        assert_eq!(
            page.next,
            Some(PageCursor {
                sort_key: "b".to_owned(),
                pk: "2".to_owned()
            })
        );
    }
}
