//! A document's and a photograph's own verbs, against a vault with a content
//! store: what is added, what a replace keeps, what the same bytes are, what a
//! place and an album do, and how the files follower merges a folder.
//! The trash, the stars, the tags, the albums' membership and the folders are
//! the shared verbs and are proved in `shared_verbs.rs`; here they are the way a
//! test arranges the state a verb of these two kinds is asked about.

mod common;

use centraid_vault::commands::Registry;
use centraid_vault::{Command, CommandStatus, Principal};
use serde_json::json;

struct World {
    scratch: common::Scratch,
    registry: Registry,
}

impl World {
    fn new() -> Self {
        Self {
            scratch: common::Scratch::founded_with_blobs("docs-photos").expect("a vault"),
            registry: Registry::with_system_commands().expect("a registry"),
        }
    }

    fn run(&self, name: &str, input: serde_json::Value) -> centraid_vault::CommandOutcome {
        self.scratch
            .vault
            .execute(
                &self.registry,
                &Principal::owner("phone"),
                &Command::new(name, input),
            )
            .unwrap_or_else(|error| panic!("`{name}`: {error}"))
    }

    fn ok(&self, name: &str, input: serde_json::Value) -> serde_json::Value {
        let outcome = self.run(name, input);
        assert_eq!(
            outcome.status,
            CommandStatus::Executed,
            "{name}: {:?}",
            outcome.reason
        );
        outcome.output
    }

    fn refused(&self, name: &str, input: serde_json::Value) -> String {
        let outcome = self.run(name, input);
        assert_eq!(
            outcome.status,
            CommandStatus::Failed,
            "{name} was not refused"
        );
        outcome.reason.expect("a sentence")
    }

    fn one<T: rusqlite::types::FromSql>(&self, sql: &str, params: &[&str]) -> T {
        self.scratch
            .vault
            .read(|c| Ok(c.query_row(sql, rusqlite::params_from_iter(params), |r| r.get(0))?))
            .expect("a row")
    }

    /// Bytes the stage door would have claimed: a hash and a size.
    fn bytes(&self, seed: &str) -> String {
        let hash = centraid_vault::blob::content_digest(seed.as_bytes());
        self.ok("blob.stage", json!({ "hash": hash, "size": seed.len() }));
        hash
    }

    fn document(&self, title: &str, seed: &str, folder: Option<&str>) -> String {
        let blob = self.bytes(seed);
        self.ok(
            "document.add",
            json!({ "title": title, "blob": blob, "media_type": "application/pdf",
                     "folder_id": folder }),
        )["id"]
            .as_str()
            .expect("an id")
            .to_owned()
    }

    fn folder(&self, title: &str, parent: Option<&str>) -> String {
        self.ok(
            "container.create",
            json!({ "kind": "folder", "title": title, "parent": parent }),
        )["id"]
            .as_str()
            .expect("an id")
            .to_owned()
    }

    fn photo(&self, seed: &str, extra: serde_json::Value) -> serde_json::Value {
        let mut input = json!({ "blob": self.bytes(seed), "media_type": "image/jpeg" });
        for (key, value) in extra.as_object().expect("an object") {
            input[key] = value.clone();
        }
        self.ok("photo.add", input)
    }

    fn hits(&self, term: &str, id: &str) -> i64 {
        self.one(
            "SELECT COUNT(*) FROM search s JOIN entity e ON e.n = s.rowid
              WHERE search MATCH ?1 AND e.id = ?2",
            &[term, id],
        )
    }
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

#[test]
fn identity_is_the_wrapper_two_documents_may_share_their_bytes() {
    let w = World::new();
    let a = w.document("Lease", "the same pages", None);
    let b = w.document("Lease copy", "the same pages", None);
    assert_ne!(a, b);
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM blob", &[]), 1);
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(DISTINCT blob) FROM document WHERE id IN (?1, ?2)",
            &[&a, &b]
        ),
        1
    );
}

#[test]
fn a_document_over_bytes_that_never_arrived_is_refused_with_a_sentence() {
    let w = World::new();
    let sentence = w.refused(
        "document.add",
        json!({ "title": "Ghost", "blob": "ab".repeat(32), "media_type": "text/plain" }),
    );
    assert!(sentence.contains("have not arrived"), "{sentence}");
    let folder = w.folder("Taxes", None);
    w.ok("entity.trash", json!({ "id": folder }));
    let sentence = w.refused(
        "document.add",
        json!({ "title": "Late", "blob": w.bytes("x"), "media_type": "text/plain",
                 "folder_id": folder }),
    );
    assert!(sentence.contains("trash"), "{sentence}");
}

