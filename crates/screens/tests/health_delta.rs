//! A Health pass reads only what changed (#1183): the store's cursor lives in the vault beside the
//! install that wrote it, the shell answers a delta (the days its changes touched, the workouts
//! added, the ids deleted), and the cursor moves in the commit of the records it covers. The
//! shell's part is played here; every assertion is on what the vault holds.

mod health_support;

use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::{act, load};
use centraid_screens::health::follow as health;
use centraid_screens::testing::Driver;
use health_support::*;
use wire::app_query_response::Answer;
use wire::effect_result::Outcome as O;

const STORE: &str = "store:apple-health";
const CHOSEN: [&str; 2] = ["steps", "workouts"];

/// An iPhone following Health, with the store's origin written by `phone-a`; the coordinator's
/// instance, and nothing else pending.
fn rig() -> (Driver, u64, String) {
    let (mut d, follower) = driver_following_on("ios", "en-GB");
    let today = today(&d);
    connect_store(&d);
    d.effects.retain(|request| request.instance == follower);
    (d, follower, today)
}

/// The cursor the vault holds for `device`.
fn held_cursor(d: &Driver, device: &str) -> String {
    match answer(
        d,
        load::shell::OriginCursor {
            system: load::shell::OriginCursorSystem::Health,
            r#ref: STORE.to_owned(),
            device_id: device.to_owned(),
        },
    ) {
        Answer::OriginCursor(held) => held.cursor,
        other => panic!("{other:?}"),
    }
}

fn move_cursor(d: &Driver, device: &str, cursor: &str) {
    arrange(
        d,
        act::shell::AdvanceOriginCursor {
            system: act::shell::AdvanceOriginCursorSystem::Health,
            r#ref: STORE.to_owned(),
            device_id: device.to_owned(),
            cursor: cursor.to_owned(),
        },
    );
}

/// The coordinator's pass, up to the read it asks the shell for: the habit is the keychain's answer.
fn read_of(d: &mut Driver, follower: u64, habit: &str) -> wire::HealthRead {
    // The app leaves and comes forward: every connected store is followed.
    for foreground in [false, true] {
        d.call(wire::screen_request::Kind::Lifecycle(wire::AppLifecycle {
            foreground,
        }));
    }
    d.pump(Duration::from_millis(2_600));
    // The other stores are not connected on this phone: their habits are not found.
    loop {
        match pending_for(d, follower).clone() {
            wire::effect::Kind::HealthRead(read) => return read,
            wire::effect::Kind::Keychain(op) if op.key == health::DEVICE_KEY => {
                answer_for(d, follower, keychain(habit));
            }
            wire::effect::Kind::Keychain(_) => {
                answer_for(d, follower, O::Keychain(wire::KeychainValue::default()));
            }
            other => panic!("{other:?}"),
        }
    }
}

fn snapshot(delta: bool) -> wire::HealthSnapshot {
    wire::HealthSnapshot {
        store: wire::health_snapshot::Store::AppleHealth as i32,
        store_present: true,
        workouts_complete: true,
        device_id: "phone-a".to_owned(),
        delta,
        ..Default::default()
    }
}

fn total(d: &Driver, day: &str, metric: &str, value: f64) -> wire::HealthDayTotal {
    let _ = d;
    wire::HealthDayTotal {
        day: day.to_owned(),
        metric: metric.to_owned(),
        value,
    }
}

/// One pass over `snapshot`, as the coordinator runs it.
fn run(d: &Driver, snapshot: &wire::HealthSnapshot) -> health::Outcome {
    d.with_ctx_in(ZONE, |ctx| {
        let window = health::window(ctx).expect("the window");
        let chosen: Vec<String> = CHOSEN.iter().map(|key| (*key).to_owned()).collect();
        health::run(ctx, snapshot, &window, &chosen, "phone-a")
    })
}

/// What the vault holds of `metric`, by day.
fn held(d: &Driver, metric: &str) -> Vec<(String, f64)> {
    let mut days: Vec<(String, f64)> = d
        .with_ctx_in(ZONE, |ctx| health::window(ctx).expect("the window").held)
        .into_iter()
        .filter(|total| total.metric == metric)
        .map(|total| (total.day, total.value))
        .collect();
    days.sort_by(|a, b| a.0.cmp(&b.0));
    days
}

