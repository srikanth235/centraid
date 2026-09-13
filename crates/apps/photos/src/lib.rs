//! # Photos — a manifest, eight statement sets, five pure folds, 18 actions
//!
//! Photos is the largest app in the product: 21,348 lines of v0 TypeScript, 8
//! queries, 18 actions, 38 scopes over five schemas and a 551-line demo seed
//! (#1020, wave 4 census §A2). Its doctrine, from the manifest's own
//! description (`manifest.json`, copied verbatim from v0's `app.json`):
//!
//! - the library is a **projection**: the meaning — assets, albums, captions,
//!   capture times — is owned in the vault and the bytes are rented behind each
//!   content item's `content_uri`;
//! - **a star is a tag, not a column.** `media_asset.favorite` is gone
//!   (#916, ONT-03); the star is the `starred` concept in the flags scheme that
//!   Docs, Locker and People read, each anchored on its own subject, so a
//!   photo's star is one row in one place;
//! - **the storage answer is the gateway's sweep**, never something the app can
//!   compute: local-CAS presence is a filesystem fact. Until the sweep has run
//!   the answer is *not counted yet* — never zeroes ([`storage`], D-1020-P1);
//! - **confidence is a match count, never a percentage**, and "first seen" is
//!   the earliest `captured_at` among matches because `media_face_region` has
//!   no `created_at` — no proposal time is invented ([`faces`], D-1020-P2);
//! - **duplicates are read, never computed here.** The union-find over phash
//!   Hamming distance ≤ 6 lives in `crates/media::duplicates`; this app reads
//!   the `cluster_id` a sweep already stamped ([`duplicates`], D-1020-P3);
//! - **enrichment status is a read-only mirror** of `enrich.policy`, and
//!   `request-enrichment` writes a **priority hint**, never a gate
//!   ([`enrichment`], D-1020-P4);
//! - **the Places facet stays inside Photos.** There is no `crates/apps/places`:
//!   `core_place` joins in the library and search reads, and the phrase logic
//!   that keeps a location a *phrase* rather than a coordinate lives in
//!   [`places`] (D-1020-P5).
//!
//! ## What this crate is allowed to contain, and what stops the rest
//!
//! | Not allowed | What stops it |
//! |---|---|
//! | SQL, in any form | `cargo xtask rules`' `sql-confinement` scans this crate; SQL lives only under `crates/{ontology,vault,seat,search}` and `crates/apps/kit`. A statement here is a [`centraid_apps_kit::PageQuery`] — a projection, a `from`, a predicate and an order, as data |
//! | A model, a codec or a hash | recognition is the automations lane's and the byte plane is `crates/media`'s; the only dependencies here are the kit and `serde` |
//! | A write from a query | [`queries`] holds statements and a [`centraid_apps_kit::PageDoor`], whose one method reads |
//! | An invocation with no `invoke_key` | the field is required on [`commands::Invocation`] (D-1020-D3-5) |
//! | A denial turned into an error | [`commands::Outcome::Denied`] and [`Denial`] are states a surface renders |
//! | A failed read folded into a `0` | every three-state answer in this crate models the third state explicitly (#1020 apps seam 6, census §A seam 5) |
//!
//! ## The manifest
//!
//! `manifest.json` is v0's `app.json`, byte for byte, and [`manifest`] parses
//! it with the kit's parser at load time rather than restating it in Rust. Two
//! copies of "which tables does Photos write" is how the two answers drift.

pub mod commands;
pub mod duplicates;
pub mod enrichment;
pub mod faces;
pub mod manifest;
pub mod places;
pub mod queries;
pub mod representations;
pub mod storage;

pub use commands::{ACTIONS, Commands, Invocation, Outcome};
pub use duplicates::{DuplicateCluster, duplicate_clusters};
pub use enrichment::{EnrichmentStatus, Tier};
pub use faces::{
    FaceQueue, FaceQueueEntry, PeopleRoster, QUEUE_LIMIT, face_queue, group_people_faces,
};
pub use manifest::{APP_ID, manifest};
pub use places::{PlacePhrase, PlacePhraseSource, PlaceRow, place_phrase};
pub use queries::{LibraryData, LibraryInput, load_library};
pub use storage::{StorageSummary, storage_summary};

/// A CONSENT DENIAL, as the payload carries it.
///
/// Every v0 Photos query wraps its body and answers `{…empty, vaultDenied:
/// {code, message}}` rather than throwing (`queries/library.ts:284-292` and the
/// same in all eight). `revoked_at` comes from the HOST, because a revoked app
/// cannot read the consent tables to date its own revocation
/// (`packages/server/src/engine/handlers/vault-bridge.ts:29-36`) — so it is an
/// `Option` that is never filled in by this crate.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Denial {
    pub code: Option<String>,
    pub message: Option<String>,
    pub revoked_at: Option<String>,
}

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
