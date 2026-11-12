//! CATCH UP (`reminders.catch_up`) — the pressure valve, reachable any day: what
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

use super::list;
use crate::catalog::load;
use crate::kit::civil::HourCycle;
use crate::kit::read::{self, Page, Reading};
use crate::kit::schedule::ops::Ops;
use crate::kit::schedule::rows::{self, Context};
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, agenda_todo, task as words};

pub const PILE_DATED: &str = "dated";
pub const PILE_REPEATING: &str = "repeating";
pub const PILE_SITTING: &str = "sitting";

/// What the page holds of its two reads.
#[derive(Clone, Debug)]
struct Answered {
    catch_up: wire::AgendaTaskCatchUp,
    projects: wire::AgendaTaskProjects,
}

#[must_use]
pub fn build(_route: &wire::Route) -> Option<Box<dyn Screen>> {
    Some(Box::new(CatchUp {
        page: Page::loading(),
        incomplete: false,
        ops: Ops::default(),
        asking: None,
    }))
}

struct CatchUp {
    /// The read. Nothing behind, repeating or sitting is [`Page::Empty`].
    page: Page<Answered>,
    /// The catch-up came and the projects its rows name did not: neither can
    /// be made up, so with nothing shown it is the failure, in its own words.
    incomplete: bool,
    ops: Ops,
    /// The pile the confirm asks about.
    asking: Option<String>,
}

/// A pile's tasks in an answer: the repeating pile keeps only what is behind.
fn pile_of<'a>(answer: &'a Answered, key: &str) -> Vec<&'a wire::AgendaTask> {
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

/// Is this repeating task actually behind?
fn behind(task: &wire::AgendaTask) -> bool {
    task.missed > 0 || task.overdue
}

impl CatchUp {
    fn reload(&mut self, ctx: &Ctx) {
        self.incomplete = false;
        let catch_up = read::read(
            ctx,
            load::reminders::CatchUp::default(),
            |answer| match answer {
                Answer::AgendaTaskCatchUp(catch_up) => Some(catch_up),
                _ => None,
            },
        );
        let projects = read::read(
            ctx,
            load::reminders::Projects::default(),
            |answer| match answer {
                Answer::AgendaTaskProjects(projects) => Some(projects),
                _ => None,
            },
        );
        let reading = match (catch_up, projects) {
            (Reading::Data(catch_up), Reading::Data(projects)) => {
                Reading::Data(Answered { catch_up, projects })
            }
            (Reading::Denied(denial), _) | (_, Reading::Denied(denial)) => Reading::Denied(denial),
            (Reading::Failed, _) => Reading::Failed,
            (Reading::Data(_), Reading::Failed) => {
                self.incomplete = true;
                Reading::Failed
            }
        };
        if let Reading::Data(answer) = &reading {
            let open: Vec<&wire::AgendaTask> = answer
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
        // A refresh never blanks the piles shown: a failed one keeps them under a note.
        let held = std::mem::replace(&mut self.page, Page::loading());
        self.page = held.after(reading, ctx.locale(), |answer| {
            [PILE_DATED, PILE_REPEATING, PILE_SITTING]
                .iter()
                .all(|key| pile_of(answer, key).is_empty())
        });
        self.incomplete = self.incomplete && matches!(self.page, Page::Failed);
    }

    /// A pile's tasks, as the screen draws them.
    fn pile(&self, key: &str) -> Vec<&wire::AgendaTask> {
        self.page
            .data()
            .map_or_else(Vec::new, |answer| pile_of(answer, key))
    }

    fn find(&self, id: &str) -> Option<wire::AgendaTask> {
        [PILE_DATED, PILE_REPEATING, PILE_SITTING]
            .iter()
            .flat_map(|key| self.pile(key))
            .find(|task| task.task_id == id)
            .cloned()
    }

    fn data(&self, locale: Locale, cycle: HourCycle, answer: &Answered) -> wire::TodoCatchUpData {
        let catch_up = &answer.catch_up;
        let row_ctx = Context {
            cycle,
            ..Context::of(
                &catch_up.today,
                &answer.projects.projects,
                &answer.projects.sections,
            )
        };
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
        let tasks: Vec<wire::AgendaTask> = self.pile(&pile).into_iter().cloned().collect();
        let mut done = 0_u64;
        self.ops.clear();
        for task in &tasks {
            self.ops.check(ctx, task);
            if self.ops.status().is_some_and(|status| status.refused) {
                break;
            }
            done += 1;
        }
        if done > 0 && done as usize == tasks.len() {
            self.ops.say(agenda_todo::tasks_done_n(ctx.locale(), done));
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
                if self.ops.can_undo() {
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
            Some(E::StatusActed(_)) => {
                self.ops.undo(ctx);
                self.reload(ctx);
            }
            Some(E::TodoCatchUp(catch_up)) => self.event(catch_up, ctx),
            _ => {}
        }
        Vec::new()
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        use wire::todo_catch_up_state::Content;
        let locale = ctx.locale();
        let content = self
            .page
            .data()
            .map(|answer| Content::Data(self.data(locale, ctx.hour_cycle(), answer)));
        let mut page = self.page.wire(
            locale,
            |denial| list::denied(locale, denial),
            || wire::EmptyState {
                headline: words::catch_up_empty(locale),
                ..wire::EmptyState::default()
            },
        );
        // The catch-up came and its lists did not: the failure says so.
        if self.incomplete && matches!(page.state, Some(wire::page_state::State::Failed(_))) {
            page.state = Some(wire::page_state::State::Failed(read::incomplete(locale)));
        }
        wire::ViewState {
            kind: Some(wire::view_state::Kind::TodoCatchUp(
                wire::TodoCatchUpState {
                    content,
                    page: Some(page),
                    chrome: Some(wire::TodoChrome {
                        title: words::catch_up(locale),
                        ..rows::chrome(locale)
                    }),
                    status: self.ops.status(),
                    confirm: self.confirm(locale),
                },
            )),
            ..wire::ViewState::default()
        }
    }
}