#[test]
fn replacing_keeps_the_old_bytes_as_a_version_and_a_restore_keeps_what_it_replaced() {
    let w = World::new();
    let id = w.document("Scan", "first scan", None);
    let first = w.one::<String>("SELECT blob FROM document WHERE id = ?1", &[&id]);
    let second = w.bytes("second scan");
    w.ok("document.replace", json!({ "id": id, "blob": second }));
    assert_eq!(
        w.one::<String>(
            "SELECT blob FROM revision WHERE entity_id = ?1 AND seq = 1",
            &[&id]
        ),
        first
    );
    assert_eq!(
        w.one::<String>("SELECT blob FROM document WHERE id = ?1", &[&id]),
        second
    );
    // The same bytes again revise nothing.
    w.ok("document.replace", json!({ "id": id, "blob": second }));
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM revision WHERE entity_id = ?1", &[&id]),
        1
    );
    // Restoring version 1 writes the current bytes as version 2.
    w.ok("document.restore_version", json!({ "id": id, "seq": 1 }));
    assert_eq!(
        w.one::<String>("SELECT blob FROM document WHERE id = ?1", &[&id]),
        first
    );
    assert_eq!(
        w.one::<String>(
            "SELECT blob FROM revision WHERE entity_id = ?1 AND seq = 2",
            &[&id]
        ),
        second
    );
    let sentence = w.refused("document.restore_version", json!({ "id": id, "seq": 9 }));
    assert!(
        sentence.contains("not in this document's history"),
        "{sentence}"
    );
    // A trashed document is frozen, and its bytes survive a collection.
    w.ok("entity.trash", json!({ "id": id }));
    assert!(
        w.refused("document.replace", json!({ "id": id, "blob": second }))
            .contains("trash")
    );
    assert!(
        w.ok("blob.collect", json!({}))["collected"]
            .as_array()
            .expect("a list")
            .is_empty()
    );
}

#[test]
fn the_words_a_phone_read_out_of_a_file_are_what_it_is_found_by() {
    let w = World::new();
    let blob = w.bytes("scanned lease");
    let id = w.ok(
        "document.add",
        json!({ "title": "Scan 0041", "blob": blob, "media_type": "application/pdf",
                 "text": "monthly rent is due on the first" }),
    )["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    assert_eq!(w.hits("rent", &id), 1);
    // A title found it before, and a replace brings its own words.
    let next = w.bytes("rescanned lease");
    w.ok(
        "document.replace",
        json!({ "id": id, "blob": next, "text": "deposit refunded" }),
    );
    assert_eq!(w.hits("rent", &id), 0);
    assert_eq!(w.hits("deposit", &id), 1);
}

#[test]
fn a_lapsed_grace_window_is_not_restorable() {
    let w = World::new();
    let id = w.document("Old lease", "old", None);
    w.ok("entity.trash", json!({ "id": id }));
    w.scratch.clock.advance_ms(30 * 86_400_000 - 1);
    w.ok("entity.restore", json!({ "id": id }));
    w.ok("entity.trash", json!({ "id": id }));
    w.scratch.clock.advance_ms(30 * 86_400_000);
    let sentence = w.refused("entity.restore", json!({ "id": id }));
    assert!(sentence.contains("grace window"), "{sentence}");
    // It waits for "delete forever", which has no window.
    w.ok("entity.purge", json!({ "id": id }));
}

#[test]
fn text_is_written_through_the_blob_door_and_found_by_its_words() {
    let w = World::new();
    let id = w.ok(
        "document.create_text",
        json!({ "title": "Packing", "body_text": "passport and sunscreen" }),
    )["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    assert_eq!(w.hits("sunscreen", &id), 1);
    w.ok(
        "document.edit",
        json!({ "id": id, "body_text": "passport and umbrella" }),
    );
    assert_eq!(w.hits("sunscreen", &id), 0);
    assert_eq!(w.hits("umbrella", &id), 1);
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM revision WHERE entity_id = ?1", &[&id]),
        1,
        "the words that were replaced are version one"
    );
    // A title alone edits no bytes and a PDF's words are not written in place.
    w.ok(
        "document.edit",
        json!({ "id": id, "title": "Packing list" }),
    );
    assert_eq!(
        w.one::<String>("SELECT title FROM entity WHERE id = ?1", &[&id]),
        "Packing list"
    );
    let pdf = w.document("Scan", "pages", None);
    assert!(
        w.refused("document.edit", json!({ "id": pdf, "body_text": "x" }))
            .contains("text")
    );
    let big = "x".repeat(64 * 1024 + 1);
    assert!(
        w.refused("document.edit", json!({ "id": id, "body_text": big }))
            .contains("budget")
    );
}

#[test]
fn a_document_is_filed_moved_and_comes_back_to_its_folder() {
    let w = World::new();
    let (taxes, trips) = (w.folder("Taxes", None), w.folder("Trips", None));
    let id = w.document("Return", "return", Some(&taxes));
    w.ok("document.move", json!({ "id": id, "folder_id": trips }));
    assert_eq!(
        w.one::<String>("SELECT folder_id FROM document WHERE id = ?1", &[&id]),
        trips
    );
    w.ok("document.move", json!({ "id": id }));
    assert_eq!(
        w.one::<Option<String>>("SELECT folder_id FROM document WHERE id = ?1", &[&id]),
        None
    );
    w.ok("document.move", json!({ "id": id, "folder_id": taxes }));
    // The folder takes its documents and its folders to the trash and back.
    let nested = w.folder("2025", Some(&taxes));
    let inner = w.document("W-2", "w2", Some(&nested));
    w.ok("entity.trash", json!({ "id": taxes }));
    for gone in [&id, &nested, &inner] {
        assert!(
            w.one::<Option<String>>("SELECT deleted_at FROM entity WHERE id = ?1", &[gone])
                .is_some(),
            "{gone} went with the folder"
        );
    }
    w.ok("entity.restore", json!({ "id": taxes }));
    for back in [&id, &nested, &inner] {
        assert!(
            w.one::<Option<String>>("SELECT deleted_at FROM entity WHERE id = ?1", &[back])
                .is_none(),
            "{back} came back with the folder"
        );
    }
    // A purge takes what went with it; a document restored on its own is kept.
    w.ok("entity.trash", json!({ "id": taxes }));
    w.ok("entity.restore", json!({ "id": id }));
    w.ok("entity.purge", json!({ "id": taxes }));
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM entity WHERE id IN (?1, ?2, ?3)",
            &[&taxes, &nested, &inner]
        ),
        0
    );
    assert_eq!(
        w.one::<Option<String>>("SELECT folder_id FROM document WHERE id = ?1", &[&id]),
        None
    );
}

