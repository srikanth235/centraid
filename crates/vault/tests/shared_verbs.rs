//! The shared verbs of the entity kernel (#1214, K4), each against a vault the product founds:
//! one home, the trash with its contents, flags as columns, minted ids, arrivals, tags and
//! concepts, and what a purge does with what points at a row.
//!
//! Kinds are made the way a per-kind command makes them (the entity row in its home, then the kind
//! row, through the commit guard); everything else goes through the registry, so what is proved is
//! the verb and the gate together. The rules a sentence states are held by the database too:
//! `schema_rules.rs` writes each bad row with raw SQL.
//!
//! The shared verbs' tests that read an app's tables (edges, links, a person merge, a follow's
//! three-way merge, a document's bytes) went with their lanes: each re-proves its own against the
//! new tables when its module is plugged back in (`UNPLUGGED.md`).

mod common;

use centraid_vault::commands::{
    CommandCondition, CommandCtx, CommandDefinition, Idempotency, Registry, arrival,
};
use centraid_vault::model::Kind;
use centraid_vault::{Command, CommandStatus, CommitTx, Principal, Vault};
use serde_json::json;

const AT: &str = "2026-03-01T09:00:00.000Z";

struct World {
    scratch: common::Scratch,
    registry: Registry,
}

fn arrive(ctx: &CommandCtx<'_, '_>) -> centraid_vault::Result<serde_json::Value> {
    let id = ctx.insert_entity(Kind::Document, "Scanned")?;
    ctx.connection().execute(
        "INSERT INTO document (id, blob, media_type) VALUES (?1, ?2, 'text/plain')",
        rusqlite::params![id, ctx.required_str("blob")?],
    )?;
    arrival::record(ctx, &id, Kind::Document)?;
    Ok(json!({ "id": id }))
}

impl World {
    fn new() -> Self {
        let mut registry = Registry::with_system_commands().expect("a registry");
        registry
            .register(CommandDefinition::plain(
                "probe.arrive",
                "probe",
                r#"{"type":"object","additionalProperties":true}"#,
                Idempotency::Idempotent,
                &[] as &[CommandCondition],
                arrive,
            ))
            .expect("a probe");
        Self {
            scratch: common::Scratch::founded("verbs").expect("a vault"),
            registry,
        }
    }

    fn vault(&self) -> &Vault {
        &self.scratch.vault
    }

    /// An entity's `updated_at`.
    fn stamp(&self, id: &str) -> String {
        self.one::<String>("SELECT updated_at FROM entity WHERE id = ?1", &[id])
    }

    /// Run a command; the clock moves a second first, so a stamp changes exactly when a command
    /// touched the entity.
    fn run(&self, name: &str, input: serde_json::Value) -> centraid_vault::CommandOutcome {
        self.scratch.clock.advance_ms(1_000);
        self.run_now(name, input)
    }

