//! HEALTH'S WORDS FOR A FIGURE (#1129). Every figure here is the core's
//! (R-1129-12); this only FORMATS it in the member's units, which are the
//! phone's and never the vault's. Pure: no clock, every input handed in.

use centraid_api_proto::core_v1 as wire;

use super::{Metric, Units, kinds};
use crate::kit::civil;
use crate::strings::{Locale, fill, health as words};

pub const BP: u32 = 10_000;
const KG_TO_LB: f64 = 2.204_622_621_8;
const M_PER_MI: f64 = 1_609.344;
const M_TO_FT: f64 = 3.280_839_895;
const WEEK_BACK: i64 = 6;
/// The mark a kind with none of its own takes.
pub const WORKOUT_ICON: &str = "Gym";

/// Kotlin's `roundToLong`: ties toward positive infinity.
fn round(value: f64) -> i64 {
    #[allow(clippy::cast_possible_truncation)]
    {
        (value + 0.5).floor() as i64
    }
}

/// `8412` as `8,412`.
#[must_use]
pub fn grouped(value: i64) -> String {
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

/// A metric's name.
#[must_use]
pub fn label(locale: Locale, metric: Metric) -> String {
    match metric {
        Metric::Steps => words::metric_steps(locale),
        Metric::Sleep => words::metric_sleep(locale),
        Metric::Energy => words::metric_energy(locale),
        Metric::Exercise => words::metric_exercise(locale),
        Metric::RestingHr => words::metric_resting_hr(locale),
        Metric::Weight => words::metric_weight(locale),
    }
}

/// A figure and its unit word, apart: `"8,412" ""`, `"7 h 12 m" ""`,
/// `"412" "kcal"`, `"157.4" "lb"`.
#[must_use]
pub fn figure(locale: Locale, metric: Metric, value: f64, units: Units) -> (String, String) {
    match metric {
        Metric::Steps => (grouped(round(value)), String::new()),
        Metric::Sleep => (duration(locale, value), String::new()),
        Metric::Energy => (grouped(round(value)), words::unit_kcal(locale)),
        Metric::Exercise => (grouped(round(value)), words::unit_min(locale)),
        Metric::RestingHr => (grouped(round(value)), words::unit_bpm(locale)),
        Metric::Weight => match units {
            Units::Metric => (tenths(value), words::unit_kg(locale)),
            Units::Imperial => (tenths(value * KG_TO_LB), words::unit_lb(locale)),
        },
    }
}

/// A figure with its unit, as one phrase: `8,412`, `412 kcal`.
#[must_use]
pub fn phrase(locale: Locale, metric: Metric, value: f64, units: Units) -> String {
    let (number, unit) = figure(locale, metric, value, units);
    if unit.is_empty() {
        number
    } else {
        format!("{number} {unit}")
    }
}

/// Minutes asleep as `7 h 12 m`, or `48 m`.
#[must_use]
pub fn duration(locale: Locale, minutes: f64) -> String {
    let total = round(minutes).max(0);
    let (hours, rest) = (total / 60, total % 60);
    if hours == 0 {
        fill(
            &words::duration_minutes(locale),
            &[("m", &rest.to_string())],
        )
    } else {
        fill(
            &words::duration_hours(locale),
            &[("h", &hours.to_string()), ("m", &rest.to_string())],
        )
    }
}

/// A workout's span as `31 min` or `1 h 06 min`.
#[must_use]
pub fn span(locale: Locale, seconds: i64) -> String {
    let minutes = (seconds + 30) / 60;
    let (hours, rest) = (minutes / 60, minutes % 60);
    if hours == 0 {
        fill(&words::span_minutes(locale), &[("m", &rest.to_string())])
    } else {
        fill(
            &words::span_hours(locale),
            &[("h", &hours.to_string()), ("m", &format!("{rest:02}"))],
        )
    }
}

/// A stopwatch: `31:04`, `1:06:12`.
#[must_use]
pub fn stopwatch(seconds: i64) -> String {
    let s = seconds.max(0);
    let (hours, minutes, rest) = (s / 3_600, (s / 60) % 60, s % 60);
    if hours == 0 {
        format!("{minutes}:{rest:02}")
    } else {
        format!("{hours}:{minutes:02}:{rest:02}")
    }
}

/// A distance in metres as `5.2` and `km` (or `mi`).
#[must_use]
pub fn distance(locale: Locale, metres: f64, units: Units) -> (String, String) {
    match units {
        Units::Metric => (tenths(metres / 1_000.0), words::unit_km(locale)),
        Units::Imperial => (tenths(metres / M_PER_MI), words::unit_mi(locale)),
    }
}

/// A climb in metres as `42` and `m` (or `ft`).
#[must_use]
pub fn climb(locale: Locale, metres: f64, units: Units) -> (String, String) {
    match units {
        Units::Metric => (grouped(round(metres)), words::unit_m(locale)),
        Units::Imperial => (grouped(round(metres * M_TO_FT)), words::unit_ft(locale)),
    }
}

/// Time per kilometre (or mile) as `6:00` and `/km`, or `None` with no distance
/// to divide by.
#[must_use]
pub fn pace(locale: Locale, seconds: i64, metres: f64, units: Units) -> Option<(String, String)> {
    if metres <= 0.0 || seconds <= 0 {
        return None;
    }
    #[allow(clippy::cast_precision_loss)]
    let seconds = seconds as f64;
    Some(match units {
        Units::Metric => (
            stopwatch(round(seconds * 1_000.0 / metres)),
            words::unit_per_km(locale),
        ),
        Units::Imperial => (
            stopwatch(round(seconds * M_PER_MI / metres)),
            words::unit_per_mi(locale),
        ),
    })
}

/// One decimal, its zero kept: `71.4`, `5.0`, `1,204.3`.
#[must_use]
pub fn tenths(value: f64) -> String {
    let scaled = round(value.abs() * 10.0);
    let text = format!("{}.{}", grouped(scaled / 10), scaled % 10);
    if value < 0.0 && scaled != 0 {
        format!("−{text}")
    } else {
        text
    }
}

/// THE CORE'S DIFFERENCE OF TWO FIGURES, IN WORDS, and its sign (−1, 0, 1):
/// `change` in the metric's unit, `pct` as a percentage (`health.proto`; the core
/// subtracts, RP-K-6). Steps and active energy say the percentage; minutes,
/// beats and kilograms say themselves (`+12 min`). Empty when the core sent
/// none; zero when it rounds to nothing in the words it would be said in.
#[must_use]
pub fn delta(
    locale: Locale,
    metric: Metric,
    change: Option<f64>,
    pct: Option<f64>,
    units: Units,
) -> (String, i32) {
    let percent = matches!(metric, Metric::Steps | Metric::Energy);
    let Some(signed) = (if percent { pct } else { change }) else {
        return (String::new(), 0);
    };
    let (magnitude, words_) = if percent {
        let p = round(signed);
        (p.abs(), format!("{}%", p.abs()))
    } else {
        match metric {
            Metric::Sleep | Metric::Exercise => {
                let n = round(signed).abs();
                (n, format!("{n} {}", words::unit_min(locale)))
            }
            Metric::RestingHr => {
                let n = round(signed).abs();
                (n, format!("{n} {}", words::unit_bpm(locale)))
            }
            _ => {
                let (number, unit) = figure(locale, Metric::Weight, signed.abs(), units);
                let empty = number.trim_start_matches(['0', '.']).is_empty();
                (i64::from(!empty), format!("{number} {unit}"))
            }
        }
    };
    let sign = if magnitude == 0 {
        0
    } else if signed > 0.0 {
        1
    } else {
        -1
    };
    match sign {
        0 => (words_, 0),
        1 => (format!("+{words_}"), 1),
        _ => (format!("−{words_}"), -1),
    }
}

/// A bar's length: `value` over `scale`, in basis points, clamped.
#[must_use]
pub fn bp(value: f64, scale: f64) -> u32 {
    if scale <= 0.0 {
        return 0;
    }
    let scaled = round(value / scale * f64::from(BP)).clamp(0, i64::from(BP));
    u32::try_from(scaled).unwrap_or(BP)
}

/// A drawing scale a little past `top`, rounded to two significant figures, so
/// the bar's end is a round number.
#[must_use]
pub fn scale_over(top: f64) -> f64 {
    if top <= 0.0 {
        return 1.0;
    }
    let raw = top * 1.25;
    let mut unit = 1.0;
    while raw / unit >= 100.0 {
        unit *= 10.0;
    }
    (raw / unit).ceil() * unit
}

/// A kind key's word: `Run`; one the seed does not name is a plain `Workout`.
#[must_use]
pub fn kind_word(locale: Locale, key: &str) -> String {
    match key {
        kinds::RUN => words::kind_run(locale),
        kinds::WALK => words::kind_walk(locale),
        kinds::CYCLE => words::kind_cycle(locale),
        kinds::STRENGTH => words::kind_strength(locale),
        kinds::SWIM => words::kind_swim(locale),
        kinds::HIKE => words::kind_hike(locale),
        kinds::YOGA => words::kind_yoga(locale),
        _ => words::kind_other(locale),
    }
}

/// A kind key's chip: `Runs`; one the seed does not name is the vault's own
/// label for it.
#[must_use]
pub fn kind_chip(locale: Locale, key: &str, label: &str) -> String {
    match key {
        kinds::RUN => words::chip_run(locale),
        kinds::WALK => words::chip_walk(locale),
        kinds::CYCLE => words::chip_cycle(locale),
        kinds::STRENGTH => words::chip_strength(locale),
        kinds::SWIM => words::chip_swim(locale),
        kinds::HIKE => words::chip_hike(locale),
        kinds::YOGA => words::chip_yoga(locale),
        kinds::OTHER => words::chip_other(locale),
        _ if label.is_empty() => words::chip_other(locale),
        _ => label.to_owned(),
    }
}

/// "Morning run": the kind and the part of the day it started in, on the
/// phone's clock (`HH:MM`).
#[must_use]
pub fn title(locale: Locale, kind: &str, clock: &str) -> String {
    let Some(hour) = clock.get(..2).and_then(|hour| hour.parse::<u32>().ok()) else {
        return kind_word(locale, kind);
    };
    let part = match hour {
        5..=11 => words::part_morning(locale),
        12..=16 => words::part_afternoon(locale),
        17..=21 => words::part_evening(locale),
        _ => words::part_night(locale),
    };
    fill(&part, &[("kind", &kind_word(locale, kind).to_lowercase())])
}

/// `11 Oct`.
#[must_use]
pub fn short_date(locale: Locale, day: &str) -> String {
    let month = day
        .get(5..7)
        .and_then(|digits| digits.parse().ok())
        .map(|month| civil::month_name(locale, month));
    let dom = day.get(8..).and_then(|digits| digits.parse::<u32>().ok());
    match (month, dom) {
        (Some(month), Some(dom)) if !month.is_empty() => {
            format!("{dom} {}", month.chars().take(3).collect::<String>())
        }
        _ => day.to_owned(),
    }
}

/// `October`, or `September 2025` outside `today`'s year.
#[must_use]
pub fn month_heading(locale: Locale, day: &str, today: &str) -> String {
    let month = civil::month_of(locale, day);
    if month.is_empty() {
        return day.to_owned();
    }
    if day.get(..4) == today.get(..4) {
        month
    } else {
        format!("{month} {}", day.get(..4).unwrap_or_default())
    }
}

/// A KIND'S MARK, from the icon registry (`packages/design/src/icons.ts`), so a
/// list of runs, rides and swims is not one glyph repeated. The registry has no
/// runner, cyclist or mountain: each kind takes the nearest mark it does have,
/// and a kind with none takes [`WORKOUT_ICON`].
#[must_use]
pub fn kind_icon(key: &str) -> &'static str {
    match key {
        kinds::RUN => "Activity",
        kinds::WALK => "MapPin",
        kinds::CYCLE => "Compass",
        kinds::SWIM => "Water",
        kinds::HIKE => "Plant",
        kinds::YOGA => "Mood",
        _ => WORKOUT_ICON,
    }
}

