//! **A RESTORED PHONE SHOWS A COMPLETE THUMBNAIL GRID BEFORE IT DOWNLOADS A
//! SINGLE ORIGINAL** (#1029 §4, §5, F6, F14).
//!
//! The acceptance criterion this file exists for, in its own words: *a 100k-
//! thumbnail library restores in a number of requests proportional to **packs,
//! not thumbnails***. A test at a hundred items would pass whether that is true
//! or not — 100 requests and 1 request are both small — so the scale is the
//! test, and it is run at the number the criterion names.
//!
//! ## WHAT EACH TEST HERE PROVES, AND WHY IT IS SPLIT IN THREE
//!
//! 1. [`a_hundred_thousand_thumbnails_cost_packs_and_not_thumbnails`] — the
//!    REQUEST COUNT, over a hundred thousand real custody rows laid out across
//!    real packs. The number `grid_fetches` answers is the number of GETs the
//!    grid costs, and it is four orders of magnitude below the item count.
//! 2. [`every_thumbnail_in_a_real_pack_opens_from_the_range_the_vault_recorded`]
//!    — that the ranges those rows carry are **true of the bytes**. A plan with
//!    the right shape over wrong offsets is a grid of broken cells.
//! 3. [`the_grid_is_complete_before_a_single_original_is_fetched`] — the
//!    ORDERING. Originals have their own custody rows and their own placements,
//!    and none of them is in the grid's plan.
//!
//! ## WHY THE PLAN IS A PURE FUNCTION AND THERE IS NO SERVER HERE
//!
//! `backup::custody::grid_fetches` takes rows and answers fetches. It has no
//! store, no socket and no SQL, so the request count is a property of the vault's
//! own index rather than of a transport — which is exactly why it can be
//! asserted at a hundred thousand in a unit test instead of being measured
//! against a gateway that would have to hold a gigabyte to say the same thing.

use centraid_media::object::{self, Custody as ObjectCustody, Kind, Role};
use centraid_vault::backup::custody::{
    self, Admission, BlobRole, Custody, FileKey, Placement, grid_fetches,
};
use centraid_vault::file::Vault;

/// The vault every object here is sealed for — §4's AAD binding.
const VAULT_KEY: [u8; 32] = [0x51; 32];
const ROOT: [u8; 32] = [0x52; 32];

/// The number the acceptance criteria name.
const LIBRARY: usize = 100_000;

/// A thumbnail's plaintext, in bytes. A grid-resolution thumbnail is one to
/// three kilobytes; 1 KiB is at the SMALL end, which packs MORE items per pack
/// and so makes the assertion below harder rather than easier — a real library
/// of larger thumbnails needs more packs, not fewer, and is still nowhere near
/// one request per item.
const THUMBNAIL_BYTES: usize = 1024;

fn vault_id() -> object::VaultId<'static> {
    object::VaultId::new(&VAULT_KEY)
}

fn thumbnail(index: usize) -> Vec<u8> {
    // Distinct per item, so an item opened from the wrong range is caught by
    // its contents and not only by its length.
    let mut bytes = vec![0_u8; THUMBNAIL_BYTES];
    bytes[..8].copy_from_slice(&(index as u64).to_be_bytes());
    for (at, byte) in bytes.iter_mut().enumerate().skip(8) {
        *byte = (at as u8).wrapping_mul(31).wrapping_add(index as u8);
    }
    bytes
}

