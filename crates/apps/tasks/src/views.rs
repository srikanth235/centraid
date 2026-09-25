//! WHAT EACH PLACE SHOWS, from one board read — in the device's zone (#1046).
//!
//! v0 derived every place (Today, Upcoming, Inbox, Anytime, All, Logbook, the
//! Reminder lens, one project, Catch up) on the phone from the board's rows
//! and the HOST clock (`logic.ts`). The v1 phone's shared layer has no
//! calendar, so the derivation runs here, over rows already placed by
//! [`crate::local`], and a screen draws the groups it is handed.
//!
//! The ARITHMETIC IS v0's, group for group, with two deliberate corrections:
//!
//! - **"Today" is the device's day**, not the UTC prefix of an instant.
//! - **Catch up's repeating pile is the repeating tasks that are BEHIND**
//!   (a missed period, or an effective due before today). v0 put every open
//!   repeating task in it, so "Complete all" completed a daily task that was
//!   not yet due — a bulk verb acting on work nobody had fallen behind on.
//!
//! Group ORDER inside a group is v0's `byDue`: the effective due's local
//! reading (a date-only due before a timed one on the same day), undated last,
//! then title — and then the primary key, so a full tie is the data's order
//! and not the read's (the board's own rule, [`crate::board::by_urgency`]).

use std::cmp::Ordering;
use std::collections::BTreeMap;

use centraid_vault::time::zone::FireZone;

use crate::board::is_open_status;
use crate::local::{self, Civil, DuePlacement};
use crate::queries::{ProjectRow, SectionRow, TaskRow};

/// An undated task that has sat this many days is "sitting" (v0's 90).
pub const SITTING_DAYS: i64 = 90;

/// Away this many days, with something overdue, and the absence is named
/// (v0's week: "a two-day pile is a Tuesday").
pub const ABSENCE_DAYS: i64 = 7;

/// A task with its civil readings, and its children placed the same way.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Placed {
    pub task: TaskRow,
    pub due: DuePlacement,
    /// The local day `completed_at` falls on; empty when there is none.
    pub completed_day: String,
    /// Civil days since `created_at`, in the zone; `None` when it will not
    /// read.
    pub age_days: Option<i64>,
    pub children: Vec<Placed>,
}

impl Placed {
    fn is_open(&self) -> bool {
        is_open_status(&self.task.status)
    }
    fn dated(&self) -> bool {
        !self.due.due_day.is_empty()
    }
}

/// The effective due: a repeating task's next open period, else its stored
/// due (v0's `next_due ?? due_at`).
#[must_use]
pub fn effective_due(task: &TaskRow) -> Option<&str> {
    task.recurrence
        .next_due
        .as_deref()
        .or(task.due_at.as_deref())
}

/// Place one task (and its family) in `zone`, against `today`.
#[must_use]
pub fn place(task: &TaskRow, zone: &FireZone, today: &Civil) -> Placed {
    let mut bare = task.clone();
    let children = std::mem::take(&mut bare.children)
        .iter()
        .map(|child| place(child, zone, today))
        .collect();
    Placed {
        due: local::place_due(effective_due(task), task.remind_before_min, zone, today),
        completed_day: task
            .completed_at
            .as_deref()
            .and_then(|stamp| local::read(stamp, zone))
            .map(|civil| civil.day_text())
            .unwrap_or_default(),
        age_days: task
            .created_at
            .as_deref()
            .and_then(|stamp| local::read(stamp, zone))
            .map(|born| local::days_between(born.day, today.day)),
        task: bare,
        children,
    }
}

/// v0's `byDue`, made total.
fn by_due(left: &Placed, right: &Placed) -> Ordering {
    match (left.dated(), right.dated()) {
        (true, false) => return Ordering::Less,
        (false, true) => return Ordering::Greater,
        _ => {}
    }
    left.due
        .due_local
        .cmp(&right.due.due_local)
        .then_with(|| left.task.title.cmp(&right.task.title))
        .then_with(|| left.task.task_id.cmp(&right.task.task_id))
}

/// v0's `byClosed`: newest-closed first, an absent stamp last.
fn by_closed(left: &Placed, right: &Placed) -> Ordering {
    let (l, r) = (
        left.task.completed_at.as_deref().unwrap_or_default(),
        right.task.completed_at.as_deref().unwrap_or_default(),
    );
    match (l.is_empty(), r.is_empty()) {
        (true, false) => return Ordering::Greater,
        (false, true) => return Ordering::Less,
        _ => {}
    }
    r.cmp(l)
        .then_with(|| left.task.title.cmp(&right.task.title))
        .then_with(|| left.task.task_id.cmp(&right.task.task_id))
}

