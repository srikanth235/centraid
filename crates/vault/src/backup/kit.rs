//! The recovery kit: the one artefact that carries keys (#1020, D-1020-R3).
//!
//! Everything else a gateway writes carries ciphertext. A directory copy, an
//! export, a snapshot — none of them hold the seal key, the identity seed or
//! `K`. The kit does, and that is its whole reason to exist: it is the file in
//! a member's drawer that turns a pile of encrypted bytes back into a vault.
//!
//! ## Always wrapped, and never a way around it
//!
//! On disk a kit is `kind: "centraid-recovery-kit-wrapped"`: a header anyone
//! can read (version, kind, createdAt, fingerprint, scrypt parameters, salt,
//! nonce, tag) around a body only the password opens. AAD is
//! `centraid-recovery-kit-wrap-v1`, the KDF is scrypt at N = 2^17, r = 8, p = 1
//! — deliberately expensive, because it is the only thing between the file and
//! the keys.
//!
//! **Never add an unwrapped acceptance path** (v0 #568). A parser that accepts
//! a plain `centraid-recovery-kit` silently ignores the password, and every
//! caller that treats "parse succeeded" as "the owner knows the password" then
//! has a password-free branch reachable from the kit file itself.
//! [`parse_recovery_kit`] refuses one, and a test asserts the refusal.
//!
//! ## The one place v1 reads a v0 artefact, deliberately (D-1020-R3)
//!
//! #1020 is explicit that there is no v0-artefact compatibility — a seat file
//! and a pairing ticket are re-made in a ceremony the owner is present for. A
//! recovery kit is not like that. It is written once and opened years later, on
//! the day everything else is gone; it is the one artefact whose purpose is to
//! outlive the software that wrote it. **A recovery kit in a member's drawer
//! must stay openable.** So v1's parser opens a v0-made kit, and
//! `contracts/custody/recovery-kit.json` — produced by v0's own
//! `wrapRecoveryKit` under a fixed password, via
//! `contracts/tools/export-recovery-kit-fixture.ts` — is how that is proven
//! rather than asserted. This is a v1 design choice about one file format; it
//! does not reopen seat files or tickets.
//!
//! ## The fingerprint is a capability, not a checksum
//!
//! Labels and `createdAt` are **excluded**: renaming a vault does not change
//! what the kit can restore. Which Locker keys it carries **is** included,
//! because a kit that lost one restores a vault whose secrets do not open — a
//! real capability difference an owner must be able to notice.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Value, json};

use crate::backup::keyring::{Keyring, KeyringError};

const KIT_KIND: &str = "centraid-recovery-kit";
const WRAPPED_KIT_KIND: &str = "centraid-recovery-kit-wrapped";
const WRAP_AAD: &[u8] = b"centraid-recovery-kit-wrap-v1";
const KIT_LABEL: &str = "recovery kit";

/// scrypt at v0's parameters. **Format-normative**: a kit written under these
/// is opened under whatever its own header says, but a kit *written* now uses
/// these, and lowering them lowers the cost of every future kit.
pub const RECOVERY_KIT_SCRYPT_LOG_N: u8 = 17;
pub const RECOVERY_KIT_SCRYPT_R: u32 = 8;
pub const RECOVERY_KIT_SCRYPT_P: u32 = 1;

/// The passphrase floor (v0 #1014 X13). Checked **on the way in, never on the
/// way out**: a kit written before this floor existed must still open, because
/// a strength rule that locks an owner out of their own recovery material is
/// worse than the weak password it prevents.
pub const PASSPHRASE_MIN_CHARS: usize = 12;
pub const PASSPHRASE_MIN_WORDS: usize = 4;

#[derive(Debug, thiserror::Error)]
pub enum KitError {
    #[error("recovery kit: {0}")]
    Invalid(String),
    /// One message for a wrong password and for a corrupt file, on purpose: an
    /// oracle that distinguishes them tells an attacker which half to work on.
    #[error("recovery kit: wrong password or corrupt file ({0})")]
    WrongPasswordOrCorrupt(String),
    #[error(
        "recovery kit: password must be at least {PASSPHRASE_MIN_CHARS} characters or {PASSPHRASE_MIN_WORDS} words"
    )]
    PassphraseTooWeak,
    #[error("recovery kit: password is required")]
    PasswordRequired,
    #[error(transparent)]
    Keyring(#[from] KeyringError),
}

