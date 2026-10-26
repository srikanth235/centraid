//! What Photos reads, against a vault the product founds and Photos' own commands
//! fill: the albums and their covers, the places, the full-text leg of the search,
//! the duplicates and the count of the library, each asked through the paged door a
//! phone's core asks through. (The shelves are `shelves.rs`; the overview, one
//! photograph and the search's other legs are `collections.rs`.)

mod common;

use centraid_apps_kit::testdoor::TestDoor;
use centraid_apps_photos::duplicates::{Fingerprint, duplicate_clusters};
use centraid_apps_photos::overview::{live_photo_count, load_albums};
use centraid_apps_photos::places::load_places;
use centraid_apps_photos::queries::load_search_term;
use common::World;
use serde_json::json;

#[test]
fn an_album_counts_its_members_that_are_not_trashed_and_hands_its_cover_to_a_member() {
    let w = World::new();
    let album = w.album("Summer");
    let a = w.photo("a", json!({ "taken_at": "2025-01-01T00:00:00.000Z" }));
    let b = w.photo("b", json!({ "taken_at": "2025-01-02T00:00:00.000Z" }));
    for photo in [&a, &b] {
        w.ok(
            "edge.add",
            json!({ "from": album, "rel": "contains", "to": photo }),
        );
    }
    w.ok("album.set_cover", json!({ "id": album, "photo_id": b }));
    let overview = || w.read(|door| load_albums(door, 0).expect("reads"));
    let row = &overview().albums[0];
    assert_eq!((row.title.as_str(), row.count), ("Summer", 2));
    assert_eq!(
        row.cover.as_ref().map(|cover| cover.content_id.clone()),
        Some(centraid_vault::blob::content_digest(b"b"))
    );
    // The cover leaves the album: the album shows its first photograph instead.
    w.ok(
        "edge.remove",
        json!({ "from": album, "rel": "contains", "to": b }),
    );
    let after = overview();
    assert_eq!(after.albums[0].count, 1);
    assert_eq!(
        after.albums[0]
            .cover
            .as_ref()
            .map(|cover| cover.content_id.clone()),
        Some(centraid_vault::blob::content_digest(b"a"))
    );
    // A trashed member is not counted, and comes back with the album's order.
    w.ok("entity.trash", json!({ "id": a }));
    assert_eq!(overview().albums[0].count, 0);
    assert!(overview().albums[0].cover.is_none());
    w.ok("entity.restore", json!({ "id": a }));
    assert_eq!(overview().albums[0].count, 1);
}

#[test]
fn a_photograph_carries_its_place_and_a_places_phrase_is_never_digits() {
    let w = World::new();
    w.photo("pier", json!({ "lat": 37.7955, "lon": -122.3937 }));
    let place = w.read(|door| centraid_apps_photos::places::read_places(door).expect("reads"));
    assert_eq!(place.len(), 1);
    assert_eq!(place[0].name, "37.7955, -122.3937");
    let phrase =
        centraid_apps_photos::places::place_phrase(&centraid_apps_photos::places::PhraseInput {
            place_name: Some(&place[0].name),
            ..Default::default()
        });
    assert_eq!(phrase.source, centraid_apps_photos::PlacePhraseSource::None);
    w.ok(
        "entity.retitle",
        json!({ "id": place[0].place_id, "title": "Pier 39" }),
    );
    w.ok(
        "place.locate",
        json!({ "id": place[0].place_id, "locality": "San Francisco" }),
    );
    let named = w.read(|door| load_places(door, 0).expect("reads"));
    let found = &named.places[0];
    assert_eq!(
        (found.place.name.as_str(), found.place.gazetteer.as_deref()),
        ("Pier 39", Some("San Francisco"))
    );
    assert_eq!(found.phrase.text, "Pier 39");
}

