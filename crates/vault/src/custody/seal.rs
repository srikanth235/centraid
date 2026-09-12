//! The vault DEK: sealed cells and the fingerprint that proves the key is
//! this vault's (#1020, D-1020-R2). Layer two of three.
//!
//! Wire form is `"sealed:v1:" + base64(nonce(12) ‖ ct ‖ tag(16))`, AES-256-GCM,
//! a fresh random nonce per value, and **AAD = `<physical>.<column>:<rowId>`**.
//! That AAD is the whole security property of the layer: a ciphertext lifted
//! out of one cell and dropped into another fails to open, because the AAD it
//! was sealed under names the cell it came from.
//!
//! Faithful to `packages/vault/src/schema/sealed.ts` (#298), including the one
//! rule that reads like a bug and is not:
//!
//! ## `is_sealed_value` is structural, not a prefix test
//!
//! A value is sealed only if it carries the prefix **and** the remainder is a
//! strict-alphabet base64 body of at least 38 characters, a multiple of four
//! long, decoding to at least `nonce + tag` bytes. The reason is a real one: a
//! member's password that happens to begin `sealed:v1:` must be **sealed**, not
//! stored verbatim as "already sealed". A bare `starts_with` predicate hands an
//! attacker a way to write a plaintext secret into a sealed column by choosing
//! its first ten characters.
//!
//! ## The fingerprint commits with the secrets
//!
//! `seal_key_fingerprint` is a truncated SHA-256 — preimage-resistant, safe in
//! a receipt or an error message — and [`stamp_seal_key_fingerprint`] writes it
//! into `core_vault.settings_json` **inside the sealing transaction**. "This
//! vault has secrets" and the secrets themselves therefore commit together: a
//! crash cannot leave sealed cells whose key nothing names, nor a stamp for a
//! key that sealed nothing.

use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use sha2::{Digest as _, Sha256};

/// Wire prefix of a sealed value.
pub const SEALED_PREFIX: &str = "sealed:v1:";

/// What a default read (and the SQL surface) shows instead of a secret.
pub const SEALED_PLACEHOLDER: &str = "«sealed»";

const NONCE_BYTES: usize = 12;
const TAG_BYTES: usize = 16;

/// Where the stamp lives inside `core_vault.settings_json`.
const SETTINGS_KEY: &str = "seal_key";

#[derive(Debug, thiserror::Error)]
pub enum SealError {
    #[error("seal key is {0} bytes, expected 32")]
    KeyLength(usize),
    #[error("value is not a sealed value")]
    NotSealed,
    #[error("sealed value is truncated")]
    Truncated,
    /// Tampering, a wrong key, or — the interesting one — the right ciphertext
    /// in the wrong cell.
    #[error("sealed value failed to authenticate for {aad}")]
    Authentication { aad: String },
    #[error("sealed plaintext is not UTF-8")]
    NotUtf8,
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
}

fn key32(key: &[u8]) -> Result<Aes256Gcm, SealError> {
    if key.len() != 32 {
        return Err(SealError::KeyLength(key.len()));
    }
    Aes256Gcm::new_from_slice(key).map_err(|_| SealError::KeyLength(key.len()))
}

/// AAD binding a ciphertext to its exact cell: `physical.column:rowId`.
#[must_use]
pub fn seal_aad(physical: &str, column: &str, row_id: &str) -> String {
    format!("{physical}.{column}:{row_id}")
}

/// The structural predicate. See the module docs for why it is not a
/// `starts_with`.
#[must_use]
pub fn is_sealed_value(value: &str) -> bool {
    let Some(body) = value.strip_prefix(SEALED_PREFIX) else {
        return false;
    };
    // `^[A-Za-z0-9+/]{38,}={0,2}$`, and a length that is a multiple of four.
    if body.len() < 38 || !body.len().is_multiple_of(4) {
        return false;
    }
    let padding = body.len() - body.trim_end_matches('=').len();
    if padding > 2 {
        return false;
    }
    let core = &body[..body.len() - padding];
    if core.len() < 38
        || !core
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
    {
        return false;
    }
    STANDARD
        .decode(body)
        .is_ok_and(|bytes| bytes.len() >= NONCE_BYTES + TAG_BYTES)
}

