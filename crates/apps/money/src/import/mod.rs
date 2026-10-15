//! STATEMENT IMPORT, AS PURE FOLDS (#1099, wave 2).
//!
//! A bank statement arrives as bytes. This module turns them into the
//! **normalised row** the `money.import_transactions` command takes (seam S1:
//! [`ImportRow`]) and, with the rows the account already holds, into a
//! [`plan::ImportPlan`] that says what each row would do. Nothing here opens a
//! vault, writes a row or keeps the bytes: the caller reads the statement once,
//! hands the bytes to [`csv::read_csv`] or [`ofx::read_ofx`], and drops them.
//!
//! The pipeline, each stage a function of the one before:
//!
//! 1. [`text::decode`] — a UTF-8 byte-order mark is dropped; bytes that are not
//!    UTF-8 are read as windows-1252, the code page banks still export in.
//! 2. [`csv::read_csv`] / [`ofx::read_ofx`] — [`ParsedRow`]s: each is an
//!    [`ImportRow`] or a [`RejectReason`] with its 1-based line. **A bad row is
//!    one rejected row, never a blocked file.**
//! 3. [`plan::plan`] — rules, then exact de-duplication, then the fuzzy
//!    *proposal*, then the verdict per row and the file's totals.
//!
//! **Limits are refusals, not truncation** ([`Refusal`]): a file over
//! [`IMPORT_BYTES`] or with more than [`IMPORT_ROWS`] data rows is refused
//! whole, so a plan never silently covers part of a file.
//!
//! **No value reaches a log.** A [`Refusal`]'s and a [`RejectReason`]'s
//! sentence never quotes the file.

pub mod amount;
pub mod csv;
pub mod date;
pub mod keys;
pub mod ofx;
pub mod plan;
pub mod text;

use serde::{Deserialize, Serialize};

pub use csv::{AmountSpec, CsvOptions, CsvProfile, SavedProfile, SignChoice, read_csv};
pub use date::DateOrder;
pub use ofx::{AccountRef, OfxFile, OfxStatement, StatementRefusal, read_ofx, resolve_account};
pub use plan::{
    ExistingTxn, ImportPlan, PlanRow, PlanTotals, RowVerdict, SIMILARITY_THRESHOLD,
    existing_window, plan,
};

/// The most data rows one statement may hold (R-1099-7).
pub const IMPORT_ROWS: usize = 20_000;

/// The largest statement file read (R-1099-7): 8 MiB.
pub const IMPORT_BYTES: usize = 8 * 1024 * 1024;

/// The largest single amount a row may carry, in minor units. A statement cell
/// beyond it is a typo or not a statement; it keeps a sum of [`IMPORT_ROWS`]
/// rows inside `i64`.
pub const MAX_AMOUNT_MINOR: i64 = 10_000_000_000_000;

/// Which way money moved, from the account's side.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    /// Money out of the account.
    Debit,
    /// Money into the account.
    Credit,
}

impl Direction {
    /// The command's spelling: `debit` or `credit`.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Debit => "debit",
            Self::Credit => "credit",
        }
    }

    /// The signed minor-unit value of `magnitude` in this direction.
    #[must_use]
    pub const fn signed(self, magnitude: i64) -> i64 {
        match self {
            Self::Debit => -magnitude,
            Self::Credit => magnitude,
        }
    }
}

/// Where a statement came from; `money.import_transactions`' `source`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Csv,
    Ofx,
}

impl Source {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Csv => "csv",
            Self::Ofx => "ofx",
        }
    }
}

/// THE NORMALISED ROW (seam S1): what `money.import_transactions` takes, field
/// for field. The `txn_id` is minted by the caller, not here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImportRow {
    /// `ofx:<FITID>`, `ofx-nofitid:<hex>` or `csv:<64 hex>` (R-1099-3).
    pub external_id: String,
    /// The printed day, `YYYY-MM-DD`; never shifted by a zone.
    pub posted_on: String,
    /// The magnitude in minor units of the account's currency; always > 0.
    pub amount_minor: i64,
    pub direction: Direction,
    /// Exactly as the bank wrote it, trimmed of surrounding whitespace only.
    pub description: String,
    pub memo: Option<String>,
    pub check_number: Option<String>,
    pub bank_type: Option<String>,
    /// Set by the rules (post-rules); `None` out of a parser.
    pub category_concept_id: Option<String>,
    /// Set by the rules (post-rules); `None` out of a parser.
    pub display_name: Option<String>,
}

