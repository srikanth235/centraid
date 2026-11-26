//! The notification scheduler over a real vault: what it holds, what it masks, what it cancels,
//! what a replayed press does, and how the platform's cap is filled.

mod common;

use std::sync::Arc;

use centraid_api_proto::core_v1 as wire;
use centraid_core::notify::desired::{Extra, Inputs, desired};
use centraid_core::notify::{
    Ledger, MemoryLedger, Ran, Runner, Scheduler, Words, categories, replay,
};
use centraid_core::{Core, CoreConfig, Handle};
use centraid_vault::alerts::Notice;
use centraid_vault::clock::{FixedClock, SeededIds};
use serde_json::{Value, json};

/// 2026-11-26T10:00:00Z
const NOW: i64 = 1_795_687_200_000;
const HOUR: i64 = 3_600_000;
const DAY: i64 = 24 * HOUR;

struct English;

impl centraid_core::device::widget::Words for English {
    fn title(&self) -> String {
        "Today".to_owned()
    }

    fn empty(&self) -> String {
        "Nothing today".to_owned()
    }

    fn counts(&self, events: u64, tasks: u64) -> String {
        format!("{events} events, {tasks} tasks")
    }
}

impl Words for English {
    fn alert(&self, notice: &Notice, _zone: &str) -> (String, String) {
        (notice.title.clone(), notice.at.clone().unwrap_or_default())
    }

    fn private(&self, kind: &str) -> (String, String) {
        (format!("A {kind} is due"), String::new())
    }

    fn locker(&self) -> (String, String) {
        ("An item in Locker expires soon".to_owned(), String::new())
    }

    fn done_label(&self) -> String {
        "Done".to_owned()
    }

    fn snooze_label(&self) -> String {
        "Snooze".to_owned()
    }

    fn channel_name(&self) -> String {
        "Reminders".to_owned()
    }

    fn backup_channel_name(&self) -> String {
        "Backup".to_owned()
    }
}

fn id(n: u64) -> String {
    format!("01900000-0000-7000-8000-{n:012x}")
}

struct World {
    handle: Handle,
    _dir: tempfile::TempDir,
}

impl World {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let clock = Arc::new(FixedClock::at(NOW));
        let handle = Core::open(
            CoreConfig::new(dir.path().join("vault.db"))
                .with_seed(common::seed(), 0)
                .with_clock(clock, Arc::new(SeededIds::new("notify"))),
        )
        .unwrap();
        handle
            .with_vault(|vault| Ok(vault.found("Household", "Ada")?))
            .unwrap();
        Self { handle, _dir: dir }
    }

    fn run(&self, name: &str, input: serde_json::Value) -> serde_json::Value {
        common::command(&self.handle, name, &input, &format!("seed-{name}-{input}"))
    }

    fn event(&self, n: u64, starts: &str) -> String {
        let e = id(n);
        self.run(
            "event.propose",
            json!({ "id": e, "title": "Dentist", "starts": starts, "timing": "zoned", "zone": "UTC" }),
        );
        e
    }

    fn task(&self, n: u64, due: &str) -> String {
        let t = id(n);
        self.run(
            "task.add",
            json!({ "id": t, "title": "Call mum", "due": due, "zone": "UTC" }),
        );
        t
    }

    fn remind(&self, entity: &str, offset: i64) -> String {
        let out = common::command(
            &self.handle,
            "reminder.add",
            &json!({ "entity_id": entity, "offset_min": offset }),
            &format!("remind-{entity}-{offset}"),
        );
        out["id"].as_str().unwrap().to_owned()
    }

    fn again(&self, scheduler: &Scheduler, now: i64) -> Option<wire::ScheduleNotifications> {
        self.handle
            .with_vault(|vault| {
                vault
                    .read(|c| Ok(scheduler.refresh(c, now, &English)))
                    .map_err(Into::into)
            })
            .unwrap()
            .unwrap()
    }

    fn set(&self, scheduler: &Scheduler, now: i64) -> wire::ScheduleNotifications {
        self.again(scheduler, now).expect("the set moved")
    }
}

#[test]
fn an_event_alert_is_held_with_its_buttons_and_its_link() {
    let world = World::new();
    let event = world.event(1, "2026-11-27T15:00:00.000Z");
    world.remind(&event, 60);
    let set = world.set(&Scheduler::new(), NOW);
    assert_eq!(set.all.len(), 1);
    let held = &set.all[0];
    assert_eq!(held.fire_at_ms, NOW + DAY + 4 * HOUR);
    assert_eq!(held.title, "Dentist");
    assert_eq!(held.category_id, "alert.event");
    assert_eq!(held.open_url, format!("centraid://open/event/{event}"));
    assert_eq!(held.entity_id, event);
    assert!(set.retain_delivered);
}

