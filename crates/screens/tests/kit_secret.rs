//! The kit's secret piece: a revealed value and a copied one, and what ends
//! each. The Locker screens (and chat's inline reveal, wave 4) share it.
//!
//! The bug these pin (#1135): on Android a revealed secret stayed on the
//! clipboard when the app was killed before the clear fired. The clear is now a
//! fact of the effect itself — `ClipboardSet` carries `sensitive` and
//! `clear_after_ms` — so the shell can persist the deadline and clear a stale
//! clip on its next launch, and the Rust timer clears it while the app lives.

use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::kit::secret::Secrets;
use centraid_screens::screen::{Ctx, Screen};
use centraid_screens::testing::Driver;
use centraid_screens::{Registry, Runtime};
use wire::screen_event::Kind as E;

const PROBE: &str = "probe.secret";
const COPY_AFTER: Duration = Duration::from_millis(40);
const SHOW_AFTER: Duration = Duration::from_millis(40);

/// A screen that does nothing but hold a [`Secrets`]: a counter tap copies,
/// the other event reveals.
struct Probe {
    secrets: Secrets,
    copy: &'static str,
}

impl Screen for Probe {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Counter(counter)) => match counter.kind {
                Some(wire::counter_event::Kind::CopyTapped(_)) => {
                    self.secrets.copy(ctx, self.copy, COPY_AFTER)
                }
                Some(wire::counter_event::Kind::RetryTapped(_)) => {
                    self.secrets.show(ctx, "password", "hunter2", SHOW_AFTER)
                }
                None => Vec::new(),
            },
            Some(E::TimerFired(fired)) => self.secrets.fired(&fired.timer),
            Some(E::EffectResult(result)) => {
                self.secrets.answered(ctx, &result);
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    fn view(&self, _ctx: &Ctx) -> wire::ViewState {
        // The shown value is the view's: `value` is what a shell would draw.
        let shown = self
            .secrets
            .value("password")
            .unwrap_or_default()
            .to_owned();
        wire::ViewState {
            kind: Some(wire::view_state::Kind::Counter(wire::CounterView {
                title: shown,
                content: None,
            })),
            ..wire::ViewState::default()
        }
    }
}

fn driver() -> Driver {
    let route = wire::Route {
        screen: PROBE.to_owned(),
        args: Some(wire::route::Args::Counter(wire::CounterRoute {})),
    };
    Driver::with_runtime(Runtime::new(
        Registry::default().with(PROBE, |_| {
            Some(Box::new(Probe {
                secrets: Secrets::default(),
                copy: "4111 1111 1111 1111",
            }) as Box<dyn Screen>)
        }),
        vec![("probe".to_owned(), route)],
    ))
}

fn instance(driver: &Driver) -> u64 {
    driver.navigation.as_ref().expect("navigation").tabs[0].entries[0].instance
}

fn tap_copy(driver: &mut Driver, id: u64) -> wire::ScreenUpdate {
    driver.send(
        id,
        E::Counter(wire::CounterEvent {
            kind: Some(wire::counter_event::Kind::CopyTapped(
                wire::CounterCopyTapped {},
            )),
        }),
    )
}

fn tap_show(driver: &mut Driver, id: u64) -> wire::ScreenUpdate {
    driver.send(
        id,
        E::Counter(wire::CounterEvent {
            kind: Some(wire::counter_event::Kind::RetryTapped(
                wire::CounterRetryTapped {},
            )),
        }),
    )
}

fn kinds(effects: &[wire::EffectRequest]) -> Vec<&wire::effect::Kind> {
    effects
        .iter()
        .filter_map(|request| request.effect.as_ref()?.kind.as_ref())
        .collect()
}

#[test]
fn a_copied_secret_is_sensitive_and_says_when_it_must_be_gone() {
    let mut driver = driver();
    driver.start();
    let id = instance(&driver);
    let update = tap_copy(&mut driver, id);
    let set = kinds(&update.effects)
        .into_iter()
        .find_map(|kind| match kind {
            wire::effect::Kind::ClipboardSet(set) => Some(set.clone()),
            _ => None,
        })
        .expect("a copy asks the shell to set the clipboard");
    assert_eq!(set.text, "4111 1111 1111 1111");
    assert!(set.sensitive, "a secret is kept out of clipboard history");
    // The deadline rides the effect, so a shell can keep it past a kill.
    assert_eq!(set.clear_after_ms, 40);
}

#[test]
fn the_timer_clears_what_it_set_and_only_that() {
    let mut driver = driver();
    driver.start();
    let id = instance(&driver);
    tap_copy(&mut driver, id);
    let before = driver.effects.len();
    driver.pump(Duration::from_millis(400));
    let clear = kinds(&driver.effects[before..])
        .into_iter()
        .find_map(|kind| match kind {
            wire::effect::Kind::ClipboardClear(clear) => Some(clear.clone()),
            _ => None,
        })
        .expect("the timer clears the clipboard");
    assert_eq!(clear.expected_text, "4111 1111 1111 1111");
}

#[test]
fn a_copy_the_shell_could_not_make_leaves_nothing_to_clear() {
    let mut driver = driver();
    driver.start();
    let id = instance(&driver);
    let update = tap_copy(&mut driver, id);
    let effect_id = update.effects[0].effect_id;
    driver.send(
        id,
        E::EffectResult(wire::EffectResult {
            effect_id,
            outcome: Some(wire::effect_result::Outcome::Failed(wire::EffectFailed {
                reason: "no clipboard".to_owned(),
                denied: false,
            })),
        }),
    );
    let before = driver.effects.len();
    driver.pump(Duration::from_millis(400));
    assert!(
        kinds(&driver.effects[before..])
            .into_iter()
            .all(|kind| !matches!(kind, wire::effect::Kind::ClipboardClear(_))),
        "nothing was copied, so nothing is cleared"
    );
}

#[test]
fn a_shown_value_raises_the_screenshot_shield_and_the_timer_hides_it() {
    let mut driver = driver();
    driver.start();
    let id = instance(&driver);
    let update = tap_show(&mut driver, id);
    let shield = kinds(&update.effects).into_iter().find_map(|kind| match kind {
        wire::effect::Kind::ScreenshotShield(shield) => Some(shield.on),
        _ => None,
    });
    assert_eq!(shield, Some(true));
    let shown = driver.views[&id].clone();
    let Some(wire::view_state::Kind::Counter(view)) = shown.kind else {
        panic!("the probe draws a counter");
    };
    assert_eq!(view.title, "hunter2");

    let before = driver.effects.len();
    driver.pump(Duration::from_millis(400));
    let dropped = kinds(&driver.effects[before..]).into_iter().find_map(|kind| match kind {
        wire::effect::Kind::ScreenshotShield(shield) => Some(shield.on),
        _ => None,
    });
    assert_eq!(dropped, Some(false), "the shield drops with the value");
    let Some(wire::view_state::Kind::Counter(view)) = driver.views[&id].kind.clone() else {
        panic!("the probe draws a counter");
    };
    assert!(view.title.is_empty(), "the value is gone from the view");
}
