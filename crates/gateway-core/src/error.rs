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

    /// A tombstone was refused by the floor, the size guard, the rate limit or
    /// the append-only flag (F4, F10).
    #[error("gateway: tombstone refused")]
    DeleteRefused(DeleteRefusal),

    /// A capability does not cover what was asked for, or it was revoked or has
    /// expired.
    #[error("gateway: capability scope")]
    CapabilityScope,
}

/// THE VAULT MOVED, AND WHEN.
///
/// A phone that learns only *that* its vault moved can freeze it; a phone that
/// learns *when* can tell the member how much is at stake. Dropping the time
/// and letting the shell default it draws "0 changes since 1 January 1970" over
/// a frozen vault, which is a fabricated fact rather than a missing one — so a
/// client reads a missing companion as malformed, and this is the value it
/// needs to find.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Moved {
    pub current_epoch: u64,
    pub moved_at_ms: i64,
}

/// Both ends of a version refusal, because "the server is too old" and "the
/// phone is too old" are the same comparison seen from two ends and the phone
/// shows a different state for each.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProtocolWindow {
    pub server_min: u32,
    pub server_max: u32,
    pub client: u32,
}

/// What a quota refusal has to say for a member to act on it: the ceiling, what
/// is already spent, and what this request wanted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Quota {
    pub quota_bytes: u64,
    pub used_bytes: u64,
    pub wanted_bytes: u64,
}

/// A lease refusal's two epochs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LeaseEpochs {
    pub held: u64,
    pub claimed: u64,
}

/// An over-size refusal's two numbers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SizeCap {
    pub declared_bytes: u64,
    pub cap_bytes: u64,
}

/// WHAT A REFUSAL CARRIES BESIDE ITS CODE, AND IT IS A RULE.
///
/// The code says *what* was refused. Almost every refusal a phone acts on also
/// needs a *value* — the epoch that superseded it and when, the head as it
/// stands now, the server's protocol range, the bytes left in a quota — and an
/// adapter that rendered the code and dropped the value would leave the phone
/// with a refusal it can display and not act on.
///
/// **This lives here and not in either adapter** for the same reason
/// [`Refusal::code`] does: two adapters each deciding what to put on the wire
/// are two adapters that will disagree, on a phone somebody is restoring. The
/// standalone adapter was dropping every one of these; the conformance suite's
/// `errors/a-refusal-carries-its-companions-on-the-wire` is what now stops
/// either of them from doing it again.
///
/// The server's own clock is **not** here: every error body carries it
/// unconditionally, because a phone with a wrong clock has to be able to
/// re-sign after any refusal, not only after a skew.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Companions {
    /// [`Refusal::VaultMoved`].
    pub moved: Option<Moved>,
    /// [`Refusal::VersionWindow`].
    pub protocol: Option<ProtocolWindow>,
    /// [`Refusal::ClockSkew`]'s replay window.
    pub skew_window_ms: Option<i64>,
    /// [`Refusal::HeadConflict`]'s current head. `None` inside a `Some`
    /// companion is a real answer — "there is no head" — and is why the
    /// conflict itself is reported as present with an absent head rather than
    /// as no companion at all.
    pub head: Option<Option<ObjectName>>,
    /// [`Refusal::QuotaExceeded`].
    pub quota: Option<Quota>,
    /// [`Refusal::LeaseStale`].
    pub lease: Option<LeaseEpochs>,
    /// [`Refusal::ObjectTooLarge`].
    pub size: Option<SizeCap>,
    /// The object [`Refusal::ObjectUnknown`] or [`Refusal::AlreadyCommitted`]
    /// names.
    pub object: Option<ObjectName>,
}

