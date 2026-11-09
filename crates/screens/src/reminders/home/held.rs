//! WHAT REMINDERS' HOME HOLDS FROM THE CORE, and the reads that fill it.
//!
//! The answers are kept raw, like the core gave them, so a local change (a search closed, a filter
//! chosen) re-folds without a read. `todo` says the Inbox and the projects are current; a change
//! event clears everything, so coming back to a place reads again. Reminders reads tasks alone: the
//! Inbox board, every open task (the smart lists' counts) and the projects, and a task search.

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;

use super::{Home, Phase};
use crate::catalog::load::reminders as query_rem;
use crate::kit::read::read;
use crate::kit::schedule::phase::{Stop, get};
use crate::kit::schedule::rows;
use crate::screen::Ctx;

/// `search`'s own ceiling.
pub const SEARCH_LIMIT: u32 = 100;
/// The all-open board's window: the board's own ceiling, so a count is not cut short.
pub const BOARD_LIMIT: u32 = rows::MAX_WINDOW;

#[derive(Default)]
pub struct Held {
    pub todo: bool,
    pub inbox: Option<wire::AgendaTaskBoard>,
    /// Every open task: the smart lists' counts and the Flag (#1173).
    pub all: Option<wire::AgendaTaskBoard>,
    pub projects: Option<wire::AgendaTaskProjects>,
    /// The trimmed term `search` answers.
    pub search_term: Option<String>,
    pub search: Option<wire::AgendaTaskSearch>,
}

impl Held {
    /// Every task the held answers carry, root or child: the Inbox, every open task and the hits.
    #[must_use]
    pub fn tasks(&self) -> Vec<&wire::AgendaTask> {
        let mut found: Vec<&wire::AgendaTask> = [&self.inbox, &self.all]
            .into_iter()
            .flatten()
            .flat_map(|board| &board.groups)
            .flat_map(rows::flatten)
            .collect();
        if let Some(tasks) = &self.search {
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
        self.inbox
            .as_ref()
            .map_or((&[], &[]), |board| (&board.projects, &board.sections))
    }

    /// The day the core named.
    #[must_use]
    pub fn today(&self) -> String {
        self.inbox
            .as_ref()
            .map(|board| board.today.clone())
            .unwrap_or_default()
    }
}

impl Home {
    /// Read whatever the place needs and does not hold, and settle the phase: data, a failure, or
    /// the gate. Everything is synchronous, so a view never draws a window under another's heading.
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
        self.fill_todo(ctx)?;
        match term {
            Some(term) => self.fill_task_search(ctx, &term),
            None => {
                self.held.search = None;
                self.held.search_term = None;
                Ok(())
            }
        }
    }

    /// THE INBOX BOARD, every open task and the projects.
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

    /// THE TASKS AND LISTS A TERM FINDS, with no event and no day under them.
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
        self.held.search = Some(tasks);
        self.held.search_term = Some(term.to_owned());
        Ok(())
    }
}
