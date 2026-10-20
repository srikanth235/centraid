//! HEALTH'S READS, AS STATEMENTS-AS-DATA WITH STATED CEILINGS.
//!
//! **There is no SQL in this crate.** A statement is a [`PageQuery`] and the kit is the only
//! place that turns one into SQL; the core runs it through its page door. Every read here is
//! bounded by a number this module states, and a read that reaches its ceiling is
//! [`centraid_apps_kit::error::KitError::FanOutExceeded`] — the core's
//! `ERROR_CODE_READ_BOUND_REACHED` — never a short answer: a typical computed over a silently
//! short window is a wrong number, not a slow screen.
//!
//! A workout is read as its `core_activity` (the span and the kind, keyset-ordered by
//! `(started_at, activity_id)` on the rung's page index) and then its `health_workout` row by id
//! in a second bounded statement: the page door serves one table per statement. The activities
//! that are workouts are the ones whose kind is a concept of the `health:workout-kinds` scheme,
//! which only `health.follow_workout` writes, and always with the workout row beside it; a
//! purge removes both.
//!
//! | Ceiling | Rows | What it bounds |
//! | --- | --- | --- |
//! | [`DAY_ROWS`] | 5,000 | two years of one metric, or a trend year and the year before of all six |
//! | [`FOLLOW_DAY_ROWS`] | 2,400 | the follower's window: 400 days of the six metrics |
//! | [`KIND_ROWS`] | 500 | the workout kinds, seeded and minted |
//! | [`WORKOUT_ROWS`] | 20,000 | every workout, for the kind counts |
//! | [`DAY_WORKOUT_ROWS`] | 200 | one day's workouts |

use std::collections::BTreeMap;

use centraid_apps_kit::error::KitResult;
use centraid_apps_kit::page::{Page, PageRequest};
use centraid_apps_kit::reads::{FanOutBound, PageDoor, in_list, read_page, read_pages};
use centraid_apps_kit::row::{Cell, Row, text_of};
use centraid_apps_kit::statement::{PageBindValue, PageOrder, PageQuery};

use crate::figures::Metric;

/// Two years of one metric, or a trend year and the year before it of all six (4,386 rows).
pub const DAY_ROWS: FanOutBound = FanOutBound::new(500, 10);
/// The follower's window: 400 days of the six metrics.
pub const FOLLOW_DAY_ROWS: FanOutBound = FanOutBound::new(400, 6);
/// The workout kinds, seeded and minted.
pub const KIND_ROWS: FanOutBound = FanOutBound::new(500, 1);
/// Every workout, for the kind counts the Workouts filter draws.
pub const WORKOUT_ROWS: FanOutBound = FanOutBound::new(500, 40);
/// One day's workouts.
pub const DAY_WORKOUT_ROWS: FanOutBound = FanOutBound::new(200, 1);
/// Workout rows read by id per statement.
const MEASURE_CHUNK: usize = 200;

/// The scheme every workout kind lives in (rung three seeds it under this id).
pub const WORKOUT_KINDS_SCHEME_ID: &str = "health:workout-kinds";
/// The `phone_origin.source` a health store's origin carries.
pub const HEALTH_SOURCE: &str = "health";

// ---------------------------------------------------------------------------
// Rows.
// ---------------------------------------------------------------------------

/// One stated daily total.
#[derive(Debug, Clone, PartialEq)]
pub struct DayRow {
    /// `YYYY-MM-DD`.
    pub day: String,
    pub metric: Metric,
    pub value: f64,
}

/// One workout kind.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KindRow {
    pub concept_id: String,
    /// The notation: `run`, or the store's word for a kind the seed does not name.
    pub key: String,
    pub label: String,
}

/// A workout's activity: the entity, its kind and its span.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivityRow {
    pub activity_id: String,
    pub kind_concept_id: String,
    pub started_at: String,
    pub ended_at: Option<String>,
}

/// What the store measured, from `health_workout`.
#[derive(Debug, Clone, PartialEq)]
pub struct MeasureRow {
    pub activity_id: String,
    pub phone_kind: String,
    pub recorded_by: Option<String>,
    pub moving_sec: Option<i64>,
    pub distance_m: Option<f64>,
    pub energy_kcal: Option<f64>,
    pub avg_hr_bpm: Option<i64>,
    pub elevation_gain_m: Option<f64>,
}

fn real_of(row: &Row, column: &str) -> Option<f64> {
    match row.get(column) {
        Some(Cell::Real(value)) => Some(*value),
        #[allow(clippy::cast_precision_loss)]
        Some(Cell::Integer(value)) => Some(*value as f64),
        _ => None,
    }
}

fn integer_of(row: &Row, column: &str) -> Option<i64> {
    row.get(column).and_then(Cell::integer)
}

