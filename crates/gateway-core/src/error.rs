//! What a gateway refuses, and the wire code for each refusal.
//!
//! **The mapping lives beside the rules, not in each adapter.** An adapter that
//! chose its own code for "the compare-and-set lost" would be an adapter the
//! phone branches on differently, and the phone cannot tell which deployment it
//! is talking to — that is the whole premise (§3).
//!
//! Every variant is a *code*, never a member-facing sentence. The sentence is
//! derived from the code by the shell, which is the rule `error.proto` already
//! states for every other refusal in this product.

use centraid_api_proto::core_v1::ErrorCode;

use crate::checksum::ChecksumFault;
use crate::ids::ObjectName;
use crate::retention::DeleteRefusal;
use crate::time::{Duration, ServerTime};

/// Every way a gateway says no.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Refusal {
    /// The signature did not verify, or the certificate did not chain to the
    /// vault's identity key. Unknown and invalid are the same refusal.
    #[error("gateway: signature invalid")]
    SignatureInvalid,

    /// The request timestamp is outside the replay window. It carries the
    /// **server's** time so the client can re-sign once (Reference B).
    #[error("gateway: clock skew")]
    ClockSkew {
        server_time: ServerTime,
        window: Duration,
    },

    /// The protocol version is outside the range one side supports. Carried in
    /// both directions, because "the server is too old" and "the phone is too
    /// old" are the same comparison seen from two ends.
    #[error("gateway: protocol version")]
    VersionWindow { server: (u32, u32), client: u32 },

    /// The checksum rule, in whichever mode this store supports.
    #[error("gateway: checksum")]
    Checksum(ChecksumFault),

    /// A presign was asked for a name that is already committed. Storage is
    /// write-once; a name is the hash of its bytes.
    #[error("gateway: already committed")]
    AlreadyCommitted(ObjectName),

    /// A commit named an object that was never declared, or never uploaded.
    #[error("gateway: object unknown")]
    ObjectUnknown(ObjectName),

    /// Above the 16 MiB cap (F6). A bigger file is a list of objects.
    #[error("gateway: object too large")]
    ObjectTooLarge { declared: u64, cap: u64 },

    /// The generation id was not 32 hex characters. A client does not get to
    /// choose the gateway's keyspace.
    #[error("gateway: malformed generation")]
    MalformedGeneration,

    /// THE COMPARE-AND-SET LOST (F7). The loser is told the current head and
    /// re-reads; it does not clobber.
    #[error("gateway: head conflict")]
    HeadConflict { current: Option<ObjectName> },

    /// The lease claim's epoch is at or below the one the gateway holds.
    #[error("gateway: lease stale")]
    LeaseStale { held: u64, claimed: u64 },

    /// This device does not hold the lease, and never did.
    #[error("gateway: not the lease holder")]
    NotLeaseHolder,

    /// THE VAULT MOVED. A superseded device is not a stranger, and the answer
    /// differs: the phone freezes that vault read-only and keeps its spool.
    #[error("gateway: vault moved")]
    VaultMoved {
        current_epoch: u64,
        moved_at: ServerTime,
    },

    /// The vault, or its account, is not registered here.
    #[error("gateway: unknown vault")]
    UnknownVault,

    /// The quota is spent. Keys are free to mint, so an unbounded free tier is
    /// unbounded Sybil storage (F13).
    #[error("gateway: quota exceeded")]
    QuotaExceeded {
        quota_bytes: u64,
        used_bytes: u64,
        wanted_bytes: u64,
    },

    /// The plan lapsed: read-only, and retained for a stated period. Restore
    /// still works (F13).
    #[error("gateway: plan lapsed")]
    PlanLapsed,

    /// The stated retention period after a lapse ended.
    #[error("gateway: plan expired")]
    PlanExpired,

    /// A tombstone was refused by the floor, the size guard, the rate limit or
    /// the append-only flag (F4, F10).
    #[error("gateway: tombstone refused")]
    DeleteRefused(DeleteRefusal),

    /// A capability does not cover what was asked for, or it was revoked or has
    /// expired.
    #[error("gateway: capability scope")]
    CapabilityScope,

    /// A mailbox deposit exceeded the capability's size cap or its rate limit,
    /// or the capability has expired. Deposits are unsigned, so one leaked
    /// capability must not fill a mailbox.
    #[error("gateway: mailbox refused")]
    MailboxRefused(MailboxFault),
}

