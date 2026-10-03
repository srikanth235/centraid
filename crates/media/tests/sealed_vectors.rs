//! `centraid-sealed/2`'s vectors — `contracts/crypto/sealed-vectors.json`
//! ([#1080](https://github.com/srikanth235/centraid/issues/1080)).
//!
//! ## HALF OF THIS FILE IS COMPARED AND HALF IS OPENED
//!
//! **Compared**: everything the format DETERMINES from a fixed root key — the
//! two derived keys, names for several `(h, i)`, their object keys, part
//! counts and lengths, an encoded header, and the sealed length of an
//! uncompressed payload at each chunk boundary. A context string, a field
//! order, the preimage layout or the framing that moved moves a value here.
//!
//! **Opened**: sealing draws random nonces, so the committed `sealedBase64`
//! samples cannot be reproduced and are instead decrypted under their names
//! and checked against their plaintext and their recorded digest. That pins the
//! READER against bytes this build did not just produce.
//!
//! `CENTRAID_UPDATE_FIXTURES=1` regenerates the file; the comparison runs
//! either way, so the variable is a generator and never a way to go green.
//! These are regression vectors: nothing a member holds was sealed before
//! #1080, so a deliberate format change regenerates them and says so.

use base64::{Engine, engine::general_purpose::STANDARD};
use centraid_media::sealed::{
    self, BackupKeys, CHUNK_BYTES, Digest, FORMAT_NAME, Header, Name, PART_BYTES, PlaintextHash,
};
use serde_json::{Value, json};

/// `00 01 02 … 1f`: a root nobody would mistake for a real one.
fn root() -> [u8; 32] {
    std::array::from_fn(|index| u8::try_from(index).expect("under 32"))
}

fn keys() -> BackupKeys {
    BackupKeys::from_root(&root())
}

fn fixture_path() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../contracts/crypto/sealed-vectors.json")
}

/// The samples whose sealed bytes are committed and opened.
fn samples() -> Vec<(&'static str, bool, Vec<u8>)> {
    vec![
        ("an empty file", false, Vec::new()),
        (
            "an original's bytes, uncompressed",
            false,
            b"\xff\xd8\xff\xe0 a photograph's first bytes".to_vec(),
        ),
        (
            "a database range, compressed",
            true,
            b"CREATE TABLE core_party (party_id TEXT PRIMARY KEY);\n".repeat(40),
        ),
        (
            "a snapshot manifest, compressed",
            true,
            br#"{"v":2,"ranges":[{"i":0,"len":4096}],"census":{"core_party":1}}"#.to_vec(),
        ),
    ]
}

#[test]
fn the_committed_sealed_vectors_open_and_are_what_this_build_derives() {
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
        eprintln!("regenerated the sealed vectors — run `bun run format` and commit them");
    }

    let committed: Value = serde_json::from_str(
        &std::fs::read_to_string(fixture_path()).expect("the vectors are readable"),
    )
    .expect("the vectors are JSON");

    assert_eq!(
        committed, regenerated,
        "contracts/crypto/sealed-vectors.json is not what this build derives. \
         Every field except `sealedBase64` is DETERMINED by the format — a \
         context string, the name preimage, the header layout or the framing \
         moved. Regenerate with CENTRAID_UPDATE_FIXTURES=1 when that is what you \
         meant, and say so in the receipt."
    );

    open_every_committed_sample(&committed);
}

/// The half a derivation cannot reach: the committed ciphertext still opens.
fn open_every_committed_sample(committed: &Value) {
    let keys = keys();
    let samples = committed["samples"].as_array().expect("samples");
    assert_eq!(samples.len(), 4, "every sample is committed");
    for sample in samples {
        let label = sample["label"].as_str().expect("a label");
        let name: Name = sample["name"]
            .as_str()
            .expect("a name")
            .parse()
            .expect("a name parses");
        let sealed = STANDARD
            .decode(sample["sealedBase64"].as_str().expect("sealed bytes"))
            .expect("base64");
        let plaintext = STANDARD
            .decode(sample["plaintextBase64"].as_str().expect("plaintext"))
            .expect("base64");
        let opened = sealed::open_part(&keys, &name, &sealed)
            .unwrap_or_else(|error| panic!("{label} no longer opens: {error}"));
        assert_eq!(opened.plaintext, plaintext, "{label}");
        assert_eq!(
            opened.header.compressed,
            sample["compressed"].as_bool().expect("a flag"),
            "{label}"
        );
        assert_eq!(
            Digest::of(&sealed).header_value(),
            sample["contentDigest"].as_str().expect("a digest"),
            "{label}"
        );
    }
}

