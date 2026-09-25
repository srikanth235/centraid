//! TASKS' ARM OF THE APP QUERY (#1046): `crates/apps/tasks`' loaders, asked
//! through [`super::VaultDoor`] and spelled as `tasks.proto` spells them.
//!
//! The board, the families, the recurrence facts, every civil reading and
//! every place's groups are the crate's (`queries`, `local`, `views`); this
//! module resolves the zone ([`super::zone_of`]'s rule) and the vault clock,
//! runs the loader, and converts. `today` is the vault clock's day in the
//! request's zone — never the host's clock and never UTC by default.

use centraid_api_proto::core_v1 as wire;
use centraid_apps_tasks as tasks;
use centraid_apps_tasks::local::{self, Civil};
use centraid_apps_tasks::queries::{ProjectRow, SectionRow, TaskRow};
use centraid_apps_tasks::views::{self, GroupKind, Placed, View};
use centraid_vault::Vault;
use centraid_vault::time::zone::FireZone;

use super::{RecordingSearch, VaultDoor, settle, zone_of};
use crate::error::{CoreError, Result};

type Answer = wire::app_query_response::Answer;

/// The vault clock, read in `zone`.
fn today_in(zone: &FireZone, now: &str) -> Result<Civil> {
    local::today(zone, now).ok_or_else(|| CoreError::Invariant {
        context: format!("the vault clock did not read as an instant: {now}"),
    })
}

/// A window of zero is the manifest's default; the crate clamps the rest.
fn limit_of(limit: u32) -> Option<i64> {
    (limit > 0).then_some(i64::from(limit))
}

fn view_of(asked: &wire::TasksBoardRequest) -> Result<Option<View>> {
    use wire::TasksView as V;
    Ok(Some(
        match V::try_from(asked.view).unwrap_or(V::Unspecified) {
            V::Unspecified => return Ok(None),
            V::Today => View::Today,
            V::Upcoming => View::Upcoming,
            V::Inbox => View::Inbox,
            V::Anytime => View::Anytime,
            V::All => View::All,
            V::Logbook => View::Logbook,
            V::Reminders => View::Reminders,
            V::Project => {
                let project_id = asked.project_id.trim();
                if project_id.is_empty() {
                    return Err(CoreError::InvalidRequest {
                        detail: "a tasks board for one project names no `project_id`".to_owned(),
                    });
                }
                View::Project(project_id.to_owned())
            }
        },
    ))
}

pub(super) fn board(
    vault: &Vault,
    door: &VaultDoor<'_>,
    now: &str,
    asked: &wire::TasksBoardRequest,
) -> Result<Answer> {
    let zone = zone_of(vault, &asked.tz)?;
    let today = today_in(&zone, now)?;
    let view = view_of(asked)?;
    settle(
        door,
        tasks::load_board(door, limit_of(asked.limit), now),
        |data| {
            let open = placed(&data.open, &zone, &today);
            let logbook = placed(&data.logbook, &zone, &today);
            let groups = view
                .as_ref()
                .map(|view| views::groups(view, &open, &logbook, &data.projects, &data.sections))
                .unwrap_or_default();
            let counts = views::counts(&open);
            Answer::TasksBoard(wire::TasksBoard {
                today: today.day_text(),
                now_local: today.local_text(),
                view: asked.view,
                groups: groups.into_iter().map(group_to_wire).collect(),
                counts: Some(wire::TasksCounts {
                    overdue: count(counts.overdue),
                    today: count(counts.today),
                    upcoming: count(counts.upcoming),
                    anytime: count(counts.anytime),
                    inbox: count(counts.inbox),
                    reminders: count(counts.reminders),
                    open: count(data.open_count),
                    closed: count(data.closed_count),
                }),
                projects: data
                    .projects
                    .iter()
                    .map(|project| project_to_wire(project, &open))
                    .collect(),
                sections: data
                    .sections
                    .iter()
                    .map(|section| section_to_wire(section, &open))
                    .collect(),
                tags: data
                    .tags
                    .into_iter()
                    .map(|chip| wire::TasksTagChip {
                        concept_id: chip.concept_id,
                        label: chip.label,
                    })
                    .collect(),
                truncated: data.truncated,
                window: count(data.window),
            })
        },
    )
}

