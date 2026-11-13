//! Every way the gateway says no, and the one body that carries it (#1080).
//!
//! # A CODE IS NEVER A SENTENCE
//!
//! A refusal is a closed [`Code`], serialised as its screaming-snake name, in
//! a body `{"code", "time_ms", ...companions}`. The member-facing words are
//! the shell's, derived from the code; a sentence on the wire is a sentence
//! two ends would have to agree on.
//!
//! # A COMPANION IS A VALUE THE PHONE ACTS ON
//!
//! `MOVED` without the epoch that superseded the phone, or `HEAD_CONFLICT`
//! without the head as it stands, is a refusal the phone can display and not
//! act on. So the typed [`Refusal`] carries its values, [`RefusalBody::of`]
//! writes every one, and [`Refusal::from_body`] refuses to rebuild a refusal
//! whose companion is missing: a client reads a dropped companion as a
//! malformed answer, never as a default, because a defaulted epoch is a
//! fabricated fact. `null` is a real companion value for a head — "there is
//! no head" — and is distinct from the field being absent.
//!
//! # THE STATUS IS FOR PROXIES
//!
//! [`Code::status`] exists so that something between the phone and the
//! gateway behaves. The code is the answer. A store fault is a 500 and a
//! refusal never is: the phone retries the first and acts on the second.

use core::fmt;

use serde::{Deserialize, Deserializer, Serialize};

use crate::rules::ids::{Digest, Name};
use crate::rules::wire::{ClaimView, HeadView};

/// The closed set of answers that are not a success.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Code {
    /// The request is malformed: a body, a header, a name or a parameter.
    BadRequest,
    /// No token, an unknown token, a token for another vault, an unknown
    /// vault, a bad signature, or a spent, expired or unknown pairing secret.
    /// All the same answer, so none of them is an oracle.
    Unauthorized,
    /// A token a takeover revoked, or one below the vault's writer epoch:
    /// another phone has taken over. Carries the signed claim that says so.
    Moved,
    /// A pairing secret offered for a vault this gateway already holds.
    VaultKnown,
    /// A claim whose epoch is not the writer epoch plus one.
    EpochConflict,
    /// A compare-and-set lost, or a claim's `head_seen` is not the head.
    HeadConflict,
    /// The vault has no head yet.
    NoHead,
    /// No such object, or no such route.
    NotFound,
    /// The bytes do not hash to the declared digest.
    DigestMismatch,
    /// The name is held with a different digest. Storage is write-once.
    NameTaken,
    /// Over a byte limit.
    TooLarge,
    /// Over a count limit.
    TooMany,
    /// The gateway's disk refused the write.
    DiskFull,
    /// The current head's manifest cannot be deleted.
    HeadInUse,
    /// A `Range` the object cannot satisfy.
    BadRange,
    /// A signed record that is not newer than the one standing, or jumps
    /// too far ahead of it (E3).
    OutOfOrder,
    /// The operator froze the vault (E6).
    Frozen,
    /// The gateway has too many live nonces; ask again later (E5).
    Busy,
    /// A head dated further ahead than the gateway's clock allows (E14).
    ClockAhead,
    /// The gateway's store failed. **Not a refusal**: the phone retries.
    Internal,
}

impl Code {
    /// Every code, for the tests that hold the table complete.
    pub const ALL: [Self; 20] = [
        Self::BadRequest,
        Self::Unauthorized,
        Self::Moved,
        Self::VaultKnown,
        Self::EpochConflict,
        Self::HeadConflict,
        Self::NoHead,
        Self::NotFound,
        Self::DigestMismatch,
        Self::NameTaken,
        Self::TooLarge,
        Self::TooMany,
        Self::DiskFull,
        Self::HeadInUse,
        Self::BadRange,
        Self::OutOfOrder,
        Self::Frozen,
        Self::Busy,
        Self::ClockAhead,
        Self::Internal,
    ];

