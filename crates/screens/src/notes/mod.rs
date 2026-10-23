//! NOTES' SCREENS (#1135): the library, notebooks and journal under one band, the
//! editor with its link powerbox, a note's version history and the kit's trash.
//! Every decision a person sees is made here; SwiftUI and Compose draw
//! [`wire::ViewState`].
//!
//! | Screen | Route name | Machine |
//! |---|---|---|
//! | Notes · Notebooks · Journal, with Search and More | [`HOME`] | [`home`] |
//! | One note, autosaving, with the powerbox | [`EDITOR`] | [`editor`] |
//! | One note's versions | [`HISTORY`] | [`history`] |
//! | The trash | [`TRASH`] | [`trash`] |
//!
//! The band's three places are ONE screen with the place a value, so a tap on
//! the band swaps what is drawn and never a stack entry: back never walks
//! through the places a member happened to tap. A row that opens a page
//! carries the [`wire::Route`] to push (built by [`routes`]), so a shell never
//! names a screen.

use centraid_api_proto::core_v1 as wire;

use crate::Registry;
use crate::kit::read::Reading;

pub mod editor;
pub mod fold;
pub mod history;
pub mod home;
pub mod trash;

pub const HOME: &str = "notes.home";
pub const EDITOR: &str = "notes.editor";
pub const HISTORY: &str = "notes.history";
pub const TRASH: &str = "notes.trash";

/// The tab Notes' pages are pushed under.
pub const TAB: &str = "notes";

/// Every Notes screen, registered under its route name.
#[must_use]
pub fn registry() -> Registry {
    Registry::default()
        .with(HOME, home::build)
        .with(EDITOR, editor::build)
        .with(HISTORY, history::build)
        .with(TRASH, trash::build)
}

/// A runtime with Notes' screens and one tab, `notes`, rooted at its home. The
/// shell's real runtime composes [`registry`] with the other apps'; this is
/// what Notes' own tests drive.
#[must_use]
pub fn runtime() -> crate::Runtime {
    crate::Runtime::new(
        registry(),
        vec![(
            TAB.to_owned(),
            routes::home(wire::NotesPlace::Notes, "", "", false),
        )],
    )
}

/// What a read came to while a screen waits on it: nothing yet, a refusal, a
/// gate or the answer. A failed read is never an empty list.
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

/// The gate drawn when the vault will not let Notes read: the core's own code
/// rides as the receipt.
#[must_use]
pub(crate) fn denied(
    locale: crate::strings::Locale,
    denial: &wire::AppQueryDenial,
) -> wire::Denied {
    use crate::strings::notes as words;
    wire::Denied {
        title: words::denied_title(locale),
        body: words::denied_body(locale),
        receipt: denial.code.clone().unwrap_or_default(),
    }
}

/// The routes Notes' own screens hand to a shell inside a view state.
pub mod routes {
    use super::{EDITOR, HISTORY, HOME, TRASH, wire};

    fn route(screen: &str, args: wire::route::Args) -> wire::Route {
        wire::Route {
            screen: screen.to_owned(),
            args: Some(args),
        }
    }

    /// Notes' home on `place`; a notebook id (or `unfiled_only`) filters the
    /// Notes place, and `notebook_name` rides along for the heading.
    #[must_use]
    pub fn home(
        place: wire::NotesPlace,
        notebook_id: &str,
        notebook_name: &str,
        unfiled_only: bool,
    ) -> wire::Route {
        route(
            HOME,
            wire::route::Args::NotesHome(wire::NotesHomeRoute {
                place: place as i32,
                notebook_id: notebook_id.to_owned(),
                notebook_name: notebook_name.to_owned(),
                unfiled_only,
            }),
        )
    }

    /// One note. A note with no id names nothing, so callers do not push it.
    #[must_use]
    pub fn editor(note_id: &str) -> wire::Route {
        route(
            EDITOR,
            wire::route::Args::NotesEditor(wire::NotesEditorRoute {
                note_id: note_id.to_owned(),
                is_new: false,
            }),
        )
    }

    /// An empty draft; its first save creates the note.
    #[must_use]
    pub fn new_note() -> wire::Route {
        route(
            EDITOR,
            wire::route::Args::NotesEditor(wire::NotesEditorRoute {
                note_id: String::new(),
                is_new: true,
            }),
        )
    }

    /// One note's versions; `note_title` rides along for the back control.
    #[must_use]
    pub fn history(note_id: &str, note_title: &str) -> wire::Route {
        route(
            HISTORY,
            wire::route::Args::NotesHistory(wire::NotesHistoryRoute {
                note_id: note_id.to_owned(),
                note_title: note_title.to_owned(),
            }),
        )
    }

    #[must_use]
    pub fn trash() -> wire::Route {
        route(TRASH, wire::route::Args::Trash(wire::TrashRoute {}))
    }
}
