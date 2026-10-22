//! # Photos — a manifest, three queries, pure folds, nineteen actions
//!
//! Its doctrine, from the manifest's own description (`manifest.json`):
//!
//! - the library is a **projection**: the meaning — photographs, albums, captions,
//!   capture times — is owned in the vault (`entity`, `photo`, `container`, `edge`)
//!   and the bytes are the blob plane's, named by hash (#1135);
//! - **the same bytes are one photograph**: `photo.blob` is unique, so a re-upload
//!   adopts what is there and brings it back from the trash;
//! - **a star is an edge, not a column**: a heart and the archive are `tagged`
//!   edges to `flag:starred` and `flag:archived`, the flags Docs, Notes and Locker
//!   read, each anchored on its own subject;
//! - **an edit folds its original, a crop folds nothing** ([`queries`]'s module
//!   note): the library draws the newest live photograph of a burst;
//! - **duplicates are a projection of the perceptual hashes**, clustered at read by
//!   the one clustering `crates/media` owns ([`duplicates`], D-1020-P3); nothing is
//!   stored and no sweep has to run;
//! - **the Places facet stays inside Photos.** There is no `crates/apps/places`: a
//!   `place` entity joins in the library and search reads, and the phrase logic
//!   that keeps a location a *phrase* rather than a coordinate lives in [`places`]
//!   (D-1020-P5);
//! - **faces and memories are gone**: nothing produces a face region or a memory,
//!   so no surface draws one (R-FP-10, Q-1047-2).
//!
//! ## What this crate is allowed to contain, and what stops the rest
//!
//! | Not allowed | What stops it |
//! |---|---|
//! | SQL, in any form | `cargo xtask rules`' `sql-confinement` scans this crate; SQL lives only under `crates/{ontology,vault,search}` and `crates/apps/kit`. A statement here is a [`centraid_apps_kit::PageQuery`] — a projection, a `from`, a predicate and an order, as data |
//! | A model, a codec or a hash | recognition is the phone's and the byte plane is `crates/media`'s; the only dependencies here are the kit and `serde_json` |
//! | A write from a query | [`queries`] holds statements and a [`centraid_apps_kit::PageDoor`], whose one method reads |
//! | An invocation with no `invoke_key` | the field is required on [`commands::Invocation`] (D-1020-D3-5) |
//! | A denial turned into an error | [`commands::Outcome::Denied`] and [`Denial`] are states a surface renders |
//! | A failed read folded into a `0` | every three-state answer in this crate models the third state explicitly (#1020 apps seam 6, census §A seam 5) |
//!
//! ## The manifest
//!
//! `manifest.json` is the contract; [`manifest`] parses it with the kit's parser at
//! load time rather than restating it in Rust. Two copies of "which commands does
//! Photos send" is how the two answers drift, so the action table
//! ([`commands::ACTIONS`]) is compared with it by a test.

pub mod commands;
pub mod duplicates;
pub mod manifest;
pub mod places;
pub mod queries;

pub use commands::{ACTIONS, Commands, Invocation, Outcome};
pub use duplicates::{DuplicateCluster, Fingerprint, duplicate_clusters};
pub use manifest::{APP_ID, manifest};
pub use places::{PlacePhrase, PlacePhraseSource, PlaceRow, place_phrase};
pub use queries::{LibraryData, LibraryInput, SearchData, load_library, load_search_term};

/// A CONSENT DENIAL, as the payload carries it: the kit's one type, shared by
/// every app so the core settles all of them through one door.
pub use centraid_apps_kit::Denial;

/// THE THREE STATES OF A READ, once, for every surface in this app.
///
/// `Option<T>` collapses two of the three (census §A seam 5): "not asked yet"
/// and "asked and refused" both become `None`, and the failure mode is a `0`
/// where the honest answer is *unknown* — on a storage figure, a photograph
/// count or a person's face tally. The third state is modelled here instead.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reading<T> {
    /// The read has not happened yet. A surface renders a skeleton.
    Loading,
    /// The vault refused, or the door was not there. A surface renders the ask.
    Denied(Denial),
    /// The answer.
    Data(T),
}

impl<T> Reading<T> {
    /// The data, when there is data. **Not** a default: a caller that wants to
    /// print a number must decide what "unknown" prints as.
    pub const fn data(&self) -> Option<&T> {
        match self {
            Self::Data(value) => Some(value),
            Self::Loading | Self::Denied(_) => None,
        }
    }

    /// Whether this reading is a refusal a surface should offer to fix.
    pub const fn denied(&self) -> bool {
        matches!(self, Self::Denied(_))
    }
}
