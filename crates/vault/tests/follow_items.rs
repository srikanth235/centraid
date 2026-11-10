//! The follower's children merge **per item** ([#1183](https://github.com/srikanth235/centraid/issues/1183)):
//! a contact point or a guest the member has not changed takes the source's word (its new label, its
//! removal), one the member changed stands as they left it, and what they added or removed stays so.

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
            scratch: common::Scratch::founded("follow-items").expect("a vault"),
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

    fn contacts(&self, points: Value) {
        self.ok(
            "follow.contacts",
            json!({ "origin": { "ref": "phone", "label": "Phone" }, "complete": true,
                     "records": [{ "external_id": "c1", "fields": { "title": "Grace Hopper", "points": points } }] }),
        );
    }

    fn grace(&self) -> String {
        self.one("SELECT id FROM entity WHERE title = 'Grace Hopper'", &[])
    }

    /// The points a person holds, `kind:value=label` in key order.
    fn points(&self, person: &str) -> Vec<String> {
        self.scratch
            .vault
            .read(|c| {
                let mut statement = c.prepare(
                    "SELECT kind || ':' || value || '=' || COALESCE(label, '') FROM contact_point
                      WHERE person_id = ?1 ORDER BY kind, normalized",
                )?;
                Ok(statement
                    .query_map([person], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?)
            })
            .expect("points")
    }

    fn point_id(&self, person: &str, kind: &str) -> String {
        self.one(
            "SELECT id FROM contact_point WHERE person_id = ?1 AND kind = ?2",
            &[person, kind],
        )
    }

    fn calendar(&self, guests: Value) {
        self.ok(
            "follow.calendar",
            json!({ "origin": { "ref": "calendar:work", "label": "Work", "device_id": "phone-1" },
                     "complete": true, "records": [{ "external_id": "uid:1", "device_id": "phone-1",
                     "fields": { "title": "Sync", "starts": "2026-03-02T09:00", "ends": "2026-03-02T10:00",
                                 "timing": "floating", "description": "agenda", "rule": null, "busy": 1, "attendees": guests } }] }),
        );
    }

    fn event(&self) -> String {
        self.one(
            "SELECT entity_id FROM source WHERE external_id = 'uid:1'",
            &[],
        )
    }

    fn person_with_email(&self, name: &str, email: &str) -> String {
        let id = self.ok("person.add", json!({ "title": name }))["id"]
            .as_str()
            .expect("an id")
            .to_owned();
        self.ok(
            "person.save_contact_point",
            json!({ "id": id, "kind": "email", "value": email }),
        );
        id
    }

    /// `person=state` for each guest of the event, in person order.
    fn guests(&self, event: &str) -> Vec<(String, String)> {
        self.scratch
            .vault
            .read(|c| {
                let mut statement = c.prepare(
                    "SELECT to_id, COALESCE(state, '') FROM edge
                      WHERE from_id = ?1 AND rel = 'attendee' ORDER BY to_id",
                )?;
                Ok(statement
                    .query_map([event], |row| Ok((row.get(0)?, row.get(1)?)))?
                    .collect::<rusqlite::Result<Vec<_>>>()?)
            })
            .expect("guests")
    }
}

fn point(kind: &str, value: &str, label: Option<&str>) -> Value {
    json!({ "kind": kind, "value": value, "label": label })
}

#[test]
fn an_untouched_point_takes_the_sources_new_label_and_its_removal() {
    let w = World::new();
    w.contacts(json!([
        point("phone", "+1 555 010 0100", Some("mobile")),
        point("email", "grace@navy.example", Some("work")),
    ]));
    let id = w.grace();
    // The source relabels the phone and drops the email; the member touched neither.
    w.contacts(json!([point("phone", "+1 555 010 0100", Some("home"))]));
    assert_eq!(
        w.points(&id),
        ["phone:+1 555 010 0100=home"],
        "the relabel lands and the dropped email goes"
    );
    // The source clears the label.
    w.contacts(json!([point("phone", "+1 555 010 0100", None)]));
    assert_eq!(w.points(&id), ["phone:+1 555 010 0100="]);
}

