//! THE TASK PAGE (`reminders.task`) — an editor (#1015 D3: autosave everywhere,
//! close = done).
//!
//! The title and the notes are typed, so they autosave ([`Autosave`]: 900 ms,
//! one key per edit, only what changed, a vault change never overwrites
//! typing). Every other field is a decision, so it is one write when it is
//! made: When, Time, Reminder, Repeats, Anchor, Priority, Effort, Project,
//! Tags, a subtask added, Release, Delete. There is no Save.
//!
//! Repeats is the core's sentence ("Every 2 weeks on Monday"), "Never" for a
//! one-off — never v0's "—". The stored rule (`AgendaTask.rrule`) rides as the
//! field's `raw` and pre-selects the preset it is, and is never drawn (#834).
//! A date-only reminder names no moment: "On the day". A date or time picked
//! from the platform's picker closes the field, as a chip does.

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;
use wire::screen_event::Kind as E;
use wire::todo_detail_event::Kind as D;
use wire::todo_detail_state::Asking;

use super::list::{self, Phase};
use crate::catalog::{act, load};
use crate::field::Field;
use crate::kit::act as kit_act;
use crate::kit::autosave::{Autosave, Draft};
use crate::kit::civil::{self, HourCycle};
use crate::kit::read::{self, Reading};
use crate::kit::schedule::attachments::{Attachments, Of};
use crate::kit::schedule::custom::{Custom, Done};
use crate::kit::schedule::ops::Ops;
use crate::kit::schedule::repeat::{REPEAT_CUSTOM, normalize_url};
use crate::kit::schedule::rows::{self, Context};
use crate::kit::schedule::rule_words;
use crate::reminders::routes;
use crate::screen::{Ctx, Screen};
use crate::strings::{
    Locale, agenda_editor as editor_words, agenda_event as link_words,
    agenda_repeat as repeat_words, agenda_tasks as card_words, task as words,
};

/// `TodoField.key`s.
pub const WHEN: &str = "when";
pub const TIME: &str = "time";
pub const REMINDER: &str = "reminder";
pub const REPEATS: &str = "repeats";
pub const ANCHOR: &str = "anchor";
pub const PRIORITY: &str = "priority";
pub const EFFORT: &str = "effort";
pub const PROJECT: &str = "project";
pub const TAGS: &str = "tags";
/// The flag is a switch: its choices are `ON` and `OFF`.
pub const FLAG: &str = "flag";
pub const ON: &str = "on";
pub const OFF: &str = "off";

/// Choice keys.
pub const NONE: &str = "none";
pub const TODAY: &str = "today";
pub const TOMORROW: &str = "tomorrow";
pub const WEEKEND: &str = "weekend";
pub const NEXT_WEEK: &str = "next_week";

const SCHEDULED: &str = "scheduled";
const COMPLETION: &str = "completion";

/// Reminder lead times in minutes, and the words each is drawn in.
const REMINDER_LEADS: [u32; 5] = [0, 10, 30, 60, 1440];

/// The repeat presets: choice key and the rule it writes.
const REPEAT_RULES: [(&str, &str); 4] = [
    ("daily", "FREQ=DAILY"),
    ("weekly", "FREQ=WEEKLY"),
    ("monthly", "FREQ=MONTHLY"),
    ("yearly", "FREQ=YEARLY"),
];

const EFFORTS: [i64; 4] = [5, 15, 25, 60];

/// The words a member types on the task page: its title and its notes.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Typed {
    id: String,
    title: String,
    notes: String,
}

impl Draft for Typed {
    const ACTION: &'static str = act::reminders::EditTask::NAME;

    fn subject(&self) -> &str {
        &self.id
    }

    /// A task needs a name: an emptied title is kept on screen and not sent.
    fn refusal(&self, locale: Locale) -> Option<String> {
        self.title
            .trim()
            .is_empty()
            .then(|| words::title_required(locale))
    }

    /// `edit-task` naming ONLY the words that changed.
    fn request(&self, baseline: &Self) -> Option<wire::ActRequest> {
        let title = self.title.trim() != baseline.title.trim();
        let notes = self.notes != baseline.notes;
        if !title && !notes {
            return None;
        }
        Some(
            act::reminders::EditTask {
                task_id: self.id.clone(),
                title: title.then(|| self.title.trim().to_owned()),
                description: match (notes, self.notes.trim().is_empty()) {
                    (false, _) => Field::Keep,
                    (true, true) => Field::Clear,
                    (true, false) => Field::Is(self.notes.clone()),
                },
                ..Default::default()
            }
            .into(),
        )
    }
}

/// What the page holds of its reads.
#[derive(Clone, Debug)]
struct Answered {
    detail: wire::AgendaTaskDetail,
    /// The projects the Project field offers; `None` until a read of them
    /// lands, and then the detail's own project and section stand in.
    projects: Option<wire::AgendaTaskProjects>,
}

impl Answered {
    fn task(&self) -> Option<&wire::AgendaTask> {
        self.detail.task.as_ref()
    }

    fn today(&self) -> &str {
        &self.detail.today
    }

    fn lists(&self) -> (Vec<wire::AgendaTaskProject>, Vec<wire::AgendaTaskSection>) {
        match &self.projects {
            Some(projects) => (projects.projects.clone(), projects.sections.clone()),
            None => (
                self.detail.project.iter().cloned().collect(),
                self.detail.section.iter().cloned().collect(),
            ),
        }
    }
}

