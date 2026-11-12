//! Share one workout (#1185): the page's Share button asks the owner check, and only a pass hands
//! the workout to the OS as one spreadsheet file.

mod health_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::load;
use centraid_screens::health::routes;
use centraid_screens::testing::Driver;
use health_support::*;
use wire::health_workout_event as we;
use wire::screen_event::Kind as E;

fn kinds(d: &Driver) -> Vec<wire::effect::Kind> {
    d.effects
        .iter()
        .filter_map(|request| request.effect.as_ref()?.kind.clone())
        .collect()
}

fn check(outcome: wire::owner_checked::Outcome) -> wire::effect_result::Outcome {
    wire::effect_result::Outcome::OwnerChecked(wire::OwnerChecked {
        available: true,
        outcome: outcome as i32,
        ..wire::OwnerChecked::default()
    })
}

fn share(d: &mut Driver, page: u64) {
    d.send(
        page,
        E::HealthWorkout(wire::HealthWorkoutEvent {
            kind: Some(we::Kind::ShareRequested(we::ShareRequested {})),
        }),
    );
}

/// The page of the one followed workout.
fn page(d: &mut Driver) -> u64 {
    connect_store(d);
    workout(
        d,
        "run",
        "run",
        "2026-11-08T06:40:00.000Z",
        "2026-11-08T07:11:00.000Z",
    );
    let id = match answer(
        d,
        load::health::Workouts {
            limit: 10,
            ..Default::default()
        },
    ) {
        wire::app_query_response::Answer::HealthWorkouts(found) => {
            found.workouts[0].activity_id.clone()
        }
        other => panic!("{other:?}"),
    };
    push(d, routes::workout(&id, "Health"))
}

#[test]
fn one_workout_is_shared_as_one_csv_only_after_the_owner_check() {
    let mut d = driver();
    let page = page(&mut d);
    match &workout_state(d.view(page)).content {
        Some(wire::health_workout_state::Content::Data(data)) => {
            assert_eq!(data.share_label, "Share");
        }
        other => panic!("no data: {other:?}"),
    }
    d.effects.clear();
    share(&mut d, page);
    assert!(matches!(
        kinds(&d).as_slice(),
        [wire::effect::Kind::OwnerCheck(check)] if check.ask
    ));
    d.answer_effect(check(wire::owner_checked::Outcome::Succeeded));
    let Some(wire::effect::Kind::ShareBytes(file)) = kinds(&d).into_iter().last() else {
        panic!("the share sheet was asked for");
    };
    assert!(file.name.ends_with(".csv"), "{}", file.name);
    assert_eq!(file.media_type, "text/csv");
    let text = String::from_utf8_lossy(&file.content);
    assert_eq!(
        text.lines().count(),
        2,
        "the header and the one workout: {text}"
    );
}

#[test]
fn a_refused_check_shares_nothing_and_says_why() {
    let mut d = driver();
    let page = page(&mut d);
    d.effects.clear();
    share(&mut d, page);
    d.answer_effect(check(wire::owner_checked::Outcome::Failed));
    assert!(
        !kinds(&d)
            .iter()
            .any(|kind| matches!(kind, wire::effect::Kind::ShareBytes(_)))
    );
    let status = workout_state(d.view(page))
        .status
        .clone()
        .expect("a sentence");
    assert!(status.refused);
}
