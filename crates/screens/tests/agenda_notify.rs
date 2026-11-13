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
use centraid_screens::testing::{Driver, FakeShell};
use reminders_support::*;
use wire::NotificationVerb as Verb;
use wire::screen_event::Kind as E;

fn rig() -> (Driver, u64, FakeShell) {
    let runtime = centraid_screens::Runtime::new(
        agenda::registry(),
        vec![(
            agenda::TAB.to_owned(),
            routes::home(wire::AgendaDestination::Day, ""),
        )],
    )
    .with_services(agenda::notify::services());
    let mut d = Driver::with_runtime_clocked(
        runtime,
        std::sync::Arc::new(centraid_vault::clock::FixedClock::frozen()),
    );
    d.start();
    let mut shell = FakeShell::default();
    d.serve(&mut shell);
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
    (d, service, shell)
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

fn pressed(d: &mut Driver, service: u64, shell: &mut FakeShell, id: &str, verb: Verb) {
    pressed_as(d, service, shell, id, verb, "");
}

fn pressed_as(
    d: &mut Driver,
    service: u64,
    shell: &mut FakeShell,
    id: &str,
    verb: Verb,
    press_id: &str,
) {
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
    d.serve(shell);
}

fn has(set: &wire::ScheduleNotifications, id: &str) -> bool {
    set.all.iter().any(|n| n.notification_id == id)
}

#[test]
fn a_reminder_is_held_done_from_its_button_undone_and_deleted() {
    let (mut d, service, mut shell) = rig();
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
    pressed(&mut d, service, &mut shell, &reminder, Verb::Done);
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

    // Returning rechecks platform permission without discarding the action's receipt or Undo.
    d.effects.clear();
    d.call(wire::screen_request::Kind::Lifecycle(wire::AppLifecycle {
        foreground: false,
    }));
    d.call(wire::screen_request::Kind::Lifecycle(wire::AppLifecycle {
        foreground: true,
    }));
    assert_eq!(
        set.completed_answers,
        vec![wire::NotificationAnswered {
            notification_id: reminder.clone(),
            verb: Verb::Done as i32,
            press_id: String::new(),
        }]
    );
    let mut refreshed = latest(&d);
    assert!(
        refreshed.completed_answers.is_empty(),
        "an action completion is emitted once"
    );
    refreshed.completed_answers = set.completed_answers.clone();
    assert_eq!(refreshed, set);

    // Undo: the task is open again and the reminder is back, the receipt gone.
    pressed(&mut d, service, &mut shell, &receipt_id, Verb::Undo);
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
    let (mut d, service, mut shell) = rig();
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
        &mut shell,
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

#[test]
fn foreground_reconciles_unchanged_reminders_after_each_permission_outcome() {
    use wire::NotificationPermission as Permission;
    for permission in [
        Permission::Denied,
        Permission::Granted,
        Permission::NotAsked,
    ] {
        let (mut d, service, _shell) = rig();
        clear_tasks(&d);
        let tomorrow = day(&d, 1);
        add(
            &d,
            act::reminders::AddTask {
                title: "Permission changed in Settings".to_owned(),
                due: Field::Is(format!("{tomorrow}T09:00")),
                remind_before_min: Field::Is(0),
                ..Default::default()
            },
        );
        changed(&mut d, service);
        let wanted = latest(&d);
        assert_eq!(
            wanted.all.len(),
            1,
            "the unchanged set holds a timed reminder"
        );
        assert!(wanted.ask_permission);
        let request = d
            .effects
            .iter()
            .rev()
            .find(|request| {
                matches!(
                    request
                        .effect
                        .as_ref()
                        .and_then(|effect| effect.kind.as_ref()),
                    Some(wire::effect::Kind::ScheduleNotifications(_))
                )
            })
            .expect("the timed reminder asked the platform")
            .clone();
        d.effects.clear();
        d.send(
            service,
            E::EffectResult(wire::EffectResult {
                effect_id: request.effect_id,
                outcome: Some(wire::effect_result::Outcome::NotificationsScheduled(
                    wire::NotificationsScheduled {
                        permission: permission as i32,
                        held: u32::from(permission == Permission::Granted),
                        ..Default::default()
                    },
                )),
            }),
        );
        assert!(d.effects.is_empty(), "a permission answer is quiet");
        changed(&mut d, service);
        assert!(d.effects.is_empty(), "unchanged data still emits nothing");
        d.call(wire::screen_request::Kind::Lifecycle(wire::AppLifecycle {
            foreground: false,
        }));
        d.effects.clear();
        d.call(wire::screen_request::Kind::Lifecycle(wire::AppLifecycle {
            foreground: true,
        }));
        let sets: Vec<_> = d
            .effects
            .iter()
            .filter_map(|request| match request.effect.as_ref()?.kind.as_ref()? {
                wire::effect::Kind::ScheduleNotifications(set) => Some(set),
                _ => None,
            })
            .collect();
        assert_eq!(
            sets.len(),
            1,
            "foreground must recheck the platform after {permission:?}"
        );
        assert_eq!(
            *sets[0], wanted,
            "grant, revocation or promptability can change without a task edit"
        );
        changed(&mut d, service);
        assert!(
            d.effects.is_empty(),
            "reconciliation does not disable set deduplication"
        );
    }
}

#[test]
fn a_receipt_undo_survives_a_notification_service_restart() {
    let runtime = centraid_screens::Runtime::new(
        agenda::registry(),
        vec![(
            agenda::TAB.to_owned(),
            routes::home(wire::AgendaDestination::Day, ""),
        )],
    );
    let d = Driver::with_runtime(runtime);
    clear_tasks(&d);
    let tomorrow = day(&d, 1);
    let id = add(
        &d,
        act::reminders::AddTask {
            title: "Cold notification action".to_owned(),
            due: Field::Is(format!("{tomorrow}T09:00")),
            remind_before_min: Field::Is(0),
            ..Default::default()
        },
    );
    let mut shell = FakeShell::default();
    let mut update =
        |service: &mut dyn centraid_screens::Screen, kind: E| driven(&d, service, &mut shell, kind);
    let mut first = agenda::notify::build(&agenda::notify::route()).expect("the service builds");
    let appeared = update(&mut *first, E::Appeared(Default::default()));
    let reminder = appeared
        .iter()
        .find_map(|effect| match effect.kind.as_ref()? {
            wire::effect::Kind::ScheduleNotifications(set) => {
                set.all.iter().find(|n| n.notification_id.contains(&id))
            }
            _ => None,
        })
        .expect("the timed task is offered to the platform")
        .notification_id
        .clone();
    let completed = update(
        &mut *first,
        E::ShellFact(wire::ShellFact {
            fact: Some(wire::shell_fact::Fact::NotificationAnswered(
                wire::NotificationAnswered {
                    notification_id: reminder,
                    verb: Verb::Done as i32,
                    press_id: String::new(),
                },
            )),
        }),
    );
    assert_eq!(task_of_status(&d, &id), "done");
    let receipt = completed
        .iter()
        .find_map(|effect| match effect.kind.as_ref()? {
            wire::effect::Kind::ScheduleNotifications(set) => set
                .all
                .iter()
                .find(|n| n.immediate && n.body == "Cold notification action"),
            _ => None,
        })
        .expect("the cold action posts a receipt")
        .clone();
    assert_eq!(
        receipt.category_id, "receipt",
        "the posted receipt offers Undo"
    );
    // The Android receiver releases its last AppSession holder after posting. The OS still
    // holds the receipt, but its next button opens a new service over the unchanged vault.
    drop(first);
    let mut reopened =
        agenda::notify::build(&agenda::notify::route()).expect("the service rebuilds");
    update(&mut *reopened, E::Appeared(Default::default()));
    update(
        &mut *reopened,
        E::ShellFact(wire::ShellFact {
            fact: Some(wire::shell_fact::Fact::NotificationAnswered(
                wire::NotificationAnswered {
                    notification_id: receipt.notification_id,
                    verb: Verb::Undo as i32,
                    press_id: String::new(),
                },
            )),
        }),
    );
    assert_eq!(
        task_of_status(&d, &id),
        "open",
        "a posted Undo must retain its inverse after the receiver's session closes"
    );
}

/// A shell acknowledges each secret operation before the service can post a set.
fn driven(
    d: &Driver,
    service: &mut dyn centraid_screens::Screen,
    shell: &mut FakeShell,
    kind: E,
) -> Vec<wire::Effect> {
    let mut pending = d.with_ctx(|ctx| service.update(wire::ScreenEvent { kind: Some(kind) }, ctx));
    let mut output = Vec::new();
    for _ in 0..16 {
        if pending.is_empty() {
            return output;
        }
        let mut next = Vec::new();
        for effect in pending {
            if let Some(wire::effect::Kind::Secrets(batch)) = effect.kind.as_ref() {
                let answer = shell.batch(batch);
                next.extend(d.with_ctx(|ctx| {
                    service.update(
                        wire::ScreenEvent {
                            kind: Some(E::EffectResult(wire::EffectResult {
                                effect_id: 0,
                                outcome: Some(wire::effect_result::Outcome::Secrets(answer)),
                            })),
                        },
                        ctx,
                    )
                }));
            } else {
                output.push(effect);
            }
        }
        pending = next;
    }
    panic!("secret operation count exceeded the receipt protocol bound");
}

#[test]
fn a_snooze_moves_the_alert_and_leaves_the_due() {
    let (mut d, service, mut shell) = rig();
    clear_tasks(&d);
    let later = day(&d, 4);
    let id = add(
        &d,
        act::reminders::AddTask {
            title: "Water plants".to_owned(),
            due: Field::Is(format!("{later}T09:00")),
            remind_before_min: Field::Is(15),
            ..Default::default()
        },
    );
    changed(&mut d, service);
    let original = format!("task||{id}|{later}T08:45");
    assert!(has(&latest(&d), &original), "{:?}", latest(&d).all);
    pressed(&mut d, service, &mut shell, &original, Verb::SnoozeHour);
    let task = task_of(&d, &id);
    let now = d.with_ctx(|ctx| ctx.now_ms().expect("injected vault clock"));
    let alert = latest(&d)
        .all
        .into_iter()
        .find(|n| !n.immediate && n.notification_id.starts_with(&format!("task||{id}|")))
        .expect("snoozed alert");
    assert_eq!(
        alert.fire_at_ms,
        now + 3_600_000,
        "snooze is one elapsed hour"
    );
    assert_eq!(task.due_local, format!("{later}T09:00"), "the due stays");
    assert_eq!(task.remind_before_min, Some(15), "the lead stays");
    let set = latest(&d);
    assert!(!has(&set, &original), "{:?}", set.all);
    assert!(
        set.all
            .iter()
            .any(|n| n.notification_id.starts_with(&format!("task||{id}|")) && !n.immediate),
        "the alert is at the snoozed moment: {:?}",
        set.all
    );
    let receipt = set.all.iter().find(|n| n.immediate).expect("a receipt");
    let receipt_id = receipt.notification_id.clone();
    pressed(&mut d, service, &mut shell, &receipt_id, Verb::Undo);
    assert!(has(&latest(&d), &original), "{:?}", latest(&d).all);
    assert_eq!(task_of(&d, &id).due_local, format!("{later}T09:00"));
}

#[test]
fn a_vault_of_thousands_of_events_still_gets_its_next_forty_eight() {
    use centraid_screens::catalog::act::calendar::{Propose, ProposeTiming};
    let (mut d, service, _shell) = rig();
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
/// and its already persisted live receipt keeps its original Undo/deadline.

#[test]
fn a_press_sent_twice_keeps_the_same_live_receipt_and_undo() {
    let (mut d, service, mut shell) = rig();
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
    pressed_as(
        &mut d,
        service,
        &mut shell,
        &reminder,
        Verb::Done,
        "press-1",
    );
    assert_eq!(task_of_status(&d, &id), "done");
    let receipt = latest(&d)
        .all
        .iter()
        .find(|n| n.immediate)
        .expect("a receipt")
        .clone();

    // The same press again, as the outbox does at the next start: nothing new, no second receipt.
    pressed_as(
        &mut d,
        service,
        &mut shell,
        &reminder,
        Verb::Done,
        "press-1",
    );
    assert_eq!(task_of_status(&d, &id), "done");

    assert_eq!(
        latest(&d)
            .all
            .iter()
            .find(|n| n.immediate)
            .expect("same receipt")
            .notification_id,
        receipt.notification_id
    );
    assert_eq!(latest(&d).completed_answers[0].press_id, "press-1");
    // A timer callback does not advance the injected clock. The original live receipt survives;
    // actual process/store restart and strict absolute expiry are covered separately.
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
        &mut shell,
        &receipt.notification_id,
        Verb::Undo,
        "press-2",
    );
    assert_eq!(
        task_of_status(&d, &id),
        "open",
        "the same live receipt remains undoable"
    );
}

/// A2: TIME PASSING NEVER REMOVES A DELIVERED REMINDER; ONLY RESOLVING THE ITEM DOES. A reminder that
/// fired yesterday and was not dealt with is not pending, but it is named live until the task is done.

#[test]
fn a_fired_reminder_stays_live_until_its_task_is_resolved() {
    let (mut d, service, _shell) = rig();
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
    let (mut d, service, _shell) = rig();
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
    let (mut d, service, _shell) = rig();
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
    let (mut d, service, _shell) = rig();
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
    // THE LINE HAS A BUTTON (#1188, NA1): "Open Settings" under a refusal, and a press asks the shell.
    {
        answered(
            &mut d,
            service,
            wire::NotificationsScheduled {
                permission: wire::NotificationPermission::Denied as i32,
                ..Default::default()
            },
        );
        let i = d.push(agenda::TAB, routes::task(&id));
        let label = detail_data(d.view(i))
            .fields
            .iter()
            .find(|f| f.key == "reminder")
            .map(|f| f.action_label.clone())
            .expect("the reminder row");
        assert_eq!(label, "Open Settings");
        d.effects.clear();
        d.send(
            i,
            E::TodoDetail(wire::TodoDetailEvent {
                kind: Some(wire::todo_detail_event::Kind::AlertSettings(
                    wire::AlertSettingsPressed {},
                )),
            }),
        );
        assert!(d.effects.iter().any(|request| matches!(
            request.effect.as_ref().and_then(|e| e.kind.as_ref()),
            Some(wire::effect::Kind::OpenNotificationSettings(_))
        )));
        d.pop(agenda::TAB, i);
    }
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

/// ANOTHER PRODUCER'S NOTICE (#1188, NB2): held through the one service, it never starts the
/// system prompt by itself, only its screen's own `ask` does, and a tap on it opens where it says.

#[test]
fn another_producers_notice_never_asks_by_itself_and_a_tap_opens_its_route() {
    use centraid_screens::kit::permission::{Channel, ExtraNotice, Offer};
    let runtime = centraid_screens::Runtime::new(
        agenda::registry(),
        vec![(
            agenda::TAB.to_owned(),
            routes::home(wire::AgendaDestination::Day, ""),
        )],
    )
    .with_services(agenda::notify::services());
    let board = runtime.alerts();
    let mut d = Driver::with_runtime(runtime);
    d.start();
    let mut shell = FakeShell::default();
    d.serve(&mut shell);
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
    clear_tasks(&d);
    changed(&mut d, service);
    let opens = routes::home(wire::AgendaDestination::Week, "");
    let signalled = |d: &mut Driver| {
        d.effects.clear();
        d.send(service, E::Signalled(wire::Signalled {}));
    };
    let fire_at_ms = 4_000_000_000_000;
    assert!(board.hold(
        "backup",
        Offer {
            notices: vec![ExtraNotice {
                id: "backup|stale".to_owned(),
                channel: Channel::Backup,
                fire_at_ms,
                title: "Backup".to_owned(),
                body: "Your backup is out of date.".to_owned(),
                opens: opens.clone(),
            }],
            wanted: vec![],
        },
    ));
    signalled(&mut d);
    let set = latest(&d);
    assert!(has(&set, "backup|stale"), "the notice is held");
    assert!(!set.ask_permission, "a producer's notices alone never ask");
    board.request_ask();
    signalled(&mut d);
    assert!(latest(&d).ask_permission, "its screen's own ask does");
    signalled(&mut d);
    assert!(!latest(&d).ask_permission, "an ask is spent once");
    // Actual OS inventory remains valid while the producer still offers this id,
    // even when it has not separately named it in wanted (the upstream all/live rule).
    d.effects.clear();
    answered(
        &mut d,
        service,
        wire::NotificationsScheduled {
            delivered: vec![wire::DeliveredNotification {
                notification_id: "backup|stale".to_owned(),
                source_fingerprint: String::new(),
            }],
            ..Default::default()
        },
    );
    assert!(
        d.effects.iter().all(|request| {
            match request
                .effect
                .as_ref()
                .and_then(|effect| effect.kind.as_ref())
            {
                Some(wire::effect::Kind::ScheduleNotifications(set)) => !set
                    .cancel_delivered_ids
                    .iter()
                    .any(|id| id == "backup|stale"),
                _ => true,
            }
        }),
        "an offered delivered notice must not be withdrawn as an unknown record"
    );
    d.effects.clear();
    d.send(
        service,
        E::ShellFact(wire::ShellFact {
            fact: Some(wire::shell_fact::Fact::NotificationAnswered(
                wire::NotificationAnswered {
                    notification_id: "backup|stale".to_owned(),
                    verb: Verb::Open as i32,
                    press_id: String::new(),
                },
            )),
        }),
    );
    let opened =
        d.effects
            .iter()
            .find_map(|request| match request.effect.as_ref()?.kind.as_ref()? {
                wire::effect::Kind::OpenRoute(open) => open.route.clone(),
                _ => None,
            });
    assert_eq!(opened, Some(opens), "a tap opens the producer's route");
    assert!(board.hold("backup", Offer::default()));
    signalled(&mut d);
    assert!(
        latest(&d)
            .cancel_delivered_ids
            .iter()
            .any(|id| id == "backup|stale"),
        "withdrawal of the offer and wanted id removes that delivered notice"
    );
}
