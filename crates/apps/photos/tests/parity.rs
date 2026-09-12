//! THE PORT, READ BACK THROUGH THE REAL DOOR.
//!
//! Two halves, and the second one is the one that matters:
//!
//! 1. **The sample coupling** (census seam A3): every shipped frame is at or
//!    under `THUMB_EDGE` on its long edge, asserted against the committed
//!    manifest that recorded it. Nothing on either side tested this before.
//! 2. **The eight queries**, folded over a vault seeded by
//!    `centraid_apps_kit::fixtures::photos_demo` — v0's own nineteen-frame
//!    roll, transcribed as data — inside a database created from
//!    `contracts/schema/vault-ddl.sql`, read through the kit's test door.
//!
//! **What is NOT here, and why it is not a skipped test.**
//! `contracts/apps/photos/queries.json` — v0's own answers at fixed inputs —
//! is not committed, because generating it needs `bun run build` and the v0
//! handler graph, and this machine had 2.6 GB of disk left when the lane ran
//! (`df -h /home/user`). The generator is committed and unrun
//! (`contracts/tools/export-photos-parity.ts`), the exact regeneration command
//! is in `contracts/apps/photos/README.md`, and
//! `the_fixture_bundle_is_declared_pending_and_says_so_out_loud` below asserts
//! the manifest SAYS it is pending — so the state cannot be mistaken for
//! parity by anybody reading a green suite. When the bundle lands, that test
//! flips to a comparison and the declaration comes out of the manifest.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use centraid_apps_kit::contract_vault::open_contract_vault;
use centraid_apps_kit::fixtures::{
    DEMO_ALBUM_FILES, DEMO_ALBUM_TITLE, DEMO_FACE_PEOPLE, DEMO_ROLL, SampleFrame, THUMB_EDGE,
    photos_demo,
};
use centraid_apps_kit::testdoor::TestDoor;
use centraid_apps_photos::duplicates::duplicate_clusters;
use centraid_apps_photos::enrichment::{Tier, enrichment_status};
use centraid_apps_photos::faces::{asset_faces, face_queue, people_roster};
use centraid_apps_photos::places::{NamedPlace, PhraseContext, PhraseInput, place_phrase};
use centraid_apps_photos::queries::{LibraryInput, load_library, load_search};
use centraid_apps_photos::storage::{Totals, storage_summary};
use centraid_apps_photos::{Reading, manifest};
use rusqlite::Connection;

/// The repository root, from this crate's manifest directory.
fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .to_path_buf()
}

fn read_json(relative: &str) -> serde_json::Value {
    let path = root().join(relative);
    let text = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("{} is not readable: {error}", path.display()));
    serde_json::from_str(&text)
        .unwrap_or_else(|error| panic!("{} is not JSON: {error}", path.display()))
}

/// The sample manifest, as `SampleFrame` facts.
///
/// The strings are leaked because `SampleFrame` holds `&'static str` — the
/// generator's frames are compile-time data in real use, and a test that reads
/// them off disk is the one caller that has to bridge.
fn samples() -> Vec<SampleFrame> {
    let manifest = read_json("contracts/apps/photos/sample/manifest.json");
    manifest["files"]
        .as_array()
        .expect("the manifest lists its files")
        .iter()
        .map(|entry| SampleFrame {
            file: Box::leak(
                entry["file"]
                    .as_str()
                    .expect("a file name")
                    .to_owned()
                    .into_boxed_str(),
            ),
            width: u32::try_from(entry["width"].as_u64().expect("a width")).expect("a width"),
            height: u32::try_from(entry["height"].as_u64().expect("a height")).expect("a height"),
            byte_size: entry["byte_size"].as_i64().expect("a byte size"),
            sha256: Box::leak(
                entry["sha256"]
                    .as_str()
                    .expect("a digest")
                    .to_owned()
                    .into_boxed_str(),
            ),
        })
        .collect()
}

