//! THE GLANCE SERVICE, through the door a shell uses (#1173, wave 3): the
//! widgets' snapshot is asked for on start and on a change, is not asked for
//! twice when nothing moved, says `unavailable` when nothing can be read, and
//! the platform's "Add a reminder" opens Agenda's Reminders with the quick-add
//! bar holding the title. Effects are counted; nothing here measures time.

mod todo_support;

use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::agenda::{self, glance, routes};
use centraid_screens::field::Field;
use centraid_screens::testing::Driver;
use centraid_screens::{Registry, Runtime};
use serde_json::Value;
use todo_support::arrange;
use wire::screen_event::Kind as E;

fn runtime() -> Runtime {
    Runtime::new(
        Registry::default()
            .merge(agenda::registry())
            .merge(glance::registry()),
        vec![(
            agenda::TAB.to_owned(),
            routes::home(wire::AgendaDestination::Day, ""),
        )],
    )
    .with_services(glance::services())
}

/// The glance service is the first instance the runtime opens.
const SERVICE: u64 = 1;

fn documents(d: &Driver) -> Vec<Value> {
    d.effects
        .iter()
        .filter_map(|request| match request.effect.as_ref()?.kind.as_ref()? {
            wire::effect::Kind::AgendaGlance(glance) => {
                assert_eq!(glance.version, 1);
                Some(serde_json::from_slice(&glance.document).expect("the document is JSON"))
            }
            _ => None,
        })
        .collect()
}

fn done() -> wire::effect_result::Outcome {
    wire::effect_result::Outcome::Done(wire::EffectDone {})
}

/// Answer the oldest pending snapshot write, the way a shell does; the other
/// screens' effects stay where they are.
fn answer_glance(d: &mut Driver, outcome: wire::effect_result::Outcome) {
    let at = d
        .effects
        .iter()
        .position(|request| {
            matches!(
                request.effect.as_ref().and_then(|e| e.kind.as_ref()),
                Some(wire::effect::Kind::AgendaGlance(_))
            )
        })
        .expect("a snapshot write is pending");
    let request = d.effects.remove(at);
    d.send(
        request.instance,
        E::EffectResult(wire::EffectResult {
            effect_id: request.effect_id,
            outcome: Some(outcome),
        }),
    );
}

fn changed() -> E {
    E::DataChanged(wire::DataChanged {
        tables: vec!["task".to_owned()],
    })
}

#[test]
fn the_snapshot_is_asked_for_on_start_and_not_again_when_nothing_changed() {
    let mut d = Driver::with_runtime(runtime());
    d.start();
    assert_eq!(documents(&d).len(), 1);
    assert_eq!(documents(&d)[0]["state"], "ready");
    assert_eq!(documents(&d)[0]["version"], 1);
    answer_glance(&mut d, done());
    d.send(SERVICE, changed());
    d.send(
        SERVICE,
        E::Lifecycle(wire::AppLifecycle { foreground: false }),
    );
    d.send(SERVICE, E::EnvironmentChanged(wire::EnvironmentChanged {}));
    assert!(documents(&d).is_empty(), "nothing moved, nothing was asked");
}

#[test]
fn a_new_task_asks_for_one_new_snapshot() {
    let mut d = Driver::with_runtime(runtime());
    d.start();
    answer_glance(&mut d, done());
    let title = "Zq glance reminder";
    let today = todo_support::today(&d);
    arrange(
        &d,
        centraid_screens::catalog::act::agenda::AddTask {
            title: title.to_owned(),
            due: Field::Is(today),
            ..Default::default()
        },
    );
    d.send(SERVICE, changed());
    let asked = documents(&d);
    assert_eq!(asked.len(), 1);
    let rows = asked[0]["reminders"]["rows"].as_array().expect("rows");
    assert!(rows.iter().any(|row| row["title"] == title), "{asked:?}");
    // Again, with nothing new: no second ask.
    answer_glance(&mut d, done());
    d.send(SERVICE, changed());
    assert!(documents(&d).is_empty());
}

