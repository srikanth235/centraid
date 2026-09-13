//! THE STATEMENT, AS DATA (#996 rulings R8 and W4-D2, ported for #1020).
//!
//! A handler holds neither a closure nor a pre-assembled string, because the
//! same shape is executed by three things — the seat in process, the shell
//! across a message seam, and the gateway through the paged door — and a closure
//! survives none of them while a string survives the first two but cannot be
//! checked at the third (`packages/core/src/page/statement.ts:14-19`).
//!
//! **One assembler for all three ends.** Three assemblers would be three keyset
//! dialects, and the one that drifted would drift silently at a page boundary
//! where nobody looks (`statement.ts:88-92`). [`page_statement`] is that one
//! assembler, and the only place in this workspace that emits a SELECT for an
//! app.

use crate::error::{KitError, KitResult};
use crate::page::{PageCursor, PageRequest, probe_limit};
use crate::row::Row;

/// What a statement's placeholders may be bound to. v0's `PageBindValue` is
/// `string | number | null`; the two number kinds are split here because SQLite
/// binds them differently and an `i64` that arrived as a JSON integer must not
/// go back out as a float.
#[derive(Debug, Clone, PartialEq)]
pub enum PageBindValue {
    Text(String),
    Integer(i64),
    Real(f64),
    Null,
}

impl From<&str> for PageBindValue {
    fn from(value: &str) -> Self {
        Self::Text(value.to_owned())
    }
}

impl From<String> for PageBindValue {
    fn from(value: String) -> Self {
        Self::Text(value)
    }
}

impl From<i64> for PageBindValue {
    fn from(value: i64) -> Self {
        Self::Integer(value)
    }
}

/// The ORDER BY, as the columns the keyset compares.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageOrder {
    pub sort_column: String,
    /// The tiebreak. The sort key is not unique; the primary key is.
    pub pk_column: String,
    pub descending: bool,
}

impl PageOrder {
    pub fn asc(sort_column: &str, pk_column: &str) -> Self {
        Self {
            sort_column: sort_column.to_owned(),
            pk_column: pk_column.to_owned(),
            descending: false,
        }
    }

    pub fn desc(sort_column: &str, pk_column: &str) -> Self {
        Self {
            sort_column: sort_column.to_owned(),
            pk_column: pk_column.to_owned(),
            descending: true,
        }
    }
}

/// One handler's statement, minus the parts the host owns.
///
/// There is **no `key_of`**: the cursor is read off the row by the same two
/// columns the ORDER BY names — one declaration, so the walk and the cursor
/// cannot disagree — which also means `select` MUST carry both of them
/// (`statement.ts:43-48`).
#[derive(Debug, Clone, PartialEq)]
pub struct PageQuery {
    /// Names the handler in the work-counter row and the plan snapshot.
    pub name: String,
    /// The projection. Must include the order's two columns.
    pub select: String,
    /// The table, with any JOINs a page of it needs.
    pub from: String,
    /// The handler's own predicate. `None` means every row of `from`.
    pub r#where: Option<String>,
    /// Binds the statement's own placeholders take, before the keyset's.
    pub bind: Vec<PageBindValue>,
    pub order: PageOrder,
}

impl PageQuery {
    /// A statement with no predicate and no binds.
    pub fn new(name: &str, select: &str, from: &str, order: PageOrder) -> Self {
        Self {
            name: name.to_owned(),
            select: select.to_owned(),
            from: from.to_owned(),
            r#where: None,
            bind: Vec::new(),
            order,
        }
    }

    /// The handler's own predicate and the binds it takes, set together so the
    /// two cannot get out of step.
    pub fn filter(mut self, r#where: &str, bind: Vec<PageBindValue>) -> Self {
        self.r#where = Some(r#where.to_owned());
        self.bind = bind;
        self
    }
}

/// The cursor of one row, by the columns its handler orders on.
///
/// Two refusals, and they differ: a **non-text pk** is v0's throw
/// (`statement.ts:73-76`), and a **column the projection never carried** is
/// where v0 reads `undefined`, stringifies it and hands back the cursor
/// `"undefined"`. The port refuses that instead — a cursor over a column the
/// page did not select is not a continuation of anything.
pub fn page_cursor_of(query_name: &str, row: &Row, order: &PageOrder) -> KitResult<PageCursor> {
    let sort_cell = row
        .get(&order.sort_column)
        .ok_or_else(|| KitError::CursorColumnMissing {
            query: query_name.to_owned(),
            column: order.sort_column.clone(),
        })?;
    let pk_cell = row
        .get(&order.pk_column)
        .ok_or_else(|| KitError::CursorColumnMissing {
            query: query_name.to_owned(),
            column: order.pk_column.clone(),
        })?;
    let pk = pk_cell
        .text()
        .ok_or_else(|| KitError::CursorPkNotText {
            column: order.pk_column.clone(),
            found: pk_cell.type_name().to_owned(),
        })?
        .to_owned();
    Ok(PageCursor {
        // NULL collapses to the empty string, exactly as `statement.ts:77`.
        sort_key: sort_cell.to_cursor_text(),
        pk,
    })
}

