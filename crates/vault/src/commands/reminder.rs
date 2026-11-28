//! Reminders (D2, G3, I8): THE ONE NOTIFICATION RULE, said in a sentence.
//!
//! Every alert comes from a `reminder` row with its own id. A reminder goes only where there is a
//! time to fire at, and `reminder_target` (with the composite keys of `reminder`) is what the
//! database enforces:
//!
//! - an **event** or a **task** takes a reminder directly (`offset_min` minutes before its time);
//! - a **person** only through one of their own dated rows (`person_date`: a birthday, an
//!   anniversary, another date), named by `date_id`;
//! - a **Locker item** only through one of its `date` fields, named by `field_id` (a notification
//!   names the item's title and the field's label, never a value).
//!
//! The same lead on two dates of one person is two reminders; the same lead on one target twice is
//! one (the database refuses the second). The alert a reminder holds is derived data in the index
//! file ([`crate::alerts`]), written after the commit.
//!
//! The event, task, person and Locker command modules call [`add`] and [`set_leads`] from their own
//! commands; [`list`] is the read.

use rusqlite::{Connection, OptionalExtension};

use crate::alerts::{ReminderRow, TARGET_KINDS};
use crate::commands::entity::lookup_live;
use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency};
use crate::error::{Result, VaultError};
use crate::model::Kind;

/// The longest lead a reminder takes: a year, in minutes.
pub const MAX_OFFSET_MIN: i64 = 525_600;

/// The reminders an entity holds, smallest lead first.
///
/// # Errors
/// SQLite's refusal.
pub fn list(connection: &Connection, entity_id: &str) -> Result<Vec<ReminderRow>> {
    crate::alerts::reminders_of(connection, entity_id)
}

