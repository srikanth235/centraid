//! The three `health.*` commands — the write surface of the health pack (#1129).
//!
//! Health follows the phone's health store one way (R-1127-1): HealthKit on iOS, Health Connect
//! on Android. The shell's sync engine is the only caller and decides what changed; this module
//! stores what it is told and refuses what the schema or the rulings forbid. Nothing here is
//! ever written back to the store (R-1129-7).
//!
//! ## What each command is for
//!
//! - `health.record_days` — a pass read the store's daily totals for a window and sends the
//!   `(day, metric, value)` triples it found. A batch, one transaction: a value the vault already
//!   holds is not touched (no UPDATE, so `updated_at` and `row_version` stand still), a changed
//!   one is updated, a new one inserted. Reading the same week twice writes nothing (R-1088-12).
//!   A day is never deleted (R-1129-3): a sum the store now reports nothing for is sent as 0.
//! - `health.follow_workout` — a workout arrived or a followed one was seen again. Writes the
//!   `core_activity` (the entity, actor the vault's own party) and its `health_workout` row, or
//!   updates both. The activity id is the engine's, minted before the first attempt, so a
//!   re-offer lands the same row. It does not write `phone_link`: the engine links through
//!   `phone.link` as for every source (R-1129-2).
//! - `health.purge_workout` — the workout left the store, or the member deleted it here. An
//!   activity has no trash, so this is a purge: through `core_entity`, which cascades the
//!   activity and its workout row and leaves the link a tombstone (R-1127-3).
//!
//! ## What a refusal looks like
//!
//! A value, never a panic: a schema failure or a precondition's sentence and its stable predicate
//! name come back as a `Failed` outcome, and nothing is written — a batch is refused whole. The
//! predicates a shell switches on are `schema` (an unknown metric, a negative value, a malformed
//! day), `days_subject_is_a_party`, `days_are_calendar_days`, `days_name_each_metric_once`,
//! `workout_has_an_owner`, `workout_is_a_workout`, `workout_ends_after_it_starts` and
//! `workout_exists`.
//!
//! ## The kind of a workout
//!
//! `kind` is the vault's kind key: one of the eight the rung seeds (`run` is `health:kind:run`),
//! or, for a kind the seed does not name, the store's word, minted into the
//! `health:workout-kinds` scheme on first use and reused after. `phone_kind` keeps the store's
//! own word whole either way, so a later re-mapping is a read-side change.

use std::collections::BTreeSet;

use rusqlite::OptionalExtension;

use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency, Risk};
use crate::error::{Result, VaultError};

/// The workout-kinds scheme rung three seeds under this fixed id.
pub const WORKOUT_KINDS_SCHEME_ID: &str = "health:workout-kinds";

/// The most `(day, metric)` values one `health.record_days` may carry; the schema's `maxItems`.
/// A year of the six metrics is 2,190, and the first connect backfills one year (owner answer 3).
pub const RECORD_DAYS_MAX: usize = 4_000;

/// The three, in the order a pass uses them.
#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    vec![record_days(), follow_workout(), purge_workout()]
}

fn definition(
    name: &'static str,
    input_schema: &'static str,
    idempotency: Idempotency,
    risk: Risk,
    preconditions: &'static [CommandCondition],
    postconditions: &'static [CommandCondition],
    handler: crate::commands::CommandHandler,
) -> CommandDefinition {
    CommandDefinition {
        name,
        owner_schema: "health",
        input_schema,
        idempotency,
        risk,
        confirm: false,
        preconditions,
        postconditions,
        handler,
        sealed_input: &[],
    }
}

fn invalid(name: &str, detail: impl Into<String>) -> VaultError {
    VaultError::InvalidInput {
        name: name.to_owned(),
        detail: detail.into(),
    }
}

fn str_of<'a>(ctx: &'a CommandCtx<'_, '_>, key: &str) -> Option<&'a str> {
    ctx.input.get(key).and_then(serde_json::Value::as_str)
}

