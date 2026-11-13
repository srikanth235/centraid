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
use crate::rules::ids::{Digest, GatewayId, Name, Nonce, Secret, Signature, Token, VaultId};

/// The header an object's digest travels in, both ways: `blake3=<64 hex>`.
pub const DIGEST_HEADER: &str = "content-digest";

/// The header every refusal also carries its code in, so the answer to a
/// `HEAD` — which has no body — still says which refusal it is.
pub const CODE_HEADER: &str = "centraid-code";

/// `GET /v3/info`.
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
    /// See [`crate::rules::signing::claim_preimage`].
    pub signature: Signature,
}

/// The last claim a vault accepted, as a `MOVED` carries it: everything the
/// old phone needs to verify it against its own vault identity key (E4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClaimView {
    pub epoch: u64,
    #[serde(default)]
    pub head_seen: Option<Name>,
    pub nonce: Nonce,
    pub signature: Signature,
}

/// A read grant's signature: over the claim preimage at epoch 0, no head.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadBody {
    pub signature: Signature,
}

/// A pairing by secret: the secret from the QR, and the vault key's
/// signature over its hash and the nonce (E7).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SecretBody {
    pub secret: Secret,
    /// See [`crate::rules::signing::pair_preimage`].
    pub signature: Signature,
}

/// `POST /v3/nonce`'s answer: a nonce good for one pair request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct NonceAnswer {
    pub nonce: Nonce,
    pub ttl_ms: i64,
}

/// `POST /v3/pair`. Every kind carries a nonce from `POST /v3/nonce`, signed
/// into its preimage and spent by the request, whatever its outcome.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PairRequest {
    pub vault_id: VaultId,
    /// What the member calls this device; shown by `pairings`.
    #[serde(default)]
    pub label: String,
    pub kind: PairKind,
    pub nonce: Nonce,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret: Option<SecretBody>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claim: Option<ClaimBody>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub read: Option<ReadBody>,
}

/// What `POST /v3/pair` answers. **The only time the token exists outside the
/// phone**: the gateway keeps its BLAKE3 and cannot print it again.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Paired {
    pub token: Token,
    /// The epoch the token writes at; 0 for a read grant.
    pub epoch: u64,
    pub gateway_id: GatewayId,
}

/// The head as the phone signed it, served unchanged (E2): the phone
/// verifies the signature, the gateway id and the vault id before it
/// believes any field.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct HeadView {
    /// The snapshot manifest's name.
    pub name: Name,
    /// The head this one replaced, or none.
    #[serde(default)]
    pub prev: Option<Name>,
    /// When the phone took the snapshot, on the phone's clock (signed).
    pub taken_at_ms: i64,
    /// **The writer epoch the phone held when it signed.**
    pub epoch: u64,
    /// The vault's standing claim, beside the signed head and the same shape
    /// `MOVED` carries: a restoring phone takes the writer epoch as the
    /// greater of the verified head's epoch and the verified claim's, and
    /// acts on neither unverified. `None` while the vault has never been
    /// claimed.
    #[serde(default)]
    pub claim: Option<ClaimView>,
    /// The signed counter shared by heads, deletes and undos.
    pub generation: u64,
    /// The vault's write counter in the snapshot.
    pub writes: u64,
    /// When the gateway moved the head, on the gateway's clock (unsigned).
    pub set_at_ms: i64,
    /// See [`crate::rules::signing::head_preimage`].
    pub signature: Signature,
}

/// `PUT /v3/v/{vault}/head`. The epoch is the token's, not sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetHead {
    pub name: Name,
    /// The head this writer last saw; absent or null for "there is none".
    #[serde(default)]
    pub prev: Option<Name>,
    pub taken_at_ms: i64,
    pub generation: u64,
    pub writes: u64,
    pub signature: Signature,
}

/// One registered snapshot. A snapshot whose manifest is held for deletion
/// stays listed, with its dates, so a restore can still choose it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SnapshotView {
    pub name: Name,
    pub taken_at_ms: i64,
    pub registered_at_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub held_at_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub purge_after_ms: Option<i64>,
}

/// What a held name is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HeldKind {
    Object,
    Snapshot,
}

/// One entry of `GET held`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct HeldEntry {
    pub name: Name,
    pub size: u64,
    pub digest: Digest,
    pub kind: HeldKind,
    pub held_at_ms: i64,
    pub purge_after_ms: i64,
}

/// `POST /v3/v/{vault}/delete`: the names, and the vault key's signature
/// over them and the generation (E6).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeleteRequest {
    pub names: Vec<Name>,
    pub generation: u64,
    pub signature: Signature,
}

/// `POST /v3/v/{vault}/undo`: lift the holds of `names`, or of every hold
/// when `names` is null.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UndoRequest {
    #[serde(default)]
    pub names: Option<Vec<Name>>,
    pub generation: u64,
    pub signature: Signature,
}

/// What `POST undo` answers: how many holds were lifted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Undone {
    pub undone: u64,
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
    /// Held now, held before, or never stored: either way, deleted.
    /// Deleting is idempotent (#1080, the root's ruling A15).
    pub deleted: Vec<Name>,
    /// Only `HEAD_IN_USE`: the head's own manifest.
    pub refused: Vec<NameRefusal>,
}

/// What `POST revoke` answers: the calling token is gone, and every route
/// answers it `UNAUTHORIZED` from now on.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Revoked {
    pub revoked: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The pair body is one `kind`, the nonce, and only its own payload field
    /// on the wire.
    #[test]
    fn a_secret_pairing_serialises_without_the_other_kinds_fields() {
        let request = PairRequest {
            vault_id: VaultId::from_bytes([1; 32]),
            label: "Ada's phone".to_owned(),
            kind: PairKind::Secret,
            nonce: Nonce::from_bytes([3; 16]),
            secret: Some(SecretBody {
                secret: Secret::from_bytes([2; 16]),
                signature: Signature::from_bytes([4; 64]),
            }),
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
        let signature = Signature::from_bytes([1; 64]);
        for text in [
            format!(
                r#"{{"name":"{name}","taken_at_ms":5,"generation":1,"writes":2,"signature":"{signature}"}}"#
            ),
            format!(
                r#"{{"name":"{name}","prev":null,"taken_at_ms":5,"generation":1,"writes":2,"signature":"{signature}"}}"#
            ),
        ] {
            let parsed: SetHead = serde_json::from_str(&text).expect("parses");
            assert_eq!(parsed.prev, None, "{text}");
        }
    }

    /// An undo of every hold writes `names: null`, and a missing `names`
    /// reads the same.
    #[test]
    fn an_undo_of_everything_has_null_names() {
        let signature = Signature::from_bytes([1; 64]);
        let text = format!(r#"{{"generation":3,"signature":"{signature}"}}"#);
        let parsed: UndoRequest = serde_json::from_str(&text).expect("parses");
        assert_eq!(parsed.names, None);
    }
}
