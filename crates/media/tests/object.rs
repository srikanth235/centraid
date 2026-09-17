//! `centraid-object/1`'s adversarial suite (#1029 §4).
//!
//! The unit tests beside the code prove the happy paths. These four prove the
//! properties the format exists for, and each one is named after the defect or
//! the ruling it stands in for:
//!
//! 1. **B9** — no nonce repeats, across retries *or across process restarts*.
//! 2. **F6** — 16 MiB holds for the worst input there is, and a bigger one
//!    becomes a list.
//! 3. **Packs** — an item opens from its range alone, and repacking preserves
//!    bytes while F8's seam is asked first.
//! 4. **Padmé** — neighbouring plaintext sizes produce identically sized
//!    objects, which is the whole of what the padding buys.

use std::collections::BTreeSet;
use std::process::Command;

use centraid_media::object::{
    self, Custody, Dictionary, Header, Kind, MAX_OBJECT_BYTES, MAX_PLAINTEXT_BYTES, NONCE_BYTES,
    ObjectName, Role, SealOptions,
};

const ROOT: [u8; 32] = [0x2a; 32];
const FILE_KEY: [u8; 32] = [0x5b; 32];

/// The env var that turns this test binary into a nonce probe for the restart
/// half of the B9 test. See [`no_nonce_repeats_across_retries_or_restarts`].
const PROBE: &str = "CENTRAID_OBJECT_NONCE_PROBE";

fn dictionary() -> Dictionary {
    let owned: Vec<Vec<u8>> = (0..128_u32)
        .map(|row| {
            format!("core_content_item|content_id={row}|content_uri=data:text/plain,{row}|")
                .into_bytes()
        })
        .collect();
    let refs: Vec<&[u8]> = owned.iter().map(Vec::as_slice).collect();
    Dictionary::train(&refs, 16 * 1024).expect("trains on page-shaped samples")
}

/// Deterministic incompressible bytes, from BLAKE3's XOF rather than the OS —
/// the point of this filler is that zstd cannot shrink it, not that it is
/// unpredictable, and 14 MiB from `/dev/urandom` per test run is a cost for
/// nothing.
fn incompressible(length: usize, seed: &[u8]) -> Vec<u8> {
    let mut out = vec![0_u8; length];
    blake3::Hasher::new()
        .update(seed)
        .finalize_xof()
        .fill(&mut out);
    out
}

/// Every nonce in one sealed object: the key wrap's, then each chunk's.
///
/// It walks the real bytes rather than asking the sealer, so a sealer that
/// stopped writing a nonce where the format says would fail here too.
fn nonces_of(sealed: &[u8]) -> Vec<[u8; NONCE_BYTES]> {
    let (header, body_at) = Header::decode(sealed).expect("a sealed object decodes");
    let mut found = Vec::new();
    if !header.wrapped_key.is_empty() {
        found.push(
            header.wrapped_key[..NONCE_BYTES]
                .try_into()
                .expect("wrap nonce"),
        );
    }
    let mut at = body_at;
    while at < sealed.len() {
        found.push(
            sealed[at..at + NONCE_BYTES]
                .try_into()
                .expect("chunk nonce"),
        );
        let length = u32::from_be_bytes(
            sealed[at + NONCE_BYTES..at + NONCE_BYTES + 4]
                .try_into()
                .expect("chunk length"),
        ) as usize;
        at += NONCE_BYTES + 4 + length;
    }
    assert_eq!(at, sealed.len(), "the chunk walk did not land on the end");
    found
}

fn seal_one(plaintext: &[u8]) -> Vec<u8> {
    object::seal(
        Custody::Wrapped(&ROOT),
        &SealOptions {
            kind: Kind::Blob,
            role: Role::Original,
            dictionary: None,
        },
        plaintext,
    )
    .expect("seals")
    .bytes
}

// ------------------------------------------------------------------- B9 ----

