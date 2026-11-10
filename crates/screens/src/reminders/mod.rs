//! REMINDERS' SCREENS (#1135, split from Agenda in round 10 of #1173): the ids it registers. Reminders
//! owns tasks and lists: the smart lists and My Lists on its [`HOME`], a list ([`TODO_LIST`]), a project
//! ([`PROJECT`]), a task ([`TASK`]), Catch up ([`CATCH_UP`]) and the trash ([`TRASH`]).
//!
//! Everything of the app is here: its home, the lists, a project, a task, the new-reminder sheet,
//! Catch up and the trash. What it shares with Calendar (the rows of a reminder, the repeat rule and
//! its sheet, the attachments page, the style sheet) is the kit's `kit::schedule`; this module names
//! none of Calendar's.

use crate::Registry;
pub mod buckets;
pub mod catch_up;
pub mod detail;
pub mod earlier;
pub mod editor;
pub mod home;
pub mod list;
pub mod ops;
pub mod order;
pub mod project;
pub mod quick;
pub mod routes;
pub mod trash;
pub mod view;

/// Reminders' home.
pub const HOME: &str = "reminders.home";
/// The Anytime, All, Logbook, Reminders, smart-list and Inbox pages.
pub const TODO_LIST: &str = "reminders.list";
pub const PROJECT: &str = "reminders.project";
pub const TASK: &str = crate::kit::schedule::routes::TASK;
/// The new-reminder sheet.
pub const EDITOR: &str = "reminders.editor";
pub const CATCH_UP: &str = "reminders.catch_up";
pub const TRASH: &str = "reminders.trash";
/// The earlier versions of a task (#1185).
pub const EARLIER: &str = "reminders.earlier";

/// Reminders' screens, registered under their route names.
#[must_use]
pub fn registry() -> Registry {
    Registry::default()
        .with(HOME, home::build)
        .with(TODO_LIST, list::build)
        .with(PROJECT, project::build)
        .with(TASK, detail::build)
        .with(CATCH_UP, catch_up::build)
        .with(EDITOR, editor::build)
        .with(TRASH, trash::build)
        .with(EARLIER, earlier::build)
}
