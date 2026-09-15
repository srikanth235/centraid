//! The kit's one error type.
//!
//! Every variant here is a **member-visible outcome** in v0 — a `throw` out of
//! `probeLimit`, `inList`, `readPages` or the paged door's `refuse` — and the
//! port keeps them errors rather than short answers for the reason v0 states at
//! `packages/blueprints/apps/_shared/paged-reads.ts:110-112`: returning what a
//! walk had would be the truncation flag again, a short answer that reads as a
//! whole one. A denial, by contrast, is never an error (#1020, census §3.1 and
//! apps seam 10) — it is a value, and it lives in each app's payload.

use std::fmt::Write as _;

/// Everything the kit refuses, with the sentence v0 refuses it with.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum KitError {
    /// `probeLimit` / `pageOf`: a window of zero rows is not a window.
    #[error("page limit must be a positive whole number of rows, got {limit}")]
    BadLimit { limit: usize },

    /// `pageCursorOf`: the pk column must be text, because the cursor is a pair
    /// of strings on the wire and a non-string pk has no round trip.
    #[error("page cursor: {column} must be a string, got {found}")]
    CursorPkNotText { column: String, found: String },

    /// `pageCursorOf`: the order's columns must be in the projection. v0 reads
    /// `undefined` here and stringifies it; the port refuses instead.
    #[error("page cursor: {column} is not in the projection of {query}")]
    CursorColumnMissing { query: String, column: String },

    /// A keyset page was continued over a sort column that can be NULL.
    ///
    /// **This is a live v0 bug the port refuses instead of reproducing**
    /// (D-1020-D3-10). v0 collapses a NULL sort key to `""` when it mints a
    /// cursor (`packages/core/src/page/statement.ts:77`) and continues with
    /// the row value `(sort, pk) < (?, ?)`. SQLite evaluates a row-value
    /// comparison with a NULL operand to **NULL, not true** — verified:
    /// `SELECT (NULL,'pk-4') > ('','pk-3')` answers NULL — so a page of a
    /// nullable sort column silently drops rows in three of the four cases:
    ///
    /// | Direction | Boundary row | Rows still owed | v0 |
    /// |---|---|---|---|
    /// | ASC | valued | only valued | correct: NULLs sorted first and were served |
    /// | ASC | NULL | more NULLs, then valued | **every remaining NULL dropped** |
    /// | DESC | valued | valued, then NULLs | **every NULL dropped** |
    /// | DESC | NULL | more NULLs | **every remaining NULL dropped** |
    ///
    /// A stringified cursor cannot carry "this key was NULL", so a sound
    /// predicate cannot be written for it; the fix is the typed, versioned
    /// cursor, which is filed as a finding rather than built in this lane. Until
    /// then a continued page orders by a NOT NULL column, and this is the
    /// refusal that says so — "a balance derived from a silently short ledger
    /// is a WRONG NUMBER, not a slow screen"
    /// (`packages/blueprints/apps/tally/queries/dashboard.ts:45-51`).
    ///
    /// Found by `crates/apps/kit/tests/keyset_properties.rs`, which is the
    /// reason that file is a property test and not a table of examples.
    #[error(
        "{query}: {column} can be NULL, and a keyset page cannot be continued over it — SQLite compares a row value with a NULL operand to NULL, so a page would silently drop rows. Order a continued page by a column that is NOT NULL ({detail})."
    )]
    NullableSortKey {
        query: String,
        column: String,
        detail: &'static str,
    },

    /// `inList([])`: an empty set is the right answer and the wrong shape.
    #[error("in_list({column}): an empty set is not a read")]
    EmptyInList { column: String },

    /// `readPages` past its bound. The same member-visible outcome as v0's
    /// throw: the caller is asking a question about a set it did not bound.
    #[error("{query}: fan-out passed {cap} rows; the set this joins over is not bounded")]
    FanOutExceeded { query: String, cap: usize },

    /// The door's grammar said no. `why` is the door's own sentence.
    #[error("paged door refuses handler \"{query}\": {why}")]
    GrammarRefused { query: String, why: String },

    /// Two amounts of different currencies were added.
    #[error(
        "{left} and {right} are different currencies — adding them would produce a number that is true in neither."
    )]
    CurrencyMismatch { left: String, right: String },

    /// An `app.json` the manifest parser will not read. `code` is v0's
    /// `ManifestValidationCode`, kept verbatim so the taxonomy survives.
    #[error("{code}: {message}{}", path_suffix(path))]
    Manifest {
        code: &'static str,
        message: String,
        path: Option<String>,
    },

    /// The test door's own failures — a broken fixture, never a product path.
    #[error("test door: {0}")]
    Door(String),
}

fn path_suffix(path: &Option<String>) -> String {
    let mut out = String::new();
    if let Some(path) = path {
        let _ = write!(out, " (at {path})");
    }
    out
}

impl KitError {
    /// The door's refusal, spelled as v0 spells it.
    pub(crate) fn refuse(query: &str, why: impl Into<String>) -> Self {
        Self::GrammarRefused {
            query: query.to_owned(),
            why: why.into(),
        }
    }

    pub(crate) fn manifest(
        code: &'static str,
        message: impl Into<String>,
        path: Option<&str>,
    ) -> Self {
        Self::Manifest {
            code,
            message: message.into(),
            path: path.map(str::to_owned),
        }
    }
}

/// The kit's result alias.
pub type KitResult<T> = Result<T, KitError>;