fn workouts(d: &Driver) -> usize {
    match answer(
        d,
        load::health::Workouts {
            limit: 50,
            ..Default::default()
        },
    ) {
        Answer::HealthWorkouts(listed) => listed.workouts.len(),
        other => panic!("{other:?}"),
    }
}

fn phone_workout(id: &str, hour: u32, today: &str) -> wire::HealthPhoneWorkout {
    wire::HealthPhoneWorkout {
        id: id.to_owned(),
        kind: "running".to_owned(),
        started_at: format!("{today}T{hour:02}:00:00Z"),
        ended_at: format!("{today}T{hour:02}:30:00Z"),
        ..Default::default()
    }
}

#[test]
fn the_pass_hands_the_shell_the_cursor_the_vault_holds_for_this_install_and_only_this_one() {
    let (mut d, follower, _) = rig();
    move_cursor(&d, "phone-a", "A1");
    // This install wrote it: the read is a delta from it.
    let read = read_of(&mut d, follower, "1|steps,workouts|phone-a");
    assert_eq!(read.cursor, "A1");
    assert!(!read.ask_permission);
    // The shell's answer moves it, with nothing to write.
    let mut answered = snapshot(true);
    answered.next_cursor = "A2".to_owned();
    answer_for(&mut d, follower, O::Health(answered));
    assert_eq!(held_cursor(&d, "phone-a"), "A2");
    // ANOTHER INSTALL'S WORD IS NOT TRUSTED, and neither is a habit that names no install.
    let read = read_of(&mut d, follower, "1|steps,workouts|phone-b");
    assert_eq!(
        read.cursor, "",
        "a cursor another install wrote is a complete read"
    );
    answer_for(&mut d, follower, O::Health(snapshot(false)));
    let read = read_of(&mut d, follower, "1|steps,workouts");
    assert_eq!(
        read.cursor, "",
        "an unknown install reads nothing of the cursor"
    );
    answer_for(&mut d, follower, O::Health(snapshot(false)));
    // The first commit by another install takes the origin over: its cursor is the vault's now.
    move_cursor(&d, "phone-b", "B1");
    assert_eq!(held_cursor(&d, "phone-a"), "");
    let read = read_of(&mut d, follower, "1|steps,workouts|phone-b");
    assert_eq!(read.cursor, "B1");
    answer_for(&mut d, follower, O::Health(snapshot(false)));
}

#[test]
fn a_delta_applies_only_its_days_and_workouts_and_judges_nothing_else_gone() {
    let (d, _, today) = rig();
    record(
        &d,
        &today,
        &[
            (3, "steps", 1_000.0),
            (2, "steps", 2_000.0),
            (1, "steps", 3_000.0),
            (2, "sleep_min", 400.0),
        ],
    );
    workout(
        &d,
        "w1",
        "running",
        &format!("{today}T06:00:00.000Z"),
        &format!("{today}T06:30:00.000Z"),
    );
    move_cursor(&d, "phone-a", "A1");
    let (back2, back1, back3, back4) = (
        day_back(&today, 2),
        day_back(&today, 1),
        day_back(&today, 3),
        day_back(&today, 4),
    );
    let mut delta = snapshot(true);
    delta.next_cursor = "A2".to_owned();
    delta.days = vec![
        total(&d, &back2, "steps", 2_500.0),
        // A day left with no samples is sent as 0 and corrects what the vault holds.
        total(&d, &back1, "steps", 0.0),
        // A 0 for a day the vault holds nothing for is not written.
        total(&d, &back4, "steps", 0.0),
    ];
    delta.workouts = vec![phone_workout("w3", 8, &today)];
    delta.deleted_workout_ids = vec!["w1".to_owned(), "never-seen".to_owned()];
    let outcome = run(&d, &delta);
    assert!(outcome.read);
    assert_eq!(outcome.refused, 0);
    assert_eq!(outcome.days, 2);
    assert_eq!(outcome.forgotten, 1);
    // ONLY THE DAYS IT NAMES MOVED: the one it did not (a complete read stating this much would
    // have zeroed it) and the metric it did not touch stand.
    assert_eq!(
        held(&d, "steps"),
        [(back3, 1_000.0), (back2.clone(), 2_500.0), (back1, 0.0)]
    );
    assert_eq!(held(&d, "sleep_min"), [(back2, 400.0)]);
    // The deleted workout keeps its row and forgets its source; the added one is there.
    assert_eq!(workouts(&d), 2);
    assert_eq!(held_cursor(&d, "phone-a"), "A2");
}

