//! The collections overview, the places, one photograph's detail, the search's
//! structured legs and the duplicates' members: each against the same library the
//! shelves are read from, so a tile and the shelf it opens are asked the same
//! question and answer the same number.

mod common;

use centraid_apps_photos::detail::load_photo;
use centraid_apps_photos::overview::{live_photo_count, load_albums};
use centraid_apps_photos::places::load_places;
use centraid_apps_photos::search::{HitKind, Named, assemble, resting, structured_legs, tokens};
use centraid_apps_photos::shelf::{Shelf, ShelfInput, load_shelf};
use common::{World, library};
use serde_json::json;

const NOW: i64 = 1_767_312_000_000;

#[test]
fn every_tile_counts_the_shelf_it_opens() {
    let l = library();
    let albums = l.w.read(|door| load_albums(door, NOW).expect("reads"));
    let shelf_total = |shelf: Shelf| {
        l.w.read(|door| {
            load_shelf(
                door,
                &ShelfInput {
                    shelf,
                    limit: 1,
                    after: None,
                },
                NOW,
            )
            .expect("reads")
            .total
        })
        .expect("a total")
    };
    assert_eq!(albums.live.count, shelf_total(Shelf::Live));
    assert_eq!(albums.favorites.count, shelf_total(Shelf::Favorites));
    assert_eq!(albums.videos.count, shelf_total(Shelf::Videos));
    assert_eq!(albums.archive.count, shelf_total(Shelf::Archive));
    assert_eq!(albums.trash.count, shelf_total(Shelf::Trash));
    assert_eq!(albums.unplaced, shelf_total(Shelf::Unplaced));
    assert_eq!(albums.live.count, 6);
    assert_eq!(albums.places, 2);
    // Home's number is the same one.
    assert_eq!(
        l.w.read(|door| live_photo_count(door).expect("counts")),
        albums.live.count
    );
    // The covers are the shelf's newest cell.
    assert_eq!(
        albums
            .live
            .cover
            .as_ref()
            .map(|cell| cell.photo_id.as_str()),
        Some(l.new.as_str())
    );
    assert_eq!(
        albums
            .favorites
            .cover
            .as_ref()
            .map(|cell| cell.photo_id.as_str()),
        Some(l.new.as_str())
    );
    assert!(
        albums
            .videos
            .cover
            .as_ref()
            .is_some_and(|cell| cell.photo_id == l.movie)
    );
}

#[test]
fn an_album_counts_what_it_draws_and_a_trashed_album_waits_for_its_restore() {
    let l = library();
    let overview = l.w.read(|door| load_albums(door, NOW).expect("reads"));
    assert_eq!(overview.albums.len(), 1);
    let summer = &overview.albums[0];
    assert_eq!((summer.title.as_str(), summer.count), ("Summer", 3));
    // No cover was chosen: the album's first member is its cover.
    assert!(summer.cover.is_some());
    assert!(overview.trashed_albums.is_empty());
    // A chosen cover that is a member and not trashed wins.
    l.w.ok(
        "album.set_cover",
        json!({ "id": l.album, "photo_id": l.old }),
    );
    let chosen = l.w.read(|door| load_albums(door, NOW).expect("reads"));
    assert_eq!(
        chosen.albums[0]
            .cover
            .as_ref()
            .map(|cell| cell.photo_id.as_str()),
        Some(l.old.as_str())
    );
    // Trashing the album moves it to the trash list, with its countdown.
    l.w.ok("entity.trash", json!({ "id": l.album }));
    let after = l.w.read(|door| load_albums(door, NOW).expect("reads"));
    assert!(after.albums.is_empty());
    assert_eq!(after.trashed_albums.len(), 1);
    assert_eq!(after.trashed_albums[0].album_id, l.album);
    assert_eq!(after.trashed_albums[0].purge_in_days, Some(29));
}