impl Companions {
    /// Every companion this refusal carries, flattened to `(name, value)`.
    ///
    /// The names are the **wire names**, and they are here rather than in an
    /// adapter's serializer so that a rename is one edit and not two. An
    /// adapter is free to nest them the way its body nests — `moved.at_ms` or
    /// `moved_at_ms` — as long as the name and the value both survive, which is
    /// exactly what the conformance case asks.
    #[must_use]
    pub fn fields(&self) -> Vec<(&'static str, String)> {
        let mut out = Vec::new();
        if let Some(moved) = self.moved {
            out.push(("current_epoch", moved.current_epoch.to_string()));
            out.push(("moved_at_ms", moved.moved_at_ms.to_string()));
        }
        if let Some(protocol) = self.protocol {
            out.push(("server_protocol_min", protocol.server_min.to_string()));
            out.push(("server_protocol_max", protocol.server_max.to_string()));
            out.push(("client_protocol", protocol.client.to_string()));
        }
        if let Some(window) = self.skew_window_ms {
            out.push(("skew_window_ms", window.to_string()));
        }
        if let Some(head) = self.head {
            out.push((
                "current_head",
                head.map(|name| name.hex()).unwrap_or_default(),
            ));
        }
        if let Some(quota) = self.quota {
            out.push(("quota_bytes", quota.quota_bytes.to_string()));
            out.push(("used_bytes", quota.used_bytes.to_string()));
            out.push(("wanted_bytes", quota.wanted_bytes.to_string()));
        }
        if let Some(lease) = self.lease {
            out.push(("held_epoch", lease.held.to_string()));
            out.push(("claimed_epoch", lease.claimed.to_string()));
        }
        if let Some(size) = self.size {
            out.push(("declared_bytes", size.declared_bytes.to_string()));
            out.push(("cap_bytes", size.cap_bytes.to_string()));
        }
        if let Some(object) = self.object {
            out.push(("object", object.hex()));
        }
        out
    }
}

impl Refusal {
    /// WHAT THIS REFUSAL CARRIES BESIDE ITS CODE. See [`Companions`].
    #[must_use]
    pub fn companions(&self) -> Companions {
        match *self {
            Self::VaultMoved {
                current_epoch,
                moved_at,
            } => Companions {
                moved: Some(Moved {
                    current_epoch,
                    moved_at_ms: moved_at.millis(),
                }),
                ..Companions::default()
            },
            Self::VersionWindow { server, client } => Companions {
                protocol: Some(ProtocolWindow {
                    server_min: server.0,
                    server_max: server.1,
                    client,
                }),
                ..Companions::default()
            },
            Self::ClockSkew { window, .. } => Companions {
                skew_window_ms: Some(window.millis()),
                ..Companions::default()
            },
            Self::HeadConflict { current } => Companions {
                head: Some(current),
                ..Companions::default()
            },
            Self::QuotaExceeded {
                quota_bytes,
                used_bytes,
                wanted_bytes,
            } => Companions {
                quota: Some(Quota {
                    quota_bytes,
                    used_bytes,
                    wanted_bytes,
                }),
                ..Companions::default()
            },
            Self::LeaseStale { held, claimed } => Companions {
                lease: Some(LeaseEpochs { held, claimed }),
                ..Companions::default()
            },
            Self::ObjectTooLarge { declared, cap } => Companions {
                size: Some(SizeCap {
                    declared_bytes: declared,
                    cap_bytes: cap,
                }),
                ..Companions::default()
            },
            Self::ObjectUnknown(object) | Self::AlreadyCommitted(object) => Companions {
                object: Some(object),
                ..Companions::default()
            },
            // These carry nothing a phone can act on beyond the code itself,
            // and the server's clock — which every body carries — is not a
            // companion.
            Self::SignatureInvalid
            | Self::Checksum(_)
            | Self::MalformedGeneration
            | Self::NotLeaseHolder
            | Self::UnknownVault
            | Self::DeleteRefused(_)
            | Self::CapabilityScope => Companions::default(),
        }
    }

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
            Self::DeleteRefused(_) => ErrorCode::GatewayDeleteRefused,
            Self::CapabilityScope => ErrorCode::GatewayCapabilityScope,
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

// ---------------------------------------------------------------------------
// The refusal body, and it is ONE declaration (#1029 W17-5)
// ---------------------------------------------------------------------------

/// A REFUSAL AS IT TRAVELS, DECLARED ONCE FOR BOTH ENDS.
///
/// It lived twice: `gateway-server` had a `Serialize`-only copy and
/// `gateway-client` a `Deserialize`-only one, written the same way by hand and
/// asserted equal by a round-trip test that constructed the client's struct
/// rather than reading the server's bytes. **They had already drifted.** The
/// server wrote `server_protocol_min` / `server_protocol_max` /
/// `client_protocol` and the client declared `min` / `max`, non-optional, so a
/// `VersionWindow` refusal did not deserialise at all: a phone that was merely
/// too new was told "the gateway's answer did not decode", which reads as a
/// broken server and is not one.
///
/// Two structs cannot be held equal by discipline, so there is one, and it is
/// **here** rather than in either end — the shape of a refusal is a fact about
/// the protocol, exactly as [`Refusal::code`] and [`Companions`] are. The
/// server renders it, the client reads it, and
/// `gateway-server/tests/wire_iroh.rs` moves the bytes between two processes'
/// worth of code to prove it.
///
/// `serde` is the one thing this adds to a crate that is otherwise a pure
/// state machine. It reaches no clock, no socket and no filesystem, so
/// `tests/pure_rules.rs` is unaffected — and the alternative was a hand-rolled
/// JSON writer, which is a second serializer to disagree with the first.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ErrorBody {
    /// The code from [`Refusal::code`], spelled `{code:?}`. **Never a
    /// sentence**: the member-facing wording is derived from the code by the
    /// shell, which is the rule `error.proto` already states for every other
    /// refusal in this product.
    pub code: String,
    /// The server's clock, so a phone with a wrong one can re-sign **once**.
    ///
    /// Not a companion: every body carries it, after any refusal, because a
    /// phone with a wrong clock has to be able to re-sign after all of them.
    pub server_time_ms: i64,
    /// `VAULT_MOVED`: which epoch superseded this device, and when.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub moved: Option<MovedBody>,
    /// `VERSION_WINDOW`: both ends of the comparison.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol: Option<ProtocolBody>,
    /// `GATEWAY_CLOCK_SKEW`: the replay window, beside the clock above.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skew_window_ms: Option<i64>,
    /// `GATEWAY_HEAD_CONFLICT`: the head as it stands now, hex. An **empty
    /// string** is a real answer — "there is no head" — and is why the
    /// conflict reports a present companion with an absent value rather than
    /// no companion at all.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_head: Option<String>,
    /// `GATEWAY_QUOTA_EXCEEDED`: the ceiling, what is spent, what was wanted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quota: Option<QuotaBody>,
    /// `GATEWAY_LEASE_STALE`: the two epochs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lease: Option<LeaseBody>,
    /// `GATEWAY_OBJECT_TOO_LARGE`: what was declared and the cap.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<SizeBody>,
    /// The object an unknown-object or already-committed refusal names, hex.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object: Option<String>,
}

