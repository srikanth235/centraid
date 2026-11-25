//! What Calendar reads: a day, a week, a month, and what overlaps (D1, G3, L3).
//!
//! **One window, three entry points.** [`day`], [`week`] and [`month`] are [`window`] over one, seven
//! and a month's days, and each is a BOUNDED INDEX WALK, never a scan, whatever the vault holds:
//!
//! - the single events of each timing are one range seek of `event_by_start` (a zoned `starts` is
//!   an instant, a floating one a wall clock, an all-day one a date, so each form has its own
//!   range), looking back [`SHORT_DAYS`] for a short event that began before the window and still
//!   runs into it ([`SINGLES`]); an event that runs longer than a week (the `long` column) is not
//!   looked for by its start but on its own partial index `event_long` ([`LONG`]), so a
//!   semester-long event costs the window one more seek and nothing grows with the vault;
//! - the series are one walk of the partial index `event_by_rule` (every repeating event that began
//!   before the window ends), each expanded over the window by [`crate::time`] and given its one-day
//!   overrides by a range of the `occurrence` key; a day moved INTO the window from anywhere is one
//!   range of `occurrence_by_moved` ([`SERIES`], [`OVERRIDES`], [`MOVED`]);
//! - people's dates (G3: a birthday, an anniversary) are derived, never stored as events: one seek
//!   of `person_date_by_day` per day of the window ([`DATES`]).
//!
//! A day is the viewer's: the vault's zone unless a zone is named, so a zoned event is placed on the
//! day it is there; a floating or all-day one is on the day it says.
//!
//! An OVERLAP is something this module reports ([`overlaps`]), never something a command refuses
//! (L3): two busy timed events that share time.

use std::collections::BTreeSet;

use rusqlite::{Connection, OptionalExtension};

use crate::error::Result;
use crate::time::recurrence::{Semantics, parse_instant_ms};
use crate::time::zone::{
    FireZone, WallTime, add_wall_days, parse_wall_iso, wall_epoch, wall_from_epoch, wall_iso,
};

use super::times::{Times, day_key, day_start, epoch_ms, expand_series, moved_end};

/// The most days one window covers: a month grid of six weeks.
pub const MAX_WINDOW_DAYS: i64 = 42;

/// The most occurrences of one series a window expands.
const SERIES_AT_MOST: usize = 400;

/// How far before a window a short (not `long`) event's start can be and still run into it: a week
/// by the `long` column's own definition, and a day for the date it ends on.
const SHORT_DAYS: i64 = 8;

/// (Each statement joins with `CROSS JOIN`, which tells SQLite to keep the event or the date as the
/// outer loop: its index is the walk, and the entity row is one seek of its key.)
///
/// Single events of one timing, by start: a range of `event_by_start`. `?1`..`?2` is the range of
/// `starts` to look in (the window, and [`SHORT_DAYS`] before it), `?3` the timing, `?4` where an
/// event must still be running. Rows come in start order.
pub const SINGLES: &str = "SELECT v.id, e.title, e.parent_id, v.starts, v.ends, v.timing, v.zone,
        v.busy, v.status, v.location
   FROM event v CROSS JOIN entity e ON e.id = v.id
  WHERE v.starts >= ?1 AND v.starts < ?2 AND v.timing = ?3 AND v.rule IS NULL
    AND ifnull(v.ends, v.starts) >= ?4 AND e.deleted_at IS NULL
  ORDER BY v.starts, v.id";

/// The long events of one timing that run into a window: a range of the partial index `event_long`
/// (`?1` is where the window ends, `?2` where it begins, `?3` the timing).
pub const LONG: &str = "SELECT v.id, e.title, e.parent_id, v.starts, v.ends, v.timing, v.zone,
        v.busy, v.status, v.location
   FROM event v CROSS JOIN entity e ON e.id = v.id
  WHERE v.long = 1 AND v.starts < ?1 AND v.ends >= ?2 AND v.timing = ?3 AND v.rule IS NULL
    AND e.deleted_at IS NULL
  ORDER BY v.starts, v.id";

/// The series that began before `?1`: the partial index of repeating events, in start order.
pub const SERIES: &str = "SELECT v.id, e.title, e.parent_id, v.starts, v.ends, v.timing, v.zone,
        v.busy, v.status, v.location, v.rule, v.rule_supported
   FROM event v CROSS JOIN entity e ON e.id = v.id
  WHERE v.rule IS NOT NULL AND v.starts < ?1 AND e.deleted_at IS NULL
  ORDER BY v.starts, v.id";

