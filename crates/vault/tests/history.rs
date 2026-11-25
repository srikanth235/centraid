//! Every record keeps its earlier values (#1185, rewritten on the v0 tables for #1214, K6): one
//! history, kept at the commit door.
//!
//! Kinds are made the way a per-kind command makes them (the entity row in its home, then the kind
//! row, through the commit guard) where their app module is not plugged in yet, so each rule is
//! proved against the tables and not against a command that has not been rewritten. Everything the
//! shared verbs can do (`note.*`, `entity.*`, `container.create`, `flag.*`, `history.*`) goes
//! through the registry. What is asserted is rows and values, never time.

mod common;

use std::collections::BTreeSet;

use centraid_vault::commands::{
    CommandCondition, CommandCtx, CommandDefinition, Idempotency, Registry,
};
use centraid_vault::history::{self, Actor, BLOB_SLOTS, Role, SHAPE_VERSION, TABLES, Version, Who};
use centraid_vault::model::Kind;
use centraid_vault::{Command, CommandStatus, CommitTx, Principal};
use serde_json::{Value, json};

const AT: &str = "2026-03-01T09:00:00.000Z";

struct World {
    scratch: common::Scratch,
    registry: Registry,
}

/// A `revision` row, as a test reads it.
#[derive(Debug)]
struct Rev {
    seq: i64,
    at: String,
    actor: String,
    origin_id: Option<String>,
    cause: String,
    shape: i64,
    state: Value,
    body: Option<String>,
    autosave: bool,
    touched_at: Option<String>,
}

