//! HEALTH'S SIX ANSWERS: what each screen and the follower read, folded (#1129, R-1129-12).
//!
//! Each loader reads through [`crate::door`] and folds with [`crate::figures`]; `health.proto`
//! mirrors every struct here and `crates/core`'s `app_query/health.rs` is the one conversion.
//! A loader takes `today` as a day count: the core places it in the request's zone (the vault
//! clock's day there) before it asks, so nothing in this crate reads a zone or a clock.
//!
//! | Answer | Reads | Folds |
//! | --- | --- | --- |
//! | [`Today`] | the 365 days to today, today's workouts | today's figure per metric, the typical and its range (R-1129-8) |
//! | [`Series`] | one metric over the period and the one before | buckets, averages, best, total, days above typical |
//! | [`Trends`] | all six over the period and the one before | per-metric average, previous, sparkline buckets |
//! | [`Workouts`] | a page of workouts, every workout's kind | rows, kind counts |
//! | [`Workout`] | one activity and its workout row | — |
//! | [`FollowView`] | the two latests, the days in the window | the window (R-1129-3, R-1129-4) |

use std::collections::BTreeMap;

use centraid_apps_kit::error::KitResult;
use centraid_apps_kit::page::{PageCursor, PageRequest};
use centraid_apps_kit::reads::PageDoor;

use crate::civil::{format_day, month_start_shifted, parse_day};
use crate::door::{self, ActivityRow, DAY_ROWS, DayRow, FOLLOW_DAY_ROWS, KindRow, MeasureRow};
use crate::figures::{self, Bucket, Days, Fold, Metric, Typical};

/// The days `metrics_with_data` looks back over, today included (R-1129-6).
pub const DATA_LOOKBACK_DAYS: i64 = 365;
/// The days weight's latest is looked for in, today included.
pub const WEIGHT_LOOKBACK_DAYS: i64 = 30;

/// A metric's days, keyed by day count.
fn by_metric(rows: &[DayRow]) -> BTreeMap<Metric, Days> {
    let mut out: BTreeMap<Metric, Days> = BTreeMap::new();
    for row in rows {
        if let Some(day) = parse_day(&row.day) {
            out.entry(row.metric).or_default().insert(day, row.value);
        }
    }
    out
}

fn read_days(
    door: &dyn PageDoor,
    subject: Option<&str>,
    first: i64,
    last: i64,
    metric: Option<Metric>,
) -> KitResult<BTreeMap<Metric, Days>> {
    let Some(subject) = subject else {
        return Ok(BTreeMap::new());
    };
    let rows = door::days(
        door,
        subject,
        &format_day(first),
        &format_day(last),
        metric,
        DAY_ROWS,
    )?;
    Ok(by_metric(&rows))
}

// ---------------------------------------------------------------------------
// Workouts, shared.
// ---------------------------------------------------------------------------

/// One workout, as every answer that lists one spells it.
#[derive(Debug, Clone, PartialEq)]
pub struct Workout {
    pub activity_id: String,
    pub kind: KindRow,
    pub started_at: String,
    pub ended_at: String,
    pub moving_sec: Option<i64>,
    pub distance_m: Option<f64>,
    pub energy_kcal: Option<f64>,
    pub avg_hr_bpm: Option<i64>,
    pub elevation_gain_m: Option<f64>,
    pub recorded_by: Option<String>,
}

/// The workout kinds by concept id.
fn kind_index(kinds: &[KindRow]) -> BTreeMap<String, KindRow> {
    kinds
        .iter()
        .map(|kind| (kind.concept_id.clone(), kind.clone()))
        .collect()
}

