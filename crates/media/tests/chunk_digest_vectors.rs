//! Known answers for the per-chunk digests the backup manifest records
//! (`contracts/crypto/chunk-digest-vectors.json`, #1191 B9).
//!
//! A manifest is immutable and names each sealed chunk by BLAKE3 of the bytes as
//! they open; for a compressed part those are zstd output. A part sealed again
//! later must reproduce them, so a zstd change that alters output must fail
//! HERE and not as read-back reporting damage forever. The workspace pins the
//! zstd crate exactly for the same reason.
//!
//! `CENTRAID_UPDATE_FIXTURES=1` regenerates the file; the comparison runs
//! either way. Nothing is released, so a deliberate change regenerates it and
//! says so.

use centraid_media::sealed::{self, BackupKeys, CHUNK_BYTES, ChunkDigest, PartSealer, chunk_count};
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
        (
            "multi-chunk, compressible",
            compressible(2 * CHUNK_BYTES + 100),
        ),
        (
            "multi-chunk, incompressible",
            incompressible(2 * CHUNK_BYTES + 100),
        ),
    ]
}

fn seal(plaintext: &[u8], compress: bool) -> (Vec<ChunkDigest>, u64) {
    let mut sealer =
        PartSealer::new(&keys(), 0, plaintext.len() as u64, compress, Vec::new()).expect("new");
    sealer.update(plaintext).expect("update");
    let (bytes, seal) = sealer.finish().expect("finish");
    assert_eq!(
        chunk_count(bytes.len() as u64).expect("count") as usize,
        seal.chunk_digests.len()
    );
    (seal.chunk_digests, seal.len)
}

fn current() -> Value {
    let mut cases = Vec::new();
    for (what, plaintext) in inputs() {
        for compress in [false, true] {
            let (digests, sealed_len) = seal(&plaintext, compress);
            cases.push(json!({
                "input": what,
                "plaintextLen": plaintext.len(),
                "compressed": compress,
                "sealedLen": sealed_len,
                "chunkDigests": digests.iter().map(ChunkDigest::to_hex).collect::<Vec<_>>(),
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
    assert_eq!(
        committed, now,
        "a zstd or framing change moved a chunk digest"
    );
}

#[test]
fn sealing_twice_gives_equal_digests_and_equal_sealed_length() {
    for (what, plaintext) in inputs() {
        for compress in [false, true] {
            let first = seal(&plaintext, compress);
            let second = seal(&plaintext, compress);
            assert_eq!(first, second, "{what}, compressed {compress}");
        }
    }
}
