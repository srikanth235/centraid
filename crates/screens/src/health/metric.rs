//! ONE METRIC OVER A WEEK, A MONTH OR A YEAR (#1129), opened from a Today or a
//! Trends row: the period's per-day average against the member's typical, the
//! chart's buckets with the typical line across them, and the facts. Every figure
//! is `health.series`'s (R-1129-12); the identity hue marks only the bucket today
//! falls in (R-1129-10).

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;
use wire::health_metric_event::Kind as M;
use wire::screen_event::Kind as E;

use super::figures;
use super::home::per_unit;
use super::{Metric, Phase, Store, Units, denied};
use crate::catalog::load;
use crate::kit::civil;
use crate::kit::read;
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, fill, health as words};

const RANGE_WEEK: &str = "week";
const RANGE_MONTH: &str = "month";
const RANGE_YEAR: &str = "year";
const WEEK: usize = 7;
const QUARTER: usize = 3;

#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    let Some(wire::route::Args::HealthMetric(args)) = &route.args else {
        return None;
    };
    Some(Box::new(MetricPage {
        metric: Metric::of_key(&args.metric).unwrap_or(Metric::Steps),
        range: match wire::HealthMetricRange::try_from(args.range) {
            Ok(wire::HealthMetricRange::Month) => wire::HealthMetricRange::Month,
            Ok(wire::HealthMetricRange::Year) => wire::HealthMetricRange::Year,
            _ => wire::HealthMetricRange::Week,
        },
        parent: args.parent.clone(),
        phase: Phase::Loading,
    }))
}

struct MetricPage {
    metric: Metric,
    range: wire::HealthMetricRange,
    parent: String,
    phase: Phase<wire::HealthSeries>,
}

impl MetricPage {
    fn reload(&mut self, ctx: &Ctx) {
        let metric = match self.metric {
            Metric::Steps => load::health::SeriesMetric::Steps,
            Metric::Sleep => load::health::SeriesMetric::SleepMin,
            Metric::Energy => load::health::SeriesMetric::ActiveEnergyKcal,
            Metric::Exercise => load::health::SeriesMetric::ExerciseMin,
            Metric::RestingHr => load::health::SeriesMetric::RestingHrBpm,
            Metric::Weight => load::health::SeriesMetric::WeightKg,
        };
        let range = match self.range {
            wire::HealthMetricRange::Month => load::health::SeriesRange::Month,
            wire::HealthMetricRange::Year => load::health::SeriesRange::Year,
            _ => load::health::SeriesRange::Week,
        };
        self.phase = Phase::of(read::read(
            ctx,
            load::health::Series { metric, range },
            |answer| match answer {
                Answer::HealthSeries(series) => Some(series),
                _ => None,
            },
        ));
    }

    fn pick(&mut self, ctx: &Ctx, key: &str) {
        let range = match key {
            RANGE_WEEK => wire::HealthMetricRange::Week,
            RANGE_MONTH => wire::HealthMetricRange::Month,
            RANGE_YEAR => wire::HealthMetricRange::Year,
            _ => return,
        };
        if range != self.range {
            self.range = range;
            self.phase = Phase::Loading;
            self.reload(ctx);
        }
    }

