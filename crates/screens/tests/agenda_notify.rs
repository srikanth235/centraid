//! THE NOTIFICATION SERVICE (`agenda.notify`), end to end through the door a
//! shell uses: a reminder appears in the set the phone is told to hold, a
//! pressed button writes through the one door and leaves a receipt with Undo,
//! and a deleted task leaves the set.

mod reminders_support;

#[allow(clippy::duplicate_mod)]
#[path = "schedule_routes/mod.rs"]
mod routes;
use centraid_api_proto::core_v1 as wire;
use centraid_screens::agenda;
use centraid_screens::catalog::act;
use centraid_screens::field::Field;
use centraid_screens::testing::Driver;
use reminders_support::*;
use wire::NotificationVerb as Verb;
use wire::screen_event::Kind as E;

fn rig() -> (Driver, u64) {
    let runtime = centraid_screens::Runtime::new(
        agenda::registry(),
        vec![(
            agenda::TAB.to_owned(),
            routes::home(wire::AgendaDestination::Day, ""),
        )],
    )
    .with_services(agenda::notify::services());
    let mut d = Driver::with_runtime(runtime);
    d.start();
    let service = d
        .effects
        .iter()
        .find(|request| {
            matches!(
                request.effect.as_ref().and_then(|e| e.kind.as_ref()),
                Some(wire::effect::Kind::ScheduleNotifications(_))
            )
        })
        .map(|request| request.instance)
        .expect("the service spoke when it appeared");
    (d, service)
}

/// The latest set the service asked the shell to hold, after `d.effects` was
/// last cleared.
fn latest(d: &Driver) -> wire::ScheduleNotifications {
    d.effects
        .iter()
        .rev()
        .find_map(|request| match request.effect.as_ref()?.kind.as_ref()? {
            wire::effect::Kind::ScheduleNotifications(set) => Some(set.clone()),
            _ => None,
        })
        .expect("the service spoke")
}

fn changed(d: &mut Driver, service: u64) {
    d.effects.clear();
    d.send(
        service,
        E::DataChanged(wire::DataChanged { tables: vec![] }),
    );
}

fn pressed(d: &mut Driver, service: u64, id: &str, verb: Verb) {
    pressed_as(d, service, id, verb, "");
}

/// A press that carries the id the shell's outbox gave it (#1188, A6).
fn pressed_as(d: &mut Driver, service: u64, id: &str, verb: Verb, press_id: &str) {
    d.effects.clear();
    d.send(
        service,
        E::ShellFact(wire::ShellFact {
            fact: Some(wire::shell_fact::Fact::NotificationAnswered(
                wire::NotificationAnswered {
                    notification_id: id.to_owned(),
                    verb: verb as i32,
                    press_id: press_id.to_owned(),
                },
            )),
        }),
    );
}

fn has(set: &wire::ScheduleNotifications, id: &str) -> bool {
    set.all.iter().any(|n| n.notification_id == id)
}

#[test]
fn a_reminder_is_held_done_from_its_button_undone_and_deleted() {
    let (mut d, service) = rig();
    clear_tasks(&d);
    let tomorrow = day(&d, 1);
    let id = add(
        &d,
        act::reminders::AddTask {
            title: "Call the dentist".to_owned(),
            due: Field::Is(format!("{tomorrow}T09:00")),
            remind_before_min: Field::Is(0),
            ..Default::default()
        },
    );
    changed(&mut d, service);
    let set = latest(&d);
    let reminder = format!("task||{id}|{tomorrow}T09:00");
    assert!(has(&set, &reminder), "{:?}", set.all);
    assert!(set.ask_permission);
    assert_eq!(set.categories.len(), 3);
    assert_eq!(set.all.len(), 1);
    assert_eq!(set.all[0].title, "Call the dentist");
    assert_eq!(set.all[0].category_id, "task");

    // The button: the task is done, and the receipt carries Undo.
    pressed(&mut d, service, &reminder, Verb::Done);
    assert_eq!(task_of_status(&d, &id), "done");
    let set = latest(&d);
    assert!(!has(&set, &reminder));
    assert_eq!(set.all.len(), 1);
    let receipt = &set.all[0];
    assert!(receipt.immediate);
    assert_eq!(receipt.category_id, "receipt");
    assert_eq!(receipt.title, "Task done");
    assert_eq!(receipt.body, "Call the dentist");
    assert!(!set.ask_permission);
    let receipt_id = receipt.notification_id.clone();

    // Undo: the task is open again and the reminder is back, the receipt gone.
    pressed(&mut d, service, &receipt_id, Verb::Undo);
    assert_eq!(task_of_status(&d, &id), "open");
    let set = latest(&d);
    assert!(has(&set, &reminder));
    assert!(set.all.iter().all(|n| !n.immediate));

    // A deleted task leaves the set.
    arrange(
        &d,
        act::reminders::DeleteTask {
            task_id: id.clone(),
        },
    );
    changed(&mut d, service);
    assert!(latest(&d).all.is_empty());
}

