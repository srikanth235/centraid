//! THE LAWS OF A REMINDER LIST'S ROW WRITES (round 10 of #1173): check off, undo, add, file, flag,
//! delete, reorder and clear, for the Reminders home, a list, a project and Catch up alike. The status
//! line and Undo plumbing is the kit's [`Ops`]; the writes below are Reminders' alone, so Calendar
//! carries none of them.

use centraid_api_proto::core_v1 as wire;

use crate::catalog::act;
use crate::kit::act::{self as kit_act};
use crate::kit::civil;
use crate::kit::schedule::natural::Fields;
use crate::kit::schedule::ops::Ops;
use crate::screen::Ctx;
use crate::strings::{Locale, agenda_reminders as reminders, task as words};

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
    /// A web address, already normalised.
    pub url: Option<&'a str>,
    pub project_id: Option<&'a str>,
    pub section_id: Option<&'a str>,
    pub tags: &'a [String],
    pub flagged: bool,
    /// The due is a wall clock: the request names the device's zone beside it.
    pub timed: bool,
}

impl<'a> NewTask<'a> {
    /// A task of what the date chip read. A repeat with no due is never sent.
    #[must_use]
    pub fn dated(fields: &'a Fields) -> Self {
        Self {
            title: &fields.title,
            due: &fields.due,
            rule: fields.rule.as_deref().filter(|_| !fields.due.is_empty()),
            timed: fields.timed,
            ..Self::default()
        }
    }
}

/// The `add-task` command a staged task writes. Empty text is absent, and a
/// priority of 0 is none.
#[must_use]
pub fn add_request(task: &NewTask) -> act::reminders::AddTask {
    let text = |value: &str| {
        if value.is_empty() {
            Default::default()
        } else {
            crate::field::Field::Is(value.to_owned())
        }
    };
    act::reminders::AddTask {
        title: task.title.to_owned(),
        description: text(task.notes),
        due: text(task.due),
        priority: (task.priority > 0).then_some(task.priority),
        rule: text(task.rule.unwrap_or_default()),
        project_id: text(task.project_id.unwrap_or_default()),
        section_id: text(task.section_id.unwrap_or_default()),
        url: text(task.url.unwrap_or_default()),
        ..Default::default()
    }
}

