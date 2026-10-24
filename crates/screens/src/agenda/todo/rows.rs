//! WHAT ONE TASK SAYS AS A ROW — one way, for every to-do surface (Day,
//! Schedule, To-do, a list, a project, Catch up).
//!
//! Pure: every date is a civil string the core already placed in the device's
//! zone (`due_day`, `due_time`, `remind_at_local`, `completed_day`), and `today`
//! is the answer's own, never the device clock's UTC day. The words are
//! [`crate::kit::civil`] and [`crate::strings::task`]; a view formats nothing.

use std::collections::HashMap;

use centraid_api_proto::core_v1 as wire;
use wire::TasksGroupKind as Kind;

use crate::agenda::routes;
use crate::kit::civil;
use crate::strings::{Locale, task as words};

pub const STATUS_OPEN: &str = "open";
pub const STATUS_DONE: &str = "done";
pub const STATUS_CANCELLED: &str = "cancelled";

/// The board window, and how far "Show more" may widen it (the manifest's 20…500).
pub const PAGE: u32 = 100;
pub const MAX_WINDOW: u32 = 500;

/// Filing choice keys.
pub const FILE_INBOX: &str = "inbox";
pub const FILE_PROJECT: &str = "project:";
pub const FILE_SECTION: &str = "section:";

/// A group verb's keys: Overdue's way out, and a section's add target.
pub const VERB_CATCH_UP: &str = "catch_up";
pub const VERB_ADD: &str = "add:";

/// Undated open work this old says how long it has sat.
const SITTING_DAYS: i32 = 30;
const META_SEPARATOR: &str = " · ";

/// What a row needs besides its task.
#[derive(Clone, Debug, Default)]
pub struct Context<'a> {
    pub today: &'a str,
    pub projects: HashMap<&'a str, &'a wire::TasksProject>,
    pub sections: HashMap<&'a str, &'a wire::TasksSection>,
    /// The group head already names the day, so the row says the time only.
    pub day_in_head: bool,
    /// Name the project in the meta line (not inside the project itself).
    pub show_project: bool,
}

impl<'a> Context<'a> {
    /// A context over a board's projects and sections.
    #[must_use]
    pub fn of(
        today: &'a str,
        projects: &'a [wire::TasksProject],
        sections: &'a [wire::TasksSection],
    ) -> Self {
        Self {
            today,
            projects: projects
                .iter()
                .map(|p| (p.project_id.as_str(), p))
                .collect(),
            sections: sections
                .iter()
                .map(|s| (s.section_id.as_str(), s))
                .collect(),
            day_in_head: false,
            show_project: true,
        }
    }
}

#[must_use]
pub fn is_open(task: &wire::TasksTask) -> bool {
    task.status != STATUS_DONE && task.status != STATUS_CANCELLED
}

#[must_use]
pub fn check_of(status: &str) -> wire::TodoCheck {
    match status {
        STATUS_DONE => wire::TodoCheck::Done,
        STATUS_CANCELLED => wire::TodoCheck::WontDo,
        _ => wire::TodoCheck::Open,
    }
}

#[must_use]
pub fn check_label(locale: Locale, title: &str, open: bool) -> String {
    if open {
        format!(
            "{} {title} {}",
            words::mark(locale),
            words::done_suffix(locale)
        )
    } else {
        format!("{} {title}", words::reopen(locale))
    }
}

