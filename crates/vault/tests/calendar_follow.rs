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
        w.one::<String>("SELECT group_concat(offset_min) FROM (SELECT offset_min FROM reminder WHERE entity_id = ?1 ORDER BY offset_min)", &[&event]),
        "10,60"
    );
    // The member's change to the alerts stands over the phone's next word.
    w.ok("event.edit", json!({ "id": event, "reminders": [5] }));
    w.read(vec![with(
        meeting("uid:1", "Sync"),
        "reminders",
        json!([60, 10, 1440]),
    )]);
    assert_eq!(
        w.one::<String>("SELECT group_concat(offset_min) FROM (SELECT offset_min FROM reminder WHERE entity_id = ?1 ORDER BY offset_min)", &[&event]),
        "5"
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

fn deleted(w: &World, id: &str) -> bool {
    w.one::<Option<String>>("SELECT deleted_at FROM entity WHERE id = ?1", &[id])
        .is_some()
}

/// A calendar is a holder: it takes its live events to the trash with it, an event that was
/// already in the trash keeps its own stamp, and one restore brings back exactly the events that
/// went with it. The vault's own calendar cannot be trashed.
#[test]
fn a_calendar_takes_its_events_to_the_trash_and_restores_exactly_those() {
    let w = World::new();
    let side = w.id(
        "container.create",
        json!({ "kind": "calendar", "title": "Side" }),
    );
    let on = |title: &str, day: &str| {
        w.id(
            "event.propose",
            json!({ "title": title, "starts": format!("{day}T09:00:00"),
                    "ends": format!("{day}T09:30:00"), "timing": "floating", "calendar_id": side }),
        )
    };
    let (kept, early) = (on("Kept", "2030-01-10"), on("Early", "2030-01-11"));
    w.ok("entity.trash", json!({ "id": early }));
    w.scratch.clock.advance_ms(1_000);
    let trashed = w.ok("entity.trash", json!({ "id": side }));
    assert_eq!(
        trashed["trashed"].as_array().map(Vec::len),
        Some(2),
        "the calendar and Kept"
    );
    assert!(deleted(&w, &side) && deleted(&w, &kept) && deleted(&w, &early));
    // An event is not brought back into a calendar in the trash; a new one is not made on it.
    let refused = w.run("entity.restore", json!({ "id": kept }));
    assert_eq!(refused.status, CommandStatus::Failed);
    let made = w.run(
        "event.propose",
        json!({ "title": "Late", "starts": "2030-01-11T09:00:00", "ends": "2030-01-11T09:30:00",
                "timing": "floating", "calendar_id": side }),
    );
    assert_eq!(made.status, CommandStatus::Failed);
    // The vault's own calendar stays.
    let own = w.run("entity.trash", json!({ "id": "calendar:default" }));
    assert_eq!(own.status, CommandStatus::Failed);
    w.ok("entity.restore", json!({ "id": side }));
    assert!(!deleted(&w, &side) && !deleted(&w, &kept));
    assert!(
        deleted(&w, &early),
        "the event that was already in the trash stays there"
    );
}

/// A calendar in the trash purges with the events that went with it, and refuses while an event
/// the member trashed on its own, or kept live, is still on it.
#[test]
fn a_purged_calendar_takes_what_went_with_it() {
    let w = World::new();
    let side = w.id(
        "container.create",
        json!({ "kind": "calendar", "title": "Side" }),
    );
    let event = w.id(
        "event.propose",
        json!({ "title": "Only", "starts": "2030-01-10T09:00:00", "ends": "2030-01-10T09:30:00",
                "timing": "floating", "calendar_id": side }),
    );
    let early = w.id(
        "event.propose",
        json!({ "title": "Early", "starts": "2030-01-12T09:00:00", "ends": "2030-01-12T09:30:00",
                "timing": "floating", "calendar_id": side }),
    );
    w.ok("entity.trash", json!({ "id": early }));
    w.scratch.clock.advance_ms(1_000);
    w.ok("entity.trash", json!({ "id": side }));
    let refused = w.run("entity.purge", json!({ "id": side }));
    assert_eq!(
        refused.status,
        CommandStatus::Failed,
        "an event of its own is still on it"
    );
    w.ok("entity.purge", json!({ "id": early }));
    w.ok("entity.purge", json!({ "id": side }));
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM entity WHERE id IN (?1, ?2, ?3)",
            &[&side, &event, &early]
        ),
        0
    );
}

/// A followed calendar the member trashed is not resurrected by the next pass, and what the phone
/// newly states into it goes to the trash with it, so a restore brings it back.
#[test]
fn a_followed_calendar_the_member_trashed_stays_trashed() {
    let w = World::new();
    w.read(vec![meeting("uid:1", "Sync")]);
    let event = w.event_of("uid:1");
    let calendar: String = w.one("SELECT calendar_id FROM event WHERE id = ?1", &[&event]);
    w.ok("entity.trash", json!({ "id": calendar }));
    assert!(deleted(&w, &event));
    w.read(vec![meeting("uid:1", "Sync"), meeting("uid:2", "New")]);
    let arrival = w.event_of("uid:2");
    assert!(
        deleted(&w, &calendar),
        "a pass does not restore the calendar"
    );
    assert!(
        deleted(&w, &event) && deleted(&w, &arrival),
        "nor its events"
    );
    w.ok("entity.restore", json!({ "id": calendar }));
    assert!(!deleted(&w, &calendar) && !deleted(&w, &event) && !deleted(&w, &arrival));
}
