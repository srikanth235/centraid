//! WHAT AGENDA'S HOME HOLDS FROM THE CORE, and the reads that fill it.
//!
//! The answers are kept raw, like the core gave them, so a local change (a
//! calendar hidden, Schedule to Waiting, search closed) re-folds without a
//! read. `window` names the window `upcoming` was read for, `dated` the one the
//! dated boards were, and `todo` says the Inbox and the projects are current; a
//! change event clears all three, so coming back to a place reads again.
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

use super::grid::{self, WeekStart};
use super::{App, Home, Phase};
use crate::catalog::load::calendar as query_cal;
use crate::catalog::load::reminders as query_rem;
use crate::kit::civil;
use crate::kit::read::{Reading, read};
use crate::kit::schedule::rows;
use crate::screen::Ctx;

/// Schedule's and Waiting's reach from the anchor, in days.
pub const LIST_DAYS: i64 = 120;
/// `search`'s own ceiling.
pub const SEARCH_LIMIT: u32 = 100;
/// The dated boards' window: the board's own ceiling, so a window is not cut short.
pub const BOARD_LIMIT: u32 = rows::MAX_WINDOW;

#[derive(Default)]
pub struct Held {
    pub window: Option<String>,
    pub upcoming: Option<wire::AgendaUpcoming>,
    pub context: Option<wire::AgendaDayContext>,
    pub dated: Option<String>,
    pub today_board: Option<wire::AgendaTaskBoard>,
    pub upcoming_board: Option<wire::AgendaTaskBoard>,
    pub catch_up: Option<wire::AgendaTaskCatchUp>,
    pub todo: bool,
    pub inbox: Option<wire::AgendaTaskBoard>,
    /// Every open task: the smart lists' counts and the Flag (#1173).
    pub all: Option<wire::AgendaTaskBoard>,
    pub projects: Option<wire::AgendaTaskProjects>,
    /// The trimmed term `search` answers.
    pub search_term: Option<String>,
    pub search: Option<wire::AgendaSearch>,
}

/// Why a read stopped.
pub enum Stop {
    Failed,
    Denied(wire::AppQueryDenial),
}

fn get<T>(reading: Reading<T>) -> Result<T, Stop> {
    match reading {
        Reading::Data(data) => Ok(data),
        Reading::Denied(denial) => Err(Stop::Denied(denial)),
        Reading::Failed => Err(Stop::Failed),
    }
}

impl Held {
    /// Every task the held answers carry, root or child: the Inbox, the dated
    /// boards and the hits.
    #[must_use]
    pub fn tasks(&self) -> Vec<&wire::AgendaTask> {
        let boards = [
            &self.inbox,
            &self.all,
            &self.today_board,
            &self.upcoming_board,
        ];
        let mut found: Vec<&wire::AgendaTask> = boards
            .into_iter()
            .flatten()
            .flat_map(|board| &board.groups)
            .flat_map(rows::flatten)
            .collect();
        if let Some(tasks) = self.search.as_ref().and_then(|s| s.tasks.as_ref()) {
            found.extend(
                tasks
                    .tasks
                    .iter()
                    .flat_map(|t| std::iter::once(t).chain(&t.children)),
            );
        }
        found
    }

    /// A task on screen, root or child, by id.
    #[must_use]
    pub fn find(&self, id: &str) -> Option<wire::AgendaTask> {
        if id.is_empty() {
            return None;
        }
        self.tasks()
            .into_iter()
            .find(|task| task.task_id == id)
            .cloned()
    }

    /// Projects and sections from whichever answer holds them.
    #[must_use]
    pub fn projects_of(&self) -> (&[wire::AgendaTaskProject], &[wire::AgendaTaskSection]) {
        if let Some(projects) = &self.projects {
            return (&projects.projects, &projects.sections);
        }
        [&self.inbox, &self.today_board, &self.upcoming_board]
            .into_iter()
            .flatten()
            .next()
            .map_or((&[], &[]), |board| (&board.projects, &board.sections))
    }