/// Encrypt one plaintext into the sealed wire form.
///
/// The key arrives **by value**. There is no ambient seal key in this crate,
/// which is what stops a future read path from reaching for one (D-1020-R4).
pub fn seal_value(key: &[u8], aad: &str, plaintext: &str) -> Result<String, SealError> {
    let cipher = key32(key)?;
    let nonce = super::random_bytes::<NONCE_BYTES>();
    let body = cipher
        .encrypt(
            (&nonce).into(),
            Payload {
                msg: plaintext.as_bytes(),
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| SealError::Authentication {
            aad: aad.to_owned(),
        })?;
    let mut raw = Vec::with_capacity(NONCE_BYTES + body.len());
    raw.extend_from_slice(&nonce);
    raw.extend_from_slice(&body);
    Ok(format!("{SEALED_PREFIX}{}", STANDARD.encode(raw)))
}

/// Decrypt a sealed wire value. Fails on tampering **or a wrong cell**.
pub fn open_value(key: &[u8], aad: &str, value: &str) -> Result<String, SealError> {
    let cipher = key32(key)?;
    let body = value
        .strip_prefix(SEALED_PREFIX)
        .ok_or(SealError::NotSealed)?;
    let raw = STANDARD.decode(body).map_err(|_| SealError::NotSealed)?;
    if raw.len() < NONCE_BYTES + TAG_BYTES {
        return Err(SealError::Truncated);
    }
    let nonce: [u8; NONCE_BYTES] = raw[..NONCE_BYTES].try_into().expect("checked length");
    let plain = cipher
        .decrypt(
            (&nonce).into(),
            Payload {
                msg: &raw[NONCE_BYTES..],
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| SealError::Authentication {
            aad: aad.to_owned(),
        })?;
    String::from_utf8(plain).map_err(|_| SealError::NotUtf8)
}

/// Non-secret identity of a DEK: a truncated SHA-256, safe to stamp into
/// `core_vault.settings_json` and to print in a receipt.
#[must_use]
pub fn seal_key_fingerprint(key: &[u8]) -> String {
    let digest = hex::encode(Sha256::digest(key));
    format!("sha256:{}", &digest[..32])
}

/// The fingerprint stamped at first seal, or `None` on a vault that never
/// sealed. A malformed settings bag reads as `None` — a vault whose settings
/// JSON is unparseable has bigger problems than this question.
pub fn read_seal_key_fingerprint(
    connection: &rusqlite::Connection,
) -> Result<Option<String>, SealError> {
    let settings: Option<Option<String>> = connection
        .query_row("SELECT settings_json FROM core_vault LIMIT 1", [], |row| {
            row.get(0)
        })
        .map(Some)
        .or_else(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })?;
    let Some(Some(text)) = settings else {
        return Ok(None);
    };
    let Ok(bag) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Ok(None);
    };
    Ok(bag
        .get(SETTINGS_KEY)
        .and_then(|v| v.get("fingerprint"))
        .and_then(serde_json::Value::as_str)
        .filter(|fp| !fp.is_empty())
        .map(str::to_owned))
}

