//! THE RECORD'S ENCODING IS A FORMAT DECISION, PINNED AS BYTES (#1029 §0).
//!
//! Beside `identity_vectors.rs`, and for the same reason one layer out. A
//! round-trip test cannot see the encoding move: rename `_centraid` to
//! `_centraidv2`, reorder the two entries, swap base64url for standard base64,
//! change the TTL — every round trip in this crate still passes, and every
//! record already published becomes unreadable to the new build while every
//! record the new build publishes is unreadable to every phone already in
//! someone's pocket. These bytes are what notices.
//!
//! What is pinned here, and why each one is not visible to behaviour:
//!
//! - **the whole signed packet**, byte for byte, in the form that travels:
//!   `public key ‖ signature ‖ timestamp ‖ encoded DNS packet`. That pins the
//!   owner name, the TXT entry names, their order inside the record, the TTL,
//!   and pkarr's own encoding and signature over all of it. `SignedPacket::
//!   serialize` is deliberately NOT what is pinned: it prefixes `last_seen`,
//!   which is the reading clock and not part of the record;
//! - **the `cert=` payload**, so the base64url alphabet and the 104-byte
//!   certificate layout are pinned separately from the packet that carries
//!   them;
//!
//! ## THE TWO INPUTS THAT ARE NOT DERIVED, AND WHY THEY ARE CONSTANTS
//!
//! A device key is random per phone and a pkarr timestamp is the publishing
//! clock (lane A's `certificate.rs`; `IdentityRecord::sign_at`). Neither comes
//! from the seed, so neither is reproducible — and a vector over a signature
//! needs every input fixed. Both are literals below, and neither is a secret
//! that protects anything: they are test inputs, and the file says so.
//!
//! ## THESE VECTORS ARE FREELY REGENERATED UNTIL FIRST RELEASE
//!
//! Same standing as `identity-vectors.json` (#1029, Reference A): D-1020-R1 is
//! dropped pre-release, nothing has shipped, and no record exists in the world
//! that a regeneration would orphan. `CENTRAID_UPDATE_FIXTURES=1` regenerates
//! and the comparison still runs afterwards, so the variable is a generator and
//! never a way to go green. After the first release this paragraph is what has
//! to be deleted to say the opposite.

use std::path::{Path, PathBuf};

use centraid_identity::certificate::{DeviceCertificate, Epoch};
use centraid_identity::derive::VaultMint;
use centraid_identity::phrase::RecoveryPhrase;
use centraid_identity::record::{GatewayUrl, IdentityRecord};
use serde_json::{Value, json};

fn fixture_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../contracts/crypto/discovery-vectors.json")
}

/// BIP39's own all-zero-entropy English vector, as in `identity_vectors.rs`, so
/// both files pin the same tree.
const PHRASE: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon \
     abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon \
     abandon abandon abandon art";

/// A device key's 32 secret bytes, fixed by hand. **A TEST INPUT, NOT A
/// SECRET**: a real device key is drawn from OS entropy on the phone that mints
/// it and never leaves it, so there is nothing here for an attacker to have.
const DEVICE_SECRET: [u8; 32] = [
    0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10,
    0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20,
];

/// The publishing clock, in microseconds since the Unix epoch. Fixed so the
/// packet's signature is reproducible; any value would do, and this one is
/// 2023-11-14T22:13:20Z.
const TIMESTAMP_MICROS: u64 = 1_700_000_000_000_000;

/// The gateway the vectors name. `.example` is reserved by RFC 2606, so no
/// fixture can be mistaken for a live host.
const GATEWAY: &str = "https://gateway.example/";