    /// The screaming-snake name, exactly as serde writes it.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::BadRequest => "BAD_REQUEST",
            Self::Unauthorized => "UNAUTHORIZED",
            Self::Moved => "MOVED",
            Self::VaultKnown => "VAULT_KNOWN",
            Self::EpochConflict => "EPOCH_CONFLICT",
            Self::HeadConflict => "HEAD_CONFLICT",
            Self::NoHead => "NO_HEAD",
            Self::NotFound => "NOT_FOUND",
            Self::DigestMismatch => "DIGEST_MISMATCH",
            Self::NameTaken => "NAME_TAKEN",
            Self::TooLarge => "TOO_LARGE",
            Self::TooMany => "TOO_MANY",
            Self::DiskFull => "DISK_FULL",
            Self::HeadInUse => "HEAD_IN_USE",
            Self::BadRange => "BAD_RANGE",
            Self::OutOfOrder => "OUT_OF_ORDER",
            Self::Frozen => "FROZEN",
            Self::Busy => "BUSY",
            Self::ClockAhead => "CLOCK_AHEAD",
            Self::Internal => "INTERNAL",
        }
    }

    /// The code a `centraid-code` header spells, back.
    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|code| code.as_str() == text)
    }

    /// The HTTP status this code travels under. Only [`Code::Internal`] is a
    /// 5xx other than the full disk's 507, which a proxy must not retry.
    #[must_use]
    pub const fn status(self) -> u16 {
        match self {
            Self::BadRequest | Self::DigestMismatch | Self::ClockAhead => 400,
            Self::Unauthorized => 401,
            Self::NoHead | Self::NotFound => 404,
            Self::Moved
            | Self::VaultKnown
            | Self::EpochConflict
            | Self::HeadConflict
            | Self::NameTaken
            | Self::HeadInUse
            | Self::OutOfOrder => 409,
            Self::Frozen => 423,
            Self::TooLarge | Self::TooMany => 413,
            Self::BadRange => 416,
            Self::Internal => 500,
            Self::Busy => 503,
            Self::DiskFull => 507,
        }
    }
}

impl fmt::Display for Code {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// A refusal, with the values the phone acts on. The two large companions —
/// a head as the phone signed it and a signed claim — are boxed, so the
/// `Err` of every rule stays small.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    BadRequest,
    Unauthorized,
    /// The epoch that superseded this token, and the signed claim that did
    /// it, which the phone verifies before it believes it (E4).
    Moved {
        epoch: u64,
        claim: Box<ClaimView>,
    },
    VaultKnown,
    /// The writer epoch and head as they stand; the claimer re-reads.
    EpochConflict {
        epoch: u64,
        head: Option<Box<HeadView>>,
    },
    /// The writer epoch and head as they stand; the writer re-reads.
    HeadConflict {
        epoch: u64,
        head: Option<Box<HeadView>>,
    },
    /// The writer epoch, so a restoring phone can claim one past it.
    NoHead {
        epoch: u64,
        claim: Option<Box<ClaimView>>,
    },
    /// The object that is not there, when there is one to name.
    NotFound {
        name: Option<Name>,
    },
    /// What the bytes really hash to.
    DigestMismatch {
        computed: Digest,
    },
    /// The digest the name is already held with.
    NameTaken {
        digest: Digest,
    },
    /// The byte limit that was crossed.
    TooLarge {
        limit: u64,
    },
    /// The count limit that was crossed.
    TooMany {
        limit: u64,
    },
    DiskFull,
    /// The current head's manifest.
    HeadInUse {
        name: Name,
    },
    /// The object's size, so the phone can ask for a range that fits.
    BadRange {
        size: u64,
    },
    /// The standing record's epoch, generation and writes (E3).
    OutOfOrder {
        epoch: u64,
        generation: u64,
        writes: u64,
    },
    /// Since when the operator has held the vault.
    Frozen {
        since_ms: i64,
    },
    /// When to ask again.
    Busy {
        retry_after_ms: u64,
    },
    /// How far ahead of the gateway's clock the head was dated.
    ClockAhead {
        skew_ms: i64,
    },
}

