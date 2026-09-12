//! Every way the vault refuses, as a value.
//!
//! Two rules this module is written to.
//!
//! **A deny is an outcome, not an exception.** `evaluate_access` returns a
//! `Decision`, never an error — the authority plane's whole job is to answer,
//! and an answer that arrives as a panic cannot be receipted (plane census
//! §3.2). So there is no `VaultError::Denied`.
//!
//! **A refusal a caller must act on differently gets its own variant.** `DiskFull`
//! and `RebootstrapRequired` are the two the product renders: one is "your disk
//! is full", the other is "throw your copy away and take a snapshot". A caller
//! that had to grep a message string for either would eventually stop.

use std::path::PathBuf;

/// Why a seat's cursor cannot be served, in v0's closed vocabulary.
///
/// Ten values wide on the wire (`packages/server/src/routes/replica-routes.ts:79-95`);
/// the three a cursor can earn at the log door are here, plus `Initial` for a
/// seat that has none. Anything a future reader does not recognise normalises
/// to `InvalidCursor` — no raw error text ever reaches a peer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RebootstrapReason {
    /// The cursor names an epoch this vault is no longer in.
    EpochMismatch,
    /// The cursor is below the retention floor: the rows it wants are gone.
    Retention,
    /// The cursor is above the watermark — a seat that ran ahead of the
    /// gateway, which after a restore from backup is the normal case.
    CursorAhead,
    /// The seat has no cursor yet.
    Initial,
    /// A cursor that did not parse, and every reason a reader did not know.
    InvalidCursor,
}

impl RebootstrapReason {
    /// The wire spelling, matching v0's verdict strings exactly.
    #[must_use]
    pub const fn as_wire(self) -> &'static str {
        match self {
            Self::EpochMismatch => "epoch-mismatch",
            Self::Retention => "retention",
            Self::CursorAhead => "cursor-ahead",
            Self::Initial => "initial",
            Self::InvalidCursor => "invalid-cursor",
        }
    }
}

impl std::fmt::Display for RebootstrapReason {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_wire())
    }
}

/// Why an idempotency claim was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IntentRefusal {
    /// The intent id is held by a different command, caller or payload.
    IdReused,
    /// A terminal outcome is being asked for a different status.
    AlreadyTerminal,
    /// Past the 30-day window: the outcome can no longer say where its effect
    /// landed, because the log rows its `commit_seq` points into are pruned.
    OutcomeExpired,
}

impl IntentRefusal {
    #[must_use]
    pub const fn as_wire(self) -> &'static str {
        match self {
            Self::IdReused => "intent_id_reused",
            Self::AlreadyTerminal => "intent_already_terminal",
            Self::OutcomeExpired => "outcome_expired",
        }
    }
}

impl std::fmt::Display for IntentRefusal {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_wire())
    }
}

#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum VaultError {
    #[error("{path} does not exist")]
    Missing { path: PathBuf },

    #[error(
        "{path} is not a Centraid vault: application_id {found:#010x}, expected {expected:#010x}"
    )]
    NotAVault {
        path: PathBuf,
        found: i64,
        expected: i64,
    },

    /// A file a NEWER build wrote. The core never guesses a schema down.
    #[error("{path} is at schema version {found}; this build understands {expected}")]
    DowngradeRefused {
        path: PathBuf,
        found: i64,
        expected: i64,
    },

    /// The disk is full. Typed because the product renders it and because the
    /// commit that hit it was rolled back WHOLE — `commit_seq` did not move
    /// and no artifact was left behind (D-1020-D1-8).
    #[error("the disk is full: {context}")]
    DiskFull { context: String },

    /// A seat's cursor cannot be served; it must bootstrap from a snapshot.
    #[error("re-bootstrap required: {reason}")]
    RebootstrapRequired { reason: RebootstrapReason },

    #[error("intent refused: {refusal}")]
    IntentRefused {
        refusal: IntentRefusal,
        detail: String,
    },

    /// The decode ran outside its transaction. v0's message, kept verbatim,
    /// because it names the ONE mistake that produces it.
    #[error("{table} key {key} read back missing: the decode ran outside its transaction")]
    DecodeOutsideTransaction { table: String, key: String },

    #[error("no command named `{name}` is registered")]
    UnknownCommand { name: String },

    #[error("`{name}` is registered but has no body yet")]
    NotImplemented { name: String },

    #[error("`{name}`: {detail}")]
    InvalidInput { name: String, detail: String },

    /// An ontology-version mismatch is a STALE REGISTRATION, not an old
    /// client: there is one served ontology version, so compatibility is
    /// equality on purpose (#310, plane census §3.3).
    #[error("`{name}` was registered against ontology {registered}; this gateway serves {served}")]
    OntologyVersionMismatch {
        name: String,
        registered: String,
        served: String,
    },

    #[error("a cursor must be `<epoch>:<seq>`, and `{found}` is not")]
    InvalidCursor { found: String },

    #[error("{context}")]
    Invariant { context: String },

    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),

    #[error(transparent)]
    Io(#[from] std::io::Error),

    #[error("{context}: {source}")]
    Json {
        context: String,
        #[source]
        source: serde_json::Error,
    },

    #[error(transparent)]
    Ontology(#[from] centraid_ontology::OntologyError),
}

impl VaultError {
    /// Turn a rusqlite error into `DiskFull` when SQLite said `SQLITE_FULL`,
    /// and leave it alone otherwise.
    ///
    /// The classification is on the PRIMARY code, not the message: `disk I/O
    /// error` and `database or disk is full` are both things SQLite says, and
    /// only one of them is this.
    pub fn from_sqlite(context: &str, error: rusqlite::Error) -> Self {
        use rusqlite::ErrorCode;
        let full = matches!(
            &error,
            rusqlite::Error::SqliteFailure(inner, _)
                if inner.code == ErrorCode::DiskFull
        );
        if full {
            return Self::DiskFull {
                context: format!("{context}: {error}"),
            };
        }
        Self::Sqlite(error)
    }

    /// Is this the disk-full answer? The one predicate a caller needs, so a
    /// test does not pattern-match on a `#[non_exhaustive]` enum.
    #[must_use]
    pub const fn is_disk_full(&self) -> bool {
        matches!(self, Self::DiskFull { .. })
    }
}

pub type Result<T> = std::result::Result<T, VaultError>;
