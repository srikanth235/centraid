//! THE CALENDAR'S GRIDS, LAID OUT (#1173): the week strip, the hour grid (Day
//! and Week), the month and the year. Pure: it folds what [`super::fold`]
//! already placed in the member's zone, and a shell draws what it returns.
//!
//! ## Minutes, lanes and the week
//!
//! A block's place is minutes from its column day's local midnight, 0 to 1440,
//! clipped on every side and never under [`MIN_BLOCK`] tall. Blocks that overlap
//! form a cluster and each takes the first lane free at its start
//! ([`lanes`]); the cluster's lane count is every member's `columns`. A run over
//! midnight is clipped on each day it spans and cannot be dragged.
//!
//! The week starts on the region's first weekday ([`week_start_of`]): Sunday in
//! a short list of regions, Monday elsewhere.
//!
//! ## A guess never writes
//!
//! Every minute a shell reports (a drop, a long press) is snapped here
//! ([`snap`]), to [`SNAP`] minutes.

use std::collections::{BTreeMap, HashMap};

use centraid_api_proto::core_v1 as wire;
use wire::AgendaDestination as Dest;

use super::fold;
use crate::calendar::hues::Hues;
use crate::calendar::routes;
use crate::kit::civil;
use crate::kit::schedule::rows;
use crate::kit::schedule::rule_words::long_day;
use crate::strings::{
    Locale, agenda as words, agenda_grid as sayings, agenda_home as sentences, task,
};

/// What a drop or a long press snaps to, in minutes.
pub const SNAP: i32 = 15;
/// Minutes in a day: the grid's height.
pub const DAY: i32 = 1440;
/// The shortest a block is drawn.
pub const MIN_BLOCK: i32 = 15;
/// A timed task's block: it has a moment and no length.
const TASK_BLOCK: i32 = 30;
/// Where the grid opens with nothing to land on.
const DEFAULT_SCROLL: i32 = 480;
/// What shows above the minute the grid opens on.
const LEAD: i32 = 60;
/// Dots a day carries.
pub const DOTS: usize = 3;
/// Titles a grid-style month cell carries.
pub const CHIPS: usize = 3;
const BIRTHDAY_HUE: &str = "rose";
const SEPARATOR: &str = ", ";
/// Between the time and the place on a block's second line.
const META_SEPARATOR: &str = " · ";

pub use crate::kit::civil::{WeekStart, week_first, week_start_of};

fn year_month(day: &str) -> Option<(i64, i64)> {
    civil::epoch_day_of(day)?;
    Some((day.get(0..4)?.parse().ok()?, day.get(5..7)?.parse().ok()?))
}

fn first_of(year: i64, month: i64) -> String {
    format!("{year:04}-{month:02}-01")
}

/// Days in a month, from the first of it to the first of the next.
fn month_days(year: i64, month: i64) -> Option<i64> {
    let (next_year, next_month) = if month == 12 {
        (year + 1, 1)
    } else {
        (year, month + 1)
    };
    Some(
        civil::epoch_day_of(&first_of(next_year, next_month))?
            - civil::epoch_day_of(&first_of(year, month))?,
    )
}

/// `day` moved by `by` months, keeping its day of the month when the month has
/// it and its last day when not (31 March + 1 month is 30 April).
#[must_use]
pub fn plus_months(day: &str, by: i64) -> Option<String> {
    let (year, month) = year_month(day)?;
    let dom: i64 = day.get(8..10)?.parse().ok()?;
    let total = year * 12 + (month - 1) + by;
    let (year, month) = (total.div_euclid(12), total.rem_euclid(12) + 1);
    Some(format!(
        "{year:04}-{month:02}-{:02}",
        dom.min(month_days(year, month)?)
    ))
}

/// The cells a month draws: whole weeks from the week start on or before the
/// 1st through the week's end on or after the last day.
#[must_use]
pub fn month_range(anchor: &str, start: WeekStart) -> Option<(String, i64)> {
    let (year, month) = year_month(anchor)?;
    let first = week_first(&first_of(year, month), start)?;
    let last = civil::plus_days(&first_of(year, month), month_days(year, month)? - 1)?;
    let end = civil::plus_days(&week_first(&last, start)?, 6)?;
    let count = civil::epoch_day_of(&end)? - civil::epoch_day_of(&first)? + 1;
    Some((first, count))
}

/// The day a step of `by` periods lands on: a day, a week, a month or a year.
/// `None` for a place with no period, and for a day that does not parse.
#[must_use]
pub fn step(destination: Dest, anchor: &str, by: i32) -> Option<String> {
    let by = i64::from(by);
    match destination {
        Dest::Day => civil::plus_days(anchor, by),
        Dest::Week => civil::plus_days(anchor, by * 7),
        Dest::Month => plus_months(anchor, by),
        Dest::Year => plus_months(anchor, by * 12),
        _ => None,
    }
}

/// The days a read must cover for `destination` anchored on `anchor`, as the
/// first day and how many. Day and Week read the anchor's week (the strip has
/// dots), Month its whole cell range; every other place its own window.
#[must_use]
pub fn range_of(
    destination: Dest,
    anchor: &str,
    start: WeekStart,
    window: i64,
) -> Option<(String, i64)> {
    match destination {
        Dest::Day | Dest::Week => Some((week_first(anchor, start)?, 7)),
        Dest::Month => month_range(anchor, start),
        _ => civil::epoch_day_of(anchor).map(|_| (anchor.to_owned(), window)),
    }
}

/// Whether `destination` is one of the Calendar's views.
#[must_use]
pub fn is_calendar_view(destination: Dest) -> bool {
    matches!(
        destination,
        Dest::Day | Dest::Week | Dest::Month | Dest::Schedule | Dest::Year
    )
}

// ---- minutes ---------------------------------------------------------------

/// A minute the shell reported, put on the grid: the nearest [`SNAP`], and a
/// whole step before the day's end.
#[must_use]
pub fn snap(minute: i32) -> i32 {
    let minute = minute.clamp(0, DAY);
    ((minute + SNAP / 2) / SNAP * SNAP).min(DAY - SNAP)
}

/// A dragged block's foot put on the grid: the nearest [`SNAP`], up to the
/// day's end.
#[must_use]
pub fn snap_end(minute: i32) -> i32 {
    ((minute.clamp(0, DAY) + SNAP / 2) / SNAP * SNAP).min(DAY)
}

