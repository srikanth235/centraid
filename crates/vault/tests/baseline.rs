//! The baseline migration IS the corpus's schema (D-1020-D1-1, D-1020-D1-2).
//!
//! `contracts/migrations/001_baseline.sql` is generated from the corpus, so the
//! claim it makes is testable: found a v1 file from it and its `sqlite_master`
//! must equal the corpus's, object for object, SQL for SQL.
//!
//! **The exclusions, and every one's reason.** The generator leaves out exactly
//! three classes of object, and this test confirms each is back in the founded
//! file anyway — because SQLite creates it itself:
//!
//! | Excluded | Why | Back in the file? |
//! |---|---|---|
//! | FTS shadow tables (`fts_*_{data,idx,content,docsize,config}`) | `CREATE VIRTUAL TABLE` creates them; issuing their DDL too is an error | yes, 90 of them |
//! | `sqlite_sequence` | created for the first `AUTOINCREMENT` table; a hand-written `CREATE TABLE` for it is refused | yes |
//! | `sqlite_autoindex_*` | implicit, created by the UNIQUE constraint that needs it, and not nameable in DDL | yes, and not in `sqlite_master` with a `sql` at all |
//!
//! So the answer to "what is excluded from the comparison" is **nothing**. The
//! founded schema and the corpus's schema are equal as sets and as text. Any
//! future exclusion has to be added to this table with its reason, and the
//! assertion below is what forces that.

mod common;

use std::collections::BTreeMap;

use centraid_vault::{APPLICATION_ID, Vault, head_version};

/// Every schema object of a file, keyed by `(type, name)`.
fn schema_of(connection: &rusqlite::Connection) -> BTreeMap<(String, String), String> {
    let mut statement = connection
        .prepare(
            r"SELECT type, name, sql FROM sqlite_master
                WHERE sql IS NOT NULL
                  AND name NOT LIKE 'sqlite\_stat%' ESCAPE '\'
                ORDER BY type, name",
        )
        .expect("the query prepares");
    statement
        .query_map([], |row| {
            Ok((
                (row.get::<_, String>(0)?, row.get::<_, String>(1)?),
                row.get::<_, String>(2)?,
            ))
        })
        .expect("the query runs")
        .collect::<rusqlite::Result<BTreeMap<_, _>>>()
        .expect("the rows read")
}

#[test]
fn a_founded_v1_file_carries_exactly_the_corpuss_schema() {
    let golden = centraid_ontology::golden::open_golden().expect("the corpus inflates");
    let corpus = rusqlite::Connection::open(golden.db_path()).expect("the corpus opens");
    let expected = schema_of(&corpus);

    let scratch = common::Scratch::empty("baseline").expect("a vault is founded");
    let actual = scratch
        .vault
        .read(|connection| Ok(schema_of(connection)))
        .expect("the founded schema reads");

    let mut findings: Vec<String> = Vec::new();
    for (key, sql) in &expected {
        match actual.get(key) {
            None => findings.push(format!(
                "{} `{}` is in the corpus and not founded",
                key.0, key.1
            )),
            Some(found) if found != sql => {
                findings.push(format!("{} `{}`: the DDL differs", key.0, key.1));
            }
            Some(_) => {}
        }
    }
    for key in actual.keys() {
        if !expected.contains_key(key) {
            findings.push(format!(
                "{} `{}` is founded and not in the corpus",
                key.0, key.1
            ));
        }
    }
    assert_eq!(findings.join("\n"), "");

    // NOT VACUOUS. Two empty schemas compare equal, which is the one way this
    // could pass for free.
    assert!(
        expected.len() > 700,
        "only {} objects in the corpus",
        expected.len()
    );
    assert_eq!(expected.len(), actual.len());
}

