//! The shared verbs, each against a vault the product founds.
//!
//! Kinds are created the way a per-kind command will create them (the entity
//! row, then the kind row, through the commit guard); everything else goes
//! through the registry, so what is proved is the verb and the gate together.

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

    fn run(&self, name: &str, input: serde_json::Value) -> centraid_vault::CommandOutcome {
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

// ---------------------------------------------------------------------------
// entity.*
// ---------------------------------------------------------------------------

#[test]
fn retitle_changes_the_title_once_and_refuses_what_it_does_not_serve() {
    let w = World::new();
    w.person("p1", "Ada");
    w.ok("entity.retitle", json!({"id": "p1", "title": "  Ada L.  "}));
    assert_eq!(
        w.one::<String>("SELECT title FROM entity WHERE id = 'p1'", &[]),
        "Ada L."
    );
    assert_eq!(
        w.one::<i64>("SELECT version FROM entity WHERE id = 'p1'", &[]),
        2
    );
    // A flag keeps its name; a name cannot be blank; the trash is not edited.
    assert!(
        w.refused(
            "entity.retitle",
            json!({"id": "flag:starred", "title": "x"})
        )
        .contains("built in")
    );
    assert!(
        w.refused("entity.retitle", json!({"id": "p1", "title": "  "}))
            .contains("needs a name")
    );
    w.ok("entity.trash", json!({"id": "p1"}));
    assert!(
        w.refused("entity.retitle", json!({"id": "p1", "title": "x"}))
            .contains("in the trash")
    );
    // A photograph may have no title at all.
    let hash = centraid_vault::blob::content_digest(b"p");
    w.commit(|tx| {
        centraid_vault::blob::stage(tx.connection(), &hash, 1)?;
        tx.insert_entity("ph", Kind::Photo, "caption", AT)?;
        tx.connection()
            .execute("INSERT INTO photo (id, blob, media_type, form) VALUES ('ph', ?1, 'image/jpeg', 'photo')", [&hash])?;
        Ok(())
    });
    w.ok("entity.retitle", json!({"id": "ph", "title": ""}));
}

#[test]
fn a_holder_takes_its_members_to_the_trash_and_a_restore_brings_back_only_those() {
    let w = World::new();
    let book = w.container("notebook", "Recipes", None);
    w.note("n-with", "Soup", "", Some(&book));
    w.note("n-early", "Stew", "", Some(&book));
    w.note("n-out", "Loose", "", None);
    // One member was in the trash before its notebook went.
    w.ok("entity.trash", json!({"id": "n-early"}));
    let early_at = w.one::<String>("SELECT deleted_at FROM entity WHERE id = 'n-early'", &[]);
    w.scratch.clock.advance_ms(60_000);

    let output = w.ok("entity.trash", json!({"id": &book}));
    assert_eq!(
        output["trashed"].as_array().expect("ids").len(),
        2,
        "the notebook and its live note"
    );
    assert!(w.trashed(&book) && w.trashed("n-with") && !w.trashed("n-out"));
    let went_with = w.one::<String>("SELECT deleted_at FROM entity WHERE id = 'n-with'", &[]);
    assert_eq!(
        went_with,
        w.one::<String>("SELECT deleted_at FROM entity WHERE id = ?1", &[&book])
    );
    assert_ne!(went_with, early_at);

    w.ok("entity.restore", json!({"id": &book}));
    assert!(!w.trashed(&book) && !w.trashed("n-with"));
    assert!(
        w.trashed("n-early"),
        "the note that was already in the trash stays there"
    );
    assert_eq!(
        w.one::<i64>("SELECT version FROM entity WHERE id = 'n-with'", &[]),
        3,
        "trash and restore are two changes"
    );
}

#[test]
fn a_purge_purges_what_went_with_the_holder_and_moves_the_rest_to_the_top_level() {
    let w = World::new();
    let book = w.container("notebook", "Recipes", None);
    w.note("n-with", "Soup", "", Some(&book));
    w.note("n-back", "Stew", "", Some(&book));
    w.ok("entity.trash", json!({"id": &book}));
    // A member restored on its own is not lost with the notebook.
    w.ok("entity.restore", json!({"id": "n-back"}));
    assert!(
        w.refused("entity.purge", json!({"id": "n-back"}))
            .contains("not in the trash")
    );

    let output = w.ok("entity.purge", json!({"id": &book}));
    assert_eq!(output["purged"].as_array().expect("ids").len(), 2);
    assert!(!w.exists(&book) && !w.exists("n-with"));
    assert!(w.exists("n-back"));
    assert_eq!(
        w.one::<Option<String>>("SELECT notebook_id FROM note WHERE id = 'n-back'", &[]),
        None,
        "it is at the top level now"
    );
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM note WHERE id = 'n-with'", &[]),
        0,
        "the kind row went with the entity"
    );
}