/// A vault carrying the committed schema and the demo roll.
fn seeded() -> Connection {
    let ddl = fs::read_to_string(root().join("contracts/schema/vault-ddl.sql"))
        .expect("the committed DDL is readable");
    let connection = open_contract_vault(&ddl, "[]").expect("the schema replays");
    connection
        .execute(
            "INSERT INTO core_party (party_id, kind, display_name, created_at)
             VALUES ('demo-owner', 'person', 'Priya', '2026-03-15T00:00:00.000Z')",
            [],
        )
        .expect("the owner lands");
    let counts = photos_demo(&connection, &samples(), "2026-03-15", "demo-owner")
        .expect("the demo roll seeds");
    assert_eq!(counts.assets, 19, "v0's seed writes nineteen assets");
    assert_eq!(counts.faces, 8, "eight face proposals across seven frames");
    assert_eq!(counts.favorites, 2);
    assert_eq!(counts.album_members, 4);
    assert_eq!(counts.people, 2);
    connection
}

// ---------------------------------------------------------------------------
// 1. THE SAMPLE COUPLING (census seam A3).
// ---------------------------------------------------------------------------

/// **THE TEST THE COUPLING NEVER HAD.** v0's seed ties its image dimensions to
/// a renderer constant in a comment; this fails if any shipped frame grows past
/// it, on either side.
#[test]
fn every_shipped_sample_is_small_enough_for_the_grid_to_paint_directly() {
    let manifest = read_json("contracts/apps/photos/sample/manifest.json");
    assert_eq!(
        manifest["thumbEdge"].as_u64(),
        Some(u64::from(THUMB_EDGE)),
        "the manifest and the port disagree about THUMB_EDGE"
    );
    let frames = samples();
    assert_eq!(
        frames.len(),
        19,
        "eighteen PNGs ship beside the seed, plus the one inline video payload"
    );
    for frame in &frames {
        assert!(
            frame.paints_as_thumb(),
            "{} is {}x{} — {} px on its long edge, past THUMB_EDGE {THUMB_EDGE}, so the grid \
             would probe a ?variant=thumb derivative the preview backstop has not generated",
            frame.file,
            frame.width,
            frame.height,
            frame.long_edge()
        );
    }
    // And at least one frame is EXACTLY at the ceiling, so the assertion is
    // not passing because every frame is comfortably small.
    assert!(
        frames.iter().any(|frame| frame.long_edge() == THUMB_EDGE),
        "no frame sits at the ceiling; the test would not notice it moving"
    );
}

/// The committed copy is the v0 bytes, byte for byte. The inline video payload
/// is listed in the manifest and copied nowhere, so it is skipped here.
#[test]
fn the_contracts_sample_directory_is_the_v0_roll() {
    let manifest = read_json("contracts/apps/photos/sample/manifest.json");
    let inline: Vec<&str> = manifest["files"]
        .as_array()
        .expect("the files are listed")
        .iter()
        .filter(|entry| entry["inline"] == serde_json::json!(true))
        .map(|entry| entry["file"].as_str().expect("a name"))
        .collect();
    assert_eq!(inline, ["tahoe-pan.mp4"]);
    for frame in samples() {
        if inline.contains(&frame.file) {
            continue;
        }
        let ours = fs::read(root().join("contracts/apps/photos/sample").join(frame.file))
            .unwrap_or_else(|error| panic!("{}: {error}", frame.file));
        let theirs = fs::read(
            root()
                .join("packages/blueprints/apps/photos/sample")
                .join(frame.file),
        )
        .unwrap_or_else(|error| panic!("{}: {error}", frame.file));
        assert_eq!(ours, theirs, "{} drifted from the v0 roll", frame.file);
        assert_eq!(
            i64::try_from(ours.len()).expect("a length"),
            frame.byte_size,
            "{} is not the length the manifest recorded",
            frame.file
        );
    }
}

/// The generator is idempotent in the only sense a fixture generator can be:
/// the same inputs write the same rows.
#[test]
fn the_generator_writes_the_same_rows_twice() {
    let digest = |connection: &Connection| -> Vec<String> {
        connection
            .prepare(
                "SELECT asset_id || '|' || COALESCE(title,'') || '|' || COALESCE(captured_at,'')
                        || '|' || COALESCE(place_id,'') || '|' || COALESCE(width,0)
                   FROM media_asset ORDER BY asset_id",
            )
            .expect("the digest prepares")
            .query_map([], |row| row.get::<_, String>(0))
            .expect("the digest runs")
            .collect::<Result<Vec<String>, _>>()
            .expect("every row reads")
    };
    assert_eq!(digest(&seeded()), digest(&seeded()));
}

