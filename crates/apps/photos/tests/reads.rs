//! What Photos reads, against a vault the product founds and Photos' own commands
//! fill: the library window (an edit folding its original, the archive and the trash
//! applied to it), the albums and their covers, the places, the search and the
//! duplicates, each asked through the paged door a phone's core asks through.

use std::sync::Arc;

use centraid_apps_kit::testdoor::TestDoor;
use centraid_apps_photos::duplicates::{Fingerprint, duplicate_clusters};
use centraid_apps_photos::queries::{LibraryInput, load_library, load_search_term};
use centraid_vault::clock::{FixedClock, SeededIds};
use centraid_vault::commands::Registry;
use centraid_vault::{Command, CommandStatus, Principal, Vault};
use serde_json::json;

struct World {
    dir: std::path::PathBuf,
    vault: Vault,
    clock: Arc<FixedClock>,
    registry: Registry,
}

impl Drop for World {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl World {
    fn new() -> Self {
        let dir = centraid_ontology::scratch::scratch_dir();
        std::fs::create_dir_all(&dir).expect("a scratch directory");
        let clock = Arc::new(FixedClock::frozen());
        let vault = Vault::create_with(
            dir.join("vault.db"),
            Box::new(Arc::clone(&clock)),
            Box::new(SeededIds::new("photos")),
        )
        .expect("a vault");
        vault.found("Home", "Owner").expect("founded");
        Self {
            dir,
            vault,
            clock,
            registry: Registry::with_system_commands().expect("a registry"),
        }
    }

    fn ok(&self, name: &str, input: serde_json::Value) -> serde_json::Value {
        let outcome = self
            .vault
            .execute(
                &self.registry,
                &Principal::owner("phone"),
                &Command::new(name, input),
            )
            .expect("runs");
        assert_eq!(
            outcome.status,
            CommandStatus::Executed,
            "{name}: {:?}",
            outcome.reason
        );
        outcome.output
    }

    fn photo(&self, seed: &str, extra: serde_json::Value) -> String {
        let hash = centraid_vault::blob::content_digest(seed.as_bytes());
        self.ok("blob.stage", json!({ "hash": hash, "size": seed.len() }));
        let mut input = json!({ "blob": hash, "media_type": "image/jpeg", "form": "photo" });
        for (key, value) in extra.as_object().expect("an object") {
            input[key] = value.clone();
        }
        self.ok("photo.add", input)["id"]
            .as_str()
            .expect("an id")
            .to_owned()
    }

    fn album(&self, title: &str) -> String {
        self.ok(
            "container.create",
            json!({ "kind": "album", "title": title }),
        )["id"]
            .as_str()
            .expect("an id")
            .to_owned()
    }

