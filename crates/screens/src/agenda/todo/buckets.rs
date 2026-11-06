//! THE REMINDERS HOME'S SMART LISTS AS GROUPS (#1173): Today split into
//! Overdue, an untimed head, Morning, Afternoon and Tonight; Scheduled by day;
//! Flagged as one group. Pure folds over a board's open tasks.
//!
//! The Today buckets cut on the clock time the core placed in the device's
//! zone (`due_time`, `HH:MM`): Morning is before 12:00, Afternoon is 12:00 to
//! 17:59, Tonight is 18:00 on. A date-only task (no time) is in no bucket of
//! the day: it is the head group, "Today". The cuts are the product's call
//! until the owner rules (an open question on #1173).

use centraid_api_proto::core_v1 as wire;

use super::rows::{self, Context};
use crate::kit::civil;
use crate::strings::{Locale, agenda_reminders as reminders, task as words};

/// Morning ends, and Afternoon begins, at this hour.
pub const AFTERNOON_FROM: &str = "12:00";
/// Afternoon ends, and Tonight begins, at this hour.
pub const TONIGHT_FROM: &str = "18:00";

/// Which part of the day a time falls in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Part {
    Morning,
    Afternoon,
    Tonight,
}

/// The part of the day for `HH:MM`. `HH:MM` compares as text, zero-padded.
#[must_use]
pub fn part_of(due_time: &str) -> Part {
    if due_time < AFTERNOON_FROM {
        Part::Morning
    } else if due_time < TONIGHT_FROM {
        Part::Afternoon
    } else {
        Part::Tonight
    }
}

/// The open roots of a board, in the board's order.
fn open_roots(board: &wire::AgendaTaskBoard) -> Vec<&wire::AgendaTask> {
    board
        .groups
        .iter()
        .flat_map(|group| &group.tasks)
        .filter(|task| rows::is_open(task))
        .collect()
}

fn group(
    locale: Locale,
    key: &str,
    title: String,
    tasks: &[&wire::AgendaTask],
    ctx: &Context,
) -> Option<wire::TodoRowGroup> {
    if tasks.is_empty() {
        return None;
    }
    let rows: Vec<wire::TodoRow> = tasks
        .iter()
        .map(|task| rows::row(locale, task, ctx, false))
        .collect();
    Some(wire::TodoRowGroup {
        key: key.to_owned(),
        title,
        meta: rows.len().to_string(),
        rows,
        ..wire::TodoRowGroup::default()
    })
}

/// How many open roots are due today or before: the Today card's count.
#[must_use]
pub fn today_count(board: &wire::AgendaTaskBoard) -> usize {
    open_roots(board)
        .iter()
        .filter(|task| task.lands_today)
        .count()
}

/// Today: Overdue first (its rows say how long ago), then the untimed head,
/// then Morning, Afternoon and Tonight. A group with nothing in it is not drawn.
#[must_use]
pub fn today(
    locale: Locale,
    board: &wire::AgendaTaskBoard,
    ctx: &Context,
) -> Vec<wire::TodoRowGroup> {
    let mut due: Vec<&wire::AgendaTask> = open_roots(board)
        .into_iter()
        .filter(|task| task.lands_today)
        .collect();
    due.sort_by(|a, b| (&a.due_time, a.sort_order).cmp(&(&b.due_time, b.sort_order)));
    let mut overdue = Vec::new();
    let mut untimed = Vec::new();
    let mut parts: [Vec<&wire::AgendaTask>; 3] = Default::default();
    for task in due {
        if task.overdue {
            overdue.push(task);
        } else if task.due_time.is_empty() {
            untimed.push(task);
        } else {
            parts[part_of(&task.due_time) as usize].push(task);
        }
    }
    // The head names the day, so a row says the time only.
    let mut day = ctx.clone();
    day.day_in_head = true;
    [
        group(
            locale,
            "overdue",
            words::group_overdue(locale),
            &overdue,
            ctx,
        ),
        group(locale, "today", words::group_today(locale), &untimed, &day),
        group(
            locale,
            "morning",
            reminders::morning(locale),
            &parts[Part::Morning as usize],
            &day,
        ),
        group(
            locale,
            "afternoon",
            reminders::afternoon(locale),
            &parts[Part::Afternoon as usize],
            &day,
        ),
        group(
            locale,
            "tonight",
            reminders::tonight(locale),
            &parts[Part::Tonight as usize],
            &day,
        ),
    ]
    .into_iter()
    .flatten()
    .collect()
}