/// The activities joined to what the store measured; an activity with no workout row is not a
/// workout and is left out.
fn joined(
    door: &dyn PageDoor,
    activities: Vec<ActivityRow>,
    kinds: &BTreeMap<String, KindRow>,
) -> KitResult<Vec<Workout>> {
    if activities.is_empty() {
        return Ok(Vec::new());
    }
    let ids: Vec<String> = activities.iter().map(|a| a.activity_id.clone()).collect();
    let mut measures = door::measures(door, &ids)?;
    let trashed = door::trashed(door, &ids)?;
    Ok(activities
        .into_iter()
        .filter(|activity| !trashed.contains(&activity.activity_id))
        .filter_map(|activity| {
            let measure: MeasureRow = measures.remove(&activity.activity_id)?;
            let kind = kinds
                .get(&activity.kind_concept_id)
                .cloned()
                .unwrap_or_else(|| KindRow {
                    concept_id: activity.kind_concept_id.clone(),
                    key: String::new(),
                    label: String::new(),
                });
            Some(Workout {
                activity_id: activity.activity_id,
                kind,
                ended_at: activity
                    .ended_at
                    .unwrap_or_else(|| activity.started_at.clone()),
                started_at: activity.started_at,
                moving_sec: measure.moving_sec,
                distance_m: measure.distance_m,
                energy_kcal: measure.energy_kcal,
                avg_hr_bpm: measure.avg_hr_bpm,
                elevation_gain_m: measure.elevation_gain_m,
                recorded_by: measure.recorded_by,
            })
        })
        .collect())
}

fn kind_ids(kinds: &[KindRow]) -> Vec<String> {
    kinds.iter().map(|kind| kind.concept_id.clone()).collect()
}

// ---------------------------------------------------------------------------
// health.today
// ---------------------------------------------------------------------------

/// One metric on Today.
#[derive(Debug, Clone, PartialEq)]
pub struct TodayMetric {
    pub metric: Metric,
    /// Today's figure (see [`today`]), and the day it is for.
    pub value: Option<(String, f64)>,
    pub typical: Option<Typical>,
}

/// Today: the six metrics against the member's own typical, today's workouts, and what the
/// shell needs to say where the numbers come from.
#[derive(Debug, Clone, PartialEq)]
pub struct Today {
    pub today: String,
    pub metrics: Vec<TodayMetric>,
    pub workouts: Vec<Workout>,
    pub connected: bool,
    pub metrics_with_data: Vec<Metric>,
}

/// Today's figure for one metric: the row keyed today for every metric but weight (a sum's day so
/// far, last night's sleep, today's resting heart rate), and for weight the newest row in the 30
/// days to today.
fn todays_figure(metric: Metric, days: &Days, today: i64) -> Option<(String, f64)> {
    let (day, value) = match metric.fold() {
        Fold::Last => figures::within(days, today - (WEIGHT_LOOKBACK_DAYS - 1), today)
            .last()
            .copied()?,
        _ => (today, *days.get(&today)?),
    };
    Some((format_day(day), value))
}

/// `health.today`. `day_start` and `day_end` are the instants, in the vault's spelling
/// ([`crate::civil::utc_instant`]), that bound the caller's day.
///
/// # Errors
///
/// A door failure, or a read past its ceiling.
pub fn today(door: &dyn PageDoor, today: i64, day_start: &str, day_end: &str) -> KitResult<Today> {
    let subject = door::self_party(door)?;
    let days = read_days(
        door,
        subject.as_deref(),
        today - (DATA_LOOKBACK_DAYS - 1),
        today,
        None,
    )?;
    let empty = Days::new();
    let metrics = Metric::ALL
        .into_iter()
        .map(|metric| {
            let days = days.get(&metric).unwrap_or(&empty);
            TodayMetric {
                metric,
                value: todays_figure(metric, days, today),
                typical: figures::typical_before(days, today),
            }
        })
        .collect();
    let metrics_with_data = Metric::ALL
        .into_iter()
        .filter(|metric| days.get(metric).is_some_and(|days| !days.is_empty()))
        .collect();
    let kinds = door::kinds(door)?;
    let workouts = if kinds.is_empty() {
        Vec::new()
    } else {
        let started = door::workouts_started_between(door, &kind_ids(&kinds), day_start, day_end)?;
        joined(door, started, &kind_index(&kinds))?
    };
    Ok(Today {
        today: format_day(today),
        metrics,
        workouts,
        connected: door::connected(door)?,
        metrics_with_data,
    })
}

// ---------------------------------------------------------------------------
// health.series
// ---------------------------------------------------------------------------

/// A series' span.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Range {
    /// The 7 days to today.
    Week,
    /// The 30 days to today.
    Month,
    /// The 12 calendar months to today's.
    Year,
}