    fn data(&self, ctx: &Ctx, series: &wire::HealthSeries) -> wire::HealthMetricData {
        let (locale, units) = (ctx.locale(), Units::of(ctx));
        let metric = self.metric;
        let year = self.range == wire::HealthMetricRange::Year;
        let caption = caption(locale, self.range, &series.buckets);
        if series.buckets.iter().all(|bucket| bucket.value.is_none()) {
            return wire::HealthMetricData {
                caption,
                empty: Some(wire::EmptyState {
                    headline: words::metric_empty(locale),
                    ..Default::default()
                }),
                ..Default::default()
            };
        }
        let (number, unit) = series
            .average
            .map(|average| figures::figure(locale, metric, average, units))
            .unwrap_or_default();
        let versus = match (series.average, series.typical) {
            (Some(_), Some(_)) => {
                let (diff, sign) = figures::delta(
                    locale,
                    metric,
                    series.versus_typical,
                    series.versus_typical_pct,
                    units,
                );
                let diff = diff.chars().skip(1).collect::<String>();
                match sign {
                    1 => fill(
                        &if year {
                            words::versus_year_above(locale)
                        } else {
                            words::versus_above(locale)
                        },
                        &[("diff", &diff)],
                    ),
                    -1 => fill(
                        &if year {
                            words::versus_year_below(locale)
                        } else {
                            words::versus_below(locale)
                        },
                        &[("diff", &diff)],
                    ),
                    _ => {
                        if year {
                            words::versus_year_about(locale)
                        } else {
                            words::versus_about(locale)
                        }
                    }
                }
            }
            _ => String::new(),
        };
        // A BAR'S HEIGHT IS DRAWING: the tallest of the buckets and the typical
        // line is the chart's top.
        let tallest = series
            .buckets
            .iter()
            .filter_map(|bucket| bucket.value)
            .fold(0.0_f64, f64::max);
        let top = figures::scale_over(tallest.max(series.typical.unwrap_or(0.0)));
        let last = series.buckets.len().saturating_sub(1);
        let bars: Vec<wire::HealthChartBar> = series
            .buckets
            .iter()
            .enumerate()
            .map(|(index, bucket)| {
                let value = bucket.value;
                let words_ = [
                    bucket_words(locale, self.range, bucket),
                    value
                        .map(|value| figures::phrase(locale, metric, value, units))
                        .unwrap_or_default(),
                ];
                wire::HealthChartBar {
                    has_value: value.is_some(),
                    height_bp: value.map_or(0, |value| figures::bp(value, top)),
                    current: index == last,
                    above_typical: matches!((value, series.typical), (Some(v), Some(t)) if v > t),
                    accessibility_label: words_
                        .iter()
                        .filter(|part| !part.is_empty())
                        .cloned()
                        .collect::<Vec<_>>()
                        .join(", "),
                }
            })
            .collect();
        let per = per_unit(locale, metric, &unit);
        let average_words = [number.as_str(), per.as_str()]
            .iter()
            .filter(|part| !part.is_empty())
            .copied()
            .collect::<Vec<_>>()
            .join(" ");
        wire::HealthMetricData {
            chart_label: fill(
                &words::chart_spoken(locale),
                &[("caption", &caption), ("average", &average_words)],
            ),
            caption,
            average: number,
            average_unit: per,
            versus,
            bars,
            has_typical: series.typical.is_some(),
            typical_bp: series
                .typical
                .map_or(0, |typical| figures::bp(typical, top)),
            typical_label: words::typical_line(locale),
            ticks: ticks(locale, self.range, &series.buckets),
            facts: facts(locale, metric, series, year, units),
            foot: foot(locale, metric, &Store::of(ctx).name(locale)),
            empty: None,
        }
    }
}

fn facts(
    locale: Locale,
    metric: Metric,
    series: &wire::HealthSeries,
    year: bool,
    units: Units,
) -> Vec<wire::HealthFact> {
    let mut facts = Vec::new();
    if let Some(best) = &series.best {
        let lowest = metric == Metric::RestingHr;
        let label = match (year, lowest) {
            (true, true) => words::fact_lowest_month(locale),
            (true, false) => words::fact_best_month(locale),
            (false, true) => words::fact_lowest_day(locale),
            (false, false) => words::fact_best_day(locale),
        };
        let at = if year {
            month_of(locale, &best.start)
        } else {
            civil::dated(locale, &best.start)
        };
        if let Some(value) = best.value {
            facts.push(wire::HealthFact {
                label,
                detail: format!("{at} · {}", figures::phrase(locale, metric, value, units)),
            });
        }
    }
    if let Some(total) = series.total {
        let phrase = figures::phrase(locale, metric, total, units);
        facts.push(wire::HealthFact {
            label: words::fact_total(locale),
            detail: if metric == Metric::Steps {
                format!("{phrase} {}", words::unit_steps(locale))
            } else {
                phrase
            },
        });
    }
    if series.typical.is_some() && series.counted > 0 {
        facts.push(wire::HealthFact {
            label: if year {
                words::fact_above_months(locale)
            } else {
                words::fact_above_days(locale)
            },
            detail: fill(
                &words::fact_count(locale),
                &[
                    ("n", &series.above_typical.to_string()),
                    ("m", &series.counted.to_string()),
                ],
            ),
        });
    }
    facts
}

fn foot(locale: Locale, metric: Metric, store: &str) -> String {
    match metric {
        Metric::Sleep => words::metric_foot_sleep(locale),
        Metric::RestingHr => fill(&words::metric_foot_heart(locale), &[("store", store)]),
        Metric::Weight => words::metric_foot_weight(locale),
        _ => fill(&words::metric_foot_day(locale), &[("store", store)]),
    }
}

fn month_of(locale: Locale, day: &str) -> String {
    civil::month_of(locale, day)
}

/// "Wed 14 – Tue 20 October", "Last 30 days", "November – October".
fn caption(
    locale: Locale,
    range: wire::HealthMetricRange,
    buckets: &[wire::HealthBucket],
) -> String {
    let (Some(first), Some(last)) = (buckets.first(), buckets.last()) else {
        return String::new();
    };
    match range {
        wire::HealthMetricRange::Month => words::caption_month(locale),
        wire::HealthMetricRange::Year => {
            format!(
                "{} – {}",
                month_of(locale, &first.start),
                month_of(locale, &last.start)
            )
        }
        _ => format!(
            "{} – {}",
            civil::dated(locale, &first.start),
            civil::day_month(locale, &last.end)
        ),
    }
}

fn bucket_words(
    locale: Locale,
    range: wire::HealthMetricRange,
    bucket: &wire::HealthBucket,
) -> String {
    if range == wire::HealthMetricRange::Year {
        month_of(locale, &bucket.start)
    } else {
        civil::day_month(locale, &bucket.start)
    }
}

