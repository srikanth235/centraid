//! The core's typed refusals, and their wire codes.
//!
//! Every variant maps to exactly one [`ErrorCode`], because a shell branches on
//! the code and a code that could mean two things is a branch that guesses.
//! The mapping is a function rather than a `#[repr]` so a new variant has to
//! choose, and so the choice is visible in one place.

use centraid_api_proto::core_v1::ErrorCode;

/// What the core refuses.
#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    /// The handle is closed. Every call after [`crate::Handle::close`] is this,
    /// and not a hang and not a panic.
    #[error("this core is closed")]
    Closed,

    /// The handle was poisoned by a caught panic. The shell restarts the core
    /// **deliberately** rather than carrying on over state nobody can vouch
    /// for. Carries the diagnostic id so a crash report and a log line name
    /// the same event.
    #[error("this core is poisoned by a caught panic ({diagnostic_id}); restart it")]
    Poisoned { diagnostic_id: String },

    /// A thin seat could not reach its gateway.
    #[error("the gateway is unreachable: {reason}")]
    Unavailable { reason: String },

    /// The request itself is wrong: a zero limit, a cursor with a non-decimal
    /// seq, a page query with no order column. Not the state.
    #[error("invalid request: {detail}")]
    InvalidRequest { detail: String },

    /// A message type or body this build does not carry.
    #[error("unsupported message: {type_url}")]
    Unsupported { type_url: String },

    /// Not built yet. **Never a silent stub** — a caller gets this and can say
    /// so, rather than getting an empty answer that looks like "no data".
    #[error("`{what}` is not yet available: {lands_in}")]
    NotYetAvailable {
        what: &'static str,
        lands_in: &'static str,
    },

    /// The action refuses to run without a gateway.
    #[error("`{app_id}.{action}` needs the gateway and this seat has none")]
    OnlineOnly { app_id: String, action: String },

    /// The request was cancelled by a `Cancel`.
    #[error("request {request_id} was cancelled")]
    Cancelled { request_id: u64 },

    /// A bounded read was asked to be cancelled. Bounded reads are bounded
    /// instead: cancelling one leaves a SQLite read transaction to be rolled
    /// back by a dropped future, which is how v0's four-statements-in-one-read
    /// rule gets broken (census seam 4).
    #[error("request {request_id} is a bounded read and is not cancellable")]
    NotCancellable { request_id: u64 },

    #[error(transparent)]
    Vault(#[from] centraid_vault::VaultError),

    #[error(transparent)]
    Seat(#[from] centraid_seat::SeatError),

    #[error(transparent)]
    Protocol(#[from] centraid_protocol::ProtocolError),

    #[error(transparent)]
    Decode(#[from] prost::DecodeError),

    #[error("core invariant: {context}")]
    Invariant { context: String },
}

impl CoreError {
    /// The one code a shell branches on.
    #[must_use]
    pub fn code(&self) -> ErrorCode {
        match self {
            // A closed or poisoned handle is INTERNAL from the shell's side:
            // the remedy is the same, which is to restart the core.
            Self::Closed | Self::Poisoned { .. } | Self::Invariant { .. } => ErrorCode::Internal,
            Self::Unavailable { .. } => ErrorCode::PeerUnreachable,
            Self::InvalidRequest { .. } | Self::NotCancellable { .. } | Self::Decode(_) => {
                ErrorCode::InvalidRequest
            }
            Self::Unsupported { .. } => ErrorCode::UnsupportedMessage,
            Self::NotYetAvailable { .. } => ErrorCode::NotYetAvailable,
            Self::OnlineOnly { .. } => ErrorCode::OnlineOnly,
            Self::Cancelled { .. } => ErrorCode::Cancelled,
            Self::Vault(vault) => vault_code(vault),
            Self::Seat(seat) => seat_code(seat),
            Self::Protocol(_) => ErrorCode::MalformedFrame,
        }
    }

    /// The diagnostic id, when this error has one.
    #[must_use]
    pub fn diagnostic_id(&self) -> Option<&str> {
        match self {
            Self::Poisoned { diagnostic_id } => Some(diagnostic_id),
            _ => None,
        }
    }

    /// The wire `Error`. `detail` is **for logs only** — a shell renders the
    /// code, never this string.
    #[must_use]
    pub fn to_wire(&self) -> centraid_api_proto::core_v1::Error {
        centraid_api_proto::core_v1::Error {
            code: self.code() as i32,
            detail: self.to_string(),
            diagnostic_id: self.diagnostic_id().unwrap_or_default().to_owned(),
        }
    }
}

fn vault_code(error: &centraid_vault::VaultError) -> ErrorCode {
    use centraid_vault::VaultError as V;
    if error.is_disk_full() {
        // No dedicated code: a full disk is the file refusing, and the shell's
        // remedy (tell the member to clear space) is the same as for any other
        // internal failure of the file. Named here rather than left implicit so
        // the choice is a choice.
        return ErrorCode::Internal;
    }
    match error {
        V::RebootstrapRequired { .. } => ErrorCode::RebootstrapRequired,
        V::DowngradeRefused { .. } => ErrorCode::DowngradeRefused,
        V::NotImplemented { .. } => ErrorCode::NotYetAvailable,
        V::InvalidInput { .. }
        | V::InvalidCursor { .. }
        | V::UnknownCommand { .. }
        | V::OntologyVersionMismatch { .. } => ErrorCode::InvalidRequest,
        V::IntentRefused { refusal, .. } => intent_refusal_code(*refusal),
        _ => ErrorCode::Internal,
    }
}

fn intent_refusal_code(refusal: centraid_vault::IntentRefusal) -> ErrorCode {
    use centraid_vault::IntentRefusal as R;
    match refusal {
        // The SAME code for both: `intent_already_terminal` is a reused id seen
        // from the other side — the ledger holds an answer and is being asked
        // for a different one. A shell's remedy is identical (mint a new id).
        R::IdReused | R::AlreadyTerminal => ErrorCode::IntentIdReused,
        R::OutcomeExpired => ErrorCode::IntentOutcomeExpired,
    }
}

fn seat_code(error: &centraid_seat::SeatError) -> ErrorCode {
    use centraid_seat::SeatError as S;
    match error {
        S::Drift { .. } | S::EpochGate { .. } | S::RebootstrapRequired { .. } => {
            ErrorCode::RebootstrapRequired
        }
        S::OnlineOnly { .. } => ErrorCode::OnlineOnly,
        S::OutcomeExpired { .. } => ErrorCode::IntentOutcomeExpired,
        S::IntentIdReused { .. } => ErrorCode::IntentIdReused,
        _ => ErrorCode::Internal,
    }
}

pub type Result<T> = std::result::Result<T, CoreError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_closed_handle_is_a_typed_error_and_not_a_hang() {
        let error = CoreError::Closed;
        assert_eq!(error.code(), ErrorCode::Internal);
        assert!(error.diagnostic_id().is_none());
    }

    #[test]
    fn a_poisoned_handle_carries_the_diagnostic_id_onto_the_wire() {
        let error = CoreError::Poisoned {
            diagnostic_id: "diag-1".to_owned(),
        };
        let wire = error.to_wire();
        assert_eq!(wire.diagnostic_id, "diag-1");
        assert_eq!(wire.code, ErrorCode::Internal as i32);
        // And the DETAIL is for logs. It is present, and a shell must not
        // render it; the test records the intent rather than enforcing it.
        assert!(!wire.detail.is_empty());
    }

    #[test]
    fn a_rebootstrap_from_either_side_carries_the_same_code() {
        assert_eq!(
            CoreError::Seat(centraid_seat::SeatError::Drift { ours: 4, theirs: 5 }).code(),
            ErrorCode::RebootstrapRequired
        );
        assert_eq!(
            CoreError::Vault(centraid_vault::VaultError::RebootstrapRequired {
                reason: centraid_vault::RebootstrapReason::EpochMismatch,
            })
            .code(),
            ErrorCode::RebootstrapRequired
        );
    }

    #[test]
    fn a_bounded_read_refusing_to_be_cancelled_is_an_invalid_request_not_an_internal_error() {
        // The peer asked for something the protocol does not offer. That is the
        // peer's mistake, not a failure of this core.
        assert_eq!(
            CoreError::NotCancellable { request_id: 7 }.code(),
            ErrorCode::InvalidRequest
        );
        assert_eq!(
            CoreError::Cancelled { request_id: 7 }.code(),
            ErrorCode::Cancelled
        );
    }

    #[test]
    fn a_not_yet_available_capability_names_where_it_lands() {
        let error = CoreError::NotYetAvailable {
            what: "content",
            lands_in: "wave 3",
        };
        assert_eq!(error.code(), ErrorCode::NotYetAvailable);
        assert!(error.to_string().contains("wave 3"));
    }
}