#[test]
fn done_is_on_a_task_alert_only_and_snooze_is_on_every_kind() {
    let cats = categories(&English);
    let verbs = |kind: &str| -> Vec<i32> {
        cats.iter()
            .find(|c| c.category_id == format!("alert.{kind}"))
            .unwrap()
            .actions
            .iter()
            .map(|a| a.verb)
            .collect()
    };
    let (done, snooze) = (
        wire::NotificationVerb::Done as i32,
        wire::NotificationVerb::SnoozeHour as i32,
    );
    assert_eq!(verbs("task"), [done, snooze]);
    for kind in ["event", "person", "locker_item"] {
        assert_eq!(verbs(kind), [snooze], "{kind}");
    }
}

#[test]
fn a_snoozed_birthday_is_held_again_at_its_snooze() {
    let world = World::new();
    let person = id(10);
    world.run("person.add", json!({ "id": person, "title": "Ana" }));
    let date = world.run(
        "person.add_date",
        json!({ "id": person, "date": "--11-27", "kind": "birthday" }),
    )["date_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let reminder = common::command(
        &world.handle,
        "reminder.add",
        &json!({ "entity_id": person, "date_id": date, "offset_min": 0 }),
        "r1",
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let scheduler = Scheduler::new();
    let first = world.set(&scheduler, NOW);
    assert_eq!(first.all.len(), 1);
    assert_eq!(
        first.all[0].fire_at_ms,
        NOW + 23 * HOUR,
        "09:00 the next day"
    );
    assert!(first.all[0].notification_id.contains(&reminder));

    let until = NOW + 2 * DAY + 3 * HOUR;
    common::command(
        &world.handle,
        "alert.snooze",
        &json!({ "entity_id": person, "date_id": date, "until": centraid_vault::clock::format_iso_ms(until) }),
        "s1",
    );
    let second = world.set(&scheduler, NOW);
    assert_eq!(second.all.len(), 1, "one alert per target");
    assert_eq!(second.all[0].fire_at_ms, until);
    assert_ne!(second.all[0].notification_id, first.all[0].notification_id);
    assert!(
        second
            .cancel_delivered_ids
            .contains(&first.all[0].notification_id),
        "the old firing's banner is withdrawn"
    );
}

#[test]
fn a_trashed_event_has_its_pending_and_delivered_entries_cancelled() {
    let world = World::new();
    let event = world.event(2, "2026-11-26T12:00:00.000Z");
    world.remind(&event, 0);
    world.remind(&event, 120);
    let scheduler = Scheduler::new();
    let before = world.set(&scheduler, NOW - 1);
    assert_eq!(before.all.len(), 2, "two leads, two alerts");
    let (early, at_start) = (
        before.all[0].notification_id.clone(),
        before.all[1].notification_id.clone(),
    );

    let fired = world.set(&scheduler, NOW + 1);
    assert!(fired.live_ids.contains(&early), "the 10:00 lead has fired");
    scheduler.scheduled(&wire::NotificationsScheduled {
        permission: wire::NotificationPermission::Granted as i32,
        delivered: vec![wire::DeliveredNotification {
            notification_id: early.clone(),
            source_fingerprint: String::new(),
        }],
        ..wire::NotificationsScheduled::default()
    });

    common::command(
        &world.handle,
        "entity.trash",
        &json!({ "ids": [event] }),
        "t1",
    );
    let after = world.set(&scheduler, NOW + 1);
    assert!(after.all.is_empty(), "the pending alert is gone");
    assert!(!after.live_ids.contains(&early));
    assert!(
        after.cancel_delivered_ids.contains(&early),
        "the delivered banner is removed"
    );
    assert!(
        after.cancel_delivered_ids.contains(&at_start),
        "and the one still pending"
    );
}

#[test]
fn a_locker_expiry_says_only_that_something_expires_and_names_nothing() {
    let world = World::new();
    let item = id(20);
    let added = world.run(
        "locker.add_item",
        json!({
            "item_id": item, "type": "passport", "title": "Passport",
            "fields": [{ "label": "Expiry", "kind": "date", "value": "2026-12-10" }]
        }),
    );
    let first = &added["fields"][0];
    let field = first
        .as_str()
        .map_or_else(|| first["id"].as_str().unwrap().to_owned(), str::to_owned);
    common::command(
        &world.handle,
        "reminder.add",
        &json!({ "entity_id": item, "field_id": field, "offset_min": 0 }),
        "r1",
    );
    let set = world.set(&Scheduler::new(), NOW);
    assert_eq!(set.all.len(), 1);
    let held = &set.all[0];
    assert_eq!(held.title, "An item in Locker expires soon");
    assert!(held.body.is_empty());
    for text in [&held.title, &held.body] {
        assert!(!text.contains("Passport") && !text.contains("Expiry"));
    }
    assert_eq!(held.category_id, "alert.locker_item");
}

#[test]
fn details_off_says_only_that_one_is_due() {
    let world = World::new();
    let event = world.event(3, "2026-11-27T15:00:00.000Z");
    world.remind(&event, 0);
    let scheduler = Scheduler::new();
    scheduler.set_details(false);
    let set = world.set(&scheduler, NOW);
    assert_eq!(set.all[0].title, "A event is due");
}

#[test]
fn the_platform_cap_is_filled_with_the_soonest_and_refilled_as_they_pass() {
    let world = World::new();
    for n in 0..5_i64 {
        let event = world.event(
            u64::try_from(30 + n).unwrap(),
            &centraid_vault::clock::format_iso_ms(NOW + (n + 1) * DAY),
        );
        world.remind(&event, 0);
    }
    let scheduler = Scheduler::new();
    scheduler.launched(&wire::NotifyLaunched {
        pending_cap: 3,
        zone: "UTC".into(),
        locale: "en".into(),
    });
    let first = world.set(&scheduler, NOW);
    let fires: Vec<i64> = first.all.iter().map(|each| each.fire_at_ms).collect();
    assert_eq!(fires, [NOW + DAY, NOW + 2 * DAY, NOW + 3 * DAY]);
    assert!(
        world.again(&scheduler, NOW).is_none(),
        "nothing moved, nothing is said"
    );
    let refilled = world.set(&scheduler, NOW + DAY + 1);
    let fires: Vec<i64> = refilled.all.iter().map(|each| each.fire_at_ms).collect();
    assert_eq!(
        fires,
        [NOW + 2 * DAY, NOW + 3 * DAY, NOW + 4 * DAY],
        "a refresh refills the cap"
    );
}

#[test]
fn the_backups_stale_notice_rides_its_own_channel_and_the_permission_is_asked_once() {
    let world = World::new();
    let event = world.event(40, "2026-11-27T15:00:00.000Z");
    world.remind(&event, 0);
    let scheduler = Scheduler::new();
    scheduler.offer(
        "backup",
        centraid_core::notify::Offer {
            notices: vec![Extra {
                id: "backup|stale|g1".into(),
                backup: true,
                fire_at_ms: NOW + 3 * DAY,
                title: "Your backup is a week old".into(),
                body: "Open Centraid to back up.".into(),
                open_url: String::new(),
            }],
            wanted: vec!["backup|stale|g0".into()],
        },
    );
    scheduler.ask_permission();
    let set = world.set(&scheduler, NOW);
    let stale = set
        .all
        .iter()
        .find(|each| each.notification_id == "backup|stale|g1")
        .unwrap();
    assert_eq!(stale.channel_id, "backup");
    assert_eq!(stale.thread_id, "backup");
    assert!(set.ask_permission, "a set that holds something asks the OS");
    scheduler.scheduled(&wire::NotificationsScheduled {
        permission: wire::NotificationPermission::Granted as i32,
        ..wire::NotificationsScheduled::default()
    });
    world.remind(&event, 5);
    let later = world.set(&scheduler, NOW + 1);
    assert!(!later.ask_permission, "granted: it does not ask again");
}

struct Real<'a>(&'a Handle);

