//! CATCH UP (`agenda.catch_up`) — the pressure valve, reachable any day: what
//! came due, what repeats and is behind, what has sat 90 days. One bulk verb
//! per pile, "Complete all", behind a confirm.
//!
//! THE REPEATING PILE KEEPS ONLY WHAT IS BEHIND (owner ruling): a missed
//! period, or a due before today. The core answers that set; the screen keeps
//! the rule too, so a pile never shows a series that is merely repeating.

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;
use wire::screen_event::Kind as E;
use wire::todo_catch_up_event::Kind as C;

use super::list::{self, Phase};
use super::todo::ops::Ops;
use super::todo::rows::{self, Context};
use crate::catalog::load;
use crate::kit::read::{self, Reading};
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, agenda_todo, task as words};

pub const PILE_DATED: &str = "dated";
pub const PILE_REPEATING: &str = "repeating";
pub const PILE_SITTING: &str = "sitting";

/// What the page holds of its two reads.
#[derive(Clone, Debug)]
struct Answered {
    catch_up: wire::TasksCatchUp,
    projects: wire::TasksProjects,
}

#[must_use]
pub fn build(_route: &wire::Route) -> Option<Box<dyn Screen>> {
    Some(Box::new(CatchUp {
        phase: Phase::Loading,
        incomplete: false,
        ops: Ops::default(),
        asking: None,
    }))
}

struct CatchUp {
    phase: Phase<Answered>,
    /// The catch-up came and the projects its rows name did not: neither can
    /// be made up.
    incomplete: bool,
    ops: Ops,
    /// The pile the confirm asks about.
    asking: Option<String>,
}

/// Is this repeating task actually behind?
fn behind(task: &wire::TasksTask) -> bool {
    task.missed > 0 || task.overdue
}

impl CatchUp {
    fn reload(&mut self, ctx: &Ctx) {
        self.incomplete = false;
        let catch_up = read::read(
            ctx,
            load::agenda::CatchUp::default(),
            |answer| match answer {
                Answer::TasksCatchUp(catch_up) => Some(catch_up),
                _ => None,
            },
        );
        let projects = read::read(
            ctx,
            load::agenda::Projects::default(),
            |answer| match answer {
                Answer::TasksProjects(projects) => Some(projects),
                _ => None,
            },
        );
        self.phase = match (catch_up, projects) {
            (Reading::Data(catch_up), Reading::Data(projects)) => {
                Phase::Ready(Answered { catch_up, projects })
            }
            (Reading::Denied(denial), _) | (_, Reading::Denied(denial)) => Phase::Denied(denial),
            (Reading::Failed, _) => Phase::Failed,
            (Reading::Data(_), Reading::Failed) => {
                self.incomplete = true;
                Phase::Failed
            }
        };
        if let Phase::Ready(answer) = &self.phase {
            let open: Vec<&wire::TasksTask> = answer
                .catch_up
                .dated
                .iter()
                .chain(&answer.catch_up.repeating)
                .chain(&answer.catch_up.sitting)
                .filter(|task| rows::is_open(task))
                .collect();
            self.ops
                .answered(ctx.locale(), &open, &answer.catch_up.today);
        }
    }

    /// A pile's tasks, as the screen draws them.
    fn pile(&self, key: &str) -> Vec<&wire::TasksTask> {
        let Some(answer) = self.phase.data() else {
            return Vec::new();
        };
        let catch_up = &answer.catch_up;
        match key {
            PILE_DATED => catch_up.dated.iter().collect(),
            PILE_REPEATING => catch_up
                .repeating
                .iter()
                .filter(|task| behind(task))
                .collect(),
            PILE_SITTING => catch_up.sitting.iter().collect(),
            _ => Vec::new(),
        }
    }

    fn find(&self, id: &str) -> Option<wire::TasksTask> {
        [PILE_DATED, PILE_REPEATING, PILE_SITTING]
            .iter()
            .flat_map(|key| self.pile(key))
            .find(|task| task.task_id == id)
            .cloned()
    }

