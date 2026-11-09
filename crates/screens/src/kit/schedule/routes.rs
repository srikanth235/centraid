//! THE ROUTE TO A REMINDER, for the apps that show one: a Calendar day, a search hit, a widget row.
//! The id is Reminders' own (`reminders::TASK` is this constant), so a row opens the page Reminders
//! registered and the app that drew the row names none of Reminders' modules.

use centraid_api_proto::core_v1 as wire;

/// The screen id Reminders registers for one task.
pub const TASK: &str = "reminders.task";

/// One task. A task with no id names nothing, so callers do not push it.
#[must_use]
pub fn task(task_id: &str) -> wire::Route {
    wire::Route {
        sheet: false,
        screen: TASK.to_owned(),
        args: Some(wire::route::Args::TodoDetail(wire::TodoDetailRoute {
            task_id: task_id.to_owned(),
        })),
    }
}
