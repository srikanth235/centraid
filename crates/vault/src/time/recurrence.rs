//! THE EXPANDER — civil-time recurrence, and the DST policy it shares with
//! cron (#1020, D-1020-S1, D-1020-S2).
//!
//! One rule and no second engine anywhere. What the expansion guarantees:
//!
//! - **A zoned rule keeps its WALL CLOCK through an offset change.** A 09:00
//!   series is a 09:00 series on both sides of a DST boundary, because every
//!   step is civil arithmetic ([`super::zone::add_wall_days`],
//!   [`super::zone::add_wall_months`]) and the instant is resolved once, at
//!   the end.
//! - **A gap is skipped and a fold occurs once, at the earlier instant**
//!   ([`super::zone::FireZone::resolve_wall_time`]).
//! - **A refused rule expands to NO occurrences** — never to a plausible
//!   series that means something else ([`super::rrule`]).
//! - **An exception keys off the unmodified original occurrence**: the
//!   SERIES-LOCAL WALL CLOCK, never the resolved instant. Keying on the
//!   instant is drift ONT-25 — a skip written by
//!   `schedule.edit_event_occurrence` matched no occurrence at all and the
//!   skipped day came back, on the web agenda and on the phone, silently.
//! - **A BARE DATE IS A WHOLE DAY, NOT A MIDNIGHT** (#1090). A task whose
//!   anchor is `2026-03-01` recurs on civil days: its occurrences are dates,
//!   the same in every zone, and [`next_occurrence`] / [`collapse_missed`]
//!   answer dates. Read as the UTC midnight `parse_instant_ms` would make of
//!   it, each period was "missed" at 00:00Z and the next one fell on the
//!   previous evening anywhere west of Greenwich — a daily task left Today at
//!   20:00 in New York. Such a series has no zone of its own, so `zone` names
//!   the calendar `now` (or a completion) is read on: the member's.

use super::rrule::{self, DAY_TOKENS, Freq, MonthlyPin, ParsedRrule};
use super::temporal;
use super::zone::{
    FireZone, WallTime, add_wall_days, add_wall_months, days_in_month, parse_wall_iso, wall_epoch,
    wall_from_epoch, wall_iso, wall_weekday,
};

/// Which reading a series' own times are under.
///
/// `core_event.recurrence_semantics` and
/// `schedule_recurrence_exception.recurrence_semantics` hold exactly these
/// three, and a CHECK constraint keeps them to it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Semantics {
    /// A real instant expanded in the series' own zone. `dtstart` ends in `Z`
    /// and `start_tz` is `NOT NULL` — the schema's own CHECK.
    #[default]
    Zoned,
    /// A wall clock with no zone: 09:00 wherever the member is.
    Floating,
    /// A whole day.
    AllDay,
}

impl Semantics {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Zoned => "zoned",
            Self::Floating => "floating",
            Self::AllDay => "all-day",
        }
    }

    /// The stored spelling, read leniently: v0's `semanticsOf` treats anything
    /// that is not `floating` or `all-day` as `zoned`, and a row written
    /// before the CHECK existed must still read as something.
    #[must_use]
    pub fn from_stored(value: Option<&str>) -> Self {
        match value {
            Some("floating") => Self::Floating,
            Some("all-day") => Self::AllDay,
            _ => Self::Zoned,
        }
    }
}

/// One occurrence of a series.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Occurrence {
    /// The occurrence as the rule produced it, before any override. For a
    /// zoned series this is the resolved instant.
    pub original_start: String,
    /// Where the occurrence actually starts — the same as `original_start`
    /// until [`apply_exceptions`] moves it.
    pub start: String,
    /// **THE OCCURRENCE'S OWN IDENTITY**: the series-local wall clock. This is
    /// what `schedule_recurrence_exception.original_start_local` holds and
    /// what every matcher compares (#996 R21).
    pub wall_start: String,
    /// The autumn fold: this wall clock exists at two instants and the earlier
    /// one was taken.
    pub overlap: bool,
}

/// What [`expand`] is asked.
#[derive(Debug, Clone)]
pub struct ExpandInput<'a> {
    pub rrule: &'a str,
    /// The series' anchor — `core_event.dtstart`, `schedule_task.due_at`.
    pub start: &'a str,
    pub range_from: &'a str,
    pub range_to: &'a str,
    /// The series' own zone. Required for [`Semantics::Zoned`]; ignored
    /// otherwise. **This is the caller's tier-1 zone**, resolved through
    /// [`FireZone`] so there is no second reader.
    pub zone: Option<&'a FireZone>,
    pub semantics: Semantics,
    /// v0's default is 366.
    pub max_instances: usize,
}

impl<'a> ExpandInput<'a> {
    /// A zoned expansion over `[range_from, range_to)`, with v0's default
    /// ceiling.
    #[must_use]
    pub const fn new(
        rrule: &'a str,
        start: &'a str,
        range_from: &'a str,
        range_to: &'a str,
    ) -> Self {
        Self {
            rrule,
            start,
            range_from,
            range_to,
            zone: None,
            semantics: Semantics::Zoned,
            max_instances: DEFAULT_MAX_INSTANCES,
        }
    }

    #[must_use]
    pub const fn in_zone(mut self, zone: &'a FireZone) -> Self {
        self.zone = Some(zone);
        self
    }

    #[must_use]
    pub const fn with_semantics(mut self, semantics: Semantics) -> Self {
        self.semantics = semantics;
        self
    }

    #[must_use]
    pub const fn at_most(mut self, max_instances: usize) -> Self {
        self.max_instances = max_instances;
        self
    }
}

/// v0's `maxInstances ?? 366`.
pub const DEFAULT_MAX_INSTANCES: usize = 366;
/// v0's hard ceiling on the same field: `Math.min(…, 10_000)`.
pub const ABSOLUTE_MAX_INSTANCES: usize = 10_000;

/// An instant as `Date.parse` reads one, in milliseconds.
///
/// Accepts `YYYY-MM-DD`, `YYYY-MM-DDTHH:MM[:SS[.fff]]` with an optional `Z` or
/// `±HH:MM`. **A datetime with no zone reads as UTC**, which is what v0's
/// `Date.parse` does on a host running UTC — and every host that runs this
/// tree is one, by the ruling that deleted the host-local tier.
#[must_use]
pub fn parse_instant_ms(value: &str) -> Option<i64> {
    let bytes = value.as_bytes();
    if bytes.len() == 10 {
        let wall = parse_wall_iso(value)?;
        return Some(wall_epoch(wall));
    }
    if bytes.len() < 16 || bytes[10] != b'T' {
        return None;
    }
    // Split the zone designator off the tail, then read the civil half.
    let (civil, offset_ms) = match value.rfind(['Z', '+']) {
        Some(index) if bytes[index] == b'Z' && index > 10 => (&value[..index], 0),
        Some(index) if bytes[index] == b'+' && index > 10 => {
            (&value[..index], -offset_minutes(&value[index..])? * 60_000)
        }
        _ => match value.rfind('-') {
            // A negative offset's `-` is after the `T`; the date's two are not.
            Some(index) if index > 10 => {
                (&value[..index], -offset_minutes(&value[index..])? * 60_000)
            }
            _ => (value, 0),
        },
    };
    let wall = parse_wall_iso(civil)?;
    Some(wall_epoch(wall) + offset_ms)
}

/// `+HH:MM` / `-HH:MM` as signed minutes.
fn offset_minutes(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    if bytes.len() != 6 || bytes[3] != b':' {
        return None;
    }
    let hours: i64 = text.get(1..3)?.parse().ok()?;
    let minutes: i64 = text.get(4..6)?.parse().ok()?;
    let magnitude = hours * 60 + minutes;
    Some(if bytes[0] == b'-' {
        -magnitude
    } else {
        magnitude
    })
}