// ---------------------------------------------------------------------------
// 2. THE EIGHT QUERIES.
// ---------------------------------------------------------------------------

/// The instant the folds are read at. Fixed, and past the roll.
const NOW_MS: i64 = 1_773_532_800_000; // 2026-03-15T00:00:00.000Z

#[test]
fn the_library_window_carries_the_roll_newest_first_with_its_joins() {
    let connection = seeded();
    let door = TestDoor::new(&connection);
    let data = load_library(&door, &LibraryInput::default(), NOW_MS).expect("the library reads");

    // Nineteen assets, none trashed and none archived by the seed.
    assert_eq!(data.assets.len(), 19);
    assert!(data.trash.is_empty());
    assert!(!data.truncated, "nineteen is inside the 500 window");
    assert_eq!(data.window, 500);

    // NEWEST FIRST, and the tail is the oldest the page reached.
    let taken: Vec<&str> = data
        .assets
        .iter()
        .map(|asset| asset.taken_at.as_deref().unwrap_or_default())
        .collect();
    let mut sorted = taken.clone();
    sorted.sort_unstable_by(|left, right| right.cmp(left));
    assert_eq!(taken, sorted);
    assert_eq!(data.tail.as_deref(), taken.last().copied());

    // THE STAR IS DERIVED. Two frames are starred, and the two are the ones
    // v0's seed stars through `media.update_asset`.
    let starred: Vec<&str> = data
        .assets
        .iter()
        .filter(|asset| asset.favorite)
        .map(|asset| asset.asset.title.as_deref().unwrap_or_default())
        .collect();
    assert_eq!(starred.len(), 2);
    assert!(starred.contains(&"Bend in the Truckee"));
    assert!(starred.contains(&"Emerald Bay overlook"));

    // The album join: four members, all naming the one album.
    let in_album: Vec<&str> = data
        .assets
        .iter()
        .filter(|asset| !asset.album_ids.is_empty())
        .map(|asset| asset.asset.asset_id.as_str())
        .collect();
    assert_eq!(in_album.len(), DEMO_ALBUM_FILES.len());
    assert_eq!(data.albums.len(), 1);
    assert_eq!(data.albums[0].title.as_deref(), Some(DEMO_ALBUM_TITLE));
    assert!(data.assets.iter().all(|asset| {
        asset
            .album_titles
            .iter()
            .all(|title| title == DEMO_ALBUM_TITLE)
    }));

    // THE PLACE JOIN, and the deliberate holes in it: three frames carry no
    // place, because a camera roll where every frame knows where it was is not
    // a camera roll anyone has.
    let placeless = data
        .assets
        .iter()
        .filter(|asset| asset.place.is_none())
        .count();
    let expected_placeless = DEMO_ROLL
        .iter()
        .filter(|frame| frame.place.is_none())
        .count();
    assert_eq!(placeless, expected_placeless);
    assert_eq!(
        data.places.len(),
        9,
        "sixteen located frames collapse onto nine places at ~11 m"
    );

    // Byte facts ride from the content item, and a `blob:` URI becomes a
    // same-origin serve URL with its three variants.
    let first = &data.assets[0];
    assert!(first.byte_size.is_some_and(|size| size > 0));
    assert!(
        first
            .uris
            .src
            .as_deref()
            .is_some_and(|src| src.starts_with("/centraid/_vault/blobs/"))
    );
    assert!(first.uris.thumb.is_some());
}

