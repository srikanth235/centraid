//! WHAT AN ITEM SAID BEFORE IS FOUND (#1185): the words of an earlier version are in
//! `search_past`, keyed to the live item, written in the commit that kept the version.
//!
//! Every assertion is on values and counts (rows of the index, the versions an item holds),
//! never on time. The door's side (one row, the flag) is in `crates/search/tests/earlier.rs`. What
//! the live index holds (`search`, its queue and its drain) is the index file's lane's; only the
//! past rows, which the history writes with the version, are asserted here.

mod common;

use centraid_vault::commands::{
    CommandCondition, CommandCtx, CommandDefinition, Idempotency, Registry,
};
use centraid_vault::model::Kind;
use centraid_vault::{Command, CommandStatus, Principal, Vault};
use serde_json::{Value, json};

const AT: &str = "2026-03-01T09:00:00.000Z";

/// What the notes lane's `note.edit` writes, without what it derives (links): the history's door
/// and the index writer it calls do not care who wrote the rows.
fn edit_note(ctx: &CommandCtx<'_, '_>) -> centraid_vault::Result<Value> {
    let id = ctx.required_str("id")?.to_owned();
    if let Some(body) = ctx.input.get("body").and_then(Value::as_str) {
        ctx.connection()
            .execute("UPDATE note SET body = ?2 WHERE id = ?1", [&id, body])?;
    }
    ctx.touch(&id)?;
    Ok(json!({ "id": id }))
}

struct World {
    scratch: common::Scratch,
    registry: Registry,
}

impl World {
    fn new(seed: &str) -> Self {
        let mut registry = Registry::with_system_commands().expect("a registry");
        registry
            .register(CommandDefinition::plain(
                "probe.note_edit",
                "probe",
                r#"{"type":"object","additionalProperties":true}"#,
                Idempotency::Idempotent,
                &[] as &[CommandCondition],
                edit_note,
            ))
            .expect("a probe");
        Self {
            scratch: common::Scratch::founded(seed).expect("a vault"),
            registry,
        }
    }

    fn vault(&self) -> &Vault {
        &self.scratch.vault
    }

