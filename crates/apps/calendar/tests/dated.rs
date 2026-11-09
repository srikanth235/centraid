//! WHAT CALENDAR READS OF A REMINDER (rounds 10 and 12 of #1173): a title, a due day and time, its
//! state and whether it repeats, in the zone the device states; every occurrence of a repeating one;
//! the overdue ones when asked; and nothing else of the task. Against a vault the product founds.

use centraid_apps_calendar::{DatedReminder, load_dated_reminders};
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

fn read_window(
    world: &World,
    from: &str,
    to: &str,
    overdue_before: &str,
    zone: &FireZone,
) -> Vec<DatedReminder> {
    world
        .vault
        .read(|connection| {
            let door = TestDoor::new(connection);
            let (rows, denial) =
                load_dated_reminders(&door, from, to, overdue_before, zone).expect("reads");
            assert!(denial.is_none());
            Ok(rows)
        })
        .expect("a read")
}

#[test]
fn a_day_shows_the_open_and_the_ticked_reminders_due_on_it_in_the_devices_zone() {
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
    let kolkata = FireZone::named("Asia/Kolkata").expect("a zone");
    let utc = FireZone::named("Etc/UTC").expect("a zone");

    let tenth = read_window(&world, "2026-03-10", "2026-03-10", "", &utc);
    let titles: Vec<&str> = tenth.iter().map(|row| row.title.as_str()).collect();
    assert_eq!(titles, ["Done", "File the taxes", "Call Mum"], "{tenth:?}");
    assert_eq!(tenth[1].task_id, dated);
    assert_eq!(tenth[1].due_time, "");
    assert_eq!(tenth[2].due_time, "23:30");
    assert!(tenth[0].done, "a ticked reminder stays on its day, ticked");
    assert!(!tenth[1].done && !tenth[1].repeats && !tenth[1].projected && !tenth[1].overdue);

    let week = read_window(&world, "2026-03-09", "2026-03-15", "", &kolkata);
    let call = week
        .iter()
        .find(|row| row.task_id == late)
        .expect("on the week");
    assert_eq!(
        (call.due_day.as_str(), call.due_time.as_str()),
        ("2026-03-11", "05:00")
    );
    assert_eq!(week.len(), 3, "no undated reminder: {week:?}");
}

#[test]
fn every_occurrence_of_a_repeating_reminder_is_on_its_day() {
    let world = World::new();
    let water = world.id(
        "task.add",
        json!({ "title": "Water", "due": "2026-03-10", "rule": "FREQ=DAILY" }),
    );
    let utc = FireZone::named("Etc/UTC").expect("a zone");
    let week = read_window(&world, "2026-03-09", "2026-03-15", "", &utc);
    let days: Vec<&str> = week.iter().map(|row| row.due_day.as_str()).collect();
    assert_eq!(
        days,
        [
            "2026-03-10",
            "2026-03-11",
            "2026-03-12",
            "2026-03-13",
            "2026-03-14",
            "2026-03-15"
        ],
        "{week:?}"
    );
    assert!(week.iter().all(|row| row.task_id == water && row.repeats));
    // The series' open row is the first; the rest are the rule's, with no row of their own to tick.
    assert!(!week[0].projected);
    assert!(week[1..].iter().all(|row| row.projected));
    // A window after the open row still names the series' days.
    let later = read_window(&world, "2026-04-01", "2026-04-02", "", &utc);
    assert_eq!(later.len(), 2, "{later:?}");
    assert!(later.iter().all(|row| row.projected));
}

#[test]
fn a_timed_weekly_reminder_names_each_week_at_its_time() {
    let world = World::new();
    world.id(
        "task.add",
        json!({ "title": "Bins", "due": "2026-03-09T08:30:00.000Z", "rule": "FREQ=WEEKLY" }),
    );
    let utc = FireZone::named("Etc/UTC").expect("a zone");
    let month = read_window(&world, "2026-03-01", "2026-03-31", "", &utc);
    let days: Vec<(&str, &str)> = month
        .iter()
        .map(|row| (row.due_day.as_str(), row.due_time.as_str()))
        .collect();
    assert_eq!(
        days,
        [
            ("2026-03-09", "08:30"),
            ("2026-03-16", "08:30"),
            ("2026-03-23", "08:30"),
            ("2026-03-30", "08:30")
        ],
        "{month:?}"
    );
}

#[test]
fn the_overdue_ones_come_only_when_asked_and_oldest_first() {
    let world = World::new();
    world.id("task.add", json!({ "title": "Older", "due": "2026-03-01" }));
    world.id("task.add", json!({ "title": "Old", "due": "2026-03-08" }));
    world.id("task.add", json!({ "title": "Today", "due": "2026-03-10" }));
    let done = world.id("task.add", json!({ "title": "Done", "due": "2026-03-02" }));
    world.id("task.complete", json!({ "id": done }));
    let utc = FireZone::named("Etc/UTC").expect("a zone");

    let plain = read_window(&world, "2026-03-10", "2026-03-10", "", &utc);
    assert_eq!(plain.len(), 1, "{plain:?}");
    let asked = read_window(&world, "2026-03-10", "2026-03-10", "2026-03-10", &utc);
    let titles: Vec<(&str, bool)> = asked
        .iter()
        .map(|row| (row.title.as_str(), row.overdue))
        .collect();
    assert_eq!(
        titles,
        [("Today", false), ("Older", true), ("Old", true)],
        "overdue ones are open, due before the day, and never today's own: {asked:?}"
    );
}

#[test]
fn a_window_that_does_not_parse_answers_nothing() {
    let world = World::new();
    world.id("task.add", json!({ "title": "x", "due": "2026-03-10" }));
    let utc = FireZone::named("Etc/UTC").expect("a zone");
    assert!(read_window(&world, "soon", "later", "", &utc).is_empty());
}
