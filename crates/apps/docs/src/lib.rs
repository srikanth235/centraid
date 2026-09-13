//! # Docs — a manifest, four queries, one share fold, sixteen actions
//!
//! 13,183 lines of v0 TypeScript, 4 queries, 16 actions, 34 scopes over five
//! schemas (#1020, wave 4 census §A3). Its doctrine, from the manifest's own
//! description (`manifest.json`, copied verbatim from v0's `app.json`):
//!
//! - **IDENTITY IS THE WRAPPER, NOT THE BYTES.** A document is a
//!   `core.document` wrapper around a sha256-deduped canonical content item
//!   (#352): identity is separate from bytes, so two documents may legitimately
//!   share identical bytes. Dedup is on the bytes, never on document identity —
//!   **a port that keys a drive row by content id merges two members' unrelated
//!   files** (D-1020-DC1).
//! - **FOLDERS ARE SKOS CONCEPTS** in the owner's folders scheme, and filing is
//!   a single tag per document. Documents arrive newest-filed-first *via their
//!   folders-scheme tags*, and every decoration is `IN`-bounded by the same
//!   window.
//! - **STARRING IS A FLAGS-SCHEME TAG ON THE WRAPPER ITSELF**, so Starred here
//!   is the set of starred DOCUMENTS and nothing else — a photo starred in
//!   Photos carries its tag on the `media.asset` and never appears in this list.
//! - **TRASH KEEPS THE FOLDER TAG AND THE STAR**, so a restored document lands
//!   right back where it was.
//! - **A SHARE IS A STANDING ANSWER, NOT A ROSTER**, resolved over the document
//!   *or over any folder above it* ([`shares`], D-1020-DC2).
//! - **A DOCUMENT'S ARRIVAL IS ITS OWN PLANE** ([`origins`]): a delivered copy
//!   carries no folders-scheme tag, so the drive's tag window cannot see it and
//!   the subscription lineage is the second door in.
//! - **BYTES RIDE THE DOOR, NEVER THE PAYLOAD** ([`bytes`], D-1020-DC4).
//! - **NO DATA OF ITS OWN** — revoke the grant and the app goes dark.
//!
//! ## What this crate is allowed to contain, and what stops the rest
//!
//! | Not allowed | What stops it |
//! |---|---|
//! | SQL, in any form | `cargo xtask rules`' `sql-confinement` scans this crate; SQL lives only under `crates/{ontology,vault,seat,search}` and `crates/apps/kit`. A statement here is a [`centraid_apps_kit::PageQuery`] — a projection, a `from`, a predicate and an order, as data |
//! | The bytes themselves | the byte plane is `crates/media`'s and the door is the seat's; [`bytes`] holds the REQUEST shapes and the never-inline rule, and no buffer |
//! | A write from a query | [`queries`] holds statements and a [`centraid_apps_kit::PageDoor`], whose one method reads |
//! | An invocation with no `invoke_key` | the field is required on [`commands::Invocation`] (D-1020-D3-5) |
//! | A denial turned into an error | [`commands::Outcome::Denied`] and [`Denial`] are states a surface renders |
//! | A failed read folded into a `0` or a `[]` | every three-state answer here is a [`Reading`], and `shared_with: null` ≠ `shared_with: []` (census §A seam 5) |
//!
//! ## The manifest
//!
//! `manifest.json` is v0's `app.json`, byte for byte, and [`manifest`] parses
//! it with the kit's parser at load time rather than restating it in Rust. Two
//! copies of "which tables does Docs write" is how the two answers drift.

pub mod bytes;
pub mod commands;
pub mod manifest;
pub mod origins;
pub mod queries;
pub mod shares;

pub use bytes::{ByteDoor, ByteRequest, NEVER_INLINE, StagedBlob, may_serve_inline};
pub use commands::{ACTIONS, Commands, Invocation, Outcome};
pub use manifest::{APP_ID, manifest};
pub use origins::SharedFromEntry;
pub use queries::{
    ActivityData, DriveData, DriveInput, HistoryData, MAX_CHAIN_STEPS, SearchData, load_activity,
    load_drive, load_history, load_search,
};
pub use shares::{SHARE_FAN_OUT, SHARE_WINDOWS, SharedMember, SharedWithEntry};

/// A CONSENT DENIAL, as the payload carries it.
///
/// Every v0 Docs query wraps its body and answers `{…empty, vaultDenied:
/// {code, message}}` rather than throwing (`queries/drive.ts:276`-`:284`, and
/// the same in all four). `revoked_at` comes from the HOST, because a revoked
/// app cannot read the consent tables to date its own revocation
/// (`packages/server/src/engine/handlers/vault-bridge.ts:29`-`:36`) — so it is
/// an `Option` this crate never fills in.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Denial {
    pub code: Option<String>,
    pub message: Option<String>,
    pub revoked_at: Option<String>,
}

/// THE THREE STATES OF A READ, once, for every surface in this app.
///
/// `Option<T>` collapses two of the three (census §A seam 5): "not asked yet"
/// and "asked and refused" both become `None`, and the failure mode is an empty
/// list where the honest answer is *unknown*. On Docs that failure has a name:
/// **`shared_with: null` is "we cannot see" and `shared_with: []` is "shared
/// with nobody"**, and the second is the one a member acts on
/// (`queries/drive.ts:246`: "`null` is 'reads denied'; `[]` is 'shared with
/// nobody'").
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
    /// print "shared with nobody" must decide what "unknown" prints as.
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

    /// `true` where the fact is KNOWN, whatever it turned out to be.
    ///
    /// The drive ships this as `shared_from_known`, because **absent is not
    /// empty**: a denied origin read is told, not drawn
    /// (`queries/drive.ts:271`).
    pub const fn known(&self) -> bool {
        matches!(self, Self::Data(_))
    }
}
