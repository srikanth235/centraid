//! Health in the assistant (#1135, the owner's ruling of 2026-10-24): the read kinds `daily figure`
//! and `workout`, the 90 days the world holds, and that nothing here writes them.

mod common;

use common::{call, ids, seeded_with, text};
use serde_json::{Value, json};

/// Today is 2026-09-27: the window starts on 2026-06-29.
fn world_json() -> Value {
    json!({
        "me": "Sam Park", "epoch": "2026-01-05T09:00", "seed": "health",
        "health_days": [
            {"day": "2026-09-26", "metric": "steps", "value": 8412},
            {"day": "2026-09-25", "metric": "steps", "value": 4000},
            {"day": "2026-09-26", "metric": "sleep_min", "value": 432},
            {"day": "2026-09-26", "metric": "weight_kg", "value": 71.6},
            {"day": "2026-06-29", "metric": "steps", "value": 1000},
            {"day": "2026-06-28", "metric": "steps", "value": 999}
        ],
        "workouts": [
            {"key": "run", "kind": "run", "starts": "2026-09-26T07:00:00Z",
             "ends": "2026-09-26T07:41:00Z",
             "workout": {"moving_s": 2400, "distance_m": 8012.5, "energy_kcal": 412.0,
                         "heart_bpm": 151, "climb_m": 38.5}},
            {"key": "walk", "kind": "walk", "starts": "2026-09-20T17:30:00Z",
             "ends": "2026-09-20T18:10:00Z"},
            {"key": "old", "kind": "run", "starts": "2026-05-01T07:00:00Z",
             "ends": "2026-05-01T07:30:00Z"}
        ]
    })
}

fn find(session: &mut centraid_nativetools::Session, args: Value) -> Value {
    session.user("");
    call(session, "find", args)
}

#[test]
fn the_world_holds_ninety_days_of_figures_and_workouts_and_no_older_row() {
    let world = seeded_with(&world_json());
    let mut session = world.session();
    let figures = find(&mut session, json!({"kind": "daily figure", "limit": 50}));
    assert_eq!(
        ids(&figures["effect"]["rows"]).len(),
        5,
        "the 28 June row is out of the window: {figures}"
    );
    let workouts = find(&mut session, json!({"kind": "workout"}));
    let mut got = ids(&workouts["effect"]["rows"]);
    got.sort();
    let mut want = vec![world.id("run"), world.id("walk")];
    want.sort();
    assert_eq!(got, want, "the May run is out of the window: {workouts}");
}

#[test]
fn a_figure_reads_by_metric_and_sums_and_a_workout_carries_what_the_store_measured() {
    let world = seeded_with(&world_json());
    let mut session = world.session();
    let steps = find(
        &mut session,
        json!({"kind": "daily figure", "where": "metric = steps and value > 5000"}),
    );
    assert_eq!(ids(&steps["effect"]["rows"]).len(), 1, "{steps}");
    session.user("");
    let total = call(
        &mut session,
        "compute",
        json!({"op": "sum", "field": "value", "kind": "daily figure", "where": "metric = steps"}),
    );
    assert!(
        total["text"].as_str().unwrap_or_default().contains("13412"),
        "{total}"
    );
    let shown = text(
        &mut session,
        "find",
        json!({"kind": "workout", "where": "distance > 8000"}),
    );
    assert!(
        shown.contains("2400 s") && shown.contains("8013 m") && shown.contains("151 bpm"),
        "{shown}"
    );
}

#[test]
fn nothing_in_chat_writes_health() {
    let world = seeded_with(&world_json());
    let mut session = world.session();
    find(&mut session, json!({"kind": "workout"}));
    for args in [
        json!({"verb": "edit", "rows": "#1", "args": "energy: 5"}),
        json!({"verb": "delete", "rows": "#1"}),
        json!({"verb": "create", "kind": "workout", "args": "name: Swim"}),
    ] {
        let out = call(&mut session, "act", args.clone());
        let said = out["text"].as_str().unwrap_or_default();
        assert!(
            said.starts_with("error:")
                || said.contains("does not apply")
                || said.contains("applies to"),
            "{args}: {out}"
        );
        assert!(session.pending().is_none(), "{args} parked a write");
    }
}
