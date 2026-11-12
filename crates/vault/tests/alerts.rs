//! THE ALERT INDEX (#1188, A5): what an event or a task fires next, kept by the writer.

mod common;

use centraid_vault::alerts::{self, Alert, Timing};
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
            scratch: common::Scratch::founded("alerts").expect("a vault"),
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

    fn rows(&self) -> Vec<Alert> {
        self.scratch
            .vault
            .read(|c| alerts::next(c, "0000", "0000", 1000))
            .expect("rows")
    }

    fn event(&self, extra: Value) -> String {
        let mut input = json!({ "title": "Standup", "timing": "zoned", "zone": "UTC" });
        input
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        self.ok("event.propose", input)["id"]
            .as_str()
            .unwrap()
            .to_owned()
    }
}

#[test]
fn an_event_with_two_lead_times_holds_two_rows_and_a_trash_removes_them() {
    let w = World::new();
    let id = w.event(json!({ "starts": "2026-03-01T10:00:00Z", "reminders": [10, 60] }));
    let rows = w.rows();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].fire_key, "2026-03-01T09:00:00.000Z");
    assert_eq!(rows[1].fire_key, "2026-03-01T09:50:00.000Z");
    assert!(rows.iter().all(|r| !r.repeats && r.timing == Timing::Fixed));
    w.ok("entity.trash", json!({ "id": id }));
    assert!(w.rows().is_empty(), "a trashed event fires nothing");
    w.ok("entity.restore", json!({ "id": id }));
    assert_eq!(w.rows().len(), 2, "a restored event fires again");
}

#[test]
fn an_edit_replaces_the_rows_and_cancelling_or_clearing_removes_them() {
    let w = World::new();
    let id = w.event(json!({ "starts": "2026-03-01T10:00:00Z", "reminders": [10] }));
    w.ok(
        "event.edit",
        json!({ "id": id, "starts": "2026-03-02T10:00:00Z" }),
    );
    assert_eq!(w.rows()[0].fire_key, "2026-03-02T09:50:00.000Z");
    w.ok("event.edit", json!({ "id": id, "status": "cancelled" }));
    assert!(w.rows().is_empty());
    w.ok(
        "event.edit",
        json!({ "id": id, "status": "confirmed", "reminders": null }),
    );
    assert!(w.rows().is_empty());
}

#[test]
fn a_repeating_event_holds_its_next_firing_and_advance_moves_it_on() {
    let w = World::new();
    // The clock is 2026-01-01T00:00Z.
    w.event(json!({
        "starts": "2025-12-30T10:00:00Z", "rule": "FREQ=DAILY", "reminders": [10],
    }));
    let rows = w.rows();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].fire_key, "2026-01-01T09:50:00.000Z");
    assert!(rows[0].repeats);
    w.scratch.clock.advance_days(1);
    assert_eq!(w.scratch.vault.advance_alerts().expect("advance"), 1);
    assert_eq!(w.rows()[0].fire_key, "2026-01-02T09:50:00.000Z");
    assert_eq!(w.scratch.vault.advance_alerts().expect("again"), 0);
}

#[test]
fn a_skipped_day_is_not_the_next_firing() {
    let w = World::new();
    let id = w.event(json!({
        "starts": "2025-12-30T10:00:00Z", "rule": "FREQ=DAILY", "reminders": [10],
    }));
    w.ok(
        "event.edit_occurrence",
        json!({ "id": id, "original_start": "2026-01-01T10:00:00", "scope": "occurrence", "action": "skip" }),
    );
    assert_eq!(w.rows()[0].fire_key, "2026-01-02T09:50:00.000Z");
}

#[test]
fn a_task_with_a_moment_and_a_lead_time_holds_one_row_and_done_removes_it() {
    let w = World::new();
    let id = w.ok(
        "task.add",
        json!({ "title": "Call", "due": "2026-03-01T09:00:00Z", "remind_before_min": 15 }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let rows = w.rows();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].fire_key, "2026-03-01T08:45:00.000Z");
    w.ok("task.complete", json!({ "id": id }));
    assert!(w.rows().is_empty(), "a done task fires nothing");
}

