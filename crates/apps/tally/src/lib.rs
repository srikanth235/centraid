//! # Tally — a manifest, eight statement builders, one pure fold, 23 commands
//!
//! Tally is a shared-expense ledger. Its doctrine, from the manifest's own
//! description (`manifest.json`, copied verbatim from v0's `app.json`):
//!
//! - a friend is a canonical `core.party`;
//! - a group is a `social.circle` decorated by a `tally.group`, and **a group is
//!   one ledger in one money** (#996, R22);
//! - an expense stores its **resolved** splits, its payers and the method it
//!   was entered with, all re-validated by the vault to sum to the amount;
//! - a settlement is real cash;
//! - **balances are NEVER stored.** They are derived at read time by the one
//!   engine in [`balance`], and the simplification proposal and the rate
//!   suggestion are derived the same way and written nowhere.
//!
//! ## What this crate is allowed to contain, and what stops the rest
//!
//! | Not allowed | What stops it |
//! |---|---|
//! | SQL, in any form | `cargo xtask rules`' `sql-confinement` scans this crate; SQL lives only under `crates/{ontology,vault,seat,search}` and `crates/apps/kit`. A statement here is a [`centraid_apps_kit::PageQuery`] — a projection, a `from`, a predicate and an order, as data |
//! | A provider SDK | the only dependencies are the kit and `serde`; there is no generic inference verb (v0's `ctx-primitives`) |
//! | A write from a query | [`queries`] holds statements and a [`centraid_apps_kit::PageDoor`], whose one method reads |
//! | An invocation with no `invoke_key` | the field is required on [`commands::Invocation`] (D-1020-D3-5) |
//! | A denial turned into an error | [`commands::Outcome::Denied`] is a state, and the surface renders it |
//! | An unbounded read | every window in [`queries`] is a stated number and every walk errors at its ceiling |
//!
//! ## The manifest
//!
//! `manifest.json` is v0's `app.json`, byte for byte, and [`manifest`] parses it
//! with the kit's parser at load time rather than restating it in Rust. Two
//! copies of "which tables does Tally write" is how the two answers drift —
//! the same reason `contracts/schema/v0-registries.json` is transcribed rather
//! than re-typed (`contracts/README.md`).

pub mod balance;
pub mod commands;
pub mod manifest;
pub mod queries;

pub use balance::{
    Attribution, BalanceData, BalanceExpense, BalanceSettlement, Simplification, Transfer,
    attribute_expense, group_net, group_pair_nets, minimal_transfers, open_debt_count,
    simplification,
};
pub use commands::{ACTIONS, Commands, Invocation, Outcome};
pub use manifest::{APP_ID, manifest};
pub use queries::{TallyData, load_tally};
