//! Locker sealed files (#1214, I7): the `lkf1` format held to committed vectors, streaming seal and
//! open, a file in a field, and what the vault never does with one (a derivative, a dedupe, a copy
//! of its plaintext on disk).
//!
//! THE FORMAT IS PERMANENT ONCE WRITTEN. `tests/vectors/lkf1.json` is a sealed file, the same file
//! with its tail cut off and the same file with two chunks swapped, produced once with fixed nonces
//! (`write_the_vectors`, `LKF1_WRITE_VECTORS=1 cargo test ... -- --ignored`). A change that breaks
//! `the_committed_vectors_still_hold` has broken every file a member sealed.

mod common;

use std::io::Read;

use centraid_vault::commands::locker;
use centraid_vault::custody::sealed_file::{
    self, HEADER_BYTES, OpenReader, SealReader, SealedFileError, open_bytes,
};
use common::locker::{K, add, id_of, item_id, key_id, plain, seal, world};
use serde_json::json;

const VECTORS: &str = include_str!("vectors/lkf1.json");
const VECTOR_KEY: [u8; 32] = {
    let mut key = [0_u8; 32];
    let mut at = 0;
    while at < 32 {
        key[at] = at as u8;
        at += 1;
    }
    key
};

fn vector_plaintext() -> Vec<u8> {
    (0..70_u8).collect()
}

fn vector_seal() -> Vec<u8> {
    let mut at = 0_u8;
    let plain = vector_plaintext();
    let mut reader = SealReader::with_nonces(
        &plain[..],
        &VECTOR_KEY,
        "key-1",
        "item-1:passport_scan",
        16,
        move || {
            at += 1;
            [at; 12]
        },
    )
    .expect("seals");
    let mut out = Vec::new();
    reader.read_to_end(&mut out).expect("reads");
    out
}

#[test]
#[ignore = "writes tests/vectors/lkf1.json; run once with LKF1_WRITE_VECTORS=1"]
fn write_the_vectors() {
    assert!(std::env::var("LKF1_WRITE_VECTORS").is_ok());
    let sealed = vector_seal();
    let whole = HEADER_BYTES + (16 + sealed_file::CHUNK_OVERHEAD) * 4;
    let cut = sealed[..whole].to_vec();
    let chunk = 16 + sealed_file::CHUNK_OVERHEAD;
    let mut swapped = sealed.clone();
    let first = swapped[HEADER_BYTES..HEADER_BYTES + chunk].to_vec();
    let second = swapped[HEADER_BYTES + chunk..HEADER_BYTES + 2 * chunk].to_vec();
    swapped[HEADER_BYTES..HEADER_BYTES + chunk].copy_from_slice(&second);
    swapped[HEADER_BYTES + chunk..HEADER_BYTES + 2 * chunk].copy_from_slice(&first);
    let vectors = json!({
        "about": "lkf1: header 'lkf1' + u32 BE plaintext chunk size; per chunk nonce(12) + AES-256-GCM + tag(16); AAD = header || field id || 0x1F || key id || index u64 BE || final flag. Nonces here are 01..05 repeated; real files use random ones.",
        "key_hex": hex::encode(VECTOR_KEY),
        "key_id": "key-1",
        "field_id": "item-1:passport_scan",
        "chunk_bytes": 16,
        "plaintext_hex": hex::encode(vector_plaintext()),
        "sealed_hex": hex::encode(&sealed),
        "tail_cut_off_hex": hex::encode(cut),
        "two_chunks_swapped_hex": hex::encode(swapped),
    });
    std::fs::write(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/vectors/lkf1.json"),
        serde_json::to_string_pretty(&vectors).unwrap() + "\n",
    )
    .unwrap();
}