/// See [`ErrorBody::moved`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct MovedBody {
    pub current_epoch: u64,
    pub moved_at_ms: i64,
}

/// See [`ErrorBody::protocol`].
///
/// **The field names are the server's**, because the server's are what is
/// already on the wire and what `Companions::pairs` spells; renaming them to
/// the client's shorter ones would have moved the bytes to fix a reader.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ProtocolBody {
    /// Inclusive.
    pub server_protocol_min: u32,
    /// Inclusive.
    pub server_protocol_max: u32,
    /// What the refused request asked for.
    pub client_protocol: u32,
}

/// See [`ErrorBody::quota`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct QuotaBody {
    pub quota_bytes: u64,
    pub used_bytes: u64,
    pub wanted_bytes: u64,
}

/// See [`ErrorBody::lease`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct LeaseBody {
    pub held_epoch: u64,
    pub claimed_epoch: u64,
}

/// See [`ErrorBody::size`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SizeBody {
    pub declared_bytes: u64,
    pub cap_bytes: u64,
}

impl ErrorBody {
    /// The body for one refusal, companions and all.
    ///
    /// **The only place this product builds an error body**, so there is one
    /// answer rather than one per adapter.
    #[must_use]
    pub fn of(refusal: &Refusal, server_time_ms: i64) -> Self {
        let companions = refusal.companions();
        Self {
            code: format!("{:?}", refusal.code()),
            server_time_ms,
            moved: companions.moved.map(|moved| MovedBody {
                current_epoch: moved.current_epoch,
                moved_at_ms: moved.moved_at_ms,
            }),
            protocol: companions.protocol.map(|protocol| ProtocolBody {
                server_protocol_min: protocol.server_min,
                server_protocol_max: protocol.server_max,
                client_protocol: protocol.client,
            }),
            skew_window_ms: companions.skew_window_ms,
            current_head: companions
                .head
                .map(|head| head.map(|name| name.hex()).unwrap_or_default()),
            quota: companions.quota.map(|quota| QuotaBody {
                quota_bytes: quota.quota_bytes,
                used_bytes: quota.used_bytes,
                wanted_bytes: quota.wanted_bytes,
            }),
            lease: companions.lease.map(|lease| LeaseBody {
                held_epoch: lease.held,
                claimed_epoch: lease.claimed,
            }),
            size: companions.size.map(|size| SizeBody {
                declared_bytes: size.declared_bytes,
                cap_bytes: size.cap_bytes,
            }),
            object: companions.object.map(|object| object.hex()),
        }
    }

