//! THE YEAR-3 PHOTOS AXIS: 90,000 photographs, and what the port measures on
//! them (#1020, D-1020-P11; rebuilt on the new model, #1135).
//!
//! `centraid_apps_kit::fixtures::year3_photos` writes the profile [`YEAR3_PHOTOS`]
//! declares: 90,000 photographs, with every 250th trashed, every 500th archived, every 50th starred, 400 places, 40
//! albums of 50, and a burst every hundredth pair. Each number is a bound a read
//! was built to trip: the library shelf walked by a cursor over capture times that
//! tie in pairs, the trash shelf, the collections and the places over the whole
//! library.
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
    YEAR3_50K_ASSETS, YEAR3_PHOTOS, Year3PhotosCounts, Year3PhotosShape, live_photo_count,
    year3_photos,
};
use centraid_apps_kit::testdoor::TestDoor;
use centraid_apps_photos::overview::load_albums;
use centraid_apps_photos::places::load_places;
use centraid_apps_photos::shelf::{Shelf, ShelfCursor, ShelfData, ShelfInput, load_shelf};
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

fn first_page(world: &Seeded, shelf: Shelf, limit: usize) -> ShelfData {
    read(world, |door| {
        load_shelf(
            door,
            &ShelfInput {
                shelf,
                limit,
                after: None,
            },
            NOW_MS,
        )
        .expect("the shelf reads")
    })
}

#[test]
fn the_shrunken_axis_goes_through_the_same_statements() {
    let world = seeded(SMALL);
    let live = first_page(&world, Shelf::Live, 120);
    // The library is bigger than a page, so the shelf says where the next one starts.
    assert_eq!(live.cells.len(), 120);
    assert!(live.next.is_some());
    // The total is exact: the live rows less the older still of every burst.
    let total = live.total.expect("the first page counts");
    let rows = world.counts.live_assets;
    assert!(
        total <= rows && rows - total <= world.counts.bursts,
        "{total} of {rows}"
    );
    // The trash shelf is every trashed photograph; the archive every archived one.
    let trash = first_page(&world, Shelf::Trash, 200);
    assert_eq!(trash.total, Some(world.counts.trashed));
    assert_eq!(
        first_page(&world, Shelf::Archive, 200).total,
        Some(world.counts.archived - archived_and_trashed(&world))
    );
    // The collections and the places are real.
    let albums = read(&world, |door| load_albums(door, NOW_MS).expect("reads"));
    assert_eq!(albums.albums.len(), SMALL.albums);
    assert_eq!(albums.live.count, total);
    assert_eq!(albums.trash.count, world.counts.trashed);
    let places = read(&world, |door| load_places(door, NOW_MS).expect("reads"));
    assert_eq!(places.places.len(), SMALL.places);
    assert!(live.cells.iter().any(|cell| cell.favorite));
    // A burst folds its older still: the library draws at most one photograph of a burst.
    let drawn: Vec<&str> = live
        .cells
        .iter()
        .filter_map(|cell| cell.burst.as_deref())
        .collect();
    let distinct: std::collections::BTreeSet<&str> = drawn.iter().copied().collect();
    assert_eq!(drawn.len(), distinct.len());
}

/// Photographs that are both archived and trashed, which the archive shelf leaves
/// to the trash.
fn archived_and_trashed(world: &Seeded) -> usize {
    let trash = first_page(world, Shelf::Trash, 200);
    let all = read(world, |door| {
        centraid_apps_kit::rules::Standing::read(door).expect("standing")
    });
    let mut count = 0;
    let mut page = trash;
    loop {
        count += page
            .cells
            .iter()
            .filter(|cell| all.is_archived(&cell.photo_id))
            .count();
        let Some(next) = page.next.clone() else {
            return count;
        };
        page = read(world, |door| {
            load_shelf(
                door,
                &ShelfInput {
                    shelf: Shelf::Trash,
                    limit: 200,
                    after: Some(next.clone()),
                },
                NOW_MS,
            )
            .expect("the shelf reads")
        });
    }
}

