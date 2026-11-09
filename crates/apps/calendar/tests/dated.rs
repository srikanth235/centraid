//! WHAT CALENDAR READS OF A REMINDER (round 10 of #1173): a title, a due day and time, read-only, in
//! the zone the device states; open and one-off only; and nothing else of the task. Against a vault
//! the product founds.

use centraid_apps_calendar::load_dated_reminders;
use centraid_apps_kit::testdoor::TestDoor;
use centraid_vault::commands::Registry;
use centraid_vault::time::zone::FireZone;
use centraid_vault::{Command, CommandStatus, Principal, Vault};
use serde_json::{Value, json};

struct World {
    dir: std::path::PathBuf,
    vault: Vault,
    registry: Registry,
}

impl Drop for World {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl World {
    fn new() -> Self {
        let dir = centraid_ontology::scratch::scratch_dir();
        std::fs::create_dir_all(&dir).expect("a scratch directory");
        let vault = Vault::create(dir.join("vault.db")).expect("a vault");
        vault.found("Home", "Owner").expect("founded");
        Self {
            dir,
            vault,
            registry: Registry::with_system_commands().expect("a registry"),
        }
    }

    fn id(&self, name: &str, input: Value) -> String {
        let outcome = self
            .vault
            .execute(
                &self.registry,
                &Principal::owner("phone"),
                &Command::new(name, input),
            )
            .expect("runs");
        assert_eq!(
            outcome.status,
            CommandStatus::Executed,
            "{name}: {:?}",
            outcome.reason
        );
        outcome.output["id"].as_str().expect("an id").to_owned()
    }
}

#[test]
fn a_day_shows_the_open_one_off_reminders_due_on_it_in_the_devices_zone() {
    let world = World::new();
    let dated = world.id(
        "task.add",
        json!({ "title": "File the taxes", "due": "2026-03-10" }),
    );
    // An instant is the day it falls on in the REQUEST zone: 23:30Z on the 10th is the 11th in Kolkata.
    let late = world.id(
        "task.add",
        json!({ "title": "Call Mum", "due": "2026-03-10T23:30:00.000Z" }),
    );
    let _undated = world.id("task.add", json!({ "title": "Someday" }));
    let done = world.id("task.add", json!({ "title": "Done", "due": "2026-03-10" }));
    world.id("task.complete", json!({ "id": done }));
    let _repeating = world.id(
        "task.add",
        json!({ "title": "Water", "due": "2026-03-10", "rule": "FREQ=DAILY" }),
    );
    let kolkata = FireZone::named("Asia/Kolkata").expect("a zone");
    let utc = FireZone::named("Etc/UTC").expect("a zone");
    world
        .vault
        .read(|connection| {
            let door = TestDoor::new(connection);
            let (tenth, denial) =
                load_dated_reminders(&door, "2026-03-10", "2026-03-10", &utc).expect("reads");
            assert!(denial.is_none());
            let titles: Vec<&str> = tenth.iter().map(|row| row.title.as_str()).collect();
            assert_eq!(titles, ["File the taxes", "Call Mum"], "{tenth:?}");
            assert_eq!(tenth[0].task_id, dated);
            assert_eq!(tenth[0].due_time, "");
            assert_eq!(tenth[1].due_time, "23:30");

            let (week, _) =
                load_dated_reminders(&door, "2026-03-09", "2026-03-15", &kolkata).expect("reads");
            let call = week
                .iter()
                .find(|row| row.task_id == late)
                .expect("on the week");
            assert_eq!(
                (call.due_day.as_str(), call.due_time.as_str()),
                ("2026-03-11", "05:00")
            );
            assert_eq!(
                week.len(),
                2,
                "no undated, completed or repeating reminder: {week:?}"
            );
            Ok(())
        })
        .expect("a read");
}

#[test]
fn a_window_that_does_not_parse_answers_nothing() {
    let world = World::new();
    world.id("task.add", json!({ "title": "x", "due": "2026-03-10" }));
    let utc = FireZone::named("Etc/UTC").expect("a zone");
    world
        .vault
        .read(|connection| {
            let (rows, _) = load_dated_reminders(&TestDoor::new(connection), "soon", "later", &utc)
                .expect("reads");
            assert!(rows.is_empty());
            Ok(())
        })
        .expect("a read");
}