/// **B9: no nonce is reused under any key.**
///
/// The old stack derived its AEAD nonce from a keyed MAC over the object's
/// address, which is safe only if one address always maps to one set of bytes.
/// It did not, so the same nonce was written twice under one key.
///
/// The in-process half seals **the same plaintext** many times — the retry case,
/// which is exactly where a derived nonce repeats and a random one does not.
/// The restart half re-runs this test binary as a child process and asserts its
/// nonces are disjoint from this one's: a generator seeded once per process
/// would pass the first half and fail the second, and that is the whole reason
/// the second half exists rather than being asserted in prose.
#[test]
fn no_nonce_repeats_across_retries_or_restarts() {
    let mut seen: BTreeSet<[u8; NONCE_BYTES]> = BTreeSet::new();
    let mut count = 0_usize;
    for _ in 0..256 {
        for nonce in nonces_of(&seal_one(b"the same plaintext, sealed again")) {
            count += 1;
            assert!(seen.insert(nonce), "a nonce repeated within one process");
        }
    }
    assert!(count >= 512, "only {count} nonces were drawn");

    // The same plaintext under the same key is a DIFFERENT object every time,
    // which is the observable consequence of the above.
    assert_ne!(
        ObjectName::of(&seal_one(b"the same plaintext, sealed again")),
        ObjectName::of(&seal_one(b"the same plaintext, sealed again")),
    );

    let output = Command::new(std::env::current_exe().expect("this test binary"))
        .args(["nonce_probe", "--exact", "--nocapture", "--test-threads=1"])
        .env(PROBE, "1")
        .output()
        .expect("the probe runs");
    assert!(output.status.success(), "the probe failed: {output:?}");
    let text = String::from_utf8(output.stdout).expect("the probe prints UTF-8");
    // `split`, not `strip_prefix`: with `--nocapture` the harness writes
    // "test nonce_probe ... " with no newline, so the first nonce shares a line
    // with it.
    let from_the_child: Vec<&str> = text
        .lines()
        .filter_map(|line| line.split("NONCE ").nth(1))
        .collect();
    assert!(
        from_the_child.len() >= 16,
        "the probe printed {} nonces, so it did not run",
        from_the_child.len()
    );
    for nonce in from_the_child {
        let raw: [u8; NONCE_BYTES] = hex::decode(nonce)
            .expect("hex")
            .try_into()
            .expect("a nonce is 24 bytes");
        assert!(
            !seen.contains(&raw),
            "a fresh process drew a nonce this one had already used"
        );
    }
}

/// The child half of [`no_nonce_repeats_across_retries_or_restarts`]. Inert
/// unless the parent sets [`PROBE`], so a plain `cargo test` run costs nothing.
#[test]
fn nonce_probe() {
    if std::env::var_os(PROBE).is_none() {
        return;
    }
    for _ in 0..8 {
        for nonce in nonces_of(&seal_one(b"the same plaintext, sealed again")) {
            println!("NONCE {}", hex::encode(nonce));
        }
    }
}

// ------------------------------------------------------------------- F6 ----

/// **F6: 16 MiB, and the headroom is measured rather than assumed.**
///
/// The worst input for the cap is a *compressing* kind holding bytes zstd cannot
/// shrink: the payload comes out slightly larger than the plaintext, and Padmé
/// then rounds that up. If this passes, no smaller or more compressible input
/// can fail.
#[test]
fn the_cap_holds_for_the_worst_case_input() {
    let dictionary = dictionary();
    let plain = incompressible(MAX_PLAINTEXT_BYTES, b"the worst case");
    let sealed = object::seal(
        Custody::Wrapped(&ROOT),
        &SealOptions {
            kind: Kind::Base,
            role: Role::Whole,
            dictionary: Some(&dictionary),
        },
        &plain,
    )
    .expect("the cap's own worst case seals");
    assert!(
        sealed.bytes.len() <= MAX_OBJECT_BYTES,
        "{} bytes exceeds the {MAX_OBJECT_BYTES}-byte cap",
        sealed.bytes.len()
    );
    assert!(
        sealed.bytes.len() > MAX_PLAINTEXT_BYTES,
        "the filler compressed, so this did not test the worst case"
    );
    assert_eq!(
        object::open(Custody::Wrapped(&ROOT), &sealed.bytes, Some(&dictionary)).expect("opens"),
        plain
    );
}

/// **F6: resumability comes from the list, not from multipart.**
#[test]
fn an_oversized_input_becomes_a_list_of_objects() {
    let plain = incompressible(MAX_PLAINTEXT_BYTES * 2 + 1024, b"a long video");
    let options = SealOptions {
        kind: Kind::Blob,
        role: Role::Original,
        dictionary: None,
    };
    let (parts, list) =
        object::seal_list(Custody::FileKey(&FILE_KEY), &options, &plain).expect("splits");
    assert_eq!(parts.len(), 3, "14 MiB parts over a 28 MiB + 1 KiB input");
    assert_eq!(list.parts.len(), 3);
    assert_eq!(list.plaintext_bytes, plain.len() as u64);
    for part in &parts {
        assert!(part.bytes.len() <= MAX_OBJECT_BYTES);
    }

    let bytes: Vec<&[u8]> = parts.iter().map(|part| part.bytes.as_slice()).collect();
    assert_eq!(
        object::open_list(Custody::FileKey(&FILE_KEY), &list, &bytes, None).expect("reassembles"),
        plain
    );

    // Order is the whole of the structure, so a swapped pair is caught by the
    // list and not by luck.
    let swapped: Vec<&[u8]> = vec![bytes[1], bytes[0], bytes[2]];
    assert!(object::open_list(Custody::FileKey(&FILE_KEY), &list, &swapped, None).is_err());

    // An input that already fits is a one-part list, so no caller branches on
    // size.
    let (_, small) =
        object::seal_list(Custody::FileKey(&FILE_KEY), &options, b"one part").expect("splits");
    assert_eq!(small.parts.len(), 1);
}

