//! HEALTH'S EARLIER VERSIONS: the kit's one earlier-versions screen with Health's spec (#1185).
//!
//! A workout keeps its figures (distance, time, active energy, average heart rate, elevation gain)
//! and when it started and ended. A version's line is the ones it held, as the workout page words
//! them and in the member's units: `Tue 4 March, 07:00 to 07:30 · 5 km · 30:00 · 148 bpm`. What the
//! page does not show (the kind, the place, who recorded it, the title) has no words; a version that
//! changed only those reads "Other details".

use centraid_api_proto::core_v1 as wire;
use centraid_vault::time::{FireZone, parse_civil_ms};

use super::{Metric, denied, figures};
use crate::kit::civil;
use crate::kit::earlier::{self, EarlierSpec, Field, Look};
use crate::kit::quantity::Quantity;
use crate::screen::Screen;
use crate::strings::{fill, health as words, shared};

/// Health's earlier versions, as the kit's screen takes it.
pub static SPEC: EarlierSpec = EarlierSpec {
    app: "health",
    noun: shared::trash_noun_workout,
    denied,
    parts,
    know: None,
    gate: None,
};

#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    earlier::build(&SPEC, route)
}

/// A stored instant as the phone's wall clock: `2026-03-04T08:00`.
fn local(look: &Look, stored: &str) -> Option<String> {
    if !stored.ends_with('Z') {
        return stored.get(..16).map(str::to_owned);
    }
    let zone = FireZone::named(look.zone).ok()?;
    let at = zone.zoned_parts(parse_civil_ms(stored, &zone)?);
    Some(format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}",
        at.year, at.month, at.day, at.hour, at.minute
    ))
}

/// The one line a workout's fields read as.
fn parts(look: &Look, fields: &[Field]) -> Vec<String> {
    let locale = look.locale;
    let units = look.units;
    let named = |name: &str| fields.iter().find(|field| field.name == name);
    let moment = |name: &str| {
        named(name)
            .and_then(|field| field.value.as_str())
            .and_then(|stored| local(look, stored))
    };
    let real =
        |column: &str| named(&format!("workout.{column}")).and_then(|field| field.value.as_f64());
    let when = match (moment("activity.starts"), moment("activity.ends")) {
        (Some(start), Some(end)) => Some(fill(
            &words::workout_when(locale),
            &[
                (
                    "day",
                    &civil::day_month(locale, start.get(..10).unwrap_or_default()),
                ),
                ("start", &civil::clock_for(locale, &start, look.cycle)),
                ("end", &civil::clock_for(locale, &end, look.cycle)),
            ],
        )),
        (Some(start), None) => Some(format!(
            "{}, {}",
            civil::day_month(locale, start.get(..10).unwrap_or_default()),
            civil::clock_for(locale, &start, look.cycle)
        )),
        (None, Some(end)) => Some(civil::clock_for(locale, &end, look.cycle)),
        (None, None) => None,
    };
    [
        when,
        real("distance_m")
            .filter(|metres| *metres > 0.0)
            .map(|metres| Quantity::distance_m(metres).words(locale, units)),
        real("moving_s").map(|seconds| figures::stopwatch(seconds.round() as i64)),
        real("energy_kcal").map(|kcal| figures::measure(Metric::Energy, kcal).words(locale, units)),
        real("heart_bpm").map(|bpm| format!("{} {}", bpm.round(), words::unit_bpm(locale))),
        real("climb_m").map(|metres| Quantity::climb_m(metres).words(locale, units)),
    ]
    .into_iter()
    .flatten()
    .collect()
}
