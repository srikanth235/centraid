//! What a followed calendar's events add to the engine: how a record reads (`shape`), what a row
//! derives from it (`settle`), and the fields that are rows of their own: a series' one-day
//! overrides (`overrides`) and an event's alerts (`reminders`). The guests are `guests.rs`.

use std::collections::BTreeSet;

use rusqlite::{Connection, OptionalExtension};
use serde_json::{Value as Json, json};

use crate::commands::{CommandCtx, reminder};
use crate::error::Result;
use crate::time::recurrence::Semantics;
use crate::time::rrule;
use crate::time::zone::FireZone;

use super::reminders_held;
use super::times::{
    Times, day_key, expand_series, parse_timing, rekey_stranded, resolve_one, resolve_times, row_of,
};

// ---------------------------------------------------------------------------
// The follower's `settle`, and its `overrides`
// ---------------------------------------------------------------------------

/// What a followed event derives from what its source stated: whether its rule
/// is one the expander can expand. A source states the rule; it does not know
/// the engine.
pub(crate) fn settle(ctx: &CommandCtx<'_, '_>, id: &str) -> Result<()> {
    let rule: Option<String> = ctx
        .connection()
        .query_row("SELECT rule FROM event WHERE id = ?1", [id], |row| {
            row.get(0)
        })
        .optional()?
        .flatten();
    ctx.connection().execute(
        "UPDATE event SET rule_supported = ?2 WHERE id = ?1",
        rusqlite::params![id, rule.is_none_or(|rule| rrule::inspect(&rule).is_ok())],
    )?;
    // The rule or the start may have moved: no day is left that nothing reads.
    rekey_stranded(ctx.connection(), id)
}

/// What happened to one day of a series, as the row holds it.
#[derive(Debug, Clone)]
struct Day {
    cancelled: bool,
    starts: Option<String>,
    ends: Option<String>,
    /// How the day reads when it is not as its series does, and the zone of a zoned one.
    timing: Option<String>,
    zone: Option<String>,
    title: Option<String>,
    description: Option<String>,
    url: Option<String>,
    /// The day's own words for where (free text: a phone's location never becomes a place, D5).
    location: Option<String>,
}

impl PartialEq for Day {
    fn eq(&self, other: &Self) -> bool {
        let place = |day: &Self| day.location.as_deref().map(|name| name.trim().to_lowercase());
        (
            self.cancelled,
            &self.starts,
            &self.ends,
            &self.timing,
            &self.zone,
        ) == (
            other.cancelled,
            &other.starts,
            &other.ends,
            &other.timing,
            &other.zone,
        ) && (&self.title, &self.description, &self.url)
            == (&other.title, &other.description, &other.url)
            && place(self) == place(other)
    }
}

impl Eq for Day {}

/// What a source's `overrides` field says: over the window `from`..`to` (UTC
/// instants) it showed these days of the series as the rule has them (`shown`,
/// by the series-local wall clock), and these as moved or renamed (`moved`). A
/// day of the window the rule produces and the source showed neither way was
/// skipped there. The phone has no rule engine, so it states what it SEES and
/// the vault, which has one, works out what that means.
struct Observed {
    from: String,
    to: String,
    shown: BTreeSet<String>,
    moved: Vec<Json>,
}

/// A day the phone names, by its wall clock to the minute (a phone says `…T09:00:00`; a day is
/// found by what it says to the minute) or its date.
fn phone_key(key: &str) -> String {
    key.chars().take(16).collect()
}

fn observed(statement: &Json) -> Option<Observed> {
    let text = |key: &str| statement.get(key)?.as_str().map(str::to_owned);
    let list = |key: &str| statement.get(key).and_then(Json::as_array).cloned();
    Some(Observed {
        from: text("from")?,
        to: text("to")?,
        shown: list("shown")?
            .iter()
            .filter_map(|key| key.as_str().map(phone_key))
            .collect(),
        moved: list("moved").unwrap_or_default(),
    })
}

/// The days of the window the rule produces, and what became of each as the
/// statement says: the rows a source that said it would have left.
struct Derived {
    window: BTreeSet<String>,
    rows: std::collections::BTreeMap<String, Day>,
}