fn self_party(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    Ok(ctx
        .connection()
        .query_row(
            "SELECT self_party_id FROM core_vault WHERE self_party_id IS NOT NULL LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()?)
}

/// The subject a batch is about: the one it names, or the vault's own party.
fn subject_of(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    match str_of(ctx, "subject_party_id") {
        Some(subject) => Ok(Some(subject.to_owned())),
        None => self_party(ctx),
    }
}

/// The batch's `days`, as `(day, metric, value)`. The schema has already held each item's shape.
fn days_of(ctx: &CommandCtx<'_, '_>) -> Result<Vec<(String, String, f64)>> {
    let items = ctx
        .input
        .get("days")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| invalid("days", "a list of days is required"))?;
    if items.len() > RECORD_DAYS_MAX {
        return Err(invalid("days", "too many days for one batch"));
    }
    items
        .iter()
        .map(|item| {
            let text = |key: &str| {
                item.get(key)
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
                    .ok_or_else(|| invalid(key, "a string is required"))
            };
            let value = item
                .get("value")
                .and_then(serde_json::Value::as_f64)
                .ok_or_else(|| invalid("value", "a number is required"))?;
            Ok((text("day")?, text("metric")?, value))
        })
        .collect()
}

// ---------------------------------------------------------------------------
// health.record_days
// ---------------------------------------------------------------------------

fn record_days() -> CommandDefinition {
    static PRE: &[CommandCondition] = &[
        CommandCondition {
            predicate: "days_subject_is_a_party",
            check: |ctx| {
                let found = match subject_of(ctx)? {
                    Some(subject) => ctx.connection().query_row(
                        "SELECT COUNT(*) FROM core_party WHERE party_id = ?1",
                        [subject],
                        |row| row.get::<_, i64>(0),
                    )?,
                    None => 0,
                };
                Ok((found != 1)
                    .then(|| "Those totals are about someone this vault does not hold.".to_owned()))
            },
        },
        CommandCondition {
            predicate: "days_are_calendar_days",
            check: |ctx| {
                let Ok(days) = days_of(ctx) else {
                    return Ok(None);
                };
                for (day, _, _) in &days {
                    // The schema's own CHECK, asked of the engine that will enforce it.
                    let real: bool =
                        ctx.connection()
                            .query_row("SELECT date(?1) IS ?1", [day], |row| row.get(0))?;
                    if !real {
                        return Ok(Some(format!("{day} is not a day of the calendar.")));
                    }
                }
                Ok(None)
            },
        },
        CommandCondition {
            predicate: "days_name_each_metric_once",
            check: |ctx| {
                let Ok(days) = days_of(ctx) else {
                    return Ok(None);
                };
                let mut seen = BTreeSet::new();
                for (day, metric, _) in &days {
                    if !seen.insert((day.as_str(), metric.as_str())) {
                        return Ok(Some(format!(
                            "The batch states {metric} for {day} more than once."
                        )));
                    }
                }
                Ok(None)
            },
        },
    ];
    definition(
        "health.record_days",
        r#"{
          "type": "object",
          "required": ["days"],
          "additionalProperties": false,
          "properties": {
            "subject_party_id": { "type": "string", "minLength": 1 },
            "days": {
              "type": "array",
              "maxItems": 4000,
              "items": {
                "type": "object",
                "required": ["day", "metric", "value"],
                "additionalProperties": false,
                "properties": {
                  "day": { "type": "string", "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" },
                  "metric": {
                    "enum": ["steps", "active_energy_kcal", "exercise_min", "sleep_min",
                             "resting_hr_bpm", "weight_kg"]
                  },
                  "value": { "type": "number", "minimum": 0 }
                }
              }
            }
          }
        }"#,
        // Idempotent by content (R-1088-12): the same batch a second time finds every value
        // already held and writes nothing.
        Idempotency::Idempotent,
        Risk::Low,
        PRE,
        &[],
        |ctx| {
            let subject = subject_of(ctx)?.ok_or_else(|| VaultError::Invariant {
                context: "this vault has no owner yet".to_owned(),
            })?;
            let days = days_of(ctx)?;
            let connection = ctx.connection();
            let mut held = connection.prepare(
                "SELECT value FROM health_daily
                  WHERE subject_party_id = ?1 AND day = ?2 AND metric = ?3",
            )?;
            let mut insert = connection.prepare(
                "INSERT INTO health_daily
                   (subject_party_id, day, metric, value, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            )?;
            let mut update = connection.prepare(
                "UPDATE health_daily SET value = ?4, updated_at = ?5
                  WHERE subject_party_id = ?1 AND day = ?2 AND metric = ?3",
            )?;
            let (mut written, mut unchanged) = (0_u64, 0_u64);
            for (day, metric, value) in &days {
                let was: Option<f64> = held
                    .query_row(rusqlite::params![subject, day, metric], |row| row.get(0))
                    .optional()?;
                match was {
                    // Exact, bit for bit: a total is the store's own number, sent back as it was
                    // read, so "unchanged" means the very same value and nothing rounder.
                    Some(was) if was.to_bits() == value.to_bits() => unchanged += 1,
                    Some(_) => {
                        update.execute(rusqlite::params![subject, day, metric, value, ctx.now])?;
                        written += 1;
                    }
                    None => {
                        insert.execute(rusqlite::params![subject, day, metric, value, ctx.now])?;
                        written += 1;
                    }
                }
            }
            Ok(serde_json::json!({ "written": written, "unchanged": unchanged }))
        },
    )
}

// ---------------------------------------------------------------------------
// health.follow_workout
// ---------------------------------------------------------------------------

/// An instant as the vault spells one (`2026-10-20T07:00:00.000Z`), from any ISO 8601 form the
/// schema admits: SQLite's own reading, so the text compares in time order.
fn instant(ctx: &CommandCtx<'_, '_>, key: &str) -> Result<Option<String>> {
    let Some(text) = str_of(ctx, key) else {
        return Ok(None);
    };
    Ok(ctx
        .connection()
        .query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', ?1)", [text], |row| {
            row.get(0)
        })?)
}