/// One live series by its id (a seek of the key).
const SERIES_ONE: &str = "SELECT v.id, e.title, e.parent_id, v.starts, v.ends, v.timing, v.zone,
        v.busy, v.status, v.location, v.rule, v.rule_supported
   FROM event v CROSS JOIN entity e ON e.id = v.id
  WHERE v.id = ?1 AND v.rule IS NOT NULL AND e.deleted_at IS NULL";

/// One series' days that were changed, between two original starts: a range of the key.
pub const OVERRIDES: &str = "SELECT original_start, cancelled, starts, ends, timing, zone, title,
        location FROM occurrence
  WHERE series_id = ?1 AND original_start >= ?2 AND original_start < ?3
  ORDER BY original_start";

/// The days moved to start between `?1` and `?2`, whichever series and whatever day they were
/// moved from: a range of `occurrence_by_moved`.
pub const MOVED: &str = "SELECT series_id, original_start, cancelled, starts, ends, timing, zone,
        title, location FROM occurrence
  WHERE starts >= ?1 AND starts < ?2 AND cancelled = 0
  ORDER BY starts, series_id";

/// Whose date falls on a day, whatever the year or none: one seek of `person_date_by_day` (`?1` is
/// `MM-DD`).
pub const DATES: &str = "SELECT d.id, d.person_id, e.title, d.kind, d.label, d.date
   FROM person_date d CROSS JOIN entity e ON e.id = d.person_id
  WHERE substr(d.date, -5) = ?1 AND e.deleted_at IS NULL
  ORDER BY d.person_id";

/// What an appearance is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    /// An event, or one day of a series.
    Event,
    /// A date of a person (G3): derived, with no event behind it.
    PersonDate,
}

/// One thing on the calendar's window: an event, one day of a series, or a person's date.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Appearance {
    pub source: Source,
    /// The event's id, or the person date's id.
    pub id: String,
    /// The person, for a person's date.
    pub person_id: Option<String>,
    /// The series-local wall clock of this day of a series.
    pub original_start: Option<String>,
    pub title: String,
    /// As stored for its timing: an instant, a wall clock to the minute, or a date.
    pub starts: String,
    pub ends: Option<String>,
    pub timing: String,
    pub zone: Option<String>,
    /// The first day of the window it is on, `YYYY-MM-DD`, in the viewer's zone.
    pub day: String,
    /// The last day it is on (inclusive), which may be past the window.
    pub last_day: String,
    pub busy: bool,
    pub status: String,
    pub location: Option<String>,
    pub calendar_id: Option<String>,
    pub repeats: bool,
    /// A person's date: its kind (`birthday`...), its own label and the year it began, when it has one.
    pub date_kind: Option<String>,
    pub date_label: Option<String>,
    pub year: Option<i64>,
}

/// Two busy events that share time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Overlap {
    /// `(event id, series day)` of the one that starts first.
    pub first: (String, Option<String>),
    pub second: (String, Option<String>),
}

fn viewer(connection: &Connection, zone: Option<&str>) -> FireZone {
    let vault: Option<String> = connection
        .query_row("SELECT zone FROM vault", [], |row| row.get(0))
        .optional()
        .ok()
        .flatten()
        .flatten();
    FireZone::resolve(zone, vault.as_deref())
        .or_else(|_| FireZone::named("Etc/UTC"))
        .expect("UTC is a zone")
}

fn midnight(day: &str) -> Option<WallTime> {
    parse_wall_iso(day).map(|wall| WallTime {
        hour: 0,
        minute: 0,
        second: 0,
        millisecond: 0,
        ..wall
    })
}

/// `wall` as a bound in the form a timing stores: an instant in the viewer's zone for a zoned one,
/// a wall clock to the minute, a date.
fn bound(timing: Semantics, zone: &FireZone, wall: WallTime) -> String {
    match timing {
        Semantics::Zoned => zone.resolve_wall_time_forward(wall).instant,
        Semantics::Floating => wall_iso(wall, true).chars().take(16).collect(),
        Semantics::AllDay => wall_iso(wall, false),
    }
}