/// The keyset cursor: a `before` reads strictly earlier, and an UNDATED asset
/// rides the first window only.
#[test]
fn the_cursor_reads_strictly_earlier_and_an_undated_asset_rides_the_first_window() {
    let connection = seeded();
    // One asset with no capture time at all.
    connection
        .execute(
            "INSERT INTO core_content_item (content_id, content_uri, sha256, byte_size, created_at)
             VALUES ('undated-content', 'blob:ff', ?1, 10, '2026-03-15T00:00:00.000Z')",
            [format!("{:064x}", 0xffff_u32)],
        )
        .expect("the bytes land");
    connection
        .execute(
            "INSERT INTO media_asset (asset_id, content_id, kind, created_at, updated_at)
             VALUES ('undated-asset', 'undated-content', 'photo', ?1, ?1)",
            ["2026-03-15T00:00:00.000Z"],
        )
        .expect("the asset lands");

    let door = TestDoor::new(&connection);
    let first = load_library(&door, &LibraryInput::default(), NOW_MS).expect("the first page");
    assert!(
        first
            .assets
            .iter()
            .any(|asset| asset.asset.asset_id == "undated-asset"),
        "an undated asset is in the first window"
    );
    let tail = first.tail.clone().expect("a tail");
    let next = load_library(
        &door,
        &LibraryInput {
            limit: None,
            before: Some(tail.clone()),
        },
        NOW_MS,
    )
    .expect("the second page");
    assert!(
        !next
            .assets
            .iter()
            .any(|asset| asset.asset.asset_id == "undated-asset"),
        "and no cursored page ever reaches it again: NULL fails `captured_at < ?`"
    );
    assert!(
        next.assets.iter().all(|asset| asset
            .taken_at
            .as_deref()
            .is_some_and(|at| at < tail.as_str())),
        "the cursor is STRICT"
    );
    assert!(
        next.memories.is_empty(),
        "a cursored page carries no memory shelf"
    );
}

#[test]
fn a_trashed_photograph_rides_the_trash_shelf_with_its_days_and_leaves_the_grid() {
    let connection = seeded();
    connection
        .execute(
            "UPDATE media_asset SET deleted_at = ?1, purge_at = ?2 WHERE asset_id = 'demo-asset-000000'",
            ["2026-03-14T00:00:00.000Z", "2026-04-13T00:00:00.000Z"],
        )
        .expect("the trash lands");
    let door = TestDoor::new(&connection);
    let data = load_library(&door, &LibraryInput::default(), NOW_MS).expect("the library reads");
    assert_eq!(data.assets.len(), 18);
    assert_eq!(data.trash.len(), 1);
    assert_eq!(data.trash[0].purge_in_days, Some(29));
    // A trashed row with NO purge date reads `None`, not zero.
    connection
        .execute(
            "UPDATE media_asset SET purge_at = NULL WHERE asset_id = 'demo-asset-000000'",
            [],
        )
        .expect("the window clears");
    let data = load_library(&door, &LibraryInput::default(), NOW_MS).expect("the library reads");
    assert_eq!(data.trash[0].purge_in_days, None);
}

#[test]
fn the_storage_summary_of_an_unswept_vault_is_not_counted_yet() {
    let connection = seeded();
    let door = TestDoor::new(&connection);
    let summary = storage_summary(&door).expect("the rollup reads");
    assert!(!summary.counted_yet());
    assert_eq!(summary.buckets(), None);
    assert!(summary.offerable_release().is_none());

    // Now the sweep runs.
    for (bucket, count, bytes) in [
        ("replicated", 10, 20_000_000),
        ("local-only", 9, 18_000_000),
        ("freeable", 4, 8_000_000),
        ("local-unproven", 5, 10_000_000),
    ] {
        connection
            .execute(
                "INSERT INTO blob_custody_rollup (bucket, item_count, byte_size, computed_at)
                 VALUES (?1, ?2, ?3, '2026-03-15T01:00:00.000Z')",
                rusqlite::params![bucket, count, bytes],
            )
            .expect("the rollup lands");
    }
    let summary = storage_summary(&door).expect("the rollup reads");
    assert_eq!(summary.computed_at(), Some("2026-03-15T01:00:00.000Z"));
    let buckets = summary.buckets().expect("counted");
    assert_eq!(buckets.library(), Totals::new(19, 38_000_000));
    assert_eq!(
        summary
            .offerable_release()
            .map(|freeable| freeable.totals()),
        Some(Totals::new(4, 8_000_000))
    );
}

