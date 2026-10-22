//! HEALTH'S ARM OF THE APP QUERY (#1129): `crates/apps/health`'s six answers, asked through
//! [`super::VaultDoor`] and spelled as `health.proto` spells them.
//!
//! Every figure is the crate's (R-1129-12): this module checks what the request states, runs the
//! answer and converts. EVERYTHING CIVIL IS PLACED HERE, in the request's `tz` ([`zone_of`]'s
//! rule): today is the vault clock's day there, today's bounds are that day's first instant and
//! the next day's, a workout's wall clock is its instant read there, and the follower's window
//! is placed from the latests in it. A shell does no date arithmetic (#1046's rule, RP-K-2).

use centraid_api_proto::core_v1 as wire;
use centraid_apps_agenda::local;
use centraid_apps_health::civil::{format_day, parse_day, utc_instant};
use centraid_apps_health::figures::{Bucket, Metric};
use centraid_apps_health::queries::{self, Range, TrendRange, Workout};
use centraid_apps_kit::error::KitResult;
use centraid_apps_kit::page::{PageCursor, PageRequest};
use centraid_vault::Vault;
use centraid_vault::time::recurrence::parse_instant_ms;
use centraid_vault::time::zone::{FireZone, WallTime, add_wall_days, parse_wall_iso};

use super::{VaultDoor, settle, zone_if_any, zone_of};
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

fn invariant(what: &str, value: &str) -> CoreError {
    CoreError::Invariant {
        context: format!("a health read could not place {what}: {value}"),
    }
}

/// The vault clock's day in `zone`: as a day count, and as the wall time its civil readings
/// start from.
fn today_in(zone: &FireZone, now: &str) -> Result<(i64, WallTime)> {
    let text = local::today(zone, now).ok_or_else(|| invariant("today", now))?;
    let day = parse_day(&text).ok_or_else(|| invariant("today", &text))?;
    let wall = parse_wall_iso(&text).ok_or_else(|| invariant("today", &text))?;
    Ok((day, wall))
}

/// The first instant of a day in `zone`, in the vault's spelling.
fn start_of(zone: &FireZone, day: WallTime) -> Result<String> {
    let instant = local::start_of_day(zone, day);
    utc_instant(&instant).ok_or_else(|| invariant("a day's first instant", &instant))
}

/// The wall time of a day count, for [`start_of`].
fn wall_of(day: i64) -> Result<WallTime> {
    let text = format_day(day);
    parse_wall_iso(&text).ok_or_else(|| invariant("a day", &text))
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

/// A workout as the wire spells it. Its wall clock is `local`'s minute reading of each instant in
/// `zone`; with no zone (a list read as a decoration, [`zone_if_any`]) or an instant no command
/// writes, it is empty rather than a guess.
fn workout_row(workout: Workout, zone: Option<&FireZone>) -> wire::HealthWorkoutRow {
    let wall = |instant: &str| {
        zone.and_then(|zone| local::now_local(zone, instant))
            .unwrap_or_default()
    };
    let local_start = wall(&workout.started_at);
    let local_end = wall(&workout.ended_at);
    let span = parse_instant_ms(&workout.started_at)
        .zip(parse_instant_ms(&workout.ended_at))
        .map_or(0, |(start, end)| (end - start).max(0) / 1_000);
    wire::HealthWorkoutRow {
        local_start,
        local_end,
        length_sec: workout.moving_sec.unwrap_or(span),
        activity_id: workout.activity_id,
        kind_concept_id: workout.kind.concept_id,
        kind_key: workout.kind.key,
        kind_label: workout.kind.label,
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

pub(super) fn today(
    vault: &Vault,
    door: &VaultDoor<'_>,
    now: &str,
    asked: &wire::HealthTodayRequest,
) -> Result<Answer> {
    let zone = zone_of(vault, &asked.tz)?;
    let (today, wall) = today_in(&zone, now)?;
    let day_start = start_of(&zone, wall)?;
    let day_end = start_of(&zone, add_wall_days(wall, 1))?;
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
                workouts: data
                    .workouts
                    .into_iter()
                    .map(|workout| workout_row(workout, Some(&zone)))
                    .collect(),
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

pub(super) fn series(
    vault: &Vault,
    door: &VaultDoor<'_>,
    now: &str,
    asked: &wire::HealthSeriesRequest,
) -> Result<Answer> {
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
    let (today, _) = today_in(&zone_of(vault, &asked.tz)?, now)?;
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
                versus_typical: data.versus_typical,
                versus_typical_pct: data.versus_typical_pct,
            })
        },
    )
}

pub(super) fn trends(
    vault: &Vault,
    door: &VaultDoor<'_>,
    now: &str,
    asked: &wire::HealthTrendsRequest,
) -> Result<Answer> {
    use wire::HealthTrendRange as R;
    let range = match R::try_from(asked.range).unwrap_or(R::Unspecified) {
        R::Days30 => TrendRange::Days30,
        R::Days90 => TrendRange::Days90,
        R::Year => TrendRange::Year,
        R::Unspecified => {
            return Err(invalid("a health trends read names no range".to_owned()));
        }
    };
    let (today, _) = today_in(&zone_of(vault, &asked.tz)?, now)?;
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
                    change: trend.change,
                    change_pct: trend.change_pct,
                })
                .collect(),
        })
    })
}

pub(super) fn workouts(
    vault: &Vault,
    door: &VaultDoor<'_>,
    asked: &wire::HealthWorkoutsRequest,
) -> Result<Answer> {
    let zone = zone_if_any(vault, &asked.tz)?;
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
                workouts: data
                    .rows
                    .into_iter()
                    .map(|workout| workout_row(workout, zone.as_ref()))
                    .collect(),
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

pub(super) fn workout(
    vault: &Vault,
    door: &VaultDoor<'_>,
    asked: &wire::HealthWorkoutRequest,
) -> Result<Answer> {
    let zone = zone_if_any(vault, &asked.tz)?;
    let activity_id = asked.activity_id.trim();
    if activity_id.is_empty() {
        return Err(invalid(
            "a health workout read names no `activity_id`".to_owned(),
        ));
    }
    settle(door, done(queries::workout(door, activity_id)), |found| {
        Answer::HealthWorkout(wire::HealthWorkout {
            workout: found.map(|workout| workout_row(workout, zone.as_ref())),
        })
    })
}

pub(super) fn follow_view(
    vault: &Vault,
    door: &VaultDoor<'_>,
    now: &str,
    asked: &wire::HealthFollowViewRequest,
) -> Result<Answer> {
    let zone = zone_of(vault, &asked.tz)?;
    let (today, _) = today_in(&zone, now)?;
    let workout_day =
        |started_at: &str| local::today(&zone, started_at).and_then(|day| parse_day(&day));
    let loaded = queries::follow_view(door, today, workout_day);
    // THE INSTANT THE WORKOUTS' WINDOW OPENS, placed here so the reader is handed it.
    let workouts_since = match &loaded {
        Ok(view) => start_of(&zone, wall_of(view.workouts_from)?)?,
        Err(_) => String::new(),
    };
    settle(door, done(loaded), |view| {
        Answer::HealthFollowView(wire::HealthFollowView {
            today: view.today,
            totals_from: format_day(view.totals_from),
            workouts_from: format_day(view.workouts_from),
            workouts_since,
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
