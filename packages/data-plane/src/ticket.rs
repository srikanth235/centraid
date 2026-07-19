use anyhow::{Context, Result, bail};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use subtle::ConstantTimeEq;

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BlobTicket {
    pub relative_path: String,
    pub expires_at_ms: u64,
    pub nonce: String,
    pub media_type: String,
    pub disposition: String,
    pub etag: String,
}

pub fn verify(secret: &[u8], encoded: &str, now_ms: u64) -> Result<BlobTicket> {
    let (payload, signature) = encoded.split_once('.').context("ticket has no signature")?;
    let signature = URL_SAFE_NO_PAD
        .decode(signature)
        .context("ticket signature is not base64url")?;
    let mut mac = HmacSha256::new_from_slice(secret).context("invalid ticket secret")?;
    mac.update(payload.as_bytes());
    let expected = mac.finalize().into_bytes();
    if expected.as_slice().ct_eq(&signature).unwrap_u8() != 1 {
        bail!("ticket signature mismatch");
    }
    let json = URL_SAFE_NO_PAD
        .decode(payload)
        .context("ticket payload is not base64url")?;
    let ticket: BlobTicket = serde_json::from_slice(&json).context("ticket payload is not JSON")?;
    if ticket.expires_at_ms < now_ms {
        bail!("ticket expired");
    }
    if ticket.nonce.len() < 16 || ticket.relative_path.is_empty() {
        bail!("ticket fields are invalid");
    }
    Ok(ticket)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sign(secret: &[u8], ticket: &BlobTicket) -> String {
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(ticket).unwrap());
        let mut mac = HmacSha256::new_from_slice(secret).unwrap();
        mac.update(payload.as_bytes());
        format!(
            "{payload}.{}",
            URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
        )
    }

    #[test]
    fn verifies_signature_and_expiry() {
        let ticket = BlobTicket {
            relative_path: "v/blobs/sha256/ab/abc".into(),
            expires_at_ms: 200,
            nonce: "0123456789abcdef".into(),
            media_type: "image/jpeg".into(),
            disposition: "inline; filename=\"x.jpg\"".into(),
            etag: "abc".into(),
        };
        let encoded = sign(b"secret", &ticket);
        assert_eq!(verify(b"secret", &encoded, 199).unwrap(), ticket);
        assert!(verify(b"wrong", &encoded, 199).is_err());
        assert!(verify(b"secret", &encoded, 201).is_err());
    }
}
