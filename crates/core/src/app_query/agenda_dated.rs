//! `calendar.dated-reminders` (rounds 10 and 12 of #1173): the dated reminders that fall due on the
//! days of a window, open and ticked, every occurrence of a repeating one, and the overdue ones when
//! asked, so Calendar can draw them on their day, tick them with Reminders' own action and open each
//! in Reminders. The read is `crates/apps/calendar`'s `load_dated_reminders`: a title, a due day, a
//! due time and their state and nothing else, and Calendar's manifest declares `vault.task` as a read scope and no task command.

use centraid_api_proto::core_v1 as wire;
use centraid_apps_kit::civil;
use centraid_vault::Vault;

use super::{Answer, VaultDoor, settle, zone_of};
use crate::error::Result;

pub(crate) fn dated(
    vault: &Vault,
    door: &VaultDoor<'_>,
    now: &str,
    asked: &wire::CalendarDatedRemindersRequest,
) -> Result<Answer> {
    let zone = zone_of(vault, &asked.tz)?;
    let today = civil::today(&zone, now).unwrap_or_default();
    door.tables
        .borrow_mut()
        .extend(["entity", "task"].map(str::to_owned));
    settle(
        door,
        centraid_apps_calendar::load_dated_reminders(
            door,
            &asked.from,
            &asked.to,
            &asked.overdue_before,
            &zone,
        ),
        |rows| {
            Answer::CalendarDatedReminders(wire::CalendarDatedReminders {
                today,
                reminders: rows
                    .into_iter()
                    .map(|row| wire::CalendarDatedReminder {
                        task_id: row.task_id,
                        title: row.title,
                        due_day: row.due_day,
                        due_time: row.due_time,
                        done: row.done,
                        repeats: row.repeats,
                        projected: row.projected,
                        overdue: row.overdue,
                    })
                    .collect(),
            })
        },
    )
}
