//! THE ONE MEASURE FORMATTER (#1185). A measured amount (a distance, a weight, a size on disk, a
//! span of time) is a [`Quantity`], and it is worded here and nowhere else, in the member's ONE
//! units switch ([`UnitsPref`]: metric or imperial, owner's ruling D13, never one switch per kind
//! of measure). Money has its own typed amount ([`super::money::Amount`]); this is the rest.
//!
//! A quantity holds its value in the family's canonical unit, so storage never depends on how it
//! is shown:
//!
//! | [`Unit`] | Canonical | Metric says | Imperial says |
//! |---|---|---|---|
//! | `Distance` | metres | `5.2 km` | `3.2 mi` |
//! | `Climb` | metres | `42 m` | `138 ft` |
//! | `Mass` | kilograms | `71.4 kg` | `157.4 lb` |
//! | `Pace` | seconds per kilometre | `6:00 /km` | `9:39 /mi` |
//! | `Energy` | kilocalories | `412 kcal` | the same |
//! | `Temperature` | degrees Celsius | `36.6 °C` | `97.9 °F` |
//! | `Volume` | millilitres | `250 ml`, `1.5 L` | `8.5 fl oz` |
//! | `Bytes` | bytes | `1.4 MB` | the same (bytes ignore the switch) |
//! | `BytesFloor` | bytes | `340 MB`, `4.9 GB` (rounded down) | the same |
//! | `Duration` | seconds | `7 h 12 min` | the same |
//! | `Span` | seconds | `1 h 06 min` | the same |
//! | `Minutes`, `Beats`, `Steps` | the count | `31 min`, `62 bpm`, `8,412` | the same |
//!
//! Every unit word lives in `strings::quantity`; the byte phrase is the vault's own
//! ([`centraid_vault::page::format_byte_size`]) so a size reads the same wherever a view of the
//! vault draws it.
//!
//! ## Which units a screen uses
//!
//! [`Ctx::units`](crate::screen::Ctx::units) is the effective switch: what the member chose
//! ([`stored`], kept on the phone under [`UNITS_KEY`]) or, when they never chose, what the phone's
//! region measures in ([`UnitsPref::of_region`]). Settings changes it with [`set_op`].

use centraid_api_proto::core_v1 as wire;
use centraid_vault::page::format_byte_size;

use crate::custody::secrets::VaultSecrets;
use crate::strings::{Locale, fill, quantity as words};

const KG_TO_LB: f64 = 2.204_622_621_8;
const M_PER_MI: f64 = 1_609.344;
const M_TO_FT: f64 = 3.280_839_895;
const KM_PER_MI: f64 = M_PER_MI / 1_000.0;
const ML_PER_FL_OZ: f64 = 29.573_529_562_5;
const ML_PER_L: f64 = 1_000.0;

/// The device-store key the member's choice is kept under (the same store the Keychain and
/// Keystore answer for, read once at open into [`VaultSecrets`]). Absent means "follow the phone's
/// region".
pub const UNITS_KEY: &str = "units";

/// The measurement system a member reads. Display only: a [`Quantity`] is stored canonically.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UnitsPref {
    Metric,
    Imperial,
}

impl UnitsPref {
    /// The system a region measures in: only the regions that use miles and pounds read as
    /// imperial.
    #[must_use]
    pub fn of_region(region: &str) -> Self {
        if matches!(region, "US" | "LR" | "MM") {
            Self::Imperial
        } else {
            Self::Metric
        }
    }

    /// What the device store holds for the choice.
    #[must_use]
    pub const fn stored(self) -> &'static str {
        match self {
            Self::Metric => "metric",
            Self::Imperial => "imperial",
        }
    }

    /// The choice a stored value names; anything else is no choice (follow the region).
    #[must_use]
    pub fn of_stored(stored: &str) -> Option<Self> {
        match stored.trim() {
            "metric" => Some(Self::Metric),
            "imperial" => Some(Self::Imperial),
            _ => None,
        }
    }
}

/// The member's stored choice, or `None` when they have not made one.
#[must_use]
pub fn stored(secrets: &VaultSecrets) -> Option<UnitsPref> {
    secrets
        .device_value(UNITS_KEY)
        .as_deref()
        .and_then(UnitsPref::of_stored)
}

/// What the screens use: the stored choice, else the region's.
#[must_use]
pub fn effective(stored: Option<UnitsPref>, region: &str) -> UnitsPref {
    stored.unwrap_or_else(|| UnitsPref::of_region(region))
}

/// THE SETTER. The op that keeps `pref`, or clears the choice (`None`: follow the region again).
/// Send it as a `Secrets` effect and fold the answer in with [`VaultSecrets::absorb`], so a read
/// after the write sees what the platform said it stored.
#[must_use]
pub fn set_op(pref: Option<UnitsPref>) -> wire::SecretOp {
    VaultSecrets::device_set(UNITS_KEY, pref.map_or("", UnitsPref::stored))
}

