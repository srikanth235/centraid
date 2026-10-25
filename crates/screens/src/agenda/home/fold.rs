//! THE CORE'S ANSWERS, AS THE LIST A VIEW DRAWS (#1046, #1128).
//!
//! Pure, and over strings the core already placed in the device's zone: every
//! comparison is between `YYYY-MM-DD` and `YYYY-MM-DDTHH:MM` strings, which sort
//! as the instants they name, and the only arithmetic is civil
//! ([`crate::kit::civil`]).
//!
//! ## Which days
//!
//! - **Day**: the anchor, alone.
//! - **Schedule**: every day from the anchor for [`LIST_DAYS`] that has an
//!   event, a birthday or an open task due. Days before the anchor are not drawn.
//! - **Waiting**: the days of Schedule's window that hold an occurrence waiting
//!   on your reply, and only those occurrences. It draws no task.
//! - **A search term**: the days the hits fall on, wherever they are; a search
//!   finds, and a hit last month is still the answer. Search is an overlay on
//!   whichever tab was open and it covers every event: Waiting's filter does
//!   not narrow it (#1047). The tasks it found are one group above the days,
//!   and the projects whose own name it matched are containers above that
//!   (R-1097-19, Q-1128-1).
//!
//! ## Tasks are rows on their day (R-1128-2)
//!
//! An open task whose due day is the section's day is a row of it: untimed ones
//! right after the all-day events, timed ones among the timed rows by time, the
//! now line still placed among whatever has not started. Hidden calendars never
//! hide a task. Undated tasks are never here (they are To-do's). Day on today
//! also draws the Overdue group and the absence notice above the day
//! (R-1128-3); every other anchor draws none.
//!
//! A run over several days is a row on each; the upcoming answer is padded a
//! day either side (`held`), and `local_days` is what keeps a row to the days it
//! is on.

use std::collections::{BTreeMap, HashMap, HashSet};

use centraid_api_proto::core_v1 as wire;
use wire::AgendaDestination as Dest;

use super::held::{Held, span_of};
use super::search;
use crate::agenda::routes;
use crate::agenda::todo::rows;
use crate::kit::civil;
use crate::strings::{Locale, agenda as words, agenda_home as sentences, fill, task};

const CANCELLED: &str = "cancelled";
const NEEDS_ACTION: &str = "needs-action";
const MIDNIGHT: &str = "00:00";
const META_SEPARATOR: &str = " · ";
/// A party hue for an event on no calendar: neutral, and never a brand.
const NO_CALENDAR_HUE: &str = "cSlate";

/// What a fold reads besides the held answers.
pub struct Fold<'a> {
    pub locale: Locale,
    pub destination: Dest,
    pub anchor: &'a str,
    /// The trimmed term search is answering, when it is.
    pub term: Option<&'a str>,
    pub hidden: &'a [String],
    pub held: &'a Held,
}

/// The calendar's colour role by id: People's convention, so no view converts
/// a wheel word. A calendar that stores `var(--c-<hue>)` gets that hue; one that
/// stores nothing, or a colour the wheel cannot name, gets its id's own.
struct Hues<'a> {
    stored: HashMap<&'a str, Option<&'a str>>,
}

impl<'a> Hues<'a> {
    fn of(calendars: &'a [wire::AgendaCalendar]) -> Self {
        Self {
            stored: calendars
                .iter()
                .map(|calendar| (calendar.calendar_id.as_str(), calendar.color.as_deref()))
                .collect(),
        }
    }

    fn hue(&self, id: Option<&str>) -> String {
        let Some(id) = id else {
            return NO_CALENDAR_HUE.to_owned();
        };
        let stored = self.stored.get(id).copied().flatten();
        let key = centraid_design::party_hue_key(id, stored)
            .unwrap_or_else(|| centraid_design::identity_hue_key(id));
        rows::hue_role(key)
    }
}

/// One row on a day: an event or a task, and the key it sorts by.
enum Slot<'a> {
    Event(&'a wire::AgendaEvent, String),
    Task(&'a wire::TasksTask, String),
}

impl Slot<'_> {
    fn sort(&self) -> &str {
        match self {
            Self::Event(_, key) | Self::Task(_, key) => key,
        }
    }
}

