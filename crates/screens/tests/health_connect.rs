//! Health's Connect page and the follow it runs (`health.connect`): the choice
//! of types, the one tap that asks the shell to read the store, and what is
//! written from the answer. Ports of the `HealthScreensSpec` connect cases and
//! the `HealthFollowSpec` pass cases through `Driver`.

mod health_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::load;
use centraid_screens::health::routes;
use centraid_screens::testing::Driver;
use health_support::*;
use wire::app_query_response::Answer;
use wire::effect_result::Outcome;
use wire::health_connect_event as ce;

/// Connect opened over a fresh phone, the home's own effects set aside.
fn opened(d: &mut Driver) -> u64 {
    d.effects.clear();
    push(d, routes::connect("Health"))
}

fn toggle(d: &mut Driver, i: u64, key: &str) {
    d.send(
        i,
        wire::screen_event::Kind::HealthConnect(wire::HealthConnectEvent {
            kind: Some(ce::Kind::Toggled(ce::Toggled {
                key: key.to_owned(),
            })),
        }),
    );
}

fn tap(d: &mut Driver, i: u64) {
    d.send(
        i,
        wire::screen_event::Kind::HealthConnect(wire::HealthConnectEvent {
            kind: Some(ce::Kind::Connect(ce::ConnectTapped {})),
        }),
    );
}

fn no_memory() -> Outcome {
    Outcome::Keychain(wire::KeychainValue {
        found: false,
        value: Vec::new(),
    })
}

fn snapshot(today: &str) -> wire::HealthSnapshot {
    wire::HealthSnapshot {
        store: wire::health_snapshot::Store::AppleHealth as i32,
        store_present: true,
        workouts_complete: true,
        device_id: "phone-a".to_owned(),
        days: vec![
            wire::HealthDayTotal {
                day: today.to_owned(),
                metric: "steps".to_owned(),
                value: 5_000.0,
            },
            wire::HealthDayTotal {
                day: day_back(today, 2),
                metric: "sleep_min".to_owned(),
                value: 450.0,
            },
        ],
        workouts: vec![wire::HealthPhoneWorkout {
            id: "hk-1".to_owned(),
            kind: "running".to_owned(),
            started_at: format!("{today}T09:00:00Z"),
            ended_at: format!("{today}T09:31:00Z"),
            moving_sec: Some(1_864),
            distance_m: Some(5_200.0),
            ..Default::default()
        }],
        ..Default::default()
    }
}

fn is_connected(d: &Driver) -> bool {
    match answer(d, load::health::Today {}) {
        Answer::HealthToday(today) => today.connected,
        other => panic!("{other:?}"),
    }
}

#[test]
fn connect_starts_with_every_type_on_the_first_time_and_energy_is_two_types() {
    let mut d = driver();
    let i = opened(&mut d);
    assert!(
        matches!(pending(&d), wire::effect::Kind::Keychain(op) if op.op == wire::keychain_op::Op::Get as i32)
    );
    d.answer_effect(no_memory());
    let state = connect_state(d.view(i));
    let labels: Vec<&str> = state.choices.iter().map(|c| c.label.as_str()).collect();
    assert_eq!(
        labels,
        [
            "Steps",
            "Sleep",
            "Active energy and exercise",
            "Resting heart rate",
            "Weight",
            "Workouts"
        ]
    );
    assert!(state.choices.iter().all(|choice| choice.on));
    assert_eq!(state.connect_label, "Connect Apple Health");
    assert!(state.can_connect);
    assert!(state.lede.contains("Nothing is written back."));
    assert_eq!(state.chrome.as_ref().unwrap().back_label, "Health");
}

#[test]
fn what_the_member_chose_last_time_is_what_is_on() {
    let mut d = driver();
    let i = opened(&mut d);
    d.answer_effect(keychain("0|steps,sleep_min,weight_kg,workouts"));
    let on: Vec<&str> = connect_state(d.view(i))
        .choices
        .iter()
        .filter(|choice| choice.on)
        .map(|choice| choice.key.as_str())
        .collect();
    assert_eq!(on, ["steps", "sleep_min", "weight_kg", "workouts"]);
}

#[test]
fn none_chosen_cannot_connect_and_a_tap_asks_nothing() {
    let mut d = driver();
    let i = opened(&mut d);
    d.answer_effect(no_memory());
    for key in [
        "steps",
        "sleep_min",
        "energy",
        "resting_hr_bpm",
        "weight_kg",
        "workouts",
    ] {
        toggle(&mut d, i, key);
    }
    let state = connect_state(d.view(i));
    assert!(!state.can_connect);
    assert_eq!(state.status, "Choose at least one to connect");
    tap(&mut d, i);
    assert!(d.effects.is_empty(), "the OS is asked at a real tap only");
    assert!(!connect_state(d.view(i)).working);
}

