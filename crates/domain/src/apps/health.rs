//! Health: workouts and readings.

use rusqlite::Row;

use crate::kind::{Export, Footer, KindDecl, Share, Trash, exported, plain};
use crate::read::{DEFAULT_PAGE, ParamTy, Read, ReadDecl, Shape, desc, param, read};

use super::{Trashed, trash};

#[derive(Debug, Clone, PartialEq)]
pub struct DayTotalRow {
    pub day: String,
    pub metric: String,
    pub value: f64,
    pub origin_id: Option<String>,
    pub stated: Option<f64>,
    pub unit: String,
}

impl DayTotalRow {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            day: row.get("day")?,
            metric: row.get("metric")?,
            value: row.get("value")?,
            origin_id: row.get("origin_id")?,
            stated: row.get("stated")?,
            unit: row.get("unit")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct WorkoutSummary {
    pub id: String,
    pub title: String,
    pub type_id: String,
    pub type_title: String,
    pub starts: String,
    pub ends: Option<String>,
    pub moving_s: Option<i64>,
    pub distance_m: Option<f64>,
    pub energy_kcal: Option<f64>,
    pub heart_bpm: Option<i64>,
    pub climb_m: Option<f64>,
    pub starred_at: Option<String>,
}

impl WorkoutSummary {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            title: row.get("title")?,
            type_id: row.get("type_id")?,
            type_title: row.get("type_title")?,
            starts: row.get("starts")?,
            ends: row.get("ends")?,
            moving_s: row.get("moving_s")?,
            distance_m: row.get("distance_m")?,
            energy_kcal: row.get("energy_kcal")?,
            heart_bpm: row.get("heart_bpm")?,
            climb_m: row.get("climb_m")?,
            starred_at: row.get("starred_at")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct WorkoutDetail {
    pub id: String,
    pub title: String,
    pub type_id: String,
    pub starts: String,
    pub ends: Option<String>,
    pub place_id: Option<String>,
    pub recorded_by: Option<String>,
    pub moving_s: Option<i64>,
    pub distance_m: Option<f64>,
    pub energy_kcal: Option<f64>,
    pub heart_bpm: Option<i64>,
    pub climb_m: Option<f64>,
    pub notes: Option<String>,
    pub starred_at: Option<String>,
    pub arrived_via: Option<String>,
    pub arrived_label: Option<String>,
    pub updated_at: String,
}

impl WorkoutDetail {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            title: row.get("title")?,
            type_id: row.get("type_id")?,
            starts: row.get("starts")?,
            ends: row.get("ends")?,
            place_id: row.get("place_id")?,
            recorded_by: row.get("recorded_by")?,
            moving_s: row.get("moving_s")?,
            distance_m: row.get("distance_m")?,
            energy_kcal: row.get("energy_kcal")?,
            heart_bpm: row.get("heart_bpm")?,
            climb_m: row.get("climb_m")?,
            notes: row.get("notes")?,
            starred_at: row.get("starred_at")?,
            arrived_via: row.get("arrived_via")?,
            arrived_label: row.get("arrived_label")?,
            updated_at: row.get("updated_at")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ReadingRow {
    pub id: String,
    pub metric: String,
    pub at: String,
    pub value: f64,
    pub value2: Option<f64>,
    pub context: Option<String>,
    pub unit: String,
}

impl ReadingRow {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            metric: row.get("metric")?,
            at: row.get("at")?,
            value: row.get("value")?,
            value2: row.get("value2")?,
            context: row.get("context")?,
            unit: row.get("unit")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ReadingDetail {
    pub id: String,
    pub person_id: String,
    pub metric: String,
    pub at: String,
    pub value: f64,
    pub value2: Option<f64>,
    pub context: Option<String>,
    pub unit: String,
    pub has_value2: bool,
    pub arrived_via: Option<String>,
    pub arrived_label: Option<String>,
    pub updated_at: String,
}

impl ReadingDetail {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            person_id: row.get("person_id")?,
            metric: row.get("metric")?,
            at: row.get("at")?,
            value: row.get("value")?,
            value2: row.get("value2")?,
            context: row.get("context")?,
            unit: row.get("unit")?,
            has_value2: row.get::<_, i64>("has_value2")? != 0,
            arrived_via: row.get("arrived_via")?,
            arrived_label: row.get("arrived_label")?,
            updated_at: row.get("updated_at")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkoutKindRow {
    pub id: String,
    pub key: String,
    pub title: String,
}

impl WorkoutKindRow {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            key: row.get("key")?,
            title: row.get("title")?,
        })
    }
}

pub const DAY_TOTALS: Read<DayTotalRow> = read(
    ReadDecl {
        name: "health.day_totals",
        shape: Shape::BoundedChild,
        sql: "SELECT m.day, m.metric, m.value, m.origin_id, m.stated, hm.unit \
              FROM measurement m JOIN health_metric hm ON hm.code = m.metric \
              WHERE m.person_id = :person AND m.day = :day \
              ORDER BY m.metric ASC LIMIT 20",
        params: &[param("person", ParamTy::Id), param("day", ParamTy::Day)],
        reads: &["measurement", "health_metric"],
        across: &[],
        bound: 20,
        cursor: &[],
    },
    DayTotalRow::of,
);

pub const METRIC_TREND: Read<DayTotalRow> = read(
    ReadDecl {
        name: "health.metric_trend",
        shape: Shape::BoundedChild,
        sql: "SELECT m.day, m.metric, m.value, m.origin_id, m.stated, hm.unit \
              FROM measurement m INDEXED BY measurement_by_metric \
              JOIN health_metric hm ON hm.code = m.metric \
              WHERE m.metric = :metric AND m.person_id = :person \
                AND m.day >= :from_day AND m.day <= :to_day \
              ORDER BY m.day ASC LIMIT 90",
        params: &[
            param("metric", ParamTy::Text),
            param("person", ParamTy::Id),
            param("from_day", ParamTy::Day),
            param("to_day", ParamTy::Day),
        ],
        reads: &["measurement", "health_metric"],
        across: &[],
        bound: 90,
        cursor: &[],
    },
    DayTotalRow::of,
);

pub const WORKOUTS: Read<WorkoutSummary> = read(
    ReadDecl {
        name: "health.workouts",
        shape: Shape::PagedList,
        sql: "SELECT w.id, e.title, w.type_id, te.title AS type_title, w.starts, w.ends, \
                     w.moving_s, w.distance_m, w.energy_kcal, w.heart_bpm, w.climb_m, e.starred_at \
              FROM workout w INDEXED BY workout_by_start \
              JOIN entity e ON e.id = w.id \
              JOIN entity te ON te.id = w.type_id \
              WHERE e.deleted_at IS NULL AND (w.starts, w.id) < (:a, :b) \
              ORDER BY w.starts DESC, w.id DESC LIMIT :n",
        params: &[],
        reads: &["workout"],
        across: &["entity"],
        bound: DEFAULT_PAGE,
        cursor: &[desc("starts", "a"), desc("id", "b")],
    },
    WorkoutSummary::of,
);

pub const WORKOUT_BY_ID: Read<WorkoutDetail> = read(
    ReadDecl {
        name: "health.workout_by_id",
        shape: Shape::ByKey,
        sql: "SELECT workout.id, entity.title, workout.type_id, workout.starts, workout.ends, \
                     workout.place_id, workout.recorded_by, workout.moving_s, workout.distance_m, \
                     workout.energy_kcal, workout.heart_bpm, workout.climb_m, workout.notes, \
                     entity.starred_at, entity.arrived_via, entity.arrived_label, entity.updated_at \
              FROM workout JOIN entity ON entity.id = workout.id \
              WHERE workout.id = :id AND entity.deleted_at IS NULL",
        params: &[param("id", ParamTy::Id)],
        reads: &["workout"],
        across: &["entity"],
        bound: 1,
        cursor: &[],
    },
    WorkoutDetail::of,
);

pub const READINGS_BY_METRIC: Read<ReadingRow> = read(
    ReadDecl {
        name: "health.readings_by_metric",
        shape: Shape::PagedList,
        sql: "SELECT r.id, r.metric, r.at, r.value, r.value2, r.context, hm.unit \
              FROM reading r INDEXED BY reading_by_person \
              JOIN entity e ON e.id = r.id \
              JOIN health_metric hm ON hm.code = r.metric \
              WHERE r.person_id = :person AND r.metric = :metric \
                AND e.deleted_at IS NULL AND (r.at, r.id) < (:a, :b) \
              ORDER BY r.at DESC, r.id DESC LIMIT :n",
        params: &[param("person", ParamTy::Id), param("metric", ParamTy::Text)],
        reads: &["reading", "health_metric"],
        across: &["entity"],
        bound: DEFAULT_PAGE,
        cursor: &[desc("at", "a"), desc("id", "b")],
    },
    ReadingRow::of,
);

pub const READING_BY_ID: Read<ReadingDetail> = read(
    ReadDecl {
        name: "health.reading_by_id",
        shape: Shape::ByKey,
        sql: "SELECT reading.id, reading.person_id, reading.metric, reading.at, reading.value, \
                     reading.value2, reading.context, health_metric.unit, health_metric.has_value2, \
                     entity.arrived_via, entity.arrived_label, entity.updated_at \
              FROM reading \
              JOIN entity ON entity.id = reading.id \
              JOIN health_metric ON health_metric.code = reading.metric \
              WHERE reading.id = :id AND entity.deleted_at IS NULL",
        params: &[param("id", ParamTy::Id)],
        reads: &["reading", "health_metric"],
        across: &["entity"],
        bound: 1,
        cursor: &[],
    },
    ReadingDetail::of,
);

pub const WORKOUT_KINDS: Read<WorkoutKindRow> = read(
    ReadDecl {
        name: "health.workout_kinds",
        shape: Shape::BoundedChild,
        sql: "SELECT c.id, c.key, e.title \
              FROM concept c JOIN entity e ON e.id = c.id \
              WHERE c.kind = 'workout_kind' AND e.deleted_at IS NULL \
              ORDER BY c.key ASC LIMIT 100",
        params: &[],
        reads: &["concept"],
        across: &["entity"],
        bound: 100,
        cursor: &[],
    },
    WorkoutKindRow::of,
);

pub const WORKOUT_COUNT_BY_TYPE: Read<i64> = read(
    ReadDecl {
        name: "health.workout_count_by_type",
        shape: Shape::Aggregate,
        sql: "SELECT count(*) AS count FROM workout w JOIN entity e ON e.id = w.id \
              WHERE w.type_id = :type_id AND e.deleted_at IS NULL",
        params: &[param("type_id", ParamTy::Id)],
        reads: &["workout"],
        across: &["entity"],
        bound: 1,
        cursor: &[],
    },
    |row| row.get("count"),
);

pub const TRASH: Read<Trashed> = trash!("health.trash", "'workout', 'reading'");

pub const READS: &[ReadDecl] = &[
    DAY_TOTALS.decl,
    METRIC_TREND.decl,
    WORKOUTS.decl,
    WORKOUT_BY_ID.decl,
    READINGS_BY_METRIC.decl,
    READING_BY_ID.decl,
    WORKOUT_KINDS.decl,
    WORKOUT_COUNT_BY_TYPE.decl,
    TRASH.decl,
];

pub const KINDS: &[KindDecl] = &[
    KindDecl::new(
        "workout",
        "health",
        "workout",
        "workouts",
        Trash::Listed("health.trash"),
    )
    .takes_captures()
    .holds(&["photo", "document"], &["entity.held_counts"])
    .footers(&[
        Footer::Attachments,
        Footer::Linked,
        Footer::MentionedIn,
        Footer::Origin,
        Footer::Says,
    ])
    .exports(Export::File {
        header: "centraid.health.v1",
        format: exported,
    })
    .shares(Share::Payload(plain)),
    KindDecl::new(
        "reading",
        "health",
        "reading",
        "readings",
        Trash::Listed("health.trash"),
    )
    .footers(&[Footer::Origin, Footer::Says])
    .exports(Export::Within("workout")),
    KindDecl::new(
        "workout_kind",
        "health",
        "workout type",
        "workout types",
        Trash::Purged("a type is purged outright; no workout can sit on one that is gone"),
    )
    .sits_in(&["workout_kind"]),
];