/// Which place a board answer is for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum View {
    Today,
    Upcoming,
    Inbox,
    Anytime,
    All,
    Logbook,
    Reminders,
    /// One project, by id: its open work, by section.
    Project(String),
}

/// What a group IS. The shell owns the words; this is the fact.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GroupKind {
    Overdue,
    Today,
    /// One civil day of Upcoming; the group's `day` names it.
    Day,
    /// Unfiled work.
    Inbox,
    /// One project's undated work in Anytime; the group's `project_id` names it.
    Project,
    Dated,
    Undated,
    Done,
    WontDo,
    Reminders,
    /// One section of a project; the group's `section_id` names it.
    Section,
    /// A project's work in no section.
    Unsectioned,
}

/// One group on a place.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Group {
    pub kind: GroupKind,
    /// Stable across answers, for a list's item keys.
    pub key: String,
    pub day: String,
    pub project_id: Option<String>,
    pub section_id: Option<String>,
    pub tasks: Vec<Placed>,
}

impl Group {
    fn new(kind: GroupKind, key: impl Into<String>, mut tasks: Vec<Placed>) -> Self {
        tasks.sort_by(by_due);
        Self {
            kind,
            key: key.into(),
            day: String::new(),
            project_id: None,
            section_id: None,
            tasks,
        }
    }
}

fn open_of(open: &[Placed]) -> impl Iterator<Item = &Placed> {
    open.iter().filter(|task| task.is_open())
}