/// NA5: A SNOOZE MOVES THE ALERT, NOT THE DUE. While one is set it is the task's one row; editing
/// the due, the lead or the repeat ends it, and so does finishing the task.
#[test]
fn a_snooze_is_the_tasks_one_row_and_the_due_stays() {
    let w = World::new();
    let id = w.ok(
        "task.add",
        json!({ "title": "Call", "due": "2026-03-01T09:00:00Z", "remind_before_min": 15 }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    w.ok(
        "task.edit",
        json!({ "id": id, "snoozed_until": "2026-03-01T10:00:00.000Z" }),
    );
    let rows = w.rows();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].fire_key, "2026-03-01T10:00:00.000Z");
    let due: String = w
        .scratch
        .vault
        .read(|c| Ok(c.query_row("SELECT due FROM task WHERE id = ?1", [&id], |r| r.get(0))?))
        .expect("due");
    assert_eq!(due, "2026-03-01T09:00:00Z", "the due is never moved");
    // Ending it by hand puts the reminder back.
    w.ok("task.edit", json!({ "id": id, "snoozed_until": null }));
    assert_eq!(w.rows()[0].fire_key, "2026-03-01T08:45:00.000Z");
    // A new due ends a snooze set against the old one.
    w.ok(
        "task.edit",
        json!({ "id": id, "snoozed_until": "2026-03-01T10:00:00.000Z" }),
    );
    w.ok(
        "task.edit",
        json!({ "id": id, "due": "2026-03-02T09:00:00Z" }),
    );
    assert_eq!(w.rows()[0].fire_key, "2026-03-02T08:45:00.000Z");
    // Finishing it clears the snooze, so a reopened task does not wake again at the old moment.
    w.ok(
        "task.edit",
        json!({ "id": id, "snoozed_until": "2026-03-02T10:00:00.000Z" }),
    );
    w.ok("task.complete", json!({ "id": id }));
    let kept: Option<String> = w
        .scratch
        .vault
        .read(|c| {
            Ok(
                c.query_row("SELECT snoozed_until FROM task WHERE id = ?1", [&id], |r| {
                    r.get(0)
                })?,
            )
        })
        .expect("snooze");
    assert_eq!(kept, None);
}

#[test]
fn a_wall_clock_task_floats() {
    let w = World::new();
    w.ok(
        "task.add",
        json!({ "title": "Walk", "due": "2026-03-01T09:00", "remind_before_min": 0 }),
    );
    let rows = w.rows();
    assert_eq!(rows[0].timing, Timing::Floating);
    assert_eq!(rows[0].fire_key, "2026-03-01T09:00");
}

/// A DAY HAS NO MOMENT (#1188, NA6): a date-only task and an all-day event sound at 09:00 that day,
/// a floating key, and neither item gains a time.
#[test]
fn a_day_with_no_time_holds_a_floating_nine_oclock_row_and_the_item_gains_no_time() {
    let w = World::new();
    let id = w.ok(
        "task.add",
        json!({ "title": "Tax", "due": "2026-03-01", "remind_before_min": 30 }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let rows = w.rows();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].timing, Timing::Floating);
    assert_eq!(
        rows[0].fire_key, "2026-03-01T09:00",
        "the lead means nothing"
    );
    let due: String = w
        .scratch
        .vault
        .read(|c| Ok(c.query_row("SELECT due FROM task WHERE id = ?1", [&id], |r| r.get(0))?))
        .expect("due");
    assert_eq!(due, "2026-03-01", "the vault never gains a time");
    w.ok(
        "event.propose",
        json!({ "title": "Holiday", "timing": "all-day", "starts": "2026-03-02",
                "ends": "2026-03-03", "reminders": [10, 60] }),
    );
    let rows = w.rows();
    assert_eq!(rows.len(), 2, "one row for the event, whatever its leads");
    assert_eq!(rows[1].fire_key, "2026-03-02T09:00");
}

#[test]
fn the_next_few_are_one_bounded_read_whatever_the_vault_holds() {
    let w = World::new();
    for day in 1..=60 {
        w.event(json!({
            "starts": format!("2026-02-{:02}T10:00:00Z", (day % 27) + 1),
            "reminders": [5],
        }));
    }
    let next = w
        .scratch
        .vault
        .read(|c| alerts::next(c, "2026-02-10", "2026-02-10", 5))
        .expect("rows");
    assert_eq!(next.len(), 5);
    assert!(
        next.windows(2)
            .all(|pair| pair[0].fire_key <= pair[1].fire_key)
    );
}

