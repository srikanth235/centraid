//! THE REMINDERS A DAY SHOWS (round 10, extended in round 12 of #1173): the dated reminders that fall
//! due on the days of a window, as Apple's Calendar shows them: open and ticked ones, every occurrence
//! of a repeating one, and, on today, the overdue ones above the day. This app reads a task's title,
//! due day, due time and state, nothing else, and writes none (`vault.task` is a read scope in the
//! manifest and no action here names a `task.*` command): ticking one is Reminders' own
//! `complete-task` or `reopen-task`, sent by the screen under Reminders' name.
//!
//! A stored due has two spellings, a civil date and an instant or wall clock, and is read in the
//! zone the device states, as Reminders reads it. A repeating reminder has one open row, the
//! occurrence the series is at, and the ones after it are the engine's answer
//! (`next_occurrence`, the very function `complete-task` opens the next with): they are drawn on
//! their days as projections, with no row of their own to tick. A series measured from its
//! completion has no later occurrence to name before it is done, so it shows its one.

use centraid_apps_kit::error::KitResult;
use centraid_apps_kit::page::PageRequest;
use centraid_apps_kit::reads::{PageDoor, Read};
use centraid_apps_kit::row::text_of;
use centraid_apps_kit::statement::{PageBindValue, PageOrder, PageQuery};
use centraid_apps_kit::{Denial, denial_of};
use centraid_vault::time::civil::parse_civil_ms;
use centraid_vault::time::recurrence::{NextOccurrenceInput, RecurrenceAnchor, next_occurrence};
use centraid_vault::time::zone::{FireZone, add_wall_days, parse_wall_iso, wall_iso};

/// The most reminders a window answers.
pub const DATED_MAX: usize = 400;
/// The most open series one window projects, and the most occurrences it names of any one.
const SERIES_MAX: usize = 200;
const OCCURRENCES_MAX: usize = 400;
/// The most overdue reminders one read names.
const OVERDUE_MAX: usize = 200;

/// One reminder on its day.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DatedReminder {
    pub task_id: String,
    pub title: String,
    /// `YYYY-MM-DD`, in the request zone.
    pub due_day: String,
    /// `HH:MM`, or empty for a date-only due.
    pub due_time: String,
    /// Ticked off.
    pub done: bool,
    /// Part of a repeating series.
    pub repeats: bool,
    /// A later occurrence the series' rule names: `task_id` is the series' open row, which is not
    /// this one, so there is nothing to tick here.
    pub projected: bool,
    /// Open and due on a day before `overdue_before`.
    pub overdue: bool,
}

fn text(word: &str) -> PageBindValue {
    PageBindValue::Text(word.to_owned())
}

/// `dated-reminders`: the dated reminders due on a local day in `[from, to]`, by day, time and id,
/// every occurrence of a repeating one among them, and, when `overdue_before` names a day, the open
/// ones due before it (oldest first, marked `overdue`). A door refusal is the payload's denial.
///
/// # Errors
///
/// A bounded-read error the door cannot express as a denial.
pub fn load_dated_reminders(
    door: &dyn PageDoor,
    from: &str,
    to: &str,
    overdue_before: &str,
    zone: &FireZone,
) -> KitResult<(Vec<DatedReminder>, Option<Denial>)> {
    match read(door, from, to, overdue_before, zone) {
        Ok(rows) => Ok((rows, None)),
        Err(centraid_apps_kit::KitError::Door(message)) => {
            Ok((Vec::new(), Some(denial_of(message))))
        }
        Err(other) => Err(other),
    }
}

/// A stored due as the day and time it falls on in `zone`.
fn placed(due: &str, zone: &FireZone) -> Option<(String, String)> {
    if due.len() == 10 {
        return Some((due.to_owned(), String::new()));
    }
    let millis = parse_civil_ms(due, zone)?;
    let wall = zone.zoned_parts(millis);
    Some((
        wall_iso(wall, false),
        format!("{:02}:{:02}", wall.hour, wall.minute),
    ))
}

struct Found {
    id: String,
    day: String,
    time: String,
    done: bool,
    repeats: bool,
    projected: bool,
    overdue: bool,
}

