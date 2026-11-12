//! MAKE A REMINDER (`reminders.editor`, #1128, split from Agenda's editor in round 10 of #1173).
//!
//! Title and due first, then Notes (the reminder's description), List (the Inbox, then the projects
//! A to Z) and a "More details" row that opens priority, repeat, tags and an address. Save is one
//! `add-task` carrying the notes, the priority, the repeat rule, the address and the project, then
//! one `add-task-tag` per tag, through [`Ops::add_full`], the list surfaces' one add. A reminder has
//! no place: the vault's task has no such field, so the sheet does not draw one.
//!
//! Repeat offers the presets and Custom, the kit's sheet over a WORKING rule
//! (`kit::schedule::custom`). Save is explicit: a reminder with no title is never made, and leaving
//! with changes asks. A write answers at once, so a committed Save sets `dismissed` and the screen
//! ignores everything after it: the core remembers no key, and a second Save would file the
//! reminder again.
//!
//! The screen reads Reminders' projects only: it has no calendar, no guest and no clock of its own,
//! so the day it opens on is the route's (the list page it was opened from names today).

mod repeat_sheet;

use centraid_api_proto::core_v1 as wire;
use wire::agenda_editor_event::Kind as K;
use wire::agenda_editor_state::{Asking, Mode, Sheet};
use wire::app_query_response::Answer;
use wire::screen_event::Kind as E;

use crate::catalog::load;
use crate::kit::civil::{self, HourCycle};
use crate::kit::read::{self as kit_read, Page, Reading};
use crate::kit::schedule::draft::{
    self, Draft, LIST_INBOX, PRIORITY_MAX, REPEAT_BIWEEKLY, REPEAT_CUSTOM, REPEAT_DAILY,
    REPEAT_MONTHLY, REPEAT_NONE, REPEAT_WEEKLY, REPEAT_YEARLY, RULES,
};
use crate::kit::schedule::ops::Ops;
use crate::kit::schedule::rows;
use crate::kit::schedule::rule_words::long_day;
use crate::reminders::ops::NewTask;
use crate::screen::{Ctx, Screen};
use crate::strings::{
    Locale, agenda as words, agenda_editor as editor_words, agenda_repeat as repeat_words,
    agenda_tasks as task_words, fill, task as task_strings,
};

/// The Inbox's dot: a neutral list colour, since the Inbox is no one's project.
const INBOX_HUE: &str = "graphite";

/// The registry factory.
#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    let Some(wire::route::Args::AgendaEditor(args)) = &route.args else {
        return None;
    };
    Some(Box::new(Editor {
        route: args.clone(),
        page: Page::loading(),
        projects: Vec::new(),
        baseline: None,
        draft: None,
        sheet: Sheet::None,
        more_open: false,
        custom: None,
        asking: Asking::None,
        save_tried: false,
        status: None,
        dismissed: false,
        ops: Ops::default(),
    }))
}

struct Editor {
    route: wire::AgendaEditorRoute,
    /// The read of the lists a reminder can be filed in. The draft is what the page shows, so a
    /// re-read that failed keeps it under a note.
    page: Page<()>,
    /// The projects a reminder can be filed in; empty when the read did not land, and then the
    /// Inbox is the one list.
    projects: Vec<wire::AgendaTaskProject>,
    /// The values as opened: what "changed" is measured against.
    baseline: Option<Draft>,
    draft: Option<Draft>,
    sheet: Sheet,
    /// The More details row is open.
    more_open: bool,
    /// The Custom repeat sheet's working rule, while it is open.
    custom: Option<crate::kit::schedule::custom::Custom>,
    asking: Asking,
    /// Save was pressed, which is when a blocked draft says why even before anything was typed.
    save_tried: bool,
    /// The vault's refusal of the last Save, over the draft that stays.
    status: Option<wire::StatusLine>,
    dismissed: bool,
    ops: Ops,
}

impl Editor {
    // -- reads ------------------------------------------------------------

