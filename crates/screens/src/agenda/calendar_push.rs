//! TWO-WAY CALENDAR SYNC, THE SCREEN HALF (#1173): what the core asks the shell to write.
//!
//! The vault derives what the phone's writable calendars are OWED (`shell.calendar-owed`, from
//! `centraid_vault::commands::calendar_push::owed_pushes`): nothing is queued, so a write that
//! failed or was never answered is owed again at the next pass (C11). This module turns each owed
//! event into [`wire::CalendarWriteItem`]s in the forms a shell can perform without a rule
//! engine (wall clocks in a zone, an RFC 5545 rule, alert minutes), keeps what it asked so the
//! answer can be recorded (`follow.pushed`), and folds the shell's per-item answers back into one
//! verdict per event.
//!
//! ## What one event becomes (C10)
//!
//! - an event that does not repeat: one `SPAN_SERIES` item;
//! - a repeating series edited as a whole: one `SPAN_SERIES` item stating the fields that changed
//!   (the vault's own rule string is what is written);
//! - a day of a series the member moved, edited or cancelled: one `SPAN_THIS` item for that day,
//!   keyed by its series-local `original_start` (a cancelled day sets `cancel`); a day whose move
//!   the member undid is written back as the series has it.
//!
//! "This and following" is stored by the vault as moved days of one series, so it is those days.
//!
//! An update states ONLY the fields the member changed here (`states_*`), so a phone-side change
//! to another field is never overwritten by a write that did not mean to touch it.

use centraid_api_proto::core_v1 as wire;
use centraid_vault::clock::parse_iso_ms;
use centraid_vault::time::zone::{FireZone, WallTime, parse_wall_iso, wall_epoch, wall_from_epoch, wall_iso};
use serde_json::{Value, json};
use wire::app_query_response::Answer;
use wire::calendar_write_item::{Op, Span};

use crate::catalog::load;
use crate::kit::read::{self, Reading};
use crate::screen::Ctx;

/// The most events one `CalendarWrite` carries; the rest follow on the next round.
pub const PAGE: u32 = 50;

/// Pages scanned for something writable before giving up for this round (a bound by construction).
pub const MAX_PAGES: usize = 20;

/// One event the vault owes the phone, as `shell.calendar-owed` answered it.
#[derive(Clone, Debug)]
pub struct Owed {
    pub op: String,
    pub event_id: String,
    pub origin_ref: String,
    pub external_id: String,
    pub device_id: String,
    pub changed: Vec<String>,
    pub stated: Value,
    pub fields: Value,
}

/// One page of what is owed, and where to read on.
#[derive(Clone, Debug, Default)]
pub struct Page {
    pub items: Vec<Owed>,
    pub next: String,
}

/// The writes asked for one event and what to record when they are answered.
#[derive(Clone, Debug)]
pub struct Prepared {
    pub event_id: String,
    pub op: &'static str,
    pub device_id: String,
    /// The fields `follow.pushed` states the phone now holds (the changed ones of an update, all
    /// of a create), or `null`.
    pub pushed: Value,
    pub items: Vec<wire::CalendarWriteItem>,
}

/// What the shell's answers came to for one event.
#[derive(Clone, Debug, PartialEq)]
pub struct Verdict {
    pub event_id: String,
    pub op: &'static str,
    pub ok: bool,
    pub external_id: String,
    pub device_id: String,
    pub phone_kept: bool,
    pub pushed: Value,
}