#[test]
fn a_tap_asks_the_shell_to_read_the_store_with_exactly_the_chosen_types_then_follows_it() {
    let mut d = driver();
    let today = today(&d);
    let i = opened(&mut d);
    d.answer_effect(no_memory());
    toggle(&mut d, i, "sleep_min");
    tap(&mut d, i);
    let working = connect_state(d.view(i));
    assert!(working.working && !working.can_connect);
    assert_eq!(working.status, "Reading Apple Health…");
    match pending(&d) {
        wire::effect::Kind::HealthRead(read) => {
            assert!(
                read.ask_permission,
                "Connect's tap is where the OS is asked"
            );
            assert_eq!(
                read.chosen,
                [
                    "steps",
                    "active_energy_kcal",
                    "exercise_min",
                    "resting_hr_bpm",
                    "weight_kg",
                    "workouts"
                ]
            );
            // A fresh vault reads a year of days and 90 days of workouts (R-1129-4).
            assert_eq!(read.today, today);
            assert_eq!(read.totals_from, day_back(&today, 365));
        }
        other => panic!("{other:?}"),
    }
    d.answer_effect(Outcome::Health(snapshot(&today)));
    // The store's origin is written and the first pass ran: Health is followed,
    // the days are in, the workout is a row.
    assert!(is_connected(&d));
    let state = connect_state(d.view(i));
    assert!(state.finished, "the shell pops a connected page");
    match answer(&d, load::health::Today {}) {
        Answer::HealthToday(found) => {
            let steps = found
                .metrics
                .iter()
                .find(|m| m.metric == wire::HealthMetric::Steps as i32);
            assert_eq!(steps.and_then(|m| m.value), Some(5_000.0));
            assert_eq!(found.workouts.len(), 1);
            assert_eq!(found.workouts[0].kind_key, "run");
        }
        other => panic!("{other:?}"),
    }
    // This phone remembers it connected, and what it chose.
    match pending(&d) {
        wire::effect::Kind::Keychain(op) => {
            assert_eq!(op.op, wire::keychain_op::Op::Set as i32);
            assert_eq!(
                op.value,
                b"1|steps,active_energy_kcal,exercise_min,resting_hr_bpm,weight_kg,workouts"
            );
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn after_connect_the_home_follows_and_a_second_pass_over_the_same_store_changes_nothing() {
    let mut d = driver();
    let today = today(&d);
    let home = root(&d);
    // The home asks what this phone remembers: nothing yet.
    answer_for(&mut d, home, no_memory());
    let i = push(&mut d, routes::connect("Health"));
    answer_for(&mut d, i, no_memory());
    tap(&mut d, i);
    answer_for(&mut d, i, Outcome::Health(snapshot(&today)));
    let before = match answer(&d, load::health::FollowView {}) {
        Answer::HealthFollowView(view) => view.days,
        other => panic!("{other:?}"),
    };
    assert_eq!(before.len(), 2);
    // Connect wrote the origin, so the home's data changed under it: it learns
    // the phone connected (Connect kept the habit) and follows, silently.
    d.pump(std::time::Duration::from_millis(500));
    answer_for(&mut d, home, keychain("1|steps,sleep_min,workouts"));
    match pending_for(&d, home) {
        wire::effect::Kind::HealthRead(read) => assert!(!read.ask_permission),
        other => panic!("{other:?}"),
    }
    answer_for(&mut d, home, Outcome::Health(snapshot(&today)));
    let after = match answer(&d, load::health::FollowView {}) {
        Answer::HealthFollowView(view) => view.days,
        other => panic!("{other:?}"),
    };
    assert_eq!(before, after, "the days the vault holds are not sent again");
}

#[test]
fn a_refusal_from_the_os_is_the_stores_own_didnt_answer_and_nothing_is_written() {
    let mut d = driver();
    let i = opened(&mut d);
    d.answer_effect(no_memory());
    tap(&mut d, i);
    d.answer_effect(Outcome::Failed(wire::EffectFailed {
        reason: "denied".to_owned(),
        denied: true,
        cancelled: false,
    }));
    let state = connect_state(d.view(i));
    assert!(!state.working && !state.finished);
    assert_eq!(state.status, "Apple Health didn’t answer. Try again.");
    assert!(state.can_connect);
    assert!(!is_connected(&d));
}

#[test]
fn health_connect_missing_from_the_phone_says_where_to_get_it() {
    let mut d = driver_on("android", "en-GB");
    let i = opened(&mut d);
    d.answer_effect(no_memory());
    tap(&mut d, i);
    d.answer_effect(Outcome::Health(wire::HealthSnapshot {
        store: wire::health_snapshot::Store::HealthConnect as i32,
        store_present: false,
        installable: true,
        ..Default::default()
    }));
    let state = connect_state(d.view(i));
    assert_eq!(
        state.status,
        "Get Health Connect from Google Play, then connect again."
    );
    assert_eq!(state.connect_label, "Connect Health Connect");
    assert!(!is_connected(&d));
    // And where Play cannot bring it, it is not available.
    tap(&mut d, i);
    d.answer_effect(Outcome::Health(wire::HealthSnapshot {
        store: wire::health_snapshot::Store::HealthConnect as i32,
        store_present: false,
        ..Default::default()
    }));
    assert_eq!(
        connect_state(d.view(i)).status,
        "Health Connect isn’t available on this phone."
    );
}

#[test]
fn a_toggle_after_a_failure_clears_its_sentence() {
    let mut d = driver();
    let i = opened(&mut d);
    d.answer_effect(no_memory());
    tap(&mut d, i);
    d.answer_effect(Outcome::Failed(wire::EffectFailed::default()));
    assert!(!connect_state(d.view(i)).status.is_empty());
    toggle(&mut d, i, "weight_kg");
    assert_eq!(connect_state(d.view(i)).status, "");
}
