//! Support for Health's tests: arranging the vault through the typed catalogue,
//! the phone's facts (platform, locale, zone) and the views the screens draw.
//! Every test goes through `Driver`, the door a shell uses.
#![allow(dead_code)]

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::{act, load};
use centraid_screens::field::Keyed;
use centraid_screens::health;
use centraid_screens::kit::act as kit_act;
use centraid_screens::kit::civil;
use centraid_screens::testing::Driver;
use wire::app_query_response::Answer;
use wire::screen_event::Kind as E;

/// A driver over Health's own runtime, on the platform and locale named.
pub fn driver_on(platform: &str, locale: &str) -> Driver {
    let mut driver = Driver::with_runtime(health::runtime());
    driver.call(wire::screen_request::Kind::Environment(wire::Environment {
        locale: locale.to_owned(),
        zone: "Europe/Berlin".to_owned(),
        platform: platform.to_owned(),
        ..Default::default()
    }));
    driver.start();
    driver
}

/// An iPhone in the metric world.
pub fn driver() -> Driver {
    driver_on("ios", "de-DE")
}

pub fn root(d: &Driver) -> u64 {
    d.navigation
        .as_ref()
        .and_then(|nav| nav.tabs.first())
        .and_then(|stack| stack.entries.first())
        .map(|entry| entry.instance)
        .expect("the tab has a root")
}

pub fn arrange(d: &Driver, request: impl Into<wire::ActRequest>) -> wire::ActResponse {
    let response = d.act(
        request
            .into()
            .keyed(format!("arrange:{}", kit_act::fresh())),
    );
    assert_eq!(
        response.status,
        wire::ActStatus::Executed as i32,
        "arranging was refused: {}",
        response.reason
    );
    response
}

pub fn answer(d: &Driver, request: impl Into<wire::LoadRequest>) -> Answer {
    let mut request = request.into();
    request.zone = "Europe/Berlin".to_owned();
    let answered = d
        .handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Load(Box::new(request))),
        })
        .expect("the load door answers");
    let Some(wire::response::Kind::Load(loaded)) = answered.kind else {
        panic!("a load answered {:?}", answered.kind);
    };
    loaded.answer.and_then(|a| a.answer).expect("an answer")
}

/// The vault clock's day in the driver's zone.
pub fn today(d: &Driver) -> String {
    match answer(d, load::health::Today {}) {
        Answer::HealthToday(today) => today.today,
        other => panic!("today answered {other:?}"),
    }
}

pub fn day_back(today: &str, days: i64) -> String {
    civil::plus_days(today, -days).expect("a real day")
}

/// Record `(days back, metric, value)` through the one write.
pub fn record(d: &Driver, today: &str, days: &[(i64, &str, f64)]) {
    let list: Vec<serde_json::Value> = days
        .iter()
        .map(|(back, metric, value)| {
            serde_json::json!({"day": day_back(today, *back), "metric": metric, "value": value})
        })
        .collect();
    arrange(
        d,
        act::health::RecordDays {
            days: serde_json::Value::Array(list).to_string(),
            person_id: None,
        },
    );
}

/// The store's origin, so Health reads as connected.
pub fn connect_store(d: &Driver) {
    arrange(
        d,
        act::health::FollowWorkouts {
            origin: serde_json::json!({
                "ref": "store:apple-health", "label": "Apple Health", "device_id": "phone-a"
            })
            .to_string(),
            records: "[]".to_owned(),
            ..Default::default()
        },
    );
}

/// One followed workout, started `hours` hours before midnight UTC of `today`.
pub fn workout(d: &Driver, id: &str, kind: &str, starts: &str, ends: &str) {
    arrange(
        d,
        act::health::FollowWorkouts {
            origin: serde_json::json!({
                "ref": "store:apple-health", "label": "Apple Health", "device_id": "phone-a"
            })
            .to_string(),
            records: serde_json::json!([{
                "external_id": format!("local:{id}"),
                "device_id": "phone-a",
                "fields": {
                    "kind": kind, "starts": starts, "ends": ends,
                    "workout": {
                        "recorded_by": "Apple Watch", "moving_s": 1864, "distance_m": 5200,
                        "energy_kcal": 338, "heart_bpm": 148, "climb_m": 42
                    }
                }
            }])
            .to_string(),
            ..Default::default()
        },
    );
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

pub fn home_event(d: &mut Driver, i: u64, kind: wire::health_home_event::Kind) {
    d.send(i, E::HealthHome(wire::HealthHomeEvent { kind: Some(kind) }));
}

pub fn band(d: &mut Driver, i: u64, key: &str) {
    home_event(
        d,
        i,
        wire::health_home_event::Kind::Band(wire::health_home_event::BandPicked {
            key: key.to_owned(),
        }),
    );
}

pub fn push(d: &mut Driver, route: wire::Route) -> u64 {
    d.push(health::TAB, route)
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

pub fn home_state(v: &wire::ViewState) -> &wire::HealthHomeState {
    match &v.kind {
        Some(wire::view_state::Kind::HealthHome(state)) => state,
        other => panic!("not Health's home: {other:?}"),
    }
}

pub fn home_data(v: &wire::ViewState) -> &wire::HealthHomeData {
    match &home_state(v).content {
        Some(wire::health_home_state::Content::Data(data)) => data,
        other => panic!("home has no data: {other:?}"),
    }
}

pub fn metric_state(v: &wire::ViewState) -> &wire::HealthMetricState {
    match &v.kind {
        Some(wire::view_state::Kind::HealthMetric(state)) => state,
        other => panic!("not a metric: {other:?}"),
    }
}

pub fn workout_state(v: &wire::ViewState) -> &wire::HealthWorkoutState {
    match &v.kind {
        Some(wire::view_state::Kind::HealthWorkout(state)) => state,
        other => panic!("not a workout: {other:?}"),
    }
}

pub fn connect_state(v: &wire::ViewState) -> &wire::HealthConnectState {
    match &v.kind {
        Some(wire::view_state::Kind::HealthConnect(state)) => state,
        other => panic!("not Connect: {other:?}"),
    }
}

/// The kind of the oldest pending effect.
pub fn pending(d: &Driver) -> &wire::effect::Kind {
    d.effects
        .first()
        .and_then(|request| request.effect.as_ref())
        .and_then(|effect| effect.kind.as_ref())
        .expect("an effect is pending")
}

/// A keychain answer carrying `value`.
pub fn keychain(value: &str) -> wire::effect_result::Outcome {
    wire::effect_result::Outcome::Keychain(wire::KeychainValue {
        found: true,
        value: value.as_bytes().to_vec(),
    })
}

/// Answer the oldest effect `instance` asked, whatever other screens have pending.
pub fn answer_for(d: &mut Driver, instance: u64, outcome: wire::effect_result::Outcome) {
    let at = d
        .effects
        .iter()
        .position(|request| request.instance == instance)
        .expect("that screen asked for an effect");
    let request = d.effects.remove(at);
    d.send(
        instance,
        E::EffectResult(wire::EffectResult {
            effect_id: request.effect_id,
            outcome: Some(outcome),
        }),
    );
}

/// The oldest effect `instance` asked.
pub fn pending_for(d: &Driver, instance: u64) -> &wire::effect::Kind {
    d.effects
        .iter()
        .find(|request| request.instance == instance)
        .and_then(|request| request.effect.as_ref())
        .and_then(|effect| effect.kind.as_ref())
        .expect("that screen has an effect pending")
}
