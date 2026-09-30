//! THE PHONE IS THE UNLOCK BOUNDARY — and the only place `K` becomes plaintext
//! (#1020 D-1020-L3, restated by #1029 §1 and #1047 D-5).
//!
//! **The owner ruled the gesture on 2026-09-25 (D-5): the phone's biometric,
//! the device passcode as fallback, a relock when Centraid leaves the
//! foreground, and no Locker passphrase.** [`phone`] is that boundary: the
//! shell raises the OS prompt and reports it, and only then does the core put
//! `K` in the session — the seed's `locker'` leaf, derived at open and never
//! written down (D-6, Q-1047-11) — seal what a member typed and reveal one
//! cell, receipt first. The session's clock ([`Session`]) is what [`phone`]
//! holds.
//!
//! What the rule PROTECTS is the half worth stating: `K` becomes plaintext
//! only on the phone the vault is on, after its owner has just proved they are
//! present, and a revealed value lives [`REVEAL_WINDOW_MS`]. That is a claim
//! about presence, which is why what enforces it is the OS prompt and a
//! clock, and never a role check.
//!
//! ## Storage is not authorization
//!
//! That sentence is v0's, from `packages/client/src/locker/locker-unlock.ts`:
//! a store that makes `K` harder to CARRY AWAY without making a person prove
//! they are present is not a boundary. On the phone the proof is the OS
//! prompt — the biometric, or the device passcode — raised by the shell
//! (D-5). What it does not do is bind `K` cryptographically to that prompt:
//! `K` derives from the seed, and the seed is not keystore-guarded, so a
//! keystore wrap of `K` alone would guard nothing the seed does not already
//! open (Q-1047-12, resolved 2026-09-28).
//!
//! ## The numbers are the product's
//!
//! [`SESSION_TIMEOUT_MS`] 5 min and [`REVEAL_WINDOW_MS`] 30 s are v0's
//! numbers, kept because they were the product's answer
//! (`blueprints/apps/locker/reveal.ts:21`).
//!
//! ## A session, not a mode — and the clock is CHECKED
//!
//! [`Session::key`] re-checks the clock on **every** call rather than trusting
//! a timer. A timer in a suspended app may fire minutes late or never, and a
//! session that expires only when a timer says so is a session that does not
//! expire. Expiry **locks as a side effect**: a caller that asks after the
//! window closed must not be able to ask again and get a different answer.
//!
//! ## A locked reveal REFUSES; it does not prompt
//!
//! [`phone`]'s reveal answers `LockerRevealRefusal::Locked`. The shell renders
//! the Lock surface and raises the OS prompt itself — a door that could raise
//! the prompt is a door that could be used to phish it.
//!
//! There is no second reveal door and no fill door (R-1047-D3): v0 has no
//! browser extension and no desktop shell, so the only reveal is the member's
//! own, on the phone, through [`phone`].

pub mod phone;
pub mod session;
mod transfer;

pub use session::{REVEAL_WINDOW_MS, SESSION_TIMEOUT_MS, Session, SessionState};
