//! # Locker — the app whose custody changes in this wave
//!
//! 15,908 lines of v0 TypeScript, 8 queries, 16 actions, **37 scopes including
//! the only three `reveal` verbs in the product** (#1020, wave 4 census §A8,
//! §F). Everything else in this crate follows from one sentence, which is the
//! trust premise's Locker half: *the gateway is trusted for data and blind for
//! secrets* (#1020 `:33`, open question 8).
//!
//! ## What that makes true of this crate
//!
//! - **Listing is not unlocking.** [`queries::items`] is authorised by the app
//!   grant alone. It takes no authentication, reaches for no online verb, and
//!   runs on a seat's own rows — which is the whole reason Locker is usable on
//!   a phone in airplane mode. Watchtower and the counts are *decorations*
//!   asked for as optional, so a seat that cannot reach them answers
//!   **undecorated** rather than refusing the list ([`Decorated::watchtower`]
//!   is absent, never `false`).
//! - **A sealed cell never rides a payload.** No statement in this crate names
//!   `password`, `otp_seed`, `card_number`, `cvv`, `content`, `value_sealed` or
//!   `private_key` for a **list**; [`queries::ITEM_COLUMNS`] is the browsable
//!   half, stated once, and the detail pane's own projection carries the sealed
//!   cells as the ciphertext they are at rest — a placeholder, never a value
//!   ([`sidecars`]).
//! - **The plaintext is the seat's, and it is not in this crate at all.** An
//!   app crate gets *one row's plaintext per receipt* through `crates/core`'s
//!   reveal (W6-D2, `docs/decisions.md:909`); it never holds the member key
//!   `K`. `crates/seat::locker` is where the unwrap runs.
//! - **`access` is ONLINE-ONLY by construction, with two walls.**
//!   `access.receipt` lives in the audit band and not the replica, so the run
//!   is marked online-only and the gateway serves it. The declared `rowFilter`
//!   on `object_type` is the outer wall and [`queries::access`]'s own
//!   predicate is the inner one, so the page is filtered **before** the window
//!   rather than after — without it a busy vault's newest 200 receipts could be
//!   entirely someone else's and the clamp would hand the screen an empty
//!   history (census §A8).
//! - **`online_only` is exactly v0's five** (`ONLINE_ONLY_ACTIONS`,
//!   `packages/blueprints/apps/locker/writes.ts:33`-`:39`):
//!   `add-item, edit-item, set-field, set-passkey, export`. Never a wider set —
//!   `trash/restore/purge/star/archive/duplicate/remove-field/set-addresses/clear-passkey`
//!   are all durable in the outbox, and `export` keeps the entry with a new
//!   meaning (D-1020-L7).
//! - **Watchtower and TOTP are seat-side derivations** (D-1020-L6). A gateway
//!   that cannot unseal cannot compute either, so [`watchtower`] and [`totp`]
//!   fold over values the *seat* revealed inside its window, and the two
//!   manifest `act` scopes say so.
//!
//! ## What this crate is allowed to contain, and what stops the rest
//!
//! | Not allowed | What stops it |
//! |---|---|
//! | SQL, in any form | `cargo xtask rules`' `sql-confinement`; a statement here is a [`centraid_apps_kit::PageQuery`] — a projection, a `from`, a predicate and an order, as data |
//! | The member key `K`, in any form | nothing in this crate's dependency set can open a `lk1:` cell: `centraid-vault` is not a dependency, and the reveal arrives as a [`Revealed`] value with a life |
//! | A write from a query | [`queries`] holds statements and a [`centraid_apps_kit::PageDoor`], whose one method reads |
//! | An invocation with no `invoke_key` | the field is required on [`commands::Invocation`] (D-1020-D3-5) |
//! | A denial turned into an error | [`commands::Outcome::Denied`] and [`Denial`] are states a surface renders |
//! | A failed decoration folded into "all clear" | [`Decorated::watchtower`] is an `Option`, and the fold that builds a summary refuses to build one from `None` |
//!
//! ## The manifest, and the two fields deleted from it
//!
//! `manifest.json` is v0's `app.json` with **exactly two deletions**, both
//! recorded as D-1020-L7 and both dead-or-wrong rather than ported:
//!
//! 1. `auth_session` on the `items` query. A permit-era parameter on a live
//!    query: the permit, the `authenticate` op and the permit screens were
//!    deleted by #996 R13 (`docs/decisions.md:92`, `:879`) and v0's own
//!    `items.ts` handler never reads it. A schema-first port turns a dead field
//!    into a required one.
//! 2. `disabledOn: ["viewer"]`. #996 R13 enables Locker on **every** seat
//!    including the PWA, and the exclusion is two rulings old.
//!
//! Everything else — all eight queries, all sixteen actions, all thirty-seven
//! scopes, the knob, `byteBearing`, `originActs` — is byte-for-byte v0's, and
//! [`manifest::tests`] asserts the diff is those two and nothing else.

pub mod commands;
pub mod manifest;
pub mod origin;
pub mod queries;
pub mod sidecars;
pub mod totp;
pub mod types;
pub mod watchtower;

pub use commands::{ACTIONS, Commands, Invocation, Outcome};
pub use manifest::{APP_ID, manifest};
pub use origin::{MatchPolicy, matches_origin, page_origin};
pub use queries::{Decorated, ITEM_COLUMNS, ItemRow};
pub use types::{ITEM_TYPES, degrade_type, is_known_type};
pub use watchtower::{WatchEntry, Watchtower};

