//! The claim: how a vault's identity key moves the writer (#1080).
//!
//! A restore or a takeover is a claim: the phone proves it holds the vault's
//! identity key by signing the gateway's id, the vault's id, the epoch it
//! claims and the head it checked. The gateway admits it only at the writer
//! epoch plus one and only while that head is still the head, so a claim and
//! the check it was made after are one step.
//!
//! # FORMAT DECISION — THE SIGNED BYTES
//!
//! Ed25519 (RFC 8032, verified strictly) by the vault identity key over:
//!
//! ```text
//! u32be(25) ‖ "centraid-gateway-claim-v2"
//! u32be(16) ‖ gateway_id    16 raw bytes
//! u32be(32) ‖ vault_id      32 raw bytes, the identity public key
//! u32be(8)  ‖ u64be(epoch)
//! u32be(32) ‖ head_seen     32 raw bytes of the name, or u32be(0) and nothing
//!                           when the claimer saw no head
//! ```
//!
//! Every field is length-prefixed, so no two different claims are the same
//! bytes; the context string means a claim signature is never a signature
//! over anything else this product signs; the gateway id means a claim made
//! to one gateway cannot be replayed at another. [`claim_preimage`] is the one
//! builder, and the phone calls it (or [`sign_claim`]) to sign the same bytes
//! the gateway checks.
//!
//! # THE READ GRANT IS THE SAME BYTES AT EPOCH 0
//!
//! A restoring phone has no token and must fetch and check a snapshot before
//! it may claim. It signs [`claim_preimage`] at [`READ_EPOCH`] with no head
//! and is granted a token at epoch 0. Every vault's writer epoch is at least
//! 1, so that token is below it forever: it reads and is refused `MOVED` on
//! every write. Epoch 0 is never a claim — a claim is the writer epoch plus
//! one, at least 2 — so the two cannot be confused.

use ed25519_dalek::Signer as _;

use crate::rules::ids::{GatewayId, Name, Signature, VaultId};

/// The domain separator.
pub const CLAIM_CONTEXT: &[u8] = b"centraid-gateway-claim-v2";

/// The epoch a read grant signs, and the epoch its token carries.
pub const READ_EPOCH: u64 = 0;

/// The exact bytes a claim signature covers. See the module header.
#[must_use]
pub fn claim_preimage(
    gateway: &GatewayId,
    vault: &VaultId,
    epoch: u64,
    head_seen: Option<&Name>,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 * 5 + CLAIM_CONTEXT.len() + 16 + 32 + 8 + 32);
    push(&mut out, CLAIM_CONTEXT);
    push(&mut out, gateway.as_bytes());
    push(&mut out, vault.as_bytes());
    push(&mut out, &epoch.to_be_bytes());
    push(
        &mut out,
        head_seen.map_or(&[][..], |name| &name.as_bytes()[..]),
    );
    out
}

fn push(out: &mut Vec<u8>, field: &[u8]) {
    // Every field here is at most 32 bytes, so the length always fits.
    let length = u32::try_from(field.len()).unwrap_or(u32::MAX);
    out.extend_from_slice(&length.to_be_bytes());
    out.extend_from_slice(field);
}

/// Sign a claim as the vault whose identity key this is.
#[must_use]
pub fn sign_claim(
    identity: &ed25519_dalek::SigningKey,
    gateway: &GatewayId,
    epoch: u64,
    head_seen: Option<&Name>,
) -> Signature {
    let vault = VaultId::from_bytes(identity.verifying_key().to_bytes());
    let preimage = claim_preimage(gateway, &vault, epoch, head_seen);
    Signature::from_bytes(identity.sign(&preimage).to_bytes())
}

/// Sign a read grant: the claim preimage at [`READ_EPOCH`], no head.
#[must_use]
pub fn sign_read(identity: &ed25519_dalek::SigningKey, gateway: &GatewayId) -> Signature {
    sign_claim(identity, gateway, READ_EPOCH, None)
}