/// The day (`YYYY-MM-DD`) a stored time is on, for the viewer. `exclusive_end`: an end that is the
/// instant after the last moment (a timed event's) belongs to the day before when it is midnight.
fn day_of(timing: Semantics, zone: &FireZone, value: &str, exclusive_end: bool) -> Option<String> {
    match timing {
        Semantics::AllDay => Some(value.get(..10)?.to_owned()),
        Semantics::Floating => {
            let wall = parse_wall_iso(value)?;
            let wall = if exclusive_end {
                wall_from_epoch(wall_epoch(wall) - 1)
            } else {
                wall
            };
            Some(wall_iso(wall, false))
        }
        Semantics::Zoned => {
            let at = parse_instant_ms(value)? - i64::from(exclusive_end);
            Some(wall_iso(zone.zoned_parts(at), false))
        }
    }
}

/// The viewer-local wall clock of a start, to sort and compare by.
fn local_epoch(timing: Semantics, zone: &FireZone, value: &str) -> Option<i64> {
    match timing {
        Semantics::Zoned => Some(wall_epoch(zone.zoned_parts(parse_instant_ms(value)?))),
        _ => parse_wall_iso(value).map(wall_epoch),
    }
}

struct Frame<'a> {
    zone: &'a FireZone,
    /// First day of the window and the day after its last.
    from: WallTime,
    to: WallTime,
}

impl Frame<'_> {
    fn intersects(&self, timing: Semantics, starts: &str, ends: Option<&str>) -> Option<(String, String)> {
        let first = day_of(timing, self.zone, starts, false)?;
        let last = match ends {
            Some(ends) => day_of(timing, self.zone, ends, timing != Semantics::AllDay)?,
            None => first.clone(),
        };
        let last = if last < first { first.clone() } else { last };
        let (window_first, window_last) = (
            wall_iso(self.from, false),
            wall_iso(add_wall_days(self.to, -1), false),
        );
        (last >= window_first && first <= window_last)
            .then(|| (first.max(window_first), last))
    }
}

/// Everything on the calendar in `days` days from `from_day` (`YYYY-MM-DD`), in the viewer's zone
/// (the vault's own when none is named): single events, the days of each series with their
/// overrides, and people's dates; ordered by day, all-day first, then by the time on the clock.
///
/// # Errors
/// SQLite's refusal.
pub fn window(
    connection: &Connection,
    from_day: &str,
    days: i64,
    zone: Option<&str>,
) -> Result<Vec<Appearance>> {
    let days = days.clamp(1, MAX_WINDOW_DAYS);
    let Some(from) = midnight(from_day) else {
        return Ok(Vec::new());
    };
    let to = add_wall_days(from, days);
    let zone = viewer(connection, zone);
    let frame = Frame {
        zone: &zone,
        from,
        to,
    };
    let mut out = Vec::new();
    singles(connection, &frame, &mut out)?;
    series(connection, &frame, &mut out)?;
    dates(connection, &frame, days, &mut out)?;
    let key = |appearance: &Appearance| {
        let timing = Semantics::from_stored(Some(&appearance.timing));
        (
            appearance.day.clone(),
            timing != Semantics::AllDay,
            local_epoch(timing, &zone, &appearance.starts).unwrap_or_default(),
            appearance.id.clone(),
            appearance.original_start.clone(),
        )
    };
    out.sort_by_cached_key(key);
    Ok(out)
}

/// A day.
///
/// # Errors
/// SQLite's refusal.
pub fn day(connection: &Connection, day: &str, zone: Option<&str>) -> Result<Vec<Appearance>> {
    window(connection, day, 1, zone)
}

/// The week that holds `day`, from the weekday `week_starts` (0 Sunday … 6 Saturday).
///
/// # Errors
/// SQLite's refusal.
pub fn week(
    connection: &Connection,
    day: &str,
    week_starts: i64,
    zone: Option<&str>,
) -> Result<Vec<Appearance>> {
    let Some(wall) = midnight(day) else {
        return Ok(Vec::new());
    };
    let back = (crate::time::zone::wall_weekday(wall) - week_starts).rem_euclid(7);
    let first = wall_iso(add_wall_days(wall, -back), false);
    window(connection, &first, 7, zone)
}

/// The days of one month (`month` 1..=12).
///
/// # Errors
/// SQLite's refusal.
pub fn month(
    connection: &Connection,
    year: i64,
    month: i64,
    zone: Option<&str>,
) -> Result<Vec<Appearance>> {
    let first = format!("{year:04}-{month:02}-01");
    let Some(start) = midnight(&first) else {
        return Ok(Vec::new());
    };
    let next = if month >= 12 {
        format!("{:04}-01-01", year + 1)
    } else {
        format!("{year:04}-{:02}-01", month + 1)
    };
    let days = midnight(&next).map_or(30, |end| (wall_epoch(end) - wall_epoch(start)) / 86_400_000);
    window(connection, &first, days, zone)
}