pub(super) fn task(
    vault: &Vault,
    door: &VaultDoor<'_>,
    now: &str,
    asked: &wire::TasksTaskRequest,
) -> Result<Answer> {
    let zone = zone_of(vault, &asked.tz)?;
    let today = today_in(&zone, now)?;
    let loaded = tasks::load_task(door, &asked.task_id, now).and_then(|(detail, denial)| {
        // The chrome only for a task that is there to be filed somewhere.
        let chrome = if denial.is_none() && detail.task.is_some() {
            tasks::queries::load_chrome(door)?
        } else {
            (Vec::new(), Vec::new())
        };
        Ok(((detail, chrome), denial))
    });
    settle(door, loaded, |(detail, (projects, sections))| {
        let placed_task = detail
            .task
            .as_ref()
            .map(|task| views::place(task, &zone, &today));
        let family: Vec<Placed> = placed_task.iter().cloned().collect();
        let project = detail.task.as_ref().and_then(|task| {
            projects
                .iter()
                .find(|project| Some(&project.project_id) == task.project_id.as_ref())
        });
        let section = detail.task.as_ref().and_then(|task| {
            sections
                .iter()
                .find(|section| Some(&section.section_id) == task.section_id.as_ref())
        });
        Answer::TasksTask(Box::new(wire::TasksTaskDetail {
            today: today.day_text(),
            now_local: today.local_text(),
            task: placed_task.as_ref().map(task_to_wire),
            parent: detail
                .parent
                .as_ref()
                .map(|parent| task_to_wire(&views::place(parent, &zone, &today))),
            project: project.map(|project| project_to_wire(project, &family)),
            section: section.map(|section| section_to_wire(section, &family)),
        }))
    })
}

pub(super) fn projects(
    vault: &Vault,
    door: &VaultDoor<'_>,
    now: &str,
    asked: &wire::TasksProjectsRequest,
) -> Result<Answer> {
    let zone = zone_of(vault, &asked.tz)?;
    let today = today_in(&zone, now)?;
    settle(door, tasks::load_board(door, None, now), |data| {
        let open = placed(&data.open, &zone, &today);
        Answer::TasksProjects(wire::TasksProjects {
            projects: data
                .projects
                .iter()
                .map(|project| project_to_wire(project, &open))
                .collect(),
            sections: data
                .sections
                .iter()
                .map(|section| section_to_wire(section, &open))
                .collect(),
            inbox_count: count(views::counts(&open).inbox),
        })
    })
}

pub(super) fn search(
    vault: &Vault,
    door: &VaultDoor<'_>,
    now: &str,
    asked: &wire::TasksSearchRequest,
) -> Result<Answer> {
    if asked.limit == 0 {
        // REQUIRED AND VALIDATED, not defaulted: proto3 cannot say "required".
        return Err(CoreError::InvalidRequest {
            detail: "a tasks search carries no limit; a default is how an unbounded read \
                     gets written by accident"
                .to_owned(),
        });
    }
    let zone = zone_of(vault, &asked.tz)?;
    let today = today_in(&zone, now)?;
    let loaded = vault.read(|connection| {
        let index = match centraid_search::SqliteDoor::open(connection) {
            Ok(index) => index,
            Err(error) => {
                return Ok(Err(CoreError::Invariant {
                    context: format!("the search index will not open: {error}"),
                }));
            }
        };
        let search = RecordingSearch {
            inner: &index,
            door,
        };
        Ok(Ok(tasks::load_search_term(
            door,
            &search,
            &centraid_search::Principal::Owner,
            &asked.term,
            usize::try_from(asked.limit).unwrap_or(usize::MAX),
            now,
        )))
    })??;
    settle(door, loaded, |data| {
        Answer::TasksSearch(wire::TasksSearch {
            today: today.day_text(),
            now_local: today.local_text(),
            tasks: data
                .tasks
                .iter()
                .map(|task| task_to_wire(&views::place(task, &zone, &today)))
                .collect(),
        })
    })
}

pub(super) fn catch_up(
    vault: &Vault,
    door: &VaultDoor<'_>,
    now: &str,
    asked: &wire::TasksCatchUpRequest,
) -> Result<Answer> {
    let zone = zone_of(vault, &asked.tz)?;
    let today = today_in(&zone, now)?;
    settle(door, tasks::load_board(door, None, now), |data| {
        let piles = views::catch_up(&placed(&data.open, &zone, &today));
        let rows = |pile: &[Placed]| pile.iter().map(task_to_wire).collect();
        Answer::TasksCatchUp(wire::TasksCatchUp {
            today: today.day_text(),
            now_local: today.local_text(),
            dated: rows(&piles.dated),
            repeating: rows(&piles.repeating),
            sitting: rows(&piles.sitting),
            away_days: u32::try_from(piles.away_days).unwrap_or(u32::MAX),
            overdue: count(piles.overdue),
            absent: piles.absent,
        })
    })
}

// ---------------------------------------------------------------------------
// The conversion. ONE place, so a field that moved is one edit.
// ---------------------------------------------------------------------------

