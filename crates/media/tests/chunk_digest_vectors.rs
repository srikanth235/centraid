//! Known answers for the digest of a sealed chunk
//! (`contracts/crypto/chunk-digest-vectors.json`, #1191 B9, regenerated for
//! `centraid-sealed/4` in #1212).
//!
//! A tree node names each object by `{name, digest, len, class}`, and the
//! digest is BLAKE3 of the object as stored. An object sealed again later must
//! reproduce it byte for byte, so a zstd or Padmé framing change that alters
//! output must fail HERE and not as read-back reporting damage forever. The
//! workspace pins the zstd crate exactly for the same reason.
//!
//! `CENTRAID_UPDATE_FIXTURES=1` regenerates the file; the comparison runs
//! either way. Nothing is released, so a deliberate change regenerates it and
//! says so.

use centraid_media::sealed::{self, BackupKeys, CHUNK_BYTES, Class};
use serde_json::{Value, json};

fn keys() -> BackupKeys {
    BackupKeys::from_root(&std::array::from_fn(|i| u8::try_from(i).expect("under 32")))
}

fn incompressible(len: usize) -> Vec<u8> {
    let mut out = vec![0_u8; len];
    blake3::Hasher::new()
        .update(b"chunk-digest")
        .finalize_xof()
        .fill(&mut out);
    out
}

fn compressible(len: usize) -> Vec<u8> {
    b"SQLite format 3\0 core_party row, core_party row. "
        .iter()
        .copied()
        .cycle()
        .take(len)
        .collect()
}

fn inputs() -> Vec<(&'static str, Vec<u8>)> {
    vec![
        ("empty", Vec::new()),
        ("short, compressible", compressible(100)),
        ("short, incompressible", incompressible(100)),
        ("one chunk exactly, compressible", compressible(CHUNK_BYTES)),
        (
            "one chunk exactly, incompressible",
            incompressible(CHUNK_BYTES),
        ),
    ]
}

fn current() -> Value {
    let mut cases = Vec::new();
    for (what, plaintext) in inputs() {
        for class in Class::ALL {
            let sealed = sealed::seal(&keys(), class, &plaintext).expect("seals");
            cases.push(json!({
                "input": what,
                "class": class.byte(),
                "plaintextLen": plaintext.len(),
                "compressed": sealed.flags & sealed::FLAG_ZSTD != 0,
                "sealedLen": sealed.object.len(),
                "name": sealed.name.to_hex(),
                "digest": sealed.digest.to_hex(),
            }));
        }
    }
    json!({ "format": sealed::FORMAT_NAME, "cases": cases })
}

#[test]
fn chunk_digests_match_the_committed_known_answers() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../contracts/crypto/chunk-digest-vectors.json");
    let now = current();
    if std::env::var_os("CENTRAID_UPDATE_FIXTURES").is_some() {
        let text = serde_json::to_string_pretty(&now).expect("json") + "\n";
        std::fs::write(&path, text).expect("write");
    }
    let committed: Value =
        serde_json::from_str(&std::fs::read_to_string(&path).expect("read")).expect("parses");
    assert_eq!(committed, now, "a zstd or framing change moved a digest");
}

#[test]
fn media_classes_never_compress_and_sealed_lengths_stay_bounded() {
    assert_eq!(sealed::OVERHEAD_BYTES, 51);
    assert_eq!(sealed::MAX_OBJECT_BYTES, CHUNK_BYTES + 51);
    let generated = current();
    let cases = generated["cases"].as_array().expect("cases");
    let mut compressed_records = 0_usize;
    for case in cases {
        let class = case["class"].as_u64().expect("class");
        let compressed = case["compressed"].as_bool().expect("compressed");
        let sealed_len =
            usize::try_from(case["sealedLen"].as_u64().expect("sealedLen")).expect("usize");
        assert!(sealed_len >= sealed::MIN_OBJECT_BYTES);
        assert!(sealed_len <= CHUNK_BYTES + 51);
        if class == u64::from(Class::Thumbnails.byte())
            || class == u64::from(Class::Originals.byte())
        {
            assert!(!compressed, "media class compressed");
        } else if compressed {
            compressed_records += 1;
        }
    }
    assert_eq!(compressed_records, 2);
}

#[test]
fn sealing_twice_gives_the_same_object() {
    for (what, plaintext) in inputs() {
        let first = sealed::seal(&keys(), Class::Originals, &plaintext).expect("seals");
        let second = sealed::seal(&keys(), Class::Originals, &plaintext).expect("seals");
        assert_eq!(first, second, "{what}");
    }
}