/// v0's `parseBasicInstant`: an extended instant, or ICS basic format
/// (`20260301T000000Z`), which is the shape `UNTIL` arrives in.
#[must_use]
pub fn parse_basic_instant(value: &str) -> Option<i64> {
    if let Some(millis) = parse_instant_ms(value) {
        return Some(millis);
    }
    let body = value.strip_suffix('Z').unwrap_or(value);
    let bytes = body.as_bytes();
    if bytes.len() != 8 && bytes.len() != 15 {
        return None;
    }
    if bytes.len() == 15 && bytes[8] != b'T' {
        return None;
    }
    if !bytes
        .iter()
        .enumerate()
        .all(|(index, byte)| index == 8 || byte.is_ascii_digit())
    {
        return None;
    }
    let year: i64 = body.get(0..4)?.parse().ok()?;
    let month: i64 = body.get(4..6)?.parse().ok()?;
    let day: i64 = body.get(6..8)?.parse().ok()?;
    let (hour, minute, second) = if bytes.len() == 15 {
        (
            body.get(9..11)?.parse().ok()?,
            body.get(11..13)?.parse().ok()?,
            body.get(13..15)?.parse().ok()?,
        )
    } else {
        (0, 0, 0)
    };
    Some(wall_epoch(WallTime {
        year,
        month,
        day,
        hour,
        minute,
        second,
        millisecond: 0,
    }))
}

/// The series anchor as a wall clock. A zoned anchor is an instant READ IN THE
/// SERIES' ZONE; a floating or all-day anchor already is one.
fn start_wall(start: &str, semantics: Semantics, zone: Option<&FireZone>) -> Option<WallTime> {
    if semantics == Semantics::Zoned {
        let instant = parse_instant_ms(start)?;
        return Some(zone?.zoned_parts(instant));
    }
    parse_wall_iso(start)
}

/// The value a range bound and an occurrence are compared on. For a zoned
/// series that is an instant; otherwise it is the wall epoch, so a floating
/// series is never re-read through anybody's zone.
fn instant_for_comparison(value: &str, semantics: Semantics) -> Option<i64> {
    if semantics == Semantics::Zoned {
        return parse_instant_ms(value);
    }
    parse_wall_iso(value).map(wall_epoch)
}

fn step_anchor(initial: WallTime, rule: &ParsedRrule, index: i64) -> WallTime {
    match rule.freq {
        Freq::Daily => add_wall_days(initial, index * rule.interval),
        Freq::Weekly => add_wall_days(initial, index * 7 * rule.interval),
        Freq::Monthly => add_wall_months(initial, index * rule.interval),
        Freq::Yearly => add_wall_months(initial, index * 12 * rule.interval),
    }
}

/// The BYDAY members of one week, in civil order. The week's anchor is its
/// SUNDAY, which is what makes `WKST` refusable rather than implementable
/// ([`super::rrule`]).
fn weekly_candidates(initial: WallTime, rule: &ParsedRrule, week_index: i64) -> Vec<WallTime> {
    let anchor = add_wall_days(
        initial,
        week_index * 7 * rule.interval - wall_weekday(initial),
    );
    let mut walls: Vec<WallTime> = rule
        .by_day
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .filter_map(|day| {
            DAY_TOKENS
                .iter()
                .position(|token| token == day)
                .map(|offset| add_wall_days(anchor, offset as i64))
        })
        .collect();
    walls.sort_by_key(|wall| wall_epoch(*wall));
    walls
}

/// The ONE candidate of a MONTHLY rule pinned to a day (#1119, R-1119-1) in
/// the month `period` steps from the anchor — or none, because **that month
/// has no such day** (RFC 5545: the 31st of February is skipped, not clamped).
/// It carries the anchor's wall clock, like every other candidate.
fn monthly_candidates(
    initial: WallTime,
    rule: &ParsedRrule,
    pin: MonthlyPin,
    period: i64,
) -> Vec<WallTime> {
    let month = add_wall_months(initial, period * rule.interval);
    let length = days_in_month(month.year, month.month);
    let day = match pin {
        MonthlyPin::MonthDay(-1) => length,
        MonthlyPin::MonthDay(day) => day,
        MonthlyPin::NthWeekday { ordinal, day } => {
            let Some(target) = DAY_TOKENS.iter().position(|token| *token == day) else {
                return Vec::new();
            };
            let target = target as i64;
            if ordinal > 0 {
                let first = wall_weekday(WallTime { day: 1, ..month });
                1 + (target - first).rem_euclid(7) + 7 * (ordinal - 1)
            } else {
                let last = wall_weekday(WallTime {
                    day: length,
                    ..month
                });
                length - (last - target).rem_euclid(7)
            }
        }
    };
    if (1..=length).contains(&day) {
        vec![WallTime { day, ..month }]
    } else {
        Vec::new()
    }
}

fn resolve_candidate(
    wall: WallTime,
    semantics: Semantics,
    zone: Option<&FireZone>,
) -> Option<Occurrence> {
    let wall_start = wall_iso(wall, semantics != Semantics::AllDay);
    if semantics == Semantics::Zoned {
        let resolved = zone?.resolve_wall_time(wall)?;
        return Some(Occurrence {
            original_start: resolved.instant.clone(),
            start: resolved.instant,
            wall_start,
            overlap: resolved.overlap,
        });
    }
    Some(Occurrence {
        original_start: wall_start.clone(),
        start: wall_start.clone(),
        wall_start,
        overlap: false,
    })
}

fn within_until(occurrence: &Occurrence, rule: &ParsedRrule, semantics: Semantics) -> bool {
    let Some(until) = rule.until.as_deref() else {
        return true;
    };
    let Some(until_ms) = parse_basic_instant(until) else {
        return true;
    };
    instant_for_comparison(&occurrence.start, semantics).is_none_or(|value| value <= until_ms)
}

/// Smallest period index whose candidates can land on or after `from_ms`.
/// Overshoots by at most one interval so the subsequent walk still applies
/// BYDAY / UNTIL / COUNT exactly.
fn first_period_at_or_after(
    initial: WallTime,
    rule: &ParsedRrule,
    from_ms: i64,
    semantics: Semantics,
) -> i64 {
    let anchor_ms = wall_epoch(initial);
    if from_ms <= anchor_ms {
        return 0;
    }
    let delta = from_ms - anchor_ms;
    match rule.freq {
        Freq::Daily => (delta / (86_400_000 * rule.interval) - 1).max(0),
        Freq::Weekly => (delta / (7 * 86_400_000 * rule.interval) - 1).max(0),
        Freq::Monthly => {
            let from_wall = wall_from_comparison_ms(from_ms, semantics);
            let months = (from_wall.year - initial.year) * 12 + (from_wall.month - initial.month);
            (months.div_euclid(rule.interval) - 1).max(0)
        }
        Freq::Yearly => {
            let from_wall = wall_from_comparison_ms(from_ms, semantics);
            let years = from_wall.year - initial.year;
            (years.div_euclid(rule.interval) - 1).max(0)
        }
    }
}

/// The civil fields of a comparison value. For a floating series the
/// comparison value IS a wall epoch; for a zoned one it is a UTC instant and
/// its UTC calendar is a conservative lower bound, which is all the jump needs.
fn wall_from_comparison_ms(millis: i64, _semantics: Semantics) -> WallTime {
    wall_from_epoch(millis)
}