    /// Read the projects. A re-read keeps the draft: a change elsewhere never overwrites what the
    /// member is typing.
    fn reload(&mut self, ctx: &Ctx) {
        let reading =
            match kit_read::read(
                ctx,
                load::reminders::Projects::default(),
                |answer| match answer {
                    Answer::AgendaTaskProjects(projects) => Some(projects),
                    _ => None,
                },
            ) {
                Reading::Data(projects) => {
                    self.projects = projects.projects;
                    Reading::Data(())
                }
                Reading::Denied(denial) => Reading::Denied(denial),
                // A refused or missing read leaves the Inbox; a first read that failed has nothing to show.
                Reading::Failed => Reading::Failed,
            };
        let landed = matches!(reading, Reading::Data(()));
        // A re-read never blanks the page shown: a failed one keeps the draft under a note.
        let held = std::mem::replace(&mut self.page, Page::loading());
        self.page = held.after(reading, ctx.locale(), |()| false);
        if landed && self.draft.is_none() {
            self.baseline = Some(draft::new_task(&self.route.day));
            self.draft.clone_from(&self.baseline);
        }
    }

    // -- the draft --------------------------------------------------------

    /// Apply a change to the draft. A change is the member acting again, so the last refusal goes.
    fn edit(&mut self, change: impl FnOnce(&Draft) -> Option<Draft>) {
        let Some(current) = &self.draft else { return };
        if let Some(next) = change(current) {
            self.draft = Some(next);
            self.status = None;
        }
    }

    fn close_sheet(&mut self) {
        self.sheet = Sheet::None;
        self.custom = None;
    }

    fn dirty(&self) -> bool {
        match (&self.draft, &self.baseline) {
            (Some(draft), Some(base)) => draft::dirty(draft, base),
            _ => false,
        }
    }

    /// Why Save is not armed, or empty: a title, a day, and an address that, when typed, is one.
    fn blocked(&self, locale: Locale) -> String {
        let Some(draft) = &self.draft else {
            return String::new();
        };
        if draft.title.trim().is_empty() {
            words::block_title(locale)
        } else if draft::normalize_url(&draft.url).is_none() {
            editor_words::block_url(locale)
        } else {
            String::new()
        }
    }

    fn can_save(&self, locale: Locale) -> bool {
        self.draft.is_some() && !self.dismissed && self.blocked(locale).is_empty()
    }

    // -- saving -----------------------------------------------------------

    /// A reminder saves as `add-task`: the trimmed title and the due, a bare day or a floating
    /// local time.
    fn save(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        if self.dismissed {
            return Vec::new();
        }
        if !self.can_save(ctx.locale()) {
            self.save_tried = self.draft.is_some();
            return Vec::new();
        }
        let Some(draft) = self.draft.clone() else {
            return Vec::new();
        };
        let locale = ctx.locale();
        let lands = civil::relative_day(locale, &draft.start_day, &self.route.day);
        self.status = None;
        let due = draft::due_of(&draft);
        let notes = draft.notes.trim();
        let rule = draft::rule_for(&draft);
        let url = draft::normalize_url(&draft.url).filter(|url| !url.is_empty());
        let project = self
            .project_of(&draft.list_key)
            .map(|project| project.project_id.clone());
        let task = NewTask {
            title: draft.title.trim(),
            notes,
            due: &due,
            priority: i64::from(draft.priority.clamp(0, PRIORITY_MAX)),
            rule: rule.as_deref(),
            url: url.as_deref(),
            project_id: project.as_deref(),
            tags: &draft.tags,
            ..NewTask::default()
        };
        if self.ops.add_full(ctx, &task, &lands).is_some() {
            // THE EDITOR CLOSES: "Added to ..." and its Undo go to the page beneath (#1185).
            self.ops.line.hand_down(ctx);
            self.dismissed = true;
            return Vec::new();
        }
        self.status = self.ops.status();
        Vec::new()
    }

    // -- events -----------------------------------------------------------

