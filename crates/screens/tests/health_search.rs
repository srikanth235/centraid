//! HEALTH'S SEARCH PAGE and the Home groups it shares a search with (#1173, item 11): metrics are
//! found by their name and open that metric, workouts by their kind, and Home lists Health and
//! Money as groups of their own.

mod health_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::{act, load};
use centraid_screens::health;
use centraid_screens::shell;
use centraid_screens::testing::Driver;
use health_support::arrange;
use wire::home_search_event::Kind as S;
use wire::screen_event::Kind as E;

fn type_term(d: &mut Driver, i: u64, term: &str) {
    d.send(
        i,
        E::HomeSearch(wire::HomeSearchEvent {
            kind: Some(S::Term(wire::home_search_event::TermChanged {
                term: term.to_owned(),
            })),
        }),
    );
}

fn data(d: &Driver, i: u64) -> wire::HomeSearchData {
    match &d.view(i).kind {
        Some(wire::view_state::Kind::HomeSearch(state)) => match state.content.clone() {
            Some(wire::home_search_state::Content::Data(data)) => *data,
            other => panic!("not data: {other:?}"),
        },
        other => panic!("not a search: {other:?}"),
    }
}

fn log_a_run(d: &Driver) {
    arrange(
        d,
        act::health::LogWorkout {
            starts: "2026-03-04T07:00:00Z".to_owned(),
            r#type: Some("run".to_owned()),
            moving_s: Some(1800),
            distance_m: Some(5000.0),
            ..Default::default()
        },
    );
}

#[test]
fn health_search_finds_a_metric_by_its_name_a_workout_by_its_kind_and_nothing_else() {
    let mut d = Driver::with_runtime(health::runtime());
    d.start();
    log_a_run(&d);
    let i = d.push("health", health::routes::search());
    match &d.view(i).kind {
        Some(wire::view_state::Kind::HomeSearch(state)) => {
            let chrome = state.chrome.as_ref().unwrap();
            assert_eq!(chrome.placeholder, "Search Health");
            assert_eq!(chrome.scope_label, "Health");
        }
        other => panic!("not a search: {other:?}"),
    }
    type_term(&mut d, i, "sleep");
    let found = data(&d, i);
    assert_eq!(found.groups.len(), 1);
    assert_eq!(found.groups[0].app_id, "health");
    // THE ASK is Health's own: the assistant is asked in Health's scope, not across the vault.
    let ask = found.ask.clone().expect("an ask");
    assert_eq!(ask.scope, "health");
    assert_eq!(
        found.ask_route.as_ref().map(|route| route.screen.as_str()),
        ask.route.as_ref().map(|route| route.screen.as_str())
    );
    let metric = &found.groups[0].rows[0];
    assert_eq!(metric.kind_label, "Metric");
    assert_eq!(metric.route.as_ref().unwrap().screen, "health.metric");

    // The example scenario holds runs; they are found by their kind, and only Health's.
    type_term(&mut d, i, "run");
    let found = data(&d, i);
    assert!(
        found.groups.iter().all(|group| group.app_id == "health"),
        "a Health search shows Health alone"
    );
    // And by the date it was on, which no index holds.
    for term in ["4 March", "March 4", "2026-03-04", "march"] {
        type_term(&mut d, i, term);
        assert!(
            data(&d, i)
                .groups
                .iter()
                .flat_map(|group| group.rows.iter())
                .any(|row| row.kind_label == "Workout"),
            "{term} finds the run"
        );
    }
    type_term(&mut d, i, "5 March");
    assert!(
        data(&d, i)
            .groups
            .iter()
            .flat_map(|group| group.rows.iter())
            .all(|row| row.kind_label != "Workout"),
        "another day finds none"
    );
    assert!(
        found
            .groups
            .iter()
            .flat_map(|group| group.rows.iter())
            .any(|row| row.kind_label == "Workout"
                && row.route.as_ref().unwrap().screen == "health.workout"),
        "{found:?}"
    );
}

#[test]
fn home_lists_health_and_money_as_groups_of_their_own() {
    let mut d = Driver::with_runtime(shell::runtime());
    d.start();
    log_a_run(&d);
    let i = d.push("home", shell::routes::search());
    type_term(&mut d, i, "run");
    let found = data(&d, i);
    let health = found.groups.iter().find(|g| g.app_id == "health");
    assert!(health.is_some(), "workouts are Health's group: {found:?}");
    type_term(&mut d, i, "sleep");
    let found = data(&d, i);
    assert!(
        found
            .groups
            .iter()
            .any(|g| g.app_id == "health" && g.rows.iter().any(|r| r.kind_label == "Metric"))
    );
}

/// A WORKOUT RENAMED SINCE is found by the name it had, as the workout once, with the line that
/// says so, opening that workout's Earlier versions (#1185); by what it is called now it is the
/// ordinary row.
#[test]
fn health_search_finds_a_workout_by_an_earlier_name_and_opens_earlier_versions() {
    let mut d = Driver::with_runtime(health::runtime());
    d.start();
    arrange(
        &d,
        act::health::LogWorkout {
            starts: "2026-03-04T07:00:00Z".to_owned(),
            r#type: Some("run".to_owned()),
            title: Some("Zqquokka loop".to_owned()),
            moving_s: Some(1800),
            ..Default::default()
        },
    );
    let id = match health_support::answer(
        &d,
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
    arrange(
        &d,
        act::health::EditWorkout {
            workout_id: id.clone(),
            title: Some("Harbour run".to_owned()),
            ..Default::default()
        },
    );
    let i = d.push("health", health::routes::search());
    type_term(&mut d, i, "Zqquokka");
    let found = data(&d, i);
    let rows: Vec<&wire::HomeSearchRow> = found
        .groups
        .iter()
        .filter(|group| group.app_id == "health")
        .flat_map(|group| group.rows.iter())
        .collect();
    assert_eq!(rows.len(), 1, "{found:?}");
    let row = rows[0];
    assert_eq!(row.id, id);
    assert_eq!(row.title, "Harbour run", "the workout, not its old name");
    assert_eq!(row.earlier_label, "In an earlier version");
    assert!(row.accessibility_label.ends_with("In an earlier version"));
    let route = row.route.as_ref().expect("a route");
    assert_eq!(route.screen, health::EARLIER);
    let Some(wire::route::Args::Earlier(args)) = &route.args else {
        panic!("an earlier-versions route");
    };
    assert_eq!(args.entity_id, id);
    type_term(&mut d, i, "Harbour");
    let found = data(&d, i);
    let row = found
        .groups
        .iter()
        .flat_map(|group| group.rows.iter())
        .find(|row| row.id == id)
        .expect("found by its name now");
    assert!(row.earlier_label.is_empty());
    assert_eq!(row.route.as_ref().unwrap().screen, "health.workout");
}
