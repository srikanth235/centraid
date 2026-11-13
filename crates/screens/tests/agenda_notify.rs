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
    d.effects.clear();
    d.send(
        service,
        E::ShellFact(wire::ShellFact {
            fact: Some(wire::shell_fact::Fact::NotificationAnswered(
                wire::NotificationAnswered {
                    notification_id: id.to_owned(),
                    verb: verb as i32,
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