    fn go(&self, name: &str, input: Value) {
        self.scratch.clock.advance_ms(1_000);
        let outcome = self
            .vault()
            .execute(
                &self.registry,
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

    fn note(&self, title: &str, body: &str) -> String {
        let id = self.vault().ids().next();
        self.vault()
            .commit(|tx| {
                tx.insert_entity_in(&id, Kind::Note, title, None, AT)?;
                tx.connection()
                    .execute("INSERT INTO note (id, body) VALUES (?1, ?2)", [&id, body])?;
                Ok(())
            })
            .expect("a note");
        id
    }

    fn count(&self, sql: &str) -> i64 {
        self.vault()
            .read(|connection| Ok(connection.query_row(sql, [], |row| row.get(0))?))
            .expect("counts")
    }

    /// How many entities the past index finds by this word.
    fn finds(&self, word: &str) -> i64 {
        self.vault()
            .read(|connection| {
                Ok(connection.query_row(
                    "SELECT count(DISTINCT e.id) FROM search_past t
                       JOIN entity e ON e.n = (t.rowid >> 24)
                      WHERE search_past MATCH ?1",
                    [format!("\"{word}\"")],
                    |row| row.get(0),
                )?)
            })
            .expect("asks")
    }

    fn past_rows(&self) -> i64 {
        self.count("SELECT count(*) FROM search_past")
    }
}

#[test]
fn a_note_is_found_by_the_words_it_said_before() {
    let w = World::new("earlier-note");
    let note = w.note("Plan", "alpha shared");
    // A creation has no earlier version.
    assert_eq!(w.past_rows(), 0);
    w.go(
        "probe.note_edit",
        json!({"id": note, "body": "beta shared"}),
    );
    assert_eq!(w.finds("alpha"), 1, "alpha is in the past");
    assert_eq!(w.finds("beta"), 0, "beta is only the present's");
    assert_eq!(w.finds("shared"), 1);
    assert_eq!(w.past_rows(), 1);
    // The first version holds everything it said, its title included, once.
    assert_eq!(
        w.count("SELECT doc FROM search_past_vocab WHERE term = 'plan'"),
        1
    );
    w.go(
        "probe.note_edit",
        json!({"id": note, "body": "gamma shared"}),
    );
    assert_eq!(w.past_rows(), 2);
    assert_eq!(
        w.count("SELECT doc FROM search_past_vocab WHERE term = 'plan'"),
        1,
        "a title that did not change is not indexed again"
    );
}

#[test]
fn an_unchanged_body_adds_no_second_copy_and_a_renamed_title_adds_the_old_one() {
    let w = World::new("earlier-dedupe");
    let note = w.note("First name", "kept words");
    // Three edits that leave the words alone: each is a version that carries no body.
    for title in ["Second name", "Third name", "Fourth name"] {
        w.go("entity.retitle", json!({"id": note, "title": title}));
    }
    assert_eq!(w.count("SELECT count(*) FROM revision"), 3);
    assert_eq!(
        w.count("SELECT count(*) FROM revision WHERE body IS NOT NULL"),
        0
    );
    assert_eq!(w.past_rows(), 3, "one row per version with something new");
    // The words never changed, so no earlier version says them: they are the live row's only.
    assert_eq!(w.finds("kept"), 0);
    for word in ["first", "second", "third"] {
        assert_eq!(w.finds(word), 1, "{word}");
    }
    assert_eq!(w.finds("fourth"), 0);
    // Editing the words once adds one body, once.
    w.go("probe.note_edit", json!({"id": note, "body": "new words"}));
    assert_eq!(w.past_rows(), 4);
    assert_eq!(w.finds("kept"), 1);
}

#[test]
fn a_restored_version_is_found_by_what_it_replaced() {
    let w = World::new("earlier-restore");
    let folder = w.go_id("container.create", json!({"kind": "folder", "title": "F"}));
    let doc = w.vault().ids().next();
    w.vault()
        .commit(|tx| {
            tx.insert_entity_in(&doc, Kind::Document, "Ledger", Some(&folder), AT)?;
            let hash = centraid_vault::blob::content_digest(b"x");
            tx.connection()
                .execute("INSERT INTO blob (hash, size) VALUES (?1, 1)", [&hash])?;
            tx.connection().execute(
                "INSERT INTO document (id, blob, media_type) VALUES (?1, ?2, 'text/plain')",
                [&doc, &hash],
            )?;
            Ok(())
        })
        .expect("a document");
    w.go("entity.retitle", json!({"id": doc, "title": "Receipts"}));
    assert_eq!(w.finds("ledger"), 1);
    w.go("history.restore_version", json!({"id": doc, "seq": 1}));
    // The restore replaced "Receipts", which is now one of the words it said before.
    assert_eq!(w.finds("receipts"), 1);
    assert_eq!(w.past_rows(), 2);
}

#[test]
fn a_purge_removes_the_past_rows_and_their_words_in_the_same_transaction() {
    let w = World::new("earlier-purge");
    let note = w.note("Plan", "zeppelin");
    w.go("probe.note_edit", json!({"id": note, "body": "blimp"}));
    let other = w.note("Other", "unrelated");
    w.go("probe.note_edit", json!({"id": other, "body": "elsewhere"}));
    assert_eq!(w.past_rows(), 2);
    w.go("entity.trash", json!({"id": note}));
    w.go("entity.purge", json!({"id": note}));
    assert_eq!(w.past_rows(), 1, "the past rows went with the purge");
    assert_eq!(w.finds("zeppelin"), 0);
    assert_eq!(
        w.count("SELECT count(*) FROM search_past_vocab WHERE term = 'zeppelin'"),
        0,
        "and the index holds none of its words"
    );
    assert_eq!(w.finds("unrelated"), 1, "another note's words stay");
    assert_eq!(w.count("SELECT count(*) FROM revision"), 1);
}

impl World {
    fn go_id(&self, name: &str, input: Value) -> String {
        self.scratch.clock.advance_ms(1_000);
        let outcome = self
            .vault()
            .execute(
                &self.registry,
                &Principal::owner("phone"),
                &Command::new(name, input),
            )
            .unwrap_or_else(|error| panic!("`{name}`: {error}"));
        assert_eq!(outcome.status, CommandStatus::Executed, "{name}");
        outcome.output["id"].as_str().expect("an id").to_owned()
    }
}