    /// The day the core named, from whichever held answer has one.
    #[must_use]
    pub fn today(&self) -> String {
        let named = [
            self.context.as_ref().map(|c| c.today.as_str()),
            self.upcoming.as_ref().map(|u| u.today.as_str()),
            self.inbox.as_ref().map(|b| b.today.as_str()),
            self.today_board.as_ref().map(|b| b.today.as_str()),
            self.upcoming_board.as_ref().map(|b| b.today.as_str()),
            self.catch_up.as_ref().map(|c| c.today.as_str()),
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
    pub(super) fn read(&mut self, ctx: &Ctx) {
        self.phase = match self.fill(ctx) {
            Ok(()) => Phase::Ready,
            Err(Stop::Failed) => Phase::Failed,
            Err(Stop::Denied(denial)) => {
                // The gate has no search and no sheet.
                self.search_open = false;
                self.search_term.clear();
                self.held.search = None;
                self.held.search_term = None;
                self.sheet = wire::agenda_home_state::Sheet::None;
                Phase::Denied(denial)
            }
        };
        if matches!(self.phase, Phase::Ready) {
            let tasks = self.held.tasks();
            let open: Vec<&wire::AgendaTask> = tasks
                .into_iter()
                .filter(|task| rows::is_open(task))
                .collect();
            let today = self.today.clone();
            self.ops.answered(ctx.locale(), &open, &today);
        }
    }

    /// Forget every held answer: a pull, or a row moved.
    pub(super) fn invalidate(&mut self) {
        self.held = Held::default();
    }

    fn fill(&mut self, ctx: &Ctx) -> Result<(), Stop> {
        let term = self.active_term();
        // REMINDERS READS TASKS ALONE, CALENDAR EVENTS ALONE (and the dates of reminders, read-only).
        if self.app == App::Reminders {
            self.fill_todo(ctx)?;
            return match term {
                Some(term) => self.fill_task_search(ctx, &term),
                None => {
                    self.held.search = None;
                    self.held.search_term = None;
                    Ok(())
                }
            };
        }
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

    /// TO-DO READS TASKS ALONE: the Inbox board and the projects.
    fn fill_todo(&mut self, ctx: &Ctx) -> Result<(), Stop> {
        if !self.held.todo {
            let board = get(read(
                ctx,
                query_rem::Board {
                    limit: self.limit,
                    view: Some(query_rem::BoardView::Inbox),
                    project_id: None,
                },
                |answer| match answer {
                    Answer::AgendaTaskBoard(board) => Some(board),
                    _ => None,
                },
            ))?;
            let projects = get(read(ctx, query_rem::Projects {}, |answer| match answer {
                Answer::AgendaTaskProjects(projects) => Some(projects),
                _ => None,
            }))?;
            let all = get(read(
                ctx,
                query_rem::Board {
                    limit: BOARD_LIMIT,
                    view: Some(query_rem::BoardView::All),
                    project_id: None,
                },
                |answer| match answer {
                    Answer::AgendaTaskBoard(board) => Some(board),
                    _ => None,
                },
            ))?;
            self.today.clone_from(&board.today);
            self.held.all = Some(all);
            self.held.inbox = Some(board);
            self.held.projects = Some(projects);
            self.held.todo = true;
        }
        Ok(())
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
        // DAY'S BOARDS ARE KEYED BY THE ANCHOR TOO: the absence notice is read
        // on today alone, and a step inside the held week lands there.
        let dated_key = if self.destination == wire::AgendaDestination::Day {
            format!("{key}|{}", self.anchor)
        } else {
            key.clone()
        };
        if dated && self.held.dated.as_deref() != Some(dated_key.as_str()) {
            // THE REMINDERS OF THE DAYS DRAWN, read-only (round 10): Calendar reads a task's title,
            // due day and time, and shows it as a row of its day that opens in Reminders.
            let last = civil::plus_days(&first, span - 1).ok_or(Stop::Failed)?;
            let window = get(read(
                ctx,
                query_cal::DatedReminders {
                    from: first.clone(),
                    to: last,
                },
                |answer| match answer {
                    Answer::CalendarDatedReminders(found) => Some(found),
                    _ => None,
                },
            ))?;
            self.held.upcoming_board = Some(board_of(&window));
            self.held.today_board = None;
            self.held.catch_up = None;
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

    /// REMINDERS' HITS: the tasks and lists a term finds, as the one answer the fold draws, with
    /// no event and no day under them.
    fn fill_task_search(&mut self, ctx: &Ctx, term: &str) -> Result<(), Stop> {
        if self.held.search_term.as_deref() == Some(term) {
            return Ok(());
        }
        let mut request: wire::LoadRequest = query_rem::Search {
            term: term.to_owned(),
        }
        .into();
        request.limit = SEARCH_LIMIT;
        let tasks = get(read(ctx, request, |answer| match answer {
            Answer::AgendaTaskSearch(tasks) => Some(tasks),
            _ => None,
        }))?;
        let today = self.held.today();
        self.held.upcoming = Some(wire::AgendaUpcoming {
            today: today.clone(),
            ..wire::AgendaUpcoming::default()
        });
        self.held.context = Some(wire::AgendaDayContext {
            today,
            ..wire::AgendaDayContext::default()
        });
        self.held.search = Some(wire::AgendaSearch {
            tasks: Some(tasks),
            ..wire::AgendaSearch::default()
        });
        self.held.search_term = Some(term.to_owned());
        Ok(())
    }
}

/// The reminders of a window as the board the fold draws a day from: one group of open tasks,
/// each with its title, due day and time, and nothing else.
fn board_of(found: &wire::CalendarDatedReminders) -> wire::AgendaTaskBoard {
    let tasks = found
        .reminders
        .iter()
        .map(|reminder| wire::AgendaTask {
            task_id: reminder.task_id.clone(),
            title: reminder.title.clone(),
            status: rows::STATUS_OPEN.to_owned(),
            due_day: reminder.due_day.clone(),
            due_time: reminder.due_time.clone(),
            ..wire::AgendaTask::default()
        })
        .collect();
    wire::AgendaTaskBoard {
        today: found.today.clone(),
        groups: vec![wire::AgendaTaskGroup {
            kind: wire::AgendaTaskGroupKind::Day as i32,
            tasks,
            ..wire::AgendaTaskGroup::default()
        }],
        ..wire::AgendaTaskBoard::default()
    }
}

fn pick_context(answer: Answer) -> Option<wire::AgendaDayContext> {
    match answer {
        Answer::AgendaDayContext(context) => Some(context),
        _ => None,
    }
}