// ---------------------------------------------------------------------------
// Photographs, places and albums
// ---------------------------------------------------------------------------

#[test]
fn the_same_bytes_are_one_photograph_and_a_re_upload_restores_it() {
    let w = World::new();
    let first = w.photo("sunset", json!({ "title": "Sunset" }));
    assert_eq!(first["deduped"], json!(false));
    let id = first["id"].as_str().expect("an id").to_owned();
    w.ok("entity.trash", json!({ "id": id }));
    let again = w.photo("sunset", json!({}));
    assert_eq!(again["id"], json!(id));
    assert_eq!(again["deduped"], json!(true));
    assert!(
        w.one::<Option<String>>("SELECT deleted_at FROM entity WHERE id = ?1", &[&id])
            .is_none()
    );
    assert_eq!(
        w.one::<String>("SELECT title FROM entity WHERE id = ?1", &[&id]),
        "Sunset"
    );
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM photo", &[]), 1);
    // The form follows the bytes, and sound is Docs'.
    let film = w.ok(
        "photo.add",
        json!({ "blob": w.bytes("film"), "media_type": "video/mp4", "duration_s": 3.5 }),
    );
    assert_eq!(
        w.one::<String>(
            "SELECT form FROM photo WHERE id = ?1",
            &[film["id"].as_str().expect("an id")]
        ),
        "video"
    );
    let sentence = w.refused(
        "photo.add",
        json!({ "blob": w.bytes("song"), "media_type": "audio/mpeg" }),
    );
    assert!(sentence.contains("Docs"), "{sentence}");
}

