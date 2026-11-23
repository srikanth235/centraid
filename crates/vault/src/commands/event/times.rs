//! Event timing, wall-clock resolution, recurrence expansion, and reminder child callbacks.

use std::collections::BTreeSet;

use rusqlite::Connection;
use serde_json::{Value as Json, json};

use crate::commands::CommandCtx;
use crate::error::{Result, VaultError};
use crate::time::occurrence::{SEARCH_WINDOW_DAYS, search_window};
use crate::time::recurrence::{ExpandInput, Occurrence, Semantics, expand, parse_instant_ms};
use crate::time::zone::{FireZone, parse_wall_iso};
use crate::time::{rrule, temporal};

use super::{TIMINGS, reminders_held, set_reminders};

pub(super) fn parse_timing(word: &str) -> Option<Semantics> {
    TIMINGS.into_iter().find(|timing| timing.as_str() == word)
}

/// The times a command states, resolved to what the row stores.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Times {
    pub(super) starts: String,
    pub(super) ends: Option<String>,
    pub(super) timing: Semantics,
    pub(super) zone: Option<String>,
}

/// The event as it stands, for an edit to complete a half-stated change from.
pub(super) struct Row {
    pub(super) times: Times,
    pub(super) rule: Option<String>,
    pub(super) status: String,
}

pub(super) fn row_of(connection: &Connection, id: &str) -> Result<Row> {
    connection
        .query_row(
            "SELECT starts, ends, timing, zone, rule, status FROM event WHERE id = ?1",
            [id],
            |row| {
                let timing: String = row.get(2)?;
                Ok(Row {
                    times: Times {
                        starts: row.get(0)?,
                        ends: row.get(1)?,
                        timing: Semantics::from_stored(Some(&timing)),
                        zone: row.get(3)?,
                    },
                    rule: row.get(4)?,
                    status: row.get(5)?,
                })
            },
        )
        .map_err(|_| VaultError::Invariant {
            context: format!("`{id}` is not an event, and a precondition said it was"),
        })
}

/// One time as the row will hold it, under `timing`: an instant stays one, a
/// wall clock in the zone becomes the instant it is, a floating time or a day
/// stays as written.
pub(super) fn resolve_one(
    field: &str,
    value: &str,
    timing: Semantics,
    zone: Option<&FireZone>,
) -> std::result::Result<String, String> {
    let kind = temporal::classify(value);
    let shape = |wanted: &str| format!("`{field}` is {value}; with this timing it is {wanted}.");
    match timing {
        Semantics::AllDay => (kind == Some(temporal::Kind::LocalDate))
            .then(|| value.to_owned())
            .ok_or_else(|| shape("a date, YYYY-MM-DD")),
        Semantics::Floating => (kind == Some(temporal::Kind::FloatingDateTime))
            .then(|| value.to_owned())
            .ok_or_else(|| shape("a wall clock, YYYY-MM-DDTHH:MM[:SS]")),
        Semantics::Zoned => match kind {
            Some(temporal::Kind::Instant) => parse_instant_ms(value)
                .map(crate::clock::format_iso_ms)
                .ok_or_else(|| shape("an instant or a wall clock in its zone")),
            Some(temporal::Kind::FloatingDateTime) => {
                let zone = zone.ok_or("a zoned time needs the zone it is in.")?;
                let wall = parse_wall_iso(value)
                    .ok_or_else(|| shape("an instant or a wall clock in its zone"))?;
                zone.resolve_wall_time(wall)
                    .map(|resolved| resolved.instant)
                    .ok_or_else(|| format!("{value} does not exist in {zone}: the clocks skip it."))
            }
            _ => Err(shape("an instant or a wall clock in its zone")),
        },
    }
}

