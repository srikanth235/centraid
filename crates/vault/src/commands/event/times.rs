//! Event timing, wall-clock resolution and recurrence expansion.

use std::collections::BTreeSet;

use rusqlite::Connection;
use serde_json::Value as Json;

use crate::commands::CommandCtx;
use crate::error::{Result, VaultError};
use crate::time::occurrence::{SEARCH_WINDOW_DAYS, search_window};
use crate::time::recurrence::{ExpandInput, Occurrence, Semantics, expand, parse_instant_ms};
use crate::time::zone::{FireZone, parse_wall_iso, wall_epoch};
use crate::time::{rrule, temporal};

use super::TIMINGS;

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
        Semantics::Floating => temporal::floating_minute(value)
            .ok_or_else(|| shape("a wall clock to the minute, YYYY-MM-DDTHH:MM")),
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
        // A start moved with no end said keeps the length it had.
        None => match base {
            Some(base) if base.timing == timing && base.zone == zone.as_ref().map(|z| z.name().to_owned()) && base.starts != starts => {
                base.ends.as_deref().map(|ends| moved_end(timing, &base.starts, ends, &starts))
            }
            Some(base) => base
                .ends
                .clone()
                .map(|value| resolve_one("ends", &value, timing, zone.as_ref()))
                .transpose()?,
            None => None,
        },
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

/// The key a day of a series has in `occurrence.original_start`, in the form the series' timing
/// holds (the table checks it): the resolved instant of a zoned series' day, the wall clock to the
/// minute of a floating one's, the date of an all-day one's. It names the DAY the rule produced,
/// never where a change moved it.
pub(super) fn day_key(timing: Semantics, day: &Occurrence) -> String {
    match timing {
        Semantics::Zoned => day.original_start.clone(),
        Semantics::Floating => day.wall_start.chars().take(16).collect(),
        Semantics::AllDay => day.wall_start.chars().take(10).collect(),
    }
}

/// Where a day of the series starts, in the form its timing holds (a floating clock to the minute).
pub(super) fn day_start(timing: Semantics, day: &Occurrence) -> String {
    match timing {
        Semantics::Zoned => day.start.clone(),
        Semantics::Floating => day.start.chars().take(16).collect(),
        Semantics::AllDay => day.start.chars().take(10).collect(),
    }
}

/// The day of the series that `original_start` (a [`day_key`]) names, or `None` when the rule does
/// not land there. The key is searched for in a window around it, the way an instant of another
/// zone is.
pub(super) fn occurrence_at(times: &Times, rule: &str, original_start: &str) -> Option<Occurrence> {
    let (from, to) = search_window(original_start, SEARCH_WINDOW_DAYS)?;
    expand_series(times, rule, &from, &to, 16)
        .into_iter()
        .find(|occurrence| day_key(times.timing, occurrence) == original_start)
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
            .map(|occurrence| day_key(times.timing, &occurrence))
            .collect(),
    )
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

// ---------------------------------------------------------------------------
// How long, and how far
// ---------------------------------------------------------------------------

/// A time of any of the three forms as milliseconds on one line: an instant as it is, a wall
/// clock or a date as if it were UTC. Comparing two of the SAME form is exact; across forms it is
/// the few hours' error a size bound can ignore.
pub(super) fn epoch_ms(value: &str) -> Option<i64> {
    if crate::time::has_zone_designator(value) {
        return parse_instant_ms(value);
    }
    parse_wall_iso(value).map(wall_epoch)
}

/// `ends` carried to a start that moved: the same length after the new start, in the form the
/// timing keeps (a floating clock to the minute).
pub(super) fn moved_end(timing: Semantics, was_starts: &str, was_ends: &str, starts: &str) -> String {
    let (Some(a), Some(b), Some(c)) = (epoch_ms(was_starts), epoch_ms(was_ends), epoch_ms(starts))
    else {
        return was_ends.to_owned();
    };
    let _ = c;
    let moved = crate::time::recurrence::shift_temporal(starts, b - a);
    if timing == Semantics::Floating {
        moved.chars().take(16).collect()
    } else {
        moved
    }
}
