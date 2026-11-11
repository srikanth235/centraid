//! EARLIER VERSIONS of a workout (#1185): the entry at the foot of the page with its count (absent
//! at zero), the kit's one list with each version's figures in the member's units, Restore with no
//! confirm, Undo, and a change the health store's pass made reading "From Apple Health". Every test
//! goes through `Driver`, over a vault seeded at a fixed instant.

mod health_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::{act, load};
use centraid_screens::field::Field;
use centraid_screens::health::{self, routes};
use centraid_screens::testing::Driver;
use health_support::*;
use serde_json::json;

/// 2026-03-02 12:00 UTC.
const SEEDED_AT_MS: i64 = 1_772_452_800_000;
const STARTS: &str = "2026-03-04T07:00:00Z";

fn driver_in(region: &str) -> Driver {
    let mut d = Driver::with_runtime_at(health::runtime(), SEEDED_AT_MS);
    d.call(wire::screen_request::Kind::Environment(wire::Environment {
        locale: format!("en-{region}"),
        zone: "Europe/Berlin".to_owned(),
        platform: "ios".to_owned(),
        ..Default::default()
    }));
    d.start();
    d
}

fn the_workout(d: &Driver) -> String {
    match answer(
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
    }
}

fn edit(d: &Driver, id: &str, change: impl FnOnce(&mut act::health::EditWorkout)) {
    let mut request = act::health::EditWorkout {
        workout_id: id.to_owned(),
        ..Default::default()
    };
    change(&mut request);
    arrange(d, request);
}

/// A 4 km run in 30 minutes, then corrected to 5 km, then to 5.2 km in 31 minutes.
fn run(d: &Driver) -> String {
    arrange(
        d,
        act::health::LogWorkout {
            r#type: Some("run".to_owned()),
            starts: STARTS.to_owned(),
            ends: Some("2026-03-04T07:30:00Z".to_owned()),
            distance_m: Some(4_000.0),
            moving_s: Some(1_800),
            ..Default::default()
        },
    );
    let id = the_workout(d);
    edit(d, &id, |e| e.distance_m = Field::Is(5_000.0));
    edit(d, &id, |e| {
        e.distance_m = Field::Is(5_200.0);
        e.moving_s = Field::Is(1_860);
    });
    id
}

fn earlier_view(v: &wire::ViewState) -> &wire::EarlierView {
    match &v.kind {
        Some(wire::view_state::Kind::Earlier(view)) => view,
        other => panic!("not the earlier-versions screen: {other:?}"),
    }
}

fn rows(v: &wire::ViewState) -> &[wire::EarlierRow] {
    match &earlier_view(v).content {
        Some(wire::earlier_view::Content::Data(data)) => &data.rows,
        other => panic!("no data: {other:?}"),
    }
}

fn open_earlier(d: &mut Driver, id: &str) -> u64 {
    let page = d.push(health::TAB, routes::workout(id, "Today"));
    let entry = workout_state(d.view(page))
        .earlier
        .clone()
        .expect("the entry");
    d.push(health::TAB, entry.route.expect("a route"))
}

fn send(d: &mut Driver, i: u64, kind: wire::earlier_event::Kind) {
    d.send(
        i,
        wire::screen_event::Kind::Earlier(wire::EarlierEvent { kind: Some(kind) }),
    );
}