#[test]
fn the_face_queue_counts_matches_and_dates_them_by_capture() {
    let connection = seeded();
    let door = TestDoor::new(&connection);
    let queue = face_queue(&door).expect("the queue reads");
    assert_eq!(queue.unmatched_total, 8, "eight proposals, all unanswered");
    assert_eq!(queue.queue.len(), 8);
    assert_eq!(queue.confirmed_total, 0);
    assert!(!queue.region_window_filled);
    // The seed's proposals name NOBODY, so every match count is zero and no
    // first-seen date is invented from a party nobody proposed.
    assert!(queue.queue.iter().all(|entry| entry.match_count == 0));
    assert!(queue.queue.iter().all(|entry| entry.party_id.is_none()));
    // But a proposal IS on a photograph with a capture time, so first-seen is
    // that photograph's own.
    assert!(
        queue
            .queue
            .iter()
            .all(|entry| entry.first_seen_at.is_some())
    );
    // The roster the picker offers is every PERSON party in the vault — the two
    // the seed names, plus the owner. A picker that offered only the named
    // pair could not confirm a face as the member themself.
    assert_eq!(queue.people.len(), DEMO_FACE_PEOPLE.len() + 1);

    // Answer one, and it leaves the queue for good.
    connection
        .execute(
            "UPDATE media_face_region
                SET review_state = 'confirmed', party_id = 'demo-party-000001',
                    confirmed_by_party_id = 'demo-owner'
              WHERE region_id = 'demo-region-000000'",
            [],
        )
        .expect("the answer lands");
    let queue = face_queue(&door).expect("the queue reads");
    assert_eq!(queue.unmatched_total, 7);
    assert_eq!(queue.confirmed_total, 1);
}

#[test]
fn the_people_roster_names_only_confirmed_parties_and_groups_the_rest_as_questions() {
    let connection = seeded();
    // Confirm two faces of one person, in two different photographs.
    for region in ["demo-region-000000", "demo-region-000002"] {
        connection
            .execute(
                "UPDATE media_face_region
                    SET review_state = 'confirmed', party_id = 'demo-party-000001',
                        confirmed_by_party_id = 'demo-owner'
                  WHERE region_id = ?1",
                [region],
            )
            .expect("the answer lands");
    }
    let door = TestDoor::new(&connection);
    let roster = people_roster(&door).expect("the roster reads");
    assert_eq!(roster.people.len(), 1);
    assert_eq!(roster.people[0].party_id, "demo-party-000001");
    assert_eq!(roster.people[0].name.as_deref(), Some("Ana Ribeiro"));
    assert_eq!(
        roster.people[0].count, 2,
        "the count is distinct PHOTOGRAPHS"
    );
    assert_eq!(roster.unmatched_total, 6);
    // The remaining proposals carry no name, and with no cluster rows they
    // group into nothing — an honest empty shelf rather than six people.
    assert!(roster.proposals.is_empty());
    assert!(roster.people[0].confirmed_by.len() == 1);
}

#[test]
fn one_photographs_faces_are_the_unanswered_and_the_confirmed_and_no_others() {
    let connection = seeded();
    connection
        .execute(
            "UPDATE media_face_region SET review_state = 'rejected', party_id = NULL
              WHERE region_id = 'demo-region-000004'",
            [],
        )
        .expect("the answer lands");
    let door = TestDoor::new(&connection);
    // `ana-and-marco-table.png` is the fifth portrait and carries TWO faces.
    let asset_id = connection
        .query_row(
            "SELECT asset_id FROM media_asset WHERE title = 'Ana and Marco at the table'",
            [],
            |row| row.get::<_, String>(0),
        )
        .expect("the frame is there");
    let faces = asset_faces(&door, &asset_id).expect("the faces read");
    assert_eq!(faces.regions.len(), 1, "the rejected face is gone for good");
    assert!(faces.regions[0].detector_confidence.is_some());
    assert!(!faces.regions[0].confirmed);
}

#[test]
fn duplicates_read_the_cluster_id_a_sweep_stamped_and_nothing_when_none_has() {
    let connection = seeded();
    let door = TestDoor::new(&connection);
    assert!(
        duplicate_clusters(&door).expect("the read runs").is_empty(),
        "an un-swept vault has no duplicates, and that is not an empty screen by accident"
    );

    // The sweep runs. `centraid_media::duplicates::cluster` is what decides the
    // value; here it is stamped so the QUERY can be read.
    connection
        .execute(
            "UPDATE media_asset_phash SET cluster_id = 'demo-asset-000000'
              WHERE asset_id IN ('demo-asset-000000', 'demo-asset-000001')",
            [],
        )
        .expect("the stamp lands");
    let clusters = duplicate_clusters(&door).expect("the read runs");
    assert_eq!(clusters.len(), 1);
    assert_eq!(clusters[0].key, "demo-asset-000000");
    assert_eq!(clusters[0].assets.len(), 2);
    assert_eq!(clusters[0].tier, "phash");

    // A cluster whose second member is TRASHED drops entirely: a duplicate of
    // one is a photograph.
    connection
        .execute(
            "UPDATE media_asset SET deleted_at = '2026-03-14T00:00:00.000Z',
                                    purge_at = '2026-04-13T00:00:00.000Z'
              WHERE asset_id = 'demo-asset-000001'",
            [],
        )
        .expect("the trash lands");
    assert!(duplicate_clusters(&door).expect("the read runs").is_empty());
}

