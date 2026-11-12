//! WHAT CALENDAR'S HOME HOLDS FROM THE CORE, and the reads that fill it.
//!
//! The answers are kept raw, like the core gave them, so a local change (a
//! calendar hidden, Schedule to Waiting, search closed) re-folds without a
//! read. `window` names the window `upcoming` was read for and `dated` the one the
//! dated reminders were; a change event clears both, so coming back to a place reads again.
//!
//! ## The read range
//!
//! Day and Week read the anchor's whole week (the strip's dots), Month its
//! whole cell range (the leading and trailing days), and Year the anchor's day
//! alone: twelve small months carry no event marks, so no year of occurrences
//! is read. The window key names the range ([`range_of`]), so a step inside the
//! held week or month reads nothing.
//!
//! ## The window is padded, and the fold cuts it
//!
//! `upcoming` takes INSTANTS, and the instant an anchor's local midnight falls
//! on needs the zone's offset, which a screen does not compute. So the bounds
//! are the UTC midnights a day either side of the window: every offset on Earth
//! is inside ±14 hours, so `[anchor − 1 day, end + 1 day)` in UTC covers the
//! window's local days whatever the zone. The core answers every occurrence's
//! `local_days` in the device's zone and the fold keeps the days it draws, so
//! the pad is never shown. `day-context` takes civil days and is asked exactly.
//!
//! No anchor is known before the first answer, and the bounds need one, so the
//! first read asks `day-context` with no bounds (the core's today in the zone)
//! and the anchor becomes the `today` it names — never the device clock's.

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;

use super::Home;
use super::grid::{self, WeekStart};
use crate::catalog::load::calendar as query_cal;
use crate::kit::civil;
use crate::kit::read::read;
use crate::kit::read::{Page, Reading};
use crate::kit::schedule::rows;
use crate::kit::schedule::stop::{Stop, get};
use crate::screen::Ctx;

/// Schedule's and Waiting's reach from the anchor, in days.
pub const LIST_DAYS: i64 = 120;
/// `search`'s own ceiling.
pub const SEARCH_LIMIT: u32 = 100;

#[derive(Default)]
pub struct Held {
    pub window: Option<String>,
    pub upcoming: Option<wire::AgendaUpcoming>,
    pub context: Option<wire::AgendaDayContext>,
    pub dated: Option<String>,
    /// The reminders due on the days drawn, read-only rows of their day.
    pub reminders: Option<wire::AgendaTaskBoard>,
    /// The trimmed term `search` answers.
    pub search_term: Option<String>,
    pub search: Option<wire::AgendaSearch>,
}

impl Held {
    /// A reminder on screen that has a row of its own to tick, by id: not a projected occurrence.
    #[must_use]
    pub fn find_reminder(&self, id: &str) -> Option<wire::AgendaTask> {
        if id.is_empty() {
            return None;
        }
        self.reminders
            .iter()
            .flat_map(|board| &board.groups)
            .flat_map(|group| &group.tasks)
            .find(|task| task.task_id == id && task.status != rows::STATUS_PROJECTED)
            .cloned()
    }

    /// Take back, for what a refresh that failed did not read again, what was held before it.
    pub fn keep_unread(&mut self, old: Self) {
        self.window = self.window.take().or(old.window);
        self.upcoming = self.upcoming.take().or(old.upcoming);
        self.context = self.context.take().or(old.context);
        self.dated = self.dated.take().or(old.dated);
        self.reminders = self.reminders.take().or(old.reminders);
        self.search_term = self.search_term.take().or(old.search_term);
        self.search = self.search.take().or(old.search);
    }

    /// The day the core named, from whichever held answer has one.
    #[must_use]
    pub fn today(&self) -> String {
        let named = [
            self.context.as_ref().map(|c| c.today.as_str()),
            self.upcoming.as_ref().map(|u| u.today.as_str()),
            self.reminders.as_ref().map(|b| b.today.as_str()),
        ];
        named
            .into_iter()
            .flatten()
            .find(|day| !day.is_empty())
            .unwrap_or_default()
            .to_owned()
    }
}

/// Days a place reads from the anchor. To-do reads no event, but a search over
/// it asks the events for one day, so it answers 1 like Day.
#[must_use]
pub fn span_of(destination: wire::AgendaDestination) -> i64 {
    match destination {
        wire::AgendaDestination::Schedule | wire::AgendaDestination::Waiting => LIST_DAYS,
        _ => 1,
    }
}