fn text(row: &Row, column: &str) -> String {
    text_of(row, column).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Statements.
// ---------------------------------------------------------------------------

/// `health.vault` — the vault's own party, whose days these are.
#[must_use]
pub fn vault_statement() -> PageQuery {
    PageQuery::new(
        "health.vault",
        "vault_id, self_party_id",
        "core_vault",
        PageOrder::asc("vault_id", "vault_id"),
    )
}

/// `health.days` — a subject's totals over `[first, last]`, oldest first; one metric's, or all
/// six. `(day, metric)` is unique for a subject, so it is the keyset.
#[must_use]
pub fn days_statement(subject: &str, first: &str, last: &str, metric: Option<Metric>) -> PageQuery {
    let mut bind = vec![
        PageBindValue::from(subject),
        PageBindValue::from(first),
        PageBindValue::from(last),
    ];
    let mut predicate = "subject_party_id = ? AND day >= ? AND day <= ?".to_owned();
    if let Some(metric) = metric {
        predicate.push_str(" AND metric = ?");
        bind.push(PageBindValue::from(metric.key()));
    }
    PageQuery::new(
        "health.days",
        "day, metric, value",
        "health_daily",
        PageOrder::asc("day", "metric"),
    )
    .filter(&predicate, bind)
}

/// `health.days.latest` — a subject's newest day with any row.
#[must_use]
pub fn latest_day_statement(subject: &str) -> PageQuery {
    PageQuery::new(
        "health.days.latest",
        "day, metric",
        "health_daily",
        PageOrder::desc("day", "metric"),
    )
    .filter("subject_party_id = ?", vec![PageBindValue::from(subject)])
}

/// `health.origin` — a health store's origin, if one was ever connected.
#[must_use]
pub fn origin_statement() -> PageQuery {
    PageQuery::new(
        "health.origin",
        "origin_id, source",
        "phone_origin",
        PageOrder::asc("origin_id", "origin_id"),
    )
    .filter("source = ?", vec![PageBindValue::from(HEALTH_SOURCE)])
}

/// `health.kinds` — every workout kind, seeded and minted.
#[must_use]
pub fn kinds_statement() -> PageQuery {
    PageQuery::new(
        "health.kinds",
        "concept_id, notation, pref_label",
        "core_concept",
        PageOrder::asc("concept_id", "concept_id"),
    )
    .filter(
        "scheme_id = ?",
        vec![PageBindValue::from(WORKOUT_KINDS_SCHEME_ID)],
    )
}

const ACTIVITY_COLUMNS: &str = "activity_id, kind_concept_id, started_at, ended_at";

/// `health.workouts` — the activities of the given kinds, newest first, optionally only those
/// that started in `[start, end)`.
///
/// # Errors
///
/// An empty kind list, which is a caller that should not be reading.
pub fn workouts_statement(kinds: &[String], span: Option<(&str, &str)>) -> KitResult<PageQuery> {
    let fragment = in_list("kind_concept_id", kinds)?;
    let mut predicate = fragment.sql;
    let mut bind = fragment.bind;
    if let Some((start, end)) = span {
        predicate.push_str(" AND started_at >= ? AND started_at < ?");
        bind.push(PageBindValue::from(start));
        bind.push(PageBindValue::from(end));
    }
    Ok(PageQuery::new(
        "health.workouts",
        ACTIVITY_COLUMNS,
        "core_activity",
        PageOrder::desc("started_at", "activity_id"),
    )
    .filter(&predicate, bind))
}

/// `health.workout` — one activity by id.
#[must_use]
pub fn activity_statement(activity_id: &str) -> PageQuery {
    PageQuery::new(
        "health.workout",
        ACTIVITY_COLUMNS,
        "core_activity",
        PageOrder::asc("activity_id", "activity_id"),
    )
    .filter("activity_id = ?", vec![PageBindValue::from(activity_id)])
}

/// `health.workouts.measures` — what the store measured, for a set of activities.
///
/// # Errors
///
/// An empty id list.
pub fn measures_statement(activity_ids: &[String]) -> KitResult<PageQuery> {
    let fragment = in_list("activity_id", activity_ids)?;
    Ok(PageQuery::new(
        "health.workouts.measures",
        "activity_id, phone_kind, recorded_by, moving_sec, distance_m, energy_kcal, avg_hr_bpm, \
         elevation_gain_m",
        "health_workout",
        PageOrder::asc("activity_id", "activity_id"),
    )
    .filter(&fragment.sql, fragment.bind))
}

// ---------------------------------------------------------------------------
// Reads.
// ---------------------------------------------------------------------------

/// The vault's own party, `None` before the vault is founded.
///
/// # Errors
///
/// A door failure.
pub fn self_party(door: &dyn PageDoor) -> KitResult<Option<String>> {
    let page = read_page(door, &vault_statement(), &PageRequest::first(1))?;
    Ok(page
        .rows
        .first()
        .and_then(|row| text_of(row, "self_party_id")))
}

/// A subject's totals over `[first, last]`, oldest first, to `bound`.
///
/// # Errors
///
/// A door failure, or more rows than `bound` holds.
pub fn days(
    door: &dyn PageDoor,
    subject: &str,
    first: &str,
    last: &str,
    metric: Option<Metric>,
    bound: FanOutBound,
) -> KitResult<Vec<DayRow>> {
    let rows = read_pages(door, &days_statement(subject, first, last, metric), bound)?;
    Ok(rows
        .iter()
        .filter_map(|row| {
            Some(DayRow {
                day: text_of(row, "day")?,
                metric: Metric::from_key(&text_of(row, "metric")?)?,
                value: real_of(row, "value")?,
            })
        })
        .collect())
}

/// A subject's newest day with any row.
///
/// # Errors
///
/// A door failure.
pub fn latest_day(door: &dyn PageDoor, subject: &str) -> KitResult<Option<String>> {
    let page = read_page(door, &latest_day_statement(subject), &PageRequest::first(1))?;
    Ok(page.rows.first().and_then(|row| text_of(row, "day")))
}

/// Whether a health store was ever connected: a `phone_origin` of source `health` exists.
///
/// # Errors
///
/// A door failure.
pub fn connected(door: &dyn PageDoor) -> KitResult<bool> {
    Ok(
        !read_page(door, &origin_statement(), &PageRequest::first(1))?
            .rows
            .is_empty(),
    )
}

/// Every workout kind.
///
/// # Errors
///
/// A door failure, or more kinds than [`KIND_ROWS`].
pub fn kinds(door: &dyn PageDoor) -> KitResult<Vec<KindRow>> {
    Ok(read_pages(door, &kinds_statement(), KIND_ROWS)?
        .iter()
        .map(|row| KindRow {
            concept_id: text(row, "concept_id"),
            key: text(row, "notation"),
            label: text(row, "pref_label"),
        })
        .collect())
}

fn activity_of(row: &Row) -> ActivityRow {
    ActivityRow {
        activity_id: text(row, "activity_id"),
        kind_concept_id: text(row, "kind_concept_id"),
        started_at: text(row, "started_at"),
        ended_at: text_of(row, "ended_at"),
    }
}

/// One page of the workouts of `kinds`, newest first.
///
/// # Errors
///
/// A door failure, or an empty kind list.
pub fn workout_page(
    door: &dyn PageDoor,
    kinds: &[String],
    request: &PageRequest,
) -> KitResult<Page<ActivityRow>> {
    let page = read_page(door, &workouts_statement(kinds, None)?, request)?;
    Ok(Page {
        rows: page.rows.iter().map(activity_of).collect(),
        next: page.next,
    })
}

/// Every workout of `kinds`, newest first, to [`WORKOUT_ROWS`].
///
/// # Errors
///
/// A door failure, an empty kind list, or more workouts than the ceiling.
pub fn every_workout(door: &dyn PageDoor, kinds: &[String]) -> KitResult<Vec<ActivityRow>> {
    Ok(
        read_pages(door, &workouts_statement(kinds, None)?, WORKOUT_ROWS)?
            .iter()
            .map(activity_of)
            .collect(),
    )
}

/// The workouts of `kinds` that started in `[start, end)`, newest first.
///
/// # Errors
///
/// A door failure, an empty kind list, or more than [`DAY_WORKOUT_ROWS`].
pub fn workouts_started_between(
    door: &dyn PageDoor,
    kinds: &[String],
    start: &str,
    end: &str,
) -> KitResult<Vec<ActivityRow>> {
    Ok(read_pages(
        door,
        &workouts_statement(kinds, Some((start, end)))?,
        DAY_WORKOUT_ROWS,
    )?
    .iter()
    .map(activity_of)
    .collect())
}

/// One activity by id.
///
/// # Errors
///
/// A door failure.
pub fn activity(door: &dyn PageDoor, activity_id: &str) -> KitResult<Option<ActivityRow>> {
    let page = read_page(
        door,
        &activity_statement(activity_id),
        &PageRequest::first(1),
    )?;
    Ok(page.rows.first().map(activity_of))
}

/// What the store measured, by activity id, for the ids that are workouts.
///
/// # Errors
///
/// A door failure.
pub fn measures(
    door: &dyn PageDoor,
    activity_ids: &[String],
) -> KitResult<BTreeMap<String, MeasureRow>> {
    let mut found = BTreeMap::new();
    for chunk in activity_ids.chunks(MEASURE_CHUNK) {
        let rows = read_pages(
            door,
            &measures_statement(chunk)?,
            FanOutBound::new(MEASURE_CHUNK, 1),
        )?;
        for row in &rows {
            let measure = MeasureRow {
                activity_id: text(row, "activity_id"),
                phone_kind: text(row, "phone_kind"),
                recorded_by: text_of(row, "recorded_by"),
                moving_sec: integer_of(row, "moving_sec"),
                distance_m: real_of(row, "distance_m"),
                energy_kcal: real_of(row, "energy_kcal"),
                avg_hr_bpm: integer_of(row, "avg_hr_bpm"),
                elevation_gain_m: real_of(row, "elevation_gain_m"),
            };
            found.insert(measure.activity_id.clone(), measure);
        }
    }
    Ok(found)
}