/// The data for any place but To-do (or To-do under a search), or `None` when
/// the answers it folds are not held.
#[must_use]
pub fn events(fold: &Fold) -> Option<wire::AgendaHomeData> {
    let locale = fold.locale;
    let held = fold.held;
    let upcoming = held.upcoming.as_ref()?;
    let context = held.context.as_ref()?;
    let today = if context.today.is_empty() {
        upcoming.today.as_str()
    } else {
        context.today.as_str()
    };
    let now = if context.now_local.is_empty() {
        upcoming.now_local.as_str()
    } else {
        context.now_local.as_str()
    };
    let anchor = if fold.anchor.is_empty() {
        today
    } else {
        fold.anchor
    };
    let search = fold.term.and(held.search.as_ref());
    // THE HITS ARE EVERY EVENT: while they read, the tab's own rows stay.
    let waiting_only = search.is_none() && fold.destination == Dest::Waiting;
    let span = span_of(fold.destination);
    let window: Vec<String> = (0..span)
        .filter_map(|n| civil::plus_days(anchor, n))
        .collect();
    let in_window: HashSet<&str> = window.iter().map(String::as_str).collect();

    let shown = |event: &wire::AgendaEvent| {
        event
            .calendar_id
            .as_ref()
            .is_none_or(|id| !fold.hidden.contains(id))
    };
    let hues = Hues::of(&upcoming.calendars);

    // A REPEATING HIT IS ITS NEXT OCCURRENCE (#1047, R-1047-Q6): drawn on that
    // day and opened by that occurrence's key, never the series' anchor years back.
    let moved: Vec<wire::AgendaEvent>;
    let source: &[wire::AgendaEvent] = match search {
        Some(hits) => {
            moved = hits.events.iter().map(at_next_occurrence).collect();
            &moved
        }
        None => &upcoming.events,
    };
    let visible: Vec<&wire::AgendaEvent> = source
        .iter()
        .filter(|event| shown(event))
        .filter(|event| !waiting_only || waits_on_you(event))
        .collect();

    // EVERY DAY A ROW IS ON, in the window unless it is a search hit.
    let mut by_day: BTreeMap<String, Vec<&wire::AgendaEvent>> = BTreeMap::new();
    for event in &visible {
        for day in days_of(event) {
            if search.is_some() || in_window.contains(day.as_str()) {
                by_day.entry(day).or_default().push(event);
            }
        }
    }

    // TASKS DUE ON A DAY of the window: Day and Schedule only, and never under
    // a search or Waiting.
    let dated =
        search.is_none() && !waiting_only && matches!(fold.destination, Dest::Day | Dest::Schedule);
    let (projects, sections) = held.projects_of();
    let mut task_ctx = rows::Context::of(today, projects, sections);
    // THE DAY'S HEAD NAMES THE DAY, so a row says its time only.
    task_ctx.day_in_head = true;
    let due_on = if dated {
        tasks_by_day(held, &in_window)
    } else {
        BTreeMap::new()
    };

    // DAY CONTEXT DECORATES; it never makes a Waiting day or a search day.
    let birthdays: HashMap<String, Vec<&wire::AgendaBirthday>> =
        context
            .birthdays
            .iter()
            .fold(HashMap::new(), |mut acc, birthday| {
                acc.entry(format!("{:02}-{:02}", birthday.month, birthday.day))
                    .or_default()
                    .push(birthday);
                acc
            });
    let mut days: Vec<String> = by_day.keys().cloned().collect();
    if search.is_none() && !waiting_only {
        for day in &window {
            let decorated = birthdays.contains_key(day.get(5..).unwrap_or_default())
                || due_on.contains_key(day.as_str());
            if decorated && !days.contains(day) {
                days.push(day.clone());
            }
        }
    }
    days.sort();

    let mut shown_month = anchor.get(..7).unwrap_or_default().to_owned();
    let mut sections_out = Vec::new();
    for day in &days {
        let names: Vec<String> = birthdays
            .get(day.get(5..).unwrap_or_default())
            .map(|found| found.iter().map(|b| b.name.clone()).collect())
            .unwrap_or_default();
        let month = day.get(..7).unwrap_or_default().to_owned();
        let month_heading = (month != shown_month).then(|| rows::month_year(locale, day));
        shown_month = month;
        let events_here = by_day.get(day).map_or(&[][..], Vec::as_slice);
        let tasks_here = due_on.get(day.as_str()).map_or(&[][..], Vec::as_slice);
        sections_out.push(wire::AgendaDaySection {
            day: day.clone(),
            day_number: civil::day_of_month_of(day)
                .map(|n| n.to_string())
                .unwrap_or_default(),
            weekday_short: civil::weekday_short(locale, day),
            heading: if day == today {
                words::today(locale)
            } else {
                civil::day_month(locale, day)
            },
            is_today: day == today,
            is_past: day.as_str() < today,
            month_heading,
            ribbon: match names.len() {
                0 => None,
                1 => Some(names[0].clone()),
                n => Some(format!("{n} {}", words::ribbon_birthdays(locale))),
            },
            ribbon_names: names,
            items: items(
                locale,
                day,
                events_here,
                tasks_here,
                today,
                now,
                &hues,
                &task_ctx,
            ),
        });
    }

    // THE OVERDUE GROUP AND THE ABSENCE NOTICE: Day on today, and nowhere else.
    let on_today = dated && fold.destination == Dest::Day && anchor == today;
    let overdue = on_today
        .then(|| overdue_group(locale, held, &task_ctx))
        .flatten();
    let notice = on_today.then(|| notice_of(locale, held)).flatten();
    // THE TASKS THE TERM FOUND (R-1128-4): one group above the event days; and
    // THE PROJECTS THE TERM NAMED (R-1097-19, Q-1128-1), above those.
    let task_hits = if fold.term.is_some() {
        search::hits_group(locale, held, &task_ctx)
    } else {
        None
    };
    let containers = if fold.term.is_some() {
        search::containers(locale, held)
    } else {
        Vec::new()
    };

    let drawn: HashSet<&str> = sections_out
        .iter()
        .flat_map(|section| &section.items)
        .filter_map(|item| match &item.kind {
            Some(wire::agenda_row_item::Kind::Event(row)) => Some(row.instance_key.as_str()),
            _ => None,
        })
        .collect();
    let event_count = drawn.len();
    let waiting_count = upcoming
        .events
        .iter()
        .filter(|event| shown(event))
        .filter(|event| {
            waits_on_you(event)
                && days_of(event)
                    .iter()
                    .any(|d| in_window.contains(d.as_str()))
        })
        .map(|event| event.instance_key.as_str())
        .collect::<HashSet<_>>()
        .len();
    let landing = sections_out
        .iter()
        .find(|section| section.is_today)
        .or_else(|| sections_out.iter().find(|section| !section.is_past))
        .map(|section| wire::AgendaLanding {
            day: section.day.clone(),
            now_line: section
                .items
                .iter()
                .any(|item| matches!(item.kind, Some(wire::agenda_row_item::Kind::NowLine(_)))),
        })
        .unwrap_or_default();

    // "NOTHING ON THIS DAY" IS FOR A DAY WITH NEITHER EVENTS NOR TASKS: Day on
    // today that draws an Overdue group or the absence notice has something on
    // it, so it says nothing (R-1128-3). A day whose only task was just checked
    // off draws no row and no group, and there the sentence is right.
    let empty = if !sections_out.is_empty() || overdue.is_some() || notice.is_some() {
        wire::AgendaEmpty::None
    } else if fold.term.is_some() {
        // A PROJECT FOUND BY NAME IS AN ANSWER too: no "nothing matches" over it.
        if task_hits.is_some() || !containers.is_empty() {
            wire::AgendaEmpty::None
        } else {
            wire::AgendaEmpty::NoMatch
        }
    } else if waiting_only {
        wire::AgendaEmpty::NothingWaiting
    } else if fold.destination == Dest::Schedule
        && fold.hidden.is_empty()
        && upcoming.events.is_empty()
    {
        wire::AgendaEmpty::DayOne
    } else {
        wire::AgendaEmpty::NothingOnDay
    };
    let (empty_title, empty_body, empty_action) = match empty {
        wire::AgendaEmpty::DayOne => (
            words::empty_day_one_title(locale),
            words::empty_day_one_body(locale),
            words::new_event(locale),
        ),
        wire::AgendaEmpty::NoMatch => (
            words::empty_no_match(locale),
            words::empty_no_match_body(locale),
            String::new(),
        ),
        wire::AgendaEmpty::NothingWaiting => {
            (words::empty_waiting(locale), String::new(), String::new())
        }
        wire::AgendaEmpty::NothingOnDay => (
            if span == 1 {
                words::empty_day(locale)
            } else {
                words::empty_days(locale)
            },
            String::new(),
            String::new(),
        ),
        _ => (String::new(), String::new(), String::new()),
    };

    Some(wire::AgendaHomeData {
        today: today.to_owned(),
        now_local: now.to_owned(),
        days: sections_out,
        empty: empty as i32,
        empty_title,
        empty_body,
        empty_action,
        // NO EVENT OF THE MEMBER'S YET, AND THE PHONE ALREADY HOLDS A CALENDAR:
        // the import is offered, where the shell can read one. Not "day one"
        // alone: a first vault's starter tasks and an imported contact's
        // birthday fill the list with marks, and an offer keyed on an empty
        // screen would never be seen.
        import_source: if fold.term.is_none()
            && fold.hidden.is_empty()
            && upcoming.events.is_empty()
        {
            wire::ImportSource::Calendar as i32
        } else {
            wire::ImportSource::Unspecified as i32
        },
        calendars: upcoming
            .calendars
            .iter()
            .map(|calendar| {
                let hidden = fold.hidden.contains(&calendar.calendar_id);
                wire::AgendaCalendarChoice {
                    calendar_id: calendar.calendar_id.clone(),
                    name: calendar
                        .name
                        .as_ref()
                        .filter(|name| !name.trim().is_empty())
                        .cloned()
                        .unwrap_or_else(|| words::calendar_unnamed(locale)),
                    hue_key: hues.hue(Some(&calendar.calendar_id)),
                    hidden,
                    state_label: if hidden {
                        words::calendar_hidden(locale)
                    } else {
                        words::calendar_shown(locale)
                    },
                }
            })
            .collect(),
        overdue,
        notice,
        task_hits: task_hits.into_iter().collect(),
        containers,
        waiting_count: u32::try_from(waiting_count).unwrap_or(u32::MAX),
        event_count: u32::try_from(event_count).unwrap_or(u32::MAX),
        event_count_label: sentences::event_count(locale, event_count as u64),
        landing: Some(landing),
        catch_up: Some(routes::catch_up()),
        todo: None,
    })
}

