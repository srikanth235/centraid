//! A label of thousands never holds the vault for seconds (#1146, wave 8): trashing or restoring
//! it writes the first piece of its members' search rows in its own commit and leaves the rest
//! owed, and draining what is owed leaves the index exactly where a rebuild would.

mod common;

use std::collections::BTreeSet;

use centraid_vault::commands::Registry;
use centraid_vault::index::{self, INLINE_DEPENDENTS};
use centraid_vault::{Command, CommandStatus, Principal, Vault};
use serde_json::json;

const AT: &str = "2020-01-01T00:00:00.000Z";
type Dump = BTreeSet<(String, i64, String, i64)>;

fn dump(vault: &Vault) -> Dump {
    vault
        .commit(|tx| {
            let c = tx.connection();
            c.execute_batch(
                "CREATE VIRTUAL TABLE temp.search_instances USING fts5vocab(main, search, instance)",
            )?;
            let rows = c
                .prepare("SELECT term, doc, col, \"offset\" FROM temp.search_instances")?
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))?
                .collect::<rusqlite::Result<Dump>>()?;
            c.execute_batch("DROP TABLE temp.search_instances")?;
            Ok(rows)
        })
        .expect("dumps")
        .value
}

fn rebuilt(vault: &Vault) -> Dump {
    vault
        .commit(|tx| {
            index::rebuild(tx.connection())?;
            Ok(())
        })
        .expect("rebuilds");
    dump(vault)
}

fn go(vault: &Vault, registry: &Registry, name: &str, input: serde_json::Value) {
    let outcome = vault
        .execute(
            registry,
            &Principal::owner("phone"),
            &Command::new(name, input),
        )
        .expect("runs");
    assert_eq!(
        outcome.status,
        CommandStatus::Executed,
        "{name}: {:?}",
        outcome.reason
    );
}

fn drain(vault: &Vault) -> usize {
    let mut steps = 0;
    while vault.reindex_owed().expect("a batch") > 0 {
        steps += 1;
    }
    steps
}

#[test]
fn a_label_of_many_members_leaves_the_rest_owed_and_draining_it_equals_a_rebuild() {
    let scratch = common::Scratch::founded("owed").expect("a vault");
    let vault = &scratch.vault;
    let registry = Registry::with_system_commands().expect("a registry");
    let members = INLINE_DEPENDENTS * 2 + 30;
    go(
        vault,
        &registry,
        "container.create",
        json!({"id": "club", "kind": "list", "title": "Zebrafish Club"}),
    );
    vault
        .commit(|tx| {
            for n in 0..members {
                common::add_person(tx, &format!("p{n:04}"), &format!("Person {n}"), AT)?;
            }
            Ok(())
        })
        .expect("people");
    for n in 0..members {
        go(
            vault,
            &registry,
            "edge.add",
            json!({"from": "club", "rel": "contains", "to": format!("p{n:04}")}),
        );
    }
    assert!(
        !vault.index_owed().expect("asks"),
        "a small label owes nothing"
    );

    // Trashing the list takes its words from every member; only a piece lands in the commit.
    go(vault, &registry, "entity.trash", json!({"id": "club"}));
    assert!(
        vault.index_owed().expect("asks"),
        "the rest of the members are owed"
    );
    let behind = dump(vault);
    let steps = drain(vault);
    assert!(steps >= 1, "the owed rows took {steps} batches");
    assert!(!vault.index_owed().expect("asks"));
    let drained = dump(vault);
    assert_ne!(
        behind, drained,
        "the index was behind until the batches ran"
    );
    assert_eq!(
        drained,
        rebuilt(vault),
        "drained, the index is the rebuilt one"
    );

    // Restoring brings the words back the same way.
    go(vault, &registry, "entity.restore", json!({"id": "club"}));
    assert!(vault.index_owed().expect("asks"));
    drain(vault);
    assert_eq!(dump(vault), rebuilt(vault));
}