#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    let Some(wire::route::Args::TodoDetail(args)) = &route.args else {
        return None;
    };
    if args.task_id.is_empty() {
        return None;
    }
    Some(Box::new(Detail {
        task_id: args.task_id.clone(),
        phase: Phase::Loading,
        projects: None,
        autosave: Autosave::new(),
        asking: Asking::None,
        open_field: String::new(),
        ops: Ops::default(),
        finished: false,
        attachments: Attachments::of(Of::Task, &args.task_id),
        custom: None,
    }))
}

struct Detail {
    task_id: String,
    phase: Phase<Answered>,
    /// The last projects read that landed, kept over a read that does not.
    projects: Option<wire::AgendaTaskProjects>,
    autosave: Autosave<Typed>,
    asking: Asking,
    open_field: String,
    ops: Ops,
    /// The task left (deleted): the shell pops.
    finished: bool,
    /// The photos and files on the task (#1173).
    attachments: Attachments,
    /// The Custom repeat sheet's working rule, while it is open: the editor's own
    /// model (#1173), saved to this task on Done.
    custom: Option<Custom>,
}

impl Detail {
    fn reload(&mut self, ctx: &Ctx) {
        let detail = read::read(
            ctx,
            load::reminders::Task {
                task_id: self.task_id.clone(),
            },
            |answer| match answer {
                Answer::AgendaTask(detail) => Some(detail),
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
        if let Reading::Data(projects) = &projects {
            self.projects = Some(projects.clone());
        }
        self.phase = match (detail, projects) {
            (Reading::Data(detail), _) => Phase::Ready(Answered {
                detail: *detail,
                projects: self.projects.clone(),
            }),
            (Reading::Denied(denial), _) | (_, Reading::Denied(denial)) => Phase::Denied(denial),
            (Reading::Failed, _) => Phase::Failed,
        };
        let Phase::Ready(answer) = &self.phase else {
            return;
        };
        let Some(task) = answer.task() else {
            return;
        };
        self.attachments.reload(ctx);
        let open: Vec<&wire::AgendaTask> = task
            .children
            .iter()
            .chain(std::iter::once(task))
            .filter(|t| rows::is_open(t))
            .collect();
        self.ops.answered(ctx.locale(), &open, answer.today());
        // Over unsaved words the law replaces nothing; the FIELDS are still the
        // vault's, so they are refreshed around the words being typed.
        self.autosave.loaded(Typed {
            id: task.task_id.clone(),
            title: task.title.clone(),
            notes: task.description.clone().unwrap_or_default(),
        });
    }

    fn task(&self) -> Option<wire::AgendaTask> {
        self.phase.data().and_then(Answered::task).cloned()
    }

    fn today(&self) -> String {
        self.phase
            .data()
            .map(|answer| answer.today().to_owned())
            .unwrap_or_default()
    }

    /// One field write: the status line is cleared, then says the refusal when
    /// there is one; the page is read again either way.
    fn write(&mut self, ctx: &Ctx, request: impl Into<wire::ActRequest>, parts: &[&str]) -> bool {
        self.ops.status = None;
        let key = kit_act::key(parts, kit_act::fresh());
        let settled = kit_act::act(ctx, request, &key);
        if !settled.committed {
            self.ops.status = Some(wire::StatusLine {
                sentence: settled.refusal.clone(),
                action_label: String::new(),
                refused: true,
            });
        }
        self.reload(ctx);
        settled.committed
    }

    fn edit(
        &mut self,
        ctx: &Ctx,
        task: &wire::AgendaTask,
        field: &str,
        value: &str,
        edit: act::reminders::EditTask,
    ) {
        self.write(
            ctx,
            edit,
            &[act::reminders::EditTask::NAME, &task.task_id, field, value],
        );
    }

    /// A chip, a card, a sheet row: one write, or nothing when it is already so.
    fn choose(&mut self, ctx: &Ctx, field: &str, key: &str) {
        self.open_field.clear();
        let Some(task) = self.task() else {
            return;
        };
        let today = self.today();
        let base = || act::reminders::EditTask {
            task_id: task.task_id.clone(),
            ..Default::default()
        };
        match field {
            WHEN => {
                if key == NONE {
                    if !task.due_day.is_empty() {
                        self.edit(
                            ctx,
                            &task,
                            WHEN,
                            key,
                            act::reminders::EditTask {
                                due: Field::Clear,
                                ..base()
                            },
                        );
                    }
                } else if let Some(day) = day_for(key, &today).filter(|day| *day != task.due_day) {
                    let due = with_time(&task, &day);
                    self.edit(
                        ctx,
                        &task,
                        WHEN,
                        &day,
                        act::reminders::EditTask {
                            due: Field::Is(due),
                            ..base()
                        },
                    );
                }
            }
            TIME => {
                if key == NONE && !task.due_time.is_empty() {
                    let due = Field::Is(task.due_day.clone());
                    self.edit(
                        ctx,
                        &task,
                        TIME,
                        key,
                        act::reminders::EditTask { due, ..base() },
                    );
                }
            }
            REMINDER => {
                if task.due_day.is_empty() {
                    return;
                }
                if key == NONE {
                    if task.remind_before_min.is_some() {
                        let edit = act::reminders::EditTask {
                            remind_before_min: Field::Clear,
                            ..base()
                        };
                        self.edit(ctx, &task, REMINDER, key, edit);
                    }
                } else if let Some(lead) = key
                    .parse::<u32>()
                    .ok()
                    .filter(|lead| REMINDER_LEADS.contains(lead))
                    .filter(|lead| task.remind_before_min != Some(i64::from(*lead)))
                {
                    let edit = act::reminders::EditTask {
                        remind_before_min: Field::Is(i64::from(lead)),
                        ..base()
                    };
                    self.edit(ctx, &task, REMINDER, key, edit);
                }
            }
            REPEATS => {
                if key == REPEAT_CUSTOM {
                    // Custom opens the editor's sheet over the stored rule.
                    if !task.due_day.is_empty() {
                        self.custom = Some(Custom::open(
                            task.rrule.as_deref().filter(|_| task.repeats),
                            &task.due_day,
                        ));
                    }
                } else if key == NONE {
                    if task.repeats {
                        self.edit(
                            ctx,
                            &task,
                            REPEATS,
                            key,
                            act::reminders::EditTask {
                                rule: Field::Clear,
                                ..base()
                            },
                        );
                    }
                } else if !task.due_day.is_empty() {
                    let Some((_, rule)) = REPEAT_RULES.iter().find(|(name, _)| *name == key) else {
                        return;
                    };
                    if task.rrule.as_deref() != Some(rule) {
                        let edit = act::reminders::EditTask {
                            rule: Field::Is((*rule).to_owned()),
                            ..base()
                        };
                        self.edit(ctx, &task, REPEATS, key, edit);
                    }
                }
            }
            ANCHOR => {
                let anchor = match key {
                    SCHEDULED => act::reminders::OrganizeTaskAnchor::Scheduled,
                    COMPLETION => act::reminders::OrganizeTaskAnchor::Completion,
                    _ => return,
                };
                let current = task.recurrence_anchor.as_deref().unwrap_or(SCHEDULED);
                if task.repeats && current != key {
                    let request = act::reminders::OrganizeTask {
                        task_id: task.task_id.clone(),
                        anchor: Some(anchor),
                        ..Default::default()
                    };
                    self.write(
                        ctx,
                        request,
                        &[
                            act::reminders::OrganizeTask::NAME,
                            &task.task_id,
                            ANCHOR,
                            key,
                        ],
                    );
                }
            }
            PRIORITY => {
                let level = if key == NONE {
                    Some(0)
                } else {
                    key.parse::<i64>()
                        .ok()
                        .filter(|level| (1..=3).contains(level))
                };
                if let Some(level) = level.filter(|level| *level != task.priority.clamp(0, 3)) {
                    let edit = act::reminders::EditTask {
                        priority: Some(level),
                        ..base()
                    };
                    self.edit(ctx, &task, PRIORITY, key, edit);
                }
            }
            EFFORT => {
                if key == NONE {
                    if task.effort_min.is_some() {
                        let edit = act::reminders::EditTask {
                            effort_min: Field::Clear,
                            ..base()
                        };
                        self.edit(ctx, &task, EFFORT, key, edit);
                    }
                } else if let Some(minutes) = key
                    .parse::<i64>()
                    .ok()
                    .filter(|minutes| EFFORTS.contains(minutes))
                    .filter(|minutes| task.effort_min != Some(*minutes))
                {
                    let edit = act::reminders::EditTask {
                        effort_min: Field::Is(minutes),
                        ..base()
                    };
                    self.edit(ctx, &task, EFFORT, key, edit);
                }
            }
            PROJECT => self.file(ctx, &task, key),
            // THE FLAG SWITCH: `on` sets it and `off` clears it, the same
            // write the row swipe makes; a switch already so is nothing.
            FLAG => {
                let on = match key {
                    ON => true,
                    OFF => false,
                    _ => return,
                };
                if on != task.flagged {
                    self.ops.status = None;
                    self.ops.flag(ctx, &task.task_id, on);
                    self.reload(ctx);
                }
            }
            // A TAG CHIP IS ITS OWN REMOVAL: tapping it untags.
            TAGS => {
                if let Some(tag) = task.tags.iter().find(|tag| tag.concept_id == key) {
                    let request = act::reminders::RemoveTaskTag {
                        task_id: task.task_id.clone(),
                        label: tag.label.clone(),
                    };
                    self.write(
                        ctx,
                        request,
                        &[
                            act::reminders::RemoveTaskTag::NAME,
                            &task.task_id,
                            &tag.concept_id,
                        ],
                    );
                }
            }
            _ => {}
        }
    }

    /// The Project field's choice: the Inbox, a project, or one of its sections.
    fn file(&mut self, ctx: &Ctx, task: &wire::AgendaTask, key: &str) {
        if task.parent_task_id.is_some() {
            return;
        }
        let Some(answer) = self.phase.data() else {
            return;
        };
        let (projects, sections) = answer.lists();
        let place: Option<(Option<String>, Option<String>)> = if key == rows::FILE_INBOX {
            Some((None, None))
        } else if let Some(project) = key.strip_prefix(rows::FILE_PROJECT) {
            projects
                .iter()
                .find(|p| p.project_id == project)
                .map(|p| (Some(p.project_id.clone()), None))
        } else if let Some(section) = key.strip_prefix(rows::FILE_SECTION) {
            sections
                .iter()
                .find(|s| s.section_id == section)
                .map(|s| (Some(s.project_id.clone()), Some(s.section_id.clone())))
        } else {
            None
        };
        let Some((project_id, section_id)) = place else {
            return;
        };
        // A project without a section CLEARS the section: a section of another
        // project would be refused. The Inbox clears both.
        let request = act::reminders::OrganizeTask {
            task_id: task.task_id.clone(),
            project_id: project_id.map_or(Field::Clear, Field::Is),
            section_id: section_id.map_or(Field::Clear, Field::Is),
            position: Some(task.sort_order as f64),
            ..Default::default()
        };
        self.write(
            ctx,
            request,
            &[
                act::reminders::OrganizeTask::NAME,
                &task.task_id,
                PROJECT,
                key,
            ],
        );
    }

    fn confirmed(&mut self, ctx: &Ctx) {
        let asking = std::mem::replace(&mut self.asking, Asking::None);
        let Some(task) = self.task() else {
            return;
        };
        let locale = ctx.locale();
        match asking {
            Asking::Delete => {
                let request = act::reminders::DeleteTask {
                    task_id: task.task_id.clone(),
                };
                if self.write(
                    ctx,
                    request,
                    &[act::reminders::DeleteTask::NAME, &task.task_id],
                ) {
                    self.finished = true;
                    // The words are gone with the task: leaving saves nothing.
                    self.autosave = Autosave::new();
                    self.ops.status =
                        Some(say(crate::kit::trash::moved_to_trash(locale, &task.title)));
                }
            }
            Asking::Release => {
                let request = act::reminders::CancelTask {
                    task_id: task.task_id.clone(),
                };
                if self.write(
                    ctx,
                    request,
                    &[act::reminders::CancelTask::NAME, &task.task_id],
                ) {
                    self.ops.status = Some(say(words::task_released(locale)));
                }
            }
            _ => {}
        }
    }

    /// One control of the page. Most are writes; an open link and an add ask the shell.
    fn event(&mut self, event: wire::TodoDetailEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(D::OpenLink(_)) => return self.open_link(),
            Some(D::Attachment(attachment)) => return self.attachments.event(ctx, attachment),
            _ => self.changed(event, ctx),
        }
        Vec::new()
    }

    /// The address as the browser is asked for it: a web address, with `https://` put on a bare
    /// domain. Nothing else is ever opened from a task.
    fn open_link(&self) -> Vec<wire::Effect> {
        let Some(url) = self
            .task()
            .and_then(|task| task.url)
            .and_then(|url| normalize_url(&url))
            .filter(|url| !url.is_empty())
        else {
            return Vec::new();
        };
        vec![wire::Effect {
            kind: Some(wire::effect::Kind::OpenUrl(wire::OpenUrl { url })),
        }]
    }

    fn changed(&mut self, event: wire::TodoDetailEvent, ctx: &Ctx) {
        match event.kind {
            Some(D::Refreshed(_)) => self.reload(ctx),
            Some(D::Title(typed)) => self.autosave.edit(ctx, |draft| draft.title = typed.title),
            Some(D::Notes(typed)) => self.autosave.edit(ctx, |draft| draft.notes = typed.notes),
            Some(D::FieldChoice(choice)) => self.choose(ctx, &choice.field, &choice.key),
            // A PICK IS A CHOICE: the field closes, as a chip closes it.
            Some(D::DatePicked(picked)) => {
                self.open_field.clear();
                let Some(task) = self.task() else {
                    return;
                };
                if civil::iso_weekday_of(&picked.day).is_some() && picked.day != task.due_day {
                    let due = with_time(&task, &picked.day);
                    let edit = act::reminders::EditTask {
                        task_id: task.task_id.clone(),
                        due: Field::Is(due),
                        ..Default::default()
                    };
                    self.edit(ctx, &task, WHEN, &picked.day, edit);
                }
            }
            Some(D::TimePicked(picked)) => {
                self.open_field.clear();
                let Some(task) = self.task() else {
                    return;
                };
                let day = if task.due_day.is_empty() {
                    self.today()
                } else {
                    task.due_day.clone()
                };
                if is_clock(&picked.time) && picked.time != task.due_time && !day.is_empty() {
                    let edit = act::reminders::EditTask {
                        task_id: task.task_id.clone(),
                        due: Field::Is(format!("{day}T{}", picked.time)),
                        ..Default::default()
                    };
                    self.edit(ctx, &task, TIME, &picked.time, edit);
                }
            }
            Some(D::FieldOpened(opened)) => self.open_field = opened.field,
            Some(D::FieldClosed(_)) => {
                self.open_field.clear();
                self.custom = None;
            }
            Some(D::CustomRepeat(editor)) => self.custom_event(ctx, editor),
            Some(D::TagAdded(added)) => {
                let label = added.label.trim().to_owned();
                if let Some(task) = self.task().filter(|_| !label.is_empty()) {
                    let request = act::reminders::AddTaskTag {
                        task_id: task.task_id.clone(),
                        label: label.clone(),
                    };
                    self.write(
                        ctx,
                        request,
                        &[act::reminders::AddTaskTag::NAME, &task.task_id, &label],
                    );
                }
            }
            Some(D::Check(_)) => {
                if let Some(task) = self.task() {
                    self.ops.check(ctx, &task);
                    self.reload(ctx);
                }
            }
            Some(D::SubtaskChecked(checked)) => {
                let child = self.task().and_then(|task| {
                    task.children
                        .into_iter()
                        .find(|c| c.task_id == checked.task_id)
                });
                if let Some(child) = child {
                    self.ops.check(ctx, &child);
                    self.reload(ctx);
                }
            }
            Some(D::StatusActed(_)) => {
                self.ops.undo(ctx);
                self.reload(ctx);
            }
            Some(D::SubtaskAdded(added)) => {
                let title = added.title.trim().to_owned();
                let Some(task) = self
                    .task()
                    .filter(|t| t.parent_task_id.is_none() && !title.is_empty())
                else {
                    return;
                };
                let request = act::reminders::AddTask {
                    title: title.clone(),
                    parent_id: Field::Is(task.task_id.clone()),
                    ..Default::default()
                };
                self.write(
                    ctx,
                    request,
                    &[act::reminders::AddTask::NAME, &task.task_id, "sub", &title],
                );
            }
            Some(D::Delete(_)) => self.asking = Asking::Delete,
            // RELEASING DESTROYS NOTHING: the outlined secondary, not `net`.
            Some(D::Release(_)) => self.asking = Asking::Release,
            Some(D::Confirmed(_)) => self.confirmed(ctx),
            Some(D::Dismissed(_)) => self.asking = Asking::None,
            // The page's asks of the shell are `event`'s.
            Some(D::OpenLink(_) | D::Attachment(_)) | None => {}
        }
    }

    /// One event of the Custom repeat sheet. Done writes the rule to the task
    /// (when it is a new one) and closes the sheet; a read-only sheet only closes.
    fn custom_event(&mut self, ctx: &Ctx, event: wire::AgendaEditorEvent) {
        let (Some(task), Some(kind)) = (self.task(), event.kind) else {
            return;
        };
        let Some(custom) = &mut self.custom else {
            return;
        };
        if custom.on_event(&kind, &task.due_day) != Done::Applied {
            return;
        }
        let rule = custom.rule(&task.due_day);
        self.custom = None;
        if let Some(rule) = rule.filter(|rule| task.rrule.as_deref() != Some(rule.as_str())) {
            let edit = act::reminders::EditTask {
                task_id: task.task_id.clone(),
                rule: Field::Is(rule),
                ..Default::default()
            };
            self.edit(ctx, &task, REPEATS, REPEAT_CUSTOM, edit);
        }
    }

    /// The Custom repeat sheet, while it is open.
    fn custom_sheet(
        &self,
        locale: Locale,
        task: &wire::AgendaTask,
    ) -> Option<wire::AgendaCustomRepeatSheet> {
        let custom = self.custom.as_ref()?;
        Some(custom.sheet(locale, &task.due_day, || {
            task.rrule
                .as_deref()
                .and_then(|rule| rule_words::of_rule(locale, rule))
                .unwrap_or_else(|| repeat_words::unrepresentable(locale))
        }))
    }

    fn confirm(&self, locale: Locale) -> Option<wire::Confirm> {
        match self.asking {
            Asking::Delete => Some(wire::Confirm {
                title: words::delete_title(locale),
                body: words::delete_body(locale),
                confirm_label: words::delete(locale),
                destructive: true,
            }),
            Asking::Release => Some(wire::Confirm {
                title: words::release_title(locale),
                body: words::release_body(locale),
                confirm_label: words::release(locale),
                destructive: false,
            }),
            _ => None,
        }
    }

    fn data(
        &self,
        locale: Locale,
        cycle: HourCycle,
        answer: &Answered,
        task: &wire::AgendaTask,
    ) -> wire::TodoDetailData {
        let today = answer.today();
        let (projects, sections) = answer.lists();
        let row_ctx = Context {
            show_project: false,
            cycle,
            ..Context::of(today, &projects, &sections)
        };
        let check = rows::check_of(&task.status);
        let open = rows::is_open(task);
        let title = if task.title.trim().is_empty() {
            words::untitled(locale)
        } else {
            task.title.clone()
        };
        let subtask = task.parent_task_id.is_some();
        let parent_id = answer
            .detail
            .parent
            .as_ref()
            .map(|parent| parent.task_id.clone())
            .or_else(|| task.parent_task_id.clone())
            .unwrap_or_default();
        let draft = self.autosave.draft();
        wire::TodoDetailData {
            draft: Some(wire::TodoDraft {
                title: draft.map_or_else(|| task.title.clone(), |d| d.title.clone()),
                notes: draft.map_or_else(
                    || task.description.clone().unwrap_or_default(),
                    |d| d.notes.clone(),
                ),
            }),
            check: check as i32,
            check_label: rows::check_label(locale, &title, open),
            status_label: match check {
                wire::TodoCheck::Done => words::done(locale),
                wire::TodoCheck::WontDo => words::wont_do(locale),
                wire::TodoCheck::InProcess => words::started(locale),
                _ => String::new(),
            },
            fields: fields(locale, cycle, task, today, &projects, &sections),
            subtasks_label: if task.children.is_empty() {
                words::field_subtasks(locale)
            } else {
                format!(
                    "{} · {} {} {}",
                    words::field_subtasks(locale),
                    task.done_children,
                    words::of(locale),
                    task.children.len()
                )
            },
            subtasks: task
                .children
                .iter()
                .map(|child| rows::row(locale, child, &row_ctx, true))
                .collect(),
            can_add_subtask: !subtask && open,
            subtask_note: if subtask {
                words::subtask_cap(locale)
            } else {
                String::new()
            },
            parent_route: (!parent_id.is_empty()).then(|| routes::task(&parent_id)),
            parent_title: answer
                .detail
                .parent
                .as_ref()
                .map(|p| p.title.clone())
                .unwrap_or_default(),
            title_placeholder: words::title_placeholder(locale),
            notes_placeholder: words::notes_placeholder(locale),
            add_subtask_placeholder: words::subtask_placeholder(locale),
            delete_label: words::delete(locale),
            release_label: words::release(locale),
            can_release: open,
            today: today.to_owned(),
            link: link_of(locale, task),
            attachments: Some(self.attachments.view(locale)),
            custom_repeat: self.custom_sheet(locale, task),
        }
    }
}

/// The task's address and the control that opens it: absent when it has none.
fn link_of(locale: Locale, task: &wire::AgendaTask) -> Option<wire::TodoLink> {
    let url = task
        .url
        .as_deref()
        .map(str::trim)
        .filter(|url| !url.is_empty())?;
    Some(wire::TodoLink {
        label: link_words::link_label(locale),
        url: url.to_owned(),
        open_label: link_words::link_open_label(locale),
        accessibility_label: crate::strings::fill(
            &link_words::link_spoken_label(locale),
            &[("url", url)],
        ),
    })
}

fn say(sentence: String) -> wire::StatusLine {
    wire::StatusLine {
        sentence,
        action_label: String::new(),
        refused: false,
    }
}

impl Screen for Detail {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Appeared(_) | E::DataChanged(_) | E::EnvironmentChanged(_)) => self.reload(ctx),
            Some(E::TimerFired(fired)) => {
                if self.autosave.fired(ctx, &fired.timer) {
                    self.reload(ctx);
                }
            }
            // CLOSE = DONE: whatever is typed is saved.
            Some(E::Left(_)) => {
                let _ = self.autosave.flush(ctx);
            }
            Some(E::TodoDetail(detail)) => return self.event(detail, ctx),
            // THE SHELL'S ANSWER TO A PICK: the attachments' (an add under way).
            Some(E::EffectResult(result)) => {
                if let Some(outcome) = &result.outcome {
                    return self.attachments.result(ctx, outcome).unwrap_or_default();
                }
            }
            _ => {}
        }
        Vec::new()
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        use wire::todo_detail_state::Content;
        let locale = ctx.locale();
        let content = match &self.phase {
            Phase::Loading => Content::Loading(wire::Loading { first_load: true }),
            Phase::Failed => Content::Failure(read::failure(locale)),
            Phase::Denied(denial) => Content::Denied(list::denied(locale, denial)),
            // GONE is drawn, not failed: never made, deleted, or in the trash.
            Phase::Ready(answer) => match answer.task() {
                Some(task) => {
                    Content::Data(Box::new(self.data(locale, ctx.hour_cycle(), answer, task)))
                }
                None => Content::Gone(wire::EmptyState {
                    headline: words::task_gone(locale),
                    ..wire::EmptyState::default()
                }),
            },
        };
        wire::ViewState {
            kind: Some(wire::view_state::Kind::TodoDetail(wire::TodoDetailState {
                task_id: self.task_id.clone(),
                content: Some(content),
                autosave: Some(self.autosave.view(locale)),
                confirm: self.confirm(locale),
                open_field: self.open_field.clone(),
                chrome: Some(rows::chrome(locale)),
                status: self.ops.status.clone(),
                finished: self.finished,
            })),
            ..wire::ViewState::default()
        }
    }
}

