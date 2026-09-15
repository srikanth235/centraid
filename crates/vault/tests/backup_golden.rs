//! The backup plane against the cross-language golden (#1020, D-1020-R1).
//!
//! `crates/media` proves the byte formats. This proves the **vault-side**
//! entry points reach the same bytes: a WAL segment sealed through
//! `backup::wal` and a manifest sealed through `backup::manifest` must match
//! the vectors Node produced, not merely round-trip through themselves.
//!
//! The distinction matters because the vault side does the key derivation. The
//! golden's `wal` section carries both a `masterKeyHex` and the `dataKeyHex` it
//! derives to, so a wrong HKDF info string is caught here rather than showing
//! up as "the restore cannot open anything" on the day it is needed.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use centraid_vault::backup::{keyring, manifest, wal};
use serde_json::Value;

fn golden() -> Value {
    serde_json::from_str(include_str!("../../../contracts/golden/format-golden.json")).unwrap()
}

fn bytes32(hex_value: &str) -> [u8; 32] {
    hex::decode(hex_value).unwrap().try_into().unwrap()
}

#[test]
fn the_wal_section_passes_through_the_vault_side_entry_points() {
    let golden = golden();
    let vector = &golden["wal"];
    let master = bytes32(vector["masterKeyHex"].as_str().unwrap());
    let vault_id = vector["vaultId"].as_str().unwrap();

    // The derivation itself: the vault side is what computes the data key, so
    // a wrong info string is a wrong key and this is where it shows.
    assert_eq!(
        keyring::derive_data_key(&master, vault_id).unwrap(),
        bytes32(vector["dataKeyHex"].as_str().unwrap()),
        "centraid-backup:data:<vaultId> is format-normative"
    );

    let address_value = &vector["address"];
    let address = wal::WalAddress {
        db: address_value["db"].as_str().unwrap(),
        generation: address_value["generation"].as_str().unwrap(),
        group: address_value["group"].as_u64().unwrap(),
        start_offset: address_value["startOffset"].as_u64().unwrap(),
        end_offset: address_value["endOffset"].as_u64().unwrap(),
        tick_ms: address_value["tickMs"].as_u64().unwrap(),
    };
    let plain = STANDARD
        .decode(vector["plainBase64"].as_str().unwrap())
        .unwrap();
    let sealed = STANDARD
        .decode(vector["sealedBase64"].as_str().unwrap())
        .unwrap();

    assert_eq!(
        wal::open_segment(&master, vault_id, &address, &sealed).unwrap(),
        plain,
        "Node's segment opens in Rust"
    );
    assert_eq!(
        wal::seal_segment(&master, vault_id, &address, &plain).unwrap(),
        sealed,
        "and Rust seals the identical bytes — the nonce is derived, not random"
    );
}

#[test]
fn the_snapshot_section_passes_through_the_vault_side_entry_points() {
    let golden = golden();
    let vector = &golden["snapshot"];
    let master = bytes32(vector["masterKeyHex"].as_str().unwrap());
    let vault_id = vector["vaultId"].as_str().unwrap();
    let stored = STANDARD
        .decode(vector["storedBase64"].as_str().unwrap())
        .unwrap();

    // Discovery needs no key at all.
    let public = manifest::read_public_envelope(&stored).unwrap();
    assert_eq!(public.to_json(), vector["publicEnvelope"]);
    assert_eq!(
        manifest::manifest_hash(&stored),
        vector["manifestHash"].as_str().unwrap()
    );

    let (envelope, payload) = manifest::open_manifest(&master, vault_id, &stored).unwrap();
    assert_eq!(payload, vector["payload"]);
    assert_eq!(envelope, public);

    let (rust_stored, rust_hash) =
        manifest::seal_manifest(&master, vault_id, &envelope, &vector["payload"]).unwrap();
    assert_eq!(
        rust_stored, stored,
        "the canonical JSON spelling and the derived nonce are both exact"
    );
    assert_eq!(rust_hash, vector["manifestHash"].as_str().unwrap());
}

/// The typed envelope must survive a round trip through its own JSON, or the
/// re-seal above would be passing for the wrong reason.
#[test]
fn the_public_envelope_round_trips_through_its_typed_form() {
    let golden = golden();
    let value = &golden["snapshot"]["publicEnvelope"];
    let envelope = manifest::PublicEnvelope::from_json(value).unwrap();
    assert_eq!(&envelope.to_json(), value);
    assert_eq!(envelope.prev_manifest_hash, None);
    assert_eq!(envelope.key_epoch, 1);
    assert_eq!(envelope.generation, 3);
    assert_eq!(envelope.chunk_index.len(), 1);
}