    /// A body that carries no companions, for an internal error — which is not
    /// a refusal and has none.
    #[must_use]
    pub fn internal(server_time_ms: i64) -> Self {
        Self {
            code: format!("{:?}", ErrorCode::Internal),
            server_time_ms,
            moved: None,
            protocol: None,
            skew_window_ms: None,
            current_head: None,
            quota: None,
            lease: None,
            size: None,
            object: None,
        }
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

    /// A MOVED VAULT CARRIES *WHEN*, NOT ONLY *THAT*.
    ///
    /// A phone that gets the code and no time can freeze the vault and cannot
    /// tell the member how much is at stake; a shell that defaults the missing
    /// time draws "0 changes since 1 January 1970", which is worse than blank
    /// because it looks like a fact.
    #[test]
    fn a_moved_vault_carries_its_epoch_and_the_time_it_moved() {
        let companions = Refusal::VaultMoved {
            current_epoch: 7,
            moved_at: ServerTime::from_millis(1_700_000_000_000),
        }
        .companions();
        assert_eq!(
            companions.moved,
            Some(Moved {
                current_epoch: 7,
                moved_at_ms: 1_700_000_000_000,
            })
        );
        assert_eq!(
            companions.fields(),
            vec![
                ("current_epoch", "7".to_owned()),
                ("moved_at_ms", "1700000000000".to_owned()),
            ]
        );
    }

    /// A VERSION REFUSAL CARRIES BOTH ENDS. The phone shows a different state
    /// for "this server needs an update" than for "this app does".
    #[test]
    fn a_version_refusal_carries_the_servers_range_and_the_clients_number() {
        let companions = Refusal::VersionWindow {
            server: (2, 4),
            client: 9,
        }
        .companions();
        assert_eq!(
            companions.protocol,
            Some(ProtocolWindow {
                server_min: 2,
                server_max: 4,
                client: 9,
            })
        );
    }

    /// "THERE IS NO HEAD" IS AN ANSWER, NOT AN ABSENCE.
    ///
    /// A lost compare-and-set against an empty vault has to be distinguishable
    /// from an adapter that dropped the companion, or the phone cannot tell
    /// "re-read from nothing" from "this server is broken".
    #[test]
    fn a_head_conflict_with_no_head_still_carries_the_companion() {
        let companions = Refusal::HeadConflict { current: None }.companions();
        assert_eq!(companions.head, Some(None));
        assert_eq!(
            companions.fields(),
            vec![("current_head", String::new())],
            "the companion is present and its value is empty, which is the \
             difference between `there is no head` and `this adapter dropped it`"
        );
    }

    /// EVERY REFUSAL THAT HOLDS A VALUE HANDS IT OVER.
    ///
    /// The failure this guards against is a new variant with a field that
    /// nobody adds to `companions()`: it compiles, the phone gets a code with
    /// nothing attached, and the gap is found by a member.
    #[test]
    fn no_refusal_that_carries_data_reports_an_empty_companion_set() {
        let carrying = [
            Refusal::ClockSkew {
                server_time: ServerTime::from_millis(1),
                window: Duration::from_secs(300),
            },
            Refusal::VersionWindow {
                server: (1, 1),
                client: 5,
            },
            Refusal::AlreadyCommitted(ObjectName::of(b"x")),
            Refusal::ObjectUnknown(ObjectName::of(b"y")),
            Refusal::ObjectTooLarge {
                declared: 20,
                cap: 16,
            },
            Refusal::HeadConflict {
                current: Some(ObjectName::of(b"z")),
            },
            Refusal::LeaseStale {
                held: 3,
                claimed: 3,
            },
            Refusal::VaultMoved {
                current_epoch: 4,
                moved_at: ServerTime::from_millis(9),
            },
            Refusal::QuotaExceeded {
                quota_bytes: 10,
                used_bytes: 9,
                wanted_bytes: 5,
            },
        ];
        for refusal in carrying {
            assert!(
                !refusal.companions().fields().is_empty(),
                "{refusal:?} carries a value the phone needs and hands over nothing"
            );
        }
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