#[test]
fn an_edit_keeps_the_originals_date_place_and_caption() {
    let w = World::new();
    let place = w.ok(
        "place.add",
        json!({ "title": "The cabin", "lat": 61.0, "lon": 7.0 }),
    )["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    let original = w.photo(
        "original",
        json!({ "title": "Lake", "taken_at": "2025-07-01T10:00:00.000Z", "offset_min": 120,
                 "place_id": place }),
    )["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    let edit = w.ok(
        "photo.add",
        json!({ "blob": w.bytes("cropped"), "media_type": "image/jpeg", "edited_from": original }),
    )["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    assert_eq!(
        w.one::<String>("SELECT title FROM entity WHERE id = ?1", &[&edit]),
        "Lake"
    );
    assert_eq!(
        w.one::<String>("SELECT taken_at FROM photo WHERE id = ?1", &[&edit]),
        "2025-07-01T10:00:00.000Z"
    );
    assert_eq!(
        w.one::<String>("SELECT place_id FROM photo WHERE id = ?1", &[&edit]),
        place
    );
    // Said outright, the editor's own values win; lineage never loops.
    let own = w.ok(
        "photo.add",
        json!({ "blob": w.bytes("filtered"), "media_type": "image/jpeg",
                 "edited_from": original, "title": "Lake, warm", "taken_at": "2025-07-02T00:00:00.000Z" }),
    )["id"].as_str().expect("an id").to_owned();
    assert_eq!(
        w.one::<String>("SELECT title FROM entity WHERE id = ?1", &[&own]),
        "Lake, warm"
    );
    let sentence = w.refused("photo.edit", json!({ "id": original, "edited_from": edit }));
    assert!(sentence.contains("its own edit"), "{sentence}");
    w.ok(
        "photo.edit",
        json!({ "id": edit, "taken_at": null, "offset_min": -60 }),
    );
    assert_eq!(
        w.one::<Option<String>>("SELECT taken_at FROM photo WHERE id = ?1", &[&edit]),
        None
    );
    assert_eq!(
        w.one::<i64>("SELECT offset_min FROM photo WHERE id = ?1", &[&edit]),
        -60
    );
}

#[test]
fn coordinates_find_the_place_the_member_named_before_they_found_a_new_one() {
    let w = World::new();
    let a = w.photo("a", json!({ "lat": 48.8584, "lon": 2.2945 }))["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    let place = w.one::<String>("SELECT place_id FROM photo WHERE id = ?1", &[&a]);
    assert_eq!(
        w.one::<String>("SELECT title FROM entity WHERE id = ?1", &[&place]),
        "48.8584, 2.2945"
    );
    // A burst at the same spot is one place; a coordinate label is no name to adopt.
    let b = w.photo("b", json!({ "lat": 48.85841, "lon": 2.29449 }))["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    assert_eq!(
        w.one::<String>("SELECT place_id FROM photo WHERE id = ?1", &[&b]),
        place
    );
    // The member names it, and a photograph taken in its garden adopts it.
    w.ok(
        "entity.retitle",
        json!({ "id": place, "title": "Tour Eiffel" }),
    );
    let c = w.photo("c", json!({ "lat": 48.8590, "lon": 2.2950 }))["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    assert_eq!(
        w.one::<String>("SELECT place_id FROM photo WHERE id = ?1", &[&c]),
        place
    );
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM place", &[]), 1);
    // A photograph is found by its place's name and the gazetteer's locality.
    assert_eq!(w.hits("eiffel", &a), 1);
    w.ok("place.locate", json!({ "id": place, "locality": "Paris" }));
    assert_eq!(w.hits("paris", &c), 1);
    w.ok("place.locate", json!({ "id": place, "locality": null }));
    assert_eq!(w.hits("paris", &c), 0);
    // Clearing a photograph's place is `photo.set_place` with none.
    w.ok("photo.set_place", json!({ "id": c }));
    assert_eq!(w.hits("eiffel", &c), 0);
    // A place is not a thing a photograph can be set to be.
    assert!(
        w.refused("photo.set_place", json!({ "id": c, "place_id": a }))
            .contains("not a place")
    );
}

#[test]
fn a_caption_is_found_and_an_album_keeps_its_cover_while_the_photograph_is_there() {
    let w = World::new();
    let id = w.photo("beach", json!({}))["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    let blob = w.one::<String>("SELECT blob FROM photo WHERE id = ?1", &[&id]);
    w.ok(
        "derivative.write",
        json!({ "blob": blob, "variant": "caption", "text": "dog on a beach" }),
    );
    assert_eq!(w.hits("dog", &id), 1);
    let album = w.ok(
        "container.create",
        json!({ "kind": "album", "title": "Summer" }),
    )["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    let other = w.photo("pier", json!({}))["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    for photo in [&other, &id] {
        w.ok(
            "edge.add",
            json!({ "from": album, "rel": "contains", "to": photo }),
        );
    }
    w.ok("album.set_cover", json!({ "id": album, "photo_id": id }));
    assert_eq!(
        w.one::<String>("SELECT cover FROM container WHERE id = ?1", &[&album]),
        blob
    );
    let outsider = w.photo("city", json!({}))["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    assert!(
        w.refused(
            "album.set_cover",
            json!({ "id": album, "photo_id": outsider })
        )
        .contains("not in")
    );
    // Trash keeps the album's places; a purge clears the cover and frees the bytes.
    w.ok("entity.trash", json!({ "id": id }));
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM edge WHERE to_id = ?1", &[&id]),
        1
    );
    let purged = w.ok("entity.purge", json!({ "id": id }));
    assert_eq!(
        w.one::<Option<String>>("SELECT cover FROM container WHERE id = ?1", &[&album]),
        None
    );
    // The purge collects what nothing names any more, inside its own commit.
    assert!(
        purged["released"]
            .as_array()
            .expect("a list")
            .iter()
            .any(|hash| hash.as_str() == Some(&blob))
    );
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM blob WHERE hash = ?1", &[&blob]),
        0
    );
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM derivative WHERE blob = ?1", &[&blob]),
        0
    );
}

