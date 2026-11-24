//! `centraid-sealed/3`'s vectors, `contracts/crypto/sealed3-vectors.json`
//! ([#1209](https://github.com/srikanth235/centraid/issues/1209), spec §2).
//!
//! Sealing is deterministic, so **every** value is compared, not opened: the
//! four derived keys, names, nonces and whole objects (hex) and digests for
//! fixed inputs, compressed and not, in each class. A context string, the
//! preimage, the header layout, the AAD or the nonce derivation that moved
//! moves a value here. The committed objects are also **opened**, so the
//! reader is pinned against bytes this build did not just produce.
//!
//! `CENTRAID_UPDATE_FIXTURES=1` regenerates the file; the comparison runs
//! either way, so the variable is a generator and never a way to go green.

use centraid_media::sealed::{self, BackupKeys, Class, Ref};
use serde_json::{Value, json};

fn root() -> [u8; 32] {
    std::array::from_fn(|index| u8::try_from(index).expect("under 32"))
}

fn keys() -> BackupKeys {
    BackupKeys::from_root(&root())
}

fn path() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../contracts/crypto/sealed3-vectors.json")
}

fn samples() -> Vec<(&'static str, Class, Vec<u8>)> {
    vec![
        ("an empty chunk", Class::Records, Vec::new()),
        (
            "an original's bytes, not compressed",
            Class::Originals,
            b"\xff\xd8\xff\xe0 a photograph's first bytes".to_vec(),
        ),
        (
            "a database range, compressed",
            Class::Records,
            b"SQLite format 3\0 page after page of core_party rows. ".repeat(40),
        ),
        (
            "a thumbnail, compressed",
            Class::Thumbnails,
            b"thumbnail thumbnail thumbnail thumbnail thumbnail".to_vec(),
        ),
    ]
}

fn generate() -> Value {
    let keys = keys();
    let cases: Vec<Value> = samples()
        .into_iter()
        .map(|(what, class, plain)| {
            let sealed = sealed::seal(&keys, class, &plain).expect("seals");
            json!({
                "input": what,
                "class": class.byte(),
                "plaintextHex": hex::encode(&plain),
                "name": sealed.name.to_hex(),
                "flags": sealed.object[5],
                "nonce": hex::encode(&sealed.object[7..31]),
                "objectHex": hex::encode(&sealed.object),
                "digest": sealed.digest.to_hex(),
                "ref": hex::encode(sealed.reference().encode()),
            })
        })
        .collect();
    json!({
        "format": sealed::FORMAT_NAME,
        "root": hex::encode(root()),
        "kBackup": hex::encode(keys.k_backup()),
        "kName": hex::encode(keys.k_name()),
        "kObj": hex::encode(keys.k_obj()),
        "kNonce": hex::encode(keys.k_nonce()),
        "cases": cases,
    })
}

#[test]
fn the_committed_vectors_are_what_this_build_derives_and_open() {
    let now = generate();
    if std::env::var_os("CENTRAID_UPDATE_FIXTURES").is_some() {
        std::fs::write(
            path(),
            serde_json::to_string_pretty(&now).expect("json") + "\n",
        )
        .expect("write");
    }
    let committed: Value =
        serde_json::from_str(&std::fs::read_to_string(path()).expect("read")).expect("parses");
    assert_eq!(committed, now, "the sealed format moved");

    // The committed bytes open with the keys alone.
    for case in committed["cases"].as_array().expect("cases") {
        let object = hex::decode(case["objectHex"].as_str().expect("hex")).expect("hex");
        let plain = hex::decode(case["plaintextHex"].as_str().expect("hex")).expect("hex");
        let reference = Ref::decode(&hex::decode(case["ref"].as_str().expect("ref")).expect("hex"))
            .expect("ref");
        assert_eq!(
            sealed::open(&keys(), &reference, &object).expect("opens"),
            plain
        );
    }
}

#[test]
fn both_compressed_and_plain_objects_are_among_the_vectors() {
    let committed = generate();
    let flags: Vec<u64> = committed["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .map(|case| case["flags"].as_u64().expect("flags"))
        .collect();
    assert!(flags.contains(&0) && flags.contains(&1));
}
