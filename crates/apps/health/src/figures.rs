//! THE FIGURES, AS PURE FUNCTIONS OF DAYS (R-1129-12).
//!
//! Every number a Health screen draws beyond a stored total is computed here, from `(day, value)`
//! pairs a loader has already read: the typical and its usual range (R-1129-8), a period's per-day
//! figure, a series' buckets, the best bucket. Nothing here reads, so each is tested on hand-made
//! days, and Kotlin formats what comes out and derives nothing (DOCTRINE rule 6).
//!
//! Two rules hold throughout:
//!
//! - **A day with no row feeds nothing.** It is not a day of zero steps: the store did not say.
//!   An average is over the days that have a row, and a figure nothing feeds is `None`.
//! - **A metric folds its own way** ([`Fold`]): a sum's period has a total, a night's never does,
//!   and weight's figure for a span is its NEWEST value, never an average of a gain and a loss.

use std::collections::BTreeMap;

use crate::civil;

/// The six daily metrics, in the order Today lists them; the vault's own names are [`key`].
///
/// [`key`]: Metric::key
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Metric {
    Steps,
    SleepMin,
    ActiveEnergyKcal,
    ExerciseMin,
    RestingHrBpm,
    WeightKg,
}

/// How a metric's days combine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fold {
    /// A day's total of a count: a period has a total as well as a per-day average.
    Sum,
    /// A night's total, keyed to the day the member woke: averaged, never added across nights.
    Night,
    /// The store's own daily average: averaged, never added.
    Average,
    /// The day's last sample: a span's figure is its newest.
    Last,
}

/// Which way is better, for the best bucket.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Better {
    Higher,
    Lower,
    /// No direction is better (weight): there is no best bucket.
    Neither,
}

impl Metric {
    /// All six, in Today's order.
    pub const ALL: [Self; 6] = [
        Self::Steps,
        Self::SleepMin,
        Self::ActiveEnergyKcal,
        Self::ExerciseMin,
        Self::RestingHrBpm,
        Self::WeightKg,
    ];

    /// The name the vault's `health_daily.metric` CHECK spells.
    #[must_use]
    pub const fn key(self) -> &'static str {
        match self {
            Self::Steps => "steps",
            Self::SleepMin => "sleep_min",
            Self::ActiveEnergyKcal => "active_energy_kcal",
            Self::ExerciseMin => "exercise_min",
            Self::RestingHrBpm => "resting_hr_bpm",
            Self::WeightKg => "weight_kg",
        }
    }

    /// The metric a vault name names.
    #[must_use]
    pub fn from_key(key: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|metric| metric.key() == key)
    }

    #[must_use]
    pub const fn fold(self) -> Fold {
        match self {
            Self::Steps | Self::ActiveEnergyKcal | Self::ExerciseMin => Fold::Sum,
            Self::SleepMin => Fold::Night,
            Self::RestingHrBpm => Fold::Average,
            Self::WeightKg => Fold::Last,
        }
    }

    #[must_use]
    pub const fn better(self) -> Better {
        match self {
            Self::RestingHrBpm => Better::Lower,
            Self::WeightKg => Better::Neither,
            _ => Better::Higher,
        }
    }
}

/// A metric's values by day (the day as a count, [`civil::parse_day`]).
pub type Days = BTreeMap<i64, f64>;

/// The values of the days in `[first, last]` that have a row, oldest first.
#[must_use]
pub fn within(days: &Days, first: i64, last: i64) -> Vec<(i64, f64)> {
    if first > last {
        return Vec::new();
    }
    days.range(first..=last)
        .map(|(day, value)| (*day, *value))
        .collect()
}

/// The `p`th quantile of sorted values, linear between the closest ranks (the R-7 rule, which a
/// spreadsheet's `PERCENTILE` uses): one value is every quantile of itself.
#[must_use]
pub fn quantile(sorted: &[f64], p: f64) -> Option<f64> {
    let last = sorted.len().checked_sub(1)?;
    let rank = p.clamp(0.0, 1.0) * last as f64;
    let below = rank.floor() as usize;
    let above = (below + 1).min(last);
    let weight = rank - below as f64;
    Some(sorted[below] + (sorted[above] - sorted[below]) * weight)
}

