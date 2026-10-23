//! PHOTOS' SCREENS READ AND WRITE THROUGH THE ONE DOOR (#1135): every read a Photos
//! screen draws is a `load`, every write an `act`, each by the name the manifest
//! declares and with the input a screen sends. The cases drive `Handle::call` the
//! way a shell, the chat and the harness do, over a vault the product founds.

use std::collections::HashMap;
use std::sync::Arc;

use centraid_api_proto::core_v1 as wire;
use centraid_core::{Core, CoreConfig, CoreError, Handle};
use centraid_vault::clock::{ClockIds, FixedClock};
use serde_json::json;

type Answer = wire::app_query_response::Answer;

const SEPARATOR: char = '\u{1f}';

struct World {
    dir: std::path::PathBuf,
    handle: Handle,
    writes: std::cell::Cell<u32>,
}

impl Drop for World {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn text(value: &str) -> wire::Value {
    wire::Value {
        kind: Some(wire::value::Kind::Text(value.to_owned())),
    }
}

fn int(value: i64) -> wire::Value {
    wire::Value {
        kind: Some(wire::value::Kind::Integer(value)),
    }
}

impl World {
    fn founded() -> Self {
        let dir = centraid_ontology::scratch::scratch_dir();
        std::fs::create_dir_all(&dir).expect("a directory");
        let start = centraid_vault::time::recurrence::parse_instant_ms("2026-01-02T00:00:00.000Z")
            .expect("an instant");
        let clock = Arc::new(FixedClock::at(start));
        let handle = Core::open(
            CoreConfig::new(dir.join("vault.db"))
                .with_clock(clock.clone(), Arc::new(ClockIds::new(Box::new(clock)))),
        )
        .expect("it opens");
        handle
            .with_vault(|vault| Ok(vault.found("Photos", "Owner")?))
            .expect("it founds");
        Self {
            dir,
            handle,
            writes: std::cell::Cell::new(0),
        }
    }

    fn command(&self, name: &str, input: serde_json::Value) -> serde_json::Value {
        self.writes.set(self.writes.get() + 1);
        let response = self
            .handle
            .call(&wire::Request {
                kind: Some(wire::request::Kind::Command(wire::Command {
                    name: name.to_owned(),
                    input: serde_json::to_vec(&input).expect("json"),
                    invoke_key: format!("photos-screens-setup-{}", self.writes.get()),
                    ..wire::Command::default()
                })),
            })
            .unwrap_or_else(|error| panic!("{name} refused: {error}"));
        let Some(wire::response::Kind::Command(outcome)) = response.kind else {
            panic!("a command answered with something else");
        };
        assert_eq!(
            outcome.status,
            wire::CommandStatus::Executed as i32,
            "{name}: {}",
            outcome.reason
        );
        serde_json::from_slice(&outcome.output).expect("the output is JSON")
    }

    fn photo(&self, seed: &str, extra: serde_json::Value) -> String {
        let hash = centraid_vault::blob::content_digest(seed.as_bytes());
        self.command("blob.stage", json!({ "hash": hash, "size": seed.len() }));
        let mut input = json!({ "blob": hash, "media_type": "image/jpeg", "form": "photo" });
        for (key, value) in extra.as_object().expect("an object") {
            input[key] = value.clone();
        }
        self.command("photo.add", input)["id"]
            .as_str()
            .expect("an id")
            .to_owned()
    }

    fn load(
        &self,
        query: &str,
        limit: u32,
        after: &str,
        pairs: &[(&str, wire::Value)],
    ) -> Result<wire::LoadResponse, CoreError> {
        let params: HashMap<String, wire::Value> = pairs
            .iter()
            .map(|(name, value)| ((*name).to_owned(), value.clone()))
            .collect();
        match self
            .handle
            .call(&wire::Request {
                kind: Some(wire::request::Kind::Load(Box::new(wire::LoadRequest {
                    app: "photos".to_owned(),
                    query: query.to_owned(),
                    zone: "UTC".to_owned(),
                    limit,
                    after: after.to_owned(),
                    params,
                }))),
            })?
            .kind
        {
            Some(wire::response::Kind::Load(loaded)) => Ok(*loaded),
            other => panic!("a load answered {other:?}"),
        }
    }

