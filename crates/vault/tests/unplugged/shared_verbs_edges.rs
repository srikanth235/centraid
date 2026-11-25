//! The shared verbs that join two things (`edge.*`, #1214 K5): what `edge_shape` allows and the
//! sentence when it does not, an ordered list, and which edge touches the note it is part of.
//! Moved from the old `shared_verbs.rs` when K4 rewrote the kernel verbs; K5 rewrites these.

mod common;

use centraid_vault::commands::Registry;
use centraid_vault::model::Kind;
use centraid_vault::{Command, CommandStatus, CommitTx, Principal, Vault};
use serde_json::json;

const AT: &str = "2026-03-01T09:00:00.000Z";

struct World {
    scratch: common::Scratch,
    registry: Registry,
}

impl World {
    fn new() -> Self {
        Self {
            scratch: common::Scratch::founded("verbs").expect("a vault"),
            registry: Registry::with_system_commands().expect("a registry"),
        }
    }

    fn vault(&self) -> &Vault {
        &self.scratch.vault
    }

    /// An entity's `updated_at`: the clock moves a second before every command, so it changes
    /// exactly when a command touched the entity.
    fn stamp(&self, id: &str) -> String {
        self.one::<String>("SELECT updated_at FROM entity WHERE id = ?1", &[id])
    }

