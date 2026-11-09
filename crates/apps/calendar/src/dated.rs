//! THE REMINDERS A DAY SHOWS (round 10): the open, one-off reminders that fall due in a window of
//! days, read-only. Apple's Calendar shows them on their day and opens them in Reminders; this app
//! reads a task's title, due day, due time and state, nothing else, and writes none
//! (`vault.task` is a read scope in the manifest and no action here names a `task.*` command).
//!
//! A stored due has two spellings, a civil date and an instant or wall clock, and is read in the
//! zone the device states, as Reminders reads it. A repeating reminder is Reminders' alone: the
//! next period of a rule is that app's engine's answer, so a day here shows the one-off ones.

use centraid_apps_kit::error::KitResult;
use centraid_apps_kit::page::PageRequest;
use centraid_apps_kit::reads::{PageDoor, Read};
use centraid_apps_kit::row::text_of;
use centraid_apps_kit::statement::{PageBindValue, PageOrder, PageQuery};
use centraid_apps_kit::{Denial, denial_of};
use centraid_vault::time::civil::parse_civil_ms;
use centraid_vault::time::zone::{FireZone, add_wall_days, parse_wall_iso, wall_iso};

/// The most reminders a window answers.
pub const DATED_MAX: usize = 400;

/// One reminder on its day.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DatedReminder {
    pub task_id: String,
    pub title: String,
    /// `YYYY-MM-DD`, in the request zone.
    pub due_day: String,
    /// `HH:MM`, or empty for a date-only due.
    pub due_time: String,
}

fn text(word: &str) -> PageBindValue {
    PageBindValue::Text(word.to_owned())
}

/// `dated-reminders`: the open one-off reminders due on a local day in `[from, to]`, by day, time
/// and id. A door refusal is the payload's denial.
///
/// # Errors
///
/// A bounded-read error the door cannot express as a denial.
pub fn load_dated_reminders(
    door: &dyn PageDoor,
    from: &str,
    to: &str,
    zone: &FireZone,
) -> KitResult<(Vec<DatedReminder>, Option<Denial>)> {
    match read(door, from, to, zone) {
        Ok(rows) => Ok((rows, None)),
        Err(centraid_apps_kit::KitError::Door(message)) => {
            Ok((Vec::new(), Some(denial_of(message))))
        }
        Err(other) => Err(other),
    }
}

fn read(
    door: &dyn PageDoor,
    from: &str,
    to: &str,
    zone: &FireZone,
) -> KitResult<Vec<DatedReminder>> {
    let (Some(low), Some(high)) = (parse_wall_iso(from), parse_wall_iso(to)) else {
        return Ok(Vec::new());
    };
    // A stored instant is at most a day from its local day: widen the index range by one each way.
    let bottom = wall_iso(add_wall_days(low, -1), false);
    let top = wall_iso(add_wall_days(high, 2), false);
    let page = door.page(
        &PageQuery::new(
            "calendar.dated.tasks",
            "id, due",
            "task",
            PageOrder::asc("due", "id"),
        )
        .filter(
            "status = ? AND rule IS NULL AND due >= ? AND due < ?",
            vec![text("open"), text(&bottom), text(&top)],
        ),
        &PageRequest {
            limit: DATED_MAX,
            after: None,
        },
    )?;
    let mut placed: Vec<(String, String, String)> = Vec::new();
    for row in &page.rows {
        let (Some(id), Some(due)) = (text_of(row, "id"), text_of(row, "due")) else {
            continue;
        };
        let (day, time) = if due.len() == 10 {
            (due.clone(), String::new())
        } else if let Some(millis) = parse_civil_ms(&due, zone) {
            let wall = zone.zoned_parts(millis);
            (
                wall_iso(wall, false),
                format!("{:02}:{:02}", wall.hour, wall.minute),
            )
        } else {
            continue;
        };
        if day.as_str() >= from && day.as_str() <= to {
            placed.push((id, day, time));
        }
    }
    placed.sort_by(|a, b| (&a.1, &a.2, &a.0).cmp(&(&b.1, &b.2, &b.0)));
    let ids: Vec<String> = placed.iter().map(|(id, _, _)| id.clone()).collect();
    let titles = Read {
        name: "calendar.dated.titles",
        table: "entity",
        select: "id, title",
        order: ("id", "id"),
        column: "id",
    }
    .of(door, &ids, Some(("deleted_at IS NULL", Vec::new())))?;
    let mut out = Vec::new();
    for (id, day, time) in placed {
        let Some(title) = titles
            .iter()
            .find(|row| text_of(row, "id").as_deref() == Some(id.as_str()))
            .and_then(|row| text_of(row, "title"))
        else {
            continue;
        };
        out.push(DatedReminder {
            task_id: id,
            title,
            due_day: day,
            due_time: time,
        });
    }
    Ok(out)
}