#[test]
fn what_cannot_outlive_its_holder_is_purged_with_it() {
    let w = World::new();
    w.account("acct", "Everyday");
    w.txn("t1", "acct", -500, None);
    w.txn("t2", "acct", 900, None);
    w.commit(|tx| {
        tx.connection()
            .execute("UPDATE txn SET transfer_id = 't1' WHERE id = 't2'", [])?;
        Ok(())
    });
    let project = w.container("project", "Move house", None);
    let section = w.container("section", "Packing", Some(&project));
    w.task("task", Some(&project), Some(&section), None);
    for holder in ["acct", project.as_str()] {
        w.ok("entity.trash", json!({"id": holder}));
    }
    w.ok("entity.purge", json!({"id": "acct"}));
    assert!(
        !w.exists("t1") && !w.exists("t2"),
        "an account's lines go with it"
    );
    w.ok("entity.restore", json!({"id": &project}));
    w.ok("entity.trash", json!({"id": &project}));
    w.ok("entity.purge", json!({"id": &project}));
    assert!(!w.exists(&section), "a section cannot outlive its project");
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM entity WHERE id = 'task'", &[]),
        0,
        "the task went to the trash with its project"
    );
}

#[test]
fn a_category_a_place_and_a_task_release_what_points_at_them() {
    let w = World::new();
    w.account("acct", "Everyday");
    w.txn("t1", "acct", -500, Some("category:food.groceries"));
    w.ok("entity.purge", json!({"id": "category:food.groceries"}));
    assert_eq!(
        w.one::<Option<String>>("SELECT category_id FROM txn WHERE id = 't1'", &[]),
        None
    );
    // A group's children move to the top level rather than going with it.
    w.ok("entity.purge", json!({"id": "category:food"}));
    assert_eq!(
        w.one::<Option<String>>(
            "SELECT parent_id FROM concept WHERE id = 'category:food.dining'",
            &[]
        ),
        None
    );

    w.task("parent", None, None, None);
    w.task("child", None, None, Some("parent"));
    // A subtask goes to the trash with its parent; one the member restored on its
    // own is live and is not theirs to lose, so the purge releases it.
    w.ok("entity.trash", json!({"id": "parent"}));
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM entity WHERE id = 'child' AND deleted_at IS NOT NULL",
            &[]
        ),
        1
    );
    w.ok("entity.restore", json!({"id": "child"}));
    w.ok("entity.purge", json!({"id": "parent"}));
    assert_eq!(
        w.one::<Option<String>>("SELECT parent_id FROM task WHERE id = 'child'", &[]),
        None
    );
    // A release is a change to what was released: it is touched (created, trashed,
    // restored, released).
    assert_eq!(
        w.one::<i64>("SELECT version FROM entity WHERE id = 'child'", &[]),
        4
    );
}

#[test]
fn a_purge_refuses_with_a_sentence_when_something_would_lose_its_meaning() {
    let w = World::new();
    w.event("e1", "calendar:default");
    assert!(
        w.refused("entity.purge", json!({"id": "calendar:default"}))
            .contains("event is still on")
    );
    assert!(
        w.refused("entity.purge", json!({"id": "flag:starred"}))
            .contains("built in")
    );
    w.commit(|tx| {
        tx.insert_entity("act", Kind::Activity, "Run", AT)?;
        tx.connection().execute(
            "INSERT INTO activity (id, type_id, type_kind, starts) VALUES ('act', 'workout_kind:run', 'workout_kind', '2026-03-01T07:00:00Z')",
            [],
        )?;
        Ok(())
    });
    assert!(
        w.refused("entity.purge", json!({"id": "workout_kind:run"}))
            .contains("1 activity use")
    );
    let me = w.vault().self_id().expect("reads").expect("founded");
    assert!(
        w.refused("entity.trash", json!({"id": &me}))
            .contains("this is you")
    );
    assert!(
        w.refused("entity.purge", json!({"id": &me}))
            .contains("not in the trash")
    );
    // A tag is deleted, not trashed.
    w.ok("tag.add", json!({"id": "e1", "label": "trip"}));
    assert!(
        w.refused("entity.trash", json!({"id": "tag:trip"}))
            .contains("deleted, not moved to the trash")
    );
    w.ok("entity.purge", json!({"id": "tag:trip"}));
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM edge WHERE rel = 'tagged'", &[]),
        0,
        "the tagging went with the tag"
    );
}

