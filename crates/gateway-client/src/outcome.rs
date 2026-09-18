//! What came back, and which of it a phone is allowed to act on (#1029 §3, W5B-1).
//!
//! # A REFUSAL IS A CODE, AND THE CLIENT'S JOB IS TO BRANCH ON IT
//!
//! The gateway never sends a member-facing sentence — `error.proto` says so for
//! every refusal in this product, and `gateway-core`'s `Refusal` says it again.
//! So this module turns the wire's code back into a typed thing, and the shell
//! turns *that* into words. Three of the codes are behaviour and the rest are
//! shown; the table is in [`crate`]'s header.
//!
//! # THE COMPANION TRAVELS WITH THE REFUSAL, NOT AFTER IT
//!
//! `ERROR_CODE_VAULT_MOVED` without its `VaultMoved` is half an answer: a phone
//! learns THAT its vault moved and never when, which is half of "N changes
//! since `<date>`" — and a client that filled the date in from its own clock
//! would be inventing the one fact the refusal exists to carry (W5 lane A, on
//! `Error.moved`). The same holds for `ERROR_CODE_VERSION_WINDOW`, whose range
//! `version::admit` puts in the refusal precisely "so the phone can render the
//! typed state without a second round trip".
//!
//! [`ErrorBody`] therefore carries both companions, and they are `Option`s
//! because a *body-less* code has none — not because a phone may shrug when one
//! is missing. [`ClientError::from_body`] refuses to invent either.

use centraid_api_proto::core_v1::ErrorCode;
use centraid_gateway_core::error::Refusal;
use serde::{Deserialize, Serialize};

use crate::transport::TransportError;

/// A refusal as the HTTP adapters render it.
///
/// The field names are the wire's and are shared with `centraid-gateway-server`
/// by being written the same on both sides — the server renders, the client
/// reads, and the round trip is asserted in `tests/over_the_wire.rs` against a
/// real socket rather than against this struct.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ErrorBody {
    /// The code, as `Refusal::code()` produced it.
    pub code: String,
    /// The server's clock, so a phone with a wrong one can re-sign **once**.
    pub server_time_ms: i64,
    /// `VaultMoved`'s companion: which epoch holds the vault now, and when it
    /// took it. Present exactly when `code` is the moved one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub moved: Option<MovedBody>,
    /// `VersionWindow`'s companion: the range the server supports. Present
    /// exactly when `code` is the version one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol: Option<ProtocolBody>,
}

/// `centraid.core.v1.VaultMoved`, on the HTTP wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct MovedBody {
    /// The lease epoch that holds the vault now.
    pub current_epoch: u64,
    /// When it took it, on the **server's** clock.
    pub moved_at_ms: i64,
}

/// The server's supported protocol range.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProtocolBody {
    /// Inclusive.
    pub min: u32,
    /// Inclusive.
    pub max: u32,
}

/// Which side of a protocol mismatch needs an update.
///
/// Both arms exist because it is one comparison seen from two ends
/// ([`centraid_gateway_core::version::Skew`]) and the sentences differ. The
/// client latches the first arm: a server below this phone's minimum is one
/// this phone **writes nothing to**.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServerNeeds {
    /// The server is below this phone's minimum. The typed "this server needs
    /// an update" state, and no write.
    Update { server: (u32, u32) },
    /// This phone is below the server's minimum.
    PhoneUpdate { server: (u32, u32) },
}

/// Everything a call to a gateway can come back as, other than the answer.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ClientError {
    /// The gateway could not be reached. **Not a refusal** — see
    /// [`TransportError`].
    #[error(transparent)]
    Transport(#[from] TransportError),

    /// THE VAULT MOVED. The shell freezes that vault read-only, shows the
    /// unacked spool as "N changes since `<date>`", and keeps it (F1). Nothing
    /// is wiped and nothing is taken back automatically.
    #[error("gateway: the vault moved to another device")]
    Moved {
        /// The lease epoch that holds it now.
        current_epoch: u64,
        /// When, on the server's clock.
        moved_at_ms: i64,
    },

    /// One side is outside the other's protocol range.
    #[error("gateway: protocol version")]
    Version(ServerNeeds),

    /// **The skew answer was spent and the clock is still wrong.** A second
    /// skew refusal on a re-signed request is a real failure and not a clock
    /// ([`Refusal::is_retryable_once`]), so the client stops here rather than
    /// hammering a server whose clock is the broken one.
    #[error("gateway: the clock is still outside the window after one correction")]
    ClockUnrecoverable {
        /// What the server said its time was, the second time.
        server_time_ms: i64,
    },

    /// Any other refusal. The code is the answer; the shell derives the words.
    #[error("gateway refused: {code:?}")]
    Refused {
        /// The code.
        code: ErrorCode,
        /// The status it arrived under, for a log line.
        status: u16,
    },

    /// The answer did not decode. A gateway that sends this is broken, and the
    /// phone shows the same thing it shows for an internal error.
    #[error("the gateway's answer did not decode: {reason}")]
    Malformed {
        /// For a log line.
        reason: String,
    },
}