/// A search hit moved onto the occurrence the core names (`next_instance_key`,
/// `next_original_start_local`, `next_local_start`): its keys are that
/// occurrence's, and its days shift by whole days from the series' anchor to it,
/// so the row sits on the day it opens. A hit with no next occurrence (a
/// one-off, or none in reach) is itself.
fn at_next_occurrence(event: &wire::AgendaEvent) -> wire::AgendaEvent {
    if event.next_instance_key.is_empty() || event.next_local_start.len() < 10 {
        return event.clone();
    }
    let from = civil::epoch_day_of(event.local_start.get(..10).unwrap_or_default());
    let to = civil::epoch_day_of(event.next_local_start.get(..10).unwrap_or_default());
    let shift = from.zip(to).map_or(0, |(from, to)| to - from);
    let moved = |stamp: &str| -> String {
        let Some(day) = stamp.get(..10) else {
            return stamp.to_owned();
        };
        let shifted = civil::plus_days(day, shift).unwrap_or_else(|| day.to_owned());
        format!("{shifted}{}", stamp.get(10..).unwrap_or_default())
    };
    let mut next = event.clone();
    next.instance_key.clone_from(&event.next_instance_key);
    next.original_start_local = Some(if event.next_original_start_local.is_empty() {
        event.original_start_local.clone().unwrap_or_default()
    } else {
        event.next_original_start_local.clone()
    })
    .filter(|original| !original.is_empty());
    next.local_start.clone_from(&event.next_local_start);
    next.local_end = moved(&event.local_end);
    next.local_days = event.local_days.iter().map(|stamp| moved(stamp)).collect();
    next
}

