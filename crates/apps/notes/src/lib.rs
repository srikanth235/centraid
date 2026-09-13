#![forbid(unsafe_code)]
//! # Notes — six queries, fifteen actions, and the one app that reads seven domains
//!
//! 9,336 lines of v0 TypeScript, 6 queries, 15 actions, 33 scopes over five
//! schemas (#1020, wave 4 census §A4). Its doctrine, from the manifest's own
//! description (`manifest.json`, copied verbatim from v0's `app.json`):
//!
//! - **NOTHING IS STORED HERE.** A note is a `knowledge.note` wrapper over a
//!   canonical, sha256-deduped `core.content_item` body. Revoke the grant and
//!   the app goes dark while the notes and the receipts remain the owner's.
//! - **THE LIBRARY IS A BOUNDED RECENT WINDOW PLUS *EVERY* PINNED NOTE.** A pin
//!   survives the note ageing out of the window, so the pinned shelf is read
//!   beside the recent one and not out of it ([`queries::load_library`]).
//! - **THE JOURNAL ASYMMETRY IS THE CONTRACT, NOT AN OVERSIGHT** (D-1020-N3).
//!   People-journal entries are excluded from the library, the trash shelf, the
//!   derived tag chips, search and the powerbox — and **opening one by id still
//!   works** (`queries/library.ts:1`-`:7`, #834 R-journal). A port that
//!   unified the two would either leak journal entries onto the notes shelf or
//!   break the People screen that opens one. [`queries::load_note`] is the
//!   by-id door and it does no journal read at all; that is the asymmetry,
//!   spelled as code.
//! - **A LIST ROW CARRIES A PREVIEW, NEVER A BODY** (#404): six lines,
//!   200 characters, plus the checklist tally. The editor pulls the full text
//!   lazily through `note`, which is what keeps a 1 MiB body off the shelf.
//! - **HISTORY IS THE NOTE'S OWN REVISION OCCURRENCES**, walked from
//!   `current_revision_id` through `parent_revision_id` ([`version_chain`],
//!   #996 R20(a)). A cycle is a REFUSAL, not a truncated list (D-1020-N2).
//! - **THE POWERBOX IS SECRET-FREE BY CONSTRUCTION** ([`queries::load_link_targets`]):
//!   seven domains through `crates/search`, and Locker is not one of them.
//! - **A DENIAL IS A VALUE.** Every query wraps its body and answers the empty
//!   shape plus `vaultDenied` rather than throwing.
//!
//! ## What this crate is allowed to contain, and what stops the rest
//!
//! | Not allowed | What stops it |
//! |---|---|
//! | SQL, in any form — a `MATCH` least of all | `cargo xtask rules`' `sql-confinement` scans this crate; SQL lives only under `crates/{ontology,vault,seat,search}` and `crates/apps/kit`. A statement here is a [`centraid_apps_kit::statement::PageQuery`], and a search is a [`centraid_search::SearchRequest`] |
//! | A write from a query | [`queries`] holds statements and a [`centraid_apps_kit::reads::PageDoor`], whose one method reads |
//! | An invocation with no `invoke_key` | the field is required on [`commands::Invocation`] (D-1020-D3-5) |
//! | A denial turned into an error | [`commands::Outcome::Denied`] and [`Denial`] are states a surface renders |
//! | A failed read folded into a `0` or a `[]` | every three-state answer here is a [`Reading`] (census §A seam 5) |
//! | A body over the ceiling | `core.add_content_item`'s 1 MiB SB-text ceiling is the vault's; this crate never mints one |

pub mod cards;
pub mod commands;
pub mod derive;
pub mod journal;
pub mod manifest;
pub mod queries;
pub mod version_chain;

pub use cards::{CardDoor, CardStatus, NoCards, OwnerCards, Ref, RefCard};
pub use commands::{ACTIONS, Commands, Invocation, Outcome};
pub use derive::{
    CheckTally, PREVIEW_CHARS, PREVIEW_LINES, check_of, decode_note_body, preview_of,
};
pub use manifest::{APP_ID, manifest};
pub use queries::{
    HistoryData, JournalData, LibraryData, LinkTargetsData, NoteData, SHELF_ROWS, SearchData,
    WINDOW_DEFAULT, WINDOW_MAX, WINDOW_MIN, load_history, load_journal, load_library,
    load_link_targets, load_note, load_search,
};
pub use version_chain::{ChainWalk, MAX_CHAIN_STEPS, VersionChainError, note_version_chain};

/// A CONSENT DENIAL, as the payload carries it.
///
/// Every v0 Notes query wraps its body and answers `{…empty, vaultDenied:
/// {code, message}}` rather than throwing (`queries/library.ts:471`-`:479`, and
/// the same in all six). `revoked_at` comes from the HOST, because a revoked
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
/// list where the honest answer is *unknown*. On Notes that failure has a name:
/// **`tags: []` is "this note carries no tags" and an unknown tag read is not
/// the same claim** — the second is what a member would go looking for the
/// missing chips over.
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
    /// The data, when there is data. **Not** a default.
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
    pub const fn known(&self) -> bool {
        matches!(self, Self::Data(_))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reading_keeps_absent_and_empty_apart() {
        let denied: Reading<Vec<String>> = Reading::Denied(Denial::default());
        assert!(denied.data().is_none());
        assert!(denied.denied());
        assert!(!denied.known());
        let empty: Reading<Vec<String>> = Reading::Data(Vec::new());
        assert_eq!(empty.data().map(Vec::len), Some(0));
        assert!(empty.known());
        assert!(!empty.denied());
        let loading: Reading<Vec<String>> = Reading::Loading;
        assert!(!loading.known());
        assert!(!loading.denied());
    }
}