fn generated() -> Value {
    let seed = RecoveryPhrase::parse(PHRASE)
        .expect("the BIP39 vector parses")
        .seed();
    let gateway = GatewayUrl::parse(GATEWAY).expect("a gateway URL");
    let timestamp = pkarr::Timestamp::from(TIMESTAMP_MICROS);
    let device = ed25519_dalek::SigningKey::from_bytes(&DEVICE_SECRET).verifying_key();

    let keys = VaultMint::fresh().mint(&seed, 0).expect("vault 0");
    let certificate = DeviceCertificate::issue(&keys.identity, &device, Epoch::new(2));
    let record = IdentityRecord::new(gateway, certificate);

    json!({
        "schema": "centraid-discovery-vectors/1",
        "why": "The pkarr record's owner name, entry names, entry order, TTL and base64url alphabet are format decisions (#1029 §0). A round trip cannot see any of them move; a published record that no phone can read is what moving one costs.",
        "phrase": PHRASE,
        "gateway": GATEWAY,
        "timestampMicros": TIMESTAMP_MICROS,
        "recordName": centraid_identity::record::RECORD_NAME,
        "recordTtlSeconds": centraid_identity::record::RECORD_TTL_SECONDS,
        "identityRecord": {
            "vaultIndex": 0,
            "identityPublicHex": hex::encode(keys.identity.public().to_bytes()),
            "deviceSecretHex": hex::encode(DEVICE_SECRET),
            "devicePublicHex": hex::encode(device.to_bytes()),
            "epoch": 2,
            // The `cert=` payload, pinned apart from the packet: the alphabet
            // and the 104-byte layout are their own decision.
            "certBase64Url": cert_base64(&certificate),
            // The whole signed packet: name, entries, order, TTL, signature.
            "signedPacketHex": hex::encode(
                record.sign_at(&keys.identity, timestamp).expect("signs").as_bytes(),
            ),
        },
    })
}

/// base64url, unpadded — read off the published record rather than re-encoded
/// here, so the vector pins what the record actually carries.
fn cert_base64(certificate: &DeviceCertificate) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(certificate.to_bytes())
}

#[test]
fn the_committed_vectors_are_what_this_build_encodes() {
    let path = fixture_path();
    let expected = generated();

    if std::env::var_os("CENTRAID_UPDATE_FIXTURES").is_some() {
        std::fs::create_dir_all(path.parent().expect("a parent")).expect("create contracts/crypto");
        std::fs::write(
            &path,
            format!(
                "{}\n",
                serde_json::to_string_pretty(&expected).expect("serialise")
            ),
        )
        .expect("write the vectors");
        eprintln!("regenerated {} — run `bun run format`", path.display());
    }

    let committed: Value = serde_json::from_str(
        &std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("{} is unreadable: {error}", path.display())),
    )
    .expect("the vectors are JSON");

    assert_eq!(
        committed, expected,
        "contracts/crypto/discovery-vectors.json is not what this build encodes. \
         The record's owner name, an entry name, the entry order, the TTL or the \
         base64url alphabet MOVED, which makes every published record unreadable \
         to this build and every record this build publishes unreadable to every \
         phone already carrying one — regenerate with CENTRAID_UPDATE_FIXTURES=1 \
         only when that is what you meant."
    );
}

/// The pinned packet is not merely stable, it is **readable**: the committed
/// bytes parse back into the record they were generated from. Without this, a
/// regenerated fixture would prove only that the encoder agrees with itself.
#[test]
fn the_pinned_packet_reads_back_as_the_record_it_pins() {
    let vectors = generated();
    let bytes = hex::decode(
        vectors["identityRecord"]["signedPacketHex"]
            .as_str()
            .expect("hex"),
    )
    .expect("hex");

    // Read back exactly the way a resolver does: the key, then the relay
    // payload that travels under it.
    let key = pkarr::PublicKey::try_from(&bytes[..32]).expect("the leading 32 bytes are the key");
    let packet = pkarr::SignedPacket::from_relay_payload(&key, &bytes[32..].to_vec().into())
        .expect("a signed packet");
    let record = IdentityRecord::read(&packet).expect("reads back");

    assert_eq!(record.gateway().as_str(), GATEWAY);
    assert_eq!(record.certificate().epoch(), Epoch::new(2));
    assert_eq!(
        hex::encode(record.identity().to_bytes()),
        vectors["identityRecord"]["identityPublicHex"]
            .as_str()
            .expect("hex"),
    );
    assert_eq!(
        cert_base64(record.certificate()),
        vectors["identityRecord"]["certBase64Url"]
            .as_str()
            .expect("base64url"),
    );
}