impl Ops {
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
        let fields = Fields {
            title: title.to_owned(),
            due: due_day.to_owned(),
            ..Fields::default()
        };
        self.add_fields(ctx, &fields, lands_in, project_id, section_id)
    }

    /// [`Self::add`] with what the date chip read: a due, a repeat rule, and the
    /// device's zone beside a wall-clock due. A repeat with no due is never sent.
    pub fn add_fields(
        &mut self,
        ctx: &Ctx,
        fields: &Fields,
        lands_in: &str,
        project_id: Option<&str>,
        section_id: Option<&str>,
    ) -> bool {
        let task = NewTask {
            project_id,
            section_id,
            ..NewTask::dated(fields)
        };
        self.add_full(ctx, &task, lands_in).is_some()
    }

    /// A NEW TASK WITH EVERYTHING THE SHEETS CAN STAGE (#1173): one `add-task`,
    /// then its tags and its flag. Returns the new id when the task committed.
    /// A tag or a flag the vault refuses after the add leaves the task made and
    /// says the refusal, so a screen never files the same task twice.
    pub fn add_full(&mut self, ctx: &Ctx, task: &NewTask, lands_in: &str) -> Option<String> {
        let mut request = add_request(task);
        // A wall-clock due names the device's zone beside it.
        if task.timed && !task.due.is_empty() {
            request.zone = crate::field::Field::Is(ctx.zone().to_owned());
        }
        let key = kit_act::key(&["add-task", task.title], self.next_seq());
        let settled = self.line.act(ctx, request, &key, |locale| {
            format!("{} {lands_in}", words::added_to(locale))
        });
        if !settled.committed {
            return None;
        }
        let id = settled.output_text("id")?;
        for label in task.tags {
            let key = kit_act::key(&["add-task-tag", &id, label], self.next_seq());
            let tagged = self.line.act_also(
                ctx,
                act::reminders::AddTaskTag {
                    task_id: id.clone(),
                    label: label.clone(),
                },
                &key,
            );
            if !tagged.committed {
                return Some(id);
            }
        }
        if task.flagged {
            let key = kit_act::key(&["star-task", &id], self.next_seq());
            self.line.act_also(
                ctx,
                act::reminders::StarTask {
                    task_id: id.clone(),
                },
                &key,
            );
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
        // A project without a section CLEARS the section, because a section of
        // another project would be refused; the Inbox clears both.
        let clear = || crate::field::Field::Clear;
        let request = act::reminders::OrganizeTask {
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
        self.line.act(ctx, request, &key, |locale| {
            format!("{} {label}", words::filed_in(locale))
        });
    }

    /// THE FLAG (#1173): set or clear the starred flag on a task. The status
    /// line says it, and the inverse is the other verb, so Undo flips it back.
    pub fn flag(&mut self, ctx: &Ctx, task_id: &str, on: bool) -> bool {
        let key = kit_act::key(
            &[if on { "star-task" } else { "unstar-task" }, task_id],
            self.next_seq(),
        );
        let task_id = task_id.to_owned();
        let request: wire::ActRequest = if on {
            act::reminders::StarTask { task_id }.into()
        } else {
            act::reminders::UnstarTask { task_id }.into()
        };
        self.line
            .act(
                ctx,
                request,
                &key,
                if on {
                    reminders::row_flagged
                } else {
                    reminders::row_unflagged
                },
            )
            .committed
    }

    /// THE SWIPE'S DELETE: the task goes to the trash with its subtasks and
    /// Undo restores it.
    pub fn delete(&mut self, ctx: &Ctx, task_id: &str, title: &str) -> bool {
        let key = kit_act::key(&["delete-task", task_id], self.next_seq());
        self.line
            .act(
                ctx,
                act::reminders::DeleteTask {
                    task_id: task_id.to_owned(),
                },
                &key,
                |locale| crate::kit::trash::moved_to_trash(locale, title),
            )
            .committed
    }

    /// DRAG TO REORDER (#1173): put `task_id` at `position`. Only the position
    /// changes: the project and the section stay as stored.
    pub fn reposition(&mut self, ctx: &Ctx, task_id: &str, position: f64) -> bool {
        let key = kit_act::key(&["organize-task", task_id, "position"], self.next_seq());
        self.line
            .act_quietly(
                ctx,
                act::reminders::OrganizeTask {
                    task_id: task_id.to_owned(),
                    position: Some(position),
                    ..Default::default()
                },
                &key,
            )
            .committed
    }

    /// "Clear": the completed tasks of a list go to the trash (30 days, the
    /// Trash page restores them). One status line says it, and ONE Undo
    /// restores every task it cleared.
    pub fn clear_completed(&mut self, ctx: &Ctx, task_ids: &[String]) -> bool {
        let requests = task_ids
            .iter()
            .map(|id| {
                let key = kit_act::key(&["delete-task", id, "cleared"], self.next_seq());
                (
                    act::reminders::DeleteTask {
                        task_id: id.clone(),
                    }
                    .into(),
                    key,
                )
            })
            .collect::<Vec<(wire::ActRequest, String)>>();
        let answers = self
            .line
            .act_all(ctx, requests, reminders::completed_cleared);
        answers.len() == task_ids.len() && answers.iter().all(|settled| settled.committed)
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
            .status()
            .is_some_and(|s| s.sentence == words::task_done(locale))
        {
            self.line.say(format!(
                "{} · {} {}",
                words::task_done(locale),
                words::next_one_is(locale),
                civil::relative_day(locale, &next.due_day, today)
            ));
        }
        self.next_of = None;
    }
}
