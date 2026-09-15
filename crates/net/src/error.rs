//! Typed connect failures, and the `ConnectivityEvent` each becomes (#1020,
//! D-1020-C9).
//!
//! Every failure below is one a member can be told something about, which is
//! the whole point of the enum: v0's transport surfaced a string, and a shell
//! that cannot distinguish "no relay is reachable" from "your gateway is off"
//! renders the same unhelpful sentence for both. `Timeout` exists as its own
//! variant rather than as a flavour of `PeerUnreachable` because a timeout is
//! the answer when the product does not KNOW, and saying "your gateway is off"
//! when the truth is "we gave up after ten seconds" is a lie the member acts
//! on.

use centraid_api_proto::core_v1::{
    ConnectivityEvent, ConnectivityState, ErrorCode, UpgradeRequired,
};

#[derive(Debug, thiserror::Error)]
pub enum ConnectError {
    /// Relays were configured and none answered. The product depends on relay
    /// availability whenever hole-punching fails (#1020 Decision), so this is a
    /// first-class state and not an internal error.
    #[error("no relay was reachable; a direct path was not found either")]
    NoRelayReachable,

    /// The peer is addressable and did not answer.
    #[error("the gateway did not answer")]
    PeerUnreachable,

    /// The remote endpoint is not an enrolled, unrevoked device. Unknown and
    /// revoked are the same refusal
    /// (`packages/vault/src/gateway/identity.ts:27-35`).
    #[error("this device is not enrolled on that gateway, or its enrolment was revoked")]
    Unauthorized,

    /// The version window refused the peer.
    #[error("the version window refused the peer")]
    VersionWindow(UpgradeRequired),

    /// The bounded connect budget elapsed. NEVER A HANG (D-1020-C9).
    #[error("the connection attempt timed out after {0:?}")]
    Timeout(std::time::Duration),

    /// The endpoint could not be bound, or a stream failed mid-protocol.
    #[error("{0}")]
    Protocol(#[from] centraid_protocol::ProtocolError),

    #[error("the iroh endpoint: {0}")]
    Endpoint(String),

    /// A stream failed at the i/o layer. Routed through `ProtocolError` when it
    /// came from the framing codec; this is the direct case, a flush or a write
    /// on an iroh stream.
    #[error("i/o: {0}")]
    Io(#[from] std::io::Error),
}

impl ConnectError {
    pub fn code(&self) -> ErrorCode {
        match self {
            Self::NoRelayReachable => ErrorCode::NoRelayReachable,
            Self::PeerUnreachable | Self::Endpoint(_) => ErrorCode::PeerUnreachable,
            Self::Unauthorized => ErrorCode::Unauthorized,
            Self::VersionWindow(_) => ErrorCode::VersionWindow,
            Self::Timeout(_) => ErrorCode::Timeout,
            Self::Protocol(error) => error.code(),
            Self::Io(_) => ErrorCode::PeerUnreachable,
        }
    }

    /// The event a shell renders. Every connect failure becomes one of these —
    /// the shell never learns about a failure any other way, which is what
    /// makes "the renderer sees connectivity state" (#1020, desktop modes) true
    /// rather than a promise.
    pub fn event(&self) -> ConnectivityEvent {
        ConnectivityEvent {
            state: ConnectivityState::Failed as i32,
            code: self.code() as u32,
            relay_url: String::new(),
        }
    }

    /// Would retrying help? A member-facing distinction: `Unauthorized` and
    /// `VersionWindow` need a person to do something, and a shell that retries
    /// them forever shows a spinner instead of the instruction.
    pub fn is_worth_retrying(&self) -> bool {
        match self {
            Self::NoRelayReachable
            | Self::PeerUnreachable
            | Self::Timeout(_)
            | Self::Endpoint(_) => true,
            Self::Unauthorized | Self::VersionWindow(_) => false,
            Self::Protocol(error) => error.is_fatal_to_the_stream(),
            Self::Io(_) => true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn every_failure_has_its_own_wire_code() {
        let failures = [
            ConnectError::NoRelayReachable,
            ConnectError::PeerUnreachable,
            ConnectError::Unauthorized,
            ConnectError::Timeout(Duration::from_secs(10)),
        ];
        let codes: Vec<ErrorCode> = failures.iter().map(ConnectError::code).collect();
        assert_eq!(
            codes,
            [
                ErrorCode::NoRelayReachable,
                ErrorCode::PeerUnreachable,
                ErrorCode::Unauthorized,
                ErrorCode::Timeout,
            ]
        );
        // Distinct, so a shell can branch. A collapsed pair here is how two
        // different member problems get one sentence.
        for (index, code) in codes.iter().enumerate() {
            for (other_index, other) in codes.iter().enumerate() {
                if index != other_index {
                    assert_ne!(code, other);
                }
            }
        }
    }

    /// A timeout is not "your gateway is off". The distinction is the reason
    /// the variant exists, and this test is what keeps a later refactor from
    /// folding it into `PeerUnreachable`.
    #[test]
    fn a_timeout_is_not_the_same_answer_as_an_unreachable_peer() {
        assert_ne!(
            ConnectError::Timeout(Duration::from_secs(10)).code(),
            ConnectError::PeerUnreachable.code()
        );
    }

    #[test]
    fn only_the_failures_a_person_must_act_on_stop_the_retry_loop() {
        assert!(ConnectError::NoRelayReachable.is_worth_retrying());
        assert!(ConnectError::PeerUnreachable.is_worth_retrying());
        assert!(ConnectError::Timeout(Duration::from_secs(1)).is_worth_retrying());
        assert!(!ConnectError::Unauthorized.is_worth_retrying());
        assert!(
            !ConnectError::VersionWindow(UpgradeRequired::default()).is_worth_retrying(),
            "a shell that retries an upgrade shows a spinner instead of the instruction"
        );
    }

    #[test]
    fn a_failure_becomes_a_failed_connectivity_event_carrying_its_code() {
        let event = ConnectError::Unauthorized.event();
        assert_eq!(event.state, ConnectivityState::Failed as i32);
        assert_eq!(event.code, ErrorCode::Unauthorized as u32);
    }
}