/// The times a command or a source states over `base` (an edit) or alone (a
/// proposal): the object's `starts`, `ends`, `timing` and `zone`. `Err` is the
/// sentence a member reads.
///
/// The timing is the one said; else the zone's presence says zoned; else the
/// event's own, when it has one; else the shape of `starts` (a date is all-day,
/// an instant zoned, anything else a wall clock). A zone is the one said, else
/// the event's own.
pub(super) fn resolve_times(
    stated: &serde_json::Map<String, Json>,
    base: Option<&Times>,
) -> std::result::Result<Times, String> {
    let (starts, ends, timing_word, zone_word) = (
        stated.get("starts").and_then(Json::as_str),
        stated.get("ends"),
        stated.get("timing").and_then(Json::as_str),
        stated.get("zone"),
    );
    if let Some(base) = base
        && starts.is_none()
        && ends.is_none()
        && timing_word.is_none()
        && zone_word.is_none()
    {
        return Ok(base.clone());
    }
    let zone_name = match zone_word {
        Some(Json::String(name)) => Some(name.clone()),
        Some(_) => None,
        None => base.and_then(|base| base.zone.clone()),
    };
    let timing = match timing_word {
        Some(word) => parse_timing(word).ok_or_else(|| format!("`{word}` is not a timing."))?,
        None if matches!(zone_word, Some(Json::String(_))) => Semantics::Zoned,
        None if base.is_some() => base.map_or(Semantics::Floating, |base| base.timing),
        None => match starts.map(temporal::classify) {
            Some(Some(temporal::Kind::LocalDate)) => Semantics::AllDay,
            Some(Some(temporal::Kind::Instant)) => Semantics::Zoned,
            _ => Semantics::Floating,
        },
    };
    let zone = if timing == Semantics::Zoned {
        let name = zone_name.ok_or("A zoned event needs the zone it is in.")?;
        Some(FireZone::named(&name).map_err(|_| format!("{name} is not a time zone."))?)
    } else {
        if matches!(zone_word, Some(Json::String(_))) {
            return Err("A time in a zone is zoned; it cannot also be floating or all-day.".into());
        }
        None
    };
    let starts = match starts.or_else(|| base.map(|base| base.starts.as_str())) {
        Some(value) => resolve_one("starts", value, timing, zone.as_ref())?,
        None => return Err("An event needs a start.".to_owned()),
    };
    let ends = match ends {
        Some(Json::String(value)) => Some(resolve_one("ends", value, timing, zone.as_ref())?),
        Some(_) => None,
        None => base
            .and_then(|base| base.ends.clone())
            .map(|value| resolve_one("ends", &value, timing, zone.as_ref()))
            .transpose()?,
    };
    if let Some(ends) = &ends {
        let (before, after) = (&starts, ends);
        let ordered = if timing == Semantics::Zoned {
            parse_instant_ms(after) > parse_instant_ms(before)
        } else if timing == Semantics::AllDay {
            after >= before
        } else {
            after > before
        };
        if !ordered {
            return Err(if timing == Semantics::AllDay {
                "An all-day event must end on or after the day it starts."
            } else {
                "An event must end after it starts."
            }
            .to_owned());
        }
    }
    Ok(Times {
        starts,
        ends,
        timing,
        zone: zone.map(|zone| zone.name().to_owned()),
    })
}

pub(super) fn times(
    ctx: &CommandCtx<'_, '_>,
    base: Option<&Times>,
) -> std::result::Result<Times, String> {
    resolve_times(
        ctx.input.as_object().unwrap_or(&serde_json::Map::new()),
        base,
    )
}

/// What one day of a series states of its own times, over the series': only what was said
/// (the rest is the series'), and how the day reads when that is not the way its series does.
#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct DayTimes {
    pub(super) starts: Option<String>,
    pub(super) ends: Option<String>,
    /// The day's own timing and, for a zoned one, its zone; `None` while it reads as its series
    /// does ([#1146](https://github.com/srikanth235/centraid/issues/1146)).
    pub(super) own: Option<(Semantics, Option<String>)>,
}