#[test]
fn the_places_carry_their_live_counts_a_cover_and_a_phrase_never_digits() {
    let l = library();
    let data = l.w.read(|door| load_places(door, NOW).expect("reads"));
    assert_eq!(data.places.len(), 2);
    // Most photographs first.
    assert_eq!(data.places[0].place.place_id, l.place_a);
    assert_eq!(data.places[0].count, 2);
    assert_eq!(
        data.places[0]
            .cover
            .as_ref()
            .map(|cell| cell.photo_id.as_str()),
        Some(l.new.as_str())
    );
    assert_eq!(data.places[1].count, 1);
    assert_eq!(data.unplaced, 3);
    for card in &data.places {
        assert_eq!(
            card.name, None,
            "a title that is only coordinates is no name"
        );
        assert!(!card.phrase.text.contains("37.79"), "{}", card.phrase.text);
    }
    // Naming one gives the card its name.
    l.w.ok(
        "entity.retitle",
        json!({ "id": l.place_a, "title": "Pier 39" }),
    );
    let named = l.w.read(|door| load_places(door, NOW).expect("reads"));
    assert_eq!(named.places[0].name.as_deref(), Some("Pier 39"));
    assert_eq!(named.places[0].phrase.text, "Pier 39");
    // A place with no live photograph is still a place to choose.
    l.w.ok("entity.trash", json!({ "id": l.edit }));
    let emptied = l.w.read(|door| load_places(door, NOW).expect("reads"));
    assert!(emptied.places.iter().any(|card| card.count == 0));
}

#[test]
fn one_photograph_carries_its_albums_labels_place_and_lineage() {
    let l = library();
    l.w.ok("tag.add", json!({ "id": l.old, "label": "Beach" }));
    l.w.ok("flag.set", json!({ "id": l.old, "flag": "starred" }));
    let detail = l.w.read(|door| {
        load_photo(door, &l.old, NOW)
            .expect("reads")
            .expect("there")
    });
    assert_eq!(detail.cell.title, "Old");
    assert!(detail.cell.favorite);
    assert!(!detail.trashed);
    assert_eq!(detail.albums.len(), 1);
    assert_eq!(detail.albums[0].title, "Summer");
    assert_eq!(detail.tags.len(), 1);
    assert_eq!(detail.tags[0].label, "Beach");
    let place = detail.place.expect("a place");
    assert_eq!(place.place.place_id, l.place_a);
    assert!(place.exact_location.is_some());
    // The original of an edit lists its edit.
    let original = l.w.read(|door| {
        load_photo(door, &l.original, NOW)
            .expect("reads")
            .expect("there")
    });
    assert_eq!(original.edits, [l.edit.clone()]);
    assert_eq!(
        l.w.read(|door| load_photo(door, &l.edit, NOW)
            .expect("reads")
            .expect("there"))
            .cell
            .edited_from
            .as_deref(),
        Some(l.original.as_str())
    );
    // A trashed photograph is still readable, with its stamp; a missing one is None.
    let trashed = l.w.read(|door| {
        load_photo(door, &l.trashed, NOW)
            .expect("reads")
            .expect("there")
    });
    assert!(trashed.trashed);
    assert_eq!(trashed.cell.purge_in_days, Some(29));
    assert!(
        l.w.read(|door| load_photo(door, "nope", NOW).expect("reads"))
            .is_none()
    );
}

fn search_hits(
    l: &common::Library,
    term: &str,
    text: &[String],
    albums: &[Named],
) -> centraid_apps_photos::search::SearchHits {
    l.w.read(|door| {
        let standing = centraid_apps_kit::rules::Standing::read(door).expect("standing");
        let legs = structured_legs(door, &standing, term).expect("legs");
        assemble(door, &standing, NOW, 100, text, albums, &legs).expect("reads")
    })
}

