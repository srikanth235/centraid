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

use super::list;
use centraid_vault::time::{FireZone, parse_civil_ms};

use crate::catalog::{act, load};
use crate::field::Field;
use crate::kit::act as kit_act;
use crate::kit::attachments::Attachments;
use crate::kit::autosave::{Autosave, Draft, Resolved};
use crate::kit::civil::{self, HourCycle};
use crate::kit::earlier;
use crate::kit::follow;
use crate::kit::links::{self, Kind, Links, Outcome};
use crate::kit::quantity::UnitsPref;
use crate::kit::read::{self, Note, Page, Reading};
use crate::kit::schedule::custom::{Custom, Done};
use crate::kit::schedule::ops::Ops;
use crate::kit::schedule::repeat::{REPEAT_CUSTOM, normalize_url};
use crate::kit::schedule::rows::{self, Context};
use crate::kit::schedule::rule_words;
use crate::kit::share::{self, Share};
use crate::kit::stale;
use crate::reminders::routes;
use crate::screen::{Ctx, Screen};
use crate::strings::{
    Locale, agenda_editor as editor_words, agenda_event as link_words,
    agenda_notify as notify_words, agenda_repeat as repeat_words, agenda_tasks as card_words,
    links as link_label, task as words,
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
    /// The task's revision when it was read, advanced by each save's answer: what an edit names as
    /// the one it replaces (#1185).
    rev: i64,
}

impl Draft for Typed {
    const ACTION: &'static str = act::reminders::EditTask::NAME;

    fn noun(locale: Locale) -> String {
        crate::strings::chat_confirm::noun_reminder(locale)
    }

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
                expected_rev: Some(self.rev),
                ..Default::default()
            }
            .into(),
        )
    }

    fn committed(&mut self, output: &[u8]) {
        if let Some(rev) = serde_json::from_slice::<serde_json::Value>(output)
            .ok()
            .and_then(|value| value.get("rev")?.as_i64())
        {
            self.rev = rev;
        }
    }

    fn subject_id(&self) -> Option<&str> {
        Some(&self.id)
    }

    fn base_rev(&self) -> Option<i64> {
        Some(self.rev)
    }

    fn rebased(&mut self, rev: i64) {
        self.rev = rev;
    }

    /// The words the task does not hold, by the vault's names for them.
    fn kept_fields(&self, baseline: &Self) -> Vec<(String, serde_json::Value)> {
        let mut kept = Vec::new();
        if self.title.trim() != baseline.title.trim() {
            kept.push(("entity.title".to_owned(), self.title.trim().into()));
        }
        if self.notes != baseline.notes {
            let notes = Some(self.notes.as_str()).filter(|notes| !notes.trim().is_empty());
            kept.push(("task.description".to_owned(), notes.into()));
        }
        kept
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
        page: Page::loading(),
        gone: false,
        projects: None,
        autosave: Autosave::new(),
        asking: Asking::None,
        open_field: String::new(),
        ops: Ops::default(),
        finished: false,
        attachments: Attachments::of("reminders", &args.task_id),
        custom: None,
        earlier: earlier::Foot::default(),
        differences: follow::Phone::default(),
        share: Share::default(),
        // A task may link to another task; the picker leaves this one out (`for_entity`).
        links: Links::new(&Kind::ALL).for_entity(&args.task_id),
        linked: None,
        linked_unread: false,
    }))
}

