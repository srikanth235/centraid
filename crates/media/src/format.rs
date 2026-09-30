// First-party MIT code (#1020, D-1020-R1). The hash and the KDF are BLAKE3
// (#1025 S4, D-1025-S4-1/-3).
//
// WHAT THIS MODULE IS NOW (#1029 §4).
//
// Four hashes and a canonicalizer. The v0-derived seals that stood here — the
// WAL-segment seal and the snapshot-manifest seal, with the AES-GCM primitives
// under them — are deleted with their last callers: `centraid-object/1`
// (`crate::object`) replaces both, and its nonces are random rather than
// derived from an address, which is the defect they carried (#1029 B9,
// `receipts/issue-1029-phone-is-the-vault.md`).

use anyhow::{Result, bail};
use serde_json::Value;

/// The digest that names bytes on this plane.
///
/// **BLAKE3, and it used to be SHA-256** (#1025 S4, D-1025-S4-1). This file was
/// moved byte-for-byte from v0 and its formats are normative (D-1020-R1), so
/// changing the function here IS a re-keying event — which is exactly what this
/// slice spends, once, while v1 has no released predecessor and no artefact a
/// member holds is restorable. Every golden under `contracts/` regenerates
/// through its generator in the same change.
#[must_use]
pub fn content_hash_hex(bytes: &[u8]) -> String {
    hex::encode(blake3::hash(bytes).as_bytes())
}

pub fn canonical_json(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(v) => v.to_string(),
        // TypeScript's canonicalizer delegates numbers to JSON.stringify,
        // whose values and exponent thresholds follow ECMAScript Number
        // (IEEE-754), not serde_json's arbitrary integer spelling.
        Value::Number(v) => ryu_js::Buffer::new()
            .format(v.as_f64().expect("JSON numbers are finite"))
            .to_owned(),
        Value::String(v) => serde_json::to_string(v).expect("string serialization"),
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(values) => {
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort_unstable();
            let fields = keys
                .into_iter()
                .map(|key| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(key).expect("key serialization"),
                        canonical_json(&values[key])
                    )
                })
                .collect::<Vec<_>>()
                .join(",");
            format!("{{{fields}}}")
        }
    }
}

/// Derive `length` bytes from a key under a context string.
///
/// **`blake3::derive_key`, superseding HKDF-SHA-256** (#1025 S4, D-1025-S4-3).
/// BLAKE3's KDF mode is a keyed hash over the context with its own domain
/// separation, and it is an XOF, so any output length comes off one derivation
/// rather than out of HKDF's counter loop. The `info` string becomes the
/// context verbatim, so every existing info string is still what separates one
/// derived key from another — the derivation changed, the domain did not.
pub fn derive_bytes(key: &[u8], info: &str, length: usize) -> Result<Vec<u8>> {
    if length == 0 {
        bail!("a derived key is at least one byte");
    }
    let mut out = vec![0; length];
    blake3::Hasher::new_derive_key(info)
        .update(key)
        .finalize_xof()
        .fill(&mut out);
    Ok(out)
}

pub fn derive_data_key(master: &[u8], vault_id: &str) -> Result<[u8; 32]> {
    derive_bytes(master, &format!("centraid-backup:data:{vault_id}"), 32)?
        .try_into()
        .map_err(|_| anyhow::anyhow!("data key length"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn canonical_json_sorts_object_keys_recursively() {
        assert_eq!(
            canonical_json(&json!({"z": 1, "a": {"y": true, "b": null}})),
            r#"{"a":{"b":null,"y":true},"z":1}"#
        );
    }

    #[test]
    fn canonical_json_uses_ecmascript_number_spelling() {
        assert_eq!(
            canonical_json(
                &serde_json::from_str("[1.5,1e21,1e20,1e-7,1e-6,-0,9007199254740993]").unwrap()
            ),
            "[1.5,1e+21,100000000000000000000,1e-7,0.000001,0,9007199254740992]"
        );
    }
}