    /// Run a command at the clock's present instant.
    fn run_now(&self, name: &str, input: serde_json::Value) -> centraid_vault::CommandOutcome {
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

    fn mint(&self) -> String {
        self.vault().ids().next()
    }

    // -- the kinds, as a per-kind command writes them -----------------------

    /// An entity of `kind` in `parent`, with no kind row (the shared verbs read only the entity).
    fn bare(&self, kind: Kind, title: &str, parent: Option<&str>) -> String {
        let id = self.mint();
        self.commit(|tx| tx.insert_entity_in(&id, kind, title, parent, AT));
        id
    }

    fn note(&self, title: &str, notebook: Option<&str>) -> String {
        let id = self.mint();
        self.commit(|tx| {
            tx.insert_entity_in(&id, Kind::Note, title, notebook, AT)?;
            tx.connection()
                .execute("INSERT INTO note (id, body) VALUES (?1, '')", [&id])?;
            Ok(())
        });
        id
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

    fn task(&self, parent: Option<&str>) -> String {
        let id = self.mint();
        self.commit(|tx| {
            tx.insert_entity_in(&id, Kind::Task, "Task", parent, AT)?;
            tx.connection()
                .execute("INSERT INTO task (id) VALUES (?1)", [&id])?;
            Ok(())
        });
        id
    }

    fn event(&self, calendar: &str) -> String {
        let id = self.mint();
        self.commit(|tx| {
            tx.insert_entity_in(&id, Kind::Event, "Lunch", Some(calendar), AT)?;
            tx.connection().execute(
                "INSERT INTO event (id, starts, timing) VALUES (?1, '2026-03-02T10:00', 'floating')",
                [&id],
            )?;
            Ok(())
        });
        id
    }

    fn exists(&self, id: &str) -> bool {
        self.one::<i64>("SELECT COUNT(*) FROM entity WHERE id = ?1", &[id]) == 1
    }

    fn trashed(&self, id: &str) -> bool {
        self.one::<Option<String>>("SELECT deleted_at FROM entity WHERE id = ?1", &[id])
            .is_some()
    }

    fn trashed_by(&self, id: &str) -> Option<String> {
        self.one::<Option<String>>("SELECT trashed_by FROM entity WHERE id = ?1", &[id])
    }

    fn home(&self, id: &str) -> Option<String> {
        self.one::<Option<String>>("SELECT parent_id FROM entity WHERE id = ?1", &[id])
    }
}

// ---------------------------------------------------------------------------
// entity.retitle
// ---------------------------------------------------------------------------

#[test]
fn retitle_changes_the_title_once_and_refuses_what_it_does_not_serve() {
    let w = World::new();
    let person = w.mint();
    w.commit(|tx| common::add_person(tx, &person, "Ada", AT));
    w.ok(
        "entity.retitle",
        json!({"id": &person, "title": "  Ada L.  "}),
    );
    assert_eq!(
        w.one::<String>("SELECT title FROM entity WHERE id = ?1", &[&person]),
        "Ada L."
    );
    assert_ne!(w.stamp(&person), AT, "a retitle is a change");
    assert!(
        w.refused("entity.retitle", json!({"id": &person, "title": "  "}))
            .contains("needs a name")
    );
    // A reading carries no title: the screen formats the figure.
    let reading = w.bare(Kind::Reading, "", None);
    assert!(
        w.refused("entity.retitle", json!({"id": &reading, "title": "x"}))
            .contains("has no name")
    );
    // A photograph may have no title at all.
    let photo = w.bare(Kind::Photo, "caption", None);
    w.ok("entity.retitle", json!({"id": &photo, "title": ""}));
    // The trash is not edited.
    w.ok("entity.trash", json!({"id": &person}));
    assert!(
        w.refused("entity.retitle", json!({"id": &person, "title": "x"}))
            .contains("in the trash")
    );
}

// ---------------------------------------------------------------------------
// One home (A19)
// ---------------------------------------------------------------------------

#[test]
fn moving_a_note_a_container_a_task_and_a_concept_is_one_command_and_one_path() {
    let w = World::new();
    let a = w.container("notebook", "A", None);
    let b = w.container("notebook", "B", None);
    let note = w.note("Soup", Some(&a));
    let before = w.stamp(&note);
    assert_eq!(w.home(&note), Some(a.clone()));
    assert_eq!(
        w.one::<String>("SELECT parent_kind FROM entity WHERE id = ?1", &[&note]),
        "notebook"
    );

    let moved = w.ok("entity.move", json!({"id": &note, "parent": &b}));
    assert_eq!(moved["moved"], true);
    assert_eq!(w.home(&note), Some(b.clone()));
    assert_ne!(w.stamp(&note), before, "a move is a change to the item");
    // The same home again changes nothing.
    let stamp = w.stamp(&note);
    assert_eq!(
        w.ok("entity.move", json!({"id": &note, "parent": &b}))["moved"],
        false
    );
    assert_eq!(w.stamp(&note), stamp);
    // To the top level, which a note may sit at.
    w.ok("entity.move", json!({"id": &note, "parent": null}));
    assert_eq!(w.home(&note), None);
    assert_eq!(
        w.one::<Option<String>>("SELECT parent_kind FROM entity WHERE id = ?1", &[&note]),
        None
    );

    // A container is moved by its own command, which is the same path and also places it.
    let inner = w.container("notebook", "Inner", Some(&a));
    w.ok(
        "container.move",
        json!({"id": &inner, "parent": &b, "position": 7.5}),
    );
    assert_eq!(w.home(&inner), Some(b.clone()));
    assert_eq!(
        w.one::<f64>("SELECT position FROM container WHERE id = ?1", &[&inner]),
        7.5
    );
    // A task goes to a project, then into a section of it, then under another task.
    let project = w.container("project", "Move house", None);
    let section = w.container("section", "Packing", Some(&project));
    let task = w.task(Some(&project));
    w.ok("entity.move", json!({"id": &task, "parent": &section}));
    let sub = w.task(Some(&task));
    assert_eq!(w.home(&sub), Some(task.clone()));
    // A concept is moved the same way: a tag inside a tag.
    let tag = w.ok("tag.add", json!({"id": &note, "label": "Food"}))["tag"]
        .as_str()
        .expect("a tag")
        .to_owned();
    let child = w.ok("tag.add", json!({"id": &note, "label": "Soups"}))["tag"]
        .as_str()
        .expect("a tag")
        .to_owned();
    w.ok("entity.move", json!({"id": &child, "parent": &tag}));
    assert_eq!(w.home(&child), Some(tag));
}

#[test]
fn a_home_of_the_wrong_kind_a_loop_and_a_missing_home_are_refused_in_a_sentence() {
    let w = World::new();
    let book = w.container("notebook", "Book", None);
    let inner = w.container("notebook", "Inner", Some(&book));
    let folder = w.container("folder", "Folder", None);
    let note = w.note("N", None);
    // The kind of the home is `home_shape`'s.
    assert!(
        w.refused("entity.move", json!({"id": &note, "parent": &folder}))
            .contains("does not go inside a folder")
    );
    assert!(
        w.refused(
            "container.create",
            json!({"kind": "notebook", "title": "x", "parent": &folder})
        )
        .contains("does not go inside a folder")
    );
    // A loop, and a thing inside itself.
    assert!(
        w.refused("entity.move", json!({"id": &book, "parent": &inner}))
            .contains("cannot go inside itself")
    );
    assert!(
        w.refused("container.move", json!({"id": &book, "parent": &book}))
            .contains("cannot go inside itself")
    );
    // A kind that may not sit at the top needs a home: a section a project, an event a calendar.
    assert!(
        w.refused("container.create", json!({"kind": "section", "title": "S"}))
            .contains("belongs in a project")
    );
    let section = w.container("section", "S", Some(&w.container("project", "P", None)));
    assert!(
        w.refused("entity.move", json!({"id": &section, "parent": null}))
            .contains("belongs in a project")
    );
    let event = w.event("calendar:default");
    assert!(
        w.refused("entity.move", json!({"id": &event, "parent": null}))
            .contains("belongs in a calendar")
    );
    // The home is there and is live.
    assert!(
        w.refused("entity.move", json!({"id": &note, "parent": "nothing"}))
            .contains("nothing with the id")
    );
    let gone = w.container("notebook", "Gone", None);
    w.ok("entity.trash", json!({"id": &gone}));
    assert!(
        w.refused("entity.move", json!({"id": &note, "parent": &gone}))
            .contains("in the trash")
    );
    // The owner is nobody's to file.
    let me = w
        .vault()
        .self_id()
        .expect("reads")
        .expect("a founded vault has an owner");
    assert!(
        w.refused("entity.move", json!({"id": me, "parent": &book}))
            .contains("this is you")
    );
    // Refusals wrote nothing.
    assert_eq!(w.home(&note), None);
}

// ---------------------------------------------------------------------------
// The trash takes what a holder holds (A13)
// ---------------------------------------------------------------------------

#[test]
fn a_holder_takes_its_contents_to_the_trash_naming_itself_and_a_restore_brings_back_only_those() {
    let w = World::new();
    let book = w.container("notebook", "Recipes", None);
    let with = w.note("Soup", Some(&book));
    let early = w.note("Stew", Some(&book));
    let out = w.note("Loose", None);
    // One member was in the trash before its notebook went, AT THE SAME INSTANT: no timestamp is
    // compared, so it still does not come back with the notebook.
    w.ok("entity.trash", json!({"id": &early}));
    assert_eq!(
        w.trashed_by(&early),
        None,
        "trashed on its own it names no one"
    );

    let output = w.run_now("entity.trash", json!({"id": &book})).output;
    assert_eq!(
        output["trashed"].as_array().expect("ids").len(),
        2,
        "the notebook and its live note"
    );
    assert!(w.trashed(&book) && w.trashed(&with) && !w.trashed(&out));
    assert_eq!(w.trashed_by(&with), Some(book.clone()));
    assert_eq!(
        w.trashed_by(&book),
        None,
        "the holder was trashed on its own"
    );
    assert_eq!(
        w.one::<String>("SELECT deleted_at FROM entity WHERE id = ?1", &[&with]),
        w.one::<String>("SELECT deleted_at FROM entity WHERE id = ?1", &[&early]),
        "the same instant, and still not the same trash"
    );
    let trashed_stamp = w.stamp(&with);
    assert_ne!(trashed_stamp, AT, "a trash is a change");

    w.ok("entity.restore", json!({"id": &book}));
    assert!(!w.trashed(&book) && !w.trashed(&with));
    assert_eq!(w.trashed_by(&with), None);
    assert!(
        w.trashed(&early),
        "the note that was already in the trash stays there"
    );
    assert_ne!(
        w.stamp(&with),
        trashed_stamp,
        "trash and restore are two changes"
    );
}

#[test]
fn nested_holders_each_name_their_own_holder_and_come_back_together() {
    let w = World::new();
    let outer = w.container("folder", "Outer", None);
    let inner = w.container("folder", "Inner", Some(&outer));
    let deep = w.note("Deep", None);
    let doc_in_inner = w.bare(Kind::Document, "Doc", Some(&inner));
    let _ = deep;
    let doc_in_outer = w.bare(Kind::Document, "Doc2", Some(&outer));
    // `inner` goes alone first, with what it holds.
    w.ok("entity.trash", json!({"id": &inner}));
    assert_eq!(w.trashed_by(&doc_in_inner), Some(inner.clone()));
    // Then `outer`: the already-trashed `inner` and what it holds are not its.
    w.ok("entity.trash", json!({"id": &outer}));
    assert_eq!(w.trashed_by(&doc_in_outer), Some(outer.clone()));
    assert_eq!(w.trashed_by(&inner), None);
    assert!(
        w.refused("entity.restore", json!({"id": &inner}))
            .contains("restore “Outer” first")
    );
    w.ok("entity.restore", json!({"id": &outer}));
    assert!(!w.trashed(&outer) && !w.trashed(&doc_in_outer));
    assert!(
        w.trashed(&inner) && w.trashed(&doc_in_inner),
        "inner went on its own"
    );
    // Now `outer` is live, so `inner` can come back, and brings its document.
    w.ok("entity.restore", json!({"id": &inner}));
    assert!(!w.trashed(&inner) && !w.trashed(&doc_in_inner));

    // One trash of a whole tree: every row names its direct holder, and one restore of the root
    // brings the whole tree back.
    w.ok("entity.trash", json!({"id": &outer}));
    assert_eq!(w.trashed_by(&inner), Some(outer.clone()));
    assert_eq!(w.trashed_by(&doc_in_inner), Some(inner.clone()));
    let restored = w.ok("entity.restore", json!({"id": &outer}));
    assert_eq!(restored["restored"].as_array().expect("ids").len(), 4);
    for id in [&outer, &inner, &doc_in_inner, &doc_in_outer] {
        assert!(!w.trashed(id) && w.trashed_by(id).is_none());
    }
}

#[test]
fn an_account_a_person_and_a_task_hold_what_belongs_to_them() {
    let w = World::new();
    // A task holds its subtasks (a home), and a restore of the task brings them back.
    let project = w.container("project", "P", None);
    let task = w.task(Some(&project));
    let sub = w.task(Some(&task));
    w.ok("entity.trash", json!({"id": &task}));
    assert_eq!(w.trashed_by(&sub), Some(task.clone()));
    w.ok("entity.restore", json!({"id": &task}));
    assert!(!w.trashed(&sub));
    // A project holds sections and tasks; its section holds its tasks.
    let section = w.container("section", "S", Some(&project));
    let in_section = w.task(Some(&section));
    w.ok("entity.trash", json!({"id": &project}));
    assert_eq!(w.trashed_by(&section), Some(project.clone()));
    assert_eq!(w.trashed_by(&in_section), Some(section.clone()));
    w.ok("entity.restore", json!({"id": &project}));
    assert!(!w.trashed(&in_section));
    // An account holds its lines.
    let account = w.mint();
    let line = w.mint();
    w.commit(|tx| {
        tx.insert_entity(&account, Kind::Account, "Everyday", AT)?;
        tx.connection().execute(
            "INSERT INTO account (id, type, currency) VALUES (?1, 'checking', 'USD')",
            [&account],
        )?;
        tx.insert_entity(&line, Kind::Txn, "Coffee", AT)?;
        tx.connection().execute(
            "INSERT INTO txn (id, account_id, posted_on, amount_minor, entered) VALUES (?1, ?2, '2026-03-01', -450, 'hand')",
            [&line, &account],
        )?;
        Ok(())
    });
    w.ok("entity.trash", json!({"id": &account}));
    assert_eq!(w.trashed_by(&line), Some(account.clone()));
    assert!(
        w.refused("entity.restore", json!({"id": &line}))
            .contains("restore “Everyday” first")
    );
    w.ok("entity.restore", json!({"id": &account}));
    assert!(!w.trashed(&line));
    // A person holds what was written about them alone, and nothing else.
    let person = w.mint();
    w.commit(|tx| common::add_person(tx, &person, "Ada", AT));
    let alone = w.note("About Ada", None);
    let shared = w.note("About Ada and a task", None);
    let other = w.task(None);
    w.commit(|tx| {
        for (from, to) in [(&alone, &person), (&shared, &person), (&shared, &other)] {
            tx.connection().execute(
                "INSERT INTO edge (from_id, rel, to_id, created_at) VALUES (?1, 'about', ?2, ?3)",
                rusqlite::params![from, to, AT],
            )?;
        }
        Ok(())
    });
    w.ok("entity.trash", json!({"id": &person}));
    assert_eq!(w.trashed_by(&alone), Some(person.clone()));
    assert!(
        !w.trashed(&shared),
        "a note about two things is the member's own"
    );
}

#[test]
fn a_row_is_not_restored_inside_a_trash_and_the_sentence_names_the_holder() {
    let w = World::new();
    let book = w.container("notebook", "Recipes", None);
    let with = w.note("Soup", Some(&book));
    let own = w.note("Stew", Some(&book));
    w.ok("entity.trash", json!({"id": &own}));
    w.ok("entity.trash", json!({"id": &book}));
    // Taken with the holder, or trashed on its own beforehand: either way it is inside a trash.
    for id in [&with, &own] {
        assert!(
            w.refused("entity.restore", json!({"id": id}))
                .contains("restore “Recipes” first"),
        );
        assert!(w.trashed(id));
    }
    // The database says the same (an event cannot be anywhere else).
    let event = w.event("calendar:default");
    let cal = w.container("calendar", "Work", None);
    w.ok("entity.move", json!({"id": &event, "parent": &cal}));
    w.ok("entity.trash", json!({"id": &event}));
    w.ok("entity.trash", json!({"id": &cal}));
    assert!(
        w.refused("entity.restore", json!({"id": &event}))
            .contains("restore “Work” first")
    );
    w.ok("entity.restore", json!({"id": &cal}));
    w.ok("entity.restore", json!({"id": &event}));
    assert!(!w.trashed(&event));
}

// ---------------------------------------------------------------------------
// A purge
// ---------------------------------------------------------------------------

#[test]
fn a_purge_removes_contents_before_the_holder_and_moves_the_rest_to_the_top_level() {
    let w = World::new();
    let book = w.container("notebook", "Recipes", None);
    let inner = w.container("notebook", "Inner", Some(&book));
    let deep = w.note("Soup", Some(&inner));
    let back = w.note("Stew", Some(&book));
    let alone = w.note("Alone", Some(&book));
    // One member was in the trash before its notebook went: it is no one's contents.
    w.ok("entity.trash", json!({"id": &alone}));
    w.ok("entity.trash", json!({"id": &book}));
    assert_eq!(w.trashed_by(&alone), None);
    assert_eq!(w.trashed_by(&deep), Some(inner.clone()));

    let output = w.ok("entity.purge", json!({"id": &book}));
    let purged: Vec<&str> = output["purged"]
        .as_array()
        .expect("ids")
        .iter()
        .filter_map(|id| id.as_str())
        .collect();
    let at = |id: &str| purged.iter().position(|p| *p == id).expect("purged");
    assert!(
        at(&deep) < at(&inner) && at(&inner) < at(&book),
        "contents go first: {purged:?}"
    );
    assert!(at(&back) < at(&book), "contents go first: {purged:?}");
    for id in [&book, &inner, &deep, &back] {
        assert!(!w.exists(id));
    }
    assert!(
        w.exists(&alone),
        "a row trashed on its own is not lost with the holder"
    );
    assert_eq!(w.home(&alone), None, "it is at the top level now");
    assert!(w.trashed(&alone), "and still in the trash");
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM note WHERE id = ?1", &[&deep]),
        0,
        "the kind row went with the entity"
    );
}

#[test]
fn a_purge_refuses_with_a_sentence_when_something_would_lose_its_meaning() {
    let w = World::new();
    // The owner, and the calendar every vault is founded with.
    let me = w
        .vault()
        .self_id()
        .expect("reads")
        .expect("a founded vault has an owner");
    assert!(
        w.refused("entity.purge", json!({"id": me}))
            .contains("this is you")
    );
    assert!(
        w.refused("entity.trash", json!({"id": "calendar:default"}))
            .contains("founded with")
    );
    assert!(
        w.refused("entity.purge", json!({"id": "calendar:default"}))
            .contains("founded with")
    );
    // A calendar whose event was trashed on its own: the event cannot live without a calendar.
    let cal = w.container("calendar", "Work", None);
    let event = w.event(&cal);
    w.ok("entity.trash", json!({"id": &event}));
    w.ok("entity.trash", json!({"id": &cal}));
    let sentence = w.refused("entity.purge", json!({"id": &cal}));
    assert!(
        sentence.contains("1 event is still in “Work”"),
        "{sentence}"
    );
    assert!(w.exists(&cal) && w.exists(&event));
    // Once the event is gone, the calendar can go.
    w.ok("entity.purge", json!({"id": &event}));
    w.ok("entity.purge", json!({"id": &cal}));
    assert!(!w.exists(&cal));
    // A kind of workout in use is changed first (workout kinds have no trash, so no trash step).
    let run = "workout_kind:run";
    let workout = w.mint();
    w.commit(|tx| {
        tx.insert_entity(&workout, Kind::Workout, "Morning run", AT)?;
        tx.connection().execute(
            "INSERT INTO workout (id, type_id, starts) VALUES (?1, ?2, ?3)",
            rusqlite::params![workout, run, AT],
        )?;
        Ok(())
    });
    assert!(
        w.refused("entity.purge", json!({"id": run}))
            .contains("1 activity use")
    );
    // A category with a line filed under it.
    let account = w.mint();
    let line = w.mint();
    w.commit(|tx| {
        tx.insert_entity(&account, Kind::Account, "Everyday", AT)?;
        tx.connection().execute(
            "INSERT INTO account (id, type, currency) VALUES (?1, 'checking', 'USD')",
            [&account],
        )?;
        tx.insert_entity(&line, Kind::Txn, "Lunch", AT)?;
        tx.connection().execute(
            "INSERT INTO txn (id, account_id, posted_on, amount_minor, entered) VALUES (?1, ?2, '2026-03-01', -900, 'hand')",
            [&line, &account],
        )?;
        tx.connection().execute(
            "INSERT INTO txn_split (txn_id, position, category_id, amount_minor) VALUES (?1, 0, 'category:food', -900)",
            [&line],
        )?;
        Ok(())
    });
    assert!(
        w.refused("entity.purge", json!({"id": "category:food"}))
            .contains("1 line is filed under “Food”")
    );
    // A trash-less kind is deleted, not moved to the trash; a trash kind must be in it first.
    assert!(
        w.refused("entity.trash", json!({"id": "category:housing"}))
            .contains("is deleted, not moved to the trash")
    );
    let note = w.note("N", None);
    assert!(
        w.refused("entity.purge", json!({"id": &note}))
            .contains("not in the trash")
    );
}

#[test]
fn what_cannot_outlive_its_target_goes_with_it_and_what_can_lets_go() {
    let w = World::new();
    // An account's lines go with the account; a person's readings with the person.
    let account = w.mint();
    let line = w.mint();
    let person = w.mint();
    let reading = w.mint();
    w.commit(|tx| {
        tx.insert_entity(&account, Kind::Account, "Everyday", AT)?;
        tx.connection().execute(
            "INSERT INTO account (id, type, currency) VALUES (?1, 'checking', 'USD')",
            [&account],
        )?;
        tx.insert_entity(&line, Kind::Txn, "Coffee", AT)?;
        tx.connection().execute(
            "INSERT INTO txn (id, account_id, posted_on, amount_minor, entered) VALUES (?1, ?2, '2026-03-01', -450, 'hand')",
            [&line, &account],
        )?;
        common::add_person(tx, &person, "Ada", AT)?;
        tx.insert_entity(&reading, Kind::Reading, "", AT)?;
        tx.connection().execute(
            "INSERT INTO reading (id, person_id, metric, at, value) VALUES (?1, ?2, 'weight_kg', ?3, 60)",
            rusqlite::params![reading, person, AT],
        )?;
        Ok(())
    });
    // A line trashed on its own is still purged with its account.
    w.ok("entity.trash", json!({"id": &line}));
    w.ok("entity.trash", json!({"id": &account}));
    let out = w.ok("entity.purge", json!({"id": &account}));
    assert_eq!(out["purged"].as_array().expect("ids").len(), 2);
    assert!(!w.exists(&line));
    w.ok("entity.trash", json!({"id": &person}));
    w.ok("entity.purge", json!({"id": &person}));
    assert!(!w.exists(&reading));
    // A place lets go of the photographs and events that named it; a copy lets go of its original.
    let place = w.mint();
    let photo = w.mint();
    let copy = w.mint();
    let hash = centraid_vault::blob::content_digest(b"p");
    w.commit(|tx| {
        centraid_vault::blob::stage(tx.connection(), &hash, 1)?;
        tx.insert_entity(&place, Kind::Place, "Home", AT)?;
        tx.connection()
            .execute("INSERT INTO place (id) VALUES (?1)", [&place])?;
        for (id, edited_from) in [(&photo, None), (&copy, Some(&photo))] {
            tx.insert_entity(id, Kind::Photo, "p", AT)?;
            tx.connection().execute(
                "INSERT INTO photo (id, blob, media_type, form, place_id, edited_from)
                 VALUES (?1, ?2, 'image/jpeg', 'photo', ?3, ?4)",
                rusqlite::params![id, hash, place, edited_from],
            )?;
        }
        Ok(())
    });
    w.ok("entity.trash", json!({"id": &place}));
    w.ok("entity.purge", json!({"id": &place}));
    assert_eq!(
        w.one::<Option<String>>("SELECT place_id FROM photo WHERE id = ?1", &[&photo]),
        None
    );
    w.ok("entity.trash", json!({"id": &photo}));
    w.ok("entity.purge", json!({"id": &photo}));
    assert_eq!(
        w.one::<Option<String>>("SELECT edited_from FROM photo WHERE id = ?1", &[&copy]),
        None
    );
}

#[test]
fn an_entity_number_is_never_reused_after_a_purge() {
    let w = World::new();
    let first = w.note("First", None);
    let n = w.one::<i64>("SELECT n FROM entity WHERE id = ?1", &[&first]);
    w.ok("entity.trash", json!({"id": &first}));
    w.ok("entity.purge", json!({"id": &first}));
    assert!(!w.exists(&first));
    let second = w.note("Second", None);
    let m = w.one::<i64>("SELECT n FROM entity WHERE id = ?1", &[&second]);
    assert!(m > n, "the purged row's number {n} was given again as {m}");
}

#[test]
fn emptying_the_trash_takes_one_kind_or_all_and_only_what_is_due_when_asked() {
    let w = World::new();
    let note = w.note("N", None);
    let book = w.container("notebook", "B", None);
    let in_book = w.note("In B", Some(&book));
    for id in [&note, &book] {
        w.ok("entity.trash", json!({"id": id}));
    }
    // Not yet due: nothing.
    assert_eq!(
        w.ok("entity.empty_trash", json!({"due_only": true}))["purged"],
        0
    );
    // One kind.
    // (the notebook took its note with it, and a note is a note)
    assert_eq!(
        w.ok("entity.empty_trash", json!({"kind": "note"}))["purged"],
        2
    );
    assert!(!w.exists(&note) && !w.exists(&in_book) && w.exists(&book));
    // What is left, once it is due.
    // (the pass trusts a clock only within a week of the last write: the member writes on day 29)
    w.scratch.clock.advance_days(29);
    w.note("later", None);
    w.scratch.clock.advance_days(2);
    assert_eq!(
        w.ok("entity.empty_trash", json!({"due_only": true}))["purged"],
        1
    );
    assert!(!w.exists(&book));
    // A kind with no trash has none to empty, and `with_kind` needs `kind`.
    assert!(
        w.refused("entity.empty_trash", json!({"kind": "tag"}))
            .contains("no trash to empty")
    );
    assert!(
        w.refused("entity.empty_trash", json!({"with_kind": "note"}))
            .contains("second kind")
    );
}

// ---------------------------------------------------------------------------
// Flags are columns (A14)
// ---------------------------------------------------------------------------

#[test]
fn a_flag_is_an_instant_on_the_row_and_setting_it_is_not_an_edit() {
    let w = World::new();
    let project = w.container("project", "Move house", None);
    let note = w.note("N", None);
    // An edit first, so there is a revision for a flag to (not) add to.
    w.ok(
        "entity.retitle",
        json!({"id": &project, "title": "Move flat"}),
    );
    let stamp = w.stamp(&project);
    let revisions =
        |id: &str| w.one::<i64>("SELECT COUNT(*) FROM revision WHERE entity_id = ?1", &[id]);
    let before = revisions(&project);
    assert!(before > 0, "the retitle wrote a version");
    let writes = w.one::<i64>("SELECT writes FROM vault", &[]);

    assert_eq!(
        w.ok("flag.set", json!({"id": &project, "flag": "archived"}))["changed"],
        true
    );
    let first_star = {
        w.ok("flag.set", json!({"id": &project, "flag": "starred"}));
        w.one::<String>("SELECT starred_at FROM entity WHERE id = ?1", &[&project])
    };
    assert_eq!(first_star, w.vault().clock().now_text());
    assert_eq!(
        w.one::<Option<String>>("SELECT pinned_at FROM entity WHERE id = ?1", &[&project]),
        None
    );
    // Neither the "last edited" nor a revision moved; the search owes nothing.
    assert_eq!(w.stamp(&project), stamp, "a flag stamps no updated_at");
    assert_eq!(revisions(&project), before, "a flag writes no revision");
    // Setting it again keeps its first instant.
    assert_eq!(
        w.ok("flag.set", json!({"id": &project, "flag": "starred"}))["changed"],
        false
    );
    assert_eq!(
        w.one::<String>("SELECT starred_at FROM entity WHERE id = ?1", &[&project]),
        first_star
    );
    // The same for every kind but a missing or trashed row.
    for flag in ["starred", "pinned", "archived"] {
        w.ok("flag.set", json!({"id": &note, "flag": flag}));
        w.ok("flag.set", json!({"id": "category:food", "flag": flag}));
    }
    assert_eq!(
        w.ok("flag.clear", json!({"id": &project, "flag": "archived"}))["changed"],
        true
    );
    assert_eq!(
        w.ok("flag.clear", json!({"id": &project, "flag": "archived"}))["changed"],
        false
    );
    assert_eq!(w.stamp(&project), stamp);
    assert!(w.one::<i64>("SELECT writes FROM vault", &[]) >= writes);
    assert!(
        w.refused("flag.set", json!({"id": "nothing", "flag": "pinned"}))
            .contains("nothing with the id")
    );
    w.ok("entity.trash", json!({"id": &note}));
    assert!(
        w.refused("flag.set", json!({"id": &note, "flag": "pinned"}))
            .contains("in the trash")
    );
    // The shelves read the column: three flags, three partial indexes.
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM entity WHERE starred_at IS NOT NULL",
            &[]
        ),
        3
    );
}