type Result<T> = std::result::Result<T, KitError>;

/// One vault this gateway backs up: how to reach it and what opens it.
///
/// All four addressing fields are required — they are load-bearing for a
/// restore, and a kit missing one is a kit that fails at the provider three
/// phases in instead of at the door.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RecoveryKitTarget {
    pub provider: String,
    pub target_id: String,
    pub vault_id: String,
    pub label: String,
    /// base64. The vault DEK.
    pub seal_key: Option<String>,
    /// base64. The gateway's identity seed for this vault.
    pub identity_seed: Option<String>,
    /// Every live Locker key file. Not always one: `K′` exists on disk before
    /// the DB names it, so a kit written mid-rotation carries both.
    pub locker_keys: Vec<LockerKeyEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LockerKeyEntry {
    pub key_id: String,
    /// base64 of the key material.
    pub key: String,
}

/// A parsed and validated recovery kit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoveryKitDocument {
    pub created_at: String,
    pub keyring: Keyring,
    pub targets: Vec<RecoveryKitTarget>,
}

impl RecoveryKitDocument {
    /// The canonical plain JSON — what the wrap seals and the fingerprint is
    /// taken over.
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "version": 1,
            "kind": KIT_KIND,
            "createdAt": self.created_at,
            "keyring": self.keyring.to_json(),
            "targets": self.targets.iter().map(|target| {
                let mut object = serde_json::Map::new();
                object.insert("provider".into(), json!(target.provider));
                object.insert("targetId".into(), json!(target.target_id));
                object.insert("vaultId".into(), json!(target.vault_id));
                object.insert("label".into(), json!(target.label));
                if let Some(key) = &target.seal_key {
                    object.insert("sealKey".into(), json!(key));
                }
                if let Some(seed) = &target.identity_seed {
                    object.insert("identitySeed".into(), json!(seed));
                }
                if !target.locker_keys.is_empty() {
                    object.insert("lockerKeys".into(), json!(target.locker_keys.iter().map(|entry| json!({
                        "keyId": entry.key_id,
                        "key": entry.key,
                    })).collect::<Vec<_>>()));
                }
                Value::Object(object)
            }).collect::<Vec<_>>(),
        })
    }

    /// Parse a plain kit document. Strict: every refusal here is a restore that
    /// would otherwise fail long after the operator could act on it.
    pub fn from_json(value: &Value) -> Result<Self> {
        let invalid = |what: String| KitError::Invalid(what);
        let object = value
            .as_object()
            .ok_or_else(|| invalid("not an object".into()))?;
        match object.get("kind").and_then(Value::as_str) {
            Some(KIT_KIND) => {}
            other => {
                return Err(invalid(format!(
                    "not a {KIT_KIND} (kind={other:?}) — this is not a centraid recovery kit"
                )));
            }
        }
        if object.get("version").and_then(Value::as_u64) != Some(1) {
            return Err(invalid(format!(
                "unsupported version {:?} — update the gateway",
                object.get("version")
            )));
        }
        let keyring = Keyring::from_json(
            object
                .get("keyring")
                .ok_or_else(|| invalid("missing \"keyring\"".into()))?,
        )?;
        let targets_value = object
            .get("targets")
            .and_then(Value::as_array)
            .ok_or_else(|| invalid("\"targets\" must be an array".into()))?;
        let mut targets = Vec::with_capacity(targets_value.len());
        for (index, target) in targets_value.iter().enumerate() {
            targets.push(parse_target(target, index)?);
        }
        Ok(Self {
            created_at: object
                .get("createdAt")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            keyring,
            targets,
        })
    }

    /// The target for a vault id, which is how `recover --vault` addresses one.
    #[must_use]
    pub fn target_for(&self, vault_id: &str) -> Option<&RecoveryKitTarget> {
        self.targets
            .iter()
            .find(|target| target.vault_id == vault_id)
    }
}