// ---------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------

/// A quick pick's day, from the core's today (never the device clock): this
/// weekend is the Saturday on or after today (today, on a Sunday), next week the
/// Monday after.
#[must_use]
pub fn day_for(key: &str, today: &str) -> Option<String> {
    let weekday = i64::from(civil::iso_weekday_of(today)?);
    match key {
        TODAY => Some(today.to_owned()),
        TOMORROW => civil::plus_days(today, 1),
        WEEKEND => {
            if weekday == 7 {
                Some(today.to_owned())
            } else {
                civil::plus_days(today, 6 - weekday)
            }
        }
        NEXT_WEEK => civil::plus_days(today, 7 - weekday + 1),
        _ => None,
    }
}

/// SETTING THE DAY KEEPS THE TIME (v0's rule): a task due at 09:00 moved is
/// still due at 09:00.
fn with_time(task: &wire::AgendaTask, day: &str) -> String {
    if task.due_time.is_empty() {
        day.to_owned()
    } else {
        format!("{day}T{}", task.due_time)
    }
}

fn is_clock(time: &str) -> bool {
    let bytes = time.as_bytes();
    bytes.len() == 5
        && bytes[2] == b':'
        && time[..2].parse::<u32>().is_ok_and(|hour| hour < 24)
        && time[3..].parse::<u32>().is_ok_and(|minute| minute < 60)
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

fn chip(key: &str, label: String, selected: bool, enabled: bool, meta: String) -> wire::TodoChoice {
    wire::TodoChoice {
        key: key.to_owned(),
        label,
        meta,
        selected,
        enabled,
        ..wire::TodoChoice::default()
    }
}

fn simple(key: &str, label: String, selected: bool) -> wire::TodoChoice {
    chip(key, label, selected, true, String::new())
}

fn lead_label(locale: Locale, lead: u32) -> String {
    match lead {
        0 => words::remind_at_time(locale),
        60 => words::remind_hour(locale),
        1440 => words::remind_day(locale),
        minutes => format!("{minutes} {}", words::minutes_before(locale)),
    }
}

/// The owner's ruling: a moment only when the core supplies one, else "On the day".
fn reminder_value(
    locale: Locale,
    cycle: HourCycle,
    task: &wire::AgendaTask,
    today: &str,
) -> String {
    if task.remind_before_min.is_none() {
        words::remind_none(locale)
    } else if !task.remind_at_local.is_empty() {
        format!(
            "{} {}",
            civil::relative_day(
                locale,
                task.remind_at_local.get(..10).unwrap_or_default(),
                today
            ),
            civil::clock_for(locale, &task.remind_at_local, cycle)
        )
    } else {
        words::reminder_on_the_day(locale)
    }
}

fn fields(
    locale: Locale,
    cycle: HourCycle,
    task: &wire::AgendaTask,
    today: &str,
    projects: &[wire::AgendaTaskProject],
    sections: &[wire::AgendaTaskSection],
) -> Vec<wire::TodoField> {
    let dated = !task.due_day.is_empty();
    let mut out = Vec::new();

    let mut when_choices: Vec<wire::TodoChoice> = [
        (TODAY, words::when_today(locale)),
        (TOMORROW, words::when_tomorrow(locale)),
        (WEEKEND, words::when_weekend(locale)),
        (NEXT_WEEK, words::when_next_week(locale)),
    ]
    .into_iter()
    .map(|(key, label)| {
        let day = day_for(key, today);
        chip(
            key,
            label,
            day.as_deref() == Some(task.due_day.as_str()) && day.is_some(),
            day.is_some(),
            String::new(),
        )
    })
    .collect();
    when_choices.push(simple(NONE, words::when_none(locale), !dated));
    out.push(wire::TodoField {
        key: WHEN.to_owned(),
        label: words::field_when(locale),
        group: card_words::group_date_time(locale),
        value: if dated {
            civil::relative_day(locale, &task.due_day, today)
        } else {
            words::when_none(locale)
        },
        choices: when_choices,
        pick_date: true,
        enabled: true,
        // THE PICKER OPENS ON THE DUE DAY, else the core's today.
        day: if dated {
            task.due_day.clone()
        } else {
            today.to_owned()
        },
        pick_label: words::pick_date(locale),
        ..wire::TodoField::default()
    });

    out.push(wire::TodoField {
        key: TIME.to_owned(),
        label: words::field_time(locale),
        value: if task.due_time.is_empty() {
            words::time_none(locale)
        } else {
            civil::time_for(locale, &task.due_time, cycle)
        },
        choices: vec![chip(
            NONE,
            words::time_none(locale),
            task.due_time.is_empty(),
            !task.due_time.is_empty(),
            String::new(),
        )],
        pick_time: true,
        enabled: true,
        day: if dated {
            task.due_day.clone()
        } else {
            today.to_owned()
        },
        time: task.due_time.clone(),
        pick_label: words::pick_time(locale),
        ..wire::TodoField::default()
    });

    let mut reminder_choices = vec![chip(
        NONE,
        words::remind_none(locale),
        task.remind_before_min.is_none(),
        dated,
        String::new(),
    )];
    reminder_choices.extend(REMINDER_LEADS.iter().map(|lead| {
        chip(
            &lead.to_string(),
            lead_label(locale, *lead),
            task.remind_before_min == Some(i64::from(*lead)),
            dated,
            String::new(),
        )
    }));
    out.push(wire::TodoField {
        key: REMINDER.to_owned(),
        label: words::field_reminder(locale),
        value: reminder_value(locale, cycle, task, today),
        note: if dated {
            words::reminder_note_a(locale)
        } else {
            words::reminder_needs_due(locale)
        },
        choices: reminder_choices,
        enabled: dated,
        ..wire::TodoField::default()
    });

    let mut repeat_choices = vec![simple(NONE, words::repeats_never(locale), !task.repeats)];
    repeat_choices.extend(REPEAT_RULES.iter().map(|(key, rule)| {
        let label = match *key {
            "daily" => words::repeats_daily(locale),
            "weekly" => words::repeats_weekly(locale),
            "monthly" => words::repeats_monthly(locale),
            _ => words::repeats_yearly(locale),
        };
        chip(
            key,
            label,
            task.repeats && task.rrule.as_deref() == Some(*rule),
            dated,
            String::new(),
        )
    }));
    // CUSTOM: any stored rule that is not a preset is this choice; it opens the sheet.
    let preset = task
        .rrule
        .as_deref()
        .is_some_and(|stored| REPEAT_RULES.iter().any(|(_, rule)| *rule == stored));
    repeat_choices.push(chip(
        REPEAT_CUSTOM,
        editor_words::repeat_custom(locale),
        task.repeats && !preset,
        dated,
        String::new(),
    ));
    out.push(wire::TodoField {
        key: REPEATS.to_owned(),
        label: words::field_repeats(locale),
        value: task
            .rrule
            .as_deref()
            .filter(|rule| task.repeats && !rule.trim().is_empty())
            .map_or_else(
                || words::repeats_never(locale),
                |rule| rule_words::stored(locale, rule),
            ),
        note: if !dated {
            words::repeats_needs_due(locale)
        } else if task.missed > 0 {
            format!(
                "{} {} · {} {}. {}",
                words::missed(locale),
                task.missed,
                words::next_is(locale),
                civil::relative_day(locale, &task.due_day, today),
                words::missed_note_a(locale)
            )
        } else {
            String::new()
        },
        choices: repeat_choices,
        // For the picker only; the member reads `value` (#834).
        enabled: dated || task.repeats,
        ..wire::TodoField::default()
    });

    if task.repeats {
        let anchor = task.recurrence_anchor.as_deref().unwrap_or(SCHEDULED);
        out.push(wire::TodoField {
            key: ANCHOR.to_owned(),
            label: words::field_anchor(locale),
            value: if anchor == COMPLETION {
                words::anchor_completion(locale)
            } else {
                words::anchor_scheduled(locale)
            },
            note: words::anchor_note(locale),
            choices: vec![
                chip(
                    SCHEDULED,
                    words::anchor_scheduled(locale),
                    anchor == SCHEDULED,
                    true,
                    words::anchor_scheduled_body(locale),
                ),
                chip(
                    COMPLETION,
                    words::anchor_completion(locale),
                    anchor == COMPLETION,
                    true,
                    words::anchor_completion_body(locale),
                ),
            ],
            enabled: true,
            ..wire::TodoField::default()
        });
    }

    let project = task
        .project_id
        .as_deref()
        .and_then(|id| projects.iter().find(|p| p.project_id == id));
    let section = task
        .section_id
        .as_deref()
        .and_then(|id| sections.iter().find(|s| s.section_id == id));
    out.push(wire::TodoField {
        key: PROJECT.to_owned(),
        label: card_words::field_list(locale),
        group: card_words::group_organisation(locale),
        value: match (project, section) {
            (None, _) => words::inbox(locale),
            (Some(project), None) => project.name.clone(),
            (Some(project), Some(section)) => format!("{} · {}", project.name, section.name),
        },
        choices: place_choices(locale, task, projects, sections),
        sheet: true,
        enabled: task.parent_task_id.is_none(),
        ..wire::TodoField::default()
    });

    out.push(wire::TodoField {
        key: FLAG.to_owned(),
        label: card_words::field_flag(locale),
        value: String::new(),
        choices: vec![
            simple(ON, card_words::quick_flagged(locale), task.flagged),
            simple(OFF, card_words::flag_off(locale), !task.flagged),
        ],
        toggle: true,
        on: task.flagged,
        enabled: true,
        ..wire::TodoField::default()
    });

    let level = task.priority.clamp(0, 3);
    out.push(wire::TodoField {
        key: PRIORITY.to_owned(),
        label: words::field_priority(locale),
        value: Some(rows::priority_label(locale, task.priority))
            .filter(|label| !label.is_empty())
            .unwrap_or_else(|| words::priority_none(locale)),
        // THE LABEL CARRIES IT (product-intuition/references/design-behaviour.md § Wording): "None" is a choice on the
        // row, so no note says that priority is optional.
        choices: vec![
            simple(NONE, words::priority_none(locale), level == 0),
            simple("1", card_words::priority_1(locale), level == 1),
            simple("2", card_words::priority_2(locale), level == 2),
            simple("3", card_words::priority_3(locale), level == 3),
        ],
        enabled: true,
        ..wire::TodoField::default()
    });

    let mut effort_choices = vec![simple(
        NONE,
        words::priority_none(locale),
        task.effort_min.is_none(),
    )];
    effort_choices.extend(EFFORTS.iter().map(|minutes| {
        simple(
            &minutes.to_string(),
            if *minutes == 60 {
                words::effort_hour(locale)
            } else {
                format!("{minutes} {}", words::min(locale))
            },
            task.effort_min == Some(*minutes),
        )
    }));
    out.push(wire::TodoField {
        key: EFFORT.to_owned(),
        label: words::field_effort(locale),
        value: task.effort_min.map_or_else(
            || words::field_empty(locale),
            |minutes| rows::effort_label(locale, minutes),
        ),
        choices: effort_choices,
        enabled: true,
        ..wire::TodoField::default()
    });

    out.push(wire::TodoField {
        key: TAGS.to_owned(),
        label: words::field_tags(locale),
        value: if task.tags.is_empty() {
            words::field_empty(locale)
        } else {
            task.tags
                .iter()
                .map(|tag| format!("#{}", tag.label))
                .collect::<Vec<_>>()
                .join(" ")
        },
        note: if task.tags.is_empty() {
            String::new()
        } else {
            words::tags_note_b(locale)
        },
        choices: task
            .tags
            .iter()
            .map(|tag| simple(&tag.concept_id, tag.label.clone(), true))
            .collect(),
        add_text: true,
        add_placeholder: words::tags_add(locale),
        enabled: true,
        ..wire::TodoField::default()
    });
    out
}

/// The Project sheet: the Inbox, then each project by its order with its
/// sections indented under it.
fn place_choices(
    locale: Locale,
    task: &wire::AgendaTask,
    projects: &[wire::AgendaTaskProject],
    sections: &[wire::AgendaTaskSection],
) -> Vec<wire::TodoChoice> {
    let mut out = vec![wire::TodoChoice {
        key: rows::FILE_INBOX.to_owned(),
        label: words::inbox(locale),
        selected: task.project_id.is_none(),
        enabled: true,
        icon_key: "Inbox".to_owned(),
        ..wire::TodoChoice::default()
    }];
    let mut ordered: Vec<&wire::AgendaTaskProject> = projects.iter().collect();
    ordered.sort_by(|a, b| {
        a.sort_order
            .cmp(&b.sort_order)
            .then_with(|| a.name.cmp(&b.name))
    });
    for project in ordered {
        out.push(wire::TodoChoice {
            key: format!("{}{}", rows::FILE_PROJECT, project.project_id),
            label: project.name.clone(),
            selected: task.project_id.as_deref() == Some(project.project_id.as_str())
                && task.section_id.is_none(),
            enabled: true,
            icon_key: "Folder".to_owned(),
            ..wire::TodoChoice::default()
        });
        let mut own: Vec<&wire::AgendaTaskSection> = sections
            .iter()
            .filter(|s| s.project_id == project.project_id)
            .collect();
        own.sort_by_key(|s| s.sort_order);
        out.extend(own.into_iter().map(|section| wire::TodoChoice {
            key: format!("{}{}", rows::FILE_SECTION, section.section_id),
            label: section.name.clone(),
            selected: task.section_id.as_deref() == Some(section.section_id.as_str()),
            enabled: true,
            indented: true,
            ..wire::TodoChoice::default()
        }));
    }
    out
}