fn read(
    door: &dyn PageDoor,
    from: &str,
    to: &str,
    overdue_before: &str,
    zone: &FireZone,
) -> KitResult<Vec<DatedReminder>> {
    let (Some(low), Some(high)) = (parse_wall_iso(from), parse_wall_iso(to)) else {
        return Ok(Vec::new());
    };
    // A stored instant is at most a day from its local day: widen the index range by one each way.
    let bottom = wall_iso(add_wall_days(low, -1), false);
    let top = wall_iso(add_wall_days(high, 2), false);
    let mut found: Vec<Found> = Vec::new();

    // THE ROWS DUE IN THE WINDOW: open and ticked, one-off and a series' own occurrence.
    let page = door.page(
        &PageQuery::new(
            "calendar.dated.tasks",
            "id, due, status, rule",
            "task",
            PageOrder::asc("due", "id"),
        )
        .filter(
            "status IN ('open', 'done') AND due >= ? AND due < ?",
            vec![text(&bottom), text(&top)],
        ),
        &PageRequest {
            limit: DATED_MAX,
            after: None,
        },
    )?;
    for row in &page.rows {
        let (Some(id), Some(due)) = (text_of(row, "id"), text_of(row, "due")) else {
            continue;
        };
        let Some((day, time)) = placed(&due, zone) else {
            continue;
        };
        if day.as_str() >= from && day.as_str() <= to {
            found.push(Found {
                id,
                day,
                time,
                done: text_of(row, "status").as_deref() == Some("done"),
                repeats: text_of(row, "rule").is_some_and(|rule| !rule.is_empty()),
                projected: false,
                overdue: false,
            });
        }
    }

    // THE OCCURRENCES AFTER A SERIES' OPEN ONE: the engine's own next, again and again, to the end
    // of the window. The series' open row may be days behind the window (an overdue daily one).
    let series = door.page(
        &PageQuery::new(
            "calendar.dated.series",
            "id, due, rule, anchor, zone",
            "task",
            PageOrder::asc("due", "id"),
        )
        .filter(
            "status = ? AND rule IS NOT NULL AND due IS NOT NULL AND due < ?",
            vec![text("open"), text(&top)],
        ),
        &PageRequest {
            limit: SERIES_MAX,
            after: None,
        },
    )?;
    for row in &series.rows {
        let (Some(id), Some(due), Some(rule)) = (
            text_of(row, "id"),
            text_of(row, "due"),
            text_of(row, "rule"),
        ) else {
            continue;
        };
        if RecurrenceAnchor::from_stored(text_of(row, "anchor").as_deref())
            == RecurrenceAnchor::Completion
        {
            continue;
        }
        let own = text_of(row, "zone")
            .and_then(|name| FireZone::named(&name).ok())
            .unwrap_or_else(|| zone.clone());
        let mut current = due.clone();
        for _ in 0..OCCURRENCES_MAX {
            let Some(next) = next_occurrence(&NextOccurrenceInput {
                rrule: &rule,
                scheduled_start: &due,
                after: &current,
                zone: Some(&own),
                anchor: RecurrenceAnchor::Scheduled,
            }) else {
                break;
            };
            let Some((day, time)) = placed(&next, zone) else {
                break;
            };
            if day.as_str() > to {
                break;
            }
            if day.as_str() >= from {
                found.push(Found {
                    id: id.clone(),
                    day,
                    time,
                    done: false,
                    repeats: true,
                    projected: true,
                    overdue: false,
                });
            }
            current = next;
        }
    }

    // THE OVERDUE ONES, above the day they are asked on: open, due before `overdue_before`.
    if let Some(today) = parse_wall_iso(overdue_before) {
        let ceiling = wall_iso(add_wall_days(today, 2), false);
        let late = door.page(
            &PageQuery::new(
                "calendar.dated.overdue",
                "id, due, rule",
                "task",
                PageOrder::asc("due", "id"),
            )
            .filter(
                "status = ? AND due IS NOT NULL AND due < ?",
                vec![text("open"), text(&ceiling)],
            ),
            &PageRequest {
                limit: OVERDUE_MAX,
                after: None,
            },
        )?;
        for row in &late.rows {
            let (Some(id), Some(due)) = (text_of(row, "id"), text_of(row, "due")) else {
                continue;
            };
            let Some((day, time)) = placed(&due, zone) else {
                continue;
            };
            if day.as_str() < overdue_before {
                found.push(Found {
                    id,
                    day,
                    time,
                    done: false,
                    repeats: text_of(row, "rule").is_some_and(|rule| !rule.is_empty()),
                    projected: false,
                    overdue: true,
                });
            }
        }
    }

    found.sort_by(|a, b| {
        (a.overdue, &a.day, &a.time, &a.id, a.projected).cmp(&(
            b.overdue,
            &b.day,
            &b.time,
            &b.id,
            b.projected,
        ))
    });
    found.dedup_by(|a, b| {
        a.id == b.id && a.day == b.day && a.projected == b.projected && a.overdue == b.overdue
    });
    found.truncate(DATED_MAX + OVERDUE_MAX);
    let mut ids: Vec<String> = found.iter().map(|f| f.id.clone()).collect();
    ids.sort();
    ids.dedup();
    let titles = Read {
        name: "calendar.dated.titles",
        table: "entity",
        select: "id, title",
        order: ("id", "id"),
        column: "id",
    }
    .of(door, &ids, Some(("deleted_at IS NULL", Vec::new())))?;
    let mut out = Vec::new();
    for f in found {
        let Some(title) = titles
            .iter()
            .find(|row| text_of(row, "id").as_deref() == Some(f.id.as_str()))
            .and_then(|row| text_of(row, "title"))
        else {
            continue;
        };
        out.push(DatedReminder {
            task_id: f.id,
            title,
            due_day: f.day,
            due_time: f.time,
            done: f.done,
            repeats: f.repeats,
            projected: f.projected,
            overdue: f.overdue,
        });
    }
    Ok(out)
}