fn parse_target(value: &Value, index: usize) -> Result<RecoveryKitTarget> {
    let object = value
        .as_object()
        .ok_or_else(|| KitError::Invalid(format!("target {index} is not an object")))?;
    let mut required = [""; 4];
    for (slot, field) in ["provider", "targetId", "vaultId", "label"]
        .iter()
        .enumerate()
    {
        required[slot] = object
            .get(*field)
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .ok_or_else(|| KitError::Invalid(format!("target {index} is missing \"{field}\"")))?;
    }
    let mut locker_keys = Vec::new();
    if let Some(entries) = object.get("lockerKeys").and_then(Value::as_array) {
        for (position, entry) in entries.iter().enumerate() {
            let entry = entry.as_object().ok_or_else(|| {
                KitError::Invalid(format!(
                    "target {index} lockerKeys[{position}] needs a \"keyId\" and a \"key\""
                ))
            })?;
            let key_id = entry
                .get("keyId")
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty());
            let key = entry
                .get("key")
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty());
            match (key_id, key) {
                (Some(key_id), Some(key)) => locker_keys.push(LockerKeyEntry {
                    key_id: key_id.to_owned(),
                    key: key.to_owned(),
                }),
                _ => {
                    return Err(KitError::Invalid(format!(
                        "target {index} lockerKeys[{position}] needs a \"keyId\" and a \"key\""
                    )));
                }
            }
        }
    }
    Ok(RecoveryKitTarget {
        provider: required[0].to_owned(),
        target_id: required[1].to_owned(),
        vault_id: required[2].to_owned(),
        label: required[3].to_owned(),
        seal_key: object
            .get("sealKey")
            .and_then(Value::as_str)
            .map(str::to_owned),
        identity_seed: object
            .get("identitySeed")
            .and_then(Value::as_str)
            .map(str::to_owned),
        locker_keys,
    })
}

fn sha256_of_base64(value: &str) -> String {
    centraid_media::format::sha256_hex(&STANDARD.decode(value).unwrap_or_default())
}

/// The stable **capability** fingerprint over canonical JSON.
///
/// Epochs sorted by number, targets by `vaultId` then `targetId`, every key
/// present as a sha256 of its material. Labels and `createdAt` are excluded
/// because cosmetic changes do not alter recovery ability.
#[must_use]
pub fn recovery_kit_fingerprint(document: &RecoveryKitDocument) -> String {
    let mut epochs = document.keyring.epochs.clone();
    epochs.sort_by_key(|epoch| epoch.epoch);
    let mut targets = document.targets.clone();
    // v0 sorts with `localeCompare`; Rust compares UTF-8 bytes. The two agree
    // for the ASCII ids a target actually carries (a vault id is a UUID), and
    // `contracts/custody/recovery-kit.json` is the check that they agree for
    // the fixture. Noted rather than hidden: a non-ASCII targetId would be the
    // one input that could disagree.
    targets.sort_by(|left, right| {
        left.vault_id
            .cmp(&right.vault_id)
            .then_with(|| left.target_id.cmp(&right.target_id))
    });
    let preimage = json!({
        "version": 1,
        "keyring": epochs.iter().map(|epoch| json!({
            "epoch": epoch.epoch,
            "keyHash": sha256_of_base64(&epoch.key),
        })).collect::<Vec<_>>(),
        "targets": targets.iter().map(|target| {
            let mut locker_keys = target.locker_keys.clone();
            locker_keys.sort_by(|left, right| left.key_id.cmp(&right.key_id));
            json!({
                "provider": target.provider,
                "targetId": target.target_id,
                "vaultId": target.vault_id,
                "sealkeyHash": target.seal_key.as_deref().map(sha256_of_base64),
                "identitySeedHash": target.identity_seed.as_deref().map(sha256_of_base64),
                "lockerKeyHashes": locker_keys.iter().map(|entry| json!({
                    "keyId": entry.key_id,
                    "keyHash": sha256_of_base64(&entry.key),
                })).collect::<Vec<_>>(),
            })
        }).collect::<Vec<_>>(),
    });
    centraid_media::format::sha256_hex(centraid_media::format::canonical_json(&preimage).as_bytes())
}