#[test]
fn a_point_the_member_relabelled_survives_the_source_dropping_it_and_keeps_its_parts() {
    let w = World::new();
    w.contacts(json!([
        point("phone", "+1 555 010 0100", Some("mobile")),
        point("email", "grace@navy.example", Some("work")),
    ]));
    let id = w.grace();
    w.ok(
        "person.save_contact_point",
        json!({ "id": id, "point_id": w.point_id(&id, "phone"), "kind": "phone",
                 "value": "+1 555 010 0100", "label": "private", "preferred": true }),
    );
    // The source drops both and relabels nothing: the untouched email goes, the member's phone stays.
    w.contacts(json!([]));
    assert_eq!(w.points(&id), ["phone:+1 555 010 0100=private"]);
    assert_eq!(
        w.one::<i64>(
            "SELECT preferred FROM contact_point WHERE person_id = ?1",
            &[&id]
        ),
        1,
        "what the member set on it stays"
    );
}

#[test]
fn a_point_the_member_relabelled_ignores_the_sources_label_change_while_the_rest_follows() {
    let w = World::new();
    w.contacts(json!([
        point("phone", "+1 555 010 0100", Some("mobile")),
        point("email", "grace@navy.example", Some("work")),
    ]));
    let id = w.grace();
    w.ok(
        "person.save_contact_point",
        json!({ "id": id, "point_id": w.point_id(&id, "phone"), "kind": "phone",
                 "value": "+1 555 010 0100", "label": "private" }),
    );
    w.contacts(json!([
        point("phone", "+1 555 010 0100", Some("cell")),
        point("email", "grace@navy.example", Some("office")),
    ]));
    assert_eq!(
        w.points(&id),
        [
            "email:grace@navy.example=office",
            "phone:+1 555 010 0100=private"
        ],
        "per item: the email follows, the member's relabel stands"
    );
    // The member sets the label back to what the phone said last: the point follows again.
    w.ok(
        "person.save_contact_point",
        json!({ "id": id, "point_id": w.point_id(&id, "phone"), "kind": "phone",
                 "value": "+1 555 010 0100", "label": "cell" }),
    );
    w.contacts(json!([
        point("phone", "+1 555 010 0100", Some("desk")),
        point("email", "grace@navy.example", Some("office")),
    ]));
    assert_eq!(
        w.points(&id),
        [
            "email:grace@navy.example=office",
            "phone:+1 555 010 0100=desk"
        ]
    );
}

#[test]
fn points_the_member_added_or_removed_stay_as_they_left_them() {
    let w = World::new();
    w.contacts(json!([
        point("phone", "+1 555 010 0100", None),
        point("email", "grace@navy.example", None),
    ]));
    let id = w.grace();
    w.ok(
        "person.save_contact_point",
        json!({ "id": id, "kind": "address", "value": "1 Navy Yard" }),
    );
    w.ok(
        "person.remove_contact_point",
        json!({ "point_id": w.point_id(&id, "email") }),
    );
    // The source relabels the email the member removed and drops the phone.
    w.contacts(json!([point("email", "grace@navy.example", Some("work"))]));
    assert_eq!(
        w.points(&id),
        ["address:1 Navy Yard="],
        "the removed email is not brought back, the added address stays, the dropped phone goes"
    );
}

#[test]
fn a_guest_the_member_answered_keeps_the_answer_and_an_untouched_guest_follows() {
    let w = World::new();
    let ann = w.person_with_email("Ann", "ann@example.com");
    let ben = w.person_with_email("Ben", "ben@example.com");
    let guest = |name: &str, email: &str, state: &str| json!({ "name": name, "email": email, "state": state });
    w.calendar(json!([
        guest("Ann", "ann@example.com", "needs-action"),
        guest("Ben", "ben@example.com", "needs-action"),
    ]));
    let event = w.event();
    w.ok(
        "event.respond",
        json!({ "id": event, "person_id": ann, "state": "accepted" }),
    );
    w.calendar(json!([
        guest("Ann", "ann@example.com", "declined"),
        guest("Ben", "ben@example.com", "tentative"),
    ]));
    let held = w.guests(&event);
    let state = |person: &str| {
        held.iter()
            .find(|(id, _)| id == person)
            .map(|(_, state)| state.as_str())
    };
    assert_eq!(state(&ann), Some("accepted"), "the member's answer stands");
    assert_eq!(
        state(&ben),
        Some("tentative"),
        "the untouched guest follows"
    );
}