#[test]
fn tomorrow_and_snooze_move_a_task_and_undo_puts_it_back() {
    let (mut d, service) = rig();
    clear_tasks(&d);
    let (soon, later) = (day(&d, 1), day(&d, 4));
    let id = add(
        &d,
        act::reminders::AddTask {
            title: "Water plants".to_owned(),
            due: Field::Is(format!("{later}T09:00")),
            remind_before_min: Field::Is(0),
            ..Default::default()
        },
    );
    changed(&mut d, service);
    pressed(
        &mut d,
        service,
        &format!("task||{id}|{later}T09:00"),
        Verb::Tomorrow,
    );
    let set = latest(&d);
    let receipt = set.all.iter().find(|n| n.immediate).expect("a receipt");
    assert_eq!(receipt.title, "Moved to tomorrow");
    assert_eq!(receipt.category_id, "receipt");
    assert!(
        has(&set, &format!("task||{id}|{soon}T09:00")),
        "{:?}",
        set.all
    );
}

fn task_of_status(d: &Driver, id: &str) -> String {
    task_of(d, id).status
}

/// A5: THE SET DOES NOT DEPEND ON THE VAULT'S SIZE. Past the old read's ceiling (2,000 events in
/// the window) the service was refused and kept a stale set; now the alert index names the few
/// items that fire next and the set comes, soonest first, capped.
#[test]
fn a_vault_of_thousands_of_events_still_gets_its_next_forty_eight() {
    use centraid_screens::catalog::act::calendar::{Propose, ProposeTiming};
    let (mut d, service) = rig();
    clear_tasks(&d);
    let first = day(&d, 1);
    for n in 0..2_100_i64 {
        let (hour, minute) = (9 + n / 60 % 12, n % 60);
        arrange(
            &d,
            Propose {
                title: format!("Event {n}"),
                starts: format!("{first}T{hour:02}:{minute:02}:00Z"),
                timing: Some(ProposeTiming::Zoned),
                zone: Field::Is("UTC".to_owned()),
                reminders: Field::Is("[5]".to_owned()),
                busy: Some(false),
                ..Default::default()
            },
        );
    }
    changed(&mut d, service);
    let set = latest(&d);
    assert_eq!(set.all.len(), centraid_screens::agenda::notify::CAP);
    assert!(
        set.all
            .windows(2)
            .all(|pair| pair[0].fire_at_ms <= pair[1].fire_at_ms),
        "soonest first"
    );
}

/// A6: A PRESS THE SHELL SENDS TWICE (its outbox could not tell the core had it) IS APPLIED ONCE,
/// and an Undo needs nothing the core held in memory.
#[test]
fn a_press_sent_twice_is_applied_once_and_undo_works_after_the_receipt_was_forgotten() {
    let (mut d, service) = rig();
    clear_tasks(&d);
    let tomorrow = day(&d, 1);
    let id = add(
        &d,
        act::reminders::AddTask {
            title: "Pay rent".to_owned(),
            due: Field::Is(format!("{tomorrow}T09:00")),
            remind_before_min: Field::Is(0),
            ..Default::default()
        },
    );
    changed(&mut d, service);
    let reminder = format!("task||{id}|{tomorrow}T09:00");
    pressed_as(&mut d, service, &reminder, Verb::Done, "press-1");
    assert_eq!(task_of_status(&d, &id), "done");
    let receipt = latest(&d)
        .all
        .iter()
        .find(|n| n.immediate)
        .expect("a receipt")
        .clone();

    // The same press again, as the outbox does at the next start: nothing new, no second receipt.
    pressed_as(&mut d, service, &reminder, Verb::Done, "press-1");
    assert_eq!(task_of_status(&d, &id), "done");

    // The core forgets the receipt (the app was killed, or the ten minutes passed), and the member
    // presses Undo on the banner still on the screen.
    d.effects.clear();
    d.send(
        service,
        E::TimerFired(wire::TimerFired {
            timer: "receipt".to_owned(),
        }),
    );
    pressed_as(
        &mut d,
        service,
        &receipt.notification_id,
        Verb::Undo,
        "press-2",
    );
    assert_eq!(
        task_of_status(&d, &id),
        "open",
        "Undo needs no memory of the receipt"
    );
}

/// A2: TIME PASSING NEVER REMOVES A DELIVERED REMINDER; ONLY RESOLVING THE ITEM DOES. A reminder that
/// fired yesterday and was not dealt with is not pending, but it is named live until the task is done.
#[test]
fn a_fired_reminder_stays_live_until_its_task_is_resolved() {
    let (mut d, service) = rig();
    clear_tasks(&d);
    let yesterday = day(&d, -1);
    let id = add(
        &d,
        act::reminders::AddTask {
            title: "Take the bins out".to_owned(),
            due: Field::Is(format!("{yesterday}T09:00")),
            remind_before_min: Field::Is(0),
            ..Default::default()
        },
    );
    changed(&mut d, service);
    let fired = format!("task||{id}|{yesterday}T09:00");
    let set = latest(&d);
    assert!(!has(&set, &fired), "a past reminder is not pending");
    assert!(set.live_ids.contains(&fired), "{:?}", set.live_ids);

    // Resolving the task is what takes it off the screen.
    arrange(
        &d,
        act::reminders::CompleteTask {
            task_id: id.clone(),
        },
    );
    changed(&mut d, service);
    assert!(!latest(&d).live_ids.contains(&fired));
}

