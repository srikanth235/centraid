//! THE SEAT IS THE UNLOCK BOUNDARY — and the only place `K` becomes plaintext
//! (#1020, D-1020-L3).
//!
//! ## Storage is not authorization
//!
//! That sentence is the whole reason this module exists, and it is v0's, from
//! `packages/client/src/locker/locker-unlock.ts:3`-`:11`: *a non-extractable
//! WebCrypto key stops export, not use by app code running on the page.
//! Electron's `safeStorage` encrypts at rest and prompts for nothing.
//! IndexedDB is readable by the origin that wrote it. Each makes `K` harder to
//! CARRY AWAY and none makes a person prove they are present — so none is a
//! boundary, and shipping one as if it were is how the permit the gateway used
//! to mint gets deleted in exchange for nothing.*
//!
//! What a boundary needs is something the owner **knows** or **is**. Touch ID
//! is the `IS` half and is deferred: it needs a signed, entitled macOS build,
//! and an unsigned dev build rejects `promptTouchID` outright. So this is the
//! `KNOWS` half — one local passphrase, PBKDF2-SHA-256 over it, AES-GCM
//! around `K`, and **the wrapped blob is all that is ever at rest**. The
//! passphrase is never stored, never sent, and never derivable from what is;
//! losing it means re-enrolling the seat, which is the honest cost of the
//! boundary actually being one.
//!
//! ## The numbers are the product's, not this port's
//!
//! [`SESSION_TIMEOUT_MS`] 5 min, [`REVEAL_WINDOW_MS`] 30 s,
//! [`PASSPHRASE_MINIMUM`] 12 characters, [`WRAP_ITERATIONS`] 600,000. They are
//! the ones the deleted gateway `locker-auth.ts` used, kept because they were
//! the **product's** answer and not the gateway's implementation detail
//! (`locker-unlock.ts:22`-`:35`, `blueprints/apps/locker/reveal.ts:21`).
//!
//! ## A session, not a mode — and the clock is CHECKED
//!
//! [`Session::key`] re-checks the clock on **every** call rather than trusting
//! a timer. A `setTimeout` in a backgrounded tab or a suspended window may
//! fire minutes late or never, and a session that expires only when a timer
//! says so is a session that does not expire. Expiry **locks as a side
//! effect**: a caller that asks after the window closed must not be able to
//! ask again and get a different answer.
//!
//! ## What a blueprint gets, and what it never gets (W6-D2)
//!
//! An app crate gets **one row's plaintext per receipt** — a
//! [`Reveal`] — and never `K`. `docs/decisions.md:909`: *one `fetch` in a
//! blueprint would put a vault key on someone else's server with no receipt
//! recording it, since nothing was revealed.* There is no `unlock()` on the
//! app-facing door either, *because a door that can raise the passphrase
//! prompt is a door that can be used to phish it* — the shell prompts.
//!
//! ## A locked reveal REFUSES; it does not prompt
//!
//! [`Unlock::reveal`] answers [`RevealRefusal::Locked`]. The shell renders the
//! Lock surface and takes the passphrase itself. That split is the phishing
//! argument made structural.

pub mod fill;
pub mod session;
pub mod unlock;

pub use fill::{FillGrant, FillRequest, fill_grant};
pub use session::{PASSPHRASE_MINIMUM, SESSION_TIMEOUT_MS, Session, SessionState, WrappedKey};
pub use unlock::{
    REVEAL_WINDOW_MS, Reveal, RevealRefusal, RevealTarget, Unlock, UnlockError, WRAP_ITERATIONS,
    unwrap_member_key, wrap_member_key,
};
