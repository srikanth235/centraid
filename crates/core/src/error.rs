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

    /// THE OWNER-FACING SENTENCE, derived from [`Self::code`] and nothing else.
    ///
    /// Lane E's shell showed a member
    /// `entity id is already held by another kind: core_party (#916)` — a
    /// SQLite `RAISE(ABORT)` from a trigger, carried out through `detail`
    /// because that was the only string on the message (#1020 wave 3, lane E
    /// finding 2). `error.proto` already said that no free-text reason reaches
    /// a member; it just gave a shell nothing else to render.
    ///
    /// So this function reads the CODE, never `self`'s own `Display`. That is
    /// the whole mechanism: a database message, a file path, a SQL fragment or
    /// a panic payload cannot reach a member through a function that does not
    /// look at them. `to_wire` keeps the raw text in `detail` for the audit
    /// trail, which is where `command.proto`'s rule says a predicate belongs.
    #[must_use]
    pub fn sentence(&self) -> String {
        sentence_for_code(self.code()).to_owned()
    }

    /// The wire `Error`. `detail` is **for logs only** — a shell renders
    /// [`Self::sentence`], or its own words for the code, and never `detail`.
    #[must_use]
    pub fn to_wire(&self) -> centraid_api_proto::core_v1::Error {
        centraid_api_proto::core_v1::Error {
            code: self.code() as i32,
            detail: self.to_string(),
            diagnostic_id: self.diagnostic_id().unwrap_or_default().to_owned(),
            sentence: self.sentence(),
        }
    }
}

/// THE OWNER-FACING SENTENCE for a code.
///
/// One table, reached by `CoreError::sentence` and by the seat and transport
/// paths that produce a code without a `CoreError` variant of their own. A
/// shell may render it verbatim or branch on the code and use its own words;
/// what it must not do is render `Error.detail`, which is where the raw
/// predicate lives (#1020 wave 3, lane E finding 2).
#[must_use]
pub fn sentence_for_code(code: ErrorCode) -> &'static str {
    use ErrorCode as C;
    match code {
        C::Unspecified => "Something went wrong and this build could not say what.",
        C::Unauthorized => {
            "This device is not enrolled on that vault, or its access was withdrawn."
        }
        C::VersionWindow => {
            "This app and that gateway are too far apart in version to talk. Update the one the \
             diagnostics screen names."
        }
        C::MalformedFrame => {
            "The connection carried something this build could not read, so it was closed."
        }
        C::UnsupportedMessage => "That is something this build does not know how to do.",
        C::NoRelayReachable => {
            "No route to the gateway was found. Check the network at either end."
        }
        C::PeerUnreachable => "The gateway did not answer.",
        C::Timeout => "That took too long and was given up on rather than left hanging.",
        C::Cancelled => "Cancelled.",
        C::RebootstrapRequired => {
            "This device has to take a fresh copy of the vault before it can catch up."
        }
        C::InvalidRequest => {
            "That request does not make sense to this build, and nothing was changed."
        }
        C::SnapshotUnavailable => "The gateway has nowhere to build a copy of the vault right now.",
        C::IntentHashMismatch => {
            "That request does not match what was submitted with it, so it was not run."
        }
        C::IntentIdReused => {
            "That request was already answered once, with different contents. Start it again."
        }
        C::IntentOutcomeExpired => {
            "The answer to that request is too old to reuse. Send it again as a new one."
        }
        C::ReadSetIncomplete => {
            "That change did not declare everything it reads, so it was refused rather than run \
             on a guess."
        }
        C::OnlineOnly => "That one needs the gateway, and this device cannot reach it.",
        C::Denied => "That is not allowed for this app.",
        C::DowngradeRefused => {
            "This vault was written by a newer version of Centraid. Update this one rather than \
             risk the file."
        }
        C::UpgradeRequired => "This vault needs an upgrade this version does not carry.",
        C::NotYetAvailable => "That part is not built yet.",
        C::Internal => {
            "Centraid hit a problem of its own and stopped rather than carry on. Restarting it is \
             safe."
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

    /// **NO REFUSAL PAYLOAD SHIPS SQL.** The demonstrated red for lane E
    /// finding 2 (#1020 wave 3).
    ///
    /// The refusal a member actually saw was a SQLite `RAISE(ABORT)` from an
    /// entity-kind trigger, reaching the screen through `Error.detail` because
    /// that was the only string the message carried. The sentence is now built
    /// from the code, so the trigger's words cannot get into it — and `detail`
    /// still carries them, because the audit trail is what they are for.
    #[test]
    fn the_owner_facing_sentence_carries_no_database_text_and_the_detail_still_does() {
        // Verbatim, from `contracts/schema/vault-ddl.sql`'s trigger and from
        // lane E's Kotlin run through the real C ABI.
        let raised = "entity id is already held by another kind: core_party (#916)";
        let error = CoreError::Vault(centraid_vault::VaultError::Invariant {
            context: raised.to_owned(),
        });
        let wire = error.to_wire();

        assert!(
            wire.detail.contains(raised),
            "the audit trail keeps the predicate: {}",
            wire.detail
        );
        assert!(
            !wire.sentence.contains(raised),
            "and the owner-facing sentence does not: {}",
            wire.sentence
        );
        assert_eq!(wire.code, ErrorCode::Internal as i32);

        // And not by luck: nothing that looks like a schema object or a SQL
        // keyword appears in ANY code's sentence.
        for code in EVERY_CODE {
            let sentence = sentence_for_code(code);
            assert!(!sentence.is_empty(), "{code:?} has no sentence");
            let lowered = sentence.to_lowercase();
            // SQL-SHAPED, not merely English: `update` is a word an owner
            // reads ("update this one"), `update ... set` is a statement.
            for fragment in [
                "select ",
                "insert into",
                "delete from",
                " set ",
                "raise(",
                "sqlite",
                "pragma ",
                "constraint",
                "core_",
                "knowledge_",
                "media_",
                "_json",
                "#916",
                "(#",
            ] {
                assert!(
                    !lowered.contains(fragment),
                    "`{code:?}`'s sentence contains `{fragment}`: {sentence}"
                );
            }
        }
    }

    /// Every code the enum carries, so the sweep above cannot miss one: a new
    /// code with no sentence is a code whose refusal renders as nothing.
    const EVERY_CODE: [ErrorCode; 22] = [
        ErrorCode::Unspecified,
        ErrorCode::Unauthorized,
        ErrorCode::VersionWindow,
        ErrorCode::MalformedFrame,
        ErrorCode::UnsupportedMessage,
        ErrorCode::NoRelayReachable,
        ErrorCode::PeerUnreachable,
        ErrorCode::Timeout,
        ErrorCode::Cancelled,
        ErrorCode::RebootstrapRequired,
        ErrorCode::InvalidRequest,
        ErrorCode::SnapshotUnavailable,
        ErrorCode::IntentHashMismatch,
        ErrorCode::IntentIdReused,
        ErrorCode::IntentOutcomeExpired,
        ErrorCode::ReadSetIncomplete,
        ErrorCode::OnlineOnly,
        ErrorCode::Denied,
        ErrorCode::DowngradeRefused,
        ErrorCode::UpgradeRequired,
        ErrorCode::NotYetAvailable,
        ErrorCode::Internal,
    ];
}
