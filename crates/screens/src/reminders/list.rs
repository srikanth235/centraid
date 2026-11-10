//! ANYTIME, ALL, LOGBOOK, REMINDERS — one screen, the view a parameter (law 2),
//! each reached from Home's More sheet (`reminders.list`).
//!
//! Open views check a row off ("Task done", Undo); the Logbook's box reopens,
//! because a done row is drawn in the Logbook only (owner ruling). The board is
//! read synchronously on `Appeared` and whenever a table it read changes, and
//! again after every write, so the view shows what committed.

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;
use wire::screen_event::Kind as E;
use wire::todo_list_event::Kind as L;

use crate::catalog::load;
use crate::kit::civil::HourCycle;
use crate::kit::read::{self, Reading};
use crate::kit::schedule::ops::Ops;
use crate::kit::schedule::rows::{self, Context};
use crate::kit::schedule::rule_words::long_day;
use crate::reminders::buckets;
use crate::reminders::view::Prefs;
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, agenda_reminders as reminders, agenda_todo, fill, task as words};

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

/// The gate drawn when the vault will not let Reminders read the tasks.
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
    view: load::reminders::BoardView,
    project_id: Option<String>,
    limit: u32,
) -> Reading<wire::AgendaTaskBoard> {
    read::read(
        ctx,
        load::reminders::Board {
            limit,
            project_id,
            view: Some(view),
        },
        |answer| match answer {
            Answer::AgendaTaskBoard(board) => Some(board),
            _ => None,
        },
    )
}

/// Every open task of a board, roots and children, for `Ops::answered`.
pub(super) fn open_tasks(board: &wire::AgendaTaskBoard) -> Vec<&wire::AgendaTask> {
    board
        .groups
        .iter()
        .flat_map(rows::flatten)
        .filter(|task| rows::is_open(task))
        .collect()
}

/// A task of the board by id, roots and children.
pub(super) fn find(board: &wire::AgendaTaskBoard, id: &str) -> Option<wire::AgendaTask> {
    board
        .groups
        .iter()
        .flat_map(rows::flatten)
        .find(|task| task.task_id == id)
        .cloned()
}

/// "100 tasks · more not shown" when the window is not everything.
fn window_label(locale: Locale, board: &wire::AgendaTaskBoard) -> String {
    if board.truncated {
        fill(
            &agenda_todo::window_label(locale),
            &[("count", &rows::count(locale, board.window as usize))],
        )
    } else {
        String::new()
    }
}

/// The colour token of a smart list, one place for the home's card and the page's title.
#[must_use]
pub fn smart_color(view: wire::TodoView) -> &'static str {
    match view {
        wire::TodoView::Today => "listBlue",
        wire::TodoView::Scheduled => "listRaspberry",
        wire::TodoView::All => "appLocker",
        wire::TodoView::Flagged => "stateAmber",
        wire::TodoView::Logbook => "listGraphite",
        _ => "",
    }
}

/// The Overdue group's "Catch up": open the Catch up page, as Home's notice does.
/// Any other verb key is not this page's to act on.
pub(super) fn verb_effects(key: &str) -> Vec<wire::Effect> {
    if key != rows::VERB_CATCH_UP {
        return Vec::new();
    }
    vec![wire::Effect {
        kind: Some(wire::effect::Kind::OpenRoute(wire::OpenRoute {
            route: Some(crate::reminders::routes::catch_up()),
        })),
    }]
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
        prefs: Prefs::default(),
    }))
}

struct List {
    view: wire::TodoView,
    /// The board window: it widens by a page at "Show more", up to the manifest's bound.
    limit: u32,
    phase: Phase<wire::AgendaTaskBoard>,
    ops: Ops,
    /// The Reminders "Filter and sort" choice, read from the keychain on `Appeared`.
    prefs: Prefs,
}

impl List {
    fn board_view(&self) -> load::reminders::BoardView {
        use load::reminders::BoardView as B;
        match self.view {
            // The smart lists are folds over the All board (#1173).
            wire::TodoView::All
            | wire::TodoView::Today
            | wire::TodoView::Scheduled
            | wire::TodoView::Flagged => B::All,
            wire::TodoView::Logbook => B::Logbook,
            wire::TodoView::Reminders => B::Reminders,
            wire::TodoView::Inbox => B::Inbox,
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
            wire::TodoView::All
            | wire::TodoView::Today
            | wire::TodoView::Scheduled
            | wire::TodoView::Flagged => wire::AgendaTaskView::All,
            wire::TodoView::Logbook => wire::AgendaTaskView::Logbook,
            wire::TodoView::Reminders => wire::AgendaTaskView::Reminders,
            wire::TodoView::Inbox => wire::AgendaTaskView::Inbox,
            _ => wire::AgendaTaskView::Anytime,
        };
        view as i32
    }

    fn title(&self, locale: Locale) -> String {
        match self.view {
            wire::TodoView::All => words::view_all(locale),
            wire::TodoView::Today => reminders::smart_today(locale),
            wire::TodoView::Scheduled => reminders::smart_scheduled(locale),
            wire::TodoView::Flagged => reminders::smart_flagged(locale),
            wire::TodoView::Logbook => words::view_logbook(locale),
            wire::TodoView::Reminders => words::view_reminders(locale),
            wire::TodoView::Inbox => words::inbox(locale),
            _ => words::view_anytime(locale),
        }
    }

