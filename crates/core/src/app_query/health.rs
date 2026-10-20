//! HEALTH'S ARM OF THE APP QUERY (#1129): `crates/apps/health`'s six answers, asked through
//! [`super::VaultDoor`] and spelled as `health.proto` spells them.
//!
//! Every figure is the crate's (R-1129-12): this module checks what the request states, runs the
//! answer and converts. It reads NO ZONE and NO CLOCK — `today`, and the instants that bound it
//! for today's workouts, are the caller's to state, and one that is not a day of the calendar (or
//! not a UTC instant) is `ERROR_CODE_INVALID_REQUEST`, never a guess.

use centraid_api_proto::core_v1 as wire;
use centraid_apps_health::civil::{format_day, parse_day, utc_instant};
use centraid_apps_health::figures::{Bucket, Metric};
use centraid_apps_health::queries::{self, Range, TrendRange, Workout};
use centraid_apps_kit::error::KitResult;
use centraid_apps_kit::page::{PageCursor, PageRequest};

use super::{VaultDoor, settle};
use crate::error::{CoreError, Result};

type Answer = wire::app_query_response::Answer;

/// The most workouts one page may ask for.
pub const WORKOUTS_PAGE_MAX: u32 = 200;

fn done<T>(loaded: KitResult<T>) -> KitResult<(T, Option<centraid_apps_kit::Denial>)> {
    loaded.map(|value| (value, None))
}

fn invalid(detail: String) -> CoreError {
    CoreError::InvalidRequest { detail }
}

/// A day the request states, or the request's fault.
fn day_of(text: &str, what: &str) -> Result<i64> {
    parse_day(text.trim()).ok_or_else(|| {
        invalid(format!(
            "a health {what} states `{text}`, which is not a day of the calendar (YYYY-MM-DD)"
        ))
    })
}

fn instant_of(text: &str, what: &str) -> Result<String> {
    utc_instant(text.trim()).ok_or_else(|| {
        invalid(format!(
            "a health today read states {what} `{text}`, which is not a UTC instant"
        ))
    })
}

fn metric_to_wire(metric: Metric) -> i32 {
    (match metric {
        Metric::Steps => wire::HealthMetric::Steps,
        Metric::SleepMin => wire::HealthMetric::SleepMin,
        Metric::ActiveEnergyKcal => wire::HealthMetric::ActiveEnergyKcal,
        Metric::ExerciseMin => wire::HealthMetric::ExerciseMin,
        Metric::RestingHrBpm => wire::HealthMetric::RestingHrBpm,
        Metric::WeightKg => wire::HealthMetric::WeightKg,
    }) as i32
}

fn metric_of(value: i32) -> Result<Metric> {
    use wire::HealthMetric as M;
    match M::try_from(value).unwrap_or(M::Unspecified) {
        M::Steps => Ok(Metric::Steps),
        M::SleepMin => Ok(Metric::SleepMin),
        M::ActiveEnergyKcal => Ok(Metric::ActiveEnergyKcal),
        M::ExerciseMin => Ok(Metric::ExerciseMin),
        M::RestingHrBpm => Ok(Metric::RestingHrBpm),
        M::WeightKg => Ok(Metric::WeightKg),
        M::Unspecified => Err(invalid("a health series read names no metric".to_owned())),
    }
}

