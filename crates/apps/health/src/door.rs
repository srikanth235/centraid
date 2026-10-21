//! HEALTH'S READS, AS STATEMENTS-AS-DATA WITH STATED CEILINGS.
//!
//! **There is no SQL in this crate.** A statement is a [`PageQuery`] and the kit is the only
//! place that turns one into SQL; the core runs it through its page door. Every read here is
//! bounded by a number this module states, and a read that reaches its ceiling is
//! [`centraid_apps_kit::error::KitError::FanOutExceeded`] — the core's
//! `ERROR_CODE_READ_BOUND_REACHED` — never a short answer: a typical computed over a silently
//! short window is a wrong number, not a slow screen.
//!
//! A workout is read as its `activity` (the span and the kind, keyset-ordered by `(starts, id)` on
//! the model's page index), then its `workout` row (what the store measured) and its `entity` row
//! (whether it is in the trash) by id, each in a bounded statement of its own: the page door serves
//! one table per statement. The activities that are workouts are the ones whose kind is a
//! `workout_kind`, which only `follow.health` writes, and always with the workout row beside it;
//! a purge removes both.
//!
//! //! | Ceiling | Rows | What it bounds |
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

/// The `origin.system` a health store's origin carries.
pub const HEALTH_SYSTEM: &str = "health";
/// The `activity.type_kind` of a workout.
pub const WORKOUT_KIND: &str = "workout_kind";

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
    /// The key: `run`, or the store's word (folded) for a kind the seed does not name.
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

