//! THE HEALTH WIDGET'S SNAPSHOT, as one pure function from what `health.today` answered to the
//! JSON document a shell keeps in its shared container.
//!
//! A widget cannot call the core and cannot format a word, so everything it draws is decided here
//! and finished in the device's locale and the member's units. The shells read this document and
//! draw it; they compute nothing from it except "has `refresh_after` passed", a comparison of two
//! civil strings.
//!
//! # PRIVACY OBLIGATION
//!
//! The builder reads Health's today and nothing else: **four daily figures and a weight weighed
//! today, never a workout, a route, a typical range, a trend or a heart reading.** The document
//! sits in a container the lock screen's widgets and the OS's indexers can reach, so a field added
//! here is a field disclosed. A new key is an owner's call, not a convenience.
//!
//! # Bounds, by construction
//!
//! At most [`MAX_FIGURES`] figures, each worded from a number by `kit::quantity`, so the document
//! is far below [`MAX_BYTES`]; no free text of the member's goes in.
//!
//! # Schema, version 1
//!
//! ```text
//! version, state ("ready" | "empty" | "unavailable"),
//! today (YYYY-MM-DD), zone,
//! refresh_after (local wall clock, YYYY-MM-DDTHH:MM, the next day's start; after it the widget
//!                shows words.stale and words.stale_hint instead of figures; "" unless ready),
//! open (the key a tap hands back),
//! words { title, empty, nothing, stale, stale_hint, unavailable, steps_caption },
//! figures [ {metric, label, value, unit, text} ]   (ready only, in the order below)
//! sleep_line ("Slept 7 h 12 min", or "")
//! ```
//!
//! - **`ready`**: a store is connected. `figures` holds, in this order, each of steps, sleep,
//!   active energy, exercise and weight that has a value FOR TODAY, at most [`MAX_FIGURES`]; a
//!   figure the store did not give is absent, never a zero. No figure at all draws `words.nothing`.
//!   `value` and `unit` are the number and its unit word apart (`"8,412" ""`, `"412" "kcal"`,
//!   `"72.4" "kg"`), `text` is them joined, `label` the metric's name. The small widget draws the
//!   first figure big with `words.steps_caption` when its `metric` is `"steps"`, and `sleep_line`.
//! - **`empty`**: no store is connected: `words.empty`.
//! - **`unavailable`**: nothing could be read (no vault in front, a failed read, a refusal):
//!   `words.unavailable`, never an empty healthy-looking widget.
//!
//! **Additive keys**: the schema grows by adding keys and keeps `version` 1; a reader tolerates a
//! key it does not know and a shell never requires a new one. A change that removes or retypes a
//! key is a new version.

use centraid_api_proto::core_v1 as wire;
use serde_json::{Map, Value, json};

use crate::health::figures;
use crate::health::{Metric, Units};
use crate::kit::civil;
use crate::strings::{Locale, fill, health_glance as words};

/// The document's schema version.
pub const VERSION: u32 = 1;
/// The file the document is kept in, in the shared container: one name for the writer and the
/// readers. Rust names it so a shell holds no constant for it.
pub const FILE: &str = "health-glance.json";
/// The most figures the document carries.
pub const MAX_FIGURES: usize = 4;
/// The most bytes the document may be.
pub const MAX_BYTES: usize = 4 * 1024;
/// The key that opens Health's home.
pub const KEY_HOME: &str = "home";

/// The metrics the widget may draw, in the order it draws them.
const SHOWN: [Metric; 5] = [
    Metric::Steps,
    Metric::Sleep,
    Metric::Energy,
    Metric::Exercise,
    Metric::Weight,
];

/// What the read answered, and how it is worded.
pub struct Inputs<'a> {
    pub locale: Locale,
    pub zone: &'a str,
    pub units: Units,
    pub today: &'a wire::HealthToday,
}

/// The document for what `health.today` answered.
#[must_use]
pub fn build(inputs: &Inputs) -> Vec<u8> {
    let today = inputs.today;
    if !today.connected {
        return document(inputs, "empty", &today.today, "", &[], "");
    }
    if civil::epoch_day_of(&today.today).is_none() {
        return unavailable(inputs.locale, inputs.zone);
    }
    let refresh_after = civil::plus_days(&today.today, 1)
        .map(|next| format!("{next}T00:00"))
        .unwrap_or_default();
    let value_of = |metric: Metric| {
        today
            .metrics
            .iter()
            .find(|row| Metric::of_wire(row.metric) == Some(metric))
            .filter(|row| row.day.as_deref() == Some(today.today.as_str()))
            .and_then(|row| row.value)
    };
    let figures: Vec<Value> = SHOWN
        .into_iter()
        .filter_map(|metric| {
            let (value, unit) =
                figures::measure(metric, value_of(metric)?).figure(inputs.locale, inputs.units);
            let text = if unit.is_empty() {
                value.clone()
            } else {
                format!("{value} {unit}")
            };
            Some(json!({
                "metric": metric.key(),
                "label": figures::label(inputs.locale, metric),
                "value": value,
                "unit": unit,
                "text": text,
            }))
        })
        .take(MAX_FIGURES)
        .collect();
    let sleep_line = value_of(Metric::Sleep)
        .map(|minutes| {
            let (duration, _) =
                figures::measure(Metric::Sleep, minutes).figure(inputs.locale, inputs.units);
            fill(&words::slept(inputs.locale), &[("duration", &duration)])
        })
        .unwrap_or_default();
    document(
        inputs,
        "ready",
        &today.today,
        &refresh_after,
        &figures,
        &sleep_line,
    )
}

/// The document for a day that could not be read: no vault in front, a failed read, or a vault
/// that refused. Never an empty `ready`.
#[must_use]
pub fn unavailable(locale: Locale, zone: &str) -> Vec<u8> {
    let empty = wire::HealthToday::default();
    document(
        &Inputs {
            locale,
            zone,
            units: Units::Metric,
            today: &empty,
        },
        "unavailable",
        "",
        "",
        &[],
        "",
    )
}

fn document(
    inputs: &Inputs,
    state: &str,
    today: &str,
    refresh_after: &str,
    figures: &[Value],
    sleep_line: &str,
) -> Vec<u8> {
    let locale = inputs.locale;
    let mut root = Map::new();
    root.insert("version".to_owned(), json!(VERSION));
    root.insert("state".to_owned(), json!(state));
    root.insert("today".to_owned(), json!(today));
    root.insert("zone".to_owned(), json!(inputs.zone));
    root.insert("refresh_after".to_owned(), json!(refresh_after));
    root.insert("open".to_owned(), json!(KEY_HOME));
    root.insert(
        "words".to_owned(),
        json!({
            "title": words::title(locale),
            "empty": words::empty(locale),
            "nothing": words::nothing(locale),
            "stale": words::stale(locale),
            "stale_hint": words::stale_hint(locale),
            "unavailable": words::unavailable(locale),
            "steps_caption": words::steps_caption(locale),
        }),
    );
    root.insert("figures".to_owned(), Value::Array(figures.to_vec()));
    root.insert("sleep_line".to_owned(), json!(sleep_line));
    serde_json::to_vec(&Value::Object(root)).unwrap_or_default()
}
