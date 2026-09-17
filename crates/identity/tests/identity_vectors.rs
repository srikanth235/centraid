//! THE DERIVATION IS A FORMAT DECISION, PINNED AS BYTES (#1029 §0).
//!
//! A round-trip test cannot see a moved derivation: seal and open with the same
//! wrong path and everything passes. But a vault's identity public key **is**
//! its address, so a path, a domain tag or an index that moves does not produce
//! a bug — it produces a vault at a different address that every contact has
//! already linked. The vectors therefore live in
//! `contracts/crypto/identity-vectors.json` as bytes rather than as behaviour,
//! regenerated and diffed the way `contracts/crypto/blake3-vectors.json` is:
//! `CENTRAID_UPDATE_FIXTURES=1` writes the file and the comparison still runs
//! afterwards, so the variable is a generator and never a way to go green.
//!
//! ## THESE VECTORS ARE FREELY REGENERATED UNTIL FIRST RELEASE
//!
//! D-1020-R1 makes a format change a re-keying event proven against
//! `contracts/golden/format-golden.json`. It is **dropped pre-release**
//! (#1029, Reference A): nothing has shipped, so no vault exists whose address
//! a regeneration would move. Until the first release these are regression
//! vectors — they say "the derivation did not change by accident", not "the
//! derivation may never change". After the first release they become the second
//! thing, and this paragraph is what has to be deleted to say so.

use std::path::{Path, PathBuf};

use centraid_identity::{AccountKey, RecoveryPhrase, VaultMint};
use serde_json::{Value, json};

fn fixture_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../contracts/crypto/identity-vectors.json")
}

/// BIP39's own all-zero-entropy English vector. A published phrase rather than
/// one of ours, so the seed underneath these derivations is checkable against
/// BIP39 rather than only against this repository.
const PHRASE: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon \
     abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon \
     abandon abandon abandon art";

/// Vault indices worth pinning: the first, the second (so a sibling's
/// independence is a byte fact), and a sparse one (indices need not be dense).
const VAULT_INDICES: [u32; 3] = [0, 1, 4];

fn generated() -> Value {
    let phrase = RecoveryPhrase::parse(PHRASE).expect("the BIP39 vector parses");
    let seed = phrase.seed();

    let mut mint = VaultMint::fresh();
    let vaults: Vec<Value> = VAULT_INDICES
        .iter()
        .map(|index| {
            let keys = mint.mint(&seed, *index).expect("a fresh index");
            json!({
                "index": index,
                // The vault id and the address. If this value moves, every
                // contact who linked this vault is addressing a stranger.
                "identityPublicHex": hex::encode(keys.identity.public().to_bytes()),
                // Published beside the identity key; what a contact seals to.
                "boxPublicHex": hex::encode(keys.box_key.public().to_bytes()),
                // Never leaves the phone, so only the vectors can see it move.
                "rootKeyHex": hex::encode(keys.root.as_bytes()),
            })
        })
        .collect();

    json!({
        "schema": "centraid-identity-vectors/1",
        "why": "SLIP-0010 paths, domain tags and indices are format decisions (#1029 §0, W0.5-R1). A vault identity public key IS its address; a round trip cannot see it move, these bytes can.",
        "phrase": PHRASE,
        "seedHex": hex::encode(phrase.seed().as_bytes()),
        "accountPublicHex": hex::encode(AccountKey::derive(&seed).public().to_bytes()),
        "vaults": vaults,
    })
}

#[test]
fn the_committed_vectors_are_what_this_build_derives() {
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
        "contracts/crypto/identity-vectors.json is not what this build derives. \
         A derivation path, a domain tag or an index MOVED, which gives every vault \
         a new address — regenerate with CENTRAID_UPDATE_FIXTURES=1 only when that \
         is what you meant."
    );
}

/// The four leaves under one seed are four independent secrets, asserted as
/// values rather than as a property the derivation code happens to have.
#[test]
fn the_pinned_public_values_are_all_distinct() {
    let vectors = generated();
    let mut seen: Vec<String> = vec![
        vectors["accountPublicHex"]
            .as_str()
            .expect("hex")
            .to_owned(),
    ];
    for vault in vectors["vaults"].as_array().expect("vaults") {
        for field in ["identityPublicHex", "boxPublicHex", "rootKeyHex"] {
            seen.push(vault[field].as_str().expect("hex").to_owned());
        }
    }
    let unique: std::collections::BTreeSet<&String> = seen.iter().collect();
    assert_eq!(
        unique.len(),
        seen.len(),
        "two derivation paths produced one value"
    );
}