/// One metric over a range: the buckets and the facts under the chart.
#[derive(Debug, Clone, PartialEq)]
pub struct Series {
    pub metric: Metric,
    pub range: Range,
    pub today: String,
    pub buckets: Vec<Bucket>,
    pub average: Option<f64>,
    pub previous_average: Option<f64>,
    pub typical: Option<f64>,
    pub best: Option<Bucket>,
    pub total: Option<f64>,
    pub above_typical: usize,
    pub counted: usize,
    /// `average` less `typical`, and as a percentage of `typical` ([`figures::difference`]).
    pub versus_typical: Option<f64>,
    pub versus_typical_pct: Option<f64>,
}

/// `health.series`.
///
/// # Errors
///
/// A door failure, or a read past its ceiling.
pub fn series(door: &dyn PageDoor, metric: Metric, range: Range, today: i64) -> KitResult<Series> {
    let subject = door::self_party(door)?;
    // The period, the one before it, and (for WEEK and MONTH) the 30 days the typical reads.
    let (first, previous_first) = match range {
        Range::Week => (today - 6, today - 13),
        Range::Month => (today - 29, today - 59),
        Range::Year => (
            month_start_shifted(today, -11),
            month_start_shifted(today, -23),
        ),
    };
    let read_from = previous_first.min(today - 30);
    let days = read_days(door, subject.as_deref(), read_from, today, Some(metric))?
        .remove(&metric)
        .unwrap_or_default();
    let buckets = match range {
        Range::Week | Range::Month => figures::day_buckets(metric, &days, first, today),
        Range::Year => figures::month_buckets(metric, &days, today, 12),
    };
    let average = figures::period_figure(metric, &days, first, today);
    let previous_average = figures::period_figure(metric, &days, previous_first, first - 1);
    let typical = match range {
        Range::Week | Range::Month => {
            figures::typical_before(&days, today).map(|typical| typical.typical)
        }
        Range::Year => previous_average,
    };
    let (above_typical, counted) = figures::above(&buckets, typical);
    let (versus_typical, versus_typical_pct) = figures::difference(average, typical);
    Ok(Series {
        metric,
        range,
        today: format_day(today),
        best: figures::best(metric, &buckets),
        total: figures::period_total(metric, &days, first, today),
        buckets,
        average,
        previous_average,
        typical,
        above_typical,
        counted,
        versus_typical,
        versus_typical_pct,
    })
}

// ---------------------------------------------------------------------------
// health.trends
// ---------------------------------------------------------------------------

/// The trends' span.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrendRange {
    Days30,
    Days90,
    /// The 12 calendar months to today's.
    Year,
}

/// The buckets a 30- or 90-day trend's sparkline draws.
pub const TREND_BUCKETS: i64 = 9;