    fn data(&self, locale: Locale, answer: &Answered) -> wire::TodoCatchUpData {
        let catch_up = &answer.catch_up;
        let row_ctx = Context::of(
            &catch_up.today,
            &answer.projects.projects,
            &answer.projects.sections,
        );
        let piles: Vec<wire::TodoPile> = [
            (PILE_DATED, words::pile_dated(locale)),
            (PILE_REPEATING, words::pile_repeating(locale)),
            (PILE_SITTING, words::pile_sitting(locale)),
        ]
        .into_iter()
        .filter_map(|(key, title)| {
            let tasks = self.pile(key);
            if tasks.is_empty() {
                return None;
            }
            Some(wire::TodoPile {
                key: key.to_owned(),
                title,
                meta: tasks.len().to_string(),
                verb_label: words::complete_all(locale),
                rows: tasks
                    .iter()
                    .map(|task| rows::row(locale, task, &row_ctx, false))
                    .collect(),
            })
        })
        .collect();
        let head = if catch_up.absent {
            format!(
                "{} · {}",
                agenda_todo::days_away_n(locale, u64::from(catch_up.away_days)),
                agenda_todo::came_due_n(locale, u64::from(catch_up.overdue))
            )
        } else {
            String::new()
        };
        wire::TodoCatchUpData {
            today: catch_up.today.clone(),
            head,
            empty: piles.is_empty().then(|| wire::EmptyState {
                headline: words::catch_up_empty(locale),
                ..wire::EmptyState::default()
            }),
            piles,
        }
    }

    fn confirm(&self, locale: Locale) -> Option<wire::Confirm> {
        self.asking.as_ref().map(|_| wire::Confirm {
            title: words::complete_all_title(locale),
            body: words::complete_all_body(locale),
            confirm_label: words::complete_all(locale),
            destructive: false,
        })
    }

    /// Complete every task of the pile asked about. A BULK VERB SAYS ITS COUNT,
    /// and offers no Undo of twelve; the first refusal stops it and is what the
    /// status line says.
    fn complete_all(&mut self, ctx: &Ctx) {
        let Some(pile) = self.asking.take() else {
            return;
        };
        let tasks: Vec<wire::TasksTask> = self.pile(&pile).into_iter().cloned().collect();
        let mut done = 0_u64;
        self.ops.status = None;
        for task in &tasks {
            self.ops.check(ctx, task);
            if self
                .ops
                .status
                .as_ref()
                .is_some_and(|status| status.refused)
            {
                break;
            }
            done += 1;
        }
        if done > 0 && done as usize == tasks.len() {
            self.ops.status = Some(wire::StatusLine {
                sentence: agenda_todo::tasks_done_n(ctx.locale(), done),
                action_label: String::new(),
                refused: false,
            });
        }
        self.reload(ctx);
    }

    fn event(&mut self, event: wire::TodoCatchUpEvent, ctx: &Ctx) {
        match event.kind {
            Some(C::Refreshed(_)) => self.reload(ctx),
            Some(C::CompleteAll(tapped)) => {
                if !self.pile(&tapped.pile).is_empty() {
                    self.asking = Some(tapped.pile);
                }
            }
            Some(C::Confirmed(_)) => self.complete_all(ctx),
            Some(C::Dismissed(_)) => self.asking = None,
            Some(C::RowChecked(checked)) => {
                let Some(task) = self.find(&checked.task_id) else {
                    return;
                };
                self.ops.check(ctx, &task);
                self.reload(ctx);
            }
            // Only a status line that offers Undo is undone: a bulk "2 tasks
            // done" offers none.
            Some(C::StatusActed(_)) => {
                if self
                    .ops
                    .status
                    .as_ref()
                    .is_some_and(|status| !status.action_label.is_empty())
                {
                    self.ops.undo(ctx);
                    self.reload(ctx);
                }
            }
            None => {}
        }
    }
}

impl Screen for CatchUp {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Appeared(_) | E::DataChanged(_) | E::EnvironmentChanged(_)) => self.reload(ctx),
            Some(E::TodoCatchUp(catch_up)) => self.event(catch_up, ctx),
            _ => {}
        }
        Vec::new()
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        use wire::todo_catch_up_state::Content;
        let locale = ctx.locale();
        let content = match &self.phase {
            Phase::Loading => Content::Loading(wire::Loading { first_load: true }),
            Phase::Failed if self.incomplete => Content::Failure(read::incomplete(locale)),
            Phase::Failed => Content::Failure(read::failure(locale)),
            Phase::Denied(denial) => Content::Denied(list::denied(locale, denial)),
            Phase::Ready(answer) => Content::Data(self.data(locale, answer)),
        };
        wire::ViewState {
            kind: Some(wire::view_state::Kind::TodoCatchUp(
                wire::TodoCatchUpState {
                    content: Some(content),
                    chrome: Some(wire::TodoChrome {
                        title: words::catch_up(locale),
                        ..rows::chrome(locale)
                    }),
                    status: self.ops.status.clone(),
                    confirm: self.confirm(locale),
                    asking_pile: self.asking.clone().unwrap_or_default(),
                },
            )),
            ..wire::ViewState::default()
        }
    }
}