/// THE COUNTS ARE THE VAULT'S, NOT THE BOARD'S WINDOW (#1173): more overdue
/// tasks than the board's window holds are all counted, and the document draws
/// six rows of them.
#[test]
fn the_counts_say_every_open_task_when_the_rows_are_only_a_window() {
    let mut d = Driver::with_runtime(runtime());
    d.start();
    // A founded vault holds a few starter tasks; the added ones are on top.
    let before = documents(&d)[0]["reminders"].clone();
    let (was_overdue, was_today) = (
        before["overdue_count"].as_u64().expect("a count"),
        before["today_count"].as_u64().expect("a count"),
    );
    answer_glance(&mut d, done());
    let overdue = centraid_screens::agenda::todo::rows::MAX_WINDOW as usize + 20;
    for n in 0..overdue {
        arrange(
            &d,
            centraid_screens::catalog::act::agenda::AddTask {
                title: format!("Zq long overdue {n}"),
                due: Field::Is("2000-01-01".to_owned()),
                ..Default::default()
            },
        );
    }
    d.send(SERVICE, changed());
    let asked = documents(&d);
    assert_eq!(asked.len(), 1);
    let reminders = &asked[0]["reminders"];
    assert_eq!(
        reminders["overdue_count"].as_u64(),
        Some(was_overdue + overdue as u64),
        "{reminders:?}"
    );
    assert_eq!(reminders["today_count"].as_u64(), Some(was_today));
    assert_eq!(
        reminders["rows"].as_array().map(Vec::len),
        Some(6),
        "six rows are drawn of {overdue}"
    );
}

#[test]
fn the_runtime_relays_a_commit_to_the_service_once() {
    let mut d = Driver::with_runtime(runtime());
    d.start();
    answer_glance(&mut d, done());
    let today = todo_support::today(&d);
    arrange(
        &d,
        centraid_screens::catalog::act::agenda::AddTask {
            title: "Zq relayed".to_owned(),
            due: Field::Is(today),
            ..Default::default()
        },
    );
    d.pump(Duration::from_millis(500));
    assert_eq!(documents(&d).len(), 1, "one commit, one new snapshot");
}

#[test]
fn a_refused_write_is_asked_again_on_the_next_change() {
    let mut d = Driver::with_runtime(runtime());
    d.start();
    answer_glance(
        &mut d,
        wire::effect_result::Outcome::Failed(wire::EffectFailed {
            reason: "the container is gone".to_owned(),
            ..Default::default()
        }),
    );
    d.send(SERVICE, changed());
    assert_eq!(documents(&d).len(), 1, "the refused document is sent again");
}

#[test]
fn no_vault_in_front_is_an_unavailable_snapshot_once() {
    let mut d = Driver::unfounded(runtime());
    d.start();
    let asked = documents(&d);
    assert_eq!(asked.len(), 1);
    assert_eq!(asked[0]["state"], "unavailable");
    assert_eq!(asked[0]["up_next"].as_array().map(Vec::len), Some(0));
    answer_glance(&mut d, done());
    d.send(SERVICE, changed());
    assert!(documents(&d).is_empty(), "the same refusal is not repeated");
}

#[test]
fn add_a_reminder_opens_reminders_with_the_title_in_the_quick_add_bar() {
    let mut d = Driver::with_runtime(runtime());
    d.start();
    answer_glance(&mut d, done());
    let update = d.call(wire::screen_request::Kind::ShellFact(wire::ShellFact {
        fact: Some(wire::shell_fact::Fact::AgendaIntent(wire::AgendaIntent {
            kind: Some(wire::agenda_intent::Kind::Add(wire::AgendaIntentAdd {
                title: "  Buy oat milk ".to_owned(),
            })),
        })),
    }));
    let routes_opened: Vec<&wire::Route> = update
        .effects
        .iter()
        .filter_map(|request| match request.effect.as_ref()?.kind.as_ref()? {
            wire::effect::Kind::OpenRoute(open) => open.route.as_ref(),
            _ => None,
        })
        .collect();
    assert_eq!(routes_opened.len(), 1);
    assert_eq!(
        *routes_opened[0],
        routes::home(wire::AgendaDestination::Todo, "Buy oat milk")
    );
    // Nothing was written: no task has the title.
    assert!(
        todo_support::load_board(
            &d,
            centraid_screens::catalog::load::agenda::BoardView::All,
            None
        )
        .groups
        .iter()
        .flat_map(|group| &group.tasks)
        .all(|task| task.title != "Buy oat milk")
    );
    // An empty title opens the bar empty.
    let update = d.call(wire::screen_request::Kind::ShellFact(wire::ShellFact {
        fact: Some(wire::shell_fact::Fact::AgendaIntent(wire::AgendaIntent {
            kind: Some(wire::agenda_intent::Kind::Add(wire::AgendaIntentAdd {
                title: String::new(),
            })),
        })),
    }));
    assert!(update.effects.iter().any(|request| matches!(
        request.effect.as_ref().and_then(|e| e.kind.as_ref()),
        Some(wire::effect::Kind::OpenRoute(open))
            if open.route.as_ref() == Some(&routes::home(wire::AgendaDestination::Todo, ""))
    )));
}
