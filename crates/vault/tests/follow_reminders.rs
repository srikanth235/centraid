//! The phone's Reminders, followed (#1185).

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
            scratch: common::Scratch::founded("follow-reminders").expect("a vault"),
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
}

fn follow(w: &World, records: Value, complete: bool) -> Value {
    w.ok(
        "follow.reminders",
        json!({ "origin": { "ref": "list:1", "label": "Groceries" }, "complete": complete, "records": records }),
    )
}

fn rec(id: &str, title: &str, extra: Value) -> Value {
    let mut fields = json!({ "title": title, "status": "open", "done_at": null });
    fields
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    json!({ "external_id": id, "fields": fields })
}

#[test]
fn a_reminder_arrives_edits_stand_and_a_phone_completion_completes_the_task() {
    let w = World::new();
    let out = follow(
        &w,
        json!([rec(
            "r1",
            "Milk",
            json!({ "due": "2026-12-01", "rule": "FREQ=WEEKLY", "remind_before_min": 10 })
        )]),
        true,
    );
    assert_eq!(out["added"], 1);
    let id: String = w.one("SELECT entity_id FROM source WHERE external_id = 'r1'", &[]);
    // The member edits the due day; the phone completes the reminder.
    w.sql("UPDATE task SET due = '2026-12-05' WHERE id = ?1", &[&id]);
    let done = rec(
        "r1",
        "Milk",
        json!({ "due": "2026-12-01", "rule": "FREQ=WEEKLY", "remind_before_min": 10, "status": "done", "done_at": "2026-11-30T10:00:00Z" }),
    );
    let out = follow(&w, json!([done]), true);
    assert_eq!(out["updated"], 1);
    let status: String = w.one("SELECT status FROM task WHERE id = ?1", &[&id]);
    let due: String = w.one("SELECT due FROM task WHERE id = ?1", &[&id]);
    assert_eq!(status, "done");
    assert_eq!(due, "2026-12-05", "the member's own due day stands");
}

#[test]
fn a_reminder_losing_its_due_loses_its_rule_in_one_write() {
    let w = World::new();
    follow(
        &w,
        json!([rec(
            "r1",
            "Milk",
            json!({ "due": "2026-12-01", "rule": "FREQ=WEEKLY" })
        )]),
        true,
    );
    let out = follow(
        &w,
        json!([rec("r1", "Milk", json!({ "due": null, "rule": null }))]),
        true,
    );
    assert_eq!(out["updated"], 1);
}

#[test]
fn a_reminder_gone_from_a_complete_read_goes_to_the_trash_and_an_older_arrival_is_taken_over() {
    let w = World::new();
    follow(
        &w,
        json!([rec("r1", "Milk", json!({})), rec("r2", "Eggs", json!({}))]),
        true,
    );
    let out = follow(&w, json!([rec("r1", "Milk", json!({}))]), true);
    assert_eq!(out["trashed"], 1);
    // A task with no source at all is matched by title.
    w.ok("task.add", json!({ "title": "Bread" }));
    let out = follow(
        &w,
        json!([rec("r1", "Milk", json!({})), rec("r3", "Bread", json!({}))]),
        true,
    );
    assert_eq!(out["matched"], 1);
}