/// What `entity_id` names now: `None` for nothing, else its kind and whether it has a workout.
fn workout_state(ctx: &CommandCtx<'_, '_>, activity_id: &str) -> Result<Option<(String, bool)>> {
    Ok(ctx
        .connection()
        .query_row(
            "SELECT e.entity_type,
                    EXISTS (SELECT 1 FROM health_workout w WHERE w.activity_id = e.entity_id)
               FROM core_entity e WHERE e.entity_id = ?1",
            [activity_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?)
}

/// The concept a kind key names in the workout-kinds scheme, minted on first use.
fn kind_concept(ctx: &CommandCtx<'_, '_>, kind: &str) -> Result<String> {
    let kind = kind.trim();
    crate::commands::core::find_or_create_concept(ctx, WORKOUT_KINDS_SCHEME_ID, kind, kind)
}

fn integer_of(ctx: &CommandCtx<'_, '_>, key: &str) -> Option<i64> {
    ctx.input.get(key).and_then(serde_json::Value::as_i64)
}

fn real_of(ctx: &CommandCtx<'_, '_>, key: &str) -> Option<f64> {
    ctx.input.get(key).and_then(serde_json::Value::as_f64)
}

fn follow_workout() -> CommandDefinition {
    static PRE: &[CommandCondition] = &[
        CommandCondition {
            predicate: "workout_has_an_owner",
            check: |ctx| {
                Ok(self_party(ctx)?.is_none().then(|| {
                    "This vault has no owner yet, so a workout has no one to be about.".to_owned()
                }))
            },
        },
        CommandCondition {
            predicate: "workout_is_a_workout",
            check: |ctx| {
                let Some(activity_id) = str_of(ctx, "activity_id") else {
                    return Ok(None);
                };
                Ok(match workout_state(ctx, activity_id)? {
                    None => None,
                    Some((kind, has_workout)) if kind == "core.activity" && has_workout => None,
                    Some(_) => {
                        Some("That id names a row in the vault that is not a workout.".to_owned())
                    }
                })
            },
        },
        CommandCondition {
            predicate: "workout_ends_after_it_starts",
            check: |ctx| {
                let (Some(started), Some(ended)) =
                    (instant(ctx, "started_at")?, instant(ctx, "ended_at")?)
                else {
                    return Ok(Some("A workout's start and end are instants.".to_owned()));
                };
                Ok((ended < started).then(|| "A workout cannot end before it starts.".to_owned()))
            },
        },
    ];
    definition(
        "health.follow_workout",
        r#"{
          "type": "object",
          "required": ["activity_id", "kind", "phone_kind", "started_at", "ended_at"],
          "additionalProperties": false,
          "properties": {
            "activity_id": { "type": "string", "minLength": 1, "maxLength": 128, "pattern": "\\S" },
            "kind": { "type": "string", "minLength": 1, "maxLength": 64, "pattern": "\\S" },
            "phone_kind": { "type": "string", "minLength": 1, "maxLength": 200, "pattern": "\\S" },
            "started_at": {
              "type": "string",
              "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,9})?Z$"
            },
            "ended_at": {
              "type": "string",
              "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,9})?Z$"
            },
            "recorded_by": { "type": ["string", "null"], "maxLength": 200 },
            "moving_sec": { "type": ["integer", "null"], "minimum": 1 },
            "distance_m": { "type": ["number", "null"], "minimum": 0 },
            "energy_kcal": { "type": ["number", "null"], "minimum": 0 },
            "avg_hr_bpm": { "type": ["integer", "null"], "minimum": 1 },
            "elevation_gain_m": { "type": ["number", "null"], "minimum": 0 }
          }
        }"#,
        // Idempotent by content and by the engine's own id (R-1088-12): the same workout a
        // second time finds both rows as they are and writes nothing.
        Idempotency::Idempotent,
        Risk::Low,
        PRE,
        &[],
        |ctx| {
            let activity_id = ctx.required_str("activity_id")?.to_owned();
            let phone_kind = ctx.required_str("phone_kind")?.trim().to_owned();
            let started_at = instant(ctx, "started_at")?
                .ok_or_else(|| invalid("started_at", "an instant is required"))?;
            let ended_at = instant(ctx, "ended_at")?
                .ok_or_else(|| invalid("ended_at", "an instant is required"))?;
            let recorded_by = str_of(ctx, "recorded_by")
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(str::to_owned);
            let moving_sec = integer_of(ctx, "moving_sec");
            let distance_m = real_of(ctx, "distance_m");
            let energy_kcal = real_of(ctx, "energy_kcal");
            let avg_hr_bpm = integer_of(ctx, "avg_hr_bpm");
            let elevation_gain_m = real_of(ctx, "elevation_gain_m");
            let kind_concept_id = kind_concept(ctx, ctx.required_str("kind")?)?;

            if workout_state(ctx, &activity_id)?.is_some() {
                let activity_changed = ctx.connection().execute(
                    "UPDATE core_activity
                        SET kind_concept_id = ?2, started_at = ?3, ended_at = ?4, updated_at = ?5
                      WHERE activity_id = ?1
                        AND (kind_concept_id IS NOT ?2 OR started_at IS NOT ?3
                             OR ended_at IS NOT ?4)",
                    rusqlite::params![activity_id, kind_concept_id, started_at, ended_at, ctx.now],
                )? > 0;
                let workout_changed = ctx.connection().execute(
                    "UPDATE health_workout
                        SET phone_kind = ?2, recorded_by = ?3, moving_sec = ?4, distance_m = ?5,
                            energy_kcal = ?6, avg_hr_bpm = ?7, elevation_gain_m = ?8,
                            updated_at = ?9
                      WHERE activity_id = ?1
                        AND (phone_kind IS NOT ?2 OR recorded_by IS NOT ?3
                             OR moving_sec IS NOT ?4 OR distance_m IS NOT ?5
                             OR energy_kcal IS NOT ?6 OR avg_hr_bpm IS NOT ?7
                             OR elevation_gain_m IS NOT ?8)",
                    rusqlite::params![
                        activity_id,
                        phone_kind,
                        recorded_by,
                        moving_sec,
                        distance_m,
                        energy_kcal,
                        avg_hr_bpm,
                        elevation_gain_m,
                        ctx.now
                    ],
                )? > 0;
                return Ok(serde_json::json!({
                    "activity_id": activity_id,
                    "created": false,
                    "changed": activity_changed || workout_changed,
                }));
            }

            let actor = self_party(ctx)?.ok_or_else(|| VaultError::Invariant {
                context: "this vault has no owner yet".to_owned(),
            })?;
            // `source_app_id` is NULL, as for every writer today: `access_app` holds no rows.
            ctx.connection().execute(
                "INSERT INTO core_activity
                   (activity_id, actor_party_id, kind_concept_id, started_at, ended_at,
                    location_place_id, source_app_id, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL, ?6, ?6)",
                rusqlite::params![
                    activity_id,
                    actor,
                    kind_concept_id,
                    started_at,
                    ended_at,
                    ctx.now
                ],
            )?;
            ctx.connection().execute(
                "INSERT INTO health_workout
                   (activity_id, phone_kind, recorded_by, moving_sec, distance_m, energy_kcal,
                    avg_hr_bpm, elevation_gain_m, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
                rusqlite::params![
                    activity_id,
                    phone_kind,
                    recorded_by,
                    moving_sec,
                    distance_m,
                    energy_kcal,
                    avg_hr_bpm,
                    elevation_gain_m,
                    ctx.now
                ],
            )?;
            Ok(serde_json::json!({
                "activity_id": activity_id, "created": true, "changed": true,
            }))
        },
    )
}

// ---------------------------------------------------------------------------
// health.purge_workout
// ---------------------------------------------------------------------------

fn purge_workout() -> CommandDefinition {
    static PRE: &[CommandCondition] = &[CommandCondition {
        predicate: "workout_exists",
        check: |ctx| {
            let activity_id = ctx.required_str("activity_id")?;
            let found: i64 = ctx.connection().query_row(
                "SELECT COUNT(*) FROM health_workout WHERE activity_id = ?1",
                [activity_id],
                |row| row.get(0),
            )?;
            Ok((found != 1).then(|| "That is not a workout in the vault.".to_owned()))
        },
    }];
    static POST: &[CommandCondition] = &[CommandCondition {
        predicate: "workout_destroyed",
        check: |ctx| {
            let activity_id = ctx.required_str("activity_id")?;
            let found: i64 = ctx.connection().query_row(
                "SELECT (SELECT COUNT(*) FROM core_activity WHERE activity_id = ?1)
                      + (SELECT COUNT(*) FROM health_workout WHERE activity_id = ?1)
                      + (SELECT COUNT(*) FROM core_entity WHERE entity_id = ?1)",
                [activity_id],
                |row| row.get(0),
            )?;
            Ok((found != 0).then(|| "the workout is still in the vault".to_owned()))
        },
    }];
    definition(
        "health.purge_workout",
        r#"{
          "type": "object",
          "required": ["activity_id"],
          "additionalProperties": false,
          "properties": { "activity_id": { "type": "string", "minLength": 1 } }
        }"#,
        Idempotency::Once,
        Risk::High,
        PRE,
        POST,
        |ctx| {
            let activity_id = ctx.required_str("activity_id")?.to_owned();
            // Through the supertype: the activity goes by its cascade, the workout row by its own,
            // every composite `(type, id)` pointer at the activity with them, and the phone link
            // is left with a NULL entity — the tombstone that keeps it from arriving again.
            ctx.connection().execute(
                "DELETE FROM core_entity WHERE entity_id = ?1",
                [&activity_id],
            )?;
            Ok(serde_json::json!({ "activity_id": activity_id }))
        },
    )
}