/// Whether a block can be dragged: a timed event that is not cancelled and
/// starts and ends on one day, with no guest but the member. A run over
/// midnight, an all-day event, one the grid cannot place and one with other
/// guests are not: moving an invitation only moves the member's own copy, which
/// reads as moving the meeting.
#[must_use]
pub fn draggable(event: &wire::AgendaEvent) -> bool {
    if event.all_day
        || event.status.as_deref() == Some("cancelled")
        || event.attendees.iter().any(|guest| !guest.is_you)
    {
        return false;
    }
    let day = event.local_start.get(..10).unwrap_or_default();
    let end = event.local_end.as_str();
    let end_day = end.get(..10).unwrap_or_default();
    minute_in(&event.local_start).is_some()
        && (end.is_empty()
            || end_day == day
            || (civil::plus_days(day, 1).as_deref() == Some(end_day)
                && civil::clock(end) == "00:00"))
}

/// `09:05` for minute 545.
#[must_use]
pub fn clock_label(minute: i32) -> String {
    format!("{:02}:{:02}", minute / 60, minute % 60)
}

/// Minutes into the day of `HH:MM`.
fn minute_of(clock: &str) -> Option<i32> {
    let hours: i32 = clock.get(0..2)?.parse().ok()?;
    let minutes: i32 = clock.get(3..5)?.parse().ok()?;
    ((0..24).contains(&hours) && (0..60).contains(&minutes)).then_some(hours * 60 + minutes)
}

/// Minutes into the day of the clock of `YYYY-MM-DDTHH:MM`.
fn minute_in(local: &str) -> Option<i32> {
    minute_of(local.get(11..16)?)
}

/// `YYYY-MM-DDTHH:MM` as minutes since the epoch's midnight, on the wall clock.
#[must_use]
pub fn minutes_of(local: &str) -> Option<i64> {
    let day = civil::epoch_day_of(local.get(..10)?)?;
    Some(day * 1440 + i64::from(minute_in(local)?))
}

/// The wall clock `minutes` after the epoch's midnight.
#[must_use]
pub fn local_of(minutes: i64) -> String {
    let day = civil::civil_day_of(minutes.div_euclid(1440));
    let clock = i32::try_from(minutes.rem_euclid(1440)).unwrap_or(0);
    format!("{day}T{}", clock_label(clock))
}

/// A block clipped to the day and never shorter than [`MIN_BLOCK`].
fn clip(start: i32, end: i32) -> (i32, i32) {
    let start = start.clamp(0, DAY - MIN_BLOCK);
    (start, end.clamp(0, DAY).max(start + MIN_BLOCK))
}

/// THE LANES: for each span, in the order given, its lane and its cluster's
/// lane count. Spans sort by start, the longer first; a span that starts before
/// the cluster is over joins it and takes the first lane free at its start; one
/// that starts at or after the cluster's end opens the next cluster.
#[must_use]
pub fn lanes(spans: &[(i32, i32)]) -> Vec<(usize, usize)> {
    let mut order: Vec<usize> = (0..spans.len()).collect();
    order.sort_by_key(|&at| (spans[at].0, std::cmp::Reverse(spans[at].1), at));
    let mut out = vec![(0, 1); spans.len()];
    let mut members: Vec<usize> = Vec::new();
    let mut lane_ends: Vec<i32> = Vec::new();
    let mut cluster_end = i32::MIN;
    let close = |members: &mut Vec<usize>, lane_ends: &mut Vec<i32>, out: &mut [(usize, usize)]| {
        for &member in members.iter() {
            out[member].1 = lane_ends.len();
        }
        members.clear();
        lane_ends.clear();
    };
    for at in order {
        let (start, end) = spans[at];
        if start >= cluster_end {
            close(&mut members, &mut lane_ends, &mut out);
            cluster_end = i32::MIN;
        }
        let lane = match lane_ends.iter().position(|&ends| ends <= start) {
            Some(lane) => {
                lane_ends[lane] = end;
                lane
            }
            None => {
                lane_ends.push(end);
                lane_ends.len() - 1
            }
        };
        out[at].0 = lane;
        members.push(at);
        cluster_end = cluster_end.max(end);
    }
    close(&mut members, &mut lane_ends, &mut out);
    out
}

// ---- the inputs ------------------------------------------------------------

/// What the grids fold: the shown events by day over the read range, the open
/// tasks due by day, the birthdays by month-day, and the clocks.
pub struct Input<'a> {
    pub locale: Locale,
    pub destination: Dest,
    pub anchor: &'a str,
    pub today: &'a str,
    pub now: &'a str,
    pub start: WeekStart,
    pub style: wire::AgendaMonthStyle,
    pub by_day: &'a BTreeMap<String, Vec<&'a wire::AgendaEvent>>,
    pub due_on: &'a BTreeMap<&'a str, Vec<&'a wire::AgendaTask>>,
    /// The overdue reminders, drawn in the all-day lane of Day on today (the hour grid has no list
    /// to lead with): oldest first, each saying how long ago.
    pub overdue: &'a [&'a wire::AgendaTask],
    pub birthdays: &'a HashMap<String, Vec<&'a wire::AgendaBirthday>>,
    pub hues: &'a Hues<'a>,
    pub tasks: &'a rows::Context<'a>,
}

/// The grids a view carries; each is set on its own place and absent elsewhere.
#[derive(Default)]
pub struct Grids {
    pub week_strip: Option<wire::AgendaWeekStrip>,
    pub time_grid: Option<wire::AgendaTimeGrid>,
    pub month: Option<wire::AgendaMonthGrid>,
    pub year: Option<wire::AgendaYearGrid>,
}

/// The grids of `input`'s place. `selected` is the anchor day's rows, which the
/// month's list style draws under its cells.
#[must_use]
pub fn build(input: &Input, selected: Vec<wire::AgendaDaySection>) -> Grids {
    match input.destination {
        Dest::Day | Dest::Week => Grids {
            week_strip: week_strip(input),
            time_grid: time_grid(input),
            ..Grids::default()
        },
        Dest::Month => Grids {
            month: month(input, selected),
            ..Grids::default()
        },
        Dest::Year => Grids {
            year: year(input),
            ..Grids::default()
        },
        _ => Grids::default(),
    }
}

