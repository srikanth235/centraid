//! PEOPLE'S SCREENS (#1135): the roster and Touch under one band, one person's
//! sheet with its write sheets, the profile editor, the contacts import and the
//! kit's trash. Every decision a person sees is made here; SwiftUI and Compose
//! draw [`wire::ViewState`].
//!
//! | Screen | Route name | Machine |
//! |---|---|---|
//! | People · Touch, with Search and More | [`HOME`] | [`home`] |
//! | One person | [`PERSON`] | [`person`] |
//! | The profile, autosaving | [`EDITOR`] | [`editor`] |
//! | The trash | [`TRASH`] | [`trash`] |
//!
//! People and Touch are ONE screen with the destination a value, so a tap on the
//! band swaps what is drawn and never a stack entry: back never walks through
//! the lists a member happened to tap. A row that opens a page carries the
//! [`wire::Route`] to push (built by [`routes`]), so a shell never names a
//! screen.
//!
//! ## Reads and writes
//!
//! Every read is `people.people`, `people.dashboard`, `people.person`,
//! `people.search` or `people.trash`, and every write is a manifest action
//! (`crates/apps/people/manifest.json`): the same door chat and the training
//! harness use. The chip and the order are part of the core's REQUEST, so
//! changing one reads again and the counts stay the whole window's.
//!
//! ## One civil-time path
//!
//! "Last touch" and every date are the core's civil days in the member's zone
//! (`last_contacted_local_day`, `today`, `in_days`), turned into words by
//! [`fold`] over [`crate::kit::civil`] and nothing else. A 29 February birthday
//! is the 28th in a common year because the core's `in_days` says so and the day
//! shown is `today + in_days`, not the stored `MM-DD`.

use centraid_api_proto::core_v1 as wire;

use crate::Registry;
use crate::kit::read::Reading;

pub mod contacts;
pub mod editor;
pub mod fold;
pub mod home;
pub mod person;
pub mod trash;

pub const HOME: &str = "people.home";
pub const PERSON: &str = "people.person";
pub const EDITOR: &str = "people.editor";
pub const TRASH: &str = "people.trash";

/// The tab People's pages are pushed under.
pub const TAB: &str = "people";

/// Every People screen, registered under its route name.
#[must_use]
pub fn registry() -> Registry {
    Registry::default()
        .with(HOME, home::build)
        .with(PERSON, person::build)
        .with(EDITOR, editor::build)
        .with(TRASH, trash::build)
}

/// A runtime with People's screens and one tab, `people`, rooted at its home. The
/// shell's real runtime composes [`registry`] with the other apps'; this is what
/// People's own tests drive.
#[must_use]
pub fn runtime() -> crate::Runtime {
    crate::Runtime::new(
        registry(),
        vec![(
            TAB.to_owned(),
            routes::home(wire::PeopleDestination::People),
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

/// The gate drawn when the vault will not let People read: the core's own words
/// ride as the receipt.
#[must_use]
pub(crate) fn denied(
    locale: crate::strings::Locale,
    denial: &wire::AppQueryDenial,
) -> wire::Denied {
    use crate::strings::people as words;
    wire::Denied {
        title: words::denied_title(locale),
        body: words::denied_body(locale),
        receipt: denial
            .message
            .clone()
            .or_else(|| denial.code.clone())
            .unwrap_or_default(),
    }
}

/// The routes People's own screens hand to a shell inside a view state.
pub mod routes {
    use super::{EDITOR, HOME, PERSON, TRASH, wire};

    fn route(screen: &str, args: wire::route::Args) -> wire::Route {
        wire::Route {
            screen: screen.to_owned(),
            args: Some(args),
        }
    }

    /// People's home on `destination`.
    #[must_use]
    pub fn home(destination: wire::PeopleDestination) -> wire::Route {
        route(
            HOME,
            wire::route::Args::PeopleHome(wire::PeopleHomeRoute {
                destination: destination as i32,
            }),
        )
    }

    /// One person; `name` rides along for the app bar, and `log_touch` opens the
    /// Log a touch sheet at once. A person with no id names nothing, so callers
    /// do not push it.
    #[must_use]
    pub fn person(party_id: &str, name: &str, log_touch: bool) -> wire::Route {
        route(
            PERSON,
            wire::route::Args::PeoplePerson(wire::PeoplePersonRoute {
                party_id: party_id.to_owned(),
                name: name.to_owned(),
                log_touch,
            }),
        )
    }

    /// The editor on an existing person.
    #[must_use]
    pub fn editor(party_id: &str) -> wire::Route {
        route(
            EDITOR,
            wire::route::Args::PeopleEditor(wire::PeopleEditorRoute {
                party_id: party_id.to_owned(),
                is_new: false,
            }),
        )
    }

    /// An empty draft; its first save adds the person.
    #[must_use]
    pub fn new_person() -> wire::Route {
        route(
            EDITOR,
            wire::route::Args::PeopleEditor(wire::PeopleEditorRoute {
                party_id: String::new(),
                is_new: true,
            }),
        )
    }

    #[must_use]
    pub fn trash() -> wire::Route {
        route(TRASH, wire::route::Args::Trash(wire::TrashRoute {}))
    }
}
