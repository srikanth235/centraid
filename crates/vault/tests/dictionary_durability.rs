//! **THE DICTIONARY IS PART OF THE BACKUP** (#1029 W13, finding 3).
//!
//! Every `base` and `segment` object is zstd'd against a trained dictionary
//! whose BLAKE3 id its header names, and opening refuses any other dictionary.
//! The dictionary was trained per process from the compiled-in baseline DDL and
//! **stored nowhere**, so a zstd bump or a DDL edit that moved the trainer's
//! output moved the id, and every object sealed against the old one became
//! permanently unopenable — with no copy of the old bytes anywhere to open them
//! with.
//!
//! The case that makes it undeniable is the one the whole umbrella is about: a
//! phone restoring from 24 words holds a seed and a gateway full of ciphertext,
//! and has no vault to have kept a dictionary in. It must obtain the dictionary
//! **from the backup**.
//!
//! These are the two halves of that, and both fail on the base commit:
//!
//! 1. the manifest opens with the root key and **no dictionary at all**, which
//!    is the only way a restore can bootstrap;
//! 2. what it carries is the dictionary the generation was sealed against, so a
//!    build whose trainer has since moved still opens every object.

use centraid_media::object::{self, Custody};
use centraid_vault::backup::{BaseRange, GenerationManifest, ObjectKeys, SegmentRef};
use centraid_vault::backup::segment::GenerationId;

const VAULT: [u8; 32] = [0x31; 32];
const ROOT: [u8; 32] = [0x32; 32];

fn keys() -> ObjectKeys {
    ObjectKeys::new(VAULT, ROOT)
}

fn manifest() -> GenerationManifest {
    GenerationManifest {
        vault_id: keys().vault_id_hex(),
        generation: GenerationId::from_bytes([9; 16]),
        created_at: "2026-09-21T00:00:00.000Z".to_owned(),
        prev_manifest: None,
        base: vec![BaseRange {
            index: 0,
            offset: 0,
            length: 4096,
            plaintext_hash: hex::encode([0x11; 32]),
            object_name: hex::encode([0x22; 32]),
            object_bytes: 512,
            reused: false,
        }],
        base_txid: 3,
        base_plaintext_hash: hex::encode([0x33; 32]),
        base_file_bytes: 4096,
        base_census: vec![("core_entity".to_owned(), 2)],
        segments: vec![SegmentRef {
            object: hex::encode([0x44; 32]),
            first_txid: 4,
            last_txid: 7,
            bytes: 128,
            census: vec![("core_entity".to_owned(), 5)],
        }],
    }
}

/// **A PHONE RESTORING FROM 24 WORDS HOLDS NO DICTIONARY YET.**
///
/// It has the seed, and from the seed the vault identity key and the root key.
/// It has a gateway full of ciphertext. The manifest is the first object it
/// opens, and if opening that object already requires the dictionary then there
/// is no order in which a restore can succeed.
///
/// On the base commit this fails with `DictionaryRequired`: `Kind::Manifest`
/// compressed, so the manifest was sealed against the very thing the restore
/// was trying to find.
#[test]
fn a_manifest_opens_with_the_root_key_and_no_dictionary_at_all() {
    let (sealed, _) = manifest().seal(&keys()).expect("seals");
    let opened = object::open(
        object::VaultId::new(&VAULT),
        Custody::Wrapped(&ROOT),
        &sealed,
        None,
    );
    assert!(
        opened.is_ok(),
        "a restore cannot bootstrap: opening the manifest needs a dictionary \
         the phone does not have yet — {opened:?}"
    );
}