impl ClientError {
    /// Turn one refusal body into the typed error the shell branches on.
    ///
    /// A companion that should be there and is not becomes
    /// [`Self::Malformed`] rather than a default: a `VAULT_MOVED` with no
    /// moment would let a shell draw "0 changes since 1 January 1970" over a
    /// frozen vault, which is worse than an error, because it reads like a
    /// fact.
    #[must_use]
    pub fn from_body(status: u16, body: &ErrorBody) -> Self {
        let Some(code) = code_of(&body.code) else {
            return Self::Malformed {
                reason: format!("unknown error code {:?}", body.code),
            };
        };
        match code {
            ErrorCode::VaultMoved => body.moved.map_or_else(
                || Self::Malformed {
                    reason: "a moved refusal with no VaultMoved companion".to_owned(),
                },
                |moved| Self::Moved {
                    current_epoch: moved.current_epoch,
                    moved_at_ms: moved.moved_at_ms,
                },
            ),
            ErrorCode::VersionWindow => body.protocol.map_or_else(
                || Self::Malformed {
                    reason: "a version refusal with no range".to_owned(),
                },
                |range| {
                    Self::Version(needs(
                        (range.min, range.max),
                        (crate::CLIENT_PROTOCOL_MIN, crate::CLIENT_PROTOCOL_MAX),
                    ))
                },
            ),
            code => Self::Refused { code, status },
        }
    }
}

/// Which side needs an update, from the two ranges.
///
/// It is [`centraid_gateway_core::version::negotiate`]'s answer and not a
/// second comparison — that module exists exactly so a phone and a server
/// cannot disagree about whose fault a mismatch is.
#[must_use]
pub fn needs(server: (u32, u32), client: (u32, u32)) -> ServerNeeds {
    use centraid_gateway_core::version::{Range, Skew, negotiate};

    match negotiate(
        Range::new(server.0, server.1),
        Range::new(client.0, client.1),
    ) {
        Skew::ServerTooOld => ServerNeeds::Update { server },
        // A phone that agrees with the server has no business being here: the
        // caller only builds a `ServerNeeds` from a refusal. An `Agreed` that
        // reached this arm means the SERVER refused a version it advertises, so
        // the phone is the one that cannot proceed.
        Skew::ClientTooOld | Skew::Agreed(_) => ServerNeeds::PhoneUpdate { server },
    }
}

/// Every code a gateway's refusal can carry, so a wire spelling can be read
/// back into one.
///
/// **It is derived from `Refusal` rather than from the enum**: the wire
/// spelling is `format!("{code:?}")` on the adapters' side, and the set of
/// codes that can appear is exactly `Refusal::code()`'s range.
/// `every_refusal_this_product_has_survives_its_wire_spelling` walks every
/// variant and would fail the moment a new refusal is minted without a client
/// that can read it.
const GATEWAY_CODES: &[ErrorCode] = &[
    ErrorCode::Unauthorized,
    ErrorCode::VersionWindow,
    ErrorCode::InvalidRequest,
    ErrorCode::VaultMoved,
    ErrorCode::Internal,
    ErrorCode::GatewaySignatureInvalid,
    ErrorCode::GatewayClockSkew,
    ErrorCode::GatewayChecksumMissing,
    ErrorCode::GatewayChecksumMismatch,
    ErrorCode::GatewayAlreadyCommitted,
    ErrorCode::GatewayObjectUnknown,
    ErrorCode::GatewayObjectTooLarge,
    ErrorCode::GatewayHeadConflict,
    ErrorCode::GatewayLeaseStale,
    ErrorCode::GatewayNotLeaseHolder,
    ErrorCode::GatewayQuotaExceeded,
    ErrorCode::GatewayPlanLapsed,
    ErrorCode::GatewayDeleteRefused,
    ErrorCode::GatewayCapabilityScope,
    ErrorCode::GatewayMailboxRefused,
];

/// Read a wire spelling back into a code.
#[must_use]
pub fn code_of(spelling: &str) -> Option<ErrorCode> {
    GATEWAY_CODES
        .iter()
        .copied()
        .find(|code| format!("{code:?}") == spelling)
}

/// How a refusal is spelled on the wire. One function, used by the adapters to
/// render and by this crate to read, so the two cannot drift.
#[must_use]
pub fn spelling_of(refusal: &Refusal) -> String {
    format!("{:?}", refusal.code())
}

#[cfg(test)]
mod tests {
    use centraid_gateway_core::checksum::ChecksumFault;
    use centraid_gateway_core::error::MailboxFault;
    use centraid_gateway_core::ids::ObjectName;
    use centraid_gateway_core::retention::DeleteRefusal;
    use centraid_gateway_core::time::{Duration, ServerTime};

    use super::*;