impl Input<'_> {
    /// The events on `day`, in the order the day's list gives them.
    fn events(&self, day: &str) -> Vec<&wire::AgendaEvent> {
        let mut found: Vec<&wire::AgendaEvent> = self
            .by_day
            .get(day)
            .map(|events| events.to_vec())
            .unwrap_or_default();
        found.sort_by_key(|event| fold::event_key(event, day));
        found
    }

    /// One dot per calendar with an event on `day`, in the order they first
    /// start, at most [`DOTS`].
    fn dots(&self, day: &str) -> Vec<String> {
        let events = self.events(day);
        let mut calendars: Vec<Option<&str>> = Vec::new();
        for event in &events {
            let calendar = event.calendar_id.as_deref();
            if !calendars.contains(&calendar) {
                calendars.push(calendar);
            }
        }
        calendars
            .into_iter()
            .take(DOTS)
            .map(|calendar| self.hues.grid_hue(calendar))
            .collect()
    }

    fn tasks_on(&self, day: &str) -> &[&wire::AgendaTask] {
        self.due_on.get(day).map_or(&[][..], Vec::as_slice)
    }

    fn birthdays_on(&self, day: &str) -> &[&wire::AgendaBirthday] {
        self.birthdays
            .get(day.get(5..).unwrap_or_default())
            .map_or(&[][..], Vec::as_slice)
    }

    /// "Wednesday 4 November, 3 events"; the day alone when it holds none.
    fn spoken(&self, day: &str) -> String {
        let count = self.events(day).len() as u64;
        if count == 0 {
            long_day(self.locale, day)
        } else {
            format!(
                "{}{SEPARATOR}{}",
                long_day(self.locale, day),
                sentences::event_count(self.locale, count)
            )
        }
    }

    fn task_hue(&self, task: &wire::AgendaTask) -> String {
        task.project_id
            .as_deref()
            .map(|id| rows::hue_of(id, self.tasks.projects.get(id).copied()))
            .unwrap_or_else(|| crate::calendar::hues::NO_CALENDAR_HUE.to_owned())
    }

    fn task_title(&self, task: &wire::AgendaTask) -> String {
        if task.title.trim().is_empty() {
            task::untitled(self.locale)
        } else {
            task.title.clone()
        }
    }
}

fn initial(locale: Locale, day: &str) -> String {
    match civil::iso_weekday_of(day) {
        Some(1) => sayings::initial_mon(locale),
        Some(2) => sayings::initial_tue(locale),
        Some(3) => sayings::initial_wed(locale),
        Some(4) => sayings::initial_thu(locale),
        Some(5) => sayings::initial_fri(locale),
        Some(6) => sayings::initial_sat(locale),
        Some(7) => sayings::initial_sun(locale),
        _ => String::new(),
    }
}

fn is_weekend(day: &str) -> bool {
    matches!(civil::iso_weekday_of(day), Some(6 | 7))
}

fn day_number(day: &str) -> String {
    civil::day_of_month_of(day)
        .map(|n| n.to_string())
        .unwrap_or_default()
}

fn days_from(first: &str, count: i64) -> Vec<String> {
    (0..count)
        .filter_map(|n| civil::plus_days(first, n))
        .collect()
}

// ---- the week strip --------------------------------------------------------

/// The anchor's week, a day per cell with its dots.
fn week_strip(input: &Input) -> Option<wire::AgendaWeekStrip> {
    let first = week_first(input.anchor, input.start)?;
    let days = days_from(&first, 7)
        .into_iter()
        .map(|day| wire::AgendaStripDay {
            day_number: day_number(&day),
            weekday_initial: initial(input.locale, &day),
            is_today: day == input.today,
            is_selected: day == input.anchor,
            is_weekend: is_weekend(&day),
            dot_hue_keys: input.dots(&day),
            accessibility_label: input.spoken(&day),
            // A day picked stays in the layout it was picked in.
            opens: input.destination as i32,
            day,
        })
        .collect();
    Some(wire::AgendaWeekStrip {
        days,
        previous_label: sayings::previous_week(input.locale),
        next_label: sayings::next_week(input.locale),
    })
}

// ---- the hour grid ---------------------------------------------------------

/// Day's one column or Week's seven, with the all-day strip over them.
fn time_grid(input: &Input) -> Option<wire::AgendaTimeGrid> {
    let columns = if input.destination == Dest::Week {
        days_from(&week_first(input.anchor, input.start)?, 7)
    } else {
        civil::epoch_day_of(input.anchor)?;
        vec![input.anchor.to_owned()]
    };
    let locale = input.locale;
    let now_minute = minute_in(input.now);
    let now = columns
        .iter()
        .any(|day| day == input.today)
        .then(|| {
            now_minute.map(|minute| {
                let label = clock_label(minute);
                wire::AgendaGridNow {
                    day: input.today.to_owned(),
                    minute,
                    accessibility_label: format!("{}{SEPARATOR}{label}", words::now(locale)),
                    label,
                }
            })
        })
        .flatten();
    let days: Vec<wire::AgendaGridDay> = columns
        .iter()
        .map(|day| wire::AgendaGridDay {
            day: day.clone(),
            heading: if input.destination == Dest::Week {
                format!("{}\n{}", civil::weekday_short(locale, day), day_number(day))
            } else {
                String::new()
            },
            is_today: day == input.today,
            all_day: chips_of(input, day),
            blocks: blocks_of(input, day),
            accessibility_label: long_day(locale, day),
        })
        .collect();
    let first_block = days
        .iter()
        .flat_map(|day| &day.blocks)
        .map(|block| block.start_minute)
        .min();
    let scroll_to_minute = match (&now, first_block) {
        (Some(now), _) => now.minute - LEAD,
        (None, Some(first)) => first - LEAD,
        (None, None) => DEFAULT_SCROLL,
    }
    .max(0);
    Some(wire::AgendaTimeGrid {
        hours: (0..24)
            .map(|hour| wire::AgendaHourMark {
                minute: hour * 60,
                label: clock_label(hour * 60),
            })
            .collect(),
        days,
        scroll_to_minute,
        snap_minutes: SNAP,
        all_day_label: sayings::grid_all_day(locale),
        now,
        slot_hint: sayings::slot_hint(locale),
        move_label: sayings::move_label(locale),
        resize_label: sayings::resize_label(locale),
    })
}