#[test]
fn search_folds_the_places_the_labels_and_no_location_with_their_counts() {
    let l = library();
    l.w.ok(
        "entity.retitle",
        json!({ "id": l.place_a, "title": "Pier 39" }),
    );
    l.w.ok("tag.add", json!({ "id": l.old, "label": "Beach day" }));
    l.w.ok("tag.add", json!({ "id": l.archived, "label": "Beach day" }));
    // A place by name: its live photographs, newest first, and a top hit with its count.
    let pier = search_hits(&l, "pier", &[], &[]);
    assert_eq!(pier.top_hits.len(), 1);
    assert_eq!(pier.top_hits[0].kind, HitKind::Place);
    assert_eq!(pier.top_hits[0].count, 2);
    assert_eq!(
        pier.cells
            .iter()
            .map(|cell| cell.photo_id.as_str())
            .collect::<Vec<_>>(),
        [l.new.as_str(), l.old.as_str()]
    );
    // A label: the live photographs it is on (the archived one is not offered).
    let beach = search_hits(&l, "beach", &[], &[]);
    assert_eq!(beach.labels.len(), 1);
    assert_eq!(beach.labels[0].label, "Beach day");
    assert_eq!(
        beach
            .cells
            .iter()
            .map(|cell| cell.photo_id.as_str())
            .collect::<Vec<_>>(),
        [l.old.as_str()]
    );
    // No location: the bucket, with its count, and the unplaced live photographs.
    let nowhere = search_hits(&l, "no location", &[], &[]);
    assert_eq!(nowhere.top_hits.len(), 1);
    assert_eq!(nowhere.top_hits[0].kind, HitKind::Unplaced);
    assert_eq!(nowhere.top_hits[0].count, 3);
    assert_eq!(nowhere.total, 3);
    // An album the text legs found: its members that are not trashed are its count,
    // the live ones are the hits.
    let summer = search_hits(
        &l,
        "summer",
        &[],
        &[Named {
            id: l.album.clone(),
            label: "Summer".to_owned(),
        }],
    );
    assert_eq!(summer.top_hits[0].kind, HitKind::Album);
    assert_eq!(summer.top_hits[0].count, 3);
    assert_eq!(
        summer
            .cells
            .iter()
            .map(|cell| cell.photo_id.as_str())
            .collect::<Vec<_>>(),
        [l.old.as_str(), l.undated_a.as_str()]
    );
    // The text legs' ids ride along, and only the live ones are hits.
    let text = vec![l.archived.clone(), l.undated_b.clone(), l.original.clone()];
    let ranked = search_hits(&l, "zeppelin", &text, &[]);
    assert_eq!(
        ranked
            .cells
            .iter()
            .map(|cell| cell.photo_id.as_str())
            .collect::<Vec<_>>(),
        [l.undated_b.as_str()],
        "the archived and the folded original are no hit"
    );
    // The cells are capped and the total is exact.
    let capped = l.w.read(|door| {
        let standing = centraid_apps_kit::rules::Standing::read(door).expect("standing");
        let legs = structured_legs(door, &standing, "no location").expect("legs");
        assemble(door, &standing, NOW, 2, &[], &[], &legs).expect("reads")
    });
    assert_eq!(
        (capped.cells.len(), capped.total, capped.truncated),
        (2, 3, true)
    );
}

#[test]
fn the_resting_search_suggests_places_with_photographs_and_labels_on_live_ones() {
    let l = library();
    l.w.ok(
        "entity.retitle",
        json!({ "id": l.place_a, "title": "Pier 39" }),
    );
    l.w.ok("tag.add", json!({ "id": l.old, "label": "Beach" }));
    l.w.ok("tag.add", json!({ "id": l.archived, "label": "Hidden" }));
    let rest = l.w.read(|door| {
        let standing = centraid_apps_kit::rules::Standing::read(door).expect("standing");
        resting(door, &standing).expect("reads")
    });
    // The second place has only coordinates for a title, so it is not suggested.
    assert_eq!(
        rest.places
            .iter()
            .map(|p| p.label.as_str())
            .collect::<Vec<_>>(),
        ["Pier 39"]
    );
    assert_eq!(
        rest.labels
            .iter()
            .map(|p| p.label.as_str())
            .collect::<Vec<_>>(),
        ["Beach"]
    );
}

#[test]
fn the_words_of_a_query_are_the_ones_worth_matching() {
    assert_eq!(tokens("The Pier"), ["pier"]);
}

#[test]
fn a_duplicate_cluster_carries_its_members_as_cells_and_leaves_out_what_is_put_away() {
    let w = World::new();
    let a = w.photo(
        "a",
        json!({ "phash": "ffff0000ffff0000", "width": 400, "height": 300 }),
    );
    let b = w.photo(
        "b",
        json!({ "phash": "ffff0000ffff0001", "width": 800, "height": 600 }),
    );
    let c = w.photo("c", json!({ "phash": "ffff0000ffff0003" }));
    w.ok("flag.set", json!({ "id": c, "flag": "archived" }));
    w.ok("flag.set", json!({ "id": b, "flag": "starred" }));
    let album = w.album("Keepers");
    w.ok(
        "edge.add",
        json!({ "from": album, "rel": "contains", "to": a }),
    );
    let clusters = w.read(|door| {
        centraid_apps_photos::duplicates::duplicate_clusters(door, 0, |prints| {
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
    let cells = &clusters[0].cells;
    assert_eq!(cells.len(), 2, "the archived twin is not offered");
    let by = |id: &str| {
        cells
            .iter()
            .find(|cell| cell.photo_id == id)
            .expect("a member")
    };
    assert_eq!((by(&a).width, by(&a).height), (Some(400), Some(300)));
    assert!(by(&b).favorite);
    assert_eq!(by(&a).album_ids, [album]);
    assert!(by(&b).album_ids.is_empty());
    assert!(by(&a).byte_size.is_some());
}
