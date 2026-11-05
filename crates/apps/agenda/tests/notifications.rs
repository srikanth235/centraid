//! Alerts read real command results, independently of the task board window.
use centraid_apps_agenda::notifications::{Alert, load};
use centraid_apps_kit::testdoor::TestDoor;
use centraid_vault::commands::Registry;
use centraid_vault::time::recurrence::parse_instant_ms;
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
        std::fs::create_dir_all(&dir).expect("scratch");
        let vault = Vault::create(dir.join("vault.db")).expect("vault");
        vault.found("Home", "Owner").expect("founded");
        Self {
            dir,
            vault,
            registry: Registry::with_system_commands().expect("commands"),
        }
    }
    fn run(&self, name: &str, input: Value) -> Value {
        let out = self
            .vault
            .execute(
                &self.registry,
                &Principal::owner("phone"),
                &Command::new(name, input),
            )
            .expect("command");
        assert_eq!(
            out.status,
            CommandStatus::Executed,
            "{name}: {:?}",
            out.reason
        );
        out.output
    }
    fn alerts(&self) -> Vec<Alert> {
        self.alerts_at("2099-06-02T12:00:00Z")
    }
    fn alerts_at(&self, now: &str) -> Vec<Alert> {
        self.vault
            .read(|db| {
                let (alerts, denial) = load(
                    &TestDoor::new(db),
                    now,
                    &FireZone::named("America/New_York").expect("zone"),
                )
                .expect("alerts");
                assert!(denial.is_none());
                Ok(alerts.alerts)
            })
            .expect("read")
    }
}

#[test]
fn notifications_track_due_edits_completion_and_trash() {
    let world = World::new();
    let id = world.run(
        "task.add",
        json!({"title":"Medicine", "due":"2099-06-03T09:00", "remind_before_min":30}),
    )["id"]
        .as_str()
        .expect("id")
        .to_owned();
    let before = world.alerts();
    assert_eq!(before.len(), 1);
    assert_eq!(
        Some(before[0].fire_at_ms),
        parse_instant_ms("2099-06-03T12:30:00Z")
    );
    world.run("task.edit", json!({"id":id, "due":"2099-06-04T10:00"}));
    let edited = world.alerts();
    assert_ne!(edited[0].id, before[0].id);
    assert_eq!(
        Some(edited[0].fire_at_ms),
        parse_instant_ms("2099-06-04T13:30:00Z")
    );
    world.run("task.complete", json!({"id":id}));
    assert!(world.alerts().is_empty());
    let other = world.run(
        "task.add",
        json!({"title":"Delete me", "due":"2099-06-04", "remind_before_min":0}),
    )["id"]
        .as_str()
        .expect("id")
        .to_owned();
    assert_eq!(world.alerts().len(), 1);
    world.run("entity.trash", json!({"id":other}));
    assert!(world.alerts().is_empty());
}

#[test]
fn notifications_expand_series_and_keep_distinct_leads_in_instant_order() {
    let world = World::new();
    world.run("event.propose", json!({"title":"Call", "starts":"2099-06-03T09:00", "ends":"2099-06-03T10:00", "zone":"Europe/Paris", "rule":"FREQ=DAILY;COUNT=3", "reminders":[30,0]}));
    let alerts = world.alerts();
    assert_eq!(alerts.len(), 6);
    assert!(alerts.iter().all(|alert| !alert.task));
    assert!(
        alerts
            .windows(2)
            .all(|pair| pair[0].fire_at_ms < pair[1].fire_at_ms)
    );
    assert_eq!(
        Some(alerts[0].fire_at_ms),
        parse_instant_ms("2099-06-03T06:30:00Z")
    );
    assert_eq!(
        alerts
            .iter()
            .map(|alert| &alert.id)
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        6
    );
}

#[test]
fn notifications_include_an_old_reminder_beyond_the_newest_board_window() {
    let world = World::new();
    let id = world.run(
        "task.add",
        json!({"title":"Still remind me", "due":"2099-06-03T09:00", "remind_before_min":0}),
    )["id"]
        .as_str()
        .expect("id")
        .to_owned();
    for index in 0..505 {
        world.run("task.add", json!({"title":format!("Newer task {index}")}));
    }
    let alerts = world.alerts();
    assert_eq!(alerts.len(), 1);
    assert_eq!(alerts[0].entity_id, id);
}

