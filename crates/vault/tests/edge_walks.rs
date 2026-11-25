//! V6, moved out of `index_walks` by K7 (it is the edge lane's statement): `edge_order` has a
//! reader. The fixture writes minted ids (the grammar of an id refuses the old `list-1`, `p1`).

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
                   VALUES ('01900000-0000-7000-8000-ffffffffff01', 'list', 'Big list', '2026-03-01T09:00:00.000Z', '2026-03-01T09:00:00.000Z');
                 INSERT INTO container (id, kind) VALUES ('01900000-0000-7000-8000-ffffffffff01', 'list');
                 WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3000)
                   INSERT INTO entity (id, kind, title, created_at, updated_at)
                   SELECT printf('01900000-0000-7000-8000-%012x', i), 'person', 'P' || i, '2026-03-01T09:00:00.000Z', '2026-03-01T09:00:00.000Z' FROM n;
                 INSERT INTO person (id) SELECT id FROM entity WHERE kind = 'person' AND id LIKE '01900000-%';
                 INSERT INTO edge (from_id, rel, to_id, position, created_at)
                   SELECT '01900000-0000-7000-8000-ffffffffff01', 'contains', id, n, '2026-03-01T09:00:00.000Z' FROM entity WHERE kind = 'person' AND id LIKE '01900000-%';
                 ANALYZE;",
            )?;
            Ok(())
        })
        .expect("a big list");
    // The statement `edge.add` and a restore run for the next position.
    let read = centraid_vault::commands::edge::NEXT_POSITION;
    let with = plan(&scratch, read, &["01900000-0000-7000-8000-ffffffffff01", "contains"]);
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
    let without = plan(&scratch, read, &["01900000-0000-7000-8000-ffffffffff01", "contains"]);
    assert!(
        !without.contains("edge_order")
            && (without.contains("TEMP B-TREE") || without.contains("SCAN")),
        "without it the read sorts or scans every member of the list: {without}"
    );
}