// ---------------------------------------------------------------------------
// Ids (A17) and arrivals (A10)
// ---------------------------------------------------------------------------

#[test]
fn a_new_entity_id_is_a_uuid_v7_minted_from_the_injected_clock() {
    use centraid_vault::clock::{Clock as _, ClockIds, FixedClock};
    let dir = centraid_ontology::scratch::scratch_dir();
    std::fs::create_dir_all(&dir).expect("a scratch");
    let clock = std::sync::Arc::new(FixedClock::frozen());
    let vault = Vault::create_with(
        dir.join("vault.db"),
        Box::new(std::sync::Arc::clone(&clock)),
        Box::new(ClockIds::new(Box::new(std::sync::Arc::clone(&clock)))),
    )
    .expect("a vault");
    vault.found("Test", "Test Owner").expect("founded");
    let registry = Registry::with_system_commands().expect("a registry");
    let mut seen = Vec::new();
    for (days, title) in [(0, "A"), (1, "B"), (400, "C")] {
        clock.advance_days(days);
        let out = vault
            .execute(
                &registry,
                &Principal::owner("phone"),
                &Command::new(
                    "container.create",
                    json!({"kind": "notebook", "title": title}),
                ),
            )
            .expect("runs");
        seen.push((
            out.output["id"].as_str().expect("an id").to_owned(),
            clock.now_ms(),
        ));
    }
    for (id, ms) in &seen {
        assert!(centraid_vault::model::is_minted_id(id), "{id}");
        // The first 48 bits are the clock's milliseconds: not the host's.
        let prefix = format!("{:08x}-{:04x}", (ms >> 16) & 0xffff_ffff, ms & 0xffff);
        assert!(id.starts_with(&prefix), "{id} is not minted at {ms}");
    }
    assert!(
        seen[0].0 < seen[1].0 && seen[1].0 < seen[2].0,
        "v7 sorts by time"
    );
    // The founding's own slugs are untouched.
    assert!(seen.iter().all(|(id, _)| !id.contains(':')));
    let seeded: i64 = vault
        .read(|c| {
            Ok(c.query_row(
                "SELECT COUNT(*) FROM entity WHERE id LIKE '%:%' AND kind = substr(id, 1, instr(id, ':') - 1)",
                [],
                |r| r.get(0),
            )?)
        })
        .expect("counts");
    assert!(seeded > 0, "seeded slugs stay slugs");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_caller_chosen_id_is_a_uuid_v7_or_it_is_refused() {
    let w = World::new();
    let ok = w.mint();
    w.ok(
        "container.create",
        json!({"kind": "list", "title": "Mine", "id": &ok}),
    );
    assert!(w.exists(&ok));
    let outcome = w.vault().execute(
        &w.registry,
        &Principal::owner("phone"),
        &Command::new(
            "container.create",
            json!({"kind": "list", "title": "Slug", "id": "list:mine"}),
        ),
    );
    let error = outcome.expect_err("a slug is founding's alone");
    assert!(error.to_string().contains("UUIDv7"), "{error}");
    assert!(!w.exists("list:mine"));
}

#[test]
fn a_one_time_arrival_stamps_both_its_columns_and_makes_no_origin_or_source() {
    let w = World::new();
    let hash = centraid_vault::blob::content_digest(b"scan");
    w.commit(|tx| {
        centraid_vault::blob::stage(tx.connection(), &hash, 4)?;
        Ok(())
    });
    let counts = |w: &World| {
        (
            w.one::<i64>("SELECT COUNT(*) FROM origin", &[]),
            w.one::<i64>("SELECT COUNT(*) FROM source", &[]),
        )
    };
    let before = counts(&w);
    let id = w.ok(
        "probe.arrive",
        json!({"blob": &hash, "arrived_via": "scan", "arrived_label": "/home/me/receipts/2026/scan-001.pdf"}),
    )["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    assert_eq!(
        w.one::<String>("SELECT arrived_via FROM entity WHERE id = ?1", &[&id]),
        "scan"
    );
    assert_eq!(
        w.one::<String>("SELECT arrived_label FROM entity WHERE id = ?1", &[&id]),
        "scan-001.pdf",
        "a label is a file's own name, never a path"
    );
    assert_eq!(
        counts(&w),
        before,
        "an arrival is two columns, not a followed store"
    );
    // A typed item has neither, and the two come together or not at all.
    let typed = w.ok("probe.arrive", json!({"blob": &hash}))["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    assert_eq!(
        w.one::<Option<String>>("SELECT arrived_via FROM entity WHERE id = ?1", &[&typed]),
        None
    );
    for input in [
        json!({"blob": &hash, "arrived_via": "scan"}),
        json!({"blob": &hash, "arrived_label": "x.pdf"}),
        json!({"blob": &hash, "arrived_via": "vcard", "arrived_label": "x.vcf"}),
        json!({"blob": &hash, "arrived_via": "scan", "arrived_label": "  /  "}),
    ] {
        let error = w
            .vault()
            .execute(
                &w.registry,
                &Principal::owner("phone"),
                &Command::new("probe.arrive", input),
            )
            .expect_err("refused");
        assert!(error.to_string().contains("arrived_"), "{error}");
    }
}

// ---------------------------------------------------------------------------
// Tags and concepts (A1, A7, J1)
// ---------------------------------------------------------------------------

#[test]
fn a_new_label_wears_the_palette_colour_fewest_labels_wear_and_a_recolour_sticks() {
    let w = World::new();
    let note = w.note("Trip", None);
    let colour = |key: &str| {
        w.one::<Option<String>>("SELECT color FROM concept WHERE key = ?1", &[key])
            .expect("a label always has a colour")
    };
    // The first eight labels take the eight hues, in palette order: no colour repeats early.
    let labels = ["a", "b", "c", "d", "e", "f", "g", "h"];
    for label in labels {
        w.ok("tag.add", json!({"id": &note, "label": label}));
    }
    let seen: Vec<String> = labels.iter().map(|label| colour(label)).collect();
    assert_eq!(
        seen,
        [
            "blue",
            "mustard",
            "violet",
            "petrol",
            "indigo",
            "graphite",
            "raspberry",
            "orchid"
        ]
    );
    // The ninth starts the palette again, and a repeated tagging keeps the colour.
    w.ok("tag.add", json!({"id": &note, "label": "i"}));
    assert_eq!(colour("i"), "blue");
    w.ok("tag.add", json!({"id": &note, "label": "A"}));
    assert_eq!(colour("a"), "blue");
    // A colour asked for wins on a NEW label and never recolours a known one.
    w.ok(
        "tag.add",
        json!({"id": &note, "label": "j", "color": "orchid"}),
    );
    assert_eq!(colour("j"), "orchid");
    w.ok(
        "tag.add",
        json!({"id": &note, "label": "j", "color": "violet"}),
    );
    assert_eq!(colour("j"), "orchid");
    // The recolour is its own command, by the label's words.
    let done = w.ok("tag.color", json!({"label": "  J ", "color": "violet"}));
    assert_eq!(done["changed"], true);
    assert_eq!(colour("j"), "violet");
    assert_eq!(
        w.ok("tag.color", json!({"label": "j", "color": "violet"}))["changed"],
        false
    );
    assert!(
        w.refused("tag.color", json!({"label": "nope", "color": "blue"}))
            .contains("no such label")
    );
    // Only the palette's keys are colours.
    let outcome = w.run("tag.color", json!({"label": "j", "color": "#FF0000"}));
    assert_ne!(outcome.status, CommandStatus::Executed);
    // Only a concept kind that takes a colour wears one: a category, by the lookup row.
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM concept c JOIN concept_kind k ON k.code = c.kind
              WHERE c.color IS NOT NULL AND k.takes_color = 0",
            &[]
        ),
        0
    );
}

