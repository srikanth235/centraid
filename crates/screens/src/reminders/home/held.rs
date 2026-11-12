//! WHAT REMINDERS' HOME HOLDS FROM THE CORE, and the reads that fill it.
//!
//! The answers are kept raw, like the core gave them, so a local change (a search closed, a filter
//! chosen) re-folds without a read. `todo` says the Inbox and the projects are current; a change
//! event clears everything, so coming back to a place reads again. Reminders reads tasks alone: the
//! Inbox board, every open task (the smart lists' counts) and the projects, and a task search.

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;

use super::{Home, search};
use crate::catalog::load::reminders as query_rem;
use crate::kit::read::{Note, Page, Reading, read};
use crate::kit::schedule::rows;
use crate::kit::schedule::stop::{Stop, get};
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
    /// Read whatever the place needs and does not hold, and settle the page: data, a failure, or
    /// the gate. Everything is synchronous, so a view never draws a window under another's heading.
    pub(super) fn read(&mut self, ctx: &Ctx) {
        self.land(ctx, false);
    }

    /// [`Self::read`] after the window grew: a read that did not come keeps the rows already shown
    /// under the "more did not load" note.
    pub(super) fn read_wider(&mut self, ctx: &Ctx) {
        self.land(ctx, true);
    }

    fn land(&mut self, ctx: &Ctx, wider: bool) {
        let locale = ctx.locale();
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
        if matches!(reading, Reading::Data(())) {
            let tasks = self.held.tasks();
            let open: Vec<&wire::AgendaTask> = tasks
                .into_iter()
                .filter(|task| rows::is_open(task))
                .collect();
            let today = self.today.clone();
            self.ops.answered(locale, &open, &today);
        }
        // A refresh never blanks the rows shown (a failed one keeps them under a note); a read
        // for another place or term starts from nothing, so a failure of it is the failure and
        // never the old rows.
        let asked = self
            .active_term()
            .map_or_else(|| "lists".to_owned(), |term| format!("search/{term}"));
        let kept = std::mem::replace(&mut self.page, Page::loading());
        let held = if self.asked == asked {
            kept.refreshing()
        } else {
            Page::loading()
        };
        self.asked = asked;
        let nothing = self.active_term().is_some() && search::nothing(&self.held);
        self.page = match (held, reading) {
            (Page::Ready { data, .. }, Reading::Failed) if wider => Page::Ready {
                data,
                note: Some(Note::more_failed(locale)),
            },
            (held, reading) => held.after(reading, locale, |()| nothing),
        };
    }

    /// The held answers are stale: the next read asks again. What is held stays until that read
    /// lands, so a refresh that fails still has the rows to keep under its note.
    pub(super) fn invalidate(&mut self) {
        self.held.todo = false;
        self.held.search_term = None;
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