/// One metric's trend.
#[derive(Debug, Clone, PartialEq)]
pub struct Trend {
    pub metric: Metric,
    pub average: Option<f64>,
    pub previous: Option<f64>,
    pub buckets: Vec<Bucket>,
    /// `average` less `previous`, and as a percentage of `previous` ([`figures::difference`]).
    pub change: Option<f64>,
    pub change_pct: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Trends {
    pub range: TrendRange,
    pub today: String,
    /// In [`Metric::ALL`] order; a metric with no row in either period is absent.
    pub trends: Vec<Trend>,
}

/// `health.trends`.
///
/// # Errors
///
/// A door failure, or a read past its ceiling.
pub fn trends(door: &dyn PageDoor, range: TrendRange, today: i64) -> KitResult<Trends> {
    let subject = door::self_party(door)?;
    let (first, previous_first) = match range {
        TrendRange::Days30 => (today - 29, today - 59),
        TrendRange::Days90 => (today - 89, today - 179),
        TrendRange::Year => (
            month_start_shifted(today, -11),
            month_start_shifted(today, -23),
        ),
    };
    let days = read_days(door, subject.as_deref(), previous_first, today, None)?;
    let trends = Metric::ALL
        .into_iter()
        .filter_map(|metric| {
            let days = days.get(&metric)?;
            let average = figures::period_figure(metric, days, first, today);
            let previous = figures::period_figure(metric, days, previous_first, first - 1);
            if average.is_none() && previous.is_none() {
                return None;
            }
            let buckets = match range {
                TrendRange::Year => figures::month_buckets(metric, days, today, 12),
                TrendRange::Days30 | TrendRange::Days90 => {
                    figures::even_runs(first, today, TREND_BUCKETS)
                        .into_iter()
                        .map(|(start, end)| figures::bucket(metric, days, start, end))
                        .collect()
                }
            };
            let (change, change_pct) = figures::difference(average, previous);
            Some(Trend {
                metric,
                average,
                previous,
                buckets,
                change,
                change_pct,
            })
        })
        .collect();
    Ok(Trends {
        range,
        today: format_day(today),
        trends,
    })
}

// ---------------------------------------------------------------------------
// health.workouts / health.workout
// ---------------------------------------------------------------------------

/// A kind with workouts, for the filter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KindCount {
    pub kind: KindRow,
    pub count: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Workouts {
    pub rows: Vec<Workout>,
    /// Every kind with a workout, whatever the filter: most first, then by label.
    pub kinds: Vec<KindCount>,
    pub next: Option<PageCursor>,
}

/// `health.workouts`: a page of every workout (or one kind's), newest first.
///
/// # Errors
///
/// A door failure, or more workouts than the counts' ceiling.
pub fn workouts(
    door: &dyn PageDoor,
    kind: Option<&str>,
    request: &PageRequest,
) -> KitResult<Workouts> {
    let kinds = door::kinds(door)?;
    let index = kind_index(&kinds);
    let every_kind = kind_ids(&kinds);
    let filter: Vec<String> = match kind {
        Some(kind) if index.contains_key(kind) => vec![kind.to_owned()],
        // A kind that is not a workout kind has no workouts.
        Some(_) => Vec::new(),
        None => every_kind.clone(),
    };
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    if !every_kind.is_empty() {
        for activity in door::every_workout(door, &every_kind)? {
            *counts.entry(activity.kind_concept_id).or_default() += 1;
        }
    }
    let mut kind_counts: Vec<KindCount> = counts
        .into_iter()
        .filter_map(|(concept_id, count)| {
            Some(KindCount {
                kind: index.get(&concept_id)?.clone(),
                count,
            })
        })
        .collect();
    kind_counts.sort_by(|a, b| {
        b.count
            .cmp(&a.count)
            .then_with(|| a.kind.label.cmp(&b.kind.label))
            .then_with(|| a.kind.concept_id.cmp(&b.kind.concept_id))
    });
    if filter.is_empty() {
        return Ok(Workouts {
            rows: Vec::new(),
            kinds: kind_counts,
            next: None,
        });
    }
    let page = door::workout_page(door, &filter, request)?;
    Ok(Workouts {
        rows: joined(door, page.rows, &index)?,
        kinds: kind_counts,
        next: page.next,
    })
}

/// `health.workout`: one workout, or `None` when the id names no workout.
///
/// # Errors
///
/// A door failure.
pub fn workout(door: &dyn PageDoor, activity_id: &str) -> KitResult<Option<Workout>> {
    let Some(activity) = door::activity(door, activity_id)? else {
        return Ok(None);
    };
    let kinds = door::kinds(door)?;
    Ok(joined(door, vec![activity], &kind_index(&kinds))?
        .into_iter()
        .next())
}

// ---------------------------------------------------------------------------
// health.follow_view
// ---------------------------------------------------------------------------

/// How far back a first read of the totals goes (owner answer 3).
pub const TOTALS_BACK: i64 = 365;
/// How far back a first read of the workouts goes (owner answer 3).
pub const WORKOUTS_BACK: i64 = 90;
/// Days re-read behind the latest one held, because watches upload late.
pub const REREAD: i64 = 7;

/// THE FIRST DAY A PASS READS (R-1129-4). With nothing held: `back` days before `today`.
/// Otherwise [`REREAD`] days before the latest day held, or before today when that is earlier
/// still (a member who has not opened the app for a month gets the month), and never more than
/// `back` days before today (RP-K-4: the window always covers the last [`REREAD`] days).
#[must_use]
pub fn window_from(today: i64, latest: Option<i64>, back: i64) -> i64 {
    let floor = today - back;
    latest.map_or(floor, |latest| {
        floor.max((latest - REREAD).min(today - REREAD))
    })
}

/// What the follower engine reads before a pass (R-1129-3, R-1129-4): the window, and what
/// the vault holds in it.
#[derive(Debug, Clone, PartialEq)]
pub struct FollowView {
    pub latest_day: Option<String>,
    pub latest_workout_started_at: Option<String>,
    pub today: String,
    /// The first day of the totals' window and of the workouts' ([`window_from`]).
    pub totals_from: i64,
    pub workouts_from: i64,
    /// Every (day, metric, value) with day >= `totals_from`, oldest first.
    pub days: Vec<DayRow>,
}

/// The newest followed workout's start: the newest activity of a workout kind that has its
/// workout row (by construction every one does; the row is still asked for, not assumed).
fn latest_workout(door: &dyn PageDoor) -> KitResult<Option<String>> {
    let kinds = door::kinds(door)?;
    if kinds.is_empty() {
        return Ok(None);
    }
    let ids = kind_ids(&kinds);
    let mut request = PageRequest::first(20);
    for _ in 0..10 {
        let page = door::workout_page(door, &ids, &request)?;
        let on_page: Vec<String> = page.rows.iter().map(|a| a.activity_id.clone()).collect();
        let measured = door::measures(door, &on_page)?;
        if let Some(found) = page
            .rows
            .iter()
            .find(|activity| measured.contains_key(&activity.activity_id))
        {
            return Ok(Some(found.started_at.clone()));
        }
        match page.next {
            Some(next) => request = PageRequest::after(20, next),
            None => return Ok(None),
        }
    }
    Ok(None)
}

/// `health.follow_view`. `workout_day` places the newest workout's start on a day in the
/// request's zone — the caller's to do, since this crate reads no zone.
///
/// # Errors
///
/// A door failure, or a window holding more than [`FOLLOW_DAY_ROWS`].
pub fn follow_view(
    door: &dyn PageDoor,
    today: i64,
    workout_day: impl Fn(&str) -> Option<i64>,
) -> KitResult<FollowView> {
    let latest_workout_started_at = latest_workout(door)?;
    let workouts_from = window_from(
        today,
        latest_workout_started_at.as_deref().and_then(&workout_day),
        WORKOUTS_BACK,
    );
    let subject = door::self_party(door)?;
    let latest_day = match &subject {
        Some(subject) => door::latest_day(door, subject)?,
        None => None,
    };
    let totals_from = window_from(
        today,
        latest_day.as_deref().and_then(parse_day),
        TOTALS_BACK,
    );
    let days = match (&subject, &latest_day) {
        (Some(subject), Some(latest)) => door::days(
            door,
            subject,
            &format_day(totals_from),
            latest,
            None,
            FOLLOW_DAY_ROWS,
        )?,
        _ => Vec::new(),
    };
    Ok(FollowView {
        latest_day,
        latest_workout_started_at,
        today: format_day(today),
        totals_from,
        workouts_from,
        days,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn day(text: &str) -> i64 {
        parse_day(text).expect("a day")
    }

    #[test]
    fn the_window_reads_a_year_and_ninety_days_with_nothing_held() {
        let today = day("2026-10-20");
        assert_eq!(
            format_day(window_from(today, None, TOTALS_BACK)),
            "2025-10-20"
        );
        assert_eq!(
            format_day(window_from(today, None, WORKOUTS_BACK)),
            "2026-07-22"
        );
    }

    #[test]
    fn the_window_rereads_seven_days_behind_the_latest_always_the_last_seven_never_past_the_floor()
    {
        let today = day("2026-10-20");
        let from =
            |latest: &str, back: i64| format_day(window_from(today, Some(day(latest)), back));
        assert_eq!(from("2026-10-19", TOTALS_BACK), "2026-10-12");
        assert_eq!(from("2026-10-20", TOTALS_BACK), "2026-10-13");
        // A month away: the month is read.
        assert_eq!(from("2026-09-10", TOTALS_BACK), "2026-09-03");
        // A latest day the clock has not reached yet still reads the last seven.
        assert_eq!(from("2026-11-01", TOTALS_BACK), "2026-10-13");
        assert_eq!(from("2024-01-01", TOTALS_BACK), "2025-10-20");
        assert_eq!(from("2026-01-01", WORKOUTS_BACK), "2026-07-22");
    }
}