/// EXPAND A RECURRENCE.
///
/// Returns the occurrences in `[range_from, range_to)`, oldest first. An
/// unsupported rule, an unreadable anchor or an empty range yields **no
/// occurrences** rather than a plausible series meaning something else.
#[must_use]
pub fn expand(input: &ExpandInput<'_>) -> Vec<Occurrence> {
    let Some(rule) = rrule::parse(input.rrule) else {
        return Vec::new();
    };
    let Some(initial) = start_wall(input.start, input.semantics, input.zone) else {
        return Vec::new();
    };
    let (Some(from), Some(to)) = (
        instant_for_comparison(input.range_from, input.semantics),
        instant_for_comparison(input.range_to, input.semantics),
    ) else {
        return Vec::new();
    };
    if from >= to {
        return Vec::new();
    }
    let limit = input.max_instances.clamp(1, ABSOLUTE_MAX_INSTANCES);
    let mut results: Vec<Occurrence> = Vec::new();
    // Fast-forward analytically to the first period that can intersect
    // `range_from` — but only for UNBOUNDED rules. A COUNT series must walk
    // from the anchor so exhaustion is observed after a few periods (COUNT=1
    // on a 2000 anchor must not convert twenty-six years of civil time).
    let mut period = if rule.count.is_none() {
        first_period_at_or_after(initial, &rule, from, input.semantics)
    } else {
        0
    };
    let mut emitted: i64 = 0;
    let mut guard: usize = 0;
    let initial_epoch = wall_epoch(initial);
    while results.len() < limit && guard < limit.saturating_mul(16) {
        guard += 1;
        let walls = if rule.freq == Freq::Weekly && rule.by_day.is_some() {
            weekly_candidates(initial, &rule, period)
        } else if let Some(pin) = rule.monthly_pin {
            monthly_candidates(initial, &rule, pin, period)
        } else {
            vec![step_anchor(initial, &rule, period)]
        };
        for wall in walls {
            if wall_epoch(wall) < initial_epoch {
                continue;
            }
            let Some(occurrence) = resolve_candidate(wall, input.semantics, input.zone) else {
                // A GAP IS SKIPPED, not substituted: the wall time exists at
                // no instant in this zone, so nothing can deliver it.
                continue;
            };
            if !within_until(&occurrence, &rule, input.semantics) {
                return results;
            }
            if let Some(count) = rule.count
                && emitted >= count
            {
                return results;
            }
            emitted += 1;
            let Some(value) = instant_for_comparison(&occurrence.start, input.semantics) else {
                continue;
            };
            if value >= to {
                return results;
            }
            if value >= from {
                results.push(occurrence);
            }
            if results.len() >= limit {
                return results;
            }
        }
        period += 1;
    }
    results
}

/// What an exception does to the occurrence it names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExceptionAction {
    Skip,
    Override,
}

/// How far an exception reaches.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ExceptionScope {
    #[default]
    Occurrence,
    Future,
}

/// An exception as the matcher wants it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecurrenceException {
    /// **The SERIES-LOCAL WALL CLOCK** of the occurrence (#996, R21) — never
    /// the resolved instant. [`super::occurrence`] is what builds one from a
    /// stored row.
    pub original_start: String,
    pub action: ExceptionAction,
    pub scope: ExceptionScope,
    /// Where the occurrence moved to, when the override says so.
    pub start: Option<String>,
}

/// THE MATCHER TAKES THE OCCURRENCE KEY (#996, R21; drift ONT-25).
///
/// Matching on `original_start` — the resolved UTC instant for a zoned series
/// — is what made a stored skip match nothing: the two are different strings
/// for every zoned series on earth.
#[must_use]
pub fn apply_exceptions(
    instances: &[Occurrence],
    exceptions: &[RecurrenceException],
) -> Vec<Occurrence> {
    let mut future: Vec<&RecurrenceException> = exceptions
        .iter()
        .filter(|exception| exception.scope == ExceptionScope::Future)
        .collect();
    future.sort_by(|left, right| left.original_start.cmp(&right.original_start));
    // A future-scope override shifts by the delta between the occurrence it
    // excepts and where that occurrence moved to — so the anchor is that
    // occurrence's own start, found by its key, not the key string itself.
    let start_of_key: std::collections::BTreeMap<&str, &str> = instances
        .iter()
        .map(|instance| (instance.wall_start.as_str(), instance.start.as_str()))
        .collect();
    let mut out = Vec::with_capacity(instances.len());
    for instance in instances {
        let key = instance.wall_start.as_str();
        let mut in_force: Option<&RecurrenceException> = None;
        for candidate in &future {
            if candidate.original_start.as_str() > key {
                break;
            }
            in_force = Some(candidate);
        }
        let exception = exceptions
            .iter()
            .find(|exception| {
                exception.scope == ExceptionScope::Occurrence && exception.original_start == key
            })
            .or(in_force);
        let Some(exception) = exception else {
            out.push(instance.clone());
            continue;
        };
        if exception.action == ExceptionAction::Skip {
            continue;
        }
        let Some(moved) = exception.start.as_deref() else {
            out.push(instance.clone());
            continue;
        };
        if exception.scope == ExceptionScope::Occurrence {
            out.push(Occurrence {
                start: moved.to_owned(),
                ..instance.clone()
            });
            continue;
        }
        let anchor = start_of_key
            .get(exception.original_start.as_str())
            .copied()
            .unwrap_or(exception.original_start.as_str());
        match wall_delta_ms(anchor, moved) {
            Some(delta) => out.push(Occurrence {
                start: shift_temporal(&instance.start, delta),
                ..instance.clone()
            }),
            None => out.push(Occurrence {
                start: moved.to_owned(),
                ..instance.clone()
            }),
        }
    }
    out
}

/// Does this string carry a zone designator?
fn is_zoned_instant(value: &str) -> bool {
    if value.ends_with('Z') {
        return true;
    }
    let bytes = value.as_bytes();
    if bytes.len() < 6 {
        return false;
    }
    let tail = &value[value.len() - 6..];
    let tail_bytes = tail.as_bytes();
    matches!(tail_bytes[0], b'+' | b'-')
        && tail_bytes[3] == b':'
        && tail_bytes[1..3].iter().all(u8::is_ascii_digit)
        && tail_bytes[4..6].iter().all(u8::is_ascii_digit)
}

/// Shift a wall-clock or zoned instant by `delta_ms` **without** converting a
/// floating or all-day string through anybody's zone.
#[must_use]
pub fn shift_temporal(value: &str, delta_ms: i64) -> String {
    if is_zoned_instant(value) {
        return parse_instant_ms(value).map_or_else(
            || value.to_owned(),
            |millis| crate::clock::format_iso_ms(millis + delta_ms),
        );
    }
    let Some(wall) = parse_wall_iso(value) else {
        return value.to_owned();
    };
    wall_iso(
        wall_from_epoch(wall_epoch(wall) + delta_ms),
        value.contains('T'),
    )
}

fn wall_delta_ms(from: &str, to: &str) -> Option<i64> {
    if is_zoned_instant(from) || is_zoned_instant(to) {
        return Some(parse_instant_ms(to)? - parse_instant_ms(from)?);
    }
    Some(wall_epoch(parse_wall_iso(to)?) - wall_epoch(parse_wall_iso(from)?))
}

/// What [`next_occurrence`] is asked.
#[derive(Debug, Clone, Copy)]
pub struct NextOccurrenceInput<'a> {
    pub rrule: &'a str,
    pub scheduled_start: &'a str,
    pub after: &'a str,
    /// The series' zone. A bare-date series has none of its own: `zone` is the
    /// calendar an `after` instant is read on (UTC's when `None`).
    pub zone: Option<&'a FireZone>,
    pub anchor: RecurrenceAnchor,
}

/// `schedule_task.recurrence_anchor` — what the next occurrence is measured
/// from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RecurrenceAnchor {
    /// From the schedule: "the 1st of every month", whenever it was ticked.
    #[default]
    Scheduled,
    /// From the completion: "every 30 days after I last did it".
    Completion,
}

impl RecurrenceAnchor {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Scheduled => "scheduled",
            Self::Completion => "completion",
        }
    }

    #[must_use]
    pub fn from_stored(value: Option<&str>) -> Self {
        if value == Some("completion") {
            Self::Completion
        } else {
            Self::Scheduled
        }
    }
}