fn derive(connection: &Connection, id: &str, said: &Observed) -> Result<Derived> {
    let (times, rule, title, description, url, location): (
        Times,
        Option<String>,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
    ) = {
        let row = row_of(connection, id)?;
        let (title, description, url, location) = connection.query_row(
            "SELECT e.title, v.description, v.url, v.location FROM event v JOIN entity e ON e.id = v.id
              WHERE v.id = ?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
        (row.times, row.rule, title, description, url, location)
    };
    let mut derived = Derived {
        window: BTreeSet::new(),
        rows: std::collections::BTreeMap::new(),
    };
    let Some(rule) = rule.filter(|rule| rrule::inspect(rule).is_ok()) else {
        return Ok(derived);
    };
    let moved: std::collections::BTreeMap<String, &Json> = said
        .moved
        .iter()
        .filter_map(|day| Some((phone_key(day.get("original_start")?.as_str()?), day)))
        .collect();
    for occurrence in expand_series(&times, &rule, &said.from, &said.to, 2_000) {
        // The phone names a day by the series' wall clock; the vault keys it as its timing says.
        let wall = phone_key(&occurrence.wall_start);
        let key = day_key(times.timing, &occurrence);
        derived.window.insert(key.clone());
        let day = if let Some(day) = moved.get(&wall) {
            let text = |name: &str, own: Option<&str>| {
                let said = day
                    .get(name)
                    .and_then(Json::as_str)
                    .filter(|text| !text.is_empty());
                said.filter(|said| Some(*said) != own).map(str::to_owned)
            };
            let text_of = |name: &str| day.get(name).and_then(Json::as_str);
            // The day's own timing, when the phone says one that is not its series'.
            let timing = text_of("timing")
                .and_then(parse_timing)
                .unwrap_or(times.timing);
            let day_zone = if timing == Semantics::Zoned {
                text_of("zone")
                    .map(str::to_owned)
                    .or_else(|| times.zone.clone())
            } else {
                None
            };
            let own =
                timing != times.timing || (timing == Semantics::Zoned && day_zone != times.zone);
            let zone = day_zone
                .as_deref()
                .and_then(|name| FireZone::named(name).ok());
            let at = |value: Option<&str>| {
                value.and_then(|value| resolve_one("starts", value, timing, zone.as_ref()).ok())
            };
            let starts = at(text_of("starts")).filter(|starts| own || *starts != occurrence.start);
            Day {
                cancelled: false,
                ends: starts.as_ref().and_then(|_| at(text_of("ends"))),
                starts,
                timing: own.then(|| timing.as_str().to_owned()),
                zone: day_zone.filter(|_| own && timing == Semantics::Zoned),
                title: text("title", Some(&title)),
                description: text("description", description.as_deref()),
                url: text("url", url.as_deref()),
                location: text("location", location.as_deref()),
            }
        } else if said.shown.contains(&wall) {
            continue;
        } else {
            Day {
                cancelled: true,
                starts: None,
                ends: None,
                timing: None,
                zone: None,
                title: None,
                description: None,
                url: None,
                location: None,
            }
        };
        // A day the phone calls moved and says nothing different of is the series' own.
        if day.starts.is_some()
            || day.cancelled
            || day.title.is_some()
            || day.description.is_some()
            || day.url.is_some()
            || day.location.is_some()
        {
            derived.rows.insert(key, day);
        }
    }
    Ok(derived)
}

/// The rows an event's days hold now, by series-local wall clock.
fn held(connection: &Connection, id: &str) -> Result<std::collections::BTreeMap<String, Day>> {
    connection
        .prepare(
            "SELECT original_start, cancelled, starts, ends, timing, zone, title, description, url,
                    location
               FROM occurrence WHERE series_id = ?1",
        )?
        .query_map([id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                Day {
                    cancelled: row.get(1)?,
                    starts: row.get(2)?,
                    ends: row.get(3)?,
                    timing: row.get(4)?,
                    zone: row.get(5)?,
                    title: row.get(6)?,
                    description: row.get(7)?,
                    url: row.get(8)?,
                    location: row.get(9)?,
                },
            ))
        })?
        .collect::<rusqlite::Result<_>>()
        .map_err(Into::into)
}

