//! A note's own verbs, against a vault the product founds: create, edit (and
//! what it keeps), move, restore a version, and the wikilinks an edit compiles.
//! The trash, the pin, the tags and the notebooks are the shared verbs and are
//! proved in `shared_verbs.rs`; here they are only the way a test arranges a
//! note into the state a note verb is asked about.

mod common;

use centraid_vault::commands::Registry;
use centraid_vault::{Command, CommandStatus, Principal};
use serde_json::json;

struct World {
    scratch: common::Scratch,
    registry: Registry,
}

impl World {
    fn new() -> Self {
        Self {
            scratch: common::Scratch::founded("notes").expect("a vault"),
            registry: Registry::with_system_commands().expect("a registry"),
        }
    }

    fn run(&self, name: &str, input: serde_json::Value) -> centraid_vault::CommandOutcome {
        self.scratch
            .vault
            .execute(
                &self.registry,
                &Principal::owner("phone"),
                &Command::new(name, input),
            )
            .unwrap_or_else(|error| panic!("`{name}`: {error}"))
    }

    fn ok(&self, name: &str, input: serde_json::Value) -> serde_json::Value {
        let outcome = self.run(name, input);
        assert_eq!(
            outcome.status,
            CommandStatus::Executed,
            "{name}: {:?}",
            outcome.reason
        );
        outcome.output
    }

    fn refused(&self, name: &str, input: serde_json::Value) -> String {
        let outcome = self.run(name, input);
        assert_eq!(
            outcome.status,
            CommandStatus::Failed,
            "{name} was not refused"
        );
        outcome.reason.expect("a sentence")
    }

    fn note(&self, title: &str, body: &str) -> String {
        self.ok("note.create", json!({ "title": title, "body": body }))["id"]
            .as_str()
            .expect("an id")
            .to_owned()
    }

    fn query<T: rusqlite::types::FromSql>(&self, sql: &str, params: &[&str]) -> T {
        self.scratch
            .vault
            .read(|c| Ok(c.query_row(sql, rusqlite::params_from_iter(params), |r| r.get(0))?))
            .expect("a row")
    }

