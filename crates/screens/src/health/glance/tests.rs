//! The Health snapshot builder over fixtures the vault cannot make: a pinned day, so every figure,
//! label and refresh is exact. Nothing here reads a clock or asserts on time.

use centraid_api_proto::core_v1 as wire;
use serde_json::Value;

use super::snapshot::{
    self, Inputs, KEY_HOME, MAX_BYTES, MAX_FIGURES, VERSION, build, unavailable,
};
use crate::health::Units;
use crate::strings::Locale;

const TODAY: &str = "2026-11-07";

fn metric(which: wire::HealthMetric, value: Option<f64>, day: &str) -> wire::HealthTodayMetric {
    wire::HealthTodayMetric {
        metric: which as i32,
        value,
        day: Some(day.to_owned()),
        // What the document must never carry.
        typical: Some(7_000.0),
        low: Some(6_000.0),
        high: Some(8_000.0),
        ..Default::default()
    }
}

fn today(connected: bool, metrics: Vec<wire::HealthTodayMetric>) -> wire::HealthToday {
    wire::HealthToday {
        today: TODAY.to_owned(),
        metrics,
        connected,
        // What the document must never carry.
        workouts: vec![wire::HealthWorkoutRow {
            kind_label: "SECRET WORKOUT".to_owned(),
            ..Default::default()
        }],
        ..Default::default()
    }
}

fn day() -> Vec<wire::HealthTodayMetric> {
    vec![
        metric(wire::HealthMetric::Steps, Some(8_412.0), TODAY),
        metric(wire::HealthMetric::SleepMin, Some(432.0), TODAY),
        metric(wire::HealthMetric::ActiveEnergyKcal, Some(412.0), TODAY),
        metric(wire::HealthMetric::ExerciseMin, Some(38.0), TODAY),
        metric(wire::HealthMetric::RestingHrBpm, Some(58.0), TODAY),
    ]
}

fn document(today: &wire::HealthToday, units: Units) -> Value {
    let bytes = build(&Inputs {
        locale: Locale::En,
        zone: "Asia/Kolkata",
        units,
        today,
    });
    assert!(bytes.len() <= MAX_BYTES, "{} bytes", bytes.len());
    serde_json::from_slice(&bytes).expect("the document is JSON")
}

fn texts(document: &Value) -> Vec<String> {
    document["figures"]
        .as_array()
        .expect("figures")
        .iter()
        .map(|figure| figure["text"].as_str().expect("text").to_owned())
        .collect()
}

#[test]
fn a_day_with_figures_says_them_in_order_with_their_labels() {
    let doc = document(&today(true, day()), Units::Metric);
    assert_eq!(doc["version"], VERSION);
    assert_eq!(doc["state"], "ready");
    assert_eq!(doc["today"], TODAY);
    assert_eq!(doc["zone"], "Asia/Kolkata");
    assert_eq!(doc["open"], KEY_HOME);
    assert_eq!(texts(&doc), ["8,412", "7 h 12 min", "412 kcal", "38 min"]);
    let first = &doc["figures"][0];
    assert_eq!(first["metric"], "steps");
    assert_eq!(first["value"], "8,412");
    assert_eq!(first["unit"], "");
    assert_eq!(doc["figures"][2]["unit"], "kcal");
    assert_eq!(doc["sleep_line"], "Slept 7 h 12 min");
    assert_eq!(doc["words"]["steps_caption"], "steps today");
    assert_eq!(doc["words"]["title"], "Health");
}

#[test]
fn the_document_carries_figures_only() {
    let text = serde_json::to_string(&document(&today(true, day()), Units::Metric)).expect("text");
    for secret in ["SECRET", "typical", "7000", "workout", "bpm"] {
        assert!(!text.contains(secret), "{secret} is disclosed: {text}");
    }
    assert!(texts(&document(&today(true, day()), Units::Metric)).len() <= MAX_FIGURES);
}