fn count(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

fn placed(rows: &[TaskRow], zone: &FireZone, today: &Civil) -> Vec<Placed> {
    rows.iter()
        .map(|task| views::place(task, zone, today))
        .collect()
}

fn project_to_wire(project: &ProjectRow, open: &[Placed]) -> wire::TasksProject {
    wire::TasksProject {
        project_id: project.project_id.clone(),
        name: project.name.clone().unwrap_or_default(),
        area: project.area.clone(),
        color: project.color.clone(),
        sort_order: project.sort_order.unwrap_or_default(),
        open_count: count(
            open.iter()
                .filter(|task| {
                    tasks::is_open_status(&task.task.status)
                        && task.task.project_id.as_deref() == Some(project.project_id.as_str())
                })
                .count(),
        ),
    }
}

fn section_to_wire(section: &SectionRow, open: &[Placed]) -> wire::TasksSection {
    wire::TasksSection {
        section_id: section.section_id.clone(),
        project_id: section.project_id.clone().unwrap_or_default(),
        name: section.name.clone().unwrap_or_default(),
        sort_order: section.sort_order.unwrap_or_default(),
        open_count: count(
            open.iter()
                .filter(|task| {
                    tasks::is_open_status(&task.task.status)
                        && task.task.section_id.as_deref() == Some(section.section_id.as_str())
                })
                .count(),
        ),
    }
}

fn group_to_wire(group: views::Group) -> wire::TasksGroup {
    use wire::TasksGroupKind as K;
    wire::TasksGroup {
        kind: match group.kind {
            GroupKind::Overdue => K::Overdue,
            GroupKind::Today => K::Today,
            GroupKind::Day => K::Day,
            GroupKind::Inbox => K::Inbox,
            GroupKind::Project => K::Project,
            GroupKind::Dated => K::Dated,
            GroupKind::Undated => K::Undated,
            GroupKind::Done => K::Done,
            GroupKind::WontDo => K::WontDo,
            GroupKind::Reminders => K::Reminders,
            GroupKind::Section => K::Section,
            GroupKind::Unsectioned => K::Unsectioned,
        } as i32,
        key: group.key,
        day: group.day,
        project_id: group.project_id,
        section_id: group.section_id,
        tasks: group.tasks.iter().map(task_to_wire).collect(),
    }
}

fn task_to_wire(placed: &Placed) -> wire::TasksTask {
    let task = &placed.task;
    let due = &placed.due;
    let small =
        |value: i64| i32::try_from(value).unwrap_or(if value < 0 { i32::MIN } else { i32::MAX });
    wire::TasksTask {
        task_id: task.task_id.clone(),
        parent_task_id: task.parent_task_id.clone(),
        project_id: task.project_id.clone(),
        section_id: task.section_id.clone(),
        status: task.status.clone(),
        title: task.title.clone(),
        description: task.description.clone(),
        priority: task.priority.unwrap_or_default(),
        due_at: task.due_at.clone(),
        completed_at: task.completed_at.clone(),
        effort_min: task.effort_min,
        remind_before_min: task.remind_before_min,
        recurrence_anchor: task.recurrence_anchor.clone(),
        tz: task.tz.clone(),
        series_id: task.series_id.clone(),
        sort_order: task.sort_order.unwrap_or_default(),
        created_at: task.created_at.clone(),
        updated_at: task.updated_at.clone(),
        repeats: task.rrule.is_some(),
        rrule: task.rrule.clone(),
        recurrence_summary: task.recurrence.recurrence_summary.clone(),
        missed: count(task.recurrence.missed.unwrap_or_default()),
        next_due: task.recurrence.next_due.clone(),
        due_day: due.due_day.clone(),
        due_local: due.due_local.clone(),
        due_time: due.due_time.clone(),
        days_from_today: due.days_from_today.map(small),
        overdue: due.overdue,
        lands_today: due.lands_today,
        remind_at_local: due.remind_at_local.clone(),
        completed_day: placed.completed_day.clone(),
        age_days: placed.age_days.map(small),
        tags: task
            .tags
            .iter()
            .map(|tag| wire::TasksTag {
                tag_id: tag.tag_id.clone(),
                concept_id: tag.concept_id.clone(),
                label: tag.label.clone(),
            })
            .collect(),
        attachments: task
            .attachments
            .iter()
            .map(|attachment| wire::TasksAttachment {
                attachment_id: attachment.attachment_id.clone(),
                content_id: attachment.content_id.clone(),
                role: attachment.role.clone(),
                is_primary: attachment.is_primary.unwrap_or_default() != 0,
                media_type: attachment.media_type.clone(),
                content_uri: attachment.content_uri.clone(),
                byte_size: attachment.byte_size,
            })
            .collect(),
        references: task
            .references
            .iter()
            .map(|reference| wire::TasksReference {
                link_id: reference.link_id.clone(),
                to_type: reference.to_type.clone(),
                to_id: reference.to_id.clone(),
            })
            .collect(),
        children: placed.children.iter().map(task_to_wire).collect(),
        done_children: count(task.done_children.unwrap_or_default()),
        snippet: task.snippet.clone(),
    }
}

#[cfg(test)]
#[path = "tasks_tests.rs"]
mod tests;