fn hash_of(label: &str) -> PlaintextHash {
    PlaintextHash::of(format!("centraid sealed vector: {label}").as_bytes())
}

/// Recompute every determined field; carry the committed ciphertext through
/// unless asked to refresh it. A fresh seal every run would differ on every
/// invocation, which is the randomness working, not a drift.
fn generate(committed: &Value, refresh: bool) -> Value {
    let keys = keys();
    let mib = 1024 * 1024_u64;

    let names: Vec<Value> = [
        ("photo", 0_u32),
        ("photo", 1),
        ("video", 7),
        ("range", u32::MAX),
    ]
    .into_iter()
    .map(|(label, index)| {
        let h = hash_of(label);
        let name = sealed::name(&keys, &h, index);
        json!({
            "h": h.to_hex(),
            "partIndex": index,
            "name": name.to_hex(),
            "objectKey": hex::encode(sealed::object_key(&keys, &name)),
        })
    })
    .collect();

    let parts: Vec<Value> = [0, 1, 64 * mib - 1, 64 * mib, 64 * mib + 1, 200 * mib]
        .into_iter()
        .map(|len| {
            let count = sealed::part_count(len);
            json!({
                "fileLen": len,
                "parts": count,
                "lastPartLen": sealed::part_len(len, count - 1).expect("the last part"),
                "names": sealed::names_of(&keys, &hash_of("parts"), len)
                    .iter()
                    .map(Name::to_hex)
                    .collect::<Vec<_>>(),
            })
        })
        .collect();

    let header = Header::for_part(hash_of("header"), 200 * mib, 3, true).expect("a header");

    let framing: Vec<Value> = [0_usize, 1, CHUNK_BYTES, CHUNK_BYTES + 1]
        .into_iter()
        .map(|len| {
            let plaintext = vec![0x5a_u8; len];
            let h = PlaintextHash::of(&plaintext);
            let sealed =
                sealed::seal_part(&keys, &h, len as u64, 0, &plaintext, false).expect("seals");
            json!({ "payloadLen": len, "sealedLen": sealed.len() })
        })
        .collect();

    let committed_samples = committed["samples"].as_array();
    let samples: Vec<Value> = samples()
        .into_iter()
        .enumerate()
        .map(|(index, (label, compress, plaintext))| {
            let h = PlaintextHash::of(&plaintext);
            let name = sealed::name(&keys, &h, 0);
            let carried = committed_samples
                .and_then(|samples| samples.get(index))
                .filter(|sample| sample["name"] == json!(name.to_hex()) && !refresh)
                .and_then(|sample| sample["sealedBase64"].as_str())
                .and_then(|text| STANDARD.decode(text).ok());
            let sealed = carried.unwrap_or_else(|| {
                sealed::seal_part(&keys, &h, plaintext.len() as u64, 0, &plaintext, compress)
                    .expect("seals")
            });
            json!({
                "label": label,
                "compressed": compress,
                "plaintextBase64": STANDARD.encode(&plaintext),
                "h": h.to_hex(),
                "name": name.to_hex(),
                "contentDigest": Digest::of(&sealed).header_value(),
                "sealedBase64": STANDARD.encode(&sealed),
            })
        })
        .collect();

    json!({
        "format": FORMAT_NAME,
        "partBytes": PART_BYTES,
        "chunkBytes": CHUNK_BYTES,
        "root": hex::encode(root()),
        "kBackup": hex::encode(keys.k_backup()),
        "kName": hex::encode(keys.k_name()),
        "names": names,
        "parts": parts,
        "header": {
            "h": header.plaintext_hash.to_hex(),
            "fileLen": header.file_len,
            "partIndex": header.part_index,
            "partLen": header.part_len,
            "compressed": header.compressed,
            "hex": hex::encode(header.encode()),
        },
        "framing": framing,
        "samples": samples,
    })
}