/// The days a read covers for `destination` anchored on `anchor`: the first day
/// and how many. Day and Week read the anchor's whole week (the strip has dots),
/// Month its whole cell range, and every other place its own window.
#[must_use]
pub fn range_of(
    destination: wire::AgendaDestination,
    anchor: &str,
    start: WeekStart,
) -> Option<(String, i64)> {
    grid::range_of(destination, anchor, start, span_of(destination))
}

/// The UTC midnight opening `day`, in the vault's instant spelling.
fn midnight(day: &str) -> Option<String> {
    civil::epoch_day_of(day).map(|_| format!("{day}T00:00:00Z"))
}

impl Home {
    /// Read whatever the current place needs and does not hold, and settle the
    /// phase: data, a failure, or the gate. Everything is synchronous, so a
    /// view never draws a window under another window's heading.
    pub(super) fn read(&mut self, ctx: &Ctx) -> bool {
        let reading = match self.fill(ctx) {
            Ok(()) => Reading::Data(()),
            Err(Stop::Failed) => Reading::Failed,
            Err(Stop::Denied(denial)) => {
                // The gate has no search and no sheet.
                self.search_open = false;
                self.search_term.clear();
                self.held.search = None;
                self.held.search_term = None;
                self.sheet = wire::agenda_home_state::Sheet::None;
                Reading::Denied(denial)
            }
        };
        // A refresh never blanks the place shown (a failed one keeps it under a note); a read for
        // another place, day or term starts from nothing, so a failure of it is the failure and
        // never the old window.
        let asked = format!(
            "{}|{}|{}",
            self.destination as i32,
            self.anchor,
            self.active_term().unwrap_or_default()
        );
        let kept = std::mem::replace(&mut self.page, Page::loading());
        let held = if self.asked == asked {
            kept.refreshing()
        } else {
            Page::loading()
        };
        self.asked = asked;
        let answered = !matches!(reading, Reading::Failed);
        self.page = held.after(reading, ctx.locale(), |()| false);
        answered
    }

    fn fill(&mut self, ctx: &Ctx) -> Result<(), Stop> {
        let term = self.active_term();
        self.fill_window(ctx)?;
        match term {
            Some(term) => self.fill_search(ctx, &term),
            None => {
                self.held.search = None;
                self.held.search_term = None;
                Ok(())
            }
        }
    }

    /// THE EVENTS' WINDOW, and the dated boards Day, Schedule, Week and Month draw on it.
    fn fill_window(&mut self, ctx: &Ctx) -> Result<(), Stop> {
        if self.anchor.is_empty() {
            // TODAY IS THE CORE'S: no bounds is today in the zone.
            let context = get(read(ctx, query_cal::DayContext::default(), pick_context))?;
            if context.today.is_empty() {
                return Err(Stop::Failed);
            }
            self.anchor.clone_from(&context.today);
        }
        // THE WINDOW KEY NAMES THE RANGE, so a step inside the week a Day or
        // Week view already holds reads nothing.
        let Some((first, span)) = range_of(
            self.destination,
            &self.anchor,
            grid::week_start_of(ctx.region()),
        ) else {
            return Err(Stop::Failed);
        };
        let key = format!("{span}|{first}");
        if self.held.window.as_deref() != Some(key.as_str()) {
            let (Some(before), Some(after), Some(last)) = (
                civil::plus_days(&first, -1).and_then(|day| midnight(&day)),
                civil::plus_days(&first, span + 1).and_then(|day| midnight(&day)),
                civil::plus_days(&first, span - 1),
            ) else {
                return Err(Stop::Failed);
            };
            let upcoming = get(read(
                ctx,
                query_cal::Upcoming {
                    from: Some(before),
                    to: Some(after),
                },
                |answer| match answer {
                    Answer::AgendaUpcoming(upcoming) => Some(upcoming),
                    _ => None,
                },
            ))?;
            let context = get(read(
                ctx,
                query_cal::DayContext {
                    from: Some(first.clone()),
                    to: Some(last),
                },
                pick_context,
            ))?;
            self.held.upcoming = Some(upcoming);
            self.held.context = Some(context);
            self.held.window = Some(key.clone());
            self.held.dated = None;
        }
        self.today = self.held.today();
        let dated = matches!(
            self.destination,
            wire::AgendaDestination::Day
                | wire::AgendaDestination::Schedule
                | wire::AgendaDestination::Week
                | wire::AgendaDestination::Month
        );
        // THE OVERDUE REMINDERS are read with Day on today alone (Apple's Calendar shows them above
        // the day), and the board is keyed by the anchor too, so a step inside the held week reads
        // again where it lands.
        let overdue_before = if self.destination == wire::AgendaDestination::Day
            && !self.today.is_empty()
            && self.anchor == self.today
        {
            self.today.clone()
        } else {
            String::new()
        };
        let dated_key = if self.destination == wire::AgendaDestination::Day {
            format!("{key}|{}|{overdue_before}", self.anchor)
        } else {
            key.clone()
        };
        if dated && self.held.dated.as_deref() != Some(dated_key.as_str()) {
            // THE REMINDERS OF THE DAYS DRAWN (rounds 10 and 12): Calendar reads a task's title, due
            // day and time and its state, and shows it as a row of its day: ticked there with
            // Reminders' own action, opened in Reminders.
            let last = civil::plus_days(&first, span - 1).ok_or(Stop::Failed)?;
            let window = get(read(
                ctx,
                query_cal::DatedReminders {
                    from: first.clone(),
                    to: last,
                    overdue_before: Some(overdue_before).filter(|day| !day.is_empty()),
                },
                |answer| match answer {
                    Answer::CalendarDatedReminders(found) => Some(found),
                    _ => None,
                },
            ))?;
            self.held.reminders = Some(board_of(&window));
            self.held.dated = Some(dated_key);
        }
        Ok(())
    }