#[test]
fn emptying_the_trash_takes_one_kind_or_all_and_only_what_is_due_when_asked() {
    let w = World::new();
    w.note("old", "Old", "", None);
    w.note("new", "New", "", None);
    w.person("gone", "Gone");
    w.ok("entity.trash", json!({"id": "old"}));
    w.scratch.clock.advance_days(31);
    w.ok("entity.trash", json!({"id": "new"}));
    w.ok("entity.trash", json!({"id": "gone"}));
    let due = w.ok("entity.empty_trash", json!({"due_only": true}));
    assert_eq!(due["purged"], 1, "only what has waited out its thirty days");
    assert!(!w.exists("old") && w.exists("new"));
    let notes = w.ok("entity.empty_trash", json!({"kind": "note"}));
    assert_eq!(notes["purged"], 1);
    assert!(w.exists("gone"), "another kind's trash is left alone");
    assert!(
        w.refused("entity.empty_trash", json!({"kind": "tag"}))
            .contains("no trash")
    );
    w.ok("entity.empty_trash", json!({}));
    assert!(!w.exists("gone"));
}

// ---------------------------------------------------------------------------
// tag.*, flag.*, edge.*
// ---------------------------------------------------------------------------

#[test]
fn a_tag_is_minted_by_its_folded_label_and_a_tagging_changes_nothing_on_the_entity() {
    let w = World::new();
    w.note("n1", "Trip", "", None);
    let first = w.ok("tag.add", json!({"id": "n1", "label": "Road  Trip"}));
    assert_eq!(first["tag"], "tag:road trip");
    assert_eq!(first["added"], true);
    let again = w.ok("tag.add", json!({"id": "n1", "label": "road trip"}));
    assert_eq!(again["added"], false, "the same word is the same tag");
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM concept WHERE kind = 'tag'", &[]),
        1
    );
    assert_eq!(
        w.one::<String>("SELECT title FROM entity WHERE id = 'tag:road trip'", &[]),
        "Road Trip"
    );
    assert_eq!(
        w.one::<i64>("SELECT version FROM entity WHERE id = 'n1'", &[]),
        1,
        "a tag is not a change to the note"
    );
    assert_eq!(
        w.ok("tag.remove", json!({"id": "n1", "label": "ROAD TRIP"}))["removed"],
        true
    );
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM edge", &[]), 0);
    assert!(
        w.refused("tag.add", json!({"id": "n1", "label": " "}))
            .contains("needs a word")
    );
    assert!(
        w.refused("tag.add", json!({"id": "tag:road trip", "label": "x"}))
            .contains("is a word")
    );
}

#[test]
fn a_flag_is_a_seeded_tagging_on_anything_that_is_not_a_word() {
    let w = World::new();
    let project = w.container("project", "Move house", None);
    w.ok("flag.set", json!({"id": &project, "flag": "archived"}));
    w.ok("flag.set", json!({"id": &project, "flag": "starred"}));
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM edge WHERE from_id = ?1 AND rel = 'tagged' AND to_id LIKE 'flag:%'", &[&project]),
        2
    );
    assert_eq!(
        w.ok("flag.clear", json!({"id": &project, "flag": "archived"}))["changed"],
        true
    );
    assert_eq!(
        w.ok("flag.clear", json!({"id": &project, "flag": "archived"}))["changed"],
        false
    );
    assert!(
        w.refused("flag.set", json!({"id": "category:food", "flag": "pinned"}))
            .contains("is a word")
    );
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
    assert_eq!(
        w.one::<i64>("SELECT version FROM entity WHERE id = 'e1'", &[]),
        1,
        "an attendee is not a touch"
    );
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
    assert_eq!(
        w.one::<i64>("SELECT version FROM entity WHERE id = 'n1'", &[]),
        2
    );
    assert_eq!(
        w.one::<i64>("SELECT version FROM entity WHERE id = 'mum'", &[]),
        1,
        "the person is re-indexed, not touched"
    );
    w.ok(
        "edge.add",
        json!({"from": "n1", "rel": "links", "to": "n2", "anchor": {"from": 3, "to": 9}}),
    );
    assert_eq!(
        w.one::<i64>("SELECT version FROM entity WHERE id = 'n1'", &[]),
        3
    );
    assert_eq!(
        w.one::<String>("SELECT anchor FROM edge WHERE rel = 'links'", &[]),
        r#"{"from":3,"to":9}"#
    );
    w.ok(
        "edge.remove",
        json!({"from": "n1", "rel": "about", "to": "mum"}),
    );
    assert_eq!(
        w.one::<i64>("SELECT version FROM entity WHERE id = 'n1'", &[]),
        4
    );
    // Removing an edge that is not there changes nothing.
    w.ok(
        "edge.remove",
        json!({"from": "n1", "rel": "about", "to": "mum"}),
    );
    assert_eq!(
        w.one::<i64>("SELECT version FROM entity WHERE id = 'n1'", &[]),
        4
    );
}

