//! A STORED RULE THAT NOW FAILS TO PARSE STILL LOADS (#1173, owner decision).
//!
//! The write boundaries refuse a rule the engine cannot read, but a rule stored
//! before a refusal existed (or by an import, or a build that read more) is
//! already in the file, and a surface that choked on it would lose the member's
//! event or task. So every row here is put in DIRECTLY, past the commands, the
//! way an older build left it, and then each path that reads a stored rule is
//! asked to cope:
//!
//! - the expander gives the series no occurrences (the apps keep the anchor);
//! - completing a repeating task finishes it, spawns nothing and errors nowhere;
//! - the follow merge carries on, and the editor-side edits still work;
//! - the rule is never rewritten or dropped behind the member's back.
//!
//! The apps' and screens' halves (the event at its anchor, the detail, the
//! read-only Custom editor) are in `crates/apps/calendar/tests/stored_rules.rs` and `crates/apps/reminders/tests/stored_rules.rs`
//! and `crates/screens/tests/agenda_repeat.rs`.

mod common;

use centraid_vault::commands::Registry;
use centraid_vault::time::recurrence::{ExpandInput, Semantics, expand};
use centraid_vault::time::rrule;
use centraid_vault::{Command, CommandStatus, Principal};
use serde_json::{Value, json};

/// Rules this build refuses at every write boundary and cannot expand.
const UNREADABLE: [&str; 4] = [
    "FREQ=HOURLY;INTERVAL=2",
    "FREQ=DAILY;BYHOUR=9",
    "FREQ=MONTHLY;BYSETPOS=-1",
    "FREQ=DAILY;COUNT=3;UNTIL=20300101",
];

struct World {
    scratch: common::Scratch,
    registry: Registry,
}

