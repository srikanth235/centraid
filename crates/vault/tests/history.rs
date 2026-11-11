//! Every record keeps its earlier values (#1185): one history, kept at the commit door.
//!
//! Each kind is edited twice, read back as earlier versions with their diffs, restored to the
//! first, undone, and purged. What is asserted is rows and values, never time.

mod common;

use centraid_vault::commands::Registry;
use centraid_vault::history::{self, Role, Version, Who};
use centraid_vault::model::Kind;
use centraid_vault::{Command, CommandStatus, Principal};
use serde_json::{Value, json};

struct World {
    scratch: common::Scratch,
    registry: Registry,
}

impl World {
    fn new() -> Self {
        Self {
            scratch: common::Scratch::founded("history").expect("a vault"),
            registry: Registry::with_system_commands().expect("a registry"),
        }
    }

    fn run(&self, name: &str, input: Value) -> centraid_vault::CommandOutcome {
        self.scratch.clock.advance_ms(1_000);
        self.scratch
            .vault
            .execute(
                &self.registry,
                &Principal::owner("phone"),
                &Command::new(name, input),
            )
            .unwrap_or_else(|error| panic!("`{name}`: {error}"))
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

    fn refused(&self, name: &str, input: Value) -> String {
        let outcome = self.run(name, input);
        assert_eq!(outcome.status, CommandStatus::Failed, "{name} not refused");
        outcome.reason.expect("a sentence")
    }

    fn id(&self, name: &str, input: Value) -> String {
        let out = self.ok(name, input);
        ["id", "workout_id", "note_id"]
            .iter()
            .find_map(|key| out[*key].as_str())
            .expect("an id")
            .to_owned()
    }

    fn count(&self, sql: &str) -> i64 {
        self.scratch
            .vault
            .read(|c| Ok(c.query_row(sql, [], |row| row.get(0))?))
            .expect("a count")
    }

    fn revisions(&self) -> i64 {
        self.count("SELECT COUNT(*) FROM revision")
    }

    fn versions(&self, id: &str) -> Vec<Version> {
        self.scratch
            .vault
            .read(|c| history::earlier_versions(c, id, None, 100))
            .expect("the read")
            .versions
    }

    /// The entity's whole state now.
    fn state(&self, id: &str) -> Value {
        self.scratch
            .vault
            .read(|c| history::current_state(c, id))
            .expect("state")
            .expect("an entity")
    }

    /// The change a version made to a field.
    fn change(version: &Version, field: &str) -> (Value, Value) {
        let change = version
            .changes
            .iter()
            .find(|change| change.field == field)
            .unwrap_or_else(|| panic!("no change to `{field}` in {:?}", version.changes));
        (change.before.clone(), change.after.clone())
    }

    fn bytes(&self, seed: &str) -> String {
        let hash = centraid_vault::blob::content_digest(seed.as_bytes());
        self.ok("blob.stage", json!({ "hash": hash, "size": seed.len() }));
        hash
    }

    /// Restore the first (oldest) version, undo that, and purge: the same story for every kind.
    /// `edited` is the state after both edits.
    fn story(&self, id: &str, first: &Value) {
        let edited = self.state(id);
        let versions = self.versions(id);
        assert_eq!(versions.len(), 2, "two edits, two earlier versions");
        assert!(versions[0].seq > versions[1].seq, "newest first");
        let oldest = versions[1].seq;
        let out = self.ok(
            "history.restore_version",
            json!({ "id": id, "seq": oldest }),
        );
        assert_eq!(out["restored"], true);
        assert_eq!(
            &self.state(id),
            first,
            "restoring the first version brings the first state"
        );
        assert_eq!(self.versions(id).len(), 3, "a restore is itself a version");
        // Restoring what is held again writes nothing.
        let again = self.ok(
            "history.restore_version",
            json!({ "id": id, "seq": oldest }),
        );
        assert_eq!(again["restored"], false);
        assert_eq!(self.versions(id).len(), 3);
        // Undo the restore: back to what it replaced.
        self.ok("history.undo", json!({ "id": id }));
        assert_eq!(
            self.state(id),
            edited,
            "undo puts back the state the restore replaced"
        );
        assert_eq!(self.versions(id).len(), 4);
    }

    fn purge_takes_history(&self, id: &str) {
        assert!(
            self.count(&format!(
                "SELECT COUNT(*) FROM revision WHERE entity_id = '{id}'"
            )) > 0
        );
        self.ok("entity.trash", json!({ "id": id }));
        // Trash is not a change to what the record holds.
        let kept = self.versions(id).len();
        self.ok("entity.restore", json!({ "id": id }));
        assert_eq!(
            self.versions(id).len(),
            kept,
            "trash and restore keep history as it was"
        );
        self.ok("entity.trash", json!({ "id": id }));
        self.ok("entity.purge", json!({ "id": id }));
        assert_eq!(
            self.count(&format!(
                "SELECT COUNT(*) FROM revision WHERE entity_id = '{id}'"
            )),
            0,
            "deleting means deleting: the history goes with the record"
        );
    }
}

// ---------------------------------------------------------------------------------------------
// The classification
// ---------------------------------------------------------------------------------------------

#[test]
fn every_table_every_kind_and_every_relation_is_classified() {
    let w = World::new();
    w.scratch
        .vault
        .read(|c| {
            let loose = history::Shape::unclassified(c)?;
            assert!(loose.is_empty(), "tables the history does not classify: {loose:?}");
            // Every kind has a kind row the history captures.
            let shape = history::shape(c)?;
            for kind in Kind::ALL {
                let host = shape.hosts().any(|part| part.name == kind.host());
                assert!(host, "kind `{}` has no classified kind row `{}`", kind.as_str(), kind.host());
            }
            // Every relation the baseline allows is state or argued out.
            let sql: String = c.query_row(
                "SELECT sql FROM sqlite_schema WHERE name = 'edge'",
                [],
                |row| row.get(0),
            )?;
            let list = sql
                .split("rel        TEXT NOT NULL CHECK (rel IN")
                .nth(1)
                .and_then(|rest| rest.split(')').next())
                .expect("the relation list");
            for rel in list.split(',').map(|rel| rel.trim().trim_matches(['(', '\'', '\n', ' '])) {
                let state = history::TABLES.iter().any(|(table, role)| {
                    *table == "edge"
                        && matches!(role, Role::Child { filter: Some(f), .. } if f.contains(&format!("'{rel}'")))
                });
                let outside = history::RELATIONS_OUTSIDE.iter().any(|(named, _)| *named == rel);
                assert!(state ^ outside, "relation `{rel}` is neither state nor argued out (or both)");
            }
            // A child is a cascade from the entity or its kind row, through the column it names.
            for part in &shape.parts {
                let Role::Child { via, .. } = part.role else { continue };
                let cascades = c
                    .prepare(&format!("PRAGMA foreign_key_list(\"{}\")", part.name))?
                    .query_map([], |row| Ok((row.get::<_, String>(3)?, row.get::<_, String>(6)?)))?
                    .collect::<rusqlite::Result<Vec<_>>>()?
                    .iter()
                    .any(|(from, rule)| from == via && rule == "CASCADE");
                assert!(cascades, "`{}`.`{via}` does not cascade from its owner", part.name);
            }
            // Nothing captured is a blob-typed cell (it could not be a JSON value), and every
            // omitted column is a real one (no entry outlives its column).
            for (table, column, why) in history::OMITTED {
                assert!(!why.is_empty());
                let found: i64 = c.query_row(
                    &format!("SELECT COUNT(*) FROM pragma_table_xinfo('{table}') WHERE name = ?1"),
                    [column],
                    |row| row.get(0),
                )?;
                assert_eq!(found, 1, "`{table}.{column}` is omitted but is not a column");
            }
            for part in &shape.parts {
                let blobs: i64 = c.query_row(
                    &format!(
                        "SELECT COUNT(*) FROM pragma_table_xinfo('{}') WHERE type = 'BLOB'",
                        part.name
                    ),
                    [],
                    |row| row.get(0),
                )?;
                assert_eq!(blobs, 0, "`{}` has a BLOB column", part.name);
            }
            for (table, column, _) in history::CONTENT {
                let part = shape.part(table).expect("content lives on a kind row");
                assert!(part.columns.iter().any(|name| name == column));
            }
            // Every sealed column is KEPT (as ciphertext) and is the history's own mask list, so a
            // sealed column added to custody is masked on read without a second edit.
            for (table, column) in [
                ("locker_item", "password"),
                ("locker_item", "otp_seed"),
                ("locker_item", "card_number"),
                ("locker_item", "cvv"),
                ("locker_item", "content"),
                ("locker_item_field", "value_sealed"),
            ] {
                let part = shape.part(table).expect("classified");
                assert!(part.columns.iter().any(|name| name == column), "{table}.{column}");
                assert!(history::is_sealed(table, column), "{table}.{column}");
            }
            // A passkey is state, its key sealed and masked like the rest.
            let passkey = shape.part("locker_item_passkey").expect("classified");
            assert!(passkey.columns.iter().any(|name| name == "private_key"));
            assert!(history::is_sealed("locker_item_passkey", "private_key"));
            Ok(())
        })
        .expect("read");
}

// ---------------------------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------------------------

#[test]
fn a_person_keeps_its_name_and_its_contact_points() {
    let w = World::new();
    let id = w.id("person.add", json!({ "title": "Ada" }));
    assert_eq!(w.revisions(), 0, "creating writes no history");
    let first = w.state(&id);
    w.ok(
        "person.edit",
        json!({ "id": id, "title": "Ada Lovelace", "role": "Countess" }),
    );
    let point = w.ok(
        "person.save_contact_point",
        json!({ "id": id, "kind": "email", "value": "ada@analytical.example" }),
    )["point_id"]
        .as_str()
        .expect("a point")
        .to_owned();
    let versions = w.versions(&id);
    assert_eq!(versions.len(), 2);
    // Newest first: the state before the contact point existed, then the first state.
    assert_eq!(versions[0].cause, "person.save_contact_point");
    assert_eq!(versions[0].by, Who::Member);
    let (before, after) = World::change(&versions[0], &format!("contact_point[{point}]"));
    assert_eq!(before, Value::Null);
    assert_eq!(after["value"], "ada@analytical.example");
    let (before, after) = World::change(&versions[1], "entity.title");
    assert_eq!((before, after), (json!("Ada"), json!("Ada Lovelace")));
    assert_eq!(
        World::change(&versions[1], "person.role"),
        (Value::Null, json!("Countess"))
    );
    w.story(&id, &first);
    w.purge_takes_history(&id);
}

#[test]
fn an_event_keeps_its_time_and_its_guests() {
    let w = World::new();
    let ben = w.id("person.add", json!({ "title": "Ben" }));
    let id = w.id(
        "event.propose",
        json!({ "title": "Lunch", "starts": "2026-03-02T12:00", "ends": "2026-03-02T13:00",
                "zone": "Europe/Paris" }),
    );
    let first = w.state(&id);
    w.ok(
        "event.edit",
        json!({ "id": id, "starts": "2026-03-02T13:00", "ends": "2026-03-02T14:00" }),
    );
    w.ok(
        "event.edit",
        json!({ "id": id, "attendees": [ben.clone()] }),
    );
    let versions = w.versions(&id);
    assert_eq!(versions.len(), 2);
    let (before, after) = World::change(&versions[0], &format!("attendee[{ben}]"));
    assert_eq!(before, Value::Null);
    assert_eq!(after["rel"], "attendee");
    let (was, now) = World::change(&versions[1], "event.starts");
    assert_eq!(
        (was, now),
        (
            json!("2026-03-02T11:00:00.000Z"),
            json!("2026-03-02T12:00:00.000Z")
        )
    );
    w.story(&id, &first);
    w.purge_takes_history(&id);
}

#[test]
fn a_task_keeps_what_was_set() {
    let w = World::new();
    let id = w.id(
        "task.add",
        json!({ "title": "Ring the bank", "due": "2026-03-04" }),
    );
    let first = w.state(&id);
    w.ok(
        "task.edit",
        json!({ "id": id, "title": "Ring the bank back", "priority": 3 }),
    );
    w.ok("task.edit", json!({ "id": id, "due": "2026-03-09" }));
    let versions = w.versions(&id);
    assert_eq!(versions.len(), 2);
    assert_eq!(
        World::change(&versions[0], "task.due"),
        (json!("2026-03-04"), json!("2026-03-09"))
    );
    assert_eq!(
        World::change(&versions[1], "task.priority"),
        (json!(0), json!(3))
    );
    w.story(&id, &first);
    w.purge_takes_history(&id);
}

#[test]
fn a_transaction_keeps_the_members_category_and_never_the_banks_words() {
    let w = World::new();
    let account = w.id(
        "account.add",
        json!({ "title": "Everyday", "type": "checking", "currency": "USD" }),
    );
    w.ok(
        "follow.statement",
        json!({ "origin": { "ref": account, "label": "Everyday", "fills": account },
                "records": [{ "external_id": "csv:1", "fields": { "title": "GROCER", "posted_on": "2026-03-01",
                                                                    "amount_minor": -1250 } }] }),
    );
    let id: String = w
        .scratch
        .vault
        .read(|c| Ok(c.query_row("SELECT id FROM txn", [], |row| row.get(0))?))
        .expect("the line");
    let food = w.id("category.add", json!({ "title": "Zebra food" }));
    let fun = w.id("category.add", json!({ "title": "Zebra fun" }));
    let first = w.state(&id);
    w.ok(
        "txn.categorize",
        json!({ "ids": [id], "category_id": food }),
    );
    w.ok("txn.categorize", json!({ "ids": [id], "category_id": fun }));
    let versions = w.versions(&id);
    assert_eq!(versions.len(), 2);
    assert_eq!(
        World::change(&versions[0], "txn.category_id"),
        (json!(food), json!(fun))
    );
    assert_eq!(
        World::change(&versions[1], "txn.category_id"),
        (Value::Null, json!(food))
    );
    // The bank's amount, day and account are never in a version: they never change.
    for version in &versions {
        for change in &version.changes {
            assert!(
                !["amount_minor", "posted_on", "account_id"]
                    .iter()
                    .any(|column| change.field.ends_with(column)),
                "{}",
                change.field
            );
        }
    }
    let stored: String = w
        .scratch
        .vault
        .read(|c| {
            Ok(
                c.query_row("SELECT group_concat(state) FROM revision", [], |row| {
                    row.get(0)
                })?,
            )
        })
        .expect("states");
    assert!(
        !stored.contains("amount_minor") && !stored.contains("posted_on"),
        "{stored}"
    );
    w.story(&id, &first);
    w.purge_takes_history(&id);
}

#[test]
fn a_photo_keeps_its_caption() {
    let w = World::new();
    let blob = w.bytes("a photograph");
    let id = w.id(
        "photo.add",
        json!({ "blob": blob, "media_type": "image/jpeg", "title": "Beach" }),
    );
    let first = w.state(&id);
    w.ok(
        "entity.retitle",
        json!({ "id": id, "title": "Beach at dusk" }),
    );
    w.ok(
        "entity.retitle",
        json!({ "id": id, "title": "Beach at dusk, Tahoe" }),
    );
    let versions = w.versions(&id);
    assert_eq!(versions.len(), 2);
    assert_eq!(
        World::change(&versions[0], "entity.title"),
        (json!("Beach at dusk"), json!("Beach at dusk, Tahoe"))
    );
    assert_eq!(
        World::change(&versions[1], "entity.title"),
        (json!("Beach"), json!("Beach at dusk"))
    );
    // The file is the photograph: it is not state, and nothing copies it.
    assert!(first["photo"].get("blob").is_none());
    w.story(&id, &first);
    w.purge_takes_history(&id);
}

#[test]
fn a_workout_keeps_what_the_member_changed() {
    let w = World::new();
    let id = w.id(
        "workout.log",
        json!({ "type": "run", "starts": "2026-03-04", "moving_s": 1800, "distance_m": 5000 }),
    );
    let first = w.state(&id);
    w.ok("workout.edit", json!({ "id": id, "distance_m": 5200.0 }));
    w.ok(
        "workout.edit",
        json!({ "id": id, "title": "Morning run", "moving_s": 1750 }),
    );
    let versions = w.versions(&id);
    assert_eq!(versions.len(), 2);
    let (was, now) = World::change(&versions[1], "workout.distance_m");
    assert_eq!((was.as_f64(), now.as_f64()), (Some(5000.0), Some(5200.0)));
    assert_eq!(
        World::change(&versions[0], "workout.moving_s"),
        (json!(1800), json!(1750))
    );
    w.story(&id, &first);
    w.purge_takes_history(&id);
}

#[test]
fn a_note_and_a_document_keep_their_words_and_bytes_on_the_one_mechanism() {
    let w = World::new();
    let note = w.id("note.create", json!({ "title": "Plan", "body": "one" }));
    let first = w.state(&note);
    w.ok("note.edit", json!({ "id": note, "body": "two" }));
    w.ok("note.edit", json!({ "id": note, "title": "Plan B" }));
    let versions = w.versions(&note);
    assert_eq!(versions.len(), 2);
    assert_eq!(
        World::change(&versions[1], "note.body"),
        (json!("one"), json!("two"))
    );
    assert_eq!(
        World::change(&versions[0], "entity.title"),
        (json!("Plan"), json!("Plan B"))
    );
    // The words are in their own cell, once: not also inside the state.
    let in_state: i64 = w.count("SELECT COUNT(*) FROM revision WHERE state LIKE '%\"body\"%'");
    assert_eq!(in_state, 0);
    // The old verb is a thin caller: it restores the words and only the words.
    let out = w.ok(
        "note.restore_version",
        json!({ "id": note, "seq": versions[1].seq }),
    );
    assert_eq!(out["restored"], true);
    let now = w.state(&note);
    assert_eq!(now["note"]["body"], "one");
    assert_eq!(
        now["entity"]["title"], "Plan B",
        "the title is not the words' to restore"
    );
    w.ok(
        "history.restore_version",
        json!({ "id": note, "seq": versions[1].seq }),
    );
    assert_eq!(w.state(&note), first);
    w.purge_takes_history(&note);

    let doc_first = w.bytes("first bytes");
    let doc = w.id(
        "document.add",
        json!({ "title": "Lease", "blob": doc_first, "media_type": "application/pdf" }),
    );
    let first = w.state(&doc);
    for seed in ["second bytes", "third bytes"] {
        let blob = w.bytes(seed);
        w.ok(
            "document.replace",
            json!({ "id": doc, "blob": blob, "media_type": "application/pdf" }),
        );
    }
    let versions = w.versions(&doc);
    assert_eq!(versions.len(), 2);
    assert_eq!(
        World::change(&versions[1], "document.blob").0,
        json!(doc_first),
        "a version names its bytes by hash"
    );
    // The bytes of a replaced version stay held by the history's foreign key.
    let held: i64 = w.count("SELECT COUNT(*) FROM revision WHERE blob IS NOT NULL");
    assert_eq!(held, 2);
    w.ok(
        "document.restore_version",
        json!({ "id": doc, "seq": versions[1].seq }),
    );
    assert_eq!(w.state(&doc)["document"]["blob"], json!(doc_first));
    w.ok("history.undo", json!({ "id": doc }));
    w.ok(
        "history.restore_version",
        json!({ "id": doc, "seq": versions[1].seq }),
    );
    assert_eq!(w.state(&doc)["document"], first["document"]);
    w.purge_takes_history(&doc);
}

// ---------------------------------------------------------------------------------------------
// Locker: sealed cells are kept SEALED, masked on read, and restored with the rest
// ---------------------------------------------------------------------------------------------

/// A `K` that is written NOWHERE: the test is the core, which seals; the vault never sees it.
fn locker_key() -> Vec<u8> {
    vec![0x3c_u8; 32]
}

/// What the core hands the vault for `plaintext` sealed into row `row_id` under key `k1`.
fn sealed(row_id: &str, plaintext: &str) -> String {
    centraid_vault::custody::locker_key::encrypt_under_locker_key(
        &locker_key(),
        "k1",
        row_id,
        plaintext,
    )
    .expect("the core seals")
}

fn opened(row_id: &str, ciphertext: &str) -> String {
    centraid_vault::custody::locker_key::decrypt_under_locker_key(
        &locker_key(),
        "k1",
        row_id,
        ciphertext,
    )
    .expect("the key opens it")
}

const FIRST: &str = "PLANTED-FIRST-PASSWORD-q8w3e-not-in-any-payload";
const SECOND: &str = "PLANTED-SECOND-PASSWORD-r5t6y-not-in-any-payload";
const THIRD: &str = "PLANTED-THIRD-PASSWORD-u1i2o-not-in-any-payload";
const PIN_ONE: &str = "PLANTED-PIN-ONE-a7s8d-not-in-any-payload";
const PIN_TWO: &str = "PLANTED-PIN-TWO-f3g4h-not-in-any-payload";
const SEED: &str = "PLANTED-OTP-SEED-j9k0l-not-in-any-payload";

#[test]
fn a_changed_password_is_kept_sealed_masked_on_read_and_restored_with_the_item() {
    let w = World::new();
    w.scratch
        .vault
        .commit(|tx| {
            tx.connection().execute(
                "INSERT INTO locker_key (key_id, created_at) VALUES ('k1', '2026-01-01T00:00:00.000Z')",
                [],
            )?;
            Ok(())
        })
        .expect("the key plane");
    let id = "item-1";
    let first = sealed(id, FIRST);
    w.ok(
        "locker.add_item",
        json!({ "item_id": id, "type": "login", "title": "The bank", "username": "ada@example.com",
                "url": "https://bank.example", "password": first, "password_rotated": true,
                "key_id": "k1" }),
    );
    let edit = |username: &str, password: &str| {
        w.ok(
            "locker.edit_item",
            json!({ "item_id": id, "title": "The bank", "username": username,
                    "url": "https://bank.example", "password": password, "password_rotated": true,
                    "key_id": "k1" }),
        );
    };
    let at_first = w.state(id);
    assert_eq!(w.revisions(), 0, "a creation has no earlier state");

    // A password change ALONE is a version (it was not before the ruling).
    edit("ada@example.com", &sealed(id, SECOND));
    assert_eq!(w.revisions(), 1, "a changed sealed cell is history");
    // And a change that moves a plain field and the password is one version.
    edit("ada@work.example", &sealed(id, THIRD));
    let versions = w.versions(id);
    assert_eq!(versions.len(), 2);

    // (i) THE HISTORY HOLDS CIPHERTEXT ONLY. It names the cell and holds exactly the sealed
    // value the live cell held, and not a byte of any plaintext, in a revision row, a plain
    // column, or the vault file with its sidecars.
    let all: String = w
        .scratch
        .vault
        .read(|c| {
            Ok(c.query_row(
                "SELECT COALESCE(group_concat(state || COALESCE(body, '') || cause), '') FROM revision",
                [],
                |row| row.get(0),
            )?)
        })
        .expect("history");
    assert!(
        all.contains("\"password\":\"lk1:"),
        "the cell is kept, as ciphertext"
    );
    assert!(
        all.contains(&first),
        "the version holds the ciphertext the live cell held"
    );
    for secret in [FIRST, SECOND, THIRD] {
        assert!(
            !all.contains(secret),
            "{secret} reached the history in the clear"
        );
    }
    let scan = |name: &str| {
        if let Ok(bytes) = std::fs::read(w.scratch.dir().join(name)) {
            for secret in [FIRST, SECOND, THIRD] {
                assert!(
                    !bytes
                        .windows(secret.len())
                        .any(|window| window == secret.as_bytes()),
                    "{secret} is in {name}"
                );
            }
        }
    };
    for name in ["vault.db", "vault.db-wal", "vault.db-shm"] {
        scan(name);
    }

    // (ii) READ: a changed secret is seen to have changed and is shown as nothing else.
    let (was, now) = World::change(&versions[1], "locker_item.password");
    assert_eq!((was, now), (json!(history::MASK), json!(history::MASK)));
    let read = serde_json::to_string(
        &versions
            .iter()
            .map(|v| {
                v.changes
                    .clone()
                    .into_iter()
                    .map(|c| (c.field, c.before, c.after))
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>(),
    )
    .expect("json");
    assert!(
        !read.contains("lk1:"),
        "a version's diff shows no ciphertext"
    );
    assert_eq!(
        World::change(&versions[0], "locker_item.username"),
        (json!("ada@example.com"), json!("ada@work.example"))
    );

    // The version's own cell opens with K as the password it held, and not as another's.
    let cell = w
        .scratch
        .vault
        .locker_sealed_earlier_cell(id, versions[1].seq, "password", "")
        .expect("reads")
        .expect("the version held a password");
    assert_eq!(cell.key_id.as_deref(), Some("k1"));
    assert_eq!(opened(id, &cell.ciphertext.expect("sealed")), FIRST);
    assert!(
        w.scratch
            .vault
            .locker_sealed_earlier_cell(id, versions[1].seq, "username", "")
            .expect("reads")
            .is_none(),
        "a plain column is not a sealed cell"
    );

    // (iii) RESTORE brings the old password back with the plain fields: the live cell is the
    // ciphertext the version held, and the live reveal's own path opens it.
    let out = w.ok(
        "history.restore_version",
        json!({ "id": id, "seq": versions[1].seq }),
    );
    assert_eq!(out["restored"], true);
    let live: String = w.count_text("SELECT password FROM locker_item WHERE id = 'item-1'");
    assert_eq!(
        opened(id, &live),
        FIRST,
        "the old password is the live one again"
    );
    assert_eq!(
        w.state(id),
        at_first,
        "the whole state is the first state again"
    );
    // Undo the restore: the password it replaced comes back.
    w.ok("history.undo", json!({ "id": id }));
    let live: String = w.count_text("SELECT password FROM locker_item WHERE id = 'item-1'");
    assert_eq!(opened(id, &live), THIRD);
    for name in ["vault.db", "vault.db-wal", "vault.db-shm"] {
        scan(name);
    }

    // A sealed custom field is state too: restored with the item, masked on read.
    w.ok(
        "locker.set_field",
        json!({ "item_id": id, "label": "Branch", "kind": "text", "value": "Main", "field_id": "f1" }),
    );
    w.ok(
        "locker.set_field",
        json!({ "item_id": id, "label": "PIN", "kind": "sealed", "value": sealed("f2", PIN_ONE), "field_id": "f2", "key_id": "k1" }),
    );
    let before = w.versions(id).len();
    w.ok(
        "locker.set_field",
        json!({ "item_id": id, "label": "PIN", "kind": "sealed", "value": sealed("f2", PIN_TWO), "field_id": "f2", "key_id": "k1" }),
    );
    let versions = w.versions(id);
    assert_eq!(
        versions.len(),
        before + 1,
        "a changed sealed field is a version"
    );
    let (was, now) = World::change(&versions[0], "locker_item_field[f2].value_sealed");
    assert_eq!((was, now), (json!(history::MASK), json!(history::MASK)));
    let field = w
        .scratch
        .vault
        .locker_sealed_earlier_cell(id, versions[0].seq, "value_sealed", "f2")
        .expect("reads")
        .expect("the version held the field");
    assert_eq!(opened("f2", &field.ciphertext.expect("sealed")), PIN_ONE);
    w.ok("history.undo", json!({ "id": id, "seq": versions[0].seq }));
    let live: String =
        w.count_text("SELECT value_sealed FROM locker_item_field WHERE field_id = 'f2'");
    assert_eq!(
        opened("f2", &live),
        PIN_ONE,
        "the old PIN is the live one again"
    );

    // A removed sealed field comes back whole, and a whole-row change is masked too.
    w.ok(
        "locker.remove_field",
        json!({ "item_id": id, "field_id": "f2" }),
    );
    let versions = w.versions(id);
    let (was, now) = World::change(&versions[0], "locker_item_field[f2]");
    assert_eq!(was["value_sealed"], json!(history::MASK));
    assert!(now.is_null());
    w.ok("history.undo", json!({ "id": id, "seq": versions[0].seq }));
    let live: String =
        w.count_text("SELECT value_sealed FROM locker_item_field WHERE field_id = 'f2'");
    assert_eq!(opened("f2", &live), PIN_ONE);

    // A one-time-code field's seed is kept sealed too, and is never an openable cell.
    w.ok(
        "locker.set_field",
        json!({ "item_id": id, "label": "Backup", "kind": "otp", "value": sealed("f3", SEED), "field_id": "f3", "key_id": "k1" }),
    );
    w.ok(
        "locker.set_field",
        json!({ "item_id": id, "label": "Backup", "kind": "otp", "value": sealed("f3", "PLANTED-OTP-SEED-2-z1x2c-not-in-any-payload"), "field_id": "f3", "key_id": "k1" }),
    );
    let versions = w.versions(id);
    assert!(
        w.scratch
            .vault
            .locker_sealed_earlier_cell(id, versions[0].seq, "value_sealed", "f3")
            .expect("reads")
            .is_none(),
        "a seed is never opened, live or earlier"
    );
    w.ok("history.undo", json!({ "id": id, "seq": versions[0].seq }));
    let live: String =
        w.count_text("SELECT value_sealed FROM locker_item_field WHERE field_id = 'f3'");
    assert_eq!(
        opened("f3", &live),
        SEED,
        "an undone seed is the one it replaced"
    );
    for name in ["vault.db", "vault.db-wal", "vault.db-shm"] {
        scan(name);
    }
    let seed_scan = std::fs::read(w.scratch.dir().join("vault.db")).expect("file");
    assert!(
        !seed_scan
            .windows(SEED.len())
            .any(|window| window == SEED.as_bytes()),
        "a seed is in the file in the clear"
    );

    // A passkey is state too: replacing its key and removing it are taken back, the key masked.
    w.ok(
        "locker.set_passkey",
        json!({ "item_id": id, "rp_id": "bank.example", "display_name": "Laptop",
                "private_key": sealed(id, "PLANTED-KEY-ONE-m4n5b-not-in-any-payload"), "key_id": "k1" }),
    );
    w.ok(
        "locker.set_passkey",
        json!({ "item_id": id, "rp_id": "bank.example", "display_name": "Laptop",
                "private_key": sealed(id, "PLANTED-KEY-TWO-v6c7x-not-in-any-payload"), "key_id": "k1" }),
    );
    let versions = w.versions(id);
    let (was, now) = World::change(&versions[0], "locker_item_passkey.private_key");
    assert_eq!((was, now), (json!(history::MASK), json!(history::MASK)));
    w.ok("history.undo", json!({ "id": id, "seq": versions[0].seq }));
    let live: String =
        w.count_text("SELECT private_key FROM locker_item_passkey WHERE item_id = 'item-1'");
    assert_eq!(
        opened(id, &live),
        "PLANTED-KEY-ONE-m4n5b-not-in-any-payload"
    );
    w.ok("locker.clear_passkey", json!({ "item_id": id }));
    let versions = w.versions(id);
    w.ok("history.undo", json!({ "id": id, "seq": versions[0].seq }));
    let live: String =
        w.count_text("SELECT private_key FROM locker_item_passkey WHERE item_id = 'item-1'");
    assert_eq!(
        opened(id, &live),
        "PLANTED-KEY-ONE-m4n5b-not-in-any-payload"
    );
    let file = std::fs::read(w.scratch.dir().join("vault.db")).expect("file");
    for key in [
        "PLANTED-KEY-ONE-m4n5b-not-in-any-payload",
        "PLANTED-KEY-TWO-v6c7x-not-in-any-payload",
    ] {
        assert!(
            !file
                .windows(key.len())
                .any(|window| window == key.as_bytes()),
            "{key} in the file"
        );
    }
    w.purge_takes_history(id);
}

impl World {
    fn count_text(&self, sql: &str) -> String {
        self.scratch
            .vault
            .read(|c| Ok(c.query_row(sql, [], |row| row.get(0))?))
            .expect("a cell")
    }
}

// ---------------------------------------------------------------------------------------------
// Followed rows, unchanged commits, and scale
// ---------------------------------------------------------------------------------------------

fn contact(title: &str) -> Value {
    json!({ "origin": { "ref": "phone", "label": "Phone" }, "complete": true,
            "records": [{ "external_id": "c1", "fields": { "title": title, "points": [] } }] })
}

#[test]
fn a_follow_pass_that_changes_a_field_is_attributed_to_the_store() {
    let w = World::new();
    w.ok("follow.contacts", contact("Grace Hopper"));
    let id: String = w.count_text("SELECT id FROM entity WHERE title = 'Grace Hopper'");
    assert_eq!(w.revisions(), 0, "the first pass creates");
    // The same statement again writes nothing at all.
    w.ok("follow.contacts", contact("Grace Hopper"));
    assert_eq!(w.revisions(), 0, "an unchanged pass keeps nothing");
    w.ok("follow.contacts", contact("Grace B. Hopper"));
    let versions = w.versions(&id);
    assert_eq!(versions.len(), 1);
    assert_eq!(versions[0].by, Who::Store("contacts".to_owned()));
    assert_eq!(versions[0].cause, "follow.contacts");
    assert_eq!(
        World::change(&versions[0], "entity.title"),
        (json!("Grace Hopper"), json!("Grace B. Hopper"))
    );
    // The member's own change after it is the member's.
    w.ok("person.edit", json!({ "id": id, "title": "Grace" }));
    let versions = w.versions(&id);
    assert_eq!(versions[0].by, Who::Member);
    assert_eq!(versions[1].by, Who::Store("contacts".to_owned()));
    // What a version became current by is who replaced the one below it: the first version was
    // never replaced by anyone but the creating pass, which no commit names.
    assert_eq!(versions[0].since_by, Who::Store("contacts".to_owned()));
    assert_eq!(versions[1].since_by, Who::Member);
}

#[test]
fn an_unchanged_commit_writes_zero_versions_and_creating_many_writes_none() {
    let w = World::new();
    let id = w.id("person.add", json!({ "title": "Ada", "role": "Countess" }));
    let note = w.id("note.create", json!({ "title": "N", "body": "same" }));
    // Edits that restate what is held, and stamps.
    w.ok(
        "person.edit",
        json!({ "id": id, "title": "Ada", "role": "Countess" }),
    );
    w.ok(
        "note.edit",
        json!({ "id": note, "body": "same", "title": "N" }),
    );
    w.ok("entity.retitle", json!({ "id": id, "title": "Ada" }));
    assert_eq!(w.revisions(), 0);
    // Creation of many, through commands and through a followed import.
    for n in 0..25 {
        w.id("person.add", json!({ "title": format!("Person {n}") }));
        w.id(
            "note.create",
            json!({ "title": format!("Note {n}"), "body": "x" }),
        );
    }
    let records: Vec<Value> = (0..40)
        .map(|n| json!({ "external_id": format!("c{n}"), "fields": { "title": format!("Contact {n}"), "points": [] } }))
        .collect();
    w.ok(
        "follow.contacts",
        json!({ "origin": { "ref": "phone", "label": "Phone" }, "complete": true, "records": records }),
    );
    assert_eq!(w.revisions(), 0, "creating writes no history");
    // A second identical pass of the same 40: nothing.
    let again: Vec<Value> = (0..40)
        .map(|n| json!({ "external_id": format!("c{n}"), "fields": { "title": format!("Contact {n}"), "points": [] } }))
        .collect();
    w.ok(
        "follow.contacts",
        json!({ "origin": { "ref": "phone", "label": "Phone" }, "complete": true, "records": again }),
    );
    assert_eq!(w.revisions(), 0, "an unchanged pass writes nothing");
    // One field of one record changed in a pass of 40: one version.
    let mut changed: Vec<Value> = (0..40)
        .map(|n| json!({ "external_id": format!("c{n}"), "fields": { "title": format!("Contact {n}"), "points": [] } }))
        .collect();
    changed[7] =
        json!({ "external_id": "c7", "fields": { "title": "Contact seven", "points": [] } });
    w.ok(
        "follow.contacts",
        json!({ "origin": { "ref": "phone", "label": "Phone" }, "complete": true, "records": changed }),
    );
    assert_eq!(
        w.revisions(),
        1,
        "a pass of N records writes a version for each one that changed"
    );
}

#[test]
fn a_page_of_versions_is_keyset_paged_and_a_restore_refuses_what_is_not_there() {
    let w = World::new();
    let id = w.id("person.add", json!({ "title": "v0" }));
    for n in 1..=7 {
        w.ok("person.edit", json!({ "id": id, "title": format!("v{n}") }));
    }
    let (first, second) = w
        .scratch
        .vault
        .read(|c| {
            let first = history::earlier_versions(c, &id, None, 3)?;
            let second = history::earlier_versions(c, &id, first.next, 3)?;
            Ok((first, second))
        })
        .expect("pages");
    assert_eq!(
        first.versions.iter().map(|v| v.seq).collect::<Vec<_>>(),
        [7, 6, 5]
    );
    assert_eq!(
        second.versions.iter().map(|v| v.seq).collect::<Vec<_>>(),
        [4, 3, 2]
    );
    assert_eq!(first.next, Some(5));
    // The diff of the first of a later page is against the version above it.
    assert_eq!(
        World::change(&second.versions[0], "entity.title"),
        (json!("v3"), json!("v4"))
    );
    let wire = first.to_json();
    assert_eq!(wire["versions"][0]["by"]["kind"], "member");
    // A version became current when the one below it was replaced, the first when the record was
    // made, also across a page's edge; and the count is the rows the record holds.
    assert_eq!(first.versions[0].since, first.versions[1].at);
    assert_eq!(first.versions[0].since_by, Who::Member);
    assert_eq!(first.versions[2].since, second.versions[0].at);
    let last = second.versions.last().expect("the last");
    let born: String = w
        .scratch
        .vault
        .read(|c| {
            Ok(
                c.query_row("SELECT created_at FROM entity WHERE id = ?1", [&id], |r| {
                    r.get(0)
                })?,
            )
        })
        .expect("born");
    let all = w
        .scratch
        .vault
        .read(|c| history::earlier_versions(c, &id, None, 100))
        .expect("all");
    assert_eq!(all.versions.last().expect("oldest").since, born);
    assert_eq!(last.seq, 2);
    assert_eq!(
        w.scratch
            .vault
            .read(|c| history::count(c, &id))
            .expect("count"),
        7
    );
    assert!(
        w.refused("history.restore_version", json!({ "id": id, "seq": 99 }))
            .contains("not in this record's history")
    );
    let fresh = w.id("person.add", json!({ "title": "New" }));
    assert!(
        w.refused("history.undo", json!({ "id": fresh }))
            .contains("no earlier version")
    );
    w.ok("entity.trash", json!({ "id": id }));
    assert!(
        w.refused("history.undo", json!({ "id": id }))
            .contains("trash")
    );
}

#[test]
fn an_undo_that_names_its_version_is_refused_once_the_record_changed_again() {
    let w = World::new();
    let id = w.id("person.add", json!({ "title": "Ada" }));
    w.ok("entity.retitle", json!({ "id": id, "title": "Ada L." }));
    let named = w.versions(&id)[0].seq;
    // Nothing changed since: the named undo is the plain undo.
    let again = w.id("person.add", json!({ "title": "Grace" }));
    w.ok(
        "entity.retitle",
        json!({ "id": again, "title": "Grace H." }),
    );
    let grace = w.versions(&again)[0].seq;
    w.ok("history.undo", json!({ "id": again, "seq": grace }));
    assert_eq!(w.state(&again)["entity"]["title"], "Grace");
    // Changed again after the named change: refused, and the later change stays.
    w.ok("entity.retitle", json!({ "id": id, "title": "Countess" }));
    let refused = w.refused("history.undo", json!({ "id": id, "seq": named }));
    assert!(refused.contains("can no longer be undone"), "{refused}");
    assert_eq!(w.state(&id)["entity"]["title"], "Countess");
}

#[test]
fn what_an_edit_costs_in_storage() {
    let w = World::new();
    let id = w.id(
        "person.add",
        json!({ "title": "Ada Lovelace", "role": "Countess", "nickname": "Ada" }),
    );
    for (kind, value) in [
        ("email", "ada@analytical.example"),
        ("phone", "+15550100100"),
    ] {
        w.ok(
            "person.save_contact_point",
            json!({ "id": id, "kind": kind, "value": value }),
        );
    }
    let base = w.revisions();
    w.ok("person.edit", json!({ "id": id, "nickname": "Countess" }));
    assert_eq!(
        w.revisions(),
        base + 1,
        "one version per commit, not per field"
    );
    let bytes: i64 = w.count(
        "SELECT length(entity_id) + length(at) + length(cause) + length(state) + 8
           FROM revision ORDER BY seq DESC LIMIT 1",
    );
    eprintln!("storage per edited person with two contact points: {bytes} bytes");
    assert!(bytes < 1_500, "{bytes}");
}

#[test]
fn a_trashed_item_offers_no_earlier_versions_and_gets_the_entry_back_with_the_item() {
    let w = World::new();
    // The entry's count is one rule for every kind: it is read from the entity, so a note, a
    // person and a task stand for the nine apps' records.
    let items = [
        w.id("note.create", json!({ "title": "Plan", "body": "words" })),
        w.id("person.add", json!({ "title": "Ada" })),
        w.id("task.add", json!({ "title": "Ring the bank" })),
    ];
    for id in items {
        let offered = |w: &World| {
            w.scratch
                .vault
                .read(|c| history::offered(c, &id))
                .expect("offered")
        };
        w.ok("entity.retitle", json!({ "id": id, "title": "Renamed" }));
        assert_eq!(offered(&w), 1, "a live item offers its version");
        w.ok("entity.trash", json!({ "id": id }));
        assert_eq!(offered(&w), 0, "a trashed item offers none");
        assert_eq!(
            w.versions(&id).len(),
            1,
            "its versions are still kept for when it returns"
        );
        w.ok("entity.restore", json!({ "id": id }));
        assert_eq!(offered(&w), 1, "restored, it offers them again");
    }
}
