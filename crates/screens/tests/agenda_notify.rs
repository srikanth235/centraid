//! THE NOTIFICATION SERVICE (`agenda.notify`), end to end through the door a
//! shell uses: a reminder appears in the set the phone is told to hold, a
//! pressed button writes through the one door and leaves a receipt with Undo,
//! and a deleted task leaves the set.

mod todo_support;

#[allow(clippy::duplicate_mod)]
#[path = "schedule_routes/mod.rs"]
mod routes;
use centraid_api_proto::core_v1 as wire;
use centraid_screens::agenda;
use centraid_screens::catalog::act;
use centraid_screens::field::Field;
use centraid_screens::testing::Driver;
use todo_support::*;
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