impl Runner for Real<'_> {
    fn run(&self, name: &str, input: &Value, key: &str) -> Result<Ran, String> {
        match self.0.command(name, input, key) {
            Ok(outcome) if outcome.status == centraid_vault::CommandStatus::Executed => {
                Ok(Ran::Done)
            }
            Ok(outcome) => Ok(Ran::Declined(outcome.reason.unwrap_or_default())),
            Err(error) => Err(error.to_string()),
        }
    }
}

fn press(id: &str, verb: wire::NotificationVerb, entity: &str, at_ms: i64) -> wire::NotifyPress {
    wire::NotifyPress {
        id: id.to_owned(),
        verb: verb as i32,
        entity_id: entity.to_owned(),
        date_id: String::new(),
        field_id: String::new(),
        at_ms,
        key: format!("key-{id}"),
    }
}

fn outcomes(results: &[wire::NotifyPressResult]) -> Vec<i32> {
    results.iter().map(|each| each.outcome).collect()
}

#[test]
fn replaying_the_outbox_is_idempotent() {
    use wire::NotifyPressOutcome as O;
    let world = World::new();
    let task = world.task(50, "2026-11-27T09:00:00.000Z");
    let event = world.event(51, "2026-11-28T09:00:00.000Z");
    world.remind(&event, 0);
    let presses = vec![
        press("p1", wire::NotificationVerb::Done, &task, NOW),
        press("p2", wire::NotificationVerb::SnoozeHour, &event, NOW),
    ];
    let ledger = MemoryLedger::default();
    let runner = Real(&world.handle);

    let scheduler = Scheduler::new();
    let before = world.set(&scheduler, NOW);
    assert_eq!(before.all.len(), 2, "the task's alert and the event's");

    let first = replay(&presses, NOW + 1000, &runner, &ledger);
    assert_eq!(outcomes(&first), [O::Applied as i32, O::Applied as i32]);
    let held = world.set(&scheduler, NOW + 1000);
    assert_eq!(held.all.len(), 1, "a done task has no alert left");
    assert_eq!(held.all[0].entity_id, event);
    assert_eq!(
        held.all[0].fire_at_ms,
        NOW + HOUR,
        "the event's alert moved an hour on"
    );

    let second = replay(&presses, NOW + 2000, &runner, &ledger);
    assert_eq!(outcomes(&second), [O::Already as i32, O::Already as i32]);

    let lost = replay(&presses, NOW + 3000, &runner, &MemoryLedger::default());
    assert_eq!(
        outcomes(&lost),
        [O::Applied as i32, O::Applied as i32],
        "a lost ledger runs the commands again under their keys"
    );
    let after = world.again(&scheduler, NOW + 3000);
    assert!(
        after.is_none(),
        "running the presses again under their keys changed nothing: {after:?}"
    );
    assert!(ledger.has("p1"));
}

