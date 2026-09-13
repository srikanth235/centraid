//! The seat's typed refusals.
//!
//! Each variant here is a decision a shell renders differently, which is the
//! whole test for whether something deserves a variant. A string would collapse
//! `DiskFull` (clear space, retry from the same cursor) into `Drift` (throw the
//! file away and re-bootstrap), and those two remedies are not interchangeable.

use centraid_vault::error::{RebootstrapReason, VaultError};

/// What a seat refuses, and why.
#[derive(Debug, thiserror::Error)]
pub enum SeatError {
    /// The gateway's schema epoch is not this file's. The remedy is a
    /// re-bootstrap, never an apply: the rows would land in tables whose shape
    /// has moved and the first symptom would be a wrong answer.
    #[error("seat drift: the page carries schema epoch {theirs} and this file is {ours}")]
    Drift { ours: i64, theirs: i64 },

    /// A row carries another epoch than this file's. Checked PER ROW, because a
    /// page header is only what the gateway believes.
    #[error("seat epoch gate: row {seq} carries epoch `{theirs}` and this file is `{ours}`")]
    EpochGate {
        seq: i64,
        ours: String,
        theirs: String,
    },

    /// `seat_state` has no singleton row: the snapshot landed and nothing
    /// initialised it, or this is not a seat file at all.
    #[error("seat_state has no singleton row; this file was never initialised as a seat")]
    StateMissing,

    /// The file cannot grow. Distinct from every other SQLite error because
    /// the remedy is the member's (clear space) and the next apply resumes
    /// from the same cursor rather than re-bootstrapping.
    #[error("the seat's file is full: {context}")]
    DiskFull { context: String },

    /// This action refuses to be queued offline, with a reason the shell
    /// renders. Never a silent queue: a Locker reveal or an export answered
    /// from a durable store is a mass reveal nobody asked for.
    #[error("`{app_id}.{action}` needs the gateway and this seat has none")]
    OnlineOnly { app_id: String, action: String },

    /// A gateway cursor cannot be served from. Carried through so a seat can
    /// branch on the reason rather than on a string.
    #[error("re-bootstrap required: {reason:?}")]
    RebootstrapRequired { reason: RebootstrapReason },

    /// The outcome aged past the idempotency window. The remedy is to resubmit
    /// as a NEW intent, never a silent retry.
    #[error("the outcome for `{intent_id}` expired; resubmit as a new intent")]
    OutcomeExpired { intent_id: String },

    /// An intent id already holds a different payload.
    #[error("intent id `{intent_id}` is already held by a different payload")]
    IntentIdReused { intent_id: String },

    /// Something this crate believes cannot happen, happened.
    #[error("seat invariant: {context}")]
    Invariant { context: String },

    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),

    #[error(transparent)]
    Json(#[from] serde_json::Error),

    #[error(transparent)]
    Vault(#[from] VaultError),
}

impl SeatError {
    /// Classify a SQLite error, so `SQLITE_FULL` never reaches a caller as a
    /// generic failure.
    ///
    /// `PRAGMA max_page_count` reports a full *logical* file as `SQLITE_FULL`
    /// exactly as a full filesystem does, which is what makes the failure
    /// matrix's disk-full case testable at all without a real full disk.
    #[must_use]
    pub fn from_sqlite(context: &str, error: rusqlite::Error) -> Self {
        if is_full(&error) {
            return Self::DiskFull {
                context: context.to_owned(),
            };
        }
        Self::Sqlite(error)
    }

    /// Whether this is the disk-full answer, whichever layer produced it.
    #[must_use]
    pub fn is_disk_full(&self) -> bool {
        match self {
            Self::DiskFull { .. } => true,
            Self::Vault(vault) => vault.is_disk_full(),
            Self::Sqlite(error) => is_full(error),
            _ => false,
        }
    }
}

fn is_full(error: &rusqlite::Error) -> bool {
    matches!(
        error,
        rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error {
                code: rusqlite::ErrorCode::DiskFull,
                ..
            },
            _
        )
    )
}

pub type Result<T> = std::result::Result<T, SeatError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_full_file_is_its_own_answer_and_not_a_generic_sqlite_error() {
        let error = SeatError::from_sqlite(
            "applying a row",
            rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(13), // SQLITE_FULL
                Some("database or disk is full".to_owned()),
            ),
        );
        assert!(matches!(error, SeatError::DiskFull { .. }));
        assert!(error.is_disk_full());
    }

    /// A full file is recognised even when it arrived as a plain `Sqlite`.
    ///
    /// Killed the mutant that deleted the `Self::Sqlite` arm of
    /// `is_disk_full`. A `?` on a `rusqlite::Result` anywhere in this crate
    /// produces exactly that variant, which makes it the MOST common way a
    /// full file reaches a caller — and the one arm a reader is most likely to
    /// think redundant.
    #[test]
    fn a_full_file_is_recognised_through_the_plain_sqlite_variant() {
        let plain = SeatError::Sqlite(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(13),
            None,
        ));
        assert!(
            plain.is_disk_full(),
            "a `?` on a rusqlite::Result is the commonest way a full file arrives"
        );
        let other = SeatError::Sqlite(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(5),
            None,
        ));
        assert!(!other.is_disk_full());
    }

    #[test]
    fn another_sqlite_failure_is_not_mistaken_for_a_full_file() {
        let error = SeatError::from_sqlite(
            "applying a row",
            rusqlite::Error::SqliteFailure(rusqlite::ffi::Error::new(5), None), // SQLITE_BUSY
        );
        assert!(matches!(error, SeatError::Sqlite(_)));
        assert!(!error.is_disk_full());
    }
}