/// One day's rows: all-day first, the day's untimed tasks right after them,
/// then what runs in from a day before, then the timed events and tasks by
/// start, and on today the now line before the first row that has not started
/// (a list has no time axis, so "between the last row under way and the next"
/// is where now is).
#[allow(clippy::too_many_arguments)]
fn items(
    locale: Locale,
    day: &str,
    events: &[&wire::AgendaEvent],
    tasks: &[&wire::TasksTask],
    today: &str,
    now: &str,
    hues: &Hues,
    task_ctx: &rows::Context,
) -> Vec<wire::AgendaRowItem> {
    // EVENTS FIRST, so a task at the same minute sorts after them (the sort is stable).
    let mut ordered: Vec<Slot> = events
        .iter()
        .map(|event| Slot::Event(event, event_key(event, day)))
        .chain(
            tasks
                .iter()
                .map(|task| Slot::Task(task, task_key(task, day))),
        )
        .collect();
    ordered.sort_by(|a, b| a.sort().cmp(b.sort()));
    let mut out: Vec<wire::AgendaRowItem> = ordered
        .iter()
        .map(|slot| wire::AgendaRowItem {
            kind: Some(match slot {
                Slot::Event(event, _) => wire::agenda_row_item::Kind::Event(event_row(
                    locale, day, event, today, now, hues,
                )),
                Slot::Task(task, _) => {
                    wire::agenda_row_item::Kind::Task(rows::row(locale, task, task_ctx, false))
                }
            }),
        })
        .collect();
    if day != today {
        return out;
    }
    let at = ordered
        .iter()
        .position(|slot| match slot {
            Slot::Event(event, _) => {
                !event.all_day && start_day(event) == day && event.local_start.as_str() > now
            }
            Slot::Task(task, _) => {
                !task.due_time.is_empty() && format!("{day}T{}", task.due_time).as_str() > now
            }
        })
        .unwrap_or(ordered.len());
    let clock = civil::clock(now);
    out.insert(
        at,
        wire::AgendaRowItem {
            kind: Some(wire::agenda_row_item::Kind::NowLine(wire::AgendaNowLine {
                accessibility_label: format!("{}, {clock}", words::now(locale)),
                label: clock,
            })),
        },
    );
    out
}

/// All-day "0", then (see [`task_key`]) "01", what runs in from before "1", the
/// rest by start.
fn event_key(event: &wire::AgendaEvent, day: &str) -> String {
    if event.all_day {
        "0".to_owned()
    } else if start_day(event) < day {
        "1".to_owned()
    } else {
        format!("2{}", event.local_start)
    }
}

/// Untimed right after the all-day rows; timed among the timed ones, by time.
fn task_key(task: &wire::TasksTask, day: &str) -> String {
    if task.due_time.is_empty() {
        "01".to_owned()
    } else {
        format!("2{day}T{}", task.due_time)
    }
}

