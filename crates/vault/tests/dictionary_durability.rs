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

use centraid_media::object::{self, Custody, Dictionary, Kind, Role};
use centraid_vault::backup::segment::GenerationId;
use centraid_vault::backup::{BaseRange, GenerationManifest, ObjectKeys, SegmentRef};

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

/// **A TRAINER THAT MOVED MUST NOT COST A MEMBER THEIR BACKUP.**
///
/// The generation is sealed by one build. A later build — a zstd bump, a DDL
/// edit, anything that moves what `Dictionary::train` produces — restores it.
/// Simulated by sealing against a dictionary trained on a *different* corpus
/// from the one this build ships, which is exactly what trainer drift is: the
/// bytes differ, so the id differs, so nothing sealed against the old id opens
/// against the new one.
///
/// The property under test is that the restore never consults this build's
/// trainer at all. It opens the manifest, reads the dictionary out of it, and
/// opens the segment against *that*.
///
/// On the base commit this fails: there is no way to seal a generation against
/// a dictionary other than the process-wide trained one, and no way to get one
/// back out of the backup.
#[test]
fn a_generation_opens_against_the_dictionary_its_manifest_carries() {
    // The dictionary a DIFFERENT build trained. Nothing in this build can
    // produce it, which is the point.
    let corpus: Vec<Vec<u8>> = (0..128_u32)
        .map(|row| {
            format!("CREATE TABLE other_shape_{row} (a TEXT, b TEXT, c INTEGER, d BLOB);")
                .into_bytes()
        })
        .collect();
    let refs: Vec<&[u8]> = corpus.iter().map(Vec::as_slice).collect();
    let theirs = Dictionary::train(&refs, 8 * 1024).expect("trains");

    let sealing = ObjectKeys::with_dictionary(VAULT, ROOT, theirs.clone());
    assert_ne!(
        sealing.dictionary().expect("has one").id(),
        keys().dictionary().expect("has one").id(),
        "the simulated drift did not move the id, so this test proves nothing"
    );

    let pages = b"core_entity rows and more core_entity rows".repeat(64);
    let segment = sealing
        .seal(Kind::Segment, Role::Whole, &pages)
        .expect("seals a segment");
    let (sealed_manifest, _) = manifest().seal(&sealing).expect("seals the manifest");

    // THE RESTORE STARTS HERE, holding only the two keys.
    let fresh = keys();
    let (_, recovered) = GenerationManifest::open_with_dictionary(&fresh, &sealed_manifest)
        .expect("the manifest opens with no dictionary in hand");
    assert_eq!(recovered.id(), theirs.id(), "the bytes came back changed");

    assert!(
        fresh.open(Kind::Segment, &segment.bytes).is_err(),
        "this build's trainer opened an object it was never sealed against"
    );
    assert_eq!(
        fresh
            .adopting(recovered)
            .open(Kind::Segment, &segment.bytes)
            .expect("the backup's own dictionary opens its own segment"),
        pages
    );
}

/// **THE GOLDEN VECTOR: THE SHIPPED DICTIONARY'S ID IS PINNED.**
///
/// `shipped_dictionary` trains from `migrations::BASELINE_SQL`, and zstd's
/// trainer makes no promise of stability across versions. A zstd bump or a DDL
/// edit that moves its output moves this id — which is a **format change**,
/// because the id is the name every `base` and `segment` header carries and
/// opening refuses any other.
///
/// Carrying the dictionary in the manifest means such a change no longer costs
/// anybody their old generations. It is still a change somebody should have
/// decided to make, so it fails here rather than being discovered by a restore
/// that produced larger objects for no stated reason.
///
/// **Moving this constant is the whole procedure** — there is nothing to
/// re-key. Move it deliberately, and say in the commit what moved the trainer.
#[test]
fn the_shipped_dictionarys_id_is_the_one_this_build_is_pinned_to() {
    const PINNED: &str = "84f64d4aa6ab33c496ffaec1ced1f7a6be84d62904de9a5fd9ef7a20f8b43bd9";
    let shipped = centraid_vault::backup::objects::shipped_dictionary()
        .expect("this build trains its own dictionary");
    assert_eq!(
        hex::encode(shipped.id()),
        PINNED,
        "the trained dictionary moved: zstd, the baseline DDL, or the sample \
         filter. Every object sealed against the old id still opens — the \
         manifest carries its dictionary — but this is a format change and it \
         is made on purpose, not noticed later"
    );
}
