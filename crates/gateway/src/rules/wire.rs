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

use crate::rules::code::{Code, Refusal};
use crate::rules::ids::{Digest, GatewayId, Name, Nonce, Secret, Signature, Token, VaultId};

/// The header an object's digest travels in, both ways: `blake3=<64 hex>`.
pub const DIGEST_HEADER: &str = "content-digest";

/// The header every refusal also carries its code in, so the answer to a
/// `HEAD` — which has no body — still says which refusal it is.
pub const CODE_HEADER: &str = "centraid-code";

/// `GET /v1/info`.
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

/// `POST /v1/nonce`'s answer: a nonce good for one pair request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct NonceAnswer {
    pub nonce: Nonce,
    pub ttl_ms: i64,
}

/// `POST /v1/pair`. Every kind carries a nonce from `POST /v1/nonce`, signed
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

/// What `POST /v1/pair` answers. **The only time the token exists outside the
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

/// `PUT /v1/v/{vault}/head`. The epoch is the token's, not sent.
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
    /// The writer epoch and generation the head naming this snapshot was signed at: the signed
    /// order of snapshots. Absent (0) from a gateway that does not say.
    #[serde(default)]
    pub epoch: u64,
    #[serde(default)]
    pub generation: u64,
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

/// `POST /v1/v/{vault}/delete`: the names, and the vault key's signature
/// over them, the generation and the head the delete was computed against
/// (E6, spec §4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeleteRequest {
    pub names: Vec<Name>,
    pub generation: u64,
    /// The root name of the head this delete was computed under, or none for
    /// a vault with no head. The gateway accepts the delete only while that
    /// is its current head, so a rolled-back gateway refuses it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head_root: Option<Name>,
    pub signature: Signature,
}

/// `POST /v1/v/{vault}/check`: the vault key's signature over one name and the generation
/// (decision 34). The gateway hashes that stored object against its recorded digest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckRequest {
    pub name: Name,
    pub generation: u64,
    pub signature: Signature,
}

/// What a check found.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckState {
    /// The stored bytes hash to the recorded digest; nothing changed.
    Intact,
    /// They do not (or the file is gone): the name is marked damaged, so a signed delete frees
    /// it at once.
    Damaged,
    /// The gateway holds no object of that name.
    Missing,
}

/// What `POST check` answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Checked {
    pub state: CheckState,
}

/// `POST /v1/v/{vault}/undo`: lift the holds of `names`, or of every hold
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

/// One stored object as a bundle answer and `GET objects` describe it.
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
    /// With `NAME_TAKEN`: the digest the gateway recorded (additive).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub digest: Option<Digest>,
    /// With `NAME_TAKEN`: why the name is not free (additive).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<NameState>,
}

impl NameRefusal {
    /// A refusal with only a code.
    #[must_use]
    pub const fn code(name: Name, code: Code) -> Self {
        Self {
            name,
            code,
            digest: None,
            state: None,
        }
    }

    /// What one frame's or name's refusal says, `NAME_TAKEN` companions
    /// included.
    #[must_use]
    pub fn of(name: Name, refusal: &Refusal) -> Self {
        let (digest, state) = match refusal {
            Refusal::NameTaken { digest, state } => (Some(*digest), Some(*state)),
            _ => (None, None),
        };
        Self {
            name,
            code: refusal.code(),
            digest,
            state,
        }
    }
}

/// Why a name a frame wanted is not free.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NameState {
    /// Stored and live under another digest.
    Live,
    /// Held for deletion (a signed delete is waiting out its week).
    Held,
    /// The gateway found its file missing or rotten. Only a signed delete
    /// frees the name.
    Damaged,
}

