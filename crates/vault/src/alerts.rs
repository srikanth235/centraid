//! ALERTS: the index of "what fires next" (#1188, A5; #1214 D2), kept by the index writer.
//!
//! THE ONE NOTIFICATION RULE: every alert comes from a `reminder` row with its own id. An event or a
//! task takes one directly; a person only through a named `person_date`; a Locker item only through
//! a named `date` field (`reminder_target` and the composite keys say so, the commands say it in a
//! sentence). `alert` (the index file, schema `ix`) holds each reminder's NEXT firing:
//!
//! - an event or a task with a moment: the moment minus the lead (`offset_min`), zoned (a UTC
//!   instant, timing `fixed`) or floating (a wall clock, timing `floating`);
//! - A DATE HAS NO MOMENT: an all-day event or task, a person's date and a Locker date fire at
//!   [`DAY_ALERT_TIME`] local on the day, and the lead is counted BACK from that 09:00. A person's
//!   date repeats every year (a yearless `--MM-DD` has no origin year, a dated one starts at its
//!   year); Feb 29 falls on Feb 28 in a year with no leap day. A Locker date fires once;
//! - a repeating event or task holds its NEXT firing ([`advance`] moves it on); a one-day override
//!   (`occurrence`) and a cancelled day are honoured; a task's `snoozed_until` is its one alert while
//!   it is set (attached to its smallest lead).
//!
//! The rows are DERIVED DATA, written after the commit from the same queue as search
//! (`index::after_commit`, the idle pass, `index::rebuild`), by [`sync`], one entity at a time and
//! keyed by the entity's `n` so that a purge, which leaves no reminder to name, still removes them.
//! A trashed item has no alert; restoring it writes them again.
//!
//! A row is a KEY, not an answer: [`next`] is the bounded read (one seek on `alert_by_fire`),
//! [`notice`] says what the notification shows. `fire_key` reads by `timing`: 'fixed' is a UTC
//! instant text, 'floating' a wall clock `YYYY-MM-DDTHH:MM` compared by the reader with the member's
//! own now; the vault knows its own zone at most, so a floating row is worked out against that and
//! the reader leaves [`FLOATING_SLACK_MS`] of room.

use std::collections::HashSet;

use rusqlite::{Connection, OptionalExtension, params};

use crate::clock::format_iso_ms;
use crate::error::Result;
use crate::time::recurrence::{ExpandInput, Semantics, expand, parse_instant_ms};
use crate::time::rrule;
use crate::time::zone::{
    FireZone, WallTime, parse_wall_iso, wall_epoch, wall_from_epoch, wall_iso,
};

const MINUTE_MS: i64 = 60_000;
const DAY_MS: i64 = 86_400_000;
/// How long a one-off row outlives its firing, so a reader can still tell a banner that fired a
/// moment ago is the item's. A task's stays until the task is resolved (the row goes with it).
pub const KEEP_PAST_MS: i64 = 2 * DAY_MS;
/// How much earlier than its own now a reader asks for floating rows: a phone in another zone than
/// the vault's. The widest offset between two zones is 26 hours; a day and a half covers it.
pub const FLOATING_SLACK_MS: i64 = 36 * 60 * MINUTE_MS;
/// When the alert of a day with no time sounds, on that day, wherever the member is (#1188, NA6).
pub const DAY_ALERT_TIME: &str = "09:00";
const DAY_ALERT_MS: i64 = 9 * 60 * MINUTE_MS;
/// How far ahead a repeating item looks for its next firing.
const HORIZON_MS: i64 = 3 * 366 * DAY_MS;
/// The most occurrences one look expands.
const EXPAND_AT_MOST: usize = 4_000;
/// How many entities one [`advance`] moves on.
pub const ADVANCE_BATCH: usize = 200;

/// The kinds a reminder may be on, and the other half of what `reminder_target` holds.
pub const TARGET_KINDS: [&str; 4] = ["event", "task", "person", "locker_item"];

/// An event's alerts as the member meets them: the LONGEST lead first, so the first alert is the
/// one that fires first (1440 then 60; 30 then 10). Every reader that hands an event's alerts on
/// goes through this one function.
#[must_use]
pub fn longest_first(mut leads: Vec<i64>) -> Vec<i64> {
    leads.sort_unstable_by(|a, b| b.cmp(a));
    leads.dedup();
    leads
}

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
    pub reminder_id: String,
    /// The owning entity's `n`.
    pub n: i64,
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

