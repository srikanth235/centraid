//! Two-way calendar sync, the vault's half (#1173): what is owed to a phone calendar and what
//! `follow.pushed` records, one test per conflict rule C1..C12 of the design (C12: a restore
//! after a pushed delete re-creates the event on the phone).
//!
//! The merge is `follow.calendar`; "owed" is derived, never stored; the shell's answers are
//! `follow.pushed`. Each test plays the phone and the shell by hand.

mod common;

use centraid_vault::commands::Registry;
use centraid_vault::commands::calendar_push::{Op, Owed, owed_pushes};
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

    fn origin(&self) -> String {
        self.one("SELECT id FROM origin WHERE ref = 'calendar:work'", &[])
    }

    fn event_of(&self, uid: &str) -> String {
        self.one(
            "SELECT entity_id FROM source WHERE external_id = ?1",
            &[uid],
        )
    }

    /// What is owed to the writable calendars among `writable`.
    fn owed(&self, writable: &[String]) -> Vec<Owed> {
        self.scratch
            .vault
            .read(|c| owed_pushes(c, writable, None, 50))
            .expect("the owed read")
            .items
    }

    fn owed_here(&self) -> Vec<Owed> {
        self.owed(&[self.origin()])
    }

    fn pushed(&self, items: Value) -> Value {
        self.ok("follow.pushed", json!({ "items": items }))
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

fn ops(owed: &[Owed]) -> Vec<(Op, &str)> {
    owed.iter()
        .map(|item| (item.op, item.event_id.as_str()))
        .collect()
}

fn source_state(w: &World, event: &str) -> (Option<String>, i64) {
    (
        w.one(
            "SELECT MAX(gone_at) FROM source WHERE entity_id = ?1",
            &[event],
        ),
        w.one("SELECT COUNT(*) FROM source WHERE entity_id = ?1", &[event]),
    )
}

#[test]
fn sync_c1_a_phone_change_the_vault_did_not_touch_lands_and_owes_nothing() {
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
    assert!(
        w.owed_here().is_empty(),
        "the vault matches what the phone stated"
    );
}

#[test]
fn sync_c2_a_vault_change_the_phone_did_not_make_is_pushed_then_stated() {
    let w = World::new();
    w.read(vec![meeting("uid:1", "Sync")]);
    let event = w.event_of("uid:1");
    w.ok(
        "event.edit",
        json!({ "id": event, "description": "mine", "reminders": [30, 5] }),
    );
    let owed = w.owed_here();
    assert_eq!(ops(&owed), [(Op::Update, event.as_str())]);
    assert_eq!(owed[0].changed, ["description", "reminders"]);
    assert_eq!(owed[0].external_id.as_deref(), Some("uid:1"));
    assert_eq!(owed[0].origin_ref, "calendar:work");
    assert_eq!(owed[0].fields["description"], "mine");
    assert_eq!(
        owed[0].fields["reminders"], "[30,5]",
        "the two alerts ride in the fields"
    );
    assert!(
        owed[0].fields.get("attendees").is_none(),
        "guests are never pushed"
    );
    let done = w.pushed(json!([{ "event_id": event, "op": "update", "ok": true,
                                 "fields": owed[0].fields }]));
    assert_eq!(done["updated"], 1);
    assert!(
        w.owed_here().is_empty(),
        "after the shell confirms, stated is what was pushed"
    );
    // The phone's next read says the same words: nothing for the vault to take back.
    w.read(vec![with(
        with(meeting("uid:1", "Sync"), "description", json!("mine")),
        "reminders",
        json!([30, 5]),
    )]);
    assert_eq!(
        w.one::<String>("SELECT description FROM event WHERE id = ?1", &[&event]),
        "mine"
    );
    assert!(w.owed_here().is_empty());
}

#[test]
fn sync_c3_both_changed_the_same_field_the_members_edit_wins_and_is_pushed() {
    let w = World::new();
    w.read(vec![meeting("uid:1", "Sync")]);
    let event = w.event_of("uid:1");
    w.ok("event.edit", json!({ "id": event, "description": "mine" }));
    w.read(vec![with(
        meeting("uid:1", "Sync"),
        "description",
        json!("theirs"),
    )]);
    assert_eq!(
        w.one::<String>("SELECT description FROM event WHERE id = ?1", &[&event]),
        "mine",
        "the member's edit stands"
    );
    let owed = w.owed_here();
    assert_eq!(ops(&owed), [(Op::Update, event.as_str())]);
    assert_eq!(owed[0].changed, ["description"]);
    assert_eq!(
        owed[0].stated["description"], "theirs",
        "what the phone holds now"
    );
    w.pushed(json!([{ "event_id": event, "op": "update", "ok": true }]));
    assert!(w.owed_here().is_empty());
}

#[test]
fn sync_c4_a_phone_delete_of_an_untouched_event_trashes_it_and_pushes_nothing() {
    let w = World::new();
    w.read(vec![meeting("uid:1", "Sync"), meeting("uid:2", "Other")]);
    let event = w.event_of("uid:1");
    w.read(vec![meeting("uid:2", "Other")]);
    assert!(
        w.one::<Option<String>>("SELECT deleted_at FROM entity WHERE id = ?1", &[&event])
            .is_some(),
        "the untouched event is trashed"
    );
    assert!(
        w.owed_here().is_empty(),
        "the phone's own delete is not pushed back as a delete"
    );
}

#[test]
fn sync_c5_a_phone_delete_of_an_edited_event_keeps_it_unlinked_and_never_recreates_it() {
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
    let (gone_at, rows) = source_state(&w, &event);
    assert!(
        gone_at.is_some() && rows == 1,
        "the source keeps a mark that the phone unlinked it"
    );
    assert!(
        w.owed_here().is_empty(),
        "an unlinked event is not owed a create: the phone deleted it"
    );
    // The next complete read does not forget it a second time.
    let again = w.read(vec![meeting("uid:2", "Other")]);
    assert_eq!(again["forgotten"], 0);
    assert!(w.owed_here().is_empty());
}

#[test]
fn sync_c6_a_vault_trash_of_an_unchanged_event_is_deleted_on_the_phone_then_tombstoned() {
    let w = World::new();
    w.read(vec![meeting("uid:1", "Sync")]);
    let event = w.event_of("uid:1");
    w.ok("entity.trash", json!({ "id": event }));
    let owed = w.owed_here();
    assert_eq!(ops(&owed), [(Op::Delete, event.as_str())]);
    assert_eq!(owed[0].external_id.as_deref(), Some("uid:1"));
    assert_eq!(
        owed[0].stated["title"], "Sync",
        "the shell compares its copy with this"
    );
    let done = w.pushed(json!([{ "event_id": event, "op": "delete", "ok": true }]));
    assert_eq!(done["deleted"], 1);
    // The tombstone is a source of no row, the form a purge leaves it in (and the form C12
    // relies on): the phone's old id is remembered, the event has no source.
    assert_eq!(
        source_state(&w, &event).1,
        0,
        "the event has no source any more"
    );
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM source WHERE external_id = 'uid:1' AND entity_id IS NULL
                AND gone_at IS NOT NULL",
            &[]
        ),
        1,
        "the source is tombstoned, not dropped"
    );
    assert!(w.owed_here().is_empty(), "never owed again");
    // Purged, the tombstone stays a source of no row, as every purge leaves it.
    w.ok("entity.purge", json!({ "id": event }));
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM source WHERE external_id = 'uid:1' AND entity_id IS NULL",
            &[]
        ),
        1
    );
}