/// Pack a whole library, keeping **one pack's bytes at a time** in memory.
///
/// A hundred thousand thumbnails is a hundred megabytes of plaintext, which a
/// test must not hold at once any more than a phone must. Each batch is
/// generated, packed, reduced to its rows and dropped; what survives is the
/// custody rows, which is what a restore has too.
fn pack_library(items: usize, keep_first_pack: bool) -> (Vec<Custody>, usize, Option<Vec<u8>>) {
    // How many items fit a 16 MiB pack, measured once from a real seal rather
    // than estimated — the sealed size is header, framing, tag and Padmé, and
    // an estimate that ran over would make every batch overflow into a second
    // pack and quietly double the count this test is asserting.
    let probe = object::seal(
        vault_id(),
        ObjectCustody::FileKey(&[1_u8; 32]),
        &object::SealOptions {
            kind: Kind::Thumbnail,
            role: Role::Thumbnail,
            dictionary: None,
        },
        &thumbnail(0),
    )
    .expect("seals");
    // Leave room for the item table and the trailer; `build_all` is the one
    // that decides, and this only has to keep a batch from spilling.
    let per_pack = (object::pack::MAX_PACK_BYTES - 1024 * 1024) / probe.bytes.len();

    let mut rows: Vec<Custody> = Vec::with_capacity(items);
    let mut packs = 0_usize;
    let mut first_pack = None;

    let mut at = 0_usize;
    while at < items {
        let batch = per_pack.min(items - at);
        let bodies: Vec<(String, Vec<u8>, FileKey)> = (at..at + batch)
            .map(|index| {
                (
                    format!("thumb-{index:07}"),
                    thumbnail(index),
                    FileKey::fresh().expect("draws"),
                )
            })
            .collect();
        let pack_items: Vec<object::pack::PackItem<'_>> = bodies
            .iter()
            .map(|(id, plaintext, key)| object::pack::PackItem {
                id,
                custody: key.custody(),
                kind: Kind::Thumbnail,
                role: Role::Thumbnail,
                plaintext,
            })
            .collect();

        let built = object::pack::build_all(vault_id(), &ROOT, &pack_items, None).expect("packs");
        assert_eq!(built.len(), 1, "a batch was sized to overflow its own pack");
        let pack = built.into_iter().next().expect("one pack");
        packs += 1;

        for (entry, (_, plaintext, key)) in pack.entries.iter().zip(&bodies) {
            rows.push(Custody {
                // The plaintext hash: the dedup key, which never leaves here.
                plaintext_hash: hex::encode(blake3::hash(plaintext).as_bytes()),
                file_key: *key,
                plaintext_bytes: plaintext.len() as u64,
                role: BlobRole::Thumbnail,
                placements: vec![Placement {
                    part_index: 0,
                    object_name: pack.name.hex(),
                    byte_offset: entry.offset,
                    byte_length: entry.length,
                }],
            });
        }
        if keep_first_pack && first_pack.is_none() {
            first_pack = Some(pack.bytes);
        }
        at += batch;
    }
    (rows, packs, first_pack)
}

/// **THE ACCEPTANCE CRITERION.** A hundred thousand thumbnails, and the grid
/// costs the number of PACKS.
#[test]
fn a_hundred_thousand_thumbnails_cost_packs_and_not_thumbnails() {
    let (rows, packs, _) = pack_library(LIBRARY, false);
    assert_eq!(rows.len(), LIBRARY);

    let fetches = grid_fetches(&rows);

    assert_eq!(
        fetches.len(),
        packs,
        "the grid costs {} requests for {packs} packs — the plan is per item, \
         not per pack",
        fetches.len()
    );
    assert!(
        fetches.len() * 100 < LIBRARY,
        "{} requests for {LIBRARY} thumbnails is not proportional to packs",
        fetches.len()
    );
    // Every thumbnail is in exactly one fetch: a grid that is cheap and
    // incomplete is not a grid.
    let planned: usize = fetches.iter().map(|fetch| fetch.items.len()).sum();
    assert_eq!(planned, LIBRARY, "the plan lost or duplicated an item");

    let names: std::collections::BTreeSet<&str> = fetches
        .iter()
        .map(|fetch| fetch.object_name.as_str())
        .collect();
    assert_eq!(names.len(), fetches.len(), "an object is fetched twice");

    eprintln!(
        "restore grid: {LIBRARY} thumbnails of {THUMBNAIL_BYTES} B in {packs} packs \
         = {} requests",
        fetches.len()
    );
}