/// All-day events, birthdays, and the open tasks due that day with no time.
fn chips_of(input: &Input, day: &str) -> Vec<wire::AgendaGridChip> {
    let locale = input.locale;
    let mut out: Vec<wire::AgendaGridChip> = input
        .events(day)
        .into_iter()
        .filter(|event| event.all_day)
        .map(|event| {
            let title = event_title(locale, event);
            wire::AgendaGridChip {
                key: format!("event:{}", event.instance_key),
                hue_key: input.hues.grid_hue(event.calendar_id.as_deref()),
                route: Some(routes::event(
                    &event.event_id,
                    &event.instance_key,
                    event.original_start_local.as_deref(),
                    day,
                )),
                accessibility_label: format!("{title}{SEPARATOR}{}", words::all_day(locale)),
                title,
                ..wire::AgendaGridChip::default()
            }
        })
        .collect();
    out.extend(
        input
            .birthdays_on(day)
            .iter()
            .map(|birthday| wire::AgendaGridChip {
                key: format!("birthday:{}", birthday.name),
                title: birthday.name.clone(),
                hue_key: rows::hue_role(BIRTHDAY_HUE),
                accessibility_label: format!(
                    "{}{SEPARATOR}{}",
                    birthday.name,
                    sayings::birthday(locale)
                ),
                ..wire::AgendaGridChip::default()
            }),
    );
    // OVERDUE REMINDERS lead Day's lane on today, in the attention hue (amber, never red), each with its
    // box and how long ago in its spoken label.
    if input.destination == Dest::Day && day == input.today {
        out.splice(
            0..0,
            input.overdue.iter().map(|task| {
                let title = input.task_title(task);
                let how_long = rows::due_label(input.locale, task, input.tasks);
                wire::AgendaGridChip {
                    key: format!("task:overdue:{}", task.task_id),
                    hue_key: rows::hue_role("amber"),
                    is_task: true,
                    task_id: task.task_id.clone(),
                    route: Some(crate::kit::schedule::routes::task(&task.task_id)),
                    accessibility_label: format!(
                        "{title}{SEPARATOR}{}{SEPARATOR}{how_long}",
                        task::group_overdue(input.locale)
                    ),
                    title,
                    done: false,
                    read_only: false,
                }
            }),
        );
    }
    out.extend(
        input
            .tasks_on(day)
            .iter()
            .filter(|task| task.due_time.is_empty())
            .map(|task| {
                let title = input.task_title(task);
                wire::AgendaGridChip {
                    key: format!("task:{}", task.task_id),
                    hue_key: input.task_hue(task),
                    is_task: true,
                    task_id: task.task_id.clone(),
                    route: Some(crate::kit::schedule::routes::task(&task.task_id)),
                    accessibility_label: title.clone(),
                    title,
                    done: task.status == rows::STATUS_DONE,
                    read_only: task.status == rows::STATUS_PROJECTED,
                }
            }),
    );
    out
}

fn event_title(locale: Locale, event: &wire::AgendaEvent) -> String {
    event
        .summary
        .as_ref()
        .filter(|summary| !summary.trim().is_empty())
        .cloned()
        .unwrap_or_else(|| words::untitled(locale))
}

/// The timed events and the timed tasks of `day`, placed in lanes.
fn blocks_of(input: &Input, day: &str) -> Vec<wire::AgendaGridBlock> {
    let locale = input.locale;
    let now = minutes_of(input.now);
    let day_start = civil::epoch_day_of(day).map_or(0, |epoch| epoch * 1440);
    let past = |end: i32| match now {
        Some(now) => day_start + i64::from(end) <= now,
        None => day < input.today,
    };
    let mut blocks: Vec<wire::AgendaGridBlock> = Vec::new();
    for event in input.events(day).into_iter().filter(|e| !e.all_day) {
        let starts_here = fold::start_day(event) >= day;
        let end = event.local_end.as_str();
        let end_day = end.get(..10).unwrap_or_default();
        let start = if starts_here {
            minute_in(&event.local_start).unwrap_or(0)
        } else {
            0
        };
        let end_minute = if end.is_empty() {
            start
        } else if end_day > day {
            DAY
        } else {
            minute_in(end).unwrap_or(start)
        };
        // A run that ends on the next midnight ends on this day.
        let ends_here = end.is_empty()
            || end_day <= day
            || (civil::plus_days(day, 1).as_deref() == Some(end_day)
                && civil::clock(end) == "00:00");
        let (start, end) = clip(start, end_minute);
        let (time_label, spoken) = fold::time_of(locale, input.tasks.cycle, event, day);
        let title = event_title(locale, event);
        let meta = if event
            .conferencing_uri
            .as_ref()
            .is_some_and(|uri| !uri.trim().is_empty())
        {
            words::meta_call(locale)
        } else {
            String::new()
        };
        let accessibility_label = [title.as_str(), spoken.as_str(), meta.as_str()]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(SEPARATOR);
        blocks.push(wire::AgendaGridBlock {
            key: format!("{day}|{}", event.instance_key),
            instance_key: event.instance_key.clone(),
            hue_key: input.hues.grid_hue(event.calendar_id.as_deref()),
            start_minute: start,
            end_minute: end,
            is_past: past(end),
            movable: starts_here && ends_here && draggable(event),
            route: Some(routes::event(
                &event.event_id,
                &event.instance_key,
                event.original_start_local.as_deref(),
                day,
            )),
            title,
            detail: [time_label.as_str(), meta.as_str()]
                .into_iter()
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join(META_SEPARATOR),
            time_label,
            meta,
            accessibility_label,
            ..wire::AgendaGridBlock::default()
        });
    }
    for task in input
        .tasks_on(day)
        .iter()
        .filter(|task| !task.due_time.is_empty())
    {
        let Some(at) = minute_of(&task.due_time) else {
            continue;
        };
        let (start, end) = clip(at, at + TASK_BLOCK);
        let title = input.task_title(task);
        let meta = task
            .project_id
            .as_deref()
            .and_then(|id| input.tasks.projects.get(id))
            .map(|project| project.name.clone())
            .unwrap_or_default();
        let time_label = clock_label(at);
        let accessibility_label = [title.as_str(), time_label.as_str(), meta.as_str()]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(SEPARATOR);
        blocks.push(wire::AgendaGridBlock {
            key: format!("{day}|task:{}", task.task_id),
            hue_key: input.task_hue(task),
            start_minute: start,
            end_minute: end,
            is_past: past(end),
            is_task: true,
            task_id: task.task_id.clone(),
            route: Some(crate::kit::schedule::routes::task(&task.task_id)),
            done: task.status == rows::STATUS_DONE,
            read_only: task.status == rows::STATUS_PROJECTED,
            title,
            detail: meta.clone(),
            time_label,
            meta,
            accessibility_label,
            ..wire::AgendaGridBlock::default()
        });
    }
    // BY START, THE LONGER FIRST: the order the lanes are taken in.
    blocks.sort_by_key(|block| {
        (
            block.start_minute,
            std::cmp::Reverse(block.end_minute),
            block.key.clone(),
        )
    });
    let spans: Vec<(i32, i32)> = blocks
        .iter()
        .map(|block| (block.start_minute, block.end_minute))
        .collect();
    for (block, (lane, columns)) in blocks.iter_mut().zip(lanes(&spans)) {
        block.column = i32::try_from(lane).unwrap_or(0);
        block.columns = i32::try_from(columns).unwrap_or(1);
    }
    blocks
}

