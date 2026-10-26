//! THE LAWS OF A TO-DO LIST'S ROW WRITES — check off, undo, add, file — for
//! Day, To-do, a list, a project and Catch up alike.
//!
//! A DONE ROW IS DRAWN IN THE LOGBOOK ONLY (owner ruling): checking a row off
//! says "Task done" with Undo on the status line, and the Logbook's box
//! reopens.
//!
//! `act` answers at once (the phone is the vault), so there is no in-flight
//! map, no hidden-until-answered set and no pending row: a screen submits, the
//! verdict is the status line, and the next load draws what committed. Undo is
//! the core's own `inverse` for the action, sent back as an action.

use centraid_api_proto::core_v1 as wire;

use super::rows;
use crate::catalog::act;
use crate::kit::act::{self as kit_act, Settled};
use crate::kit::civil;
use crate::screen::Ctx;
use crate::strings::{Locale, task as words};

/// A repeating task completed here: where its next one landed is named when the
/// next load carries it.
#[derive(Clone, Debug)]
struct NextOf {
    task_id: String,
    series_id: Option<String>,
}

/// What a to-do surface holds beside its answers: the one status line, what
/// Undo reverses, and the count of completions this session.
#[derive(Clone, Debug, Default)]
pub struct Ops {
    seq: u64,
    pub status: Option<wire::StatusLine>,
    undo: Option<wire::ActInverse>,
    next_of: Option<NextOf>,
    /// Completions this session, for Today's earned quiet.
    pub completed: u32,
}

impl Ops {
    fn next_seq(&mut self) -> u64 {
        self.seq = kit_act::fresh();
        self.seq
    }

    fn refused(&mut self, settled: &Settled) {
        self.status = Some(wire::StatusLine {
            sentence: settled.refusal.clone(),
            action_label: String::new(),
            refused: true,
        });
        self.undo = None;
    }

    /// Whether an Undo is on offer.
    #[must_use]
    pub fn can_undo(&self) -> bool {
        self.undo.is_some()
    }

    /// The box. Open work completes; closed work (the Logbook) reopens.
    pub fn check(&mut self, ctx: &Ctx, task: &wire::AgendaTask) {
        let locale = ctx.locale();
        let open = rows::is_open(task);
        let key = kit_act::key(
            &[
                if open { "complete-task" } else { "reopen-task" },
                &task.task_id,
            ],
            self.next_seq(),
        );
        let settled = if open {
            kit_act::act(
                ctx,
                act::agenda::CompleteTask {
                    task_id: task.task_id.clone(),
                },
                &key,
            )
        } else {
            kit_act::act(
                ctx,
                act::agenda::ReopenTask {
                    task_id: task.task_id.clone(),
                },
                &key,
            )
        };
        if !settled.committed {
            self.refused(&settled);
            return;
        }
        // A REPEATING TASK'S COMPLETION IS NOT UNDONE HERE: the engine has
        // already opened its next occurrence, and reopening this one would
        // leave two open copies of one series.
        let undoable = !task.repeats;
        self.status = Some(wire::StatusLine {
            sentence: if open {
                words::task_done(locale)
            } else {
                words::task_reopened(locale)
            },
            action_label: if undoable {
                words::undo(locale)
            } else {
                String::new()
            },
            refused: false,
        });
        self.undo = settled.inverse.filter(|_| undoable);
        self.next_of = (open && task.repeats).then(|| NextOf {
            task_id: task.task_id.clone(),
            series_id: task.series_id.clone(),
        });
        if open {
            self.completed += 1;
        } else {
            self.completed = self.completed.saturating_sub(1);
        }
    }

    /// The status line's Undo: the inverse action, sent as the core described it.
    pub fn undo(&mut self, ctx: &Ctx) {
        let Some(inverse) = self.undo.take() else {
            return;
        };
        let was_completion = inverse.action == "reopen-task";
        let request = wire::ActRequest {
            app: act::agenda::APP.to_owned(),
            action: inverse.action,
            input: inverse.input,
            invoke_key: String::new(),
        };
        let key = kit_act::key(&["undo", &request.action], self.next_seq());
        let settled = kit_act::act(ctx, request, &key);
        self.next_of = None;
        if settled.committed {
            self.status = None;
            if was_completion {
                self.completed = self.completed.saturating_sub(1);
            }
        } else {
            self.refused(&settled);
        }
    }