/// The sentence for why a reminder cannot go where it was asked to, or `None` when it can.
///
/// # Errors
/// SQLite's refusal.
pub fn refusal(
    connection: &Connection,
    entity_id: &str,
    date_id: Option<&str>,
    field_id: Option<&str>,
    offset_min: i64,
) -> Result<Option<String>> {
    if !(0..=MAX_OFFSET_MIN).contains(&offset_min) {
        return Ok(Some(
            "a reminder comes 0 minutes to a year before, not after".to_owned(),
        ));
    }
    let found = match lookup_live(connection, entity_id)? {
        Ok(found) => found,
        Err(sentence) => return Ok(Some(sentence)),
    };
    let title = &found.title;
    if !TARGET_KINDS.contains(&found.kind.as_str()) {
        return Ok(Some(format!(
            "“{title}” is a {}, which has no time to remind at: a reminder goes on an event, a task, \
             a person's date or a Locker date",
            found.kind.noun()
        )));
    }
    if date_id.is_some() && field_id.is_some() {
        return Ok(Some(
            "a reminder names one date or one field, not both".to_owned(),
        ));
    }
    match found.kind {
        Kind::Event | Kind::Task if date_id.is_some() || field_id.is_some() => {
            return Ok(Some(format!(
                "“{title}” takes a reminder directly: it has no date to name"
            )));
        }
        Kind::Person => {
            if field_id.is_some() {
                return Ok(Some(format!(
                    "a reminder on “{title}” names one of their dates, not a Locker field"
                )));
            }
            let Some(date) = date_id else {
                return Ok(Some(format!(
                    "a person has no moment of their own: a reminder on “{title}” names one of \
                     their dates (a birthday, an anniversary)"
                )));
            };
            let own: bool = connection.query_row(
                "SELECT EXISTS (SELECT 1 FROM person_date WHERE id = ?1 AND person_id = ?2)",
                [date, entity_id],
                |row| row.get(0),
            )?;
            if !own {
                return Ok(Some(format!("that date is not one of “{title}”'s dates")));
            }
        }
        Kind::LockerItem => {
            if date_id.is_some() {
                return Ok(Some(format!(
                    "a reminder on the Locker item “{title}” names one of its date fields, not a \
                     person's date"
                )));
            }
            let Some(field) = field_id else {
                return Ok(Some(format!(
                    "a reminder on the Locker item “{title}” names one of its date fields (an \
                     expiry, a renewal)"
                )));
            };
            let label: Option<(String, String)> = connection
                .query_row(
                    "SELECT label, kind FROM locker_item_field WHERE id = ?1 AND item_id = ?2",
                    [field, entity_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            match label {
                None => {
                    return Ok(Some(format!("that field is not one of “{title}”'s fields")));
                }
                Some((label, kind)) if kind != "date" => {
                    return Ok(Some(format!(
                        "“{label}” is not a date field of “{title}”: only a date can be reminded"
                    )));
                }
                Some(_) => {}
            }
        }
        _ => {}
    }
    // A task counts its lead back from a due; the database refuses one on a task with none
    // (`reminder_needs_a_due`).
    if found.kind == Kind::Task {
        let dated: bool = connection.query_row(
            "SELECT due IS NOT NULL FROM task WHERE id = ?1",
            [entity_id],
            |row| row.get(0),
        )?;
        if !dated {
            return Ok(Some(format!(
                "“{title}” has no due date: a reminder counts back from one"
            )));
        }
    }
    let held: bool = connection.query_row(
        "SELECT EXISTS (SELECT 1 FROM reminder WHERE entity_id = ?1
            AND ifnull(date_id, '') = ifnull(?2, '') AND ifnull(field_id, '') = ifnull(?3, '')
            AND offset_min = ?4)",
        rusqlite::params![entity_id, date_id, field_id, offset_min],
        |row| row.get(0),
    )?;
    if held {
        return Ok(Some(format!(
            "“{title}” already has a reminder {offset_min} minutes before"
        )));
    }
    Ok(None)
}

/// Add a reminder; returns its id. The one function the event, task, person and Locker commands
/// call.
///
/// # Errors
/// [`VaultError::InvalidInput`] with the sentence of [`refusal`], or SQLite's refusal.
pub fn add(
    ctx: &CommandCtx<'_, '_>,
    entity_id: &str,
    date_id: Option<&str>,
    field_id: Option<&str>,
    offset_min: i64,
) -> Result<String> {
    if let Some(sentence) = refusal(ctx.connection(), entity_id, date_id, field_id, offset_min)? {
        return Err(VaultError::InvalidInput {
            name: "reminder".to_owned(),
            detail: sentence,
        });
    }
    let id = ctx.next_id();
    ctx.connection().execute(
        "INSERT INTO reminder (id, entity_id, entity_kind, date_id, field_id, offset_min)
         SELECT ?1, id, kind, ?3, ?4, ?5 FROM entity WHERE id = ?2",
        rusqlite::params![id, entity_id, date_id, field_id, offset_min],
    )?;
    ctx.touch(entity_id)?;
    Ok(id)
}

/// Make an event's or a task's own reminders exactly `leads` (minutes before, each once); returns
/// whether anything changed. Reminders that name a date or a field are not touched.
///
/// # Errors
/// [`VaultError::InvalidInput`] with a sentence, or SQLite's refusal.
pub fn set_leads(ctx: &CommandCtx<'_, '_>, entity_id: &str, leads: &[i64]) -> Result<bool> {
    let held: Vec<(String, i64)> = list(ctx.connection(), entity_id)?
        .into_iter()
        .filter(|row| row.date_id.is_none() && row.field_id.is_none())
        .map(|row| (row.id, row.offset_min))
        .collect();
    let mut changed = false;
    for (id, offset) in &held {
        if !leads.contains(offset) {
            ctx.connection()
                .execute("DELETE FROM reminder WHERE id = ?1", [id])?;
            changed = true;
        }
    }
    let mut wanted = leads.to_vec();
    wanted.sort_unstable();
    wanted.dedup();
    for lead in wanted {
        if !held.iter().any(|(_, offset)| *offset == lead) {
            add(ctx, entity_id, None, None, lead)?;
            changed = true;
        }
    }
    if changed {
        ctx.touch(entity_id)?;
    }
    Ok(changed)
}

fn pre_add(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    refusal(
        ctx.connection(),
        ctx.required_str("entity_id")?,
        ctx.optional_str("date_id"),
        ctx.optional_str("field_id"),
        ctx.input
            .get("offset_min")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(-1),
    )
}

fn add_command(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let offset = ctx
        .input
        .get("offset_min")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(0);
    let id = add(
        ctx,
        ctx.required_str("entity_id")?,
        ctx.optional_str("date_id"),
        ctx.optional_str("field_id"),
        offset,
    )?;
    Ok(serde_json::json!({ "id": id }))
}

fn pre_remove(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let id = ctx.required_str("id")?;
    let held: bool = ctx.connection().query_row(
        "SELECT EXISTS (SELECT 1 FROM reminder WHERE id = ?1)",
        [id],
        |row| row.get(0),
    )?;
    Ok((!held).then(|| format!("there is no reminder with the id `{id}`")))
}

fn remove_command(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let id = ctx.required_str("id")?;
    let entity: Option<String> = ctx
        .connection()
        .query_row(
            "SELECT entity_id FROM reminder WHERE id = ?1",
            [id],
            |row| row.get(0),
        )
        .optional()?;
    ctx.connection()
        .execute("DELETE FROM reminder WHERE id = ?1", [id])?;
    if let Some(entity) = entity {
        ctx.touch(&entity)?;
    }
    Ok(serde_json::json!({ "removed": id }))
}

#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    vec![
        CommandDefinition::plain(
            "reminder.add",
            "reminder",
            r#"{
              "type": "object",
              "required": ["entity_id", "offset_min"],
              "additionalProperties": false,
              "properties": {
                "entity_id": { "type": "string", "minLength": 1 },
                "date_id": { "type": "string", "minLength": 1 },
                "field_id": { "type": "string", "minLength": 1 },
                "offset_min": { "type": "integer", "minimum": 0, "maximum": 525600 }
              }
            }"#,
            Idempotency::Once,
            &[CommandCondition {
                predicate: "reminder_has_a_time_to_fire_at",
                check: pre_add,
            }],
            add_command,
        ),
        CommandDefinition::plain(
            "reminder.remove",
            "reminder",
            r#"{
              "type": "object",
              "required": ["id"],
              "additionalProperties": false,
              "properties": { "id": { "type": "string", "minLength": 1 } }
            }"#,
            Idempotency::Idempotent,
            &[CommandCondition {
                predicate: "reminder_exists",
                check: pre_remove,
            }],
            remove_command,
        ),
    ]
}