// ---------------------------------------------------------------------------
// container.*
// ---------------------------------------------------------------------------

#[test]
fn containers_nest_only_in_their_own_kind_and_never_inside_themselves() {
    let w = World::new();
    let outer = w.container("folder", "Taxes", None);
    let inner = w.container("folder", "2026", Some(&outer));
    assert!(
        w.refused(
            "container.create",
            json!({"kind": "notebook", "title": "N", "parent": &outer})
        )
        .contains("does not go inside")
    );
    assert!(
        w.refused("container.create", json!({"kind": "section", "title": "S"}))
            .contains("belongs to a project")
    );
    assert!(
        w.refused("container.move", json!({"id": &outer, "parent": &inner}))
            .contains("inside itself")
    );
    let area = w.container("area", "Home", None);
    let project = w.container("project", "Move", Some(&area));
    w.container("section", "Packing", Some(&project));
    assert!(
        w.refused("container.move", json!({"id": &project, "parent": &outer}))
            .contains("does not go inside")
    );
    w.ok("container.move", json!({"id": &project, "parent": null}));
    assert_eq!(
        w.one::<Option<String>>("SELECT parent_id FROM container WHERE id = ?1", &[&project]),
        None
    );
    w.ok(
        "container.move",
        json!({"id": &inner, "parent": null, "position": 7}),
    );
    assert_eq!(
        w.one::<f64>("SELECT position FROM container WHERE id = ?1", &[&inner]),
        7.0
    );
    assert!(
        w.refused("container.create", json!({"kind": "folder", "title": " "}))
            .contains("needs a name")
    );
}

// ---------------------------------------------------------------------------
// blob.*, derivative.*
// ---------------------------------------------------------------------------

#[test]
fn staging_bytes_is_idempotent_and_the_same_bytes_have_one_size() {
    let w = World::new();
    let hash = centraid_vault::blob::content_digest(b"hello");
    assert_eq!(
        w.ok("blob.stage", json!({"hash": &hash, "size": 5}))["added"],
        true
    );
    assert_eq!(
        w.ok("blob.stage", json!({"hash": &hash, "size": 5}))["added"],
        false
    );
    let error = w
        .vault()
        .execute(
            &w.registry,
            &Principal::owner("p"),
            &Command::new("blob.stage", json!({"hash": &hash, "size": 6})),
        )
        .expect_err("a different size");
    assert!(error.to_string().contains("already held at 5 bytes"));
}

#[test]
fn garbage_collection_takes_what_no_foreign_key_names_and_what_only_a_collected_blob_named() {
    let w = World::new();
    let kept = w.document("d1", "Kept", b"kept", None);
    let orphan = centraid_vault::blob::content_digest(b"orphan");
    w.ok("blob.stage", json!({"hash": &orphan, "size": 6}));
    // A derivative of the orphan has bytes of its own; the orphan's collection
    // takes the derivative, and its bytes then have no claim either.
    let thumb = centraid_vault::blob::content_digest(b"orphan thumb");
    w.ok(
        "derivative.write",
        json!({"blob": &orphan, "variant": "thumb", "out": &thumb, "out_size": 12, "media_type": "image/jpeg"}),
    );
    // A derivative of the kept document keeps its own bytes alive only while it exists.
    let kept_thumb = centraid_vault::blob::content_digest(b"kept thumb");
    w.ok(
        "derivative.write",
        json!({"blob": &kept, "variant": "preview", "out": &kept_thumb, "out_size": 10, "media_type": "image/jpeg"}),
    );
    let collected = w.ok("blob.collect", json!({}))["collected"]
        .as_array()
        .expect("hashes")
        .clone();
    let mut collected: Vec<String> = collected
        .iter()
        .map(|hash| hash.as_str().expect("hash").to_owned())
        .collect();
    collected.sort();
    let mut expected = vec![orphan.clone(), thumb.clone()];
    expected.sort();
    assert_eq!(collected, expected);
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM blob", &[]),
        2,
        "the kept document's blob and its preview"
    );
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM derivative", &[]), 1);

    // Trash keeps the reference alive; a purge releases it.
    w.ok("entity.trash", json!({"id": "d1"}));
    assert!(
        w.ok("blob.collect", json!({}))["collected"]
            .as_array()
            .expect("hashes")
            .is_empty()
    );
    // The purge collects inside its own commit and says what it released.
    let purged = w.ok("entity.purge", json!({"id": "d1"}));
    assert_eq!(purged["released"].as_array().expect("hashes").len(), 2);
    assert!(
        w.ok("blob.collect", json!({}))["collected"]
            .as_array()
            .expect("hashes")
            .is_empty(),
        "nothing is left for a later sweep"
    );
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM blob", &[]), 0);
}

