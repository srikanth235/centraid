//! The indexes the baseline carries are the ones its reads walk (#1191, V5): each read below
//! plans as a search or an ordered walk of the index named, with no sort of its own. The plan
//! sweep of `crates/core/tests/query_plans.rs` counts the table scans of every app read over the
//! year-3 vault and names the index each app statement is served by; this names the index each
//! statement of the vault's own is served by. Every statement planned here is the product's own
//! constant, never a copy.

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
            centraid_vault::commands::event::PERSON_OF_EMAIL,
            &["a@example.com"],
        ),
        "contact_point_by_value",
    );
}

/// A category's plans are read by the primary key `(category_id, month)`, which the statement the
/// merge of two categories runs seeks; no secondary index serves it. The reads of a month across
/// categories (`budget_by_month`), the series (`event_by_rule`) and the newest statement line
/// (`source_by_seen`) are app statements, so the vault cannot name them: their proofs plan the
/// apps' own statements in `crates/core/tests/query_plans.rs` (`the_named_reads_walk_their_index`).
#[test]
fn a_categorys_plans_are_a_seek_of_the_budget_key() {
    let scratch = common::Scratch::founded("walk-budget").expect("a vault");
    let per_category = plan(
        &scratch,
        centraid_vault::commands::money::PLANS_OF_CATEGORY,
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
    // The statement `edge.add` and a restore run for the next position.
    let read = centraid_vault::commands::edge::NEXT_POSITION;
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