/// Is `start` a BARE CIVIL DATE (`2026-03-01`)? A series anchored on one is
/// ALL-DAY: it recurs on dates, not instants (see the module header).
#[must_use]
pub fn is_all_day_anchor(start: &str) -> bool {
    temporal::classify(start) == Some(temporal::Kind::LocalDate)
}

/// The civil day (`YYYY-MM-DD`) a date or an instant falls on: a date is its
/// own day, an instant is read on `zone`'s calendar (UTC's without one).
fn civil_day(value: &str, zone: Option<&FireZone>) -> Option<String> {
    if is_all_day_anchor(value) {
        return Some(value.to_owned());
    }
    let millis = parse_instant_ms(value)?;
    let wall = zone.map_or_else(|| wall_from_epoch(millis), |zone| zone.zoned_parts(millis));
    Some(wall_iso(wall, false))
}

/// A `YYYY-MM-DD` as its day number in the wall epoch, for ordering.
fn day_epoch(day: &str) -> Option<i64> {
    parse_wall_iso(day).map(wall_epoch)
}

/// The first date strictly after the day `input.after` falls on, in an
/// ALL-DAY series.
fn next_all_day(input: &NextOccurrenceInput<'_>) -> Option<String> {
    let after = civil_day(input.after, input.zone)?;
    let after_epoch = day_epoch(&after)?;
    let start = if input.anchor == RecurrenceAnchor::Completion {
        after.as_str()
    } else {
        input.scheduled_start
    };
    let horizon = wall_iso(add_wall_days(parse_wall_iso(&after)?, 10 * 366), false);
    expand(
        &ExpandInput::new(input.rrule, start, &after, &horizon)
            .with_semantics(Semantics::AllDay)
            .at_most(4_000),
    )
    .into_iter()
    .find(|occurrence| day_epoch(&occurrence.start).is_some_and(|day| day > after_epoch))
    .map(|occurrence| occurrence.start)
}

/// The first occurrence strictly after `after`, or `None`.
///
/// A series anchored on a bare date answers a DATE: strictly after the day
/// `after` falls on (read on `zone`'s calendar when it is an instant).
#[must_use]
pub fn next_occurrence(input: &NextOccurrenceInput<'_>) -> Option<String> {
    if is_all_day_anchor(input.scheduled_start) {
        return next_all_day(input);
    }
    let start = if input.anchor == RecurrenceAnchor::Completion {
        input.after
    } else {
        input.scheduled_start
    };
    let after_ms = parse_instant_ms(input.after)?;
    let horizon = crate::clock::format_iso_ms(after_ms + 10 * 366 * 86_400_000);
    let mut expand_input = ExpandInput::new(input.rrule, start, input.after, &horizon)
        .with_semantics(Semantics::Zoned)
        .at_most(4_000);
    expand_input.zone = input.zone;
    expand(&expand_input)
        .into_iter()
        .find(|occurrence| {
            parse_instant_ms(&occurrence.start).is_some_and(|millis| millis > after_ms)
        })
        .map(|occurrence| occurrence.start)
}

/// v0's `MAX_MISSED` — a repeating task's missed count is capped, not walked
/// forever.
pub const MAX_MISSED: usize = 1_000;

/// What [`collapse_missed`] is asked.
#[derive(Debug, Clone, Copy)]
pub struct CollapseInput<'a> {
    pub rrule: &'a str,
    pub scheduled_start: &'a str,
    /// The series' zone. A bare-date series has none of its own: `zone` is the
    /// calendar `now` and a completion are read on — the member's, so "today"
    /// is the day they are living (UTC's when `None`).
    pub zone: Option<&'a FireZone>,
    pub anchor: RecurrenceAnchor,
    /// The evaluation clock — **never the host's `now`**.
    pub now: &'a str,
    pub last_completed_at: Option<&'a str>,
}

/// A repeating task never stacks: unactioned periods collapse into a count.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Collapsed {
    /// Capped at [`MAX_MISSED`] for `scheduled`; at most 1 for `completion`.
    pub missed: usize,
    pub next_due: Option<String>,
}

fn later_of<'a>(left: &'a str, right: Option<&'a str>) -> &'a str {
    let Some(right) = right else { return left };
    let Some(right_ms) = parse_instant_ms(right) else {
        return left;
    };
    match parse_instant_ms(left) {
        Some(left_ms) if right_ms <= left_ms => left,
        _ => right,
    }
}

/// [`collapse_missed`] for an ALL-DAY series: every period is a civil day,
/// so a period is "missed" only once its day is behind the day `now` falls on
/// in `zone` — today's own is live until today ends.
fn collapse_all_day(input: &CollapseInput<'_>) -> Collapsed {
    let Some(today) = civil_day(input.now, input.zone) else {
        return Collapsed::default();
    };
    let (Some(today_epoch), Some(today_wall)) = (day_epoch(&today), parse_wall_iso(&today)) else {
        return Collapsed::default();
    };
    let after = |after: &str, anchor| {
        next_all_day(&NextOccurrenceInput {
            rrule: input.rrule,
            scheduled_start: input.scheduled_start,
            after,
            zone: input.zone,
            anchor,
        })
    };
    if input.anchor == RecurrenceAnchor::Completion {
        let next_due = match input.last_completed_at {
            None => Some(input.scheduled_start.to_owned()),
            Some(completed) => after(completed, RecurrenceAnchor::Completion),
        };
        let Some(next_due) = next_due else {
            return Collapsed::default();
        };
        let missed = usize::from(day_epoch(&next_due).is_some_and(|day| day < today_epoch));
        return Collapsed {
            missed,
            next_due: Some(next_due),
        };
    }
    // Occurrences on [start, today); a completion covers its own day and every
    // day before it.
    let completed_day = input
        .last_completed_at
        .and_then(|completed| civil_day(completed, input.zone))
        .and_then(|day| day_epoch(&day).map(|epoch| (day, epoch)));
    let from = match &completed_day {
        Some((day, epoch))
            if day_epoch(input.scheduled_start).is_none_or(|start| *epoch > start) =>
        {
            day.as_str()
        }
        _ => input.scheduled_start,
    };
    let elapsed = if day_epoch(from).is_some_and(|from| from < today_epoch) {
        expand(
            &ExpandInput::new(input.rrule, input.scheduled_start, from, &today)
                .with_semantics(Semantics::AllDay)
                .at_most(MAX_MISSED),
        )
    } else {
        Vec::new()
    };
    let missed = elapsed
        .iter()
        .filter(|occurrence| match &completed_day {
            None => true,
            Some((_, completed)) => {
                day_epoch(&occurrence.start).is_some_and(|day| day > *completed)
            }
        })
        .count();
    // The first occurrence on or after today: strictly after yesterday.
    let yesterday = wall_iso(add_wall_days(today_wall, -1), false);
    Collapsed {
        missed,
        next_due: after(&yesterday, RecurrenceAnchor::Scheduled),
    }
}