#[test]
fn a_derivative_is_one_row_per_variant_and_checks_its_own_shape() {
    let w = World::new();
    let original = w.document("d1", "Scan", b"scan", None);
    assert!(
        w.refused(
            "derivative.write",
            json!({"blob": &original, "variant": "thumb"})
        )
        .contains("needs its bytes")
    );
    assert!(
        w.refused(
            "derivative.write",
            json!({"blob": &original, "variant": "text"})
        )
        .contains("needs its value")
    );
    w.ok(
        "derivative.write",
        json!({"blob": &original, "variant": "text", "text": "first"}),
    );
    w.ok(
        "derivative.write",
        json!({"blob": &original, "variant": "text", "text": "second"}),
    );
    assert_eq!(
        w.one::<String>("SELECT text FROM derivative WHERE variant = 'text'", &[]),
        "second"
    );
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM derivative", &[]), 1);
    let missing = centraid_vault::blob::content_digest(b"never staged");
    assert!(
        w.vault()
            .execute(
                &w.registry,
                &Principal::owner("p"),
                &Command::new(
                    "derivative.write",
                    json!({"blob": &missing, "variant": "text", "text": "x"})
                ),
            )
            .is_err()
    );
    w.ok(
        "derivative.drop",
        json!({"blob": &original, "variant": "text"}),
    );
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM derivative", &[]), 0);
}

// ---------------------------------------------------------------------------
// person.merge
// ---------------------------------------------------------------------------

#[test]
fn a_merge_repoints_every_reference_and_purges_the_person_who_goes() {
    let w = World::new();
    w.person("keep", "Margaret");
    w.person("lose", "Peggy");
    w.person("sib", "Ann");
    w.note("n1", "Birthday", "", None);
    w.event("e1", "calendar:default");
    w.commit(|tx| {
        let c = tx.connection();
        c.execute("UPDATE person SET role = NULL, nickname = 'Peggy', cadence_days = 14 WHERE id = 'lose'", [])?;
        c.execute("UPDATE person SET role = 'Teacher' WHERE id = 'keep'", [])?;
        for (id, kind, value, preferred) in [
            ("c-keep", "email", "m@orchard.example", 1),
            ("c-dup", "email", "m@orchard.example", 0),
            ("c-phone", "phone", "555 0100", 1),
            ("c-mail2", "email", "peggy@orchard.example", 1),
        ] {
            let owner = if id == "c-keep" { "keep" } else { "lose" };
            c.execute(
                "INSERT INTO contact_point (id, person_id, kind, value, normalized, preferred, position)
                 VALUES (?1, ?2, ?3, ?4, ?4, ?5, 1)",
                rusqlite::params![id, owner, kind, value, preferred],
            )?;
        }
        c.execute("INSERT INTO measurement (person_id, day, metric, value) VALUES ('keep', '2026-03-01', 'steps', 100)", [])?;
        c.execute("INSERT INTO measurement (person_id, day, metric, value) VALUES ('lose', '2026-03-01', 'steps', 999)", [])?;
        c.execute("INSERT INTO measurement (person_id, day, metric, value) VALUES ('lose', '2026-03-02', 'steps', 200)", [])?;
        Ok(())
    });
    w.ok(
        "edge.add",
        json!({"from": "n1", "rel": "about", "to": "lose"}),
    );
    w.ok(
        "edge.add",
        json!({"from": "e1", "rel": "attendee", "to": "lose", "state": "accepted"}),
    );
    w.ok(
        "edge.add",
        json!({"from": "lose", "rel": "related", "to": "sib", "label": "sister"}),
    );
    w.ok(
        "edge.add",
        json!({"from": "lose", "rel": "related", "to": "keep", "label": "same"}),
    );
    w.ok("tag.add", json!({"id": "lose", "label": "family"}));

    let output = w.ok("person.merge", json!({"from": "lose", "into": "keep"}));
    assert_eq!(output["into"], "keep");
    assert!(!w.exists("lose"));
    // Edges follow, and an edge that would join the survivor to themselves is dropped.
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM edge WHERE from_id = 'n1' AND rel = 'about' AND to_id = 'keep'",
            &[]
        ),
        1
    );
    assert_eq!(
        w.one::<String>(
            "SELECT state FROM edge WHERE rel = 'attendee' AND to_id = 'keep'",
            &[]
        ),
        "accepted"
    );
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM edge WHERE rel = 'related' AND from_id = 'keep' AND to_id = 'sib'", &[]), 1);
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM edge WHERE rel = 'related' AND (from_id = to_id)",
            &[]
        ),
        0
    );
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM edge WHERE from_id = 'keep' AND rel = 'tagged'",
            &[]
        ),
        1
    );
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM edge WHERE from_id = 'lose' OR to_id = 'lose'",
            &[]
        ),
        0
    );
    // Contact points: a duplicate is kept once, the survivor's preference stands.
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM contact_point WHERE person_id = 'keep'",
            &[]
        ),
        3
    );
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM contact_point WHERE person_id = 'keep' AND kind = 'email' AND preferred = 1", &[]), 1);
    assert_eq!(w.one::<String>("SELECT id FROM contact_point WHERE person_id = 'keep' AND kind = 'email' AND preferred = 1", &[]), "c-keep");
    // A measurement both have is the survivor's; the other moves.
    assert_eq!(
        w.one::<f64>(
            "SELECT value FROM measurement WHERE person_id = 'keep' AND day = '2026-03-01'",
            &[]
        ),
        100.0
    );
    assert_eq!(
        w.one::<f64>(
            "SELECT value FROM measurement WHERE person_id = 'keep' AND day = '2026-03-02'",
            &[]
        ),
        200.0
    );
    // Blanks are filled; what the survivor says stands.
    assert_eq!(
        w.one::<String>("SELECT role FROM person WHERE id = 'keep'", &[]),
        "Teacher"
    );
    assert_eq!(
        w.one::<String>("SELECT nickname FROM person WHERE id = 'keep'", &[]),
        "Peggy"
    );
    assert_eq!(
        w.one::<i64>("SELECT cadence_days FROM person WHERE id = 'keep'", &[]),
        14
    );
    assert_eq!(
        w.one::<i64>("SELECT version FROM entity WHERE id = 'keep'", &[]),
        2
    );
}