// ---------------------------------------------------------------- packs ----

/// **A pack is addressable by range**, and a header cannot be transplanted
/// between two items of the same kind.
#[test]
fn a_pack_is_addressable_by_range_and_its_headers_do_not_transplant() {
    let bodies: Vec<(String, Vec<u8>)> = (0..32_u32)
        .map(|index| {
            (
                format!("thumb-{index}"),
                incompressible(4096, &index.to_be_bytes()),
            )
        })
        .collect();
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
    let pack = object::pack::build(&ROOT, &items, None).expect("packs");
    assert!(pack.bytes.len() <= object::pack::MAX_PACK_BYTES);

    // The read path a restored phone uses: one row, one byte range, no table.
    for (entry, (_, expected)) in pack.entries.iter().zip(&bodies) {
        let range = &pack.bytes[entry.offset as usize..(entry.offset + entry.length) as usize];
        assert_eq!(
            object::open(Custody::FileKey(&FILE_KEY), range, None).expect("opens from its range"),
            *expected
        );
    }

    // Two items of the same kind and role. Gluing one's header onto the other's
    // body is what the per-chunk AAD refuses.
    let first = &pack.bytes[pack.entries[0].offset as usize..][..pack.entries[0].length as usize];
    let second = &pack.bytes[pack.entries[1].offset as usize..][..pack.entries[1].length as usize];
    let (_, first_body_at) = Header::decode(first).expect("decodes");
    let (_, second_body_at) = Header::decode(second).expect("decodes");
    let mut transplanted = first[..first_body_at].to_vec();
    transplanted.extend_from_slice(&second[second_body_at..]);
    assert!(
        object::open(Custody::FileKey(&FILE_KEY), &transplanted, None).is_err(),
        "a header transplanted onto another item's body opened"
    );

    // And the table rebuilds exactly the rows the vault holds.
    assert_eq!(
        object::pack::read_table(&ROOT, &pack.bytes, None).expect("reads the table"),
        pack.entries
    );

    // F8's seam is asked before any byte is copied.
    let live: BTreeSet<String> = bodies.iter().take(4).map(|(id, _)| id.clone()).collect();
    assert!(object::pack::should_repack(&pack.entries, &live));
    let repacked = object::pack::repack(
        &ROOT,
        &pack.bytes,
        &pack.entries,
        &live,
        &object::pack::NoLiveShares,
        None,
    )
    .expect("repacks");
    assert_eq!(repacked.entries.len(), 4);
    assert!(repacked.bytes.len() < pack.bytes.len());
    assert_eq!(
        object::open(
            Custody::FileKey(&FILE_KEY),
            &repacked.bytes[repacked.entries[3].offset as usize..]
                [..repacked.entries[3].length as usize],
            None
        )
        .expect("opens after repacking"),
        bodies[3].1,
        "repacking re-encrypted an item it was supposed to copy"
    );
}

// ---------------------------------------------------------------- Padmé ----

/// **Padmé: neighbouring plaintext sizes produce identically sized objects.**
///
/// The assertion is on the sealed length, not on `padme()` — the arithmetic is
/// unit-tested next to the function, and what matters here is that nothing
/// downstream of it leaks the exact length back out.
#[test]
fn padme_collapses_neighbouring_sizes_onto_one_object_size() {
    let options = SealOptions {
        kind: Kind::Thumbnail,
        role: Role::Thumbnail,
        dictionary: None,
    };
    let sealed_length = |length: usize| {
        object::seal(
            Custody::FileKey(&FILE_KEY),
            &options,
            &incompressible(length, b"padme"),
        )
        .expect("seals")
        .bytes
        .len()
    };

    // 1001 and 1004 bytes are different photographs and the same object size.
    assert_eq!(sealed_length(1001), sealed_length(1004));

    // A whole bucket collapses, not just a lucky pair: every length from 4 KiB
    // to 4 300 bytes seals to one size.
    let bucket = sealed_length(4096);
    for length in (4096..=4300).step_by(37) {
        assert_eq!(sealed_length(length), bucket, "{length} left the bucket");
    }

    // And the bound it claims: never more than ~12% over plus the fixed framing,
    // so the padding is a cost somebody can budget for rather than an open-ended
    // one.
    for length in [100_000, 1_000_000] {
        let sealed = sealed_length(length);
        assert!(sealed >= length, "{length} sealed to {sealed}");
        assert!(
            (sealed - length) * 100 <= length * 12 + 25_600,
            "{length} → {sealed} is more than Padmé's bound plus the fixed framing"
        );
    }
}