    fn on_editor_event(&mut self, event: K, ctx: &Ctx) -> Vec<wire::Effect> {
        match event {
            K::Refreshed(_) => self.reload(ctx),
            K::Title(change) => self.edit(|d| {
                Some(Draft {
                    title: change.text,
                    ..d.clone()
                })
            }),
            K::Notes(change) => self.edit(|d| {
                Some(Draft {
                    notes: change.text,
                    ..d.clone()
                })
            }),
            K::AllDay(change) => self.edit(|d| Some(draft::all_day(d, change.on))),
            K::Start(change) => self.edit(|d| draft::move_start(d, &change.day, &change.time)),
            K::Repeat(picked) => {
                if picked.key == REPEAT_CUSTOM {
                    // Custom opens its own sheet over the working rule.
                    self.open_custom();
                } else if self.repeat_keys().contains(&picked.key) {
                    self.close_sheet();
                    self.edit(|d| {
                        Some(Draft {
                            repeat_key: picked.key,
                            repeat_rule: String::new(),
                            ..d.clone()
                        })
                    });
                }
            }
            K::SheetOpened(opened) => {
                let sheet = Sheet::try_from(opened.sheet).unwrap_or(Sheet::Unspecified);
                if matches!(sheet, Sheet::List | Sheet::Repeat) && self.draft.is_some() {
                    self.close_sheet();
                    self.sheet = sheet;
                } else if sheet == Sheet::CustomRepeat && self.draft.is_some() {
                    self.open_custom();
                }
            }
            K::SheetClosed(_) => self.close_sheet(),
            K::Save(_) => return self.save(ctx),
            K::Leave(_) => {
                if self.dirty() {
                    self.asking = Asking::Discard;
                } else {
                    self.dismissed = true;
                }
            }
            K::Confirmed(_) => {
                if std::mem::replace(&mut self.asking, Asking::None) == Asking::Discard {
                    self.dismissed = true;
                }
            }
            K::ConfirmDismissed(_) => self.asking = Asking::None,
            K::List(picked) => {
                if self.list_keys().contains(&picked.key) {
                    self.close_sheet();
                    self.edit(|d| {
                        Some(Draft {
                            list_key: picked.key,
                            ..d.clone()
                        })
                    });
                }
            }
            K::Priority(picked) => {
                let level = picked
                    .key
                    .parse::<i32>()
                    .ok()
                    .filter(|level| (0..=PRIORITY_MAX).contains(level));
                if let Some(priority) = level {
                    self.edit(|d| {
                        Some(Draft {
                            priority,
                            ..d.clone()
                        })
                    });
                }
            }
            K::TagAdded(added) => self.edit(|d| draft::tag_added(d, &added.text)),
            K::TagRemoved(removed) => self.edit(|d| draft::tag_removed(d, &removed.text)),
            K::MoreDetails(_) => self.more_open = !self.more_open,
            K::Url(change) => self.edit(|d| {
                Some(Draft {
                    url: change.text,
                    ..d.clone()
                })
            }),
            K::CustomFreq(picked) => self.custom_freq(&picked.key),
            K::CustomInterval(changed) => self.custom_interval(changed.interval),
            K::CustomWeekday(toggled) => self.custom_weekday(&toggled.key),
            K::CustomMonthMode(picked) => self.custom_month_mode(&picked.key),
            K::CustomMonthDay(toggled) => self.custom_month_day(&toggled.key),
            K::CustomOrdinal(picked) => self.custom_ordinal(&picked.key),
            K::CustomNthWeekday(picked) => self.custom_nth_weekday(&picked.key),
            K::CustomEnd(picked) => self.custom_end(&picked.key),
            K::CustomUntil(changed) => self.custom_until(&changed.day),
            K::CustomCount(changed) => self.custom_count(changed.count),
            K::CustomApplied(_) => self.apply_custom(),
            K::CustomReplace(_) => self.replace_custom(),
            // An event's fields, its scopes and its kind switch: a reminder has none of them.
            K::End(_)
            | K::Calendar(_)
            | K::Guest(_)
            | K::Reminder(_)
            | K::Link(_)
            | K::Skip(_)
            | K::PlaceSearch(_)
            | K::Place(_)
            | K::PlaceCleared(_)
            | K::SecondReminder(_)
            | K::Availability(_)
            | K::ZoneSearch(_)
            | K::Zone(_)
            | K::Travel(_)
            | K::Scope(_)
            | K::KindPicked(_) => {}
        }
        Vec::new()
    }

