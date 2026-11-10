//! Calendar follows the phone one way, the vault's half: `follow.calendar` lands what the phone
//! states, the member's edit stands over it, and nothing is ever written back to the phone.
//! Each test plays the phone by hand.

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
            scratch: common::Scratch::founded("sync").expect("a vault"),
            registry: Registry::with_system_commands().expect("a registry"),
        }
    }

    fn run(&self, name: &str, input: Value) -> centraid_vault::CommandOutcome {
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

    fn id(&self, name: &str, input: Value) -> String {
        self.ok(name, input)["id"]
            .as_str()
            .expect("an id")
            .to_owned()
    }

    fn one<T: rusqlite::types::FromSql>(&self, sql: &str, params: &[&str]) -> T {
        self.scratch
            .vault
            .read(|c| Ok(c.query_row(sql, rusqlite::params_from_iter(params), |r| r.get(0))?))
            .expect("a row")
    }

    /// The phone calendar `work` read in full, stating `records`.
    fn read(&self, records: Vec<Value>) -> Value {
        self.ok(
            "follow.calendar",
            json!({ "origin": { "ref": "calendar:work", "label": "Work", "device_id": "phone-1" },
                     "complete": true, "records": records }),
        )
    }

    fn event_of(&self, uid: &str) -> String {
        self.one(
            "SELECT entity_id FROM source WHERE external_id = ?1",
            &[uid],
        )
    }
}

fn meeting(uid: &str, title: &str) -> Value {
    json!({ "external_id": uid, "device_id": "phone-1", "fields": {
        "title": title, "starts": "2026-03-02T09:00", "ends": "2026-03-02T10:00",
        "timing": "floating", "description": "agenda", "rule": null, "busy": 1 } })
}

fn with(mut record: Value, field: &str, value: Value) -> Value {
    record["fields"][field] = value;
    record
}

#[test]
fn a_phone_change_the_vault_did_not_touch_lands() {
    let w = World::new();
    w.read(vec![meeting("uid:1", "Sync")]);
    let event = w.event_of("uid:1");
    w.read(vec![with(
        meeting("uid:1", "Sync"),
        "description",
        json!("new agenda"),
    )]);
    assert_eq!(
        w.one::<String>("SELECT description FROM event WHERE id = ?1", &[&event]),
        "new agenda"
    );
}

#[test]
fn a_phone_delete_of_an_untouched_event_trashes_it() {
    let w = World::new();
    w.read(vec![meeting("uid:1", "Sync"), meeting("uid:2", "Other")]);
    let event = w.event_of("uid:1");
    w.read(vec![meeting("uid:2", "Other")]);
    assert!(
        w.one::<Option<String>>("SELECT deleted_at FROM entity WHERE id = ?1", &[&event])
            .is_some(),
        "the untouched event is trashed"
    );
}

#[test]
fn a_phone_delete_of_an_edited_event_keeps_the_event_and_forgets_only_the_link() {
    let w = World::new();
    w.read(vec![meeting("uid:1", "Sync"), meeting("uid:2", "Other")]);
    let event = w.event_of("uid:1");
    w.ok("event.edit", json!({ "id": event, "description": "mine" }));
    let out = w.read(vec![meeting("uid:2", "Other")]);
    assert_eq!(out["forgotten"], 1);
    assert_eq!(
        w.one::<Option<String>>("SELECT deleted_at FROM entity WHERE id = ?1", &[&event]),
        None,
        "the event is kept"
    );
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM source WHERE entity_id = ?1",
            &[&event]
        ),
        0,
        "the link is gone, as for a contact"
    );
    // The next complete read has nothing left to forget.
    let again = w.read(vec![meeting("uid:2", "Other")]);
    assert_eq!(again["forgotten"], 0);
}

#[test]
fn a_phones_alerts_land_in_the_events_reminders_as_a_followed_field() {
    let w = World::new();
    w.read(vec![with(
        meeting("uid:1", "Sync"),
        "reminders",
        json!([60, 10]),
    )]);
    let event = w.event_of("uid:1");
    assert_eq!(
        w.one::<String>("SELECT reminders FROM event WHERE id = ?1", &[&event]),
        "[60,10]"
    );
    // The member's change to the alerts stands over the phone's next word.
    w.ok("event.edit", json!({ "id": event, "reminders": [5] }));
    w.read(vec![with(
        meeting("uid:1", "Sync"),
        "reminders",
        json!([60, 10, 1440]),
    )]);
    assert_eq!(
        w.one::<String>("SELECT reminders FROM event WHERE id = ?1", &[&event]),
        "[5]"
    );
    let refused = w.run(
        "follow.calendar",
        json!({ "origin": { "ref": "calendar:work", "label": "Work", "device_id": "phone-1" },
                "complete": false,
                "records": [with(meeting("uid:9", "Bad"), "reminders", json!(["soon"]))] }),
    );
    assert_eq!(refused.status, CommandStatus::Executed);
    assert_eq!(
        refused.output["refused"], 1,
        "an alert that is not minutes is left out"
    );
}

#[test]
fn a_phones_guests_match_a_person_by_exact_email_and_the_rest_stay_in_the_statement() {
    let w = World::new();
    let ann = w.id("person.add", json!({ "title": "Ann Lee" }));
    w.ok(
        "person.save_contact_point",
        json!({ "id": ann, "kind": "email", "value": "Ann@Example.com" }),
    );
    let guests = json!([
        { "name": "Ann", "email": "ann@example.com", "state": "accepted" },
        { "name": "Stranger", "email": "who@example.com", "state": "tentative" },
        { "name": "No email" }
    ]);
    w.read(vec![with(
        meeting("uid:1", "Sync"),
        "attendees",
        guests.clone(),
    )]);
    let event = w.event_of("uid:1");
    assert_eq!(
        w.one::<String>(
            "SELECT state FROM edge WHERE from_id = ?1 AND rel = 'attendee' AND to_id = ?2",
            &[&event, &ann]
        ),
        "accepted",
        "a matching email is that person's edge, with the answer"
    );
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM edge WHERE from_id = ?1 AND rel = 'attendee'",
            &[&event]
        ),
        1,
        "nobody is minted for an unmatched guest"
    );
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM person", &[]) - 1,
        1,
        "the owner and Ann only"
    );
    let stated: Value = serde_json::from_str(
        &w.one::<String>("SELECT stated FROM source WHERE entity_id = ?1", &[&event]),
    )
    .expect("json");
    assert_eq!(
        stated["attendees"].as_array().map(Vec::len),
        Some(3),
        "kept in the statement"
    );
    // The phone's guest list changing is not an edit by the member.
    w.read(vec![with(
        meeting("uid:1", "Sync"),
        "attendees",
        json!([{ "name": "Ann", "email": "ann@example.com", "state": "declined" }]),
    )]);
    assert_eq!(
        w.one::<String>(
            "SELECT state FROM edge WHERE from_id = ?1 AND rel = 'attendee' AND to_id = ?2",
            &[&event, &ann]
        ),
        "declined"
    );
}
