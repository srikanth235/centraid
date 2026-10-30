//! DOCS' SCREENS (#1135): the drive, one document, its versions, its text
//! editor and its trash. Every decision a person sees is made here; SwiftUI and
//! Compose draw [`wire::ViewState`].
//!
//! | Screen | Route name | Machine |
//! |---|---|---|
//! | All · Folders · Starred · Recently added, a folder's page, Search | [`DRIVE`] | [`drive`] |
//! | One document | [`DOCUMENT`] | [`document`] |
//! | A document's version history | [`VERSIONS`] | [`versions`] |
//! | A text document's editor | [`EDITOR`] | [`editor`] |
//! | The trash | [`TRASH`] | [`trash`] |
//!
//! A row that opens a page carries the [`wire::Route`] to push (built by
//! [`routes`]), so a shell never names a screen.
//!
//! ## Reads and writes
//!
//! Every read is `docs.drive`, `docs.search` or `docs.history`
//! and every write is a manifest action (`crates/apps/docs/manifest.json`), the
//! same door chat and the training harness use. The shelf, the three filters
//! and the order are part of the core's REQUEST, so changing one reads again.
//!
//! ## Where this lives
//!
//! Not in `crates/apps/docs`: `centraid-core` depends on that crate for its
//! readers, and this crate depends on the core for `load` and `act`, so a
//! screen there would make a cycle. The folder walk ([`folders`]) is the one
//! piece of Docs logic that is pure, so it stays in the app crate
//! (`centraid_apps_docs::folder_path`) and is used from here.

use centraid_api_proto::core_v1 as wire;

use crate::Registry;
use crate::kit::read::Reading;
use crate::strings::{Locale, docs as words};

pub mod document;
pub mod drive;
pub mod editor;
pub mod fold;
pub mod folders;
pub mod rename;
pub mod trash;
pub mod versions;

pub const DRIVE: &str = "docs.drive";
pub const DOCUMENT: &str = "docs.document";
pub const VERSIONS: &str = "docs.versions";
pub const EDITOR: &str = "docs.editor";
pub const TRASH: &str = "docs.trash";

/// Every Docs screen, registered under its route name.
#[must_use]
pub fn registry() -> Registry {
    Registry::default()
        .with(DRIVE, drive::build)
        .with(DOCUMENT, document::build)
        .with(VERSIONS, versions::build)
        .with(EDITOR, editor::build)
        .with(TRASH, trash::build)
}

/// A runtime with Docs' screens and one tab, `docs`, rooted at the drive. The
/// shell's real runtime composes [`registry`] with the other apps'; this is what
/// Docs' own tests drive.
#[must_use]
pub fn runtime() -> crate::Runtime {
    crate::Runtime::new(
        registry(),
        vec![(
            TAB.to_owned(),
            routes::drive(wire::DocsDestination::All, "", "", ""),
        )],
    )
}

/// The tab Docs' drive is the root of.
pub const TAB: &str = "docs";

/// What a page holds of its reads: nothing yet, a refusal, a gate or the
/// answer. A failed read is never an empty list.
#[derive(Clone, Debug)]
pub(crate) enum Phase<T> {
    Loading,
    Failed,
    Denied(wire::AppQueryDenial),
    Ready(T),
}

impl<T> Phase<T> {
    pub(crate) fn of(reading: Reading<T>) -> Self {
        match reading {
            Reading::Data(data) => Self::Ready(data),
            Reading::Denied(denial) => Self::Denied(denial),
            Reading::Failed => Self::Failed,
        }
    }

    pub(crate) fn data(&self) -> Option<&T> {
        match self {
            Self::Ready(data) => Some(data),
            _ => None,
        }
    }
}

/// The gate drawn when the vault will not let Docs read.
pub(crate) fn denied(locale: Locale, denial: &wire::AppQueryDenial) -> wire::Denied {
    wire::Denied {
        title: words::denied_title(locale),
        body: words::denied_body(locale),
        receipt: denial.code.clone().unwrap_or_default(),
    }
}

/// A refused write's sentence, as the status line over the rows.
pub(crate) fn refusal(sentence: String) -> wire::StatusLine {
    wire::StatusLine {
        sentence,
        action_label: String::new(),
        refused: true,
    }
}

/// The routes Docs' own screens hand to a shell inside a view state.
pub mod routes {
    use super::{DOCUMENT, DRIVE, EDITOR, TRASH, VERSIONS, wire};

    fn route(screen: &str, args: wire::route::Args) -> wire::Route {
        wire::Route {
            screen: screen.to_owned(),
            args: Some(args),
        }
    }

    /// The drive, landing on `destination`. `folder_id` and `folder_name` name
    /// a folder's page (Folders only); `parent` is the pushing page's title.
    #[must_use]
    pub fn drive(
        destination: wire::DocsDestination,
        folder_id: &str,
        folder_name: &str,
        parent: &str,
    ) -> wire::Route {
        route(
            DRIVE,
            wire::route::Args::DocsDrive(wire::DocsDriveRoute {
                destination: destination as i32,
                folder_id: folder_id.to_owned(),
                folder_name: folder_name.to_owned(),
                parent: parent.to_owned(),
            }),
        )
    }

    /// A folder's page, pushed from the page titled `parent`.
    #[must_use]
    pub fn folder(folder_id: &str, name: &str, parent: &str) -> wire::Route {
        drive(wire::DocsDestination::Folders, folder_id, name, parent)
    }

    /// One document; `title` rides along so the head has words before the read.
    #[must_use]
    pub fn document(document_id: &str, title: &str, parent: &str) -> wire::Route {
        route(
            DOCUMENT,
            wire::route::Args::DocsDocument(wire::DocsDocumentRoute {
                document_id: document_id.to_owned(),
                title: title.to_owned(),
                parent: parent.to_owned(),
            }),
        )
    }

    /// A text document's editor.
    #[must_use]
    pub fn editor(document_id: &str, title: &str) -> wire::Route {
        route(
            EDITOR,
            wire::route::Args::DocsEditor(wire::DocsEditorRoute {
                document_id: document_id.to_owned(),
                title: title.to_owned(),
            }),
        )
    }

    /// A document's version history.
    #[must_use]
    pub fn versions(document_id: &str, title: &str) -> wire::Route {
        route(
            VERSIONS,
            wire::route::Args::DocsVersions(wire::DocsVersionsRoute {
                document_id: document_id.to_owned(),
                title: title.to_owned(),
            }),
        )
    }

    #[must_use]
    pub fn trash() -> wire::Route {
        route(TRASH, wire::route::Args::Trash(wire::TrashRoute {}))
    }
}
