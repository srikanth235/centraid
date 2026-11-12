//! WHAT THE STORE SAYS on a followed workout's page (#1183): a line under the figures for each one
//! the member's own differs on, in the store's name and the member's units, one tap to take the
//! store's figure back, and nothing on the lists. A workout the member logged by hand and the store
//! then matched keeps the member's figures, which is how a figure comes to differ. Every test goes
//! through `Driver`, the door a shell uses, over a vault seeded at a fixed instant.

mod health_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::act;
use centraid_screens::health::{self, routes};
use centraid_screens::testing::Driver;
use health_support::*;
use serde_json::json;
use wire::health_workout_state::Content as WorkoutContent;

/// 2026-03-02 12:00 UTC.
const SEEDED_AT_MS: i64 = 1_772_452_800_000;
const STARTS: &str = "2026-03-04T07:00:00Z";

fn driver_at(platform: &str, locale: &str) -> Driver {
    let mut d = Driver::with_runtime_clocked(
        health::runtime(),
        std::sync::Arc::new(centraid_vault::clock::FixedClock::at(SEEDED_AT_MS)),
    );
    d.call(wire::screen_request::Kind::Environment(wire::Environment {
        locale: locale.to_owned(),
        zone: "Europe/Berlin".to_owned(),
        platform: platform.to_owned(),
        ..Default::default()
    }));
    d.start();
    d
}

/// The member logged a 4 km run by hand; the watch then states the same run at 5 km.
fn adopted_run(d: &Driver, label: &str) -> String {
    arrange(
        d,
        act::health::LogWorkout {
            r#type: Some("run".to_owned()),
            starts: STARTS.to_owned(),
            distance_m: Some(4_000.0),
            moving_s: Some(1_800),
            ..Default::default()
        },
    );
    arrange(
        d,
        act::health::FollowWorkouts {
            origin: json!({ "ref": "store:apple-health", "label": label, "device_id": "phone-a" })
                .to_string(),
            records: json!([{ "external_id": "local:1", "device_id": "phone-a", "fields": {
                "kind": "run", "starts": STARTS, "ends": "2026-03-04T07:30:00Z",
                "workout": { "recorded_by": "Apple Watch", "moving_s": 1_800,
                             "distance_m": 5_000, "heart_bpm": 148 } } }])
            .to_string(),
            ..Default::default()
        },
    );
    match answer(
        d,
        centraid_screens::catalog::load::health::Workouts {
            limit: 10,
            ..Default::default()
        },
    ) {
        wire::app_query_response::Answer::HealthWorkouts(found) => {
            assert_eq!(found.workouts.len(), 1, "the run was adopted, not doubled");
            found.workouts[0].activity_id.clone()
        }
        other => panic!("{other:?}"),
    }
}

fn data(d: &Driver, page: u64) -> &wire::HealthWorkoutData {
    match &workout_state(d.view(page)).content {
        Some(WorkoutContent::Data(data)) => data,
        other => panic!("not a workout's data: {other:?}"),
    }
}

fn taken(d: &mut Driver, page: u64, line: &wire::PhoneSays) {
    d.send(
        page,
        wire::screen_event::Kind::PhoneSaysTaken(wire::PhoneSaysTaken {
            take: line.take.clone(),
        }),
    );
}

fn figure<'a>(data: &'a wire::HealthWorkoutData, label: &str) -> Option<(&'a str, &'a str)> {
    data.figures
        .iter()
        .find(|f| f.label == label)
        .map(|f| (f.value.as_str(), f.unit.as_str()))
}

#[test]
fn a_workout_whose_figures_agree_and_one_nothing_follows_show_no_line() {
    let mut d = driver_at("ios", "en-GB");
    // The store's own run, as stated: nothing differs.
    connect_store(&d);
    workout(&d, "w1", "run", STARTS, "2026-03-04T07:31:00Z");
    let id = match answer(
        &d,
        centraid_screens::catalog::load::health::Workouts {
            limit: 10,
            ..Default::default()
        },
    ) {
        wire::app_query_response::Answer::HealthWorkouts(found) => {
            found.workouts[0].activity_id.clone()
        }
        other => panic!("{other:?}"),
    };
    let page = d.push(health::TAB, routes::workout(&id, "Today"));
    assert!(data(&d, page).figures_phone_says.is_empty());
}

#[test]
fn a_figure_the_member_holds_differently_says_what_the_store_says_in_their_units() {
    let mut d = driver_at("ios", "en-GB");
    let id = adopted_run(&d, "Apple Health");
    let page = d.push(health::TAB, routes::workout(&id, "Today"));
    let shown = data(&d, page).clone();
    assert_eq!(
        figure(&shown, "Distance"),
        Some(("4.0", "km")),
        "the member's own figure is what is drawn"
    );
    let lines: Vec<(&str, &str, &str)> = shown
        .figures_phone_says
        .iter()
        .map(|l| {
            (
                l.lead.as_str(),
                l.action_label.as_str(),
                l.accessibility_label.as_str(),
            )
        })
        .collect();
    assert_eq!(
        lines,
        [(
            "Apple Health says 5.0 km",
            "Use Apple Health’s",
            "Use the distance Apple Health has, 5.0 km"
        )],
        "the heart rate the member left empty is filled by the store, so only the distance differs"
    );
    let take = shown.figures_phone_says[0].take.clone().expect("take");
    assert_eq!(
        (take.field.as_str(), take.item_key.as_deref()),
        ("workout", Some("distance_m"))
    );

    taken(&mut d, page, &shown.figures_phone_says[0]);
    let shown = data(&d, page);
    assert_eq!(figure(shown, "Distance"), Some(("5.0", "km")));
    assert!(shown.figures_phone_says.is_empty());
    assert!(workout_state(d.view(page)).status.is_none());
}

#[test]
fn the_store_is_named_as_the_phone_names_it_and_the_figure_in_the_members_units() {
    let mut d = driver_at("android", "en-US");
    let id = adopted_run(&d, "Health Connect");
    let page = d.push(health::TAB, routes::workout(&id, "Today"));
    let line = data(&d, page).figures_phone_says[0].clone();
    assert_eq!(line.lead, "Health Connect says 3.1 mi");
    assert_eq!(line.action_label, "Use Health Connect’s");
    assert_eq!(
        line.accessibility_label,
        "Use the distance Health Connect has, 3.1 mi"
    );
}

#[test]
fn a_refused_take_is_a_sentence_over_the_workout_as_it_still_is() {
    let mut d = driver_at("ios", "en-GB");
    let id = adopted_run(&d, "Apple Health");
    let page = d.push(health::TAB, routes::workout(&id, "Today"));
    let mut line = data(&d, page).figures_phone_says[0].clone();
    line.take.as_mut().expect("take").field = "no_such_field".to_owned();
    taken(&mut d, page, &line);
    let status = workout_state(d.view(page))
        .status
        .clone()
        .expect("a sentence");
    assert!(status.refused && !status.sentence.trim().is_empty());
    let shown = data(&d, page);
    assert_eq!(figure(shown, "Distance"), Some(("4.0", "km")));
    assert_eq!(shown.figures_phone_says.len(), 1);
}

#[test]
fn the_health_home_and_its_workout_list_carry_no_line() {
    let mut d = driver_at("ios", "en-GB");
    adopted_run(&d, "Apple Health");
    let root = root(&d);
    let drawn = format!("{:?}", d.view(root));
    band(&mut d, root, "workouts");
    let listed = format!("{:?}", d.view(root));
    for drawn in [drawn, listed] {
        assert!(!drawn.contains("Apple Health says") && !drawn.contains("Use Apple Health"));
    }
}