/// Read one page of what the writable calendars `origins` (origin refs) are owed, after the event
/// `after`. `None` when the read failed: nothing is pushed on a read that did not come back.
pub fn read(ctx: &Ctx, origins: &[String], after: &str) -> Option<Page> {
    let request = load::shell::CalendarOwed {
        origins: Some(json!(origins).to_string()),
        after_event: (!after.is_empty()).then(|| after.to_owned()),
        limit: PAGE,
    };
    match read::read(ctx, request, |answer| match answer {
        Answer::ImportsCalendarOwed(owed) => Some(owed),
        _ => None,
    }) {
        Reading::Data(owed) => Some(Page {
            next: owed.next,
            items: owed
                .items
                .into_iter()
                .map(|item| Owed {
                    op: item.op,
                    event_id: item.event_id,
                    origin_ref: item.origin_ref,
                    external_id: item.external_id,
                    device_id: item.device_id,
                    changed: item.changed,
                    stated: serde_json::from_str(&item.stated_json).unwrap_or(Value::Null),
                    fields: serde_json::from_str(&item.fields_json).unwrap_or(Value::Null),
                })
                .collect(),
        }),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Times, in the shell's forms
// ---------------------------------------------------------------------------

/// A time as the shell reads it: an all-day event's day, a zoned one's wall clock in its zone (the
/// vault holds the instant), a floating one's wall clock.
fn local_of(text: &str, timing: &str, zone: Option<&str>) -> Option<String> {
    let text = text.trim();
    match timing {
        "all-day" => text.get(..10).map(str::to_owned),
        "zoned" => {
            let zone = FireZone::named(zone?).ok()?;
            let wall = zone.zoned_parts(parse_iso_ms(text)?);
            Some(wall_iso(WallTime { millisecond: 0, ..wall }, true))
        }
        _ => {
            let wall = parse_wall_iso(text)?;
            Some(wall_iso(WallTime { millisecond: 0, ..wall }, true))
        }
    }
}

/// `start` moved on by the length from `from` to `to` (the series' own length), on the wall clock.
fn plus_length(start: &str, from: &str, to: &str) -> Option<String> {
    let (start, from, to) = (
        parse_wall_iso(start)?,
        parse_wall_iso(from)?,
        parse_wall_iso(to)?,
    );
    let length = wall_epoch(to) - wall_epoch(from);
    let at = wall_from_epoch(wall_epoch(start) + length.max(0));
    let timed = start.hour != 0 || start.minute != 0 || start.second != 0 || length % 86_400_000 != 0;
    Some(wall_iso(at, timed))
}

/// The times of a whole event: `(all_day, start, end, tz)`.
fn when_of(fields: &Value) -> Option<(bool, String, String, String)> {
    let timing = fields.get("timing").and_then(Value::as_str).unwrap_or("floating");
    let zone = fields
        .get("zone")
        .and_then(Value::as_str)
        .filter(|zone| !zone.is_empty());
    let start = local_of(fields.get("starts")?.as_str()?, timing, zone)?;
    let end = match fields.get("ends").and_then(Value::as_str) {
        Some(end) => local_of(end, timing, zone)?,
        None if timing == "all-day" => start.clone(),
        // No end is an hour, the least a calendar app draws.
        None => {
            let at = wall_from_epoch(wall_epoch(parse_wall_iso(&start)?) + 3_600_000);
            wall_iso(at, true)
        }
    };
    let tz = if timing == "zoned" {
        zone.unwrap_or_default().to_owned()
    } else {
        String::new()
    };
    Some((timing == "all-day", start, end, tz))
}

fn text_of(fields: &Value, name: &str) -> String {
    fields
        .get(name)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_owned()
}

/// The alerts, minutes before: the column holds the JSON array as text.
fn alerts_of(fields: &Value) -> Vec<u32> {
    let list: Vec<Value> = match fields.get("reminders") {
        Some(Value::String(text)) => serde_json::from_str(text).unwrap_or_default(),
        Some(Value::Array(list)) => list.clone(),
        _ => Vec::new(),
    };
    list.iter()
        .filter_map(Value::as_u64)
        .filter_map(|minutes| u32::try_from(minutes).ok())
        .collect()
}

fn busy_of(fields: &Value) -> bool {
    match fields.get("busy") {
        Some(Value::Bool(busy)) => *busy,
        Some(other) => other.as_i64().is_none_or(|busy| busy != 0),
        None => true,
    }
}

/// The fields of an event as they are written. `changed` names what to state (`None`: all).
fn write_fields(fields: &Value, changed: Option<&[String]>) -> Option<wire::CalendarWriteFields> {
    let says = |names: &[&str]| {
        changed.is_none_or(|changed| names.iter().any(|name| changed.iter().any(|c| c == name)))
    };
    let states_when = says(&["starts", "ends", "timing", "zone"]);
    let (all_day, start, end, tz) = if states_when {
        when_of(fields)?
    } else {
        (false, String::new(), String::new(), String::new())
    };
    Some(wire::CalendarWriteFields {
        title: text_of(fields, "title"),
        notes: text_of(fields, "description"),
        url: text_of(fields, "url"),
        all_day,
        start,
        end,
        tz,
        rrule: text_of(fields, "rule"),
        busy: busy_of(fields),
        alerts: alerts_of(fields),
        states_notes: says(&["description"]),
        states_url: says(&["url"]),
        states_alerts: says(&["reminders"]),
        states_rrule: says(&["rule"]),
        states_title: says(&["title"]),
        states_when,
        states_busy: says(&["busy"]),
    })
}

/// What the phone last stated, in the forms a delete is checked against.
fn expected_of(stated: &Value) -> wire::CalendarStated {
    let when = when_of(stated);
    wire::CalendarStated {
        title: text_of(stated, "title"),
        notes: text_of(stated, "description"),
        url: text_of(stated, "url"),
        start: when.as_ref().map(|w| w.1.clone()).unwrap_or_default(),
        end: when.map(|w| w.2).unwrap_or_default(),
    }
}

// ---------------------------------------------------------------------------
// The days of a series (C10)
// ---------------------------------------------------------------------------

/// One day of a series as the vault holds it: `[original_start, cancelled, starts, title, timing,
/// url, place]` (`event::overrides_held`).
fn held_days(overrides: &Value) -> Vec<Value> {
    overrides
        .get("held")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn day_key(day: &Value) -> &str {
    day.get(0).and_then(Value::as_str).unwrap_or_default()
}

/// Whether the phone already shows `day` as it is held: `stated` is what the phone last stated of
/// the series' days, either as the vault's own held rows (a past push) or as what the phone showed
/// (`shown` days and `moved` ones, from a read).
fn day_stated(stated: &Value, day: &Value, zone: Option<&str>, timing: &str) -> bool {
    let key = day_key(day);
    if let Some(rows) = stated.get("held").and_then(Value::as_array) {
        return rows.iter().any(|row| row == day);
    }
    let cancelled = day.get(1).and_then(Value::as_bool).unwrap_or(false);
    let shown = stated
        .get("shown")
        .and_then(Value::as_array)
        .is_some_and(|shown| shown.iter().any(|day| day.as_str() == Some(key)));
    let moved = stated
        .get("moved")
        .and_then(Value::as_array)
        .and_then(|moved| {
            moved
                .iter()
                .find(|moved| moved.get("original_start").and_then(Value::as_str) == Some(key))
        });
    if cancelled {
        return !shown && moved.is_none();
    }
    let Some(moved) = moved else {
        return false;
    };
    let same_title = day.get(3).and_then(Value::as_str).is_none_or(|title| {
        moved.get("title").and_then(Value::as_str) == Some(title.trim())
    });
    let same_start = day.get(2).and_then(Value::as_str).is_none_or(|starts| {
        local_of(starts, timing, zone).as_deref() == moved.get("starts").and_then(Value::as_str)
    });
    same_title && same_start
}

/// The items of a series' days: each that differs from what the phone last stated, and each move
/// the member undid.
fn day_items(
    owed: &Owed,
    calendar: &str,
    timing: &str,
    zone: Option<&str>,
    series: &(String, String),
) -> Vec<wire::CalendarWriteItem> {
    let held = held_days(owed.fields.get("overrides").unwrap_or(&Value::Null));
    let said = owed.stated.get("overrides").cloned().unwrap_or(Value::Null);
    let mut items = Vec::new();
    let base = |key: &str| wire::CalendarWriteItem {
        event_id: owed.event_id.clone(),
        op: Op::Update as i32,
        calendar_key: calendar.to_owned(),
        external_id: owed.external_id.clone(),
        span: Span::This as i32,
        original_start: key.to_owned(),
        device_id: owed.device_id.clone(),
        ..wire::CalendarWriteItem::default()
    };
    let busy = busy_of(&owed.fields);
    for day in &held {
        if day_stated(&said, day, zone, timing) {
            continue;
        }
        let key = day_key(day);
        let cancelled = day.get(1).and_then(Value::as_bool).unwrap_or(false);
        let mut item = base(key);
        if cancelled {
            item.cancel = true;
            items.push(item);
            continue;
        }
        let start = day
            .get(2)
            .and_then(Value::as_str)
            .and_then(|starts| local_of(starts, timing, zone))
            .unwrap_or_else(|| key.to_owned());
        let Some(end) = plus_length(&start, &series.0, &series.1) else {
            continue;
        };
        item.fields = Some(wire::CalendarWriteFields {
            title: day
                .get(3)
                .and_then(Value::as_str)
                .map_or_else(|| text_of(&owed.fields, "title"), str::to_owned),
            url: day
                .get(5)
                .and_then(Value::as_str)
                .map_or_else(|| text_of(&owed.fields, "url"), str::to_owned),
            all_day: timing == "all-day",
            start,
            end,
            tz: zone.unwrap_or_default().to_owned(),
            busy,
            states_title: true,
            states_when: true,
            states_url: true,
            ..wire::CalendarWriteFields::default()
        });
        items.push(item);
    }
    // A day the phone moved or cancelled that the vault no longer holds as changed was put back:
    // write it as the series has it.
    let still: Vec<&str> = held.iter().map(day_key).collect();
    let undone: Vec<String> = match &said {
        said if said.get("held").is_some() => held_days(said)
            .iter()
            .map(|day| day_key(day).to_owned())
            .collect(),
        said => said
            .get("moved")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|moved| moved.get("original_start").and_then(Value::as_str))
            .map(str::to_owned)
            .collect(),
    };
    for key in undone.iter().filter(|key| !still.contains(&key.as_str())) {
        let Some(end) = plus_length(key, &series.0, &series.1) else {
            continue;
        };
        let mut item = base(key);
        item.fields = Some(wire::CalendarWriteFields {
            title: text_of(&owed.fields, "title"),
            url: text_of(&owed.fields, "url"),
            all_day: timing == "all-day",
            start: key.clone(),
            end,
            tz: zone.unwrap_or_default().to_owned(),
            busy,
            states_title: true,
            states_when: true,
            states_url: true,
            ..wire::CalendarWriteFields::default()
        });
        items.push(item);
    }
    items
}

// ---------------------------------------------------------------------------
// One owed event
// ---------------------------------------------------------------------------

/// The calendar a push goes to: the ref `calendar:<key>` without its prefix. A ref of another kind
/// (this phone's own `local:` origin) names no phone calendar and is never written.
fn calendar_of(origin_ref: &str) -> Option<&str> {
    origin_ref
        .strip_prefix("calendar:")
        .filter(|key| !key.is_empty())
}

/// The writes one owed event asks for, or none when it cannot be written as it stands.
#[must_use]
pub fn prepare(owed: &Owed, device: &str) -> Option<Prepared> {
    let calendar = calendar_of(&owed.origin_ref)?;
    let device_id = if owed.device_id.is_empty() {
        device.to_owned()
    } else {
        owed.device_id.clone()
    };
    let item = |op: Op| wire::CalendarWriteItem {
        event_id: owed.event_id.clone(),
        op: op as i32,
        calendar_key: calendar.to_owned(),
        external_id: owed.external_id.clone(),
        span: Span::Series as i32,
        device_id: device_id.clone(),
        ..wire::CalendarWriteItem::default()
    };
    let (op, items, pushed) = match owed.op.as_str() {
        "delete" => {
            let mut one = item(Op::Delete);
            one.expected = Some(expected_of(&owed.stated));
            ("delete", vec![one], Value::Null)
        }
        "create" => {
            let mut one = item(Op::Create);
            one.fields = Some(write_fields(&owed.fields, None)?);
            let mut items = vec![one];
            // A series founded here pushes the days it already holds.
            if owed.fields.get("overrides").is_some_and(|days| !days.is_null()) {
                items.extend(days_of(owed, calendar)?);
            }
            ("create", items, owed.fields.clone())
        }
        "update" => {
            let changed = &owed.changed;
            let only_days = changed.iter().all(|name| name == "overrides");
            let mut items = Vec::new();
            if !only_days {
                let mut one = item(Op::Update);
                one.fields = Some(write_fields(&owed.fields, Some(changed))?);
                items.push(one);
            }
            if changed.iter().any(|name| name == "overrides") {
                items.extend(days_of(owed, calendar)?);
            }
            let mut pushed = serde_json::Map::new();
            for name in changed {
                if let Some(value) = owed.fields.get(name) {
                    pushed.insert(name.clone(), value.clone());
                }
            }
            ("update", items, Value::Object(pushed))
        }
        _ => return None,
    };
    // A day-only edit that turned out to change nothing the phone shows has nothing to write.
    if items.is_empty() {
        return None;
    }
    Some(Prepared {
        event_id: owed.event_id.clone(),
        op,
        device_id,
        pushed,
        items,
    })
}

/// The `SPAN_THIS` items of a series' days.
fn days_of(owed: &Owed, calendar: &str) -> Option<Vec<wire::CalendarWriteItem>> {
    let timing = owed
        .fields
        .get("timing")
        .and_then(Value::as_str)
        .unwrap_or("floating");
    let zone = owed
        .fields
        .get("zone")
        .and_then(Value::as_str)
        .filter(|zone| !zone.is_empty());
    let (_, start, end, _) = when_of(&owed.fields)?;
    Some(day_items(owed, calendar, timing, zone, &(start, end)))
}

// ---------------------------------------------------------------------------
// The answers
// ---------------------------------------------------------------------------

/// One verdict per event asked: all its items must have been answered `ok` (an item the shell
/// left out is a failure, and so is the whole answer failing: it is owed again, C11).
#[must_use]
pub fn verdicts(asked: &[Prepared], answered: Option<&wire::CalendarWritten>) -> Vec<Verdict> {
    asked
        .iter()
        .map(|prepared| {
            let theirs: Vec<&wire::CalendarWrittenItem> = answered
                .map(|written| {
                    written
                        .items
                        .iter()
                        .filter(|item| item.event_id == prepared.event_id)
                        .collect()
                })
                .unwrap_or_default();
            let ok = theirs.len() >= prepared.items.len() && theirs.iter().all(|item| item.ok);
            Verdict {
                event_id: prepared.event_id.clone(),
                op: prepared.op,
                ok,
                external_id: theirs
                    .iter()
                    .map(|item| item.external_id.clone())
                    .find(|id| !id.is_empty())
                    .unwrap_or_default(),
                device_id: prepared.device_id.clone(),
                phone_kept: theirs.iter().any(|item| item.phone_kept),
                pushed: prepared.pushed.clone(),
            }
        })
        .collect()
}

/// The `follow.pushed` items for these verdicts.
#[must_use]
pub fn pushed_items(verdicts: &[Verdict]) -> Value {
    Value::Array(
        verdicts
            .iter()
            .map(|verdict| {
                let mut item = serde_json::Map::new();
                item.insert("event_id".into(), json!(verdict.event_id));
                item.insert("op".into(), json!(verdict.op));
                item.insert("ok".into(), json!(verdict.ok));
                if verdict.op == "create" && !verdict.external_id.is_empty() {
                    item.insert("external_id".into(), json!(verdict.external_id));
                    item.insert("device_id".into(), json!(verdict.device_id));
                }
                if verdict.op != "delete" && !verdict.pushed.is_null() {
                    item.insert("fields".into(), verdict.pushed.clone());
                }
                if verdict.phone_kept {
                    item.insert("phone_kept".into(), json!(true));
                }
                Value::Object(item)
            })
            .collect(),
    )
}