    fn run(&self, name: &str, input: serde_json::Value) -> centraid_vault::CommandOutcome {
        self.scratch.clock.advance_ms(1_000);
        self.vault()
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

    fn commit(&self, body: impl FnOnce(&CommitTx<'_>) -> centraid_vault::Result<()>) {
        self.vault()
            .commit(|tx| body(tx))
            .expect("the commit lands");
    }

    fn one<T: rusqlite::types::FromSql>(&self, sql: &str, params: &[&str]) -> T {
        self.vault()
            .read(|connection| {
                Ok(connection
                    .query_row(sql, rusqlite::params_from_iter(params), |row| row.get(0))?)
            })
            .unwrap_or_else(|error| panic!("{sql}: {error}"))
    }

    // -- the kinds, as a per-kind command writes them -----------------------

    fn person(&self, id: &str, name: &str) {
        self.commit(|tx| {
            common::add_person(tx, id, name, AT)?;
            Ok(())
        });
    }

    fn note(&self, id: &str, title: &str, body: &str, notebook: Option<&str>) {
        self.commit(|tx| {
            tx.insert_entity(id, Kind::Note, title, AT)?;
            tx.connection().execute(
                "INSERT INTO note (id, body, notebook_id) VALUES (?1, ?2, ?3)",
                rusqlite::params![id, body, notebook],
            )?;
            Ok(())
        });
    }

    fn container(&self, kind: &str, title: &str, parent: Option<&str>) -> String {
        self.ok(
            "container.create",
            json!({"kind": kind, "title": title, "parent": parent}),
        )["id"]
            .as_str()
            .expect("an id")
            .to_owned()
    }

    fn document(&self, id: &str, title: &str, bytes: &[u8], folder: Option<&str>) -> String {
        let hash = centraid_vault::blob::content_digest(bytes);
        self.commit(|tx| {
            centraid_vault::blob::stage(tx.connection(), &hash, bytes.len() as i64)?;
            tx.insert_entity(id, Kind::Document, title, AT)?;
            tx.connection().execute(
                "INSERT INTO document (id, blob, media_type, folder_id) VALUES (?1, ?2, 'text/plain', ?3)",
                rusqlite::params![id, hash, folder],
            )?;
            Ok(())
        });
        hash
    }

    fn account(&self, id: &str, name: &str) {
        self.commit(|tx| {
            tx.insert_entity(id, Kind::Account, name, AT)?;
            tx.connection().execute(
                "INSERT INTO account (id, type, currency) VALUES (?1, 'checking', 'USD')",
                [id],
            )?;
            Ok(())
        });
    }

    fn txn(&self, id: &str, account: &str, amount: i64, category: Option<&str>) {
        self.commit(|tx| {
            tx.insert_entity(id, Kind::Txn, id, AT)?;
            tx.connection().execute(
                "INSERT INTO txn (id, account_id, currency, posted_on, amount_minor, category_id)
                 VALUES (?1, ?2, 'USD', '2026-03-01', ?3, ?4)",
                rusqlite::params![id, account, amount, category],
            )?;
            Ok(())
        });
    }

    fn task(&self, id: &str, project: Option<&str>, section: Option<&str>, parent: Option<&str>) {
        self.commit(|tx| {
            tx.insert_entity(id, Kind::Task, id, AT)?;
            tx.connection().execute(
                "INSERT INTO task (id, project_id, section_id, parent_id) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![id, project, section, parent],
            )?;
            Ok(())
        });
    }

    fn event(&self, id: &str, calendar: &str) {
        self.commit(|tx| {
            tx.insert_entity(id, Kind::Event, id, AT)?;
            tx.connection().execute(
                "INSERT INTO event (id, starts, timing, calendar_id) VALUES (?1, '2026-03-02T10:00:00', 'floating', ?2)",
                rusqlite::params![id, calendar],
            )?;
            Ok(())
        });
    }

    fn exists(&self, id: &str) -> bool {
        self.one::<i64>("SELECT COUNT(*) FROM entity WHERE id = ?1", &[id]) == 1
    }

    fn trashed(&self, id: &str) -> bool {
        self.one::<Option<String>>("SELECT deleted_at FROM entity WHERE id = ?1", &[id])
            .is_some()
    }
}

#[test]
fn an_edge_joins_what_edge_shape_allows_and_says_so_in_a_sentence_when_it_does_not() {
    let w = World::new();
    w.person("p1", "Ada");
    w.person("p2", "Grace");
    w.note("n1", "Note", "body", None);
    let album = w.container("album", "Trip", None);
    let refusal = w.refused(
        "edge.add",
        json!({"from": &album, "rel": "contains", "to": "n1"}),
    );
    assert!(refusal.contains("cannot be `contains`"), "{refusal}");
    assert!(
        w.refused(
            "edge.add",
            json!({"from": "p1", "rel": "related", "to": "p2"})
        )
        .contains("say how")
    );
    assert!(
        w.refused("edge.add", json!({"from": "p1", "rel": "with", "to": "p2"}))
            .contains("cannot be `with`")
    );
    assert!(
        w.refused(
            "edge.add",
            json!({"from": "p1", "rel": "related", "to": "p1", "label": "self"})
        )
        .contains("itself")
    );
    assert!(
        w.refused(
            "edge.add",
            json!({"from": "n1", "rel": "about", "to": "p1", "position": 1})
        )
        .contains("has a place")
    );

    // A relation is a concept the member names.
    let out = w.ok(
        "edge.add",
        json!({"from": "p1", "rel": "related", "to": "p2", "label": "Colleague"}),
    );
    assert_eq!(out["label"], "relation:colleague");
    assert_eq!(
        w.one::<String>(
            "SELECT kind FROM entity WHERE id = 'relation:colleague'",
            &[]
        ),
        "relation"
    );
    w.ok(
        "edge.add",
        json!({"from": "p1", "rel": "related", "to": "p2", "label": "colleague"}),
    );
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM edge WHERE rel = 'related'", &[]),
        1,
        "adding is idempotent"
    );
    w.ok(
        "edge.add",
        json!({"from": "p1", "rel": "related", "to": "p2", "label": "friend"}),
    );
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM edge WHERE rel = 'related'", &[]),
        2,
        "a second label is a second edge"
    );
    w.ok(
        "edge.remove",
        json!({"from": "p1", "rel": "related", "to": "p2", "label": "Colleague"}),
    );
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM edge WHERE rel = 'related'", &[]),
        1
    );
}

