//! What the phone says that differs ([#1183](https://github.com/srikanth235/centraid/issues/1183)):
//! `follow::differences` derives, on each call, the fields a followed entity holds differently from
//! its source's last statement. Nothing is stored for it: the line comes and goes with the
//! comparison.

mod common;

use centraid_vault::commands::Registry;
use centraid_vault::commands::follow::{Difference, differences};
use centraid_vault::{Command, CommandStatus, Principal};
use serde_json::{Value, json};

struct World {
    scratch: common::Scratch,
    registry: Registry,
}

impl World {
    fn new() -> Self {
        Self {
            scratch: common::Scratch::founded("follow-stated").expect("a vault"),
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

    fn one<T: rusqlite::types::FromSql>(&self, sql: &str, params: &[&str]) -> T {
        self.scratch
            .vault
            .read(|c| Ok(c.query_row(sql, rusqlite::params_from_iter(params), |r| r.get(0))?))
            .expect("a row")
    }

    fn sql(&self, sql: &str, params: &[&str]) {
        self.scratch
            .vault
            .commit(|tx| {
                tx.set_producer("test.sql");
                tx.connection()
                    .execute(sql, rusqlite::params_from_iter(params))?;
                Ok(())
            })
            .expect("a write");
    }

    fn diff(&self, id: &str) -> Vec<Difference> {
        self.scratch
            .vault
            .read(|c| differences(c, id))
            .expect("the read")
    }

    /// The names of the fields that differ.
    fn fields(&self, id: &str) -> Vec<String> {
        self.diff(id).into_iter().map(|d| d.field).collect()
    }

    fn contacts(&self, fields: Value) -> String {
        let mut fields = fields;
        fields["title"] = json!("Grace Hopper");
        self.ok(
            "follow.contacts",
            json!({ "origin": { "ref": "phone", "label": "Phone" }, "complete": true,
                     "records": [{ "external_id": "c1", "fields": fields }] }),
        );
        self.one("SELECT id FROM entity WHERE title = 'Grace Hopper'", &[])
    }
}

fn point(kind: &str, value: &str, label: Option<&str>) -> Value {
    json!({ "kind": kind, "value": value, "label": label })
}

#[test]
fn a_person_reports_title_birthday_and_points_while_they_differ_and_nothing_once_equal() {
    let w = World::new();
    let said = json!({ "birthday": "12-09", "role": "Admiral",
        "points": [point("phone", "+1 555 010 0100", Some("mobile")), point("email", "grace@navy.example", None)] });
    let id = w.contacts(said.clone());
    assert!(w.diff(&id).is_empty(), "untouched: nothing differs");

    w.ok(
        "entity.retitle",
        json!({ "id": id, "title": "Amazing Grace" }),
    );
    w.ok("person.edit", json!({ "id": id, "birthday": "12-10" }));
    w.ok(
        "person.save_contact_point",
        json!({ "id": id, "kind": "address", "value": "1 Navy Yard" }),
    );
    let phone: String = w.one(
        "SELECT id FROM contact_point WHERE person_id = ?1 AND kind = 'phone'",
        &[&id],
    );
    w.ok(
        "person.save_contact_point",
        json!({ "id": id, "point_id": phone, "kind": "phone", "value": "+1 555 010 0100", "label": "home" }),
    );
    let email: String = w.one(
        "SELECT id FROM contact_point WHERE person_id = ?1 AND kind = 'email'",
        &[&id],
    );
    w.ok("person.remove_contact_point", json!({ "point_id": email }));

    let diff = w.diff(&id);
    let by = |name: &str| diff.iter().find(|d| d.field == name).expect(name);
    assert_eq!(w.fields(&id), ["title", "birthday", "points"]);
    assert_eq!(by("title").stated, json!("Grace Hopper"));
    assert_eq!(by("title").held, json!("Amazing Grace"));
    assert_eq!(by("birthday").stated, json!("12-09"));
    assert_eq!(by("birthday").held, json!("12-10"));
    let items: Vec<(&str, Option<&Value>, bool)> = by("points")
        .items
        .iter()
        .map(|i| (i.key.as_str(), i.stated.as_ref(), i.held.is_some()))
        .collect();
    assert_eq!(
        items,
        [
            ("address:1 navy yard", None, true),
            (
                "email:grace@navy.example",
                Some(&json!({ "kind": "email", "value": "grace@navy.example" })),
                false
            ),
            (
                "phone:+15550100100",
                Some(&json!({ "kind": "phone", "value": "+1 555 010 0100", "label": "mobile" })),
                true
            ),
        ],
        "an item the member added (no stated), one they removed (no held), one they relabelled"
    );
    // `role` was stated and not changed: not reported.
    assert!(!w.fields(&id).contains(&"role".to_owned()));

    // Setting the title back by hand re-attaches it: nothing is stored, the line just goes.
    w.ok(
        "entity.retitle",
        json!({ "id": id, "title": "Grace Hopper" }),
    );
    assert_eq!(w.fields(&id), ["birthday", "points"]);
}

#[test]
fn nothing_is_reported_without_a_live_link_a_stated_field_or_for_a_tombstone() {
    let w = World::new();
    // A person nothing follows.
    let mine = w.ok("person.add", json!({ "title": "Katherine" }))["id"]
        .as_str()
        .expect("id")
        .to_owned();
    w.ok("entity.retitle", json!({ "id": mine, "title": "Kat" }));
    assert!(w.diff(&mine).is_empty());
    assert!(w.diff("no-such-id").is_empty());

    // A field the source never stated (no birthday) is not compared, whatever the member sets.
    let id = w.contacts(json!({ "role": "Admiral" }));
    w.ok("person.edit", json!({ "id": id, "birthday": "12-10" }));
    assert!(w.diff(&id).is_empty(), "birthday was never stated");

    // A trashed row has no differences; a restored one has them again.
    w.ok("entity.retitle", json!({ "id": id, "title": "Grace" }));
    assert_eq!(w.fields(&id), ["title"]);
    w.ok("entity.trash", json!({ "id": id }));
    assert!(w.diff(&id).is_empty());
    w.ok("entity.restore", json!({ "id": id }));
    assert_eq!(w.fields(&id), ["title"]);

    // A purged row is a tombstone: no entity, no differences.
    w.ok("entity.trash", json!({ "id": id }));
    w.ok("entity.purge", json!({ "id": id }));
    assert!(w.diff(&id).is_empty());
}

#[test]
fn a_row_the_phone_unlinked_reports_nothing() {
    let w = World::new();
    let read = |records: Value| {
        w.ok(
            "follow.calendar",
            json!({ "origin": { "ref": "calendar:work", "label": "Work", "device_id": "phone-1" },
                     "complete": true, "records": records }),
        )
    };
    let meeting = |uid: &str| {
        json!({ "external_id": uid, "device_id": "phone-1", "fields": {
            "title": "Sync", "starts": "2026-03-02T09:00", "ends": "2026-03-02T10:00",
            "timing": "floating", "description": "agenda", "rule": null, "busy": 1 } })
    };
    read(json!([meeting("uid:1")]));
    let event: String = w.one(
        "SELECT entity_id FROM source WHERE external_id = 'uid:1'",
        &[],
    );
    w.ok("event.edit", json!({ "id": event, "description": "mine" }));
    assert_eq!(w.fields(&event), ["description"]);
    // The phone deletes it; the member's edit keeps the row, marked unlinked.
    read(json!([]));
    assert!(w.diff(&event).is_empty());
}

#[test]
fn an_event_reports_its_followed_fields_and_its_guests_item_by_item() {
    let w = World::new();
    let ann = w.ok("person.add", json!({ "title": "Ann" }))["id"]
        .as_str()
        .expect("id")
        .to_owned();
    w.ok(
        "person.save_contact_point",
        json!({ "id": ann, "kind": "email", "value": "ann@example.com" }),
    );
    let guest =
        |name: &str, email: &str| json!({ "name": name, "email": email, "state": "needs-action" });
    w.ok(
        "follow.calendar",
        json!({ "origin": { "ref": "calendar:work", "label": "Work", "device_id": "phone-1" },
                 "complete": true, "records": [{ "external_id": "uid:1", "device_id": "phone-1", "fields": {
            "title": "Sync", "starts": "2026-03-02T09:00", "ends": "2026-03-02T10:00",
            "timing": "floating", "description": "agenda", "rule": null, "busy": 1,
            "attendees": [guest("Ann", "ann@example.com"), guest("Stranger", "who@example.com")] } }] }),
    );
    let event: String = w.one(
        "SELECT entity_id FROM source WHERE external_id = 'uid:1'",
        &[],
    );
    assert!(w.diff(&event).is_empty());

    w.ok("event.edit", json!({ "id": event, "description": "mine" }));
    w.ok(
        "event.respond",
        json!({ "id": event, "person_id": ann, "state": "accepted" }),
    );
    let diff = w.diff(&event);
    assert_eq!(
        diff.iter().map(|d| d.field.as_str()).collect::<Vec<_>>(),
        ["description", "attendees"]
    );
    assert_eq!(diff[0].stated, json!("agenda"));
    let guests = &diff[1];
    assert_eq!(
        guests.items.len(),
        1,
        "only Ann differs; the stranger is as stated"
    );
    assert_eq!(guests.items[0].key, "ann@example.com");
    assert_eq!(
        guests.items[0].stated.as_ref().expect("stated")["state"],
        "needs-action"
    );
    assert_eq!(
        guests.items[0].held.as_ref().expect("held")["state"],
        "accepted"
    );

    // Taking the guest off is also a difference, and a stated item the vault no longer holds.
    w.ok("event.edit", json!({ "id": event, "attendees": [] }));
    let diff = w.diff(&event);
    let guests = diff
        .iter()
        .find(|d| d.field == "attendees")
        .expect("attendees");
    assert_eq!(guests.items.len(), 1);
    assert!(guests.items[0].held.is_none() && guests.items[0].stated.is_some());
}

#[test]
fn a_document_reports_its_title() {
    let w = World::new();
    let folder = w.ok(
        "container.create",
        json!({ "kind": "folder", "title": "Taxes" }),
    )["id"]
        .as_str()
        .expect("id")
        .to_owned();
    let hash = centraid_vault::blob::content_digest(b"v1");
    w.ok("blob.stage", json!({ "hash": hash, "size": 2 }));
    w.ok(
        "follow.files",
        json!({ "origin": { "ref": "/Documents/Taxes", "label": "Taxes", "fills": folder },
                 "complete": true, "records": [{ "external_id": "/a.pdf", "fields": {
                    "title": "a.pdf", "blob": hash, "media_type": "application/pdf", "stat": "2:1" } }] }),
    );
    let doc: String = w.one(
        "SELECT entity_id FROM source WHERE external_id = '/a.pdf'",
        &[],
    );
    assert!(w.diff(&doc).is_empty());
    w.ok(
        "entity.retitle",
        json!({ "id": doc, "title": "Taxes 2025.pdf" }),
    );
    let diff = w.diff(&doc);
    assert_eq!(diff.len(), 1);
    assert_eq!(
        (diff[0].field.as_str(), &diff[0].stated, &diff[0].held),
        ("title", &json!("a.pdf"), &json!("Taxes 2025.pdf"))
    );
}

#[test]
fn a_workout_reports_a_measure_the_member_changed_by_column() {
    let w = World::new();
    w.ok(
        "follow.health",
        json!({ "origin": { "ref": "store:apple-health", "label": "Apple Health", "device_id": "phone-a" },
                 "complete": false, "records": [{ "external_id": "local:1", "device_id": "phone-a", "fields": {
            "kind": "run", "starts": "2026-03-04T07:00:00Z", "ends": "2026-03-04T07:45:00Z",
            "workout": { "recorded_by": "Watch", "moving_s": 2700, "distance_m": 5234.5, "heart_bpm": 148 } } }] }),
    );
    let id: String = w.one(
        "SELECT entity_id FROM source WHERE external_id = 'local:1'",
        &[],
    );
    assert!(w.diff(&id).is_empty());
    w.sql(
        "UPDATE workout SET distance_m = 6000.0, heart_bpm = NULL WHERE id = ?1",
        &[&id],
    );
    let diff = w.diff(&id);
    assert_eq!(diff.len(), 1);
    assert_eq!(diff[0].field, "workout");
    let keys: Vec<&str> = diff[0].items.iter().map(|i| i.key.as_str()).collect();
    assert_eq!(keys, ["distance_m", "heart_bpm"]);
    assert_eq!(diff[0].items[0].stated, Some(json!(5234.5)));
    assert_eq!(diff[0].items[0].held, Some(json!(6000.0)));
    assert_eq!(diff[0].items[1].held, None, "a figure the member cleared");
}