/// An edit of a note's words and title the way the notes lane's `note.edit` makes one: through
/// the kind row and the entity, stamped, with nothing derived. (The notes lane re-proves its own
/// command; what is proved here is the history's door, which does not care who wrote the rows.)
fn edit_note(ctx: &CommandCtx<'_, '_>) -> centraid_vault::Result<Value> {
    let id = ctx.required_str("id")?.to_owned();
    if let Some(body) = ctx.input.get("body").and_then(Value::as_str) {
        ctx.connection()
            .execute("UPDATE note SET body = ?2 WHERE id = ?1", [&id, body])?;
    }
    if let Some(title) = ctx.input.get("title").and_then(Value::as_str) {
        ctx.connection()
            .execute("UPDATE entity SET title = ?2 WHERE id = ?1", [&id, title])?;
    }
    ctx.touch(&id)?;
    Ok(json!({ "id": id }))
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

    fn advance(&self, ms: i64) {
        self.scratch.clock.advance_ms(ms);
    }

    /// Run `command` at the clock's present instant.
    fn exec(&self, command: &Command) -> centraid_vault::CommandOutcome {
        self.scratch
            .vault
            .execute(&self.registry, &Principal::owner("phone"), command)
            .unwrap_or_else(|error| panic!("`{}`: {error}", command.name))
    }

    fn run(&self, name: &str, input: Value) -> centraid_vault::CommandOutcome {
        self.advance(1_000);
        self.exec(&Command::new(name, input))
    }

    fn ok(&self, name: &str, input: Value) -> Value {
        let outcome = self.run(name, input);
        assert_eq!(
            outcome.status,
            CommandStatus::Executed,
            "{name}: {:?}",
            outcome.reason
        );
        outcome.output
    }

    fn ok_command(&self, command: &Command) -> Value {
        let outcome = self.exec(command);
        assert_eq!(
            outcome.status,
            CommandStatus::Executed,
            "{}: {:?}",
            command.name,
            outcome.reason
        );
        outcome.output
    }

    fn refused(&self, name: &str, input: Value) -> String {
        let outcome = self.run(name, input);
        assert_eq!(outcome.status, CommandStatus::Failed, "{name} not refused");
        outcome.reason.expect("a sentence")
    }

    fn id_of(&self, name: &str, input: Value) -> String {
        self.ok(name, input)["id"]
            .as_str()
            .expect("an id")
            .to_owned()
    }

    /// A note as the notes lane's `note.create` will make one: the entity in its home, then the
    /// kind row.
    fn note(&self, title: &str, body: &str, notebook: Option<&str>) -> String {
        self.make(
            Kind::Note,
            title,
            notebook,
            &format!(
                "INSERT INTO note (id, body) VALUES ('{{id}}', '{}')",
                body.replace('\'', "''")
            ),
        )
    }

    fn container(&self, kind: &str, title: &str, parent: Option<&str>) -> String {
        self.id_of(
            "container.create",
            json!({"kind": kind, "title": title, "parent": parent}),
        )
    }

    fn mint(&self) -> String {
        self.scratch.vault.ids().next()
    }

    /// Raw SQL through the commit guard, as the caller named: the door a command or a follow pass
    /// opens says who acted.
    fn commit_as(
        &self,
        actor: Actor,
        body: impl FnOnce(&CommitTx<'_>) -> centraid_vault::Result<()>,
    ) {
        self.advance(1_000);
        self.scratch
            .vault
            .commit(|tx| {
                tx.set_producer("test.fixture");
                tx.set_actor(actor);
                body(tx)
            })
            .expect("the commit lands");
    }

    fn commit(&self, body: impl FnOnce(&CommitTx<'_>) -> centraid_vault::Result<()>) {
        self.commit_as(Actor::Member, body);
    }

    fn sql(&self, statements: &str) {
        self.commit(|tx| {
            tx.connection().execute_batch(statements)?;
            Ok(())
        });
    }

    /// An entity of `kind` and its kind row, made in one commit.
    fn make(&self, kind: Kind, title: &str, parent: Option<&str>, kind_row: &str) -> String {
        let id = self.mint();
        let kind_row = kind_row.replace("{id}", &id);
        self.commit(|tx| {
            tx.insert_entity_in(&id, kind, title, parent, AT)?;
            tx.connection().execute_batch(&kind_row)?;
            Ok(())
        });
        id
    }

    /// A blob row for `seed`'s bytes (the bytes themselves are not needed to name them).
    fn blob(&self, seed: &str) -> String {
        let hash = centraid_vault::blob::content_digest(seed.as_bytes());
        self.sql(&format!(
            "INSERT INTO blob (hash, size) VALUES ('{hash}', {}) ON CONFLICT (hash) DO NOTHING",
            seed.len()
        ));
        hash
    }

    fn one<T: rusqlite::types::FromSql>(&self, sql: &str) -> T {
        self.scratch
            .vault
            .read(|c| Ok(c.query_row(sql, [], |row| row.get(0))?))
            .unwrap_or_else(|error| panic!("{sql}: {error}"))
    }

    fn revisions(&self, id: &str) -> Vec<Rev> {
        self.scratch
            .vault
            .read(|c| {
                let mut statement = c.prepare(
                    "SELECT seq, at, actor, origin_id, cause, shape, state, body, autosave, touched_at
                       FROM revision WHERE entity_id = ?1 ORDER BY seq",
                )?;
                let rows = statement
                    .query_map([id], |row| {
                        let state: String = row.get(6)?;
                        Ok(Rev {
                            seq: row.get(0)?,
                            at: row.get(1)?,
                            actor: row.get(2)?,
                            origin_id: row.get(3)?,
                            cause: row.get(4)?,
                            shape: row.get(5)?,
                            state: serde_json::from_str(&state).expect("a state is JSON"),
                            body: row.get(7)?,
                            autosave: row.get(8)?,
                            touched_at: row.get(9)?,
                        })
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })
            .expect("revisions")
    }

    /// `(slot, blob, media_type)` of a version, by slot.
    fn kept_blobs(&self, id: &str, seq: i64) -> Vec<(String, String, Option<String>)> {
        self.scratch
            .vault
            .read(|c| {
                let mut statement = c.prepare(
                    "SELECT slot, blob, media_type FROM revision_blob
                      WHERE entity_id = ?1 AND seq = ?2 ORDER BY slot",
                )?;
                let rows = statement
                    .query_map(rusqlite::params![id, seq], |row| {
                        Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })
            .expect("kept blobs")
    }

    fn versions(&self, id: &str) -> Vec<Version> {
        self.scratch
            .vault
            .read(|c| history::earlier_versions(c, id, None, 100))
            .expect("the read")
            .versions
    }

    fn state(&self, id: &str) -> Value {
        self.scratch
            .vault
            .read(|c| history::current_state(c, id))
            .expect("state")
            .expect("an entity")
    }

    fn version_state(&self, id: &str, seq: i64) -> Value {
        self.scratch
            .vault
            .read(|c| history::version_state(c, id, seq))
            .expect("version state")
            .expect("a version")
    }

    fn stamp(&self, id: &str) -> String {
        self.scratch
            .vault
            .read(|c| {
                Ok(
                    c.query_row("SELECT updated_at FROM entity WHERE id = ?1", [id], |row| {
                        row.get(0)
                    })?,
                )
            })
            .expect("a stamp")
    }

    fn home(&self, id: &str) -> Option<String> {
        self.scratch
            .vault
            .read(|c| {
                Ok(
                    c.query_row("SELECT parent_id FROM entity WHERE id = ?1", [id], |row| {
                        row.get(0)
                    })?,
                )
            })
            .expect("a home")
    }

    fn revision_count(&self) -> i64 {
        self.one("SELECT COUNT(*) FROM revision")
    }
}

fn change(version: &Version, field: &str) -> (Value, Value) {
    let change = version
        .changes
        .iter()
        .find(|change| change.field == field)
        .unwrap_or_else(|| panic!("no change to `{field}` in {:?}", version.changes));
    (change.before.clone(), change.after.clone())
}

/// A followed origin of a system that fills nothing, for a store's revisions to name.
fn origin(w: &World, system: &str) -> String {
    let id = w.mint();
    w.sql(&format!(
        "INSERT INTO origin (id, system, ref, label, created_at)
         VALUES ('{id}', '{system}', 'ref-{id}', 'Phone', '{AT}')"
    ));
    id
}

// ---------------------------------------------------------------------------------------------
// The classification
// ---------------------------------------------------------------------------------------------

#[test]
fn every_table_every_kind_and_every_blob_column_is_classified() {
    let w = World::new("classified");
    // Every table of the file is classified (a new table fails here until it says what it is).
    let unclassified = w
        .scratch
        .vault
        .read(history::Shape::unclassified)
        .expect("unclassified");
    assert!(
        unclassified.is_empty(),
        "unclassified tables: {unclassified:?}"
    );
    // Every classified table exists (nothing dormant).
    let tables: BTreeSet<String> = w
        .scratch
        .vault
        .read(|c| {
            let mut statement =
                c.prepare("SELECT name FROM pragma_table_list WHERE schema = 'main'")?;
            Ok(statement
                .query_map([], |row| row.get(0))?
                .collect::<rusqlite::Result<_>>()?)
        })
        .expect("tables");
    for (name, _) in TABLES {
        assert!(
            tables.contains(*name),
            "`{name}` is classified but not a table"
        );
    }
    // Every kind's kind row is a host, and a host that no kind names is dormant.
    let hosts: BTreeSet<&str> = TABLES
        .iter()
        .filter(|(_, role)| matches!(role, Role::Host))
        .map(|(name, _)| *name)
        .collect();
    let named: BTreeSet<&str> = Kind::ALL.iter().map(|kind| kind.host()).collect();
    assert_eq!(hosts, named, "the hosts are exactly the kinds' kind rows");
    // Every child hangs from a host, and every column an OMITTED row names exists.
    for (name, role) in TABLES {
        if let Role::Child { hosts: of, via } = role {
            assert!(of.iter().all(|host| hosts.contains(host)), "{name}'s hosts");
            assert!(column_exists(&w, name, via), "{name}.{via}");
        }
    }
    for (table, column, reason) in history::OMITTED {
        assert!(
            column_exists(&w, table, column),
            "OMITTED `{table}.{column}` is no column"
        );
        assert!(!reason.is_empty());
    }
}

fn column_exists(w: &World, table: &str, column: &str) -> bool {
    w.one::<i64>(&format!(
        "SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name = '{column}'"
    )) == 1
}

#[test]
fn every_blob_column_is_a_slot_or_omitted() {
    let w = World::new("slots");
    // Every slot names a real column that references `blob(hash)`.
    for slot in BLOB_SLOTS {
        assert!(column_exists(&w, slot.table, slot.column), "{slot:?}");
        let refs: i64 = w.one(&format!(
            "SELECT COUNT(*) FROM pragma_foreign_key_list('{}')
              WHERE \"from\" = '{}' AND \"table\" = 'blob' AND \"to\" = 'hash'",
            slot.table, slot.column
        ));
        assert_eq!(refs, 1, "{slot:?} does not reference blob(hash)");
        if let Some(media) = slot.media_type {
            assert!(column_exists(&w, slot.table, media), "{slot:?}");
        }
    }
    // And every column of a state-bearing table that references `blob(hash)` is one.
    let mut unclassified = Vec::new();
    for (name, role) in TABLES {
        if !matches!(role, Role::Host | Role::Child { .. }) {
            continue;
        }
        let columns: Vec<String> = w
            .scratch
            .vault
            .read(|c| {
                let mut statement = c.prepare(&format!(
                    "SELECT \"from\" FROM pragma_foreign_key_list('{name}') WHERE \"table\" = 'blob'"
                ))?;
                Ok(statement
                    .query_map([], |row| row.get(0))?
                    .collect::<rusqlite::Result<_>>()?)
            })
            .expect("foreign keys");
        for column in columns {
            let omitted = history::OMITTED
                .iter()
                .any(|(table, omitted, _)| table == name && *omitted == column);
            if !omitted && history::blob_slot(name, &column).is_none() {
                unclassified.push(format!("{name}.{column}"));
            }
        }
    }
    assert!(
        unclassified.is_empty(),
        "blob columns that are neither a slot nor omitted: {unclassified:?}"
    );
}

// ---------------------------------------------------------------------------------------------
// B4: who made the change
// ---------------------------------------------------------------------------------------------

#[test]
fn every_revision_names_who_made_it_and_the_door_says_so() {
    let w = World::new("actors");
    let note = w.note("One", "", None);
    let origin_id = origin(&w, "contacts");

    w.ok("entity.retitle", json!({"id": note, "title": "Two"}));
    w.advance(1_000);
    w.ok_command(
        &Command::new("entity.retitle", json!({"id": note, "title": "Three"})).by("assist"),
    );
    w.advance(1_000);
    w.ok_command(
        &Command::new("entity.retitle", json!({"id": note, "title": "Four"})).as_actor(
            Actor::Store {
                origin_id: origin_id.clone(),
            },
        ),
    );
    // A raw commit says who it is by what the caller told the door, not by what it writes.
    w.commit_as(Actor::Assistant, |tx| {
        tx.connection()
            .execute("UPDATE entity SET title = 'Five' WHERE id = ?1", [&note])?;
        Ok(())
    });
    w.commit_as(
        Actor::Store {
            origin_id: origin_id.clone(),
        },
        |tx| {
            tx.connection()
                .execute("UPDATE entity SET title = 'Six' WHERE id = ?1", [&note])?;
            Ok(())
        },
    );
    // A commit that says nothing is the member's.
    w.sql(&format!(
        "UPDATE entity SET title = 'Seven' WHERE id = '{note}'"
    ));

    let revisions = w.revisions(&note);
    let who: Vec<(&str, Option<&str>)> = revisions
        .iter()
        .map(|rev| (rev.actor.as_str(), rev.origin_id.as_deref()))
        .collect();
    assert_eq!(
        who,
        [
            ("member", None),
            ("assistant", None),
            ("store", Some(origin_id.as_str())),
            ("assistant", None),
            ("store", Some(origin_id.as_str())),
            ("member", None),
        ]
    );
    // The cause is the command, a diagnostic: the door's name is not folded into it.
    assert_eq!(revisions[1].cause, "entity.retitle");
    assert!(revisions.iter().all(|rev| !rev.cause.starts_with("assist")));
    assert!(revisions.iter().all(|rev| rev.shape == SHAPE_VERSION));

    // The read says the same, with the system of a store's origin.
    let by: Vec<Who> = w.versions(&note).into_iter().rev().map(|v| v.by).collect();
    assert_eq!(
        by,
        [
            Who::Member,
            Who::Assistant,
            Who::Store("contacts".to_owned()),
            Who::Assistant,
            Who::Store("contacts".to_owned()),
            Who::Member,
        ]
    );
}

// ---------------------------------------------------------------------------------------------
// B1: what a snapshot holds
// ---------------------------------------------------------------------------------------------

fn keys(state: &Value) -> BTreeSet<String> {
    state
        .as_object()
        .expect("a state is an object")
        .keys()
        .cloned()
        .collect()
}

#[test]
fn a_hosts_snapshot_holds_its_title_home_kind_row_and_owned_children_only() {
    let w = World::new("grammar");
    let notebook = w.container("notebook", "Work", None);
    let person = w.make(
        Kind::Person,
        "Alex",
        None,
        "INSERT INTO person (id) VALUES ('{id}')",
    );
    let other = w.make(
        Kind::Person,
        "Sam",
        None,
        "INSERT INTO person (id) VALUES ('{id}')",
    );
    w.sql(&format!(
        "INSERT INTO contact_point (id, person_id, kind, value, normalized, position)
         VALUES ('cp-1', '{person}', 'email', 'a@x.org', 'a@x.org', 1)"
    ));
    // Things that decorate the record but are not its own: a hand-made link, a tag edge.
    let (a, b) = if person < other {
        (&person, &other)
    } else {
        (&other, &person)
    };
    w.sql(&format!(
        "INSERT INTO link (a, b, created_at) VALUES ('{a}', '{b}', '{AT}')"
    ));
    let _ = notebook;

    w.ok(
        "entity.retitle",
        json!({"id": person, "title": "Alexandra"}),
    );
    // The newest version holds the state before the rename (the child row's arrival made the first).
    let held = w.revisions(&person).pop().expect("a version");
    assert_eq!(
        keys(&held.state),
        [
            "contact_point",
            "entity",
            "person_date",
            "person",
            "reminder"
        ]
        .map(str::to_owned)
        .into_iter()
        .collect()
    );
    assert_eq!(
        held.state["entity"],
        json!({"title": "Alex", "parent_id": null})
    );
    assert!(held.state["contact_point"][0]["value"] == "a@x.org");

    // A link made or broken is nobody's version.
    let before = w.revision_count();
    w.sql(&format!("DELETE FROM link WHERE a = '{a}' AND b = '{b}'"));
    assert_eq!(w.revision_count(), before, "a link is outside a snapshot");
}

#[test]
fn setting_a_budget_writes_no_copy_of_the_categorys_other_budgets_or_rules() {
    let w = World::new("budget");
    let category = w.make(
        Kind::Category,
        "Groceries",
        None,
        "INSERT INTO concept (id, kind, key) VALUES ('{id}', 'category', 'groceries')",
    );
    w.sql(&format!(
        "INSERT INTO budget (category_id, month, amount_minor) VALUES
           ('{category}', '2026-01', 100), ('{category}', '2026-02', 200), ('{category}', '2026-03', 300);
         INSERT INTO rule (id, pattern, category_id, position, created_at)
           VALUES ('r1', '{{\"v\":1}}', '{category}', 1, '{AT}')"
    ));
    let stamp = w.stamp(&category);
    w.sql(&format!(
        "UPDATE budget SET amount_minor = 999 WHERE category_id = '{category}' AND month = '2026-02';
         DELETE FROM rule WHERE id = 'r1'"
    ));
    assert_eq!(
        w.revision_count(),
        0,
        "a budget or a rule is not part of the category's snapshot"
    );
    assert_eq!(w.stamp(&category), stamp);

    // A rename keeps the category's own state and none of them.
    w.ok("entity.retitle", json!({"id": category, "title": "Food"}));
    let held = &w.revisions(&category)[0];
    assert_eq!(
        keys(&held.state),
        ["concept", "entity"]
            .map(str::to_owned)
            .into_iter()
            .collect()
    );
    assert!(!held.state.to_string().contains("amount_minor"));
}

#[test]
fn a_move_writes_a_revision_whose_state_holds_the_old_home() {
    let w = World::new("move");
    let a = w.container("notebook", "A", None);
    let b = w.container("notebook", "B", None);
    let note = w.note("Plan", "words", Some(&a));
    let stamp = w.stamp(&note);

    w.ok("entity.move", json!({"id": note, "parent": b}));
    let revisions = w.revisions(&note);
    assert_eq!(revisions.len(), 1);
    assert_eq!(revisions[0].state["entity"]["parent_id"], json!(a));
    assert_ne!(w.stamp(&note), stamp, "a move is an edit");
    let version = &w.versions(&note)[0];
    assert_eq!(change(version, "entity.parent_id"), (json!(a), json!(b)));
    // To the top level and back reads the same way.
    w.ok("entity.move", json!({"id": note, "parent": null}));
    assert_eq!(w.revisions(&note)[1].state["entity"]["parent_id"], json!(b));
}

#[test]
fn a_version_written_in_a_newer_grammar_is_refused_not_misread() {
    let w = World::new("grammar-version");
    let note = w.note("One", "", None);
    w.ok("entity.retitle", json!({"id": note, "title": "Two"}));
    w.sql(&format!(
        "INSERT INTO revision (entity_id, seq, at, actor, shape, state)
         VALUES ('{note}', 2, '{AT}', 'member', {}, '{{}}')",
        SHAPE_VERSION + 1
    ));
    let read = w
        .scratch
        .vault
        .read(|c| history::version_state(c, &note, 2));
    assert!(
        read.expect_err("a newer grammar is refused")
            .to_string()
            .contains("newer than this build"),
    );
    assert!(
        w.scratch
            .vault
            .read(|c| history::version_state(c, &note, 1))
            .is_ok()
    );
}

// ---------------------------------------------------------------------------------------------
// B3: every blob slot
// ---------------------------------------------------------------------------------------------

/// A version names the blob a slot held, keeps no hash in its state, and a restore writes it back
/// through the same table (which makes a new version holding the bytes it replaced).
fn assert_slot_kept_and_restored(
    w: &World,
    id: &str,
    slot: &str,
    old: &str,
    new: &str,
    read_column: &str,
    replace: &str,
) {
    w.sql(replace);
    let revisions = w.revisions(id);
    let last = revisions.last().expect("a version");
    let kept = w.kept_blobs(id, last.seq);
    assert!(
        kept.iter().any(|(s, hash, _)| s == slot && hash == old),
        "{slot}: {kept:?}"
    );
    assert!(
        !last.state.to_string().contains(old),
        "the state holds no hash: {}",
        last.state
    );
    // The whole version has the blob back where the table has it.
    let state = w.version_state(id, last.seq);
    assert!(state.to_string().contains(old), "{state}");
    // The blob is held while the version is (a purge of the blob is refused).
    assert!(
        w.scratch
            .vault
            .commit(|tx| {
                tx.connection()
                    .execute("DELETE FROM blob WHERE hash = ?1", [old])?;
                Ok(())
            })
            .is_err(),
        "a blob a version names cannot be dropped"
    );
    // A restore puts it back, and keeps what it replaced.
    let out = w.ok(
        "history.restore_version",
        json!({"id": id, "seq": last.seq}),
    );
    assert_eq!(out["restored"], json!(true), "{out}");
    assert_eq!(w.one::<String>(read_column), old);
    let after = w.revisions(id);
    let newest = after.last().expect("the restore's version");
    assert!(newest.seq > last.seq);
    assert!(
        w.kept_blobs(id, newest.seq)
            .iter()
            .any(|(s, hash, _)| s == slot && hash == new),
        "{slot}: the restore kept {new}"
    );
}

#[test]
fn a_documents_bytes_and_media_type_are_a_slot() {
    let w = World::new("slot-document");
    let (one, two) = (w.blob("one"), w.blob("two"));
    let id = w.make(
        Kind::Document,
        "Notes",
        None,
        &format!(
            "INSERT INTO document (id, blob, media_type) VALUES ('{{id}}', '{one}', 'text/plain')"
        ),
    );
    assert_slot_kept_and_restored(
        &w,
        &id,
        "blob",
        &one,
        &two,
        &format!("SELECT blob FROM document WHERE id = '{id}'"),
        &format!(
            "UPDATE document SET blob = '{two}', media_type = 'text/markdown' WHERE id = '{id}'"
        ),
    );
    let revisions = w.revisions(&id);
    // The media type is kept beside the bytes and out of the state.
    assert_eq!(
        w.kept_blobs(&id, revisions[0].seq)[0].2.as_deref(),
        Some("text/plain")
    );
    assert!(revisions[0].state["document"].get("media_type").is_none());
    assert_eq!(
        w.one::<String>(&format!(
            "SELECT media_type FROM document WHERE id = '{id}'"
        )),
        "text/plain"
    );
}

#[test]
fn a_persons_avatar_is_a_slot() {
    let w = World::new("slot-avatar");
    let (one, two) = (w.blob("face one"), w.blob("face two"));
    let id = w.make(
        Kind::Person,
        "Alex",
        None,
        &format!("INSERT INTO person (id, avatar) VALUES ('{{id}}', '{one}')"),
    );
    assert_slot_kept_and_restored(
        &w,
        &id,
        "avatar",
        &one,
        &two,
        &format!("SELECT avatar FROM person WHERE id = '{id}'"),
        &format!("UPDATE person SET avatar = '{two}' WHERE id = '{id}'"),
    );
}

#[test]
fn a_containers_cover_is_a_slot() {
    let w = World::new("slot-cover");
    let (one, two) = (w.blob("cover one"), w.blob("cover two"));
    let id = w.container("album", "Trip", None);
    w.sql(&format!(
        "UPDATE container SET cover = '{one}' WHERE id = '{id}'"
    ));
    assert_slot_kept_and_restored(
        &w,
        &id,
        "cover",
        &one,
        &two,
        &format!("SELECT cover FROM container WHERE id = '{id}'"),
        &format!("UPDATE container SET cover = '{two}' WHERE id = '{id}'"),
    );
}

#[test]
fn a_photos_motion_clip_is_a_slot() {
    let w = World::new("slot-motion");
    let (file, one, two) = (w.blob("still"), w.blob("clip one"), w.blob("clip two"));
    let id = w.make(
        Kind::Photo,
        "Beach",
        None,
        &format!(
            "INSERT INTO photo (id, blob, media_type, form, motion_blob)
             VALUES ('{{id}}', '{file}', 'image/jpeg', 'photo', '{one}')"
        ),
    );
    assert_slot_kept_and_restored(
        &w,
        &id,
        "motion",
        &one,
        &two,
        &format!("SELECT motion_blob FROM photo WHERE id = '{id}'"),
        &format!("UPDATE photo SET motion_blob = '{two}' WHERE id = '{id}'"),
    );
    // The still is the photograph's identity: never a state, never a slot.
    assert!(
        w.revisions(&id)
            .iter()
            .all(|rev| !rev.state.to_string().contains(&file))
    );
}

#[test]
fn a_note_asset_is_a_slot_per_row_and_a_removed_asset_comes_back() {
    let w = World::new("slot-asset");
    let (one, two) = (w.blob("asset one"), w.blob("asset two"));
    let note = w.note("Trip", "see the map", None);
    w.sql(&format!(
        "INSERT INTO note_asset (id, note_id, blob, name, media_type, position)
         VALUES ('as-1', '{note}', '{one}', 'map.png', 'image/png', 1),
                ('as-2', '{note}', '{two}', 'tickets.pdf', 'application/pdf', 2)"
    ));
    // One asset is removed: the version names both, by the row's id.
    w.sql("DELETE FROM note_asset WHERE id = 'as-1'");
    // Version 1 is the note before its assets arrived; version 2 holds both.
    let revisions = w.revisions(&note);
    assert_eq!(revisions.len(), 2);
    let kept = w.kept_blobs(&note, 2);
    assert_eq!(
        kept,
        [
            (
                "asset:as-1".to_owned(),
                one.clone(),
                Some("image/png".to_owned())
            ),
            (
                "asset:as-2".to_owned(),
                two.clone(),
                Some("application/pdf".to_owned())
            ),
        ]
    );
    assert!(!revisions[1].state.to_string().contains(&one));
    let assets = &revisions[1].state["note_asset"];
    assert!(assets[0].get("blob").is_none() && assets[0].get("media_type").is_none());

    let out = w.ok("history.restore_version", json!({"id": note, "seq": 2}));
    assert_eq!(out["restored"], json!(true), "{out}");
    assert_eq!(
        w.one::<String>("SELECT blob FROM note_asset WHERE id = 'as-1'"),
        one
    );
    assert_eq!(
        w.one::<String>("SELECT media_type FROM note_asset WHERE id = 'as-1'"),
        "image/png"
    );
}

/// A sealed Locker item fixture: one key generation, an item, a plain field and a sealed file.
fn locker_item(w: &World, file: &str) -> String {
    w.sql(&format!(
        "INSERT INTO locker_key (id, key_id, created_at) VALUES (1, 'k1', '{AT}')"
    ));
    let id = w.make(
        Kind::LockerItem,
        "Passport scan",
        None,
        "INSERT INTO locker_item (id, type) VALUES ('{id}', 'document')",
    );
    w.sql(&format!(
        "INSERT INTO locker_item_field (id, item_id, label, kind, value_sealed, value_blob, key_id,
                                       value_set_at, created_at, updated_at)
         VALUES ('f-file', '{id}', 'Scan', 'file', 'lk1:AAAA', '{file}', 'k1', '{AT}', '{AT}', '{AT}')"
    ));
    id
}

#[test]
fn a_locker_sealed_file_is_a_slot_per_field_and_stays_sealed() {
    let w = World::new("slot-locker");
    let (one, two) = (w.blob("sealed file one"), w.blob("sealed file two"));
    let id = locker_item(&w, &one);
    assert_slot_kept_and_restored(
        &w,
        &id,
        "field:f-file",
        &one,
        &two,
        "SELECT value_blob FROM locker_item_field WHERE id = 'f-file'",
        &format!(
            "UPDATE locker_item_field SET value_blob = '{two}', value_sealed = 'lk1:BBBB',
                    updated_at = '{AT}' WHERE id = 'f-file'"
        ),
    );
    // The sealed cell came back as the ciphertext it was, and the read masks it.
    assert_eq!(
        w.one::<String>("SELECT value_sealed FROM locker_item_field WHERE id = 'f-file'"),
        "lk1:AAAA"
    );
    let versions = w.versions(&id);
    let (before, after) = change(&versions[1], "locker_item_field[f-file].value_sealed");
    assert_eq!(
        (before, after),
        (json!(history::MASK), json!(history::MASK)),
        "a changed secret is seen to have changed and nothing more"
    );
}

#[test]
fn no_hash_is_stored_inside_a_state_or_a_cause() {
    let w = World::new("one-hash");
    let (one, two) = (w.blob("a"), w.blob("b"));
    let doc = w.make(
        Kind::Document,
        "Doc",
        None,
        &format!(
            "INSERT INTO document (id, blob, media_type) VALUES ('{{id}}', '{one}', 'text/plain')"
        ),
    );
    w.sql(&format!(
        "UPDATE document SET blob = '{two}' WHERE id = '{doc}'"
    ));
    let person = w.make(
        Kind::Person,
        "Alex",
        None,
        &format!("INSERT INTO person (id, avatar) VALUES ('{{id}}', '{one}')"),
    );
    w.sql(&format!(
        "UPDATE person SET avatar = NULL WHERE id = '{person}'"
    ));
    let texts: Vec<String> = w
        .scratch
        .vault
        .read(|c| {
            let mut statement =
                c.prepare("SELECT state || ' ' || cause || ' ' || ifnull(body, '') FROM revision")?;
            Ok(statement
                .query_map([], |row| row.get(0))?
                .collect::<rusqlite::Result<_>>()?)
        })
        .expect("texts");
    assert!(texts.len() >= 2);
    for text in texts {
        let mut run = 0;
        for byte in text.bytes() {
            run = if byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte) {
                run + 1
            } else {
                0
            };
            assert!(run < 64, "a 64-hex value in a revision: {text}");
        }
    }
    // Every blob a version names is a real claim.
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM revision_blob rb LEFT JOIN blob b ON b.hash = rb.blob WHERE b.hash IS NULL"
        ),
        0
    );
}

#[test]
fn an_empty_slot_is_kept_as_null_and_a_restore_clears_it() {
    let w = World::new("slot-empty");
    let one = w.blob("face");
    let id = w.make(
        Kind::Person,
        "Alex",
        None,
        "INSERT INTO person (id) VALUES ('{id}')",
    );
    w.sql(&format!(
        "UPDATE person SET avatar = '{one}' WHERE id = '{id}'"
    ));
    let held = &w.revisions(&id)[0];
    assert_eq!(held.state["person"].get("avatar"), Some(&Value::Null));
    assert!(w.kept_blobs(&id, 1).is_empty());
    w.ok("history.restore_version", json!({"id": id, "seq": 1}));
    assert_eq!(
        w.one::<Option<String>>(&format!("SELECT avatar FROM person WHERE id = '{id}'")),
        None
    );
    // What the restore replaced is kept, with the avatar it named.
    assert_eq!(w.kept_blobs(&id, 2)[0].1, one);
}

// ---------------------------------------------------------------------------------------------
// B4/restore: putting a version back
// ---------------------------------------------------------------------------------------------

/// A document in `folder`, holding `blob`, as the documents lane's `document.add` will make one.
fn document(w: &World, title: &str, folder: Option<&str>, blob: &str) -> String {
    w.make(
        Kind::Document,
        title,
        folder,
        &format!(
            "INSERT INTO document (id, blob, media_type) VALUES ('{{id}}', '{blob}', 'text/plain')"
        ),
    )
}

#[test]
fn a_restore_writes_the_state_back_through_the_same_tables_and_is_itself_undone_by_restoring() {
    let w = World::new("restore");
    let blob = w.blob("words");
    let a = w.container("folder", "A", None);
    let b = w.container("folder", "B", None);
    let doc = document(&w, "First", Some(&a), &blob);
    w.ok("entity.retitle", json!({"id": doc, "title": "Second"}));
    w.sql(&format!(
        "UPDATE document SET media_type = 'text/markdown' WHERE id = '{doc}'"
    ));
    w.ok("entity.move", json!({"id": doc, "parent": b}));
    assert_eq!(w.revisions(&doc).len(), 3);

    // Version 1 held title First, text/plain, home A.
    let out = w.ok("history.restore_version", json!({"id": doc, "seq": 1}));
    assert_eq!(out["restored"], json!(true));
    assert_eq!(out["kept_current"], json!([]));
    assert_eq!(w.home(&doc).as_deref(), Some(a.as_str()));
    let state = w.state(&doc);
    assert_eq!(state["entity"]["title"], "First");
    assert_eq!(state["document"]["media_type"], "text/plain");
    // The restore is a version: what it replaced (Second, markdown, home B) is kept.
    let revisions = w.revisions(&doc);
    assert_eq!(revisions.len(), 4);
    assert_eq!(revisions[3].state["entity"]["parent_id"], json!(b));
    assert_eq!(revisions[3].cause, "history.restore_version");
    // And restoring that puts it all back.
    w.ok("history.restore_version", json!({"id": doc, "seq": 4}));
    assert_eq!(w.home(&doc).as_deref(), Some(b.as_str()));
    assert_eq!(w.state(&doc)["entity"]["title"], "Second");
    assert_eq!(w.state(&doc)["document"]["media_type"], "text/markdown");
    // Restoring what is already held writes nothing.
    let before = w.revision_count();
    let out = w.ok("history.restore_version", json!({"id": doc, "seq": 4}));
    assert_eq!(out["restored"], json!(false));
    assert_eq!(w.revision_count(), before);
}

#[test]
fn a_restore_leaves_the_home_where_it_is_when_the_old_home_can_no_longer_hold_it() {
    let w = World::new("restore-home");
    let blob = w.blob("words");
    // A home in the trash.
    let (a, b) = (
        w.container("folder", "A", None),
        w.container("folder", "B", None),
    );
    let doc = document(&w, "Plan", Some(&a), &blob);
    w.ok("entity.retitle", json!({"id": doc, "title": "Plan 2"}));
    w.ok("entity.move", json!({"id": doc, "parent": b}));
    w.ok("entity.trash", json!({"id": a}));
    let out = w.ok("history.restore_version", json!({"id": doc, "seq": 1}));
    assert_eq!(
        out["restored"],
        json!(true),
        "the title still comes back: {out}"
    );
    assert_eq!(out["kept_current"], json!(["entity.parent_id"]));
    assert_eq!(w.home(&doc).as_deref(), Some(b.as_str()));
    assert_eq!(w.state(&doc)["entity"]["title"], "Plan");

    // A home that is gone.
    w.ok("entity.purge", json!({"id": a}));
    let out = w.ok("history.restore_version", json!({"id": doc, "seq": 1}));
    assert_eq!(out["kept_current"], json!(["entity.parent_id"]), "{out}");
    assert_eq!(w.home(&doc).as_deref(), Some(b.as_str()));
}

#[test]
fn a_restore_never_puts_a_holder_inside_what_it_holds() {
    let w = World::new("restore-loop");
    let f1 = w.container("folder", "F1", None);
    let f2 = w.container("folder", "F2", Some(&f1));
    // F2 leaves F1, then F1 goes inside F2.
    w.ok("entity.move", json!({"id": f2, "parent": null}));
    w.ok("entity.move", json!({"id": f1, "parent": f2}));
    // F2's first version has it inside F1, which is now inside F2.
    let out = w.ok("history.restore_version", json!({"id": f2, "seq": 1}));
    assert_eq!(out["kept_current"], json!(["entity.parent_id"]), "{out}");
    assert_eq!(w.home(&f2), None);
    assert_eq!(w.home(&f1).as_deref(), Some(f2.as_str()));
}

#[test]
fn a_restore_refuses_a_version_that_is_not_there_and_a_trashed_record() {
    let w = World::new("restore-refused");
    let note = w.note("One", "", None);
    w.ok("entity.retitle", json!({"id": note, "title": "Two"}));
    assert_eq!(
        w.refused("history.restore_version", json!({"id": note, "seq": 9})),
        "That version is not in this record's history."
    );
    w.ok("entity.trash", json!({"id": note}));
    w.refused("history.restore_version", json!({"id": note, "seq": 1}));
    // The database says the same of a blob claim on a version that is not there.
    let hash = w.blob("x");
    let refused = w.scratch.vault.commit(|tx| {
        tx.connection().execute(
            "INSERT INTO revision_blob (entity_id, seq, slot, blob) VALUES (?1, 99, 'blob', ?2)",
            [&note, &hash],
        )?;
        Ok(())
    });
    assert!(refused.is_err());
}

#[test]
fn undoing_the_last_change_and_a_named_one_that_nothing_has_changed_again() {
    let w = World::new("undo");
    let blob = w.blob("words");
    let doc = document(&w, "One", None, &blob);
    w.ok("entity.retitle", json!({"id": doc, "title": "Two"}));
    w.sql(&format!(
        "UPDATE document SET media_type = 'text/markdown' WHERE id = '{doc}'"
    ));
    // Undo the newest.
    w.ok("history.undo", json!({"id": doc}));
    assert_eq!(w.state(&doc)["document"]["media_type"], "text/plain");
    assert_eq!(w.state(&doc)["entity"]["title"], "Two");
    // Undo the retitle by name: its field was not changed since.
    w.ok("history.undo", json!({"id": doc, "seq": 1}));
    assert_eq!(w.state(&doc)["entity"]["title"], "One");
    // A change whose field was changed again since is refused, and nothing is written.
    let other = document(&w, "A", None, &blob);
    w.ok("entity.retitle", json!({"id": other, "title": "B"}));
    w.ok("entity.retitle", json!({"id": other, "title": "C"}));
    let before = w.revision_count();
    assert_eq!(
        w.refused("history.undo", json!({"id": other, "seq": 1})),
        "This can no longer be undone: it has changed since."
    );
    assert_eq!(w.revision_count(), before);
}

#[test]
fn the_words_of_a_refused_stale_save_are_kept_beside_the_record_as_it_is() {
    let w = World::new("keep");
    let note = w.note("Draft", "mine", None);
    w.ok("probe.note_edit", json!({"id": note, "body": "theirs"}));
    let held = w.revision_count();
    let out = w.ok(
        "history.keep_version",
        json!({"id": note, "fields": {"note.body": "my unsaved words"}}),
    );
    assert_eq!(out["kept"], json!(true));
    assert_eq!(w.revision_count(), held + 1);
    assert_eq!(
        w.state(&note)["note"]["body"],
        "theirs",
        "the record is not changed"
    );
    let kept = w.revisions(&note).pop().expect("the kept version");
    assert_eq!(kept.body.as_deref(), Some("my unsaved words"));
    // A sealed cell, a blob and a field the record does not keep are refused.
    for field in [
        "note.nope",
        "locker_item_field.value_sealed",
        "document.blob",
    ] {
        w.refused(
            "history.keep_version",
            json!({"id": note, "fields": {field: "x"}}),
        );
    }
    // Words the record already holds keep nothing.
    let out = w.ok(
        "history.keep_version",
        json!({"id": note, "fields": {"note.body": "theirs"}}),
    );
    assert_eq!(out["kept"], json!(false));
}

// ---------------------------------------------------------------------------------------------
// A14: flags and uses are not edits
// ---------------------------------------------------------------------------------------------

#[test]
fn starring_pinning_archiving_and_a_locker_use_write_no_revision_and_leave_updated_at_alone() {
    let w = World::new("flags");
    let note = w.note("Plan", "words", None);
    let item = locker_item(&w, &w.blob("scan"));
    // Settle: nothing owed from creation.
    let (stamp, item_stamp, count) = (w.stamp(&note), w.stamp(&item), w.revision_count());
    let item_versions = w.revisions(&item).len();
    for flag in ["starred", "pinned", "archived"] {
        w.ok("flag.set", json!({"id": note, "flag": flag}));
    }
    w.ok("flag.clear", json!({"id": note, "flag": "starred"}));
    w.sql(&format!(
        "UPDATE locker_item SET last_used_at = '2026-03-02T10:00:00.000Z' WHERE id = '{item}'"
    ));
    assert_eq!(w.revision_count(), count, "no flag or use is a version");
    assert_eq!(w.stamp(&note), stamp, "no flag moves updated_at");
    assert_eq!(w.stamp(&item), item_stamp, "a use does not move updated_at");
    // And the state a later edit keeps holds none of them.
    w.ok("entity.retitle", json!({"id": note, "title": "Plan 2"}));
    let held = &w.revisions(&note)[0];
    assert!(!held.state.to_string().contains("_at"));
    // A real edit of a Locker item still is one.
    w.sql(&format!(
        "UPDATE locker_item SET compromised = 1 WHERE id = '{item}'"
    ));
    assert_eq!(w.revisions(&item).len(), item_versions + 1);
}

// ---------------------------------------------------------------------------------------------
// Counts: creation, unchanged commits, pages
// ---------------------------------------------------------------------------------------------

#[test]
fn an_unchanged_commit_writes_zero_versions_and_creating_many_writes_none() {
    let w = World::new("zero");
    for n in 0..20 {
        w.note(&format!("Note {n}"), "words", None);
    }
    assert_eq!(w.revision_count(), 0);
    let note = w.note("Plan", "words", None);
    // Writing what is held writes nothing.
    w.ok(
        "probe.note_edit",
        json!({"id": note, "title": "Plan", "body": "words"}),
    );
    w.sql(&format!("UPDATE note SET body = body WHERE id = '{note}'"));
    assert_eq!(w.revision_count(), 0);
    w.ok("entity.trash", json!({"id": note}));
    w.ok("entity.restore", json!({"id": note}));
    assert_eq!(w.revision_count(), 0, "trash is not state");
}

#[test]
fn a_page_of_versions_is_keyset_paged_and_a_trashed_item_offers_none() {
    let w = World::new("pages");
    let note = w.note("v0", "", None);
    for n in 1..=5 {
        w.ok(
            "entity.retitle",
            json!({"id": note, "title": format!("v{n}")}),
        );
    }
    let page = |before| {
        w.scratch
            .vault
            .read(|c| history::earlier_versions(c, &note, before, 2))
            .expect("a page")
    };
    let first = page(None);
    assert_eq!(
        first.versions.iter().map(|v| v.seq).collect::<Vec<_>>(),
        [5, 4]
    );
    let second = page(first.next);
    assert_eq!(
        second.versions.iter().map(|v| v.seq).collect::<Vec<_>>(),
        [3, 2]
    );
    let third = page(second.next);
    assert_eq!(
        third.versions.iter().map(|v| v.seq).collect::<Vec<_>>(),
        [1]
    );
    assert_eq!(third.next, None);
    assert_eq!(
        change(&first.versions[0], "entity.title"),
        (json!("v4"), json!("v5"))
    );

    let offered = |w: &World| {
        w.scratch
            .vault
            .read(|c| history::offered(c, &note))
            .expect("offered")
    };
    assert_eq!(offered(&w), 5);
    w.ok("entity.trash", json!({"id": note}));
    assert_eq!(offered(&w), 0);
    w.ok("entity.restore", json!({"id": note}));
    assert_eq!(offered(&w), 5, "the entry returns with the record");
}

#[test]
fn a_purge_takes_the_history_with_it() {
    let w = World::new("purge");
    let (one, two) = (w.blob("p1"), w.blob("p2"));
    let doc = w.make(
        Kind::Document,
        "Doc",
        None,
        &format!(
            "INSERT INTO document (id, blob, media_type) VALUES ('{{id}}', '{one}', 'text/plain')"
        ),
    );
    w.sql(&format!(
        "UPDATE document SET blob = '{two}' WHERE id = '{doc}'"
    ));
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM revision_blob"), 1);
    w.ok("entity.trash", json!({"id": doc}));
    w.ok("entity.purge", json!({"id": doc}));
    assert_eq!(w.revision_count(), 0);
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM revision_blob"), 0);
}

// ---------------------------------------------------------------------------------------------
// Quiet saves fold
// ---------------------------------------------------------------------------------------------

const IDLE: i64 = 10 * 60 * 1000;

fn quiet(name: &str, input: Value) -> Command {
    Command::new(name, input).quiet()
}

#[test]
fn quiet_saves_within_the_session_are_one_version_holding_the_state_before_it() {
    let w = World::new("fold");
    let note = w.note("Draft", "start", None);
    let edit =
        |body: &str| w.ok_command(&quiet("probe.note_edit", json!({"id": note, "body": body})));
    w.advance(1_000);
    edit("a");
    let began = w.revisions(&note);
    assert_eq!(began.len(), 1);
    assert!(began[0].autosave);
    assert_eq!(began[0].body.as_deref(), Some("start"));
    assert_eq!(began[0].touched_at, None);

    w.advance(1_000);
    edit("ab");
    w.advance(1_000);
    edit("abc");
    let folded = w.revisions(&note);
    assert_eq!(folded.len(), 1, "two saves folded into the session");
    // Only `touched_at` moved: what the version holds never does.
    assert_eq!(folded[0].at, began[0].at);
    assert_eq!(folded[0].state, began[0].state);
    assert_eq!(folded[0].body, began[0].body);
    assert_eq!(folded[0].cause, began[0].cause);
    assert_eq!(folded[0].actor, began[0].actor);
    assert_ne!(folded[0].touched_at, None);
    assert_eq!(w.state(&note)["note"]["body"], "abc");
    // The database holds that line: nothing but `touched_at` of a revision may move.
    let refused = w.scratch.vault.commit(|tx| {
        tx.connection().execute(
            "UPDATE revision SET state = '{}' WHERE entity_id = ?1",
            [&note],
        )?;
        Ok(())
    });
    assert!(
        refused
            .expect_err("history")
            .to_string()
            .contains("a revision is history")
    );
}

#[test]
fn the_idle_gap_is_ten_minutes_to_the_millisecond_and_a_sitting_ends_after_an_hour() {
    let w = World::new("fold-gaps");
    let note = w.note("Draft", "start", None);
    let edit = |body: &str, wait: i64| {
        w.advance(wait);
        w.ok_command(&quiet("probe.note_edit", json!({"id": note, "body": body})));
    };
    edit("a", 1_000);
    edit("b", IDLE);
    assert_eq!(
        w.revisions(&note).len(),
        1,
        "exactly ten idle minutes still folds"
    );
    edit("c", IDLE + 1);
    assert_eq!(
        w.revisions(&note).len(),
        2,
        "a millisecond more starts a new version"
    );

    // Typing steadily: a version at least every hour, however steady.
    let steady = w.note("Long", "start", None);
    for n in 0..8 {
        w.advance(9 * 60 * 1000);
        w.ok_command(&quiet(
            "probe.note_edit",
            json!({"id": steady, "body": format!("b{n}")}),
        ));
    }
    // Saves at 9, 18, ... 72 minutes: the first writes, those up to 69 minutes fold... the one
    // that would be an hour past the first starts the next.
    assert_eq!(w.revisions(&steady).len(), 2);
}

#[test]
fn a_different_actor_command_or_an_act_between_ends_the_session() {
    let w = World::new("fold-ends");
    let note = w.note("Draft", "start", None);
    let origin_id = origin(&w, "files");
    let save = |command: Command| {
        w.advance(1_000);
        w.ok_command(&command);
    };
    let body = |text: &str| json!({"id": note, "body": text});
    save(quiet("probe.note_edit", body("a")));
    save(quiet("probe.note_edit", body("b")));
    assert_eq!(w.revisions(&note).len(), 1);
    // The assistant's quiet save of the same command is not the member's session.
    save(quiet("probe.note_edit", body("c")).by("assist"));
    assert_eq!(w.revisions(&note).len(), 2);
    save(quiet("probe.note_edit", body("d")).by("assist"));
    assert_eq!(w.revisions(&note).len(), 2, "the same actor folds");
    // A store is its own, and each origin is its own.
    save(quiet("probe.note_edit", body("e")).as_actor(Actor::Store {
        origin_id: origin_id.clone(),
    }));
    assert_eq!(w.revisions(&note).len(), 3);
    save(quiet("probe.note_edit", body("f")).as_actor(Actor::Store {
        origin_id: origin_id.clone(),
    }));
    assert_eq!(w.revisions(&note).len(), 3);
    // Another command, a plain save and the history's own all end it on both sides.
    save(quiet("entity.retitle", json!({"id": note, "title": "T1"})));
    assert_eq!(w.revisions(&note).len(), 4);
    save(Command::new("probe.note_edit", body("g")));
    assert_eq!(w.revisions(&note).len(), 5);
    save(quiet("probe.note_edit", body("h")));
    assert_eq!(w.revisions(&note).len(), 6);
    save(quiet("probe.note_edit", body("i")));
    assert_eq!(w.revisions(&note).len(), 6);
}

#[test]
fn a_restore_never_folds_even_marked_quiet() {
    let w = World::new("fold-restore");
    let blob = w.blob("words");
    let doc = document(&w, "A", None, &blob);
    let save = |command: Command| {
        w.advance(1_000);
        w.ok_command(&command);
    };
    save(quiet("entity.retitle", json!({"id": doc, "title": "B"})));
    save(quiet("entity.retitle", json!({"id": doc, "title": "C"})));
    assert_eq!(w.revisions(&doc).len(), 1, "the retitles folded");
    // Each restore, marked quiet by its caller, is a version of its own, and so is the one after.
    for (n, seq) in [(2, 1), (3, 2), (4, 1), (5, 4)] {
        save(quiet(
            "history.restore_version",
            json!({"id": doc, "seq": seq}),
        ));
        assert_eq!(w.revisions(&doc).len(), n, "restore of version {seq}");
    }
    assert!(w.revisions(&doc)[1..].iter().all(|rev| !rev.autosave));
}

#[test]
fn a_body_edit_after_a_title_save_starts_a_version_that_keeps_the_words_the_first_elided() {
    let w = World::new("fold-body");
    let note = w.note("Draft", "original words", None);
    let save = |command: Command| {
        w.advance(1_000);
        w.ok_command(&command);
    };
    save(quiet(
        "probe.note_edit",
        json!({"id": note, "title": "Draft 2"}),
    ));
    let first = w.revisions(&note);
    assert_eq!(first.len(), 1);
    assert_eq!(
        first[0].body, None,
        "the words did not change, so none are copied"
    );
    save(quiet(
        "probe.note_edit",
        json!({"id": note, "body": "new words"}),
    ));
    assert_eq!(
        w.revisions(&note).len(),
        2,
        "the words the first needs would have been lost"
    );
    save(quiet(
        "probe.note_edit",
        json!({"id": note, "body": "newer words"}),
    ));
    assert_eq!(
        w.revisions(&note).len(),
        2,
        "later saves fold into the second"
    );
    // The elided version reads as it was: the words come from the next newer version that has them.
    assert_eq!(w.version_state(&note, 1)["note"]["body"], "original words");
    assert_eq!(w.version_state(&note, 2)["note"]["body"], "original words");
    assert_eq!(w.version_state(&note, 2)["entity"]["title"], "Draft 2");
}