/// Now, in each space: an instant, and the wall clock of the vault's zone (UTC's when it has none).
#[derive(Clone, Copy)]
struct Refs {
    fixed: i64,
    floating: i64,
}

impl Refs {
    fn read(connection: &Connection, now: i64) -> Self {
        let zone: Option<String> = connection
            .query_row("SELECT zone FROM vault", [], |row| row.get(0))
            .optional()
            .ok()
            .flatten()
            .flatten();
        let floating = zone
            .and_then(|name| FireZone::named(&name).ok())
            .map_or(now, |zone| wall_epoch(zone.zoned_parts(now)));
        Self {
            fixed: now,
            floating,
        }
    }

    const fn of(self, space: Timing) -> i64 {
        match space {
            Timing::Fixed => self.fixed,
            Timing::Floating => self.floating,
        }
    }

    /// A moment in either space as an (approximate) instant, to order moments of both.
    const fn instant(self, space: Timing, ms: i64) -> i64 {
        match space {
            Timing::Fixed => ms,
            Timing::Floating => ms - (self.floating - self.fixed),
        }
    }
}

/// A firing: the moment (in `space`) and whether the item repeats.
#[derive(Clone, Copy, Debug)]
struct Fire {
    space: Timing,
    at: i64,
    repeats: bool,
}

/// A reminder row as the writer reads it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReminderRow {
    pub id: String,
    pub entity_id: String,
    pub date_id: Option<String>,
    pub field_id: Option<String>,
    pub offset_min: i64,
}

