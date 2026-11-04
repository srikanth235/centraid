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

/// Whether the call changed a row of the vault.
fn wrote(out: &Value) -> bool {
    out["effect"]["diff"]["rows"]
        .as_array()
        .is_some_and(|rows| !rows.is_empty())
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
fn chat_logs_what_the_member_did_and_leaves_to_the_store_what_the_store_states() {
    // this world's health rows are followed from a store (`seed.rs`): its workouts and its figures
    let world = seeded_with(&world_json());
    let mut session = world.strict_session();
    find(&mut session, json!({"kind": "workout"}));
    let followed = call(
        &mut session,
        "edit",
        json!({"rows": "#1", "args": "energy: 5"}),
    );
    let said = followed["text"].as_str().unwrap_or_default();
    assert!(
        said.contains("This workout comes from Health; change it there, not here."),
        "{followed}"
    );
    assert!(!wrote(&followed), "{followed}");
    let figures = find(&mut session, json!({"kind": "daily figure", "limit": 1}));
    let figure = ids(&figures["effect"]["rows"]).len();
    assert_eq!(figure, 1);
    let refused = call(
        &mut session,
        "edit",
        json!({"rows": figures["effect"]["result"], "args": "value: 9000"}),
    );
    let said = refused["text"].as_str().unwrap_or_default();
    assert!(
        said.contains("These figures come from Health; change them there, not here."),
        "{refused}"
    );
    assert!(!wrote(&refused), "{refused}");

    // a workout the member logs is theirs: logged, changed, deleted, restored
    session.user("log a swim");
    let made = call(
        &mut session,
        "create",
        json!({"kind": "workout", "args": "name: Swim\ndate: 2026-09-27\nmoving: 1800\ndistance: 1200"}),
    );
    assert!(wrote(&made), "{made}");
    session.user("make the swim 45 minutes");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "workout", "name": "Swim"}),
    );
    let handle = found["effect"]["result"]
        .as_str()
        .expect("the swim")
        .to_owned();
    let edited = call(
        &mut session,
        "edit",
        json!({"rows": handle, "args": "moving: 2700"}),
    );
    assert!(wrote(&edited), "{edited}");
    session.user("delete the swim");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "workout", "name": "Swim"}),
    );
    let handle = found["effect"]["result"].as_str().unwrap().to_owned();
    let deleted = call(
        &mut session,
        "do",
        json!({"verb": "delete", "rows": handle}),
    );
    assert!(wrote(&deleted), "{deleted}");
    session.user("bring it back");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "workout", "name": "Swim", "trashed": true}),
    );
    let handle = found["effect"]["result"].as_str().unwrap().to_owned();
    let restored = call(
        &mut session,
        "do",
        json!({"verb": "restore", "rows": handle}),
    );
    assert!(wrote(&restored), "{restored}");
}

#[test]
fn a_figure_is_edited_once_the_store_is_disconnected_and_undo_restores_it() {
    let world = seeded_with(&world_json());
    // the store the seed follows (`seed.rs`): disconnected, its figures are the member's
    world.elsewhere(
        "follow.stop",
        json!({"system": "health", "ref": "store:seed"}),
    );
    let mut session = world.strict_session();
    session.user("make yesterday's steps 9000");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "daily figure", "where": "metric = steps", "when": {"date": "2026-09-26"}}),
    );
    let handle = found["effect"]["result"]
        .as_str()
        .expect("the figure")
        .to_owned();
    let edited = call(
        &mut session,
        "edit",
        json!({"rows": handle, "args": "value: 9000"}),
    );
    assert!(wrote(&edited), "{edited}");
    session.user("undo that");
    let undone = call(&mut session, "do", json!({"verb": "undo"}));
    assert!(wrote(&undone), "{undone}");
    let again = find(
        &mut session,
        json!({"kind": "daily figure", "where": "metric = steps", "when": {"date": "2026-09-26"}}),
    );
    assert!(
        again["text"].as_str().unwrap_or_default().contains("8412"),
        "{again}"
    );
}

