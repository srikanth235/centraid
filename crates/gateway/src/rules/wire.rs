//! Every request and answer body, declared once for both ends (#1080).
//!
//! **Bodies are JSON** (R-1029-3 stands), objects travel as raw bytes, and a
//! refusal is [`crate::rules::code::RefusalBody`]. The server renders these
//! types and the client reads the same types back, so the two cannot drift
//! into two shapes of one answer — the failure `gateway-core`'s single
//! `ErrorBody` was written to end.
//!
//! Field names are the issue's route table, verbatim.

use serde::{Deserialize, Serialize};

use crate::rules::code::Code;
use crate::rules::ids::{Digest, GatewayId, Name, Secret, Signature, Token, VaultId};

/// The header an object's digest travels in, both ways: `blake3=<64 hex>`.
pub const DIGEST_HEADER: &str = "content-digest";

/// The header every refusal also carries its code in, so the answer to a
/// `HEAD` — which has no body — still says which refusal it is.
pub const CODE_HEADER: &str = "centraid-code";

/// `GET /v2/info`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Info {
    pub gateway_id: GatewayId,
    /// [`crate::rules::limits::PROTOCOL`].
    pub protocol: u32,
    /// The gateway's clock.
    pub time_ms: i64,
}

/// How a phone asks to be paired.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PairKind {
    /// A pairing secret from the QR admits a vault this gateway has never
    /// seen, at writer epoch 1.
    Secret,
    /// The vault's identity key moves the writer to this phone at the next
    /// epoch: a restore or a takeover.
    Claim,
    /// The vault's identity key grants a token at epoch 0, which reads and
    /// can never write: what a restoring phone fetches and checks a snapshot
    /// with before it claims.
    Read,
}

impl PairKind {
    /// The lowercase word, as the body spells it.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Secret => "secret",
            Self::Claim => "claim",
            Self::Read => "read",
        }
    }
}

/// A claim's signed fields.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClaimBody {
    /// The gateway's writer epoch plus one.
    pub epoch: u64,
    /// The head the claimer fetched and checked; absent on a vault with none.
    #[serde(default)]
    pub head_seen: Option<Name>,
    /// See [`crate::rules::claim::claim_preimage`].
    pub signature: Signature,
}

/// A read grant's signature: over the claim preimage at epoch 0, no head.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadBody {
    pub signature: Signature,
}

/// `POST /v2/pair`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PairRequest {
    pub vault_id: VaultId,
    /// What the member calls this device; shown by `pairings`.
    #[serde(default)]
    pub label: String,
    pub kind: PairKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret: Option<Secret>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claim: Option<ClaimBody>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub read: Option<ReadBody>,
}

/// What `POST /v2/pair` answers. **The only time the token exists outside the
/// phone**: the gateway keeps its BLAKE3 and cannot print it again.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Paired {
    pub token: Token,
    /// The epoch the token writes at; 0 for a read grant.
    pub epoch: u64,
    pub gateway_id: GatewayId,
}

/// The head as an answer carries it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct HeadView {
    /// The snapshot manifest's name.
    pub name: Name,
    /// When the phone took the snapshot, on the phone's clock.
    pub taken_at_ms: i64,
    /// **The vault's writer epoch as of this answer**, not the epoch that set
    /// the head: it is the number a restoring phone claims one past, and the
    /// number a superseded phone freezes on.
    pub epoch: u64,
    /// When the gateway moved the head, on the gateway's clock.
    pub set_at_ms: i64,
}

/// `PUT /v2/v/{vault}/head`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetHead {
    pub name: Name,
    /// The head this writer last saw; absent or null for "there is none".
    #[serde(default)]
    pub prev: Option<Name>,
    pub taken_at_ms: i64,
}

/// One registered snapshot.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SnapshotView {
    pub name: Name,
    pub taken_at_ms: i64,
    pub registered_at_ms: i64,
}

/// `{names: [...]}`, the body of `exists`, `fetch` and `delete`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Names {
    pub names: Vec<Name>,
}

/// What `exists` answers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Missing {
    pub missing: Vec<Name>,
}

/// One stored object as `PUT` and `GET objects` describe it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ObjectEntry {
    pub name: Name,
    pub size: u64,
    pub digest: Digest,
    /// The gateway's own receipt time.
    pub stored_at_ms: i64,
}

/// One name a batch refused, and why.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct NameRefusal {
    pub name: Name,
    pub code: Code,
}

/// What `POST bundle` answers: each frame exactly as a `PUT` of that frame
/// alone would have been answered. `stored` is a `PUT`'s `201`, `already` its
/// `200`, and `refused` carries every other answer's code, `NAME_TAKEN`
/// included.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BundleAnswer {
    /// New bytes, now held.
    pub stored: Vec<Name>,
    /// Held already with the frame's digest: nothing moved.
    pub already: Vec<Name>,
    pub refused: Vec<NameRefusal>,
}

impl BundleAnswer {
    /// Every name the gateway now holds a sealing of, in the order the
    /// answer lists them: `stored`, `already`, and each `NAME_TAKEN`. A name
    /// is a function of the plaintext, so another digest under it is the
    /// same bytes sealed again (#1080, the root's ruling A15). These are the
    /// names a phone may record as acknowledged.
    #[must_use]
    pub fn acknowledged(&self) -> Vec<Name> {
        self.stored
            .iter()
            .chain(&self.already)
            .copied()
            .chain(
                self.refused
                    .iter()
                    .filter(|refusal| refusal.code == Code::NameTaken)
                    .map(|refusal| refusal.name),
            )
            .collect()
    }
}

/// What `POST delete` answers.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeleteAnswer {
    /// Tombstoned now, tombstoned before, or never held: either way, deleted.
    /// Deleting is idempotent (#1080, the root's ruling A15).
    pub deleted: Vec<Name>,
    /// Only `HEAD_IN_USE`: the head's own manifest.
    pub refused: Vec<NameRefusal>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The pair body is the issue's shape: one `kind`, and only its own
    /// payload field on the wire.
    #[test]
    fn a_secret_pairing_serialises_without_the_other_kinds_fields() {
        let request = PairRequest {
            vault_id: VaultId::from_bytes([1; 32]),
            label: "Ada's phone".to_owned(),
            kind: PairKind::Secret,
            secret: Some(Secret::from_bytes([2; 16])),
            claim: None,
            read: None,
        };
        let json = serde_json::to_value(&request).expect("serialises");
        assert_eq!(json["kind"], "secret");
        assert!(
            json.get("claim").is_none() && json.get("read").is_none(),
            "{json}"
        );
        let back: PairRequest = serde_json::from_value(json).expect("parses");
        assert_eq!(back, request);
    }

    /// `prev` absent and `prev: null` are the same claim: "there is no head".
    #[test]
    fn a_set_head_without_prev_expects_no_head() {
        let name = Name::from_bytes([3; 32]);
        for text in [
            format!(r#"{{"name":"{name}","taken_at_ms":5}}"#),
            format!(r#"{{"name":"{name}","prev":null,"taken_at_ms":5}}"#),
        ] {
            let parsed: SetHead = serde_json::from_str(&text).expect("parses");
            assert_eq!(parsed.prev, None, "{text}");
        }
    }
}