/// Stamp the key's fingerprint into `core_vault.settings_json`.
///
/// Called from the chokepoint that seals, **inside its transaction**, so
/// "this vault has secrets" is recorded the instant it becomes true. Idempotent
/// and a no-op before bootstrap, when there is no `core_vault` row to stamp.
pub fn stamp_seal_key_fingerprint(
    connection: &rusqlite::Connection,
    key: &[u8],
    stamped_at: &str,
) -> Result<bool, SealError> {
    let fingerprint = seal_key_fingerprint(key);
    let existing: Option<String> =
        match connection.query_row("SELECT settings_json FROM core_vault LIMIT 1", [], |row| {
            row.get(0)
        }) {
            Ok(value) => value,
            Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(false),
            Err(error) => return Err(error.into()),
        };
    let mut settings = existing
        .as_deref()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    if settings
        .get(SETTINGS_KEY)
        .and_then(|v| v.get("fingerprint"))
        .and_then(serde_json::Value::as_str)
        == Some(fingerprint.as_str())
    {
        return Ok(false);
    }
    settings.insert(
        SETTINGS_KEY.to_owned(),
        serde_json::json!({ "fingerprint": fingerprint, "stamped_at": stamped_at }),
    );
    connection.execute(
        "UPDATE core_vault SET settings_json = ?1",
        [serde_json::Value::Object(settings).to_string()],
    )?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: [u8; 32] = [11_u8; 32];

    #[test]
    fn a_sealed_cell_round_trips_under_its_own_aad() {
        let aad = seal_aad("locker_item", "password", "item-1");
        let sealed = seal_value(&KEY, &aad, "correct horse battery staple").unwrap();
        assert!(sealed.starts_with(SEALED_PREFIX));
        assert!(is_sealed_value(&sealed));
        assert_eq!(
            open_value(&KEY, &aad, &sealed).unwrap(),
            "correct horse battery staple"
        );
    }

    #[test]
    fn a_ciphertext_moved_to_another_row_or_column_fails_to_open() {
        let sealed = seal_value(
            &KEY,
            &seal_aad("locker_item", "password", "item-1"),
            "s3cret",
        )
        .unwrap();
        for (physical, column, row) in [
            ("locker_item", "password", "item-2"),
            ("locker_item", "cvv", "item-1"),
            ("other_table", "password", "item-1"),
        ] {
            let error = open_value(&KEY, &seal_aad(physical, column, row), &sealed).unwrap_err();
            assert!(
                matches!(error, SealError::Authentication { .. }),
                "{physical}.{column}:{row} -> {error}"
            );
        }
        // …and a different DEK opens nothing either.
        assert!(
            open_value(
                &[12_u8; 32],
                &seal_aad("locker_item", "password", "item-1"),
                &sealed
            )
            .is_err()
        );
    }

    #[test]
    fn tampering_with_one_byte_of_ciphertext_is_an_authentication_failure() {
        let aad = seal_aad("locker_item", "password", "item-1");
        let sealed = seal_value(&KEY, &aad, "s3cret").unwrap();
        let mut raw = STANDARD
            .decode(sealed.strip_prefix(SEALED_PREFIX).unwrap())
            .unwrap();
        let last = raw.len() - 1;
        raw[last] ^= 1;
        let damaged = format!("{SEALED_PREFIX}{}", STANDARD.encode(raw));
        assert!(open_value(&KEY, &aad, &damaged).is_err());
    }

    /// v0 `packages/vault/src/schema/sealed.ts:207-220`, #298 item 8. The
    /// predicate is structural, so a member password that merely *starts* with
    /// the prefix is not sealed — and therefore gets sealed.
    #[test]
    fn a_password_that_merely_starts_with_the_prefix_is_not_sealed() {
        assert!(!is_sealed_value("sealed:v1:hunter2"));
        assert!(!is_sealed_value("sealed:v1:"));
        // Right length, wrong alphabet (`-` and `_` are base64url, not base64).
        assert!(!is_sealed_value(&format!("sealed:v1:{}", "-".repeat(40))));
        // Strict alphabet, right length, but not a multiple of four.
        assert!(!is_sealed_value(&format!("sealed:v1:{}", "A".repeat(39))));
        // Multiple of four and strict, but decodes to fewer than nonce+tag.
        assert!(!is_sealed_value(&format!("sealed:v1:{}", "A".repeat(36))));
        assert!(!is_sealed_value("not sealed at all"));
        // A genuine seal of the empty string still satisfies it: 12 + 0 + 16
        // bytes is 28, which is 40 base64 characters.
        let genuine = seal_value(&KEY, "a.b:c", "").unwrap();
        assert!(is_sealed_value(&genuine));
    }

    fn vault_with_settings(settings: Option<&str>) -> rusqlite::Connection {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        connection
            .execute_batch("CREATE TABLE core_vault (vault_id TEXT, settings_json TEXT)")
            .unwrap();
        if let Some(settings) = settings {
            connection
                .execute(
                    "INSERT INTO core_vault (vault_id, settings_json) VALUES ('v1', ?1)",
                    [settings],
                )
                .unwrap();
        }
        connection
    }

    #[test]
    fn the_fingerprint_is_stamped_once_and_read_back() {
        let connection = vault_with_settings(Some("{}"));
        assert_eq!(read_seal_key_fingerprint(&connection).unwrap(), None);
        assert!(stamp_seal_key_fingerprint(&connection, &KEY, "2026-01-01T00:00:00.000Z").unwrap());
        assert_eq!(
            read_seal_key_fingerprint(&connection).unwrap().as_deref(),
            Some(seal_key_fingerprint(&KEY).as_str())
        );
        assert!(
            !stamp_seal_key_fingerprint(&connection, &KEY, "2026-01-02T00:00:00.000Z").unwrap(),
            "stamping the same key twice writes nothing"
        );
        assert!(
            stamp_seal_key_fingerprint(&connection, &[13_u8; 32], "2026-01-03T00:00:00.000Z")
                .unwrap(),
            "a different key is a different stamp"
        );
    }

    #[test]
    fn stamping_before_bootstrap_is_a_no_op_rather_than_a_failure() {
        let connection = vault_with_settings(None);
        assert!(
            !stamp_seal_key_fingerprint(&connection, &KEY, "2026-01-01T00:00:00.000Z").unwrap()
        );
        assert_eq!(read_seal_key_fingerprint(&connection).unwrap(), None);
    }

    #[test]
    fn an_unparseable_settings_bag_reads_as_no_stamp() {
        let connection = vault_with_settings(Some("{not json"));
        assert_eq!(read_seal_key_fingerprint(&connection).unwrap(), None);
        // …and stamping over it still works: the bag is replaced, not merged
        // into something unparseable.
        assert!(stamp_seal_key_fingerprint(&connection, &KEY, "2026-01-01T00:00:00.000Z").unwrap());
        assert!(read_seal_key_fingerprint(&connection).unwrap().is_some());
    }

    #[test]
    fn the_fingerprint_reveals_nothing_and_is_stable() {
        let fingerprint = seal_key_fingerprint(&KEY);
        assert_eq!(fingerprint.len(), "sha256:".len() + 32);
        assert_eq!(fingerprint, seal_key_fingerprint(&KEY));
        assert_ne!(fingerprint, seal_key_fingerprint(&[12_u8; 32]));
        assert!(!fingerprint.contains(&hex::encode(KEY)));
    }
}