/// The times a day states over its `series`: `Err` is the sentence a member reads.
///
/// The series' end is a LENGTH a day borrows (it is not stored on the day), so it is never
/// carried over a day's own start, nor into another timing where it would not read.
pub(super) fn day_times(
    stated: &serde_json::Map<String, Json>,
    series: &Times,
) -> std::result::Result<DayTimes, String> {
    let said = |key: &str| stated.get(key).and_then(Json::as_str).is_some();
    let other_timing = stated
        .get("timing")
        .and_then(Json::as_str)
        .and_then(parse_timing)
        .is_some_and(|timing| timing != series.timing);
    let base = Times {
        ends: (!said("starts") && !other_timing)
            .then(|| series.ends.clone())
            .flatten(),
        ..series.clone()
    };
    let at = resolve_times(stated, Some(&base))?;
    let own = (at.timing != series.timing
        || (at.timing == Semantics::Zoned && at.zone != series.zone))
        .then(|| {
            (
                at.timing,
                at.zone.clone().filter(|_| at.timing == Semantics::Zoned),
            )
        });
    Ok(DayTimes {
        starts: said("starts").then_some(at.starts),
        ends: stated.contains_key("ends").then_some(at.ends).flatten(),
        own,
    })
}

/// What a followed calendar states of an event, in the form the vault holds it:
/// a wall clock and its zone become the instant, so the statement a source makes
/// and the row it leaves compare equal.
pub(crate) fn shape(fields: &mut serde_json::Map<String, Json>) -> std::result::Result<(), String> {
    if let Some(alerts) = fields.get("reminders") {
        let alerts = alerts_canon(alerts)?;
        fields.insert("reminders".to_owned(), alerts);
    }
    if !["starts", "ends", "timing", "zone"]
        .iter()
        .any(|key| fields.contains_key(*key))
    {
        return Ok(());
    }
    let at = resolve_times(fields, None)?;
    fields.insert("starts".to_owned(), at.starts.into());
    if fields.contains_key("ends") {
        fields.insert("ends".to_owned(), at.ends.into());
    }
    fields.insert("timing".to_owned(), at.timing.as_str().into());
    fields.insert("zone".to_owned(), at.zone.into());
    Ok(())
}

/// What a refused save of an event keeps, in the form the vault holds it (`history.keep_version`):
/// the overlay's times (`event.starts`, `event.ends`, `event.timing`, `event.zone`) and alerts
/// (`event.reminders`) are stated as a source states them, so a wall clock and its zone become the
/// instant the row would hold and the alerts the one text of the column. A refused change to one day
/// is `occurrence`, an object stated as `event.edit_occurrence` states it (`original_start`, `scope`
/// and what the day changes), which becomes the row that command would have written. `Err` is a
/// sentence.
pub(crate) fn shape_overlay(
    connection: &rusqlite::Connection,
    id: &str,
    overlay: &mut serde_json::Map<String, Json>,
) -> std::result::Result<(), String> {
    const OWN: [&str; 4] = ["starts", "ends", "timing", "zone"];
    let mut stated = serde_json::Map::new();
    for name in OWN {
        if let Some(value) = overlay.remove(&format!("event.{name}")) {
            stated.insert(name.to_owned(), value);
        }
    }
    shape(&mut stated)?;
    for (name, value) in stated {
        overlay.insert(format!("event.{name}"), value);
    }
    if let Some(day) = overlay.get(crate::history::DAY).and_then(Json::as_object) {
        let row = day_row(connection, id, day)?;
        overlay.insert(crate::history::DAY.to_owned(), row);
    }
    Ok(())
}

/// The `occurrence` row `event.edit_occurrence` (`override`) writes for what `day` states: only
/// what was stated is the day's own, the rest is the series'.
pub(super) fn day_row(
    connection: &rusqlite::Connection,
    id: &str,
    day: &serde_json::Map<String, Json>,
) -> std::result::Result<Json, String> {
    let (Some(key), Some(scope)) = (
        day.get("original_start").and_then(Json::as_str),
        day.get("scope").and_then(Json::as_str),
    ) else {
        return Err(
            "`occurrence` names the day and whether it is the day or the days from it".into(),
        );
    };
    if !["occurrence", "future"].contains(&scope) {
        return Err("`occurrence` is one day or the days from it".to_owned());
    }
    let series =
        row_of(connection, id).map_err(|_| format!("there is nothing with the id `{id}`"))?;
    if series.rule.is_none() {
        return Err("That event does not repeat.".to_owned());
    }
    let times = day_times(day, &series.times)?;
    let said = |name: &str| day.get(name).and_then(Json::as_str);
    Ok(json!({
        "original_start": key, "scope": scope, "cancelled": 0,
        "starts": times.starts, "ends": times.ends,
        "timing": times.own.as_ref().map(|(timing, _)| timing.as_str()),
        "zone": times.own.as_ref().and_then(|(_, zone)| zone.as_deref()),
        "title": said("title"), "description": said("description"),
        "url": said("url"), "place_id": said("place_id"),
    }))
}

