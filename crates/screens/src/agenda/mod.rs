//! THE SERVICES OF CALENDAR AND REMINDERS (#1135, split in round 10 of #1173): the two that read both
//! apps and so belong to neither, notifications ([`notify`]) and the widgets ([`glance`]). The screens
//! are each app's own, `crate::calendar` and `crate::reminders`; what the two share is the kit's
//! [`crate::kit::schedule`]. This module only composes the two apps' registries for the runtime and
//! the tests, and holds the services.
//!
//! | Screen | Route name | Machine |
//! |---|---|---|
//! | Calendar: Day, Week, Month, List, Year, Invites, with Search and Calendars | [`HOME`] | `calendar::home` |
//! | One occurrence of an event | [`EVENT`] | `calendar::event` |
//! | The add sheet and the event editor | [`EDITOR`] | `calendar::editor` |
//! | Reminders: the smart lists, My Lists, with Search and More | [`REMINDERS_HOME`] | `reminders::home` |
//! | Anytime, All, Logbook, Reminders | [`TODO_LIST`] | `reminders::list` |
//! | One project | [`PROJECT`] | `reminders::project` |
//! | One task | [`TASK`] | `reminders::detail` |
//! | The new-reminder sheet | [`REMINDERS_EDITOR`] | `reminders::editor` |
//! | Catch up | [`CATCH_UP`] | `reminders::catch_up` |
//! | The trash | [`TRASH`] | `reminders::trash` |
//! | Reminders and alerts, as notifications (a service, no view) | [`notify::NAME`] | [`notify`] |

use centraid_api_proto::core_v1 as wire;

use crate::Registry;

pub mod glance;
pub mod notify;

pub use crate::calendar::{EDITOR, EVENT, HOME};
pub use crate::reminders::{
    CATCH_UP, EDITOR as REMINDERS_EDITOR, HOME as REMINDERS_HOME, PROJECT, TASK, TODO_LIST, TRASH,
};

/// Every Calendar and Reminders screen, registered under its route name.
#[must_use]
pub fn registry() -> Registry {
    crate::calendar::registry()
        .merge(crate::reminders::registry())
        .with(notify::NAME, notify::build)
}

/// A runtime with the two apps' screens and one tab, `calendar`, rooted at Calendar's home.
/// The shell's real runtime composes [`registry`] with the other apps'; this is
/// what these apps' own tests drive.
#[must_use]
pub fn runtime() -> crate::Runtime {
    crate::Runtime::new(
        registry(),
        vec![(
            TAB.to_owned(),
            crate::calendar::routes::home(wire::AgendaDestination::Day),
        )],
    )
}

/// The tab Calendar's home is the root of.
pub const TAB: &str = "calendar";
/// The tab Reminders' home is the root of.
pub const REMINDERS_TAB: &str = "reminders";