/// The arithmetic mean, or `None` of nothing.
#[must_use]
pub fn mean(values: &[f64]) -> Option<f64> {
    (!values.is_empty()).then(|| values.iter().sum::<f64>() / values.len() as f64)
}

/// The member's own usual: the median of the days that fed it, and the 25th and 75th
/// percentiles of the same days (R-1129-8).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Typical {
    pub typical: f64,
    pub low: f64,
    pub high: f64,
    /// How many days fed it.
    pub days: usize,
}

/// The typical of `today`: over the 30 WHOLE days before it that have a row. Today itself is
/// never in it — a day still under way is not a day to compare against.
#[must_use]
pub fn typical_before(days: &Days, today: i64) -> Option<Typical> {
    let mut values: Vec<f64> = within(days, today - 30, today - 1)
        .into_iter()
        .map(|(_, value)| value)
        .collect();
    values.sort_by(f64::total_cmp);
    Some(Typical {
        typical: quantile(&values, 0.5)?,
        low: quantile(&values, 0.25)?,
        high: quantile(&values, 0.75)?,
        days: values.len(),
    })
}

/// A span's one figure: the per-day average of its days that have a row, or for a
/// [`Fold::Last`] metric its newest value.
#[must_use]
pub fn period_figure(metric: Metric, days: &Days, first: i64, last: i64) -> Option<f64> {
    let rows = within(days, first, last);
    match metric.fold() {
        Fold::Last => rows.last().map(|(_, value)| *value),
        _ => mean(&rows.iter().map(|(_, value)| *value).collect::<Vec<_>>()),
    }
}

/// A span's total, for a [`Fold::Sum`] metric only; `None` for the others, and when no day in
/// the span has a row.
#[must_use]
pub fn period_total(metric: Metric, days: &Days, first: i64, last: i64) -> Option<f64> {
    if metric.fold() != Fold::Sum {
        return None;
    }
    let rows = within(days, first, last);
    (!rows.is_empty()).then(|| rows.iter().map(|(_, value)| *value).sum())
}

/// One bucket of a series: a run of days `[first, last]` and its figure.
#[derive(Debug, Clone, PartialEq)]
pub struct Bucket {
    pub first: i64,
    pub last: i64,
    /// [`period_figure`] over the bucket; `None` when no day in it has a row.
    pub value: Option<f64>,
    /// How many days in it have a row.
    pub days: usize,
}

/// The bucket `[first, last]` of `metric`'s days.
#[must_use]
pub fn bucket(metric: Metric, days: &Days, first: i64, last: i64) -> Bucket {
    Bucket {
        first,
        last,
        value: period_figure(metric, days, first, last),
        days: within(days, first, last).len(),
    }
}

/// One bucket per day of `[first, last]`, oldest first.
#[must_use]
pub fn day_buckets(metric: Metric, days: &Days, first: i64, last: i64) -> Vec<Bucket> {
    (first..=last)
        .map(|day| bucket(metric, days, day, day))
        .collect()
}

/// The `count` calendar months ending with the month `today` falls in, oldest first; the
/// current month's bucket ends at `today`.
#[must_use]
pub fn month_buckets(metric: Metric, days: &Days, today: i64, count: i64) -> Vec<Bucket> {
    (0..count)
        .rev()
        .map(|back| {
            let first = civil::month_start_shifted(today, -back);
            let last = civil::month_end(first).min(today);
            bucket(metric, days, first, last)
        })
        .collect()
}

/// `[first, last]` split into `count` contiguous runs as evenly as they go, the LATER runs taking
/// the extra day (30 days in 9 is six runs of 3 and three of 4), oldest first.
#[must_use]
pub fn even_runs(first: i64, last: i64, count: i64) -> Vec<(i64, i64)> {
    let span = last - first + 1;
    if span <= 0 || count <= 0 {
        return Vec::new();
    }
    let count = count.min(span);
    let (size, extra) = (span / count, span % count);
    let mut runs = Vec::new();
    let mut start = first;
    for index in 0..count {
        let length = size + i64::from(index >= count - extra);
        runs.push((start, start + length - 1));
        start += length;
    }
    runs
}

