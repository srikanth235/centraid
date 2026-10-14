//! # Money — a ledger of accounts and transactions the member imports
//!
//! Money is a personal-finance app: accounts, transactions that enter by
//! **importing a bank statement**, categories by rule, spending by month. Its
//! doctrine (#1099, `docs/decisions.md#money-1099`):
//!
//! - one account is one currency; nothing sums across currencies;
//! - an imported transaction is never edited (a category and a void are the
//!   member's decisions, not edits to what the bank said);
//! - re-importing the same file writes nothing;
//! - the fuzzy duplicate pass only proposes;
//! - the statement's bytes are read once and never stored;
//! - **every figure is derived at read time** — no stored balance or rollup.
//!
//! This crate holds no SQL (`cargo xtask rules`, `sql-confinement`) and no
//! provider SDK. Wave 2 is the import half: [`import`] reads CSV and OFX/QFX
//! into the normalised row and plans it against the account's existing rows;
//! [`rules`] is the rule semantics the vault agrees with.

pub mod civil;
pub mod import;
pub mod rules;
pub mod year3;
