//! Health's two read pages: one metric over a week, a month or a year
//! (`health.metric`), and one workout (`health.workout`).

mod health_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::load;
use centraid_screens::health::routes;
use centraid_screens::kit::civil;
use health_support::*;
use wire::app_query_response::Answer;
use wire::health_metric_event as me;
use wire::health_metric_state::Content as MetricContent;
use wire::health_workout_state::Content as WorkoutContent;

fn metric_data(v: &wire::ViewState) -> &wire::HealthMetricData {
    match &metric_state(v).content {
        Some(MetricContent::Data(data)) => data,
        other => panic!("the metric has no data: {other:?}"),
    }
}

#[test]
fn a_metric_is_the_weeks_bars_the_typical_line_and_its_facts() {
    let mut d = driver();
    let today = today(&d);
    connect_store(&d);
    // Six of the seven days have a row (the fifth back has none), and the 30 days
    // before today are what the typical is the median of.
    let mut days: Vec<(i64, &str, f64)> = (1..=30).map(|b| (b, "steps", 7_100.0)).collect();
    days.retain(|(back, ..)| ![1, 2, 3, 4, 5, 6].contains(back));
    days.extend([
        (0, "steps", 8_412.0),
        (1, "steps", 7_700.0),
        (2, "steps", 11_200.0),
        (3, "steps", 4_800.0),
        (5, "steps", 9_100.0),
        (6, "steps", 6_200.0),
    ]);
    record(&d, &today, &days);
    let i = push(&mut d, routes::metric("steps", "Health"));
    let state = metric_state(d.view(i));
    assert_eq!(state.chrome.as_ref().unwrap().title, "Steps");
    assert_eq!(state.chrome.as_ref().unwrap().back_label, "Health");
    let data = metric_data(d.view(i));
    let (first, last) = (day_back(&today, 6), today.clone());
    assert_eq!(
        data.caption,
        format!(
            "{} – {}",
            civil::dated(centraid_screens::strings::Locale::En, &first),
            civil::day_month(centraid_screens::strings::Locale::En, &last)
        )
    );
    // 47,412 over the six days that have a row: 7,902 a day.
    assert_eq!(data.average, "7,902");
    assert_eq!(data.average_unit, "a day");
    let has: Vec<bool> = data.bars.iter().map(|bar| bar.has_value).collect();
    assert_eq!(has, [true, true, false, true, true, true, true]);
    assert!(data.bars.last().unwrap().current);
    assert!(data.has_typical);
    assert_eq!(data.ticks.len(), 7);
    let facts: Vec<(&str, &str)> = data
        .facts
        .iter()
        .map(|fact| (fact.label.as_str(), fact.detail.as_str()))
        .collect();
    assert_eq!(facts[0].0, "Best day");
    assert!(facts[0].1.ends_with(" · 11,200"), "{facts:?}");
    assert_eq!(facts[1], ("Total", "47,412 steps"));
    assert_eq!(facts[2].0, "Days above typical");
    assert!(facts[2].1.ends_with(" of 6"), "{facts:?}");
    assert_eq!(data.foot, "Each day is the total Apple Health keeps.");
    assert!(
        data.versus.ends_with("above your typical"),
        "{}",
        data.versus
    );
    let keys: Vec<&str> = state.segments.iter().map(|s| s.key.as_str()).collect();
    assert_eq!(keys, ["week", "month", "year"]);
    // A range is a segment of the same page, and reads again.
    d.send(
        i,
        wire::screen_event::Kind::HealthMetric(wire::HealthMetricEvent {
            kind: Some(me::Kind::Range(me::RangePicked {
                key: "month".to_owned(),
            })),
        }),
    );
    assert_eq!(
        metric_state(d.view(i)).range,
        wire::HealthMetricRange::Month as i32
    );
    assert_eq!(metric_data(d.view(i)).caption, "Last 30 days");
}

#[test]
fn a_metric_with_no_row_in_the_period_says_so() {
    let mut d = driver();
    connect_store(&d);
    let i = push(&mut d, routes::metric("weight_kg", ""));
    let state = metric_state(d.view(i));
    assert_eq!(state.chrome.as_ref().unwrap().back_label, "Health");
    assert_eq!(
        metric_data(d.view(i)).empty.as_ref().unwrap().headline,
        "Nothing in this period."
    );
}

fn first_workout(d: &centraid_screens::testing::Driver) -> String {
    match answer(
        d,
        load::health::Workouts {
            limit: 10,
            ..Default::default()
        },
    ) {
        Answer::HealthWorkouts(found) => found.workouts[0].activity_id.clone(),
        other => panic!("{other:?}"),
    }
}

#[test]
fn a_workout_is_the_stores_figures_in_the_members_units_who_recorded_it_and_no_splits() {
    let mut d = driver();
    let today = today(&d);
    connect_store(&d);
    workout(
        &d,
        "w1",
        "run",
        &format!("{today}T09:00:00.000Z"),
        &format!("{today}T09:31:00.000Z"),
    );
    let id = first_workout(&d);
    let i = push(&mut d, routes::workout(&id, "Today"));
    let state = workout_state(d.view(i));
    assert_eq!(state.chrome.as_ref().unwrap().title, "Run");
    assert_eq!(state.chrome.as_ref().unwrap().back_label, "Today");
    let Some(WorkoutContent::Data(data)) = &state.content else {
        panic!("{:?}", state.content);
    };
    assert_eq!(data.title, "Morning run");
    assert!(data.when_label.contains(" to "), "{}", data.when_label);
    let figures: Vec<(&str, &str, &str)> = data
        .figures
        .iter()
        .map(|f| (f.label.as_str(), f.value.as_str(), f.unit.as_str()))
        .collect();
    assert_eq!(
        figures,
        [
            ("Distance", "5.2", "km"),
            ("Time", "31:04", ""),
            ("Average pace", "5:58", "/km"),
            ("Active energy", "338", "kcal"),
            ("Average heart rate", "148", "bpm"),
            ("Elevation gain", "42", "m"),
        ]
    );
    assert_eq!(
        data.foot,
        "Recorded by Apple Watch, read from Apple Health. Route and splits stay in Apple Health."
    );
}

#[test]
fn a_workout_that_is_gone_says_so() {
    let mut d = driver();
    connect_store(&d);
    let i = push(&mut d, routes::workout("no-such-workout", ""));
    let Some(WorkoutContent::Data(data)) = &workout_state(d.view(i)).content else {
        panic!("expected data");
    };
    assert_eq!(
        data.gone.as_ref().unwrap().headline,
        "This workout is no longer here."
    );
}