impl ImportRow {
    /// The signed minor-unit amount: negative is money out.
    #[must_use]
    pub const fn signed_minor(&self) -> i64 {
        self.direction.signed(self.amount_minor)
    }
}

/// Why one row could not be read. The row is skipped and shown; the file is
/// not blocked.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RejectReason {
    MissingDate,
    UnreadableDate,
    MissingAmount,
    UnreadableAmount,
    ZeroAmount,
    AmountTooLarge,
    /// A debit/credit file whose row fills both columns.
    BothDebitAndCredit,
    /// An indicator-column file whose row carries no recognisable indicator.
    UnknownIndicator,
    /// An OFX transaction that is not a complete aggregate.
    IncompleteTransaction,
}

impl RejectReason {
    /// The sentence the plan shows beside the line number.
    #[must_use]
    pub const fn sentence(self) -> &'static str {
        match self {
            Self::MissingDate => "No date.",
            Self::UnreadableDate => "The date could not be read.",
            Self::MissingAmount => "No amount.",
            Self::UnreadableAmount => "The amount could not be read.",
            Self::ZeroAmount => "The amount is zero.",
            Self::AmountTooLarge => "The amount is too large to be a transaction.",
            Self::BothDebitAndCredit => "Both a debit and a credit are filled.",
            Self::UnknownIndicator => "Money in or out is not marked.",
            Self::IncompleteTransaction => "The transaction is incomplete.",
        }
    }
}

/// One data row as a parser read it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedRow {
    /// 1-based line in the file the row starts on.
    pub line: usize,
    pub result: Result<ImportRow, RejectReason>,
}

/// A whole file the import refuses, with the limit it broke. Never quotes the
/// file.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Refusal {
    #[error("The file is empty.")]
    Empty,
    #[error("The file is larger than {limit} bytes.")]
    TooLarge { bytes: usize, limit: usize },
    #[error("The file has more than {limit} rows.")]
    TooManyRows { limit: usize },
    #[error("This does not look like a bank statement.")]
    NotAStatement,
    #[error("This OFX file could not be read.")]
    UnreadableOfx,
}

/// A statement's closing balance, as the vault's `checkpoint` takes it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Checkpoint {
    /// `YYYY-MM-DD`.
    pub as_of: String,
    /// Signed minor units, as the statement printed it.
    pub balance_minor: i64,
}

/// Something the member should see beside the plan, that is not a row.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Warning {
    /// A saved profile no longer fits the file's header; the columns were
    /// detected afresh.
    ProfileChanged,
    /// Which sign means money out was decided by the file's majority sign, not
    /// by a column that says so. The plan shows it so the member can flip it.
    SignGuessed,
}

/// The question a date column the file cannot answer carries to the member.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DateOrderQuestion {
    /// A few raw date cells, as printed, so the sheet can show them.
    pub samples: Vec<String>,
    /// The orders still possible.
    pub options: Vec<DateOrder>,
}

/// A statement read: rows (or the one question that stands before any row can
/// be read), the checkpoint, the profile that read it and what to warn about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Statement {
    pub source: Source,
    /// Empty while [`Self::question`] is set.
    pub rows: Vec<ParsedRow>,
    pub checkpoint: Option<Checkpoint>,
    /// CSV only: the detected or re-applied profile.
    pub profile: Option<CsvProfile>,
    pub question: Option<DateOrderQuestion>,
    pub warnings: Vec<Warning>,
}

impl Statement {
    /// The rows that read.
    pub fn readable(&self) -> impl Iterator<Item = (usize, &ImportRow)> {
        self.rows
            .iter()
            .filter_map(|row| row.result.as_ref().ok().map(|ok| (row.line, ok)))
    }
}
