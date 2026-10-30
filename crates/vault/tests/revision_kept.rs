//! A revision is kept while its entity is ([#1146](https://github.com/srikanth235/centraid/issues/1146)):
//! history is not pruned, rewritten or deleted by hand, and it goes only with the entity it
//! belongs to.

mod common;

use centraid_vault::access::Principal;
use centraid_vault::commands::Registry;
use centraid_vault::{Command, CommandStatus, Vault};

fn registry() -> Registry {
    Registry::with_system_commands().expect("the system registry builds")
}

fn owner() -> Principal {
    Principal::owner("phone")
}

fn count(vault: &Vault, sql: &str) -> i64 {
    vault
        .read(|connection| Ok(connection.query_row(sql, [], |row| row.get(0))?))
        .expect("counts")
}

#[test]
fn a_revision_cannot_be_deleted_but_goes_with_its_entity() {
    let scratch = common::Scratch::founded("revision-kept").expect("a vault");
    let registry = registry();
    let created = scratch
        .vault
        .execute(
            &registry,
            &owner(),
            &Command::new(
                "note.create",
                serde_json::json!({"title": "Draft", "body": "one"}),
            ),
        )
        .expect("creates");
    assert_eq!(
        created.status,
        CommandStatus::Executed,
        "{:?}",
        created.reason
    );
    let id = created.output["note_id"]
        .as_str()
        .or_else(|| created.output["id"].as_str())
        .expect("the note's id")
        .to_owned();
    let edit = scratch
        .vault
        .execute(
            &registry,
            &owner(),
            &Command::new("note.edit", serde_json::json!({"id": id, "body": "two"})),
        )
        .expect("edits");
    assert_eq!(edit.status, CommandStatus::Executed, "{:?}", edit.reason);
    assert_eq!(count(&scratch.vault, "SELECT count(*) FROM revision"), 1);

    // A direct delete is refused, and the row is still there.
    let refused = scratch.vault.commit(|tx| {
        tx.connection().execute("DELETE FROM revision", [])?;
        Ok(())
    });
    assert!(
        refused
            .expect_err("refused")
            .to_string()
            .contains("a revision is kept while its entity is"),
    );
    assert_eq!(count(&scratch.vault, "SELECT count(*) FROM revision"), 1);

    // A purge of the entity still takes its history with it.
    for name in ["entity.trash", "entity.purge"] {
        let outcome = scratch
            .vault
            .execute(
                &registry,
                &owner(),
                &Command::new(name, serde_json::json!({"id": id})),
            )
            .expect("runs");
        assert_eq!(
            outcome.status,
            CommandStatus::Executed,
            "{name}: {:?}",
            outcome.reason
        );
    }
    assert_eq!(count(&scratch.vault, "SELECT count(*) FROM revision"), 0);
}
