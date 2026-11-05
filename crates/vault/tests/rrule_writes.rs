//! Recurrence validity belongs to the final stored task/event image, including
//! edits that change a timed anchor into a date without resending its rule.
mod common;
use centraid_vault::commands::Registry;
use centraid_vault::{Command, CommandOutcome, CommandStatus, Principal};
use serde_json::{Value, json};

#[test]
fn subdaily_rules_require_times_at_every_write_boundary() {
    let scratch = common::Scratch::founded("rrule-writes").unwrap();
    let registry = Registry::with_system_commands().unwrap();
    let run = |name: &str, input: Value| -> CommandOutcome {
        scratch
            .vault
            .execute(
                &registry,
                &Principal::owner("phone"),
                &Command::new(name, input),
            )
            .unwrap()
    };
    for (name, input) in [
        (
            "task.add",
            json!({"title":"Hourly", "due":"2026-11-05", "rule":"FREQ=HOURLY"}),
        ),
        (
            "event.propose",
            json!({"title":"Hourly", "starts":"2026-11-05", "timing":"all-day", "rule":"FREQ=HOURLY"}),
        ),
    ] {
        let refused = run(name, input);
        assert_eq!(refused.status, CommandStatus::Failed);
        assert!(refused.reason.unwrap().contains("needs a start time"));
    }
    let task = run(
        "task.add",
        json!({"title":"Hourly", "due":"2026-11-05T09:00:00Z", "zone":"Etc/UTC", "rule":"FREQ=HOURLY"}),
    );
    assert_eq!(task.status, CommandStatus::Executed, "{:?}", task.reason);
    let task_id = task.output["id"].as_str().unwrap();
    let refused = run("task.edit", json!({"id":task_id, "due":"2026-11-05"}));
    assert_eq!(refused.status, CommandStatus::Failed);
    assert!(refused.reason.unwrap().contains("needs a start time"));
    let event = run(
        "event.propose",
        json!({"title":"Hourly", "starts":"2026-11-05T09:00:00Z", "timing":"zoned", "zone":"Etc/UTC", "rule":"FREQ=HOURLY", "busy":false}),
    );
    assert_eq!(event.status, CommandStatus::Executed, "{:?}", event.reason);
    let event_id = event.output["id"].as_str().unwrap();
    let refused = run(
        "event.edit",
        json!({"id":event_id, "starts":"2026-11-05", "timing":"all-day", "zone":null}),
    );
    assert_eq!(refused.status, CommandStatus::Failed);
    assert!(refused.reason.unwrap().contains("needs a start time"));
    let unchanged = scratch
        .vault
        .read(|db| {
            Ok((
                db.query_row("SELECT due FROM task WHERE id=?1", [task_id], |row| {
                    row.get::<_, String>(0)
                })?,
                db.query_row("SELECT timing FROM event WHERE id=?1", [event_id], |row| {
                    row.get::<_, String>(0)
                })?,
            ))
        })
        .unwrap();
    assert_eq!(
        unchanged,
        ("2026-11-05T09:00:00Z".to_owned(), "zoned".to_owned())
    );
    // Change both the value type and rule together: the final image is valid.
    let changed = run(
        "task.edit",
        json!({"id":task_id, "due":"2026-11-05", "rule":"FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1"}),
    );
    assert_eq!(
        changed.status,
        CommandStatus::Executed,
        "{:?}",
        changed.reason
    );
}
