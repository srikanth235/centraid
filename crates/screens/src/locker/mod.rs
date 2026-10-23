//! LOCKER'S SCREENS (#1135): items, review, the generator, one item, the
//! editor, the access history, import and export, the trash and the wall. Every
//! decision a person sees is made here; SwiftUI and Compose draw
//! [`wire::ViewState`].
//!
//! | Screen | Route name | Machine |
//! |---|---|---|
//! | Items · Review · Generate, with Search and More | [`HOME`] | [`home`] |
//! | One item | [`ITEM`] | [`item`] |
//! | Add or edit an item | [`EDITOR`] | [`editor`] |
//! | The whole Locker's access history | [`ACCESS`] | [`access`] |
//! | Every secret, in a file | [`EXPORT`] | [`transfer`] |
//! | A password-manager file, reviewed and sealed in | [`IMPORT`] | [`transfer`] |
//! | The trash | [`TRASH`] | [`trash`] |
//! | The wall as a page (chat opens it) | [`LOCK`] | [`lock`] |
//!
//! **The list is metadata; the secret is not.** A sealed value reaches a view
//! only as a reveal the core receipted, lives in the screen's
//! [`crate::kit::secret::Secrets`] for the core's reveal window and is gone on
//! conceal, on the timer, on a relock and on leave. The wall ([`wall`]) is every
//! screen's own piece over the one session the core holds.
//!
//! A row that opens a page carries the [`wire::Route`] to push (built by
//! [`routes`]), so a shell never names a screen.

use centraid_api_proto::core_v1 as wire;

use crate::Registry;

pub mod access;
pub mod editor;
pub mod generator;
mod handoff;
pub mod home;
pub mod item;
pub mod lock;
mod shared;
pub mod transfer;
pub mod trash;
pub mod types;
pub mod wall;

pub const HOME: &str = "locker.home";
pub const ITEM: &str = "locker.item";
pub const EDITOR: &str = "locker.editor";
pub const ACCESS: &str = "locker.access";
pub const EXPORT: &str = "locker.export";
pub const IMPORT: &str = "locker.import";
pub const TRASH: &str = "locker.trash";
pub const LOCK: &str = "locker.lock";

/// The tab Locker's home is the root of.
pub const TAB: &str = "locker";

/// Every Locker screen, registered under its route name.
#[must_use]
pub fn registry() -> Registry {
    Registry::default()
        .with(HOME, home::build)
        .with(ITEM, item::build)
        .with(EDITOR, editor::build)
        .with(ACCESS, access::build)
        .with(EXPORT, transfer::build_export)
        .with(IMPORT, transfer::build_import)
        .with(TRASH, trash::build)
        .with(LOCK, lock::build)
}

/// A runtime with Locker's screens and one tab, `locker`, rooted at its home.
/// What Locker's own tests drive.
#[must_use]
pub fn runtime() -> crate::Runtime {
    crate::Runtime::new(
        registry(),
        vec![(
            TAB.to_owned(),
            routes::home(wire::LockerDestination::Items),
        )],
    )
}

/// The routes Locker's own screens hand to a shell inside a view state.
pub mod routes {
    use super::{ACCESS, EDITOR, EXPORT, HOME, IMPORT, ITEM, LOCK, TRASH, wire};

    fn route(screen: &str, args: wire::route::Args) -> wire::Route {
        wire::Route {
            screen: screen.to_owned(),
            args: Some(args),
        }
    }

    /// Locker's home, landing on `destination`.
    #[must_use]
    pub fn home(destination: wire::LockerDestination) -> wire::Route {
        route(
            HOME,
            wire::route::Args::LockerHome(wire::LockerHomeRoute {
                destination: destination as i32,
            }),
        )
    }

    /// One item. `parent` is the pushing page's title; `follow` a chat card's
    /// member action (`reveal:password`).
    #[must_use]
    pub fn item(item_id: &str, parent: &str, follow: &str) -> wire::Route {
        route(
            ITEM,
            wire::route::Args::LockerItem(wire::LockerItemRoute {
                item_id: item_id.to_owned(),
                parent: parent.to_owned(),
                follow: follow.to_owned(),
            }),
        )
    }

    /// A new item of `item_type` (empty is a login).
    #[must_use]
    pub fn add(item_type: &str, from_generator: bool) -> wire::Route {
        route(
            EDITOR,
            wire::route::Args::LockerEditor(wire::LockerEditorRoute {
                mode: wire::LockerEditorMode::Add as i32,
                item_id: String::new(),
                r#type: item_type.to_owned(),
                from_generator,
            }),
        )
    }

    /// The editor of an existing item.
    #[must_use]
    pub fn edit(item_id: &str) -> wire::Route {
        route(
            EDITOR,
            wire::route::Args::LockerEditor(wire::LockerEditorRoute {
                mode: wire::LockerEditorMode::Edit as i32,
                item_id: item_id.to_owned(),
                r#type: String::new(),
                from_generator: false,
            }),
        )
    }

    #[must_use]
    pub fn access() -> wire::Route {
        route(
            ACCESS,
            wire::route::Args::LockerAccess(wire::LockerAccessRoute {}),
        )
    }

    #[must_use]
    pub fn export(parent: &str) -> wire::Route {
        route(
            EXPORT,
            wire::route::Args::LockerExport(wire::LockerExportRoute {
                parent: parent.to_owned(),
            }),
        )
    }

    #[must_use]
    pub fn import(parent: &str) -> wire::Route {
        route(
            IMPORT,
            wire::route::Args::LockerImport(wire::LockerImportRoute {
                parent: parent.to_owned(),
            }),
        )
    }

    #[must_use]
    pub fn trash() -> wire::Route {
        route(TRASH, wire::route::Args::Trash(wire::TrashRoute {}))
    }

    /// The wall as a page: a caller that needs the key (chat) pushes it.
    #[must_use]
    pub fn lock() -> wire::Route {
        route(
            LOCK,
            wire::route::Args::LockerLock(wire::LockerLockRoute {}),
        )
    }
}