/// The row for `task`; `subtask` rows carry no children of their own.
#[must_use]
pub fn row(locale: Locale, task: &wire::TasksTask, ctx: &Context, subtask: bool) -> wire::TodoRow {
    let title = if task.title.trim().is_empty() {
        words::untitled(locale)
    } else {
        task.title.clone()
    };
    let due = due_label(locale, task, ctx);
    let meta = meta(locale, task, ctx);
    let priority = priority_label(locale, task.priority);
    let check = check_of(&task.status);
    let open = matches!(check, wire::TodoCheck::Open | wire::TodoCheck::InProcess);
    let accessibility = [title.as_str(), &due, &meta, &priority]
        .iter()
        .filter(|part| !part.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join(", ");
    wire::TodoRow {
        task_id: task.task_id.clone(),
        children: if subtask {
            Vec::new()
        } else {
            task.children
                .iter()
                .map(|child| row(locale, child, ctx, true))
                .collect()
        },
        due_label: due,
        overdue: task.overdue && open,
        meta,
        priority_label: priority,
        project_hue_key: task
            .project_id
            .as_deref()
            .map(|id| hue_of(id, ctx.projects.get(id).copied()))
            .unwrap_or_default(),
        check: check as i32,
        check_label: check_label(locale, &title, open),
        accessibility_label: accessibility,
        subtask,
        can_file: open && !subtask,
        route: Some(routes::task(&task.task_id)),
        title,
    }
}

/// The due, in words. Overdue says how long ago — a fact, in the attention
/// tone, never a scold. A group head that names the day leaves the time.
#[must_use]
pub fn due_label(locale: Locale, task: &wire::TasksTask, ctx: &Context) -> String {
    if task.due_day.is_empty() {
        return String::new();
    }
    if let Some(days) = task
        .days_from_today
        .filter(|days| task.overdue && *days < 0)
    {
        return if days == -1 {
            civil::relative_day(locale, &task.due_day, ctx.today)
        } else {
            format!("{} {}", -days, words::days_ago(locale))
        };
    }
    if ctx.day_in_head {
        return task.due_time.clone();
    }
    let day = civil::relative_day(locale, &task.due_day, ctx.today);
    if task.due_time.is_empty() {
        day
    } else if task.lands_today {
        task.due_time.clone()
    } else {
        format!("{day} {}", task.due_time)
    }
}

/// The meta line: project · repeats · missed · reminder · effort · tags ·
/// family · age · logbook day. Each part only when it says something.
#[must_use]
pub fn meta(locale: Locale, task: &wire::TasksTask, ctx: &Context) -> String {
    let mut parts: Vec<String> = Vec::new();
    let project = task
        .project_id
        .as_deref()
        .and_then(|id| ctx.projects.get(id))
        .filter(|_| ctx.show_project);
    if let Some(project) = project {
        let section = task
            .section_id
            .as_deref()
            .and_then(|id| ctx.sections.get(id));
        parts.push(match section {
            Some(section) => format!("{} · {}", project.name, section.name),
            None => project.name.clone(),
        });
    }
    // THE CORE'S SENTENCE, never a dash.
    if let Some(summary) = task
        .recurrence_summary
        .as_deref()
        .filter(|s| task.repeats && !s.trim().is_empty())
    {
        parts.push(summary.to_owned());
    }
    if task.missed > 0 && !task.due_day.is_empty() {
        parts.push(format!(
            "{} {} · {} {}",
            words::missed(locale),
            task.missed,
            words::next_is(locale),
            civil::relative_day(locale, &task.due_day, ctx.today)
        ));
    }
    parts.extend(reminder_part(locale, task, ctx.today));
    if let Some(minutes) = task.effort_min {
        parts.push(effort_label(locale, minutes));
    }
    parts.extend(task.tags.iter().map(|tag| format!("#{}", tag.label)));
    if !task.children.is_empty() {
        parts.push(format!(
            "{} {} {}",
            task.done_children,
            words::of(locale),
            task.children.len()
        ));
    }
    if task.due_day.is_empty() && is_open(task) {
        let month = civil::month_of(locale, &task.created_local_day);
        if task.age_days.is_some_and(|age| age >= SITTING_DAYS) && !month.is_empty() {
            parts.push(format!("{} {month}", words::sitting_since(locale)));
        }
    }
    if !is_open(task) && !task.completed_day.is_empty() {
        let day = civil::relative_day(locale, &task.completed_day, ctx.today);
        parts.push(if task.status == STATUS_CANCELLED {
            format!("{} · {day}", words::wont_do(locale).to_lowercase())
        } else {
            day
        });
    }
    parts.retain(|part| !part.is_empty());
    parts.join(META_SEPARATOR)
}

/// THE OWNER'S RULING ON A DATE-ONLY REMINDER: it names a moment only when the
/// core supplies one (`remind_at_local`); a date has no moment to count back
/// from, so it says "on the day" and never invents 09:00.
#[must_use]
pub fn reminder_part(locale: Locale, task: &wire::TasksTask, today: &str) -> Option<String> {
    if !task.remind_at_local.is_empty() {
        let day = civil::relative_day(
            locale,
            task.remind_at_local.get(..10).unwrap_or_default(),
            today,
        );
        return Some(format!(
            "{} {day} {}",
            words::reminder(locale),
            civil::clock(&task.remind_at_local)
        ));
    }
    if task.remind_before_min.is_some() && !task.due_day.is_empty() {
        return Some(format!(
            "{} {}",
            words::reminder(locale),
            words::reminder_on_the_day(locale).to_lowercase()
        ));
    }
    None
}

/// `~25 min`, `~1 hour`.
#[must_use]
pub fn effort_label(locale: Locale, minutes: i64) -> String {
    if minutes == 60 {
        format!(
            "{}{}",
            words::effort_prefix(locale),
            words::effort_hour(locale)
        )
    } else {
        format!(
            "{}{minutes} {}",
            words::effort_prefix(locale),
            words::min(locale)
        )
    }
}

/// Four member-facing levels over the core's scale, higher more urgent.
#[must_use]
pub fn priority_label(locale: Locale, priority: i64) -> String {
    match priority {
        i64::MIN..=0 => String::new(),
        1 => words::priority_soon(locale),
        2 => words::priority_next(locale),
        _ => words::priority_now(locale),
    }
}

/// A project's hue as the theme's colour role (`cTeal`): the stored hue when it
/// is a wheel hue, else the id's own.
#[must_use]
pub fn hue_of(project_id: &str, project: Option<&wire::TasksProject>) -> String {
    let key = centraid_design::party_hue_key(project_id, project.and_then(|p| p.color.as_deref()))
        .unwrap_or_else(|| centraid_design::identity_hue_key(project_id));
    hue_role(key)
}

/// A wheel key as the theme's colour role: `rose` → `cRose`; empty stays empty.
#[must_use]
pub fn hue_role(wheel_key: &str) -> String {
    let mut chars = wheel_key.chars();
    chars.next().map_or_else(String::new, |first| {
        format!("c{}{}", first.to_uppercase(), chars.as_str())
    })
}

/// `April 2026`.
#[must_use]
pub fn month_year(locale: Locale, day: &str) -> String {
    format!(
        "{} {}",
        civil::month_of(locale, day),
        day.get(..4).unwrap_or_default()
    )
}

/// `3 tasks`, `1 task`.
#[must_use]
pub fn count(locale: Locale, n: usize) -> String {
    format!(
        "{n} {}",
        if n == 1 {
            words::task_one(locale)
        } else {
            words::task_many(locale)
        }
    )
}

/// The core's groups, finished. A group left empty is dropped, except a
/// project's sections, which are drawn empty (the core's own rule for the
/// project view).
#[must_use]
pub fn groups(
    locale: Locale,
    groups: &[wire::TasksGroup],
    ctx: &Context,
) -> Vec<wire::TodoRowGroup> {
    let mut last_month = ctx.today.get(..7).unwrap_or_default().to_owned();
    groups
        .iter()
        .filter_map(|group| {
            let kind = Kind::try_from(group.kind).unwrap_or(Kind::Unspecified);
            let keep_empty = kind == Kind::Section;
            let day_head = matches!(kind, Kind::Today | Kind::Day);
            let mut row_ctx = ctx.clone();
            row_ctx.day_in_head = day_head;
            row_ctx.show_project = ctx.show_project && kind != Kind::Project;
            let rows: Vec<_> = group
                .tasks
                .iter()
                .map(|t| row(locale, t, &row_ctx, false))
                .collect();
            if rows.is_empty() && !keep_empty {
                return None;
            }
            let month = (kind == Kind::Day && group.day.len() >= 7)
                .then(|| group.day[..7].to_owned())
                .filter(|month| *month != last_month)
                .inspect(|month| last_month.clone_from(month))
                .map(|_| month_year(locale, &group.day));
            let (verb_label, verb_key) = verb_of(locale, group, kind);
            Some(wire::TodoRowGroup {
                key: if group.key.is_empty() {
                    format!(
                        "{}|{}|{}|{}",
                        group.kind,
                        group.day,
                        group.project_id.as_deref().unwrap_or_default(),
                        group.section_id.as_deref().unwrap_or_default()
                    )
                } else {
                    group.key.clone()
                },
                title: title_of(locale, group, kind, ctx),
                meta: rows.len().to_string(),
                month_heading: month,
                verb_label,
                verb_key,
                section_id: keep_empty.then(|| group.section_id.clone().unwrap_or_default()),
                rows,
            })
        })
        .collect()
}

#[must_use]
pub fn title_of(locale: Locale, group: &wire::TasksGroup, kind: Kind, ctx: &Context) -> String {
    match kind {
        Kind::Overdue => words::group_overdue(locale),
        Kind::Today => words::group_today(locale),
        Kind::Day => civil::relative_day(locale, &group.day, ctx.today),
        Kind::Inbox => words::inbox(locale),
        Kind::Project => group
            .project_id
            .as_deref()
            .and_then(|id| ctx.projects.get(id))
            .map_or_else(|| words::inbox(locale), |p| p.name.clone()),
        Kind::Dated => words::group_dated(locale),
        Kind::Undated => words::group_undated(locale),
        Kind::Done => words::done(locale),
        Kind::WontDo => words::wont_do(locale),
        Kind::Reminders => words::group_reminders(locale),
        Kind::Section => group
            .section_id
            .as_deref()
            .and_then(|id| ctx.sections.get(id))
            .map_or_else(|| words::group_unsectioned(locale), |s| s.name.clone()),
        Kind::Unsectioned => words::group_unsectioned(locale),
        Kind::Unspecified => String::new(),
    }
}

fn verb_of(locale: Locale, group: &wire::TasksGroup, kind: Kind) -> (String, String) {
    match kind {
        Kind::Overdue => (words::catch_up(locale), VERB_CATCH_UP.to_owned()),
        Kind::Section => (
            words::add_task(locale),
            format!(
                "{VERB_ADD}{}",
                group.section_id.as_deref().unwrap_or_default()
            ),
        ),
        Kind::Unsectioned => (words::add_task(locale), VERB_ADD.to_owned()),
        _ => (String::new(), String::new()),
    }
}

/// Roots on screen, for the count.
#[must_use]
pub fn root_count(groups: &[wire::TodoRowGroup]) -> usize {
    groups.iter().map(|group| group.rows.len()).sum()
}

/// A group's roots and their children.
#[must_use]
pub fn flatten(group: &wire::TasksGroup) -> Vec<&wire::TasksTask> {
    group
        .tasks
        .iter()
        .flat_map(|t| std::iter::once(t).chain(t.children.iter()))
        .collect()
}

/// The fixed words a to-do screen draws, so no view carries copy.
#[must_use]
pub fn chrome(locale: Locale) -> wire::TodoChrome {
    wire::TodoChrome {
        title: words::app_title(locale),
        retry: words::retry(locale),
        loading: words::loading(locale),
        search_placeholder: words::search_placeholder(locale),
        search_label: words::search_label(locale),
        search_close: words::close(locale),
        more_title: words::more_title(locale),
        reads_title: words::reads_title(locale),
        reads_facts: vec![
            wire::TodoFact {
                label: words::reads_fact_reads(locale),
                detail: words::reads_fact_reads_value(locale),
            },
            wire::TodoFact {
                label: words::reads_fact_writes(locale),
                detail: words::reads_fact_writes_value(locale),
            },
            wire::TodoFact {
                label: words::reads_fact_leaves(locale),
                detail: words::reads_fact_leaves_value(locale),
            },
        ],
        quick_add_placeholder: words::title_placeholder(locale),
        quick_add_verb: words::add(locale),
        file_title: words::file_title(locale),
        new_project_title: words::new_project_title(locale),
        new_project_placeholder: words::new_project_placeholder(locale),
        new_project_verb: words::new_project_verb(locale),
        add_section_title: words::add_section(locale),
        add_section_placeholder: words::add_section_placeholder(locale),
        add_section_verb: words::add_section(locale),
        cancel: words::cancel(locale),
        home: words::band_home(locale),
        show_more: words::show_more(locale),
        back: words::app_title(locale),
        add_subtask_verb: words::add(locale),
        add_tag_verb: words::add(locale),
        file_verb: words::file(locale),
    }
}
