//! WHAT AN ITEM SAID BEFORE IS FOUND (#1185): the words of an earlier version are in
//! `search_past`, keyed to the live item, and leave with its trash, its purge, a rebuild.
//!
//! Every assertion is on values and counts (rows of the index, the versions an item holds),
//! never on time. The door's side (one row, the flag) is in `crates/search/tests/earlier.rs`.

mod common;

use centraid_vault::access::Principal;
use centraid_vault::commands::Registry;
use centraid_vault::index;
use centraid_vault::model::Kind;
use centraid_vault::{Command, CommandStatus, Vault};
use serde_json::json;

const AT: &str = "2026-03-01T09:00:00Z";

fn go(vault: &Vault, registry: &Registry, name: &str, input: serde_json::Value) {
    let outcome = vault
        .execute(
            registry,
            &Principal::owner("phone"),
            &Command::new(name, input),
        )
        .unwrap_or_else(|error| panic!("`{name}`: {error}"));
    assert_eq!(
        outcome.status,
        CommandStatus::Executed,
        "{name}: {:?}",
        outcome.reason
    );
}

fn count(vault: &Vault, sql: &str) -> i64 {
    vault
        .read(|connection| Ok(connection.query_row(sql, [], |row| row.get(0))?))
        .expect("counts")
}

/// How many entities the index finds by this word, now (`search`) and before (`search_past`).
fn finds(vault: &Vault, word: &str) -> (i64, i64) {
    let ask = |table: &str| -> i64 {
        vault
            .read(|connection| {
                Ok(connection.query_row(
                    &format!(
                        "SELECT count(DISTINCT e.id) FROM {table} t
                           JOIN entity e ON e.n = {key}
                          WHERE {table} MATCH ?1",
                        key = if table == "search" {
                            "t.rowid"
                        } else {
                            "(t.rowid >> 24)"
                        }
                    ),
                    [format!("\"{word}\"")],
                    |row| row.get(0),
                )?)
            })
            .expect("asks")
    };
    (ask("search"), ask("search_past"))
}

fn past_rows(vault: &Vault) -> i64 {
    count(vault, "SELECT count(*) FROM search_past")
}

#[test]
fn a_note_is_found_by_the_words_it_said_before_and_by_the_words_it_says_now() {
    let scratch = common::Scratch::founded("earlier-note").expect("a vault");
    let (vault, registry) = (
        &scratch.vault,
        Registry::with_system_commands().expect("a registry"),
    );
    go(
        vault,
        &registry,
        "note.create",
        json!({"id": "n", "title": "Plan", "body": "alpha shared"}),
    );
    // A creation has no earlier version.
    assert_eq!(past_rows(vault), 0);
    go(
        vault,
        &registry,
        "note.edit",
        json!({"id": "n", "body": "beta shared"}),
    );
    assert_eq!(finds(vault, "alpha"), (0, 1), "alpha is only in the past");
    assert_eq!(finds(vault, "beta"), (1, 0), "beta is only in the present");
    assert_eq!(
        finds(vault, "shared"),
        (1, 1),
        "a word in both is in both indexes; the door answers it once"
    );
    assert_eq!(past_rows(vault), 1);
    // The first version holds everything it said, its title included, once.
    assert_eq!(
        count(
            vault,
            "SELECT doc FROM search_past_vocab WHERE term = 'plan'"
        ),
        1
    );
    go(
        vault,
        &registry,
        "note.edit",
        json!({"id": "n", "body": "gamma shared"}),
    );
    assert_eq!(past_rows(vault), 2);
    assert_eq!(
        count(
            vault,
            "SELECT doc FROM search_past_vocab WHERE term = 'plan'"
        ),
        1,
        "a title that did not change is not indexed again"
    );
}

#[test]
fn an_unchanged_body_adds_no_second_copy_and_a_renamed_title_adds_the_old_one() {
    let scratch = common::Scratch::founded("earlier-dedupe").expect("a vault");
    let (vault, registry) = (
        &scratch.vault,
        Registry::with_system_commands().expect("a registry"),
    );
    go(
        vault,
        &registry,
        "note.create",
        json!({"id": "n", "title": "First name", "body": "kept words"}),
    );
    // Three edits that leave the words alone: each is a version that carries no body.
    for title in ["Second name", "Third name", "Fourth name"] {
        go(
            vault,
            &registry,
            "entity.retitle",
            json!({"id": "n", "title": title}),
        );
    }
    assert_eq!(
        count(vault, "SELECT count(*) FROM revision WHERE entity_id = 'n'"),
        3
    );
    assert_eq!(
        count(
            vault,
            "SELECT count(*) FROM revision WHERE body IS NOT NULL"
        ),
        0
    );
    assert_eq!(
        past_rows(vault),
        3,
        "one row per version with something new"
    );
    // The words never changed, so no earlier version says them: they are the live row's only.
    assert_eq!(finds(vault, "kept"), (1, 0));
    // Every old title is findable.
    for word in ["first", "second", "third"] {
        assert_eq!(finds(vault, word), (0, 1), "{word}");
    }
    assert_eq!(finds(vault, "fourth"), (1, 0));
    // Editing the words once adds one body, once.
    go(
        vault,
        &registry,
        "note.edit",
        json!({"id": "n", "body": "new words"}),
    );
    assert_eq!(past_rows(vault), 4);
    assert_eq!(finds(vault, "kept"), (0, 1));
}