    // -- the pickers' lists -----------------------------------------------

    /// The project a reminder's list key names, when the read still lists it.
    fn project_of(&self, key: &str) -> Option<&wire::AgendaTaskProject> {
        self.projects
            .iter()
            .find(|project| project.project_id == key)
    }

    /// The projects A to Z (case aside), the Inbox's own order being first.
    fn sorted_projects(&self) -> Vec<&wire::AgendaTaskProject> {
        let mut projects: Vec<&wire::AgendaTaskProject> = self.projects.iter().collect();
        projects.sort_by_cached_key(|project| (project.name.to_lowercase(), project.sort_order));
        projects
    }

    fn list_keys(&self) -> Vec<String> {
        std::iter::once(LIST_INBOX.to_owned())
            .chain(
                self.sorted_projects()
                    .into_iter()
                    .map(|project| project.project_id.clone()),
            )
            .collect()
    }

    /// The Inbox, then each project: the list a new task lands in.
    fn lists(&self, locale: Locale, draft: &Draft) -> Vec<wire::AgendaChoice> {
        // A list that is gone files in the Inbox, and the sheet says so.
        let chosen = if self.project_of(&draft.list_key).is_some() {
            draft.list_key.as_str()
        } else {
            LIST_INBOX
        };
        let inbox = task_strings::inbox(locale);
        std::iter::once(wire::AgendaChoice {
            key: LIST_INBOX.to_owned(),
            selected: chosen == LIST_INBOX,
            hue_key: INBOX_HUE.to_owned(),
            accessibility_label: inbox.clone(),
            label: inbox,
        })
        .chain(
            self.sorted_projects()
                .into_iter()
                .map(|project| wire::AgendaChoice {
                    key: project.project_id.clone(),
                    selected: chosen == project.project_id,
                    hue_key: rows::list_color_of(&project.project_id, Some(project)),
                    accessibility_label: project.name.clone(),
                    label: project.name.clone(),
                }),
        )
        .collect()
    }

    /// None, !, !!, !!!: the symbol is the label and Low, Medium, High priority the spoken name.
    fn priorities(locale: Locale, draft: &Draft) -> Vec<wire::AgendaChoice> {
        let level = draft.priority.clamp(0, PRIORITY_MAX);
        [
            (
                task_strings::priority_none(locale),
                task_strings::priority_none(locale),
            ),
            (
                task_words::priority_1(locale),
                task_words::priority_1_spoken(locale),
            ),
            (
                task_words::priority_2(locale),
                task_words::priority_2_spoken(locale),
            ),
            (
                task_words::priority_3(locale),
                task_words::priority_3_spoken(locale),
            ),
        ]
        .into_iter()
        .enumerate()
        .map(|(at, (label, spoken))| wire::AgendaChoice {
            key: at.to_string(),
            label,
            selected: i32::try_from(at).is_ok_and(|at| at == level),
            hue_key: String::new(),
            accessibility_label: spoken,
        })
        .collect()
    }

    /// The closed More details row: what is set, else what is inside.
    fn more_details_summary(&self, locale: Locale, draft: &Draft, repeat_label: &str) -> String {
        let mut parts: Vec<String> = Vec::new();
        let priority = Self::priorities(locale, draft)
            .into_iter()
            .find(|choice| choice.selected && choice.key != "0");
        parts.extend(priority.map(|choice| choice.label));
        if draft.repeat_key != REPEAT_NONE {
            parts.push(repeat_label.to_owned());
        }
        parts.extend(draft.tags.iter().map(|tag| format!("#{tag}")));
        if parts.is_empty() {
            task_words::more_details_empty(locale)
        } else {
            parts.join(" · ")
        }
    }