/// One workout as a list draws it, on the wall clock the core read its start on.
#[must_use]
pub fn line(
    locale: Locale,
    row: &wire::HealthWorkoutRow,
    today: &str,
    units: Units,
    parent: &str,
) -> wire::HealthWorkoutLine {
    let local = &row.local_start;
    let day = local.get(..10).unwrap_or_default();
    let clock = civil::clock(local);
    let meta = [
        row.distance_m.filter(|metres| *metres > 0.0).map(|metres| {
            let (n, u) = distance(locale, metres, units);
            format!("{n} {u}")
        }),
        (row.length_sec > 0).then(|| span(locale, row.length_sec)),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" · ");
    let week = civil::plus_days(today, -WEEK_BACK).unwrap_or_else(|| today.to_owned());
    let when = if day.is_empty() {
        String::new()
    } else if day == today {
        clock.clone()
    } else if day >= week.as_str() && civil::epoch_day_of(day).is_some() {
        civil::weekday_short(locale, day)
    } else {
        short_date(locale, day)
    };
    let title = title(locale, &row.kind_key, &clock);
    wire::HealthWorkoutLine {
        activity_id: row.activity_id.clone(),
        accessibility_label: [title.as_str(), meta.as_str(), when.as_str()]
            .iter()
            .filter(|part| !part.is_empty())
            .copied()
            .collect::<Vec<_>>()
            .join(", "),
        title,
        meta,
        when_label: when,
        icon_key: kind_icon(&row.kind_key).to_owned(),
        route: Some(super::routes::workout(&row.activity_id, parent)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EN: Locale = Locale::En;

    #[test]
    fn digits_group_by_thousands() {
        assert_eq!(grouped(0), "0");
        assert_eq!(grouped(999), "999");
        assert_eq!(grouped(8_412), "8,412");
        assert_eq!(grouped(1_204_300), "1,204,300");
        assert_eq!(grouped(-1_204), "−1,204");
    }

    #[test]
    fn a_figure_is_its_number_and_its_unit_in_the_phones_system() {
        let m = Units::Metric;
        assert_eq!(
            figure(EN, Metric::Steps, 8_412.4, m),
            ("8,412".into(), String::new())
        );
        assert_eq!(figure(EN, Metric::Sleep, 432.0, m).0, "7 h 12 m");
        assert_eq!(
            figure(EN, Metric::Energy, 412.0, m),
            ("412".into(), "kcal".into())
        );
        assert_eq!(
            figure(EN, Metric::Weight, 71.4, m),
            ("71.4".into(), "kg".into())
        );
        assert_eq!(
            figure(EN, Metric::Weight, 71.4, Units::Imperial),
            ("157.4".into(), "lb".into())
        );
        assert_eq!(duration(EN, 48.0), "48 m");
    }

    #[test]
    fn a_span_is_minutes_or_hours_and_a_stopwatch_is_clock_time() {
        assert_eq!(span(EN, 1_864), "31 min");
        assert_eq!(span(EN, 3_600), "1 h 00 min");
        assert_eq!(span(EN, 3_960), "1 h 06 min");
        assert_eq!(stopwatch(1_864), "31:04");
        assert_eq!(stopwatch(3_972), "1:06:12");
    }

    #[test]
    fn distance_climb_and_pace_follow_the_units() {
        assert_eq!(
            distance(EN, 5_200.0, Units::Metric),
            ("5.2".into(), "km".into())
        );
        assert_eq!(
            distance(EN, 5_200.0, Units::Imperial),
            ("3.2".into(), "mi".into())
        );
        assert_eq!(climb(EN, 42.0, Units::Metric), ("42".into(), "m".into()));
        assert_eq!(
            climb(EN, 42.0, Units::Imperial),
            ("138".into(), "ft".into())
        );
        assert_eq!(
            pace(EN, 1_864, 5_200.0, Units::Metric),
            Some(("5:58".into(), "/km".into()))
        );
        assert_eq!(pace(EN, 1_864, 0.0, Units::Metric), None);
    }

    #[test]
    fn a_delta_says_percent_for_counts_and_the_unit_for_the_rest() {
        let m = Units::Metric;
        assert_eq!(
            delta(EN, Metric::Steps, Some(280.0), Some(3.98), m),
            ("+4%".into(), 1)
        );
        assert_eq!(
            delta(EN, Metric::Exercise, Some(5.0), None, m),
            ("+5 min".into(), 1)
        );
        assert_eq!(
            delta(EN, Metric::RestingHr, Some(-0.2), None, m),
            ("0 bpm".into(), 0)
        );
        assert_eq!(delta(EN, Metric::Sleep, None, None, m), (String::new(), 0));
        assert_eq!(
            delta(EN, Metric::Sleep, Some(-12.0), None, m),
            ("−12 min".into(), -1)
        );
        assert_eq!(
            delta(EN, Metric::Weight, Some(0.04), None, m),
            ("0.0 kg".into(), 0)
        );
        assert_eq!(
            delta(EN, Metric::Weight, Some(-0.6), None, m),
            ("−0.6 kg".into(), -1)
        );
    }

    #[test]
    fn a_bar_is_a_clamped_share_of_a_round_scale() {
        assert_eq!(bp(5_000.0, 10_000.0), 5_000);
        assert_eq!(bp(20_000.0, 10_000.0), BP);
        assert_eq!(bp(-1.0, 10_000.0), 0);
        assert_eq!(bp(1.0, 0.0), 0);
        assert!((scale_over(9_000.0) - 12_000.0).abs() < f64::EPSILON);
        assert!((scale_over(0.0) - 1.0).abs() < f64::EPSILON);
    }

    #[test]
    fn a_workout_is_titled_by_its_kind_and_part_of_day() {
        assert_eq!(title(EN, "run", "07:10"), "Morning run");
        assert_eq!(title(EN, "cycle", "18:00"), "Evening ride");
        assert_eq!(title(EN, "swim", "03:00"), "Night swim");
        assert_eq!(title(EN, "pilates", ""), "Workout");
        assert_eq!(kind_chip(EN, "pilates", "Pilates"), "Pilates");
        assert_eq!(short_date(EN, "2026-09-30"), "30 Sep");
        assert_eq!(month_heading(EN, "2026-09-30", "2026-10-20"), "September");
        assert_eq!(
            month_heading(EN, "2025-09-30", "2026-10-20"),
            "September 2025"
        );
    }

    #[test]
    fn each_kind_has_its_own_mark_and_a_kind_with_none_keeps_the_workout_mark() {
        let kinds = ["run", "walk", "cycle", "swim", "hike", "yoga"];
        let marks: std::collections::BTreeSet<_> = kinds.iter().map(|k| kind_icon(k)).collect();
        assert_eq!(marks.len(), kinds.len());
        assert_eq!(kind_icon("strength"), "Gym");
        assert_eq!(kind_icon("EXERCISE_TYPE_TENNIS"), "Gym");
    }

    #[test]
    fn a_list_line_names_the_when_by_how_far_back_it_is() {
        let row = wire::HealthWorkoutRow {
            activity_id: "a1".into(),
            kind_key: "run".into(),
            local_start: "2026-10-20T07:10".into(),
            distance_m: Some(5_200.0),
            length_sec: 1_864,
            ..Default::default()
        };
        let today = line(EN, &row, "2026-10-20", Units::Metric, "Health");
        assert_eq!(today.title, "Morning run");
        assert_eq!(today.meta, "5.2 km · 31 min");
        assert_eq!(today.when_label, "07:10");
        let week = wire::HealthWorkoutRow {
            local_start: "2026-10-18T07:10".into(),
            ..row.clone()
        };
        assert_eq!(
            line(EN, &week, "2026-10-20", Units::Metric, "").when_label,
            "Sun"
        );
        let old = wire::HealthWorkoutRow {
            local_start: "2026-09-30T18:00".into(),
            ..row
        };
        assert_eq!(
            line(EN, &old, "2026-10-20", Units::Metric, "").when_label,
            "30 Sep"
        );
    }
}