/// Under the chart: weekday initials for a week, a date a week for a month, a
/// month a quarter for a year. **Marked back from the bucket today falls in**, at
/// one even step, so the last tick is today's and no two ticks are ever closer than
/// the step (counting forwards from the first bucket and then adding today put two
/// dates a day apart). Oldest first.
#[must_use]
pub fn ticks(
    locale: Locale,
    range: wire::HealthMetricRange,
    buckets: &[wire::HealthBucket],
) -> Vec<String> {
    match range {
        wire::HealthMetricRange::Month => back(buckets, WEEK)
            .iter()
            .map(|bucket| figures::short_date(locale, &bucket.start))
            .collect(),
        wire::HealthMetricRange::Year => back(buckets, QUARTER)
            .iter()
            .map(|bucket| month_of(locale, &bucket.start).chars().take(3).collect())
            .collect(),
        _ => buckets
            .iter()
            .map(|bucket| {
                civil::weekday_short(locale, &bucket.start)
                    .chars()
                    .take(1)
                    .collect()
            })
            .collect(),
    }
}

/// Every `step`th bucket counting back from the last, oldest first.
fn back(buckets: &[wire::HealthBucket], step: usize) -> Vec<&wire::HealthBucket> {
    let Some(last) = buckets.len().checked_sub(1) else {
        return Vec::new();
    };
    let mut out: Vec<&wire::HealthBucket> = (0..=last)
        .rev()
        .step_by(step)
        .map(|index| &buckets[index])
        .collect();
    out.reverse();
    out
}

impl Screen for MetricPage {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Appeared(_) | E::DataChanged(_) | E::EnvironmentChanged(_)) => {
                self.reload(ctx);
            }
            Some(E::HealthMetric(event)) => match event.kind {
                Some(M::Refreshed(_)) => self.reload(ctx),
                Some(M::Range(range)) => self.pick(ctx, &range.key),
                None => {}
            },
            _ => {}
        }
        Vec::new()
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        use wire::health_metric_state::Content;
        let locale = ctx.locale();
        let content = match &self.phase {
            Phase::Loading => Content::Loading(wire::Loading { first_load: true }),
            Phase::Failed => Content::Failure(read::failure(locale)),
            Phase::Denied(denial) => Content::Denied(denied(locale, denial)),
            Phase::Ready(series) => Content::Data(Box::new(self.data(ctx, series))),
        };
        let segment = |key: &str, range: wire::HealthMetricRange, label: String| wire::HealthChip {
            key: key.to_owned(),
            label,
            active: self.range == range,
        };
        wire::ViewState {
            kind: Some(wire::view_state::Kind::HealthMetric(
                wire::HealthMetricState {
                    metric: self.metric.key().to_owned(),
                    range: self.range as i32,
                    content: Some(content),
                    chrome: Some(wire::HealthPageChrome {
                        title: figures::label(locale, self.metric),
                        back_label: if self.parent.is_empty() {
                            words::app_title(locale)
                        } else {
                            self.parent.clone()
                        },
                        retry: words::retry(locale),
                    }),
                    segments: vec![
                        segment(
                            RANGE_WEEK,
                            wire::HealthMetricRange::Week,
                            words::range_week(locale),
                        ),
                        segment(
                            RANGE_MONTH,
                            wire::HealthMetricRange::Month,
                            words::range_month(locale),
                        ),
                        segment(
                            RANGE_YEAR,
                            wire::HealthMetricRange::Year,
                            words::range_year(locale),
                        ),
                    ],
                },
            )),
            ..wire::ViewState::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EN: Locale = Locale::En;

    fn days(n: i64, end: &str) -> Vec<wire::HealthBucket> {
        (0..n)
            .rev()
            .map(|back| {
                let day = civil::plus_days(end, -back).unwrap();
                wire::HealthBucket {
                    start: day.clone(),
                    end: day,
                    ..Default::default()
                }
            })
            .collect()
    }

    #[test]
    fn a_charts_ticks_are_marked_back_from_today_at_one_step_so_the_last_two_never_collide() {
        let month = ticks(EN, wire::HealthMetricRange::Month, &days(30, "2026-10-21"));
        assert_eq!(month, ["23 Sep", "30 Sep", "7 Oct", "14 Oct", "21 Oct"]);
        let months: Vec<wire::HealthBucket> = (0..12)
            .map(|i| {
                let m = (10 + i) % 12 + 1;
                let y = if m >= 11 { 2025 } else { 2026 };
                wire::HealthBucket {
                    start: format!("{y}-{m:02}-01"),
                    ..Default::default()
                }
            })
            .collect();
        assert_eq!(
            ticks(EN, wire::HealthMetricRange::Year, &months),
            ["Jan", "Apr", "Jul", "Oct"]
        );
        assert_eq!(
            ticks(EN, wire::HealthMetricRange::Week, &days(7, "2026-10-21")).len(),
            7
        );
    }
}