struct Detail {
    task_id: String,
    /// The read. A task that is gone is [`Page::Failed`] (`gone`), in its own words.
    page: Page<Answered>,
    /// No live task has the id: never made, deleted, or in the trash.
    gone: bool,
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
    /// The entry to the task's earlier versions, read with the page (#1185).
    earlier: earlier::Foot,
    /// Where the phone's Reminders differ from the task, read with the page.
    differences: follow::Phone,
    /// The task handed to the OS share sheet as a calendar file (#1185).
    share: Share,
    /// THE "Linked to" SECTION'S PICKER (#1185): what the task can link to, any item but a Locker
    /// one.
    links: Links,
    /// What the task is linked to, either end (`links::read_linked`). `None` until read, and while
    /// a read did not land.
    linked: Option<Vec<wire::LinkedItem>>,
    /// The read of `linked` was refused or failed: the status line says so, no empty section.
    linked_unread: bool,
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
        // Words not yet saved are the only copy: a task trashed elsewhere does not replace the page
        // under them. The save is refused as stale and Reload keeps them (#1185).
        if let Reading::Data(detail) = &detail
            && detail.task.is_none()
            && self.autosave.unsaved()
        {
            self.autosave.vault_moved();
            return;
        }
        let reading = match (detail, projects) {
            (Reading::Data(detail), _) => Reading::Data(Answered {
                detail: *detail,
                projects: self.projects.clone(),
            }),
            (Reading::Denied(denial), _) | (_, Reading::Denied(denial)) => Reading::Denied(denial),
            (Reading::Failed, _) => Reading::Failed,
        };
        // GONE is the page's failure in its own words, never an empty page: never made, deleted,
        // or in the trash.
        if let Reading::Data(answer) = &reading
            && answer.task().is_none()
        {
            self.gone = true;
            self.page = Page::Failed;
            return;
        }
        self.gone = false;
        let landed = matches!(reading, Reading::Data(_));
        // A re-read never blanks the page shown: a failed one keeps it under a note.
        let held = std::mem::replace(&mut self.page, Page::loading());
        self.page = held.after(reading, ctx.locale(), |_| false);
        if !landed {
            return;
        }
        let Page::Ready { data: answer, .. } = &self.page else {
            return;
        };
        let Some(task) = answer.task() else {
            return;
        };
        self.attachments.reload(ctx);
        self.differences = follow::read(ctx, &self.task_id);
        let title = if task.title.trim().is_empty() {
            words::untitled(ctx.locale())
        } else {
            task.title.clone()
        };
        self.earlier = earlier::foot(ctx, super::EARLIER, &self.task_id, &title);
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
            rev: answer.detail.rev,
        });
        self.read_linked(ctx);
    }

    /// What the task is linked to, in both directions. A refused or failed read is said on the
    /// status line and never drawn as an empty section.
    fn read_linked(&mut self, ctx: &Ctx) {
        match links::read_linked(ctx, &self.task_id) {
            Reading::Data(items) => {
                self.linked = Some(items);
                self.linked_unread = false;
            }
            Reading::Denied(_) | Reading::Failed => {
                self.linked = None;
                self.linked_unread = true;
                self.links.close();
            }
        }
        self.links.reload(ctx);
    }

    fn linked_ids(&self) -> Vec<String> {
        self.linked.as_deref().map(links::ids).unwrap_or_default()
    }

    /// One tap in the "Linked to" section or its picker, written through the kit's door (Undo when
    /// the core can take it back); the page is read again.
    fn link_event(&mut self, ctx: &Ctx, event: &wire::LinkEvent) {
        let linked = self.linked_ids();
        let id = self.task_id.clone();
        let (request, said): (wire::ActRequest, fn(Locale) -> String) =
            match self.links.update(event, &linked, ctx) {
                Outcome::Moved => return,
                Outcome::Add { id: to, .. } => (
                    act::reminders::Link {
                        from: id.clone(),
                        to,
                    }
                    .into(),
                    words::link_added,
                ),
                Outcome::Remove { id: to } => (
                    act::reminders::Unlink {
                        from: id.clone(),
                        to,
                    }
                    .into(),
                    words::link_removed,
                ),
            };
        let name = request.action.clone();
        self.write(ctx, request, &[&name, &id], said);
    }

    fn task(&self) -> Option<wire::AgendaTask> {
        self.page.data().and_then(Answered::task).cloned()
    }

    fn today(&self) -> String {
        self.page
            .data()
            .map(|answer| answer.today().to_owned())
            .unwrap_or_default()
    }

    /// One write through the kit's door: the status line says `said` with Undo when the core can
    /// take it back, or the refusal; the page is read again either way.
    fn write(
        &mut self,
        ctx: &Ctx,
        request: impl Into<wire::ActRequest>,
        parts: &[&str],
        said: impl FnOnce(Locale) -> String,
    ) -> bool {
        // Words not yet saved go first: this is a write of the same task, and it names the
        // revision they just left (#1185). A delete takes the words with the task.
        let request = request.into();
        if request.action != act::reminders::DeleteTask::NAME {
            let _ = self.autosave.flush(ctx);
        }
        let request = stale::guarded(
            request,
            &[
                act::reminders::EditTask::NAME,
                act::reminders::OrganizeTask::NAME,
            ],
            self.autosave.draft().and_then(Draft::base_rev),
        );
        let key = kit_act::key(parts, kit_act::fresh());
        let settled = self.ops.line.act(ctx, request, &key, said);
        let locale = ctx.locale();
        if let Some(stale) = settled.stale() {
            if self.autosave.unsaved() {
                self.autosave.conflicted(locale, stale);
            } else {
                // Nothing typed to keep: the page reads the task again at once, and says why.
                self.ops.line.refuse(stale::sentence(
                    locale,
                    &<Typed as Draft>::noun(locale),
                    stale,
                ));
            }
        }
        self.reload(ctx);
        settled.committed
    }

    /// RELOAD after a save the vault refused as stale (#1185): the words typed are kept as an
    /// earlier version of the task, then the vault's task is read and shown.
    fn reload_after_conflict(&mut self, ctx: &Ctx) {
        let locale = ctx.locale();
        let Resolved::Reloaded { kept, .. } = self.autosave.resolve(ctx) else {
            return;
        };
        self.ops.clear();
        self.reload(ctx);
        if kept {
            self.ops.line.say(if self.task().is_none() {
                stale::kept_in_trash(locale)
            } else {
                stale::kept(locale)
            });
        }
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
            words::task_updated,
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
                        words::task_updated,
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
                    self.ops.clear();
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
                        words::tag_removed,
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
        let Some(answer) = self.page.data() else {
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
            words::task_moved,
        );
    }

    fn confirmed(&mut self, ctx: &Ctx) {
        let asking = std::mem::replace(&mut self.asking, Asking::None);
        let Some(task) = self.task() else {
            return;
        };
        match asking {
            Asking::Delete => {
                let request = act::reminders::DeleteTask {
                    task_id: task.task_id.clone(),
                };
                if self.write(
                    ctx,
                    request,
                    &[act::reminders::DeleteTask::NAME, &task.task_id],
                    |locale| crate::kit::trash::moved_to_trash(locale, &task.title),
                ) {
                    // THE PAGE CLOSES: "moved to trash" and its Undo go to the page beneath.
                    self.ops.line.hand_down(ctx);
                    self.finished = true;
                    // The words are gone with the task: leaving saves nothing.
                    self.autosave = Autosave::new();
                }
            }
            Asking::Release => {
                let request = act::reminders::CancelTask {
                    task_id: task.task_id.clone(),
                };
                self.write(
                    ctx,
                    request,
                    &[act::reminders::CancelTask::NAME, &task.task_id],
                    words::task_released,
                );
            }
            _ => {}
        }
    }

    /// One control of the page. Most are writes; an open link and an add ask the shell.
    fn event(&mut self, event: wire::TodoDetailEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(D::OpenLink(_)) => return self.open_link(),
            Some(D::ShareRequested(_)) => {
                if self.task().is_some() {
                    return self.share.tap(ctx.locale());
                }
            }
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
            Some(D::Link(link)) => self.link_event(ctx, &link),
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
                        words::tag_added,
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
                if self.autosave.conflict().is_some() {
                    self.reload_after_conflict(ctx);
                } else {
                    self.ops.undo(ctx);
                    self.reload(ctx);
                }
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
                    words::subtask_added,
                );
            }
            Some(D::Delete(_)) => self.asking = Asking::Delete,
            // RELEASING DESTROYS NOTHING: the outlined secondary, not `net`.
            Some(D::Release(_)) => self.asking = Asking::Release,
            Some(D::Confirmed(_)) => self.confirmed(ctx),
            Some(D::Dismissed(_)) => self.asking = Asking::None,
            // The page's asks of the shell are `event`'s.
            Some(D::OpenLink(_) | D::Attachment(_) | D::ShareRequested(_)) | None => {}
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
        units: UnitsPref,
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
            share_label: share::label(locale),
            release_label: words::release(locale),
            can_release: open,
            today: today.to_owned(),
            link: link_of(locale, task),
            attachments: Some(self.attachments.view(locale, units)),
            links: self.linked.as_ref().map(|linked| {
                self.links.section(
                    locale,
                    link_label::section_linked(locale),
                    links::rows(locale, linked),
                    words::links_empty(locale),
                )
            }),
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