/// THE OPEN TASKS DUE ON EACH DAY OF THE WINDOW, in the core's order: the TODAY
/// board (overdue work belongs to the day it was due, and shows there only when
/// that day is in the window; today's own Overdue group draws it otherwise) and
/// the UPCOMING board's days.
fn tasks_by_day<'a>(
    held: &'a Held,
    window: &HashSet<&str>,
) -> BTreeMap<&'a str, Vec<&'a wire::TasksTask>> {
    let mut seen = HashSet::new();
    let mut out: BTreeMap<&str, Vec<&wire::TasksTask>> = BTreeMap::new();
    let boards = [&held.today_board, &held.upcoming_board];
    for group in boards.into_iter().flatten().flat_map(|board| &board.groups) {
        let kind =
            wire::TasksGroupKind::try_from(group.kind).unwrap_or(wire::TasksGroupKind::Unspecified);
        if !matches!(
            kind,
            wire::TasksGroupKind::Overdue | wire::TasksGroupKind::Today | wire::TasksGroupKind::Day
        ) {
            continue;
        }
        for task in &group.tasks {
            if window.contains(task.due_day.as_str())
                && rows::is_open(task)
                && seen.insert(task.task_id.as_str())
            {
                out.entry(task.due_day.as_str()).or_default().push(task);
            }
        }
    }
    out
}

/// The TODAY board's Overdue group, finished: its rows, its count and the
/// "Reschedule" verb. THE HEAD NAMES NO DAY, so each row says how long ago.
fn overdue_group(locale: Locale, held: &Held, ctx: &rows::Context) -> Option<wire::TodoRowGroup> {
    let board = held.today_board.as_ref()?;
    let group = board
        .groups
        .iter()
        .find(|group| group.kind == wire::TasksGroupKind::Overdue as i32)?;
    rows::groups(locale, std::slice::from_ref(group), ctx)
        .into_iter()
        .next()
}

/// "You were away 16 days; 34 tasks came due", when the core names an absence.
fn notice_of(locale: Locale, held: &Held) -> Option<wire::TodoNotice> {
    let catch_up = held.catch_up.as_ref().filter(|catch_up| catch_up.absent)?;
    let template = if catch_up.overdue == 1 {
        sentences::away_notice_one(locale)
    } else {
        sentences::away_notice_many(locale)
    };
    Some(wire::TodoNotice {
        sentence: fill(
            &template,
            &[
                ("days", &catch_up.away_days.to_string()),
                ("n", &catch_up.overdue.to_string()),
            ],
        ),
        verb_label: task::catch_up(locale),
        verb_key: rows::VERB_CATCH_UP.to_owned(),
    })
}

fn event_row(
    locale: Locale,
    day: &str,
    event: &wire::AgendaEvent,
    today: &str,
    now: &str,
    hues: &Hues,
) -> wire::AgendaEventRow {
    let title = event
        .summary
        .as_ref()
        .filter(|summary| !summary.trim().is_empty())
        .cloned()
        .unwrap_or_else(|| words::untitled(locale));
    let (time_label, spoken) = time_of(locale, event, day);
    let meta = meta_of(locale, event);
    let (status, status_label) = if waits_on_you(event) {
        (
            wire::AgendaRowStatus::NeedsReply,
            words::status_needs_reply(locale),
        )
    } else {
        (wire::AgendaRowStatus::None, String::new())
    };
    let accessibility_label = [title.clone(), spoken]
        .into_iter()
        .chain(meta.iter().cloned())
        .chain(std::iter::once(status_label.clone()))
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(", ");
    wire::AgendaEventRow {
        event_id: event.event_id.clone(),
        instance_key: event.instance_key.clone(),
        original_start_local: event.original_start_local.clone(),
        row_key: format!("{day}|{}", event.instance_key),
        title,
        time_label,
        meta: meta.join(META_SEPARATOR),
        calendar_hue_key: hues.hue(event.calendar_id.as_deref()),
        status: status as i32,
        status_label,
        accessibility_label,
        is_past: day < today || ended(event, today, now),
        route: Some(routes::event(
            &event.event_id,
            &event.instance_key,
            event.original_start_local.as_deref(),
            day,
        )),
    }
}

/// What a row says for its time on `day`, and how it is spoken.
///
/// An all-day row is "All day": a day has no 00:00 (#1046, a v0 defect not
/// carried). A timed run's end is EXCLUSIVE, so one ending at the next local
/// midnight still ends on `day`.
fn time_of(locale: Locale, event: &wire::AgendaEvent, day: &str) -> (String, String) {
    if event.all_day {
        return (words::all_day(locale), words::all_day(locale));
    }
    let start = civil::clock(&event.local_start);
    let starts_here = start_day(event) >= day;
    let end = event.local_end.as_str();
    let end_day = end.get(..10).unwrap_or_default();
    let end_clock = civil::clock(end);
    let ends_here = end.is_empty()
        || end_day <= day
        || (civil::plus_days(day, 1).as_deref() == Some(end_day) && end_clock == MIDNIGHT);
    if starts_here && (end.is_empty() || end == event.local_start) {
        (start.clone(), start)
    } else if starts_here && ends_here {
        (
            format!("{start} – {end_clock}"),
            format!("{start} {} {end_clock}", words::spoken_to(locale)),
        )
    } else if starts_here {
        let said = format!("{} {start}", words::from(locale));
        (said.clone(), said)
    } else if ends_here {
        let said = format!("{} {end_clock}", words::until(locale));
        (said.clone(), said)
    } else {
        (words::continues(locale), words::continues(locale))
    }
}

