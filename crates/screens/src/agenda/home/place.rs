//! TO-DO (#1128, R-1128-1): the Inbox's tasks, then the projects by area (named
//! areas A→Z, then "Projects" for those in none) in one list.
//!
//! Pure folds over [`Held`]. A row is checked off ("Task done" and Undo on the
//! status line), filed (a sheet of Inbox, projects and sections) or opened; the
//! quick add lands in the Inbox.

use std::collections::BTreeMap;

use centraid_api_proto::core_v1 as wire;

use super::held::Held;
use crate::agenda::routes;
use crate::agenda::todo::rows;
use crate::strings::{Locale, agenda_home as sentences, task as words};

/// To-do's data, or `None` when the Inbox board and the projects are not both
/// held.
#[must_use]
pub fn fold(locale: Locale, held: &Held, limit: u32) -> Option<wire::AgendaHomeData> {
    let board = held.inbox.as_ref()?;
    let answer = held.projects.as_ref()?;
    let (projects, sections) = held.projects_of();
    let ctx = rows::Context::of(&board.today, projects, sections);
    let groups = rows::groups(locale, &board.groups, &ctx);
    let project_groups = project_groups(locale, answer);
    let counts = board.counts.as_ref();
    let open = counts.map(|counts| counts.open);
    let day_one = counts.is_some_and(|counts| counts.open == 0 && counts.closed == 0)
        && board.projects.is_empty()
        && answer.projects.is_empty();
    // NOTHING OPEN (day one, or the starters finished) is when the phone's
    // reminders are offered: a first vault's starter tasks mean day one is
    // never seen, and "all done" is the point of use.
    let reminders = if open == Some(0) {
        wire::ImportSource::Reminders
    } else {
        wire::ImportSource::Unspecified
    };
    let empty = if !groups.is_empty() || !project_groups.is_empty() {
        wire::EmptyState::default()
    } else if day_one {
        // DAY ONE, and only day one, says so; both offer the phone's reminders,
        // where the shell can read them.
        wire::EmptyState {
            headline: words::day_one(locale),
            import_source: wire::ImportSource::Reminders as i32,
            ..wire::EmptyState::default()
        }
    } else {
        wire::EmptyState {
            headline: words::inbox_empty(locale),
            import_source: reminders as i32,
            action_label: words::new_project_title(locale),
            ..wire::EmptyState::default()
        }
    };
    let root_count = rows::root_count(&groups);
    let mut parts = Vec::new();
    if root_count > 0 {
        parts.push(rows::count(locale, root_count));
    }
    if !answer.projects.is_empty() {
        parts.push(sentences::project_count(
            locale,
            answer.projects.len() as u64,
        ));
    }
    Some(wire::AgendaHomeData {
        today: board.today.clone(),
        catch_up: Some(routes::catch_up()),
        todo: Some(wire::AgendaTodo {
            groups,
            projects: project_groups,
            empty: Some(empty),
            count_label: parts.join(" · "),
            window_label: if board.truncated {
                sentences::window_count(locale, u64::from(board.window))
            } else {
                String::new()
            },
            can_show_more: board.truncated && limit < rows::MAX_WINDOW,
            new_project_label: words::new_project_title(locale),
        }),
        ..wire::AgendaHomeData::default()
    })
}

/// Named areas A→Z, then the projects in none.
fn project_groups(
    locale: Locale,
    answer: &wire::AgendaTaskProjects,
) -> Vec<wire::TodoProjectGroup> {
    let mut sorted: Vec<&wire::AgendaTaskProject> = answer.projects.iter().collect();
    sorted.sort_by(|a, b| (a.sort_order, &a.name).cmp(&(b.sort_order, &b.name)));
    let mut named: BTreeMap<&str, Vec<&wire::AgendaTaskProject>> = BTreeMap::new();
    let mut unnamed = Vec::new();
    for project in sorted {
        match project
            .area
            .as_deref()
            .filter(|area| !area.trim().is_empty())
        {
            Some(area) => named.entry(area).or_default().push(project),
            None => unnamed.push(project),
        }
    }
    let group = |key: String, title: String, projects: Vec<&wire::AgendaTaskProject>| {
        wire::TodoProjectGroup {
            key,
            title,
            rows: projects
                .into_iter()
                .map(|project| {
                    let count = rows::count(locale, project.open_count as usize);
                    wire::TodoProjectRow {
                        row: Some(wire::ListRow {
                            id: project.project_id.clone(),
                            title: project.name.clone(),
                            accessibility_label: format!("{}, {count}", project.name),
                            hue_key: rows::hue_of(&project.project_id, Some(project)),
                            meta: count,
                            ..wire::ListRow::default()
                        }),
                        route: Some(routes::project(&project.project_id, &project.name)),
                    }
                })
                .collect(),
        }
    };
    let mut out: Vec<wire::TodoProjectGroup> = named
        .into_iter()
        .map(|(area, projects)| group(format!("area|{area}"), area.to_owned(), projects))
        .collect();
    if !unnamed.is_empty() {
        out.push(group(
            "area|".to_owned(),
            words::projects_no_area(locale),
            unnamed,
        ));
    }
    out
}