#[test]
fn sync_c7_a_vault_trash_of_an_event_the_phone_changed_leaves_the_phone_copy_and_unlinks() {
    let w = World::new();
    w.read(vec![meeting("uid:1", "Sync")]);
    let event = w.event_of("uid:1");
    w.ok("entity.trash", json!({ "id": event }));
    assert_eq!(ops(&w.owed_here()), [(Op::Delete, event.as_str())]);
    // The shell found the phone's copy changed since stated and left it.
    let done = w.pushed(json!([{ "event_id": event, "op": "delete", "ok": true,
                                 "phone_kept": true }]));
    assert_eq!(done["unlinked"], 1);
    assert_eq!(source_state(&w, &event).1, 0, "the source is forgotten");
    assert!(w.owed_here().is_empty());
    assert!(
        w.one::<Option<String>>("SELECT deleted_at FROM entity WHERE id = ?1", &[&event])
            .is_some(),
        "the vault's trash stands"
    );
}

#[test]
fn sync_c8_a_read_only_phone_calendar_is_never_pushed() {
    let w = World::new();
    w.read(vec![meeting("uid:1", "Sync")]);
    let event = w.event_of("uid:1");
    w.ok("event.edit", json!({ "id": event, "description": "mine" }));
    w.id(
        "event.propose",
        json!({ "title": "Born here", "starts": "2026-03-03T09:00",
                "calendar_id": w.one::<String>("SELECT fills FROM origin", &[]) }),
    );
    // The shell reported nothing writable: a calendar never reported is read-only.
    assert!(w.owed(&[]).is_empty());
    assert!(w.owed_here().len() == 2, "and writable, both are owed");
    // The edit stays in the vault and the next read keeps it.
    w.read(vec![meeting("uid:1", "Sync")]);
    assert_eq!(
        w.one::<String>("SELECT description FROM event WHERE id = ?1", &[&event]),
        "mine"
    );
}