/// A8: AN EVENT'S ALERT LEAVES THE SET WITH ITS TRASH AND COMES BACK WITH ITS RESTORE.
#[test]
fn an_events_alert_leaves_with_its_trash_and_returns_with_its_restore() {
    use centraid_screens::catalog::act::calendar::{
        Propose, ProposeTiming, RestoreEvent, TrashEvent,
    };
    let (mut d, service) = rig();
    clear_tasks(&d);
    let first = day(&d, 2);
    let id = id_of(&arrange(
        &d,
        Propose {
            title: "Standup".to_owned(),
            starts: format!("{first}T10:00:00Z"),
            timing: Some(ProposeTiming::Zoned),
            zone: Field::Is("UTC".to_owned()),
            reminders: Field::Is("[10]".to_owned()),
            busy: Some(false),
            ..Default::default()
        },
    ));
    changed(&mut d, service);
    assert_eq!(latest(&d).all.len(), 1);
    arrange(
        &d,
        TrashEvent {
            event_id: id.clone(),
        },
    );
    changed(&mut d, service);
    assert!(
        latest(&d).all.is_empty(),
        "a trashed event is gone from the set"
    );
    arrange(&d, RestoreEvent { event_id: id });
    changed(&mut d, service);
    assert_eq!(latest(&d).all.len(), 1, "a restored event alerts again");
}

/// A DELIVERED EVENT ALERT STAYS UNTIL THE EVENT ENDS, however long it runs: a week-long event that
/// began five days ago is still live, and one that ended yesterday is not.
#[test]
fn a_long_events_alert_stays_live_until_it_ends() {
    use centraid_screens::catalog::act::calendar::{Propose, ProposeTiming};
    let (mut d, service) = rig();
    clear_tasks(&d);
    let (began, over, ended) = (day(&d, -5), day(&d, 3), day(&d, -1));
    arrange(
        &d,
        Propose {
            title: "Conference".to_owned(),
            starts: format!("{began}T10:00:00Z"),
            ends: Field::Is(format!("{over}T10:00:00Z")),
            timing: Some(ProposeTiming::Zoned),
            zone: Field::Is("UTC".to_owned()),
            reminders: Field::Is("[10]".to_owned()),
            busy: Some(false),
            ..Default::default()
        },
    );
    arrange(
        &d,
        Propose {
            title: "Workshop".to_owned(),
            starts: format!("{}T10:00:00Z", day(&d, -3)),
            ends: Field::Is(format!("{ended}T10:00:00Z")),
            timing: Some(ProposeTiming::Zoned),
            zone: Field::Is("UTC".to_owned()),
            reminders: Field::Is("[10]".to_owned()),
            busy: Some(false),
            ..Default::default()
        },
    );
    changed(&mut d, service);
    let live = latest(&d).live_ids;
    assert_eq!(live.len(), 1, "{live:?}");
    assert!(live[0].starts_with("event||"), "{live:?}");
}

/// NA1: WHAT THE PHONE SAID ABOUT ALERTS REACHES THE EDITOR. A refusal answered to the service is
/// the sentence under a reminder that would sound, in the kit's one words; an allowed phone says
/// nothing of its own.
#[test]
fn a_refused_grant_is_said_under_the_reminder_that_would_sound() {
    let (mut d, service) = rig();
    clear_tasks(&d);
    let id = add(
        &d,
        act::reminders::AddTask {
            title: "Call".to_owned(),
            due: Field::Is(format!("{}T09:00", day(&d, 2))),
            remind_before_min: Field::Is(10),
            ..Default::default()
        },
    );
    let note = |d: &mut Driver| {
        let i = d.push(agenda::TAB, routes::task(&id));
        let note = detail_data(d.view(i))
            .fields
            .iter()
            .find(|f| f.key == "reminder")
            .map(|f| f.note.clone())
            .expect("the reminder row");
        d.pop(agenda::TAB, i);
        note
    };
    assert_eq!(note(&mut d), "Delivered on your phone.");
    answered(
        &mut d,
        service,
        wire::NotificationsScheduled {
            permission: wire::NotificationPermission::Denied as i32,
            ..Default::default()
        },
    );
    assert_eq!(
        note(&mut d),
        "Notifications are off. Turn them on in Settings."
    );
    answered(
        &mut d,
        service,
        wire::NotificationsScheduled {
            permission: wire::NotificationPermission::Granted as i32,
            exact_denied: true,
            ..Default::default()
        },
    );
    assert_eq!(
        note(&mut d),
        "Alerts may arrive a few minutes late. Allow exact timing in Settings."
    );
}

/// The phone's answer to the service's last `ScheduleNotifications`.
fn answered(d: &mut Driver, service: u64, scheduled: wire::NotificationsScheduled) {
    d.send(
        service,
        E::EffectResult(wire::EffectResult {
            effect_id: 0,
            outcome: Some(wire::effect_result::Outcome::NotificationsScheduled(
                scheduled,
            )),
        }),
    );
}
