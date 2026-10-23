//! The runtime, end to end, through the same door a shell uses: the proof
//! screen over a real vault seeded with the example scenario.

use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::testing::Driver;
use centraid_screens::{Registry, Runtime, proof};
use wire::screen_event::Kind as E;

fn counter_event(kind: wire::counter_event::Kind) -> E {
    E::Counter(wire::CounterEvent { kind: Some(kind) })
}

fn driver_with(clear_after: Duration) -> Driver {
    Driver::with_runtime(Runtime::new(
        Registry::default().with(proof::NAME, proof::build_with(clear_after)),
        vec![("proof".to_owned(), proof::route())],
    ))
}

fn root(driver: &Driver) -> u64 {
    driver.navigation.as_ref().expect("navigation").tabs[0].entries[0].instance
}

fn data(driver: &Driver, instance: u64) -> wire::CounterData {
    match &driver.counter(instance).content {
        Some(wire::counter_view::Content::Data(data)) => data.clone(),
        other => panic!("expected data, found {other:?}"),
    }
}

#[test]
fn starting_opens_the_root_and_draws_a_finished_count() {
    let mut driver = driver_with(Duration::from_secs(30));
    driver.start();
    let id = root(&driver);
    let view = driver.counter(id);
    assert_eq!(view.title, "Upcoming");
    let shown = data(&driver, id);
    // The sentence is finished: a number and its plural, made in Rust.
    assert!(
        shown.count_label.ends_with("upcoming events") || shown.count_label == "1 upcoming event",
        "{}",
        shown.count_label
    );
    assert_eq!(shown.copy_label, "Copy the count");
    assert!(shown.notice.is_empty());
}

#[test]
fn a_second_start_changes_nothing() {
    let mut driver = driver_with(Duration::from_secs(30));
    driver.start();
    let again = driver.start();
    assert_eq!(again.views.len(), 1, "a snapshot repeats the one view");
    assert_eq!(driver.navigation.as_ref().unwrap().tabs.len(), 1);
}

#[test]
fn copying_asks_the_shell_for_the_clipboard_and_a_haptic_then_clears_on_its_timer() {
    let mut driver = driver_with(Duration::from_millis(100));
    driver.start();
    let id = root(&driver);
    let count = data(&driver, id).count_label;
    let number = count.split(' ').next().unwrap().to_owned();

    let update = driver.send(
        id,
        counter_event(wire::counter_event::Kind::CopyTapped(
            wire::CounterCopyTapped {},
        )),
    );
    let asked: Vec<_> = update
        .effects
        .iter()
        .map(|request| request.effect.as_ref().unwrap().kind.as_ref().unwrap())
        .collect();
    assert!(matches!(asked[0], wire::effect::Kind::ClipboardSet(set) if set.text == number));
    assert!(matches!(asked[1], wire::effect::Kind::Haptic(_)));
    assert_eq!(
        data(&driver, id).notice,
        "Copied. The clipboard clears in 30 seconds."
    );
    driver.effects.clear();

    // The timer lives in Rust: nothing is sent, the clear arrives on its own.
    driver.pump(Duration::from_millis(600));
    let clear = driver.effects.first().expect("the clear was asked for");
    assert!(
        matches!(&clear.effect.as_ref().unwrap().kind, Some(wire::effect::Kind::ClipboardClear(c)) if c.expected_text == number)
    );
    assert!(data(&driver, id).notice.is_empty());
}

#[test]
fn a_failed_copy_cancels_the_clear() {
    let mut driver = driver_with(Duration::from_millis(100));
    driver.start();
    let id = root(&driver);
    driver.send(
        id,
        counter_event(wire::counter_event::Kind::CopyTapped(
            wire::CounterCopyTapped {},
        )),
    );
    driver.effects.drain(1..);
    driver.answer_effect(wire::effect_result::Outcome::Failed(wire::EffectFailed {
        reason: "denied".to_owned(),
        denied: true,
        ..Default::default()
    }));
    driver.pump(Duration::from_millis(400));
    assert!(driver.effects.is_empty(), "{:?}", driver.effects);
    assert!(data(&driver, id).notice.is_empty());
}