#[test]
fn sync_c9_a_centraid_only_calendar_never_reaches_the_phone() {
    let w = World::new();
    w.read(vec![meeting("uid:1", "Sync")]);
    let mine = w.id(
        "container.create",
        json!({ "kind": "calendar", "title": "Mine" }),
    );
    w.id(
        "event.propose",
        json!({ "title": "Private", "starts": "2026-03-04T09:00", "calendar_id": mine }),
    );
    // The default calendar has no origin either.
    w.id(
        "event.propose",
        json!({ "title": "Default", "starts": "2026-03-05T09:00" }),
    );
    assert!(w.owed_here().is_empty());
    assert!(w.owed(&["no-such-origin".to_owned()]).is_empty());
}

#[test]
fn sync_c10_a_series_edit_and_a_single_day_edit_are_told_apart() {
    let w = World::new();
    let mut weekly = meeting("uid:w", "Weekly");
    weekly["fields"]["rule"] = json!("FREQ=WEEKLY");
    weekly["fields"]["overrides"] = json!({ "from": "2026-03-01T00:00:00Z",
        "to": "2026-03-31T00:00:00Z", "shown": ["2026-03-02T09:00:00", "2026-03-09T09:00:00", "2026-03-16T09:00:00",
                    "2026-03-23T09:00:00", "2026-03-30T09:00:00"], "moved": [] });
    w.read(vec![weekly]);
    let series = w.event_of("uid:w");
    // One day cancelled: the series is untouched and the push names the days alone.
    w.ok(
        "event.edit_occurrence",
        json!({ "id": series, "original_start": "2026-03-09T09:00:00", "scope": "occurrence",
                "action": "skip" }),
    );
    let owed = w.owed_here();
    assert_eq!(ops(&owed), [(Op::Update, series.as_str())]);
    assert_eq!(owed[0].changed, ["overrides"], "that day only");
    assert_eq!(owed[0].fields["rule"], "FREQ=WEEKLY");
    assert!(owed[0].fields["overrides"]["held"].is_array());
    w.pushed(json!([{ "event_id": series, "op": "update", "ok": true }]));
    // A change to the series itself is a series-level push: the vault's own rule string.
    w.ok(
        "event.edit",
        json!({ "id": series, "rule": "FREQ=WEEKLY;COUNT=10" }),
    );
    let owed = w.owed_here();
    assert!(
        owed[0].changed.contains(&"rule".to_owned()),
        "{:?}",
        owed[0].changed
    );
    assert_eq!(owed[0].fields["rule"], "FREQ=WEEKLY;COUNT=10");
}

#[test]
fn sync_c11_a_failed_push_changes_nothing_and_is_owed_again() {
    let w = World::new();
    w.read(vec![meeting("uid:1", "Sync")]);
    let event = w.event_of("uid:1");
    w.ok("event.edit", json!({ "id": event, "description": "mine" }));
    let stated_before: String = w.one("SELECT stated FROM source WHERE entity_id = ?1", &[&event]);
    let done = w.pushed(json!([{ "event_id": event, "op": "update", "ok": false }]));
    assert_eq!(
        (done["failed"].as_i64(), done["updated"].as_i64()),
        (Some(1), Some(0))
    );
    assert_eq!(
        w.one::<String>("SELECT stated FROM source WHERE entity_id = ?1", &[&event]),
        stated_before
    );
    assert_eq!(
        ops(&w.owed_here()),
        [(Op::Update, event.as_str())],
        "owed again"
    );
    // Never answered at all is the same: nothing was recorded.
    assert_eq!(ops(&w.owed_here()), [(Op::Update, event.as_str())]);
}

// ---------------------------------------------------------------------------
// The create push, alerts and guests
// ---------------------------------------------------------------------------