impl Refusal {
    /// The wire code.
    #[must_use]
    pub const fn code(&self) -> Code {
        match self {
            Self::BadRequest => Code::BadRequest,
            Self::Unauthorized => Code::Unauthorized,
            Self::Moved { .. } => Code::Moved,
            Self::VaultKnown => Code::VaultKnown,
            Self::EpochConflict { .. } => Code::EpochConflict,
            Self::HeadConflict { .. } => Code::HeadConflict,
            Self::NoHead { .. } => Code::NoHead,
            Self::NotFound { .. } => Code::NotFound,
            Self::DigestMismatch { .. } => Code::DigestMismatch,
            Self::NameTaken { .. } => Code::NameTaken,
            Self::TooLarge { .. } => Code::TooLarge,
            Self::TooMany { .. } => Code::TooMany,
            Self::DiskFull => Code::DiskFull,
            Self::HeadInUse { .. } => Code::HeadInUse,
            Self::BadRange { .. } => Code::BadRange,
            Self::OutOfOrder { .. } => Code::OutOfOrder,
            Self::Frozen { .. } => Code::Frozen,
            Self::Busy { .. } => Code::Busy,
            Self::ClockAhead { .. } => Code::ClockAhead,
        }
    }

    /// Rebuild the typed refusal from a body, or `None` when the body is not
    /// a refusal ([`Code::Internal`]) or a companion its code requires is
    /// missing — which a client treats as a malformed answer.
    #[must_use]
    pub fn from_body(body: &RefusalBody) -> Option<Self> {
        Some(match body.code {
            Code::BadRequest => Self::BadRequest,
            Code::Unauthorized => Self::Unauthorized,
            Code::Moved => Self::Moved {
                epoch: body.epoch?,
                claim: Box::new(body.claim?),
            },
            Code::VaultKnown => Self::VaultKnown,
            Code::EpochConflict => Self::EpochConflict {
                epoch: body.epoch?,
                head: body.head?.map(Box::new),
            },
            Code::HeadConflict => Self::HeadConflict {
                epoch: body.epoch?,
                head: body.head?.map(Box::new),
            },
            Code::NoHead => Self::NoHead {
                epoch: body.epoch?,
                claim: body.claim.map(Box::new),
            },
            Code::NotFound => Self::NotFound { name: body.name },
            Code::DigestMismatch => Self::DigestMismatch {
                computed: body.digest?,
            },
            Code::NameTaken => Self::NameTaken {
                digest: body.digest?,
            },
            Code::TooLarge => Self::TooLarge { limit: body.limit? },
            Code::TooMany => Self::TooMany { limit: body.limit? },
            Code::DiskFull => Self::DiskFull,
            Code::HeadInUse => Self::HeadInUse { name: body.name? },
            Code::BadRange => Self::BadRange { size: body.size? },
            Code::OutOfOrder => Self::OutOfOrder {
                epoch: body.epoch?,
                generation: body.generation?,
                writes: body.writes?,
            },
            Code::Frozen => Self::Frozen {
                since_ms: body.since_ms?,
            },
            Code::Busy => Self::Busy {
                retry_after_ms: body.retry_after_ms?,
            },
            Code::ClockAhead => Self::ClockAhead {
                skew_ms: body.skew_ms?,
            },
            Code::Internal => return None,
        })
    }
}

impl fmt::Display for Refusal {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(&self.code(), formatter)
    }
}

impl std::error::Error for Refusal {}

/// A refusal as it travels: `{"code", "time_ms", ...companions}`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct RefusalBody {
    pub code: Code,
    /// The gateway's clock, on every refusal: a phone with a wrong clock can
    /// see that it has one.
    pub time_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub epoch: Option<u64>,
    /// `Some(None)` is written as `null`: there is no head.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub head: Option<Option<HeadView>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<Name>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub digest: Option<Digest>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generation: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub writes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub since_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skew_ms: Option<i64>,
    /// The signed claim a `MOVED` carries.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claim: Option<ClaimView>,
}