#[test]
fn a_merge_refuses_what_is_not_two_people_or_would_remove_the_owner() {
    let w = World::new();
    w.person("p1", "Ada");
    w.note("n1", "N", "", None);
    let me = w.vault().self_id().expect("reads").expect("founded");
    assert!(
        w.refused("person.merge", json!({"from": "p1", "into": "p1"}))
            .contains("themselves")
    );
    assert!(
        w.refused("person.merge", json!({"from": "n1", "into": "p1"}))
            .contains("only people")
    );
    assert!(
        w.refused("person.merge", json!({"from": &me, "into": "p1"}))
            .contains("this is you")
    );
    w.ok("person.merge", json!({"from": "p1", "into": &me}));
    assert!(!w.exists("p1"));
}

// ---------------------------------------------------------------------------
// follow.*: the per-field three-way merge
// ---------------------------------------------------------------------------

fn contacts(w: &World, complete: bool, records: serde_json::Value) -> serde_json::Value {
    w.ok(
        "follow.contacts",
        json!({
            "origin": {"ref": "icloud", "label": "iCloud"},
            "records": records,
            "complete": complete
        }),
    )
}

fn contact(
    external_id: &str,
    title: &str,
    role: Option<&str>,
    nickname: Option<&str>,
) -> serde_json::Value {
    let mut fields = json!({"title": title});
    if let Some(role) = role {
        fields["role"] = json!(role);
    }
    if let Some(nickname) = nickname {
        fields["nickname"] = json!(nickname);
    }
    json!({"external_id": external_id, "fields": fields})
}

fn field(w: &World, id: &str, column: &str) -> Option<String> {
    w.one::<Option<String>>(&format!("SELECT {column} FROM person WHERE id = ?1"), &[id])
}

fn followed(w: &World, external_id: &str) -> Option<String> {
    w.vault()
        .read(|connection| {
            Ok(connection
                .query_row(
                    "SELECT entity_id FROM source WHERE external_id = ?1",
                    [external_id],
                    |row| row.get(0),
                )
                .ok()
                .flatten())
        })
        .expect("reads")
}