/// The alerts a source states (minutes before it starts) in the one form the statement keeps: a
/// JSON array, each minute once, smallest first. No alert is `null`.
fn alerts_canon(alerts: &Json) -> std::result::Result<Json, String> {
    let list = alerts_of(alerts)?;
    Ok(if list.is_empty() {
        Json::Null
    } else {
        json!(list)
    })
}

/// The minutes a statement of alerts names, each once, smallest first.
fn alerts_of(alerts: &Json) -> std::result::Result<Vec<i64>, String> {
    let list: Vec<i64> = match alerts {
        Json::Null => Vec::new(),
        // A statement read back from text.
        Json::String(text) => match serde_json::from_str::<Json>(text) {
            Ok(Json::Array(list)) => list.iter().filter_map(Json::as_i64).collect(),
            _ => return Err("reminders are minutes before the start".to_owned()),
        },
        Json::Array(list) => list
            .iter()
            .map(|minutes| {
                minutes
                    .as_i64()
                    .filter(|minutes| *minutes >= 0)
                    .ok_or_else(|| "reminders are minutes before the start".to_owned())
            })
            .collect::<std::result::Result<_, _>>()?,
        _ => return Err("reminders are minutes before the start".to_owned()),
    };
    Ok(list
        .into_iter()
        .collect::<BTreeSet<i64>>()
        .into_iter()
        .collect())
}

/// The alerts the vault holds, in the form a source states them (`null` for none).
pub(crate) fn reminders_read(connection: &Connection, id: &str) -> Result<Json> {
    let held = reminders_held(connection, id)?;
    Ok(if held.is_empty() {
        Json::Null
    } else {
        json!(held)
    })
}

pub(crate) fn reminders_canon(statement: &Json) -> Json {
    alerts_canon(statement).unwrap_or_else(|_| statement.clone())
}

/// A three-way merge of the alerts, judged whole: the source's new word replaces the vault's when
/// the member never changed them (they are what its last word implied).
pub(crate) fn reminders_merge(
    ctx: &CommandCtx<'_, '_>,
    id: &str,
    stated: Option<&Json>,
    new: &Json,
) -> Result<bool> {
    let connection = ctx.connection();
    let held = reminders_held(connection, id)?;
    let wanted = alerts_of(new).unwrap_or_default();
    if wanted == held {
        return Ok(false);
    }
    let ours = match stated {
        Some(said) => alerts_of(said).unwrap_or_default() == held,
        None => held.is_empty(),
    };
    if !ours {
        return Ok(false);
    }
    set_reminders(connection, id, &wanted)
}

/// Put the alerts back to what the source last stated.
pub(crate) fn reminders_take(
    ctx: &CommandCtx<'_, '_>,
    id: &str,
    _item: Option<&str>,
    stated: &Json,
) -> Result<bool> {
    set_reminders(ctx.connection(), id, &alerts_of(stated).unwrap_or_default())
}

// ---------------------------------------------------------------------------
// A series
// ---------------------------------------------------------------------------

/// The days a series has between two instants, in its own zone, as the rule
/// produced them.
pub(super) fn expand_series(
    times: &Times,
    rule: &str,
    from: &str,
    to: &str,
    at_most: usize,
) -> Vec<Occurrence> {
    let zone = times
        .zone
        .as_deref()
        .and_then(|name| FireZone::named(name).ok());
    let mut input = ExpandInput::new(rule, &times.starts, from, to)
        .with_semantics(times.timing)
        .at_most(at_most);
    input.zone = zone.as_ref();
    expand(&input)
}