/// A field that is present deserialises to `Some`, `null` included, so `null`
/// and absent stay two different answers.
fn present<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

impl RefusalBody {
    /// A body with a code and the clock, and no companion.
    #[must_use]
    pub const fn bare(code: Code, time_ms: i64) -> Self {
        Self {
            code,
            time_ms,
            epoch: None,
            head: None,
            name: None,
            digest: None,
            limit: None,
            size: None,
            generation: None,
            writes: None,
            since_ms: None,
            retry_after_ms: None,
            skew_ms: None,
            claim: None,
        }
    }

    /// The body for one refusal, every companion written.
    #[must_use]
    pub fn of(refusal: &Refusal, time_ms: i64) -> Self {
        let mut body = Self::bare(refusal.code(), time_ms);
        match refusal.clone() {
            Refusal::BadRequest
            | Refusal::Unauthorized
            | Refusal::VaultKnown
            | Refusal::DiskFull => {}
            Refusal::Moved { epoch, claim } => {
                body.epoch = Some(epoch);
                body.claim = Some(*claim);
            }
            Refusal::NoHead { epoch, claim } => {
                body.epoch = Some(epoch);
                body.claim = claim.map(|claim| *claim);
            }
            Refusal::EpochConflict { epoch, head } | Refusal::HeadConflict { epoch, head } => {
                body.epoch = Some(epoch);
                body.head = Some(head.map(|head| *head));
            }
            Refusal::NotFound { name } => body.name = name,
            Refusal::DigestMismatch { computed } => body.digest = Some(computed),
            Refusal::NameTaken { digest } => body.digest = Some(digest),
            Refusal::TooLarge { limit } | Refusal::TooMany { limit } => body.limit = Some(limit),
            Refusal::HeadInUse { name } => body.name = Some(name),
            Refusal::BadRange { size } => body.size = Some(size),
            Refusal::OutOfOrder {
                epoch,
                generation,
                writes,
            } => {
                body.epoch = Some(epoch);
                body.generation = Some(generation);
                body.writes = Some(writes);
            }
            Refusal::Frozen { since_ms } => body.since_ms = Some(since_ms),
            Refusal::Busy { retry_after_ms } => body.retry_after_ms = Some(retry_after_ms),
            Refusal::ClockAhead { skew_ms } => body.skew_ms = Some(skew_ms),
        }
        body
    }

