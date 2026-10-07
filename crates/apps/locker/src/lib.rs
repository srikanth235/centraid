//! # Locker — the password manager, and the one app with sealed cells
//!
//! 15,908 lines of v0 TypeScript, 8 queries, 17 actions, **38 scopes including
//! the only three `reveal` verbs in the product** (#1020, wave 4 census §A8,
//! §F). Everything else in this crate follows from one sentence: **the phone
//! is the vault, and `K` never leaves its core** (#1029, #1047 D-5, D-6). `K`
//! is derived from the seed when the core opens, held only behind the
//! member's biometric presence gate, and nothing in this crate ever sees it.
//!
//! ## What that makes true of this crate
//!
//! - **Listing is not unlocking.** [`phone`]'s loaders are authorised by the
//!   app grant alone and run on the phone's own rows; title, url and username
//!   are plaintext at rest, so listing and search need no `K`. (The shell
//!   still shows nothing while Locker is locked, R-1047-L2 — the core refuses
//!   only what needs `K`.)
//! - **A sealed cell never rides a payload.** No statement in this crate names
//!   `password`, `otp_seed`, `card_number`, `cvv`, `content`, `value_sealed` or
//!   `private_key` for a **list**; [`queries::ITEM_COLUMNS`] is the browsable
//!   half, stated once, and a secret's existence travels as a presence bit
//!   (`<cell> IS NOT NULL`), never as the cell — the item's cells, a sealed
//!   custom field and a passkey's key alike ([`phone`]).
//! - **The plaintext is not in this crate at all.** Revealing one cell is
//!   `crates/core::locker::phone`'s, behind the unlock and a receipt written
//!   first; this crate has no reveal type and no key.
//! - **`access` has two walls.** The declared `rowFilter` on `object_type` is
//!   the outer wall and [`queries::access_statement`]'s own predicate is the inner one,
//!   so the page is filtered **before** the window rather than after — without
//!   it a busy vault's newest 200 receipts could be entirely someone else's
//!   and the clamp would hand the screen an empty history (census §A8).
//! - **A one-time code is a fold over a seed only the core opens**
//!   (D-1020-L6, Q-1047-16). [`totp`] is pure — base32, the counter, the
//!   dynamic truncation, the `otpauth://` reading — and the HMAC is injected by
//!   `crates/core::locker::phone`, which holds `K` and SHA-1; the vault's
//!   `locker.totp_code` command only writes the receipt, first. Weak and reused
//!   are not scored anywhere (Q-1047-16): scoring them means unsealing every
//!   password at once, and the Watchtower fold that did is deleted.
//!
//! ## What this crate is allowed to contain, and what stops the rest
//!
//! | Not allowed | What stops it |
//! |---|---|
//! | SQL, in any form | `cargo xtask rules`' `sql-confinement`; a statement here is a [`centraid_apps_kit::PageQuery`] — a projection, a `from`, a predicate and an order, as data |
//! | The member key `K`, in any form | nothing in this crate's dependency set can open a `lk1:` cell: `centraid-vault` is not a dependency, and a reveal is the core's |
//! | A write from a query | [`queries`] holds statements and a [`centraid_apps_kit::PageDoor`], whose one method reads |
//! | A plaintext file on disk | [`transfer`] renders and reads bytes; the core hands them to the OS save sheet and takes them from the OS picker |
//!
//! ## The manifest
//!
//! `manifest.json` is v0's `app.json` with four deletions: `auth_session` on
//! the `items` query (a permit-era parameter, #996 R13, D-1020-L7),
//! `disabledOn: ["viewer"]` (D-1020-L7), and the two autofill queries with the
//! `autofill` origin act (R-1047-D3: v0 has no browser extension and no
//! desktop shell to fill a page). [`manifest::tests`] asserts each absence.

pub mod commands;
pub mod manifest;
pub mod phone;
pub mod queries;
pub mod totp;
pub mod transfer;
pub mod types;

pub use commands::ACTIONS;
pub use manifest::{APP_ID, manifest};
pub use queries::{ITEM_COLUMNS, ItemRow};
pub use types::{ITEM_TYPES, degrade_type, is_known_type};