/// The occurrence of the series the wall clock `original_start` names, or
/// `None` when the rule does not land there. The key is NOT an instant, so the
/// window comes from the shared adapter and the match is on `wall_start`.
pub(super) fn occurrence_at(times: &Times, rule: &str, original_start: &str) -> Option<Occurrence> {
    let (from, to) = search_window(original_start, SEARCH_WINDOW_DAYS)?;
    expand_series(times, rule, &from, &to, 16)
        .into_iter()
        .find(|occurrence| occurrence.wall_start == original_start)
}

/// The distinct keys the series' occurrence rows carry, in order.
pub(super) fn override_keys(connection: &Connection, id: &str) -> Result<Vec<String>> {
    Ok(connection
        .prepare("SELECT DISTINCT original_start FROM occurrence WHERE series_id = ?1 ORDER BY 1")?
        .query_map([id], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?)
}

/// The days the series produces over the span its `keys` cover, by series-local
/// wall clock; `None` when the span cannot be searched (the caller then treats
/// every key as stranded).
pub(super) fn live_days(times: &Times, rule: &str, keys: &[String]) -> Option<BTreeSet<String>> {
    let (first, last) = (keys.first()?, keys.last()?);
    let ((from, _), (_, to)) = (
        search_window(first, SEARCH_WINDOW_DAYS)?,
        search_window(last, SEARCH_WINDOW_DAYS)?,
    );
    Some(
        expand_series(times, rule, &from, &to, 2_000)
            .into_iter()
            .map(|occurrence| occurrence.wall_start)
            .collect(),
    )
}

/// How many of the series' occurrence rows match no day of the series as it is.
pub(super) fn stranded(
    connection: &Connection,
    id: &str,
    times: &Times,
    rule: Option<&str>,
) -> Result<usize> {
    let keys = override_keys(connection, id)?;
    if keys.is_empty() {
        return Ok(0);
    }
    let Some(live) = rule.and_then(|rule| live_days(times, rule, &keys)) else {
        return Ok(keys.len());
    };
    Ok(keys.iter().filter(|key| !live.contains(*key)).count())
}

/// A followed series whose rule or start moved: every override that no day of the
/// series lands on any more is **re-keyed** to the day the series now has on the
/// same date when there is exactly one (a standup moved from nine to ten keeps its
/// skipped week), and dropped otherwise, so the series never holds a row no
/// occurrence will read ([#1146](https://github.com/srikanth235/centraid/issues/1146)).
/// A series whose rule the expander cannot read is left as it is.
pub(super) fn rekey_stranded(connection: &Connection, id: &str) -> Result<()> {
    let keys = override_keys(connection, id)?;
    if keys.is_empty() {
        return Ok(());
    }
    let row = row_of(connection, id)?;
    let live = match row.rule.as_deref() {
        None => BTreeSet::new(),
        Some(rule) if rrule::inspect(rule).is_err() => return Ok(()),
        Some(rule) => live_days(&row.times, rule, &keys).unwrap_or_default(),
    };
    for key in keys.iter().filter(|key| !live.contains(*key)) {
        let date = key.get(..10).unwrap_or(key);
        let same_date: Vec<&String> = live
            .iter()
            .filter(|day| day.get(..10).unwrap_or(day) == date)
            .collect();
        match same_date.as_slice() {
            [target] => {
                // A day the target already has an override for keeps its own.
                connection.execute(
                    "UPDATE OR IGNORE occurrence SET original_start = ?3
                      WHERE series_id = ?1 AND original_start = ?2",
                    rusqlite::params![id, key, target],
                )?;
                connection.execute(
                    "DELETE FROM occurrence WHERE series_id = ?1 AND original_start = ?2",
                    [id, key],
                )?;
            }
            _ => {
                connection.execute(
                    "DELETE FROM occurrence WHERE series_id = ?1 AND original_start = ?2",
                    [id, key],
                )?;
            }
        }
    }
    Ok(())
}

pub(super) fn rule_refusal(rule: &str) -> Option<String> {
    rrule::inspect(rule)
        .err()
        .map(|refusal| format!("{rule}: {}", refusal.message()))
}
