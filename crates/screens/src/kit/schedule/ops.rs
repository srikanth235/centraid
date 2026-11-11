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
//! verdict is the status line, and the next load draws what committed. The line and its Undo are
//! the kit's [`Undo`] (`kit::undo`): the core's own `inverse` for the action, sent back as an
//! action.

use centraid_api_proto::core_v1 as wire;

use crate::catalog::act;
use crate::kit::act as kit_act;
use crate::kit::schedule::rows;
use crate::kit::undo::Undo;
use crate::screen::Ctx;
use crate::strings::task as words;

/// A repeating task completed here: where its next one landed is named when the
/// next load carries it.
#[derive(Clone, Debug)]
pub(crate) struct NextOf {
    pub(crate) task_id: String,
    pub(crate) series_id: Option<String>,
}

/// What a to-do surface holds beside its answers: the status line and Undo (the kit's [`Undo`]),
/// and the count of completions this session.
#[derive(Clone, Debug, Default)]
pub struct Ops {
    pub(crate) seq: u64,
    pub(crate) line: Undo,
    pub(crate) next_of: Option<NextOf>,
    /// Completions this session, for Today's earned quiet.
    pub completed: u32,
}

impl Ops {
    pub(crate) fn next_seq(&mut self) -> u64 {
        self.seq = kit_act::fresh();
        self.seq
    }

    /// The status line to draw.
    #[must_use]
    pub fn status(&self) -> Option<wire::StatusLine> {
        self.line.status()
    }

    /// Say a sentence with no verb.
    pub fn say(&mut self, sentence: String) {
        self.line.say(sentence);
    }

    /// Drop the line (a screen left, or a newer thing replaces it).
    pub fn clear(&mut self) {
        self.line.clear();
        self.next_of = None;
    }

    /// Whether an Undo is on offer.
    #[must_use]
    pub fn can_undo(&self) -> bool {
        self.line.can_undo()
    }

    /// The box. Open work completes; closed work (the Logbook) reopens.
    pub fn check(&mut self, ctx: &Ctx, task: &wire::AgendaTask) {
        let open = rows::is_open(task);
        let key = kit_act::key(
            &[
                if open { "complete-task" } else { "reopen-task" },
                &task.task_id,
            ],
            self.next_seq(),
        );
        let task_id = task.task_id.clone();
        let settled = if open {
            self.line.act(
                ctx,
                act::reminders::CompleteTask { task_id },
                &key,
                words::task_done,
            )
        } else {
            self.line.act(
                ctx,
                act::reminders::ReopenTask { task_id },
                &key,
                words::task_reopened,
            )
        };
        if !settled.committed {
            return;
        }
        // A REPEATING TASK'S COMPLETION IS NOT UNDONE HERE: the engine has
        // already opened its next occurrence, and reopening this one would
        // leave two open copies of one series.
        if task.repeats {
            self.line.withdraw();
        }
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
        let was_completion = self
            .line
            .offered()
            .is_some_and(|inverse| inverse.action == "reopen-task");
        let done = self.line.acted(ctx);
        self.next_of = None;
        if done && was_completion {
            self.completed = self.completed.saturating_sub(1);
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
        let key = kit_act::key(&[&request.action, subject], self.next_seq());
        self.line
            .act_reverting(ctx, request, revert, &key, |_| sentence)
            .committed
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
        self.line.act(ctx, request, &key, |_| done).committed
    }
}
