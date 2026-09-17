//! `centraid-object/1`'s vectors — `contracts/crypto/object-vectors.json`.
//!
//! ## THESE ARE REGRESSION VECTORS, NOT A RELEASED FORMAT
//!
//! D-1020-R1 — the ruling that made the v0-derived byte formats *normative*, so
//! that changing one was a re-keying event — was **dropped before release**
//! (#1029, Reference A). Nothing any member holds was ever sealed with this
//! format. So until the first release these may be regenerated freely with
//! `CENTRAID_UPDATE_FIXTURES=1`; what they buy is that a change to the format is
//! *noticed and deliberate*, not that it is forbidden. Lane A of W0.5 said the
//! same thing beside its own fixture, and it is said here because a reader who
//! assumes otherwise will refuse a change they should have made.
//!
//! ## WHY HALF OF THIS FILE IS COMPARED AND HALF IS OPENED
//!
//! **Sealing is not reproducible, on purpose.** Every object carries a random
//! salt, a random content key and random nonces (B9), so the same plaintext
//! seals to different bytes every time and a byte-for-byte "reseal and compare"
//! would be a test that the randomness is broken. The vectors therefore work
//! from both ends:
//!
//! - **Compared**: everything a build *determines* — the trained dictionary and
//!   its BLAKE3 id, Padmé's buckets, the sealed LENGTH of each object, a pack's
//!   item offsets and lengths, and how a 28 MiB input splits. A header field
//!   that moved, a padding rule that changed, a zstd bump that compresses
//!   differently: all of them move a number here.
//! - **Opened**: the committed `sealedBase64` bytes are decrypted and checked
//!   against their plaintext. That is the half a length cannot reach — the AAD,
//!   the chunk framing, the key wrap and the field ORDER — and it pins the
//!   reader against bytes this build did not just produce.

use base64::{Engine, engine::general_purpose::STANDARD};
use centraid_media::object::{
    self, CHUNK_BYTES, Custody, Dictionary, HEADER_MAGIC, Kind, MAX_OBJECT_BYTES,
    MAX_PLAINTEXT_BYTES, NONCE_BYTES, ObjectName, Role, SALT_BYTES, SealOptions, TAG_BYTES,
    header::HEADER_FIXED_BYTES, pad::padme,
};
use serde_json::{Value, json};

const ROOT: [u8; 32] = [0x11; 32];
const FILE_KEY: [u8; 32] = [0x22; 32];

/// The vault these objects are sealed for — §4's `(vault identity key, kind)`
/// AAD binding. The key is never written into an object; it is associated data
/// on both the key wrap and every body chunk.
const VAULT_KEY: [u8; 32] = [0x33; 32];

fn vault() -> object::VaultId<'static> {
    object::VaultId::new(&VAULT_KEY)
}

fn fixture_path() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../contracts/crypto/object-vectors.json")
}

/// The dictionary's training corpus, written down here so the dictionary in the
/// fixture is reproducible from the fixture's own inputs.
fn samples() -> Vec<Vec<u8>> {
    (0..128_u32)
        .map(|row| {
            format!(
                "SQLite format 3\u{0}core_content_item\u{0}content_id=c-{row}\u{0}\
                 content_uri=data:text/plain,{row}\u{0}byte_size={row}\u{0}"
            )
            .into_bytes()
        })
        .collect()
}

fn dictionary() -> Dictionary {
    let owned = samples();
    let refs: Vec<&[u8]> = owned.iter().map(Vec::as_slice).collect();
    Dictionary::train(&refs, 16 * 1024).expect("trains")
}

/// A page-shaped plaintext the dictionary can actually help with.
fn segment_plaintext() -> Vec<u8> {
    samples()[..16].concat()
}

fn pack_bodies() -> Vec<(String, Vec<u8>)> {
    (0..6_u32)
        .map(|index| {
            (
                format!("thumb-{index}"),
                format!("thumbnail bytes for {index}")
                    .repeat(8)
                    .into_bytes(),
            )
        })
        .collect()
}

#[test]
fn the_committed_object_vectors_open_and_are_what_this_build_seals() {
    let refresh = std::env::var_os("CENTRAID_UPDATE_FIXTURES").is_some();
    let committed: Value = std::fs::read_to_string(fixture_path())
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or(Value::Null);

    let regenerated = generate(&committed, refresh);

    if refresh {
        std::fs::write(
            fixture_path(),
            format!(
                "{}\n",
                serde_json::to_string_pretty(&regenerated).expect("serialise")
            ),
        )
        .expect("write the vectors");
        eprintln!("regenerated the object vectors — run `bun run format` and commit them");
    }

    let committed: Value = serde_json::from_str(
        &std::fs::read_to_string(fixture_path()).expect("the vectors are readable"),
    )
    .expect("the vectors are JSON");

    assert_eq!(
        committed, regenerated,
        "contracts/crypto/object-vectors.json is not what this build produces. \
         Every field here except `sealedBase64` is DETERMINED by the format — a \
         header field, a padding rule, the dictionary or a zstd bump moved. \
         Regenerate with CENTRAID_UPDATE_FIXTURES=1 when that is what you meant; \
         these are regression vectors and not a released format (see this file's \
         header)."
    );

    open_every_committed_object(&committed);
}