/// The cursor of the LAST row of a page — the one that becomes a boundary.
///
/// Everything [`page_cursor_of`] does, plus the one refusal a boundary needs
/// and a row's own cursor does not: **a NULL sort key cannot be a page
/// boundary** (D-1020-D3-10; [`KitError::NullableSortKey`] has the table of
/// what v0 drops). The two functions are separate because reading a row's
/// cursor is a value question and continuing from it is a correctness one, and
/// only the second can be wrong.
///
/// This catches the boundary ROW being NULL. It does not catch a valued
/// boundary with NULL rows still owed after it, which is the descending case —
/// only a door that can read the column's nullability catches that, and
/// [`crate::testdoor::TestDoor`] does.
pub fn page_cursor_boundary(
    query_name: &str,
    row: &Row,
    order: &PageOrder,
) -> KitResult<PageCursor> {
    if matches!(row.get(&order.sort_column), Some(crate::row::Cell::Null)) {
        return Err(KitError::NullableSortKey {
            query: query_name.to_owned(),
            column: order.sort_column.clone(),
            detail: "the last row of this page has no sort key",
        });
    }
    page_cursor_of(query_name, row, order)
}

/// A handler's statement, assembled: the text and the binds, in order.
#[derive(Debug, Clone, PartialEq)]
pub struct PageStatement {
    pub sql: String,
    pub bind: Vec<PageBindValue>,
}

/// The paged door's one splice point: the row filters of every table the
/// statement names, compiled by the vault and ANDed in with the handler's own
/// predicate. Never reachable from a handler.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ExtraWhere {
    pub sql: String,
    pub bind: Vec<PageBindValue>,
}

/// The page's ordering, with the tiebreaker stated ONCE.
///
/// A handler that sorts on its own primary key names the same column twice, and
/// `ORDER BY id, id` is not free: SQLite satisfies the first term from an index
/// and then builds a temp B-tree for the last term, a sort of one-row groups
/// that answers nothing — four of the plans in v0's snapshot printed exactly
/// that (`statement.ts:104-112`).
fn order_by(sort_column: &str, pk_column: &str, direction: &str) -> String {
    if sort_column == pk_column {
        format!("{pk_column} {direction}")
    } else {
        format!("{sort_column} {direction}, {pk_column} {direction}")
    }
}