/// Scheduled: every open root with a date, a group per day, soonest first.
#[must_use]
pub fn scheduled(
    locale: Locale,
    board: &wire::AgendaTaskBoard,
    ctx: &Context,
) -> Vec<wire::TodoRowGroup> {
    let mut dated: Vec<&wire::AgendaTask> = open_roots(board)
        .into_iter()
        .filter(|task| !task.due_day.is_empty())
        .collect();
    dated.sort_by(|a, b| {
        (&a.due_day, &a.due_time, a.sort_order).cmp(&(&b.due_day, &b.due_time, b.sort_order))
    });
    let mut out: Vec<wire::TodoRowGroup> = Vec::new();
    let mut at = 0;
    while at < dated.len() {
        let day = dated[at].due_day.as_str();
        let end = dated[at..]
            .iter()
            .position(|task| task.due_day != day)
            .map_or(dated.len(), |n| at + n);
        let overdue = dated[at].overdue;
        let mut ctx = ctx.clone();
        // An overdue day keeps its rows' own "n days ago"; a later day's head
        // names it, so its rows say the time.
        ctx.day_in_head = !overdue;
        let title = if overdue {
            words::group_overdue(locale)
        } else {
            civil::relative_day(locale, day, ctx.today)
        };
        out.extend(group(
            locale,
            &format!("day|{day}"),
            title,
            &dated[at..end],
            &ctx,
        ));
        at = end;
    }
    out
}

