//! WHAT A SCREEN HOLDS BESIDE ITS ANSWERS WHEN IT WRITES: the one status line, what Undo reverses,
//! the box that checks a reminder off, and the writes with no inverse of their own (an event
//! dragged to other times, a calendar or a list made). The rest of a list's row writes (add, file,
//! flag, delete, reorder) are Reminders' own (`reminders::ops`).
//!
//! THE TICK IS REMINDERS' WRITE. Calendar draws a dated reminder on its day and lets the member
//! tick it there, as Apple's does, but the write it sends is Reminders' own `complete-task` or
//! `reopen-task`: Reminders owns the change, and Calendar's manifest holds no task write at all.
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

use crate::catalog::act;
use crate::kit::act::{self as kit_act, Settled};
use crate::kit::schedule::rows;
use crate::screen::Ctx;
use crate::strings::task as words;

/// A repeating task completed here: where its next one landed is named when the
/// next load carries it.
#[derive(Clone, Debug)]
pub(crate) struct NextOf {
    pub(crate) task_id: String,
    pub(crate) series_id: Option<String>,
}

/// What a to-do surface holds beside its answers: the one status line, what
/// Undo reverses, and the count of completions this session.
#[derive(Clone, Debug, Default)]
pub struct Ops {
    pub(crate) seq: u64,
    pub status: Option<wire::StatusLine>,
    pub(crate) undo: Option<wire::ActInverse>,
    /// The app the Undo is sent to: Reminders' for a task, Calendar's for an event rewritten on the
    /// grid (`changed`).
    pub(crate) undo_app: Option<String>,
    pub(crate) next_of: Option<NextOf>,
    /// Completions this session, for Today's earned quiet.
    pub completed: u32,
}

impl Ops {
    pub(crate) fn next_seq(&mut self) -> u64 {
        self.seq = kit_act::fresh();
        self.seq
    }

    pub(crate) fn refused(&mut self, settled: &Settled) {
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
                act::reminders::CompleteTask {
                    task_id: task.task_id.clone(),
                },
                &key,
            )
        } else {
            kit_act::act(
                ctx,
                act::reminders::ReopenTask {
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
            app: self
                .undo_app
                .take()
                .unwrap_or_else(|| act::reminders::APP.to_owned()),
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

    /// A WRITE THE CORE KNOWS NO INVERSE FOR (an event dragged to other times):
    /// `revert` is the same command carrying the old values, and Undo sends it
    /// under a key of its own. The status line says `sentence`.
    pub fn changed(
        &mut self,
        ctx: &Ctx,
        subject: &str,
        request: impl Into<wire::ActRequest>,
        revert: impl Into<wire::ActRequest>,
        sentence: String,
    ) -> bool {
        let request = request.into();
        let revert = revert.into();
        let key = kit_act::key(&[&request.action, subject], self.next_seq());
        let settled = kit_act::act(ctx, request, &key);
        if !settled.committed {
            self.refused(&settled);
            return false;
        }
        self.status = Some(wire::StatusLine {
            sentence,
            action_label: words::undo(ctx.locale()),
            refused: false,
        });
        self.undo_app = Some(revert.app.clone());
        self.undo = Some(wire::ActInverse {
            action: revert.action,
            input: revert.input,
        });
        true
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
}