/// NA2: ONE ALERT PER REAL THING. A reminder the phone's own app holds is alerted by that app, so
/// Centraid holds no alert for it, whether the follow is on or was stopped.
#[test]
fn a_followed_phone_reminder_holds_no_alert_and_stopping_the_follow_changes_nothing() {
    let w = World::new();
    w.ok(
        "follow.reminders",
        json!({ "origin": { "ref": "list:1", "label": "Groceries" }, "complete": true,
                "records": [{ "external_id": "r1", "fields": {
                    "title": "Milk", "status": "open", "done_at": null,
                    "due": "2026-03-01T09:00:00Z", "remind_before_min": 10 } }] }),
    );
    assert!(w.rows().is_empty(), "the phone alerts for it already");
    w.ok(
        "task.add",
        json!({ "title": "Mine", "due": "2026-03-01T09:00:00Z", "remind_before_min": 10 }),
    );
    assert_eq!(w.rows().len(), 1, "an item Centraid owns still alerts");
    w.ok(
        "follow.stop",
        json!({ "system": "phone_reminders", "ref": "list:1" }),
    );
    // Touch the followed task again: the retired origin's items stay silent.
    let id: String = w
        .scratch
        .vault
        .read(|c| {
            Ok(c.query_row(
                "SELECT entity_id FROM source WHERE external_id = 'r1'",
                [],
                |r| r.get(0),
            )?)
        })
        .expect("the task");
    // Stopping the follow changes nothing: the alert is still the phone's own.
    w.ok("task.edit", json!({ "id": id, "title": "Milk and eggs" }));
    assert_eq!(
        w.rows().len(),
        1,
        "a retired origin's untouched alert stays silent"
    );
    // THE MEMBER CHANGED THE ALERT: it is Centraid's own now, and it fires.
    w.ok("task.edit", json!({ "id": id, "remind_before_min": 5 }));
    assert_eq!(w.rows().len(), 2, "an alert the member set notifies");
    w.ok("task.edit", json!({ "id": id, "remind_before_min": 10 }));
    assert_eq!(
        w.rows().len(),
        1,
        "put back to what the phone stated, it is silent again"
    );
}

/// A CHANGED DUE IS CENTRAID'S (#1188): the phone would sound at the old moment and nothing at the new
/// one, so a moved due notifies, and is silent again once it agrees with the source.
#[test]
fn a_followed_reminder_whose_due_moved_is_centraids_until_it_agrees_again() {
    let w = World::new();
    w.ok(
        "follow.reminders",
        json!({ "origin": { "ref": "list:1", "label": "Groceries" }, "complete": true,
                "records": [{ "external_id": "r1", "fields": {
                    "title": "Milk", "status": "open", "done_at": null,
                    "due": "2026-03-01T09:00:00Z", "remind_before_min": 10 } }] }),
    );
    assert!(w.rows().is_empty());
    let id: String = w
        .scratch
        .vault
        .read(|c| {
            Ok(c.query_row(
                "SELECT entity_id FROM source WHERE external_id = 'r1'",
                [],
                |r| r.get(0),
            )?)
        })
        .expect("the task");
    w.ok(
        "task.edit",
        json!({ "id": id, "due": "2026-03-02T09:00:00Z" }),
    );
    assert_eq!(w.rows().len(), 1, "a moved due fires");
    w.ok(
        "task.edit",
        json!({ "id": id, "due": "2026-03-01T09:00:00Z" }),
    );
    assert!(w.rows().is_empty(), "moved back, it is silent again");
}

/// An event from the phone's calendar: silent while its reminders are what the phone stated, and
/// Centraid's own the moment the member changes them.
#[test]
fn a_followed_calendar_event_is_silent_until_the_member_changes_its_alert() {
    let w = World::new();
    w.ok(
        "follow.calendar",
        json!({ "origin": { "ref": "calendar:work", "label": "Work", "device_id": "phone-1" },
                "complete": true, "records": [{ "external_id": "uid:1", "device_id": "phone-1",
                  "fields": { "title": "Sync", "starts": "2026-03-02T09:00", "ends": "2026-03-02T10:00",
                              "timing": "floating", "rule": null, "busy": 1,
                              "reminders": [10] } }] }),
    );
    assert!(w.rows().is_empty(), "the phone alerts for it");
    let id: String = w
        .scratch
        .vault
        .read(|c| {
            Ok(c.query_row(
                "SELECT entity_id FROM source WHERE external_id = 'uid:1'",
                [],
                |r| r.get(0),
            )?)
        })
        .expect("the event");
    w.ok("event.edit", json!({ "id": id, "reminders": [10, 60] }));
    assert_eq!(w.rows().len(), 2, "an alert the member added notifies");
}