type EventRow = (
    String,
    String,
    Option<String>,
    String,
    Option<String>,
    String,
    Option<String>,
    bool,
    String,
    Option<String>,
);

fn read_event(row: &rusqlite::Row<'_>) -> rusqlite::Result<EventRow> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
        row.get(7)?,
        row.get(8)?,
        row.get(9)?,
    ))
}

fn singles(connection: &Connection, frame: &Frame<'_>, out: &mut Vec<Appearance>) -> Result<()> {
    let mut short = connection.prepare_cached(SINGLES)?;
    let mut long = connection.prepare_cached(LONG)?;
    let mut seen = BTreeSet::new();
    for timing in [Semantics::Zoned, Semantics::Floating, Semantics::AllDay] {
        let (lo, hi, running) = (
            bound(timing, frame.zone, add_wall_days(frame.from, -SHORT_DAYS)),
            bound(timing, frame.zone, frame.to),
            bound(timing, frame.zone, frame.from),
        );
        let mut rows: Vec<EventRow> = short
            .query_map(
                rusqlite::params![lo, hi, timing.as_str(), running],
                read_event,
            )?
            .collect::<rusqlite::Result<_>>()?;
        rows.extend(
            long.query_map(rusqlite::params![hi, running, timing.as_str()], read_event)?
                .collect::<rusqlite::Result<Vec<_>>>()?,
        );
        for (id, title, calendar_id, starts, ends, timing_text, zone_name, busy, status, location) in
            rows
        {
            if !seen.insert(id.clone()) {
                continue;
            }
            let Some((day, last_day)) = frame.intersects(timing, &starts, ends.as_deref()) else {
                continue;
            };
            out.push(Appearance {
                source: Source::Event,
                id,
                person_id: None,
                original_start: None,
                title,
                starts,
                ends,
                timing: timing_text,
                zone: zone_name,
                day,
                last_day,
                busy,
                status,
                location,
                calendar_id,
                repeats: false,
                date_kind: None,
                date_label: None,
                year: None,
            });
        }
    }
    Ok(())
}

/// One day of a series that was changed.
struct Changed {
    cancelled: bool,
    starts: Option<String>,
    ends: Option<String>,
    timing: Option<String>,
    zone: Option<String>,
    title: Option<String>,
    location: Option<String>,
}

/// A repeating event, as the walk of `event_by_rule` reads it.
struct SeriesRow {
    id: String,
    title: String,
    calendar_id: Option<String>,
    starts: String,
    ends: Option<String>,
    timing: Semantics,
    zone: Option<String>,
    busy: bool,
    status: String,
    location: Option<String>,
    rule: String,
    supported: bool,
}

fn read_series(row: &rusqlite::Row<'_>) -> rusqlite::Result<SeriesRow> {
    let timing: String = row.get(5)?;
    Ok(SeriesRow {
        id: row.get(0)?,
        title: row.get(1)?,
        calendar_id: row.get(2)?,
        starts: row.get(3)?,
        ends: row.get(4)?,
        timing: Semantics::from_stored(Some(&timing)),
        zone: row.get(6)?,
        busy: row.get(7)?,
        status: row.get(8)?,
        location: row.get(9)?,
        rule: row.get(10)?,
        supported: row.get(11)?,
    })
}