/// What a quantity measures, which is also the unit its value is held in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Unit {
    /// Metres; said in km or mi, a tenth kept.
    Distance,
    /// Metres of height gained; said in m or ft, whole.
    Climb,
    /// Kilograms; said in kg or lb, a tenth kept.
    Mass,
    /// Seconds per kilometre; said as a stopwatch per km or per mi.
    Pace,
    /// Kilocalories.
    Energy,
    /// Degrees Celsius; said in °C or °F, a tenth kept.
    Temperature,
    /// Millilitres; said in ml or L, or in fl oz.
    Volume,
    /// Bytes; the vault's phrase, whatever the switch.
    Bytes,
    /// Bytes said ROUNDED DOWN, never a byte more than there is: how much is backed up is a claim
    /// (#1144). Whole kilobytes and megabytes, a tenth of a gigabyte under a hundred, whole above.
    BytesFloor,
    /// Seconds, said as `7 h 12 min` (a night's sleep).
    Duration,
    /// Seconds, said as `1 h 06 min` (a workout).
    Span,
    /// Minutes as a count: `31 min`.
    Minutes,
    /// Heartbeats per minute: `62 bpm`.
    Beats,
    /// A count with no unit word: `8,412`.
    Steps,
}

/// A measured amount: a value in its unit's canonical form.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Quantity {
    pub value: f64,
    pub unit: Unit,
}

impl Quantity {
    #[must_use]
    pub const fn new(value: f64, unit: Unit) -> Self {
        Self { value, unit }
    }

    #[must_use]
    pub const fn distance_m(metres: f64) -> Self {
        Self::new(metres, Unit::Distance)
    }

    #[must_use]
    pub const fn climb_m(metres: f64) -> Self {
        Self::new(metres, Unit::Climb)
    }

    #[must_use]
    pub const fn mass_kg(kilograms: f64) -> Self {
        Self::new(kilograms, Unit::Mass)
    }

    /// Time per distance from a span and the distance it covered; `None` with nothing to divide by.
    #[must_use]
    pub fn pace(seconds: i64, metres: f64) -> Option<Self> {
        if metres <= 0.0 || seconds <= 0 {
            return None;
        }
        #[allow(clippy::cast_precision_loss)]
        let seconds = seconds as f64;
        Some(Self::new(seconds * 1_000.0 / metres, Unit::Pace))
    }

    #[must_use]
    pub const fn energy_kcal(kilocalories: f64) -> Self {
        Self::new(kilocalories, Unit::Energy)
    }

    #[must_use]
    pub const fn celsius(degrees: f64) -> Self {
        Self::new(degrees, Unit::Temperature)
    }

    #[must_use]
    pub const fn millilitres(ml: f64) -> Self {
        Self::new(ml, Unit::Volume)
    }

    #[must_use]
    #[allow(clippy::cast_precision_loss)]
    pub const fn bytes(count: i64) -> Self {
        Self::new(count as f64, Unit::Bytes)
    }

    /// A size that is a claim (what is backed up): said rounded down, never above the count.
    #[must_use]
    #[allow(clippy::cast_precision_loss)]
    pub const fn bytes_floor(count: u64) -> Self {
        Self::new(count as f64, Unit::BytesFloor)
    }

    /// A night's sleep (or any span said as hours and minutes), in seconds.
    #[must_use]
    pub const fn duration_s(seconds: f64) -> Self {
        Self::new(seconds, Unit::Duration)
    }

    /// A workout's span, in seconds.
    #[must_use]
    #[allow(clippy::cast_precision_loss)]
    pub const fn span_s(seconds: i64) -> Self {
        Self::new(seconds as f64, Unit::Span)
    }

    #[must_use]
    pub const fn minutes(count: f64) -> Self {
        Self::new(count, Unit::Minutes)
    }

    #[must_use]
    pub const fn beats(count: f64) -> Self {
        Self::new(count, Unit::Beats)
    }

    #[must_use]
    pub const fn steps(count: f64) -> Self {
        Self::new(count, Unit::Steps)
    }