#[test]
fn a_tag_is_minted_by_its_folded_label_and_a_tagging_changes_nothing_on_the_entity() {
    let w = World::new();
    let note = w.note("Trip", None);
    let first = w.ok("tag.add", json!({"id": &note, "label": "Road  Trip"}));
    let tag = first["tag"].as_str().expect("a tag").to_owned();
    assert!(
        centraid_vault::model::is_minted_id(&tag),
        "a member's tag has a minted id: {tag}"
    );
    assert_eq!(first["added"], true);
    assert_eq!(
        w.one::<String>("SELECT key FROM concept WHERE id = ?1", &[&tag]),
        "road trip"
    );
    let again = w.ok("tag.add", json!({"id": &note, "label": "road trip"}));
    assert_eq!(again["added"], false, "the same word is the same tag");
    assert_eq!(again["tag"], tag.as_str());
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM concept WHERE kind = 'tag'", &[]),
        1
    );
    assert_eq!(
        w.one::<String>("SELECT title FROM entity WHERE id = ?1", &[&tag]),
        "Road Trip"
    );
    assert_eq!(w.stamp(&note), AT, "a tag is not a change to the note");
    assert_eq!(
        w.ok("tag.remove", json!({"id": &note, "label": "ROAD TRIP"}))["removed"],
        true
    );
    assert_eq!(
        w.ok("tag.remove", json!({"id": &note, "label": "never used"}))["removed"],
        false
    );
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM edge", &[]), 0);
    assert!(
        w.refused("tag.add", json!({"id": &note, "label": " "}))
            .contains("needs a word")
    );
}

