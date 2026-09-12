//! # The app kit — the read grammar every Centraid app is written in
//!
//! An app is a **manifest** plus two sets of pure functions: queries that hold
//! statements-as-data, and actions that invoke one typed vault command each
//! (#1020, apps census §1). This crate is everything those functions are
//! allowed to import, and there is deliberately not much of it.
//!
//! What the kit guarantees:
//!
//! - **Every read is a window.** [`page::PageRequest`] has a required `limit`;
//!   there is no unpaged variant and no default. `packages/core/src/page`'s
//!   doctrine, ported verbatim.
//! - **Every window continues by keyset**, `(sort_key, pk)` compared as a row
//!   value, with the pk in the key because the sort key is not unique.
//! - **One assembler.** [`statement::page_statement`] is the only thing in the
//!   workspace that turns an app's statement into SQL, so the seat, the shell
//!   and the gateway cannot drift into three keyset dialects.
//! - **One grammar.** [`grammar::parse`] refuses subqueries, second statements,
//!   comments and unlisted functions, by construction rather than by scanning.
//! - **Money keeps its currency.** [`money::Money`] is `i64` minor units and a
//!   code; a position spanning currencies is a [`money::MoneyBag`] and a single
//!   figure over one is a [`money::Valuation`] that either carries its rates or
//!   says it is unavailable.
//! - **A ceiling errors.** [`reads::read_pages`] past its bound and
//!   [`reads::in_list`] over an empty set are errors, not short answers.
//!
//! What an app may **not** do, and what stops it:
//!
//! | Not allowed | What stops it |
//! |---|---|
//! | Hold a SQL statement or a connection | `sql-confinement` in `cargo xtask rules`: SQL lives only under `crates/{ontology,vault,seat,search}` and `crates/apps/kit` |
//! | Import a provider SDK | the app crates depend on this crate and `serde`; provider-backed judgment is the assistant's plane, and there is no generic `infer` verb (v0's `ctx-primitives`) |
//! | Write from a query | a query holds [`statement::PageQuery`] values and a [`reads::PageDoor`], which has one method and it reads |
//! | Invoke a command without an `invoke_key` | the key is a required field on the invocation, not an option (D-1020-D3-5): v0's fallback is the call's ordinal, which is stable only for a handler that makes the same call sequence every time |
//! | Turn a denial into an error | a denial is a value in the app's own payload; the kit's [`error::KitError`] has no denial variant |

pub mod changes;
pub mod contract_vault;
pub mod error;
pub mod fixtures;
pub mod grammar;
pub mod manifest;
pub mod money;
pub mod page;
pub mod reads;
pub mod row;
pub mod statement;
pub mod testdoor;

pub use error::{KitError, KitResult};
pub use page::{MAX_PAGE_ROWS, Page, PageCursor, PageRequest, page_of, probe_limit};
pub use reads::{FanOutBound, JOIN_FAN_OUT, PageDoor, in_list, read_by_id, read_pages};
pub use row::{Cell, Row};
pub use statement::{
    PageBindValue, PageOrder, PageQuery, page_cursor_boundary, page_cursor_of, page_statement,
};