#[test]
fn the_committed_vectors_still_hold() {
    let v: serde_json::Value = serde_json::from_str(VECTORS).expect("the vectors are JSON");
    let hex_of = |name: &str| hex::decode(v[name].as_str().unwrap()).unwrap();
    let (key, key_id, field) = (
        hex_of("key_hex"),
        v["key_id"].as_str().unwrap(),
        v["field_id"].as_str().unwrap(),
    );
    let sealed = hex_of("sealed_hex");
    // The header, byte for byte: "lkf1" and the chunk size, big-endian.
    assert_eq!(&sealed[..8], &[0x6c, 0x6b, 0x66, 0x31, 0, 0, 0, 16]);
    // The bytes are what the code seals to with the same nonces: the format has not moved.
    assert_eq!(sealed, vector_seal());
    // They open to the plaintext, under the key, the key id and the field they were sealed for.
    assert_eq!(open_bytes(&sealed, &key, key_id, field).unwrap(), hex_of("plaintext_hex"));
    // A file with its tail cut off, and one with two chunks swapped, do not open.
    for broken in ["tail_cut_off_hex", "two_chunks_swapped_hex"] {
        assert!(
            matches!(
                open_bytes(&hex_of(broken), &key, key_id, field),
                Err(SealedFileError::DoesNotOpen | SealedFileError::Truncated)
            ),
            "{broken} opened"
        );
    }
    // Nor under another field, another generation, or another key.
    assert!(open_bytes(&sealed, &key, key_id, "item-2:passport_scan").is_err());
    assert!(open_bytes(&sealed, &key, "key-2", field).is_err());
    assert!(open_bytes(&sealed, &[9; 32], key_id, field).is_err());
}

/// A deterministic byte stream that never exists in memory whole.
struct Stream {
    left: u64,
    state: u64,
}

impl Read for Stream {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = buf.len().min(usize::try_from(self.left).unwrap_or(usize::MAX));
        for byte in &mut buf[..n] {
            self.state = self.state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            *byte = (self.state >> 33) as u8;
        }
        self.left -= n as u64;
        Ok(n)
    }
}

fn digest_of(mut source: impl Read) -> (String, u64) {
    let mut hasher = blake3::Hasher::new();
    let mut buf = vec![0_u8; 8192];
    let mut total = 0_u64;
    loop {
        let n = source.read(&mut buf).unwrap();
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        total += n as u64;
    }
    (hasher.finalize().to_hex().to_string(), total)
}

#[test]
fn a_large_file_is_sealed_into_the_store_and_opened_as_a_stream() {
    let w = world("locker_stream");
    let size = 3 * 1024 * 1024 + 123;
    let store = centraid_blobs::ByteStore::open(w.scratch.join("vault.bytes")).expect("a store");
    let mut sealer = SealReader::new(Stream { left: size, state: 7 }, &K, "key-1", "item-1:scan").unwrap();
    let stored = store.put_stream(&mut sealer).expect("the sealed bytes are stored");
    // What is stored is the ciphertext: its hash is the ciphertext's, its size the format's.
    assert_eq!(stored.bytes, sealed_file::sealed_len(size, sealed_file::DEFAULT_CHUNK_BYTES));
    let (plain_hash, _) = digest_of(Stream { left: size, state: 7 });
    assert_ne!(stored.hash.to_hex(), plain_hash);
    let on_disk = std::fs::File::open(&stored.path).unwrap();
    assert_eq!(digest_of(on_disk).0, stored.hash.to_hex());
    // It opens as a stream to exactly the plaintext (compared by hash, never held whole)...
    let opened = OpenReader::new(std::fs::File::open(&stored.path).unwrap(), &K, "key-1", "item-1:scan").unwrap();
    assert_eq!(digest_of(opened), (plain_hash, size));
    // ...and a stored file with its last chunk dropped fails before the end.
    let cut = std::fs::read(&stored.path).unwrap();
    let whole = usize::try_from(sealed_file::DEFAULT_CHUNK_BYTES).unwrap() + sealed_file::CHUNK_OVERHEAD;
    let cut = &cut[..cut.len() - (cut.len() - HEADER_BYTES) % whole];
    assert!(open_bytes(cut, &K, "key-1", "item-1:scan").is_err());
    // No file in the scratch directory holds the plaintext's first bytes (no plaintext copy).
    let mut head = vec![0_u8; 4096];
    Stream { left: 4096, state: 7 }.read_exact(&mut head).unwrap();
    for entry in walk(w.scratch.dir()) {
        let bytes = std::fs::read(&entry).unwrap();
        assert!(!bytes.windows(head.len()).any(|window| window == head.as_slice()), "{entry:?}");
    }
}