#[test]
fn the_enrichment_mirror_is_off_until_a_policy_row_says_otherwise() {
    let connection = seeded();
    let door = TestDoor::new(&connection);
    assert_eq!(
        enrichment_status(&door).expect("the mirror reads"),
        Reading::Data(Tier::Off)
    );
    connection
        .execute(
            "INSERT INTO enrich_policy (domain, tier) VALUES ('photos', 'gateway')",
            [],
        )
        .expect("the policy lands");
    assert_eq!(
        enrichment_status(&door).expect("the mirror reads"),
        Reading::Data(Tier::Gateway)
    );
    // The `docs` domain is not this app's mirror.
    connection
        .execute(
            "UPDATE enrich_policy SET tier = 'off' WHERE domain = 'photos'",
            [],
        )
        .expect("the policy changes");
    connection
        .execute(
            "INSERT INTO enrich_policy (domain, tier) VALUES ('docs', 'gateway')",
            [],
        )
        .expect("the other policy lands");
    assert_eq!(
        enrichment_status(&door).expect("the mirror reads"),
        Reading::Data(Tier::Off)
    );
}

/// `search` folds the same grid rows in the vault's own RANK order. The FTS read
/// is `crates/search`'s, so the hits are handed in — which is also what keeps
/// the ranking from being re-sorted away.
#[test]
fn search_keeps_the_vaults_rank_order() {
    let connection = seeded();
    let door = TestDoor::new(&connection);
    let content_ids: Vec<String> = connection
        .prepare(
            "SELECT content_id FROM media_asset
              WHERE title IN ('Emerald Bay overlook', 'Dusk over the west shore')
              ORDER BY title DESC",
        )
        .expect("the ids prepare")
        .query_map([], |row| row.get::<_, String>(0))
        .expect("the ids run")
        .collect::<Result<Vec<String>, _>>()
        .expect("every id reads");
    assert_eq!(content_ids.len(), 2);
    let data = load_search(&door, &content_ids, NOW_MS).expect("the search reads");
    assert_eq!(
        data.assets
            .iter()
            .map(|asset| asset.asset.content_id.as_str())
            .collect::<Vec<_>>(),
        content_ids.iter().map(String::as_str).collect::<Vec<_>>(),
        "best match first, whatever the capture order"
    );
    // The rows are the GRID's rows: the same joins, so a hit renders in place.
    assert!(data.assets.iter().all(|asset| asset.uris.src.is_some()));
    // An empty hit list is an empty answer, not a table scan.
    assert!(
        load_search(&door, &[], NOW_MS)
            .expect("the read runs")
            .assets
            .is_empty()
    );
}