#[test]
fn notifications_schedule_every_imported_time_alarm_once() {
    let world = World::new();
    world.run("follow.reminders", json!({
        "origin":{"ref":"reminders:list","label":"Work","device_id":"phone"},
        "records":[{"external_id":"uid:task1","fields":{
            "title":"Medicine","due":"2099-06-03T10:00:00","zone":"UTC","priority":2,"status":"open","reminders":[10,30,30,-10]
        }}], "complete":false
    }));
    let alerts = world.alerts();
    assert_eq!(
        alerts.len(),
        3,
        "the primary lead and repeated import entries do not duplicate alerts"
    );
    assert_eq!(
        Some(alerts[0].fire_at_ms),
        parse_instant_ms("2099-06-03T09:30:00Z")
    );
    assert_eq!(
        Some(alerts[1].fire_at_ms),
        parse_instant_ms("2099-06-03T09:50:00Z")
    );
    assert_eq!(
        Some(alerts[2].fire_at_ms),
        parse_instant_ms("2099-06-03T10:10:00Z")
    );
}

#[test]
fn a_repeating_reminder_keeps_its_after_due_alarm_before_advancing_the_plan() {
    let world = World::new();
    world.run("follow.reminders", json!({
        "origin":{"ref":"reminders:daily","label":"Work","device_id":"phone"},
        "records":[{"external_id":"uid:daily","fields":{
            "title":"Check in","due":"2099-06-02T11:55:00","zone":"UTC","rule":"FREQ=DAILY","status":"open","reminders":[-10]
        }}], "complete":false
    }));
    let alerts = world.alerts();
    assert_eq!(alerts.len(), 1);
    assert_eq!(
        Some(alerts[0].fire_at_ms),
        parse_instant_ms("2099-06-02T12:05:00Z")
    );
    let next = world.alerts_at("2099-06-02T12:06:00Z");
    assert_eq!(
        next[0].id, alerts[0].id,
        "the delivered card remains actionable while the next period is scheduled"
    );
    assert!(next[0].fire_at_ms > alerts[0].fire_at_ms);
}

#[test]
fn later_recurrences_keep_their_after_due_alarm_including_the_final_period() {
    let world = World::new();
    world.run("follow.reminders", json!({
        "origin":{"ref":"reminders:after-due","label":"Work","device_id":"phone"},
        "records":[{"external_id":"uid:after-due","fields":{
            "title":"Check in","due":"2099-06-02T11:55:00","zone":"UTC","rule":"FREQ=DAILY;COUNT=2","status":"open","reminders":[-10,-30]
        }}], "complete":false
    }));
    let alerts = world.alerts_at("2099-06-03T12:00:00Z");
    assert_eq!(alerts.len(), 2);
    assert_eq!(
        Some(alerts[0].fire_at_ms),
        parse_instant_ms("2099-06-03T12:05:00Z")
    );
    assert_eq!(
        Some(alerts[1].fire_at_ms),
        parse_instant_ms("2099-06-03T12:25:00Z")
    );
    let later = world.alerts_at("2099-06-03T12:15:00Z");
    assert!(
        later
            .iter()
            .any(|alert| Some(alert.fire_at_ms) == parse_instant_ms("2099-06-03T12:25:00Z")),
        "the second alarm survives the first alarm's delivery"
    );
}

#[test]
fn event_alarm_windows_follow_signed_leads_instead_of_the_calendar_start_window() {
    let world = World::new();
    world.run("event.propose", json!({
        "title":"Prepare two months ahead", "starts":"2099-08-02T12:00:00", "ends":"2099-08-02T13:00:00",
        "zone":"UTC", "rule":"FREQ=DAILY;COUNT=2", "reminders":[86_400]
    }));
    world.run("event.propose", json!({
        "title":"Follow up after nine days", "starts":"2099-05-25T12:00:00", "ends":"2099-05-25T13:00:00",
        "zone":"UTC", "reminders":[-12_960]
    }));
    world.run("event.propose", json!({
        "title":"Still outside the alarm horizon", "starts":"2099-08-02T12:00:00", "ends":"2099-08-02T13:00:00",
        "zone":"UTC", "reminders":[0], "busy":false
    }));
    let alerts = world.alerts();
    assert_eq!(alerts.len(), 3);
    assert_eq!(
        alerts
            .iter()
            .filter(|alert| Some(alert.fire_at_ms) == parse_instant_ms("2099-06-03T12:00:00Z"))
            .count(),
        2,
        "both an old event's after-alarm and a far-future event's before-alarm remain scheduled"
    );
    assert_eq!(
        Some(alerts[2].fire_at_ms),
        parse_instant_ms("2099-06-04T12:00:00Z")
    );
}