#[test]
fn a_snooze_pressed_long_ago_has_expired_and_a_press_on_a_missing_item_is_declined() {
    use wire::NotifyPressOutcome as O;
    let world = World::new();
    let runner = Real(&world.handle);
    let ledger = MemoryLedger::default();
    let old = press(
        "p1",
        wire::NotificationVerb::SnoozeHour,
        &id(99),
        NOW - 3 * HOUR,
    );
    let gone = press("p2", wire::NotificationVerb::Done, &id(98), NOW);
    let out = replay(&[old, gone], NOW, &runner, &ledger);
    assert_eq!(out[0].outcome, O::Expired as i32);
    assert_eq!(out[1].outcome, O::Expired as i32);
    assert!(
        !out[1].sentence.is_empty(),
        "the vault's own sentence comes back"
    );
}

#[test]
fn the_desired_function_reads_the_same_set_as_the_scheduler() {
    let world = World::new();
    let event = world.event(60, "2026-11-27T15:00:00.000Z");
    world.remind(&event, 0);
    let direct = world
        .handle
        .with_vault(|vault| {
            vault
                .read(|c| {
                    Ok(desired(
                        c,
                        &Inputs {
                            now_ms: NOW,
                            zone: "UTC",
                            cap: 64,
                            details: true,
                            words: &English,
                            extras: &[],
                        },
                    ))
                })
                .map_err(Into::into)
        })
        .unwrap()
        .unwrap();
    let via = world.set(&Scheduler::new(), NOW);
    assert_eq!(direct.all, via.all);
}

fn widget(world: &World) -> serde_json::Value {
    let store = world.handle.device().unwrap();
    serde_json::from_str(&store.get("widget.today").unwrap().expect("a snapshot")).unwrap()
}

fn refresh_widget(world: &World) -> bool {
    let store = world.handle.device().unwrap();
    world
        .handle
        .with_vault(|vault| {
            vault
                .read(|c| {
                    Ok(centraid_core::device::widget::refresh(
                        c, &store, NOW, "UTC", &English,
                    ))
                })
                .map_err(Into::into)
        })
        .unwrap()
        .unwrap()
}

#[test]
fn the_widget_snapshot_names_todays_items_with_their_links_and_a_trash_clears_it_at_once() {
    let world = World::new();
    let event = world.event(70, "2026-11-26T15:00:00.000Z");
    let task = world.task(71, "2026-11-26T18:00:00.000Z");
    world.event(72, "2026-11-27T09:00:00.000Z");
    assert!(refresh_widget(&world));
    let snapshot = widget(&world);
    assert_eq!(snapshot["v"], 1);
    assert_eq!(snapshot["day"], "2026-11-26");
    assert_eq!(snapshot["summary"], "1 events, 1 tasks");
    let urls: Vec<&str> = snapshot["lines"]
        .as_array()
        .unwrap()
        .iter()
        .map(|line| line["url"].as_str().unwrap())
        .collect();
    assert_eq!(
        urls,
        [
            format!("centraid://open/event/{event}"),
            format!("centraid://open/task/{task}")
        ]
    );
    assert!(
        !refresh_widget(&world),
        "an unchanged snapshot is not written again"
    );

    common::command(
        &world.handle,
        "entity.trash",
        &json!({ "ids": [event] }),
        "t1",
    );
    assert!(refresh_widget(&world));
    let after = widget(&world);
    assert_eq!(after["summary"], "0 events, 1 tasks");
    assert_eq!(
        after["lines"].as_array().unwrap().len(),
        1,
        "the trashed event is gone"
    );
}