    /// CALENDAR'S HITS: the events a term finds.
    fn fill_search(&mut self, ctx: &Ctx, term: &str) -> Result<(), Stop> {
        if self.held.search_term.as_deref() == Some(term) {
            return Ok(());
        }
        let mut request: wire::LoadRequest = query_cal::Search {
            term: term.to_owned(),
        }
        .into();
        request.limit = SEARCH_LIMIT;
        let search = get(read(ctx, request, |answer| match answer {
            Answer::AgendaSearch(search) => Some(search),
            _ => None,
        }))?;
        self.held.search = Some(search);
        self.held.search_term = Some(term.to_owned());
        Ok(())
    }
}

/// The reminders of a window as the board the fold draws a day from: a group of the rows due on
/// the days drawn (a ticked one is done, a later occurrence of a repeating one is
/// [`rows::STATUS_PROJECTED`]) and, when the read named them, a group of the overdue ones, each with
/// how long ago. Each row carries its title, due day and time and nothing else.
fn board_of(found: &wire::CalendarDatedReminders) -> wire::AgendaTaskBoard {
    let today_epoch = civil::epoch_day_of(&found.today);
    let task_of = |reminder: &wire::CalendarDatedReminder| {
        let late = today_epoch
            .zip(civil::epoch_day_of(&reminder.due_day))
            .map(|(today, due)| due - today)
            .filter(|days| reminder.overdue && *days < 0);
        wire::AgendaTask {
            task_id: reminder.task_id.clone(),
            title: reminder.title.clone(),
            status: if reminder.done {
                rows::STATUS_DONE
            } else if reminder.projected {
                rows::STATUS_PROJECTED
            } else {
                rows::STATUS_OPEN
            }
            .to_owned(),
            due_day: reminder.due_day.clone(),
            due_time: reminder.due_time.clone(),
            repeats: reminder.repeats,
            overdue: late.is_some(),
            days_from_today: late.and_then(|days| i32::try_from(days).ok()),
            ..wire::AgendaTask::default()
        }
    };
    let (late, dated): (Vec<_>, Vec<_>) = found
        .reminders
        .iter()
        .partition(|reminder| reminder.overdue);
    let mut groups = vec![wire::AgendaTaskGroup {
        kind: wire::AgendaTaskGroupKind::Day as i32,
        tasks: dated.into_iter().map(task_of).collect(),
        ..wire::AgendaTaskGroup::default()
    }];
    if !late.is_empty() {
        groups.push(wire::AgendaTaskGroup {
            kind: wire::AgendaTaskGroupKind::Overdue as i32,
            tasks: late.into_iter().map(task_of).collect(),
            ..wire::AgendaTaskGroup::default()
        });
    }
    wire::AgendaTaskBoard {
        today: found.today.clone(),
        groups,
        ..wire::AgendaTaskBoard::default()
    }
}

fn pick_context(answer: Answer) -> Option<wire::AgendaDayContext> {
    match answer {
        Answer::AgendaDayContext(context) => Some(context),
        _ => None,
    }
}
