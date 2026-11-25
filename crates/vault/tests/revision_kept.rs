//! A revision is kept while its entity is ([#1146](https://github.com/srikanth235/centraid/issues/1146),
//! #1214 B2): history is not rewritten, and it goes only with the entity it belongs to. v0 deletes
//! no revision row on its own (a version a restore would read may depend on a newer one: `fill_body`
//! fills a version that elided a note's words from the nearest newer version that kept them), so
//! there is no trigger holding a delete: the rule is that no command, retention pass or purge
//! writes one, and `revision.entity_id` cascading is the only way one goes.

mod common;

use centraid_vault::commands::Registry;
use centraid_vault::model::Kind;
use centraid_vault::{Command, CommandStatus, Principal};
use serde_json::json;

const AT: &str = "2026-03-01T09:00:00.000Z";

fn count(scratch: &common::Scratch, sql: &str) -> i64 {
    scratch
        .vault
        .read(|connection| Ok(connection.query_row(sql, [], |row| row.get(0))?))
        .expect("counts")
}

#[test]
fn a_revision_is_never_rewritten_and_goes_with_its_entity_alone() {
    let scratch = common::Scratch::founded("revision-kept").expect("a vault");
    let registry = Registry::with_system_commands().expect("the system registry builds");
    let id = scratch.vault.ids().next();
    scratch
        .vault
        .commit(|tx| {
            tx.insert_entity_in(&id, Kind::Note, "Draft", None, AT)?;
            tx.connection()
                .execute("INSERT INTO note (id, body) VALUES (?1, 'one')", [&id])?;
            Ok(())
        })
        .expect("a note");
    let run = |name: &str, input: serde_json::Value| {
        scratch.clock.advance_ms(1_000);
        let outcome = scratch
            .vault
            .execute(
                &registry,
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
    };
    run("entity.retitle", json!({"id": id, "title": "Second"}));
    assert_eq!(count(&scratch, "SELECT count(*) FROM revision"), 1);

    // What a version holds is never rewritten, by anyone: only `touched_at` may move.
    for sql in [
        "UPDATE revision SET state = '{}'",
        "UPDATE revision SET body = 'x'",
        "UPDATE revision SET at = '2026-03-02T09:00:00.000Z'",
        "UPDATE revision SET actor = 'assistant'",
        "UPDATE revision SET seq = 9",
    ] {
        let refused = scratch.vault.commit(|tx| {
            tx.connection().execute(sql, [])?;
            Ok(())
        });
        assert!(
            refused
                .expect_err("refused")
                .to_string()
                .contains("a revision is history"),
            "{sql}"
        );
    }
    assert_eq!(
        count(&scratch, "SELECT count(*) FROM revision WHERE state = '{}'"),
        0
    );

    // A purge of the entity takes its history with it.
    for name in ["entity.trash", "entity.purge"] {
        run(name, json!({"id": id}));
    }
    assert_eq!(count(&scratch, "SELECT count(*) FROM revision"), 0);
}