#[test]
fn a_tag_goes_on_what_edge_shape_says_and_the_command_says_so_when_it_does_not() {
    let w = World::new();
    // Every linkable kind takes a tag: the wildcard is `entity_kind.linkable`, read from the table.
    let person = w.mint();
    w.commit(|tx| common::add_person(tx, &person, "Ada", AT));
    for id in [
        &w.note("N", None),
        &person,
        &w.task(None),
        &w.event("calendar:default"),
    ] {
        assert_eq!(
            w.ok("tag.add", json!({"id": id, "label": "x"}))["added"],
            true
        );
    }
    // A container, a concept, a chat and a reading take none.
    let notebook = w.container("notebook", "B", None);
    let thread = w.bare(Kind::Thread, "Chat", None);
    let reading = w.bare(Kind::Reading, "", None);
    for (id, noun) in [
        (notebook.as_str(), "notebook"),
        (thread.as_str(), "thread"),
        (reading.as_str(), "reading"),
        ("category:food", "category"),
    ] {
        let sentence = w.refused("tag.add", json!({"id": id, "label": "x"}));
        assert_eq!(sentence, format!("a {noun} does not take a tag"));
        let sentence = w.refused("tag.remove", json!({"id": id, "label": "x"}));
        assert_eq!(sentence, format!("a {noun} does not take a tag"));
    }
    // The table says the same for every kind, so the command and the database agree.
    let kinds: Vec<(String, bool)> = w
        .vault()
        .read(|c| {
            let mut statement =
                c.prepare("SELECT code, linkable FROM entity_kind ORDER BY code")?;
            Ok(statement
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<_>>()?)
        })
        .expect("kinds");
    assert!(kinds.iter().any(|(_, linkable)| *linkable) && kinds.iter().any(|(_, l)| !*l));
}