    fn links(&self, note: &str) -> Vec<String> {
        self.scratch
            .vault
            .read(|c| {
                Ok(c.prepare(
                    "SELECT to_id FROM edge WHERE from_id = ?1 AND rel = 'links' ORDER BY to_id",
                )?
                .query_map([note], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?)
            })
            .expect("edges")
    }
}

#[test]
fn a_note_is_born_with_its_words_and_is_found_by_them() {
    let w = World::new();
    let id = w.note("Engine", "the analytical engine");
    assert_eq!(
        w.query::<String>("SELECT body FROM note WHERE id = ?1", &[&id]),
        "the analytical engine"
    );
    assert_eq!(
        w.query::<String>("SELECT format FROM note WHERE id = ?1", &[&id]),
        "markdown"
    );
    assert_eq!(
        w.query::<i64>("SELECT COUNT(*) FROM revision WHERE entity_id = ?1", &[&id]),
        0
    );
    // The index holds the title and the body, keyed by the entity's `n`.
    let hits: i64 = w.query(
        "SELECT COUNT(*) FROM search s JOIN entity e ON e.n = s.rowid
          WHERE search MATCH 'analytical' AND e.id = ?1",
        &[&id],
    );
    assert_eq!(hits, 1);
}

#[test]
fn an_edit_keeps_the_words_it_replaced_and_a_no_op_keeps_nothing() {
    let w = World::new();
    let id = w.note("Plan", "first");
    w.ok("note.edit", json!({ "id": id, "body": "second" }));
    w.ok("note.edit", json!({ "id": id, "body": "second" }));
    w.ok(
        "note.edit",
        json!({ "id": id, "title": "Plan B", "format": "plain" }),
    );
    w.ok("note.edit", json!({ "id": id, "body": "third" }));
    let kept: Vec<String> = w
        .scratch
        .vault
        .read(|c| {
            Ok(
                c.prepare("SELECT body FROM revision WHERE entity_id = ?1 ORDER BY seq")?
                    .query_map([&id], |r| r.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?,
            )
        })
        .expect("revisions");
    assert_eq!(
        kept,
        ["first", "second"],
        "the replaced words, oldest first; a repeat and a title edit keep none"
    );
    assert_eq!(
        w.query::<String>("SELECT title FROM entity WHERE id = ?1", &[&id]),
        "Plan B"
    );
    assert_eq!(
        w.query::<String>("SELECT body FROM note WHERE id = ?1", &[&id]),
        "third"
    );
    assert!(w.query::<i64>("SELECT version FROM entity WHERE id = ?1", &[&id]) > 1);
}

#[test]
fn restoring_a_version_swaps_it_in_and_keeps_what_it_replaced() {
    let w = World::new();
    let id = w.note("Plan", "one");
    w.ok("note.edit", json!({ "id": id, "body": "two" }));
    w.ok("note.restore_version", json!({ "id": id, "seq": 1 }));
    assert_eq!(
        w.query::<String>("SELECT body FROM note WHERE id = ?1", &[&id]),
        "one"
    );
    assert_eq!(
        w.query::<String>(
            "SELECT body FROM revision WHERE entity_id = ?1 AND seq = 2",
            &[&id]
        ),
        "two"
    );
    // Restoring the words already there revises nothing.
    w.ok("note.restore_version", json!({ "id": id, "seq": 1 }));
    assert_eq!(
        w.query::<i64>("SELECT COUNT(*) FROM revision WHERE entity_id = ?1", &[&id]),
        2
    );
    let other = w.note("Other", "x");
    assert!(
        w.refused("note.restore_version", json!({ "id": other, "seq": 1 }))
            .contains("history")
    );
}

#[test]
fn a_note_is_filed_moved_and_unfiled_and_a_notebook_is_the_only_place_for_it() {
    let w = World::new();
    let book = w.ok(
        "container.create",
        json!({ "kind": "notebook", "title": "Work" }),
    )["id"]
        .as_str()
        .expect("id")
        .to_owned();
    let id = w.ok("note.create", json!({ "title": "A", "notebook_id": book }))["id"]
        .as_str()
        .expect("id")
        .to_owned();
    assert_eq!(
        w.query::<String>("SELECT notebook_id FROM note WHERE id = ?1", &[&id]),
        book
    );
    w.ok("note.move", json!({ "id": id, "notebook_id": null }));
    assert_eq!(
        w.query::<Option<String>>("SELECT notebook_id FROM note WHERE id = ?1", &[&id]),
        None
    );
    let album = w.ok(
        "container.create",
        json!({ "kind": "album", "title": "Trip" }),
    )["id"]
        .as_str()
        .expect("id")
        .to_owned();
    assert!(
        w.refused("note.move", json!({ "id": id, "notebook_id": album }))
            .contains("not a notebook")
    );
    assert!(
        w.refused(
            "note.create",
            json!({ "title": "B", "notebook_id": "nope" })
        )
        .contains("nothing with the id")
    );
}

#[test]
fn a_trashed_note_is_frozen_and_a_body_over_the_budget_is_refused() {
    let w = World::new();
    let id = w.note("A", "x");
    w.ok("entity.trash", json!({ "id": id }));
    assert!(
        w.refused("note.edit", json!({ "id": id, "body": "y" }))
            .contains("trash")
    );
    w.ok("entity.restore", json!({ "id": id }));
    let huge = "a".repeat(centraid_vault::commands::note::BODY_BUDGET_BYTES + 1);
    assert!(
        w.refused("note.edit", json!({ "id": id, "body": huge }))
            .contains("budget")
    );
    assert!(
        w.refused("note.create", json!({ "title": "  " }))
            .contains("title")
    );
}

#[test]
fn a_wikilink_compiles_to_an_edge_and_the_edge_follows_the_words() {
    let w = World::new();
    let target = w.note("Plan", "the plan");
    let other = w.note("Mum", "m");
    let id = w.note("Index", "see [[plan]] and [[Nothing]]");
    assert_eq!(w.links(&id), std::slice::from_ref(&target));
    w.ok(
        "note.edit",
        json!({ "id": id, "body": "now [[Mum]] and [[Plan]]" }),
    );
    let mut want = vec![target.clone(), other.clone()];
    want.sort();
    assert_eq!(w.links(&id), want);
    w.ok("note.edit", json!({ "id": id, "body": "no links" }));
    assert!(w.links(&id).is_empty());
    // A link made by hand is not the compile's to end, and stands in for its own.
    w.ok(
        "edge.add",
        json!({ "from": id, "rel": "links", "to": target, "anchor": { "exact": "plan", "start": 0 } }),
    );
    w.ok("note.edit", json!({ "id": id, "body": "again [[Plan]]" }));
    w.ok("note.edit", json!({ "id": id, "body": "gone" }));
    assert_eq!(
        w.links(&id),
        [target],
        "the member's link stands after the words that matched it go"
    );
}

#[test]
fn a_memo_a_trashed_note_and_the_note_itself_are_not_wikilink_targets() {
    let w = World::new();
    let person = common::self_person(&w.scratch.vault).expect("self");
    let memo = w.note("Plan", "a memo");
    w.ok(
        "edge.add",
        json!({ "from": memo, "rel": "about", "to": person }),
    );
    let gone = w.note("Gone", "x");
    w.ok("entity.trash", json!({ "id": gone }));
    let id = w.note("Self", "[[Plan]] [[Gone]] [[Self]]");
    assert!(w.links(&id).is_empty());
}