#[test]
fn a_list_is_ordered_by_position_and_an_item_is_moved_not_rewritten() {
    let w = World::new();
    let list = w.container("list", "Family", None);
    for (id, name) in [("a", "Ann"), ("b", "Bo"), ("c", "Cy")] {
        w.person(id, name);
        w.ok(
            "edge.add",
            json!({"from": &list, "rel": "contains", "to": id}),
        );
    }
    let order = |w: &World| -> Vec<String> {
        w.vault()
            .read(|connection| {
                let mut statement = connection.prepare(
                    "SELECT to_id FROM edge WHERE from_id = ?1 AND rel = 'contains' ORDER BY position",
                )?;
                Ok(statement
                    .query_map([&list], |row| row.get(0))?
                    .collect::<rusqlite::Result<Vec<String>>>()?)
            })
            .expect("reads")
    };
    assert_eq!(
        order(&w),
        ["a", "b", "c"],
        "appended in the order they were added"
    );
    w.ok(
        "edge.move",
        json!({"from": &list, "to": "c", "position": 0.5}),
    );
    assert_eq!(order(&w), ["c", "a", "b"]);
    // Adding an item that is already there does not move it.
    w.ok(
        "edge.add",
        json!({"from": &list, "rel": "contains", "to": "a"}),
    );
    assert_eq!(order(&w), ["c", "a", "b"]);
    assert!(
        w.refused(
            "edge.move",
            json!({"from": &list, "to": "nobody", "position": 1})
        )
        .contains("not in this list")
    );
}

#[test]
fn an_invitees_answer_is_updated_in_place() {
    let w = World::new();
    w.person("p1", "Ada");
    w.event("e1", "calendar:default");
    w.ok(
        "edge.add",
        json!({"from": "e1", "rel": "attendee", "to": "p1"}),
    );
    assert_eq!(
        w.one::<Option<String>>("SELECT state FROM edge WHERE rel = 'attendee'", &[]),
        None
    );
    w.ok(
        "edge.add",
        json!({"from": "e1", "rel": "attendee", "to": "p1", "state": "accepted"}),
    );
    assert_eq!(
        w.one::<String>("SELECT state FROM edge WHERE rel = 'attendee'", &[]),
        "accepted"
    );
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM edge WHERE rel = 'attendee'", &[]),
        1
    );
    assert_eq!(w.stamp("e1"), AT, "an attendee is not a touch");
}

#[test]
fn an_about_or_links_edge_touches_the_note_at_its_start_and_no_other_edge_does() {
    let w = World::new();
    w.person("mum", "Mum");
    w.note("n1", "Call", "", None);
    w.note("n2", "Other", "", None);
    w.ok(
        "edge.add",
        json!({"from": "n1", "rel": "about", "to": "mum"}),
    );
    let about = w.stamp("n1");
    assert_ne!(about, AT, "an about edge touches the note at its start");
    assert_eq!(w.stamp("mum"), AT, "the person is re-indexed, not touched");
    w.ok(
        "edge.add",
        json!({"from": "n1", "rel": "links", "to": "n2", "anchor": {"from": 3, "to": 9}}),
    );
    let linked = w.stamp("n1");
    assert_ne!(linked, about, "a links edge touches it again");
    assert_eq!(
        w.one::<String>("SELECT anchor FROM edge WHERE rel = 'links'", &[]),
        r#"{"from":3,"to":9}"#
    );
    w.ok(
        "edge.remove",
        json!({"from": "n1", "rel": "about", "to": "mum"}),
    );
    let removed = w.stamp("n1");
    assert_ne!(removed, linked, "removing an about edge touches it");
    // Removing an edge that is not there changes nothing.
    w.ok(
        "edge.remove",
        json!({"from": "n1", "rel": "about", "to": "mum"}),
    );
    assert_eq!(w.stamp("n1"), removed);
}