/// One day of a series as it appears: the series' own times (`default_start`, the day the rule
/// produced) unless the day was moved, its words unless renamed. `None` when the day is skipped,
/// or is not on the window.
fn day_of_series(
    frame: &Frame<'_>,
    series: &SeriesRow,
    key: &str,
    default_start: Option<&str>,
    changed: Option<&Changed>,
) -> Option<Appearance> {
    let timing = series.timing;
    let mut day_timing = timing;
    let mut day_zone = series.zone.clone();
    let mut day_title = series.title.clone();
    let mut day_location = series.location.clone();
    let mut day_starts = default_start.map(str::to_owned);
    let mut day_ends = day_starts.as_deref().and_then(|start| {
        series
            .ends
            .as_deref()
            .map(|ends| moved_end(timing, &series.starts, ends, start))
    });
    if let Some(changed) = changed {
        if changed.cancelled {
            return None;
        }
        if let Some(word) = &changed.timing {
            day_timing = Semantics::from_stored(Some(word));
            day_zone.clone_from(&changed.zone);
        }
        if let Some(moved) = &changed.starts {
            day_starts = Some(moved.clone());
            day_ends = changed.ends.clone().or_else(|| {
                series
                    .ends
                    .as_deref()
                    .map(|ends| moved_end(day_timing, &series.starts, ends, moved))
            });
        } else if changed.ends.is_some() {
            day_ends.clone_from(&changed.ends);
        }
        if let Some(words) = &changed.title {
            day_title.clone_from(words);
        }
        if let Some(words) = &changed.location {
            day_location = Some(words.clone());
        }
    }
    let day_starts = day_starts?;
    let (first, last) = frame.intersects(day_timing, &day_starts, day_ends.as_deref())?;
    Some(Appearance {
        source: Source::Event,
        id: series.id.clone(),
        person_id: None,
        original_start: Some(key.to_owned()),
        title: day_title,
        starts: day_starts,
        ends: day_ends,
        timing: day_timing.as_str().to_owned(),
        zone: day_zone,
        day: first,
        last_day: last,
        busy: series.busy,
        status: series.status.clone(),
        location: day_location,
        calendar_id: series.calendar_id.clone(),
        repeats: true,
        date_kind: None,
        date_label: None,
        year: None,
    })
}

fn series(connection: &Connection, frame: &Frame<'_>, out: &mut Vec<Appearance>) -> Result<()> {
    // The loosest bound of the three forms: a row past it began after the window in every form.
    let end = [Semantics::Zoned, Semantics::Floating, Semantics::AllDay]
        .into_iter()
        .map(|timing| bound(timing, frame.zone, add_wall_days(frame.to, 1)))
        .max()
        .unwrap_or_default();
    let rows: Vec<SeriesRow> = connection
        .prepare_cached(SERIES)?
        .query_map([end], read_series)?
        .collect::<rusqlite::Result<_>>()?;
    let mut walked: BTreeSet<(String, String)> = BTreeSet::new();
    for row in &rows {
        let timing = row.timing;
        // A day that began before the window runs into it for as long as the series' own length.
        let length_days = row
            .ends
            .as_deref()
            .and_then(|ends| Some((epoch_ms(ends)? - epoch_ms(&row.starts)?) / 86_400_000))
            .unwrap_or(0);
        let (from, to) = (
            bound(timing, frame.zone, add_wall_days(frame.from, -(length_days + 2))),
            bound(timing, frame.zone, add_wall_days(frame.to, 1)),
        );
        let times = Times {
            starts: row.starts.clone(),
            ends: row.ends.clone(),
            timing,
            zone: row.zone.clone(),
        };
        // A rule the expander cannot read stands for its first day only.
        let days: Vec<(String, String)> = if row.supported {
            expand_series(&times, &row.rule, &from, &to, SERIES_AT_MOST)
                .into_iter()
                .map(|day| (day_key(timing, &day), day_start(timing, &day)))
                .collect()
        } else {
            vec![(row.starts.clone(), row.starts.clone())]
        };
        let changed = changed_days(connection, &row.id, &from, &to)?;
        for (key, start) in days {
            walked.insert((row.id.clone(), key.clone()));
            out.extend(day_of_series(frame, row, &key, Some(&start), changed.get(&key)));
        }
    }
    // A day moved into the window from a day outside what was expanded.
    let (lo, hi) = (
        [Semantics::Zoned, Semantics::Floating, Semantics::AllDay]
            .into_iter()
            .map(|timing| bound(timing, frame.zone, add_wall_days(frame.from, -SHORT_DAYS)))
            .min()
            .unwrap_or_default(),
        [Semantics::Zoned, Semantics::Floating, Semantics::AllDay]
            .into_iter()
            .map(|timing| bound(timing, frame.zone, add_wall_days(frame.to, 1)))
            .max()
            .unwrap_or_default(),
    );
    let moved: Vec<(String, String, Changed)> = connection
        .prepare_cached(MOVED)?
        .query_map([lo, hi], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                Changed {
                    cancelled: row.get(2)?,
                    starts: row.get(3)?,
                    ends: row.get(4)?,
                    timing: row.get(5)?,
                    zone: row.get(6)?,
                    title: row.get(7)?,
                    location: row.get(8)?,
                },
            ))
        })?
        .collect::<rusqlite::Result<_>>()?;
    for (series_id, key, changed) in moved {
        if walked.contains(&(series_id.clone(), key.clone())) {
            continue;
        }
        let one: Option<SeriesRow> = connection
            .prepare_cached(SERIES_ONE)?
            .query_row([&series_id], read_series)
            .optional()?;
        if let Some(row) = one.filter(|row| row.supported) {
            out.extend(day_of_series(frame, &row, &key, None, Some(&changed)));
        }
    }
    Ok(())
}