    fn read<T>(&self, body: impl FnOnce(&TestDoor<'_>) -> T) -> T {
        self.vault
            .read(|c| Ok(body(&TestDoor::new(c))))
            .expect("a read")
    }

    fn library(&self) -> centraid_apps_photos::LibraryData {
        let now = centraid_vault::time::recurrence::parse_instant_ms("2026-01-02T00:00:00.000Z")
            .expect("an instant");
        self.read(|door| load_library(door, &LibraryInput::default(), now).expect("reads"))
    }
}

fn ids(library: &centraid_apps_photos::LibraryData) -> Vec<&str> {
    library
        .photos
        .iter()
        .map(|grid| grid.photo.photo_id.as_str())
        .collect()
}

#[test]
fn the_library_is_the_live_unarchived_photographs_newest_taken_first() {
    let w = World::new();
    let old = w.photo(
        "old",
        json!({ "taken_at": "2025-01-01T00:00:00.000Z", "title": "Old" }),
    );
    let new = w.photo("new", json!({ "taken_at": "2025-06-01T00:00:00.000Z" }));
    let undated = w.photo("undated", json!({}));
    let archived = w.photo(
        "archived",
        json!({ "taken_at": "2025-07-01T00:00:00.000Z" }),
    );
    let trashed = w.photo("trashed", json!({ "taken_at": "2025-08-01T00:00:00.000Z" }));
    w.ok("flag.set", json!({ "id": archived, "flag": "archived" }));
    w.ok("flag.set", json!({ "id": new, "flag": "starred" }));
    w.ok("tag.add", json!({ "id": new, "label": "Beach" }));
    w.ok("entity.trash", json!({ "id": trashed }));
    let library = w.library();
    // An undated photograph's date is when it was made, so it sorts by that.
    assert_eq!(
        ids(&library),
        [undated.as_str(), new.as_str(), old.as_str()]
    );
    assert_eq!(
        library.photos[0].taken_at.as_deref(),
        Some("2026-01-01T00:00:00.000Z")
    );
    assert!(library.photos[1].favorite);
    assert_eq!(library.photos[1].tags[0].label, "Beach");
    assert_eq!(library.photos[2].photo.title, "Old");
    assert_eq!(library.photos[1].byte_size, Some(3));
    assert!(!library.truncated);
    // The trash is its own shelf, with the days left; an archived photograph is in neither.
    assert_eq!(library.trash.len(), 1);
    assert_eq!(library.trash[0].photo.photo_id, trashed);
    assert_eq!(
        library.trash[0].purge_in_days,
        Some(29),
        "a day into its thirty"
    );
}

#[test]
fn an_edit_draws_and_its_original_stays_underneath() {
    let w = World::new();
    let original = w.photo(
        "camera",
        json!({ "burst": "b1", "taken_at": "2025-05-01T00:00:00.000Z" }),
    );
    w.clock.advance_ms(1_000);
    let edit = w.photo("render", json!({ "burst": "b1", "edited_from": original }));
    w.clock.advance_ms(1_000);
    let crop = w.photo("crop", json!({ "edited_from": original }));
    // The render folds the camera's bytes; a crop from the member's own editor folds nothing.
    let mut drawn = ids(&w.library())
        .iter()
        .map(|id| (*id).to_owned())
        .collect::<Vec<_>>();
    drawn.sort_unstable();
    let mut expected = vec![crop.clone(), edit.clone()];
    expected.sort_unstable();
    assert_eq!(drawn, expected);
    // Trashing the edit brings the original back.
    w.ok("entity.trash", json!({ "id": edit }));
    let back = w.library();
    assert!(ids(&back).contains(&original.as_str()));
    assert!(!ids(&back).contains(&edit.as_str()));
}

#[test]
fn an_album_counts_its_live_photographs_and_hands_its_cover_to_a_member() {
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
    let library = w.library();
    let row = &library.albums[0];
    assert_eq!((row.title.as_deref(), row.photo_count), (Some("Summer"), 2));
    assert_eq!(
        row.cover_content_id,
        Some(centraid_vault::blob::content_digest(b"b"))
    );
    // The cover leaves the album: the album shows its first photograph instead.
    w.ok(
        "edge.remove",
        json!({ "from": album, "rel": "contains", "to": b }),
    );
    let library = w.library();
    assert_eq!(library.albums[0].photo_count, 1);
    assert_eq!(
        library.albums[0].cover_content_id,
        Some(centraid_vault::blob::content_digest(b"a"))
    );
    assert_eq!(
        library
            .photos
            .iter()
            .find(|g| g.photo.photo_id == a)
            .expect("a")
            .album_titles,
        ["Summer"]
    );
    // A trashed member is not counted, and comes back with the album's order.
    w.ok("entity.trash", json!({ "id": a }));
    assert_eq!(w.library().albums[0].photo_count, 0);
    w.ok("entity.restore", json!({ "id": a }));
    assert_eq!(w.library().albums[0].photo_count, 1);
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
    let named = w.library();
    let found = named.photos[0].place.as_ref().expect("a place");
    assert_eq!(
        (found.name.as_str(), found.gazetteer.as_deref()),
        ("Pier 39", Some("San Francisco"))
    );
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
                Ok(load_search_term(
                    &TestDoor::new(connection),
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
        duplicate_clusters(door, |prints: &[Fingerprint]| {
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