#[test]
fn a_write_to_a_table_the_screen_read_redraws_it_once() {
    let mut driver = driver_with(Duration::from_secs(30));
    driver.start();
    let id = root(&driver);
    let before = driver.views[&id].revision;
    let before_count = data(&driver, id).count_label;

    // A write by someone else through the one door.
    let input = [
        ("title", "Dinner"),
        ("starts", "2099-01-01T18:00"),
        ("zone", "UTC"),
    ]
    .into_iter()
    .map(|(k, v)| {
        (
            k.to_owned(),
            wire::Value {
                kind: Some(wire::value::Kind::Text(v.to_owned())),
            },
        )
    })
    .collect();
    let done = driver
        .handle
        .act(&wire::ActRequest {
            app: "agenda".to_owned(),
            action: "propose".to_owned(),
            input,
            invoke_key: "proof-1".to_owned(),
        })
        .expect("act answers");
    assert_eq!(done.status, wire::ActStatus::Executed as i32, "{done:?}");

    let arrived = driver.pump(Duration::from_millis(300));
    assert!(arrived >= 1, "the change was pushed to the shell");
    assert_ne!(data(&driver, id).count_label, before_count);
    assert!(driver.views[&id].revision > before);
}

#[test]
fn the_stack_is_rusts_and_a_back_swipe_is_an_event() {
    let mut driver = driver_with(Duration::from_secs(30));
    driver.start();
    let first = root(&driver);
    let pushed = driver.nav(wire::nav_event::Kind::Push(wire::NavPush {
        tab: "proof".to_owned(),
        route: Some(proof::route()),
    }));
    assert_eq!(pushed.views.len(), 1, "the pushed screen arrives drawn");
    let nav = driver.navigation.clone().unwrap();
    let entries = &nav.tabs[0].entries;
    assert_eq!(entries.len(), 2);
    let second = entries[1].instance;
    assert_ne!(first, second);

    let popped = driver.nav(wire::nav_event::Kind::Popped(wire::NavPopped {
        tab: "proof".to_owned(),
        instance: second,
    }));
    assert_eq!(popped.closed, vec![second]);
    assert_eq!(driver.navigation.as_ref().unwrap().tabs[0].entries.len(), 1);
    assert!(!driver.views.contains_key(&second));

    // The root cannot be popped away.
    driver.nav(wire::nav_event::Kind::Popped(wire::NavPopped {
        tab: "proof".to_owned(),
        instance: first,
    }));
    assert_eq!(driver.navigation.as_ref().unwrap().tabs[0].entries.len(), 1);
}

#[test]
fn an_unknown_route_tab_or_instance_is_refused_by_name() {
    let mut driver = driver_with(Duration::from_secs(30));
    driver.start();
    let bad_route = driver.try_call(wire::screen_request::Kind::Nav(wire::NavEvent {
        kind: Some(wire::nav_event::Kind::Push(wire::NavPush {
            tab: "proof".to_owned(),
            route: Some(wire::Route {
                screen: "nowhere".to_owned(),
                args: None,
            }),
        })),
    }));
    assert!(bad_route.is_err());
    let bad_tab = driver.try_call(wire::screen_request::Kind::Nav(wire::NavEvent {
        kind: Some(wire::nav_event::Kind::SelectTab(wire::NavSelectTab {
            tab: "ghost".to_owned(),
        })),
    }));
    assert!(bad_tab.is_err());
    let bad_instance = driver.try_call(wire::screen_request::Kind::Send(wire::InstanceEvent {
        instance: 999,
        event: Some(wire::ScreenEvent {
            kind: Some(E::Appeared(wire::Appeared {})),
        }),
    }));
    assert!(bad_instance.is_err());
}

#[test]
fn a_core_with_no_runtime_refuses_the_screen_door_by_name() {
    let dir = centraid_ontology::scratch::scratch_dir();
    std::fs::create_dir_all(&dir).unwrap();
    let handle =
        centraid_core::Core::open(centraid_core::CoreConfig::new(dir.join("v.db"))).unwrap();
    let refused = handle.call(&wire::Request {
        kind: Some(wire::request::Kind::Screen(Box::new(wire::ScreenRequest {
            kind: Some(wire::screen_request::Kind::Snapshot(
                wire::SnapshotRequest {},
            )),
        }))),
    });
    assert!(refused.is_err());
}