#[test]
fn a_task_and_a_person_are_found_by_what_they_said_before() {
    let scratch = common::Scratch::founded("earlier-kinds").expect("a vault");
    let (vault, registry) = (
        &scratch.vault,
        Registry::with_system_commands().expect("a registry"),
    );
    vault
        .commit(|tx| {
            tx.insert_entity("t", Kind::Task, "Call the plumber", AT)?;
            tx.connection().execute(
                "INSERT INTO task (id, description) VALUES ('t', 'copper pipe')",
                [],
            )?;
            common::add_person(tx, "p", "Ada Lovelace", AT)?;
            Ok(())
        })
        .expect("seeds");
    go(
        vault,
        &registry,
        "task.edit",
        json!({"id": "t", "description": "plastic pipe"}),
    );
    go(
        vault,
        &registry,
        "person.edit",
        json!({"id": "p", "nickname": "Countess"}),
    );
    go(
        vault,
        &registry,
        "person.edit",
        json!({"id": "p", "nickname": "Enchantress"}),
    );
    assert_eq!(finds(vault, "copper"), (0, 1));
    assert_eq!(finds(vault, "plastic"), (1, 0));
    assert_eq!(finds(vault, "pipe"), (1, 1));
    assert_eq!(finds(vault, "countess"), (0, 1));
    assert_eq!(finds(vault, "enchantress"), (1, 0));
}

#[test]
fn a_locker_items_earlier_cells_are_not_found() {
    let scratch = common::Scratch::founded("earlier-locker").expect("a vault");
    let vault = &scratch.vault;
    vault
        .commit(|tx| {
            tx.insert_entity("lk", Kind::LockerItem, "Bank", AT)?;
            tx.connection().execute(
                "INSERT INTO locker_item (id, type, notes, password) VALUES ('lk', 'login', 'quokkaold', 'lk1:sealed')",
                [],
            )?;
            Ok(())
        })
        .expect("seeds");
    vault
        .commit(|tx| {
            tx.connection().execute(
                "UPDATE locker_item SET notes = 'quokkanew' WHERE id = 'lk'",
                [],
            )?;
            tx.touch("lk", AT)?;
            Ok(())
        })
        .expect("edits");
    assert_eq!(
        count(
            vault,
            "SELECT count(*) FROM revision WHERE entity_id = 'lk'"
        ),
        1,
        "its history is kept, sealed"
    );
    assert_eq!(past_rows(vault), 0, "and none of it is in the past index");
    assert_eq!(finds(vault, "quokkaold"), (0, 0));
    assert_eq!(
        finds(vault, "quokkanew"),
        (1, 0),
        "what it says now is found"
    );
}

#[test]
fn trashing_takes_the_past_with_it_and_restoring_brings_it_back() {
    let scratch = common::Scratch::founded("earlier-trash").expect("a vault");
    let (vault, registry) = (
        &scratch.vault,
        Registry::with_system_commands().expect("a registry"),
    );
    go(
        vault,
        &registry,
        "note.create",
        json!({"id": "n", "title": "Plan", "body": "alpha"}),
    );
    go(
        vault,
        &registry,
        "note.edit",
        json!({"id": "n", "body": "beta"}),
    );
    go(vault, &registry, "entity.trash", json!({"id": "n"}));
    assert_eq!(
        finds(vault, "alpha"),
        (0, 0),
        "neither word finds a trashed note"
    );
    assert_eq!(finds(vault, "beta"), (0, 0));
    assert_eq!(past_rows(vault), 0);
    go(vault, &registry, "entity.restore", json!({"id": "n"}));
    assert_eq!(finds(vault, "alpha"), (0, 1), "back with the note");
    assert_eq!(finds(vault, "beta"), (1, 0));
    assert_eq!(past_rows(vault), 1, "written once, not twice");
}

