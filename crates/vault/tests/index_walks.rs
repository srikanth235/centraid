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

#[test]
fn a_viewport_is_one_rtree_query_joined_to_entity_by_its_key() {
    let scratch = common::Scratch::founded("walk-geo").expect("a vault");
    let plan = plan(
        &scratch,
        centraid_vault::index::VIEWPORT,
        &["-10", "30", "35", "60", "100"],
    );
    assert!(
        plan.contains("VIRTUAL TABLE INDEX"),
        "the R-tree is searched: {plan}"
    );
    assert!(
        plan.contains("USING INTEGER PRIMARY KEY"),
        "and `entity` is read by `n`, once per point: {plan}"
    );
    assert!(
        !plan.contains("SCAN entity") && !plan.contains("SCAN e "),
        "{plan}"
    );
    assert!(!plan.contains("TEMP B-TREE"), "the read sorts: {plan}");
}

/// A search reads the index file through the same connection: a MATCH on `search`, then each hit's
/// row by `n`, the trash filter on the entity. No scan of the entity table, no sort of its own
/// beyond the rank the index hands over.
#[test]
fn a_search_is_a_match_joined_to_entity_by_its_key() {
    let scratch = common::Scratch::founded("walk-search").expect("a vault");
    let sql = "SELECT e.id FROM search s JOIN entity e ON e.n = s.rowid
                WHERE search MATCH ?1 AND e.deleted_at IS NULL ORDER BY s.rank LIMIT 20";
    let plan = plan(&scratch, sql, &["apple*"]);
    assert!(plan.contains("VIRTUAL TABLE INDEX"), "{plan}");
    assert!(plan.contains("USING INTEGER PRIMARY KEY"), "{plan}");
    assert!(!plan.contains("SCAN entity"), "{plan}");
}

/// The queue the idle pass reads: the whole-entity rows in `n` order, and a label's next piece. Both
/// walk the key; neither sorts, so the cost of a batch is the batch.
#[test]
fn the_owed_queue_is_read_in_key_order_without_a_sort() {
    let scratch = common::Scratch::founded("walk-owed").expect("a vault");
    for (sql, binds) in [
        (
            "SELECT n FROM search_owed WHERE after IS NULL ORDER BY n LIMIT ?1",
            &["50"][..],
        ),
        (
            "SELECT n, after FROM search_owed WHERE after IS NOT NULL ORDER BY n LIMIT 1",
            &[][..],
        ),
    ] {
        let plan = plan(&scratch, sql, binds);
        assert!(plan.contains("search_owed"), "{plan}");
        assert!(
            !plan.contains("TEMP B-TREE"),
            "the queue read sorts: {plan}"
        );
    }
}

/// BOUNDED BY CONSTRUCTION, ASSERTED ON ROWS: a batch of the idle pass changes the rows of at most
/// `OWED_BATCH` entities, whatever is owed, and so a restored vault of any size is drained in
/// pieces that never grow.
#[test]
fn an_idle_batch_changes_a_bounded_number_of_rows_however_much_is_owed() {
    let scratch = common::Scratch::founded("walk-batch").expect("a vault");
    let vault = &scratch.vault;
    vault
        .commit(|tx| {
            for n in 0..400 {
                common::add_person(
                    tx,
                    &vault.ids().next(),
                    &format!("Person {n} walker"),
                    "2020-01-01T00:00:00.000Z",
                )?;
            }
            Ok(())
        })
        .expect("people");
    // A pass of the commit's own wrote the first thousand; make the whole of it owed again, as a
    // restore does.
    vault
        .read(|c| {
            let _ = c;
            Ok(())
        })
        .expect("reads");
    vault
        .commit(|tx| {
            tx.connection().execute(
                "INSERT INTO search_owed (n) SELECT n FROM entity WHERE true ON CONFLICT (n) DO NOTHING",
                [],
            )?;
            Ok(())
        })
        .expect("owes everything");
    let owed_before: i64 = vault
        .read(|c| Ok(c.query_row("SELECT count(*) FROM search_owed", [], |r| r.get(0))?))
        .expect("counts");
    assert!(owed_before > 400);
    let mut batches = 0;
    loop {
        let before = vault.read(|c| Ok(c.total_changes())).expect("changes");
        let more = vault.reindex_owed().expect("a batch");
        let after = vault.read(|c| Ok(c.total_changes())).expect("changes");
        // Per entity: its search row, its words, its owed row, and the state row once.
        let bound = centraid_vault::index::OWED_BATCH as u64 * 40 + 8;
        assert!(
            after - before <= bound,
            "a batch changed {} rows, over {bound}",
            after - before
        );
        batches += 1;
        if more == 0 {
            break;
        }
    }
    let expected = (owed_before as usize).div_ceil(centraid_vault::index::OWED_BATCH);
    assert_eq!(
        batches,
        expected,
        "{owed_before} rows owed, in batches of {}",
        centraid_vault::index::OWED_BATCH
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
