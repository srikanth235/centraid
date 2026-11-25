//! `centraid-sealed/4`'s vectors, `contracts/crypto/sealed4-vectors.json`
//! ([#1209](https://github.com/srikanth235/centraid/issues/1209),
//! [#1212](https://github.com/srikanth235/centraid/issues/1212), spec §2).
//!
//! Sealing is deterministic, so **every** value is compared, not only opened:
//! the four derived keys, Padmé lengths, names, nonces, whole objects (hex) and
//! digests for fixed inputs across classes and Padmé buckets. A context string,
//! the `"obj4"` preimage, the outer or inner header layout, Padmé's buckets,
//! the AAD or the nonce derivation that moved moves a value here. The committed
//! objects are also **opened**, so the reader is pinned against bytes this
//! build did not just produce.
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
        .join("../../contracts/crypto/sealed4-vectors.json")
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
            "a compressible thumbnail, never compressed",
            Class::Thumbnails,
            b"thumbnail thumbnail thumbnail thumbnail thumbnail".to_vec(),
        ),
        (
            "padme bucket 80, 67-byte original (73-byte inner)",
            Class::Originals,
            vec![0xa1; 67],
        ),
        (
            "padme bucket 80, 72-byte original (78-byte inner)",
            Class::Originals,
            vec![0xb2; 72],
        ),
    ]
}

fn generate() -> Value {
    let keys = keys();
    let cases: Vec<Value> = samples()
        .into_iter()
        .map(|(what, class, plain)| {
            let sealed = sealed::seal(&keys, class, &plain).expect("seals");
            let padded_len = sealed.object.len() - sealed::OUTER_HEADER_BYTES - sealed::TAG_BYTES;
            json!({
                "input": what,
                "class": class.byte(),
                "plaintextHex": hex::encode(&plain),
                "name": sealed.name.to_hex(),
                "flags": sealed.flags,
                "paddedLen": padded_len,
                "objectLen": sealed.object.len(),
                "nonce": hex::encode(&sealed.object[5..29]),
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
fn both_compressed_and_plain_objects_are_among_the_vectors_and_media_stays_plain() {
    let generated = generate();
    let cases = generated["cases"].as_array().expect("cases");
    let flags: Vec<u64> = cases
        .iter()
        .map(|case| case["flags"].as_u64().expect("flags"))
        .collect();
    assert!(flags.contains(&0));
    assert!(flags.contains(&u64::from(sealed::FLAG_ZSTD)));

    for case in cases {
        let class = case["class"].as_u64().expect("class");
        let case_flags = case["flags"].as_u64().expect("flags");
        if class != u64::from(Class::Records.byte()) {
            assert_eq!(case_flags, 0, "media vector compressed");
        }
    }

    // Confirm the thumbnail sample really is compressible when sealed as Records.
    let thumb_bytes = b"thumbnail thumbnail thumbnail thumbnail thumbnail";
    let as_records = sealed::seal(&keys(), Class::Records, thumb_bytes).expect("seals");
    let as_thumb = sealed::seal(&keys(), Class::Thumbnails, thumb_bytes).expect("seals");
    assert_eq!(as_records.flags, sealed::FLAG_ZSTD);
    assert_eq!(as_thumb.flags, 0);
}

#[test]
fn nearby_sizes_share_a_padme_bucket() {
    let generated = generate();
    let cases = generated["cases"].as_array().expect("cases");
    let bucket_cases: Vec<&Value> = cases
        .iter()
        .filter(|case| {
            case["input"]
                .as_str()
                .expect("input")
                .starts_with("padme bucket 80")
        })
        .collect();
    assert_eq!(bucket_cases.len(), 2);
    let len_a = bucket_cases[0]["objectLen"].as_u64().expect("objectLen");
    let len_b = bucket_cases[1]["objectLen"].as_u64().expect("objectLen");
    assert_eq!(bucket_cases[0]["paddedLen"].as_u64(), Some(80));
    assert_eq!(bucket_cases[1]["paddedLen"].as_u64(), Some(80));
    assert_eq!(len_a, len_b, "73B and 78B inner frames share a bucket");
    assert_eq!(len_a, 125);
    assert_ne!(bucket_cases[0]["name"], bucket_cases[1]["name"]);
    assert_ne!(bucket_cases[0]["digest"], bucket_cases[1]["digest"]);
}