/// Collapse the periods a repeating task went past.
///
/// A series anchored on a bare date collapses by CIVIL DAY against the day
/// `now` falls on in `zone`, and answers dates (the module header).
#[must_use]
pub fn collapse_missed(input: &CollapseInput<'_>) -> Collapsed {
    if is_all_day_anchor(input.scheduled_start) {
        return collapse_all_day(input);
    }
    let Some(now_ms) = parse_instant_ms(input.now) else {
        return Collapsed::default();
    };
    if input.anchor == RecurrenceAnchor::Completion {
        let next_due = match input.last_completed_at {
            None => Some(input.scheduled_start.to_owned()),
            Some(completed) => next_occurrence(&NextOccurrenceInput {
                rrule: input.rrule,
                scheduled_start: input.scheduled_start,
                after: completed,
                zone: input.zone,
                anchor: RecurrenceAnchor::Completion,
            }),
        };
        let Some(next_due) = next_due else {
            return Collapsed::default();
        };
        let missed = usize::from(parse_instant_ms(&next_due).is_some_and(|due_ms| due_ms < now_ms));
        return Collapsed {
            missed,
            next_due: Some(next_due),
        };
    }
    // Occurrences in [start, now); anything completed is not missed.
    let from = later_of(input.scheduled_start, input.last_completed_at);
    let elapsed = if parse_instant_ms(from).is_some_and(|millis| millis < now_ms) {
        let mut expand_input =
            ExpandInput::new(input.rrule, input.scheduled_start, from, input.now)
                .with_semantics(Semantics::Zoned)
                .at_most(MAX_MISSED);
        expand_input.zone = input.zone;
        expand(&expand_input)
    } else {
        Vec::new()
    };
    let last_completed_ms = input.last_completed_at.and_then(parse_instant_ms);
    let missed = elapsed
        .iter()
        .filter(|occurrence| match last_completed_ms {
            None => true,
            Some(completed) => {
                parse_instant_ms(&occurrence.start).is_some_and(|millis| millis > completed)
            }
        })
        .count();
    Collapsed {
        missed,
        // Strictly-after bound + half-open window: an occurrence exactly on
        // `now` is live — ask from one millisecond earlier.
        next_due: next_occurrence(&NextOccurrenceInput {
            rrule: input.rrule,
            scheduled_start: input.scheduled_start,
            after: &crate::clock::format_iso_ms(now_ms - 1),
            zone: input.zone,
            anchor: RecurrenceAnchor::Scheduled,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn zone(name: &str) -> FireZone {
        FireZone::named(name).expect("a real zone")
    }

    #[test]
    fn a_zoned_daily_series_keeps_its_wall_clock_across_a_dst_boundary() {
        // THE DST NO-SKIP FIXTURE, inline (D-1020-S3). New York springs
        // forward on 2026-03-08; a 09:00 daily series has an occurrence every
        // one of those days and none is dropped.
        let new_york = zone("America/New_York");
        let occurrences = expand(
            &ExpandInput::new(
                "FREQ=DAILY",
                "2026-03-06T14:00:00.000Z",
                "2026-03-06T00:00:00.000Z",
                "2026-03-11T00:00:00.000Z",
            )
            .in_zone(&new_york),
        );
        let walls: Vec<&str> = occurrences
            .iter()
            .map(|occurrence| occurrence.wall_start.as_str())
            .collect();
        assert_eq!(
            walls,
            [
                "2026-03-06T09:00:00",
                "2026-03-07T09:00:00",
                "2026-03-08T09:00:00",
                "2026-03-09T09:00:00",
                "2026-03-10T09:00:00",
            ],
            "five days, five occurrences, all at 09:00 local"
        );
        // …and the instants move by an hour at the boundary, which is what
        // "keeps its wall clock" means.
        assert_eq!(occurrences[1].start, "2026-03-07T14:00:00.000Z");
        assert_eq!(occurrences[2].start, "2026-03-08T13:00:00.000Z");
    }

    #[test]
    fn an_occurrence_in_the_spring_gap_is_skipped_not_substituted() {
        let new_york = zone("America/New_York");
        let occurrences = expand(
            &ExpandInput::new(
                "FREQ=DAILY",
                "2026-03-06T07:30:00.000Z", // 02:30 EST
                "2026-03-06T00:00:00.000Z",
                "2026-03-11T00:00:00.000Z",
            )
            .in_zone(&new_york),
        );
        let walls: Vec<&str> = occurrences
            .iter()
            .map(|occurrence| occurrence.wall_start.as_str())
            .collect();
        assert!(
            !walls.contains(&"2026-03-08T02:30:00"),
            "02:30 does not exist on the 8th: {walls:?}"
        );
        assert_eq!(walls.len(), 4, "four of the five days have an 02:30");
    }

    #[test]
    fn an_overlapping_occurrence_appears_once_at_the_earlier_instant() {
        let new_york = zone("America/New_York");
        let occurrences = expand(
            &ExpandInput::new(
                "FREQ=DAILY",
                "2026-10-30T05:30:00.000Z", // 01:30 EDT
                "2026-10-30T00:00:00.000Z",
                "2026-11-03T00:00:00.000Z",
            )
            .in_zone(&new_york),
        );
        let folded: Vec<&Occurrence> = occurrences
            .iter()
            .filter(|occurrence| occurrence.wall_start == "2026-11-01T01:30:00")
            .collect();
        assert_eq!(folded.len(), 1, "once, never twice");
        assert!(folded[0].overlap, "and the caller is told it folded");
        assert_eq!(folded[0].start, "2026-11-01T05:30:00.000Z");
    }

    #[test]
    fn a_refused_rule_expands_to_nothing() {
        let utc = zone("Etc/UTC");
        assert!(
            expand(
                &ExpandInput::new(
                    "FREQ=MONTHLY;BYSETPOS=-1",
                    "2026-01-30T09:00:00.000Z",
                    "2026-01-01T00:00:00.000Z",
                    "2027-01-01T00:00:00.000Z",
                )
                .in_zone(&utc)
            )
            .is_empty(),
            "never a plausible series meaning something else"
        );
    }

    #[test]
    fn a_weekly_byday_rule_expands_on_its_days() {
        let utc = zone("Etc/UTC");
        let occurrences = expand(
            &ExpandInput::new(
                "FREQ=WEEKLY;BYDAY=MO,WE",
                "2026-01-05T09:00:00.000Z", // a Monday
                "2026-01-01T00:00:00.000Z",
                "2026-01-20T00:00:00.000Z",
            )
            .in_zone(&utc),
        );
        let walls: Vec<&str> = occurrences
            .iter()
            .map(|occurrence| occurrence.wall_start.as_str())
            .collect();
        assert_eq!(
            walls,
            [
                "2026-01-05T09:00:00",
                "2026-01-07T09:00:00",
                "2026-01-12T09:00:00",
                "2026-01-14T09:00:00",
                "2026-01-19T09:00:00",
            ]
        );
    }

    #[test]
    fn count_is_observed_from_the_anchor_not_from_the_window() {
        let utc = zone("Etc/UTC");
        let occurrences = expand(
            &ExpandInput::new(
                "FREQ=DAILY;COUNT=1",
                "2000-01-01T09:00:00.000Z",
                "2026-01-01T00:00:00.000Z",
                "2027-01-01T00:00:00.000Z",
            )
            .in_zone(&utc),
        );
        assert!(
            occurrences.is_empty(),
            "COUNT=1 on a 2000 anchor has nothing left in 2026"
        );
    }

    #[test]
    fn a_skip_keyed_on_the_wall_clock_removes_its_occurrence() {
        let kolkata = zone("Asia/Kolkata");
        let occurrences = expand(
            &ExpandInput::new(
                "FREQ=DAILY",
                "2026-03-02T03:30:00.000Z", // 09:00 IST
                "2026-03-01T00:00:00.000Z",
                "2026-03-06T00:00:00.000Z",
            )
            .in_zone(&kolkata),
        );
        assert_eq!(occurrences.len(), 4);
        let kept = apply_exceptions(
            &occurrences,
            &[RecurrenceException {
                original_start: "2026-03-03T09:00:00".to_owned(),
                action: ExceptionAction::Skip,
                scope: ExceptionScope::Occurrence,
                start: None,
            }],
        );
        assert_eq!(kept.len(), 3, "the skip matched — ONT-25's whole point");
        assert!(
            !kept
                .iter()
                .any(|item| item.wall_start == "2026-03-03T09:00:00"),
            "and it removed the right one"
        );
    }

    #[test]
    fn a_skip_keyed_on_the_resolved_instant_matches_nothing() {
        // The regression ONT-25 IS. Kept as a test so the wrong key can never
        // be reintroduced as "equivalent".
        let kolkata = zone("Asia/Kolkata");
        let occurrences = expand(
            &ExpandInput::new(
                "FREQ=DAILY",
                "2026-03-02T03:30:00.000Z",
                "2026-03-01T00:00:00.000Z",
                "2026-03-06T00:00:00.000Z",
            )
            .in_zone(&kolkata),
        );
        let kept = apply_exceptions(
            &occurrences,
            &[RecurrenceException {
                original_start: "2026-03-03T03:30:00.000Z".to_owned(),
                action: ExceptionAction::Skip,
                scope: ExceptionScope::Occurrence,
                start: None,
            }],
        );
        assert_eq!(kept.len(), occurrences.len());
    }

    #[test]
    fn next_occurrence_is_strictly_after() {
        let utc = zone("Etc/UTC");
        assert_eq!(
            next_occurrence(&NextOccurrenceInput {
                rrule: "FREQ=DAILY",
                scheduled_start: "2026-03-01T09:00:00.000Z",
                after: "2026-03-01T09:00:00.000Z",
                zone: Some(&utc),
                anchor: RecurrenceAnchor::Scheduled,
            })
            .as_deref(),
            Some("2026-03-02T09:00:00.000Z")
        );
    }

    #[test]
    fn a_repeating_task_collapses_rather_than_stacking() {
        let utc = zone("Etc/UTC");
        let collapsed = collapse_missed(&CollapseInput {
            rrule: "FREQ=DAILY",
            scheduled_start: "2026-03-01T09:00:00.000Z",
            zone: Some(&utc),
            anchor: RecurrenceAnchor::Scheduled,
            now: "2026-03-05T10:00:00.000Z",
            last_completed_at: None,
        });
        assert_eq!(collapsed.missed, 5, "the 1st through the 5th");
        assert_eq!(
            collapsed.next_due.as_deref(),
            Some("2026-03-06T09:00:00.000Z")
        );
    }

    #[test]
    fn a_floating_series_is_never_read_through_a_zone() {
        let occurrences = expand(
            &ExpandInput::new(
                "FREQ=DAILY",
                "2026-03-01T09:00",
                "2026-03-01T00:00",
                "2026-03-04T00:00",
            )
            .with_semantics(Semantics::Floating),
        );
        let starts: Vec<&str> = occurrences
            .iter()
            .map(|occurrence| occurrence.start.as_str())
            .collect();
        assert_eq!(
            starts,
            [
                "2026-03-01T09:00:00",
                "2026-03-02T09:00:00",
                "2026-03-03T09:00:00"
            ]
        );
    }

    #[test]
    fn an_all_day_series_carries_dates() {
        let occurrences = expand(
            &ExpandInput::new("FREQ=DAILY", "2026-03-01", "2026-03-01", "2026-03-04")
                .with_semantics(Semantics::AllDay),
        );
        let starts: Vec<&str> = occurrences
            .iter()
            .map(|occurrence| occurrence.start.as_str())
            .collect();
        assert_eq!(starts, ["2026-03-01", "2026-03-02", "2026-03-03"]);
    }

    #[test]
    fn an_instant_parses_with_a_zone_designator() {
        assert_eq!(
            parse_instant_ms("2026-03-01T09:00:00.000Z"),
            parse_instant_ms("2026-03-01T14:30:00.000+05:30")
        );
        assert_eq!(
            parse_instant_ms("2026-03-01T09:00:00Z"),
            parse_instant_ms("2026-03-01T04:00:00-05:00")
        );
        assert_eq!(
            parse_basic_instant("20260301T000000Z"),
            parse_instant_ms("2026-03-01")
        );
        assert_eq!(parse_basic_instant("banana"), None);
    }

    // -- A DATE IS A WHOLE DAY, not a midnight (#1090) -----------------------

    fn civil_days(from: &str, to: &str) -> i64 {
        let day = |text: &str| wall_epoch(parse_wall_iso(text).expect("a date"));
        (day(to) - day(from)) / 86_400_000
    }

    fn collapse_scheduled(
        rrule: &str,
        start: &str,
        zone: &FireZone,
        now: &str,
        last_completed_at: Option<&str>,
    ) -> Collapsed {
        collapse_missed(&CollapseInput {
            rrule,
            scheduled_start: start,
            zone: Some(zone),
            anchor: RecurrenceAnchor::Scheduled,
            now,
            last_completed_at,
        })
    }

    /// THE HOURS THE ROUND-TRIP SPEC FELL INTO. A daily task whose anchor is
    /// `2026-10-03` has an occurrence on each civil day, and the one on the
    /// member's today is live until that day ends in the member's zone — at
    /// every half hour of two days, in zones either side of UTC. Expanded as a
    /// UTC midnight it was "missed" at 00:00Z and the next one was the next
    /// UTC midnight: 20:00 the evening before in New York, so the task was
    /// due tomorrow from 20:00 on.
    #[test]
    fn a_bare_date_series_is_due_on_the_zones_day_for_all_of_it() {
        for name in [
            "America/New_York",
            "America/Los_Angeles",
            "Etc/UTC",
            "Asia/Tokyo",
            "Pacific/Auckland",
        ] {
            let zone = zone(name);
            let mut now = parse_instant_ms("2026-10-07T00:00:00.000Z").expect("an instant");
            let end = parse_instant_ms("2026-10-09T00:00:00.000Z").expect("an instant");
            while now < end {
                let now_text = crate::clock::format_iso_ms(now);
                let today = wall_iso(zone.zoned_parts(now), false);
                let collapsed =
                    collapse_scheduled("FREQ=DAILY", "2026-10-03", &zone, &now_text, None);
                assert_eq!(
                    collapsed.next_due.as_deref(),
                    Some(today.as_str()),
                    "{name} at {now_text}"
                );
                assert_eq!(
                    i64::try_from(collapsed.missed).expect("a count"),
                    civil_days("2026-10-03", &today),
                    "{name} at {now_text}: the days before today, and not today"
                );
                now += 30 * 60_000;
            }
        }
    }

    /// Completing an occurrence covers its day, and every day before it.
    #[test]
    fn a_completion_covers_its_own_civil_day_in_a_bare_date_series() {
        let new_york = zone("America/New_York");
        let now = "2026-10-08T03:25:00.000Z"; // 23:25 on the 7th
        // Tuesdays: 1, 8, 15, 22, 29 September and 6 October.
        let behind = collapse_scheduled("FREQ=WEEKLY", "2026-09-01", &new_york, now, None);
        assert_eq!(
            (behind.missed, behind.next_due.as_deref()),
            (6, Some("2026-10-13"))
        );
        // Ticked on the 23rd: the 29th and the 6th are still behind.
        let ticked = collapse_scheduled(
            "FREQ=WEEKLY",
            "2026-09-01",
            &new_york,
            now,
            Some("2026-09-23T15:00:00.000Z"),
        );
        assert_eq!(
            (ticked.missed, ticked.next_due.as_deref()),
            (2, Some("2026-10-13"))
        );
        // Ticked at 19:00 on the 6th (23:00Z): the 6th is covered.
        let current = collapse_scheduled(
            "FREQ=WEEKLY",
            "2026-09-01",
            &new_york,
            now,
            Some("2026-10-06T23:00:00.000Z"),
        );
        assert_eq!(
            (current.missed, current.next_due.as_deref()),
            (0, Some("2026-10-13"))
        );
        // Ticked at 21:00 on the 6th, which is the 7th in UTC: still the 6th.
        let late = collapse_scheduled(
            "FREQ=WEEKLY",
            "2026-09-01",
            &new_york,
            now,
            Some("2026-10-07T01:00:00.000Z"),
        );
        assert_eq!(late.missed, 0);
    }

    /// The rollover from a date is a date.
    #[test]
    fn a_bare_date_series_rolls_over_to_a_date() {
        let new_york = zone("America/New_York");
        let next = |rrule: &str, start: &str, after: &str, anchor: RecurrenceAnchor| {
            next_occurrence(&NextOccurrenceInput {
                rrule,
                scheduled_start: start,
                after,
                zone: Some(&new_york),
                anchor,
            })
        };
        let scheduled = RecurrenceAnchor::Scheduled;
        assert_eq!(
            next("FREQ=DAILY", "2026-10-03", "2026-10-03", scheduled).as_deref(),
            Some("2026-10-04")
        );
        assert_eq!(
            next(
                "FREQ=WEEKLY;INTERVAL=2",
                "2026-10-03",
                "2026-10-03",
                scheduled
            )
            .as_deref(),
            Some("2026-10-17")
        );
        // From the completion: "every 3 days after I last did it". Ticked at
        // 23:25 on the 7th in New York (03:25Z on the 8th) is the 7th.
        assert_eq!(
            next(
                "FREQ=DAILY;INTERVAL=3",
                "2026-10-03",
                "2026-10-08T03:25:00.000Z",
                RecurrenceAnchor::Completion,
            )
            .as_deref(),
            Some("2026-10-10")
        );
        // A zoned series keeps its instants.
        assert_eq!(
            next(
                "FREQ=DAILY",
                "2026-10-03T14:00:00.000Z",
                "2026-10-03T14:00:00.000Z",
                scheduled,
            )
            .as_deref(),
            Some("2026-10-04T14:00:00.000Z")
        );
    }

    // -----------------------------------------------------------------------
    // MONTHLY with ONE positional BYDAY or ONE BYMONTHDAY (#1119, R-1119-1).
    // -----------------------------------------------------------------------

    /// The wall clocks (date part) of an expansion over `[from, to)`.
    fn days_of(rule: &str, start: &str, zone_name: &str, from: &str, to: &str) -> Vec<String> {
        let zone = zone(zone_name);
        expand(&ExpandInput::new(rule, start, from, to).in_zone(&zone))
            .iter()
            .map(|occurrence| occurrence.wall_start[..10].to_owned())
            .collect()
    }

    const YEAR_2026: (&str, &str) = ("2026-01-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z");

    #[test]
    fn the_second_monday_of_every_month_across_a_year() {
        assert_eq!(
            days_of(
                "FREQ=MONTHLY;BYDAY=2MO",
                "2026-01-12T09:00:00.000Z",
                "Etc/UTC",
                YEAR_2026.0,
                YEAR_2026.1
            ),
            [
                "2026-01-12",
                "2026-02-09",
                "2026-03-09",
                "2026-04-13",
                "2026-05-11",
                "2026-06-08",
                "2026-07-13",
                "2026-08-10",
                "2026-09-14",
                "2026-10-12",
                "2026-11-09",
                "2026-12-14",
            ]
        );
    }

    #[test]
    fn the_last_friday_of_every_month_is_the_last_not_the_fourth() {
        assert_eq!(
            days_of(
                "FREQ=MONTHLY;BYDAY=-1FR",
                "2026-01-30T09:00:00.000Z",
                "Etc/UTC",
                YEAR_2026.0,
                YEAR_2026.1
            ),
            [
                "2026-01-30",
                "2026-02-27",
                "2026-03-27",
                "2026-04-24",
                "2026-05-29",
                "2026-06-26",
                "2026-07-31",
                "2026-08-28",
                "2026-09-25",
                "2026-10-30",
                "2026-11-27",
                "2026-12-25",
            ]
        );
    }

    #[test]
    fn a_positional_day_before_the_anchor_starts_the_series_at_the_next_match() {
        // The anchor is the 20th; the 2nd Monday of January 2026 (the 12th) is
        // behind it, so the first occurrence is February's.
        assert_eq!(
            days_of(
                "FREQ=MONTHLY;BYDAY=2MO;COUNT=2",
                "2026-01-20T09:00:00.000Z",
                "Etc/UTC",
                YEAR_2026.0,
                YEAR_2026.1
            ),
            ["2026-02-09", "2026-03-09"]
        );
    }

    #[test]
    fn the_31st_skips_the_months_that_have_none() {
        assert_eq!(
            days_of(
                "FREQ=MONTHLY;BYMONTHDAY=31",
                "2026-01-31T09:00:00.000Z",
                "Etc/UTC",
                YEAR_2026.0,
                YEAR_2026.1
            ),
            [
                "2026-01-31",
                "2026-03-31",
                "2026-05-31",
                "2026-07-31",
                "2026-08-31",
                "2026-10-31",
                "2026-12-31",
            ],
            "RFC 5545: February, April, June, September and November have no 31st"
        );
        // The 30th skips only February; the 29th only a non-leap February.
        let thirtieth = days_of(
            "FREQ=MONTHLY;BYMONTHDAY=30",
            "2026-01-30T09:00:00.000Z",
            "Etc/UTC",
            YEAR_2026.0,
            YEAR_2026.1,
        );
        assert_eq!(thirtieth.len(), 11);
        assert!(!thirtieth.iter().any(|day| day.starts_with("2026-02")));
        let twenty_ninth = days_of(
            "FREQ=MONTHLY;BYMONTHDAY=29",
            "2028-01-29T09:00:00.000Z",
            "Etc/UTC",
            "2028-01-01T00:00:00.000Z",
            "2029-01-01T00:00:00.000Z",
        );
        assert_eq!(twenty_ninth.len(), 12, "2028 is a leap year");
    }

    #[test]
    fn the_last_day_of_the_month_is_the_28th_29th_30th_or_31st() {
        let days = days_of(
            "FREQ=MONTHLY;BYMONTHDAY=-1",
            "2027-01-31T09:00:00.000Z",
            "Etc/UTC",
            "2027-01-01T00:00:00.000Z",
            "2029-01-01T00:00:00.000Z",
        );
        assert_eq!(days.len(), 24);
        assert_eq!(days[1], "2027-02-28");
        assert_eq!(days[3], "2027-04-30");
        assert_eq!(days[12], "2028-01-31");
        assert_eq!(days[13], "2028-02-29", "a leap February");
        assert_eq!(days[23], "2028-12-31");
    }

    #[test]
    fn count_until_and_interval_apply_to_the_pinned_months() {
        // COUNT counts occurrences, not months: the skipped ones do not count.
        assert_eq!(
            days_of(
                "FREQ=MONTHLY;BYMONTHDAY=31;COUNT=4",
                "2026-01-31T09:00:00.000Z",
                "Etc/UTC",
                YEAR_2026.0,
                YEAR_2026.1
            ),
            ["2026-01-31", "2026-03-31", "2026-05-31", "2026-07-31"]
        );
        assert_eq!(
            days_of(
                "FREQ=MONTHLY;BYDAY=2MO;UNTIL=20260610T000000Z",
                "2026-01-12T09:00:00.000Z",
                "Etc/UTC",
                YEAR_2026.0,
                YEAR_2026.1
            ),
            [
                "2026-01-12",
                "2026-02-09",
                "2026-03-09",
                "2026-04-13",
                "2026-05-11",
                "2026-06-08"
            ]
        );
        // Every other month from January: Jan, Mar, May, Jul, Sep, Nov.
        assert_eq!(
            days_of(
                "FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=-1",
                "2026-01-31T09:00:00.000Z",
                "Etc/UTC",
                YEAR_2026.0,
                YEAR_2026.1
            ),
            [
                "2026-01-31",
                "2026-03-31",
                "2026-05-31",
                "2026-07-31",
                "2026-09-30",
                "2026-11-30"
            ]
        );
        assert_eq!(
            days_of(
                "FREQ=MONTHLY;INTERVAL=2;BYDAY=-1FR",
                "2026-01-30T09:00:00.000Z",
                "Etc/UTC",
                YEAR_2026.0,
                YEAR_2026.1
            ),
            [
                "2026-01-30",
                "2026-03-27",
                "2026-05-29",
                "2026-07-31",
                "2026-09-25",
                "2026-11-27"
            ]
        );
    }

    #[test]
    fn a_window_far_past_the_anchor_lands_on_the_same_days_as_a_walk_from_it() {
        // The fast-forward must not skip a period that still has a candidate.
        let windowed = days_of(
            "FREQ=MONTHLY;INTERVAL=2;BYDAY=2MO",
            "2020-01-13T09:00:00.000Z",
            "Etc/UTC",
            "2026-01-01T00:00:00.000Z",
            "2026-07-01T00:00:00.000Z",
        );
        assert_eq!(windowed, ["2026-01-12", "2026-03-09", "2026-05-11"]);
        let thirty_first = days_of(
            "FREQ=MONTHLY;BYMONTHDAY=31",
            "2020-01-31T09:00:00.000Z",
            "Etc/UTC",
            "2026-02-01T00:00:00.000Z",
            "2026-06-01T00:00:00.000Z",
        );
        assert_eq!(thirty_first, ["2026-03-31", "2026-05-31"]);
    }

    #[test]
    fn a_timed_series_keeps_its_wall_clock_across_dst_in_los_angeles() {
        let la = zone("America/Los_Angeles");
        let occurrences = expand(
            &ExpandInput::new(
                "FREQ=MONTHLY;BYDAY=2SU",
                "2026-02-08T17:00:00.000Z", // 09:00 PST
                "2026-02-01T00:00:00.000Z",
                "2026-12-01T00:00:00.000Z",
            )
            .in_zone(&la),
        );
        let find = |wall: &str| {
            occurrences
                .iter()
                .find(|occurrence| occurrence.wall_start == wall)
                .unwrap_or_else(|| panic!("{wall} is missing from {occurrences:?}"))
                .start
                .clone()
        };
        assert_eq!(find("2026-02-08T09:00:00"), "2026-02-08T17:00:00.000Z");
        assert_eq!(
            find("2026-03-08T09:00:00"),
            "2026-03-08T16:00:00.000Z",
            "the second Sunday of March is the day DST starts: 09:00 is already PDT"
        );
        assert_eq!(find("2026-11-08T09:00:00"), "2026-11-08T17:00:00.000Z");
    }

    #[test]
    fn a_pinned_day_in_the_spring_gap_is_skipped_and_one_in_the_fold_occurs_once() {
        let la = zone("America/Los_Angeles");
        // 02:30 on the 8th of March 2026 does not exist in Los Angeles.
        let gap = expand(
            &ExpandInput::new(
                "FREQ=MONTHLY;BYMONTHDAY=8",
                "2026-02-08T10:30:00.000Z", // 02:30 PST
                "2026-02-01T00:00:00.000Z",
                "2026-05-01T00:00:00.000Z",
            )
            .in_zone(&la),
        );
        let walls: Vec<&str> = gap.iter().map(|o| o.wall_start.as_str()).collect();
        assert_eq!(walls, ["2026-02-08T02:30:00", "2026-04-08T02:30:00"]);
        // 01:30 on the 1st of November happens twice; the earlier instant wins.
        let fold = expand(
            &ExpandInput::new(
                "FREQ=MONTHLY;BYMONTHDAY=1",
                "2026-10-01T08:30:00.000Z", // 01:30 PDT
                "2026-10-01T00:00:00.000Z",
                "2026-12-01T00:00:00.000Z",
            )
            .in_zone(&la),
        );
        assert_eq!(fold.len(), 2);
        assert_eq!(fold[1].wall_start, "2026-11-01T01:30:00");
        assert_eq!(fold[1].start, "2026-11-01T08:30:00.000Z");
        assert!(fold[1].overlap);
    }

    #[test]
    fn floating_and_all_day_series_expand_the_pinned_forms_too() {
        let floating = expand(
            &ExpandInput::new(
                "FREQ=MONTHLY;BYMONTHDAY=-1",
                "2026-01-31T09:00:00",
                "2026-01-01T00:00:00",
                "2026-04-01T00:00:00",
            )
            .with_semantics(Semantics::Floating),
        );
        let walls: Vec<&str> = floating.iter().map(|o| o.wall_start.as_str()).collect();
        assert_eq!(
            walls,
            [
                "2026-01-31T09:00:00",
                "2026-02-28T09:00:00",
                "2026-03-31T09:00:00"
            ]
        );
        let all_day = expand(
            &ExpandInput::new(
                "FREQ=MONTHLY;BYDAY=1MO",
                "2026-01-05",
                "2026-01-01",
                "2026-04-01",
            )
            .with_semantics(Semantics::AllDay),
        );
        let days: Vec<&str> = all_day.iter().map(|o| o.wall_start.as_str()).collect();
        assert_eq!(days, ["2026-01-05", "2026-02-02", "2026-03-02"]);
    }

    #[test]
    fn a_rule_that_never_lands_expands_to_nothing_and_terminates() {
        // Every 12 months from February: the 31st never exists in February.
        assert!(
            days_of(
                "FREQ=MONTHLY;INTERVAL=12;BYMONTHDAY=31",
                "2026-02-28T09:00:00.000Z",
                "Etc/UTC",
                "2026-01-01T00:00:00.000Z",
                "2036-01-01T00:00:00.000Z"
            )
            .is_empty()
        );
    }

    #[test]
    fn the_forms_still_refused_expand_to_nothing() {
        for rule in [
            "FREQ=MONTHLY;BYDAY=2MO;BYSETPOS=1",
            "FREQ=MONTHLY;BYDAY=MO,TU",
            "FREQ=MONTHLY;BYDAY=MO",
            "FREQ=MONTHLY;BYDAY=2MO;BYMONTHDAY=8",
            "FREQ=MONTHLY;BYMONTHDAY=1,15",
            "FREQ=YEARLY;BYDAY=2MO",
            "FREQ=WEEKLY;BYMONTHDAY=1",
        ] {
            assert!(
                days_of(
                    rule,
                    "2026-01-12T09:00:00.000Z",
                    "Etc/UTC",
                    YEAR_2026.0,
                    YEAR_2026.1
                )
                .is_empty(),
                "{rule} is refused"
            );
        }
    }

    #[test]
    fn a_repeating_task_on_a_month_position_advances_to_the_next_one() {
        // Tasks advance through `next_occurrence` / `collapse_missed`, which are
        // built on `expand` — so a month position needs no code of its own.
        let utc = zone("Etc/UTC");
        let next = |rule: &str, start: &str, after: &str| {
            next_occurrence(&NextOccurrenceInput {
                rrule: rule,
                scheduled_start: start,
                after,
                zone: Some(&utc),
                anchor: RecurrenceAnchor::Scheduled,
            })
        };
        // A bare-date task answers a date: the last day of the month, then the next.
        assert_eq!(
            next("FREQ=MONTHLY;BYMONTHDAY=-1", "2026-01-31", "2026-01-31").as_deref(),
            Some("2026-02-28")
        );
        assert_eq!(
            next("FREQ=MONTHLY;BYMONTHDAY=-1", "2026-01-31", "2026-02-28").as_deref(),
            Some("2026-03-31")
        );
        assert_eq!(
            next("FREQ=MONTHLY;BYDAY=2MO", "2026-01-12", "2026-01-12").as_deref(),
            Some("2026-02-09")
        );
        // A timed task answers an instant.
        assert_eq!(
            next(
                "FREQ=MONTHLY;BYMONTHDAY=31",
                "2026-01-31T09:00:00.000Z",
                "2026-01-31T09:00:00.000Z"
            )
            .as_deref(),
            Some("2026-03-31T09:00:00.000Z"),
            "February has no 31st"
        );
    }
}