// ---- the month -------------------------------------------------------------

/// One title in a month cell, and where it sorts.
struct Mark {
    key: String,
    title: String,
    hue_key: String,
    is_task: bool,
}

/// A day's titles in the list's order: all-day, birthdays, the day's untimed
/// tasks, what runs in, then the timed events and tasks by time.
fn marks_of(input: &Input, day: &str) -> Vec<Mark> {
    let locale = input.locale;
    let mut marks: Vec<Mark> = input
        .events(day)
        .into_iter()
        .map(|event| Mark {
            key: fold::event_key(event, day),
            title: event_title(locale, event),
            hue_key: input.hues.grid_hue(event.calendar_id.as_deref()),
            is_task: false,
        })
        .collect();
    marks.extend(input.birthdays_on(day).iter().map(|birthday| Mark {
        key: "00".to_owned(),
        title: birthday.name.clone(),
        hue_key: rows::hue_role(BIRTHDAY_HUE),
        is_task: false,
    }));
    marks.extend(input.tasks_on(day).iter().map(|task| Mark {
        key: fold::task_key(task, day),
        title: input.task_title(task),
        hue_key: input.task_hue(task),
        is_task: true,
    }));
    marks.sort_by(|a, b| a.key.cmp(&b.key));
    marks
}

/// The month: its cells, its style, and under the list style the anchor's rows.
fn month(input: &Input, selected: Vec<wire::AgendaDaySection>) -> Option<wire::AgendaMonthGrid> {
    let locale = input.locale;
    let (first, count) = month_range(input.anchor, input.start)?;
    let listed = input.style == wire::AgendaMonthStyle::List;
    let shown_month = input.anchor.get(..7).unwrap_or_default();
    let cells: Vec<wire::AgendaMonthCell> = days_from(&first, count)
        .into_iter()
        .map(|day| {
            let marks = marks_of(input, &day);
            let (chips, more_label) = if listed {
                (Vec::new(), String::new())
            } else {
                let more = marks.len().saturating_sub(CHIPS);
                (
                    marks
                        .into_iter()
                        .take(CHIPS)
                        .map(|mark| wire::AgendaMonthChip {
                            title: mark.title,
                            hue_key: mark.hue_key,
                            is_task: mark.is_task,
                        })
                        .collect(),
                    if more > 0 {
                        format!("+{more}")
                    } else {
                        String::new()
                    },
                )
            };
            wire::AgendaMonthCell {
                day_number: day_number(&day),
                in_month: day.get(..7) == Some(shown_month),
                is_today: day == input.today,
                is_selected: day == input.anchor,
                chips,
                more_label,
                dot_hue_keys: if listed { input.dots(&day) } else { Vec::new() },
                opens: if listed { Dest::Month } else { Dest::Day } as i32,
                accessibility_label: input.spoken(&day),
                day,
            }
        })
        .collect();
    let rows = if listed { selected } else { Vec::new() };
    Some(wire::AgendaMonthGrid {
        title: rows::month_year(locale, input.anchor),
        weekday_labels: days_from(&first, 7)
            .iter()
            .map(|day| initial(locale, day))
            .collect(),
        cells,
        style: input.style as i32,
        styles: [
            (wire::AgendaMonthStyle::Grid, sayings::style_grid(locale)),
            (wire::AgendaMonthStyle::List, sayings::style_list(locale)),
        ]
        .into_iter()
        .map(|(style, label)| wire::AgendaMonthStyleChoice {
            style: style as i32,
            label,
            current: style == input.style,
        })
        .collect(),
        selected_empty: if listed && rows.is_empty() {
            words::empty_day(locale)
        } else {
            String::new()
        },
        selected: rows,
        previous_label: sayings::previous_month(locale),
        next_label: sayings::next_month(locale),
    })
}

// ---- the year --------------------------------------------------------------