#[test]
fn dense_recurring_events_schedule_the_next_sixty_alarms_without_reading_past_periods() {
    for (rule, anchor, expected) in [
        (
            "FREQ=MINUTELY",
            "2099-01-01T00:00:00",
            "2099-06-02T12:01:00Z",
        ),
        ("FREQ=HOURLY", "2099-01-01T00:05:00", "2099-06-02T12:05:00Z"),
    ] {
        let world = World::new();
        world.run(
            "event.propose",
            json!({
                "title":"Regular check", "starts":anchor, "zone":"UTC", "rule":rule, "reminders":[0]
            }),
        );
        let alerts = world.alerts();
        assert_eq!(alerts.len(), 60, "{rule}");
        assert_eq!(
            Some(alerts[0].fire_at_ms),
            parse_instant_ms(expected),
            "{rule}"
        );
        assert!(
            alerts
                .windows(2)
                .all(|pair| pair[0].fire_at_ms < pair[1].fire_at_ms)
        );
    }
}

#[test]
fn a_before_due_repeating_alarm_advances_before_the_due_time_itself_passes() {
    let world = World::new();
    world.run("task.add", json!({
        "title":"Prepare", "due":"2099-06-02T12:05:00", "zone":"UTC", "rule":"FREQ=DAILY", "remind_before_min":30
    }));
    let alerts = world.alerts();
    assert_eq!(alerts.len(), 1);
    assert_eq!(
        Some(alerts[0].fire_at_ms),
        parse_instant_ms("2099-06-03T11:35:00Z")
    );
}

#[test]
fn all_day_recurring_tasks_and_events_keep_todays_nine_oclock_alert() {
    let world = World::new();
    world.run(
        "task.add",
        json!({
            "title":"Medicine", "due":"2099-06-02", "rule":"FREQ=DAILY", "remind_before_min":0
        }),
    );
    world.run("event.propose", json!({
        "title":"Daily note", "starts":"2099-06-02", "timing":"all-day", "rule":"FREQ=DAILY;COUNT=2", "reminders":[0]
    }));
    let alerts = world.alerts();
    assert_eq!(alerts.len(), 3);
    assert_eq!(
        alerts
            .iter()
            .filter(|alert| Some(alert.fire_at_ms) == parse_instant_ms("2099-06-02T13:00:00Z"))
            .count(),
        2
    );
}

#[test]
fn a_dense_series_moved_forward_uses_its_first_real_future_alarm() {
    let world = World::new();
    let event = world.run("event.propose", json!({
        "title":"Shifted checks", "starts":"2099-06-01T00:00:00", "zone":"UTC", "rule":"FREQ=MINUTELY", "reminders":[0]
    }))["id"].as_str().expect("id").to_owned();
    world.run("event.edit_occurrence", json!({
        "id":event, "original_start":"2099-06-01T00:00:00", "scope":"future", "action":"override", "starts":"2099-06-03T00:00:00", "zone":"UTC"
    }));
    let alerts = world.alerts();
    assert_eq!(alerts.len(), 60);
    assert_eq!(
        Some(alerts[0].fire_at_ms),
        parse_instant_ms("2099-06-03T00:00:00Z")
    );
}

#[test]
fn an_old_occurrence_moved_into_the_alarm_window_is_scheduled_once() {
    let world = World::new();
    let event = world.run("event.propose", json!({
        "title":"Moved meeting", "starts":"2099-06-01T09:00:00", "zone":"UTC", "rule":"FREQ=DAILY;COUNT=3", "reminders":[0]
    }))["id"].as_str().expect("id").to_owned();
    world.run("event.edit_occurrence", json!({
        "id":event, "original_start":"2099-06-02T09:00:00", "scope":"occurrence", "action":"override", "starts":"2099-06-02T14:00:00", "zone":"UTC"
    }));
    let alerts = world.alerts();
    assert_eq!(alerts.len(), 2);
    assert_eq!(
        Some(alerts[0].fire_at_ms),
        parse_instant_ms("2099-06-02T14:00:00Z")
    );
    assert_eq!(
        Some(alerts[1].fire_at_ms),
        parse_instant_ms("2099-06-03T09:00:00Z")
    );
}