/// A LONG EVENT KEEPS ITS BANNER: a row outlives its firing while the event is running, and goes
/// when it has ended.
#[test]
fn an_event_that_is_still_running_keeps_its_row_past_the_keep_window() {
    let w = World::new();
    // Fires 2026-01-01T09:50Z; runs for ten days.
    w.event(json!({
        "starts": "2026-01-01T10:00:00Z", "ends": "2026-01-11T10:00:00Z", "reminders": [10],
    }));
    w.scratch.clock.advance_days(5);
    w.scratch.vault.advance_alerts().expect("advance");
    assert_eq!(w.rows().len(), 1, "still running on day five");
    w.scratch.clock.advance_days(6);
    w.scratch.vault.advance_alerts().expect("advance");
    assert!(w.rows().is_empty(), "over: the row goes");
}

/// A RESTORED VAULT IS THE FILE: the rows come back with it, and they are what a rebuild from the
/// items would write.
#[test]
fn the_rows_equal_a_rebuild_from_the_items() {
    let w = World::new();
    w.event(json!({ "starts": "2026-03-01T10:00:00Z", "reminders": [10, 60] }));
    w.event(json!({
        "starts": "2025-12-30T10:00:00Z", "rule": "FREQ=DAILY", "reminders": [10],
    }));
    w.ok(
        "task.add",
        json!({ "title": "Call", "due": "2026-03-01T09:00:00Z", "remind_before_min": 15 }),
    );
    w.ok(
        "task.add",
        json!({ "title": "Walk", "due": "2026-03-01T09:00", "remind_before_min": 0 }),
    );
    let before = w.rows();
    assert_eq!(before.len(), 5);
    let ids: std::collections::BTreeSet<String> = w
        .scratch
        .vault
        .read(|c| {
            Ok(c.prepare("SELECT id FROM entity")?
                .query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?)
        })
        .expect("ids");
    w.scratch
        .vault
        .commit(|tx| {
            tx.connection().execute("DELETE FROM alert", [])?;
            alerts::refresh(
                tx.connection(),
                &ids,
                alerts::now_ms("2026-01-01T00:00:00.000Z"),
            )?;
            Ok(())
        })
        .expect("rebuild");
    assert_eq!(w.rows(), before);
}

/// A FIRED TASK REMINDER'S ROW STAYS UNTIL THE TASK IS RESOLVED, however long ago it fired.
#[test]
fn a_fired_task_reminders_row_stays_until_the_task_is_resolved() {
    let w = World::new();
    let id = w.ok(
        "task.add",
        json!({ "title": "Call", "due": "2026-01-01T09:00:00Z", "remind_before_min": 0 }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    w.scratch.clock.advance_days(30);
    w.scratch.vault.advance_alerts().expect("advance");
    assert_eq!(w.rows().len(), 1, "still open after a month");
    w.ok("task.complete", json!({ "id": id }));
    assert!(w.rows().is_empty());
}

#[test]
fn a_repeating_all_day_event_sounds_each_day_at_nine_and_a_skipped_day_is_passed_over() {
    let w = World::new();
    let id = w.ok(
        "event.propose",
        json!({ "title": "Bins", "timing": "all-day", "starts": "2025-12-30", "ends": "2025-12-31",
                "rule": "FREQ=DAILY", "reminders": [0] }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    // The clock is 2026-01-01T00:00Z; today's 09:00 is still ahead.
    assert_eq!(w.rows()[0].fire_key, "2026-01-01T09:00");
    w.ok(
        "event.edit_occurrence",
        json!({ "id": id, "original_start": "2026-01-01", "scope": "occurrence", "action": "skip" }),
    );
    assert_eq!(w.rows()[0].fire_key, "2026-01-02T09:00");
}