#[test]
fn the_patched_world_is_the_vaults_after_a_workout_is_logged_changed_deleted_and_restored() {
    use centraid_nativetools::park::Writes;
    let world = seeded_with(&world_json());
    let mut session = world.session_with(
        common::TODAY,
        centraid_nativetools::Flags {
            writes: Writes::Shadow,
            ..centraid_nativetools::Flags::default()
        },
    );
    session.user("log a swim");
    call(
        &mut session,
        "create",
        json!({"kind": "workout", "args": "name: Swim\ndate: 2026-09-27\nmoving: 1800"}),
    );
    for (message, tool, args) in [
        ("it was longer", "edit", json!({"args": "moving: 2700"})),
        ("delete it", "do", json!({"verb": "delete"})),
    ] {
        session.user(message);
        let found = call(
            &mut session,
            "find",
            json!({"kind": "workout", "name": "Swim"}),
        );
        let handle = found["effect"]["result"]
            .as_str()
            .expect("the swim")
            .to_owned();
        let mut args = args;
        args["rows"] = json!(handle);
        call(&mut session, tool, args);
    }
    session.user("bring it back");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "workout", "name": "Swim", "trashed": true}),
    );
    let handle = found["effect"]["result"]
        .as_str()
        .expect("the swim")
        .to_owned();
    call(
        &mut session,
        "do",
        json!({"verb": "restore", "rows": handle}),
    );
    let drift = session.take_drift();
    assert!(
        drift.is_empty(),
        "the patch parted from the vault:\n{}",
        drift.join("\n")
    );
}

#[test]
fn a_fraction_is_said_back_and_never_rounded_into_a_figure_the_member_did_not_state() {
    let world = seeded_with(&world_json());
    world.elsewhere(
        "follow.stop",
        json!({"system": "health", "ref": "store:seed"}),
    );
    let mut session = world.strict_session();
    session.user("my weight was 70.5");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "daily figure", "where": "metric = weight_kg"}),
    );
    let handle = found["effect"]["result"].as_str().unwrap().to_owned();
    let edited = call(
        &mut session,
        "edit",
        json!({"rows": handle, "args": "value: 70.5"}),
    );
    let said = edited["text"].as_str().unwrap_or_default();
    assert!(
        said.contains(
            "value is kept as a whole number here; 70.5 would be saved as 71. Say it as 71."
        ),
        "{edited}"
    );
    assert!(!wrote(&edited), "{edited}");
}

#[test]
fn a_parked_write_the_store_states_ends_in_its_sentence_with_nothing_to_tap() {
    use centraid_nativetools::park::Writes;
    let world = seeded_with(&world_json());
    let mut session = world.session_with(
        common::TODAY,
        centraid_nativetools::Flags {
            writes: Writes::Park,
            ..centraid_nativetools::Flags::default()
        },
    );
    find(&mut session, json!({"kind": "workout"}));
    let workout = call(
        &mut session,
        "edit",
        json!({"rows": "#1", "args": "energy: 5"}),
    );
    assert!(
        session.pending().is_none(),
        "a followed workout parked a card: {workout}"
    );
    assert!(
        workout["text"]
            .as_str()
            .unwrap_or_default()
            .contains("This workout comes from Health"),
        "{workout}"
    );
    let figures = find(&mut session, json!({"kind": "daily figure", "limit": 1}));
    let figure = figures["effect"]["result"].as_str().unwrap().to_owned();
    let refused = call(
        &mut session,
        "edit",
        json!({"rows": figure, "args": "value: 9000"}),
    );
    assert!(
        session.pending().is_none(),
        "a followed figure parked a card: {refused}"
    );
    assert!(
        refused["text"]
            .as_str()
            .unwrap_or_default()
            .contains("These figures come from Health"),
        "{refused}"
    );
    // what is the member's parks, and the tap lands it
    session.user("log a swim");
    let made = call(
        &mut session,
        "create",
        json!({"kind": "workout", "args": "name: Swim\ndate: 2026-09-27\nmoving: 1800"}),
    );
    assert!(session.pending().is_some(), "{made}");
}

#[test]
fn a_workout_is_logged_at_the_instant_it_was_on_the_members_clock() {
    let world = seeded_with(&world_json());
    let mut ny = world.session_in(common::TODAY, "America/New_York");
    ny.user("log a swim at seven yesterday morning");
    let made = call(
        &mut ny,
        "create",
        json!({"kind": "workout", "args": "name: Swim\ndate: {\"date\":\"2026-09-26\",\"time\":\"07:00\"}"}),
    );
    assert!(wrote(&made), "{made}");
    ny.user("when was the swim");
    let shown = text(&mut ny, "find", json!({"kind": "workout", "name": "Swim"}));
    assert!(
        shown.contains("2026-09-26 07:00"),
        "on their own clock: {shown}"
    );
    // the vault holds the instant: 07:00 in New York in September is 11:00 UTC
    let mut utc = world.session();
    utc.user("when was the swim");
    let kept = text(&mut utc, "find", json!({"kind": "workout", "name": "Swim"}));
    assert!(
        kept.contains("2026-09-26 11:00"),
        "kept as an instant: {kept}"
    );
}
