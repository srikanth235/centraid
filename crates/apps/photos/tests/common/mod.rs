//! The world every Photos test founds: a vault the product founds, filled by Photos'
//! own commands, and read through the same paged door a phone's core reads through.

#![allow(dead_code)]

use std::sync::Arc;

use centraid_apps_kit::testdoor::TestDoor;
use centraid_apps_photos::queries::{LibraryInput, load_library};
use centraid_vault::clock::{FixedClock, SeededIds};
use centraid_vault::commands::Registry;
use centraid_vault::{Command, CommandStatus, Principal, Vault};
use serde_json::json;

pub struct World {
    dir: std::path::PathBuf,
    pub vault: Vault,
    pub clock: Arc<FixedClock>,
    pub registry: Registry,
}

impl Drop for World {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl World {
    pub fn new() -> Self {
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

    pub fn ok(&self, name: &str, input: serde_json::Value) -> serde_json::Value {
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

    pub fn photo(&self, seed: &str, extra: serde_json::Value) -> String {
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

    pub fn album(&self, title: &str) -> String {
        self.ok(
            "container.create",
            json!({ "kind": "album", "title": title }),
        )["id"]
            .as_str()
            .expect("an id")
            .to_owned()
    }

    pub fn read<T>(&self, body: impl FnOnce(&TestDoor<'_>) -> T) -> T {
        self.vault
            .read(|c| Ok(body(&TestDoor::new(c))))
            .expect("a read")
    }

    pub fn library(&self) -> centraid_apps_photos::LibraryData {
        let now = centraid_vault::time::recurrence::parse_instant_ms("2026-01-02T00:00:00.000Z")
            .expect("an instant");
        self.read(|door| load_library(door, &LibraryInput::default(), now).expect("reads"))
    }
}

pub struct Library {
    pub w: World,
    pub old: String,
    pub new: String,
    pub undated_a: String,
    pub undated_b: String,
    pub archived: String,
    pub trashed: String,
    pub both: String,
    pub movie: String,
    pub original: String,
    pub edit: String,
    pub album: String,
    pub place_a: String,
    pub place_b: String,
}

pub fn library() -> Library {
    let w = World::new();
    let old = w.photo(
        "old",
        json!({ "taken_at": "2025-01-01T00:00:00.000Z", "title": "Old", "lat": 37.7955, "lon": -122.3937 }),
    );
    let new = w.photo(
        "new",
        json!({ "taken_at": "2025-06-01T00:00:00.000Z", "lat": 37.7955, "lon": -122.3937 }),
    );
    let undated_a = w.photo("undated-a", json!({}));
    let undated_b = w.photo("undated-b", json!({}));
    let archived = w.photo(
        "archived",
        json!({ "taken_at": "2025-07-01T00:00:00.000Z" }),
    );
    let trashed = w.photo("trashed", json!({ "taken_at": "2025-08-01T00:00:00.000Z" }));
    let both = w.photo("both", json!({ "taken_at": "2025-09-01T00:00:00.000Z" }));
    let movie = w.photo(
        "movie",
        json!({ "taken_at": "2025-05-01T00:00:00.000Z", "form": "video", "media_type": "video/mp4", "duration_s": 3.5 }),
    );
    let original = w.photo(
        "original",
        json!({ "taken_at": "2025-04-01T00:00:00.000Z", "burst": "b1" }),
    );
    let edit = w.photo(
        "edit",
        json!({ "taken_at": "2025-04-01T00:00:00.000Z", "burst": "b1", "edited_from": original, "lat": 48.8584, "lon": 2.2945 }),
    );
    let album = w.album("Summer");
    for member in [&old, &archived, &trashed, &undated_a] {
        w.ok(
            "edge.add",
            json!({ "from": album, "rel": "contains", "to": member }),
        );
    }
    w.ok("flag.set", json!({ "id": new, "flag": "starred" }));
    w.ok("flag.set", json!({ "id": archived, "flag": "archived" }));
    w.ok("flag.set", json!({ "id": both, "flag": "archived" }));
    w.ok("entity.trash", json!({ "id": trashed }));
    w.ok("entity.trash", json!({ "id": both }));
    let places = w.read(|door| centraid_apps_photos::places::read_places(door).expect("places"));
    let place_of = |lat: f64| {
        places
            .iter()
            .find(|place| place.lat.is_some_and(|l| (l - lat).abs() < 0.01))
            .expect("a place")
            .place_id
            .clone()
    };
    let (place_a, place_b) = (place_of(37.7955), place_of(48.8584));
    Library {
        w,
        old,
        new,
        undated_a,
        undated_b,
        archived,
        trashed,
        both,
        movie,
        original,
        edit,
        album,
        place_a,
        place_b,
    }
}