#[test]
fn a_centraid_event_in_a_followed_calendar_is_created_on_the_phone_and_linked_to_its_id() {
    let w = World::new();
    w.read(vec![meeting("uid:1", "Sync")]);
    let calendar: String = w.one("SELECT fills FROM origin", &[]);
    let born = w.id(
        "event.propose",
        json!({ "title": "Born here", "starts": "2026-03-03T09:00", "ends": "2026-03-03T10:00",
                "calendar_id": calendar, "reminders": [15] }),
    );
    let cancelled = w.id(
        "event.propose",
        json!({ "title": "Called off", "starts": "2026-03-04T09:00", "calendar_id": calendar }),
    );
    w.ok("event.cancel", json!({ "id": cancelled }));
    let owed = w.owed_here();
    assert_eq!(
        ops(&owed),
        [(Op::Create, born.as_str())],
        "a cancelled event is not created"
    );
    assert_eq!(owed[0].external_id, None);
    assert_eq!(owed[0].fields["title"], "Born here");
    assert_eq!(owed[0].fields["reminders"], "[15]");
    let done = w.pushed(json!([{ "event_id": born, "op": "create", "ok": true,
                                 "external_id": "uid:new", "fields": owed[0].fields }]));
    assert_eq!(done["created"], 1);
    assert_eq!(w.event_of("uid:new"), born, "linked to the phone's own id");
    assert!(w.owed_here().is_empty());
    // A create answered without the phone's id is refused, and one answered twice is harmless.
    let refused = w.run(
        "follow.pushed",
        json!({ "items": [{ "event_id": born, "op": "create", "ok": true }] }),
    );
    assert_eq!(refused.status, CommandStatus::Failed);
    w.pushed(json!([{ "event_id": born, "op": "create", "ok": true, "external_id": "uid:new" }]));
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM source WHERE entity_id = ?1", &[&born]),
        1
    );
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
    // The phone's guest list changing is not an edit by the member, and never an owed push.
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
    assert!(w.owed_here().is_empty());
}

/// C12: the member trashed a followed event, the phone's copy was deleted (C6) and the source
/// tombstoned; a later explicit restore makes the event owed a CREATE again in its writable phone
/// calendar, and `follow.pushed` links the NEW id the phone minted. (RFC-style two-way sync: the
/// restored event is the member's again, so it belongs on their phone.)
#[test]
fn sync_c12_restore_after_pushed_delete_recreates_on_phone() {
    let w = World::new();
    w.read(vec![meeting("uid:1", "Sync")]);
    let event = w.event_of("uid:1");
    w.ok("entity.trash", json!({ "id": event }));
    w.pushed(json!([{ "event_id": event, "op": "delete", "ok": true }]));
    assert!(
        w.owed_here().is_empty(),
        "C6: deleted on the phone, never owed again"
    );

    // The member restores it.
    w.ok("entity.restore", json!({ "id": event }));
    let owed = w.owed_here();
    assert_eq!(ops(&owed), [(Op::Create, event.as_str())]);
    assert_eq!(owed[0].external_id, None, "the phone mints the id");
    assert_eq!(owed[0].fields["title"], "Sync");
    assert_eq!(owed[0].origin_ref, "calendar:work");
    // Owed again until the shell answers (C11): nothing was written by the restore.
    assert_eq!(ops(&w.owed_here()), [(Op::Create, event.as_str())]);
    assert_eq!(source_state(&w, &event).1, 0);

    // The shell created it and answers with the id the phone gave it.
    let done = w.pushed(json!([{ "event_id": event, "op": "create", "ok": true,
                                 "external_id": "uid:reborn", "device_id": "phone-1",
                                 "fields": owed[0].fields }]));
    assert_eq!(done["created"], 1);
    assert_eq!(w.event_of("uid:reborn"), event, "linked to the new id");
    assert!(w.owed_here().is_empty());
    // The old tombstone is untouched: it still answers to the phone's old id, and was never
    // relinked (`source_tombstone_is_final`).
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM source WHERE external_id = 'uid:1' AND entity_id IS NULL",
            &[]
        ),
        1
    );
    // The phone's next complete read holds the new copy and not the old one: no duplicate, the
    // old tombstone is forgotten (its record is gone), the event stays and is not owed anything.
    let out = w.read(vec![meeting("uid:reborn", "Sync")]);
    assert_eq!(out["added"], 0, "{out}");
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM event", &[]), 1);
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM source WHERE external_id = 'uid:1'",
            &[]
        ),
        0
    );
    assert!(w.owed_here().is_empty());
    // Trashing it again is a delete of the NEW copy, once more.
    w.ok("entity.trash", json!({ "id": event }));
    let owed = w.owed_here();
    assert_eq!(ops(&owed), [(Op::Delete, event.as_str())]);
    assert_eq!(owed[0].external_id.as_deref(), Some("uid:reborn"));
}

