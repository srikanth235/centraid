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
    let held = centraid_domain::glance::today(
        connection,
        &centraid_domain::glance::Day {
            day: &day,
            from: &from_text,
            to: &to_text,
            floating_from: &floating_from,
            floating_to: &floating_to,
        },
    )
    .map_err(|error| CoreError::Invariant {
        context: format!("the widget's read failed: {error}"),
    })?;
    let (event_count, task_count) = (held.events.len() as u64, held.tasks.len() as u64);
    let mut lines: Vec<(&'static str, centraid_domain::glance::Item)> = held
        .events
        .into_iter()
        .map(|item| ("event", item))
        .chain(held.tasks.into_iter().map(|item| ("task", item)))
        .collect();
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
            .map(|(kind, item)| json!({
                "text": item.title,
                "url": open_url::link(kind, &item.id),
                "kind": kind,
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