#[test]
fn a_concept_hierarchy_is_the_home_of_its_own_kind() {
    let w = World::new();
    let note = w.note("N", None);
    let food = w.ok("tag.add", json!({"id": &note, "label": "Food"}))["tag"]
        .as_str()
        .expect("a tag")
        .to_owned();
    let soup = w.ok("tag.add", json!({"id": &note, "label": "Soup"}))["tag"]
        .as_str()
        .expect("a tag")
        .to_owned();
    w.ok("entity.move", json!({"id": &soup, "parent": &food}));
    // A loop of tags, and a tag inside a category, are refused.
    assert!(
        w.refused("entity.move", json!({"id": &food, "parent": &soup}))
            .contains("cannot go inside itself")
    );
    assert!(
        w.refused(
            "entity.move",
            json!({"id": &soup, "parent": "category:food"})
        )
        .contains("does not go inside a category")
    );
    // A category goes under a category (the seeded ones are the member's too).
    w.ok(
        "entity.move",
        json!({"id": "category:food.dining", "parent": "category:fun"}),
    );
    // A concept is purged outright (it has no trash) and what sat in it goes to the top.
    w.ok("entity.purge", json!({"id": &food}));
    assert!(!w.exists(&food));
    assert_eq!(w.home(&soup), None);
}

