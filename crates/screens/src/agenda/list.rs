//! ANYTIME, ALL, LOGBOOK, REMINDERS — one screen, the view a parameter (law 2),
//! each reached from Home's More sheet (`agenda.todo_list`).
//!
//! Open views check a row off ("Task done", Undo); completed rows reopen.
//! Show Completed makes the closed work visible in the list that owns it. The board is
//! read synchronously on `Appeared` and whenever a table it read changes, and
//! again after every write, so the view shows what committed.

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;
use wire::screen_event::Kind as E;
use wire::todo_list_event::Kind as L;

use super::todo::ops::Ops;
use super::todo::rows::{self, Context};
use crate::catalog::{act, load};
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
) -> Reading<wire::AgendaTaskBoard> {
    read::read(
        ctx,
        load::agenda::Board {
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
        tag_id: args.tag_id.clone(),
        limit: rows::PAGE,
        phase: Phase::Loading,
        ops: Ops::default(),
        show_completed: false,
    }))
}

struct List {
    view: wire::TodoView,
    tag_id: String,
    /// The board window: it widens by a page at "Show more", up to the manifest's bound.
    limit: u32,
    phase: Phase<wire::AgendaTaskBoard>,
    ops: Ops,
    show_completed: bool,
}

impl List {
    fn board_view(&self) -> load::agenda::BoardView {
        use load::agenda::BoardView as B;
        match self.view {
            wire::TodoView::All | wire::TodoView::Tags => B::All,
            wire::TodoView::Logbook => B::Logbook,
            wire::TodoView::Reminders => B::Reminders,
            wire::TodoView::Today => B::Today,
            wire::TodoView::Scheduled => B::All,
            wire::TodoView::Flagged => B::All,
            _ => B::Anytime,
        }
    }

    fn reload(&mut self, ctx: &Ctx) {
        let mut reading = match board(ctx, self.board_view(), None, self.limit) {
            // A board for another place is not this page's answer.
            Reading::Data(board) if board.view != self.wire_view() => Reading::Failed,
            other => other,
        };
        if self.show_completed && self.view != wire::TodoView::Logbook {
            reading = match (
                reading,
                board(ctx, load::agenda::BoardView::Logbook, None, self.limit),
            ) {
                (Reading::Data(mut current), Reading::Data(completed)) => {
                    for tag in completed.tags {
                        if !current
                            .tags
                            .iter()
                            .any(|known| known.concept_id == tag.concept_id)
                        {
                            current.tags.push(tag);
                        }
                    }
                    current
                        .tags
                        .sort_by(|a, b| a.label.to_lowercase().cmp(&b.label.to_lowercase()));
                    let mut groups = completed.groups;
                    for group in &mut groups {
                        group.tasks.retain(|task| {
                            task.status == "done"
                                && match self.view {
                                    wire::TodoView::Today => task.due_day == current.today,
                                    wire::TodoView::Scheduled => !task.due_day.is_empty(),
                                    wire::TodoView::Anytime => task.due_day.is_empty(),
                                    wire::TodoView::Reminders => task.remind_before_min.is_some(),
                                    wire::TodoView::Flagged => task.flagged,
                                    _ => true,
                                }
                        });
                    }
                    current
                        .groups
                        .extend(groups.into_iter().filter(|group| !group.tasks.is_empty()));
                    Reading::Data(current)
                }
                (Reading::Failed, _) | (_, Reading::Failed) => Reading::Failed,
                (Reading::Denied(denial), _) | (_, Reading::Denied(denial)) => {
                    Reading::Denied(denial)
                }
            };
        }
        self.phase = Phase::of(reading);
        if let Phase::Ready(board) = &self.phase {
            self.ops
                .answered(ctx.locale(), &open_tasks(board), &board.today);
        }
    }

    fn wire_view(&self) -> i32 {
        let view = match self.view {
            wire::TodoView::All | wire::TodoView::Tags => wire::AgendaTaskView::All,
            wire::TodoView::Logbook => wire::AgendaTaskView::Logbook,
            wire::TodoView::Reminders => wire::AgendaTaskView::Reminders,
            wire::TodoView::Today => wire::AgendaTaskView::Today,
            wire::TodoView::Scheduled => wire::AgendaTaskView::All,
            wire::TodoView::Flagged => wire::AgendaTaskView::All,
            _ => wire::AgendaTaskView::Anytime,
        };
        view as i32
    }

    fn title(&self, locale: Locale) -> String {
        match self.view {
            wire::TodoView::Tags => crate::strings::agenda::tags_title(locale),
            wire::TodoView::All => words::view_all(locale),
            wire::TodoView::Logbook => words::view_logbook(locale),
            wire::TodoView::Reminders => words::view_reminders(locale),
            wire::TodoView::Today => words::when_today(locale),
            wire::TodoView::Scheduled => words::smart_scheduled(locale),
            wire::TodoView::Flagged => words::flagged(locale),
            _ => words::view_anytime(locale),
        }
    }

    fn empty(&self, locale: Locale) -> String {
        match self.view {
            wire::TodoView::Tags => crate::strings::agenda::tags_empty(locale),
            wire::TodoView::All => words::all_empty(locale),
            wire::TodoView::Logbook => words::logbook_empty(locale),
            wire::TodoView::Reminders => words::reminders_empty(locale),
            wire::TodoView::Today => words::scheduled_empty(locale),
            wire::TodoView::Scheduled => words::scheduled_empty(locale),
            wire::TodoView::Flagged => words::flagged_empty(locale),
            _ => words::anytime_empty(locale),
        }
    }

