use base64::{Engine, engine::general_purpose::STANDARD};
use centraid_data_plane::{
    cbsf,
    format::{self, WalAddress},
};
use serde_json::Value;

fn fixture() -> Value {
    serde_json::from_str(include_str!("../fixtures/format-golden.json")).unwrap()
}

fn bytes32(hex_value: &str) -> [u8; 32] {
    hex::decode(hex_value).unwrap().try_into().unwrap()
}

#[test]
fn node_cbsf_opens_in_rust_and_rust_seals_identical_bytes() {
    let fixture = fixture();
    let vector = &fixture["cbsf"];
    let key = bytes32(vector["keyHex"].as_str().unwrap());
    let plain = STANDARD
        .decode(vector["plainBase64"].as_str().unwrap())
        .unwrap();
    let sealed = STANDARD
        .decode(vector["sealedBase64"].as_str().unwrap())
        .unwrap();
    assert_eq!(cbsf::open_object(&key, &sealed).unwrap(), plain);
    assert_eq!(
        cbsf::seal_stored_object(&key, &plain, vector["frameSize"].as_u64().unwrap() as usize)
            .unwrap(),
        sealed
    );
}

#[test]
fn node_compressed_cbsf_algorithms_open_in_rust() {
    let fixture = fixture();
    let key = bytes32(fixture["cbsf"]["keyHex"].as_str().unwrap());
    for name in ["zstd", "deflate"] {
        let vector = &fixture["cbsfCompressed"][name];
        let plain = STANDARD
            .decode(vector["plainBase64"].as_str().unwrap())
            .unwrap();
        let sealed = STANDARD
            .decode(vector["sealedBase64"].as_str().unwrap())
            .unwrap();
        assert_eq!(cbsf::open_object(&key, &sealed).unwrap(), plain, "{name}");
    }
}

#[test]
fn node_wal_segment_opens_in_rust_and_rust_seals_identical_bytes() {
    let fixture = fixture();
    let vector = &fixture["wal"];
    let key = bytes32(vector["dataKeyHex"].as_str().unwrap());
    let address_value = &vector["address"];
    let address = WalAddress {
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
    let vault_id = vector["vaultId"].as_str().unwrap();
    assert_eq!(
        format::open_wal_segment(&key, vault_id, &address, &sealed).unwrap(),
        plain
    );
    assert_eq!(
        format::seal_wal_segment(&key, vault_id, &address, &plain).unwrap(),
        sealed
    );
}

#[test]
fn node_snapshot_opens_in_rust_and_rust_seals_identical_bytes() {
    let fixture = fixture();
    let vector = &fixture["snapshot"];
    let master = bytes32(vector["masterKeyHex"].as_str().unwrap());
    let vault_id = vector["vaultId"].as_str().unwrap();
    let stored = STANDARD
        .decode(vector["storedBase64"].as_str().unwrap())
        .unwrap();
    let payload = format::open_snapshot_manifest(&master, vault_id, &stored).unwrap();
    assert_eq!(payload, vector["payload"]);
    let (rust_stored, rust_hash) = format::seal_snapshot_manifest(
        &master,
        vault_id,
        &vector["publicEnvelope"],
        &vector["payload"],
    )
    .unwrap();
    assert_eq!(rust_stored, stored);
    assert_eq!(rust_hash, vector["manifestHash"].as_str().unwrap());
}