/// THE CURSOR WALKS THE LIBRARY WITHOUT REPEATING OR LOSING A ROW.
///
/// This is the property the keyset pair exists for, and the shrunken axis is built
/// to trip it: two photographs share every `taken_at`, so a cursor on the timestamp
/// alone stops at a tie. The shelf's cursor is the `(capture time, id)` pair carried
/// as a predicate, so a page boundary inside a tie loses nothing: the walk reaches
/// EVERY cell the exact total counts, once. (The `before` cursor of the retired
/// `library` query dropped the tie partner of every page boundary.)
#[test]
fn a_cursor_walk_over_tied_capture_times_repeats_no_row_and_loses_none() {
    let world = seeded(SMALL);
    let mut seen: Vec<String> = Vec::new();
    let mut after: Option<ShelfCursor> = None;
    let mut total = None;
    let mut pages = 0_usize;
    // A stated bound on the walk itself: 1,000 photographs at 100 a page is ten
    // pages, and a walk that needed forty is a walk that is repeating.
    for _ in 0..40 {
        let page = read(&world, |door| {
            load_shelf(
                door,
                &ShelfInput {
                    shelf: Shelf::Live,
                    limit: 100,
                    after: after.clone(),
                },
                NOW_MS,
            )
            .expect("the page reads")
        });
        pages += 1;
        total = total.or(page.total);
        seen.extend(page.cells.iter().map(|cell| cell.photo_id.clone()));
        match page.next {
            Some(next) => after = Some(next),
            None => break,
        }
    }
    let mut unique = seen.clone();
    unique.sort();
    unique.dedup();
    assert_eq!(seen.len(), unique.len(), "no row was seen twice");
    assert_eq!(
        Some(seen.len()),
        total,
        "every cell the total counts was reached"
    );
    assert!(pages <= 12, "{pages} pages for 1,000 photographs");
}

/// The measured numbers at one declared volume.
fn measure(label: &str, shape: Year3PhotosShape) {
    let started = Instant::now();
    let world = seeded(shape);
    eprintln!(
        "{label}: seeded {:?} in {:?}",
        world.counts,
        started.elapsed()
    );
    assert_eq!(world.counts.assets, shape.assets);

    let started = Instant::now();
    let live = first_page(&world, Shelf::Live, 120);
    eprintln!(
        "{label}: the library shelf (120 cells and the exact total {:?}) in {:?}",
        live.total,
        started.elapsed()
    );
    assert_eq!(live.cells.len(), 120);
    assert!(live.total.expect("a total") < world.counts.live_assets);

    let started = Instant::now();
    let trash = first_page(&world, Shelf::Trash, 200);
    eprintln!(
        "{label}: the trash shelf ({} cells of {:?}) in {:?}",
        trash.cells.len(),
        trash.total,
        started.elapsed()
    );
    assert_eq!(trash.total, Some(world.counts.trashed));

    let started = Instant::now();
    let albums = read(&world, |door| load_albums(door, NOW_MS).expect("reads"));
    eprintln!(
        "{label}: the collections ({} albums, {} live) in {:?}",
        albums.albums.len(),
        albums.live.count,
        started.elapsed()
    );
    assert_eq!(albums.albums.len(), shape.albums);

    let started = Instant::now();
    let places = read(&world, |door| load_places(door, NOW_MS).expect("reads"));
    eprintln!(
        "{label}: the places ({}) in {:?}",
        places.places.len(),
        started.elapsed()
    );
    assert_eq!(places.places.len(), shape.places);
}

/// THE `year3-photos` VOLUME: 90,000 photographs, 3,000 families. Ignored by
/// default; see the header.
///
/// ```text
/// cargo test -p centraid-apps-photos --test year3 -- --ignored --nocapture
/// ```
#[test]
#[ignore = "seeds 90,000 photographs; longer than the whole `local` gate budget"]
fn the_year3_photos_axis_measures_the_librarys_own_ceilings() {
    measure("year3 photos", YEAR3_PHOTOS);
}

/// THE `year3-50k-assets` VOLUME: the 50,000 a reference phone browses.
#[test]
#[ignore = "seeds 50,000 photographs; longer than the whole `local` gate budget"]
fn the_year3_50k_axis_measures_the_librarys_own_ceilings() {
    measure("year3 50k", YEAR3_50K_ASSETS);
}
