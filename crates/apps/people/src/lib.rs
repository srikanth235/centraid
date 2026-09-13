//! # People — a manifest, seven queries, twenty-nine actions
//!
//! 7,849 lines of v0 TypeScript, 7 queries, **29 actions — the largest action
//! surface of any bundled app** — and 24 scopes over seven schemas, against
//! **six** test files (#1020, wave 4 census §A5). Its doctrine, from the
//! manifest's own description (`manifest.json`, copied verbatim from v0's
//! `app.json`):
//!
//! - **NO DATA OF ITS OWN.** People is a personal CRM *projected* from the
//!   canonical vault: `people_profile` keeps only the genuine 1:1 decoration
//!   (role, nickname, cadence, last-contacted, how-you-met, colour) and
//!   everything else is somebody else's canonical row — interactions are
//!   `core.activity`, tasks and gift ideas are `schedule.task`, relationships
//!   are typed `core.link`s, IOUs are `tally.obligation`s, journal entries are
//!   `knowledge.note`s, notes are `knowledge.annotation`s, lists and the
//!   favourite star are SKOS concepts and tags. Revoke the grant and the app
//!   goes dark.
//! - **THE PERSON IS THE PARTY, NOT THE PROFILE.** `people_profile` is a 1:1
//!   enrichment of a `core.party`; trashing a person trashes the profile and
//!   **the canonical party survives** (`actions/trash-person.ts:3`).
//! - **THREE READS DENY INDEPENDENTLY OF THE PROFILE** ([`ReadState`],
//!   D-1020-PE1): the share plane, the linked-entity plane and Tally's
//!   obligations each sit behind a scope over a *different schema*, and a
//!   denial on one leaves the person on the screen. v0 catches one of the
//!   three and blanks the sheet for the other two; see [`person`].
//! - **MERGE IS THE ONTOLOGY PRIMITIVE, NEVER A LOCAL SOFT MERGE.**
//!   `merge-people` invokes `core.merge_party`: every foreign key re-points,
//!   the polymorphic pointers follow, the merged party is **deleted**, and a
//!   non-owner caller is parked (`actions/merge-people.ts:3`-`:7`,
//!   `crates/vault/src/commands/core.rs`).
//! - **`people.*` IS GRANTED AS A WHOLE SCHEMA.** Four `act` scopes for
//!   twenty-nine actions, because `{schema: "people", verbs: "read+act"}` is
//!   the widest form and only agenda and People use it. **A port that expands
//!   it into twenty-four explicit scopes changes the grant's meaning**
//!   (census §A5) — and would also break three actions outright, because the
//!   three narrow `social.*` act scopes name commands the `people` schema owns
//!   ([`commands`], finding PE-F1).
//!
//! ## What this crate is allowed to contain, and what stops the rest
//!
//! | Not allowed | What stops it |
//! |---|---|
//! | SQL, in any form | `cargo xtask rules`' `sql-confinement` scans this crate; SQL lives only under `crates/{ontology,vault,seat,search}` and `crates/apps/kit`. A statement here is a [`centraid_apps_kit::PageQuery`] — a projection, a `from`, a predicate and an order, as data |
//! | A write from a query | [`queries`] holds statements and a [`centraid_apps_kit::PageDoor`], whose one method reads |
//! | An invocation with no `invoke_key` | the field is required on [`commands::Invocation`] (D-1020-D3-5) |
//! | A denial turned into an error | [`commands::Outcome::Denied`] and [`Denial`] are states a surface renders |
//! | A failed read folded into a `0` or a `[]` | every three-state answer here is a [`ReadState`], and a denied share plane has **no `linked` field at all** rather than a `null` one |
//! | A civil date read off the host clock | [`dates`] takes the vault's zone offset as an argument; there is no `now()` in this crate |
//!
//! ## The manifest
//!
//! `manifest.json` is v0's `app.json`, byte for byte, and [`manifest`] parses
//! it with the kit's parser at load time rather than restating it in Rust. Two
//! copies of "which tables does People write" is how the two answers drift.

pub mod commands;
pub mod dashboard;
pub mod dates;
pub mod journal;
pub mod manifest;
pub mod person;
pub mod queries;
pub mod roster;

pub use commands::{ACTIONS, Commands, Invocation, Outcome};
pub use dates::{DAYS_UNSET, days_until_month_day};
pub use manifest::{APP_ID, manifest};

/// A CONSENT DENIAL, as the payload carries it.
///
/// Every v0 People query wraps its body and answers `{…empty, vaultDenied:
/// {code, message}}` rather than throwing (`queries/people.ts:222`-`:230`, and
/// the same in all seven). `revoked_at` comes from the HOST, because a revoked
/// app cannot read the consent tables to date its own revocation
/// (`packages/server/src/engine/handlers/vault-bridge.ts:29`-`:36`) — so it is
/// an `Option` this crate never fills in.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Denial {
    pub code: Option<String>,
    pub message: Option<String>,
    pub revoked_at: Option<String>,
}