/// C12 does not reach C4: the phone deleted an event the member never edited, the follower trashed
/// it, and a restore (the member's, or the record's return) does not re-create it on the phone.
#[test]
fn sync_c12_never_recreates_a_c4_event_the_phone_deleted() {
    let w = World::new();
    w.read(vec![meeting("uid:1", "Sync"), meeting("uid:2", "Other")]);
    let event = w.event_of("uid:1");
    w.read(vec![meeting("uid:2", "Other")]);
    assert!(
        w.one::<Option<String>>("SELECT deleted_at FROM entity WHERE id = ?1", &[&event])
            .is_some(),
        "C4: the follower trashed it"
    );
    // The member restores it from the trash: it is theirs again, and is NOT written back.
    w.ok("entity.restore", json!({ "id": event }));
    assert!(w.owed_here().is_empty(), "no create: the phone deleted it");
    // And on a later complete read that still lacks it, it is not forgotten twice or trashed
    // again (it was edited by nobody, but it is the member's now; the phone's absence is final).
    w.read(vec![meeting("uid:2", "Other")]);
    assert!(w.owed_here().is_empty());

    // The follower's own undo: a record that RETURNS restores what its absence trashed.
    let w = World::new();
    w.read(vec![meeting("uid:1", "Sync"), meeting("uid:2", "Other")]);
    let event = w.event_of("uid:1");
    w.read(vec![meeting("uid:2", "Other")]);
    let back = w.read(vec![meeting("uid:1", "Sync"), meeting("uid:2", "Other")]);
    assert_eq!(back["restored"], 1);
    assert_eq!(
        w.one::<Option<String>>("SELECT deleted_at FROM entity WHERE id = ?1", &[&event]),
        None
    );
    assert!(
        w.owed_here().is_empty(),
        "restored by the record's return: nothing owed"
    );
}

/// C12 does not reach C5: the phone deleted an event the member had edited, the vault kept it with
/// the unlink mark; trashing and restoring it never re-creates it on the phone.
#[test]
fn sync_c12_never_recreates_a_c5_marked_event_even_after_a_trash_and_restore() {
    let w = World::new();
    w.read(vec![meeting("uid:1", "Sync"), meeting("uid:2", "Other")]);
    let event = w.event_of("uid:1");
    w.ok("event.edit", json!({ "id": event, "description": "mine" }));
    w.read(vec![meeting("uid:2", "Other")]);
    assert!(w.owed_here().is_empty(), "C5: marked, not owed a create");
    w.ok("entity.trash", json!({ "id": event }));
    assert!(
        w.owed_here().is_empty(),
        "trashing the marked event owes no delete: the phone's copy is already gone"
    );
    w.ok("entity.restore", json!({ "id": event }));
    assert!(
        w.owed_here().is_empty(),
        "restoring it is not a re-create: the marker stands"
    );
    assert_eq!(
        source_state(&w, &event).1,
        1,
        "the marker is still on the event"
    );
}

/// Unchanged: an event never pushed (born in Centraid, trashed before the phone ever heard of it)
/// is, once restored, owed its create as ever; one still on the phone and restored before the
/// delete was pushed has nothing owed at all.
#[test]
fn sync_c12_leaves_a_never_pushed_event_and_an_unpushed_trash_as_they_were() {
    let w = World::new();
    w.read(vec![meeting("uid:1", "Sync")]);
    let calendar: String = w.one("SELECT fills FROM origin", &[]);
    let born = w.id(
        "event.propose",
        json!({ "title": "Born here", "starts": "2026-03-03T09:00", "calendar_id": calendar }),
    );
    w.ok("entity.trash", json!({ "id": born }));
    assert!(
        w.owed_here().is_empty(),
        "a trashed, never-pushed event owes nothing"
    );
    w.ok("entity.restore", json!({ "id": born }));
    assert_eq!(ops(&w.owed_here()), [(Op::Create, born.as_str())]);

    // Trashed and restored before the delete was pushed: still linked, nothing owed.
    let linked = w.event_of("uid:1");
    w.ok("entity.trash", json!({ "id": linked }));
    w.ok("entity.restore", json!({ "id": linked }));
    assert_eq!(
        ops(&w.owed_here()),
        [(Op::Create, born.as_str())],
        "the linked event is back and has no delete or create owed"
    );
}
