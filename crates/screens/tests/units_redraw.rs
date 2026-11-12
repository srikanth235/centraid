//! THE UNITS REACH EVERY OPEN SCREEN (#1185): the member changes Units in Settings with a Health
//! workout and its Earlier-versions page already open, and both say the new units at once, in the
//! words they were drawn in, without being opened again. `redraw_all` is the one path.

mod health_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::act;
use centraid_screens::field::Field;
use centraid_screens::health::routes;
use centraid_screens::shell;
use centraid_screens::testing::Driver;
use health_support::*;
use wire::screen_event::Kind as E;

const SEEDED_AT_MS: i64 = 1_772_452_800_000;

fn say(d: &Driver, instance: u64) -> String {
    format!("{:?}", d.view(instance))
}

fn answer_effect(
    d: &mut Driver,
    instance: u64,
    is: impl Fn(&wire::effect::Kind) -> bool,
    outcome: wire::effect_result::Outcome,
) {
    let at = d
        .effects
        .iter()
        .position(|request| {
            request.instance == instance
                && request
                    .effect
                    .as_ref()
                    .and_then(|e| e.kind.as_ref())
                    .is_some_and(&is)
        })
        .expect("the effect was asked");
    let request = d.effects.remove(at);
    d.send(
        instance,
        E::EffectResult(wire::EffectResult {
            effect_id: request.effect_id,
            outcome: Some(outcome),
        }),
    );
}

#[test]
fn changing_units_redraws_an_open_workout_and_its_earlier_versions() {
    let mut d = Driver::with_runtime_at(centraid_screens::standard(), SEEDED_AT_MS);
    d.call(wire::screen_request::Kind::Environment(wire::Environment {
        locale: "de-DE".to_owned(),
        zone: "Europe/Berlin".to_owned(),
        platform: "ios".to_owned(),
        ..Default::default()
    }));
    d.start();
    arrange(
        &d,
        act::health::LogWorkout {
            r#type: Some("run".to_owned()),
            starts: "2026-03-04T07:00:00Z".to_owned(),
            ends: Some("2026-03-04T07:30:00Z".to_owned()),
            distance_m: Some(4_000.0),
            moving_s: Some(1_800),
            ..Default::default()
        },
    );
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
    arrange(
        &d,
        act::health::EditWorkout {
            workout_id: id.clone(),
            distance_m: Field::Is(5_200.0),
            ..Default::default()
        },
    );

    let workout = d.push(shell::TAB, routes::workout(&id, "Health"));
    let entry = workout_state(d.view(workout))
        .earlier
        .clone()
        .expect("the earlier entry");
    let earlier = d.push(shell::TAB, entry.route.expect("a route"));
    let settings = d.push(shell::TAB, shell::routes::settings());
    answer_effect(
        &mut d,
        settings,
        |kind| matches!(kind, wire::effect::Kind::Keychain(op) if op.key == "appearance"),
        wire::effect_result::Outcome::Keychain(wire::KeychainValue {
            found: false,
            value: Vec::new(),
        }),
    );

    for (page, name) in [(workout, "the workout"), (earlier, "its earlier versions")] {
        let said = say(&d, page);
        assert!(said.contains("km"), "{name} says kilometres first: {said}");
        assert!(!said.contains("mi\""), "{name} says no miles yet: {said}");
    }

    d.send(
        settings,
        E::Settings(wire::SettingsEvent {
            kind: Some(wire::settings_event::Kind::UnitsPicked(
                wire::settings_event::UnitsPicked {
                    id: "imperial".to_owned(),
                },
            )),
        }),
    );
    answer_effect(
        &mut d,
        settings,
        |kind| matches!(kind, wire::effect::Kind::Secrets(batch) if batch.ops.iter().any(|op| op.key == "units")),
        wire::effect_result::Outcome::Secrets(wire::SecretBatched {
            answers: vec![wire::SecretAnswer {
                ok: true,
                ..Default::default()
            }],
        }),
    );

    for (page, name) in [(workout, "the workout"), (earlier, "its earlier versions")] {
        let said = say(&d, page);
        assert!(
            said.contains("mi\""),
            "{name} says miles after the pick: {said}"
        );
        assert!(
            !said.contains("km"),
            "{name} still says kilometres after the pick: {said}"
        );
    }
}
