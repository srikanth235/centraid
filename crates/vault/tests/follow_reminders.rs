//! The phone's Reminders, followed (#1185, #1214): each reminder is a task in the project the
//! origin fills; the member's edit of a field stands over the phone's word; a phone completion
//! completes the task; a reminder gone from a complete read goes to the trash and comes back with
//! the record; the phone alerts for what it states and the vault for what the member changed.

mod common;

use common::world::World;
use serde_json::{Value, json};

fn follow(w: &World, records: Value, complete: bool) -> Value {
    w.ok(
        "follow.reminders",
        json!({ "origin": { "ref": "list:1", "label": "Groceries", "device_id": "phone-1" },
                "complete": complete, "records": records }),
    )
}

fn rec(id: &str, title: &str, extra: Value) -> Value {
    let mut fields = json!({ "title": title, "status": "open", "done_at": null });
    fields
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    json!({ "external_id": id, "device_id": "phone-1", "fields": fields })
}

fn task_of(w: &World, uid: &str) -> String {
    w.one(
        "SELECT entity_id FROM source WHERE external_id = ?1",
        &[uid],
    )
}

fn alerts_of(w: &World, task: &str) -> i64 {
    w.vault()
        .read(|c| {
            Ok(c.query_row(
                "SELECT COUNT(*) FROM alert a JOIN reminder r ON r.id = a.reminder_id WHERE r.entity_id = ?1",
                [task],
                |r| r.get(0),
            )?)
        })
        .expect("alerts")
}

#[test]
fn a_reminder_arrives_in_its_list_edits_stand_and_a_phone_completion_completes_the_task() {
    let w = World::new("remind_follow");
    let out = follow(
        &w,
        json!([rec(
            "r1",
            "Milk",
            json!({ "due": "2026-12-01", "rule": "FREQ=WEEKLY", "reminders": [10] })
        )]),
        true,
    );
    assert_eq!(out["added"], 1, "{out}");
    let id = task_of(&w, "r1");
    // The list is a project the origin fills, and the task is in it.
    let project: String = w.one("SELECT fills FROM origin WHERE ref = 'list:1'", &[]);
    assert_eq!(
        w.one::<String>("SELECT parent_id FROM entity WHERE id = ?1", &[&id]),
        project
    );
    assert_eq!(
        w.one::<String>("SELECT kind FROM entity WHERE id = ?1", &[&project]),
        "project"
    );
    assert_eq!(
        w.one::<String>(
            "SELECT due_timing || ' ' || due FROM task WHERE id = ?1",
            &[&id]
        ),
        "all-day 2026-12-01"
    );
    assert_eq!(
        w.one::<i64>(
            "SELECT offset_min FROM reminder WHERE entity_id = ?1",
            &[&id]
        ),
        10
    );
    // The member edits the due day; the phone completes the reminder.
    w.ok("task.edit", json!({ "id": &id, "due": "2026-12-05" }));
    let done = rec(
        "r1",
        "Milk",
        json!({ "due": "2026-12-01", "rule": "FREQ=WEEKLY", "reminders": [10],
                "status": "done", "done_at": "2026-11-30T10:00:00Z" }),
    );
    let out = follow(&w, json!([done]), true);
    assert_eq!(out["updated"], 1);
    assert_eq!(
        w.one::<String>("SELECT status FROM task WHERE id = ?1", &[&id]),
        "done"
    );
    assert_eq!(
        w.one::<String>("SELECT due FROM task WHERE id = ?1", &[&id]),
        "2026-12-05",
        "the member's own due day stands"
    );
    assert_eq!(
        w.one::<String>("SELECT done_at FROM task WHERE id = ?1", &[&id]),
        "2026-11-30T10:00:00.000Z"
    );
}

#[test]
fn a_reminder_losing_its_due_loses_its_rule_and_its_alerts_in_one_write() {
    let w = World::new("remind_follow_due");
    follow(
        &w,
        json!([rec(
            "r1",
            "Milk",
            json!({ "due": "2026-12-01", "rule": "FREQ=WEEKLY", "reminders": [10] })
        )]),
        true,
    );
    let id = task_of(&w, "r1");
    let out = follow(
        &w,
        json!([rec(
            "r1",
            "Milk",
            json!({ "due": null, "rule": null, "reminders": null })
        )]),
        true,
    );
    assert_eq!(out["updated"], 1, "{out}");
    assert_eq!(
        w.one::<String>(
            "SELECT ifnull(due, '-') || ifnull(rule, '-') FROM task WHERE id = ?1",
            &[&id]
        ),
        "--"
    );
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM reminder WHERE entity_id = ?1", &[&id]),
        0
    );
}

#[test]
fn a_reminder_gone_from_a_complete_read_goes_to_the_trash_comes_back_and_an_older_arrival_is_taken_over()
 {
    let w = World::new("remind_follow_gone");
    follow(
        &w,
        json!([rec("r1", "Milk", json!({})), rec("r2", "Eggs", json!({}))]),
        true,
    );
    let eggs = task_of(&w, "r2");
    let out = follow(&w, json!([rec("r1", "Milk", json!({}))]), true);
    assert_eq!(out["trashed"], 1);
    assert!(
        w.one::<Option<String>>("SELECT deleted_at FROM entity WHERE id = ?1", &[&eggs])
            .is_some()
    );
    // Gone and back: the same reminder in a later read restores the same row.
    follow(
        &w,
        json!([rec("r1", "Milk", json!({})), rec("r2", "Eggs", json!({}))]),
        true,
    );
    assert!(
        w.one::<Option<String>>("SELECT deleted_at FROM entity WHERE id = ?1", &[&eggs])
            .is_none()
    );
    // A task with no source at all is matched by title.
    w.ok("task.add", json!({ "title": "Bread" }));
    let out = follow(
        &w,
        json!([
            rec("r1", "Milk", json!({})),
            rec("r2", "Eggs", json!({})),
            rec("r3", "Bread", json!({}))
        ]),
        true,
    );
    assert_eq!(out["matched"], 1, "{out}");
}

#[test]
fn the_phone_alerts_for_what_it_states_and_the_vault_for_what_the_member_changed() {
    let w = World::new("remind_follow_alerts");
    follow(
        &w,
        json!([rec(
            "r1",
            "Call Mum",
            json!({ "due": "2026-03-02T09:00", "reminders": [30] })
        )]),
        true,
    );
    let id = task_of(&w, "r1");
    // One alert per real thing: the phone's Reminders alert for it, so the vault holds the row and says nothing.
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM reminder WHERE entity_id = ?1", &[&id]),
        1
    );
    assert_eq!(
        alerts_of(&w, &id),
        0,
        "what the phone states, the phone alerts"
    );
    // The member adds a lead: now it is Centraid's, all of it.
    w.ok("task.edit", json!({ "id": &id, "reminders": [30, 5] }));
    assert_eq!(alerts_of(&w, &id), 2);
    // The phone's next word on the leads does not undo the member's.
    follow(
        &w,
        json!([rec(
            "r1",
            "Call Mum",
            json!({ "due": "2026-03-02T09:00", "reminders": [30, 60] })
        )]),
        true,
    );
    assert_eq!(
        w.strings("SELECT CAST(offset_min AS TEXT) FROM reminder WHERE entity_id = ?1 ORDER BY offset_min", &[&id]),
        vec!["5", "30"]
    );
    // A reminder with a bad alert is left out and counted.
    let out = follow(
        &w,
        json!([rec(
            "r9",
            "Bad",
            json!({ "due": "2026-03-02", "reminders": ["soon"] })
        )]),
        false,
    );
    assert_eq!(out["refused"], 1, "{out}");
}