impl Denial {
    /// The denial a door failure lowers to. The kit's error text is the
    /// `message`; `code` stays absent because the kit does not mint one and an
    /// invented code is a code a surface would switch on.
    #[must_use]
    pub fn from_door(error: &centraid_apps_kit::KitError) -> Self {
        Self {
            code: None,
            message: Some(error.to_string()),
            revoked_at: None,
        }
    }
}

/// THE THREE STATES OF A READ (D-1020-PE1).
///
/// `Option<T>` collapses two of the three (census §A seam 5): "not asked yet"
/// and "asked and refused" both become `None`, and the failure mode is an
/// empty list — or a `0` — where the honest answer is *unknown*. On People
/// that failure has a name and v0 ships it: a roster row carries
/// `linked: null` when the share plane is denied **and `vault_count: 0`
/// beside it** (`queries/people.ts:212`-`:213`), so the honest three-state
/// answer and a plain "linked to no vault" are one row apart.
///
/// Here the fact lives INSIDE the state. A [`Self::Denied`] sharing read has
/// no `linked` and no `vault_count` to read at all, which is what "never a
/// chip drawn on a null" means when the type says it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadState<T> {
    /// The read has not happened yet. A surface renders a skeleton.
    Loading,
    /// The vault refused, or the door was not there. A surface renders the ask.
    Denied(Denial),
    /// The answer.
    Ready(T),
}

/// A reading with no read behind it yet is [`ReadState::Loading`].
///
/// Stated rather than derived, because the alternative default a `Ready` of a
/// `T::default()` would be a made-up answer: an empty list nobody read is the
/// exact failure the type exists to prevent.
impl<T> Default for ReadState<T> {
    fn default() -> Self {
        Self::Loading
    }
}

impl<T> ReadState<T> {
    /// The data, when there is data. **Not** a default: a caller that wants to
    /// print "linked to nobody" must decide what "unknown" prints as.
    pub const fn ready(&self) -> Option<&T> {
        match self {
            Self::Ready(value) => Some(value),
            Self::Loading | Self::Denied(_) => None,
        }
    }

    /// Whether this reading is a refusal a surface should offer to fix.
    pub const fn denied(&self) -> bool {
        matches!(self, Self::Denied(_))
    }

    /// `true` where the fact is KNOWN, whatever it turned out to be.
    ///
    /// The roster ships this as `links_available`, because **absent is not
    /// empty**: a denied share read is told, not drawn (`people.ts:15`-`:19`).
    pub const fn known(&self) -> bool {
        matches!(self, Self::Ready(_))
    }

    /// The denial, when there is one.
    pub const fn denial(&self) -> Option<&Denial> {
        match self {
            Self::Denied(denial) => Some(denial),
            Self::Loading | Self::Ready(_) => None,
        }
    }

    /// Lower a door result onto the three states. The only constructor that
    /// takes a `Result`, so "an error became a denial" happens in one place.
    pub fn of(result: centraid_apps_kit::KitResult<T>) -> Self {
        match result {
            Ok(value) => Self::Ready(value),
            Err(error) => Self::Denied(Denial::from_door(&error)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A DENIED READ IS NOT AN EMPTY ONE, and the type is what says so.
    #[test]
    fn a_denial_carries_no_data_and_an_empty_answer_is_not_a_denial() {
        let denied: ReadState<Vec<String>> = ReadState::Denied(Denial::default());
        assert!(denied.ready().is_none());
        assert!(denied.denied());
        assert!(!denied.known());

        let empty: ReadState<Vec<String>> = ReadState::Ready(Vec::new());
        assert_eq!(empty.ready().map(Vec::len), Some(0));
        assert!(!empty.denied());
        assert!(empty.known(), "shared with nobody is a KNOWN fact");

        let loading: ReadState<Vec<String>> = ReadState::Loading;
        assert!(!loading.denied(), "not asked yet is not a refusal");
        assert!(!loading.known());
        assert!(loading.denial().is_none());
    }

    #[test]
    fn a_door_failure_becomes_a_denial_with_the_doors_own_sentence() {
        let state: ReadState<u8> = ReadState::of(Err(centraid_apps_kit::KitError::EmptyInList {
            column: "party_id".to_owned(),
        }));
        assert!(state.denied());
        assert!(
            state
                .denial()
                .and_then(|denial| denial.message.as_deref())
                .is_some_and(|message| message.contains("party_id"))
        );
        // NEVER INVENTED. A revoked app cannot date its own revocation.
        assert_eq!(
            state.denial().and_then(|denial| denial.revoked_at.clone()),
            None
        );
    }
}