/// The twelve months of the anchor's year, no events on them.
fn year(input: &Input) -> Option<wire::AgendaYearGrid> {
    let locale = input.locale;
    let (year, _) = year_month(input.anchor)?;
    let months = (1..=12)
        .map(|month| {
            let first = first_of(year, month);
            let (from, count) = month_range(&first, input.start)?;
            let stamp = first.get(..7).unwrap_or_default().to_owned();
            let current = input.today.get(..7) == Some(stamp.as_str());
            Some(wire::AgendaYearMonth {
                days: days_from(&from, count)
                    .into_iter()
                    .map(|day| {
                        let inside = day.get(..7) == Some(stamp.as_str());
                        wire::AgendaYearDay {
                            day_number: if inside {
                                day_number(&day)
                            } else {
                                String::new()
                            },
                            is_today: inside && day == input.today,
                            day,
                        }
                    })
                    .collect(),
                label: civil::month_name(locale, u32::try_from(month).unwrap_or(0)),
                is_current: current,
                first_day: if current {
                    input.today.to_owned()
                } else {
                    first.clone()
                },
                accessibility_label: rows::month_year(locale, &first),
                month: stamp,
            })
        })
        .collect::<Option<Vec<_>>>()?;
    Some(wire::AgendaYearGrid {
        title: format!("{year:04}"),
        months,
        previous_label: sayings::previous_year(locale),
        next_label: sayings::next_year(locale),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lanes_split_overlaps_and_reuse_a_free_lane() {
        // Two apart: each alone. Two that overlap: two lanes of two.
        assert_eq!(lanes(&[(540, 600), (660, 720)]), vec![(0, 1), (0, 1)]);
        assert_eq!(lanes(&[(540, 630), (600, 660)]), vec![(0, 2), (1, 2)]);
        // Touching is not overlapping.
        assert_eq!(lanes(&[(540, 600), (600, 660)]), vec![(0, 1), (0, 1)]);
    }

    #[test]
    fn nested_blocks_take_the_first_free_lane_and_share_the_cluster() {
        // A 09-12, B 10-11, C 10:30-11:30, then D at 11:45 inside A's run:
        // A lane 0; B lane 1; C lane 2; D reuses lane 1 (free since 11:00).
        let spans = [(540, 720), (600, 660), (630, 690), (705, 760)];
        assert_eq!(
            lanes(&spans),
            vec![(0, 3), (1, 3), (2, 3), (1, 3)],
            "one cluster of three lanes"
        );
        // The longer of two equal starts goes first, whatever the input order.
        assert_eq!(lanes(&[(600, 630), (600, 720)]), vec![(1, 2), (0, 2)]);
    }

    #[test]
    fn clusters_are_independent() {
        let spans = [(60, 120), (90, 150), (300, 360), (480, 540), (500, 520)];
        assert_eq!(lanes(&spans), vec![(0, 2), (1, 2), (0, 1), (0, 2), (1, 2)]);
    }

    #[test]
    fn a_block_is_clipped_and_never_under_fifteen_minutes() {
        assert_eq!(clip(600, 600), (600, 615));
        assert_eq!(clip(-30, 60), (0, 60));
        assert_eq!(clip(1430, 1500), (1425, 1440));
        assert_eq!(clip(0, 2000), (0, 1440));
    }

    #[test]
    fn minutes_snap_to_the_nearest_fifteen_inside_the_day() {
        assert_eq!(snap(0), 0);
        assert_eq!(snap(7), 0);
        assert_eq!(snap(8), 15);
        assert_eq!(snap(545), 540);
        assert_eq!(snap(553), 555);
        assert_eq!(snap(1439), 1425);
        assert_eq!(snap(5000), 1425);
        assert_eq!(snap(-40), 0);
    }

    #[test]
    fn the_region_picks_the_first_weekday() {
        for region in ["US", "us", "CA", "MX", "BR", "JP", "IL", "PH"] {
            assert_eq!(week_start_of(region), WeekStart::Sunday, "{region}");
        }
        for region in ["GB", "DE", "FR", "AU", ""] {
            assert_eq!(week_start_of(region), WeekStart::Monday, "{region}");
        }
        // Wednesday 4 November 2026.
        assert_eq!(
            week_first("2026-11-04", WeekStart::Monday).as_deref(),
            Some("2026-11-02")
        );
        assert_eq!(
            week_first("2026-11-04", WeekStart::Sunday).as_deref(),
            Some("2026-11-01")
        );
        assert_eq!(
            week_first("2026-11-01", WeekStart::Monday).as_deref(),
            Some("2026-10-26")
        );
        assert_eq!(
            week_first("2026-11-01", WeekStart::Sunday).as_deref(),
            Some("2026-11-01")
        );
    }

    #[test]
    fn a_month_draws_whole_weeks() {
        // November 2026 starts on a Sunday and ends on a Monday.
        assert_eq!(
            month_range("2026-11-17", WeekStart::Sunday),
            Some(("2026-11-01".to_owned(), 35))
        );
        assert_eq!(
            month_range("2026-11-17", WeekStart::Monday),
            Some(("2026-10-26".to_owned(), 42))
        );
        // February 2027 is 28 days from a Monday: four whole weeks.
        assert_eq!(
            month_range("2027-02-10", WeekStart::Monday),
            Some(("2027-02-01".to_owned(), 28))
        );
        assert_eq!(month_range("nope", WeekStart::Monday), None);
    }

    #[test]
    fn a_step_keeps_a_real_day() {
        assert_eq!(
            step(Dest::Day, "2026-11-30", 1).as_deref(),
            Some("2026-12-01")
        );
        assert_eq!(
            step(Dest::Week, "2026-11-30", -1).as_deref(),
            Some("2026-11-23")
        );
        assert_eq!(
            step(Dest::Month, "2026-03-31", 1).as_deref(),
            Some("2026-04-30")
        );
        assert_eq!(
            step(Dest::Month, "2026-01-31", -2).as_deref(),
            Some("2025-11-30")
        );
        assert_eq!(
            step(Dest::Year, "2028-02-29", 1).as_deref(),
            Some("2029-02-28")
        );
        assert_eq!(step(Dest::Schedule, "2026-11-30", 1), None);
    }

    #[test]
    fn a_wall_clock_round_trips_through_minutes() {
        let at = minutes_of("2026-11-04T23:45").expect("minutes");
        assert_eq!(local_of(at), "2026-11-04T23:45");
        assert_eq!(local_of(at + 30), "2026-11-05T00:15");
        assert_eq!(minutes_of("2026-11-04"), None);
    }

    /// What an [`Input`] borrows, owned by the test.
    struct Parts<'a> {
        by_day: BTreeMap<String, Vec<&'a wire::AgendaEvent>>,
        due_on: BTreeMap<&'a str, Vec<&'a wire::AgendaTask>>,
        birthdays: HashMap<String, Vec<&'a wire::AgendaBirthday>>,
        hues: Hues<'a>,
        tasks: rows::Context<'a>,
    }

    impl Parts<'_> {
        fn empty() -> Self {
            Self {
                by_day: BTreeMap::new(),
                due_on: BTreeMap::new(),
                birthdays: HashMap::new(),
                hues: Hues::of(&[]),
                tasks: rows::Context::of("2026-11-04", &[], &[]),
            }
        }

        fn view(&self, destination: Dest, anchor: &'static str, start: WeekStart) -> Input<'_> {
            Input {
                locale: Locale::En,
                destination,
                anchor,
                today: "2026-11-04",
                now: "2026-11-04T13:36",
                start,
                style: wire::AgendaMonthStyle::Grid,
                by_day: &self.by_day,
                due_on: &self.due_on,
                overdue: &[],
                birthdays: &self.birthdays,
                hues: &self.hues,
                tasks: &self.tasks,
            }
        }
    }

    fn event(id: &str, calendar: &str, start: &str, end: &str) -> wire::AgendaEvent {
        wire::AgendaEvent {
            event_id: id.to_owned(),
            instance_key: id.to_owned(),
            summary: Some(id.to_owned()),
            calendar_id: Some(calendar.to_owned()),
            local_start: start.to_owned(),
            local_end: end.to_owned(),
            ..wire::AgendaEvent::default()
        }
    }

    #[test]
    fn the_strip_is_seven_days_with_initials_and_at_most_three_dots() {
        let events = [
            event("a", "c1", "2026-11-04T09:00", "2026-11-04T10:00"),
            event("b", "c2", "2026-11-04T08:00", "2026-11-04T08:30"),
            event("c", "c3", "2026-11-04T11:00", "2026-11-04T12:00"),
            event("d", "c4", "2026-11-04T12:00", "2026-11-04T13:00"),
            event("e", "c1", "2026-11-04T14:00", "2026-11-04T15:00"),
        ];
        let mut parts = Parts::empty();
        parts
            .by_day
            .insert("2026-11-04".to_owned(), events.iter().collect());
        let strip =
            week_strip(&parts.view(Dest::Day, "2026-11-04", WeekStart::Monday)).expect("a strip");
        let days: Vec<&str> = strip.days.iter().map(|d| d.day.as_str()).collect();
        assert_eq!(days.len(), 7);
        assert_eq!((days[0], days[6]), ("2026-11-02", "2026-11-08"));
        let initials: String = strip
            .days
            .iter()
            .map(|d| d.weekday_initial.as_str())
            .collect();
        assert_eq!(initials, "MTWTFSS");
        let wednesday = &strip.days[2];
        assert!(wednesday.is_today && wednesday.is_selected && !wednesday.is_weekend);
        assert!(strip.days[5].is_weekend && strip.days[6].is_weekend);
        assert_eq!(wednesday.dot_hue_keys.len(), 3, "capped at three");
        // One per calendar, in the order they first start: c2 (08:00), c1, c3.
        let expected: Vec<String> = ["c2", "c1", "c3"]
            .iter()
            .map(|id| parts.hues.grid_hue(Some(id)))
            .collect();
        assert_eq!(wednesday.dot_hue_keys, expected);
        assert_eq!(wednesday.opens, Dest::Day as i32);
        assert_eq!(
            wednesday.accessibility_label,
            "Wednesday 4 November, 5 events"
        );

        let strip =
            week_strip(&parts.view(Dest::Day, "2026-11-04", WeekStart::Sunday)).expect("a strip");
        assert_eq!(strip.days[0].day, "2026-11-01");
        let initials: String = strip
            .days
            .iter()
            .map(|d| d.weekday_initial.as_str())
            .collect();
        assert_eq!(initials, "SMTWTFS");
    }

    #[test]
    fn the_hour_grid_places_blocks_and_chips() {
        let events = [
            event("a", "c1", "2026-11-04T09:00", "2026-11-04T10:00"),
            event("b", "c1", "2026-11-04T09:30", "2026-11-04T10:15"),
            event("c", "c1", "2026-11-04T13:00", ""),
            wire::AgendaEvent {
                all_day: true,
                ..event("d", "c1", "2026-11-04", "2026-11-04")
            },
            // Over midnight: 22:00 on the 4th to 02:00 on the 5th.
            event("n", "c1", "2026-11-04T22:00", "2026-11-05T02:00"),
        ];
        let timed = wire::AgendaTask {
            task_id: "t1".to_owned(),
            title: "Call".to_owned(),
            due_day: "2026-11-04".to_owned(),
            due_time: "09:15".to_owned(),
            ..wire::AgendaTask::default()
        };
        let untimed = wire::AgendaTask {
            task_id: "t2".to_owned(),
            title: "File".to_owned(),
            due_day: "2026-11-04".to_owned(),
            ..wire::AgendaTask::default()
        };
        let birthday = wire::AgendaBirthday {
            name: "Dana".to_owned(),
            month: 11,
            day: 4,
            ..wire::AgendaBirthday::default()
        };
        let mut parts = Parts::empty();
        parts
            .by_day
            .insert("2026-11-04".to_owned(), events.iter().collect());
        parts
            .by_day
            .insert("2026-11-05".to_owned(), vec![&events[4]]);
        parts.due_on.insert("2026-11-04", vec![&timed, &untimed]);
        parts.birthdays.insert("11-04".to_owned(), vec![&birthday]);
        let grid =
            time_grid(&parts.view(Dest::Day, "2026-11-04", WeekStart::Monday)).expect("a grid");
        assert_eq!(grid.hours.len(), 24);
        assert_eq!(grid.hours[9].label, "09:00");
        assert_eq!(grid.days.len(), 1);
        let column = &grid.days[0];
        let chips: Vec<&str> = column.all_day.iter().map(|c| c.key.as_str()).collect();
        assert_eq!(chips, ["event:d", "birthday:Dana", "task:t2"]);
        let by_key = |key: &str| {
            column
                .blocks
                .iter()
                .find(|b| b.key == format!("2026-11-04|{key}"))
                .unwrap_or_else(|| panic!("block {key}"))
        };
        // a (09:00-10:00), b (09:30-10:15) and the 30-minute task (09:15-09:45)
        // overlap: one cluster of three lanes.
        let (a, b, t) = (by_key("a"), by_key("b"), by_key("task:t1"));
        assert_eq!((a.column, a.columns), (0, 3));
        assert_eq!((t.column, t.columns), (1, 3));
        assert_eq!((b.column, b.columns), (2, 3));
        assert!(t.is_task && !t.movable && t.task_id == "t1");
        assert_eq!((t.start_minute, t.end_minute), (555, 585));
        assert!(a.movable && a.is_past, "morning is past at 13:36");
        // No end: a point, drawn fifteen minutes tall and alone.
        let c = by_key("c");
        assert_eq!((c.start_minute, c.end_minute, c.columns), (780, 795, 1));
        // The night run is clipped to midnight and cannot move.
        let n = by_key("n");
        assert_eq!((n.start_minute, n.end_minute), (1320, 1440));
        assert!(!n.movable && !n.is_past);
        assert_eq!(n.time_label, "From 22:00");
        // The now line, and the grid opens an hour above it.
        let now = grid.now.as_ref().expect("now");
        assert_eq!((now.minute, now.label.as_str()), (816, "13:36"));
        assert_eq!(grid.scroll_to_minute, 816 - 60);
        assert_eq!(grid.snap_minutes, 15);

        // The next day's part of the run: "Until 02:00", from the top.
        let week =
            time_grid(&parts.view(Dest::Week, "2026-11-05", WeekStart::Monday)).expect("a week");
        assert_eq!(week.days.len(), 7);
        assert_eq!(week.days[3].heading, "Thu\n5");
        let run = &week.days[3].blocks[0];
        assert_eq!((run.start_minute, run.end_minute), (0, 120));
        assert_eq!(run.time_label, "Until 02:00");
        assert!(!run.movable);
    }

    #[test]
    fn an_event_with_another_guest_is_not_draggable() {
        let mut solo = event("a", "c1", "2026-11-10T10:00", "2026-11-10T11:00");
        solo.attendees.push(wire::AgendaAttendee {
            is_you: true,
            ..wire::AgendaAttendee::default()
        });
        assert!(draggable(&solo));
        let mut guests = solo.clone();
        guests.attendees.push(wire::AgendaAttendee {
            party_id: "p2".to_owned(),
            ..wire::AgendaAttendee::default()
        });
        assert!(!draggable(&guests));
    }

    #[test]
    fn an_empty_grid_opens_at_eight_and_a_later_one_above_its_first_block() {
        let events = [event("a", "c1", "2026-11-10T10:30", "2026-11-10T11:00")];
        let mut parts = Parts::empty();
        let grid =
            time_grid(&parts.view(Dest::Day, "2026-11-10", WeekStart::Monday)).expect("a grid");
        assert_eq!(grid.scroll_to_minute, 480);
        assert!(grid.now.is_none());
        parts
            .by_day
            .insert("2026-11-10".to_owned(), events.iter().collect());
        let grid =
            time_grid(&parts.view(Dest::Day, "2026-11-10", WeekStart::Monday)).expect("a grid");
        assert_eq!(grid.scroll_to_minute, 630 - 60);
    }

    #[test]
    fn the_month_and_the_year_are_whole_weeks() {
        let parts = Parts::empty();
        let view = parts.view(Dest::Month, "2026-11-04", WeekStart::Sunday);
        let grid = month(&view, Vec::new()).expect("a month");
        assert_eq!(grid.title, "November 2026");
        assert_eq!(grid.cells.len(), 35);
        assert_eq!(grid.cells[0].day, "2026-11-01");
        assert!(grid.cells[0].in_month);
        assert!(!grid.cells[34].in_month, "5 December trails");
        assert_eq!(grid.weekday_labels.concat(), "SMTWTFS");
        assert!(grid.cells[3].is_today && grid.cells[3].is_selected);
        assert_eq!(grid.cells[3].opens, Dest::Day as i32);
        assert_eq!(grid.styles.len(), 2);
        assert!(grid.styles[0].current);
        let view = parts.view(Dest::Month, "2026-11-04", WeekStart::Monday);
        let grid = month(&view, Vec::new()).expect("a month");
        assert_eq!(grid.cells.len(), 42);
        assert_eq!(grid.cells[0].day, "2026-10-26");
        assert!(!grid.cells[0].in_month);
        assert_eq!(grid.cells[41].day, "2026-12-06");

        let grid = year(&view).expect("a year");
        assert_eq!(grid.title, "2026");
        assert_eq!(grid.months.len(), 12);
        let november = &grid.months[10];
        assert!(november.is_current);
        assert_eq!(november.first_day, "2026-11-04");
        assert_eq!(grid.months[0].first_day, "2026-01-01");
        // Whole weeks; days outside the month draw nothing.
        assert_eq!(november.days.len() % 7, 0);
        let drawn = november
            .days
            .iter()
            .filter(|d| !d.day_number.is_empty())
            .count();
        assert_eq!(drawn, 30);
        assert!(
            november.days[0].day_number.is_empty(),
            "26 October is blank"
        );
        assert_eq!(november.days.iter().filter(|d| d.is_today).count(), 1);
    }

    #[test]
    fn a_cell_shows_three_titles_and_counts_the_rest() {
        let events: Vec<wire::AgendaEvent> = (0..5)
            .map(|n| {
                event(
                    &format!("e{n}"),
                    "c1",
                    &format!("2026-11-10T{:02}:00", 9 + n),
                    &format!("2026-11-10T{:02}:30", 9 + n),
                )
            })
            .collect();
        let mut parts = Parts::empty();
        parts
            .by_day
            .insert("2026-11-10".to_owned(), events.iter().collect());
        let mut view = parts.view(Dest::Month, "2026-11-04", WeekStart::Sunday);
        let grid = month(&view, Vec::new()).expect("a month");
        let cell = grid
            .cells
            .iter()
            .find(|c| c.day == "2026-11-10")
            .expect("cell");
        assert_eq!(cell.chips.len(), 3);
        assert_eq!(cell.more_label, "+2");
        assert!(cell.dot_hue_keys.is_empty());
        view.style = wire::AgendaMonthStyle::List;
        let grid = month(&view, Vec::new()).expect("a month");
        let cell = grid
            .cells
            .iter()
            .find(|c| c.day == "2026-11-10")
            .expect("cell");
        assert!(cell.chips.is_empty() && cell.more_label.is_empty());
        assert_eq!(cell.dot_hue_keys.len(), 1);
        assert_eq!(cell.opens, Dest::Month as i32);
        assert_eq!(grid.selected_empty, "Nothing on this day.");
    }
}