fn walk(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut found = Vec::new();
    for entry in std::fs::read_dir(dir).unwrap().flatten() {
        let path = entry.path();
        if path.is_dir() {
            found.extend(walk(&path));
        } else {
            found.push(path);
        }
    }
    found
}

/// The stored sealed bytes of a small file, and the sealed cell of its name and type.
fn sealed_file_for(
    w: &common::world::World,
    field: &str,
    name: &str,
    plaintext: &[u8],
) -> (String, String) {
    let sealed = sealed_file::seal_bytes(plaintext, &K, &key_id(w), field).unwrap();
    let hash = w.vault().blobs().expect("a store").put(&sealed).expect("stored");
    let cell = seal(w, field, &json!({ "name": name, "media_type": "application/pdf" }).to_string());
    (hash, cell)
}

#[test]
fn a_file_field_holds_ciphertext_by_hash_and_a_replaced_or_removed_file_stays_readable() {
    let w = world("locker_file_field");
    let item = item_id(&w);
    add(&w, &item, "passport", "Passport", vec![plain("full_name", "A Holder")]);
    let field = "scan-field-1";
    let (hash, cell) = sealed_file_for(&w, field, "passport.pdf", b"%PDF the first scan");
    let live = key_id(&w);
    let input = |hash: &str, cell: &str, changed: Option<bool>| {
        let mut input = json!({ "item_id": item, "field_id": field, "label": "Scan", "kind": "file",
                                "value": cell, "blob": hash, "key_id": live });
        if let Some(changed) = changed {
            input["changed"] = json!(changed);
        }
        input
    };
    w.ok("locker.set_field", input(&hash, &cell, None));
    // The row: the blob is the ciphertext's hash; the name and type are a sealed cell; no hash is
    // inside any text or sealed value.
    let (blob, sealed, text, set_at): (String, String, Option<String>, Option<String>) = w
        .vault()
        .read(|c| {
            Ok(c.query_row(
                "SELECT value_blob, value_sealed, value_text, value_set_at FROM locker_item_field WHERE id = ?1",
                [field],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )?)
        })
        .unwrap();
    assert_eq!(blob, hash);
    assert!(sealed.starts_with("lk1:") && !sealed.contains(&hash));
    assert!(text.is_none() && set_at.is_some());
    assert_eq!(
        centraid_vault::blob::content_digest(&w.vault().blobs().unwrap().get(&hash).unwrap()),
        hash,
        "the hash is the stored (sealed) bytes'"
    );
    assert_ne!(hash, centraid_vault::blob::content_digest(b"%PDF the first scan"));

    // The same file sealed twice is two files with two hashes: nothing dedupes.
    let (again, _) = sealed_file_for(&w, "scan-field-2", "passport.pdf", b"%PDF the first scan");
    assert_ne!(again, hash);

    // Refused: bytes that are not a sealed file, bytes the store lacks, a blob on a text field.
    let plain_hash = w.vault().blobs().unwrap().put(b"just plain bytes, no header at all.").unwrap();
    for (bad, said) in [
        (plain_hash.as_str(), "not a file sealed under the Locker key"),
        ("0".repeat(64).as_str(), "not in this vault's store"),
    ] {
        assert!(
            w.refused("locker.set_field", input(bad, &cell, Some(true))).contains(said),
            "{said}"
        );
    }
    assert!(
        w.refused(
            "locker.set_field",
            json!({ "item_id": item, "field_key": "nationality", "value": "x", "blob": hash }),
        )
        .contains("only a file field")
    );
    // New bytes on an existing file say they changed.
    let (second, second_cell) = sealed_file_for(&w, field, "passport-2.pdf", b"%PDF the second scan");
    assert!(
        w.refused("locker.set_field", input(&second, &second_cell, None)).contains("say whether")
    );
    assert!(
        w.refused("locker.set_field", input(&second, &second_cell, Some(false))).contains("changed file")
    );

    // A replaced file: the old one stays readable, sealed, through its history slot.
    let versions_before: i64 = w.one("SELECT COUNT(*) FROM revision WHERE entity_id = ?1", &[&item]);
    w.ok("locker.set_field", input(&second, &second_cell, Some(true)));
    let held: i64 = w.one("SELECT MAX(seq) FROM revision WHERE entity_id = ?1", &[&item]);
    assert_eq!(held, versions_before + 1);
    assert_eq!(
        w.one::<String>(
            "SELECT blob FROM revision_blob WHERE entity_id = ?1 AND seq = ?2 AND slot = ?3",
            &[&item, &held.to_string(), &format!("field:{field}")]
        ),
        hash
    );
    let earlier = w.vault().locker_sealed_file(&item, field, Some(held)).unwrap().expect("the earlier file");
    assert_eq!(earlier.blob, hash);
    let bytes = w.vault().blobs().unwrap().get(&earlier.blob).unwrap();
    assert_eq!(open_bytes(&bytes, &K, &live, field).unwrap(), b"%PDF the first scan");
    let now = w.vault().locker_sealed_file(&item, field, None).unwrap().unwrap();
    assert_eq!(now.blob, second);
    // Collecting the blobs frees neither: the old one is kept by the version, the new by the field.
    w.vault().collect_blobs().unwrap();
    assert!(w.vault().blobs().unwrap().has(&hash).unwrap());
    assert!(w.vault().blobs().unwrap().has(&second).unwrap());
    // A removed file stays readable the same way.
    w.ok("locker.remove_field", json!({ "item_id": item, "field_id": field }));
    let removed_at: i64 = w.one("SELECT MAX(seq) FROM revision WHERE entity_id = ?1", &[&item]);
    let gone = w.vault().locker_sealed_file(&item, field, Some(removed_at)).unwrap().expect("kept");
    assert_eq!(gone.blob, second);
    w.vault().collect_blobs().unwrap();
    assert!(w.vault().blobs().unwrap().has(&second).unwrap());
    assert!(w.vault().locker_sealed_file(&item, field, None).unwrap().is_none());
}