fn distance_of(d: &Driver, id: &str) -> f64 {
    match answer(
        d,
        load::health::Workout {
            activity_id: id.to_owned(),
        },
    ) {
        wire::app_query_response::Answer::HealthWorkout(w) => w
            .workout
            .expect("a workout")
            .distance_m
            .expect("a distance"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn the_page_offers_the_entry_with_the_count_only_once_there_is_something_earlier() {
    let mut d = driver_in("DE");
    arrange(
        &d,
        act::health::LogWorkout {
            r#type: Some("run".to_owned()),
            starts: STARTS.to_owned(),
            distance_m: Some(4_000.0),
            ..Default::default()
        },
    );
    let id = the_workout(&d);
    let page = d.push(health::TAB, routes::workout(&id, "Today"));
    assert!(workout_state(d.view(page)).earlier.is_none());
    d.pop(health::TAB, page);

    edit(&d, &id, |e| e.distance_m = Field::Is(5_000.0));
    edit(&d, &id, |e| e.distance_m = Field::Is(5_200.0));
    let page = d.push(health::TAB, routes::workout(&id, "Today"));
    let entry = workout_state(d.view(page))
        .earlier
        .clone()
        .expect("the entry");
    assert_eq!(entry.label, "Earlier versions");
    assert_eq!(entry.count_label, "2");
    assert_eq!(entry.accessibility_label, "Earlier versions, 2");
    let route = entry.route.expect("a route");
    assert_eq!(route.screen, health::EARLIER);
    let Some(wire::route::Args::Earlier(args)) = route.args else {
        panic!("the shared route");
    };
    assert_eq!(args.entity_id, id);
}

#[test]
fn the_list_is_the_current_figures_then_each_version_in_the_members_units() {
    let mut d = driver_in("DE");
    let id = run(&d);
    let i = open_earlier(&mut d, &id);
    let lines: Vec<String> = rows(d.view(i)).iter().map(|r| r.value.clone()).collect();
    assert_eq!(
        lines,
        ["5.2 km · 31:00", "5.0 km · 30:00", "4.0 km"],
        "current, then each version's changed figures"
    );
    assert!(rows(d.view(i))[0].current);

    // The same history on a US phone reads in miles.
    let mut us = driver_in("US");
    let id = run(&us);
    let i = open_earlier(&mut us, &id);
    let lines: Vec<String> = rows(us.view(i)).iter().map(|r| r.value.clone()).collect();
    assert_eq!(lines[1], "3.1 mi · 30:00");
}

#[test]
fn a_version_that_held_only_what_the_page_does_not_show_reads_as_other_details() {
    let mut d = driver_in("DE");
    let id = run(&d);
    edit(&d, &id, |e| e.title = Some("Parkrun".to_owned()));
    edit(&d, &id, |e| e.title = Some("Parkrun 2".to_owned()));
    let i = open_earlier(&mut d, &id);
    let lines: Vec<String> = rows(d.view(i)).iter().map(|r| r.value.clone()).collect();
    assert_eq!(lines[1], "Other details", "{lines:?}");
}

#[test]
fn restore_asks_nothing_says_so_with_undo_and_undo_puts_it_back() {
    let mut d = driver_in("DE");
    let id = run(&d);
    let i = open_earlier(&mut d, &id);
    let oldest = rows(d.view(i)).last().expect("a row").seq;
    send(
        &mut d,
        i,
        wire::earlier_event::Kind::Restore(wire::earlier_event::RestoreTapped { seq: oldest }),
    );
    assert!(
        (distance_of(&d, &id) - 4_000.0).abs() < 1e-6,
        "the field is back"
    );
    let status = earlier_view(d.view(i)).status.clone().expect("a status");
    assert_eq!(status.sentence, "Earlier version restored");
    assert_eq!(status.action_label, "Undo");

    send(
        &mut d,
        i,
        wire::earlier_event::Kind::StatusActed(wire::earlier_event::StatusActed {}),
    );
    assert!(
        (distance_of(&d, &id) - 5_200.0).abs() < 1e-6,
        "the restore is undone"
    );
}

#[test]
fn a_change_the_health_stores_pass_made_reads_as_coming_from_apple_health() {
    let mut d = driver_in("DE");
    let pass = |metres: u32| {
        arrange(
            &d,
            act::health::FollowWorkouts {
                origin: json!({ "ref": "store:apple-health", "label": "Apple Health", "device_id": "phone-a" })
                    .to_string(),
                records: json!([{ "external_id": "w:1", "device_id": "phone-a", "fields": {
                    "kind": "run", "starts": STARTS, "ends": "2026-03-04T07:30:00Z",
                    "workout": { "moving_s": 1_800, "distance_m": metres } } }])
                .to_string(),
                ..Default::default()
            },
        );
    };
    pass(5_000);
    pass(5_100);
    let id = the_workout(&d);
    let i = open_earlier(&mut d, &id);
    let listed = rows(d.view(i)).to_vec();
    assert_eq!(listed.len(), 2);
    assert!(
        listed[0].label.ends_with(" · From Apple Health"),
        "{}",
        listed[0].label
    );
    assert_eq!(listed[0].value, "5.1 km");
    assert_eq!(listed[1].value, "5.0 km");
    assert!(!listed[1].label.contains("From"));
}

#[test]
fn a_read_that_fails_is_the_failed_state_never_an_empty_list() {
    let mut d = Driver::unfounded(health::runtime());
    d.start();
    let route = centraid_screens::kit::earlier::route(health::EARLIER, "some-id", "Run");
    let i = d.push(health::TAB, route);
    assert!(matches!(
        earlier_view(d.view(i))
            .page
            .as_ref()
            .and_then(|page| page.state.as_ref()),
        Some(wire::page_state::State::Failed(_))
    ));
}

#[test]
fn a_followed_workout_says_its_store_and_a_logged_one_does_not() {
    let mut d = driver_in("DE");
    arrange(
        &d,
        act::health::FollowWorkouts {
            origin: json!({ "ref": "store:apple-health", "label": "Apple Health", "device_id": "phone-a" })
                .to_string(),
            records: json!([{ "external_id": "w:1", "device_id": "phone-a", "fields": {
                "kind": "run", "starts": STARTS, "ends": "2026-03-04T07:30:00Z",
                "workout": { "moving_s": 1_800, "distance_m": 5_000 } } }])
            .to_string(),
            ..Default::default()
        },
    );
    let id = the_workout(&d);
    let page = d.push(health::TAB, routes::workout(&id, "Today"));
    let line = workout_state(d.view(page)).origin.clone().expect("a line");
    assert_eq!(line.text, "From Apple Health");
    assert_eq!(line.accessibility_label, "Came from Apple Health");

    let mut typed = driver_in("DE");
    let id = run(&typed);
    let page = typed.push(health::TAB, routes::workout(&id, "Today"));
    assert_eq!(workout_state(typed.view(page)).origin, None);
}
