//! # Docs — a manifest, four queries, the phone's shelves, eighteen actions
//!
//! Its doctrine, from the manifest's own description (`manifest.json`):
//!
//! - **IDENTITY IS THE WRAPPER, NOT THE BYTES.** A document is an `entity` of
//!   kind `document` over one blob: two documents may legitimately share
//!   identical bytes, and **a port that keys a drive row by the blob's hash
//!   merges two members' unrelated files** (D-1020-DC1). The blob plane stores
//!   the bytes once.
//! - **FOLDERS ARE CONTAINERS**, and filing is one column of the document
//!   (`folder_id`). A document attached to something and filed nowhere shows
//!   only where it is attached ([`queries`]).
//! - **STARRING IS A `tagged` EDGE TO `flag:starred`** on the document itself,
//!   so Starred here is the set of starred DOCUMENTS and nothing else — a photo
//!   starred in Photos carries its edge on the `photo` and never appears here.
//! - **TRASH KEEPS THE FOLDER AND THE STAR**, so a restored document lands right
//!   back where it was; a folder takes what is filed in it to the trash with it.
//! - **A VERSION IS THE BYTES A REPLACE PUT DOWN** (`revision`), numbered by its
//!   `seq`; restoring one keeps what it replaced.
//! - **"DELETE FOREVER" IS PHOTOS' PATH.** `purge` and `empty-trash` are
//!   `entity.purge` and `entity.empty_trash`, the way a photograph is destroyed
//!   (ruling D-1 of 2026-09-25).
//! - **THE PHONE ASKS FOR A SHELF, NOT A WINDOW** ([`phone`], [`kind`], #1046):
//!   the core cuts the shelf, applies the filters and the order, classifies each
//!   row and reads its dates in the device's zone.
//! - **BYTES RIDE THE DOOR, NEVER THE PAYLOAD** ([`bytes`], D-1020-DC4).
//! - **NO DATA OF ITS OWN** — revoke the grant and the app goes dark.
//!
//! ## What this crate is allowed to contain, and what stops the rest
//!
//! | Not allowed | What stops it |
//! |---|---|
//! | SQL, in any form | `cargo xtask rules`' `sql-confinement` scans this crate; SQL lives only under `crates/{ontology,vault,search}` and `crates/apps/kit`. A statement here is a [`centraid_apps_kit::PageQuery`] — a projection, a `from`, a predicate and an order, as data |
//! | The bytes themselves | the byte plane is `crates/media`'s and the door is the seat's; [`bytes`] holds the REQUEST shapes and the never-inline rule, and no buffer |
//! | A write from a query | [`queries`] holds statements and a [`centraid_apps_kit::PageDoor`], whose one method reads |
//! | An invocation with no `invoke_key` | the field is required on [`commands::Invocation`] (D-1020-D3-5) |
//! | A denial turned into an error | [`commands::Outcome::Denied`] and [`Denial`] are states a surface renders |
//! | A failed read folded into a `0` or a `[]` | every three-state answer here is a [`Reading`]; a document's absent body is `None`, never `""` (census §A seam 5) |
//!
//! ## The manifest
//!
//! `manifest.json` is the contract; [`manifest`] parses it with the kit's parser
//! at load time rather than restating it in Rust. Two copies of "which commands
//! does Docs send" is how the two answers drift, so the action table
//! ([`commands::ACTIONS`]) is compared with it by a test.

pub mod bytes;
pub mod commands;
pub mod kind;
pub mod manifest;
pub mod phone;
pub mod queries;

pub use bytes::{ByteDoor, ByteRequest, NEVER_INLINE, StagedBlob, may_serve_inline};
pub use commands::{ACTIONS, Commands, Invocation, Outcome};
pub use manifest::{APP_ID, manifest};
pub use queries::{
    ActivityData, DocumentData, DriveData, DriveInput, HistoryData, MAX_VERSIONS, SearchData,
    load_activity, load_document, load_drive, load_history, load_search_term,
};

/// A CONSENT DENIAL, as the payload carries it: the kit's one type, shared by
/// every app so the core settles all of them through one door.
pub use centraid_apps_kit::Denial;

/// THE THREE STATES OF A READ, once, for every surface in this app.
///
/// `Option<T>` collapses two of the three (census §A seam 5): "not asked yet"
/// and "asked and refused" both become `None`, and the failure mode is an empty
/// list where the honest answer is *unknown* — a drive that could not be read
/// drawn as a drive with nothing in it.
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
    /// print "no documents" must decide what "unknown" prints as.
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

    /// `true` where the fact is KNOWN, whatever it turned out to be — **absent
    /// is not empty**.
    pub const fn known(&self) -> bool {
        matches!(self, Self::Data(_))
    }
}