    /// The number and its unit word, apart (`"5.2" "km"`, `"8,412" ""`, `"7 h 12 min" ""`), for a
    /// view that sets them in two styles.
    #[must_use]
    pub fn figure(&self, locale: Locale, pref: UnitsPref) -> (String, String) {
        let imperial = pref == UnitsPref::Imperial;
        let v = self.value;
        match self.unit {
            Unit::Distance if imperial => (tenths(v / M_PER_MI), words::unit_mi(locale)),
            Unit::Distance => (tenths(v / 1_000.0), words::unit_km(locale)),
            Unit::Climb if imperial => (grouped(round(v * M_TO_FT)), words::unit_ft(locale)),
            Unit::Climb => (grouped(round(v)), words::unit_m(locale)),
            Unit::Mass if imperial => (tenths(v * KG_TO_LB), words::unit_lb(locale)),
            Unit::Mass => (tenths(v), words::unit_kg(locale)),
            Unit::Pace if imperial => (stopwatch(round(v * KM_PER_MI)), words::unit_per_mi(locale)),
            Unit::Pace => (stopwatch(round(v)), words::unit_per_km(locale)),
            Unit::Energy => (grouped(round(v)), words::unit_kcal(locale)),
            Unit::Temperature if imperial => {
                (tenths(v * 9.0 / 5.0 + 32.0), words::unit_fahrenheit(locale))
            }
            Unit::Temperature => (tenths(v), words::unit_celsius(locale)),
            Unit::Volume if imperial => (tenths(v / ML_PER_FL_OZ), words::unit_fl_oz(locale)),
            Unit::Volume if v.abs() >= ML_PER_L => (tenths(v / ML_PER_L), words::unit_l(locale)),
            Unit::Volume => (grouped(round(v)), words::unit_ml(locale)),
            Unit::Bytes | Unit::BytesFloor => {
                let said = self.byte_phrase();
                match said.split_once(' ') {
                    Some((number, unit)) => (number.to_owned(), unit.to_owned()),
                    None => (said, String::new()),
                }
            }
            Unit::Duration => (hours_minutes(locale, v, false), String::new()),
            Unit::Span => (hours_minutes(locale, v, true), String::new()),
            Unit::Minutes => (grouped(round(v)), words::unit_min(locale)),
            Unit::Beats => (grouped(round(v)), words::unit_bpm(locale)),
            Unit::Steps => (grouped(round(v)), String::new()),
        }
    }

    /// The vault's phrase for a size, or the rounded-down one for a size that is a claim.
    fn byte_phrase(&self) -> String {
        if self.unit == Unit::BytesFloor {
            floor_byte_size(round(self.value))
        } else {
            format_byte_size(round(self.value))
        }
    }

    /// The amount as the words a member reads, in `pref`: `5.2 km`, `157.4 lb`, `1.4 MB`.
    #[must_use]
    pub fn words(&self, locale: Locale, pref: UnitsPref) -> String {
        if matches!(self.unit, Unit::Bytes | Unit::BytesFloor) {
            return self.byte_phrase();
        }
        let (number, unit) = self.figure(locale, pref);
        if unit.is_empty() {
            number
        } else {
            format!("{number} {unit}")
        }
    }
}

/// A size rounded DOWN: decimal, whole units, a tenth of a gigabyte under a hundred (`4.9 GB` and
/// `4 GB` are a phone's worth of photographs apart, #1144), and never a byte more than there is.
fn floor_byte_size(count: i64) -> String {
    const KB: i64 = 1_000;
    const MB: i64 = 1_000_000;
    const GB: i64 = 1_000_000_000;
    let count = count.max(0);
    match count {
        0..KB => format!("{count} bytes"),
        KB..MB => format!("{} KB", count / KB),
        MB..GB => format!("{} MB", count / MB),
        GB..=99_999_999_999 => {
            let tenths = count / (GB / 10);
            format!("{}.{} GB", tenths / 10, tenths % 10)
        }
        _ => format!("{} GB", count / GB),
    }
}

/// Kotlin's `roundToLong`: ties toward positive infinity.
pub(crate) fn round(value: f64) -> i64 {
    #[allow(clippy::cast_possible_truncation)]
    {
        (value + 0.5).floor() as i64
    }
}

/// `8412` as `8,412`.
#[must_use]
pub(crate) fn grouped(value: i64) -> String {
    let digits = value.unsigned_abs().to_string();
    let mut out = String::new();
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            out.push(',');
        }
        out.push(digit);
    }
    if value < 0 { format!("−{out}") } else { out }
}

/// One decimal, its zero kept: `71.4`, `5.0`, `1,204.3`.
#[must_use]
pub(crate) fn tenths(value: f64) -> String {
    let scaled = round(value.abs() * 10.0);
    let text = format!("{}.{}", grouped(scaled / 10), scaled % 10);
    if value < 0.0 && scaled != 0 {
        format!("−{text}")
    } else {
        text
    }
}

/// A stopwatch: `31:04`, `1:06:12`.
#[must_use]
pub(crate) fn stopwatch(seconds: i64) -> String {
    let s = seconds.max(0);
    let (hours, minutes, rest) = (s / 3_600, (s / 60) % 60, s % 60);
    if hours == 0 {
        format!("{minutes}:{rest:02}")
    } else {
        format!("{hours}:{minutes:02}:{rest:02}")
    }
}

/// Seconds as `7 h 12 min` (`padded` false) or `1 h 06 min` (`padded` true), or `48 min`.
fn hours_minutes(locale: Locale, seconds: f64, padded: bool) -> String {
    let total = round(seconds / 60.0).max(0);
    let (hours, rest) = (total / 60, total % 60);
    if hours == 0 {
        let template = if padded {
            words::span_minutes(locale)
        } else {
            words::duration_minutes(locale)
        };
        return fill(&template, &[("m", &rest.to_string())]);
    }
    let minutes = if padded {
        format!("{rest:02}")
    } else {
        rest.to_string()
    };
    let template = if padded {
        words::span_hours(locale)
    } else {
        words::duration_hours(locale)
    };
    fill(&template, &[("h", &hours.to_string()), ("m", &minutes)])
}

#[cfg(test)]
mod tests;