    fn every_refusal() -> Vec<Refusal> {
        vec![
            Refusal::SignatureInvalid,
            Refusal::ClockSkew {
                server_time: ServerTime::from_millis(1),
                window: Duration::from_millis(1),
            },
            Refusal::VersionWindow {
                server: (1, 1),
                client: 9,
            },
            Refusal::Checksum(ChecksumFault::Missing),
            Refusal::Checksum(ChecksumFault::Mismatch),
            Refusal::AlreadyCommitted(ObjectName::of(b"a")),
            Refusal::ObjectUnknown(ObjectName::of(b"a")),
            Refusal::ObjectTooLarge {
                declared: 1,
                cap: 1,
            },
            Refusal::MalformedGeneration,
            Refusal::HeadConflict { current: None },
            Refusal::LeaseStale {
                held: 2,
                claimed: 1,
            },
            Refusal::NotLeaseHolder,
            Refusal::VaultMoved {
                current_epoch: 2,
                moved_at: ServerTime::from_millis(7),
            },
            Refusal::UnknownVault,
            Refusal::QuotaExceeded {
                quota_bytes: 1,
                used_bytes: 1,
                wanted_bytes: 1,
            },
            Refusal::PlanLapsed,
            Refusal::PlanExpired,
            Refusal::DeleteRefused(DeleteRefusal::AppendOnly),
            Refusal::CapabilityScope,
            Refusal::MailboxRefused(MailboxFault::TooLarge),
        ]
    }

    /// EVERY REFUSAL THIS PRODUCT HAS SURVIVES ITS WIRE SPELLING. A new refusal
    /// minted without a client that can read it fails here, rather than on a
    /// phone that shows "the gateway's answer did not decode" to somebody whose
    /// quota ran out.
    #[test]
    fn every_refusal_this_product_has_survives_its_wire_spelling() {
        for refusal in every_refusal() {
            let spelling = spelling_of(&refusal);
            assert_eq!(
                code_of(&spelling),
                Some(refusal.code()),
                "{refusal:?} spells {spelling} and no client code reads it"
            );
        }
    }

    /// A MOVED REFUSAL WITH NO MOMENT IS MALFORMED, never a zero. A shell that
    /// drew "0 changes since 1 January 1970" over a frozen vault would be
    /// showing a fabricated fact, which is worse than an error.
    #[test]
    fn a_moved_refusal_with_no_companion_is_malformed_rather_than_defaulted() {
        let body = ErrorBody {
            code: spelling_of(&Refusal::VaultMoved {
                current_epoch: 3,
                moved_at: ServerTime::from_millis(9),
            }),
            server_time_ms: 10,
            moved: None,
            protocol: None,
        };
        assert!(matches!(
            ClientError::from_body(409, &body),
            ClientError::Malformed { .. }
        ));
    }

    #[test]
    fn a_moved_refusal_carries_the_epoch_and_the_moment_through() {
        let body = ErrorBody {
            code: format!("{:?}", ErrorCode::VaultMoved),
            server_time_ms: 10,
            moved: Some(MovedBody {
                current_epoch: 3,
                moved_at_ms: 9,
            }),
            protocol: None,
        };
        assert_eq!(
            ClientError::from_body(409, &body),
            ClientError::Moved {
                current_epoch: 3,
                moved_at_ms: 9,
            }
        );
    }

    /// A SERVER A YEAR BEHIND THE PHONE IN SOMEBODY'S POCKET. The self-hoster
    /// case, and the one where the phone must write nothing.
    #[test]
    fn a_server_below_this_phones_minimum_needs_an_update() {
        assert_eq!(
            needs((0, 0), (1, 1)),
            ServerNeeds::Update { server: (0, 0) }
        );
        assert_eq!(
            needs((4, 6), (1, 1)),
            ServerNeeds::PhoneUpdate { server: (4, 6) }
        );
    }

    /// A refusal a phone cannot read is not a refusal it may guess at.
    #[test]
    fn a_code_a_newer_server_invented_is_malformed() {
        let body = ErrorBody {
            code: "SomethingANewerServerInvented".to_owned(),
            server_time_ms: 1,
            moved: None,
            protocol: None,
        };
        assert!(matches!(
            ClientError::from_body(400, &body),
            ClientError::Malformed { .. }
        ));
    }

    #[test]
    fn the_unauthorized_and_moved_codes_stay_different_answers() {
        let unauthorized = ErrorBody {
            code: format!("{:?}", ErrorCode::Unauthorized),
            server_time_ms: 1,
            moved: None,
            protocol: None,
        };
        assert!(matches!(
            ClientError::from_body(401, &unauthorized),
            ClientError::Refused {
                code: ErrorCode::Unauthorized,
                ..
            }
        ));
    }

    /// The companions are optional on the wire and absent when they do not
    /// apply, so an older body still decodes.
    #[test]
    fn a_body_without_companions_decodes() {
        let decoded: ErrorBody =
            serde_json::from_str(r#"{"code":"GatewayQuotaExceeded","server_time_ms":5}"#)
                .expect("decodes");
        assert_eq!(decoded.moved, None);
        assert_eq!(decoded.protocol, None);
    }
}
