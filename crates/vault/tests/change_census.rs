//! WHAT REPLACED THE SESSION CAPTURE: an `update_hook` and a running census
//! ([#1029](https://github.com/srikanth235/centraid/issues/1029) §1).
//!
//! The commit guard used to open one SQLite session per replicated table,
//! decode each changeset inside the transaction and write a full row image per
//! change into `replica_log`. All of that existed so a SEAT could apply the
//! log page by page, and there is no seat (#1029 §6) — but one thing it
//! produced is what the product actually needs: **which tables a commit
//! touched**, so a screen knows to re-read.
//!
//! `CommitResult::tables` now comes from a rusqlite `update_hook` installed for
//! the length of the commit. Three claims, and each is a way this could be
//! wrong:
//!
//! 1. A commit that edited one table reports **that table only** — a hook that
//!    leaked across commits, or reported every table it had ever seen, would
//!    make every write redraw every screen.
//! 2. A commit that **rolled back reports nothing** — a screen redrawn from a
//!    transaction that did not happen is the failure mode the whole
//!    never-drop-a-change-event design exists to avoid, wearing the opposite
//!    face.
//! 3. The census equals `SELECT count(*)`, table by table — it is the number
//!    the phone-side shrink warning is computed from (#1029 F4), and a count
//!    that disagreed with the file would fire on a vault that lost nothing, or
//!    stay quiet on one that lost everything.

mod common;

/// One table edited reports that table, and reports it once.
#[test]
fn a_commit_that_edits_one_table_reports_that_table_only() {
    let scratch = common::Scratch::founded("census-one").expect("a vault is founded");
    let outcome = scratch
        .vault
        .commit(|tx| {
            tx.set_producer("test.one-table");
            tx.connection().execute(
                "INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at)
                 VALUES ('p-one', 'person', 'One', ?1, ?1)",
                [&"2026-01-01T00:00:00.000Z"],
            )?;
            Ok(())
        })
        .expect("the commit lands");

    // `core_entity` too, and that is CORRECT rather than noise: the entity
    // supertype row is written by `core_party`'s own trigger, inside this
    // commit, and a screen reading entities has to re-read. What must NOT be
    // here is an FTS shadow table or a table this commit never touched.
    assert!(
        outcome.tables.contains(&"core_party".to_owned()),
        "{:?}",
        outcome.tables
    );
    assert!(
        outcome
            .tables
            .iter()
            .all(|table| table == "core_party" || table == "core_entity"),
        "the census named a table the commit did not write: {:?}",
        outcome.tables
    );
    assert!(outcome.rows >= 1, "at least the inserted row was seen");

    // AND THE NEXT COMMIT STARTS FROM EMPTY. A hook left installed, or a
    // census not cleared, would make this one report `core_party` as well.
    let second = scratch
        .vault
        .commit(|tx| {
            tx.set_producer("test.other-table");
            // A SECOND TABLE WITH NO HASH COLUMN, no foreign key and no
            // trigger, deliberately: a fixture that typed a `content_hash`
            // would be a writer of one, and `tests/one_hash.rs` holds every
            // such writer to naming where its value came from.
            tx.connection().execute(
                "INSERT INTO core_entity_kind (kind) VALUES ('test.one')",
                [],
            )?;
            Ok(())
        })
        .expect("the second commit lands");
    assert!(
        !second.tables.contains(&"core_party".to_owned()),
        "the first commit's tables leaked into the second: {:?}",
        second.tables
    );
    assert!(
        second.tables.contains(&"core_entity_kind".to_owned()),
        "{:?}",
        second.tables
    );
}

/// A commit that fails reports nothing, and leaves nothing behind for the next
/// one to report.
#[test]
fn a_rollback_reports_nothing_and_does_not_leak_into_the_next_commit() {
    let scratch = common::Scratch::founded("census-rollback").expect("a vault is founded");
    let refusal = scratch.vault.commit(|tx| {
        tx.set_producer("test.rolled-back");
        tx.connection().execute(
            "INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at)
             VALUES ('p-gone', 'person', 'Gone', ?1, ?1)",
            [&"2026-01-01T00:00:00.000Z"],
        )?;
        Err::<(), _>(centraid_vault::VaultError::Invariant {
            context: "the body refuses after writing".to_owned(),
        })
    });
    assert!(refusal.is_err(), "the commit was supposed to fail");

    // The row is not there …
    let parties: i64 = scratch
        .vault
        .read(|connection| {
            Ok(connection.query_row(
                "SELECT COUNT(*) FROM core_party WHERE party_id = 'p-gone'",
                [],
                |row| row.get(0),
            )?)
        })
        .expect("the count reads");
    assert_eq!(parties, 0, "the rollback did not roll back");

    // … and the census of the NEXT commit does not carry the rolled-back
    // table. This is the assertion that would fail on a hook left installed
    // across the ROLLBACK, which is the shape of the session-extension bug the
    // old guard had to work around by dropping its sessions first.
    let after = scratch
        .vault
        .commit(|tx| {
            tx.set_producer("test.after-rollback");
            tx.connection().execute(
                "INSERT INTO core_entity_kind (kind) VALUES ('test.after')",
                [],
            )?;
            Ok(())
        })
        .expect("the vault still works");
    assert!(
        !after.tables.contains(&"core_party".to_owned()),
        "the rolled-back commit's tables leaked into the next one: {:?}",
        after.tables
    );
    assert!(
        after.tables.contains(&"core_entity_kind".to_owned()),
        "{:?}",
        after.tables
    );
}

/// THE RUNNING CENSUS EQUALS THE FILE (#1029 F4).
///
/// The shrink warning a phone shows — "the total is below half of what it was,
/// or one app's rows are down more than 90%" — is computed from this, so it has
/// to be `SELECT count(*)` and not an estimate.
#[test]
fn the_census_matches_a_count_of_every_table() {
    let scratch = common::Scratch::founded("census-count").expect("a vault is founded");
    scratch
        .vault
        .commit(|tx| {
            tx.set_producer("test.census");
            for index in 0..5 {
                tx.connection().execute(
                    "INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at)
                     VALUES (?1, 'person', ?2, ?3, ?3)",
                    rusqlite::params![
                        format!("p-{index}"),
                        format!("Person {index}"),
                        "2026-01-01T00:00:00.000Z"
                    ],
                )?;
            }
            Ok(())
        })
        .expect("the commit lands");

    let census = scratch.vault.census().expect("the census reads");
    assert!(!census.is_empty(), "a founded vault has tables");
    assert!(
        census
            .iter()
            .all(|(table, _)| !table.starts_with("sqlite_")),
        "SQLite's own bookkeeping is not a member's rows"
    );

    // EVERY table, counted independently and compared. A census that skipped a
    // table would make its whole app invisible to the shrink guard.
    for (table, counted) in &census {
        let actual: i64 = scratch
            .vault
            .read(|connection| {
                Ok(connection.query_row(
                    &format!("SELECT count(*) FROM \"{table}\""),
                    [],
                    |row| row.get(0),
                )?)
            })
            .unwrap_or_else(|error| panic!("`{table}` would not count: {error}"));
        assert_eq!(*counted, actual, "`{table}`");
    }

    let parties = census
        .iter()
        .find(|(table, _)| table == "core_party")
        .map(|(_, count)| *count)
        .expect("core_party is in the census");
    assert!(parties >= 5, "the five parties are counted: {parties}");
}