impl Screen for Detail {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Appeared(_) | E::DataChanged(_) | E::EnvironmentChanged(_)) => self.reload(ctx),
            Some(E::StatusActed(_)) => {
                if self.autosave.conflict().is_some() {
                    self.reload_after_conflict(ctx);
                } else {
                    self.ops.undo(ctx);
                    self.reload(ctx);
                }
            }
            Some(E::TimerFired(fired)) => {
                if self.autosave.fired(ctx, &fired.timer) {
                    self.reload(ctx);
                }
            }
            // CLOSE = DONE: whatever is typed is saved.
            Some(E::Left(_)) => {
                let _ = self.autosave.flush(ctx);
                return self.share.left();
            }
            Some(E::PhoneSaysTaken(taken)) => {
                if let Some(settled) = follow::take(ctx, &self.task_id, &taken) {
                    if settled.committed {
                        self.ops.clear();
                    } else {
                        self.ops.line.refuse(settled.refusal);
                    }
                    self.reload(ctx);
                }
            }
            Some(E::TodoDetail(detail)) => return self.event(detail, ctx),
            // THE SHELL'S ANSWER TO A PICK: the attachments' (an add under way).
            Some(E::EffectResult(result)) => {
                let id = self.task_id.clone();
                let shared = self.share.result(ctx, &result, |ctx| {
                    super::export::file(ctx, None, Some(&id))
                });
                if !shared.is_empty() || self.share.status().is_some() {
                    return shared;
                }
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
        // A check of what the phone says that was not made is a note over the task.
        let page = self.page.clone().noted(Note::unchecked(
            &self.differences,
            locale,
            follow::Source::Phone,
        ));
        let content = match page.data() {
            Some(answer) => answer.task().map(|task| {
                Content::Data(Box::new(self.data(
                    locale,
                    ctx.units(),
                    ctx.hour_cycle(),
                    answer,
                    task,
                )))
            }),
            None => None,
        };
        let mut wired = page.wire(
            locale,
            |denial| list::denied(locale, denial),
            wire::EmptyState::default,
        );
        // A task that is gone (never made, deleted, or in the trash) says so in its own words.
        if self.gone && matches!(wired.state, Some(wire::page_state::State::Failed(_))) {
            wired.state = Some(wire::page_state::State::Failed(read::gone(
                words::task_gone(locale),
                String::new(),
            )));
        }
        wire::ViewState {
            kind: Some(wire::view_state::Kind::TodoDetail(wire::TodoDetailState {
                task_id: self.task_id.clone(),
                content,
                page: Some(wired),
                autosave: Some(self.autosave.view(locale)),
                confirm: self.confirm(locale),
                open_field: self.open_field.clone(),
                chrome: Some(rows::chrome(locale)),
                status: self
                    .ops
                    .status()
                    .or_else(|| self.share.status())
                    .or_else(|| self.earlier.status(locale))
                    .or_else(|| {
                        self.linked_unread.then(|| wire::StatusLine {
                            sentence: words::links_unread(locale),
                            action_label: String::new(),
                            refused: false,
                        })
                    }),
                finished: self.finished,
                earlier: self.earlier.entry.clone(),
                origin: self.earlier.origin.clone(),
                phone_says: phone_says(
                    &Wording {
                        locale,
                        cycle: ctx.hour_cycle(),
                        zone: ctx.zone(),
                        today: &self.today(),
                    },
                    &self.differences,
                ),
                link_picker: (self.linked.is_some() && self.links.is_open())
                    .then(|| self.links.picker(locale, &self.linked_ids())),
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

pub(super) fn lead_label(locale: Locale, lead: u32) -> String {
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
        // A DATE IS NOT A MOMENT: a date-only reminder never sounds, and the row says so.
        note: if !dated {
            words::reminder_needs_due(locale)
        } else if task.due_time.is_empty() {
            notify_words::no_alert_without_time(locale)
        } else {
            words::reminder_note_a(locale)
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

/// What the lines need to word a value the way the page words it.
#[derive(Clone, Copy)]
struct Wording<'a> {
    locale: Locale,
    cycle: HourCycle,
    /// The member's own zone (the device's): a stated instant is read here, never in UTC.
    zone: &'a str,
    /// The core's today in that zone.
    today: &'a str,
}

/// A stated `due` as the page words the task's own: the day as "When" says it ("Today", "Wed 11
/// March"), then the time as "Time" says it when the due has one, read in the member's zone. A
/// value that is no date is left as the phone stated it.
fn due_words(wording: &Wording<'_>, stated: &str) -> String {
    let Wording {
        locale,
        cycle,
        zone,
        today,
    } = *wording;
    let local = if stated.len() == 10 {
        Some(stated.to_owned())
    } else {
        FireZone::named(zone).ok().and_then(|zone| {
            let at = zone.zoned_parts(parse_civil_ms(stated, &zone)?);
            Some(format!(
                "{:04}-{:02}-{:02}T{:02}:{:02}",
                at.year, at.month, at.day, at.hour, at.minute
            ))
        })
    };
    let Some(local) = local.filter(|local| civil::epoch_day_of(&local[..10]).is_some()) else {
        return stated.to_owned();
    };
    let day = civil::relative_day(locale, &local[..10], today);
    match civil::clock(&local) {
        time if time.is_empty() => day,
        _ => format!("{day} {}", civil::clock_for(locale, &local, cycle)),
    }
}

/// The lines "Phone says …" under the task: one per field the member's value differs on.
fn phone_says(wording: &Wording<'_>, differences: &follow::Phone) -> Vec<wire::PhoneSays> {
    let locale = wording.locale;
    let line = |field: &str, noun: String, show: &dyn Fn(&str) -> String| {
        let difference = follow::of(differences, field)?;
        let stated = follow::text(&difference.stated)
            .or_else(|| difference.stated.as_i64().map(|number| number.to_string()))?;
        Some(follow::says(
            locale,
            follow::Source::Phone,
            &show(&stated),
            &noun,
            field,
            None,
        ))
    };
    let same = |text: &str| text.to_owned();
    let due = |text: &str| due_words(wording, text);
    let bangs = |level: &str| match level {
        "3" => "!!!".to_owned(),
        "2" => "!!".to_owned(),
        "1" => "!".to_owned(),
        _ => words::says_priority_none(locale),
    };
    // The phone's flag is the task's star: it says "flagged" or "not flagged", as the page says Flag.
    let flag = follow::of(differences, "starred").and_then(|difference| {
        let stated = difference.stated.as_bool()?;
        Some(follow::says(
            locale,
            follow::Source::Phone,
            &if stated {
                words::says_flagged(locale)
            } else {
                words::says_not_flagged(locale)
            },
            &words::says_noun_flag(locale),
            "starred",
            None,
        ))
    });
    [
        line("title", words::says_noun_title(locale), &same),
        line("description", words::says_noun_notes(locale), &same),
        line("due", words::says_noun_due(locale), &due),
        line("priority", words::says_noun_priority(locale), &bangs),
        flag,
        line("url", words::says_noun_link(locale), &same),
    ]
    .into_iter()
    .flatten()
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kit::act as kit_act;
    use crate::testing::Driver;
    use wire::link_event::Kind as L;

    /// The Driver supplies a real vault; only the `links` read and the act log are replaced.
    struct Flaky<'a> {
        core: &'a centraid_core::Handle,
        fail_links: std::cell::Cell<bool>,
        /// The `app.action` of each act made through this ctx, in order.
        acted: std::cell::RefCell<Vec<String>>,
        /// The `from`/`to` of each link or unlink act, in order.
        inputs: std::cell::RefCell<Vec<(String, String, String)>>,
    }

    impl centraid_core::screens::ScreenCtx for Flaky<'_> {
        fn load(&self, request: &wire::LoadRequest) -> centraid_core::Result<wire::LoadResponse> {
            if self.fail_links.get() && request.app == "shell" && request.query == "links" {
                Err(centraid_core::CoreError::Unavailable {
                    reason: "test read failure".into(),
                })
            } else {
                self.core.load(request)
            }
        }

        fn act(&self, request: &wire::ActRequest) -> centraid_core::Result<wire::ActResponse> {
            self.acted
                .borrow_mut()
                .push(format!("{}.{}", request.app, request.action));
            if request.action == "link" || request.action == "unlink" {
                let text = |key: &str| match request.input.get(key).and_then(|v| v.kind.as_ref()) {
                    Some(wire::value::Kind::Text(text)) => text.clone(),
                    _ => String::new(),
                };
                self.inputs
                    .borrow_mut()
                    .push((text("from"), text("to"), text("rel")));
            }
            self.core.act(request)
        }

        fn push(&self, _update: wire::ScreenUpdate) {}
        fn wake_after(&self, _after: std::time::Duration) {}
    }

    fn flaky(core: &centraid_core::Handle) -> Flaky<'_> {
        Flaky {
            core,
            fail_links: false.into(),
            acted: Vec::new().into(),
            inputs: Vec::new().into(),
        }
    }

    fn make(driver: &Driver, title: &str) -> String {
        let mut request: wire::ActRequest = act::reminders::AddTask {
            title: title.into(),
            ..Default::default()
        }
        .into();
        request.invoke_key = format!("test:{}", kit_act::fresh());
        let created = driver.act(request);
        let output: serde_json::Value = serde_json::from_slice(&created.output).expect("output");
        output["id"].as_str().expect("id").to_owned()
    }

    fn opened<'a>(core: &'a Flaky, id: &str) -> (Box<dyn Screen>, Ctx<'a>) {
        let env: &'static crate::screen::Environment =
            Box::leak(Box::new(crate::screen::Environment::default()));
        let ctx = Ctx::new(core, env);
        let mut screen = build(&routes::task(id)).expect("task page");
        screen.update(
            wire::ScreenEvent {
                kind: Some(E::Appeared(wire::Appeared {})),
            },
            &ctx,
        );
        (screen, ctx)
    }

    fn link(screen: &mut Box<dyn Screen>, ctx: &Ctx, kind: L) {
        screen.update(
            wire::ScreenEvent {
                kind: Some(E::TodoDetail(wire::TodoDetailEvent {
                    kind: Some(D::Link(wire::LinkEvent { kind: Some(kind) })),
                })),
            },
            ctx,
        );
    }

    fn state(screen: &dyn Screen, ctx: &Ctx) -> wire::TodoDetailState {
        let Some(wire::view_state::Kind::TodoDetail(state)) = screen.view(ctx).kind else {
            panic!("task state")
        };
        state
    }

    fn rows(screen: &dyn Screen, ctx: &Ctx) -> Vec<(String, String)> {
        let Some(wire::todo_detail_state::Content::Data(data)) = state(screen, ctx).content else {
            panic!("task data")
        };
        data.links
            .expect("the Linked to section")
            .rows
            .into_iter()
            .map(|row| (row.title, row.meta))
            .collect()
    }

    #[test]
    fn the_page_lists_what_the_task_is_linked_to_and_a_pick_links_through_reminders_link() {
        let driver = Driver::with_runtime(crate::agenda::runtime());
        let other = make(&driver, "Book the flat");
        let id = make(&driver, "Pack");
        let core = flaky(&driver.handle);
        let (mut screen, ctx) = opened(&core, &id);
        assert!(rows(&*screen, &ctx).is_empty());
        let Some(wire::todo_detail_state::Content::Data(data)) = state(&*screen, &ctx).content
        else {
            panic!("task data")
        };
        let section = data.links.expect("section");
        assert_eq!(section.title, "Linked to");
        assert_eq!(section.empty, "Nothing linked yet");
        assert_eq!(section.adds.len(), 1, "one Add link row for many kinds");
        link(
            &mut screen,
            &ctx,
            L::Add(wire::link_event::AddTapped { key: "link".into() }),
        );
        let picker = state(&*screen, &ctx).link_picker.expect("kind chooser");
        assert!(picker.open);
        assert!(
            picker.candidates.iter().any(|row| row.id == "task"),
            "a task may link to another task"
        );
        link(
            &mut screen,
            &ctx,
            L::Pick(wire::link_event::Picked { id: "task".into() }),
        );
        let picker = state(&*screen, &ctx).link_picker.expect("tasks");
        assert!(picker.candidates.iter().any(|row| row.id == other));
        assert!(
            picker.candidates.iter().all(|row| row.id != id),
            "a task is never offered itself"
        );
        link(
            &mut screen,
            &ctx,
            L::Pick(wire::link_event::Picked { id: other.clone() }),
        );
        assert_eq!(core.acted.borrow().as_slice(), ["reminders.link"]);
        assert_eq!(
            core.inputs.borrow().as_slice(),
            [(id.clone(), other.clone(), "links".to_owned())]
        );
        let view = state(&*screen, &ctx);
        assert!(view.link_picker.is_none_or(|picker| !picker.open));
        let status = view.status.expect("status");
        assert_eq!(status.sentence, "Linked");
        assert_eq!(status.action_label, "Undo");
        assert_eq!(
            rows(&*screen, &ctx),
            [("Book the flat".to_owned(), "Task".to_owned())]
        );
        // The link has no direction: the other task's page lists this one.
        let there = flaky(&driver.handle);
        let (other_screen, other_ctx) = opened(&there, &other);
        assert_eq!(rows(&*other_screen, &other_ctx).len(), 1);
    }

    #[test]
    fn a_tap_on_remove_unlinks_and_undo_links_again() {
        let driver = Driver::with_runtime(crate::agenda::runtime());
        let other = make(&driver, "Book the flat");
        let id = make(&driver, "Pack");
        let core = flaky(&driver.handle);
        let (mut screen, ctx) = opened(&core, &id);
        for kind in [
            L::Add(wire::link_event::AddTapped { key: "link".into() }),
            L::Pick(wire::link_event::Picked { id: "task".into() }),
            L::Pick(wire::link_event::Picked { id: other.clone() }),
        ] {
            link(&mut screen, &ctx, kind);
        }
        assert_eq!(rows(&*screen, &ctx).len(), 1);
        link(
            &mut screen,
            &ctx,
            L::Remove(wire::link_event::RemoveTapped { id: other.clone() }),
        );
        assert_eq!(
            core.acted.borrow().as_slice(),
            ["reminders.link", "reminders.unlink"]
        );
        assert_eq!(
            core.inputs.borrow().last(),
            Some(&(id.clone(), other.clone(), "links".to_owned()))
        );
        assert!(rows(&*screen, &ctx).is_empty());
        let status = state(&*screen, &ctx).status.expect("status");
        assert_eq!(status.sentence, "Link removed");
        assert_eq!(status.action_label, "Undo");
        screen.update(
            wire::ScreenEvent {
                kind: Some(E::StatusActed(wire::StatusActed {})),
            },
            &ctx,
        );
        assert_eq!(rows(&*screen, &ctx).len(), 1);
    }

    #[test]
    fn links_that_could_not_be_read_are_said_not_drawn_as_none() {
        let driver = Driver::with_runtime(crate::agenda::runtime());
        let id = make(&driver, "Pack");
        let core = flaky(&driver.handle);
        core.fail_links.set(true);
        let (mut screen, ctx) = opened(&core, &id);
        let view = state(&*screen, &ctx);
        let Some(wire::todo_detail_state::Content::Data(data)) = view.content else {
            panic!("task data")
        };
        assert!(data.links.is_none(), "no section for what was not read");
        assert_eq!(
            view.status.expect("status").sentence,
            "Couldn’t read what this task is linked to."
        );
        // Read again, the section comes back.
        core.fail_links.set(false);
        screen.update(
            wire::ScreenEvent {
                kind: Some(E::TodoDetail(wire::TodoDetailEvent {
                    kind: Some(D::Refreshed(wire::todo_detail_event::Refreshed {})),
                })),
            },
            &ctx,
        );
        assert!(rows(&*screen, &ctx).is_empty());
        assert!(state(&*screen, &ctx).status.is_none());
        assert!(core.acted.borrow().is_empty());
    }
}
