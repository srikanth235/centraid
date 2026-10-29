//! What replaced the journal ([#1146](https://github.com/srikanth235/centraid/issues/1146)): an
//! action-key table so a retried act is not applied twice, and a write counter on the `vault` row
//! so a takeover can tell which copy is ahead. The journal itself is gone from the founded file.

mod common;

use std::sync::Arc;

use centraid_vault::access::Principal;
use centraid_vault::action_key::KeyMark;
use centraid_vault::clock::{FixedClock, SeededIds};
use centraid_vault::commands::Registry;
use centraid_vault::{Command, CommandStatus, Vault};

fn registry() -> Registry {
    Registry::with_system_commands().expect("the system registry builds")
}

fn owner() -> Principal {
    Principal::owner("phone")
}

fn create(title: &str) -> Command {
    Command::new(
        "container.create",
        serde_json::json!({"kind": "folder", "title": title}),
    )
}

fn count(vault: &Vault, sql: &str) -> i64 {
    vault
        .read(|connection| Ok(connection.query_row(sql, [], |row| row.get(0))?))
        .expect("counts")
}

fn writes(vault: &Vault) -> i64 {
    count(vault, "SELECT writes FROM vault")
}

fn columns(vault: &Vault, table: &str) -> Vec<String> {
    vault
        .read(|connection| {
            let mut statement = connection.prepare("SELECT name FROM pragma_table_info(?1)")?;
            Ok(statement
                .query_map([table], |row| row.get(0))?
                .collect::<rusqlite::Result<Vec<String>>>()?)
        })
        .expect("reads the columns")
}

#[test]
fn a_founded_vault_has_no_journal_and_holds_action_keys_instead() {
    let scratch = common::Scratch::founded("no-journal").expect("a vault");
    assert_eq!(
        count(
            &scratch.vault,
            "SELECT count(*) FROM sqlite_schema WHERE name LIKE '%journal%'"
        ),
        0,
        "nothing in the founded file is the journal"
    );
    assert!(
        columns(&scratch.vault, "action_key").len() == 3,
        "the action-key table holds the key, what was asked and when"
    );
}

