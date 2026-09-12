//! The backup keyring and its derivations (#1020, D-1020-R1, D-1020-R5).
//!
//! **HKDF info strings are format-normative: editing one silently re-keys every
//! vault.** The three that exist:
//!
//! ```text
//! dataKey  = HKDF-SHA256(master, salt="", info="centraid-backup:data:<vaultId>",  32)
//! dedupKey = HKDF-SHA256(master, salt="", info="centraid-backup:dedup:<vaultId>", 32)
//! chunkId  = hex(HMAC-SHA256(dedupKey, plain))
//! ```
//!
//! Object nonces are **deterministic** (#408): a chunk's from its keyed content
//! hash, a WAL segment's from the **full** segment address including both
//! offsets. That last detail is the one a port gets wrong: a crash-retry that
//! ships a longer segment from the same start offset must get a *different*
//! nonce, and only including `endOffset` achieves that. See [`super::wal`].
//!
//! A keyring carries every epoch every snapshot was ever sealed under, because
//! a restore may reach back past a rotation. `validate` refuses a wrong
//! version, a non-numeric `active`, an empty epoch list, a key that is not
//! base64-of-32, a missing `createdAt`, or an `active` that names no epoch —
//! each one is a kit that would fail three phases into a restore instead of at
//! the door.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde::{Deserialize, Serialize};

/// Every key in the plane is 32 bytes.
pub const KEY_BYTES: usize = 32;

#[derive(Debug, thiserror::Error)]
pub enum KeyringError {
    #[error("keyring: {0}")]
    Invalid(String),
    #[error("keyring has no epoch {0}")]
    NoSuchEpoch(u32),
    #[error("HKDF output length is invalid")]
    Hkdf,
}

type Result<T> = std::result::Result<T, KeyringError>;

/// One master key generation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeyringEpoch {
    pub epoch: u32,
    /// base64 of exactly 32 bytes.
    pub key: String,
    pub created_at: String,
}

/// Every epoch every snapshot was sealed under, and which one is current.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Keyring {
    pub version: u32,
    pub active: u32,
    pub epochs: Vec<KeyringEpoch>,
}

impl Keyring {
    /// Parse and validate a keyring from the JSON a kit carries.
    ///
    /// Strict on purpose: every refusal here is a restore that would otherwise
    /// fail with an opaque provider error long after the operator could act on
    /// it.
    pub fn from_json(value: &serde_json::Value) -> Result<Self> {
        let invalid = |what: &str| KeyringError::Invalid(what.to_owned());
        let object = value.as_object().ok_or_else(|| invalid("not an object"))?;
        if object.get("version").and_then(serde_json::Value::as_u64) != Some(1) {
            return Err(invalid("unsupported version"));
        }
        let active = object
            .get("active")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| invalid("missing \"active\""))?;
        let epochs_value = object
            .get("epochs")
            .and_then(serde_json::Value::as_array)
            .filter(|epochs| !epochs.is_empty())
            .ok_or_else(|| invalid("missing \"epochs\""))?;
        let mut epochs = Vec::with_capacity(epochs_value.len());
        for entry in epochs_value {
            let entry = entry
                .as_object()
                .ok_or_else(|| invalid("malformed epoch"))?;
            let epoch = entry
                .get("epoch")
                .and_then(serde_json::Value::as_u64)
                .ok_or_else(|| invalid("epoch missing \"epoch\""))?;
            let key = entry
                .get("key")
                .and_then(serde_json::Value::as_str)
                .filter(|key| {
                    STANDARD
                        .decode(key)
                        .is_ok_and(|bytes| bytes.len() == KEY_BYTES)
                })
                .ok_or_else(|| invalid("epoch key must be base64 of 32 bytes"))?;
            let created_at = entry
                .get("createdAt")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| invalid("epoch missing \"createdAt\""))?;
            epochs.push(KeyringEpoch {
                epoch: u32::try_from(epoch).map_err(|_| invalid("epoch out of range"))?,
                key: key.to_owned(),
                created_at: created_at.to_owned(),
            });
        }
        let active = u32::try_from(active).map_err(|_| invalid("\"active\" out of range"))?;
        if !epochs.iter().any(|entry| entry.epoch == active) {
            return Err(invalid("\"active\" does not name an existing epoch"));
        }
        Ok(Self {
            version: 1,
            active,
            epochs,
        })
    }

    /// The JSON shape, for a kit this gateway writes.
    #[must_use]
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "version": self.version,
            "active": self.active,
            "epochs": self.epochs.iter().map(|epoch| serde_json::json!({
                "epoch": epoch.epoch,
                "key": epoch.key,
                "createdAt": epoch.created_at,
            })).collect::<Vec<_>>(),
        })
    }

    /// The master key for one epoch. A restore reaching past a rotation asks
    /// for an older epoch by number, never for "the key".
    pub fn master_for_epoch(&self, epoch: u32) -> Result<[u8; KEY_BYTES]> {
        let entry = self
            .epochs
            .iter()
            .find(|candidate| candidate.epoch == epoch)
            .ok_or(KeyringError::NoSuchEpoch(epoch))?;
        STANDARD
            .decode(&entry.key)
            .ok()
            .and_then(|bytes| <[u8; KEY_BYTES]>::try_from(bytes).ok())
            .ok_or_else(|| KeyringError::Invalid("epoch key must be base64 of 32 bytes".into()))
    }

    /// The master key a new artefact is sealed under.
    pub fn active_master(&self) -> Result<(u32, [u8; KEY_BYTES])> {
        Ok((self.active, self.master_for_epoch(self.active)?))
    }
}