#[test]
fn a_new_record_is_added_with_its_source_and_a_known_one_updates_only_what_the_member_left_alone() {
    let w = World::new();
    let out = contacts(
        &w,
        true,
        json!([contact("c1", "Ada Lovelace", Some("Engineer"), Some("Ada"))]),
    );
    assert_eq!(
        (out["added"].as_u64(), out["matched"].as_u64()),
        (Some(1), Some(0))
    );
    let id = followed(&w, "c1").expect("linked");
    assert_eq!(
        w.one::<String>("SELECT title FROM entity WHERE id = ?1", &[&id]),
        "Ada Lovelace"
    );
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM origin WHERE system = 'contacts'", &[]),
        1
    );

    // The member changes the nickname; the source changes the role and the nickname.
    w.commit(|tx| {
        tx.connection().execute(
            "UPDATE person SET nickname = 'Countess' WHERE id = ?1",
            [&id],
        )?;
        tx.touch(&id, AT)?;
        Ok(())
    });
    let out = contacts(
        &w,
        true,
        json!([contact(
            "c1",
            "Ada Lovelace",
            Some("Mathematician"),
            Some("Ada L.")
        )]),
    );
    assert_eq!(out["updated"], 1);
    assert_eq!(
        field(&w, &id, "role").as_deref(),
        Some("Mathematician"),
        "the member never touched it"
    );
    assert_eq!(
        field(&w, &id, "nickname").as_deref(),
        Some("Countess"),
        "the member's value stands"
    );
    // `stated` moved on: a later statement equal to the member's value does not undo it, and a
    // later change to the field the member owns still does not reach it.
    contacts(
        &w,
        true,
        json!([contact(
            "c1",
            "Ada Lovelace",
            Some("Mathematician"),
            Some("Ada Byron")
        )]),
    );
    assert_eq!(field(&w, &id, "nickname").as_deref(), Some("Countess"));
    // An identical statement is no change at all.
    let version = w.one::<i64>("SELECT version FROM entity WHERE id = ?1", &[&id]);
    let out = contacts(
        &w,
        true,
        json!([contact(
            "c1",
            "Ada Lovelace",
            Some("Mathematician"),
            Some("Ada Byron")
        )]),
    );
    assert_eq!(out["unchanged"], 1);
    assert_eq!(
        w.one::<i64>("SELECT version FROM entity WHERE id = ?1", &[&id]),
        version
    );
}

#[test]
fn a_record_is_matched_to_a_row_the_member_already_has_before_one_is_added() {
    let w = World::new();
    w.person("mine", "Grace Hopper");
    w.commit(|tx| {
        tx.connection()
            .execute("UPDATE person SET role = 'Admiral' WHERE id = 'mine'", [])?;
        Ok(())
    });
    let out = contacts(
        &w,
        true,
        json!([contact(
            "c9",
            "grace hopper",
            Some("Rear Admiral"),
            Some("Amazing Grace")
        )]),
    );
    assert_eq!(
        (out["added"].as_u64(), out["matched"].as_u64()),
        (Some(0), Some(1))
    );
    assert_eq!(followed(&w, "c9").as_deref(), Some("mine"));
    assert_eq!(
        field(&w, "mine", "role").as_deref(),
        Some("Admiral"),
        "the member's own value stands over a match"
    );
    assert_eq!(
        field(&w, "mine", "nickname").as_deref(),
        Some("Amazing Grace"),
        "a blank takes the source's word"
    );
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM person", &[]),
        2,
        "the self person and hers"
    );
    // A row another source already follows is not a candidate.
    let out = w.ok(
        "follow.contacts",
        json!({"origin": {"ref": "google", "label": "Google"}, "records": [contact("g1", "Grace Hopper", None, None)]}),
    );
    assert_eq!(out["added"], 1);
}

#[test]
fn a_record_gone_from_a_complete_read_trashes_an_untouched_row_and_forgets_an_edited_one() {
    let w = World::new();
    contacts(
        &w,
        true,
        json!([
            contact("keep", "Kept", Some("A"), None),
            contact("quiet", "Quiet", Some("B"), None),
            contact("edited", "Edited", Some("C"), None),
        ]),
    );
    let (quiet, edited) = (
        followed(&w, "quiet").expect("linked"),
        followed(&w, "edited").expect("linked"),
    );
    w.commit(|tx| {
        tx.connection()
            .execute("UPDATE person SET role = 'mine' WHERE id = ?1", [&edited])?;
        tx.touch(&edited, AT)?;
        Ok(())
    });
    // An incomplete read removes nothing.
    let out = contacts(&w, false, json!([contact("keep", "Kept", Some("A"), None)]));
    assert_eq!(
        (out["trashed"].as_u64(), out["forgotten"].as_u64()),
        (Some(0), Some(0))
    );
    let out = contacts(&w, true, json!([contact("keep", "Kept", Some("A"), None)]));
    assert_eq!(
        (out["trashed"].as_u64(), out["forgotten"].as_u64()),
        (Some(1), Some(1))
    );
    assert!(w.trashed(&quiet) && !w.trashed(&edited));
    assert_eq!(
        followed(&w, "quiet").as_deref(),
        Some(quiet.as_str()),
        "a trashed row stays linked"
    );
    assert_eq!(
        followed(&w, "edited"),
        None,
        "an edited row forgets its source and keeps the row"
    );
    assert_eq!(field(&w, &edited, "role").as_deref(), Some("mine"));
    // The forgotten row is a candidate again: if the record comes back it is matched.
    let out = contacts(
        &w,
        true,
        json!([
            contact("keep", "Kept", Some("A"), None),
            contact("edited2", "Edited", None, None)
        ]),
    );
    assert_eq!(out["matched"], 1);
    assert_eq!(followed(&w, "edited2").as_deref(), Some(edited.as_str()));
}