/// The ranges those rows carry are true **of the bytes**. Opened out of a real
/// pack, by the range only, with no item table read.
#[test]
fn every_thumbnail_in_a_real_pack_opens_from_the_range_the_vault_recorded() {
    // One pack's worth. The bytes are what is being checked, so this is the
    // test that holds real ones.
    let (rows, packs, pack_bytes) = pack_library(2000, true);
    assert_eq!(packs, 1, "two thousand thumbnails is one pack");
    let bytes = pack_bytes.expect("the first pack's bytes");

    let fetches = grid_fetches(&rows);
    assert_eq!(fetches.len(), 1);

    for (hash, placement) in &fetches[0].items {
        let held = rows
            .iter()
            .find(|row| &row.plaintext_hash == hash)
            .expect("a planned item has a row");
        let opened = object::pack::open_range(
            vault_id(),
            held.file_key.custody(),
            &bytes,
            &object::pack::PackEntry {
                id: String::new(),
                name: object::ObjectName::of(
                    &bytes[placement.byte_offset as usize
                        ..(placement.byte_offset + placement.byte_length) as usize],
                ),
                offset: placement.byte_offset,
                length: placement.byte_length,
            },
            None,
        )
        .expect("a thumbnail opens from its recorded range");
        assert_eq!(
            hex::encode(blake3::hash(&opened).as_bytes()),
            *hash,
            "the bytes at the recorded range are not this thumbnail"
        );
    }

    // And the whole span of the pack is covered by the items plus its table.
    let (first, last) = fetches[0].byte_span();
    assert_eq!(first, 0);
    assert!(last < bytes.len() as u64, "the items run past the pack");
}

/// **THE ORDERING.** The grid is planned from thumbnails alone; not one
/// original is in it. F14's "originals on demand" is not a policy a caller
/// remembers — it is what the plan contains.
#[test]
fn the_grid_is_complete_before_a_single_original_is_fetched() {
    let dir = tempfile::tempdir().expect("a directory");
    let vault = Vault::create(dir.path().join("vault.db")).expect("creates");

    // Twenty photographs: each one an original and its thumbnail, both admitted
    // and both placed, exactly as a backup would leave them.
    let mut original_objects = Vec::new();
    for index in 0..20_u8 {
        let original = hex::encode([index; 32]);
        let thumb = hex::encode([index.wrapping_add(128); 32]);
        assert!(matches!(
            custody::admit(&vault, &original, 4_000_000, BlobRole::Original).expect("admits"),
            Admission::Fresh(_)
        ));
        assert!(matches!(
            custody::admit(&vault, &thumb, 2048, BlobRole::Thumbnail).expect("admits"),
            Admission::Fresh(_)
        ));
        let original_object = hex::encode([index.wrapping_add(64); 32]);
        custody::record_placements(
            &vault,
            &original,
            &[Placement {
                part_index: 0,
                object_name: original_object.clone(),
                byte_offset: 0,
                byte_length: 4_000_000,
            }],
        )
        .expect("records");
        custody::record_placements(
            &vault,
            &thumb,
            &[Placement {
                part_index: 0,
                object_name: hex::encode([200_u8; 32]),
                byte_offset: u64::from(index) * 2048,
                byte_length: 2048,
            }],
        )
        .expect("records");
        original_objects.push(original_object);
    }

    let thumbnails = custody::thumbnails(&vault).expect("reads the thumbnails");
    assert_eq!(thumbnails.len(), 20, "every thumbnail is in the grid");

    let grid = grid_fetches(&thumbnails);
    assert_eq!(
        grid.len(),
        1,
        "twenty thumbnails in one pack is one request"
    );
    assert_eq!(grid[0].items.len(), 20, "the grid is COMPLETE");

    // Not one original object is named by the grid's plan.
    for original_object in &original_objects {
        assert!(
            !grid
                .iter()
                .any(|fetch| &fetch.object_name == original_object),
            "the grid's plan fetches an original"
        );
    }

    // The originals are known, with their own rows and their own ranges — they
    // are fetched ON DEMAND (F14), by the same plan, when a member opens one.
    let originals = custody::originals(&vault).expect("reads the originals");
    assert_eq!(originals.len(), 20);
    let on_demand = grid_fetches(&originals[..1]);
    assert_eq!(on_demand.len(), 1, "one original is one request");
}