/// HKDF-SHA256 with an **empty salt** and `info` as the uniqueness argument.
pub fn hkdf_bytes(key: &[u8], info: &str, length: usize) -> Result<Vec<u8>> {
    let hk = hkdf::Hkdf::<sha2::Sha256>::new(Some(&[]), key);
    let mut out = vec![0_u8; length];
    hk.expand(info.as_bytes(), &mut out)
        .map_err(|_| KeyringError::Hkdf)?;
    Ok(out)
}

/// `dataKey` — what every object for this vault is sealed under.
pub fn derive_data_key(master: &[u8], vault_id: &str) -> Result<[u8; KEY_BYTES]> {
    hkdf_bytes(
        master,
        &format!("centraid-backup:data:{vault_id}"),
        KEY_BYTES,
    )?
    .try_into()
    .map_err(|_| KeyringError::Hkdf)
}

/// `dedupKey` — a **separate** key, so a chunk id reveals nothing that helps
/// open a chunk.
pub fn derive_dedup_key(master: &[u8], vault_id: &str) -> Result<[u8; KEY_BYTES]> {
    hkdf_bytes(
        master,
        &format!("centraid-backup:dedup:{vault_id}"),
        KEY_BYTES,
    )?
    .try_into()
    .map_err(|_| KeyringError::Hkdf)
}

/// `chunkId = hex(HMAC-SHA256(dedupKey, plain))`. Keyed, so identical bytes in
/// two different vaults do not have the same address.
#[must_use]
pub fn chunk_id(dedup_key: &[u8], plain: &[u8]) -> String {
    use hmac::Mac as _;
    use sha2::digest::KeyInit as _;
    let mut mac =
        <hmac::Hmac<sha2::Sha256>>::new_from_slice(dedup_key).expect("HMAC accepts any key length");
    mac.update(plain);
    hex::encode(mac.finalize().into_bytes())
}

/// A 12-byte nonce derived from `info`. Deterministic by design (#408): the
/// same address always gets the same nonce, and a *different* address never
/// gets the same one.
pub fn derive_nonce(key: &[u8], info: &str) -> Result<[u8; 12]> {
    hkdf_bytes(key, info, 12)?
        .try_into()
        .map_err(|_| KeyringError::Hkdf)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keyring_json(active: u32) -> serde_json::Value {
        serde_json::json!({
            "version": 1,
            "active": active,
            "epochs": [
                { "epoch": 1, "key": STANDARD.encode([1_u8; 32]), "createdAt": "2026-01-01T00:00:00.000Z" },
                { "epoch": 2, "key": STANDARD.encode([2_u8; 32]), "createdAt": "2026-06-01T00:00:00.000Z" },
            ],
        })
    }

    #[test]
    fn a_keyring_round_trips_and_names_its_epochs() {
        let keyring = Keyring::from_json(&keyring_json(2)).unwrap();
        assert_eq!(keyring.active, 2);
        assert_eq!(keyring.master_for_epoch(1).unwrap(), [1_u8; 32]);
        assert_eq!(keyring.active_master().unwrap(), (2, [2_u8; 32]));
        assert!(matches!(
            keyring.master_for_epoch(3),
            Err(KeyringError::NoSuchEpoch(3))
        ));
        assert_eq!(
            Keyring::from_json(&keyring.to_json()).unwrap(),
            keyring,
            "to_json and from_json are inverses"
        );
    }

    #[test]
    fn every_malformed_keyring_is_refused_at_the_door() {
        let cases = [
            serde_json::json!([]),
            serde_json::json!({ "version": 2, "active": 1, "epochs": [] }),
            serde_json::json!({ "version": 1, "epochs": [] }),
            serde_json::json!({ "version": 1, "active": 1, "epochs": [] }),
            // A key that is base64 of the wrong length.
            serde_json::json!({ "version": 1, "active": 1, "epochs": [
                { "epoch": 1, "key": STANDARD.encode([1_u8; 16]), "createdAt": "x" }
            ]}),
            // A key that is not base64 at all.
            serde_json::json!({ "version": 1, "active": 1, "epochs": [
                { "epoch": 1, "key": "not base64!!", "createdAt": "x" }
            ]}),
            // No createdAt.
            serde_json::json!({ "version": 1, "active": 1, "epochs": [
                { "epoch": 1, "key": STANDARD.encode([1_u8; 32]) }
            ]}),
            // `active` names no epoch — the one that would otherwise surface
            // three phases into a restore.
            keyring_json(9),
        ];
        for (index, case) in cases.iter().enumerate() {
            assert!(
                Keyring::from_json(case).is_err(),
                "case {index} should be refused: {case}"
            );
        }
    }

    #[test]
    fn the_data_and_dedup_keys_are_different_and_vault_scoped() {
        let master = [7_u8; 32];
        let data = derive_data_key(&master, "vault-a").unwrap();
        let dedup = derive_dedup_key(&master, "vault-a").unwrap();
        assert_ne!(data, dedup, "one master, two independent keys");
        assert_ne!(
            data,
            derive_data_key(&master, "vault-b").unwrap(),
            "the info string carries the vault id"
        );
        assert_ne!(
            chunk_id(&dedup, b"the same bytes"),
            chunk_id(
                &derive_dedup_key(&master, "vault-b").unwrap(),
                b"the same bytes"
            ),
            "identical bytes in two vaults are not one address"
        );
        assert_eq!(chunk_id(&dedup, b"x").len(), 64);
    }

    #[test]
    fn a_derived_nonce_is_stable_for_its_info_and_unique_across_infos() {
        let key = [8_u8; 32];
        assert_eq!(
            derive_nonce(&key, "a").unwrap(),
            derive_nonce(&key, "a").unwrap()
        );
        assert_ne!(
            derive_nonce(&key, "a").unwrap(),
            derive_nonce(&key, "b").unwrap()
        );
    }
}
