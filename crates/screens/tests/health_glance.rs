//! THE HEALTH GLANCE SERVICE, through the door a shell uses (#1185): the widget's snapshot is
//! asked for on start and on a change, is not asked for twice when nothing moved, says `empty`
//! until a store is connected, honours the phone's units, and a widget tap opens Health's home.
//! Effects are counted; nothing here measures time.

mod health_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::health;
use centraid_screens::testing::Driver;
use centraid_screens::{Registry, Runtime};
use health_support::*;
use serde_json::Value;
use wire::screen_event::Kind as E;

fn runtime() -> Runtime {
    Runtime::new(
        Registry::default().merge(health::registry()),
        vec![(
            health::TAB.to_owned(),
            health::routes::home(wire::HealthDestination::Today),
        )],
    )
    .with_services(health::glance::services())
}

/// The glance service is the first instance the runtime opens.
const SERVICE: u64 = 1;

fn driver_in(locale: &str) -> Driver {
    let mut d = Driver::with_runtime(runtime());
    d.call(wire::screen_request::Kind::Environment(wire::Environment {
        locale: locale.to_owned(),
        zone: "Europe/Berlin".to_owned(),
        platform: "ios".to_owned(),
        ..Default::default()
    }));
    d.start();
    d
}

/// Answer every pending snapshot write.
fn settle(d: &mut Driver) {
    while !documents(d).is_empty() {
        answer_glance(d, done());
    }
}

fn documents(d: &Driver) -> Vec<Value> {
    d.effects
        .iter()
        .filter_map(|request| match request.effect.as_ref()?.kind.as_ref()? {
            wire::effect::Kind::HealthGlance(glance) => {
                assert_eq!(glance.version, 1);
                assert_eq!(glance.file, "health-glance.json");
                Some(serde_json::from_slice(&glance.document).expect("the document is JSON"))
            }
            _ => None,
        })
        .collect()
}

fn done() -> wire::effect_result::Outcome {
    wire::effect_result::Outcome::Done(wire::EffectDone {})
}

/// Answer the oldest pending snapshot write, the way a shell does.
fn answer_glance(d: &mut Driver, outcome: wire::effect_result::Outcome) {
    let at = d
        .effects
        .iter()
        .position(|request| {
            matches!(
                request.effect.as_ref().and_then(|e| e.kind.as_ref()),
                Some(wire::effect::Kind::HealthGlance(_))
            )
        })
        .expect("a snapshot write is pending");
    let request = d.effects.remove(at);
    d.send(
        request.instance,
        E::EffectResult(wire::EffectResult {
            effect_id: request.effect_id,
            outcome: Some(outcome),
        }),
    );
}

fn changed() -> E {
    E::DataChanged(wire::DataChanged {
        tables: vec!["measurement".to_owned()],
    })
}

#[test]
fn the_snapshot_is_asked_for_on_start_and_not_again_when_nothing_changed() {
    let mut d = driver_in("en-US");
    // The phone's zone arrives with its environment, so the first document is rebuilt once.
    assert_eq!(documents(&d).len(), 2);
    assert_eq!(documents(&d)[1]["zone"], "Europe/Berlin");
    assert_eq!(documents(&d)[1]["state"], "empty", "no store is connected");
    settle(&mut d);
    d.send(SERVICE, changed());
    d.send(
        SERVICE,
        E::Lifecycle(wire::AppLifecycle { foreground: false }),
    );
    d.send(SERVICE, E::EnvironmentChanged(wire::EnvironmentChanged {}));
    assert!(documents(&d).is_empty(), "nothing moved, nothing was asked");
}

#[test]
fn a_recorded_day_asks_for_one_new_snapshot_in_the_phones_units() {
    let mut d = driver_in("en-US");
    settle(&mut d);
    let day = today(&d);
    connect_store(&d);
    record(
        &d,
        &day,
        &[
            (0, "steps", 8_412.0),
            (0, "sleep_min", 432.0),
            (0, "weight_kg", 71.4),
        ],
    );
    d.send(SERVICE, changed());
    let asked = documents(&d);
    assert_eq!(asked.len(), 1);
    assert_eq!(asked[0]["state"], "ready");
    let texts: Vec<&str> = asked[0]["figures"]
        .as_array()
        .expect("figures")
        .iter()
        .map(|figure| figure["text"].as_str().expect("text"))
        .collect();
    // en-US is the imperial region.
    assert_eq!(texts, ["8,412", "7 h 12 min", "157.4 lb"]);
    // Again, with nothing new: no second ask.
    answer_glance(&mut d, done());
    d.send(SERVICE, changed());
    assert!(documents(&d).is_empty());
}

#[test]
fn a_refused_write_is_sent_again_on_the_next_change() {
    let mut d = driver_in("en-US");
    answer_glance(
        &mut d,
        wire::effect_result::Outcome::Failed(wire::EffectFailed::default()),
    );
    answer_glance(&mut d, done());
    d.send(SERVICE, changed());
    assert_eq!(
        documents(&d).len(),
        1,
        "the refused document is asked again"
    );
}

#[test]
fn the_backup_ledger_alone_moves_nothing() {
    let mut d = driver_in("en-US");
    settle(&mut d);
    d.send(
        SERVICE,
        E::DataChanged(wire::DataChanged {
            tables: vec!["backup".to_owned()],
        }),
    );
    assert!(documents(&d).is_empty());
}

#[test]
fn a_widget_tap_opens_healths_home_whatever_its_key() {
    let mut d = driver_in("en-US");
    for key in ["home", "not-a-key", ""] {
        d.send(
            SERVICE,
            E::ShellFact(wire::ShellFact {
                fact: Some(wire::shell_fact::Fact::HealthIntent(wire::HealthIntent {
                    key: key.to_owned(),
                })),
            }),
        );
        let opened = d
            .effects
            .iter()
            .rev()
            .find_map(|request| match request.effect.as_ref()?.kind.as_ref()? {
                wire::effect::Kind::OpenRoute(open) => open.route.clone(),
                _ => None,
            })
            .expect("a route is opened");
        assert_eq!(opened.screen, health::HOME);
    }
}