    /// A QUICK ADD: a bare title, optionally dated and filed, landing in
    /// `lands_in` (the words the status line names). Returns whether it
    /// committed, so a screen clears its field only then.
    pub fn add(
        &mut self,
        ctx: &Ctx,
        title: &str,
        due_day: &str,
        lands_in: &str,
        project_id: Option<&str>,
        section_id: Option<&str>,
    ) -> bool {
        let locale = ctx.locale();
        let request = act::agenda::AddTask {
            title: title.to_owned(),
            due: if due_day.is_empty() {
                Default::default()
            } else {
                crate::field::Field::Is(due_day.to_owned())
            },
            project_id: project_id.map_or(Default::default(), |id| {
                crate::field::Field::Is(id.to_owned())
            }),
            section_id: section_id.map_or(Default::default(), |id| {
                crate::field::Field::Is(id.to_owned())
            }),
            ..Default::default()
        };
        let key = kit_act::key(&["add-task", title], self.next_seq());
        let settled = kit_act::act(ctx, request, &key);
        self.undo = None;
        if settled.committed {
            self.status = Some(wire::StatusLine {
                sentence: format!("{} {lands_in}", words::added_to(locale)),
                action_label: String::new(),
                refused: false,
            });
        } else {
            self.refused(&settled);
        }
        settled.committed
    }

    /// File a task: a project (and section), or the Inbox (`project_id` None).
    /// `label` names where, for the status line.
    pub fn file(
        &mut self,
        ctx: &Ctx,
        task: &wire::AgendaTask,
        project_id: Option<&str>,
        section_id: Option<&str>,
        label: &str,
    ) {
        let locale = ctx.locale();
        // A project without a section CLEARS the section, because a section of
        // another project would be refused; the Inbox clears both.
        let clear = || crate::field::Field::Clear;
        let request = act::agenda::OrganizeTask {
            task_id: task.task_id.clone(),
            project_id: project_id.map_or_else(clear, |id| crate::field::Field::Is(id.to_owned())),
            section_id: match (project_id, section_id) {
                (Some(_), Some(section)) => crate::field::Field::Is(section.to_owned()),
                _ => crate::field::Field::Clear,
            },
            position: Some(task.sort_order as f64),
            ..Default::default()
        };
        let key = kit_act::key(
            &[
                "organize-task",
                &task.task_id,
                project_id.unwrap_or_default(),
                section_id.unwrap_or_default(),
            ],
            self.next_seq(),
        );
        let settled = kit_act::act(ctx, request, &key);
        self.undo = None;
        if settled.committed {
            self.status = Some(wire::StatusLine {
                sentence: format!("{} {label}", words::filed_in(locale)),
                action_label: String::new(),
                refused: false,
            });
        } else {
            self.refused(&settled);
        }
    }

    /// A create with no row to draw (a project, a section): the status line says it.
    pub fn created(
        &mut self,
        ctx: &Ctx,
        request: impl Into<wire::ActRequest>,
        subject: &str,
        done: String,
    ) -> bool {
        let key = kit_act::key(&["create", subject], self.next_seq());
        let settled = kit_act::act(ctx, request, &key);
        self.undo = None;
        if settled.committed {
            self.status = Some(wire::StatusLine {
                sentence: done,
                action_label: String::new(),
                refused: false,
            });
        } else {
            self.refused(&settled);
        }
        settled.committed
    }

    /// A NEW ANSWER: a repeating task completed here names where its next
    /// occurrence landed, when the answer carries it.
    pub fn answered(&mut self, locale: Locale, open: &[&wire::AgendaTask], today: &str) {
        let Some(done) = &self.next_of else {
            return;
        };
        let next = open.iter().find(|task| {
            !task.due_day.is_empty()
                && (task.task_id == done.task_id
                    || done.series_id.is_some() && task.series_id == done.series_id
                    // THE FIRST COMPLETION OF A SERIES: the next one's series is
                    // the task that was completed.
                    || task.series_id.as_deref() == Some(done.task_id.as_str()))
        });
        let Some(next) = next else {
            return;
        };
        if self
            .status
            .as_ref()
            .is_some_and(|s| s.sentence == words::task_done(locale))
        {
            self.status = Some(wire::StatusLine {
                sentence: format!(
                    "{} · {} {}",
                    words::task_done(locale),
                    words::next_one_is(locale),
                    civil::relative_day(locale, &next.due_day, today)
                ),
                action_label: String::new(),
                refused: false,
            });
        }
        self.next_of = None;
    }
}
