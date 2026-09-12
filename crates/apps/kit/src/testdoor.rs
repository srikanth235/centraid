//! THE TEST DOOR — the only place in the app plane that holds a connection.
//!
//! **Why here and not in `crates/apps/tally`.** SQL appears only under
//! `crates/{ontology,vault,seat,search}` and `crates/apps/kit` (#1020
//! invariant, enforced by `cargo xtask rules`' `sql-confinement`). An app crate
//! holds statements-as-data and never a statement, so the door an app's tests
//! read through has to live on this side of that line. `cargo xtask gate` is
//! what keeps the claim true rather than this comment.
//!
//! **What it is not.** It is not the paged door. It runs the grammar
//! ([`crate::grammar::parse`]) so a statement outside it is refused at the same
//! place, and it applies no access decision: it is the OWNER's view — no row
//! filter, no field mask — which is exactly the identity v0's parity fixtures
//! are generated under, and exactly what makes the two comparable. A door that
//! resolves entities, evaluates access and compiles row filters is
//! `crates/vault`'s, and when it lands an app changes nothing but which
//! [`PageDoor`] it is handed.

use rusqlite::Connection;
use rusqlite::types::ValueRef;

use crate::error::{KitError, KitResult};
use crate::grammar;
use crate::page::{Page, PageRequest, page_of};
use crate::reads::PageDoor;
use crate::row::{Cell, Row};
use crate::statement::{PageBindValue, PageQuery, page_cursor_boundary, page_statement};

/// A door over one open connection.
pub struct TestDoor<'connection> {
    connection: &'connection Connection,
}

impl<'connection> TestDoor<'connection> {
    pub fn new(connection: &'connection Connection) -> Self {
        Self { connection }
    }

    /// The connection, for the fixture generators that seed through it.
    pub fn connection(&self) -> &Connection {
        self.connection
    }

    /// Refuse a continued page whose sort column can be NULL.
    ///
    /// A sort term the door cannot resolve to one physical column — an
    /// expression, or a name no table in the statement owns — counts as
    /// nullable: the door cannot prove it is not, and "cannot prove" is not
    /// "is fine" for a check whose failure mode is a short ledger.
    fn refuse_nullable_sort(
        &self,
        query: &PageQuery,
        shape: &grammar::StatementShape,
    ) -> KitResult<()> {
        let refuse = |detail: &'static str| KitError::NullableSortKey {
            query: query.name.clone(),
            column: query.order.sort_column.clone(),
            detail,
        };
        let (alias, column) = match query.order.sort_column.split_once('.') {
            Some((alias, column)) => (Some(alias), column),
            None => (None, query.order.sort_column.as_str()),
        };
        if !column
            .chars()
            .all(|char| char.is_ascii_alphanumeric() || char == '_')
        {
            return Err(refuse("the sort term is an expression, not a column"));
        }
        let mut owners = 0usize;
        let mut not_null = false;
        for table in &shape.tables {
            if alias.is_some_and(|alias| alias != table.alias) {
                continue;
            }
            for (name, declared_not_null) in self.columns_of(&table.physical)? {
                if name == column {
                    owners += 1;
                    not_null = declared_not_null;
                }
            }
        }
        match owners {
            0 => Err(refuse("no table in the statement declares that column")),
            1 if not_null => Ok(()),
            1 => Err(refuse("the column is declared without NOT NULL")),
            _ => Err(refuse(
                "more than one table in the statement declares that column",
            )),
        }
    }

    /// `(column, is NOT NULL)` for one physical table.
    fn columns_of(&self, table: &str) -> KitResult<Vec<(String, bool)>> {
        let mut prepared = self
            .connection
            // `table_xinfo` rather than `table_info`: a generated column is
            // still a column a statement can order by.
            .prepare("SELECT name, \"notnull\" FROM pragma_table_xinfo(?)")
            .map_err(|error| KitError::Door(error.to_string()))?;
        let rows = prepared
            .query_map([table], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? == 1))
            })
            .map_err(|error| KitError::Door(error.to_string()))?;
        rows.collect::<Result<Vec<(String, bool)>, _>>()
            .map_err(|error| KitError::Door(error.to_string()))
    }
}