#[test]
fn a_guest_the_member_took_off_or_added_is_left_alone_and_an_untouched_one_goes_with_the_source() {
    let w = World::new();
    let ann = w.person_with_email("Ann", "ann@example.com");
    let ben = w.person_with_email("Ben", "ben@example.com");
    let cy = w.person_with_email("Cy", "cy@example.com");
    let guest = |name: &str, email: &str, state: &str| json!({ "name": name, "email": email, "state": state });
    w.calendar(json!([
        guest("Ann", "ann@example.com", "accepted"),
        guest("Ben", "ben@example.com", "accepted"),
    ]));
    let event = w.event();
    // The member takes Ann off and invites Cy.
    w.ok(
        "event.edit",
        json!({ "id": event, "attendees": [ben.clone(), cy.clone()] }),
    );
    // The source drops Ben (untouched) and re-states Ann with a new answer.
    w.calendar(json!([guest("Ann", "ann@example.com", "declined")]));
    let held: Vec<String> = w.guests(&event).into_iter().map(|(id, _)| id).collect();
    assert_eq!(
        held,
        std::slice::from_ref(&cy),
        "Ann stays off, Cy stays on, Ben went with the source"
    );
    assert!(!held.contains(&ann) && !held.contains(&ben));
}

fn the_attendee_differences(w: &World, event: &str) -> Vec<String> {
    w.scratch
        .vault
        .read(|c| centraid_vault::commands::follow::differences(c, event))
        .expect("differences")
        .into_iter()
        .filter(|difference| difference.field == "attendees")
        .flat_map(|difference| difference.items.into_iter().map(|item| item.key))
        .collect()
}

#[test]
fn a_guest_who_only_now_matches_a_person_is_attached_when_the_statement_changes() {
    let w = World::new();
    let guest = |name: &str, email: &str, state: &str| json!({ "name": name, "email": email, "state": state });
    // Followed while Ada matches nobody: no edge, and nothing for the member to have removed.
    w.calendar(json!([
        guest("Ada", "ada@example.com", "needs-action"),
        guest("Bob", "bob@example.com", "needs-action"),
    ]));
    let event = w.event();
    let ada = w.person_with_email("Ada", "ada@example.com");
    assert!(w.guests(&event).is_empty());
    assert!(
        the_attendee_differences(&w, &event).is_empty(),
        "a guest nobody held is not a difference"
    );
    // Another guest replies: the statement changes and Ada is attached as new.
    w.calendar(json!([
        guest("Ada", "ada@example.com", "needs-action"),
        guest("Bob", "bob@example.com", "accepted"),
    ]));
    assert_eq!(
        w.guests(&event),
        vec![(ada, "needs-action".to_owned())],
        "Ada is a guest now"
    );
    assert!(the_attendee_differences(&w, &event).is_empty());
}

#[test]
fn a_matched_guest_the_member_took_off_stays_off_and_is_still_reported() {
    let w = World::new();
    let guest = |name: &str, email: &str, state: &str| json!({ "name": name, "email": email, "state": state });
    let ada = w.person_with_email("Ada", "ada@example.com");
    w.calendar(json!([
        guest("Ada", "ada@example.com", "needs-action"),
        guest("Bob", "bob@example.com", "needs-action"),
    ]));
    let event = w.event();
    assert_eq!(w.guests(&event).len(), 1);
    w.ok("event.edit", json!({ "id": event, "attendees": [] }));
    assert_eq!(
        the_attendee_differences(&w, &event),
        vec!["ada@example.com".to_owned()]
    );
    w.calendar(json!([
        guest("Ada", "ada@example.com", "needs-action"),
        guest("Bob", "bob@example.com", "accepted"),
    ]));
    assert!(
        !w.guests(&event).iter().any(|(id, _)| *id == ada),
        "the member's removal stands"
    );
    assert_eq!(
        the_attendee_differences(&w, &event),
        vec!["ada@example.com".to_owned()],
        "the phone still has Ada"
    );
}
