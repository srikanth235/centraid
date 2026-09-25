//! THE TWO KEYED PRIMITIVES, PINNED (#1025 S4, D-1025-S4-2/-3).
//!
//! `blake3::keyed_hash` and `blake3::derive_key` replaced HMAC-SHA-256 and
//! HKDF-SHA-256 across this repository, and both are **format decisions**: a
//! chunk id, a frame nonce and every derived key are values that have to come
//! out the same on every build, forever, or a vault stops opening.
//!
//! A round-trip test cannot see that. Sealing and opening with the same wrong
//! derivation passes; so does a `blake3` version bump that changed a context
//! string's handling. So the vectors live in `contracts/crypto/blake3-vectors.json`,
//! where they are bytes rather than behaviour, and this regenerates and diffs
//! them the way `contracts/crypto/object-vectors.json` and
//! `contracts/crypto/identity-vectors.json` are regenerated and diffed:
//! `CENTRAID_UPDATE_FIXTURES=1` writes the file and the comparison still runs
//! afterwards, so the variable is a generator and never a way to go green.
//!
//! ## What each vector is FOR, because a vector with no site is decoration
//!
//! Every `context` and every keyed input below is a real one: the backup
//! keyring's data and dedup keys, the member-key envelope's context with a vault
//! id folded into it (BLAKE3 has no salt argument — D-1025-S4-3), a WAL nonce,
//! and `centraid-object/1`'s key-wrap context. If a site's context string
//! changes, its vector moves and this test says which.

use std::path::{Path, PathBuf};

use serde_json::{Value, json};

fn fixture_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../contracts/crypto/blake3-vectors.json")
}

/// A 32-byte key with every byte distinct from its neighbours, so a vector that
/// swapped two bytes of it would move.
const KEY: [u8; 32] = [
    0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
    0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f,
];

const VAULT_ID: &str = "00000000-0000-7000-8000-000000000456";

fn generated() -> Value {
    let derived: Vec<Value> = [
        // `backup::keyring::derive_data_key` — what every object for a vault is
        // sealed under.
        (format!("centraid-backup:data:{VAULT_ID}"), 32_usize),
        // `derive_dedup_key` — a SEPARATE key, so a chunk id reveals nothing
        // that helps open a chunk. Same key material, different context: if the
        // two ever produced one value, dedupe would leak.
        (format!("centraid-backup:dedup:{VAULT_ID}"), 32),
        // `custody::member_key::envelope_cipher`. The `‖` is the separator the
        // vault id is folded in with, because BLAKE3's KDF has no salt.
        (
            format!("centraid-member-key-envelope-v1\u{2016}{VAULT_ID}"),
            32,
        ),
        // A WAL nonce: 12 bytes off the same XOF, which is the length HKDF's
        // counter loop used to be asked for.
        (
            "centraid-backup:wal-nonce:vault:0123456789abcdef0123456789abcdef:7:32:67:1721280000456"
                .to_owned(),
            12,
        ),
    ]
    .into_iter()
    .map(|(context, length)| {
        let mut out = vec![0_u8; length];
        blake3::Hasher::new_derive_key(&context)
            .update(&KEY)
            .finalize_xof()
            .fill(&mut out);
        json!({ "context": context, "length": length, "outHex": hex::encode(&out) })
    })
    .collect();

    let keyed: Vec<Value> = [
        // `backup::keyring::chunk_id` over a chunk of plaintext.
        (
            "chunkId",
            b"the same bytes in two vaults are two addresses".to_vec(),
        ),
        // The empty message, because a MAC that special-cased length would pass
        // every other vector here.
        ("empty", Vec::new()),
        // One byte past BLAKE3's 1 KiB chunk, so the tree has two leaves.
        ("pastOneChunk", vec![0x5a; 1025]),
    ]
    .into_iter()
    .map(|(name, message)| {
        json!({
            "name": name,
            "messageLen": message.len(),
            "tagHex": hex::encode(blake3::keyed_hash(&KEY, &message).as_bytes()),
        })
    })
    .collect();

    // `centraid-object/1`'s key-wrap key, derived from the vault root so the
    // root is never itself an AEAD key (#1029 §4). It REPLACED the frame-nonce
    // vector that stood here, whose site went with the frame format it pinned:
    // that format derived its nonce from the object's ADDRESS, which is exactly
    // the defect B9 names, and a vector with no site is decoration. The context string below is the domain
    // separator — if it moves, every object ever sealed stops opening, and this
    // is what says so.
    let object_wrap_key = blake3::derive_key("centraid-object/1 vault-root key wrap", &KEY);

    json!({
        "schema": "centraid-blake3-vectors/1",
        "why": "The keyed MAC and the KDF are format decisions (#1025 S4, D-1025-S4-2/-3). A round trip cannot see a changed derivation; these bytes can.",
        "keyHex": hex::encode(KEY),
        "deriveKey": derived,
        "keyedHash": keyed,
        "objectKeyWrapKey": {
            "context": "centraid-object/1 vault-root key wrap",
            "keyHex": hex::encode(object_wrap_key),
        },
    })
}

#[test]
fn the_committed_vectors_are_what_this_build_computes() {
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
        "contracts/crypto/blake3-vectors.json is not what this build computes. \
         A keyed MAC or a derived key MOVED, which re-keys every vault that ever \
         opened — regenerate with CENTRAID_UPDATE_FIXTURES=1 only when that is \
         what you meant."
    );
}

/// THE TWO CONTEXTS THAT MUST NOT COLLIDE, asserted as values.
///
/// `derive_data_key` and `derive_dedup_key` take one master key and differ only
/// in their context string. A KDF that ignored the context would hand back one
/// key for both, and every chunk id would then be computable from the key that
/// opens the chunk.
#[test]
fn one_key_and_two_contexts_are_two_independent_keys() {
    let data = blake3::derive_key(&format!("centraid-backup:data:{VAULT_ID}"), &KEY);
    let dedup = blake3::derive_key(&format!("centraid-backup:dedup:{VAULT_ID}"), &KEY);
    assert_ne!(data, dedup);
    // And the VAULT is part of the separation, not only the purpose.
    assert_ne!(
        data,
        blake3::derive_key("centraid-backup:data:another-vault", &KEY)
    );
}
