use aes_gcm::{
    Aes256Gcm, KeyInit, Nonce,
    aead::{Aead, Payload},
};
use anyhow::{Context, Result, bail};
use base64::{Engine, engine::general_purpose::STANDARD};
use hkdf::Hkdf;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone)]
pub struct WalAddress<'a> {
    pub db: &'a str,
    pub generation: &'a str,
    pub group: u64,
    pub start_offset: u64,
    pub end_offset: u64,
    pub tick_ms: u64,
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
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

pub fn hkdf_bytes(key: &[u8], info: &str, length: usize) -> Result<Vec<u8>> {
    let hk = Hkdf::<Sha256>::new(Some(&[]), key);
    let mut out = vec![0; length];
    hk.expand(info.as_bytes(), &mut out)
        .map_err(|_| anyhow::anyhow!("HKDF output length is invalid"))?;
    Ok(out)
}

pub fn derive_data_key(master: &[u8], vault_id: &str) -> Result<[u8; 32]> {
    hkdf_bytes(master, &format!("centraid-backup:data:{vault_id}"), 32)?
        .try_into()
        .map_err(|_| anyhow::anyhow!("data key length"))
}

pub fn derive_nonce(key: &[u8], info: &str) -> Result<[u8; 12]> {
    hkdf_bytes(key, info, 12)?
        .try_into()
        .map_err(|_| anyhow::anyhow!("nonce length"))
}

pub fn seal_aes_gcm(key: &[u8; 32], nonce: &[u8; 12], plain: &[u8], aad: &[u8]) -> Result<Vec<u8>> {
    let cipher = Aes256Gcm::new_from_slice(key).context("invalid AES key")?;
    let body = cipher
        .encrypt(Nonce::from_slice(nonce), Payload { msg: plain, aad })
        .map_err(|_| anyhow::anyhow!("AES-GCM seal failed"))?;
    let mut sealed = Vec::with_capacity(12 + body.len());
    sealed.extend_from_slice(nonce);
    sealed.extend_from_slice(&body);
    Ok(sealed)
}

pub fn open_aes_gcm(key: &[u8; 32], sealed: &[u8], aad: &[u8]) -> Result<Vec<u8>> {
    if sealed.len() < 28 {
        bail!("encrypted blob truncated");
    }
    let cipher = Aes256Gcm::new_from_slice(key).context("invalid AES key")?;
    cipher
        .decrypt(
            Nonce::from_slice(&sealed[..12]),
            Payload {
                msg: &sealed[12..],
                aad,
            },
        )
        .map_err(|_| anyhow::anyhow!("AES-GCM authentication failed"))
}

pub fn snapshot_public_without_sealed(value: &Value) -> Result<Value> {
    let object = value.as_object().context("manifest must be an object")?;
    if object.get("format").and_then(Value::as_str) != Some("centraid-snapshot/2") {
        bail!("unsupported snapshot format");
    }
    let mut public = Map::new();
    for (key, value) in object {
        if key != "sealedPayload" {
            public.insert(key.clone(), value.clone());
        }
    }
    Ok(Value::Object(public))
}

fn wal_nonce_info(address: &WalAddress<'_>) -> String {
    format!(
        "centraid-backup:wal-nonce:{}:{}:{}:{}:{}:{}",
        address.db,
        address.generation,
        address.group,
        address.start_offset,
        address.end_offset,
        address.tick_ms
    )
}

fn wal_aad(vault_id: &str, address: &WalAddress<'_>) -> String {
    format!(
        "centraid-wal/1:{vault_id}:{}:{}:{}:{}:{}:{}",
        address.db,
        address.generation,
        address.group,
        address.start_offset,
        address.end_offset,
        address.tick_ms
    )
}

pub fn seal_wal_segment(
    data_key: &[u8; 32],
    vault_id: &str,
    address: &WalAddress<'_>,
    plain: &[u8],
) -> Result<Vec<u8>> {
    if address.db != "vault" && address.db != "journal" {
        bail!("invalid WAL database name");
    }
    if address.end_offset.saturating_sub(address.start_offset) != plain.len() as u64 {
        bail!("WAL segment length disagrees with address");
    }
    let nonce = derive_nonce(data_key, &wal_nonce_info(address))?;
    seal_aes_gcm(
        data_key,
        &nonce,
        plain,
        wal_aad(vault_id, address).as_bytes(),
    )
}

pub fn open_wal_segment(
    data_key: &[u8; 32],
    vault_id: &str,
    address: &WalAddress<'_>,
    sealed: &[u8],
) -> Result<Vec<u8>> {
    let plain = open_aes_gcm(data_key, sealed, wal_aad(vault_id, address).as_bytes())?;
    if address.end_offset.saturating_sub(address.start_offset) != plain.len() as u64 {
        bail!("WAL segment length disagrees with address");
    }
    Ok(plain)
}

pub fn seal_snapshot_manifest(
    master_key: &[u8; 32],
    vault_id: &str,
    public_envelope: &Value,
    payload: &Value,
) -> Result<(Vec<u8>, String)> {
    if public_envelope.get("format").and_then(Value::as_str) != Some("centraid-snapshot/2") {
        bail!("unsupported snapshot format");
    }
    let public_object = public_envelope
        .as_object()
        .context("snapshot public envelope must be an object")?;
    let data_key = derive_data_key(master_key, vault_id)?;
    let payload_bytes = canonical_json(payload).into_bytes();
    let nonce_identity = sha256_hex(
        canonical_json(&serde_json::json!({
            "publicEnvelope": public_envelope,
            "payloadHash": sha256_hex(&payload_bytes),
        }))
        .as_bytes(),
    );
    let nonce = derive_nonce(
        &data_key,
        &format!("centraid-backup:manifest-nonce:{nonce_identity}"),
    )?;
    let aad = canonical_json(public_envelope);
    let sealed = seal_aes_gcm(&data_key, &nonce, &payload_bytes, aad.as_bytes())?;
    let mut stored = public_object.clone();
    stored.insert(
        "sealedPayload".into(),
        Value::String(STANDARD.encode(sealed)),
    );
    let bytes = canonical_json(&Value::Object(stored)).into_bytes();
    let hash = sha256_hex(&bytes);
    Ok((bytes, hash))
}

pub fn open_snapshot_manifest(
    master_key: &[u8; 32],
    vault_id: &str,
    stored_bytes: &[u8],
) -> Result<Value> {
    let stored: Value = serde_json::from_slice(stored_bytes).context("manifest is not JSON")?;
    let public = snapshot_public_without_sealed(&stored)?;
    let sealed = stored
        .get("sealedPayload")
        .and_then(Value::as_str)
        .context("manifest has no sealedPayload")?;
    let sealed = STANDARD
        .decode(sealed)
        .context("manifest payload is not base64")?;
    let data_key = derive_data_key(master_key, vault_id)?;
    let plain = open_aes_gcm(&data_key, &sealed, canonical_json(&public).as_bytes())?;
    serde_json::from_slice(&plain).context("manifest payload is not JSON")
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