/// "repeats · 2 guests · call". "repeats" on EVERY occurrence of a series:
/// `recurrence_summary` is present on all of them (#1046). A guest is anyone on
/// the event but you.
fn meta_of(locale: Locale, event: &wire::AgendaEvent) -> Vec<String> {
    let guests = event.attendees.iter().filter(|guest| !guest.is_you).count();
    let mut meta = Vec::new();
    if event.recurrence_summary.is_some() {
        meta.push(words::meta_repeats(locale));
    }
    if guests > 0 {
        let noun = if guests == 1 {
            words::meta_guest(locale)
        } else {
            words::meta_guests(locale)
        };
        meta.push(format!("{guests} {noun}"));
    }
    if event
        .conferencing_uri
        .as_ref()
        .is_some_and(|uri| !uri.trim().is_empty())
    {
        meta.push(words::meta_call(locale));
    }
    meta
}

/// WAITING ON YOU: you are a guest (`is_you`, the vault's own owner, never a
/// guess) and have not answered (no reply, or `needs-action`) on an event that
/// is not cancelled.
fn waits_on_you(event: &wire::AgendaEvent) -> bool {
    event.status.as_deref() != Some(CANCELLED)
        && event.attendees.iter().any(|guest| {
            guest.is_you && (guest.partstat.is_empty() || guest.partstat == NEEDS_ACTION)
        })
}

/// HAS IT ENDED, on the answer's clock.
fn ended(event: &wire::AgendaEvent, today: &str, now: &str) -> bool {
    if event.all_day {
        let last = if event.local_end.is_empty() {
            &event.local_start
        } else {
            &event.local_end
        };
        last.get(..10).unwrap_or_default() < today
    } else if event.local_end.is_empty() {
        event.local_start.as_str() < now
    } else {
        event.local_end.as_str() <= now
    }
}

fn days_of(event: &wire::AgendaEvent) -> Vec<String> {
    if event.local_days.is_empty() {
        event
            .local_start
            .get(..10)
            .map(str::to_owned)
            .into_iter()
            .collect()
    } else {
        event.local_days.clone()
    }
}

fn start_day(event: &wire::AgendaEvent) -> &str {
    event.local_start.get(..10).unwrap_or_default()
}

/// `Wednesday 11 March`, or the input when it is not a day.
#[must_use]
pub fn long_day(locale: Locale, day: &str) -> String {
    let weekday = match civil::iso_weekday_of(day) {
        Some(1) => words::weekday_full_mon(locale),
        Some(2) => words::weekday_full_tue(locale),
        Some(3) => words::weekday_full_wed(locale),
        Some(4) => words::weekday_full_thu(locale),
        Some(5) => words::weekday_full_fri(locale),
        Some(6) => words::weekday_full_sat(locale),
        Some(7) => words::weekday_full_sun(locale),
        _ => return day.to_owned(),
    };
    format!(
        "{weekday} {} {}",
        civil::day_of_month_of(day).unwrap_or_default(),
        civil::month_of(locale, day)
    )
}

#[cfg(test)]
mod tests {
    //! The fold over fixtures the vault cannot make: a fixed clock (Monday 15
    //! June 2026, 09:42), calendars with stored colours, a guest list with every
    //! reply, and the core's answers as the core would word them.

    use super::*;

    const TODAY: &str = "2026-06-15";
    const NOW: &str = "2026-06-15T09:42";

    fn timed(id: &str, summary: &str, start: &str, end: Option<&str>) -> wire::AgendaEvent {
        let first = start[..10].to_owned();
        let last = match end {
            None => first.clone(),
            Some(end) if &end[11..] == "00:00" => civil::plus_days(&end[..10], -1).unwrap(),
            Some(end) => end[..10].to_owned(),
        };
        let mut days = vec![first.clone()];
        while days.last().unwrap() < &last {
            days.push(civil::plus_days(days.last().unwrap(), 1).unwrap());
        }
        wire::AgendaEvent {
            event_id: id.to_owned(),
            instance_key: id.to_owned(),
            summary: Some(summary.to_owned()),
            calendar_id: Some("cal-1".to_owned()),
            local_start: start.to_owned(),
            local_end: end.unwrap_or_default().to_owned(),
            local_days: days,
            ..wire::AgendaEvent::default()
        }
    }

    fn guest(partstat: &str, you: bool) -> wire::AgendaAttendee {
        wire::AgendaAttendee {
            party_id: if you {
                "me".to_owned()
            } else {
                "dana".to_owned()
            },
            name: if you {
                "You".to_owned()
            } else {
                "Dana".to_owned()
            },
            partstat: partstat.to_owned(),
            is_you: you,
        }
    }

