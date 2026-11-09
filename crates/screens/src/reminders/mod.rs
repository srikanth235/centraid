//! REMINDERS' SCREENS (#1135, split from Agenda in round 10 of #1173): the ids it registers. Reminders
//! owns tasks and lists: the smart lists and My Lists on its [`HOME`], a list ([`TODO_LIST`]), a project
//! ([`PROJECT`]), a task ([`TASK`]), Catch up ([`CATCH_UP`]) and the trash ([`TRASH`]).
//!
//! The machines behind them are in `crate::agenda`, the module the two apps share because the home,
//! the attachments page, the style sheet, the repeat words and the notification and widget services
//! are built once for both. This module names none of Calendar's.

use crate::Registry;
use crate::agenda::{catch_up, detail, home, list, project, trash};

/// Reminders' home.
pub const HOME: &str = "reminders.home";
/// The Anytime, All, Logbook, Reminders, smart-list and Inbox pages.
pub const TODO_LIST: &str = "reminders.list";
pub const PROJECT: &str = "reminders.project";
pub const TASK: &str = "reminders.task";
pub const CATCH_UP: &str = "reminders.catch_up";
pub const TRASH: &str = "reminders.trash";

/// Reminders' screens, registered under their route names.
#[must_use]
pub fn registry() -> Registry {
    Registry::default()
        .with(HOME, home::build_reminders)
        .with(TODO_LIST, list::build)
        .with(PROJECT, project::build)
        .with(TASK, detail::build)
        .with(CATCH_UP, catch_up::build)
        .with(TRASH, trash::build)
}