/// The half a length cannot reach: the committed ciphertext still opens.
fn open_every_committed_object(committed: &Value) {
    let dictionary = dictionary();
    for vector in committed["objects"].as_array().expect("objects") {
        let name = vector["name"].as_str().expect("a name");
        let sealed = STANDARD
            .decode(vector["sealedBase64"].as_str().expect("sealed bytes"))
            .expect("base64");
        let plaintext = STANDARD
            .decode(vector["plaintextBase64"].as_str().expect("plaintext"))
            .expect("base64");
        let custody = custody_of(vector);
        let with = vector["compressed"]
            .as_bool()
            .expect("a flag")
            .then_some(&dictionary);
        assert_eq!(
            object::open(vault(), custody, &sealed, with)
                .unwrap_or_else(|error| panic!("{name}: {error}")),
            plaintext,
            "{name} no longer opens"
        );
        assert_eq!(
            ObjectName::of(&sealed).hex(),
            vector["nameHex"].as_str().expect("a name hex"),
            "{name}'s name is not the BLAKE3 of its own ciphertext"
        );
    }

    let pack = &committed["pack"];
    let bytes = STANDARD
        .decode(pack["sealedBase64"].as_str().expect("pack bytes"))
        .expect("base64");
    let entries =
        object::pack::read_table(vault(), &ROOT, &bytes, None).expect("the committed pack's table");
    for (entry, (id, plaintext)) in entries.iter().zip(pack_bodies()) {
        assert_eq!(entry.id, id);
        assert_eq!(
            object::pack::open_range(vault(), Custody::FileKey(&FILE_KEY), &bytes, entry, None)
                .expect("an item opens from its range"),
            plaintext
        );
    }
}

fn custody_of(vector: &Value) -> Custody<'static> {
    match vector["custody"].as_str().expect("a custody") {
        "wrapped" => Custody::Wrapped(&ROOT),
        _ => Custody::FileKey(&FILE_KEY),
    }
}