    fn data(&self, locale: Locale, board: &wire::AgendaTaskBoard) -> wire::TodoListData {
        let mut row_ctx = Context::of(&board.today, &board.projects, &board.sections);
        row_ctx.hide_completed = !self.show_completed && self.view != wire::TodoView::Logbook;
        let mut selected = board.groups.clone();
        if self.view == wire::TodoView::Flagged {
            for group in &mut selected {
                group.tasks.retain(|task| task.flagged);
            }
        }
        if self.view == wire::TodoView::Tags {
            for group in &mut selected {
                group.tasks = group
                    .tasks
                    .iter()
                    .filter_map(|task| tagged_family(task, &self.tag_id))
                    .collect();
            }
        }
        let mut groups = rows::groups(locale, &selected, &row_ctx);
        if self.view == wire::TodoView::Scheduled {
            groups.retain(|group| {
                board.groups.iter().any(|raw| {
                    raw.key == group.key
                        && matches!(
                            wire::AgendaTaskGroupKind::try_from(raw.kind),
                            Ok(wire::AgendaTaskGroupKind::Dated | wire::AgendaTaskGroupKind::Done)
                        )
                })
            });
        }
        wire::TodoListData {
            today: board.today.clone(),
            tag_heading: if self.view == wire::TodoView::Tags {
                crate::strings::agenda::tags_title(locale)
            } else {
                String::new()
            },
            tag_choices: if self.view == wire::TodoView::Tags {
                std::iter::once(wire::TodoChoice {
                    key: String::new(),
                    label: crate::strings::agenda::tags_all(locale),
                    selected: self.tag_id.is_empty(),
                    enabled: true,
                    ..Default::default()
                })
                .chain(board.tags.iter().map(|tag| wire::TodoChoice {
                    key: tag.concept_id.clone(),
                    label: tag.label.clone(),
                    selected: self.tag_id == tag.concept_id,
                    enabled: true,
                    ..Default::default()
                }))
                .collect()
            } else {
                Vec::new()
            },
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
            Some(L::TagPicked(picked)) => {
                if self.view == wire::TodoView::Tags
                    && (picked.key.is_empty()
                        || self.phase.data().is_some_and(|board| {
                            board.tags.iter().any(|tag| tag.concept_id == picked.key)
                        }))
                {
                    self.tag_id = picked.key;
                }
            }
            Some(L::CompletedChanged(changed)) if self.view != wire::TodoView::Logbook => {
                self.show_completed = changed.on;
                self.reload(ctx);
            }
            Some(L::CompletedChanged(_)) => {}
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
            Some(L::RowAction(action)) => {
                if let Some(task) = self
                    .phase
                    .data()
                    .and_then(|board| find(board, &action.task_id))
                {
                    self.ops.row_action(ctx, &task, &action);
                    self.reload(ctx);
                }
            }
            Some(L::ClearCompleted(_)) => {
                if !self.show_completed && self.view != wire::TodoView::Logbook {
                    return;
                }
                use act::agenda::ClearCompletedView as V;
                let view = match self.view {
                    wire::TodoView::Today => V::Today,
                    wire::TodoView::Scheduled => V::Scheduled,
                    wire::TodoView::Anytime => V::Anytime,
                    wire::TodoView::Flagged => V::Flagged,
                    wire::TodoView::Reminders => V::Reminders,
                    wire::TodoView::Tags => V::Tags,
                    _ => V::All,
                };
                if let Some(board) = self.phase.data() {
                    let request = act::agenda::ClearCompleted {
                        view,
                        day: board.today.clone(),
                        zone: ctx.zone().to_owned(),
                        tag_id: if self.tag_id.is_empty() {
                            crate::field::Field::Keep
                        } else {
                            crate::field::Field::Is(self.tag_id.clone())
                        },
                        ..Default::default()
                    };
                    self.ops.created(
                        ctx,
                        request,
                        "completed",
                        words::completed_cleared(ctx.locale()),
                    );
                    self.reload(ctx);
                }
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
                clear_completed_label: if (self.show_completed
                    || self.view == wire::TodoView::Logbook)
                    && self.phase.data().is_some_and(|board| {
                        board
                            .groups
                            .iter()
                            .flat_map(rows::flatten)
                            .any(|task| task.status == "done")
                    }) {
                    words::clear_completed(locale)
                } else {
                    String::new()
                },
                show_completed: self.show_completed,
                show_completed_label: words::show_completed(locale),
                can_show_completed: self.view != wire::TodoView::Logbook,
            })),
            ..wire::ViewState::default()
        }
    }
}

/// A tagged parent keeps its family; a tagged child keeps its parent as context.
fn tagged_family(task: &wire::AgendaTask, tag: &str) -> Option<wire::AgendaTask> {
    if task
        .tags
        .iter()
        .any(|item| tag.is_empty() || item.concept_id == tag)
    {
        return Some(task.clone());
    }
    let children: Vec<_> = task
        .children
        .iter()
        .filter_map(|child| tagged_family(child, tag))
        .collect();
    if children.is_empty() {
        return None;
    }
    let mut parent = task.clone();
    parent.done_children = children
        .iter()
        .filter(|child| child.status == "done")
        .count() as u32;
    parent.children = children;
    Some(parent)
}
