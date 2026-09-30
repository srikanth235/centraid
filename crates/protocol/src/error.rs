//! Typed protocol errors, and the one mapping onto the wire's `ErrorCode`.
//!
//! Every variant here is either a local fault (a bad frame, a closed stream) or
//! a peer's refusal. None of them carries a sentence for a member: the wire's
//! `Error.detail` is for logs, and the member-facing sentence comes from the
//! shell or from a command's author (see `error.proto`).

use centraid_api_proto::core_v1::{ErrorCode, UpgradeRequired};

pub type Result<T> = std::result::Result<T, ProtocolError>;

#[derive(Debug, thiserror::Error)]
pub enum ProtocolError {
    /// A length prefix of zero. Not an empty message — see `framing`.
    #[error(
        "a frame length of zero: an empty Envelope and a zero prefix would be the same bytes, so zero is refused"
    )]
    EmptyFrame,

    #[error("frame length {len} is over the {max}-byte ceiling")]
    FrameTooLarge { len: usize, max: usize },

    #[error("the stream closed after {got} of 4 prefix bytes")]
    TruncatedPrefix { got: usize },

    #[error("the stream closed inside a frame body of {expected} bytes")]
    TruncatedBody { expected: usize },

    #[error("the frame did not decode as the expected message: {0}")]
    Decode(#[from] prost::DecodeError),

    /// An `Envelope` with no `body`. Distinct from a decode failure: the bytes
    /// were well-formed protobuf and said nothing.
    #[error("an Envelope carrying no body")]
    EmptyEnvelope,

    /// A `Request`/`Response`/`Event` whose `oneof` is a variant this build
    /// does not know, or is unset. The answer is `Unsupported{type_url}`, never
    /// a dropped message (#1020 Compatibility).
    #[error("a message type this build does not know: {type_url}")]
    UnsupportedMessage { type_url: String },

    /// The version window does not admit the peer. Carries the
    /// `UpgradeRequired` that must go out BEFORE any other message.
    #[error(
        "the version window does not admit the peer: local {}/{} against peer {}/{}",
        .0.schema_version, .0.min_supported, .0.peer_schema_version, .0.peer_min_supported
    )]
    VersionWindow(UpgradeRequired),

    /// A request id that is zero (reserved for the handshake) or already in
    /// flight. Ids are per connection, monotonic and never reused, so either
    /// is a bug on this side of the wire rather than a peer's fault.
    #[error("request id {0} is not usable: zero is the handshake and an id is never reused")]
    BadRequestId(u64),

    /// A `Cancel` naming a bounded read. Bounded reads are never cancellable
    /// and are bounded instead (#1020 Execution model).
    #[error("request {0} is a bounded read and bounded reads are not cancellable")]
    NotCancellable(u64),

    #[error("the request was cancelled")]
    Cancelled,

    #[error("i/o: {0}")]
    Io(#[from] std::io::Error),
}

impl ProtocolError {
    /// The wire code a peer is told. A shell switches on this and never on the
    /// `Display` text.
    pub fn code(&self) -> ErrorCode {
        match self {
            Self::EmptyFrame
            | Self::FrameTooLarge { .. }
            | Self::TruncatedPrefix { .. }
            | Self::TruncatedBody { .. }
            | Self::Decode(_)
            | Self::EmptyEnvelope => ErrorCode::MalformedFrame,
            Self::UnsupportedMessage { .. } => ErrorCode::UnsupportedMessage,
            Self::VersionWindow(_) => ErrorCode::VersionWindow,
            Self::BadRequestId(_) | Self::NotCancellable(_) => ErrorCode::InvalidRequest,
            Self::Cancelled => ErrorCode::Cancelled,
            Self::Io(_) => ErrorCode::PeerUnreachable,
        }
    }

    /// Does this error mean the stream's position is no longer known? A framing
    /// fault does; a refused request does not. The caller uses it to decide
    /// between closing the connection and answering the request.
    pub fn is_fatal_to_the_stream(&self) -> bool {
        matches!(
            self,
            Self::EmptyFrame
                | Self::FrameTooLarge { .. }
                | Self::TruncatedPrefix { .. }
                | Self::TruncatedBody { .. }
                | Self::Io(_)
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A framing fault is fatal to the stream and a refusal is not. Getting
    /// this backwards is how a protocol either drops working connections or
    /// keeps reading from a stream whose position it has lost.
    #[test]
    fn only_framing_faults_are_fatal_to_the_stream() {
        assert!(ProtocolError::EmptyFrame.is_fatal_to_the_stream());
        assert!(ProtocolError::FrameTooLarge { len: 1, max: 0 }.is_fatal_to_the_stream());
        assert!(ProtocolError::TruncatedBody { expected: 4 }.is_fatal_to_the_stream());
        assert!(!ProtocolError::NotCancellable(3).is_fatal_to_the_stream());
        assert!(!ProtocolError::Cancelled.is_fatal_to_the_stream());
        assert!(
            !ProtocolError::UnsupportedMessage {
                type_url: "x".to_owned()
            }
            .is_fatal_to_the_stream()
        );
    }

    #[test]
    fn every_error_maps_onto_a_named_wire_code() {
        assert_eq!(ProtocolError::EmptyFrame.code(), ErrorCode::MalformedFrame);
        assert_eq!(ProtocolError::Cancelled.code(), ErrorCode::Cancelled);
        assert_eq!(
            ProtocolError::BadRequestId(0).code(),
            ErrorCode::InvalidRequest
        );
        assert_ne!(ProtocolError::EmptyFrame.code(), ErrorCode::Unspecified);
    }
}