#[test]
fn search_finds_a_caption_or_a_place_and_leaves_out_the_archive() {
    let w = World::new();
    let dog = w.photo("dog", json!({ "title": "Dog at the beach" }));
    let cat = w.photo("cat", json!({ "title": "Cat at the beach" }));
    w.photo("tree", json!({ "title": "A tree" }));
    w.ok("flag.set", json!({ "id": cat, "flag": "archived" }));
    let search = |term: &str| {
        w.vault
            .read(|connection| {
                let index = centraid_search::SqliteDoor::open(connection, w.vault.words())
                    .expect("the index opens");
                let door = TestDoor::new(connection);
                let standing = centraid_apps_kit::rules::Standing::read(&door).expect("standing");
                Ok(load_search_term(
                    &door,
                    &standing,
                    &index,
                    &centraid_search::Principal::Owner,
                    term,
                    10,
                )
                .expect("reads"))
            })
            .expect("a read")
    };
    let (found, denial) = search("beach");
    assert!(denial.is_none());
    assert_eq!(found.photo_ids, [dog]);
    assert!(search("zeppelin").0.photo_ids.is_empty());
}

#[test]
fn duplicates_are_clustered_at_read_over_live_photographs_only() {
    let w = World::new();
    let a = w.photo("a", json!({ "phash": "ffff0000ffff0000" }));
    let b = w.photo("b", json!({ "phash": "ffff0000ffff0001" }));
    let c = w.photo("c", json!({ "phash": "0000ffff0000ffff" }));
    let d = w.photo("d", json!({ "phash": "ffff0000ffff0003" }));
    w.ok("entity.trash", json!({ "id": d }));
    let clusters = w.read(|door| {
        duplicate_clusters(door, 0, |prints: &[Fingerprint]| {
            let rows: Vec<centraid_media::duplicates::Fingerprint> = prints
                .iter()
                .map(|p| centraid_media::duplicates::Fingerprint {
                    asset_id: p.photo_id.clone(),
                    phash: p.phash.clone(),
                    cluster_id: None,
                })
                .collect();
            centraid_media::duplicates::cluster(
                &rows,
                centraid_media::duplicates::DUPLICATE_HAMMING_THRESHOLD,
            )
        })
        .expect("reads")
    });
    assert_eq!(clusters.len(), 1);
    let mut members: Vec<&str> = clusters[0]
        .photos
        .iter()
        .map(|p| p.photo_id.as_str())
        .collect();
    members.sort_unstable();
    let mut expected = [a.as_str(), b.as_str()];
    expected.sort_unstable();
    assert_eq!(
        members, expected,
        "the trashed twin is not offered, and a lone photograph is no cluster"
    );
    assert!(!members.contains(&c.as_str()));
    assert_eq!(clusters[0].tier, "phash");
}

/// THE PHOTO COUNT IS THE LIBRARY'S, NOT THE ROWS' (#1135): an edit and the photograph
/// it was made from are two rows and one drawn photograph, so the count Home's tile
/// shows is 1 for the pair; the archive and the trash are not in it; a crop saved
/// from the member's own editor (no burst) is a photograph of its own.
#[test]
fn the_photo_count_counts_an_edit_pair_once_and_leaves_out_the_archive_and_the_trash() {
    let w = World::new();
    let original = w.photo(
        "camera",
        json!({ "taken_at": "2025-03-01T10:00:00.000Z", "burst": "capture-1" }),
    );
    let _edit = w.photo(
        "camera-edited",
        json!({
            "taken_at": "2025-03-01T10:00:00.000Z",
            "burst": "capture-1",
            "edited_from": original,
        }),
    );
    let alone = w.photo("alone", json!({ "taken_at": "2025-03-02T10:00:00.000Z" }));
    let _crop = w.photo(
        "alone-cropped",
        json!({ "taken_at": "2025-03-02T10:00:00.000Z", "edited_from": alone }),
    );
    let archived = w.photo("archived", json!({}));
    let trashed = w.photo("trashed", json!({}));
    w.ok("flag.set", json!({ "id": archived, "flag": "archived" }));
    w.ok("entity.trash", json!({ "id": trashed }));
    // The pair counts once, the photograph and its crop count twice.
    assert_eq!(w.read(|door| live_photo_count(door).expect("counts")), 3);
}