    fn held_of(events: Vec<wire::AgendaEvent>) -> Held {
        Held {
            upcoming: Some(wire::AgendaUpcoming {
                events,
                calendars: vec![
                    wire::AgendaCalendar {
                        calendar_id: "cal-1".to_owned(),
                        name: Some("Personal".to_owned()),
                        color: Some("var(--c-teal)".to_owned()),
                    },
                    wire::AgendaCalendar {
                        calendar_id: "cal-2".to_owned(),
                        name: Some("Work".to_owned()),
                        color: Some("steelblue".to_owned()),
                    },
                ],
                today: TODAY.to_owned(),
                now_local: NOW.to_owned(),
            }),
            context: Some(wire::AgendaDayContext {
                today: TODAY.to_owned(),
                now_local: NOW.to_owned(),
                ..wire::AgendaDayContext::default()
            }),
            ..Held::default()
        }
    }

    fn fold_of(held: &Held, destination: Dest, hidden: &[String]) -> wire::AgendaHomeData {
        events(&Fold {
            locale: Locale::En,
            destination,
            anchor: TODAY,
            term: None,
            hidden,
            held,
        })
        .unwrap()
    }

    /// The invitations of the status test: unanswered, needs-action, accepted, none.
    fn data_events() -> Vec<wire::AgendaEvent> {
        vec![
            wire::AgendaEvent {
                attendees: vec![guest("", true)],
                ..timed("empty", "Asked, no reply", "2026-06-16T08:00", None)
            },
            wire::AgendaEvent {
                attendees: vec![guest("needs-action", true)],
                ..timed("action", "Needs action", "2026-06-16T09:00", None)
            },
            wire::AgendaEvent {
                attendees: vec![guest("accepted", true)],
                ..timed("said", "Accepted", "2026-06-16T10:00", None)
            },
            timed("held", "Held", "2026-06-16T12:00", None),
        ]
    }

