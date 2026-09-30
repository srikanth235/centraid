//! HPKE BASE MODE, AGAINST RFC 9180'S OWN BYTES (#1029 §0; Reference B).
//!
//! `crates/identity`'s sealed box is RFC 9180 base mode over DHKEM(X25519,
//! HKDF-SHA256) with HKDF-SHA256 and AES-128-GCM. A round-trip test proves the
//! seal and the open agree with each other, which they would also do if the key
//! schedule were wrong in both directions. So this replays Appendix A.1: the
//! RFC's recipient key, the RFC's encapsulated key, and the RFC's ciphertexts,
//! which nothing in this repository produced.
//!
//! Only the receiver half is replayed. A sender-side replay needs the vector's
//! ephemeral key injected into encapsulation, and `hpke` keeps that seam
//! `pub(crate)` for its own known-answer tests. Decapsulation, the key schedule
//! and the AEAD are shared by both directions, so what the receiver half leaves
//! unproven is the ephemeral keypair generation — which is `getrandom` and not
//! a format decision. `sealed_box`'s own tests cover the seal direction.

use centraid_identity::sealed_box::ENCAPPED_KEY_BYTES;
use hpke::aead::{AeadCtxR, AesGcm128};
use hpke::kdf::HkdfSha256;
use hpke::kem::X25519HkdfSha256;
use hpke::{Deserializable as _, OpModeR, setup_receiver};
use serde_json::Value;

type Kem = X25519HkdfSha256;

fn vectors() -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../contracts/crypto/rfc9180-vectors.json");
    serde_json::from_str(
        &std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("{} is unreadable: {error}", path.display())),
    )
    .expect("the vectors are JSON")
}

fn hex_at(vectors: &Value, key: &str) -> Vec<u8> {
    hex::decode(
        vectors[key]
            .as_str()
            .unwrap_or_else(|| panic!("{key} is a hex string")),
    )
    .unwrap_or_else(|error| panic!("{key} is not hex: {error}"))
}

fn receiver(vectors: &Value) -> AeadCtxR<AesGcm128, HkdfSha256, Kem> {
    let private = <Kem as hpke::Kem>::PrivateKey::from_bytes(&hex_at(vectors, "skRm"))
        .expect("the vector's recipient private key");
    let encapped = <Kem as hpke::Kem>::EncappedKey::from_bytes(&hex_at(vectors, "enc"))
        .expect("the vector's encapsulated key");
    setup_receiver::<AesGcm128, HkdfSha256, Kem>(
        &OpModeR::Base,
        &private,
        &encapped,
        &hex_at(vectors, "info"),
    )
    .expect("the vector's key schedule")
}

/// The ciphersuite the fixture pins is the one `sealed_box` uses. A fixture for
/// another suite would pass every assertion below and prove nothing about this
/// product.
#[test]
fn the_fixture_is_the_ciphersuite_this_crate_ships() {
    let vectors = vectors();
    assert_eq!(vectors["suite"]["mode"], 0, "base mode");
    assert_eq!(vectors["suite"]["kemId"], 32, "DHKEM(X25519, HKDF-SHA256)");
    assert_eq!(vectors["suite"]["kdfId"], 1, "HKDF-SHA256");
    assert_eq!(vectors["suite"]["aeadId"], 1, "AES-128-GCM");
    assert_eq!(hex_at(&vectors, "enc").len(), ENCAPPED_KEY_BYTES);
}

#[test]
fn the_rfc_9180_ciphertexts_open_with_the_rfc_9180_recipient_key() {
    let vectors = vectors();
    let mut context = receiver(&vectors);

    let encryptions = vectors["encryptions"].as_array().expect("encryptions");
    assert!(!encryptions.is_empty(), "a fixture with no ciphertext");

    // Sequence numbers advance implicitly: the nonce is `base_nonce XOR seq`,
    // so the vectors must be replayed in order and a gap would fail.
    for (expected_sequence, encryption) in encryptions.iter().enumerate() {
        assert_eq!(
            encryption["sequence"].as_u64(),
            Some(expected_sequence as u64),
            "the fixture's sequence numbers must be dense and in order"
        );
        let aad = hex::decode(encryption["aad"].as_str().expect("hex")).expect("hex");
        let ciphertext = hex::decode(encryption["ct"].as_str().expect("hex")).expect("hex");
        let plaintext = hex::decode(encryption["pt"].as_str().expect("hex")).expect("hex");

        assert_eq!(
            context
                .open(&ciphertext, &aad)
                .expect("the RFC's ciphertext"),
            plaintext,
            "sequence {expected_sequence} did not open to the RFC's plaintext"
        );
    }
}

/// The exporter is the half of the key schedule the AEAD does not exercise. W8
/// builds share invites on it, so it is pinned here rather than the first time
/// something needs it.
#[test]
fn the_rfc_9180_exported_values_match() {
    let vectors = vectors();
    let context = receiver(&vectors);

    for export in vectors["exports"].as_array().expect("exports") {
        let exporter_context =
            hex::decode(export["exporterContext"].as_str().expect("hex")).expect("hex");
        let length = usize::try_from(export["length"].as_u64().expect("a length")).expect("a size");
        let expected = hex::decode(export["exportedValue"].as_str().expect("hex")).expect("hex");

        let mut out = vec![0u8; length];
        context
            .export(&exporter_context, &mut out)
            .expect("the exporter");
        assert_eq!(out, expected, "the RFC's exported value moved");
    }
}

/// The AAD is what makes a header non-transplantable, so the vector's own AAD
/// is used to prove the refusal rather than a value of ours.
#[test]
fn the_rfc_9180_ciphertext_does_not_open_under_another_aad() {
    let vectors = vectors();
    let mut context = receiver(&vectors);

    let first = &vectors["encryptions"][0];
    let ciphertext = hex::decode(first["ct"].as_str().expect("hex")).expect("hex");
    let mut aad = hex::decode(first["aad"].as_str().expect("hex")).expect("hex");
    let last = aad.len() - 1;
    aad[last] ^= 1;

    assert!(
        context.open(&ciphertext, &aad).is_err(),
        "a flipped bit of associated data must refuse the RFC's own ciphertext"
    );
}
