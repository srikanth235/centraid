//! STOP FOLLOWING RETIRES, FOLLOWING AGAIN REVIVES (#1185): `follow.stop` keeps the origin, the home
//! it filled (`fills`) and its sources, and clears its cursor; the same `ref` followed again finds all
//! of them, so no second calendar, folder or project is made and no record is added twice. A retired
//! origin is followed by nobody: the reads that ask what a phone follows leave it out. Docs' folder is
//! in `docs_photos.rs`, which stages the bytes it needs.

mod common;

use centraid_vault::commands::Registry;
use centraid_vault::{Command, CommandStatus, Principal};
use serde_json::{Value, json};

struct World {
    scratch: common::Scratch,
    registry: Registry,
}

impl World {
    fn new() -> Self {
        Self {
            scratch: common::Scratch::founded("follow-retire").expect("a vault"),
            registry: Registry::with_system_commands().expect("a registry"),
        }
    }

    fn ok(&self, name: &str, input: Value) -> Value {
        let outcome = self
            .scratch
            .vault
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
        outcome.output
    }

    fn one<T: rusqlite::types::FromSql>(&self, sql: &str, params: &[&str]) -> T {
        self.scratch
            .vault
            .read(|c| Ok(c.query_row(sql, rusqlite::params_from_iter(params), |r| r.get(0))?))
            .expect("a row")
    }

    fn count(&self, sql: &str) -> i64 {
        self.one(sql, &[])
    }

    fn stop(&self, system: &str, reference: &str) -> Value {
        self.ok("follow.stop", json!({ "system": system, "ref": reference }))
    }

    /// The one origin of `system`: its id, whether it is retired, and what it fills.
    fn origin(&self, system: &str) -> (String, bool, Option<String>) {
        self.scratch
            .vault
            .read(|c| {
                Ok(c.query_row(
                    "SELECT id, retired_at IS NOT NULL, fills FROM origin WHERE system = ?1",
                    [system],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )?)
            })
            .expect("one origin")
    }
}

// ---- contacts ----------------------------------------------------------------------------------

fn contacts(w: &World, device: &str, records: Value) -> Value {
    w.ok(
        "follow.contacts",
        json!({ "origin": { "ref": "phone", "label": "Phone", "device_id": device },
                "complete": true, "records": records }),
    )
}

fn ada(title: &str) -> Value {
    json!([{ "external_id": "c1", "fields": { "title": title, "role": "Analyst", "points": [] } }])
}

#[test]
fn contacts_followed_again_find_their_people_and_add_none_twice() {
    let w = World::new();
    contacts(&w, "phone-a", ada("Ada Lovelace"));
    let (origin, retired, _) = w.origin("contacts");
    assert!(!retired);
    let person = w.one::<String>("SELECT id FROM entity WHERE title = 'Ada Lovelace'", &[]);

    let stopped = w.stop("contacts", "phone");
    assert_eq!(stopped["stopped"], json!(true));
    // THE ORIGIN IS RETIRED, NOT DELETED: its row and its sources stay, and nothing reads it as followed.
    assert_eq!(w.origin("contacts"), (origin.clone(), true, None));
    assert_eq!(w.count("SELECT COUNT(*) FROM source"), 1);
    assert!(
        w.one::<Option<String>>("SELECT deleted_at FROM entity WHERE id = ?1", &[&person])
            .is_none(),
        "the person is the member's own, not trashed"
    );
    // Stopping what is not followed is nothing.
    assert_eq!(w.stop("contacts", "phone")["stopped"], json!(false));

    // Followed again: the same origin, the same person, nobody added.
    let again = contacts(&w, "phone-a", ada("Ada Lovelace"));
    assert_eq!(
        (again["added"].clone(), again["unchanged"].clone()),
        (json!(0), json!(1))
    );
    assert_eq!(w.origin("contacts"), (origin, false, None));
    assert_eq!(
        w.count("SELECT COUNT(*) FROM origin WHERE system = 'contacts'"),
        1
    );
    assert_eq!(
        w.count("SELECT COUNT(*) FROM entity WHERE title = 'Ada Lovelace'"),
        1
    );
}

#[test]
fn a_person_the_member_trashed_or_renamed_while_stopped_stays_as_they_left_them() {
    let w = World::new();
    contacts(
        &w,
        "phone-a",
        json!([
            { "external_id": "c1", "fields": { "title": "Ada Lovelace", "role": "Analyst", "points": [] } },
            { "external_id": "c2", "fields": { "title": "Grace Hopper", "role": "Admiral", "points": [] } }
        ]),
    );
    let ada = w.one::<String>("SELECT id FROM entity WHERE title = 'Ada Lovelace'", &[]);
    let grace = w.one::<String>("SELECT id FROM entity WHERE title = 'Grace Hopper'", &[]);
    w.stop("contacts", "phone");
    w.ok("entity.trash", json!({ "id": ada }));
    w.ok(
        "entity.retitle",
        json!({ "id": grace, "title": "Rear Admiral Hopper" }),
    );

    contacts(
        &w,
        "phone-a",
        json!([
            { "external_id": "c1", "fields": { "title": "Ada Lovelace", "role": "Analyst", "points": [] } },
            { "external_id": "c2", "fields": { "title": "Grace Hopper", "role": "Admiral", "points": [] } }
        ]),
    );
    assert!(
        w.one::<Option<String>>("SELECT deleted_at FROM entity WHERE id = ?1", &[&ada])
            .is_some(),
        "what the member trashed while stopped stays trashed"
    );
    assert_eq!(
        w.one::<String>("SELECT title FROM entity WHERE id = ?1", &[&grace]),
        "Rear Admiral Hopper",
        "what the member renamed while stopped stands"
    );
    assert_eq!(
        w.count("SELECT COUNT(*) FROM entity WHERE kind = 'person' AND title LIKE '%Hopper'"),
        1
    );
}

// ---- calendar ----------------------------------------------------------------------------------

// ---- reminders ---------------------------------------------------------------------------------

// ---- what a phone follows ----------------------------------------------------------------------

