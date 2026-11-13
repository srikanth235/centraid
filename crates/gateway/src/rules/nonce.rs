//! The stateless nonce (#1191, E5 as amended by R2).
//!
//! `POST /v3/nonce` writes **nothing**. A nonce is 40 bytes the gateway can
//! recognise as its own without having kept it:
//!
//! ```text
//! random (16) ‖ u64be(issued_at_ms) (8) ‖ mac (16)
//! mac = blake3 keyed by a gateway-local key over
//!       "centraid-gateway-nonce-v1" ‖ gateway_id ‖ random ‖ issued_at_ms
//! ```
//!
//! The key is kept beside the gateway's identity and never leaves it. On use
//! the rules check the MAC and the age, then the credential the request
//! carries (the live secret, the vault, the signature — the signature covers
//! the nonce), and only then record the nonce as spent. So only a request
//! carrying a valid signature can ever write a row, and an unauthenticated
//! flood of `POST nonce` writes none.
//!
//! **Why a wrong-key signature may leave the nonce unspent.** The nonce is
//! public to whoever asked for it; what makes a request good is a signature
//! by the vault key *over that nonce*. An attacker holding an unspent nonce
//! cannot sign it, so keeping it unspent gains them nothing, and spending it
//! on a bad signature would let anyone burn another phone's nonce for free.

use crate::rules::ids::{GatewayId, Nonce};
use crate::rules::limits::NONCE_TTL_MS;

const CONTEXT: &[u8] = b"centraid-gateway-nonce-v1";

fn mac(key: &[u8; 32], gateway: &GatewayId, random: &[u8], issued: &[u8]) -> [u8; 16] {
    let mut hasher = blake3::Hasher::new_keyed(key);
    hasher.update(CONTEXT);
    hasher.update(gateway.as_bytes());
    hasher.update(random);
    hasher.update(issued);
    let full = hasher.finalize();
    let mut out = [0_u8; 16];
    out.copy_from_slice(&full.as_bytes()[..16]);
    out
}

/// A nonce for `random` issued at `issued_at_ms`.
#[must_use]
pub fn mint(key: &[u8; 32], gateway: &GatewayId, random: [u8; 16], issued_at_ms: i64) -> Nonce {
    let issued = issued_at_ms.to_be_bytes();
    let mut bytes = [0_u8; Nonce::LEN];
    bytes[..16].copy_from_slice(&random);
    bytes[16..24].copy_from_slice(&issued);
    bytes[24..].copy_from_slice(&mac(key, gateway, &random, &issued));
    Nonce::from_bytes(bytes)
}

/// What a good nonce is, once opened: the identifier the spent table keeps,
/// and when it was issued.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Opened {
    pub id: [u8; 16],
    pub issued_at_ms: i64,
}

/// Open `nonce` at `now_ms`: its MAC must be this gateway's and it must be
/// younger than [`NONCE_TTL_MS`]. `None` is `UNAUTHORIZED`, the same as a bad
/// signature, so a forged, foreign and expired nonce are one answer.
#[must_use]
pub fn open(key: &[u8; 32], gateway: &GatewayId, nonce: &Nonce, now_ms: i64) -> Option<Opened> {
    let bytes = nonce.as_bytes();
    let (random, rest) = bytes.split_at(16);
    let (issued, tag) = rest.split_at(8);
    let expected = mac(key, gateway, random, issued);
    // Not secret-dependent timing: the tag is compared whole, byte for byte,
    // with no early exit.
    let equal = expected
        .iter()
        .zip(tag)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0;
    if !equal {
        return None;
    }
    let issued_at_ms = i64::from_be_bytes(issued.try_into().ok()?);
    if now_ms >= issued_at_ms.saturating_add(NONCE_TTL_MS)
        || issued_at_ms > now_ms.saturating_add(NONCE_TTL_MS)
    {
        return None;
    }
    let mut id = [0_u8; 16];
    id.copy_from_slice(random);
    Some(Opened { id, issued_at_ms })
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: [u8; 32] = [7; 32];

    fn gateway() -> GatewayId {
        GatewayId::from_bytes([1; 16])
    }

    #[test]
    fn a_nonce_opens_here_while_it_is_young_and_nowhere_else() {
        let nonce = mint(&KEY, &gateway(), [9; 16], 1_000);
        assert_eq!(
            open(&KEY, &gateway(), &nonce, 1_000).map(|o| (o.id, o.issued_at_ms)),
            Some(([9; 16], 1_000))
        );
        assert!(open(&KEY, &gateway(), &nonce, 1_000 + NONCE_TTL_MS - 1).is_some());
        assert!(open(&KEY, &gateway(), &nonce, 1_000 + NONCE_TTL_MS).is_none());
        assert!(
            open(&[8; 32], &gateway(), &nonce, 1_000).is_none(),
            "another gateway's key"
        );
        assert!(
            open(&KEY, &GatewayId::from_bytes([2; 16]), &nonce, 1_000).is_none(),
            "another gateway's id"
        );
        let mut forged = *nonce.as_bytes();
        forged[23] ^= 1;
        assert!(open(&KEY, &gateway(), &Nonce::from_bytes(forged), 1_000).is_none());
        let mut forged = *nonce.as_bytes();
        forged[39] ^= 1;
        assert!(open(&KEY, &gateway(), &Nonce::from_bytes(forged), 1_000).is_none());
    }
}