/// The groups `view` draws, from the open board's roots and the logbook's.
/// An empty group is never answered — a header over nothing is a claim the
/// list is not making.
#[must_use]
pub fn groups(
    view: &View,
    open: &[Placed],
    logbook: &[Placed],
    projects: &[ProjectRow],
    sections: &[SectionRow],
) -> Vec<Group> {
    let mut out = match view {
        View::Today => {
            let overdue = open_of(open).filter(|t| t.due.overdue).cloned().collect();
            let today = open_of(open)
                .filter(|t| t.due.lands_today && !t.due.overdue)
                .cloned()
                .collect();
            vec![
                Group::new(GroupKind::Overdue, "overdue", overdue),
                Group::new(GroupKind::Today, "today", today),
            ]
        }
        View::Upcoming => {
            let mut by_day: BTreeMap<String, Vec<Placed>> = BTreeMap::new();
            for task in open_of(open).filter(|t| t.due.days_from_today.is_some_and(|d| d > 0)) {
                by_day
                    .entry(task.due.due_day.clone())
                    .or_default()
                    .push(task.clone());
            }
            by_day
                .into_iter()
                .map(|(day, tasks)| Group {
                    day: day.clone(),
                    ..Group::new(GroupKind::Day, day, tasks)
                })
                .collect()
        }
        View::Inbox => vec![Group::new(
            GroupKind::Inbox,
            "inbox",
            open_of(open)
                .filter(|t| t.task.project_id.is_none())
                .cloned()
                .collect(),
        )],
        View::Anytime => {
            let mut by_project: BTreeMap<Option<String>, Vec<Placed>> = BTreeMap::new();
            for task in open_of(open).filter(|t| !t.dated()) {
                by_project
                    .entry(task.task.project_id.clone())
                    .or_default()
                    .push(task.clone());
            }
            let name_of = |id: &Option<String>| -> String {
                projects
                    .iter()
                    .find(|project| Some(&project.project_id) == id.as_ref())
                    .and_then(|project| project.name.clone())
                    .unwrap_or_default()
            };
            // Unfiled first, then projects by name (v0's order), then id.
            let mut entries: Vec<(Option<String>, Vec<Placed>)> = by_project.into_iter().collect();
            entries.sort_by(|(left, _), (right, _)| {
                left.is_some()
                    .cmp(&right.is_some())
                    .then_with(|| name_of(left).cmp(&name_of(right)))
                    .then_with(|| left.cmp(right))
            });
            entries
                .into_iter()
                .map(|(project_id, tasks)| match project_id {
                    None => Group::new(GroupKind::Inbox, "inbox", tasks),
                    Some(id) => Group {
                        project_id: Some(id.clone()),
                        ..Group::new(GroupKind::Project, id, tasks)
                    },
                })
                .collect()
        }
        View::All => vec![
            Group::new(
                GroupKind::Dated,
                "dated",
                open_of(open).filter(|t| t.dated()).cloned().collect(),
            ),
            Group::new(
                GroupKind::Undated,
                "undated",
                open_of(open).filter(|t| !t.dated()).cloned().collect(),
            ),
        ],
        View::Logbook => {
            let mut done: Vec<Placed> = logbook
                .iter()
                .filter(|t| t.task.status == "completed")
                .cloned()
                .collect();
            let mut released: Vec<Placed> = logbook
                .iter()
                .filter(|t| t.task.status == "cancelled")
                .cloned()
                .collect();
            done.sort_by(by_closed);
            released.sort_by(by_closed);
            let group = |kind, key: &str, tasks| Group {
                kind,
                key: key.to_owned(),
                day: String::new(),
                project_id: None,
                section_id: None,
                tasks,
            };
            vec![
                group(GroupKind::Done, "done", done),
                group(GroupKind::WontDo, "wont-do", released),
            ]
        }
        View::Reminders => vec![Group::new(
            GroupKind::Reminders,
            "reminders",
            open_of(open)
                .filter(|t| t.task.remind_before_min.is_some() && t.dated())
                .cloned()
                .collect(),
        )],
        View::Project(project_id) => {
            let mine: Vec<&Placed> = open_of(open)
                .filter(|t| t.task.project_id.as_deref() == Some(project_id.as_str()))
                .collect();
            let mut sections_here: Vec<&SectionRow> = sections
                .iter()
                .filter(|section| section.project_id.as_deref() == Some(project_id.as_str()))
                .collect();
            sections_here.sort_by(|left, right| {
                left.sort_order
                    .cmp(&right.sort_order)
                    .then_with(|| left.section_id.cmp(&right.section_id))
            });
            let known = |id: &str| sections_here.iter().any(|s| s.section_id == id);
            let mut out = vec![Group {
                project_id: Some(project_id.clone()),
                ..Group::new(
                    GroupKind::Unsectioned,
                    format!("{project_id}:unsectioned"),
                    mine.iter()
                        .filter(|t| t.task.section_id.as_deref().is_none_or(|id| !known(id)))
                        .map(|t| (*t).clone())
                        .collect(),
                )
            }];
            // EVERY SECTION IS ANSWERED, even an empty one: a project's
            // sections are its structure, and "add task here" needs the row.
            out.extend(sections_here.iter().map(|section| {
                Group {
                    project_id: Some(project_id.clone()),
                    section_id: Some(section.section_id.clone()),
                    ..Group::new(
                        GroupKind::Section,
                        section.section_id.clone(),
                        mine.iter()
                            .filter(|t| t.task.section_id.as_deref() == Some(&section.section_id))
                            .map(|t| (*t).clone())
                            .collect(),
                    )
                }
            }));
            return out
                .into_iter()
                .filter(|group| group.kind == GroupKind::Section || !group.tasks.is_empty())
                .collect();
        }
    };
    out.retain(|group| !group.tasks.is_empty());
    out
}

/// The numbers a band, a tile or a notice says, over the open ROOTS fetched.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Counts {
    pub overdue: usize,
    /// Due today, not overdue.
    pub today: usize,
    pub upcoming: usize,
    pub inbox: usize,
    pub anytime: usize,
    pub reminders: usize,
}

#[must_use]
pub fn counts(open: &[Placed]) -> Counts {
    let mut counts = Counts::default();
    for task in open_of(open) {
        if task.due.overdue {
            counts.overdue += 1;
        } else if task.due.lands_today {
            counts.today += 1;
        } else if task.dated() {
            counts.upcoming += 1;
        } else {
            counts.anytime += 1;
        }
        if task.task.project_id.is_none() {
            counts.inbox += 1;
        }
        if task.task.remind_before_min.is_some() && task.dated() {
            counts.reminders += 1;
        }
    }
    counts
}

/// Catch up's three piles, and the absence to name.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CatchUp {
    /// One-off work whose due day has passed.
    pub dated: Vec<Placed>,
    /// Repeating work that is behind: a missed period, or due before today.
    pub repeating: Vec<Placed>,
    /// Undated work that has sat [`SITTING_DAYS`] or more.
    pub sitting: Vec<Placed>,
    /// Civil days since the oldest overdue due day; zero is not away.
    pub away_days: i64,
    /// How many open roots are overdue.
    pub overdue: usize,
    /// `away_days` is [`ABSENCE_DAYS`] or more and something is overdue —
    /// v0's `absence`, the one moment the screen names the time away.
    pub absent: bool,
}