/// The Places facet over the seeded roll: the vault's coordinate-shaped names
/// never reach a phrase, and the relative rung fills in.
#[test]
fn a_place_the_member_has_not_named_still_gets_a_phrase_and_never_a_coordinate() {
    let connection = seeded();
    let door = TestDoor::new(&connection);
    let data = load_library(&door, &LibraryInput::default(), NOW_MS).expect("the library reads");
    // Every seeded place carries a coordinate-shaped name, as the vault mints
    // one for a place nobody has named.
    assert!(data.places.iter().all(|place| place.name.contains(", ")));
    let anchors = NamedPlace::anchors(&data.places);
    assert!(
        anchors.is_empty(),
        "a coordinate-shaped name is not an anchor a phrase may print"
    );
    for place in &data.places {
        let phrase = place_phrase(&PhraseInput {
            place_name: Some(&place.name),
            gazetteer_name: None,
            lat: place.lat,
            lng: place.lng,
            anchors: &anchors,
            context: PhraseContext::Private,
        });
        assert_eq!(
            phrase.text, "A place with no name yet",
            "{} leaked through as a phrase",
            place.name
        );
    }

    // Name one, and it becomes both a phrase and an anchor for the rest.
    connection
        .execute(
            "UPDATE core_place SET name = 'The cabin', kind = 'home' WHERE place_id = 'demo-place-000002'",
            [],
        )
        .expect("the name lands");
    let data = load_library(&door, &LibraryInput::default(), NOW_MS).expect("the library reads");
    let anchors = NamedPlace::anchors(&data.places);
    assert_eq!(anchors.len(), 1);
    let ridge = data
        .places
        .iter()
        .find(|place| place.place_id != "demo-place-000002" && place.lat.is_some())
        .expect("another located place");
    let phrase = place_phrase(&PhraseInput {
        place_name: Some(&ridge.name),
        gazetteer_name: None,
        lat: ridge.lat,
        lng: ridge.lng,
        anchors: &anchors,
        context: PhraseContext::Private,
    });
    assert!(
        phrase.text.ends_with("of The cabin") || phrase.text == "A place with no name yet",
        "a private phrase is relative or absent, never a coordinate: {}",
        phrase.text
    );
}

// ---------------------------------------------------------------------------
// The fixture bundle's own state.
// ---------------------------------------------------------------------------

/// The manifest SAYS the v0 answers are pending, so a green suite cannot be
/// mistaken for parity. See the module note.
#[test]
fn the_fixture_bundle_is_declared_pending_and_says_so_out_loud() {
    let manifest = read_json("contracts/apps/photos/manifest.json");
    assert_eq!(manifest["app"], serde_json::json!("photos"));
    assert_eq!(
        manifest["fixtures"],
        serde_json::json!("pending-regeneration"),
        "when the bundle lands this flips to a comparison"
    );
    let command = manifest["regenerate"]
        .as_str()
        .expect("the manifest names the command that produces the bundle");
    assert!(command.contains("export-photos-parity"), "{command}");
    // The generator it names is committed.
    assert!(
        root()
            .join("contracts/tools/export-photos-parity.ts")
            .is_file(),
        "the generator the manifest names is not there"
    );
    // Presentation is deferred the same way Tally's is (D-1020-D3-9).
    assert_eq!(manifest["design"], serde_json::json!("deferred"));
    // And the queries the bundle will carry are the manifest's own eight.
    let declared: Vec<&str> = manifest["queries"]
        .as_array()
        .expect("the queries are listed")
        .iter()
        .map(|value| value.as_str().expect("a name"))
        .collect();
    let mut from_app: Vec<&str> = manifest::manifest()
        .queries
        .iter()
        .map(|entry| entry.name.as_str())
        .collect();
    from_app.sort_unstable();
    let mut declared = declared;
    declared.sort_unstable();
    assert_eq!(declared, from_app);
}

/// Every statement the port makes is named, and the names are the ones v0's
/// plan snapshot carries — so a plan review reads the same on both sides.
#[test]
fn every_statement_is_named_in_the_apps_own_namespace() {
    let statements: BTreeMap<&str, centraid_apps_kit::PageQuery> = [
        (
            "library.live",
            centraid_apps_photos::queries::live_statement(None),
        ),
        (
            "library.trash",
            centraid_apps_photos::queries::trash_statement(),
        ),
        (
            "storage.rollup",
            centraid_apps_photos::storage::rollup_statement(),
        ),
        (
            "faceQueue.regions",
            centraid_apps_photos::faces::queue_regions_statement(),
        ),
        (
            "people.clusters",
            centraid_apps_photos::faces::clusters_statement(),
        ),
        (
            "duplicates.phashes",
            centraid_apps_photos::duplicates::phash_statement(),
        ),
        (
            "enrichment.policy",
            centraid_apps_photos::enrichment::policy_statement(),
        ),
        (
            "shared.places",
            centraid_apps_photos::places::places_statement(),
        ),
    ]
    .into_iter()
    .collect();
    for (suffix, query) in statements {
        assert!(
            query.name.starts_with("photos."),
            "{} is not in the app's namespace",
            query.name
        );
        assert!(
            query.name.ends_with(suffix),
            "{} != photos.{suffix}",
            query.name
        );
        assert!(!query.select.is_empty());
        assert!(!query.from.is_empty());
    }
}
