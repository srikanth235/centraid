//! ANYTIME, ALL, LOGBOOK, REMINDERS — one screen, the view a parameter (law 2),
//! each reached from Home's More sheet (`agenda.todo_list`).
//!
//! Open views check a row off ("Task done", Undo); the Logbook's box reopens,
//! because a done row is drawn in the Logbook only (owner ruling). The board is
//! read synchronously on `Appeared` and whenever a table it read changes, and
//! again after every write, so the view shows what committed.

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;
use wire::screen_event::Kind as E;
use wire::todo_list_event::Kind as L;

use super::todo::ops::Ops;
use super::todo::rows::{self, Context};
use crate::catalog::load;
use crate::kit::read::{self, Reading};
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, agenda_todo, fill, task as words};

/// What a to-do page holds of one read: nothing yet, a refusal, a gate or the
/// answer. A failed read is never an empty list.
#[derive(Clone, Debug)]
pub(super) enum Phase<T> {
    Loading,
    Failed,
    Denied(wire::AppQueryDenial),
    Ready(T),
}

impl<T> Phase<T> {
    pub(super) fn of(reading: Reading<T>) -> Self {
        match reading {
            Reading::Data(data) => Self::Ready(data),
            Reading::Denied(denial) => Self::Denied(denial),
            Reading::Failed => Self::Failed,
        }
    }

    pub(super) fn data(&self) -> Option<&T> {
        match self {
            Self::Ready(data) => Some(data),
            _ => None,
        }
    }
}

/// The gate drawn when the vault will not let Agenda read the tasks.
pub(super) fn denied(locale: Locale, denial: &wire::AppQueryDenial) -> wire::Denied {
    wire::Denied {
        title: words::denied_title(locale),
        body: words::denied_body(locale),
        receipt: denial.code.clone().unwrap_or_default(),
    }
}

/// `board` for `view` (and `project`), in the device's zone.
pub(super) fn board(
    ctx: &Ctx,
    view: load::agenda::BoardView,
    project_id: Option<String>,
    limit: u32,
) -> Reading<wire::TasksBoard> {
    read::read(
        ctx,
        load::agenda::Board {
            limit,
            project_id,
            view: Some(view),
        },
        |answer| match answer {
            Answer::TasksBoard(board) => Some(board),
            _ => None,
        },
    )
}

/// Every open task of a board, roots and children, for `Ops::answered`.
pub(super) fn open_tasks(board: &wire::TasksBoard) -> Vec<&wire::TasksTask> {
    board
        .groups
        .iter()
        .flat_map(rows::flatten)
        .filter(|task| rows::is_open(task))
        .collect()
}

/// A task of the board by id, roots and children.
pub(super) fn find(board: &wire::TasksBoard, id: &str) -> Option<wire::TasksTask> {
    board
        .groups
        .iter()
        .flat_map(rows::flatten)
        .find(|task| task.task_id == id)
        .cloned()
}

/// "100 tasks · more not shown" when the window is not everything.
fn window_label(locale: Locale, board: &wire::TasksBoard) -> String {
    if board.truncated {
        fill(
            &agenda_todo::window_label(locale),
            &[("count", &rows::count(locale, board.window as usize))],
        )
    } else {
        String::new()
    }
}

#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    let Some(wire::route::Args::TodoList(args)) = &route.args else {
        return None;
    };
    let view = match wire::TodoView::try_from(args.view) {
        Ok(wire::TodoView::Unspecified) | Err(_) => wire::TodoView::Anytime,
        Ok(view) => view,
    };
    Some(Box::new(List {
        view,
        limit: rows::PAGE,
        phase: Phase::Loading,
        ops: Ops::default(),
    }))
}

struct List {
    view: wire::TodoView,
    /// The board window: it widens by a page at "Show more", up to the manifest's bound.
    limit: u32,
    phase: Phase<wire::TasksBoard>,
    ops: Ops,
}

impl List {
    fn board_view(&self) -> load::agenda::BoardView {
        use load::agenda::BoardView as B;
        match self.view {
            wire::TodoView::All => B::All,
            wire::TodoView::Logbook => B::Logbook,
            wire::TodoView::Reminders => B::Reminders,
            _ => B::Anytime,
        }
    }

