//! THE PROPERTY THE KEYSET EXISTS FOR: a walk repeats nothing and drops
//! nothing, whatever the window and whatever the ties.
//!
//! v0 states the failure this guards in prose and pins it with examples
//! (`packages/core/src/page/window.ts:20-24`): two rows can share a sort key,
//! and keyed on the sort key alone a page boundary that falls between them
//! either repeats one or drops one, **depending on which way the comparison is
//! written, and both are silent**. An example test finds that only when the
//! boundary happens to land there; a property test lands it on purpose.
//!
//! Three shapes the generators make sure to produce, because each one broke
//! something in v0:
//!
//! - **Duplicates in the sort key** — the row-value comparison's whole reason.
//! - **NULL sort keys** — where the property found a live v0 bug. v0 collapses
//!   a NULL sort key to `""` and continues with `(sort, pk) > (?, ?)`, and
//!   SQLite evaluates a row-value comparison with a NULL operand to NULL, so
//!   the next page drops rows in three of the four (direction, boundary) cases
//!   and says nothing. The port refuses the continuation instead
//!   (`KitError::NullableSortKey`, D-1020-D3-10), and
//!   `a_walk_is_whole_or_refused` is the property that says so: a walk is the
//!   whole read or it is an error, and never a short list.
//! - **`sort_column == pk_column`** — the single-ORDER-BY-term case, where a
//!   naive assembler emits `ORDER BY id, id` and SQLite builds a temp B-tree
//!   (`statement.ts:104-112`).

use centraid_apps_kit::page::{Page, PageRequest};
use centraid_apps_kit::reads::PageDoor;
use centraid_apps_kit::row::Cell;
use centraid_apps_kit::statement::{PageOrder, PageQuery};
use centraid_apps_kit::testdoor::TestDoor;
use proptest::prelude::*;
use rusqlite::Connection;

/// One fixture row: a nullable sort key and a unique primary key.
type Fixture = Vec<(Option<String>, String)>;

/// The fixture table. STRICT, like every table in `contracts/schema/vault-ddl.sql`,
/// which is also why a `TEXT PRIMARY KEY` reports as NOT NULL here: STRICT
/// makes primary-key columns implicitly NOT NULL, and a plain table does not.
fn ledger(rows: &Fixture, sort_key_not_null: bool) -> Connection {
    let connection = Connection::open_in_memory().expect("an in-memory database opens");
    let constraint = if sort_key_not_null { " NOT NULL" } else { "" };
    connection
        .execute_batch(&format!(
            "CREATE TABLE t (pk TEXT PRIMARY KEY, sort_key TEXT{constraint}) STRICT;"
        ))
        .expect("the fixture table is created");
    {
        let mut insert = connection
            .prepare("INSERT INTO t (pk, sort_key) VALUES (?, ?)")
            .expect("the insert prepares");
        for (sort_key, pk) in rows {
            insert
                .execute(rusqlite::params![pk, sort_key])
                .expect("a fixture row inserts");
        }
    }
    connection
}

fn query(order: PageOrder) -> PageQuery {
    PageQuery::new("kit.properties", "pk, sort_key", "t", order)
}

/// Walk every page of `query` at `window` and collect the pks, in order.
///
/// `Err` is a refused boundary, which is an outcome and not a test failure —
/// see the module note.
fn try_walk(
    door: &TestDoor<'_>,
    query: &PageQuery,
    window: usize,
) -> centraid_apps_kit::KitResult<Vec<String>> {
    let mut seen = Vec::new();
    let mut request = PageRequest::first(window);
    // A bound, so a broken cursor loops finitely and fails loudly rather than
    // hanging the suite.
    for _ in 0..10_000 {
        let Page { rows, next } = door.page(query, &request)?;
        for row in &rows {
            seen.push(
                row["pk"]
                    .text()
                    .expect("pk is text in the fixture")
                    .to_owned(),
            );
        }
        match next {
            None => return Ok(seen),
            Some(cursor) => request = PageRequest::after(window, cursor),
        }
    }
    panic!("the walk did not end; a cursor is not advancing");
}

fn walk(door: &TestDoor<'_>, query: &PageQuery, window: usize) -> Vec<String> {
    try_walk(door, query, window).expect("the walk is not refused")
}

/// The same rows in one unbounded read, which is what the walk must equal.
fn whole(connection: &Connection, order: &PageOrder) -> Vec<String> {
    let direction = if order.descending { "DESC" } else { "ASC" };
    let sql = if order.sort_column == order.pk_column {
        format!("SELECT pk FROM t ORDER BY {} {direction}", order.pk_column)
    } else {
        format!(
            "SELECT pk FROM t ORDER BY {} {direction}, {} {direction}",
            order.sort_column, order.pk_column
        )
    };
    connection
        .prepare(&sql)
        .expect("the oracle query prepares")
        .query_map([], |row| row.get::<_, String>(0))
        .expect("the oracle query runs")
        .collect::<Result<Vec<String>, _>>()
        .expect("every oracle row reads")
}