/// The reminders of an entity, smallest lead first (then by id): the READ of "what is this item
/// reminding".
///
/// # Errors
/// SQLite's refusal.
pub fn reminders_of(connection: &Connection, entity_id: &str) -> Result<Vec<ReminderRow>> {
    connection
        .prepare_cached(
            "SELECT id, entity_id, date_id, field_id, offset_min FROM reminder
              WHERE entity_id = ?1 ORDER BY offset_min, id",
        )?
        .query_map([entity_id], |row| {
            Ok(ReminderRow {
                id: row.get(0)?,
                entity_id: row.get(1)?,
                date_id: row.get(2)?,
                field_id: row.get(3)?,
                offset_min: row.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()
        .map_err(Into::into)
}

/// Rewrite the alerts of the entity numbered `n`: none when it is gone (a purge), in the trash, or
/// of a kind a reminder cannot be on; otherwise one row per reminder that has a next firing. The
/// same computation serves a commit's pass, the idle pass, [`advance`] and a rebuild, so a row can
/// never mean two things.
///
/// # Errors
/// SQLite's refusal.
pub fn sync(connection: &Connection, n: i64, now: i64) -> Result<()> {
    connection
        .prepare_cached("DELETE FROM alert WHERE n = ?1")?
        .execute([n])?;
    let row: Option<(String, String, Option<String>)> = connection
        .prepare_cached("SELECT id, kind, deleted_at FROM entity WHERE n = ?1")?
        .query_row([n], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .optional()?;
    let Some((id, kind, None)) = row else {
        return Ok(());
    };
    if !TARGET_KINDS.contains(&kind.as_str()) {
        return Ok(());
    }
    let reminders = reminders_of(connection, &id)?;
    if reminders.is_empty() {
        return Ok(());
    }
    // ONE ALERT PER REAL THING (#1188, NA2): the phone's own app alerts for what it holds.
    if phone_holds(connection, &id, &kind, &reminders)? {
        return Ok(());
    }
    let refs = Refs::read(connection, now);
    let fires = match kind.as_str() {
        "event" => event_fires(connection, &id, &reminders, refs)?,
        "task" => task_fires(connection, &id, &reminders, refs)?,
        "person" => date_fires(connection, &reminders, refs, DateOf::Person)?,
        _ => date_fires(connection, &reminders, refs, DateOf::Field)?,
    };
    let mut insert = connection.prepare_cached(
        "INSERT INTO alert (reminder_id, n, timing, fire_key, repeats) VALUES (?1, ?2, ?3, ?4, ?5)",
    )?;
    for (reminder, fire) in fires {
        // A one-off that came due longer ago than the keep window is no banner any more.
        if !fire.repeats && fire.at < refs.of(fire.space) - KEEP_PAST_MS {
            continue;
        }
        insert.execute(params![
            reminder,
            n,
            fire.space.as_str(),
            fire.space.key_of(fire.at),
            i64::from(fire.repeats)
        ])?;
    }
    Ok(())
}

/// Remove every alert of the entity numbered `n`.
///
/// # Errors
/// SQLite's refusal.
pub fn forget(connection: &Connection, n: i64) -> Result<()> {
    connection
        .prepare_cached("DELETE FROM alert WHERE n = ?1")?
        .execute([n])?;
    Ok(())
}

/// Empty the table (a rebuild's first step).
///
/// # Errors
/// SQLite's refusal.
pub fn clear(connection: &Connection) -> Result<()> {
    connection.execute("DELETE FROM alert", [])?;
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Moments
// ---------------------------------------------------------------------------------------------

/// A stored time of `timing` (`zoned`, `floating`, `all-day`) as a (space, ms) moment. A day is
/// read at 09:00 wall clock.
fn moment(timing: &str, text: &str) -> Option<(Timing, i64)> {
    match timing {
        "zoned" => parse_instant_ms(text).map(|ms| (Timing::Fixed, ms)),
        "floating" => parse_wall_iso(text).map(|wall| (Timing::Floating, wall_epoch(wall))),
        "all-day" => parse_wall_iso(text.get(..10)?)
            .map(|wall| (Timing::Floating, wall_epoch(wall) + DAY_ALERT_MS)),
        _ => None,
    }
}

/// The start the rule is expanded from, as text in its semantics.
fn anchor_text(timing: &str, starts: &str) -> String {
    if timing == "all-day" {
        format!("{}T{DAY_ALERT_TIME}", starts.get(..10).unwrap_or(starts))
    } else {
        starts.to_owned()
    }
}

/// The series' occurrence starts from `from` (in the series' space) on, soonest first. A rule the
/// calendar does not read keeps its anchor.
fn expand_series(
    rule: &str,
    starts: &str,
    timing: &str,
    zone: Option<&str>,
    from: i64,
) -> Vec<(i64, i64)> {
    let space = if timing == "zoned" {
        Timing::Fixed
    } else {
        Timing::Floating
    };
    let anchor = anchor_text(timing, starts);
    let Some(anchor_ms) = ms_in(space, &anchor) else {
        return Vec::new();
    };
    if rrule::parse(rule).is_none() {
        return vec![(anchor_ms, anchor_ms)];
    }
    let zone = zone.and_then(|name| FireZone::named(name).ok());
    let (from_text, to_text) = (text_in(space, from), text_in(space, from + HORIZON_MS));
    let mut input = ExpandInput::new(rule, &anchor, &from_text, &to_text)
        .with_semantics(match space {
            Timing::Fixed => Semantics::Zoned,
            Timing::Floating => Semantics::Floating,
        })
        .at_most(EXPAND_AT_MOST);
    input.zone = zone.as_ref();
    expand(&input)
        .iter()
        .filter_map(|occurrence| {
            Some((
                ms_in(space, &occurrence.original_start)?,
                ms_in(space, &occurrence.start)?,
            ))
        })
        .collect()
}

// ---------------------------------------------------------------------------------------------
// One alert per real thing
// ---------------------------------------------------------------------------------------------

/// Whether the phone's own calendar or reminders app alerts for this event or task (#1188, NA2): a
/// source of the record comes from a phone store (`origin_system.on_device`) whose origin is not
/// retired, the source is not gone, AND the record's alert is still what that source stated. A
/// record has several sources (A9): any one that holds it is enough. An alert the member set or
/// changed in Centraid is Centraid's own and notifies, because a control that never fires would
/// lie; a retired origin is followed by nobody, so the vault alerts again. Decided by comparing
/// with `source.stated` (the follower's three-way rule), never by a stored flag.
///
/// What is compared is what the old rule compared: the moment (`starts` or `due`, a day as a day)
/// and the leads (`reminders`, minutes, or a single `remind_before_min`).
fn phone_holds(
    connection: &Connection,
    id: &str,
    kind: &str,
    reminders: &[ReminderRow],
) -> Result<bool> {
    if kind != "event" && kind != "task" {
        return Ok(false);
    }
    let stated = connection
        .prepare_cached(
            "SELECT s.stated FROM source s
               JOIN origin o ON o.id = s.origin_id
               JOIN origin_system y ON y.code = o.system
              WHERE s.entity_id = ?1 AND y.on_device = 1
                AND o.retired_at IS NULL AND s.gone_at IS NULL",
        )?
        .query_map([id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if stated.is_empty() {
        return Ok(false);
    }
    let sql = if kind == "event" {
        "SELECT starts FROM event WHERE id = ?1"
    } else {
        "SELECT due FROM task WHERE id = ?1"
    };
    let moment: Option<String> = connection
        .prepare_cached(sql)?
        .query_row([id], |row| row.get(0))
        .optional()?
        .flatten();
    let mut leads: Vec<i64> = reminders
        .iter()
        .filter(|r| r.date_id.is_none())
        .map(|r| r.offset_min)
        .collect();
    leads.sort_unstable();
    leads.dedup();
    Ok(stated.iter().any(|text| {
        let json: serde_json::Value = serde_json::from_str(text).unwrap_or_default();
        let said_moment = json
            .get("starts")
            .or_else(|| json.get("due"))
            .and_then(|v| v.as_str());
        same_moment(moment.as_deref(), said_moment) && said_leads(&json) == leads
    }))
}

/// The leads a source stated: `reminders` (an array, or JSON text of one) or one `remind_before_min`.
fn said_leads(json: &serde_json::Value) -> Vec<i64> {
    let list: Vec<serde_json::Value> = match json.get("reminders") {
        Some(serde_json::Value::Array(items)) => items.clone(),
        Some(serde_json::Value::String(text)) => serde_json::from_str(text).unwrap_or_default(),
        _ => json
            .get("remind_before_min")
            .filter(|v| !v.is_null())
            .map(|v| vec![v.clone()])
            .unwrap_or_default(),
    };
    let mut found: Vec<i64> = list
        .iter()
        .filter_map(serde_json::Value::as_i64)
        .filter(|minutes| *minutes >= 0)
        .collect();
    found.sort_unstable();
    found.dedup();
    found
}

/// Whether two moments are the same one: a day is compared as a day, an instant as an instant, a
/// wall clock to the minute.
fn same_moment(ours: Option<&str>, stated: Option<&str>) -> bool {
    fn key(value: &str) -> String {
        if value.len() == 10 {
            return value.to_owned();
        }
        if let Some(ms) = parse_instant_ms(value).filter(|_| value.ends_with('Z')) {
            return format!("@{ms}");
        }
        value.chars().take(16).collect()
    }
    match (ours, stated) {
        (Some(ours), Some(stated)) => key(ours) == key(stated),
        (None, None) => true,
        _ => false,
    }
}

// ---------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------

type EventRow = (String, String, Option<String>, Option<String>, String, i64);

fn event_fires(
    connection: &Connection,
    id: &str,
    reminders: &[ReminderRow],
    refs: Refs,
) -> Result<Vec<(String, Fire)>> {
    let row: Option<EventRow> = connection
        .prepare_cached(
            "SELECT starts, timing, zone, rule, status, rule_supported FROM event WHERE id = ?1",
        )?
        .query_row([id], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
            ))
        })
        .optional()?;
    let Some((starts, timing, zone, rule, status, supported)) = row else {
        return Ok(Vec::new());
    };
    if status == "cancelled" {
        return Ok(Vec::new());
    }
    let Some((space, anchor)) = moment(&timing, &starts) else {
        return Ok(Vec::new());
    };
    // The starts a reminder can count back from: the anchor, or a series' occurrences with its
    // one-day overrides applied.
    let (starts_list, repeats) = match rule.as_deref().filter(|_| supported == 1) {
        None => (vec![(space, anchor)], false),
        Some(rule) => (
            series_starts(
                connection,
                id,
                rule,
                &starts,
                &timing,
                zone.as_deref(),
                refs,
            )?,
            true,
        ),
    };
    let mut out = Vec::new();
    for reminder in reminders.iter().filter(|r| r.date_id.is_none()) {
        let lead = reminder.offset_min * MINUTE_MS;
        let found = starts_list
            .iter()
            .copied()
            .find(|(space, at)| at - lead >= refs.of(*space))
            // A one-off, or a series with nothing ahead, keeps its latest firing for the banner.
            .or_else(|| (!repeats).then(|| starts_list.first().copied()).flatten());
        if let Some((space, at)) = found {
            out.push((
                reminder.id.clone(),
                Fire {
                    space,
                    at: at - lead,
                    repeats,
                },
            ));
        }
    }
    Ok(out)
}

/// A series' starts from now on, soonest first, with its cancelled days left out and its moved days
/// at the place they moved to (each in its own timing).
fn series_starts(
    connection: &Connection,
    id: &str,
    rule: &str,
    starts: &str,
    timing: &str,
    zone: Option<&str>,
    refs: Refs,
) -> Result<Vec<(Timing, i64)>> {
    let space = if timing == "zoned" {
        Timing::Fixed
    } else {
        Timing::Floating
    };
    let expanded = expand_series(rule, starts, timing, zone, refs.of(space));
    let rows = connection
        .prepare_cached(
            "SELECT original_start, cancelled, starts, timing FROM occurrence WHERE series_id = ?1",
        )?
        .query_map([id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut overridden: HashSet<i64> = HashSet::new();
    let mut moved: Vec<(Timing, i64)> = Vec::new();
    for (original, cancelled, new_start, own_timing) in rows {
        // An occurrence is named by the series' own reading of its original start.
        let Some((_, key)) = moment(timing, &original) else {
            continue;
        };
        if cancelled == 1 {
            overridden.insert(key);
        } else if let Some(new_start) = new_start {
            overridden.insert(key);
            let day_timing = own_timing.as_deref().unwrap_or(timing);
            moved.extend(moment(day_timing, &new_start));
        }
    }
    let mut out: Vec<(Timing, i64)> = expanded
        .into_iter()
        .filter(|(original, _)| !overridden.contains(original))
        .map(|(_, start)| (space, start))
        .chain(moved)
        .collect();
    out.sort_by_key(|(space, at)| refs.instant(*space, *at));
    out.dedup();
    Ok(out)
}

// ---------------------------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------------------------

type TaskRow = (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    String,
    Option<String>,
);

fn task_fires(
    connection: &Connection,
    id: &str,
    reminders: &[ReminderRow],
    refs: Refs,
) -> Result<Vec<(String, Fire)>> {
    let row: Option<TaskRow> = connection
        .prepare_cached(
            "SELECT due, due_timing, zone, rule, anchor, snoozed_until FROM task
              WHERE id = ?1 AND status = 'open'",
        )?
        .query_row([id], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
            ))
        })
        .optional()?;
    let Some((due, timing, zone, rule, anchor, snoozed)) = row else {
        return Ok(Vec::new());
    };
    let direct: Vec<&ReminderRow> = reminders.iter().filter(|r| r.date_id.is_none()).collect();
    // A SNOOZE MOVES THE ALERT, NOT THE DUE (#1188, NA5): while one is set it is the task's only
    // alert, at the instant the member asked for, on its smallest lead. The due is untouched.
    if let Some(until) = snoozed.as_deref().and_then(parse_instant_ms) {
        return Ok(direct
            .first()
            .map(|reminder| {
                (
                    reminder.id.clone(),
                    Fire {
                        space: Timing::Fixed,
                        at: until,
                        repeats: false,
                    },
                )
            })
            .into_iter()
            .collect());
    }
    let (Some(due), Some(timing)) = (due, timing) else {
        return Ok(Vec::new());
    };
    let Some((space, due_ms)) = moment(&timing, &due) else {
        return Ok(Vec::new());
    };
    let repeats = rule.is_some() && anchor == "scheduled";
    let mut out = Vec::new();
    for reminder in direct {
        let lead = reminder.offset_min * MINUTE_MS;
        let mut at = due_ms;
        if repeats && due_ms - lead < refs.of(space) {
            let next = expand_series(
                rule.as_deref().unwrap_or_default(),
                &due,
                &timing,
                zone.as_deref(),
                refs.of(space),
            )
            .into_iter()
            .map(|(_, start)| start)
            .find(|start| start - lead >= refs.of(space));
            match next {
                Some(start) => at = start,
                None => continue,
            }
        }
        out.push((
            reminder.id.clone(),
            Fire {
                space,
                at: at - lead,
                repeats,
            },
        ));
    }
    Ok(out)
}

// ---------------------------------------------------------------------------------------------
// A person's dates and a Locker date field
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
enum DateOf {
    Person,
    Field,
}

fn is_leap(year: i64) -> bool {
    year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
}

/// The wall epoch of 09:00 on a day.
fn day_at_nine(year: i64, month: i64, day: i64) -> i64 {
    wall_epoch(WallTime {
        year,
        month,
        day,
        hour: 9,
        minute: 0,
        second: 0,
        millisecond: 0,
    })
}

/// A person's date or a Locker date as (origin year, month, day): `YYYY-MM-DD`, or the yearless
/// vCard `--MM-DD`.
fn parse_date(text: &str) -> Option<(Option<i64>, i64, i64)> {
    if let Some(rest) = text.strip_prefix("--") {
        let month: i64 = rest.get(..2)?.parse().ok()?;
        let day: i64 = rest.get(3..5)?.parse().ok()?;
        return Some((None, month, day));
    }
    let wall = parse_wall_iso(text)?;
    Some((Some(wall.year), wall.month, wall.day))
}

/// The next firing of a yearly date at 09:00, the lead counted back from it: the first year whose
/// firing is not behind `reference`. Feb 29 falls on Feb 28 in a year with no leap day.
fn yearly(date: (Option<i64>, i64, i64), lead: i64, reference: i64) -> Option<i64> {
    let (origin, month, day) = date;
    let first = wall_from_epoch(reference + lead)
        .year
        .max(origin.unwrap_or(i64::MIN));
    (first..first + 9).find_map(|year| {
        let day = if month == 2 && day == 29 && !is_leap(year) {
            28
        } else {
            day
        };
        let at = day_at_nine(year, month, day) - lead;
        (at >= reference).then_some(at)
    })
}

fn date_fires(
    connection: &Connection,
    reminders: &[ReminderRow],
    refs: Refs,
    of: DateOf,
) -> Result<Vec<(String, Fire)>> {
    let mut out = Vec::new();
    for reminder in reminders {
        let (child, sql) = match of {
            DateOf::Person => (
                reminder.date_id.as_deref(),
                "SELECT date FROM person_date WHERE id = ?1",
            ),
            DateOf::Field => (
                reminder.field_id.as_deref(),
                "SELECT value_text FROM locker_item_field WHERE id = ?1 AND kind = 'date'",
            ),
        };
        let Some(child) = child else { continue };
        let text: Option<String> = connection
            .prepare_cached(sql)?
            .query_row([child], |row| row.get::<_, Option<String>>(0))
            .optional()?
            .flatten();
        let Some(date) = text.as_deref().and_then(parse_date) else {
            continue;
        };
        let lead = reminder.offset_min * MINUTE_MS;
        let reference = refs.floating;
        let fire = if of == DateOf::Person {
            yearly(date, lead, reference).map(|at| (at, true))
        } else {
            // A Locker date fires once (an expiry has no next year).
            date.0
                .map(|year| (day_at_nine(year, date.1, date.2) - lead, false))
        };
        if let Some((at, repeats)) = fire {
            out.push((
                reminder.id.clone(),
                Fire {
                    space: Timing::Floating,
                    at,
                    repeats,
                },
            ));
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------------------------
// Moving on, and the reads
// ---------------------------------------------------------------------------------------------

/// Whether [`advance`] has anything to do.
///
/// # Errors
/// SQLite's refusal.
pub fn has_stale(connection: &Connection, now: i64) -> Result<bool> {
    let refs = Refs::read(connection, now);
    for timing in [Timing::Fixed, Timing::Floating] {
        let reference = refs.of(timing);
        let stale: bool = connection
            .prepare_cached(
                "SELECT EXISTS (SELECT 1 FROM alert WHERE timing = ?1
                   AND ((repeats = 1 AND fire_key < ?2) OR (repeats = 0 AND fire_key < ?3)))",
            )?
            .query_row(
                params![
                    timing.as_str(),
                    timing.key_of(reference),
                    timing.key_of(reference - KEEP_PAST_MS)
                ],
                |row| row.get(0),
            )?;
        if stale {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Move on the repeating rows whose firing has passed (the entity's rows are written again), and
/// drop the one-off rows that came due before [`KEEP_PAST_MS`] ago. Returns how many entities were
/// recomputed; fewer than [`ADVANCE_BATCH`] means none are left. Writes the index file only; call it
/// inside a transaction on it.
///
/// # Errors
/// SQLite's refusal.
pub fn advance(connection: &Connection, now: i64) -> Result<usize> {
    let refs = Refs::read(connection, now);
    let mut stale: Vec<i64> = Vec::new();
    for timing in [Timing::Fixed, Timing::Floating] {
        let reference = refs.of(timing);
        stale.extend(
            connection
                .prepare_cached(
                    "SELECT DISTINCT n FROM alert
                      WHERE timing = ?1 AND repeats = 1 AND fire_key < ?2 LIMIT ?3",
                )?
                .query_map(
                    params![
                        timing.as_str(),
                        timing.key_of(reference),
                        ADVANCE_BATCH as i64
                    ],
                    |row| row.get::<_, i64>(0),
                )?
                .collect::<rusqlite::Result<Vec<_>>>()?,
        );
        connection
            .prepare_cached(
                "DELETE FROM alert WHERE timing = ?1 AND repeats = 0 AND fire_key < ?2",
            )?
            .execute(params![
                timing.as_str(),
                timing.key_of(reference - KEEP_PAST_MS)
            ])?;
    }
    stale.sort_unstable();
    stale.dedup();
    for n in &stale {
        sync(connection, *n, now)?;
    }
    Ok(stale.len())
}

fn alert_of(row: &rusqlite::Row<'_>, timing: Timing) -> rusqlite::Result<Alert> {
    Ok(Alert {
        reminder_id: row.get(0)?,
        n: row.get(1)?,
        timing,
        fire_key: row.get(2)?,
        repeats: row.get::<_, i64>(3)? == 1,
    })
}

/// The one-off rows that came due in the given window, newest first, at most `limit` per timing:
/// the items whose reminder may be on the member's screen right now. The bounds are keys in each
/// timing's own space.
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
            "SELECT reminder_id, n, fire_key, repeats FROM alert
              WHERE timing = ?1 AND fire_key >= ?2 AND fire_key < ?3
              ORDER BY fire_key DESC, reminder_id LIMIT ?4",
        )?;
        let rows = statement.query_map(
            params![
                timing.as_str(),
                from,
                to,
                i64::try_from(limit).unwrap_or(i64::MAX)
            ],
            |row| alert_of(row, timing),
        )?;
        for row in rows {
            out.push(row?);
        }
    }
    Ok(out)
}

/// THE NEXT FIRINGS: the next `limit` of each timing at or after the given keys, soonest first
/// within a timing. `fixed_from` is an instant text, `floating_from` a wall clock. One seek on
/// `alert_by_fire` per timing, whatever the vault holds.
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
        let mut statement = connection.prepare_cached(NEXT_SQL)?;
        let rows = statement.query_map(
            params![
                timing.as_str(),
                from,
                i64::try_from(limit).unwrap_or(i64::MAX)
            ],
            |row| alert_of(row, timing),
        )?;
        for row in rows {
            out.push(row?);
        }
    }
    Ok(out)
}

/// The statement [`next`] runs (the plan test reads it).
pub const NEXT_SQL: &str = "SELECT reminder_id, n, fire_key, repeats FROM alert
  WHERE timing = ?1 AND fire_key >= ?2 ORDER BY fire_key, reminder_id LIMIT ?3";

// ---------------------------------------------------------------------------------------------
// What a notification says
// ---------------------------------------------------------------------------------------------

/// What a notification says, and nothing more. **Never a value**: a Locker date names the item's
/// title and the field's label; a sealed cell is not read here at all.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Notice {
    pub reminder_id: String,
    pub entity_id: String,
    /// `event`, `task`, `person` or `locker_item`.
    pub kind: String,
    /// The item's title: the event's, the task's, the person's, the Locker item's.
    pub title: String,
    /// When the thing is, as the alert counts it (the firing plus the lead): an instant for a zoned
    /// item, a wall clock for a floating one, the day (`YYYY-MM-DD`) for an all-day item, a person's
    /// date or a Locker date. A snoozed task says its due.
    pub at: Option<String>,
    /// How `at` reads: `zoned`, `floating`, `all-day` or `date`.
    pub timing: String,
    /// A person's date: its label if the member gave one, else its kind (`birthday`).
    /// A Locker date: the field's label. Else `None`.
    pub what: Option<String>,
    pub offset_min: i64,
}

type NoticeRow = (
    String,
    String,
    String,
    String,
    i64,
    Option<String>,
    Option<String>,
);

/// The notice for a reminder's alert, or `None` when it has none (not written, or gone).
///
/// # Errors
/// SQLite's refusal.
pub fn notice(connection: &Connection, reminder_id: &str) -> Result<Option<Notice>> {
    let row: Option<NoticeRow> = connection
        .prepare_cached(
            "SELECT r.entity_id, e.kind, e.title, a.fire_key, r.offset_min, r.date_id, r.field_id
                   FROM alert a JOIN reminder r ON r.id = a.reminder_id
                   JOIN entity e ON e.id = r.entity_id WHERE a.reminder_id = ?1",
        )?
        .query_row([reminder_id], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
            ))
        })
        .optional()?;
    let Some((entity_id, kind, title, fire_key, offset_min, date_id, field_id)) = row else {
        return Ok(None);
    };
    let timing_of_alert: String = connection
        .prepare_cached("SELECT timing FROM alert WHERE reminder_id = ?1")?
        .query_row([reminder_id], |row| row.get(0))?;
    let space = if timing_of_alert == "fixed" {
        Timing::Fixed
    } else {
        Timing::Floating
    };
    let shifted = ms_in(space, &fire_key).map(|ms| space.key_of(ms + offset_min * MINUTE_MS));
    let (at, timing, what) = match kind.as_str() {
        "person" => {
            let what: Option<(String, Option<String>)> = connection
                .prepare_cached("SELECT kind, label FROM person_date WHERE id = ?1")?
                .query_row([date_id.as_deref().unwrap_or("")], |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })
                .optional()?;
            (
                shifted.map(|text| text[..10].to_owned()),
                "date".to_owned(),
                what.map(|(kind, label)| label.unwrap_or(kind)),
            )
        }
        "locker_item" => {
            let label: Option<String> = connection
                .prepare_cached("SELECT label FROM locker_item_field WHERE id = ?1")?
                .query_row([field_id.as_deref().unwrap_or("")], |row| row.get(0))
                .optional()?;
            (
                shifted.map(|text| text[..10].to_owned()),
                "date".to_owned(),
                label,
            )
        }
        "event" => {
            let timing: String = connection
                .prepare_cached("SELECT timing FROM event WHERE id = ?1")?
                .query_row([&entity_id], |row| row.get(0))?;
            let at = if timing == "all-day" {
                shifted.map(|text| text[..10].to_owned())
            } else {
                shifted
            };
            (at, timing, None)
        }
        _ => {
            let row: (Option<String>, Option<String>, Option<String>) = connection
                .prepare_cached("SELECT due, due_timing, snoozed_until FROM task WHERE id = ?1")?
                .query_row([&entity_id], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                })?;
            let timing = row.1.unwrap_or_else(|| "zoned".to_owned());
            let at = if row.2.is_some() {
                row.0
            } else if timing == "all-day" {
                shifted.map(|text| text[..10].to_owned())
            } else {
                shifted
            };
            (at, timing, None)
        }
    };
    Ok(Some(Notice {
        reminder_id: reminder_id.to_owned(),
        entity_id,
        kind,
        title,
        at,
        timing,
        what,
        offset_min,
    }))
}

#[cfg(test)]
mod order_tests {
    use super::longest_first;

    #[test]
    fn alerts_read_longest_lead_first_each_once() {
        assert_eq!(longest_first(vec![10, 30]), vec![30, 10]);
        assert_eq!(longest_first(vec![10, 1440, 60, 10]), vec![1440, 60, 10]);
        assert!(longest_first(Vec::new()).is_empty());
    }
}
