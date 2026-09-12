//! The generation manifest: a public envelope anyone can read, a sealed
//! payload only the keyring opens (#1020, D-1020-R5).
//!
//! The envelope shape is `centraid-snapshot/2`, which the cross-language golden
//! pins. Two halves, and the split is the design:
//!
//! - the **public envelope** — `format`, `keyEpoch`, `createdAt`,
//!   `generation`, `prevManifestHash`, `chunkIndex`, `appMeta` — is readable
//!   without any key, so a restore can discover generations, follow the
//!   `prevManifestHash` chain and size a download before it holds a key;
//! - the **sealed payload** — the file entries with their paths, sizes, mtimes,
//!   chunk lists and hashes — is AES-GCM under the epoch's data key, with the
//!   canonical public envelope as its **AAD**.
//!
//! Making the envelope the AAD is what stops a payload being re-pointed at
//! another generation: edit `generation` or `prevManifestHash` and the payload
//! stops opening. `manifestHash` is the sha256 of the canonical stored bytes,
//! which is the generation's own address.
//!
//! Every byte of this lives in [`centraid_media::format`], moved from v0. This
//! module is the typed vault-side view of it.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde_json::Value;

use crate::backup::keyring::KeyringError;
use crate::backup::wal::WalSegment;

/// The format string a v1 generation writes and reads. One value only: a
/// manifest naming another format is a file from a future this binary cannot
/// promise anything about.
pub const SNAPSHOT_FORMAT: &str = "centraid-snapshot/2";

#[derive(Debug, thiserror::Error)]
pub enum ManifestError {
    #[error("{0}")]
    Format(String),
    #[error(transparent)]
    Keyring(#[from] KeyringError),
    #[error("manifest is not JSON: {0}")]
    Json(#[from] serde_json::Error),
}

type Result<T> = std::result::Result<T, ManifestError>;

fn format_error(error: anyhow::Error) -> ManifestError {
    ManifestError::Format(error.to_string())
}

/// One chunk of the snapshot artefact, as the public index lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChunkRef {
    pub id: String,
    pub size: u64,
}

/// The half of a manifest a restore reads with no key at all.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublicEnvelope {
    pub key_epoch: u32,
    pub created_at: String,
    pub generation: u64,
    /// The previous generation's `manifestHash`, or `None` for the first.
    pub prev_manifest_hash: Option<String>,
    pub chunk_index: Vec<ChunkRef>,
    /// Free-form, and part of the AAD: a lie here costs the payload.
    pub app_meta: Value,
}

impl PublicEnvelope {
    #[must_use]
    pub fn to_json(&self) -> Value {
        serde_json::json!({
            "format": SNAPSHOT_FORMAT,
            "keyEpoch": self.key_epoch,
            "createdAt": self.created_at,
            "generation": self.generation,
            "prevManifestHash": self.prev_manifest_hash,
            "chunkIndex": self.chunk_index.iter().map(|chunk| serde_json::json!({
                "id": chunk.id,
                "size": chunk.size,
            })).collect::<Vec<_>>(),
            "appMeta": self.app_meta,
        })
    }

    pub fn from_json(value: &Value) -> Result<Self> {
        let invalid = |what: &str| ManifestError::Format(what.to_owned());
        if value.get("format").and_then(Value::as_str) != Some(SNAPSHOT_FORMAT) {
            return Err(invalid("unsupported snapshot format"));
        }
        let chunk_index = value
            .get("chunkIndex")
            .and_then(Value::as_array)
            .map(|chunks| {
                chunks
                    .iter()
                    .map(|chunk| ChunkRef {
                        id: chunk
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                        size: chunk
                            .get("size")
                            .and_then(Value::as_u64)
                            .unwrap_or_default(),
                    })
                    .collect()
            })
            .unwrap_or_default();
        Ok(Self {
            key_epoch: u32::try_from(
                value
                    .get("keyEpoch")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| invalid("manifest has no keyEpoch"))?,
            )
            .map_err(|_| invalid("keyEpoch out of range"))?,
            created_at: value
                .get("createdAt")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            generation: value
                .get("generation")
                .and_then(Value::as_u64)
                .ok_or_else(|| invalid("manifest has no generation"))?,
            prev_manifest_hash: value
                .get("prevManifestHash")
                .and_then(Value::as_str)
                .map(str::to_owned),
            chunk_index,
            app_meta: value.get("appMeta").cloned().unwrap_or(Value::Null),
        })
    }
}