/// Rows whose sort keys are drawn from a tiny alphabet, so ties are the norm
/// rather than the exception. `nulls` decides whether one in four is NULL.
fn fixture(nulls: bool) -> impl Strategy<Value = Fixture> {
    let key = prop_oneof![
        u32::from(nulls) => Just(None),
        3 => prop::sample::select(vec!["a", "b", "c"]).prop_map(|key| Some(key.to_owned())),
    ];
    proptest::collection::vec(key, 0..24usize)
        .prop_map(|keys| {
            keys.into_iter()
                .enumerate()
                // The pk is unique and its text order is NOT the insertion order,
                // so a walk that leans on rowid rather than the keyset diverges.
                .map(|(index, sort_key)| (sort_key, format!("pk-{:02}", (index * 7) % 100)))
                .collect::<Vec<_>>()
        })
        .prop_map(|rows| {
            let mut seen = std::collections::BTreeSet::new();
            rows.into_iter()
                .filter(|(_, pk)| seen.insert(pk.clone()))
                .collect()
        })
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(96))]

    /// Ties, both directions, every window from 1 up, over a sort column that
    /// is never NULL — which is what every Tally statement orders by.
    #[test]
    fn a_walk_equals_the_whole_read(
        rows in fixture(false),
        window in 1usize..6,
        descending in any::<bool>(),
    ) {
        let connection = ledger(&rows, true);
        let door = TestDoor::new(&connection);
        let order = PageOrder {
            sort_column: "sort_key".to_owned(),
            pk_column: "pk".to_owned(),
            descending,
        };
        let walked = walk(&door, &query(order.clone()), window);
        prop_assert_eq!(walked.clone(), whole(&connection, &order));
        // Stated separately, because "equal to the oracle" would still hold if
        // both repeated a row: no pk twice.
        let unique: std::collections::BTreeSet<&String> = walked.iter().collect();
        prop_assert_eq!(unique.len(), walked.len());
        prop_assert_eq!(walked.len(), rows.len());
    }

    /// `sort_column == pk_column`: one ORDER BY term, and the walk still
    /// holds. A pk is never NULL, so this case cannot be refused.
    #[test]
    fn the_degenerate_order_walks_too(
        rows in fixture(true),
        window in 1usize..4,
        descending in any::<bool>(),
    ) {
        let connection = ledger(&rows, false);
        let door = TestDoor::new(&connection);
        let order = PageOrder {
            sort_column: "pk".to_owned(),
            pk_column: "pk".to_owned(),
            descending,
        };
        let walked = walk(&door, &query(order.clone()), window);
        prop_assert_eq!(walked, whole(&connection, &order));
    }

    /// THE PROPERTY THAT FOUND THE BUG, in its post-fix form: over a NULLABLE
    /// sort column a walk is either the whole read or a refused boundary. It is
    /// never a short list, which is what v0 answers.
    #[test]
    fn a_walk_is_whole_or_refused(
        rows in fixture(true),
        window in 1usize..6,
        descending in any::<bool>(),
    ) {
        let connection = ledger(&rows, false);
        let door = TestDoor::new(&connection);
        let order = PageOrder {
            sort_column: "sort_key".to_owned(),
            pk_column: "pk".to_owned(),
            descending,
        };
        match try_walk(&door, &query(order.clone()), window) {
            Ok(walked) => prop_assert_eq!(walked, whole(&connection, &order)),
            Err(error) => prop_assert!(
                matches!(error, centraid_apps_kit::KitError::NullableSortKey { .. }),
                "{error}"
            ),
        }
    }
}

/// The example that says why the property is not vacuous: four rows, two
/// sharing every sort key, walked one at a time.
#[test]
fn ties_at_every_boundary_are_walked_exactly_once() {
    let rows: Fixture = vec![
        (Some("a".to_owned()), "pk-1".to_owned()),
        (Some("a".to_owned()), "pk-2".to_owned()),
        (Some("a".to_owned()), "pk-3".to_owned()),
    ];
    let connection = ledger(&rows, true);
    let door = TestDoor::new(&connection);
    let order = PageOrder::asc("sort_key", "pk");
    assert_eq!(walk(&door, &query(order), 1), vec!["pk-1", "pk-2", "pk-3"]);
}

/// The shrunk counterexample the property produced, kept as a named case: two
/// NULL rows and one valued one, walked one at a time. v0 answers
/// `[pk-3, pk-1]` here and loses `pk-4`; the port refuses the boundary.
#[test]
fn the_recorded_counterexample_is_refused() {
    let rows: Fixture = vec![
        (None, "pk-3".to_owned()),
        (None, "pk-4".to_owned()),
        (Some("a".to_owned()), "pk-1".to_owned()),
    ];
    let connection = ledger(&rows, false);
    let door = TestDoor::new(&connection);
    let query = query(PageOrder::asc("sort_key", "pk"));
    // The whole read is fine: no boundary is minted.
    assert_eq!(walk(&door, &query, 9), vec!["pk-3", "pk-4", "pk-1"]);
    // A window of one puts the boundary on a NULL row.
    let outcome = try_walk(&door, &query, 1);
    assert!(
        matches!(
            outcome,
            Err(centraid_apps_kit::KitError::NullableSortKey { .. })
        ),
        "{outcome:?}"
    );
}

/// The three-state column value, at the door: a NULL cell and an absent column
/// are not the same answer (#1020, apps seam 6).
#[test]
fn a_null_cell_is_present_and_an_unprojected_column_is_not() {
    let rows: Fixture = vec![(None, "pk-1".to_owned())];
    let connection = ledger(&rows, false);
    let door = TestDoor::new(&connection);
    let page = door
        .page(
            &query(PageOrder::asc("sort_key", "pk")),
            &PageRequest::first(1),
        )
        .unwrap();
    let row = &page.rows[0];
    assert_eq!(row.get("sort_key"), Some(&Cell::Null));
    assert_eq!(row.get("nothing_like_it"), None);
}