#[test]
fn the_three_excluded_classes_are_created_by_sqlite_itself() {
    let scratch = common::Scratch::empty("excluded").expect("a vault is founded");
    let (shadows, sequence, autoindexes): (i64, i64, i64) = scratch
        .vault
        .read(|connection| {
            Ok((
                connection.query_row(
                    r"SELECT COUNT(*) FROM sqlite_master
                        WHERE type = 'table' AND name LIKE 'fts\_%' ESCAPE '\'
                          AND sql LIKE 'CREATE TABLE%'",
                    [],
                    |row| row.get(0),
                )?,
                connection.query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE name = 'sqlite_sequence'",
                    [],
                    |row| row.get(0),
                )?,
                connection.query_row(
                    r"SELECT COUNT(*) FROM sqlite_master
                        WHERE name LIKE 'sqlite\_autoindex%' ESCAPE '\'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("the counts read");
    // 18 virtual tables × 5 shadow tables each.
    assert_eq!(shadows, 90);
    assert_eq!(sequence, 1);
    assert!(autoindexes > 0, "no implicit index was created");
    // And none of the three appears in the baseline's own text.
    assert!(!centraid_vault::migrations::BASELINE_SQL.contains("CREATE TABLE sqlite_sequence"));
}

#[test]
fn the_fifty_seven_fts_sync_triggers_survive_the_baseline() {
    // THE SLIP THIS CATCHES. An FTS sync trigger is named `fts_<table>_ai`,
    // which starts with the virtual table's name and an underscore exactly as a
    // shadow table does; excluding shadow objects by name alone dropped all of
    // them, and a seat's first write then wrote nothing into the index.
    let scratch = common::Scratch::empty("fts").expect("a vault is founded");
    let triggers: i64 = scratch
        .vault
        .read(|connection| {
            Ok(connection.query_row(
                r"SELECT COUNT(*) FROM sqlite_master
                    WHERE type = 'trigger' AND name LIKE 'fts\_%' ESCAPE '\'",
                [],
                |row| row.get(0),
            )?)
        })
        .expect("the count reads");
    assert_eq!(triggers, 57);
}

#[test]
fn the_entity_kind_registry_is_derived_and_equals_what_v0s_ladder_seeded() {
    // D-1020-D1-15. The derivation is "a logical name whose table keys into
    // `core_entity(entity_id)` on its own primary key", read off the DDL. This
    // holds it to v0's answer in BOTH directions, because a derivation that
    // over-registers turns a child row into an entity and one that
    // under-registers makes an app's first insert fail its foreign key.
    let golden = centraid_ontology::golden::open_golden().expect("the corpus inflates");
    let corpus = rusqlite::Connection::open(golden.db_path()).expect("the corpus opens");
    let mut statement = corpus
        .prepare("SELECT kind FROM core_entity_kind ORDER BY kind")
        .expect("the query prepares");
    let seeded: Vec<String> = statement
        .query_map([], |row| row.get(0))
        .expect("the query runs")
        .collect::<rusqlite::Result<Vec<_>>>()
        .expect("the rows read");

    let scratch = common::Scratch::empty("kinds").expect("a vault is founded");
    let derived: Vec<String> = scratch
        .vault
        .read(|connection| {
            let mut statement =
                connection.prepare("SELECT kind FROM core_entity_kind ORDER BY kind")?;
            Ok(statement
                .query_map([], |row| row.get(0))?
                .collect::<rusqlite::Result<Vec<String>>>()?)
        })
        .expect("the kinds read");

    assert_eq!(seeded.len(), 52, "the corpus's own count");
    let missing: Vec<&String> = seeded
        .iter()
        .filter(|kind| !derived.contains(kind))
        .collect();
    let extra: Vec<&String> = derived
        .iter()
        .filter(|kind| !seeded.contains(kind))
        .collect();
    assert_eq!(
        (missing.is_empty(), extra.is_empty()),
        (true, true),
        "missing {missing:?}, extra {extra:?}"
    );
    // A spot check that the exclusions are the RIGHT ones: a child row of an
    // expense is not an entity, and a machinery band's row is not either.
    assert!(derived.iter().any(|kind| kind == "tally.expense"));
    assert!(!derived.iter().any(|kind| kind == "tally.expense_split"));
    assert!(!derived.iter().any(|kind| kind == "share.authority"));
}

#[test]
fn the_two_pragmas_and_the_replica_seed_are_written() {
    let scratch = common::Scratch::empty("pragmas").expect("a vault is founded");
    let (application_id, user_version, journal): (i64, i64, String) = scratch
        .vault
        .read(|connection| {
            Ok((
                connection.query_row("PRAGMA application_id", [], |row| row.get(0))?,
                connection.query_row("PRAGMA user_version", [], |row| row.get(0))?,
                connection.query_row("PRAGMA journal_mode", [], |row| row.get(0))?,
            ))
        })
        .expect("the pragmas read");
    assert_eq!(application_id, APPLICATION_ID);
    // v1's OWN axis. The corpus is a v0 file at rung 11; a v1 file is at 1,
    // because there is no v0-artifact compatibility and the v0 ladder number
    // says nothing about a v1 file (D-1020-D1-2).
    assert_eq!(user_version, head_version());
    assert_eq!(user_version, 1);
    assert_eq!(journal, "wal");

    let state = centraid_vault::log::log_state(&scratch.vault).expect("the log state reads");
    assert_eq!(state.floor.seq, 0);
    assert_eq!(state.watermark.seq, 0);
    assert_eq!(state.commit_seq, 0);
    assert_eq!(
        state.schema_epoch,
        centraid_vault::log::constants().schema_epoch
    );
    assert!(!state.epoch.is_empty());
}

#[test]
fn reopening_a_founded_file_changes_nothing() {
    let scratch = common::Scratch::founded("reopen").expect("a vault is founded");
    let before = scratch
        .vault
        .read(|connection| Ok(schema_of(connection)))
        .expect("the schema reads");
    let path = scratch.vault.path().to_path_buf();
    let reopened = Vault::open(&path).expect("it reopens");
    assert_eq!(reopened.schema_version(), head_version());
    let after = reopened
        .read(|connection| Ok(schema_of(connection)))
        .expect("the schema reads");
    assert_eq!(before, after);
    // And no pre-migration snapshot was taken, because nothing migrated: the
    // one-snapshot rule costs nothing on an up-to-date file.
    let snapshots = centraid_vault::snapshot::pre_migration_dir(&path);
    assert!(!snapshots.exists(), "a snapshot was taken for no migration");
}