/// Catch up, from the open board's roots. A row belongs to exactly one pile,
/// so no bulk verb acts on the same task twice.
#[must_use]
pub fn catch_up(open: &[Placed]) -> CatchUp {
    let mut piles = CatchUp::default();
    for task in open_of(open) {
        if task.task.rrule.is_some() {
            if task.due.overdue || task.task.recurrence.missed.is_some_and(|missed| missed > 0) {
                piles.repeating.push(task.clone());
            }
        } else if task.due.overdue {
            piles.dated.push(task.clone());
        } else if !task.dated() && task.age_days.is_some_and(|age| age >= SITTING_DAYS) {
            piles.sitting.push(task.clone());
        }
    }
    for pile in [&mut piles.dated, &mut piles.repeating, &mut piles.sitting] {
        pile.sort_by(by_due);
    }
    let overdue: Vec<&Placed> = open_of(open).filter(|t| t.due.overdue).collect();
    piles.overdue = overdue.len();
    piles.away_days = overdue
        .iter()
        .filter_map(|t| t.due.days_from_today)
        .min()
        .map_or(0, |oldest| (-oldest).max(0));
    piles.absent = piles.away_days >= ABSENCE_DAYS && piles.overdue > 0;
    piles
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::queries::RecurrenceFacts;

    const NOW: &str = "2099-06-02T02:00:00.000Z";

    fn zone() -> FireZone {
        FireZone::named("America/New_York").expect("a zone")
    }

    fn task(id: &str, due: Option<&str>, project: Option<&str>) -> TaskRow {
        TaskRow {
            task_id: id.to_owned(),
            title: id.to_owned(),
            status: "needs-action".to_owned(),
            due_at: due.map(str::to_owned),
            project_id: project.map(str::to_owned),
            created_at: Some("2099-05-30T12:00:00.000Z".to_owned()),
            ..TaskRow::default()
        }
    }

    fn placed(rows: &[TaskRow]) -> Vec<Placed> {
        let today = local::today(&zone(), NOW).expect("now");
        rows.iter().map(|row| place(row, &zone(), &today)).collect()
    }

    fn keys(groups: &[Group]) -> Vec<(String, Vec<String>)> {
        groups
            .iter()
            .map(|g| {
                (
                    g.key.clone(),
                    g.tasks.iter().map(|t| t.task.task_id.clone()).collect(),
                )
            })
            .collect()
    }

    #[test]
    fn today_is_the_devices_day_with_overdue_first() {
        let open = placed(&[
            task("late", Some("2099-05-30"), None),
            // 01:00Z on the 2nd is 21:00 on the 1st in New York: today, not
            // tomorrow — the UTC prefix would say tomorrow.
            task("tonight", Some("2099-06-02T01:00:00.000Z"), None),
            task("tomorrow", Some("2099-06-02"), None),
            task("someday", None, Some("p")),
        ]);
        let today = groups(&View::Today, &open, &[], &[], &[]);
        assert_eq!(
            keys(&today),
            [
                ("overdue".to_owned(), vec!["late".to_owned()]),
                ("today".to_owned(), vec!["tonight".to_owned()]),
            ]
        );
        let upcoming = groups(&View::Upcoming, &open, &[], &[], &[]);
        assert_eq!(
            keys(&upcoming),
            [("2099-06-02".to_owned(), vec!["tomorrow".to_owned()])]
        );
        assert_eq!(upcoming[0].day, "2099-06-02");
        let counts = counts(&open);
        assert_eq!(
            (
                counts.overdue,
                counts.today,
                counts.upcoming,
                counts.anytime
            ),
            (1, 1, 1, 1)
        );
        assert_eq!(counts.inbox, 3);
    }

    #[test]
    fn inbox_anytime_and_all_split_the_open_work() {
        let open = placed(&[
            task("dated-unfiled", Some("2099-06-05"), None),
            task("undated-unfiled", None, None),
            task("undated-filed", None, Some("p1")),
        ]);
        let projects = [ProjectRow {
            project_id: "p1".to_owned(),
            name: Some("House".to_owned()),
            ..ProjectRow::default()
        }];
        assert_eq!(
            keys(&groups(&View::Inbox, &open, &[], &projects, &[])),
            [(
                "inbox".to_owned(),
                vec!["dated-unfiled".to_owned(), "undated-unfiled".to_owned()]
            )]
        );
        let anytime = groups(&View::Anytime, &open, &[], &projects, &[]);
        assert_eq!(
            keys(&anytime),
            [
                ("inbox".to_owned(), vec!["undated-unfiled".to_owned()]),
                ("p1".to_owned(), vec!["undated-filed".to_owned()]),
            ]
        );
        assert_eq!(anytime[1].project_id.as_deref(), Some("p1"));
        let all = groups(&View::All, &open, &[], &projects, &[]);
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].kind, GroupKind::Dated);
    }

    #[test]
    fn a_project_answers_every_section_even_an_empty_one() {
        let mut filed = task("filed", None, Some("p1"));
        filed.section_id = Some("s2".to_owned());
        let open = placed(&[
            filed,
            task("loose", None, Some("p1")),
            task("other", None, None),
        ]);
        let sections = [
            SectionRow {
                section_id: "s2".to_owned(),
                project_id: Some("p1".to_owned()),
                name: Some("Later".to_owned()),
                sort_order: Some(2),
            },
            SectionRow {
                section_id: "s1".to_owned(),
                project_id: Some("p1".to_owned()),
                name: Some("First".to_owned()),
                sort_order: Some(1),
            },
        ];
        let project = groups(&View::Project("p1".to_owned()), &open, &[], &[], &sections);
        assert_eq!(
            keys(&project),
            [
                ("p1:unsectioned".to_owned(), vec!["loose".to_owned()]),
                ("s1".to_owned(), vec![]),
                ("s2".to_owned(), vec!["filed".to_owned()]),
            ]
        );
    }

    #[test]
    fn the_logbook_is_two_outcomes_newest_first() {
        let closed = |id: &str, status: &str, at: Option<&str>| TaskRow {
            status: status.to_owned(),
            completed_at: at.map(str::to_owned),
            ..task(id, None, None)
        };
        let logbook = placed(&[
            closed("old", "completed", Some("2099-05-01T10:00:00.000Z")),
            closed("new", "completed", Some("2099-06-01T10:00:00.000Z")),
            closed("released", "cancelled", None),
        ]);
        assert_eq!(logbook[1].completed_day, "2099-06-01");
        assert_eq!(
            keys(&groups(&View::Logbook, &[], &logbook, &[], &[])),
            [
                ("done".to_owned(), vec!["new".to_owned(), "old".to_owned()]),
                ("wont-do".to_owned(), vec!["released".to_owned()]),
            ]
        );
    }

    #[test]
    fn catch_up_puts_each_row_in_one_pile_and_names_a_long_absence() {
        let mut behind = task("behind-daily", Some("2099-05-01"), None);
        behind.rrule = Some("FREQ=DAILY".to_owned());
        behind.recurrence = RecurrenceFacts {
            recurrence_summary: Some("Daily".to_owned()),
            missed: Some(3),
            next_due: Some("2099-06-01".to_owned()),
        };
        let mut current = task("current-weekly", Some("2099-06-05"), None);
        current.rrule = Some("FREQ=WEEKLY".to_owned());
        current.recurrence.missed = Some(0);
        let mut sitting = task("sitting", None, None);
        sitting.created_at = Some("2099-01-01T12:00:00.000Z".to_owned());
        let open = placed(&[
            behind,
            current,
            sitting,
            task("ten-days-late", Some("2099-05-22"), None),
            task("fresh", None, None),
        ]);
        let piles = catch_up(&open);
        let ids = |pile: &[Placed]| {
            pile.iter()
                .map(|t| t.task.task_id.clone())
                .collect::<Vec<_>>()
        };
        assert_eq!(ids(&piles.dated), ["ten-days-late"]);
        assert_eq!(
            ids(&piles.repeating),
            ["behind-daily"],
            "not the weekly that is current"
        );
        assert_eq!(ids(&piles.sitting), ["sitting"]);
        assert_eq!(piles.away_days, 10);
        assert!(piles.absent);
        // THE EFFECTIVE DUE IS THE NEXT PERIOD: the daily task reads as due
        // today, not a month overdue.
        assert!(open[0].due.lands_today && !open[0].due.overdue);
    }

    #[test]
    fn an_empty_board_answers_no_groups_and_no_absence() {
        for view in [
            View::Today,
            View::Upcoming,
            View::Inbox,
            View::All,
            View::Logbook,
        ] {
            assert!(groups(&view, &[], &[], &[], &[]).is_empty());
        }
        assert_eq!(catch_up(&[]), CatchUp::default());
    }
}