    fn reload(&mut self, ctx: &Ctx) {
        let reading = match board(ctx, self.board_view(), None, self.limit) {
            // A board for another place is not this page's answer.
            Reading::Data(board) if board.view != self.wire_view() => Reading::Failed,
            other => other,
        };
        self.phase = Phase::of(reading);
        if let Phase::Ready(board) = &self.phase {
            self.ops
                .answered(ctx.locale(), &open_tasks(board), &board.today);
        }
    }

    fn wire_view(&self) -> i32 {
        let view = match self.view {
            wire::TodoView::All => wire::TasksView::All,
            wire::TodoView::Logbook => wire::TasksView::Logbook,
            wire::TodoView::Reminders => wire::TasksView::Reminders,
            _ => wire::TasksView::Anytime,
        };
        view as i32
    }

    fn title(&self, locale: Locale) -> String {
        match self.view {
            wire::TodoView::All => words::view_all(locale),
            wire::TodoView::Logbook => words::view_logbook(locale),
            wire::TodoView::Reminders => words::view_reminders(locale),
            _ => words::view_anytime(locale),
        }
    }

    fn empty(&self, locale: Locale) -> String {
        match self.view {
            wire::TodoView::All => words::all_empty(locale),
            wire::TodoView::Logbook => words::logbook_empty(locale),
            wire::TodoView::Reminders => words::reminders_empty(locale),
            _ => words::anytime_empty(locale),
        }
    }

    fn data(&self, locale: Locale, board: &wire::TasksBoard) -> wire::TodoListData {
        let row_ctx = Context::of(&board.today, &board.projects, &board.sections);
        let groups = rows::groups(locale, &board.groups, &row_ctx);
        wire::TodoListData {
            today: board.today.clone(),
            empty: groups.is_empty().then(|| wire::EmptyState {
                headline: self.empty(locale),
                ..wire::EmptyState::default()
            }),
            count_label: rows::count(locale, rows::root_count(&groups)),
            window_label: window_label(locale, board),
            can_show_more: board.truncated && self.limit < rows::MAX_WINDOW,
            groups,
        }
    }

    fn event(&mut self, event: wire::TodoListEvent, ctx: &Ctx) {
        match event.kind {
            Some(L::Refreshed(_)) => self.reload(ctx),
            Some(L::RowChecked(checked)) => {
                let Some(task) = self
                    .phase
                    .data()
                    .and_then(|board| find(board, &checked.task_id))
                else {
                    return;
                };
                self.ops.check(ctx, &task);
                self.reload(ctx);
            }
            Some(L::StatusActed(_)) => {
                self.ops.undo(ctx);
                self.reload(ctx);
            }
            Some(L::NextPage(_)) => {
                if self.limit < rows::MAX_WINDOW {
                    self.limit = (self.limit + rows::PAGE).min(rows::MAX_WINDOW);
                    self.reload(ctx);
                }
            }
            None => {}
        }
    }
}

impl Screen for List {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Appeared(_) | E::DataChanged(_) | E::EnvironmentChanged(_)) => self.reload(ctx),
            Some(E::TodoList(list)) => self.event(list, ctx),
            _ => {}
        }
        Vec::new()
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        let locale = ctx.locale();
        let content = match &self.phase {
            Phase::Loading => {
                wire::todo_list_state::Content::Loading(wire::Loading { first_load: true })
            }
            Phase::Failed => wire::todo_list_state::Content::Failure(read::failure(locale)),
            Phase::Denied(denial) => wire::todo_list_state::Content::Denied(denied(locale, denial)),
            Phase::Ready(board) => wire::todo_list_state::Content::Data(self.data(locale, board)),
        };
        wire::ViewState {
            kind: Some(wire::view_state::Kind::TodoList(wire::TodoListState {
                view: self.view as i32,
                title: self.title(locale),
                content: Some(content),
                chrome: Some(rows::chrome(locale)),
                status: self.ops.status.clone(),
            })),
            ..wire::ViewState::default()
        }
    }
}