fn changed_days(
    connection: &Connection,
    id: &str,
    from_key: &str,
    to_key: &str,
) -> Result<std::collections::BTreeMap<String, Changed>> {
    let mut statement = connection.prepare_cached(OVERRIDES)?;
    let rows = statement.query_map(rusqlite::params![id, from_key, to_key], |row| {
        Ok((
            row.get::<_, String>(0)?,
            Changed {
                cancelled: row.get(1)?,
                starts: row.get(2)?,
                ends: row.get(3)?,
                timing: row.get(4)?,
                zone: row.get(5)?,
                title: row.get(6)?,
                location: row.get(7)?,
            },
        ))
    })?;
    rows.collect::<rusqlite::Result<_>>().map_err(Into::into)
}

fn is_leap(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn dates(
    connection: &Connection,
    frame: &Frame<'_>,
    days: i64,
    out: &mut Vec<Appearance>,
) -> Result<()> {
    let mut statement = connection.prepare_cached(DATES)?;
    for offset in 0..days {
        let wall = add_wall_days(frame.from, offset);
        let day = wall_iso(wall, false);
        let mut keys = vec![day[5..].to_owned()];
        // A 29 February with no 29 February this year falls on the 28th.
        if wall.month == 2 && wall.day == 28 && !is_leap(wall.year) {
            keys.push("02-29".to_owned());
        }
        for key in keys {
            let rows = statement.query_map([key], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, String>(5)?,
                ))
            })?;
            for row in rows {
                let (id, person, title, kind, label, date) = row?;
                // A date with a year began then; one yet to come is not shown before it.
                let year = (date.len() == 10)
                    .then(|| date[..4].parse::<i64>().ok())
                    .flatten();
                if year.is_some_and(|year| year > wall.year) {
                    continue;
                }
                out.push(Appearance {
                    source: Source::PersonDate,
                    id,
                    person_id: Some(person),
                    original_start: None,
                    title,
                    starts: day.clone(),
                    ends: None,
                    timing: Semantics::AllDay.as_str().to_owned(),
                    zone: None,
                    day: day.clone(),
                    last_day: day.clone(),
                    busy: false,
                    status: "confirmed".to_owned(),
                    location: None,
                    calendar_id: None,
                    repeats: true,
                    date_kind: Some(kind),
                    date_label: label,
                    year,
                });
            }
        }
    }
    Ok(())
}

/// The busy, timed events of the window that share time (L3): reported, never refused. An
/// all-day event, a free one and a cancelled one block nothing, so they are in no pair. A pair is
/// ordered by start.
///
/// # Errors
/// SQLite's refusal.
pub fn overlaps(
    connection: &Connection,
    from_day: &str,
    days: i64,
    zone: Option<&str>,
) -> Result<Vec<Overlap>> {
    let zone_of = viewer(connection, zone);
    let mut spans: Vec<(i64, i64, (String, Option<String>))> = Vec::new();
    for appearance in window(connection, from_day, days, zone)? {
        if appearance.source != Source::Event
            || !appearance.busy
            || appearance.status == "cancelled"
        {
            continue;
        }
        let timing = Semantics::from_stored(Some(&appearance.timing));
        if timing == Semantics::AllDay {
            continue;
        }
        let Some(start) = local_epoch(timing, &zone_of, &appearance.starts) else {
            continue;
        };
        let end = appearance
            .ends
            .as_deref()
            .and_then(|ends| local_epoch(timing, &zone_of, ends))
            .unwrap_or(start);
        spans.push((start, end, (appearance.id, appearance.original_start)));
    }
    spans.sort();
    let mut found = Vec::new();
    let mut seen = BTreeSet::new();
    for (j, later) in spans.iter().enumerate() {
        for earlier in &spans[..j] {
            if later.0 < earlier.1 && seen.insert((earlier.2.clone(), later.2.clone())) {
                found.push(Overlap {
                    first: earlier.2.clone(),
                    second: later.2.clone(),
                });
            }
        }
    }
    Ok(found)
}