    fn rows_of(data: &wire::AgendaHomeData) -> Vec<&wire::AgendaEventRow> {
        data.days
            .iter()
            .flat_map(|day| &day.items)
            .filter_map(|item| match &item.kind {
                Some(wire::agenda_row_item::Kind::Event(row)) => Some(row),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn the_status_chip_is_your_own_unanswered_invitation_and_a_cancelled_event_waits_on_nobody() {
        let mut cancelled = timed("cancel", "Cancelled ask", "2026-06-16T13:00", None);
        cancelled.status = Some("cancelled".to_owned());
        cancelled.attendees = vec![guest("", true)];
        let mut events = data_events();
        events.push(wire::AgendaEvent {
            attendees: vec![guest("", false)],
            ..timed("theirs", "Theirs", "2026-06-16T11:00", None)
        });
        events.push(cancelled);
        let data = fold_of(&held_of(events), Dest::Schedule, &[]);
        let status: Vec<(&str, &str)> = rows_of(&data)
            .iter()
            .map(|row| (row.event_id.as_str(), row.status_label.as_str()))
            .collect();
        assert_eq!(
            status,
            [
                ("empty", "needs a reply"),
                ("action", "needs a reply"),
                ("said", ""),
                ("theirs", ""),
                ("held", ""),
                ("cancel", ""),
            ]
        );
        assert_eq!(data.waiting_count, 2);
        // Waiting keeps the two, and only them.
        let waiting = fold_of(&held_of(data_events()), Dest::Waiting, &[]);
        assert_eq!(
            rows_of(&waiting)
                .iter()
                .map(|row| row.event_id.as_str())
                .collect::<Vec<_>>(),
            ["empty", "action"]
        );
    }

    #[test]
    fn a_birthday_is_a_ribbon_one_name_or_a_count_and_never_a_row() {
        let mut held = held_of(vec![timed("a", "Stand-up", "2026-06-15T10:00", None)]);
        let birthday = |id: &str, name: &str, day: i32| wire::AgendaBirthday {
            party_id: id.to_owned(),
            name: name.to_owned(),
            month: 6,
            day,
            tier: 0,
        };
        held.context.as_mut().unwrap().birthdays = vec![
            birthday("p1", "Dana", 16),
            birthday("p2", "Ada", 18),
            birthday("p3", "Bo", 18),
            birthday("p4", "Cy", 18),
        ];
        let data = fold_of(&held, Dest::Schedule, &[]);
        let day = |d: &str| data.days.iter().find(|section| section.day == d).unwrap();
        assert_eq!(day("2026-06-16").ribbon.as_deref(), Some("Dana"));
        assert_eq!(day("2026-06-18").ribbon.as_deref(), Some("3 birthdays"));
        assert_eq!(day("2026-06-18").ribbon_names, ["Ada", "Bo", "Cy"]);
        assert!(day("2026-06-18").items.is_empty());
        assert!(day("2026-06-15").ribbon.is_none());
        // A BIRTHDAY DOES NOT MAKE A WAITING DAY.
        assert!(fold_of(&held, Dest::Waiting, &[]).days.is_empty());
    }

    #[test]
    fn a_calendars_hue_is_its_stored_wheel_hue_else_its_ids_own_and_no_calendar_is_slate() {
        let mut open = timed("n", "No calendar", "2026-06-16T09:00", None);
        open.calendar_id = None;
        let data = fold_of(
            &held_of(vec![timed("a", "Mine", "2026-06-16T08:00", None), open]),
            Dest::Schedule,
            &[],
        );
        assert_eq!(data.calendars[0].hue_key, "cTeal");
        assert_eq!(
            data.calendars[1].hue_key,
            rows::hue_role(centraid_design::identity_hue_key("cal-2")),
            "steelblue is no hue the wheel names"
        );
        let hues: Vec<&str> = rows_of(&data)
            .iter()
            .map(|row| row.calendar_hue_key.as_str())
            .collect();
        assert_eq!(hues, ["cTeal", "cSlate"]);
    }

    #[test]
    fn todays_rows_at_a_fixed_clock_all_day_first_the_now_line_before_the_first_not_started() {
        let mut bank = timed("bank", "Bank holiday", TODAY, None);
        bank.all_day = true;
        bank.local_start = TODAY.to_owned();
        bank.local_end = TODAY.to_owned();
        let data = fold_of(
            &held_of(vec![
                timed("early", "Run", "2026-06-15T07:00", Some("2026-06-15T08:00")),
                bank,
                timed(
                    "late",
                    "Survey walk-through",
                    "2026-06-15T10:00",
                    Some("2026-06-15T11:30"),
                ),
                timed("now", "Call", "2026-06-15T09:30", Some("2026-06-15T10:00")),
            ]),
            Dest::Day,
            &[],
        );
        let section = &data.days[0];
        let order: Vec<String> = section
            .items
            .iter()
            .map(|item| match &item.kind {
                Some(wire::agenda_row_item::Kind::Event(row)) => row.title.clone(),
                _ => "NOW".to_owned(),
            })
            .collect();
        assert_eq!(
            order,
            ["Bank holiday", "Run", "Call", "NOW", "Survey walk-through"]
        );
        let past: Vec<(&str, bool)> = rows_of(&data)
            .iter()
            .map(|row| (row.title.as_str(), row.is_past))
            .collect();
        assert_eq!(
            past,
            [
                ("Bank holiday", false),
                ("Run", true),
                ("Call", false),
                ("Survey walk-through", false)
            ]
        );
        assert_eq!(data.event_count_label, "4 events");
        let landing = data.landing.unwrap();
        assert!(landing.now_line && landing.day == TODAY);
    }

    #[test]
    fn a_repeating_hit_is_its_next_occurrence_drawn_on_that_day_and_opened_by_its_key() {
        let mut series = timed(
            "series",
            "Survey",
            "2026-01-06T08:15",
            Some("2026-01-06T09:45"),
        );
        series.instance_key = "series".to_owned();
        series.next_instance_key = "series:2026-06-16T08:15".to_owned();
        series.next_original_start_local = "2026-06-16T08:15".to_owned();
        series.next_local_start = "2026-06-16T08:15".to_owned();
        let mut held = held_of(vec![]);
        held.search = Some(wire::AgendaSearch {
            events: vec![series],
            ..wire::AgendaSearch::default()
        });
        let data = events(&Fold {
            locale: Locale::En,
            destination: Dest::Schedule,
            anchor: TODAY,
            term: Some("survey"),
            hidden: &[],
            held: &held,
        })
        .unwrap();
        let row = rows_of(&data)[0].clone();
        assert_eq!(data.days[0].day, "2026-06-16");
        assert_eq!(row.instance_key, "series:2026-06-16T08:15");
        assert_eq!(
            row.original_start_local.as_deref(),
            Some("2026-06-16T08:15")
        );
        assert_eq!(row.time_label, "08:15 – 09:45");
        assert_eq!(
            row.route,
            Some(routes::event(
                "series",
                "series:2026-06-16T08:15",
                Some("2026-06-16T08:15"),
                "2026-06-16"
            ))
        );
    }

    #[test]
    fn the_notice_names_the_absence_and_counts_one_in_the_singular() {
        let mut held = held_of(vec![]);
        held.catch_up = Some(wire::TasksCatchUp {
            away_days: 16,
            overdue: 34,
            absent: true,
            ..wire::TasksCatchUp::default()
        });
        assert_eq!(
            notice_of(Locale::En, &held).unwrap().sentence,
            "You were away 16 days; 34 tasks came due"
        );
        held.catch_up = Some(wire::TasksCatchUp {
            away_days: 9,
            overdue: 1,
            absent: true,
            ..wire::TasksCatchUp::default()
        });
        assert_eq!(
            notice_of(Locale::En, &held).unwrap().sentence,
            "You were away 9 days; 1 task came due"
        );
        held.catch_up = Some(wire::TasksCatchUp {
            away_days: 3,
            overdue: 2,
            absent: false,
            ..wire::TasksCatchUp::default()
        });
        assert!(
            notice_of(Locale::En, &held).is_none(),
            "no absence, no notice"
        );
    }
}