    fn repeat_keys(&self) -> Vec<String> {
        let mut keys = vec![REPEAT_NONE.to_owned()];
        keys.extend(RULES.iter().map(|(key, _)| (*key).to_owned()));
        keys.push(REPEAT_CUSTOM.to_owned());
        keys
    }

    /// A repeat preset named for the day the reminder is due.
    fn repeat_label(&self, locale: Locale, key: &str, draft: &Draft) -> String {
        let day = draft.start_day.as_str();
        let long = long_day(locale, day);
        let (weekday, day_month) = long
            .split_once(' ')
            .unwrap_or((long.as_str(), long.as_str()));
        match key {
            REPEAT_DAILY => words::repeat_daily(locale),
            REPEAT_WEEKLY => fill(
                &editor_words::repeat_weekly_on(locale),
                &[("weekday", weekday)],
            ),
            REPEAT_BIWEEKLY => fill(
                &editor_words::repeat_biweekly_on(locale),
                &[("weekday", weekday)],
            ),
            REPEAT_MONTHLY => fill(
                &editor_words::repeat_monthly_on(locale),
                &[(
                    "ordinal",
                    &civil::ordinal(civil::day_of_month_of(day).unwrap_or(1)),
                )],
            ),
            REPEAT_YEARLY => fill(
                &editor_words::repeat_yearly_on(locale),
                &[("day_month", day_month)],
            ),
            // A rule the member just built says what the sheet says.
            REPEAT_CUSTOM if draft.repeat_key != REPEAT_CUSTOM => {
                editor_words::repeat_custom(locale)
            }
            REPEAT_CUSTOM => draft::rule_for(draft)
                .and_then(|rule| crate::kit::schedule::repeat::from_rrule(&rule, day))
                .map(|spec| crate::kit::schedule::custom::summary(locale, &spec))
                .unwrap_or_else(|| editor_words::repeat_custom(locale)),
            _ => words::repeat_never(locale),
        }
    }

    /// What Save will write for the address, empty when none or refused.
    fn url_saved_as(draft: &Draft) -> String {
        draft::normalize_url(&draft.url).unwrap_or_default()
    }
}

impl Screen for Editor {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        if self.dismissed {
            return Vec::new();
        }
        match event.kind {
            Some(E::Appeared(_) | E::DataChanged(_) | E::EnvironmentChanged(_)) => {
                self.reload(ctx);
                Vec::new()
            }
            Some(E::AgendaEditor(event)) => event
                .kind
                .map_or_else(Vec::new, |kind| self.on_editor_event(kind, ctx)),
            _ => Vec::new(),
        }
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        let locale = ctx.locale();
        // The draft is there once the lists were read; a gate or a failed first read shows none.
        let content = match (&self.page, &self.draft) {
            (Page::Ready { .. }, Some(draft)) => Some(wire::agenda_editor_state::Content::Data(
                Box::new(self.data(locale, ctx.hour_cycle(), draft)),
            )),
            _ => None,
        };
        let page = self.page.wire(
            locale,
            |denial| wire::Denied {
                title: words::denied_title(locale),
                body: words::denied_body(locale),
                receipt: denial.code.clone().unwrap_or_default(),
            },
            wire::EmptyState::default,
        );
        let confirm = (self.asking == Asking::Discard).then(|| wire::Confirm {
            title: words::confirm_discard_new_task_title(locale),
            body: words::confirm_discard_body(locale),
            confirm_label: words::quick_discard(locale),
            destructive: true,
        });
        wire::ViewState {
            kind: Some(wire::view_state::Kind::AgendaEditor(
                wire::AgendaEditorState {
                    mode: Mode::Create as i32,
                    content,
                    page: Some(page),
                    sheet: self.sheet as i32,
                    confirm,
                    chrome: Some(chrome(locale)),
                    dismissed: self.dismissed,
                    kind: wire::AgendaEditorKind::Task as i32,
                    status: self.status.clone(),
                },
            )),
            ..wire::ViewState::default()
        }
    }
}