// ---------------------------------------------------------------------------
// The files follower
// ---------------------------------------------------------------------------

fn files(w: &World, folder: &str, complete: bool, records: serde_json::Value) -> serde_json::Value {
    w.ok(
        "follow.files",
        json!({ "origin": { "ref": "/Documents/Taxes", "label": "Taxes", "fills": folder },
                 "records": records, "complete": complete }),
    )
}

fn file(w: &World, path: &str, title: &str, seed: &str) -> serde_json::Value {
    json!({ "external_id": path, "fields": {
        "title": title, "blob": w.bytes(seed), "media_type": "application/pdf",
        "stat": format!("{}:1", seed.len()) } })
}

#[test]
fn a_followed_folder_fills_its_folder_and_a_changed_file_is_a_new_version() {
    let w = World::new();
    let folder = w.folder("Taxes", None);
    let first = files(
        &w,
        &folder,
        true,
        json!([
            file(&w, "/a.pdf", "a.pdf", "a v1"),
            file(&w, "/b.pdf", "b.pdf", "b v1")
        ]),
    );
    assert_eq!(first["added"], json!(2));
    let a = w.one::<String>(
        "SELECT entity_id FROM source WHERE external_id = '/a.pdf'",
        &[],
    );
    assert_eq!(
        w.one::<String>("SELECT folder_id FROM document WHERE id = ?1", &[&a]),
        folder
    );
    // The file changed on the phone: its old bytes are version one.
    let v1 = w.one::<String>("SELECT blob FROM document WHERE id = ?1", &[&a]);
    let second = files(
        &w,
        &folder,
        true,
        json!([
            file(&w, "/a.pdf", "a.pdf", "a v2"),
            file(&w, "/b.pdf", "b.pdf", "b v1")
        ]),
    );
    assert_eq!(
        (second["updated"].clone(), second["unchanged"].clone()),
        (json!(1), json!(1))
    );
    assert_eq!(
        w.one::<String>(
            "SELECT blob FROM revision WHERE entity_id = ?1 AND seq = 1",
            &[&a]
        ),
        v1
    );
    // The member replaced b by hand: the phone's next word does not undo it.
    let b = w.one::<String>(
        "SELECT entity_id FROM source WHERE external_id = '/b.pdf'",
        &[],
    );
    w.ok(
        "document.replace",
        json!({ "id": b, "blob": w.bytes("b mine") }),
    );
    files(
        &w,
        &folder,
        true,
        json!([
            file(&w, "/a.pdf", "a.pdf", "a v2"),
            file(&w, "/b.pdf", "b.pdf", "b v2")
        ]),
    );
    assert_eq!(
        w.one::<String>("SELECT blob FROM document WHERE id = ?1", &[&b]),
        w.bytes("b mine")
    );
    // The phone's pre-check is in the statement, and is never mistaken for an edit.
    assert_eq!(
        w.one::<String>(
            "SELECT json_extract(stated, '$.stat') FROM source WHERE external_id = '/a.pdf'",
            &[]
        ),
        "4:1"
    );
    // A file gone from a complete read goes to the trash if never touched, and is
    // kept (its source forgotten) if the member changed it.
    let third = files(&w, &folder, true, json!([]));
    assert_eq!(
        (third["trashed"].clone(), third["forgotten"].clone()),
        (json!(1), json!(1))
    );
    assert!(
        w.one::<Option<String>>("SELECT deleted_at FROM entity WHERE id = ?1", &[&a])
            .is_some()
    );
    assert!(
        w.one::<Option<String>>("SELECT deleted_at FROM entity WHERE id = ?1", &[&b])
            .is_none()
    );
}
