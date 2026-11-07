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
use crate::strings::{Locale, agenda_reminders as reminders, task as words};

/// A repeating task completed here: where its next one landed is named when the
/// next load carries it.
#[derive(Clone, Debug)]
struct NextOf {
    task_id: String,
    series_id: Option<String>,
}

/// A task as a sheet or a toolbar stages it: what one add writes. Empty text is
/// absent and priority 0 is none.
#[derive(Clone, Copy, Debug, Default)]
pub struct NewTask<'a> {
    pub title: &'a str,
    pub notes: &'a str,
    /// A bare day or a floating local time.
    pub due: &'a str,
    pub priority: i64,
    /// A repeat rule.
    pub rule: Option<&'a str>,
    pub project_id: Option<&'a str>,
    pub section_id: Option<&'a str>,
    pub tags: &'a [String],
    pub flagged: bool,
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
        let task = NewTask {
            title,
            due: due_day,
            project_id,
            section_id,
            ..NewTask::default()
        };
        self.add_full(ctx, &task, lands_in).is_some()
    }

    /// A NEW TASK WITH EVERYTHING THE SHEETS CAN STAGE (#1173): one `add-task`,
    /// then its tags and its flag. Returns the new id when the task committed.
    /// A tag or a flag the vault refuses after the add leaves the task made and
    /// says the refusal, so a screen never files the same task twice.
    pub fn add_full(&mut self, ctx: &Ctx, task: &NewTask, lands_in: &str) -> Option<String> {
        let locale = ctx.locale();
        let text = |value: &str| {
            if value.is_empty() {
                Default::default()
            } else {
                crate::field::Field::Is(value.to_owned())
            }
        };
        let request = act::agenda::AddTask {
            title: task.title.to_owned(),
            description: text(task.notes),
            due: text(task.due),
            priority: (task.priority > 0).then_some(task.priority),
            rule: text(task.rule.unwrap_or_default()),
            project_id: text(task.project_id.unwrap_or_default()),
            section_id: text(task.section_id.unwrap_or_default()),
            ..Default::default()
        };
        let key = kit_act::key(&["add-task", task.title], self.next_seq());
        let settled = kit_act::act(ctx, request, &key);
        self.undo = None;
        if !settled.committed {
            self.refused(&settled);
            return None;
        }
        self.status = Some(wire::StatusLine {
            sentence: format!("{} {lands_in}", words::added_to(locale)),
            action_label: String::new(),
            refused: false,
        });
        let id = settled.output_text("id")?;
        for label in task.tags {
            let key = kit_act::key(&["add-task-tag", &id, label], self.next_seq());
            let tagged = kit_act::act(
                ctx,
                act::agenda::AddTaskTag {
                    task_id: id.clone(),
                    label: label.clone(),
                },
                &key,
            );
            if !tagged.committed {
                self.refused(&tagged);
                return Some(id);
            }
        }
        if task.flagged {
            let key = kit_act::key(&["star-task", &id], self.next_seq());
            let starred = kit_act::act(
                ctx,
                act::agenda::StarTask {
                    task_id: id.clone(),
                },
                &key,
            );
            if !starred.committed {
                self.refused(&starred);
            }
        }
        Some(id)
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

    /// THE FLAG (#1173): set or clear the starred flag on a task. The status
    /// line says it, and the inverse is the other verb, so Undo flips it back.
    pub fn flag(&mut self, ctx: &Ctx, task_id: &str, on: bool) -> bool {
        let locale = ctx.locale();
        let key = kit_act::key(
            &[if on { "star-task" } else { "unstar-task" }, task_id],
            self.next_seq(),
        );
        let settled = if on {
            kit_act::act(
                ctx,
                act::agenda::StarTask {
                    task_id: task_id.to_owned(),
                },
                &key,
            )
        } else {
            kit_act::act(
                ctx,
                act::agenda::UnstarTask {
                    task_id: task_id.to_owned(),
                },
                &key,
            )
        };
        if !settled.committed {
            self.refused(&settled);
            return false;
        }
        self.status = Some(wire::StatusLine {
            sentence: if on {
                reminders::row_flagged(locale)
            } else {
                reminders::row_unflagged(locale)
            },
            action_label: words::undo(locale),
            refused: false,
        });
        self.undo = settled.inverse;
        true
    }

    /// THE SWIPE'S DELETE: the task goes to the trash with its subtasks and
    /// Undo restores it.
    pub fn delete(&mut self, ctx: &Ctx, task_id: &str) -> bool {
        let locale = ctx.locale();
        let key = kit_act::key(&["delete-task", task_id], self.next_seq());
        let settled = kit_act::act(
            ctx,
            act::agenda::DeleteTask {
                task_id: task_id.to_owned(),
            },
            &key,
        );
        if !settled.committed {
            self.refused(&settled);
            return false;
        }
        self.status = Some(wire::StatusLine {
            sentence: words::task_deleted(locale),
            action_label: words::undo(locale),
            refused: false,
        });
        self.undo = settled.inverse;
        true
    }

    /// DRAG TO REORDER (#1173): put `task_id` at `position`. Only the position
    /// changes: the project and the section stay as stored.
    pub fn reposition(&mut self, ctx: &Ctx, task_id: &str, position: f64) -> bool {
        let key = kit_act::key(&["organize-task", task_id, "position"], self.next_seq());
        let settled = kit_act::act(
            ctx,
            act::agenda::OrganizeTask {
                task_id: task_id.to_owned(),
                position: Some(position),
                ..Default::default()
            },
            &key,
        );
        self.undo = None;
        if settled.committed {
            self.status = None;
        } else {
            self.refused(&settled);
        }
        settled.committed
    }

    /// "Clear": the completed tasks of a list go to the trash (30 days, the
    /// Trash page restores them). One status line says it; there is no
    /// single Undo for many writes.
    pub fn clear_completed(&mut self, ctx: &Ctx, task_ids: &[String]) -> bool {
        let locale = ctx.locale();
        for id in task_ids {
            let key = kit_act::key(&["delete-task", id, "cleared"], self.next_seq());
            let settled = kit_act::act(
                ctx,
                act::agenda::DeleteTask {
                    task_id: id.clone(),
                },
                &key,
            );
            if !settled.committed {
                self.refused(&settled);
                return false;
            }
        }
        self.undo = None;
        self.status = Some(wire::StatusLine {
            sentence: reminders::completed_cleared(locale),
            action_label: String::new(),
            refused: false,
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