#[test]
fn a_delta_with_only_days_moves_the_cursor_with_the_last_batch_and_one_with_nothing_moves_it_alone()
{
    let (d, _, today) = rig();
    move_cursor(&d, "phone-a", "A1");
    let mut delta = snapshot(true);
    delta.next_cursor = "A2".to_owned();
    delta.days = vec![total(&d, &today, "steps", 4_200.0)];
    let outcome = run(&d, &delta);
    assert!(outcome.read);
    assert_eq!(held(&d, "steps"), [(today.clone(), 4_200.0)]);
    assert_eq!(held_cursor(&d, "phone-a"), "A2");
    // Nothing to write: only the cursor moves.
    let mut quiet = snapshot(true);
    quiet.next_cursor = "A3".to_owned();
    let outcome = run(&d, &quiet);
    assert!(outcome.read);
    assert_eq!(outcome.days, 0);
    assert_eq!(held(&d, "steps"), [(today, 4_200.0)]);
    assert_eq!(held_cursor(&d, "phone-a"), "A3");
}

#[test]
fn a_write_the_vault_refuses_moves_neither_the_cursor_nor_its_records() {
    let (d, _, today) = rig();
    record(&d, &today, &[(1, "steps", 3_000.0)]);
    move_cursor(&d, "phone-a", "A1");
    let yesterday = day_back(&today, 1);
    // A cursor past what the vault keeps: the commit that carries it is refused whole.
    let mut delta = snapshot(true);
    delta.next_cursor = "x".repeat(5_000);
    delta.days = vec![total(&d, &yesterday, "steps", 3_500.0)];
    let outcome = run(&d, &delta);
    assert!(outcome.refused >= 1);
    assert!(!outcome.read);
    assert_eq!(held(&d, "steps"), [(yesterday.clone(), 3_000.0)]);
    assert_eq!(held_cursor(&d, "phone-a"), "A1");
    // With a workout to say the cursor rides with the workouts, the pass's last command: it is
    // refused with them, and the days sent before it (which carried none) stand.
    delta.workouts = vec![phone_workout("w3", 8, &today)];
    let outcome = run(&d, &delta);
    assert!(outcome.refused >= 1);
    assert_eq!(workouts(&d), 0);
    assert_eq!(held(&d, "steps"), [(yesterday, 3_500.0)]);
    assert_eq!(held_cursor(&d, "phone-a"), "A1");
}

#[test]
fn a_complete_read_after_an_expired_token_is_judged_as_before_and_names_the_cursor_to_come() {
    let (d, _, today) = rig();
    record(&d, &today, &[(3, "steps", 1_000.0), (1, "steps", 3_000.0)]);
    workout(
        &d,
        "w1",
        "running",
        &format!("{today}T06:00:00.000Z"),
        &format!("{today}T06:30:00.000Z"),
    );
    move_cursor(&d, "phone-a", "stale");
    // `delta` false: the shell could not use the cursor and read the window whole.
    let mut complete = snapshot(false);
    complete.next_cursor = "A9".to_owned();
    complete.days = vec![total(&d, &day_back(&today, 1), "steps", 3_000.0)];
    complete.workouts = vec![phone_workout("w3", 8, &today)];
    complete.deleted_workout_ids = vec!["w3".to_owned()];
    let outcome = run(&d, &complete);
    assert!(outcome.read);
    // What a complete read does: a sum it no longer states is zeroed, a workout it no longer holds
    // loses its source (its row stays), and a delta's list of deleted ids is not read.
    assert_eq!(
        held(&d, "steps"),
        [(day_back(&today, 3), 0.0), (day_back(&today, 1), 3_000.0)]
    );
    assert_eq!(outcome.forgotten, 1);
    assert_eq!(workouts(&d), 2);
    assert_eq!(held_cursor(&d, "phone-a"), "A9");
}