/// The passphrase floor, checked when a kit is **sealed**.
pub fn assert_passphrase_floor(passphrase: &str) -> Result<()> {
    if passphrase.is_empty() {
        return Err(KitError::PasswordRequired);
    }
    let words = passphrase.split_whitespace().count();
    if passphrase.chars().count() >= PASSPHRASE_MIN_CHARS || words >= PASSPHRASE_MIN_WORDS {
        Ok(())
    } else {
        Err(KitError::PassphraseTooWeak)
    }
}

fn derive_wrap_key(passphrase: &str, salt: &[u8], log_n: u8, r: u32, p: u32) -> Result<[u8; 32]> {
    if passphrase.is_empty() {
        return Err(KitError::PasswordRequired);
    }
    let params = scrypt::Params::new(log_n, r, p).map_err(|error| {
        KitError::Invalid(format!("wrapped header has invalid scrypt: {error}"))
    })?;
    let mut key = [0_u8; 32];
    scrypt::scrypt(passphrase.as_bytes(), salt, &params, &mut key)
        .map_err(|error| KitError::Invalid(format!("scrypt failed: {error}")))?;
    Ok(key)
}

/// Seal a kit under a password. The plaintext never leaves this call.
pub fn wrap_recovery_kit(document: &RecoveryKitDocument, passphrase: &str) -> Result<Value> {
    assert_passphrase_floor(passphrase)?;
    // Re-parse, so a document assembled in memory is held to the same rules a
    // document read from disk is.
    let plain = RecoveryKitDocument::from_json(&document.to_json())?;
    let salt = crate::custody::random_bytes::<16>();
    let nonce = crate::custody::random_bytes::<12>();
    let key = derive_wrap_key(
        passphrase,
        &salt,
        RECOVERY_KIT_SCRYPT_LOG_N,
        RECOVERY_KIT_SCRYPT_R,
        RECOVERY_KIT_SCRYPT_P,
    )?;
    let body = {
        use aes_gcm::aead::{Aead, Payload};
        use aes_gcm::{Aes256Gcm, KeyInit};
        let cipher = Aes256Gcm::new_from_slice(&key)
            .map_err(|_| KitError::Invalid("wrap key length".into()))?;
        cipher
            .encrypt(
                (&nonce).into(),
                Payload {
                    msg: centraid_media::format::canonical_json(&plain.to_json()).as_bytes(),
                    aad: WRAP_AAD,
                },
            )
            .map_err(|_| KitError::Invalid("wrap failed".into()))?
    };
    let (ciphertext, tag) = body.split_at(body.len() - 16);
    Ok(json!({
        "version": 1,
        "kind": WRAPPED_KIT_KIND,
        "createdAt": plain.created_at,
        "fingerprint": recovery_kit_fingerprint(&plain),
        "kdf": "scrypt",
        "N": 1_u64 << RECOVERY_KIT_SCRYPT_LOG_N,
        "r": RECOVERY_KIT_SCRYPT_R,
        "p": RECOVERY_KIT_SCRYPT_P,
        "salt": STANDARD.encode(salt),
        "nonce": STANDARD.encode(nonce),
        "tag": STANDARD.encode(tag),
        "ciphertext": STANDARD.encode(ciphertext),
    }))
}

