//! # People — a manifest, five queries, twenty-five actions
//!
//! Its doctrine, from the manifest's own description (`manifest.json`):
//!
//! - **NOTHING IS STORED HERE.** People is a personal CRM *projected* from the
//!   vault's own rows (#1135): a person is an `entity` of kind `person` with its
//!   columns (role, nickname, how you met, birthday, cadence); a touch is an
//!   `activity` with the person; a note, a journal entry, a follow-up and a gift
//!   idea are a `note` or a `task` with an `about` edge; an important date other
//!   than the birthday is a yearly all-day `event` about them; a relationship is
//!   a `related` edge; a list is a `container` holding people with `contains`
//!   edges; the star is the shared `flag:starred`. Revoke the grant and the app
//!   goes dark while the people remain the owner's.
//! - **LAST CONTACTED IS COMPUTED, NEVER STORED.** It is the newest activity
//!   `with` the person ([`queries::touch_stubs`]); a person with no touch is
//!   measured from when they were added, and one with no cadence is never due.
//! - **THE CIRCLE IS THE PEOPLE YOU KEEP**: every live person but the owner and
//!   a pet. A relative named in a relationship is a person you have written
//!   about, so they are in it.
//! - **MERGE IS THE SHARED VERB**: `merge-people` invokes `person.merge`, which
//!   re-points every foreign key and edge and purges the merged person.
//! - **A DENIAL IS A VALUE.** Every loader answers the empty shape plus the
//!   door's [`Denial`] rather than throwing, and a kit error stays an error.
//!
//! ## What this crate is allowed to contain, and what stops the rest
//!
//! | Not allowed | What stops it |
//! |---|---|
//! | SQL, in any form | `cargo xtask rules`' `sql-confinement` scans this crate; SQL lives only under `crates/{ontology,vault,seat,search}` and `crates/apps/kit`. A statement here is a [`centraid_apps_kit::PageQuery`] — a projection, a `from`, a predicate and an order, as data |
//! | A write from a query | [`queries`] holds statements and a [`centraid_apps_kit::PageDoor`], whose one method reads |
//! | An invocation with no `invoke_key` | the field is required on [`commands::Invocation`] (D-1020-D3-5) |
//! | A denial turned into an error | [`commands::Outcome::Denied`] and [`Denial`] are states a surface renders |
//! | A wrapper around a shared verb | [`commands::ACTIONS`] names `entity.trash`, `flag.set`, `container.create` directly; only what a person alone has is a `person.*` command |
//! | A civil date read off the host clock | [`dates`] takes the vault's zone offset as an argument; there is no `now()` in this crate |
//!
//! ## The manifest
//!
//! `manifest.json` is parsed by the kit's parser at load time ([`manifest`])
//! rather than restated in Rust: two copies of "which commands does People
//! invoke" is how the two answers drift.

pub mod commands;
pub mod dashboard;
pub mod dates;
pub mod manifest;
pub mod person;
pub mod phone;
pub mod queries;
pub mod roster;

pub use commands::{ACTIONS, Commands, Invocation, Outcome};
pub use dates::{DAYS_UNSET, days_until_month_day};
pub use manifest::{APP_ID, manifest};

/// A CONSENT DENIAL, as the payload carries it: the kit's one type, shared by
/// every app so the core settles all of them through one door.
pub use centraid_apps_kit::Denial;
