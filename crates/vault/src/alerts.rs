//! ALERTS: the index of "what fires next" (#1188, A5), kept by the writer.
//!
//! An event with reminders, or an open task with a lead time and a moment, owns one
//! `alert` row per lead time. The row holds `fire_key`, the moment of the item's NEXT firing, so
//! "the next 48" is one read over `alert_by_fire` at any vault size and the notification service
//! never loads the vault to find them.
//!
//! - [`refresh`] runs inside every commit, on the ids the commit touched: an item that is
//!   trashed, cancelled, done or no longer reminding loses its rows; any other gets them
//!   recomputed. A purge cascades.
//! - [`advance`] moves a repeating item's row on once its firing has passed, and drops rows of
//!   one-off items that came due long ago. It is the same computation as [`refresh`], so a row can
//!   never mean two things.
//! - [`next`] is the bounded read.
//!
//! A row is a KEY, not an answer: the service loads the few items it names and works out the
//! exact firings with the calendar's own expansion. So the key may be early (an occurrence the
//! series skips later) but never late; an override that moves one earlier is read from the
//! `occurrence` rows. How `fire_key` reads depends on `timing`: 'fixed' is a UTC instant text,
//! 'floating' a wall clock `YYYY-MM-DDTHH:MM` (09:00 wherever the member is), compared by the
//! reader with the member's own now. The vault knows its own zone at most, so a floating row is
//! worked out against that and the reader leaves [`FLOATING_SLACK_MS`] of room.

use std::collections::BTreeSet;

use rusqlite::{Connection, OptionalExtension, params};

use crate::clock::format_iso_ms;
use crate::error::Result;
use crate::time::recurrence::{
    ExceptionAction, ExceptionScope, ExpandInput, NextOccurrenceInput, RecurrenceAnchor,
    RecurrenceException, Semantics, apply_exceptions, expand, next_occurrence, parse_instant_ms,
};
use crate::time::zone::{FireZone, parse_wall_iso, wall_epoch, wall_from_epoch, wall_iso};
use crate::time::{has_zone_designator, rrule};

const MINUTE_MS: i64 = 60_000;
const DAY_MS: i64 = 86_400_000;
/// How long a one-off item's row outlives its firing, so a reader can still tell a banner that
/// fired a moment ago is the item's. An event's row also stays while the event is running.
pub const KEEP_PAST_MS: i64 = 2 * DAY_MS;
/// How much earlier than its own now a reader asks for floating rows: a phone in another zone than
/// the vault's. The widest offset between two zones is 26 hours; a day and a half covers it.
pub const FLOATING_SLACK_MS: i64 = 36 * 60 * MINUTE_MS;
/// How far ahead a repeating item looks for its next firing.
const HORIZON_MS: i64 = 3 * 366 * DAY_MS;
/// The most occurrences one look expands.
const EXPAND_AT_MOST: usize = 4_000;
/// How many rows one [`advance`] moves on.
pub const ADVANCE_BATCH: usize = 200;

/// The time of a commit, in milliseconds.
#[must_use]
pub fn now_ms(now_text: &str) -> i64 {
    parse_instant_ms(now_text).unwrap_or(0)
}

/// How a row's `fire_key` reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Timing {
    Fixed,
    Floating,
}

impl Timing {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Fixed => "fixed",
            Self::Floating => "floating",
        }
    }

    /// The key of a moment: a UTC instant, or a wall clock without seconds.
    #[must_use]
    pub fn key_of(self, ms: i64) -> String {
        match self {
            Self::Fixed => format_iso_ms(ms),
            Self::Floating => wall_key(ms),
        }
    }
}

/// `YYYY-MM-DDTHH:MM` of a wall epoch.
fn wall_key(ms: i64) -> String {
    let wall = wall_from_epoch(ms);
    format!(
        "{}T{:02}:{:02}",
        wall_iso(wall, false),
        wall.hour,
        wall.minute
    )
}

/// One row of the index.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Alert {
    pub entity_id: String,
    pub offset_min: i64,
    pub timing: Timing,
    pub fire_key: String,
    pub repeats: bool,
}

/// A time as milliseconds in the space its timing reads: an instant, or a wall epoch.
fn ms_in(timing: Timing, text: &str) -> Option<i64> {
    match timing {
        Timing::Fixed => parse_instant_ms(text),
        Timing::Floating => parse_wall_iso(text).map(wall_epoch),
    }
}

