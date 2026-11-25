//! Whole-number workout measures (`moving_s`, `heart_bpm`) on log and edit: absent keeps, null
//! clears. (Reading an integer-valued float is held by a unit test in `commands/workout.rs`.)

mod common;

use centraid_vault::access::Principal;
use centraid_vault::commands::{Command, CommandStatus, Registry};
use serde_json::{Value, json};

fn run(scratch: &common::Scratch, registry: &Registry, name: &str, input: Value) -> Value {
    let outcome = scratch
        .vault
        .execute(
            registry,
            &Principal::owner("device-1"),
            &Command::new(name, input),
        )
        .expect("runs");
    assert_eq!(
        outcome.status,
        CommandStatus::Executed,
        "{name}: {:?}",
        outcome.reason
    );
    outcome.output
}

fn measures(scratch: &common::Scratch, id: &str) -> (Option<i64>, Option<i64>) {
    scratch
        .vault
        .read(|c| {
            Ok(c.query_row(
                "SELECT moving_s, heart_bpm FROM workout WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?)
        })
        .expect("a row")
}

#[test]
fn whole_measures_take_integer_valued_floats_on_log_and_edit() {
    let scratch = common::Scratch::founded("workout-whole").expect("a vault");
    let registry = Registry::with_system_commands().expect("a registry");
    for (moving, heart) in [(json!(1800), json!(142)), (json!(1800.0), json!(142.0))] {
        let id = run(
            &scratch,
            &registry,
            "workout.log",
            json!({ "type": "run", "starts": "2026-03-04", "moving_s": moving, "heart_bpm": heart }),
        )["workout_id"]
            .as_str()
            .expect("an id")
            .to_owned();
        assert_eq!(measures(&scratch, &id), (Some(1800), Some(142)));
        run(
            &scratch,
            &registry,
            "workout.edit",
            json!({ "id": id, "moving_s": 1900, "heart_bpm": 150 }),
        );
        assert_eq!(measures(&scratch, &id), (Some(1900), Some(150)));
        // absent keeps, null clears
        run(
            &scratch,
            &registry,
            "workout.edit",
            json!({ "id": id, "heart_bpm": null }),
        );
        assert_eq!(measures(&scratch, &id), (Some(1900), None));
    }
}
