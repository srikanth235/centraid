//! THE EXPANDER — civil-time recurrence, and the DST policy it shares with
//! cron (#1020, D-1020-S1, D-1020-S2).
//!
//! v0's `packages/core/src/time/recurrence.ts` plus `recurrence-collapse.ts`,
//! with one rule and no second engine anywhere. What the expansion guarantees:
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
//!   skipped day came back, on the web agenda, on the phone and on Tally's
//!   template dashboard, silently, all three.

use super::rrule::{self, DAY_TOKENS, Freq, ParsedRrule};
use super::zone::{
    FireZone, WallTime, add_wall_days, add_wall_months, parse_wall_iso, wall_epoch,
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

/// The first occurrence strictly after `after`, or `None`.
#[must_use]
pub fn next_occurrence(input: &NextOccurrenceInput<'_>) -> Option<String> {
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

/// Collapse the periods a repeating task went past.
#[must_use]
pub fn collapse_missed(input: &CollapseInput<'_>) -> Collapsed {
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
}
