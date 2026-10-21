//! THE YEAR-3 PHOTOS AXIS: 90,000 photographs, and what the port measures on
//! them (#1020, D-1020-P11; rebuilt on the new model, #1135).
//!
//! `centraid_apps_kit::fixtures::year3_photos` writes the profile [`YEAR3_PHOTOS`]
//! declares: 90,000 photographs and 3,000 near-duplicate families of three, with
//! every 250th trashed, every 500th archived, every 50th starred, 400 places, 40
//! albums of 50, and a burst every hundredth pair. Each number is a bound a read
//! was built to trip: the library window against a keyset cursor that shares its
//! timestamp in pairs, the 200-row trash shelf, and the duplicates read's
//! 4,000-fingerprint cap against 9,000 fingerprints.
//!
//! **The numbers are PROJECTED PROVENANCE** (D-1020-D3-7's pattern). They were
//! taken on `ci-linux-x64-4c` against a file-backed vault in a debug build with
//! `[profile.dev.package."*"] opt-level = 2`, so they are a **floor** on the real
//! cost; the receipt says so, and the device measurement is the owner's.
//!
//! The full axis is behind `--ignored`. The default run uses a shrunken shape
//! through the SAME statements, which is v0's own rule for the year-3 generator.

use std::sync::Arc;
use std::time::Instant;

use centraid_apps_kit::fixtures::{
    YEAR3_PHOTOS, Year3PhotosCounts, Year3PhotosShape, live_photo_count, photo_fingerprints,
    year3_photos,
};
use centraid_apps_kit::testdoor::TestDoor;
use centraid_apps_photos::duplicates::{CLUSTER_ROWS, Fingerprint, duplicate_clusters};
use centraid_apps_photos::queries::{LibraryInput, SHELF_ROWS, load_library};
use centraid_vault::Vault;
use centraid_vault::clock::{FixedClock, SeededIds};

/// The seed every year-3 run uses, so two runs produce byte-identical rows.
const SEED: u64 = 679_003;

/// A shrunken shape, through the same statements: one ninetieth of the
/// photographs and the same proportions. Every field is named on purpose.
const SMALL: Year3PhotosShape = Year3PhotosShape {
    assets: 1_000,
    trashed_every: 250,
    archived_every: 500,
    starred_every: 50,
    near_duplicate_families: 30,
    family_size: 3,
    places: 8,
    albums: 4,
    album_members: 10,
    burst_every: 20,
};

/// The instant the folds are read at: past the whole 2024-2026 span.
const NOW_MS: i64 = 4_083_987_600_000; // 2099-06-01T09:00:00.000Z

struct Seeded {
    dir: std::path::PathBuf,
    vault: Vault,
    counts: Year3PhotosCounts,
}