/// Assemble one handler's statement for one request.
///
/// **The keyset is a row value.** `(sort, pk) < (?, ?)` is what SQLite turns
/// into an index seek; the equivalent `sort < ? OR (sort = ? AND pk < ?)` is
/// what an optimiser has to be talked into, and the difference is a scan from
/// the top of the index on every page (`statement.ts:93-98`).
pub fn page_statement(
    query: &PageQuery,
    request: &PageRequest,
    extra: Option<&ExtraWhere>,
) -> KitResult<PageStatement> {
    let PageOrder {
        sort_column,
        pk_column,
        descending,
    } = &query.order;
    let direction = if *descending { "DESC" } else { "ASC" };
    let comparison = if *descending { "<" } else { ">" };
    // The first page carries NO predicate rather than a tautological one, and
    // the handler's own `where` decides whether the keyset needs an `AND`.
    let keyset = request
        .after
        .as_ref()
        .map(|_| format!("({sort_column}, {pk_column}) {comparison} (?, ?)"));

    let mut predicates: Vec<&str> = Vec::new();
    if let Some(own) = query.r#where.as_deref().filter(|part| !part.is_empty()) {
        predicates.push(own);
    }
    if let Some(extra) = extra.filter(|extra| !extra.sql.is_empty()) {
        predicates.push(&extra.sql);
    }
    if let Some(keyset) = keyset.as_deref() {
        predicates.push(keyset);
    }

    // Bind order follows the text: the handler's own placeholders, then the
    // door's row filters, then the keyset, then the probe limit.
    let mut bind = query.bind.clone();
    if let Some(extra) = extra {
        bind.extend(extra.bind.iter().cloned());
    }
    if let Some(after) = request.after.as_ref() {
        bind.push(PageBindValue::Text(after.sort_key.clone()));
        bind.push(PageBindValue::Text(after.pk.clone()));
    }
    let probe = probe_limit(request)?;
    bind.push(PageBindValue::Integer(
        i64::try_from(probe).expect("the probe is at most MAX_PAGE_ROWS + 1"),
    ));

    let predicate = if predicates.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", predicates.join(" AND "))
    };
    Ok(PageStatement {
        sql: format!(
            "SELECT {select}\n      FROM {from}\n      {predicate}\n      ORDER BY {order}\n      LIMIT ?",
            select = query.select,
            from = query.from,
            order = order_by(sort_column, pk_column, direction),
        ),
        bind,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::row::Cell;

    fn query() -> PageQuery {
        PageQuery::new(
            "kit.test",
            "expense_id, spent_on",
            "tally_expense",
            PageOrder::desc("spent_on", "expense_id"),
        )
    }

    #[test]
    fn the_first_page_carries_no_predicate() {
        let statement = page_statement(&query(), &PageRequest::first(10), None).unwrap();
        assert!(!statement.sql.contains("WHERE"));
        assert_eq!(statement.bind, vec![PageBindValue::Integer(11)]);
    }

    #[test]
    fn the_keyset_is_a_row_value_comparison() {
        let request = PageRequest::after(
            10,
            PageCursor {
                sort_key: "2026-01-01".to_owned(),
                pk: "expense-9".to_owned(),
            },
        );
        let statement = page_statement(&query(), &request, None).unwrap();
        assert!(statement.sql.contains("(spent_on, expense_id) < (?, ?)"));
        // Never the equivalent disjunction.
        assert!(!statement.sql.contains(" OR "));
        assert_eq!(
            statement.bind,
            vec![
                PageBindValue::Text("2026-01-01".to_owned()),
                PageBindValue::Text("expense-9".to_owned()),
                PageBindValue::Integer(11),
            ]
        );
    }

    #[test]
    fn sort_equals_pk_emits_one_order_term() {
        let one = PageQuery::new(
            "kit.test",
            "expense_id",
            "tally_expense",
            PageOrder::asc("expense_id", "expense_id"),
        );
        let statement = page_statement(&one, &PageRequest::first(1), None).unwrap();
        assert!(statement.sql.contains("ORDER BY expense_id ASC\n"));
        assert!(!statement.sql.contains("expense_id ASC, expense_id"));
    }

    #[test]
    fn bind_order_is_handler_then_door_then_keyset_then_probe() {
        let mut q = query();
        q.r#where = Some("group_id = ?".to_owned());
        q.bind = vec![PageBindValue::Text("group-1".to_owned())];
        let request = PageRequest::after(
            5,
            PageCursor {
                sort_key: "s".to_owned(),
                pk: "p".to_owned(),
            },
        );
        let extra = ExtraWhere {
            sql: "(deleted_at IS NULL)".to_owned(),
            bind: vec![PageBindValue::Integer(7)],
        };
        let statement = page_statement(&q, &request, Some(&extra)).unwrap();
        assert_eq!(
            statement.bind,
            vec![
                PageBindValue::Text("group-1".to_owned()),
                PageBindValue::Integer(7),
                PageBindValue::Text("s".to_owned()),
                PageBindValue::Text("p".to_owned()),
                PageBindValue::Integer(6),
            ]
        );
        assert!(
            statement
                .sql
                .contains("WHERE group_id = ? AND (deleted_at IS NULL) AND (spent_on, expense_id)")
        );
    }

    #[test]
    fn a_cursor_over_an_unprojected_column_is_refused() {
        let mut row = Row::new();
        row.insert("expense_id".to_owned(), Cell::Text("e-1".to_owned()));
        let order = PageOrder::desc("spent_on", "expense_id");
        assert!(matches!(
            page_cursor_of("kit.test", &row, &order),
            Err(KitError::CursorColumnMissing { .. })
        ));
    }

    #[test]
    fn a_non_text_pk_is_refused_and_a_null_sort_key_is_not() {
        let mut row = Row::new();
        row.insert("spent_on".to_owned(), Cell::Null);
        row.insert("expense_id".to_owned(), Cell::Integer(1));
        let order = PageOrder::desc("spent_on", "expense_id");
        assert!(matches!(
            page_cursor_of("kit.test", &row, &order),
            Err(KitError::CursorPkNotText { .. })
        ));
        row.insert("expense_id".to_owned(), Cell::Text("e-1".to_owned()));
        assert_eq!(
            page_cursor_of("kit.test", &row, &order).unwrap(),
            PageCursor {
                sort_key: String::new(),
                pk: "e-1".to_owned()
            }
        );
    }
}
