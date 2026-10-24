//! CONNECT (#1129): what Health may read, one switch a type, and the one Ink
//! button. It reads nothing from the vault: the member's choice is the phone's
//! (R-1129-6, like a followed folder's access), so the screen starts from what
//! this phone last kept ([`HealthFollow`]'s keychain habit, every type the first
//! time) and, at the tap, asks the shell to read the store with exactly those
//! types ([`wire::HealthRead`] with `ask_permission`). Active energy and exercise
//! are one switch, as the store's own sheet groups them. The OS is asked only
//! here, at the member's tap, for read types only (R-1129-7, R-1127-15).
//!
//! The same page is "What Health may read" for Health Connect's rationale: it
//! asks nothing until the member taps.

use centraid_api_proto::core_v1 as wire;
use wire::health_connect_event::Kind as C;
use wire::screen_event::Kind as E;

use super::follow::HealthFollow;
use super::{Metric, Store};
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, fill, health as words};

const CHOICE_STEPS: &str = "steps";
const CHOICE_SLEEP: &str = "sleep_min";
const CHOICE_ENERGY: &str = "energy";
const CHOICE_HEART: &str = "resting_hr_bpm";
const CHOICE_WEIGHT: &str = "weight_kg";
const CHOICE_WORKOUTS: &str = "workouts";

/// A switch → the type keys it stands for.
const KEYS: [(&str, &[&str]); 6] = [
    (CHOICE_STEPS, &["steps"]),
    (CHOICE_SLEEP, &["sleep_min"]),
    (CHOICE_ENERGY, &["active_energy_kcal", "exercise_min"]),
    (CHOICE_HEART, &["resting_hr_bpm"]),
    (CHOICE_WEIGHT, &["weight_kg"]),
    (CHOICE_WORKOUTS, &[Metric::WORKOUTS]),
];

#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    let Some(wire::route::Args::HealthConnect(args)) = &route.args else {
        return None;
    };
    Some(Box::new(Connect {
        parent: args.parent.clone(),
        on: KEYS.iter().map(|_| true).collect(),
        seeded: false,
        follow: HealthFollow::connecting(),
    }))
}

struct Connect {
    parent: String,
    /// One flag per [`KEYS`] switch.
    on: Vec<bool>,
    /// The switches have started from what this phone kept.
    seeded: bool,
    follow: HealthFollow,
}

impl Connect {
    /// What the member chose last time is what is on; nothing chosen yet is
    /// everything on.
    fn seed(&mut self) {
        if self.seeded || !self.follow.device().loaded {
            return;
        }
        self.seeded = true;
        let chosen = &self.follow.device().chosen;
        if chosen.is_empty() {
            return;
        }
        self.on = KEYS
            .iter()
            .map(|(_, keys)| keys.iter().any(|key| chosen.iter().any(|c| c == key)))
            .collect();
    }

    /// Every type key that is on, in order.
    fn chosen(&self) -> Vec<String> {
        KEYS.iter()
            .zip(&self.on)
            .filter(|(_, on)| **on)
            .flat_map(|((_, keys), _)| keys.iter().map(|key| (*key).to_owned()))
            .collect()
    }

    fn toggle(&mut self, key: &str) {
        if self.follow.working() {
            return;
        }
        if let Some(index) = KEYS.iter().position(|(name, _)| *name == key) {
            self.on[index] = !self.on[index];
            self.follow.clear_failure();
        }
    }

    fn tap(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        let chosen = self.chosen();
        if chosen.is_empty() || self.follow.working() {
            return Vec::new();
        }
        self.follow.connect(ctx, chosen)
    }
}

fn label(locale: Locale, key: &str) -> String {
    match key {
        CHOICE_STEPS => words::choice_steps(locale),
        CHOICE_SLEEP => words::choice_sleep(locale),
        CHOICE_ENERGY => words::choice_energy(locale),
        CHOICE_HEART => words::choice_heart(locale),
        CHOICE_WEIGHT => words::choice_weight(locale),
        _ => words::choice_workouts(locale),
    }
}

fn detail(locale: Locale, key: &str) -> String {
    match key {
        CHOICE_STEPS => words::choice_steps_detail(locale),
        CHOICE_SLEEP => words::choice_sleep_detail(locale),
        CHOICE_ENERGY => words::choice_energy_detail(locale),
        CHOICE_HEART => words::choice_heart_detail(locale),
        CHOICE_WEIGHT => words::choice_weight_detail(locale),
        _ => words::choice_workouts_detail(locale),
    }
}

impl Screen for Connect {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Appeared(_)) => self.follow.attach(),
            Some(E::HealthConnect(event)) => match event.kind {
                Some(C::Toggled(toggled)) => {
                    self.toggle(&toggled.key);
                    Vec::new()
                }
                Some(C::Connect(_)) => self.tap(ctx),
                None => Vec::new(),
            },
            Some(other) => {
                let effects = self.follow.on_event(&other, ctx).unwrap_or_default();
                self.seed();
                effects
            }
            None => Vec::new(),
        }
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        let locale = ctx.locale();
        let store = Store::of(ctx).name(locale);
        let chosen = self.chosen();
        let working = self.follow.working();
        let status = if let Some(failure) = self.follow.failure() {
            failure.to_owned()
        } else if working {
            fill(&words::connect_working_status(locale), &[("store", &store)])
        } else if chosen.is_empty() {
            words::connect_none_status(locale)
        } else {
            String::new()
        };
        wire::ViewState {
            kind: Some(wire::view_state::Kind::HealthConnect(
                wire::HealthConnectState {
                    chrome: Some(wire::HealthPageChrome {
                        title: words::connect_title(locale),
                        back_label: if self.parent.is_empty() {
                            words::app_title(locale)
                        } else {
                            self.parent.clone()
                        },
                        retry: words::retry(locale),
                    }),
                    headline: words::connect_headline(locale),
                    lede: fill(&words::connect_body(locale), &[("store", &store)]),
                    choices_title: words::reads_title(locale),
                    choices: KEYS
                        .iter()
                        .zip(&self.on)
                        .map(|((key, _), on)| wire::HealthChoice {
                            key: (*key).to_owned(),
                            label: label(locale, key),
                            detail: detail(locale, key),
                            on: *on,
                        })
                        .collect(),
                    note: format!(
                        "{} {}",
                        fill(&words::connect_note(locale), &[("store", &store)]),
                        words::connect_depth_note(locale)
                    ),
                    connect_label: fill(&words::connect_action(locale), &[("store", &store)]),
                    can_connect: !chosen.is_empty() && !working,
                    working,
                    status,
                    finished: self.follow.connected_now(),
                },
            )),
            ..wire::ViewState::default()
        }
    }
}