    /// The page's own colour: the smart list's card colour on the Reminders home.
    fn color_key(&self) -> &'static str {
        smart_color(self.view)
    }

    fn empty(&self, locale: Locale) -> String {
        match self.view {
            wire::TodoView::All => words::all_empty(locale),
            wire::TodoView::Today => reminders::today_empty(locale),
            wire::TodoView::Scheduled => reminders::scheduled_empty(locale),
            wire::TodoView::Flagged => reminders::flagged_empty(locale),
            wire::TodoView::Logbook => words::logbook_empty(locale),
            wire::TodoView::Reminders => words::reminders_empty(locale),
            wire::TodoView::Inbox => words::inbox_empty(locale),
            _ => words::anytime_empty(locale),
        }
    }

    fn data(
        &self,
        locale: Locale,
        cycle: HourCycle,
        board: &wire::AgendaTaskBoard,
    ) -> wire::TodoListData {
        let row_ctx = Context {
            cycle,
            ..Context::of(&board.today, &board.projects, &board.sections)
        };
        // THE CHOICE of the Reminders menu shapes the rows; Today keeps its parts of the day.
        let shaped;
        let board = if self.view == wire::TodoView::Logbook {
            board
        } else {
            let mut copy = board.clone();
            self.prefs.options.shape(&mut copy.groups);
            shaped = copy;
            &shaped
        };
        let groups = match self.view {
            wire::TodoView::Today => buckets::today(locale, board, &row_ctx),
            wire::TodoView::Scheduled => buckets::scheduled(locale, board, &row_ctx),
            wire::TodoView::Flagged => buckets::flagged(locale, board, &row_ctx),
            _ => rows::groups(locale, &board.groups, &row_ctx),
        };
        let subtitle = if self.view == wire::TodoView::Today {
            let mut parts = vec![
                long_day(locale, &board.today),
                reminders::today_to_do(locale, buckets::today_count(board) as u64),
            ];
            if self.ops.completed > 0 {
                parts.push(reminders::today_done(locale, u64::from(self.ops.completed)));
            }
            parts.join(" · ")
        } else {
            String::new()
        };
        wire::TodoListData {
            subtitle,
            today: board.today.clone(),
            empty: groups.is_empty().then(|| wire::EmptyState {
                headline: self.empty(locale),
                ..wire::EmptyState::default()
            }),
            count_label: if self.view == wire::TodoView::Today {
                String::new()
            } else {
                rows::count(locale, rows::root_count(&groups))
            },
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
            Some(L::RowFlagged(flagged)) => {
                if self
                    .phase
                    .data()
                    .and_then(|board| find(board, &flagged.task_id))
                    .is_some()
                {
                    self.ops.flag(ctx, &flagged.task_id, flagged.flagged);
                    self.reload(ctx);
                }
            }
            Some(L::RowDeleted(deleted)) => {
                if let Some(task) = self
                    .phase
                    .data()
                    .and_then(|board| find(board, &deleted.task_id))
                {
                    self.ops.delete(ctx, &deleted.task_id, &task.title);
                    self.reload(ctx);
                }
            }
            Some(L::NextPage(_)) => {
                if self.limit < rows::MAX_WINDOW {
                    self.limit = (self.limit + rows::PAGE).min(rows::MAX_WINDOW);
                    self.reload(ctx);
                }
            }
            Some(L::GroupVerb(_)) | None => {}
        }
    }
}

impl Screen for List {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Appeared(_)) => {
                self.reload(ctx);
                return self.prefs.reset_and_ask();
            }
            Some(E::DataChanged(_) | E::EnvironmentChanged(_)) => self.reload(ctx),
            Some(E::EffectResult(result)) => {
                self.prefs.answers(&result);
            }
            Some(E::TodoList(list)) => {
                if let Some(L::GroupVerb(verb)) = &list.kind {
                    return verb_effects(&verb.key);
                }
                self.event(list, ctx);
            }
            _ => {}
        }
        Vec::new()
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        let locale = ctx.locale();
        let ready = self.phase.data().is_some();
        let content = match &self.phase {
            Phase::Loading => {
                wire::todo_list_state::Content::Loading(wire::Loading { first_load: true })
            }
            Phase::Failed => wire::todo_list_state::Content::Failure(read::failure(locale)),
            Phase::Denied(denial) => wire::todo_list_state::Content::Denied(denied(locale, denial)),
            Phase::Ready(board) => {
                wire::todo_list_state::Content::Data(self.data(locale, ctx.hour_cycle(), board))
            }
        };
        wire::ViewState {
            kind: Some(wire::view_state::Kind::TodoList(wire::TodoListState {
                view: self.view as i32,
                title: self.title(locale),
                content: Some(content),
                chrome: Some(rows::chrome(locale)),
                status: self.ops.status.clone(),
                color_key: self.color_key().to_owned(),
                add_label: if ready {
                    words::add_task(locale)
                } else {
                    String::new()
                },
                add_route: self
                    .phase
                    .data()
                    .map(|board| crate::reminders::routes::editor(&board.today)),
            })),
            ..wire::ViewState::default()
        }
    }
}