/// What the store measured, from `workout`.
#[derive(Debug, Clone, PartialEq)]
pub struct MeasureRow {
    pub activity_id: String,
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

/// `health.vault` — the vault's own person, whose days these are.
#[must_use]
pub fn vault_statement() -> PageQuery {
    PageQuery::new(
        "health.vault",
        "id, self_id",
        "vault",
        PageOrder::asc("id", "id"),
    )
}

/// `health.days` — a person's totals over `[first, last]`, oldest first; one metric's, or all
/// six. `(day, metric)` is unique for a person, so it is the keyset.
#[must_use]
pub fn days_statement(subject: &str, first: &str, last: &str, metric: Option<Metric>) -> PageQuery {
    let mut bind = vec![
        PageBindValue::from(subject),
        PageBindValue::from(first),
        PageBindValue::from(last),
    ];
    let mut predicate = "person_id = ? AND day >= ? AND day <= ?".to_owned();
    if let Some(metric) = metric {
        predicate.push_str(" AND metric = ?");
        bind.push(PageBindValue::from(metric.key()));
    }
    PageQuery::new(
        "health.days",
        "day, metric, value",
        "measurement",
        PageOrder::asc("day", "metric"),
    )
    .filter(&predicate, bind)
}

/// `health.days.latest` — a person's newest day with any row.
#[must_use]
pub fn latest_day_statement(subject: &str) -> PageQuery {
    PageQuery::new(
        "health.days.latest",
        "day, metric",
        "measurement",
        PageOrder::desc("day", "metric"),
    )
    .filter("person_id = ?", vec![PageBindValue::from(subject)])
}

/// `health.origin` — a health store's origin, if one was ever connected.
#[must_use]
pub fn origin_statement() -> PageQuery {
    PageQuery::new(
        "health.origin",
        "id, system",
        "origin",
        PageOrder::asc("id", "id"),
    )
    .filter("system = ?", vec![PageBindValue::from(HEALTH_SYSTEM)])
}

/// `health.kinds` — every workout kind's key, seeded and minted.
#[must_use]
pub fn kinds_statement() -> PageQuery {
    PageQuery::new(
        "health.kinds",
        "id, key",
        "concept",
        PageOrder::asc("id", "id"),
    )
    .filter("kind = ?", vec![PageBindValue::from(WORKOUT_KIND)])
}

/// `health.kinds.names` — their names.
#[must_use]
pub fn kind_names_statement() -> PageQuery {
    PageQuery::new(
        "health.kinds.names",
        "id, title",
        "entity",
        PageOrder::asc("id", "id"),
    )
    .filter("kind = ?", vec![PageBindValue::from(WORKOUT_KIND)])
}

const ACTIVITY_COLUMNS: &str = "id, type_id, starts, ends";

/// `health.workouts` — the activities of the given kinds, newest first, optionally only those
/// that started in `[start, end)`.
///
/// # Errors
///
/// An empty kind list, which is a caller that should not be reading.
pub fn workouts_statement(kinds: &[String], span: Option<(&str, &str)>) -> KitResult<PageQuery> {
    let fragment = in_list("type_id", kinds)?;
    let mut predicate = fragment.sql;
    let mut bind = fragment.bind;
    if let Some((start, end)) = span {
        predicate.push_str(" AND starts >= ? AND starts < ?");
        bind.push(PageBindValue::from(start));
        bind.push(PageBindValue::from(end));
    }
    Ok(PageQuery::new(
        "health.workouts",
        ACTIVITY_COLUMNS,
        "activity",
        PageOrder::desc("starts", "id"),
    )
    .filter(&predicate, bind))
}

/// `health.workout` — one activity by id.
#[must_use]
pub fn activity_statement(activity_id: &str) -> PageQuery {
    PageQuery::new(
        "health.workout",
        ACTIVITY_COLUMNS,
        "activity",
        PageOrder::asc("id", "id"),
    )
    .filter("id = ?", vec![PageBindValue::from(activity_id)])
}

/// `health.workouts.measures` — what the store measured, for a set of activities.
///
/// # Errors
///
/// An empty id list.
pub fn measures_statement(activity_ids: &[String]) -> KitResult<PageQuery> {
    let fragment = in_list("id", activity_ids)?;
    Ok(PageQuery::new(
        "health.workouts.measures",
        "id, recorded_by, moving_s, distance_m, energy_kcal, heart_bpm, climb_m",
        "workout",
        PageOrder::asc("id", "id"),
    )
    .filter(&fragment.sql, fragment.bind))
}

/// `health.workouts.entities` — which of a set of activities are in the trash.
///
/// # Errors
///
/// An empty id list.
pub fn entities_statement(activity_ids: &[String]) -> KitResult<PageQuery> {
    let fragment = in_list("id", activity_ids)?;
    Ok(PageQuery::new(
        "health.workouts.entities",
        "id, deleted_at",
        "entity",
        PageOrder::asc("id", "id"),
    )
    .filter(&fragment.sql, fragment.bind))
}

// ---------------------------------------------------------------------------
// Reads.
// ---------------------------------------------------------------------------

/// The vault's own person, `None` before the vault is founded.
///
/// # Errors
///
/// A door failure.
pub fn self_party(door: &dyn PageDoor) -> KitResult<Option<String>> {
    let page = read_page(door, &vault_statement(), &PageRequest::first(1))?;
    Ok(page.rows.first().and_then(|row| text_of(row, "self_id")))
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

/// Whether a health store was ever connected: an `origin` of system `health` exists.
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
    let names: BTreeMap<String, String> = read_pages(door, &kind_names_statement(), KIND_ROWS)?
        .iter()
        .map(|row| (text(row, "id"), text(row, "title")))
        .collect();
    Ok(read_pages(door, &kinds_statement(), KIND_ROWS)?
        .iter()
        .map(|row| {
            let concept_id = text(row, "id");
            KindRow {
                label: names.get(&concept_id).cloned().unwrap_or_default(),
                key: text(row, "key"),
                concept_id,
            }
        })
        .collect())
}

fn activity_of(row: &Row) -> ActivityRow {
    ActivityRow {
        activity_id: text(row, "id"),
        kind_concept_id: text(row, "type_id"),
        started_at: text(row, "starts"),
        ended_at: text_of(row, "ends"),
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
                activity_id: text(row, "id"),
                recorded_by: text_of(row, "recorded_by"),
                moving_sec: integer_of(row, "moving_s"),
                distance_m: real_of(row, "distance_m"),
                energy_kcal: real_of(row, "energy_kcal"),
                avg_hr_bpm: integer_of(row, "heart_bpm"),
                elevation_gain_m: real_of(row, "climb_m"),
            };
            found.insert(measure.activity_id.clone(), measure);
        }
    }
    Ok(found)
}

/// The ids, of those asked about, that are in the trash.
///
/// # Errors
///
/// A door failure.
pub fn trashed(door: &dyn PageDoor, activity_ids: &[String]) -> KitResult<Vec<String>> {
    let mut gone = Vec::new();
    for chunk in activity_ids.chunks(MEASURE_CHUNK) {
        let rows = read_pages(
            door,
            &entities_statement(chunk)?,
            FanOutBound::new(MEASURE_CHUNK, 1),
        )?;
        gone.extend(
            rows.iter()
                .filter(|row| !matches!(row.get("deleted_at"), None | Some(Cell::Null)))
                .map(|row| text(row, "id")),
        );
    }
    Ok(gone)
}
