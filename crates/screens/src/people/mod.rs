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

pub mod fold;

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
