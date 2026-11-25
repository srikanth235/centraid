//! The shared verbs of the people and follow lanes: `person.merge`, and the engine's three-way merge
//! of a followed store (K9, #1214). Moved from the old `shared_verbs.rs`.

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
    assert_ne!(w.stamp("keep"), AT, "a merge touches the survivor");
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
    let stamped = w.stamp(&id);
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
    assert_eq!(w.stamp(&id), stamped);
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