impl Drop for Seeded {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn seeded(shape: Year3PhotosShape) -> Seeded {
    let dir = centraid_ontology::scratch::scratch_dir();
    std::fs::create_dir_all(&dir).expect("a scratch directory");
    let vault = Vault::create_with(
        dir.join("vault.db"),
        Box::new(Arc::new(FixedClock::frozen())),
        Box::new(SeededIds::new("year3")),
    )
    .expect("a vault");
    vault.found("Year 3", "Owner").expect("founded");
    let counts = vault
        .commit(|tx| Ok(year3_photos(tx.connection(), shape, SEED).expect("seeded")))
        .expect("the corpus lands")
        .value;
    Seeded { dir, vault, counts }
}

fn read<T>(world: &Seeded, body: impl FnOnce(&TestDoor<'_>) -> T) -> T {
    world
        .vault
        .read(|connection| Ok(body(&TestDoor::new(connection))))
        .expect("a read")
}

/// The clustering the product runs: `centraid_media::duplicates::cluster`, so the
/// fixture is evidence for the code it is supposed to exercise.
fn media_cluster(prints: &[Fingerprint]) -> std::collections::BTreeMap<String, String> {
    let rows: Vec<centraid_media::duplicates::Fingerprint> = prints
        .iter()
        .map(|print| centraid_media::duplicates::Fingerprint {
            asset_id: print.photo_id.clone(),
            phash: print.phash.clone(),
            cluster_id: None,
        })
        .collect();
    centraid_media::duplicates::cluster(
        &rows,
        centraid_media::duplicates::DUPLICATE_HAMMING_THRESHOLD,
    )
}

#[test]
fn the_generator_writes_the_counts_it_declares() {
    let world = seeded(SMALL);
    let counts = world.counts;
    assert_eq!(counts.assets, SMALL.assets);
    assert_eq!(counts.trashed, SMALL.assets / SMALL.trashed_every);
    // Archived: the last of every 500.
    assert_eq!(counts.archived, SMALL.assets / SMALL.archived_every);
    assert_eq!(
        counts.live_assets,
        counts.assets - counts.trashed - counts.archived
    );
    assert_eq!(counts.starred, SMALL.assets / SMALL.starred_every);
    assert_eq!(counts.phashes, SMALL.assets);
    assert_eq!(counts.places, SMALL.places);
    assert_eq!(counts.album_entries, SMALL.albums * SMALL.album_members);
    let counted = world
        .vault
        .read(|connection| Ok(live_photo_count(connection).expect("counts")))
        .expect("a read");
    assert_eq!(
        usize::try_from(counted).expect("a count"),
        counts.live_assets
    );
}

#[test]
fn the_shrunken_axis_goes_through_the_same_statements() {
    let world = seeded(SMALL);
    let data = read(&world, |door| {
        load_library(door, &LibraryInput::default(), NOW_MS).expect("the library reads")
    });
    // The window FILLED: 1,000 photographs against a 500 window, so `truncated`
    // is the page's own cursor and not a row count.
    assert!(data.truncated, "older photographs exist beyond the window");
    assert!(data.tail.is_some());
    // The window is the newest 500; the trash, the archive and the folded
    // originals of a burst are taken out of it, so the shelf is shorter.
    assert!(!data.photos.is_empty() && data.photos.len() < 500);
    // The trash shelf is non-empty and bounded.
    assert_eq!(data.trash.len(), world.counts.trashed.min(SHELF_ROWS));
    // The album and place joins are real.
    assert_eq!(data.albums.len(), SMALL.albums);
    assert_eq!(data.places.len(), SMALL.places);
    assert!(data.photos.iter().any(|photo| photo.place.is_some()));
    assert!(data.photos.iter().any(|photo| photo.favorite));
    // A burst folds its older still: a burst is two photographs, and the library
    // draws at most one of them.
    let drawn: Vec<&str> = data
        .photos
        .iter()
        .filter_map(|photo| photo.photo.burst.as_deref())
        .collect();
    let distinct: std::collections::BTreeSet<&str> = drawn.iter().copied().collect();
    assert!(!drawn.is_empty(), "the window holds bursts");
    assert_eq!(
        drawn.len(),
        distinct.len(),
        "an older still of a burst is folded under its newer"
    );
}

/// THE CURSOR WALKS THE LIBRARY WITHOUT REPEATING A ROW.
///
/// This is the property the keyset pair exists for, and the shrunken axis is built
/// to trip it: two photographs share every `taken_at`, so a cursor on the
/// timestamp alone stops at a tie.
///
/// **A `taken_at` CURSOR CANNOT BE EXACT, AND THAT IS THE FINDING.** The app's
/// `before` is a bare timestamp, not the `(sort, pk)` pair the kit's page contract
/// insists on, so at a tie the page either repeats the tied row (`<=`) or drops it
/// (`<`). It drops: a photograph that shares its `taken_at` with the page's last
/// row is skipped. The walk therefore asserts what is TRUE: no row is seen twice,
/// and the rows that went missing are the tie partners of a page boundary plus the
/// older stills a burst folds. (The phone's own grid reads by keyset pair and has
/// no such gap; this is the app query's cursor.)
#[test]
fn a_cursor_walk_over_tied_capture_times_repeats_no_row_and_loses_at_most_a_tie_a_page() {
    let world = seeded(SMALL);
    let mut seen: Vec<String> = Vec::new();
    let mut before: Option<String> = None;
    let mut pages = 0_usize;
    // A stated bound on the walk itself: 1,000 photographs at 100 a page is ten
    // pages, and a walk that needed forty is a walk that is repeating.
    for _ in 0..40 {
        let data = read(&world, |door| {
            load_library(
                door,
                &LibraryInput {
                    limit: Some(100),
                    before: before.clone(),
                },
                NOW_MS,
            )
            .expect("the page reads")
        });
        if data.photos.is_empty() {
            break;
        }
        pages += 1;
        seen.extend(data.photos.iter().map(|photo| photo.photo.photo_id.clone()));
        let tail = data.tail.clone();
        if tail == before || tail.is_none() {
            break;
        }
        before = tail;
    }
    let mut unique = seen.clone();
    unique.sort();
    unique.dedup();
    assert_eq!(seen.len(), unique.len(), "no row was seen twice");
    let live = world
        .vault
        .read(|connection| Ok(live_photo_count(connection).expect("counts")))
        .expect("a read");
    let reached = i64::try_from(unique.len()).expect("a count");
    assert!(
        reached <= live,
        "the walk cannot reach more rows than exist"
    );
    let lost = live - reached;
    let bound = i64::try_from(pages + world.counts.bursts).expect("a count");
    assert!(
        lost <= bound,
        "the walk lost {lost} of {live} rows over {pages} pages and {} bursts, more than a \
         tie-per-boundary and the folded originals explain",
        world.counts.bursts
    );
}

/// THE CLUSTERS ARE THE FAMILIES, and nothing else: every cluster is one family,
/// and every family is one cluster.
#[test]
fn the_duplicates_are_the_seeded_families_and_no_photograph_crosses_one() {
    let world = seeded(SMALL);
    let clusters = read(&world, |door| {
        duplicate_clusters(door, media_cluster).expect("the duplicates read")
    });
    assert_eq!(clusters.len(), SMALL.near_duplicate_families);
    for cluster in &clusters {
        assert!(
            cluster.photos.len() >= 2,
            "a cluster of one is a photograph"
        );
        let families: std::collections::BTreeSet<usize> = cluster
            .photos
            .iter()
            .map(|photo| {
                let number: usize = photo
                    .photo_id
                    .strip_prefix("asset-")
                    .and_then(|n| n.parse().ok())
                    .expect("a seeded id");
                number / SMALL.family_size
            })
            .collect();
        assert_eq!(families.len(), 1, "{} crosses families", cluster.key);
    }
    // Only live photographs ride a card: a trashed member leaves a pair.
    let fingerprints = world
        .vault
        .read(|connection| Ok(photo_fingerprints(connection).expect("reads")))
        .expect("a read");
    assert_eq!(
        fingerprints.len(),
        world.counts.assets - world.counts.trashed,
        "a fingerprint is read for every live photograph"
    );
}

/// The measured numbers, at the FULL axis. Ignored by default; see the header.
///
/// ```text
/// cargo test -p centraid-apps-photos --test year3 -- --ignored --nocapture
/// ```
#[test]
#[ignore = "seeds 90,000 photographs; longer than the whole `local` gate budget"]
fn the_year3_photos_axis_measures_the_librarys_own_ceilings() {
    let started = Instant::now();
    let world = seeded(YEAR3_PHOTOS);
    eprintln!(
        "year3 photos: seeded {:?} in {:?}",
        world.counts,
        started.elapsed()
    );
    assert_eq!(world.counts.assets, YEAR3_PHOTOS.assets);

    let started = Instant::now();
    let data = read(&world, |door| {
        load_library(door, &LibraryInput::default(), NOW_MS).expect("the library reads")
    });
    eprintln!(
        "year3 photos: the library (500 window) folded {} rows + {} trashed in {:?}",
        data.photos.len(),
        data.trash.len(),
        started.elapsed()
    );
    assert!(data.truncated);
    assert!(data.photos.len() < 500);
    assert_eq!(data.trash.len(), SHELF_ROWS, "the trash shelf is bounded");

    let started = Instant::now();
    let wide = read(&world, |door| {
        load_library(
            door,
            &LibraryInput {
                limit: Some(2_000),
                before: None,
            },
            NOW_MS,
        )
        .expect("the library reads")
    });
    eprintln!(
        "year3 photos: the library (2,000 asked, one page served) folded {} rows in {:?}",
        wide.photos.len(),
        started.elapsed()
    );
    // THE DECLARED CEILING IS UNREACHABLE IN ONE READ (D-1020-P11): the library's
    // sort column is nullable, so a continued page over it is refused and the
    // window is one 500-row page. Asking for 2,000 measures the same page as
    // asking for 500, which is also what v0 measures; the number is here so the
    // receipt can say so with a figure and not a claim.
    assert_eq!(wide.window, 2_000, "the ASK is reported, not the clamp");
    assert_eq!(wide.photos.len(), data.photos.len(), "one page served");
    assert!(wide.truncated);

    let started = Instant::now();
    let clusters = read(&world, |door| {
        duplicate_clusters(door, media_cluster).expect("the duplicates read")
    });
    eprintln!(
        "year3 photos: duplicates clustered {} families from the first {CLUSTER_ROWS} fingerprints in {:?}",
        clusters.len(),
        started.elapsed()
    );
    // 9,000 fingerprints stand behind 3,000 families and the read takes 4,000, so
    // the review surface is cut at its cap rather than reporting every family.
    assert_eq!(clusters.len(), CLUSTER_ROWS / YEAR3_PHOTOS.family_size);
    assert!(clusters.len() < YEAR3_PHOTOS.near_duplicate_families);
}