#[test]
fn a_purged_rows_source_is_a_tombstone_and_never_takes_a_row_again() {
    let w = World::new();
    contacts(&w, true, json!([contact("c1", "Ada", None, None)]));
    let id = followed(&w, "c1").expect("linked");
    w.ok("entity.trash", json!({"id": &id}));
    w.ok("entity.purge", json!({"id": &id}));
    assert!(!w.exists(&id));
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM source WHERE external_id = 'c1' AND entity_id IS NULL",
            &[]
        ),
        1
    );
    let out = contacts(&w, true, json!([contact("c1", "Ada", None, None)]));
    assert_eq!(
        (out["added"].as_u64(), out["matched"].as_u64()),
        (Some(0), Some(0)),
        "the source is not added again"
    );
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM person", &[]), 1);
    // The database refuses to give a tombstone a row.
    let refused = w.vault().commit(|tx| {
        tx.connection().execute(
            "UPDATE source SET entity_id = ?1, entity_kind = 'person' WHERE external_id = 'c1'",
            [w.vault().self_id().expect("reads").expect("founded")],
        )?;
        Ok(())
    });
    assert!(
        refused
            .expect_err("final")
            .to_string()
            .contains("never takes a row again")
    );
}

#[test]
fn a_row_the_member_trashed_stays_trashed_and_a_statement_line_is_never_removed() {
    let w = World::new();
    contacts(&w, true, json!([contact("c1", "Ada", Some("A"), None)]));
    let id = followed(&w, "c1").expect("linked");
    w.ok("entity.trash", json!({"id": &id}));
    let out = contacts(&w, true, json!([contact("c1", "Ada", Some("B"), None)]));
    assert_eq!(out["unchanged"], 1, "the member's trash stands");
    assert!(w.trashed(&id));
    assert_eq!(
        field(&w, &id, "role").as_deref(),
        Some("A"),
        "nothing is written under a trashed row"
    );
    w.ok("entity.restore", json!({"id": &id}));
    contacts(&w, true, json!([contact("c1", "Ada", Some("B"), None)]));
    assert_eq!(
        field(&w, &id, "role").as_deref(),
        Some("B"),
        "a restored row still compares as untouched"
    );

    // A statement imports into an account and never removes a line.
    w.account("acct", "Everyday");
    let statement = |records: serde_json::Value, complete: bool| {
        w.ok(
            "follow.statement",
            json!({
                "origin": {"ref": "12-3456", "label": "Everyday statement", "fills": "acct"},
                "records": records,
                "complete": complete
            }),
        )
    };
    let line = |id: &str, amount: i64| json!({"external_id": id, "fields": {"title": format!("line {id}"), "posted_on": "2026-03-01", "amount_minor": amount}});
    let out = statement(json!([line("a", -100), line("b", -250)]), true);
    assert_eq!(out["added"], 2);
    assert_eq!(
        w.one::<String>(
            "SELECT currency FROM txn WHERE account_id = 'acct' LIMIT 1",
            &[]
        ),
        "USD"
    );
    let out = statement(json!([line("a", -100)]), true);
    assert_eq!(
        (
            out["added"].as_u64(),
            out["trashed"].as_u64(),
            out["unchanged"].as_u64()
        ),
        (Some(0), Some(0), Some(1))
    );
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM txn", &[]),
        2,
        "the month's later statement does not hold the earlier line, and it stays"
    );
    // An origin feeds the kind its map says, and a record states only what the system owns.
    assert!(w
        .vault()
        .execute(
            &w.registry,
            &Principal::owner("p"),
            &Command::new(
                "follow.statement",
                json!({"origin": {"ref": "x", "label": "x", "fills": "calendar:default"}, "records": []}),
            ),
        )
        .is_err());
    assert!(
        w.vault()
            .execute(
                &w.registry,
                &Principal::owner("p"),
                &Command::new(
                    "follow.contacts",
                    json!({"origin": {"ref": "i", "label": "i"}, "records": [
                        {"external_id": "z", "fields": {"title": "Z", "starts": "never"}}
                    ]})
                ),
            )
            .is_err()
    );
}