/// Does `signature` sign this claim by `vault`'s identity key? A vault id
/// that is not a key verifies nothing.
#[must_use]
pub fn verify_claim(
    gateway: &GatewayId,
    vault: &VaultId,
    epoch: u64,
    head_seen: Option<&Name>,
    signature: &Signature,
) -> bool {
    let Some(key) = vault.verifying_key() else {
        return false;
    };
    let signature = ed25519_dalek::Signature::from_bytes(signature.as_bytes());
    key.verify_strict(
        &claim_preimage(gateway, vault, epoch, head_seen),
        &signature,
    )
    .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity() -> ed25519_dalek::SigningKey {
        ed25519_dalek::SigningKey::from_bytes(&[0x42; 32])
    }

    fn gateway() -> GatewayId {
        GatewayId::from_bytes([0x11; 16])
    }

    /// THE PREIMAGE IS A FORMAT, PINNED BYTE FOR BYTE. A change to the layout
    /// breaks every phone's claims against every gateway, so it must be a
    /// decision somebody makes here, not a side effect.
    #[test]
    fn the_preimage_is_the_documented_layout() {
        let vault = VaultId::from_bytes([0x22; 32]);
        let head = Name::from_bytes([0x33; 32]);
        let with_head = claim_preimage(&gateway(), &vault, 2, Some(&head));
        let mut expected = Vec::new();
        expected.extend_from_slice(&25_u32.to_be_bytes());
        expected.extend_from_slice(b"centraid-gateway-claim-v2");
        expected.extend_from_slice(&16_u32.to_be_bytes());
        expected.extend_from_slice(&[0x11; 16]);
        expected.extend_from_slice(&32_u32.to_be_bytes());
        expected.extend_from_slice(&[0x22; 32]);
        expected.extend_from_slice(&8_u32.to_be_bytes());
        expected.extend_from_slice(&2_u64.to_be_bytes());
        expected.extend_from_slice(&32_u32.to_be_bytes());
        expected.extend_from_slice(&[0x33; 32]);
        assert_eq!(with_head, expected);

        let without = claim_preimage(&gateway(), &vault, 2, None);
        assert_eq!(
            &without[..without.len() - 4],
            &expected[..expected.len() - 36]
        );
        assert_eq!(&without[without.len() - 4..], &0_u32.to_be_bytes());
    }

    /// A known-answer vector: RFC 8032 signatures are deterministic, so a
    /// fixed key over a fixed claim is a fixed signature. Pinned so a phone
    /// built from another revision is checked against the same bytes.
    #[test]
    fn a_fixed_claim_has_a_fixed_signature() {
        let signature = sign_claim(&identity(), &gateway(), 7, Some(&Name::from_bytes([1; 32])));
        let vault = VaultId::from_bytes(identity().verifying_key().to_bytes());
        assert!(verify_claim(
            &gateway(),
            &vault,
            7,
            Some(&Name::from_bytes([1; 32])),
            &signature
        ));
        assert_eq!(
            signature.hex(),
            CLAIM_SIGNATURE,
            "the claim preimage or its signing moved; that is a format change"
        );
    }

    /// Ed25519 by `SigningKey::from_bytes(&[0x42; 32])` over the claim of
    /// gateway `11…11` (16 bytes), epoch 7, head `01…01` (32 bytes).
    const CLAIM_SIGNATURE: &str = "0d3c3e14ebdc58740c0abcd5cdc459e1579a9edc385cab4a3480075ebf214fa3\
                                   f8420bced7251bab42ac1a11553237ccbdc01bda211937074897ecce5383ef0e";

    /// A CLAIM IS BOUND TO EVERY FIELD IT SIGNS. Each of these is a claim an
    /// attacker would like to make from a signature they saw.
    #[test]
    fn a_signature_verifies_only_the_claim_it_signed() {
        let head = Name::from_bytes([5; 32]);
        let signature = sign_claim(&identity(), &gateway(), 3, Some(&head));
        let vault = VaultId::from_bytes(identity().verifying_key().to_bytes());
        assert!(verify_claim(&gateway(), &vault, 3, Some(&head), &signature));
        assert!(
            !verify_claim(&gateway(), &vault, 4, Some(&head), &signature),
            "epoch"
        );
        assert!(
            !verify_claim(&gateway(), &vault, 3, None, &signature),
            "head"
        );
        assert!(
            !verify_claim(
                &GatewayId::from_bytes([0x12; 16]),
                &vault,
                3,
                Some(&head),
                &signature
            ),
            "another gateway"
        );
        let stranger = VaultId::from_bytes(
            ed25519_dalek::SigningKey::from_bytes(&[0x43; 32])
                .verifying_key()
                .to_bytes(),
        );
        assert!(
            !verify_claim(&gateway(), &stranger, 3, Some(&head), &signature),
            "vault"
        );
        let mut flipped = *signature.as_bytes();
        flipped[0] ^= 1;
        assert!(
            !verify_claim(
                &gateway(),
                &vault,
                3,
                Some(&head),
                &Signature::from_bytes(flipped)
            ),
            "a flipped bit"
        );
    }

    /// A read grant's signature is not a claim's: it verifies only at epoch 0.
    #[test]
    fn a_read_signature_is_a_claim_at_epoch_zero_and_nothing_else() {
        let vault = VaultId::from_bytes(identity().verifying_key().to_bytes());
        let read = sign_read(&identity(), &gateway());
        assert!(verify_claim(&gateway(), &vault, READ_EPOCH, None, &read));
        assert!(!verify_claim(&gateway(), &vault, 1, None, &read));
    }
}