/// The best of a series' buckets: the highest, the lowest for a metric where lower is better,
/// and none for a metric where neither is. Ties go to the newest.
#[must_use]
pub fn best(metric: Metric, buckets: &[Bucket]) -> Option<Bucket> {
    let valued = buckets.iter().filter(|bucket| bucket.value.is_some());
    let pick = |a: &&Bucket, b: &&Bucket| {
        let (a, b) = (a.value.unwrap_or_default(), b.value.unwrap_or_default());
        a.total_cmp(&b)
    };
    match metric.better() {
        Better::Higher => valued.max_by(pick).cloned(),
        Better::Lower => valued
            .min_by(|a, b| pick(a, b).then(std::cmp::Ordering::Greater))
            .cloned(),
        Better::Neither => None,
    }
}

/// How many buckets with a value are above `typical`, and how many have a value.
#[must_use]
pub fn above(buckets: &[Bucket], typical: Option<f64>) -> (usize, usize) {
    let valued: Vec<f64> = buckets.iter().filter_map(|bucket| bucket.value).collect();
    let above = typical.map_or(0, |typical| {
        valued.iter().filter(|value| **value > typical).count()
    });
    (above, valued.len())
}

/// THE DIFFERENCE OF TWO FIGURES (RP-K-6): `now` less `before`, in the metric's unit, and as a
/// percentage of `before` (absent when `before` is 0). Both absent when either figure is. The
/// shell rounds and words it; it subtracts nothing.
#[must_use]
pub fn difference(now: Option<f64>, before: Option<f64>) -> (Option<f64>, Option<f64>) {
    let (Some(now), Some(before)) = (now, before) else {
        return (None, None);
    };
    let pct = (before != 0.0).then(|| (now - before) / before * 100.0);
    (Some(now - before), pct)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn day(text: &str) -> i64 {
        civil::parse_day(text).expect("a day")
    }

    /// `values[i]` on the day `i` days before `last`, oldest first; `None` is a day with no row.
    fn days_ending(last: &str, values: &[Option<f64>]) -> Days {
        let last = day(last);
        let first = last - i64::try_from(values.len()).unwrap() + 1;
        values
            .iter()
            .enumerate()
            .filter_map(|(index, value)| {
                value.map(|value| (first + i64::try_from(index).unwrap(), value))
            })
            .collect()
    }

    #[test]
    fn a_quantile_is_linear_between_ranks_and_one_value_is_its_own() {
        let sorted = [1.0, 2.0, 3.0, 4.0];
        assert_eq!(quantile(&sorted, 0.5), Some(2.5));
        assert_eq!(quantile(&sorted, 0.25), Some(1.75));
        assert_eq!(quantile(&sorted, 0.75), Some(3.25));
        assert_eq!(quantile(&[7.0], 0.25), Some(7.0));
        assert_eq!(quantile(&[], 0.5), None);
        assert_eq!(mean(&[]), None);
    }

    #[test]
    fn the_typical_is_the_thirty_whole_days_before_today_and_never_today() {
        // Thirty days of 1..=30 before today, and a huge today that must not move it.
        let mut values: Vec<Option<f64>> = (1..=30).map(|n| Some(f64::from(n))).collect();
        values.push(Some(1_000_000.0));
        let days = days_ending("2026-10-20", &values);
        let typical = typical_before(&days, day("2026-10-20")).expect("thirty days");
        assert_eq!(typical.days, 30);
        assert!((typical.typical - 15.5).abs() < 1e-9);
        assert!((typical.low - 8.25).abs() < 1e-9);
        assert!((typical.high - 22.75).abs() < 1e-9);
        // A day 31 days back is outside the window.
        let mut older = days.clone();
        older.insert(day("2026-09-19"), 1e9);
        assert_eq!(typical_before(&older, day("2026-10-20")), Some(typical));
    }

    #[test]
    fn a_day_with_no_row_feeds_nothing() {
        let days = days_ending("2026-10-20", &[Some(10.0), None, None, Some(20.0), None]);
        assert_eq!(
            period_figure(Metric::Steps, &days, day("2026-10-16"), day("2026-10-20")),
            Some(15.0),
            "an average over the days that have a row, not over five"
        );
        assert_eq!(
            period_total(Metric::Steps, &days, day("2026-10-16"), day("2026-10-20")),
            Some(30.0)
        );
        assert_eq!(
            period_figure(Metric::Steps, &days, day("2026-10-17"), day("2026-10-18")),
            None
        );
        assert_eq!(typical_before(&Days::new(), day("2026-10-20")), None);
    }

    #[test]
    fn weight_is_its_newest_and_sleep_and_heart_rate_have_no_total() {
        let days = days_ending("2026-10-20", &[Some(72.0), Some(71.5), None]);
        assert_eq!(
            period_figure(
                Metric::WeightKg,
                &days,
                day("2026-10-18"),
                day("2026-10-20")
            ),
            Some(71.5)
        );
        for metric in [Metric::SleepMin, Metric::RestingHrBpm, Metric::WeightKg] {
            assert_eq!(
                period_total(metric, &days, day("2026-10-18"), day("2026-10-20")),
                None,
                "{metric:?}"
            );
        }
    }

    #[test]
    fn runs_split_as_evenly_as_they_go_and_the_later_take_the_extra_day() {
        let runs = even_runs(0, 29, 9);
        let sizes: Vec<i64> = runs.iter().map(|(a, b)| b - a + 1).collect();
        assert_eq!(sizes, vec![3, 3, 3, 3, 3, 3, 4, 4, 4]);
        assert_eq!(runs.first().unwrap().0, 0);
        assert_eq!(runs.last().unwrap().1, 29);
        assert!(even_runs(0, 89, 9).iter().all(|(a, b)| b - a + 1 == 10));
    }

    #[test]
    fn months_are_calendar_months_and_the_current_one_ends_today() {
        let days: Days = [
            (day("2026-09-30"), 10.0),
            (day("2026-10-01"), 20.0),
            (day("2026-10-02"), 40.0),
        ]
        .into_iter()
        .collect();
        let months = month_buckets(Metric::Steps, &days, day("2026-10-20"), 2);
        assert_eq!(months.len(), 2);
        assert_eq!(
            (months[0].first, months[0].last),
            (day("2026-09-01"), day("2026-09-30"))
        );
        assert_eq!(
            (months[1].first, months[1].last),
            (day("2026-10-01"), day("2026-10-20"))
        );
        assert_eq!(months[0].value, Some(10.0));
        assert_eq!(months[1].value, Some(30.0));
        assert_eq!(months[1].days, 2);
        // Twelve months back crosses a year.
        let year = month_buckets(Metric::Steps, &days, day("2026-01-05"), 12);
        assert_eq!(year[0].first, day("2025-02-01"));
    }

    #[test]
    fn the_best_bucket_follows_the_metrics_direction() {
        let buckets = |values: &[Option<f64>]| -> Vec<Bucket> {
            values
                .iter()
                .enumerate()
                .map(|(index, value)| Bucket {
                    first: i64::try_from(index).unwrap(),
                    last: i64::try_from(index).unwrap(),
                    value: *value,
                    days: usize::from(value.is_some()),
                })
                .collect()
        };
        let series = buckets(&[Some(5.0), None, Some(9.0), Some(2.0)]);
        assert_eq!(best(Metric::Steps, &series).unwrap().value, Some(9.0));
        assert_eq!(
            best(Metric::RestingHrBpm, &series).unwrap().value,
            Some(2.0)
        );
        assert_eq!(best(Metric::WeightKg, &series), None);
        assert_eq!(best(Metric::Steps, &buckets(&[None, None])), None);
        assert_eq!(above(&series, Some(4.0)), (2, 3));
        assert_eq!(above(&series, None), (0, 3));
    }

    #[test]
    fn a_difference_is_signed_and_a_percentage_of_the_before() {
        assert_eq!(
            difference(Some(110.0), Some(100.0)),
            (Some(10.0), Some(10.0))
        );
        assert_eq!(
            difference(Some(90.0), Some(100.0)),
            (Some(-10.0), Some(-10.0))
        );
        assert_eq!(difference(Some(5.0), Some(0.0)), (Some(5.0), None));
        assert_eq!(difference(None, Some(1.0)), (None, None));
        assert_eq!(difference(Some(1.0), None), (None, None));
    }

    #[test]
    fn every_metric_key_is_the_vaults_and_round_trips() {
        for metric in Metric::ALL {
            assert_eq!(Metric::from_key(metric.key()), Some(metric));
        }
        assert_eq!(Metric::from_key("weight"), None);
    }
}