/// A whole generation: the envelope, the payload it seals, and the WAL tail
/// that happened after the snapshot was taken.
#[derive(Debug, Clone)]
pub struct Generation {
    pub envelope: PublicEnvelope,
    /// The sealed half, as JSON. Shaped `{ entries: [...] }` in v0 and kept
    /// open here so a future entry field is additive.
    pub payload: Value,
    pub wal: Vec<WalSegment>,
}

/// Seal a generation's manifest. Returns the stored bytes and their hash,
/// which is the generation's address.
pub fn seal_manifest(
    master: &[u8],
    vault_id: &str,
    envelope: &PublicEnvelope,
    payload: &Value,
) -> Result<(Vec<u8>, String)> {
    let master: [u8; 32] = master
        .try_into()
        .map_err(|_| ManifestError::Format("master key must be 32 bytes".into()))?;
    centraid_media::format::seal_snapshot_manifest(&master, vault_id, &envelope.to_json(), payload)
        .map_err(format_error)
}

/// Open a stored manifest's payload, and hand back the public envelope too —
/// the caller needs both, and reading the envelope twice is how the two get to
/// disagree.
pub fn open_manifest(
    master: &[u8],
    vault_id: &str,
    stored: &[u8],
) -> Result<(PublicEnvelope, Value)> {
    let master: [u8; 32] = master
        .try_into()
        .map_err(|_| ManifestError::Format("master key must be 32 bytes".into()))?;
    let payload = centraid_media::format::open_snapshot_manifest(&master, vault_id, stored)
        .map_err(format_error)?;
    let value: Value = serde_json::from_slice(stored)?;
    Ok((PublicEnvelope::from_json(&value)?, payload))
}

/// The public half of a stored manifest, **without any key**.
///
/// This is what makes discovery possible before the operator has typed the
/// kit's password: generations, their chain and their sizes are readable, and
/// only the file list is not.
pub fn read_public_envelope(stored: &[u8]) -> Result<PublicEnvelope> {
    PublicEnvelope::from_json(&serde_json::from_slice::<Value>(stored)?)
}

/// A generation's address: the sha256 of its canonical stored bytes.
#[must_use]
pub fn manifest_hash(stored: &[u8]) -> String {
    centraid_media::format::sha256_hex(stored)
}

/// Follow `prevManifestHash` from the newest generation backwards.
///
/// Returns the chain newest-first, and stops at the first hash nothing
/// provides — a **gap is reported, never guessed past**: a restore that
/// silently skipped a generation would hand the owner a vault missing whatever
/// that generation held.
#[must_use]
pub fn chain_from<'a>(
    newest: &'a PublicEnvelope,
    by_hash: &'a std::collections::BTreeMap<String, PublicEnvelope>,
) -> (Vec<&'a PublicEnvelope>, Option<String>) {
    let mut chain = vec![newest];
    let mut cursor = newest.prev_manifest_hash.clone();
    let mut seen = std::collections::BTreeSet::new();
    while let Some(hash) = cursor {
        if !seen.insert(hash.clone()) {
            // A cycle is corruption, not a chain. Stop and name it.
            return (chain, Some(hash));
        }
        match by_hash.get(&hash) {
            Some(envelope) => {
                chain.push(envelope);
                cursor = envelope.prev_manifest_hash.clone();
            }
            None => return (chain, Some(hash)),
        }
    }
    (chain, None)
}

/// base64 of the sealed payload inside a stored manifest, for a caller that
/// wants to move the bytes without opening them.
pub fn sealed_payload_base64(stored: &[u8]) -> Result<String> {
    let value: Value = serde_json::from_slice(stored)?;
    value
        .get("sealedPayload")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| ManifestError::Format("manifest has no sealedPayload".into()))
}