    /// The body for a store fault. It carries nothing: the detail may name a
    /// path, and it goes to the operator's log, never to the wire.
    #[must_use]
    pub fn internal(time_ms: i64) -> Self {
        Self::bare(Code::Internal, time_ms)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn head() -> HeadView {
        HeadView {
            name: Name::from_bytes([9; 32]),
            prev: None,
            taken_at_ms: 1,
            epoch: 2,
            claim: None,
            generation: 4,
            writes: 5,
            set_at_ms: 3,
            signature: crate::rules::ids::Signature::from_bytes([7; 64]),
        }
    }

    fn claim() -> ClaimView {
        ClaimView {
            epoch: 4,
            head_seen: Some(Name::from_bytes([8; 32])),
            nonce: crate::rules::ids::Nonce::from_bytes([6; 16]),
            signature: crate::rules::ids::Signature::from_bytes([5; 64]),
        }
    }

    fn every_refusal() -> Vec<Refusal> {
        vec![
            Refusal::BadRequest,
            Refusal::Unauthorized,
            Refusal::Moved {
                epoch: 4,
                claim: Box::new(claim()),
            },
            Refusal::VaultKnown,
            Refusal::EpochConflict {
                epoch: 4,
                head: Some(Box::new(head())),
            },
            Refusal::EpochConflict {
                epoch: 1,
                head: None,
            },
            Refusal::HeadConflict {
                epoch: 4,
                head: Some(Box::new(head())),
            },
            Refusal::HeadConflict {
                epoch: 1,
                head: None,
            },
            Refusal::NoHead {
                epoch: 1,
                claim: None,
            },
            Refusal::NoHead {
                epoch: 3,
                claim: Some(Box::new(claim())),
            },
            Refusal::NotFound {
                name: Some(Name::from_bytes([1; 32])),
            },
            Refusal::NotFound { name: None },
            Refusal::DigestMismatch {
                computed: Digest::of(b"x"),
            },
            Refusal::NameTaken {
                digest: Digest::of(b"y"),
            },
            Refusal::TooLarge { limit: 10 },
            Refusal::TooMany { limit: 1_000 },
            Refusal::DiskFull,
            Refusal::HeadInUse {
                name: Name::from_bytes([2; 32]),
            },
            Refusal::BadRange { size: 7 },
            Refusal::OutOfOrder {
                epoch: 2,
                generation: 9,
                writes: 3,
            },
            Refusal::Frozen { since_ms: 12 },
            Refusal::Busy {
                retry_after_ms: 60_000,
            },
            Refusal::ClockAhead { skew_ms: 301_000 },
        ]
    }

    /// Every refusal survives the wire: rendered to JSON text and rebuilt, it
    /// is the refusal it was, companions and all.
    #[test]
    fn every_refusal_round_trips_through_its_body() {
        for refusal in every_refusal() {
            let text = serde_json::to_string(&RefusalBody::of(&refusal, 99)).expect("renders");
            let body: RefusalBody = serde_json::from_str(&text).expect("parses");
            assert_eq!(body.time_ms, 99);
            assert_eq!(Refusal::from_body(&body), Some(refusal), "{text}");
        }
    }

    /// "THERE IS NO HEAD" IS AN ANSWER: the companion is `null`, present, and
    /// distinct from a body that dropped it.
    #[test]
    fn a_conflict_with_no_head_writes_null_and_a_dropped_head_is_malformed() {
        let text = serde_json::to_string(&RefusalBody::of(
            &Refusal::HeadConflict {
                epoch: 1,
                head: None,
            },
            0,
        ))
        .expect("renders");
        assert!(text.contains(r#""head":null"#), "{text}");
        let dropped = r#"{"code":"HEAD_CONFLICT","time_ms":0,"epoch":1}"#;
        let body: RefusalBody = serde_json::from_str(dropped).expect("parses");
        assert_eq!(
            Refusal::from_body(&body),
            None,
            "a missing companion is malformed"
        );
    }

    /// The code is the screaming-snake name, and `as_str` is that same text.
    #[test]
    fn every_code_serialises_as_its_screaming_snake_name() {
        for code in Code::ALL {
            assert_eq!(
                serde_json::to_string(&code).expect("renders"),
                format!("\"{}\"", code.as_str())
            );
            assert_eq!(Code::parse(code.as_str()), Some(code));
        }
        assert_eq!(Code::parse("A sentence about what went wrong"), None);
    }

    /// A REFUSAL IS NEVER A 500, AND A STORE FAULT ALWAYS IS.
    #[test]
    fn only_a_store_fault_travels_as_a_500() {
        for code in Code::ALL {
            assert_eq!(code.status() == 500, code == Code::Internal, "{code}");
        }
        assert_eq!(Refusal::from_body(&RefusalBody::internal(0)), None);
    }

    /// A superseded phone and a stranger get different codes, because the
    /// phone's answers differ: freeze read-only, or show a refusal.
    #[test]
    fn moved_is_not_unauthorized() {
        assert_ne!(
            Refusal::Moved {
                epoch: 2,
                claim: Box::new(claim())
            }
            .code(),
            Refusal::Unauthorized.code()
        );
    }
}