/// How one bundle frame was answered (spec §4). Every frame has exactly one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "result", rename_all = "snake_case")]
pub enum FrameResult {
    /// New bytes, committed (stage, fsync, rename) before this answer.
    Stored { name: Name },
    /// The same digest, live: nothing moved.
    There { name: Name },
    /// The same digest under a hold: the hold is lifted.
    Held { name: Name },
    /// The name is not free under another digest. **Not an acknowledgement.**
    Taken {
        name: Name,
        digest: Digest,
        state: NameState,
    },
    /// The gateway's disk is full; the frame was not stored.
    Full { name: Name },
    /// The frame is over `MAX_OBJECT_BYTES`; it was read past and not stored.
    TooLarge { name: Name },
    /// Any other refusal of this one frame (`DIGEST_MISMATCH`: the bytes are
    /// not the digest the frame named).
    Refused { name: Name, code: Code },
}

impl FrameResult {
    /// The frame's name.
    #[must_use]
    pub const fn name(&self) -> Name {
        match self {
            Self::Stored { name }
            | Self::There { name }
            | Self::Held { name }
            | Self::Taken { name, .. }
            | Self::Full { name }
            | Self::TooLarge { name }
            | Self::Refused { name, .. } => *name,
        }
    }

    /// One frame's refusal, as the answer says it.
    #[must_use]
    pub const fn of_refusal(name: Name, refusal: &Refusal) -> Self {
        match refusal {
            Refusal::NameTaken { digest, state } => Self::Taken {
                name,
                digest: *digest,
                state: *state,
            },
            Refusal::DiskFull => Self::Full { name },
            Refusal::TooLarge { .. } => Self::TooLarge { name },
            other => Self::Refused {
                name,
                code: other.code(),
            },
        }
    }
}

/// What `POST bundle` answers: one result per frame, in the order the frames
/// arrived. A body cut inside frame `k` answers nothing (the connection is
/// gone) but leaves frames before `k` committed and `k` absent.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BundleAnswer {
    pub results: Vec<FrameResult>,
}

impl BundleAnswer {
    /// Every name the gateway now holds these frames' bytes under: `stored`,
    /// `there` and `held`. A `taken` is not here (see [`Self::taken`]).
    #[must_use]
    pub fn acknowledged(&self) -> Vec<Name> {
        self.results
            .iter()
            .filter(|result| {
                matches!(
                    result,
                    FrameResult::Stored { .. }
                        | FrameResult::There { .. }
                        | FrameResult::Held { .. }
                )
            })
            .map(FrameResult::name)
            .collect()
    }

    /// How many frames got this kind of answer, by a predicate.
    #[must_use]
    pub fn count(&self, kind: impl Fn(&FrameResult) -> bool) -> usize {
        self.results.iter().filter(|result| kind(result)).count()
    }

    /// Frames stored new.
    #[must_use]
    pub fn stored(&self) -> usize {
        self.count(|result| matches!(result, FrameResult::Stored { .. }))
    }

    /// Frames already there, live.
    #[must_use]
    pub fn there(&self) -> usize {
        self.count(|result| matches!(result, FrameResult::There { .. }))
    }

    /// Every frame answered `taken`: `(name, recorded digest, state)`.
    /// **Not acknowledgements.** A phone compares the digest with the one it
    /// sent: another digest on a live name is a name it must not count as
    /// stored, and on a damaged name it is the cue for a signed delete.
    #[must_use]
    pub fn taken(&self) -> Vec<(Name, Digest, NameState)> {
        self.results
            .iter()
            .filter_map(|result| match result {
                FrameResult::Taken {
                    name,
                    digest,
                    state,
                } => Some((*name, *digest, *state)),
                _ => None,
            })
            .collect()
    }
}

/// What `POST delete` answers.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeleteAnswer {
    /// Held now, held before, or never stored: either way, deleted.
    /// Deleting is idempotent (#1080, the root's ruling A15).
    pub deleted: Vec<Name>,
    /// Damaged objects the delete removed at once, row and file, with no hold:
    /// the bytes were already bad and an undo would restore nothing. The names
    /// are free (additive; an older gateway never says).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub freed: Vec<Name>,
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
            nonce: Nonce::from_bytes([3; 40]),
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