#[test]
fn a_keyed_act_is_answered_replayed_after_a_restart_and_runs_once() {
    let dir = centraid_ontology::scratch::scratch_dir();
    std::fs::create_dir_all(&dir).expect("a directory");
    let file = dir.join("vault.db");
    let registry = registry();
    let clock = Arc::new(FixedClock::frozen());
    {
        let vault = Vault::create_with(
            &file,
            Box::new(Arc::clone(&clock)),
            Box::new(SeededIds::new("restart")),
        )
        .expect("a vault");
        vault.found("Test", "Owner").expect("founded");
        let mark = KeyMark {
            key: "tap-1",
            asked: "digest-1",
        };
        let first = vault
            .execute_keyed(&registry, &owner(), &create("Once"), Some(&mark))
            .expect("runs");
        assert_eq!(first.status, CommandStatus::Executed);
        assert!(!first.replayed);
        vault.close().expect("closes");
    }
    let vault = Vault::open_with(
        &file,
        Box::new(Arc::clone(&clock)),
        Box::new(SeededIds::new("after-restart")),
    )
    .expect("reopens");
    let mark = KeyMark {
        key: "tap-1",
        asked: "digest-1",
    };
    assert_eq!(
        vault.recall_key("tap-1").expect("recalls").map(|r| r.asked),
        Some("digest-1".to_owned()),
        "the key survived the restart with what it asked"
    );
    let before = writes(&vault);
    let again = vault
        .execute_keyed(&registry, &owner(), &create("Once"), Some(&mark))
        .expect("answers");
    assert!(again.replayed, "the delivery is told as a replay");
    assert!(again.tables.is_empty(), "a replay changes nothing");
    assert_eq!(writes(&vault), before, "a replay is not a write");
    assert_eq!(
        count(
            &vault,
            "SELECT count(*) FROM entity WHERE title = 'Once' AND kind = 'folder'"
        ),
        1,
        "the act ran once"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_key_older_than_thirty_days_is_trimmed_by_the_next_keyed_commit() {
    let scratch = common::Scratch::founded("trim").expect("a vault");
    let registry = registry();
    let run = |key: &'static str, title: &str| {
        let mark = KeyMark {
            key,
            asked: "digest",
        };
        scratch
            .vault
            .execute_keyed(&registry, &owner(), &create(title), Some(&mark))
            .expect("runs");
    };
    run("old", "A");
    scratch.clock.advance_days(29);
    run("recent", "B");
    assert_eq!(count(&scratch.vault, "SELECT count(*) FROM action_key"), 2);
    // Day 31 for `old`, day 2 for `recent`: the commit that writes `new` forgets `old` only.
    scratch.clock.advance_days(2);
    run("new", "C");
    let kept: Vec<String> = scratch
        .vault
        .read(|connection| {
            let mut statement = connection.prepare("SELECT key FROM action_key ORDER BY key")?;
            Ok(statement
                .query_map([], |row| row.get(0))?
                .collect::<rusqlite::Result<Vec<String>>>()?)
        })
        .expect("reads");
    assert_eq!(kept, ["new", "recent"]);
}

#[test]
fn a_refused_or_failed_command_writes_nothing_anywhere() {
    let scratch = common::Scratch::founded("refusal").expect("a vault");
    let registry = registry();
    let before = writes(&scratch.vault);
    let refused = scratch
        .vault
        .execute(
            &registry,
            &owner(),
            &Command::new(
                "entity.retitle",
                serde_json::json!({"id": "nothing-here", "title": "X"}),
            ),
        )
        .expect("answers");
    assert_eq!(refused.status, CommandStatus::Failed);
    let schema = scratch
        .vault
        .execute(
            &registry,
            &owner(),
            &Command::new("entity.retitle", serde_json::json!({"id": "x", "title": 7})),
        )
        .expect("answers");
    assert_eq!(schema.status, CommandStatus::Failed);
    assert!(refused.tables.is_empty() && schema.tables.is_empty());
    assert_eq!(writes(&scratch.vault), before, "a refusal is not a write");
    assert_eq!(count(&scratch.vault, "SELECT count(*) FROM action_key"), 0);
}

#[test]
fn the_write_counter_grows_by_one_per_changing_commit_and_not_for_a_no_op() {
    let scratch = common::Scratch::founded("counter").expect("a vault");
    let registry = registry();
    let start = writes(&scratch.vault);
    assert_eq!(
        count(&scratch.vault, "SELECT written_at IS NOT NULL FROM vault"),
        1,
        "founding was a write and stamped its time"
    );

    // A commit that changed rows: one, however many rows, and the bump is not in its census.
    scratch.clock.advance_ms(5_000);
    let made = scratch
        .vault
        .execute(&registry, &owner(), &create("Counted"))
        .expect("runs");
    assert_eq!(made.status, CommandStatus::Executed);
    assert!(
        !made.tables.contains(&"vault".to_owned()),
        "the bump is not a change a screen re-reads: {:?}",
        made.tables
    );
    assert_eq!(writes(&scratch.vault), start + 1);
    let stamped: String = scratch
        .vault
        .read(|connection| {
            Ok(connection.query_row("SELECT written_at FROM vault", [], |row| row.get(0))?)
        })
        .expect("reads");
    assert_eq!(stamped, scratch.vault.clock().now_text());

    // A commit that changed nothing: no bump, and no change to name.
    let rename = Command::new("vault.rename", serde_json::json!({"name": "Test"}));
    let same = scratch
        .vault
        .execute(&registry, &owner(), &rename)
        .expect("runs");
    assert_eq!(same.status, CommandStatus::Executed);
    assert!(same.tables.is_empty(), "{:?}", same.tables);
    assert_eq!(writes(&scratch.vault), start + 1, "a no-op is not a write");

    // A commit that changed only the vault row names it and counts once.
    let renamed = scratch
        .vault
        .execute(
            &registry,
            &owner(),
            &Command::new("vault.rename", serde_json::json!({"name": "Renamed"})),
        )
        .expect("runs");
    assert_eq!(renamed.tables, ["vault"]);
    assert_eq!(writes(&scratch.vault), start + 2);

    // Every write path counts, not only the gate's: a raw commit does too.
    common::insert_note(&scratch.vault, "outside the gate").expect("writes");
    assert_eq!(writes(&scratch.vault), start + 3);
}