/// The text a time is expanded from, in its space.
fn text_in(timing: Timing, ms: i64) -> String {
    match timing {
        Timing::Fixed => format_iso_ms(ms),
        Timing::Floating => wall_iso(wall_from_epoch(ms), true),
    }
}

/// Now, in the space of a timing: an instant, or the wall clock of the vault's zone (UTC's when it
/// has none).
fn reference(connection: &Connection, timing: Timing, now: i64) -> i64 {
    match timing {
        Timing::Fixed => now,
        Timing::Floating => {
            let zone: Option<String> = connection
                .query_row("SELECT zone FROM vault", [], |row| row.get(0))
                .optional()
                .ok()
                .flatten()
                .flatten();
            zone.and_then(|name| FireZone::named(&name).ok())
                .map_or(now, |zone| wall_epoch(zone.zoned_parts(now)))
        }
    }
}

/// Recompute the rows of every touched event and task.
///
/// # Errors
/// SQLite's refusal.
pub fn refresh(connection: &Connection, touched: &BTreeSet<String>, now: i64) -> Result<()> {
    for id in touched {
        replace(connection, id, now)?;
    }
    Ok(())
}

/// Rewrite one item's rows.
fn replace(connection: &Connection, id: &str, now: i64) -> Result<()> {
    let kind: Option<(String, Option<String>)> = connection
        .query_row(
            "SELECT kind, deleted_at FROM entity WHERE id = ?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let rows = match kind {
        // ONE ALERT PER REAL THING (#1188, NA2): a record the phone's own app holds is alerted by
        // that app. Whether the follow is still on makes no difference: a retired origin's items
        // keep their source and stay silent.
        Some((ref kind, _)) if phone_holds(connection, id, kind)? => Vec::new(),
        Some((kind, None)) if kind == "event" => event_alerts(connection, id, now)?,
        Some((kind, None)) if kind == "task" => task_alerts(connection, id, now)?,
        _ => Vec::new(),
    };
    connection
        .prepare_cached("DELETE FROM alert WHERE entity_id = ?1")?
        .execute([id])?;
    let mut insert = connection.prepare_cached(
        "INSERT INTO alert (entity_id, offset_min, timing, fire_key, repeats)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (entity_id, offset_min) DO UPDATE SET
           timing = excluded.timing, fire_key = excluded.fire_key, repeats = excluded.repeats",
    )?;
    for row in rows {
        insert.execute(params![
            row.entity_id,
            row.offset_min,
            row.timing.as_str(),
            row.fire_key,
            i64::from(row.repeats)
        ])?;
    }
    Ok(())
}

