//! `alert.snooze` (#1214 S9, V11): move one alert later, for every kind a reminder may be on.
//!
//! A snooze names the alert's target as a reminder does (an event, a task, one of a person's dates,
//! one of a Locker item's date fields) and an instant. It moves that target's alert and nothing
//! else: the item, its due and its other dates are untouched, and a snooze is not an edit of the
//! item, so it leaves no earlier version. The database ends it when the target's moment or its
//! leads change (`*_clears_its_snooze` triggers). Dismissing an alert writes nothing.
//!
//! Done is not a snooze verb: it exists only on a task's alert and is `task.complete`. On an event,
//! a birthday or a Locker expiry it would read as cancelling or deleting the thing.

use rusqlite::Connection;

use crate::alerts::TARGET_KINDS;
use crate::commands::entity::lookup_live;
use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency};
use crate::error::Result;
use crate::model::Kind;
use crate::time::{recurrence::parse_instant_ms, temporal};

fn target_of<'a>(
    ctx: &'a CommandCtx<'_, '_>,
) -> Result<(&'a str, Option<&'a str>, Option<&'a str>)> {
    Ok((
        ctx.required_str("entity_id")?,
        ctx.optional_str("date_id"),
        ctx.optional_str("field_id"),
    ))
}

fn pre_snooze(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let (entity_id, date_id, field_id) = target_of(ctx)?;
    let found = match lookup_live(ctx.connection(), entity_id)? {
        Ok(found) => found,
        Err(sentence) => return Ok(Some(sentence)),
    };
    let title = &found.title;
    if !TARGET_KINDS.contains(&found.kind.as_str()) {
        return Ok(Some(format!(
            "“{title}” is a {}, which has no alert to snooze",
            found.kind.noun()
        )));
    }
    let until = ctx.required_str("until")?;
    if !matches!(temporal::classify(until), Some(temporal::Kind::Instant)) {
        return Ok(Some(temporal::refusal(
            "until",
            until,
            &[temporal::Kind::Instant],
        )));
    }
    if parse_instant_ms(&temporal::canonical(until)) <= parse_instant_ms(ctx.now.as_str()) {
        return Ok(Some("A snooze ends in the future.".to_owned()));
    }
    if found.kind == Kind::Task && !is_open(ctx.connection(), entity_id)? {
        return Ok(Some("Only an open task can be snoozed.".to_owned()));
    }
    let held: bool = ctx.connection().query_row(
        "SELECT EXISTS (SELECT 1 FROM reminder WHERE entity_id = ?1
            AND ifnull(date_id, '') = ifnull(?2, '') AND ifnull(field_id, '') = ifnull(?3, ''))",
        rusqlite::params![entity_id, date_id, field_id],
        |row| row.get(0),
    )?;
    Ok((!held).then(|| format!("“{title}” has no reminder there to snooze")))
}

fn is_open(connection: &Connection, id: &str) -> Result<bool> {
    Ok(connection.query_row(
        "SELECT status = 'open' FROM task WHERE id = ?1",
        [id],
        |row| row.get(0),
    )?)
}

fn snooze(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let (entity_id, date_id, field_id) = target_of(ctx)?;
    let until = temporal::canonical(ctx.required_str("until")?);
    let connection = ctx.connection();
    connection.execute(
        "DELETE FROM snooze WHERE entity_id = ?1
            AND ifnull(date_id, '') = ifnull(?2, '') AND ifnull(field_id, '') = ifnull(?3, '')",
        rusqlite::params![entity_id, date_id, field_id],
    )?;
    connection.execute(
        "INSERT INTO snooze (entity_id, entity_kind, date_id, field_id, until)
         SELECT id, kind, ?2, ?3, ?4 FROM entity WHERE id = ?1",
        rusqlite::params![entity_id, date_id, field_id, until],
    )?;
    ctx.mark_for_index(entity_id);
    Ok(serde_json::json!({ "entity_id": entity_id, "until": until }))
}

#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    vec![CommandDefinition::plain(
        "alert.snooze",
        "alert",
        r#"{
          "type": "object",
          "required": ["entity_id", "until"],
          "additionalProperties": false,
          "properties": {
            "entity_id": { "type": "string", "minLength": 1 },
            "date_id": { "type": "string", "minLength": 1 },
            "field_id": { "type": "string", "minLength": 1 },
            "until": { "type": "string", "minLength": 1, "description": "A UTC instant: the alert sounds again then." }
          }
        }"#,
        Idempotency::Idempotent,
        &[CommandCondition {
            predicate: "the_alert_is_there_to_snooze",
            check: pre_snooze,
        }],
        snooze,
    )]
}