/// The statement a source made last, when the vault's rows are still what it
/// implies; otherwise the rows as they stand, which is a different thing. So an
/// untouched series reads as what its source said, and one whose days the
/// member changed reads as edited.
pub(crate) fn overrides_read(connection: &Connection, id: &str) -> Result<Json> {
    let said: Option<Json> = connection
        .query_row(
            "SELECT stated FROM source WHERE entity_id = ?1 AND origin_id IN
               (SELECT id FROM origin WHERE retired_at IS NULL)",
            [id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .and_then(|stated| serde_json::from_str::<Json>(&stated).ok())
        .and_then(|stated| stated.get("overrides").cloned());
    let Some(said) = said.filter(|said| !said.is_null()) else {
        return Ok(Json::Null);
    };
    let Some(seen) = observed(&said) else {
        return Ok(said);
    };
    let (derived, rows) = (derive(connection, id, &seen)?, held(connection, id)?);
    let inside = |rows: &std::collections::BTreeMap<String, Day>| -> Vec<(String, Day)> {
        rows.iter()
            .filter(|(key, _)| derived.window.contains(*key))
            .map(|(key, day)| (key.clone(), day.clone()))
            .collect()
    };
    Ok(if inside(&derived.rows) == inside(&rows) {
        said
    } else {
        json!({ "held": inside(&rows).iter().map(|(key, day)| json!([key, day.cancelled, day.starts, day.title, day.timing, day.url, day.location])).collect::<Vec<_>>() })
    })
}

pub(crate) fn overrides_canon(statement: &Json) -> Json {
    statement.clone()
}

/// Make one day of a series what the rule and a statement imply (`None`: no row of its own).
fn write_day(ctx: &CommandCtx<'_, '_>, id: &str, key: &str, wanted: Option<&Day>) -> Result<()> {
    let connection = ctx.connection();
    match wanted {
        None => {
            connection.execute(
                "DELETE FROM occurrence WHERE series_id = ?1 AND original_start = ?2",
                [id, key],
            )?;
        }
        Some(day) => {
            connection.execute(
                "INSERT INTO occurrence (series_id, series_timing, original_start, cancelled,
                                         starts, ends, timing, zone, title, description, url,
                                         location)
                 SELECT ?1, timing, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11
                   FROM event WHERE id = ?1
                 ON CONFLICT (series_id, original_start)
                 DO UPDATE SET cancelled = ?3, starts = ?4, ends = ?5, timing = ?6, zone = ?7,
                               title = ?8, description = ?9, url = ?10, location = ?11",
                rusqlite::params![
                    id,
                    key,
                    day.cancelled,
                    day.starts,
                    day.ends,
                    day.timing,
                    day.zone,
                    day.title,
                    day.description,
                    day.url,
                    day.location
                ],
            )?;
        }
    }
    Ok(())
}

/// Put a series' days back to what its source's statement implies, every day of the window the
/// statement covers: the member's skips and changes there are undone. Returns whether a day changed.
pub(crate) fn overrides_take(
    ctx: &CommandCtx<'_, '_>,
    id: &str,
    _item: Option<&str>,
    stated: &Json,
) -> Result<bool> {
    let connection = ctx.connection();
    let Some(said) = observed(stated) else {
        return Ok(false);
    };
    let (after, rows) = (derive(connection, id, &said)?, held(connection, id)?);
    let mut changed = false;
    for key in &after.window {
        let wanted = after.rows.get(key);
        if wanted != rows.get(key) {
            write_day(ctx, id, key, wanted)?;
            changed = true;
        }
    }
    Ok(changed)
}

/// A three-way merge of a series' days: for each day of the window the rule
/// produces, the source's new word replaces the vault's row when the member
/// never changed it (the vault's row is what the source's last word implied),
/// and otherwise the member's stands. `stated` is what the source said last,
/// `None` when it has not spoken for this series before (then it only adds).
/// A day outside the window is not judged: the window slides a day at a time
/// and a skip that left it has not been undone.
pub(crate) fn overrides_merge(
    ctx: &CommandCtx<'_, '_>,
    id: &str,
    stated: Option<&Json>,
    new: &Json,
) -> Result<bool> {
    let connection = ctx.connection();
    let Some(now) = observed(new) else {
        return Ok(false);
    };
    let (after, rows) = (derive(connection, id, &now)?, held(connection, id)?);
    let before = stated
        .and_then(observed)
        .map(|said| derive(connection, id, &said))
        .transpose()?;
    let mut changed = false;
    for key in &after.window {
        let (wanted, have) = (after.rows.get(key), rows.get(key));
        if wanted == have {
            continue;
        }
        let ours = match &before {
            Some(before) if before.window.contains(key) => have == before.rows.get(key),
            _ => have.is_none(),
        };
        if !ours {
            continue;
        }
        write_day(ctx, id, key, wanted)?;
        changed = true;
    }
    Ok(changed)
}

// ---------------------------------------------------------------------------
// How a record reads, and the alerts
// ---------------------------------------------------------------------------

/// What a followed calendar states of an event, in the form the vault holds it: a wall clock and
/// its zone become the instant, a floating time loses a zero second, so the statement a source
/// makes and the row it leaves compare equal. The alerts it states are minutes before, one form.
/// The keys `starts` and `reminders` stay what `alerts.rs` reads to alert once per real thing.
pub(crate) fn shape(
    _: &CommandCtx<'_, '_>,
    fields: &mut serde_json::Map<String, Json>,
) -> std::result::Result<(), String> {
    if let Some(alerts) = fields.get("reminders") {
        let alerts = alerts_canon(alerts)?;
        fields.insert("reminders".to_owned(), alerts);
    }
    // A phone has no place of the member's: what it writes for where is words.
    if let Some(Json::String(words)) = fields.get("location")
        && words.trim().is_empty()
    {
        fields.insert("location".to_owned(), Json::Null);
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
    let held = reminders_held(ctx.connection(), id)?;
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
    reminder::set_leads(ctx, id, &wanted)
}

/// Put the alerts back to what the source last stated.
pub(crate) fn reminders_take(
    ctx: &CommandCtx<'_, '_>,
    id: &str,
    _item: Option<&str>,
    stated: &Json,
) -> Result<bool> {
    reminder::set_leads(ctx, id, &alerts_of(stated).unwrap_or_default())
}