/// Recompute every determined field; carry the ciphertext through unless asked
/// to refresh it.
///
/// Carrying it through is what lets the comparison above be total: a fresh seal
/// every run would make `sealedBase64` differ from the committed file on every
/// invocation, which is the randomness working, not a drift.
fn generate(committed: &Value, refresh: bool) -> Value {
    let dictionary = dictionary();
    let segment = segment_plaintext();

    let specs: [(&str, Kind, Role, &str, Vec<u8>); 4] = [
        (
            "blobUncompressed",
            Kind::Blob,
            Role::Original,
            "fileKey",
            b"a camera original's bytes, which are already a compressed codec".to_vec(),
        ),
        (
            "thumbnailUncompressed",
            Kind::Thumbnail,
            Role::Thumbnail,
            "fileKey",
            b"a generated thumbnail".to_vec(),
        ),
        (
            "segmentCompressed",
            Kind::Segment,
            Role::Whole,
            "wrapped",
            segment.clone(),
        ),
        (
            "manifestCompressed",
            Kind::Manifest,
            Role::Whole,
            "wrapped",
            br#"{"format":"centraid-generation/1","txid":41,"census":{"core_entity":7}}"#.to_vec(),
        ),
    ];

    let objects: Vec<Value> = specs
        .iter()
        .enumerate()
        .map(|(index, (name, kind, role, custody, plaintext))| {
            let with = kind.compresses().then_some(&dictionary);
            let custody_ref = if *custody == "wrapped" {
                Custody::Wrapped(&ROOT)
            } else {
                Custody::FileKey(&FILE_KEY)
            };
            let sealed = object::seal(
                vault(),
                custody_ref,
                &SealOptions {
                    kind: *kind,
                    role: *role,
                    dictionary: with,
                },
                plaintext,
            )
            .expect("seals");

            let carried = committed["objects"]
                .get(index)
                .filter(|previous| previous["name"] == json!(name));
            let (bytes_base64, name_hex) = match (refresh, carried) {
                (false, Some(previous)) => (
                    previous["sealedBase64"].clone(),
                    previous["nameHex"].clone(),
                ),
                _ => (
                    json!(STANDARD.encode(&sealed.bytes)),
                    json!(sealed.name.hex()),
                ),
            };

            json!({
                "name": name,
                "kind": kind.as_str(),
                "role": role.as_str(),
                "custody": custody,
                "compressed": with.is_some(),
                "plaintextBase64": STANDARD.encode(plaintext),
                "plaintextHashHex": hex::encode(sealed.plaintext_hash),
                "sealedBytes": sealed.bytes.len(),
                "sealedBase64": bytes_base64,
                "nameHex": name_hex,
            })
        })
        .collect();

    // A pack: six small items, each its own object, addressable by range.
    let bodies = pack_bodies();
    let items: Vec<object::pack::PackItem<'_>> = bodies
        .iter()
        .map(|(id, plaintext)| object::pack::PackItem {
            id,
            custody: Custody::FileKey(&FILE_KEY),
            kind: Kind::Thumbnail,
            role: Role::Thumbnail,
            plaintext,
        })
        .collect();
    let pack = object::pack::build(vault(), &ROOT, &items, None).expect("packs");
    let pack_bytes = match (refresh, committed["pack"]["sealedBase64"].as_str()) {
        (false, Some(previous)) => json!(previous),
        _ => json!(STANDARD.encode(&pack.bytes)),
    };

    // A 28 MiB + 1 KiB input, which is a LIST rather than a multipart upload
    // (F6). Zeros: what is pinned here is the split arithmetic and the sizes,
    // and `Kind::Blob` does not compress, so the content of the filler changes
    // nothing.
    let oversized = vec![0_u8; MAX_PLAINTEXT_BYTES * 2 + 1024];
    let (parts, list) = object::seal_list(
        vault(),
        Custody::FileKey(&FILE_KEY),
        &SealOptions {
            kind: Kind::Blob,
            role: Role::Original,
            dictionary: None,
        },
        &oversized,
    )
    .expect("splits");

    let padme_buckets: Vec<Value> = [0_u64, 1, 9, 100, 1000, 1024, 100_000, 1_048_577]
        .into_iter()
        .map(|length| json!({ "length": length, "padded": padme(length) }))
        .collect();

    json!({
        "schema": "centraid-object-vectors/1",
        "why": "Regression vectors for centraid-object/1 (#1029 §4). Regenerate \
                freely with CENTRAID_UPDATE_FIXTURES=1 until the first release: \
                D-1020-R1, which made the v0 byte formats normative, was dropped \
                pre-release and nothing any member holds was sealed with this. \
                Sealing is deliberately not reproducible (random salt, key and \
                nonces — B9), so every field but `sealedBase64` is recomputed and \
                compared while `sealedBase64` is OPENED.",
        "format": {
            "name": "centraid-object/1",
            "version": 1,
            "magic": String::from_utf8_lossy(HEADER_MAGIC),
            "headerFixedBytes": HEADER_FIXED_BYTES,
            "saltBytes": SALT_BYTES,
            "nonceBytes": NONCE_BYTES,
            "tagBytes": TAG_BYTES,
            "chunkBytes": CHUNK_BYTES,
            "maxObjectBytes": MAX_OBJECT_BYTES,
            "maxPlaintextBytes": MAX_PLAINTEXT_BYTES,
        },
        "rootKeyHex": hex::encode(ROOT),
        "fileKeyHex": hex::encode(FILE_KEY),
        // THE VAULT IDENTITY KEY IS AN INPUT, NOT A FIELD OF ANY OBJECT (§4).
        // It is associated data on the key wrap and on every body chunk, so a
        // reader needs it to open these vectors and will find it nowhere inside
        // them — which is the point: a blind store must not be able to tell
        // which vault a ciphertext belongs to.
        "vaultIdentityKeyHex": hex::encode(VAULT_KEY),
        "dictionary": {
            "sampleCount": samples().len(),
            "maxBytes": 16 * 1024,
            "idHex": hex::encode(dictionary.id()),
            "bytesBase64": STANDARD.encode(dictionary.bytes()),
        },
        // The padding, as values. The object sizes below already depend on
        // these, but a bucket table is what makes a changed rule readable.
        "padme": padme_buckets,
        "objects": objects,
        "pack": {
            "items": bodies
                .iter()
                .map(|(id, plaintext)| json!({
                    "id": id,
                    "plaintextBase64": STANDARD.encode(plaintext),
                }))
                .collect::<Vec<_>>(),
            "sealedBytes": pack.bytes.len(),
            "sealedBase64": pack_bytes,
            "entries": pack
                .entries
                .iter()
                .map(|entry| json!({
                    "id": entry.id,
                    "offset": entry.offset,
                    "length": entry.length,
                }))
                .collect::<Vec<_>>(),
        },
        "list": {
            "plaintextBytes": list.plaintext_bytes,
            "partCount": list.parts.len(),
            "partSealedBytes": parts
                .iter()
                .map(|part| part.bytes.len())
                .collect::<Vec<_>>(),
        },
    })
}
