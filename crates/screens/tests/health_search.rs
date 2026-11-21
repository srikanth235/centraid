//! HEALTH'S SEARCH, IN PLACE on its home (owner, 2026-11-19), and the Home groups it shares an
//! engine with (#1173, item 11): metrics are found by their name and open that metric, workouts
//! by their kind, and Home lists Health and Money as groups of their own.

mod health_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::{act, load};
use centraid_screens::health;
use centraid_screens::shell;
use centraid_screens::testing::Driver;
use health_support::{arrange, connect_store, driver_on, home_event, home_state, root};
use wire::health_home_event as he;
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

fn home_data(d: &Driver, i: u64) -> wire::HomeSearchData {
    match &d.view(i).kind {
        Some(wire::view_state::Kind::HomeSearch(state)) => match state.content.clone() {
            Some(wire::home_search_state::Content::Data(data)) => *data,
            other => panic!("not data: {other:?}"),
        },
        other => panic!("not a search: {other:?}"),
    }
}

/// A connected Health home with its search field open.
fn open_home() -> (Driver, u64) {
    let mut d = driver_on("ios", "en-US");
    connect_store(&d);
    let i = root(&d);
    // The store is connected now: read the home again so its search key is drawn.
    home_event(&mut d, i, he::Kind::Refreshed(he::Refreshed {}));
    home_event(&mut d, i, he::Kind::SearchOpened(he::SearchOpened {}));
    (d, i)
}

fn type_in_place(d: &mut Driver, i: u64, term: &str) {
    home_event(
        d,
        i,
        he::Kind::SearchTerm(he::SearchTermChanged {
            term: term.to_owned(),
        }),
    );
}

/// The answer in the open field, once the page is ready.
fn data(d: &Driver, i: u64) -> wire::HomeSearchData {
    home_state(d.view(i))
        .search
        .as_ref()
        .and_then(|field| field.results.clone())
        .unwrap_or_else(|| panic!("no answer: {:?}", d.view(i)))
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
    let (mut d, i) = open_home();
    log_a_run(&d);
    // THE KEY IS A PLACEHOLDER AND A CLOSE LABEL, never a route: Health searches in place.
    let state = home_state(d.view(i));
    assert_eq!(
        state.chrome.as_ref().unwrap().search_placeholder,
        "Search Health"
    );
    assert_eq!(state.chrome.as_ref().unwrap().search_close, "Close search");
    let field = state.search.as_ref().unwrap();
    assert!(field.open && field.results.is_none());
    assert_eq!(field.hint, "Search by metric, workout kind or date.");
    type_in_place(&mut d, i, "sleep");
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
    type_in_place(&mut d, i, "run");
    let found = data(&d, i);
    assert!(
        found.groups.iter().all(|group| group.app_id == "health"),
        "a Health search shows Health alone"
    );
    // And by the date it was on, which no index holds.
    for term in ["4 March", "March 4", "2026-03-04", "march"] {
        type_in_place(&mut d, i, term);
        assert!(
            data(&d, i)
                .groups
                .iter()
                .flat_map(|group| group.rows.iter())
                .any(|row| row.kind_label.starts_with("Workout · ")),
            "{term} finds the run"
        );
    }
    // Another day finds none: the page's own empty state, and no workout row.
    type_in_place(&mut d, i, "5 March");
    let state = home_state(d.view(i));
    assert!(state.search.as_ref().unwrap().results.is_none());
    assert!(matches!(
        state.page.as_ref().unwrap().state,
        Some(wire::page_state::State::Empty(_))
    ));
    assert!(
        found
            .groups
            .iter()
            .flat_map(|group| group.rows.iter())
            .any(|row| row.kind_label.starts_with("Workout")
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
    let found = home_data(&d, i);
    let health = found.groups.iter().find(|g| g.app_id == "health");
    assert!(health.is_some(), "workouts are Health's group: {found:?}");
    type_term(&mut d, i, "sleep");
    let found = home_data(&d, i);
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
    let (mut d, i) = open_home();
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
    type_in_place(&mut d, i, "Zqquokka");
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
    type_in_place(&mut d, i, "Harbour");
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

/// CLOSING THE FIELD brings the tab back; a term that matches nothing is the page's own empty
/// state, with the Ask row still offered, and the first read after closing starts clean.
#[test]
fn closing_the_field_brings_the_tab_back_and_a_term_with_no_match_still_offers_the_ask() {
    let (mut d, i) = open_home();
    log_a_run(&d);
    // Open: the tab's content gives way, and the filter and range chips with it.
    let state = home_state(d.view(i));
    assert!(state.content.is_none() && state.segments.is_empty() && state.filter_menu.is_none());
    type_in_place(&mut d, i, "zzzqx");
    let state = home_state(d.view(i));
    let field = state.search.as_ref().unwrap();
    assert!(field.results.is_none() && field.term == "zzzqx");
    assert_eq!(field.ask.as_ref().unwrap().scope, "health");
    let Some(wire::page_state::State::Empty(empty)) = state.page.as_ref().unwrap().state.clone()
    else {
        panic!("not empty: {:?}", state.page);
    };
    assert_eq!(empty.body, "Nothing in Health matches “zzzqx”.");
    type_in_place(&mut d, i, "run");
    assert_eq!(data(&d, i).ask.unwrap().scope, "health");
    home_event(&mut d, i, he::Kind::SearchClosed(he::SearchClosed {}));
    let state = home_state(d.view(i));
    let field = state.search.as_ref().unwrap();
    assert!(!field.open && field.term.is_empty() && field.results.is_none());
    assert!(state.content.is_some(), "the tab is back");
}