/// A CONSENT DENIAL, as the payload carries it.
///
/// Every v0 Locker query wraps its body and answers `{…empty, vaultDenied:
/// {code, message}}` rather than throwing. `revoked_at` comes from the HOST,
/// because a revoked app cannot read the consent tables to date its own
/// revocation (`packages/server/src/engine/handlers/vault-bridge.ts:29`-`:36`)
/// — so it is an `Option` this crate never fills in.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Denial {
    pub code: Option<String>,
    pub message: Option<String>,
    pub revoked_at: Option<String>,
}

/// THE THREE STATES OF A READ, once, for every surface in this app.
///
/// `Option<T>` collapses two of the three (census §A seam 5): "not asked yet"
/// and "asked and refused" both become `None`, and the failure mode on a
/// security screen is an **all-clear that was never checked**. The third state
/// is modelled here instead.
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
}

/// A READ THIS SEAT COULD NOT ANSWER LOCALLY IS NOT A REFUSAL TO ANSWER.
///
/// `rethrowIfLocalReadRefused` in v0 (`queries/items.ts`), as a type. The
/// replica raises `ONLINE_ONLY` when its shape does not carry what the query
/// asked for; a [`Denial`] built from that would draw an **empty locker over
/// rows the vault holds**, and the caller would never fall back online. A
/// consent denial is the opposite case and stays a screen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadRefusal {
    /// Not answerable here. The caller must go to the gateway; it must NOT be
    /// flattened into an empty payload.
    OnlineOnly { query: &'static str },
    /// Consent. A value in the payload.
    Denied(Denial),
}

/// The code v0's replica raises, and the one a port must not swallow.
pub const ONLINE_ONLY_CODE: &str = "ONLINE_ONLY";

impl ReadRefusal {
    /// Classify a `(code, message)` the way v0's two `catch` arms do.
    #[must_use]
    pub fn of(query: &'static str, code: Option<&str>, message: Option<&str>) -> Self {
        if code == Some(ONLINE_ONLY_CODE) {
            return Self::OnlineOnly { query };
        }
        Self::Denied(Denial {
            code: code.map(str::to_owned),
            message: message.map(str::to_owned),
            revoked_at: None,
        })
    }

    /// Whether this must be re-raised rather than rendered.
    #[must_use]
    pub const fn must_rethrow(&self) -> bool {
        matches!(self, Self::OnlineOnly { .. })
    }
}

/// ONE ROW'S PLAINTEXT, WITH A LIFE — what a blueprint is handed, and all of it.
///
/// W6-D2 (`docs/decisions.md:909`): *blueprint code never holds `K`*, because
/// one `fetch` in a blueprint would put a vault key on someone else's server
/// with no receipt recording it, since nothing was revealed. So the app's half
/// of a reveal is this value: one address, one plaintext, one receipt id, and
/// an expiry it did not choose.
///
/// The value is **not** `Clone` and **not** `Debug`: a cloned secret is a
/// second copy nothing clears, and a `Debug` secret is a secret in a log line.
#[derive(PartialEq, Eq)]
pub struct Revealed {
    /// `{entity, entity_id, column}` — an ADDRESS the pane already holds, never
    /// a value (`packages/blueprints/apps/locker/reveal.ts:23`-`:40`).
    pub target: SidecarTarget,
    /// The plaintext, for as long as [`Self::expires_at`] has not passed.
    pub value: String,
    /// The `access.receipt` row this reveal wrote. A reveal with no receipt is
    /// the thing the whole plane exists to prevent.
    pub receipt_id: String,
    /// When the shell must drop it. `REVEAL_LIFE_MS` after the gesture.
    pub expires_at: String,
}

/// A reveal is a **gesture, not a mode**, and 30 s is the product's number
/// (`packages/blueprints/apps/locker/reveal.ts:21`). It is stated on the seat
/// that owns the screen it governs, because the reason for it was never the
/// permit's lifetime — it was the shoulder standing behind the member.
pub const REVEAL_LIFE_MS: u64 = 30_000;

/// THE ADDRESS OF A SECRET, never the secret.
///
/// `{entity, entity_id, column}` is resolved out of detail the item pane
/// already holds. A **revision is not one of these**: the password an item was
/// rotated away from rides a `core_entity_revision` snapshot, which no reveal
/// opens and only a confirmed `locker.export` unseals.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct SidecarTarget {
    pub entity: String,
    pub entity_id: String,
    pub column: String,
}

impl SidecarTarget {
    #[must_use]
    pub fn new(entity: &str, entity_id: &str, column: &str) -> Self {
        Self {
            entity: entity.to_owned(),
            entity_id: entity_id.to_owned(),
            column: column.to_owned(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_online_only_read_is_re_raised_and_a_denial_is_not() {
        let online = ReadRefusal::of("items", Some(ONLINE_ONLY_CODE), Some("no local rows"));
        assert!(online.must_rethrow());
        let denied = ReadRefusal::of("items", Some("consent_revoked"), Some("no"));
        assert!(!denied.must_rethrow());
        assert!(matches!(denied, ReadRefusal::Denied(_)));
    }

    /// The third state is the point of [`Reading`].
    #[test]
    fn loading_and_denied_are_not_the_same_absence() {
        let loading: Reading<u8> = Reading::Loading;
        let denied: Reading<u8> = Reading::Denied(Denial::default());
        assert_eq!(loading.data(), None);
        assert_eq!(denied.data(), None);
        assert!(!loading.denied());
        assert!(denied.denied());
        assert_ne!(loading, denied);
    }
}