impl World {
    fn new() -> Self {
        Self {
            scratch: common::Scratch::founded("stored-rules").expect("a vault"),
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

    /// Put `rule` on a row PAST the commands, the way an older build left it.
    fn store(&self, table: &str, id: &str, rule: &str) {
        self.scratch
            .vault
            .commit(|tx| {
                tx.set_producer("test.sql");
                let changed = tx.connection().execute(
                    &format!("UPDATE {table} SET rule = ?2 WHERE id = ?1"),
                    rusqlite::params![id, rule],
                )?;
                assert_eq!(changed, 1);
                Ok(())
            })
            .expect("a write");
    }
}

#[test]
fn the_unreadable_rules_are_unreadable_everywhere() {
    for rule in UNREADABLE {
        assert!(rrule::inspect(rule).is_err(), "{rule}");
        assert_eq!(rrule::shape(rule), None, "{rule}");
        let found = expand(
            &ExpandInput::new(
                rule,
                "2026-03-02T09:00:00",
                "2026-03-01T00:00:00",
                "2027-01-01T00:00:00",
            )
            .with_semantics(Semantics::Floating),
        );
        assert!(found.is_empty(), "{rule}: no occurrences, never a guess");
    }
}

#[test]
fn a_repeating_task_with_an_unreadable_rule_completes_without_spawning_and_without_error() {
    for rule in UNREADABLE {
        let w = World::new();
        let task = w.id(
            "task.add",
            json!({ "title": "Water the plants", "due": "2026-03-02", "rule": "FREQ=DAILY" }),
        );
        w.store("task", &task, rule);
        let done = w.ok("task.complete", json!({ "id": task }));
        assert_eq!(done["status"], "done", "{rule}");
        assert!(done["next_id"].is_null(), "{rule}: no successor is spawned");
        assert!(done["next_due"].is_null(), "{rule}");
        assert_eq!(
            w.one::<String>("SELECT status FROM task WHERE id = ?1", &[&task]),
            "done"
        );
        assert_eq!(
            w.one::<i64>("SELECT COUNT(*) FROM task", &[]),
            1,
            "{rule}: still the one task"
        );
        // The rule was not rewritten or dropped.
        assert_eq!(
            w.one::<String>("SELECT rule FROM task WHERE id = ?1", &[&task]),
            rule
        );
        // Completing it again answers the same and spawns nothing.
        let again = w.ok("task.complete", json!({ "id": task }));
        assert!(again["next_id"].is_null());
        assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM task", &[]), 1);
    }
}

#[test]
fn a_task_with_an_unreadable_rule_can_be_reopened_edited_and_trashed() {
    let w = World::new();
    let task = w.id(
        "task.add",
        json!({ "title": "Pay rent", "due": "2026-03-02", "rule": "FREQ=MONTHLY" }),
    );
    w.store("task", &task, UNREADABLE[0]);
    w.ok("task.edit", json!({ "id": task, "title": "Pay the rent" }));
    assert_eq!(
        w.one::<String>("SELECT rule FROM task WHERE id = ?1", &[&task]),
        UNREADABLE[0],
        "an edit of the title leaves the stored rule alone"
    );
    w.ok("task.complete", json!({ "id": task }));
    w.ok("task.reopen", json!({ "id": task }));
    w.ok("entity.trash", json!({ "id": task }));
    w.ok("entity.restore", json!({ "id": task }));
}

#[test]
fn an_event_with_an_unreadable_rule_keeps_its_anchor_and_edits_and_trashes_cleanly() {
    let w = World::new();
    let event = w.id(
        "event.propose",
        json!({ "title": "Standup", "starts": "2026-03-02T09:00", "ends": "2026-03-02T09:15",
                "timing": "floating", "rule": "FREQ=DAILY" }),
    );
    w.store("event", &event, UNREADABLE[1]);
    w.ok(
        "event.edit",
        json!({ "id": event, "description": "daily sync" }),
    );
    assert_eq!(
        w.one::<String>("SELECT rule FROM event WHERE id = ?1", &[&event]),
        UNREADABLE[1],
        "the rule is neither rewritten nor dropped by an edit of something else"
    );
    assert_eq!(
        w.one::<String>("SELECT starts FROM event WHERE id = ?1", &[&event]),
        "2026-03-02T09:00",
        "the anchor is untouched"
    );
    // Replacing the rule is allowed, with a readable one.
    w.ok(
        "event.edit",
        json!({ "id": event, "rule": "FREQ=WEEKLY;BYDAY=MO" }),
    );
    // A new unreadable one is refused at the boundary, as ever.
    let refused = w.run("event.edit", json!({ "id": event, "rule": UNREADABLE[1] }));
    assert_eq!(refused.status, CommandStatus::Failed);
    w.ok("entity.trash", json!({ "id": event }));
    w.ok("entity.restore", json!({ "id": event }));
}

fn followed(uid: &str, title: &str, rule: Value) -> Value {
    json!({ "external_id": uid, "device_id": "phone-1", "fields": {
        "title": title, "starts": "2026-03-02T09:00", "ends": "2026-03-02T10:00",
        "timing": "floating", "description": "agenda", "rule": rule, "busy": 1 } })
}

fn read(w: &World, records: Vec<Value>) -> Value {
    w.ok(
        "follow.calendar",
        json!({ "origin": { "ref": "calendar:work", "label": "Work", "device_id": "phone-1" },
                 "complete": true, "records": records }),
    )
}

#[test]
fn the_follow_merge_does_not_choke_on_a_followed_event_whose_rule_is_unreadable() {
    let w = World::new();
    read(&w, vec![followed("uid:1", "Sync", json!("FREQ=DAILY"))]);
    let event: String = w.one(
        "SELECT entity_id FROM source WHERE external_id = 'uid:1'",
        &[],
    );
    // The stored rule becomes one this build cannot read; the member edits
    // something else.
    w.store("event", &event, UNREADABLE[2]);
    w.ok("event.edit", json!({ "id": event, "description": "mine" }));

    // The phone changes the title and still says the rule it always said.
    let outcome = read(
        &w,
        vec![followed("uid:1", "Sync (moved)", json!("FREQ=DAILY"))],
    );
    assert_eq!(
        outcome["failed"].as_i64().unwrap_or_default(),
        0,
        "{outcome}"
    );
    assert_eq!(
        w.one::<String>("SELECT title FROM entity WHERE id = ?1", &[&event]),
        "Sync (moved)",
        "the phone's title lands: the member did not touch it"
    );
    assert_eq!(
        w.one::<String>("SELECT description FROM event WHERE id = ?1", &[&event]),
        "mine",
        "the member's edit stands"
    );
    assert_eq!(
        w.one::<String>("SELECT rule FROM event WHERE id = ?1", &[&event]),
        UNREADABLE[2],
        "the member's side of the rule is kept, never dropped"
    );

    // The phone now says an unreadable rule itself (an import can): it still merges.
    let outcome = read(
        &w,
        vec![followed("uid:1", "Sync (moved)", json!(UNREADABLE[0]))],
    );
    assert_eq!(
        outcome["failed"].as_i64().unwrap_or_default(),
        0,
        "{outcome}"
    );
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM event", &[]),
        1,
        "still the one event"
    );
    // A third pass over the same statement changes nothing and does not choke.
    read(
        &w,
        vec![followed("uid:1", "Sync (moved)", json!(UNREADABLE[0]))],
    );
}

#[test]
fn a_followed_series_with_an_unreadable_rule_survives_a_moved_start() {
    // `rekey_stranded` leaves a series whose rule the expander cannot read as it is.
    let w = World::new();
    read(&w, vec![followed("uid:2", "Weekly", json!("FREQ=WEEKLY"))]);
    let event: String = w.one(
        "SELECT entity_id FROM source WHERE external_id = 'uid:2'",
        &[],
    );
    w.store("event", &event, UNREADABLE[3]);
    let mut moved = followed("uid:2", "Weekly", json!("FREQ=WEEKLY"));
    moved["fields"]["starts"] = json!("2026-03-02T10:00");
    moved["fields"]["ends"] = json!("2026-03-02T11:00");
    let outcome = read(&w, vec![moved]);
    assert_eq!(
        outcome["failed"].as_i64().unwrap_or_default(),
        0,
        "{outcome}"
    );
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM event", &[]), 1);
}

#[test]
fn the_write_boundaries_still_refuse_a_rule_the_member_states() {
    let w = World::new();
    for rule in UNREADABLE {
        let refused = w.run(
            "task.add",
            json!({ "title": "Bad", "due": "2026-03-02", "rule": rule }),
        );
        assert_eq!(refused.status, CommandStatus::Failed, "{rule}");
        let refused = w.run(
            "event.propose",
            json!({ "title": "Bad", "starts": "2026-03-02T09:00", "timing": "floating",
                    "rule": rule }),
        );
        assert_eq!(refused.status, CommandStatus::Failed, "{rule}");
    }
    let task = w.id(
        "task.add",
        json!({ "title": "Fine", "due": "2026-03-02", "rule": "FREQ=DAILY" }),
    );
    let refused = w.run("task.edit", json!({ "id": task, "rule": UNREADABLE[0] }));
    assert_eq!(refused.status, CommandStatus::Failed);
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM task", &[]), 1);
}