/// Whether the phone's own calendar or reminders app alerts for this record (#1188, NA2): it came
/// from one (followed now, stopped, or imported once) AND its alert is still what that source
/// stated. An alert the member set or changed in Centraid is Centraid's own and notifies, because a
/// control that never fires would lie. Decided by comparing with `source.stated` (the follower's
/// three-way rule), never by a stored flag.
fn phone_holds(connection: &Connection, id: &str, kind: &str) -> Result<bool> {
    let mut statement = connection.prepare_cached(
        "SELECT s.stated FROM source s JOIN origin o ON o.id = s.origin_id
          WHERE s.entity_id = ?1 AND o.system IN ('calendar', 'phone_reminders')",
    )?;
    let stated = statement
        .query_map([id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if stated.is_empty() {
        return Ok(false);
    }
    let now_alert: AlertNow = if kind == "event" {
        AlertNow::Event(
            connection
                .query_row("SELECT reminders FROM event WHERE id = ?1", [id], |row| {
                    row.get::<_, Option<String>>(0)
                })
                .optional()?
                .flatten()
                .as_deref()
                .map(offsets_of)
                .unwrap_or_default(),
        )
    } else {
        AlertNow::Task(
            connection
                .query_row(
                    "SELECT remind_before_min FROM task WHERE id = ?1",
                    [id],
                    |row| row.get::<_, Option<i64>>(0),
                )
                .optional()?
                .flatten(),
        )
    };
    Ok(stated.iter().any(|text| {
        let json: serde_json::Value = serde_json::from_str(text).unwrap_or_default();
        match &now_alert {
            AlertNow::Task(lead) => json.get("remind_before_min").and_then(|v| v.as_i64()) == *lead,
            AlertNow::Event(offsets) => {
                let said = match json.get("reminders") {
                    Some(serde_json::Value::String(text)) => offsets_of(text),
                    Some(other) => offsets_of(&other.to_string()),
                    None => Vec::new(),
                };
                said == *offsets
            }
        }
    }))
}

/// The alert of an item, as the comparison reads it.
enum AlertNow {
    Task(Option<i64>),
    Event(Vec<i64>),
}

fn offsets_of(json: &str) -> Vec<i64> {
    let mut found: Vec<i64> = serde_json::from_str::<Vec<serde_json::Value>>(json)
        .unwrap_or_default()
        .iter()
        .filter_map(serde_json::Value::as_i64)
        .filter(|minutes| *minutes >= 0)
        .collect();
    found.sort_unstable();
    found.dedup();
    found
}

type EventFields = (
    String,
    String,
    Option<String>,
    Option<String>,
    String,
    Option<String>,
);

fn event_alerts(connection: &Connection, id: &str, now: i64) -> Result<Vec<Alert>> {
    let fields: Option<EventFields> = connection
        .query_row(
            "SELECT starts, timing, zone, rule, status, reminders FROM event WHERE id = ?1",
            [id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .optional()?;
    let Some((starts, timing, zone, rule, status, reminders)) = fields else {
        return Ok(Vec::new());
    };
    let space = match timing.as_str() {
        "zoned" => Timing::Fixed,
        "floating" => Timing::Floating,
        _ => return Ok(Vec::new()),
    };
    if status == "cancelled" {
        return Ok(Vec::new());
    }
    let offsets = reminders.as_deref().map(offsets_of).unwrap_or_default();
    if offsets.is_empty() {
        return Ok(Vec::new());
    }
    let Some(anchor) = ms_in(space, &starts) else {
        return Ok(Vec::new());
    };
    let reference = reference(connection, space, now);
    let series = match rule.as_deref() {
        Some(rule) => Some(series_starts(
            connection,
            id,
            rule,
            &starts,
            zone.as_deref(),
            space,
            reference,
            &offsets,
        )?),
        None => None,
    };
    let mut out = Vec::new();
    for offset in offsets {
        let lead = offset * MINUTE_MS;
        let start = match &series {
            // A series' next start at or after the moment this lead time would fire.
            Some(starts) => starts
                .iter()
                .copied()
                .find(|start| start - lead >= reference),
            None => Some(anchor),
        };
        let Some(start) = start else { continue };
        out.push(Alert {
            entity_id: id.to_owned(),
            offset_min: offset,
            timing: space,
            fire_key: space.key_of(start - lead),
            repeats: series.is_some(),
        });
    }
    Ok(out)
}

/// The occurrence starts of a series from `reference` on, soonest first, exceptions applied.
#[allow(clippy::too_many_arguments)]
fn series_starts(
    connection: &Connection,
    id: &str,
    rule: &str,
    starts: &str,
    zone: Option<&str>,
    space: Timing,
    reference: i64,
    offsets: &[i64],
) -> Result<Vec<i64>> {
    let zone = zone.and_then(|name| FireZone::named(name).ok());
    let from = reference;
    let to = from + HORIZON_MS;
    let (from_text, to_text) = (text_in(space, from), text_in(space, to));
    let mut input = ExpandInput::new(rule, starts, &from_text, &to_text)
        .with_semantics(match space {
            Timing::Fixed => Semantics::Zoned,
            Timing::Floating => Semantics::Floating,
        })
        .at_most(EXPAND_AT_MOST);
    input.zone = zone.as_ref();
    let mut instances = expand(&input);
    if instances.is_empty() && rrule::parse(rule).is_none() {
        // An unsupported rule keeps its anchor (the calendar does the same).
        instances.push(crate::time::recurrence::Occurrence {
            original_start: starts.to_owned(),
            start: starts.to_owned(),
            wall_start: starts.to_owned(),
            overlap: false,
        });
    }
    let (matcher, moved) = exceptions_of(connection, id, space)?;
    let mut out: Vec<i64> = apply_exceptions(&instances, &matcher)
        .iter()
        .filter_map(|occurrence| ms_in(space, &occurrence.start))
        .chain(moved)
        .collect();
    // The widest lead time still fires after `reference`, so keep what is not behind the least.
    let least = offsets.iter().copied().min().unwrap_or(0) * MINUTE_MS;
    out.retain(|start| start - least >= reference);
    out.sort_unstable();
    out.dedup();
    Ok(out)
}

/// The series' stored exceptions as the matcher reads them, and the starts days were moved to.
fn exceptions_of(
    connection: &Connection,
    id: &str,
    space: Timing,
) -> Result<(Vec<RecurrenceException>, Vec<i64>)> {
    let mut statement = connection.prepare_cached(
        "SELECT original_start, scope, cancelled, starts FROM occurrence WHERE series_id = ?1",
    )?;
    let rows = statement
        .query_map([id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut matcher = Vec::new();
    let mut moved = Vec::new();
    for (original, scope, cancelled, starts) in rows {
        let scope = if scope == "future" {
            ExceptionScope::Future
        } else {
            ExceptionScope::Occurrence
        };
        matcher.push(RecurrenceException {
            original_start: original,
            action: if cancelled == 1 {
                ExceptionAction::Skip
            } else {
                ExceptionAction::Override
            },
            scope,
            start: starts.clone(),
        });
        // A day moved from before the look to after it is in no expansion of the look.
        if cancelled == 0 && scope == ExceptionScope::Occurrence {
            moved.extend(starts.as_deref().and_then(|text| ms_in(space, text)));
        }
    }
    Ok((matcher, moved))
}

type TaskFields = (
    Option<String>,
    Option<String>,
    String,
    Option<String>,
    Option<i64>,
);

fn task_alerts(connection: &Connection, id: &str, now: i64) -> Result<Vec<Alert>> {
    let fields: Option<TaskFields> = connection
        .query_row(
            "SELECT due, rule, anchor, zone, remind_before_min FROM task
              WHERE id = ?1 AND status = 'open'",
            [id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .optional()?;
    // A DATE HAS NO MOMENT: a date-only due holds no row until the day's own convention does.
    let Some((Some(due), rule, anchor, zone, Some(lead))) = fields else {
        return Ok(Vec::new());
    };
    if due.len() == 10 {
        return Ok(Vec::new());
    }
    let space = if has_zone_designator(&due) {
        Timing::Fixed
    } else {
        Timing::Floating
    };
    let Some(due_ms) = ms_in(space, &due) else {
        return Ok(Vec::new());
    };
    let lead_ms = lead * MINUTE_MS;
    let reference = reference(connection, space, now);
    let mut at = due_ms;
    let mut repeats = false;
    if let (Some(rule), "scheduled") = (rule.as_deref(), anchor.as_str()) {
        repeats = true;
        if due_ms - lead_ms < reference {
            let zone = zone.as_deref().and_then(|name| FireZone::named(name).ok());
            let after = text_in(space, reference + lead_ms);
            let found = next_occurrence(&NextOccurrenceInput {
                rrule: rule,
                scheduled_start: &due,
                after: &after,
                zone: zone.as_ref(),
                anchor: RecurrenceAnchor::Scheduled,
            })
            .and_then(|start| ms_in(space, &start));
            match found {
                Some(start) => at = start,
                None => return Ok(Vec::new()),
            }
        }
    }
    Ok(vec![Alert {
        entity_id: id.to_owned(),
        offset_min: lead,
        timing: space,
        fire_key: space.key_of(at - lead_ms),
        repeats,
    }])
}

/// Whether [`advance`] has anything to do.
///
/// # Errors
/// SQLite's refusal.
pub fn has_stale(connection: &Connection, now: i64) -> Result<bool> {
    for timing in [Timing::Fixed, Timing::Floating] {
        let reference = reference(connection, timing, now);
        let stale: bool = connection
            .prepare_cached(
                "SELECT EXISTS (SELECT 1 FROM alert WHERE timing = ?1
                   AND (fire_key < ?2 AND repeats = 1
                        OR fire_key < ?3 AND NOT EXISTS (SELECT 1 FROM event e
                             WHERE e.id = alert.entity_id AND e.ends IS NOT NULL
                               AND julianday(e.ends) > julianday(?4))))",
            )?
            .query_row(
                params![
                    timing.as_str(),
                    timing.key_of(reference),
                    timing.key_of(reference - KEEP_PAST_MS),
                    timing.key_of(reference)
                ],
                |row| row.get(0),
            )?;
        if stale {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Move on the repeating rows whose firing has passed, and drop the one-off rows that came due
/// before [`KEEP_PAST_MS`] ago (an event's stays until the event has ended, so a long event keeps
/// its banner). Returns how many items were recomputed; fewer than
/// [`ADVANCE_BATCH`] means none are left.
///
/// # Errors
/// SQLite's refusal.
pub fn advance(connection: &Connection, now: i64) -> Result<usize> {
    let mut stale = BTreeSet::new();
    for timing in [Timing::Fixed, Timing::Floating] {
        let reference = reference(connection, timing, now);
        let key = timing.key_of(reference);
        let mut statement = connection.prepare_cached(
            "SELECT DISTINCT entity_id FROM alert
              WHERE timing = ?1 AND fire_key < ?2 AND repeats = 1
              ORDER BY fire_key LIMIT ?3",
        )?;
        let ids = statement
            .query_map(params![timing.as_str(), key, ADVANCE_BATCH as i64], |row| {
                row.get::<_, String>(0)
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        stale.extend(ids);
        let old = timing.key_of(reference - KEEP_PAST_MS);
        connection
            .prepare_cached(
                "DELETE FROM alert WHERE timing = ?1 AND repeats = 0 AND fire_key < ?2
                   AND NOT EXISTS (SELECT 1 FROM event e WHERE e.id = alert.entity_id
                                     AND e.ends IS NOT NULL AND julianday(e.ends) > julianday(?3))",
            )?
            .execute(params![timing.as_str(), old, key])?;
    }
    refresh(connection, &stale, now)?;
    Ok(stale.len())
}

/// The one-off rows that came due in the last [`KEEP_PAST_MS`], newest first, at most `limit`: the
/// items whose reminder may be on the member's screen right now. `*_from` and `*_to` are keys in
/// each timing's own space.
///
/// # Errors
/// SQLite's refusal.
pub fn recent(
    connection: &Connection,
    fixed: (&str, &str),
    floating: (&str, &str),
    limit: usize,
) -> Result<Vec<Alert>> {
    let mut out = Vec::new();
    for (timing, (from, to)) in [(Timing::Fixed, fixed), (Timing::Floating, floating)] {
        let mut statement = connection.prepare_cached(
            "SELECT entity_id, offset_min, fire_key, repeats FROM alert
              WHERE timing = ?1 AND fire_key >= ?2 AND fire_key < ?3
              ORDER BY fire_key DESC, entity_id LIMIT ?4",
        )?;
        let rows = statement.query_map(
            params![
                timing.as_str(),
                from,
                to,
                i64::try_from(limit).unwrap_or(i64::MAX)
            ],
            |row| {
                Ok(Alert {
                    entity_id: row.get(0)?,
                    offset_min: row.get(1)?,
                    timing,
                    fire_key: row.get(2)?,
                    repeats: row.get::<_, i64>(3)? == 1,
                })
            },
        )?;
        for row in rows {
            out.push(row?);
        }
    }
    Ok(out)
}

/// The rows to look at: the next `limit` of each timing at or after the given keys, soonest first
/// within a timing. `fixed_from` is an instant text, `floating_from` a wall clock.
///
/// # Errors
/// SQLite's refusal.
pub fn next(
    connection: &Connection,
    fixed_from: &str,
    floating_from: &str,
    limit: usize,
) -> Result<Vec<Alert>> {
    let mut out = Vec::new();
    for (timing, from) in [
        (Timing::Fixed, fixed_from),
        (Timing::Floating, floating_from),
    ] {
        let mut statement = connection.prepare_cached(
            "SELECT entity_id, offset_min, fire_key, repeats FROM alert
              WHERE timing = ?1 AND fire_key >= ?2
              ORDER BY fire_key, entity_id LIMIT ?3",
        )?;
        let rows = statement.query_map(
            params![
                timing.as_str(),
                from,
                i64::try_from(limit).unwrap_or(i64::MAX)
            ],
            |row| {
                Ok(Alert {
                    entity_id: row.get(0)?,
                    offset_min: row.get(1)?,
                    timing,
                    fire_key: row.get(2)?,
                    repeats: row.get::<_, i64>(3)? == 1,
                })
            },
        )?;
        for row in rows {
            out.push(row?);
        }
    }
    Ok(out)
}