// ---------------------------------------------------------------------------
// vault.rename
// ---------------------------------------------------------------------------

#[test]
fn the_vault_is_renamed_by_its_own_command_and_never_to_nothing() {
    let w = World::new();
    let named = |w: &World| -> String { w.one("SELECT name FROM vault", &[]) };
    let out = w.ok("vault.rename", json!({"name": "  Family  "}));
    assert_eq!(out["name"], "Family");
    assert_eq!(named(&w), "Family");
    assert_eq!(
        w.ok("vault.rename", json!({"name": "Family"}))["changed"],
        false
    );
    assert!(
        w.refused("vault.rename", json!({"name": "   "}))
            .contains("something in it")
    );
    assert!(
        w.refused("vault.rename", json!({"name": "x".repeat(61)}))
            .contains("at most 60")
    );
    assert_eq!(
        named(&w),
        "Family",
        "a refused rename leaves the name alone"
    );
}

// ---------------------------------------------------------------------------
// The words the commands interpret equal the rows and columns they name
// ---------------------------------------------------------------------------

#[test]
fn the_flags_the_arrivals_and_the_colours_are_what_the_founded_file_holds() {
    use centraid_vault::commands::container::{LIST_COLORS, PHONE_CALENDAR_COLORS};
    use centraid_vault::commands::flag::Flag;
    use centraid_vault::commands::tag::LABEL_COLORS;
    use std::collections::BTreeSet;

    let w = World::new();
    let words = |sql: &str| -> BTreeSet<String> {
        w.vault()
            .read(|c| {
                Ok(c.prepare(sql)?
                    .query_map([], |r| r.get::<_, String>(0))?
                    .collect::<rusqlite::Result<_>>()?)
            })
            .expect("reads")
    };
    // A flag is a column of `entity`, and each is the only `_at` flag column there is.
    let columns =
        words("SELECT name FROM pragma_table_info('entity') WHERE name LIKE '%\\_at' ESCAPE '\\'");
    for flag in Flag::ALL {
        assert!(columns.contains(flag.column()), "{}", flag.column());
    }
    // The ways a one-time arrival comes in are the `arrival_via` rows.
    let via = words("SELECT code FROM arrival_via");
    let ours: BTreeSet<String> = arrival::SYSTEMS
        .iter()
        .map(|(name, _)| (*name).to_owned())
        .collect();
    assert_eq!(ours, via);
    // Every colour a command offers or reads is a key of the palette.
    let palette = words("SELECT key FROM palette");
    for color in LIST_COLORS
        .iter()
        .chain(&PHONE_CALENDAR_COLORS)
        .chain(&LABEL_COLORS)
    {
        assert!(palette.contains(*color), "{color} is not a palette key");
    }
    // The kinds of container and concept are the rows of their lookups, with the Rust enum.
    assert_eq!(
        words("SELECT code FROM container_kind"),
        Kind::CONTAINERS
            .iter()
            .map(|k| k.as_str().to_owned())
            .collect()
    );
    assert_eq!(
        words("SELECT code FROM concept_kind"),
        Kind::CONCEPTS
            .iter()
            .map(|k| k.as_str().to_owned())
            .collect()
    );
}