fn count(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

fn bucket(bucket: Bucket) -> wire::HealthBucket {
    wire::HealthBucket {
        start: format_day(bucket.first),
        end: format_day(bucket.last),
        value: bucket.value,
        days: count(bucket.days),
    }
}

fn workout_row(workout: Workout) -> wire::HealthWorkoutRow {
    wire::HealthWorkoutRow {
        activity_id: workout.activity_id,
        kind_concept_id: workout.kind.concept_id,
        kind_key: workout.kind.key,
        kind_label: workout.kind.label,
        phone_kind: workout.phone_kind,
        started_at: workout.started_at,
        ended_at: workout.ended_at,
        moving_sec: workout.moving_sec,
        distance_m: workout.distance_m,
        energy_kcal: workout.energy_kcal,
        avg_hr_bpm: workout.avg_hr_bpm,
        elevation_gain_m: workout.elevation_gain_m,
        recorded_by: workout.recorded_by,
    }
}

// ---------------------------------------------------------------------------
// The six arms (120-125).
// ---------------------------------------------------------------------------

pub(super) fn today(door: &VaultDoor<'_>, asked: &wire::HealthTodayRequest) -> Result<Answer> {
    let today = day_of(&asked.today, "today read")?;
    let day_start = instant_of(&asked.day_start, "`day_start`")?;
    let day_end = instant_of(&asked.day_end, "`day_end`")?;
    if day_end <= day_start {
        return Err(invalid(
            "a health today read's `day_end` is not after its `day_start`".to_owned(),
        ));
    }
    settle(
        door,
        done(queries::today(door, today, &day_start, &day_end)),
        |data| {
            Answer::HealthToday(wire::HealthToday {
                today: data.today,
                metrics: data
                    .metrics
                    .into_iter()
                    .map(|metric| {
                        let (day, value) = metric
                            .value
                            .map_or((None, None), |(day, value)| (Some(day), Some(value)));
                        wire::HealthTodayMetric {
                            metric: metric_to_wire(metric.metric),
                            value,
                            day,
                            typical: metric.typical.map(|typical| typical.typical),
                            low: metric.typical.map(|typical| typical.low),
                            high: metric.typical.map(|typical| typical.high),
                            typical_days: metric.typical.map_or(0, |typical| count(typical.days)),
                        }
                    })
                    .collect(),
                workouts: data.workouts.into_iter().map(workout_row).collect(),
                connected: data.connected,
                metrics_with_data: data
                    .metrics_with_data
                    .into_iter()
                    .map(metric_to_wire)
                    .collect(),
            })
        },
    )
}

pub(super) fn series(door: &VaultDoor<'_>, asked: &wire::HealthSeriesRequest) -> Result<Answer> {
    let metric = metric_of(asked.metric)?;
    use wire::HealthRange as R;
    let range = match R::try_from(asked.range).unwrap_or(R::Unspecified) {
        R::Week => Range::Week,
        R::Month => Range::Month,
        R::Year => Range::Year,
        R::Unspecified => {
            return Err(invalid("a health series read names no range".to_owned()));
        }
    };
    let today = day_of(&asked.today, "series read")?;
    settle(
        door,
        done(queries::series(door, metric, range, today)),
        |data| {
            Answer::HealthSeries(wire::HealthSeries {
                metric: metric_to_wire(data.metric),
                range: asked.range,
                today: data.today,
                buckets: data.buckets.into_iter().map(bucket).collect(),
                average: data.average,
                previous_average: data.previous_average,
                typical: data.typical,
                best: data.best.map(bucket),
                total: data.total,
                above_typical: count(data.above_typical),
                counted: count(data.counted),
            })
        },
    )
}

pub(super) fn trends(door: &VaultDoor<'_>, asked: &wire::HealthTrendsRequest) -> Result<Answer> {
    use wire::HealthTrendRange as R;
    let range = match R::try_from(asked.range).unwrap_or(R::Unspecified) {
        R::Days30 => TrendRange::Days30,
        R::Days90 => TrendRange::Days90,
        R::Year => TrendRange::Year,
        R::Unspecified => {
            return Err(invalid("a health trends read names no range".to_owned()));
        }
    };
    let today = day_of(&asked.today, "trends read")?;
    settle(door, done(queries::trends(door, range, today)), |data| {
        Answer::HealthTrends(wire::HealthTrends {
            range: asked.range,
            today: data.today,
            trends: data
                .trends
                .into_iter()
                .map(|trend| wire::HealthTrend {
                    metric: metric_to_wire(trend.metric),
                    average: trend.average,
                    previous: trend.previous,
                    buckets: trend.buckets.into_iter().map(bucket).collect(),
                })
                .collect(),
        })
    })
}

pub(super) fn workouts(
    door: &VaultDoor<'_>,
    asked: &wire::HealthWorkoutsRequest,
) -> Result<Answer> {
    if asked.limit == 0 || asked.limit > WORKOUTS_PAGE_MAX {
        return Err(invalid(format!(
            "a health workouts read asks for {} rows; a page is 1 to {WORKOUTS_PAGE_MAX}, and a \
             default is how an unbounded read gets written by accident",
            asked.limit
        )));
    }
    let limit = usize::try_from(asked.limit).unwrap_or(usize::MAX);
    let request = match &asked.after {
        Some(cursor) => PageRequest::after(
            limit,
            PageCursor {
                sort_key: cursor.started_at.clone(),
                pk: cursor.activity_id.clone(),
            },
        ),
        None => PageRequest::first(limit),
    };
    let kind = asked
        .kind_concept_id
        .as_deref()
        .map(str::trim)
        .filter(|kind| !kind.is_empty());
    settle(
        door,
        done(queries::workouts(door, kind, &request)),
        |data| {
            Answer::HealthWorkouts(wire::HealthWorkouts {
                workouts: data.rows.into_iter().map(workout_row).collect(),
                kinds: data
                    .kinds
                    .into_iter()
                    .map(|counted| wire::HealthKindCount {
                        kind_concept_id: counted.kind.concept_id,
                        kind_key: counted.kind.key,
                        kind_label: counted.kind.label,
                        count: count(counted.count),
                    })
                    .collect(),
                next: data.next.map(|next| wire::HealthWorkoutsCursor {
                    started_at: next.sort_key,
                    activity_id: next.pk,
                }),
            })
        },
    )
}

pub(super) fn workout(door: &VaultDoor<'_>, asked: &wire::HealthWorkoutRequest) -> Result<Answer> {
    let activity_id = asked.activity_id.trim();
    if activity_id.is_empty() {
        return Err(invalid(
            "a health workout read names no `activity_id`".to_owned(),
        ));
    }
    settle(door, done(queries::workout(door, activity_id)), |found| {
        Answer::HealthWorkout(wire::HealthWorkout {
            workout: found.map(workout_row),
        })
    })
}

pub(super) fn follow_view(
    door: &VaultDoor<'_>,
    asked: &wire::HealthFollowViewRequest,
) -> Result<Answer> {
    let since = day_of(&asked.since, "follow view")?;
    settle(door, done(queries::follow_view(door, since)), |view| {
        Answer::HealthFollowView(wire::HealthFollowView {
            latest_day: view.latest_day,
            latest_workout_started_at: view.latest_workout_started_at,
            days: view
                .days
                .into_iter()
                .map(|day| wire::HealthDayValue {
                    day: day.day,
                    metric: metric_to_wire(day.metric),
                    value: day.value,
                })
                .collect(),
        })
    })
}

#[cfg(test)]
#[path = "health_tests.rs"]
mod tests;