    fn answer(
        &self,
        query: &str,
        limit: u32,
        after: &str,
        pairs: &[(&str, wire::Value)],
    ) -> Answer {
        self.load(query, limit, after, pairs)
            .unwrap_or_else(|error| panic!("photos.{query}: {error}"))
            .answer
            .and_then(|answer| answer.answer)
            .expect("an answer")
    }

    fn shelf(&self, view: &str, id: &str, limit: u32, after: &str) -> wire::PhotosShelf {
        let mut pairs = vec![("view", text(view))];
        if !id.is_empty() {
            pairs.push(("id", text(id)));
        }
        match self.answer("shelf", limit, after, &pairs) {
            Answer::PhotosShelf(shelf) => *shelf,
            other => panic!("a shelf answered {other:?}"),
        }
    }

    fn act(
        &self,
        action: &str,
        input: &[(&str, wire::Value)],
    ) -> Result<wire::ActResponse, CoreError> {
        self.writes.set(self.writes.get() + 1);
        let input: HashMap<String, wire::Value> = input
            .iter()
            .map(|(name, value)| ((*name).to_owned(), value.clone()))
            .collect();
        match self
            .handle
            .call(&wire::Request {
                kind: Some(wire::request::Kind::Act(Box::new(wire::ActRequest {
                    app: "photos".to_owned(),
                    action: action.to_owned(),
                    input,
                    invoke_key: format!("photos-screens-act-{}", self.writes.get()),
                }))),
            })?
            .kind
        {
            Some(wire::response::Kind::Act(done)) => Ok(*done),
            other => panic!("an act answered {other:?}"),
        }
    }