/// Open a wrapped kit.
///
/// There is **no unwrapped acceptance path**: a plain `centraid-recovery-kit`
/// is refused here, however well-formed it is.
pub fn parse_recovery_kit(value: &Value, passphrase: &str) -> Result<RecoveryKitDocument> {
    let object = value
        .as_object()
        .filter(|object| object.get("kind").and_then(Value::as_str) == Some(WRAPPED_KIT_KIND));
    let Some(object) = object else {
        return Err(KitError::Invalid(format!(
            "expected a password-wrapped kit (\"{WRAPPED_KIT_KIND}\"); unwrapped kits are not accepted"
        )));
    };
    if object.get("kdf").and_then(Value::as_str) != Some("scrypt") {
        return Err(KitError::Invalid("unsupported KDF".into()));
    }
    let mut cost = [0_u64; 3];
    for (slot, field) in ["N", "r", "p"].iter().enumerate() {
        cost[slot] = object
            .get(*field)
            .and_then(Value::as_u64)
            .ok_or_else(|| KitError::Invalid(format!("wrapped header has invalid \"{field}\"")))?;
    }
    let mut parts = [""; 4];
    for (slot, field) in ["salt", "nonce", "tag", "ciphertext"].iter().enumerate() {
        parts[slot] = object
            .get(*field)
            .and_then(Value::as_str)
            .ok_or_else(|| KitError::Invalid(format!("wrapped header is missing \"{field}\"")))?;
    }
    if passphrase.is_empty() {
        return Err(KitError::PasswordRequired);
    }

    // `N` is stored as the cost itself; scrypt's Params takes its log.
    let log_n = cost[0]
        .checked_ilog2()
        .filter(|log| 1_u64 << log == cost[0])
        .and_then(|log| u8::try_from(log).ok())
        .ok_or_else(|| KitError::Invalid("wrapped header has invalid \"N\"".into()))?;
    let opened = (|| -> Result<RecoveryKitDocument> {
        let decode = |what: &str, value: &str| {
            STANDARD
                .decode(value)
                .map_err(|_| KitError::Invalid(format!("wrapped header \"{what}\" is not base64")))
        };
        let salt = decode("salt", parts[0])?;
        let nonce: [u8; 12] = decode("nonce", parts[1])?
            .try_into()
            .map_err(|_| KitError::Invalid("wrapped header \"nonce\" length".into()))?;
        let mut body = decode("ciphertext", parts[3])?;
        body.extend_from_slice(&decode("tag", parts[2])?);
        let key = derive_wrap_key(
            passphrase,
            &salt,
            log_n,
            u32::try_from(cost[1])
                .map_err(|_| KitError::Invalid("wrapped header has invalid \"r\"".into()))?,
            u32::try_from(cost[2])
                .map_err(|_| KitError::Invalid("wrapped header has invalid \"p\"".into()))?,
        )?;
        let plain = {
            use aes_gcm::aead::{Aead, Payload};
            use aes_gcm::{Aes256Gcm, KeyInit};
            let cipher = Aes256Gcm::new_from_slice(&key)
                .map_err(|_| KitError::Invalid("wrap key length".into()))?;
            cipher
                .decrypt(
                    (&nonce).into(),
                    Payload {
                        msg: &body,
                        aad: WRAP_AAD,
                    },
                )
                .map_err(|_| KitError::Invalid("authentication failed".into()))?
        };
        let parsed = RecoveryKitDocument::from_json(
            &serde_json::from_slice::<Value>(&plain)
                .map_err(|error| KitError::Invalid(error.to_string()))?,
        )?;
        // The header's fingerprint is re-checked against what actually opened,
        // so a header edited to advertise different capabilities is caught.
        if object.get("fingerprint").and_then(Value::as_str)
            != Some(recovery_kit_fingerprint(&parsed).as_str())
        {
            return Err(KitError::Invalid("fingerprint mismatch".into()));
        }
        Ok(parsed)
    })();
    opened.map_err(|error| {
        // One message, whatever went wrong inside — see `KitError`.
        KitError::WrongPasswordOrCorrupt(
            error
                .to_string()
                .trim_start_matches(&format!("{KIT_LABEL}: "))
                .trim_start_matches("recovery kit: ")
                .to_owned(),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The fixture v0 produced. Reading it here is the D-1020-R3 proof: the v1
    /// parser opens bytes v1 did not make.
    const V0_FIXTURE: &str = include_str!("../../../../contracts/custody/recovery-kit.json");

    fn fixture() -> Value {
        serde_json::from_str(V0_FIXTURE).unwrap()
    }

    fn document() -> RecoveryKitDocument {
        RecoveryKitDocument::from_json(&fixture()["document"]).unwrap()
    }

    /// **D-1020-R3.** A recovery kit in a member's drawer must stay openable.
    #[test]
    fn a_v0_made_wrapped_kit_opens_in_rust() {
        let fixture = fixture();
        let password = fixture["password"].as_str().unwrap();
        let opened = parse_recovery_kit(&fixture["wrapped"], password).unwrap();
        assert_eq!(
            opened,
            document(),
            "the document v0 sealed is the one we get"
        );
        assert_eq!(opened.keyring.active, 2);
        assert_eq!(opened.targets.len(), 2);
        let first = &opened.targets[0];
        assert_eq!(first.locker_keys.len(), 2);
        assert!(first.seal_key.is_some() && first.identity_seed.is_some());
        // The second target carries no key material at all, which is legal.
        assert!(opened.targets[1].locker_keys.is_empty());
        assert!(opened.targets[1].seal_key.is_none());
    }

    /// The fingerprint is a cross-language agreement too: v0 computed the one
    /// in the fixture header.
    #[test]
    fn the_capability_fingerprint_matches_the_one_v0_computed() {
        let fixture = fixture();
        assert_eq!(
            recovery_kit_fingerprint(&document()),
            fixture["fingerprint"].as_str().unwrap()
        );
        assert_eq!(
            recovery_kit_fingerprint(&document()),
            fixture["wrapped"]["fingerprint"].as_str().unwrap()
        );
    }

    #[test]
    fn the_scrypt_parameters_are_the_ones_the_fixture_publishes() {
        let fixture = fixture();
        assert_eq!(
            fixture["scrypt"]["N"].as_u64(),
            Some(1 << RECOVERY_KIT_SCRYPT_LOG_N)
        );
        assert_eq!(
            fixture["scrypt"]["r"].as_u64(),
            Some(u64::from(RECOVERY_KIT_SCRYPT_R))
        );
        assert_eq!(
            fixture["scrypt"]["p"].as_u64(),
            Some(u64::from(RECOVERY_KIT_SCRYPT_P))
        );
        assert_eq!(
            fixture["wrapAad"].as_str(),
            Some(std::str::from_utf8(WRAP_AAD).unwrap())
        );
    }

    #[test]
    fn a_wrong_password_is_one_answer_with_a_corrupt_file() {
        let fixture = fixture();
        let wrong = parse_recovery_kit(&fixture["wrapped"], "not the password at all").unwrap_err();
        assert!(
            matches!(wrong, KitError::WrongPasswordOrCorrupt(_)),
            "{wrong}"
        );

        let mut tampered = fixture["wrapped"].clone();
        let ciphertext = tampered["ciphertext"].as_str().unwrap().to_owned();
        let mut raw = STANDARD.decode(&ciphertext).unwrap();
        raw[0] ^= 1;
        tampered["ciphertext"] = json!(STANDARD.encode(raw));
        let corrupt =
            parse_recovery_kit(&tampered, fixture["password"].as_str().unwrap()).unwrap_err();
        assert!(matches!(corrupt, KitError::WrongPasswordOrCorrupt(_)));
        assert_eq!(
            wrong.to_string(),
            corrupt.to_string(),
            "an oracle that separates the two tells an attacker which half to work on"
        );
    }

    /// v0 #568. The prohibition, with a test on it.
    #[test]
    fn an_unwrapped_kit_is_refused_however_well_formed_it_is() {
        let plain = document().to_json();
        // It parses as a plain document…
        assert!(RecoveryKitDocument::from_json(&plain).is_ok());
        // …and the kit reader still refuses it, with and without a password.
        for password in ["", "correct horse battery staple"] {
            let error = parse_recovery_kit(&plain, password).unwrap_err();
            assert!(
                error
                    .to_string()
                    .contains("unwrapped kits are not accepted"),
                "{error}"
            );
        }
    }

    #[test]
    fn a_header_edited_to_advertise_other_capabilities_is_caught() {
        let fixture = fixture();
        let mut edited = fixture["wrapped"].clone();
        edited["fingerprint"] = json!("0".repeat(64));
        let error = parse_recovery_kit(&edited, fixture["password"].as_str().unwrap()).unwrap_err();
        assert!(
            error.to_string().contains("fingerprint mismatch"),
            "{error}"
        );
    }

    #[test]
    fn the_fingerprint_ignores_cosmetics_and_notices_a_lost_locker_key() {
        let base = document();
        let mut renamed = base.clone();
        renamed.created_at = "2030-01-01T00:00:00.000Z".into();
        renamed.targets[0].label = "a different name for the same vault".into();
        assert_eq!(
            recovery_kit_fingerprint(&base),
            recovery_kit_fingerprint(&renamed),
            "renaming a vault does not change what the kit can restore"
        );

        let mut lost = base.clone();
        lost.targets[0].locker_keys.pop();
        assert_ne!(
            recovery_kit_fingerprint(&base),
            recovery_kit_fingerprint(&lost),
            "a kit that lost a Locker key restores a vault whose secrets do not open"
        );

        // Target and epoch order are not capabilities either.
        let mut reordered = base.clone();
        reordered.targets.reverse();
        reordered.keyring.epochs.reverse();
        reordered.targets[0].locker_keys.reverse();
        assert_eq!(
            recovery_kit_fingerprint(&base),
            recovery_kit_fingerprint(&reordered)
        );
    }

    #[test]
    fn a_round_trip_through_our_own_wrap_opens_again() {
        // Cheap only because `wrap` and `parse` each pay scrypt once.
        let base = document();
        let wrapped = wrap_recovery_kit(&base, "correct horse battery staple").unwrap();
        assert_eq!(wrapped["kind"], json!("centraid-recovery-kit-wrapped"));
        assert_eq!(
            parse_recovery_kit(&wrapped, "correct horse battery staple").unwrap(),
            base
        );
    }

    #[test]
    fn the_passphrase_floor_is_on_the_way_in_and_never_on_the_way_out() {
        assert!(matches!(
            assert_passphrase_floor(""),
            Err(KitError::PasswordRequired)
        ));
        assert!(matches!(
            assert_passphrase_floor("a"),
            Err(KitError::PassphraseTooWeak)
        ));
        assert!(matches!(
            assert_passphrase_floor("hunter2"),
            Err(KitError::PassphraseTooWeak)
        ));
        // Twelve characters, or four words — the two shapes owners type.
        assert!(assert_passphrase_floor("twelve chars").is_ok());
        assert!(assert_passphrase_floor("one two three four").is_ok());
        assert!(
            wrap_recovery_kit(&document(), "short").is_err(),
            "sealing a kit is where the floor applies"
        );
        // And a kit whose password would fail the floor today still OPENS.
        let fixture = fixture();
        assert!(
            parse_recovery_kit(&fixture["wrapped"], fixture["password"].as_str().unwrap()).is_ok()
        );
    }

    #[test]
    fn every_malformed_target_and_keyring_is_refused_at_the_door() {
        let mut base = document().to_json();
        for field in ["provider", "targetId", "vaultId", "label"] {
            let mut broken = base.clone();
            broken["targets"][0].as_object_mut().unwrap().remove(field);
            let error = RecoveryKitDocument::from_json(&broken).unwrap_err();
            assert!(error.to_string().contains(field), "{field}: {error}");
            // An empty string is as missing as an absent key.
            let mut empty = base.clone();
            empty["targets"][0][field] = json!("");
            assert!(RecoveryKitDocument::from_json(&empty).is_err(), "{field}");
        }
        // A lockerKeys entry missing either half.
        for field in ["keyId", "key"] {
            let mut broken = base.clone();
            broken["targets"][0]["lockerKeys"][0]
                .as_object_mut()
                .unwrap()
                .remove(field);
            let error = RecoveryKitDocument::from_json(&broken).unwrap_err();
            assert!(error.to_string().contains("lockerKeys[0]"), "{error}");
        }
        // The wrong kind, the wrong version, a bad keyring.
        base["kind"] = json!("something-else");
        assert!(RecoveryKitDocument::from_json(&base).is_err());
        base["kind"] = json!(KIT_KIND);
        base["version"] = json!(2);
        assert!(RecoveryKitDocument::from_json(&base).is_err());
        base["version"] = json!(1);
        base["keyring"]["active"] = json!(99);
        assert!(RecoveryKitDocument::from_json(&base).is_err());
    }

    #[test]
    fn a_target_is_addressed_by_vault_id() {
        let kit = document();
        assert_eq!(
            kit.target_for("00000000-0000-7000-8000-000000000456")
                .map(|target| target.label.as_str()),
            Some("the household vault")
        );
        assert!(kit.target_for("no-such-vault").is_none());
    }
}
