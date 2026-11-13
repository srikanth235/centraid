//! The indexes the baseline carries are the ones its reads walk (#1191, V5): each read below
//! plans as a search or an ordered walk of the index named, with no sort of its own. The plan
//! sweep of `crates/core/tests/query_plans.rs` counts the table scans of every app read over the
//! year-3 vault; this names the index each of the new ones is served by.

mod common;

fn plan(scratch: &common::Scratch, sql: &str, binds: &[&str]) -> String {
    scratch
        .vault
        .read(|connection| {
            let mut statement = connection.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?;
            let rows = statement.query_map(rusqlite::params_from_iter(binds), |row| {
                row.get::<_, String>(3)
            })?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?.join(" | "))
        })
        .expect("a plan")
}

fn walks(plan: &str, index: &str) {
    assert!(
        plan.contains(&format!("INDEX {index}")),
        "{index} is not used: {plan}"
    );
    assert!(!plan.contains("TEMP B-TREE"), "the read sorts: {plan}");
}

#[test]
fn a_guests_address_finds_its_person_by_the_contact_point_index() {
    let scratch = common::Scratch::founded("walk-contact").expect("a vault");
    walks(
        &plan(
            &scratch,
            "SELECT p.person_id FROM contact_point p JOIN entity e ON e.id = p.person_id
              WHERE p.kind = 'email' AND p.normalized = ?1 AND e.deleted_at IS NULL
              ORDER BY p.person_id LIMIT 1",
            &["a@example.com"],
        ),
        "contact_point_by_value",
    );
}

#[test]
fn the_series_of_a_calendar_are_walked_by_start_in_the_partial_index() {
    let scratch = common::Scratch::founded("walk-series").expect("a vault");
    walks(
        &plan(
            &scratch,
            "SELECT id, starts FROM event WHERE status <> ?1 AND rule IS NOT NULL
              ORDER BY starts, id LIMIT 50",
            &["cancelled"],
        ),
        "event_by_rule",
    );
}

#[test]
fn the_newest_statement_line_is_the_end_of_the_source_index() {
    let scratch = common::Scratch::founded("walk-source").expect("a vault");
    walks(
        &plan(
            &scratch,
            "SELECT id, entity_id, seen_at FROM source WHERE system = ?1 AND entity_id IS NOT NULL
              ORDER BY seen_at DESC, id DESC LIMIT 1",
            &["statement"],
        ),
        "source_by_seen",
    );
}

#[test]
fn a_months_budgets_across_categories_and_a_categorys_months_are_both_served() {
    let scratch = common::Scratch::founded("walk-budget").expect("a vault");
    walks(
        &plan(
            &scratch,
            "SELECT category_id, amount_minor FROM budget WHERE month = ?1 ORDER BY category_id",
            &["2026-03"],
        ),
        "budget_by_month",
    );
    let per_category = plan(
        &scratch,
        "SELECT month, amount_minor FROM budget WHERE category_id = ?1 ORDER BY month",
        &["category:food"],
    );
    assert!(
        per_category.contains("SEARCH budget USING PRIMARY KEY"),
        "{per_category}"
    );
}

/// M5: the whole-library listing the drill and garbage collection run (`content_hashes`) names
/// every claim by design, so it reads the whole `blob` table; what it must not do is sort. Its
/// statement is the product's own constant, and it is an ordered walk of `blob`'s unique `hash`
/// index, never a temporary sort tree.
#[test]
fn the_content_listing_walks_the_hash_index_and_never_sorts() {
    let scratch = common::Scratch::founded("walk-content").expect("a vault");
    let plan = plan(
        &scratch,
        centraid_vault::backup::naming::CONTENT_HASHES,
        &[],
    );
    assert!(
        plan.contains("USING INDEX") && !plan.contains("TEMP B-TREE"),
        "the listing sorts or does not use the hash index: {plan}"
    );
}

/// V6: `edge_order` has a reader and no other index serves it as well, so it stays. The plan is the
/// evidence, on a list of 3,000 members after `ANALYZE`: with `edge_order` the next position in the
/// list is the end of an index walk (and the commands now ask for it that way: the old
/// `MAX(position)` could not use a partial index at all); without it the same read goes through
/// `edge_key` and sorts every member. (The Locker's type index had no reader any page or statement
/// plans through, and is gone: `every_index_has_a_reader` in `core/tests/query_plans.rs`.)
#[test]
fn the_edge_order_index_has_a_reader_and_is_kept() {
    let scratch = common::Scratch::founded("walk-kept").expect("a vault");
    scratch
        .vault
        .commit(|tx| {
            let c = tx.connection();
            c.execute_batch(
                "INSERT INTO entity (id, kind, title, created_at, updated_at)
                   VALUES ('list-1', 'list', 'Big list', '2026-03-01T09:00:00.000Z', '2026-03-01T09:00:00.000Z');
                 INSERT INTO container (id, kind) VALUES ('list-1', 'list');
                 WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3000)
                   INSERT INTO entity (id, kind, title, created_at, updated_at)
                   SELECT 'p' || i, 'person', 'P' || i, '2026-03-01T09:00:00.000Z', '2026-03-01T09:00:00.000Z' FROM n;
                 INSERT INTO person (id) SELECT id FROM entity WHERE kind = 'person' AND id LIKE 'p%';
                 INSERT INTO edge (from_id, rel, to_id, position, created_at)
                   SELECT 'list-1', 'contains', id, rowid, '2026-03-01T09:00:00.000Z' FROM entity WHERE id LIKE 'p%';
                 ANALYZE;",
            )?;
            Ok(())
        })
        .expect("a big list");
    // The statement `edge.add` runs for the next position (a plain `MAX(position)` cannot use the
    // partial index, so the command asks for the last entry of the ordered one).
    let read = "SELECT position FROM edge WHERE from_id = ?1 AND rel = 'contains'
                 AND position IS NOT NULL ORDER BY position DESC LIMIT 1";
    let with = plan(&scratch, read, &["list-1"]);
    assert!(
        with.contains("INDEX edge_order"),
        "the next position reads the ordered index: {with}"
    );
    scratch
        .vault
        .commit(|tx| {
            tx.connection().execute_batch("DROP INDEX edge_order")?;
            Ok(())
        })
        .expect("drops");
    let without = plan(&scratch, read, &["list-1"]);
    assert!(
        !without.contains("edge_order")
            && (without.contains("TEMP B-TREE") || without.contains("SCAN")),
        "without it the read sorts or scans every member of the list: {without}"
    );
}