#[test]
fn nothing_is_ever_made_from_a_sealed_file_and_it_is_always_kept_and_sent() {
    let w = world("locker_file_kept");
    let item = item_id(&w);
    add(&w, &item, "document", "Deed", vec![]);
    let field = "deed-scan";
    let (hash, cell) = sealed_file_for(&w, field, "deed.pdf", b"%PDF deed");
    w.ok(
        "locker.set_field",
        json!({ "item_id": item, "field_id": field, "label": "Scan", "kind": "file",
                "value": cell, "blob": hash, "key_id": key_id(&w) }),
    );
    // No derivative: the command refuses, and so does the file's door.
    let refusal = w
        .vault()
        .execute(
            &w.registry,
            &centraid_vault::Principal::owner("phone"),
            &centraid_vault::Command::new(
                "derivative.write",
                json!({ "blob": hash, "variant": "text", "text": "words" }),
            ),
        )
        .map(|outcome| format!("{:?}", outcome.reason))
        .unwrap_or_else(|error| error.to_string());
    assert!(refusal.contains("nothing is made from it"), "{refusal}");
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM derivative WHERE blob = ?1", &[&hash]), 0);
    // It is flagged sealed for the backup and the phone's free-up pass, now and as an earlier version.
    let sealed = w.vault().read(|c| centraid_vault::blob::sealed_hashes(c)).unwrap();
    assert!(sealed.contains(&hash));
    let files = centraid_vault::backup::files::content_files(w.vault()).unwrap();
    let listed = files.iter().find(|f| f.h.to_hex() == hash).expect("listed for the backup");
    assert!(listed.sealed);
    w.ok("locker.remove_field", json!({ "item_id": item, "field_id": field }));
    let sealed = w.vault().read(|c| centraid_vault::blob::sealed_hashes(c)).unwrap();
    assert!(sealed.contains(&hash), "an earlier version's file is still sealed");
    // Not an item's attachment either: a sealed file is a field, never a document.
    assert_eq!(locker::ITEM_TYPES.len(), 15);
    let _ = id_of(&item, "x");
}