impl PageDoor for TestDoor<'_> {
    fn page(&self, query: &PageQuery, request: &PageRequest) -> KitResult<Page<Row>> {
        // The grammar first, so a statement this door would happily run and the
        // real door would refuse never passes a test.
        let shape = grammar::parse(query)?;
        // Then the one check only a door with the schema in reach can make: a
        // CONTINUED page must order by a NOT NULL column, or it silently drops
        // rows (see `KitError::NullableSortKey`). The first page of a nullable
        // column is sound; it is the continuation that is not, and the boundary
        // `page_cursor_boundary` refuses catches the other half.
        if request.after.is_some() {
            self.refuse_nullable_sort(query, &shape)?;
        }
        let statement = page_statement(query, request, None)?;
        let mut prepared = self
            .connection
            .prepare(&statement.sql)
            .map_err(|error| KitError::Door(format!("{error} in {}", query.name)))?;
        let binds: Vec<rusqlite::types::Value> = statement
            .bind
            .iter()
            .map(|value| match value {
                PageBindValue::Text(text) => rusqlite::types::Value::Text(text.clone()),
                PageBindValue::Integer(number) => rusqlite::types::Value::Integer(*number),
                PageBindValue::Real(number) => rusqlite::types::Value::Real(*number),
                PageBindValue::Null => rusqlite::types::Value::Null,
            })
            .collect();
        let columns: Vec<String> = prepared
            .column_names()
            .into_iter()
            .map(str::to_owned)
            .collect();
        let mut rows = prepared
            .query(rusqlite::params_from_iter(binds))
            .map_err(|error| KitError::Door(format!("{error} in {}", query.name)))?;
        let mut fetched: Vec<Row> = Vec::new();
        while let Some(row) = rows
            .next()
            .map_err(|error| KitError::Door(format!("{error} in {}", query.name)))?
        {
            let mut out = Row::new();
            for (index, column) in columns.iter().enumerate() {
                let cell = match row
                    .get_ref(index)
                    .map_err(|error| KitError::Door(error.to_string()))?
                {
                    ValueRef::Null => Cell::Null,
                    ValueRef::Integer(value) => Cell::Integer(value),
                    ValueRef::Real(value) => Cell::Real(value),
                    ValueRef::Text(bytes) => {
                        Cell::Text(String::from_utf8_lossy(bytes).into_owned())
                    }
                    ValueRef::Blob(bytes) => Cell::Blob(bytes.to_vec()),
                };
                out.insert(column.clone(), cell);
            }
            fetched.push(out);
        }
        // THE PROBE ROW IS THE HOST'S ON THIS SIDE TOO: the statement asked for
        // one row more than the window, and that row must be dropped here
        // rather than handed to a handler, which would report a full set as a
        // short one (`packages/vault/src/gateway/gateway.ts:666-672`).
        page_of(fetched, request, |row| {
            page_cursor_boundary(&query.name, row, &query.order)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::page::PageCursor;
    use crate::reads::{FanOutBound, read_by_id, read_pages};
    use crate::statement::PageOrder;

    fn ledger() -> Connection {
        let connection = Connection::open_in_memory().expect("an in-memory database opens");
        connection
            .execute_batch(
                // `spent_on` is NOT NULL in the vault's own DDL
                // (`contracts/schema/vault-ddl.sql:3699`), and every Tally
                // statement orders on a NOT NULL column for the reason
                // `KitError::NullSortKeyBoundary` states.
                "CREATE TABLE tally_expense (
                   expense_id TEXT PRIMARY KEY,
                   spent_on TEXT NOT NULL,
                   amount_minor INTEGER NOT NULL
                 );
                 INSERT INTO tally_expense VALUES
                   ('e-1', '2026-01-01', 100),
                   ('e-2', '2026-01-01', 200),
                   ('e-3', '2026-01-01', 300),
                   ('e-4', '2026-01-02', 400);",
            )
            .expect("the fixture ledger is created");
        connection
    }

    fn query() -> PageQuery {
        PageQuery::new(
            "kit.testdoor.expenses",
            "expense_id, spent_on, amount_minor",
            "tally_expense",
            PageOrder::asc("spent_on", "expense_id"),
        )
    }

    #[test]
    fn a_page_boundary_between_two_rows_sharing_a_sort_key_repeats_nothing() {
        let connection = ledger();
        let door = TestDoor::new(&connection);
        let first = door.page(&query(), &PageRequest::first(1)).unwrap();
        // Three rows share '2026-01-01', so every boundary in the walk below
        // falls inside a tie — which is the case the pk in the key exists for.
        assert_eq!(
            first.next,
            Some(PageCursor {
                sort_key: "2026-01-01".to_owned(),
                pk: "e-1".to_owned()
            })
        );
        let mut seen = vec![];
        let mut after = first.next.clone();
        seen.extend(first.rows.iter().map(|row| row["expense_id"].clone()));
        while let Some(cursor) = after {
            let page = door.page(&query(), &PageRequest::after(1, cursor)).unwrap();
            seen.extend(page.rows.iter().map(|row| row["expense_id"].clone()));
            after = page.next;
        }
        let ids: Vec<String> = seen
            .iter()
            .map(|cell| cell.text().unwrap_or_default().to_owned())
            .collect();
        assert_eq!(ids, vec!["e-1", "e-2", "e-3", "e-4"], "no repeat, no drop");
    }

    #[test]
    fn read_by_id_answers_one_row_or_none() {
        let connection = ledger();
        let door = TestDoor::new(&connection);
        let row = read_by_id(
            &door,
            "kit.testdoor.one",
            "expense_id, amount_minor",
            "tally_expense",
            "expense_id",
            "e-2",
        )
        .unwrap()
        .expect("e-2 is in the ledger");
        assert_eq!(row["amount_minor"], Cell::Integer(200));
        assert!(
            read_by_id(
                &door,
                "kit.testdoor.one",
                "expense_id",
                "tally_expense",
                "expense_id",
                "nope"
            )
            .unwrap()
            .is_none()
        );
    }

    #[test]
    fn a_walk_past_its_bound_errors_rather_than_answering_short() {
        let connection = ledger();
        let door = TestDoor::new(&connection);
        let whole = read_pages(&door, &query(), FanOutBound::new(2, 4)).unwrap();
        assert_eq!(whole.len(), 4);
        let outcome = read_pages(&door, &query(), FanOutBound::new(1, 2));
        assert!(matches!(
            outcome,
            Err(KitError::FanOutExceeded { cap: 2, .. })
        ));
    }

    /// A DEMONSTRATED RED for `NullableSortKey`: a walk over a nullable sort
    /// column is refused instead of quietly losing every remaining NULL row,
    /// which is what v0 answers here.
    #[test]
    fn a_null_sort_key_at_a_boundary_is_refused_not_dropped() {
        let connection = Connection::open_in_memory().expect("an in-memory database opens");
        connection
            .execute_batch(
                "CREATE TABLE tally_expense (expense_id TEXT PRIMARY KEY, spent_on TEXT);
                 INSERT INTO tally_expense VALUES ('e-1', NULL), ('e-2', NULL), ('e-3', 'z');",
            )
            .expect("the nullable fixture is created");
        let door = TestDoor::new(&connection);
        let query = PageQuery::new(
            "kit.testdoor.nullable",
            "expense_id, spent_on",
            "tally_expense",
            PageOrder::asc("spent_on", "expense_id"),
        );
        let outcome = door.page(&query, &PageRequest::first(1));
        assert!(
            matches!(outcome, Err(KitError::NullableSortKey { ref column, .. }) if column == "spent_on"),
            "{outcome:?}"
        );
        // And the descending half, where the boundary row is VALUED and the
        // NULL rows are the ones still owed — the case a boundary check alone
        // misses and v0 gets wrong with no signal at all.
        let mut descending = query.clone();
        descending.order = PageOrder::desc("spent_on", "expense_id");
        let first = door.page(&descending, &PageRequest::first(1)).unwrap();
        let cursor = first.next.expect("two rows are still owed");
        let outcome = door.page(&descending, &PageRequest::after(1, cursor));
        assert!(
            matches!(outcome, Err(KitError::NullableSortKey { .. })),
            "{outcome:?}"
        );
        // A window that reaches the end mints no boundary and is fine.
        let whole = door.page(&query, &PageRequest::first(9)).unwrap();
        assert_eq!(whole.rows.len(), 3);
        assert!(whole.next.is_none());
    }

    #[test]
    fn the_door_refuses_what_the_grammar_refuses() {
        let connection = ledger();
        let door = TestDoor::new(&connection);
        let mut bad = query();
        bad.r#where = Some("amount_minor > 0; DROP TABLE tally_expense".to_owned());
        assert!(matches!(
            door.page(&bad, &PageRequest::first(1)),
            Err(KitError::GrammarRefused { .. })
        ));
        // And the table is still there.
        assert_eq!(
            door.page(&query(), &PageRequest::first(9))
                .unwrap()
                .rows
                .len(),
            4
        );
    }
}