/// Flagged: the open roots that carry the Flag, in the board's order.
#[must_use]
pub fn flagged(
    locale: Locale,
    board: &wire::AgendaTaskBoard,
    ctx: &Context,
) -> Vec<wire::TodoRowGroup> {
    let flagged: Vec<&wire::AgendaTask> = open_roots(board)
        .into_iter()
        .filter(|task| task.flagged)
        .collect();
    group(
        locale,
        "flagged",
        reminders::smart_flagged(locale),
        &flagged,
        ctx,
    )
    .into_iter()
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(id: &str, due_day: &str, due_time: &str, overdue: bool) -> wire::AgendaTask {
        wire::AgendaTask {
            task_id: id.to_owned(),
            title: id.to_owned(),
            status: "open".to_owned(),
            due_day: due_day.to_owned(),
            due_time: due_time.to_owned(),
            overdue,
            lands_today: !due_day.is_empty() && due_day <= "2026-11-04",
            days_from_today: Some(if overdue { -1 } else { 0 }),
            ..wire::AgendaTask::default()
        }
    }

    fn board(tasks: Vec<wire::AgendaTask>) -> wire::AgendaTaskBoard {
        wire::AgendaTaskBoard {
            today: "2026-11-04".to_owned(),
            groups: vec![wire::AgendaTaskGroup {
                tasks,
                ..wire::AgendaTaskGroup::default()
            }],
            ..wire::AgendaTaskBoard::default()
        }
    }

    fn shape(groups: &[wire::TodoRowGroup]) -> Vec<(String, Vec<String>)> {
        groups
            .iter()
            .map(|g| {
                (
                    g.title.clone(),
                    g.rows.iter().map(|r| r.task_id.clone()).collect(),
                )
            })
            .collect()
    }

    #[test]
    fn the_cuts_are_noon_and_six() {
        assert_eq!(part_of("00:00"), Part::Morning);
        assert_eq!(part_of("11:59"), Part::Morning);
        assert_eq!(part_of("12:00"), Part::Afternoon);
        assert_eq!(part_of("17:59"), Part::Afternoon);
        assert_eq!(part_of("18:00"), Part::Tonight);
        assert_eq!(part_of("23:59"), Part::Tonight);
    }

    #[test]
    fn today_is_overdue_then_the_untimed_head_then_morning_afternoon_and_tonight() {
        let board = board(vec![
            task("water", "2026-11-04", "20:00", false),
            task("dentist", "2026-11-04", "14:00", false),
            task("lease", "2026-11-04", "11:00", false),
            task("bank", "2026-11-04", "09:30", false),
            task("cleaning", "2026-11-04", "15:00", false),
            task("bill", "2026-11-03", "", true),
            task("anytime", "2026-11-04", "", false),
            task("tomorrow", "2026-11-05", "08:00", false),
            task("undated", "", "", false),
        ]);
        let ctx = Context {
            today: &board.today,
            ..Context::default()
        };
        let groups = today(Locale::En, &board, &ctx);
        assert_eq!(
            shape(&groups),
            [
                ("Overdue".to_owned(), vec!["bill".to_owned()]),
                ("Today".to_owned(), vec!["anytime".to_owned()]),
                (
                    "Morning".to_owned(),
                    vec!["bank".to_owned(), "lease".to_owned()]
                ),
                (
                    "Afternoon".to_owned(),
                    vec!["dentist".to_owned(), "cleaning".to_owned()]
                ),
                ("Tonight".to_owned(), vec!["water".to_owned()]),
            ]
        );
        assert_eq!(today_count(&board), 7, "what is due today or before");
        // A morning row says its time only: the head names the day.
        assert_eq!(groups[2].rows[0].due_label, "09:30");
        assert_eq!(groups[0].rows[0].due_label, "Yesterday");
    }

    #[test]
    fn a_part_of_the_day_with_nothing_in_it_is_not_drawn() {
        let board = board(vec![task("late", "2026-11-04", "21:00", false)]);
        let ctx = Context {
            today: &board.today,
            ..Context::default()
        };
        let groups = today(Locale::En, &board, &ctx);
        assert_eq!(
            shape(&groups),
            [("Tonight".to_owned(), vec!["late".to_owned()])]
        );
    }

    #[test]
    fn scheduled_is_a_group_per_day_soonest_first_and_skips_the_undated() {
        let board = board(vec![
            task("later", "2026-11-09", "", false),
            task("tomorrow-pm", "2026-11-05", "15:00", false),
            task("tomorrow-am", "2026-11-05", "08:00", false),
            task("undated", "", "", false),
            task("late", "2026-11-02", "", true),
        ]);
        let ctx = Context {
            today: &board.today,
            ..Context::default()
        };
        let groups = scheduled(Locale::En, &board, &ctx);
        let days: Vec<&str> = groups.iter().map(|g| g.key.as_str()).collect();
        assert_eq!(days, ["day|2026-11-02", "day|2026-11-05", "day|2026-11-09"]);
        assert_eq!(groups[0].title, "Overdue");
        assert_eq!(
            groups[1]
                .rows
                .iter()
                .map(|r| r.task_id.as_str())
                .collect::<Vec<_>>(),
            ["tomorrow-am", "tomorrow-pm"]
        );
    }

    #[test]
    fn flagged_holds_only_the_open_roots_that_carry_the_flag() {
        let mut flagged_task = task("keep", "", "", false);
        flagged_task.flagged = true;
        let mut done = task("done", "", "", false);
        done.flagged = true;
        done.status = "done".to_owned();
        let board = board(vec![flagged_task, done, task("plain", "", "", false)]);
        let ctx = Context {
            today: &board.today,
            ..Context::default()
        };
        let groups = flagged(Locale::En, &board, &ctx);
        assert_eq!(
            shape(&groups),
            [("Flagged".to_owned(), vec!["keep".to_owned()])]
        );
        assert!(groups[0].rows[0].flagged);
        let none = super::flagged(
            Locale::En,
            &self::board(vec![task("plain", "", "", false)]),
            &ctx,
        );
        assert!(none.is_empty());
    }
}
