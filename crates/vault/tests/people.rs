//! A person's own verbs, against a vault the product founds: the person and its
//! columns, the contact points, the touch, the words kept about someone, the
//! dates, the relationships, the list, what the trash and the purge do with what
//! was written about one person, and the contacts follower's points.

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
            scratch: common::Scratch::founded("people").expect("a vault"),
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

    fn person(&self, title: &str) -> String {
        self.ok("person.add", json!({ "title": title }))["id"]
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

    fn count(&self, sql: &str, params: &[&str]) -> i64 {
        self.query(sql, params)
    }

    fn found_by(&self, term: &str, id: &str) -> bool {
        self.count(
            "SELECT COUNT(*) FROM search s JOIN entity e ON e.n = s.rowid
              WHERE search MATCH ?1 AND e.id = ?2",
            &[term, id],
        ) == 1
    }
}

#[test]
fn a_person_is_added_edited_and_found_by_what_is_known_of_them() {
    let w = World::new();
    let id = w.ok(
        "person.add",
        json!({ "title": "Ada Lovelace", "role": "Mathematician", "birthday": "12-10", "cadence_days": 30 }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        w.query::<String>("SELECT form FROM person WHERE id = ?1", &[&id]),
        "person"
    );
    assert!(w.found_by("mathematician", &id));
    w.ok("person.edit", json!({ "id": id, "nickname": "Countess", "met": "at a salon", "cadence_days": 0, "role": null }));
    assert!(w.found_by("countess", &id) && w.found_by("salon", &id));
    assert!(
        !w.found_by("mathematician", &id),
        "a cleared role leaves the index"
    );
    assert_eq!(
        w.count(
            "SELECT cadence_days IS NULL FROM person WHERE id = ?1",
            &[&id]
        ),
        1,
        "0 is no cadence"
    );
    w.ok("person.edit", json!({ "id": id, "title": "Ada King" }));
    assert_eq!(
        w.query::<String>("SELECT title FROM entity WHERE id = ?1", &[&id]),
        "Ada King"
    );
    assert!(
        w.refused("person.edit", json!({ "id": id, "birthday": "02-30" }))
            .contains("not a day")
    );
    assert!(
        w.refused("person.add", json!({ "title": "  " }))
            .contains("needs a name")
    );
    assert!(
        w.refused("person.add", json!({ "id": id, "title": "Again" }))
            .contains("already holds")
    );
}

#[test]
fn a_person_is_in_one_list_at_a_time() {
    let w = World::new();
    let list = |name: &str| {
        w.ok("container.create", json!({ "kind": "list", "title": name }))["id"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let (family, work) = (list("Family"), list("Work"));
    let id = w.ok("person.add", json!({ "title": "Mum", "list_id": family }))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let held = |list: &str| {
        w.count(
            "SELECT COUNT(*) FROM edge WHERE from_id = ?1 AND rel = 'contains' AND to_id = ?2",
            &[list, &id],
        )
    };
    assert_eq!((held(&family), held(&work)), (1, 0));
    w.ok("person.move", json!({ "id": id, "list_id": work }));
    assert_eq!((held(&family), held(&work)), (0, 1));
    w.ok("person.move", json!({ "id": id }));
    assert_eq!((held(&family), held(&work)), (0, 0));
    let note = w.ok("note.create", json!({ "title": "x" }))["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(
        w.refused("person.move", json!({ "id": id, "list_id": note }))
            .contains("not a list")
    );
}

#[test]
fn contact_points_are_one_per_spelling_and_one_preferred_per_kind() {
    let w = World::new();
    let id = w.person("Grace");
    let save = |kind: &str, value: &str, preferred: bool| {
        w.ok(
            "person.save_contact_point",
            json!({ "id": id, "kind": kind, "value": value, "preferred": preferred }),
        )["point_id"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let first = save("phone", "+1 (555) 010-0100", true);
    let second = save("phone", "+1 555 010 0200", true);
    assert_eq!(
        w.count(
            "SELECT COUNT(*) FROM contact_point WHERE person_id = ?1 AND preferred = 1",
            &[&id]
        ),
        1,
        "the second preference replaced the first"
    );
    assert_eq!(
        w.query::<i64>(
            "SELECT preferred FROM contact_point WHERE id = ?1",
            &[&second]
        ),
        1
    );
    // The same number spelled another way is the same point.
    assert!(
        w.refused(
            "person.save_contact_point",
            json!({ "id": id, "kind": "phone", "value": "+15550100100" })
        )
        .contains("already saved")
    );
    assert!(
        w.refused(
            "person.save_contact_point",
            json!({ "id": id, "kind": "email", "value": "nope" })
        )
        .contains("valid email")
    );
    assert!(
        w.refused(
            "person.save_contact_point",
            json!({ "id": id, "kind": "phone", "value": "123" })
        )
        .contains("7 to 15")
    );
    // An edit changes the point it names, keeps the one preference, and is searchable.
    w.ok("person.save_contact_point", json!({ "id": id, "point_id": first, "kind": "phone", "value": "+44 20 7946 0958", "label": "London" }));
    assert!(w.found_by("london", &id));
    w.ok("person.remove_contact_point", json!({ "point_id": first }));
    assert!(
        !w.found_by("london", &id),
        "a removed point leaves the index"
    );
    assert!(
        w.refused("person.remove_contact_point", json!({ "point_id": first }))
            .contains("no contact point")
    );
}

#[test]
fn a_touch_is_an_activity_with_the_person_and_its_words_a_note_about_it() {
    let w = World::new();
    let id = w.person("Alan");
    let touch = w.ok(
        "person.log_interaction",
        json!({ "id": id, "kind": "call", "text": "about the engine" }),
    )["interaction_id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        w.query::<String>("SELECT type_id FROM activity WHERE id = ?1", &[&touch]),
        "activity_kind:call"
    );
    assert_eq!(
        w.count(
            "SELECT COUNT(*) FROM edge WHERE from_id = ?1 AND rel = 'with' AND to_id = ?2",
            &[&touch, &id]
        ),
        1
    );
    assert_eq!(
        w.count(
            "SELECT COUNT(*) FROM edge e JOIN note n ON n.id = e.from_id
              WHERE e.rel = 'about' AND e.to_id = ?1 AND n.body = 'about the engine'",
            &[&touch]
        ),
        1
    );
    // What was written about the touch finds the person it was with, and a slip
    // of the note afterwards moves the index with it.
    assert!(w.found_by("engine", &id));
    let note = w.query::<String>(
        "SELECT from_id FROM edge WHERE rel = 'about' AND to_id = ?1",
        &[&touch],
    );
    w.ok(
        "note.edit",
        json!({ "id": note, "body": "about the lathe" }),
    );
    assert!(w.found_by("lathe", &id) && !w.found_by("engine", &id));
    // A kind the vault has not met is minted, folded; one it has is reused.
    w.ok(
        "person.log_interaction",
        json!({ "id": id, "kind": "Video  Chat" }),
    );
    w.ok(
        "person.log_interaction",
        json!({ "id": id, "kind": "video chat" }),
    );
    assert_eq!(
        w.count(
            "SELECT COUNT(*) FROM concept WHERE kind = 'activity_kind' AND key = 'video chat'",
            &[]
        ),
        1
    );
    assert!(
        w.refused(
            "person.log_interaction",
            json!({ "id": touch, "kind": "call" })
        )
        .contains("not a person")
    );
}

#[test]
fn what_is_written_about_a_person_is_a_note_a_task_a_date_or_a_journal_entry() {
    let w = World::new();
    let id = w.person("Hedy");
    let note = w.ok(
        "person.add_note",
        json!({ "id": id, "text": "Loves frequency hopping\nand film" }),
    )["note_id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        w.query::<String>("SELECT title FROM entity WHERE id = ?1", &[&note]),
        "Loves frequency hopping"
    );
    assert!(
        w.found_by("hopping", &id),
        "a note about them is part of what finds them"
    );
    let gift = w.ok(
        "person.add_gift",
        json!({ "id": id, "text": "a book on radios" }),
    )["task_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let task = w.ok("person.add_task", json!({ "id": id, "text": "write back" }))["task_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let tagged = |t: &str| {
        w.count("SELECT COUNT(*) FROM edge WHERE from_id = ?1 AND rel = 'tagged' AND to_id = 'tag:gift'", &[t])
    };
    assert_eq!(
        (tagged(&gift), tagged(&task)),
        (1, 0),
        "only the gift carries the gift tag"
    );
    // The birthday is a column; any other date is a yearly all-day event about them.
    w.ok(
        "person.add_date",
        json!({ "id": id, "label": "Birthday", "month_day": "11-09" }),
    );
    assert_eq!(
        w.query::<String>("SELECT birthday FROM person WHERE id = ?1", &[&id]),
        "11-09"
    );
    let date = w.ok(
        "person.add_date",
        json!({ "id": id, "label": "Anniversary", "month_day": "02-29", "reminder_on": true }),
    )["date_id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        w.query::<String>("SELECT rule FROM event WHERE id = ?1", &[&date]),
        "FREQ=YEARLY"
    );
    assert_eq!(
        w.query::<String>("SELECT timing FROM event WHERE id = ?1", &[&date]),
        "all-day"
    );
    assert_eq!(
        w.query::<String>("SELECT reminders FROM event WHERE id = ?1", &[&date]),
        "[0]"
    );
    assert!(
        w.query::<String>("SELECT starts FROM event WHERE id = ?1", &[&date])
            .ends_with("-02-29")
    );
    assert_eq!(
        w.count(
            "SELECT COUNT(*) FROM edge WHERE from_id = ?1 AND rel = 'about' AND to_id = ?2",
            &[&date, &id]
        ),
        1
    );
    assert!(
        w.refused(
            "person.add_date",
            json!({ "id": id, "label": "Never", "month_day": "02-30" })
        )
        .contains("not a day")
    );
    // A journal entry is a note about the owner, titled by its mood, filed on its own day.
    let owner = common::self_person(&w.scratch.vault).unwrap();
    let entry = w.ok("person.add_journal_entry", json!({ "mood": "Grateful", "text": "a good day", "entry_date": "2026-03-04", "tz": "Asia/Kolkata" }))["entry_id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        w.query::<String>("SELECT title FROM entity WHERE id = ?1", &[&entry]),
        "Grateful"
    );
    assert_eq!(
        w.query::<String>("SELECT created_at FROM entity WHERE id = ?1", &[&entry]),
        "2026-03-04T06:30:00.000Z"
    );
    assert_eq!(
        w.count(
            "SELECT COUNT(*) FROM edge WHERE from_id = ?1 AND rel = 'about' AND to_id = ?2",
            &[&entry, &owner]
        ),
        1
    );
}

#[test]
fn a_relationship_is_a_labelled_edge_to_a_person_the_vault_may_already_know() {
    let w = World::new();
    let (me, mum) = (w.person("Ada"), w.person("Mum"));
    let related = w.ok(
        "person.add_relationship",
        json!({ "id": me, "name": "mum", "kind": "Mother" }),
    )["related_id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        related, mum,
        "a person of that name is reused, not duplicated"
    );
    assert_eq!(w.count("SELECT COUNT(*) FROM edge WHERE from_id = ?1 AND rel = 'related' AND to_id = ?2 AND label_id = 'relation:mother'", &[&me, &mum]), 1);
    let pet = w.ok(
        "person.add_relationship",
        json!({ "id": me, "name": "Rex", "kind": "Pet", "pet": "dog" }),
    )["related_id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        w.query::<String>("SELECT form FROM person WHERE id = ?1", &[&pet]),
        "pet"
    );
    assert_eq!(
        w.query::<String>("SELECT role FROM person WHERE id = ?1", &[&pet]),
        "dog"
    );
    assert!(
        w.refused(
            "person.add_relationship",
            json!({ "id": me, "name": "Ada", "kind": "twin" })
        )
        .contains("themselves")
    );
}

#[test]
fn a_persons_trash_takes_what_was_written_about_them_alone_and_a_task_stays() {
    let w = World::new();
    let (ada, bob) = (w.person("Ada"), w.person("Bob"));
    let note = w.ok(
        "person.add_note",
        json!({ "id": ada, "text": "only about Ada" }),
    )["note_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let shared = w.ok(
        "person.add_note",
        json!({ "id": ada, "text": "about Ada and Bob" }),
    )["note_id"]
        .as_str()
        .unwrap()
        .to_owned();
    w.ok(
        "edge.add",
        json!({ "from": shared, "rel": "about", "to": bob }),
    );
    let touch = w.ok(
        "person.log_interaction",
        json!({ "id": ada, "kind": "call", "text": "hello" }),
    )["interaction_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let task = w.ok("person.add_task", json!({ "id": ada, "text": "ring back" }))["task_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let trashed = |id: &str| {
        w.count(
            "SELECT deleted_at IS NOT NULL FROM entity WHERE id = ?1",
            &[id],
        ) == 1
    };
    w.ok("entity.trash", json!({ "id": ada }));
    assert!(
        trashed(&note) && trashed(&touch),
        "their own words and touches went with them"
    );
    assert!(
        !trashed(&shared) && !trashed(&task),
        "a note about two people and a task stay"
    );
    w.ok("entity.restore", json!({ "id": ada }));
    assert!(!trashed(&note) && !trashed(&touch));
    w.ok("entity.trash", json!({ "id": ada }));
    w.ok("entity.purge", json!({ "id": ada }));
    assert_eq!(
        w.count(
            "SELECT COUNT(*) FROM entity WHERE id IN (?1, ?2)",
            &[&note, &touch]
        ),
        0
    );
    assert_eq!(
        w.count(
            "SELECT COUNT(*) FROM entity WHERE id IN (?1, ?2)",
            &[&shared, &task]
        ),
        2
    );
    assert_eq!(w.count("SELECT COUNT(*) FROM note WHERE id IN (SELECT from_id FROM edge WHERE rel = 'about' AND to_id = ?1)", &[&touch]), 0);
}

fn contacts(w: &World, complete: bool, records: serde_json::Value) -> serde_json::Value {
    w.ok("follow.contacts", json!({ "origin": { "ref": "phone", "label": "Phone" }, "complete": complete, "records": records }))
}

#[test]
fn the_contacts_follower_keeps_points_in_step_without_undoing_the_member() {
    let w = World::new();
    let record = |points: serde_json::Value| json!([{ "external_id": "c1", "fields": { "title": "Grace Hopper", "role": "Admiral", "points": points } }]);
    let phone = json!({ "kind": "phone", "value": "+1 555 010 0100", "label": "mobile" });
    let email = json!({ "kind": "email", "value": "grace@navy.example" });
    contacts(&w, true, record(json!([phone, email])));
    let id = w.query::<String>("SELECT id FROM entity WHERE title = 'Grace Hopper'", &[]);
    assert_eq!(
        w.count(
            "SELECT COUNT(*) FROM contact_point WHERE person_id = ?1",
            &[&id]
        ),
        2
    );
    // The member adds a point and takes the email away; the source drops the phone and adds a link.
    w.ok(
        "person.save_contact_point",
        json!({ "id": id, "kind": "address", "value": "1 Navy Yard" }),
    );
    let email_point = w.query::<String>(
        "SELECT id FROM contact_point WHERE person_id = ?1 AND kind = 'email'",
        &[&id],
    );
    w.ok(
        "person.remove_contact_point",
        json!({ "point_id": email_point }),
    );
    contacts(
        &w,
        true,
        record(json!([email, { "kind": "url", "value": "https://navy.example/grace" }])),
    );
    let kinds: String = w.query(
        "SELECT group_concat(kind) FROM (SELECT kind FROM contact_point WHERE person_id = ?1 ORDER BY kind)",
        &[&id],
    );
    assert_eq!(
        kinds, "address,url",
        "the phone the source dropped is gone, the email the member removed stays removed, their address stays"
    );
    assert_eq!(
        w.query::<i64>(
            "SELECT COUNT(*) FROM person WHERE id = ?1 AND role = 'Admiral'",
            &[&id]
        ),
        1
    );
}

#[test]
fn a_new_record_is_matched_to_the_member_s_own_person_by_name_and_only_adds() {
    let w = World::new();
    let id = w.person("Katherine Johnson");
    w.ok(
        "person.save_contact_point",
        json!({ "id": id, "kind": "email", "value": "kj@nasa.example" }),
    );
    let tally = contacts(
        &w,
        true,
        json!([{ "external_id": "c9", "fields": { "title": "katherine johnson", "role": "Mathematician",
        "points": [{ "kind": "phone", "value": "+1 555 010 0300" }] } }]),
    );
    assert_eq!(
        (tally["matched"].as_i64(), tally["added"].as_i64()),
        (Some(1), Some(0))
    );
    assert_eq!(
        w.count(
            "SELECT COUNT(*) FROM contact_point WHERE person_id = ?1",
            &[&id]
        ),
        2,
        "the member's point stands beside the source's"
    );
    assert_eq!(
        w.query::<String>("SELECT role FROM person WHERE id = ?1", &[&id]),
        "Mathematician",
        "a blank takes the source's word"
    );
}

#[test]
fn a_record_gone_from_a_complete_read_takes_an_untouched_person_and_spares_an_edited_one() {
    let w = World::new();
    contacts(
        &w,
        false,
        json!([
            { "external_id": "a", "fields": { "title": "Ann", "points": [{ "kind": "email", "value": "ann@x.example" }] } },
            { "external_id": "b", "fields": { "title": "Ben", "points": [{ "kind": "email", "value": "ben@x.example" }] } }
        ]),
    );
    let (ann, ben) = (
        w.query::<String>("SELECT id FROM entity WHERE title = 'Ann'", &[]),
        w.query::<String>("SELECT id FROM entity WHERE title = 'Ben'", &[]),
    );
    // The member adds a point to Ben: that is an edit.
    w.ok(
        "person.save_contact_point",
        json!({ "id": ben, "kind": "phone", "value": "+1 555 010 0400" }),
    );
    let tally = contacts(&w, true, json!([]));
    assert_eq!(
        (tally["trashed"].as_i64(), tally["forgotten"].as_i64()),
        (Some(1), Some(1))
    );
    assert_eq!(
        w.count(
            "SELECT deleted_at IS NOT NULL FROM entity WHERE id = ?1",
            &[&ann]
        ),
        1
    );
    assert_eq!(
        w.count(
            "SELECT deleted_at IS NULL FROM entity WHERE id = ?1",
            &[&ben]
        ),
        1
    );
    assert_eq!(
        w.count("SELECT COUNT(*) FROM source WHERE entity_id = ?1", &[&ben]),
        0,
        "Ben is no longer followed"
    );
}

#[test]
fn a_vault_restored_onto_a_new_phone_is_re_found_by_name_and_loses_nothing() {
    let w = World::new();
    let read = |device: &str, ids: &[(&str, &str)]| {
        let records: Vec<_> = ids
            .iter()
            .map(|(id, name)| json!({ "external_id": id, "device_id": device, "fields": { "title": name } }))
            .collect();
        w.ok(
            "follow.contacts",
            json!({ "origin": { "ref": "phone", "label": "Phone", "device_id": device }, "complete": true, "records": records }),
        )
    };
    read(
        "device-a",
        &[("local:a1", "Ada"), ("local:a2", "Bo"), ("local:a3", "Cy")],
    );
    let people = || {
        w.count(
            "SELECT COUNT(*) FROM entity WHERE kind = 'person' AND deleted_at IS NULL",
            &[],
        )
    };
    assert_eq!(people(), 4, "three contacts and the owner");
    // The new phone names Ada and Bo its own way and does not hold Cy.
    let tally = read("device-b", &[("local:b1", "ada"), ("local:b2", "Bo")]);
    assert_eq!(
        (
            tally["matched"].as_i64(),
            tally["added"].as_i64(),
            tally["trashed"].as_i64()
        ),
        (Some(2), Some(0), Some(0))
    );
    assert_eq!(
        tally["forgotten"].as_i64(),
        Some(1),
        "Cy's source is another phone's: forgotten, the row kept"
    );
    assert_eq!(people(), 4);
    assert_eq!(
        w.count(
            "SELECT COUNT(*) FROM source WHERE device_id = 'device-a'",
            &[]
        ),
        0
    );
    assert_eq!(
        w.count(
            "SELECT COUNT(*) FROM source WHERE device_id = 'device-b'",
            &[]
        ),
        2
    );
    // A second read of the same phone is quiet.
    let again = read("device-b", &[("local:b1", "ada"), ("local:b2", "Bo")]);
    assert_eq!(
        (
            again["added"].as_i64(),
            again["updated"].as_i64(),
            again["trashed"].as_i64()
        ),
        (Some(0), Some(0), Some(0))
    );
}
