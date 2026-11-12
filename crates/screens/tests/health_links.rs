//! A workout's page and its "Linked to" section (#1185): what the workout is linked to from either
//! end, the picker over every kind but Locker, and the write through `health.link` / `unlink` with
//! its Undo. Over a real vault, through the door a shell uses; counts and values, no clocks.

mod health_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::load;
use centraid_screens::health::{self, routes};
use centraid_screens::testing::Driver;
use health_support::*;
use wire::app_query_response::Answer;
use wire::health_workout_event as we;
use wire::link_event::Kind as L;
use wire::link_event::{AddTapped, Picked, RemoveTapped};
use wire::screen_event::Kind as E;

/// Monday 9 November 2026, 09:00 UTC: the vault's clock for every test here.
const NOW: i64 = 1_794_214_800_000;

fn seeded() -> Driver {
    let mut driver = Driver::with_runtime_clocked(
        health::runtime(),
        std::sync::Arc::new(centraid_vault::clock::FixedClock::at(NOW)),
    );
    driver.call(wire::screen_request::Kind::Environment(wire::Environment {
        locale: "en-GB".to_owned(),
        zone: "Europe/Berlin".to_owned(),
        platform: "ios".to_owned(),
        ..Default::default()
    }));
    driver.start();
    connect_store(&driver);
    workout(
        &driver,
        "run",
        "run",
        "2026-11-08T06:40:00.000Z",
        "2026-11-08T07:11:00.000Z",
    );
    workout(
        &driver,
        "ride",
        "cycle",
        "2026-11-04T17:00:00.000Z",
        "2026-11-04T18:00:00.000Z",
    );
    driver
}

fn id_of(d: &Driver, kind: &str) -> String {
    match answer(
        d,
        load::health::Workouts {
            limit: 50,
            ..Default::default()
        },
    ) {
        Answer::HealthWorkouts(found) => found
            .workouts
            .into_iter()
            .find(|w| w.kind_key == kind)
            .map(|w| w.activity_id)
            .unwrap_or_else(|| panic!("no {kind} workout")),
        other => panic!("workouts answered {other:?}"),
    }
}

fn link(d: &mut Driver, page: u64, kind: L) {
    d.send(
        page,
        E::HealthWorkout(wire::HealthWorkoutEvent {
            kind: Some(we::Kind::Link(wire::LinkEvent { kind: Some(kind) })),
        }),
    );
}

fn rows(d: &Driver, page: u64) -> Vec<(String, String)> {
    let Some(wire::health_workout_state::Content::Data(data)) =
        &workout_state(d.view(page)).content
    else {
        panic!("workout data")
    };
    data.links
        .as_ref()
        .expect("the Linked to section")
        .rows
        .iter()
        .map(|row| (row.title.clone(), row.meta.clone()))
        .collect()
}

fn add(d: &mut Driver, page: u64, kind: &str, to: &str) {
    link(d, page, L::Add(AddTapped { key: "link".into() }));
    link(d, page, L::Pick(Picked { id: kind.into() }));
    link(d, page, L::Pick(Picked { id: to.into() }));
}

#[test]
fn the_page_lists_what_the_workout_is_linked_to_and_a_pick_links_through_health_link() {
    let mut d = seeded();
    let (run, ride) = (id_of(&d, "run"), id_of(&d, "cycle"));
    let page = push(&mut d, routes::workout(&run, "Health"));
    assert!(rows(&d, page).is_empty());
    let Some(wire::health_workout_state::Content::Data(data)) =
        &workout_state(d.view(page)).content
    else {
        panic!("workout data")
    };
    let section = data.links.clone().expect("section");
    assert_eq!(section.title, "Linked to");
    assert_eq!(section.empty, "Nothing linked yet");
    assert_eq!(section.adds.len(), 1, "one Add link row for many kinds");

    link(&mut d, page, L::Add(AddTapped { key: "link".into() }));
    let picker = workout_state(d.view(page))
        .link_picker
        .clone()
        .expect("chooser");
    assert!(picker.open);
    assert!(
        picker.candidates.iter().any(|row| row.id == "workout"),
        "a workout may link to another workout"
    );
    link(
        &mut d,
        page,
        L::Pick(Picked {
            id: "workout".into(),
        }),
    );
    let picker = workout_state(d.view(page))
        .link_picker
        .clone()
        .expect("workouts");
    assert!(picker.candidates.iter().any(|row| row.id == ride));
    assert!(
        picker.candidates.iter().all(|row| row.id != run),
        "a workout is never offered itself"
    );
    link(&mut d, page, L::Pick(Picked { id: ride.clone() }));

    let state = workout_state(d.view(page)).clone();
    assert!(state.link_picker.is_none_or(|picker| !picker.open));
    let status = state.status.expect("status");
    assert_eq!(status.sentence, "Linked");
    assert_eq!(status.action_label, "Undo");
    let linked = rows(&d, page);
    assert_eq!(linked.len(), 1);
    assert_eq!(linked[0].1, "Workout");

    // The link has no direction: the other workout's page lists this one.
    let there = push(&mut d, routes::workout(&ride, "Health"));
    assert_eq!(rows(&d, there).len(), 1);
}

#[test]
fn a_tap_on_remove_unlinks_and_undo_links_again() {
    let mut d = seeded();
    let (run, ride) = (id_of(&d, "run"), id_of(&d, "cycle"));
    let page = push(&mut d, routes::workout(&run, "Health"));
    add(&mut d, page, "workout", &ride);
    assert_eq!(rows(&d, page).len(), 1);

    link(&mut d, page, L::Remove(RemoveTapped { id: ride.clone() }));
    assert!(rows(&d, page).is_empty());
    let status = workout_state(d.view(page)).status.clone().expect("status");
    assert_eq!(status.sentence, "Link removed");
    assert_eq!(status.action_label, "Undo");

    d.send(page, E::StatusActed(wire::StatusActed {}));
    assert_eq!(rows(&d, page).len(), 1, "Undo puts the link back");
}
