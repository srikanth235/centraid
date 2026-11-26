//! THE WIDGET SNAPSHOT (app-plane §10, D6): what the Today widget draws, written to the device
//! store as `widget.today` (`{"v":1,…}`) on every commit that can change it. The widget extension
//! reads the file and draws it; it opens nothing, and a tap goes to `centraid://open/<kind>/<id>`.
//! A trash or a purge of an item changes the next snapshot at once.
//!
//! Today is the member's own day in their zone: events that start, or run through it, and tasks
//! due or scheduled on it. A repeating event is not expanded here (the calendar room does that).

use centraid_vault::rusqlite::Connection;
use centraid_vault::time::zone::FireZone;
use serde_json::{Value, json};

use super::open_url;
use crate::error::{CoreError, Result};

pub const KEY: &str = "widget.today";
/// The most items a snapshot names.
pub const MOST: usize = 3;

/// The finished words the snapshot carries.
pub trait Words {
    fn title(&self) -> String;
    /// "Nothing today".
    fn empty(&self) -> String;
    /// "3 events · 2 tasks".
    fn counts(&self, events: u64, tasks: u64) -> String;
}

struct Item {
    id: String,
    kind: &'static str,
    title: String,
}

fn day_parts(zone: &FireZone, now_ms: i64) -> (String, i64, i64) {
    let wall = zone.zoned_parts(now_ms);
    let day = format!("{:04}-{:02}-{:02}", wall.year, wall.month, wall.day);
    let start = centraid_vault::time::zone::WallTime {
        hour: 0,
        minute: 0,
        second: 0,
        millisecond: 0,
        ..wall
    };
    let from = centraid_vault::time::recurrence::parse_instant_ms(
        &zone.resolve_wall_time_forward(start).instant,
    )
    .unwrap_or(now_ms);
    (day, from, from + 86_400_000)
}

fn read(
    connection: &Connection,
    sql: &str,
    params: &[&dyn centraid_vault::rusqlite::ToSql],
    kind: &'static str,
) -> Result<Vec<Item>> {
    let fail = |error: centraid_vault::rusqlite::Error| CoreError::Invariant {
        context: format!("the widget's read failed: {error}"),
    };
    let mut statement = connection.prepare(sql).map_err(fail)?;
    let rows = statement
        .query_map(params, |row| {
            Ok(Item {
                id: row.get(0)?,
                kind,
                title: row.get(1)?,
            })
        })
        .map_err(fail)?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(fail)
}

/// Today's snapshot, as the JSON the widget reads.
///
/// # Errors
/// The vault's refusal to read.
pub fn today(
    connection: &Connection,
    now_ms: i64,
    zone_name: &str,
    words: &dyn Words,
) -> Result<Value> {
    let zone = FireZone::named(zone_name)
        .or_else(|_| FireZone::named("UTC"))
        .map_err(|error| CoreError::Invariant {
            context: format!("no zone for the widget: {error:?}"),
        })?;
    let (day, from, to) = day_parts(&zone, now_ms);
    let from_text = centraid_vault::clock::format_iso_ms(from);
    let to_text = centraid_vault::clock::format_iso_ms(to);
    let floating_from = format!("{day}T00:00");
    let floating_to = format!("{day}T23:59");
    let mut events = read(
        connection,
        "SELECT e.id, n.title FROM event e JOIN entity n ON n.id = e.id
          WHERE n.deleted_at IS NULL AND e.status <> 'cancelled' AND e.rule IS NULL AND (
                (e.timing = 'zoned' AND e.starts >= ?1 AND e.starts < ?2)
             OR (e.timing = 'floating' AND e.starts >= ?3 AND e.starts <= ?4)
             OR (e.timing = 'all-day' AND e.starts <= ?5 AND ifnull(e.ends, e.starts) >= ?5))
          ORDER BY e.starts, e.id",
        &[&from_text, &to_text, &floating_from, &floating_to, &day],
        "event",
    )?;
    let mut tasks = read(
        connection,
        "SELECT t.id, n.title FROM task t JOIN entity n ON n.id = t.id
          WHERE n.deleted_at IS NULL AND t.status = 'open' AND (
                (t.due_timing = 'zoned' AND t.due >= ?1 AND t.due < ?2)
             OR (t.due_timing = 'floating' AND t.due >= ?3 AND t.due <= ?4)
             OR (t.due_timing = 'all-day' AND t.due = ?5)
             OR t.scheduled_on = ?5)
          ORDER BY t.due, t.id",
        &[&from_text, &to_text, &floating_from, &floating_to, &day],
        "task",
    )?;
    let (event_count, task_count) = (events.len() as u64, tasks.len() as u64);
    let mut lines: Vec<Item> = Vec::new();
    lines.append(&mut events);
    lines.append(&mut tasks);
    lines.truncate(MOST);
    let summary = if lines.is_empty() {
        words.empty()
    } else {
        words.counts(event_count, task_count)
    };
    Ok(json!({
        "v": 1,
        "title": words.title(),
        "day": day,
        "summary": summary,
        "lines": lines
            .iter()
            .map(|item| json!({
                "text": item.title,
                "url": open_url::link(item.kind, &item.id),
                "kind": item.kind,
            }))
            .collect::<Vec<_>>(),
    }))
}

/// Write the snapshot when it differs from what is kept. Returns whether it was written.
///
/// # Errors
/// The vault's refusal to read, or the store's to write.
pub fn refresh(
    connection: &Connection,
    store: &super::Checked<super::DirStore>,
    now_ms: i64,
    zone: &str,
    words: &dyn Words,
) -> Result<bool> {
    let snapshot = today(connection, now_ms, zone, words)?.to_string();
    if store.get(KEY).ok().flatten().as_deref() == Some(snapshot.as_str()) {
        return Ok(false);
    }
    store
        .put(KEY, &snapshot)
        .map_err(|detail| CoreError::Unavailable { reason: detail })?;
    Ok(true)
}