    fn done(&self, action: &str, input: &[(&str, wire::Value)]) -> wire::ActResponse {
        let done = self
            .act(action, input)
            .unwrap_or_else(|error| panic!("{action}: {error}"));
        assert_eq!(
            done.status,
            wire::ActStatus::Executed as i32,
            "{action}: {done:?}"
        );
        done
    }
}

fn ids(shelf: &wire::PhotosShelf) -> Vec<&str> {
    shelf
        .cells
        .iter()
        .map(|cell| cell.photo_id.as_str())
        .collect()
}

#[test]
fn a_shelf_pages_by_the_cursor_it_hands_back_through_after() {
    let w = World::founded();
    let mut all = Vec::new();
    for (index, seed) in ["a", "b", "c"].iter().enumerate() {
        all.push(w.photo(
            seed,
            json!({ "taken_at": format!("2025-0{}-01T00:00:00.000Z", index + 1) }),
        ));
    }
    let undated = w.photo("u", json!({}));
    let first = w.shelf("live", "", 2, "");
    assert_eq!(first.total, Some(4));
    assert_eq!(ids(&first), [all[2].as_str(), all[1].as_str()]);
    let next = first.next.expect("more");
    assert_eq!(next.sort_key, "2025-02-01T00:00:00.000Z");
    // The cursor goes back as `sort key U+001F id`, and the second page has no total.
    let after = format!("{}{SEPARATOR}{}", next.sort_key, next.id);
    let second = w.shelf("live", "", 2, &after);
    assert_eq!(second.total, None);
    assert_eq!(ids(&second), [all[0].as_str(), undated.as_str()]);
    assert!(second.next.is_none());
    // Inside the undated tail the sort key is empty.
    let tail = w.shelf("live", "", 1, &format!("{SEPARATOR}{undated}"));
    assert!(tail.cells.is_empty());
    // The cells carry the device's held columns; this vault holds no bytes.
    assert!(
        first
            .cells
            .iter()
            .all(|cell| cell.thumbnail_path.is_none() && !cell.original_held)
    );
    assert!(first.cells.iter().all(|cell| cell.byte_size == Some(1)));
}

#[test]
fn a_shelf_without_a_limit_or_a_needed_id_is_refused() {
    let w = World::founded();
    let refused = |result: Result<wire::LoadResponse, CoreError>| match result {
        Err(CoreError::InvalidRequest { .. }) => {}
        other => panic!("expected a refusal, got {other:?}"),
    };
    refused(w.load("shelf", 0, "", &[("view", text("live"))]));
    refused(w.load("shelf", 10, "", &[("view", text("album"))]));
    refused(w.load("shelf", 10, "", &[("view", text("sideways"))]));
    refused(w.load("shelf", 10, "no separator", &[("view", text("live"))]));
}

#[test]
fn archive_and_unarchive_are_each_others_inverse_and_move_a_photograph_between_shelves() {
    let w = World::founded();
    let a = w.photo("a", json!({ "taken_at": "2025-01-01T00:00:00.000Z" }));
    let archived = w.done(
        "archive-photo",
        &[("id", text(&a)), ("flag", text("archived"))],
    );
    let inverse = archived.inverse.expect("an archive can be taken back");
    assert_eq!(inverse.action, "unarchive-photo");
    assert!(w.shelf("live", "", 10, "").cells.is_empty());
    assert_eq!(ids(&w.shelf("archive", "", 10, "")), [a.as_str()]);
    // The undo is the inverse, sent back as an action.
    let input: Vec<(&str, wire::Value)> = inverse
        .input
        .iter()
        .map(|(name, value)| (name.as_str(), value.clone()))
        .collect();
    w.done(&inverse.action, &input);
    assert_eq!(ids(&w.shelf("live", "", 10, "")), [a.as_str()]);
    assert!(w.shelf("archive", "", 10, "").cells.is_empty());
    // The heart is its own action, and its flag is the one word `starred`.
    w.done("flag-photo", &[("id", text(&a)), ("flag", text("starred"))]);
    assert!(
        w.act(
            "flag-photo",
            &[("id", text(&a)), ("flag", text("archived"))]
        )
        .expect("the act is taken")
        .refusal
        .is_some(),
        "the archive is archive-photo's"
    );
    assert_eq!(ids(&w.shelf("favorites", "", 10, "")), [a.as_str()]);
}

#[test]
fn every_write_a_photos_screen_sends_is_an_action_with_the_input_it_sends() {
    let w = World::founded();
    let a = w.photo("a", json!({ "taken_at": "2025-01-01T00:00:00.000Z" }));
    let b = w.photo("b", json!({ "taken_at": "2025-01-02T00:00:00.000Z" }));
    // An album, its members, its cover, its rename.
    let created = w.done(
        "create-album",
        &[("kind", text("album")), ("title", text("Trip"))],
    );
    let output: serde_json::Value = serde_json::from_slice(&created.output).expect("json");
    let album = output["id"].as_str().expect("an id").to_owned();
    w.done(
        "add-to-album",
        &[
            ("from", text(&album)),
            ("rel", text("contains")),
            ("to", text(&a)),
        ],
    );
    w.done(
        "add-to-album",
        &[
            ("from", text(&album)),
            ("rel", text("contains")),
            ("to", text(&b)),
        ],
    );
    w.done(
        "set-album-cover",
        &[("id", text(&album)), ("photo_id", text(&b))],
    );
    w.done(
        "rename-album",
        &[("id", text(&album)), ("title", text("Trip 2"))],
    );
    let overview = match w.answer("albums", 0, "", &[]) {
        Answer::PhotosAlbums(albums) => *albums,
        other => panic!("{other:?}"),
    };
    assert_eq!(overview.albums.len(), 1);
    assert_eq!(overview.albums[0].title, "Trip 2");
    assert_eq!(overview.albums[0].count, 2);
    assert_eq!(
        overview.albums[0]
            .cover
            .as_ref()
            .map(|cover| cover.photo_id.as_str()),
        Some(b.as_str())
    );
    assert_eq!(overview.live.as_ref().map(|tile| tile.count), Some(2));
    // A label, and taking it away.
    w.done("tag-photo", &[("id", text(&a)), ("label", text("Beach"))]);
    let detail = match w.answer("photo", 0, "", &[("id", text(&a))]) {
        Answer::PhotosPhoto(photo) => photo.photo.expect("a photograph"),
        other => panic!("{other:?}"),
    };
    assert_eq!(detail.tags.len(), 1);
    assert_eq!(detail.albums[0].title, "Trip 2");
    w.done("untag-photo", &[("id", text(&a)), ("label", text("Beach"))]);
    // A caption, a date, a place.
    w.done(
        "retitle-photo",
        &[("id", text(&a)), ("title", text("Pier"))],
    );
    w.done(
        "edit-photo",
        &[
            ("id", text(&a)),
            ("taken_at", text("2025-03-01T00:00:00.000Z")),
        ],
    );
    // Deleting, restoring, purging: the trash shelf is what Empty Trash purges, per id.
    w.done("delete-photo", &[("id", text(&b))]);
    let trash = w.shelf("trash", "", 10, "");
    assert_eq!(ids(&trash), [b.as_str()]);
    assert_eq!(trash.total, Some(1));
    assert_eq!(trash.cells[0].purge_in_days, Some(30));
    w.done("restore-photo", &[("id", text(&b))]);
    w.done("delete-photo", &[("id", text(&b))]);
    // `purge-photo` is manifest-confirmed: the screen asks first, then the act runs.
    w.done("purge-photo", &[("id", text(&b))]);
    assert!(w.shelf("trash", "", 10, "").cells.is_empty());
    // An album goes to the trash overview and comes back with the restore.
    w.done("delete-album", &[("id", text(&album))]);
    let trashed = match w.answer("albums", 0, "", &[]) {
        Answer::PhotosAlbums(albums) => *albums,
        other => panic!("{other:?}"),
    };
    assert_eq!(trashed.trashed_albums.len(), 1);
    assert_eq!(trashed.trashed_albums[0].album_id, album);
    w.done("restore-album", &[("id", text(&album))]);
    // Removing a member.
    w.done(
        "remove-from-album",
        &[
            ("from", text(&album)),
            ("rel", text("contains")),
            ("to", text(&a)),
        ],
    );
}

#[test]
fn the_places_the_search_and_the_duplicates_answer_what_the_screens_draw() {
    let w = World::founded();
    let a = w.photo(
        "a",
        json!({ "taken_at": "2025-01-01T00:00:00.000Z", "lat": 37.7955, "lon": -122.3937,
                "phash": "ffff0000ffff0000", "title": "Pier day" }),
    );
    let b = w.photo("b", json!({ "phash": "ffff0000ffff0001" }));
    let places = match w.answer("places", 0, "", &[]) {
        Answer::PhotosPlaces(places) => places,
        other => panic!("{other:?}"),
    };
    assert_eq!(places.places.len(), 1);
    assert_eq!(places.places[0].count, 1);
    assert!(
        places.places[0].phrase.chars().all(|c| !c.is_ascii_digit())
            || places.places[0].name.is_some()
    );
    assert_eq!(places.unplaced, 1);
    // A blank term is the resting state; the words are the legs.
    let resting = match w.answer("search", 20, "", &[("term", text(""))]) {
        Answer::PhotosSearch(search) => search,
        other => panic!("{other:?}"),
    };
    assert!(resting.cells.is_empty());
    let found = match w.answer("search", 20, "", &[("term", text("no location"))]) {
        Answer::PhotosSearch(search) => search,
        other => panic!("{other:?}"),
    };
    assert_eq!(found.total_hits, 1);
    assert_eq!(found.cells[0].photo_id, b);
    assert_eq!(found.top_hits.len(), 1);
    // The duplicates carry their members as cells, and the overview counts the cluster.
    let duplicates = match w.answer("duplicates", 0, "", &[]) {
        Answer::PhotosDuplicates(duplicates) => duplicates,
        other => panic!("{other:?}"),
    };
    assert_eq!(duplicates.clusters.len(), 1);
    assert_eq!(duplicates.clusters[0].members.len(), 2);
    assert!(
        duplicates.clusters[0]
            .members
            .iter()
            .any(|member| member.photo_id == a)
    );
    let overview = match w.answer("albums", 0, "", &[]) {
        Answer::PhotosAlbums(albums) => *albums,
        other => panic!("{other:?}"),
    };
    assert_eq!(overview.duplicate_clusters, 1);
    assert_eq!(overview.places, 1);
    assert_eq!(overview.unplaced, 1);
    // The tables an answer was drawn from ride with it.
    let loaded = w.load("albums", 0, "", &[]).expect("loads");
    assert!(loaded.tables.iter().any(|table| table == "photo"));
    assert!(int(1).kind.is_some());
}