#[test]
fn not_connected_is_its_own_quiet_state_with_no_figures() {
    let doc = document(&today(false, day()), Units::Metric);
    assert_eq!(doc["state"], "empty");
    assert_eq!(doc["words"]["empty"], "Connect Health to see today");
    assert!(doc["figures"].as_array().expect("figures").is_empty());
    assert_eq!(doc["refresh_after"], "", "an empty widget never goes stale");
}

#[test]
fn the_document_goes_stale_at_the_start_of_the_next_day() {
    let doc = document(&today(true, day()), Units::Metric);
    assert_eq!(doc["refresh_after"], "2026-11-08T00:00");
    assert_eq!(doc["words"]["stale"], "Not updated today");
    assert_eq!(doc["words"]["stale_hint"], "Open Centraid to refresh");
}

#[test]
fn a_figure_the_store_did_not_give_today_is_absent_never_a_zero() {
    let metrics = vec![
        metric(wire::HealthMetric::Steps, Some(8_412.0), TODAY),
        // Yesterday's, and a row with no value: neither is today's.
        metric(wire::HealthMetric::SleepMin, Some(432.0), "2026-11-06"),
        metric(wire::HealthMetric::ActiveEnergyKcal, None, TODAY),
    ];
    let doc = document(&today(true, metrics), Units::Metric);
    assert_eq!(texts(&doc), ["8,412"]);
    assert_eq!(doc["sleep_line"], "");
    let nothing = document(&today(true, Vec::new()), Units::Metric);
    assert_eq!(nothing["state"], "ready");
    assert!(nothing["figures"].as_array().expect("figures").is_empty());
    assert_eq!(nothing["words"]["nothing"], "Nothing yet today");
}

#[test]
fn weight_is_said_in_the_members_units() {
    let mut metrics = day();
    metrics.truncate(2);
    metrics.push(metric(wire::HealthMetric::WeightKg, Some(71.4), TODAY));
    let metric_doc = document(&today(true, metrics.clone()), Units::Metric);
    let imperial_doc = document(&today(true, metrics), Units::Imperial);
    assert_eq!(texts(&metric_doc), ["8,412", "7 h 12 min", "71.4 kg"]);
    assert_eq!(texts(&imperial_doc), ["8,412", "7 h 12 min", "157.4 lb"]);
    assert_eq!(imperial_doc["figures"][2]["value"], "157.4");
    assert_eq!(imperial_doc["figures"][2]["unit"], "lb");
}

#[test]
fn at_most_four_figures_are_drawn() {
    let mut metrics = day();
    metrics.push(metric(wire::HealthMetric::WeightKg, Some(71.4), TODAY));
    let doc = document(&today(true, metrics), Units::Metric);
    assert_eq!(texts(&doc).len(), MAX_FIGURES);
}

#[test]
fn unavailable_is_its_own_state_with_no_figures() {
    let doc: Value =
        serde_json::from_slice(&unavailable(Locale::En, "Asia/Kolkata")).expect("json");
    assert_eq!(doc["state"], "unavailable");
    assert_eq!(doc["words"]["unavailable"], "Open Centraid to see Health");
    assert!(doc["figures"].as_array().expect("figures").is_empty());
    assert_eq!(doc["refresh_after"], "");
}

#[test]
fn a_day_the_core_did_not_spell_is_unavailable_not_ready() {
    let mut broken = today(true, day());
    broken.today = String::new();
    assert_eq!(document(&broken, Units::Metric)["state"], "unavailable");
}

#[test]
fn the_same_answers_make_the_same_bytes() {
    let build_once = || {
        build(&Inputs {
            locale: Locale::En,
            zone: "Asia/Kolkata",
            units: Units::Metric,
            today: &today(true, day()),
        })
    };
    assert_eq!(build_once(), build_once());
    assert_eq!(snapshot::FILE, "health-glance.json");
}