/// Decoded sealed payload bytes.
pub fn sealed_payload(stored: &[u8]) -> Result<Vec<u8>> {
    STANDARD
        .decode(sealed_payload_base64(stored)?)
        .map_err(|_| ManifestError::Format("manifest payload is not base64".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::keyring::derive_data_key;

    const MASTER: [u8; 32] = [0xcc_u8; 32];
    const VAULT: &str = "vault-1";

    fn envelope(generation: u64, prev: Option<&str>) -> PublicEnvelope {
        PublicEnvelope {
            key_epoch: 1,
            created_at: "2026-07-18T00:00:00.000Z".into(),
            generation,
            prev_manifest_hash: prev.map(str::to_owned),
            chunk_index: vec![ChunkRef {
                id: "chunk-a".into(),
                size: 1024,
            }],
            app_meta: serde_json::json!({ "source": "test" }),
        }
    }

    fn payload() -> Value {
        serde_json::json!({ "entries": [
            { "path": "vault.db", "kind": "file", "size": 4096, "sha256": "ab" }
        ]})
    }

    #[test]
    fn a_manifest_round_trips_and_the_envelope_is_readable_without_a_key() {
        let (stored, hash) = seal_manifest(&MASTER, VAULT, &envelope(3, None), &payload()).unwrap();
        assert_eq!(hash, manifest_hash(&stored));
        let public = read_public_envelope(&stored).unwrap();
        assert_eq!(public, envelope(3, None), "discovery needs no key");
        let (again, opened) = open_manifest(&MASTER, VAULT, &stored).unwrap();
        assert_eq!(again, public);
        assert_eq!(opened, payload());
        assert!(!sealed_payload(&stored).unwrap().is_empty());
    }

    #[test]
    fn editing_the_public_envelope_costs_the_payload() {
        let (stored, _) = seal_manifest(&MASTER, VAULT, &envelope(3, None), &payload()).unwrap();
        let mut value: Value = serde_json::from_slice(&stored).unwrap();
        value["generation"] = serde_json::json!(4);
        let tampered = serde_json::to_vec(&value).unwrap();
        assert!(
            open_manifest(&MASTER, VAULT, &tampered).is_err(),
            "the envelope is the AAD: a re-pointed payload must not open"
        );
        // And a wrong vault id or epoch key opens nothing either.
        assert!(open_manifest(&MASTER, "vault-2", &stored).is_err());
        assert!(open_manifest(&[0xdd_u8; 32], VAULT, &stored).is_err());
    }

    #[test]
    fn the_manifest_is_sealed_under_the_derived_data_key_not_the_master() {
        // The master never encrypts anything directly; if it did, one leaked
        // generation key would be every vault's key.
        let (stored, _) = seal_manifest(&MASTER, VAULT, &envelope(1, None), &payload()).unwrap();
        let data_key = derive_data_key(&MASTER, VAULT).unwrap();
        assert_ne!(data_key, MASTER);
        assert!(
            open_manifest(&data_key, VAULT, &stored).is_err(),
            "the data key is derived inside the seal, not passed in already derived"
        );
    }

    #[test]
    fn the_chain_is_followed_backwards_and_a_gap_is_named_not_guessed_past() {
        let (first_stored, first_hash) =
            seal_manifest(&MASTER, VAULT, &envelope(1, None), &payload()).unwrap();
        let (_, second_hash) =
            seal_manifest(&MASTER, VAULT, &envelope(2, Some(&first_hash)), &payload()).unwrap();
        let third = envelope(3, Some(&second_hash));

        let mut by_hash = std::collections::BTreeMap::new();
        by_hash.insert(
            first_hash.clone(),
            read_public_envelope(&first_stored).unwrap(),
        );

        // The middle generation is missing from the store.
        let (chain, gap) = chain_from(&third, &by_hash);
        assert_eq!(chain.len(), 1);
        assert_eq!(gap.as_deref(), Some(second_hash.as_str()));

        // With it present, the chain runs to the root and reports no gap.
        let (second_stored, _) =
            seal_manifest(&MASTER, VAULT, &envelope(2, Some(&first_hash)), &payload()).unwrap();
        by_hash.insert(
            second_hash.clone(),
            read_public_envelope(&second_stored).unwrap(),
        );
        let (chain, gap) = chain_from(&third, &by_hash);
        assert_eq!(
            chain.iter().map(|e| e.generation).collect::<Vec<_>>(),
            vec![3, 2, 1]
        );
        assert_eq!(gap, None);
    }

    #[test]
    fn a_cycle_in_the_chain_is_corruption_and_terminates() {
        let mut by_hash = std::collections::BTreeMap::new();
        let loop_envelope = envelope(2, Some("h2"));
        by_hash.insert("h2".to_owned(), loop_envelope.clone());
        let (chain, gap) = chain_from(&loop_envelope, &by_hash);
        assert!(gap.is_some(), "a cycle is named, not walked forever");
        assert!(chain.len() <= 2);
    }

    #[test]
    fn a_manifest_naming_another_format_is_refused() {
        let stored = serde_json::to_vec(&serde_json::json!({
            "format": "centraid-snapshot/3",
            "keyEpoch": 1,
            "generation": 1,
            "sealedPayload": "AA==",
        }))
        .unwrap();
        assert!(read_public_envelope(&stored).is_err());
        assert!(open_manifest(&MASTER, VAULT, &stored).is_err());
    }
}
