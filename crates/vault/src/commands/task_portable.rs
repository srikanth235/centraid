//! REMINDERS AS A CALENDAR FILE (#1185): `task.export_ics`, the reminders of every list, of one
//! list, or one reminder (what a reminder page shares) as VTODOs in one RFC 5545 file, the form
//! other task apps read. Writes nothing.
//!
//! A task is a VTODO with its UID, DTSTAMP, title, notes, due (a date, or a wall clock in the
//! task's zone, or a floating one), status (done carries COMPLETED), priority, link, alert
//! (VALARM, minutes before it is due) and RRULE when it repeats. Not written: sub-task links,
//! sections, tags and the effort estimate.

use rusqlite::Connection;
use serde_json::Value as Json;

use crate::commands::ical::{self, Writer};
use crate::commands::{CommandCtx, CommandDefinition, Idempotency, note};
use crate::error::Result;
use crate::time::recurrence::parse_instant_ms;
use crate::time::rrule;
use crate::time::temporal::{self, Kind as Reading};
use crate::time::zone::{FireZone, parse_wall_iso};

struct Task {
    id: String,
    title: String,
    stamp: String,
    status: String,
    priority: i64,
    due: Option<String>,
    done_at: Option<String>,
    rule: Option<String>,
    zone: Option<String>,
    remind_before_min: Option<i64>,
    url: Option<String>,
    description: Option<String>,
}

/// The due date as the property that carries it: `(parameters, value)`.
fn due(task: &Task, value: &str) -> Option<(String, String)> {
    match temporal::classify(value)? {
        Reading::LocalDate => Some((";VALUE=DATE".to_owned(), ical::compact_date(value)?)),
        Reading::FloatingDateTime => match task
            .zone
            .as_deref()
            .and_then(|name| FireZone::named(name).ok())
        {
            Some(zone) => Some((
                format!(";TZID={}", zone.name()),
                ical::compact_wall(parse_wall_iso(value)?),
            )),
            None => Some((String::new(), ical::compact_wall(parse_wall_iso(value)?))),
        },
        _ => {
            let millis = parse_instant_ms(value)?;
            match task
                .zone
                .as_deref()
                .and_then(|name| FireZone::named(name).ok())
            {
                Some(zone) => Some((
                    format!(";TZID={}", zone.name()),
                    ical::compact_wall(zone.zoned_parts(millis)),
                )),
                None => Some((String::new(), ical::compact_utc_ms(millis))),
            }
        }
    }
}

/// The member's 1 (low) to 3 (high) marks as RFC 5545's 9, 5 and 1; none is not written.
const fn priority_of(mark: i64) -> Option<u8> {
    match mark {
        i64::MIN..=0 => None,
        1 => Some(9),
        2 => Some(5),
        _ => Some(1),
    }
}

fn tasks(connection: &Connection, list: Option<&str>, one: Option<&str>) -> Result<Vec<Task>> {
    let mut statement = connection.prepare_cached(
        "SELECT e.id, e.title, e.updated_at, t.status, t.priority, t.due, t.done_at, t.rule,
                t.zone, t.remind_before_min, t.url, t.description
           FROM task t JOIN entity e ON e.id = t.id
          WHERE e.kind = 'task' AND e.deleted_at IS NULL
            AND (?1 IS NULL OR t.project_id = ?1)
            AND (?2 IS NULL OR e.id = ?2)
          ORDER BY t.due IS NULL, t.due, t.position, e.created_at, e.id",
    )?;
    let rows = statement
        .query_map(rusqlite::params![list, one], |row| {
            Ok(Task {
                id: row.get(0)?,
                title: row.get(1)?,
                stamp: row.get(2)?,
                status: row.get(3)?,
                priority: row.get(4)?,
                due: row.get(5)?,
                done_at: row.get(6)?,
                rule: row.get(7)?,
                zone: row.get(8)?,
                remind_before_min: row.get(9)?,
                url: row.get(10)?,
                description: row.get(11)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn file(tasks: &[Task]) -> String {
    let mut writer = Writer::calendar();
    for task in tasks {
        writer.line("BEGIN:VTODO");
        writer.line(&format!("UID:{}@centraid", task.id));
        writer.line(&format!(
            "DTSTAMP:{}",
            ical::compact_utc(&task.stamp).unwrap_or_else(|| "19700101T000000Z".to_owned())
        ));
        writer.text("SUMMARY", &task.title);
        if let Some(notes) = task.description.as_deref().filter(|d| !d.is_empty()) {
            writer.text("DESCRIPTION", notes);
        }
        let due = task.due.as_deref().and_then(|value| due(task, value));
        if let Some((params, value)) = &due {
            writer.line(&format!("DUE{params}:{value}"));
        }
        if due.is_some()
            && let Some(rule) = task.rule.as_deref()
        {
            let line = rrule::rrule_line(rule);
            if !line.is_empty() {
                writer.line(&line);
            }
        }
        writer.line(&format!(
            "STATUS:{}",
            match task.status.as_str() {
                "done" => "COMPLETED",
                "cancelled" => "CANCELLED",
                _ => "NEEDS-ACTION",
            }
        ));
        if let Some(done) = task.done_at.as_deref().and_then(ical::compact_utc) {
            writer.line(&format!("COMPLETED:{done}"));
        }
        if let Some(priority) = priority_of(task.priority) {
            writer.line(&format!("PRIORITY:{priority}"));
        }
        if let Some(url) = task.url.as_deref().filter(|u| !u.trim().is_empty()) {
            writer.line(&format!("URL:{url}"));
        }
        if let (Some(minutes), Some(_)) = (task.remind_before_min, &due) {
            writer.line("BEGIN:VALARM");
            writer.line("ACTION:DISPLAY");
            writer.text("DESCRIPTION", &task.title);
            writer.line(&if minutes == 0 {
                "TRIGGER:PT0S".to_owned()
            } else {
                format!("TRIGGER:-PT{minutes}M")
            });
            writer.line("END:VALARM");
        }
        writer.line("END:VTODO");
    }
    writer.finish()
}

/// `task.export_ics`: every list's reminders, one list's (`list_id`), or one reminder
/// (`task_id`, what a reminder page shares) as a calendar file. Writes nothing. Trashed
/// reminders are not in it.
fn export_ics(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let list = ctx.optional_str("list_id");
    let one = ctx.optional_str("task_id");
    let mut file_name = "Reminders".to_owned();
    if let Some(id) = one.or(list) {
        let title: Option<String> = ctx
            .connection()
            .query_row("SELECT title FROM entity WHERE id = ?1", [id], |row| {
                row.get(0)
            })
            .ok();
        file_name = title.map_or_else(|| "Reminders".to_owned(), |t| note::portable_stem(&t));
    }
    let rows = tasks(ctx.connection(), list, one)?;
    let text = file(&rows);
    Ok(serde_json::json!({
        "name": format!("{file_name}.ics"),
        "media_type": "text/calendar",
        "count": rows.len(),
        "content": base64::Engine::encode(&base64::engine::general_purpose::STANDARD, text),
    }))
}

#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    vec![CommandDefinition::plain(
        "task.export_ics",
        "task",
        r#"{
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "list_id": { "type": ["string", "null"] },
            "task_id": { "type": ["string", "null"] }
          }
        }"#,
        Idempotency::Idempotent,
        &[],
        export_ics,
    )]
}