/// Inbox, then each project and its sections, the task's own place selected.
#[must_use]
pub fn file_choices(locale: Locale, held: &Held, task_id: &str) -> Vec<wire::TodoChoice> {
    let Some(task) = held.find(task_id) else {
        return Vec::new();
    };
    let (projects, sections) = held.projects_of();
    let mut projects: Vec<&wire::AgendaTaskProject> = projects.iter().collect();
    projects.sort_by(|a, b| (a.sort_order, &a.name).cmp(&(b.sort_order, &b.name)));
    let mut choices = vec![wire::TodoChoice {
        key: rows::FILE_INBOX.to_owned(),
        label: words::inbox(locale),
        selected: task.project_id.is_none(),
        enabled: true,
        icon_key: "Inbox".to_owned(),
        ..wire::TodoChoice::default()
    }];
    for project in projects {
        choices.push(wire::TodoChoice {
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
            .filter(|section| section.project_id == project.project_id)
            .collect();
        own.sort_by_key(|section| section.sort_order);
        for section in own {
            choices.push(wire::TodoChoice {
                key: format!("{}{}", rows::FILE_SECTION, section.section_id),
                label: section.name.clone(),
                selected: task.section_id.as_deref() == Some(section.section_id.as_str()),
                enabled: true,
                indented: true,
                ..wire::TodoChoice::default()
            });
        }
    }
    choices
}

/// Where a filing choice files to: the project, the section and the words the
/// status line names it by. `None` when the key names a place the held answers
/// no longer have (a project gone since the sheet was drawn).
#[must_use]
pub fn filing(
    locale: Locale,
    held: &Held,
    key: &str,
) -> Option<(Option<String>, Option<String>, String)> {
    let (projects, sections) = held.projects_of();
    if key == rows::FILE_INBOX {
        return Some((None, None, words::inbox(locale)));
    }
    if let Some(id) = key.strip_prefix(rows::FILE_PROJECT) {
        let project = projects.iter().find(|project| project.project_id == id)?;
        return Some((Some(id.to_owned()), None, project.name.clone()));
    }
    let section_id = key.strip_prefix(rows::FILE_SECTION)?;
    let section = sections
        .iter()
        .find(|section| section.section_id == section_id)?;
    let project = projects
        .iter()
        .find(|project| project.project_id == section.project_id)?;
    Some((
        Some(project.project_id.clone()),
        Some(section_id.to_owned()),
        format!("{} · {}", project.name, section.name),
    ))
}

#[cfg(test)]
mod tests {
    //! To-do over boards the vault cannot make: a vault with no project at all.

    use super::*;

    fn board(open: u32, closed: u32) -> wire::AgendaTaskBoard {
        wire::AgendaTaskBoard {
            today: "2026-06-15".to_owned(),
            counts: Some(wire::AgendaTaskCounts {
                open,
                closed,
                ..wire::AgendaTaskCounts::default()
            }),
            ..wire::AgendaTaskBoard::default()
        }
    }

    fn held(board: wire::AgendaTaskBoard, projects: Vec<wire::AgendaTaskProject>) -> Held {
        Held {
            inbox: Some(board),
            projects: Some(wire::AgendaTaskProjects {
                projects,
                ..wire::AgendaTaskProjects::default()
            }),
            ..Held::default()
        }
    }

    fn empty_of(held: &Held) -> wire::EmptyState {
        fold(Locale::En, held, rows::PAGE)
            .unwrap()
            .todo
            .unwrap()
            .empty
            .unwrap()
    }

    #[test]
    fn day_one_says_so_and_offers_the_reminders() {
        let empty = empty_of(&held(board(0, 0), vec![]));
        assert_eq!(empty.headline, "Add the first thing you must not forget.");
        assert_eq!(empty.import_source, wire::ImportSource::Reminders as i32);
        assert_eq!(empty.action_label, "");
    }

    #[test]
    fn nothing_open_after_work_was_done_offers_the_reminders_and_the_new_project_action() {
        let empty = empty_of(&held(board(0, 4), vec![]));
        assert_eq!(empty.headline, "Nothing is waiting to be filed.");
        assert_eq!(empty.action_label, "New project");
        assert_eq!(empty.import_source, wire::ImportSource::Reminders as i32);
    }

    #[test]
    fn work_open_elsewhere_has_nothing_to_import_over_it() {
        let empty = empty_of(&held(board(1, 0), vec![]));
        assert_eq!(empty.headline, "Nothing is waiting to be filed.");
        assert_eq!(empty.import_source, wire::ImportSource::Unspecified as i32);
    }

    #[test]
    fn a_project_alone_is_something_and_the_projects_are_ordered_within_their_area() {
        let project = |id: &str, name: &str, area: Option<&str>, order: i64, open: u32| {
            wire::AgendaTaskProject {
                project_id: id.to_owned(),
                name: name.to_owned(),
                area: area.map(str::to_owned),
                sort_order: order,
                open_count: open,
                ..wire::AgendaTaskProject::default()
            }
        };
        let held = held(
            board(0, 0),
            vec![
                project("p2", "Taxes", None, 2, 1),
                project("p1", "Garden", Some("Home"), 5, 3),
                project("p4", "Beds", Some("Home"), 1, 0),
                project("p3", "Launch", Some("Work"), 0, 0),
            ],
        );
        let data = fold(Locale::En, &held, rows::PAGE).unwrap();
        let todo = data.todo.unwrap();
        assert_eq!(todo.empty.unwrap().headline, "", "projects are something");
        let shape: Vec<(String, Vec<String>)> = todo
            .projects
            .iter()
            .map(|group| {
                (
                    group.title.clone(),
                    group
                        .rows
                        .iter()
                        .map(|r| r.row.clone().unwrap().title)
                        .collect(),
                )
            })
            .collect();
        assert_eq!(
            shape,
            [
                (
                    "Home".to_owned(),
                    vec!["Beds".to_owned(), "Garden".to_owned()]
                ),
                ("Work".to_owned(), vec!["Launch".to_owned()]),
                ("Projects".to_owned(), vec!["Taxes".to_owned()]),
            ]
        );
        assert_eq!(
            todo.projects[0].rows[1].row.as_ref().unwrap().meta,
            "3 tasks"
        );
        assert_eq!(
            todo.projects[2].rows[0].row.as_ref().unwrap().meta,
            "1 task"
        );
        assert_eq!(todo.count_label, "4 projects");
    }

    #[test]
    fn a_window_that_is_not_everything_says_so_until_the_ceiling() {
        let mut full = board(100, 0);
        full.truncated = true;
        full.window = 100;
        let held = held(full, vec![]);
        let todo = fold(Locale::En, &held, 100).unwrap().todo.unwrap();
        assert_eq!(todo.window_label, "100 tasks · more not shown");
        assert!(todo.can_show_more);
        assert!(
            !fold(Locale::En, &held, rows::MAX_WINDOW)
                .unwrap()
                .todo
                .unwrap()
                .can_show_more
        );
    }

    #[test]
    fn a_filing_key_names_its_place_or_nothing() {
        let mut held = held(
            board(1, 0),
            vec![wire::AgendaTaskProject {
                project_id: "p1".to_owned(),
                name: "Garden".to_owned(),
                ..wire::AgendaTaskProject::default()
            }],
        );
        held.projects.as_mut().unwrap().sections = vec![wire::AgendaTaskSection {
            section_id: "s1".to_owned(),
            project_id: "p1".to_owned(),
            name: "Beds".to_owned(),
            ..wire::AgendaTaskSection::default()
        }];
        let en = Locale::En;
        assert_eq!(
            filing(en, &held, "inbox"),
            Some((None, None, "Inbox".to_owned()))
        );
        assert_eq!(
            filing(en, &held, "project:p1"),
            Some((Some("p1".to_owned()), None, "Garden".to_owned()))
        );
        assert_eq!(
            filing(en, &held, "section:s1"),
            Some((
                Some("p1".to_owned()),
                Some("s1".to_owned()),
                "Garden · Beds".to_owned()
            ))
        );
        assert_eq!(filing(en, &held, "project:gone"), None);
        assert_eq!(filing(en, &held, "section:gone"), None);
        assert_eq!(filing(en, &held, "nonsense"), None);
    }
}