/// Why a mailbox deposit was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MailboxFault {
    /// The capability's signature did not verify against the mailbox's own key.
    NotIssuedByRecipient,
    /// Past `expires_at_ms`.
    CapabilityExpired,
    /// The capability was revoked. Revocation takes effect immediately.
    CapabilityRevoked,
    /// Over the per-deposit size cap.
    TooLarge,
    /// Over the per-capability rate limit.
    RateLimited,
}

impl Refusal {
    /// The wire code. One mapping, so both adapters answer the same request the
    /// same way.
    #[must_use]
    pub const fn code(&self) -> ErrorCode {
        match self {
            Self::SignatureInvalid => ErrorCode::GatewaySignatureInvalid,
            Self::ClockSkew { .. } => ErrorCode::GatewayClockSkew,
            Self::VersionWindow { .. } => ErrorCode::VersionWindow,
            Self::Checksum(ChecksumFault::Missing) => ErrorCode::GatewayChecksumMissing,
            Self::Checksum(_) => ErrorCode::GatewayChecksumMismatch,
            Self::AlreadyCommitted(_) => ErrorCode::GatewayAlreadyCommitted,
            Self::ObjectUnknown(_) => ErrorCode::GatewayObjectUnknown,
            Self::ObjectTooLarge { .. } => ErrorCode::GatewayObjectTooLarge,
            // A generation id that is not 32 hex characters is a malformed
            // request, not a state: `INVALID_REQUEST` is the code this enum
            // already has for "the request is wrong, not the state".
            Self::MalformedGeneration => ErrorCode::InvalidRequest,
            Self::HeadConflict { .. } => ErrorCode::GatewayHeadConflict,
            Self::LeaseStale { .. } => ErrorCode::GatewayLeaseStale,
            Self::NotLeaseHolder => ErrorCode::GatewayNotLeaseHolder,
            Self::VaultMoved { .. } => ErrorCode::VaultMoved,
            // A stranger and an unregistered vault are the SAME refusal: a
            // gateway that distinguished them would be an oracle for which
            // identity keys it holds.
            Self::UnknownVault => ErrorCode::Unauthorized,
            Self::QuotaExceeded { .. } => ErrorCode::GatewayQuotaExceeded,
            Self::PlanLapsed | Self::PlanExpired => ErrorCode::GatewayPlanLapsed,
            Self::DeleteRefused(_) => ErrorCode::GatewayDeleteRefused,
            Self::CapabilityScope => ErrorCode::GatewayCapabilityScope,
            Self::MailboxRefused(_) => ErrorCode::GatewayMailboxRefused,
        }
    }

    /// Whether the phone should retry this request unchanged.
    ///
    /// Only one refusal is: a skew refusal, and exactly **once**, after the
    /// client applies the server's time. A second skew refusal on a re-signed
    /// request is a real failure and not a clock, and a client that retried
    /// forever would hammer a server whose clock is the broken one.
    #[must_use]
    pub const fn is_retryable_once(&self) -> bool {
        matches!(self, Self::ClockSkew { .. })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A SUPERSEDED DEVICE IS NOT A STRANGER. The two codes differ because the
    /// phone's answers differ: freeze the vault read-only, or show a refusal.
    #[test]
    fn vault_moved_and_unauthorized_are_different_codes() {
        let moved = Refusal::VaultMoved {
            current_epoch: 4,
            moved_at: ServerTime::from_millis(1),
        };
        assert_eq!(moved.code(), ErrorCode::VaultMoved);
        assert_eq!(Refusal::UnknownVault.code(), ErrorCode::Unauthorized);
        assert_ne!(moved.code(), Refusal::UnknownVault.code());
    }

    /// "No checksum" and "wrong checksum" are different codes, because R2
    /// stores the attestation only when the client sent it and an operator
    /// debugging one has to be able to tell them apart.
    #[test]
    fn a_missing_attestation_and_a_wrong_one_are_different_codes() {
        assert_eq!(
            Refusal::Checksum(ChecksumFault::Missing).code(),
            ErrorCode::GatewayChecksumMissing
        );
        assert_eq!(
            Refusal::Checksum(ChecksumFault::Mismatch).code(),
            ErrorCode::GatewayChecksumMismatch
        );
    }

    #[test]
    fn only_a_clock_skew_is_retryable_unchanged() {
        assert!(
            Refusal::ClockSkew {
                server_time: ServerTime::from_millis(0),
                window: Duration::from_secs(300),
            }
            .is_retryable_once()
        );
        assert!(!Refusal::NotLeaseHolder.is_retryable_once());
        assert!(
            !Refusal::HeadConflict { current: None }.is_retryable_once(),
            "a lost compare-and-set is re-read, never retried unchanged"
        );
    }
}
