use base64::{Engine, engine::general_purpose::STANDARD};
use centraid_media::format::{self, WalAddress};
use serde_json::Value;

fn fixture_path() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../contracts/golden/format-golden.json")
}

fn fixture() -> Value {
    serde_json::from_str(&std::fs::read_to_string(fixture_path()).expect("the golden is readable"))
        .unwrap()
}

fn bytes32(hex_value: &str) -> [u8; 32] {
    hex::decode(hex_value).unwrap().try_into().unwrap()
}

#[test]
fn a_wal_segment_round_trips_and_reseals_to_the_golden_bytes() {
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
fn a_snapshot_manifest_round_trips_and_reseals_to_the_golden_bytes() {
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

/// THE GOLDEN'S GENERATOR (#1025 S4), and the test that it is not stale.
///
/// It used to be v0's Node tool, and the test that stood here compared this
/// file against the v0 crate's copy byte for byte. That copy is gone with the v0
/// tree, so what remained was a conformance fixture **nothing could produce** —
/// and S4 had to change every sealed byte in it, because the content address,
/// the frame nonce MAC and the KDF all moved to BLAKE3 (D-1025-S4-1/-2/-3).
///
/// So this regenerates and diffs, exactly as `contracts/protocol/framing-golden.json`
/// does: it builds what this build would seal, compares, and
/// `CENTRAID_UPDATE_FIXTURES=1` writes the regenerated file — with the
/// comparison still running afterwards, so the variable is a generator and never
/// a way to go green. The INPUTS below are the golden's real content and are
/// carried from the v0 fixture verbatim: the same keys, the same plaintexts, the
/// same WAL address and the same snapshot envelope. Only the outputs move.
#[test]
fn the_committed_golden_is_what_this_build_seals() {
    let committed = fixture();
    let regenerated = regenerate(&committed);

    if std::env::var_os("CENTRAID_UPDATE_FIXTURES").is_some() {
        std::fs::write(
            fixture_path(),
            format!(
                "{}\n",
                serde_json::to_string_pretty(&regenerated).expect("serialise")
            ),
        )
        .expect("write the golden");
        eprintln!("regenerated the format golden — run `bun run format` and commit it");
    }

    let committed = fixture();
    assert_eq!(
        committed, regenerated,
        "contracts/golden/format-golden.json is not what this build seals; \
         regenerate it with CENTRAID_UPDATE_FIXTURES=1"
    );
}

/// Re-seal every vector from the committed file's own INPUTS.
///
/// Inputs in, outputs recomputed: the WAL address and the snapshot envelope and
/// payload are read back out of the fixture and written through unchanged, so
/// regenerating can never quietly change what the golden is ABOUT — only what
/// this build makes of it.
///
/// **The sealed-frame vectors are gone with the module that produced them**
/// (#1029 §4). They pinned a format whose header carried the plaintext hash and
/// whose nonce came off an address (Reference A, B9), and D-1020-R1 — the ruling
/// that made those bytes normative — was dropped pre-release, so no artefact any
/// member holds has to keep opening. `centraid-object/1`'s vectors live in
/// `contracts/crypto/object-vectors.json`.
fn regenerate(committed: &Value) -> Value {
    let wal = &committed["wal"];
    let master = bytes32(wal["masterKeyHex"].as_str().unwrap());
    let vault_id = wal["vaultId"].as_str().unwrap();
    let data_key = format::derive_data_key(&master, vault_id).unwrap();
    let address_value = &wal["address"];
    let address = WalAddress {
        db: address_value["db"].as_str().unwrap(),
        generation: address_value["generation"].as_str().unwrap(),
        group: address_value["group"].as_u64().unwrap(),
        start_offset: address_value["startOffset"].as_u64().unwrap(),
        end_offset: address_value["endOffset"].as_u64().unwrap(),
        tick_ms: address_value["tickMs"].as_u64().unwrap(),
    };
    let wal_plain = STANDARD
        .decode(wal["plainBase64"].as_str().unwrap())
        .unwrap();

    let snapshot = &committed["snapshot"];
    let snapshot_master = bytes32(snapshot["masterKeyHex"].as_str().unwrap());
    let snapshot_vault = snapshot["vaultId"].as_str().unwrap();
    let (stored, manifest_hash) = format::seal_snapshot_manifest(
        &snapshot_master,
        snapshot_vault,
        &snapshot["publicEnvelope"],
        &snapshot["payload"],
    )
    .unwrap();

    serde_json::json!({
        "schema": committed["schema"],
        "wal": {
            "masterKeyHex": wal["masterKeyHex"],
            "dataKeyHex": hex::encode(data_key),
            "vaultId": wal["vaultId"],
            "address": wal["address"],
            "plainBase64": wal["plainBase64"],
            "sealedBase64": STANDARD.encode(
                format::seal_wal_segment(&data_key, vault_id, &address, &wal_plain).unwrap(),
            ),
        },
        "snapshot": {
            "masterKeyHex": snapshot["masterKeyHex"],
            "vaultId": snapshot["vaultId"],
            "publicEnvelope": snapshot["publicEnvelope"],
            "payload": snapshot["payload"],
            "storedBase64": STANDARD.encode(&stored),
            "manifestHash": manifest_hash,
        },
    })
}