impl Editor {
    fn data(&self, locale: Locale, cycle: HourCycle, draft: &Draft) -> wire::AgendaEditorData {
        let repeats: Vec<wire::AgendaChoice> = self
            .repeat_keys()
            .into_iter()
            .map(|key| {
                let label = self.repeat_label(locale, &key, draft);
                wire::AgendaChoice {
                    selected: key == draft.repeat_key,
                    accessibility_label: label.clone(),
                    key,
                    label,
                    hue_key: String::new(),
                }
            })
            .collect();
        let repeat_label = repeats.iter().find(|choice| choice.selected).map_or_else(
            || words::repeat_never(locale),
            |choice| choice.label.clone(),
        );
        let lists = self.lists(locale, draft);
        let priorities = Self::priorities(locale, draft);
        let blocked = self.blocked(locale);
        let say_blocked = self.dirty() || self.save_tried;
        wire::AgendaEditorData {
            draft: Some(draft.clone()),
            heading: words::new_task(locale),
            start_label: if draft.all_day {
                long_day(locale, &draft.start_day)
            } else {
                fill(
                    &editor_words::day_and_time(locale),
                    &[
                        ("day", &long_day(locale, &draft.start_day)),
                        ("time", &civil::time_for(locale, &draft.start_time, cycle)),
                    ],
                )
            },
            start_day_label: civil::short_day(locale, &draft.start_day),
            start_time_label: if draft.all_day {
                String::new()
            } else {
                civil::time_for(locale, &draft.start_time, cycle)
            },
            repeat_label: repeat_label.clone(),
            repeats,
            dirty: self.dirty(),
            can_save: self.can_save(locale),
            blocked_reason: if say_blocked { blocked } else { String::new() },
            show_event_fields: false,
            start_field_label: words::field_due(locale),
            show_task_fields: true,
            list_label: lists
                .iter()
                .find(|choice| choice.selected)
                .map(|choice| choice.label.clone())
                .unwrap_or_default(),
            list_hue_key: lists
                .iter()
                .find(|choice| choice.selected)
                .map(|choice| choice.hue_key.clone())
                .unwrap_or_default(),
            lists,
            more_details_open: self.more_open,
            more_details_summary: self.more_details_summary(locale, draft, &repeat_label),
            custom_repeat: if self.sheet == Sheet::CustomRepeat {
                self.custom_sheet(locale, draft)
            } else {
                None
            },
            show_url: true,
            url_saved_as: Self::url_saved_as(draft),
            priority_label: priorities
                .iter()
                .find(|choice| choice.selected)
                .map(|choice| choice.label.clone())
                .unwrap_or_default(),
            priorities,
            ..wire::AgendaEditorData::default()
        }
    }
}

fn chrome(locale: Locale) -> wire::AgendaEditorChrome {
    wire::AgendaEditorChrome {
        title_placeholder: words::placeholder_title(locale),
        notes_placeholder: words::placeholder_notes(locale),
        field_title: words::field_summary(locale),
        field_all_day: words::field_all_day(locale),
        field_repeat: words::field_repeat(locale),
        field_notes: words::field_notes(locale),
        save: words::save(locale),
        close: words::close(locale),
        done: words::done(locale),
        keep_editing: words::keep_editing(locale),
        loading: words::loading(locale),
        retry: words::retry(locale),
        pick_date: words::pick_date(locale),
        pick_time: words::pick_time(locale),
        field_list: task_words::field_list(locale),
        field_more_details: task_words::field_more_details(locale),
        field_priority: task_strings::field_priority(locale),
        field_tags: task_strings::field_tags(locale),
        tag_placeholder: task_strings::tags_add(locale),
        field_url: editor_words::field_url(locale),
        url_placeholder: editor_words::placeholder_url(locale),
        custom_repeat_title: repeat_words::title(locale),
        ..wire::AgendaEditorChrome::default()
    }
}