#[test]
fn a_purge_removes_the_past_rows_and_their_words_in_the_same_transaction() {
    let scratch = common::Scratch::founded("earlier-purge").expect("a vault");
    let (vault, registry) = (
        &scratch.vault,
        Registry::with_system_commands().expect("a registry"),
    );
    go(
        vault,
        &registry,
        "note.create",
        json!({"id": "n", "title": "Plan", "body": "zeppelin"}),
    );
    go(
        vault,
        &registry,
        "note.edit",
        json!({"id": "n", "body": "blimp"}),
    );
    go(
        vault,
        &registry,
        "note.create",
        json!({"id": "m", "title": "Other", "body": "unrelated"}),
    );
    let word = |w: &str| {
        count(
            vault,
            &format!("SELECT count(*) FROM search_word WHERE word = '{w}'"),
        )
    };
    assert_eq!(word("zeppelin"), 1);
    assert_eq!(past_rows(vault), 1);
    go(vault, &registry, "entity.trash", json!({"id": "n"}));
    go(vault, &registry, "entity.purge", json!({"id": "n"}));
    assert_eq!(past_rows(vault), 0, "the past rows went with the purge");
    assert_eq!(
        count(vault, "SELECT count(*) FROM search_past_vocab"),
        0,
        "and the index holds none of its words"
    );
    assert_eq!(word("zeppelin"), 0, "the word list lost the earlier word");
    assert_eq!(word("unrelated"), 1, "another note's words stay");
    assert_eq!(count(vault, "SELECT count(*) FROM revision"), 0);
}

#[test]
fn history_is_never_pruned_so_a_version_leaves_the_index_only_with_its_item() {
    // There is no retention on a record's versions: a revision is deleted only by its entity's
    // purge (`revision_is_kept`), and the purge above removes its index rows. The trigger is
    // what holds the index to the same rule: a version that cannot be deleted cannot leave the
    // index alone.
    let scratch = common::Scratch::founded("earlier-kept").expect("a vault");
    let (vault, registry) = (
        &scratch.vault,
        Registry::with_system_commands().expect("a registry"),
    );
    go(
        vault,
        &registry,
        "note.create",
        json!({"id": "n", "title": "Plan", "body": "alpha"}),
    );
    go(
        vault,
        &registry,
        "note.edit",
        json!({"id": "n", "body": "beta"}),
    );
    let refused = vault.commit(|tx| {
        tx.connection()
            .execute("DELETE FROM revision WHERE entity_id = 'n'", [])?;
        Ok(())
    });
    assert!(refused.is_err(), "a version is not deleted by hand");
    assert_eq!(finds(vault, "alpha"), (0, 1));
}

#[test]
fn a_rebuild_writes_the_same_past_rows_the_edits_did() {
    let scratch = common::Scratch::founded("earlier-rebuild").expect("a vault");
    let (vault, registry) = (
        &scratch.vault,
        Registry::with_system_commands().expect("a registry"),
    );
    go(
        vault,
        &registry,
        "note.create",
        json!({"id": "n", "title": "One", "body": "alpha"}),
    );
    go(
        vault,
        &registry,
        "note.edit",
        json!({"id": "n", "body": "beta"}),
    );
    go(
        vault,
        &registry,
        "entity.retitle",
        json!({"id": "n", "title": "Two"}),
    );
    go(
        vault,
        &registry,
        "note.edit",
        json!({"id": "n", "body": "gamma"}),
    );
    let dump = |vault: &Vault| -> Vec<(String, i64, String)> {
        vault
            .commit(|tx| {
                let connection = tx.connection();
                connection.execute_batch(
                    "CREATE VIRTUAL TABLE temp.sp USING fts5vocab(main, search_past, instance)",
                )?;
                let rows = connection
                    .prepare("SELECT term, doc, col FROM temp.sp ORDER BY 1, 2, 3")?
                    .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                connection.execute_batch("DROP TABLE temp.sp")?;
                Ok(rows)
            })
            .expect("dumps")
            .value
    };
    let incremental = dump(vault);
    assert!(!incremental.is_empty());
    vault
        .commit(|tx| {
            index::rebuild(tx.connection())?;
            Ok(())
        })
        .expect("rebuilds");
    assert_eq!(dump(vault), incremental);
}

#[test]
fn the_columns_the_past_reads_are_the_columns_the_census_reaches() {
    // `EARLIER_COLUMNS` and the live text are one list of what a member typed: every column the
    // past index reads is a column of the file (a renamed one fails here, not silently).
    let scratch = common::Scratch::founded("earlier-columns").expect("a vault");
    scratch
        .vault
        .read(|connection| {
            for (table, columns) in index::EARLIER_COLUMNS {
                for column in *columns {
                    let held: i64 = connection.query_row(
                        &format!("SELECT count(*) FROM pragma_table_xinfo('{table}') WHERE name = ?1 AND type = 'TEXT'"),
                        [column],
                        |row| row.get(0),
                    )?;
                    assert_eq!(held, 1, "{table}.{column} is not a TEXT column of the file");
                }
            }
            Ok(())
        })
        .expect("reads");
}
