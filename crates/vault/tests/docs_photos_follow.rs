//! The two followed stores of Docs and Photos on the engine with the product's own maps
//! (#1214): a picked folder of files (`files`, filling a folder of the vault) and the camera roll
//! (`camera_roll`, with tombstones). The engine's rules are proved with test maps in the
//! `follow_*.rs` files; here the maps of `document::FILES` and `photo::ROLL` carry them.

mod common;

use centraid_vault::commands::follow::{SYSTEMS, differences};
use centraid_vault::index::viewport;
use common::world::World;
use serde_json::{Value, json};

fn world(seed: &str) -> World {
    World {
        scratch: common::Scratch::founded_with_blobs(seed).expect("a vault"),
        registry: centraid_vault::commands::Registry::with_system_commands().expect("a registry"),
    }
}

fn id_of(value: &Value) -> String {
    value["id"].as_str().expect("an id").to_owned()
}

fn folder(w: &World, title: &str) -> String {
    id_of(&w.ok(
        "container.create",
        json!({ "kind": "folder", "title": title }),
    ))
}

fn trashed(w: &World, id: &str) -> bool {
    w.one::<Option<String>>("SELECT deleted_at FROM entity WHERE id = ?1", &[id])
        .is_some()
}

fn entity_of(w: &World, external: &str) -> String {
    w.one(
        "SELECT entity_id FROM source WHERE external_id = ?1",
        &[external],
    )
}

fn hash(seed: &str) -> String {
    centraid_vault::blob::content_digest(seed.as_bytes())
}

#[test]
fn the_product_registers_both_maps_and_the_lookups_name_what_they_fill_and_yield() {
    let systems: Vec<&str> = SYSTEMS.iter().map(|map| map.system).collect();
    assert!(systems.contains(&"files") && systems.contains(&"camera_roll"));
    let w = world("dpf_registered");
    assert_eq!(
        w.one::<String>(
            "SELECT fills_kind FROM origin_system WHERE code = 'files'",
            &[]
        ),
        "folder"
    );
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM source_shape WHERE system = 'camera_roll' AND entity_kind = 'photo'",
            &[]
        ),
        1
    );
    // The commands exist, and a map that yields a kind its system does not is refused.
    for command in ["follow.files", "follow.camera_roll"] {
        assert!(w.registry.names().contains(&command), "{command}");
    }
}

// ---------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------

fn files(w: &World, folder: &str, complete: bool, records: Vec<Value>) -> Value {
    w.ok(
        "follow.files",
        json!({ "origin": { "ref": "/Documents/Taxes", "label": "Taxes", "fills": folder,
                             "device_id": "phone-a" },
                 "records": records, "complete": complete }),
    )
}

fn file(path: &str, title: &str, seed: &str) -> Value {
    json!({ "external_id": path, "device_id": "phone-a", "size": seed.len(), "fields": {
        "title": title, "blob": hash(seed), "media_type": "application/pdf",
        "stat": format!("{}:1", seed.len()) } })
}

#[test]
fn a_followed_folder_fills_its_folder_and_a_changed_file_is_a_new_version() {
    let w = world("dpf_files");
    let taxes = folder(&w, "Taxes");
    let first = files(
        &w,
        &taxes,
        true,
        vec![
            file("/a.pdf", "a.pdf", "a v1"),
            file("/b.pdf", "b.pdf", "b v1"),
        ],
    );
    assert_eq!(first["added"], json!(2));
    let a = entity_of(&w, "/a.pdf");
    assert_eq!(
        w.one::<String>("SELECT parent_id FROM entity WHERE id = ?1", &[&a]),
        taxes,
        "the file sits in the folder the follow fills"
    );
    // Nothing the member typed is claimed as an arrival: a followed file is a source's.
    assert_eq!(
        w.one::<Option<String>>("SELECT arrived_via FROM entity WHERE id = ?1", &[&a]),
        None
    );
    // The file changed on the phone: its old bytes are an earlier version, kept by their slot.
    let v1 = w.one::<String>("SELECT blob FROM document WHERE id = ?1", &[&a]);
    let second = files(
        &w,
        &taxes,
        true,
        vec![
            file("/a.pdf", "a.pdf", "a v2"),
            file("/b.pdf", "b.pdf", "b v1"),
        ],
    );
    assert_eq!(
        (second["updated"].clone(), second["unchanged"].clone()),
        (json!(1), json!(1))
    );
    assert_eq!(
        w.one::<String>(
            "SELECT rb.slot FROM revision_blob rb WHERE rb.entity_id = ?1 AND rb.blob = ?2",
            &[&a, &v1]
        ),
        "blob"
    );
    assert_eq!(
        w.one::<String>(
            "SELECT r.actor FROM revision r JOIN revision_blob rb
               ON rb.entity_id = r.entity_id AND rb.seq = r.seq
              WHERE rb.blob = ?1",
            &[&v1]
        ),
        "store",
        "a pass commits as the store"
    );
    // The phone's pre-check is in the statement and is never mistaken for an edit.
    assert_eq!(
        w.one::<String>(
            "SELECT json_extract(stated, '$.stat') FROM source WHERE external_id = '/a.pdf'",
            &[]
        ),
        "4:1"
    );
    assert!(
        w.vault()
            .read(|c| differences(c, &a))
            .expect("a read")
            .is_empty()
    );
    // The member replaced b by hand: the phone's next word does not undo it.
    let b = entity_of(&w, "/b.pdf");
    let mine = hash("b mine");
    w.ok("blob.stage", json!({ "hash": mine, "size": 6 }));
    w.ok("document.replace", json!({ "id": b, "blob": mine }));
    files(
        &w,
        &taxes,
        true,
        vec![
            file("/a.pdf", "a.pdf", "a v2"),
            file("/b.pdf", "b.pdf", "b v2"),
        ],
    );
    assert_eq!(
        w.one::<String>("SELECT blob FROM document WHERE id = ?1", &[&b]),
        mine
    );
}

#[test]
fn a_member_rename_is_kept_and_what_the_phone_said_stays_readable() {
    let w = world("dpf_rename");
    let taxes = folder(&w, "Taxes");
    files(&w, &taxes, true, vec![file("/a.pdf", "a.pdf", "v1")]);
    let a = entity_of(&w, "/a.pdf");
    w.ok(
        "entity.retitle",
        json!({ "id": a, "title": "Taxes 2025.pdf" }),
    );
    let said = w.vault().read(|c| differences(c, &a)).expect("a read");
    assert_eq!(said.len(), 1);
    assert_eq!(said[0].field, "title");
    files(&w, &taxes, true, vec![file("/a.pdf", "b.pdf", "v1")]);
    assert_eq!(
        w.one::<String>("SELECT title FROM entity WHERE id = ?1", &[&a]),
        "Taxes 2025.pdf",
        "the member's name stands"
    );
    // Taking the phone's word brings it back, and it follows the next pass again.
    w.ok(
        "follow.take_stated",
        json!({ "entity": a, "field": "title" }),
    );
    assert_eq!(
        w.one::<String>("SELECT title FROM entity WHERE id = ?1", &[&a]),
        "b.pdf"
    );
    files(&w, &taxes, true, vec![file("/a.pdf", "c.pdf", "v1")]);
    assert_eq!(
        w.one::<String>("SELECT title FROM entity WHERE id = ?1", &[&a]),
        "c.pdf"
    );
}

#[test]
fn a_file_gone_from_the_phone_goes_to_the_trash_and_comes_back_with_it() {
    let w = world("dpf_gone");
    let taxes = folder(&w, "Taxes");
    files(
        &w,
        &taxes,
        true,
        vec![file("/a.pdf", "a.pdf", "a"), file("/b.pdf", "b.pdf", "b")],
    );
    let (a, b) = (entity_of(&w, "/a.pdf"), entity_of(&w, "/b.pdf"));
    // b was edited by the member; a was not.
    w.ok("entity.retitle", json!({ "id": b, "title": "Mine" }));
    let gone = files(&w, &taxes, true, vec![]);
    assert_eq!(
        (gone["trashed"].clone(), gone["forgotten"].clone()),
        (json!(1), json!(1))
    );
    assert!(trashed(&w, &a));
    assert!(
        !trashed(&w, &b),
        "an edited file is kept and its source forgotten"
    );
    // The file comes back: the follower's own trash is undone.
    let back = files(&w, &taxes, true, vec![file("/a.pdf", "a.pdf", "a")]);
    assert_eq!(back["restored"], json!(1));
    assert!(!trashed(&w, &a));
    // What the member trashed stays trashed whatever the phone says.
    w.ok("entity.trash", json!({ "id": a }));
    files(&w, &taxes, true, vec![file("/a.pdf", "a.pdf", "a")]);
    assert!(trashed(&w, &a));
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM entity WHERE kind = 'document'", &[]),
        2
    );
}

#[test]
fn a_followed_file_claims_its_bytes_in_the_command_and_a_read_that_lost_most_is_doubted() {
    let w = world("dpf_claim");
    let taxes = folder(&w, "Taxes");
    let unsized_record = json!({ "external_id": "/a.pdf", "device_id": "phone-a", "fields": {
        "title": "a.pdf", "blob": hash("never staged"), "media_type": "application/pdf" } });
    let origin = json!({ "ref": "/Documents/Taxes", "label": "Taxes", "fills": taxes,
                          "device_id": "phone-a" });
    // Without a size the pass cannot claim the bytes; with one it does, in its own commit.
    let sentence = w.refused(
        "follow.files",
        json!({ "origin": origin, "records": [unsized_record.clone()], "complete": true }),
    );
    assert!(sentence.contains("how large"), "{sentence}");
    let mut sized = unsized_record;
    sized["size"] = json!(25);
    sized["external_id"] = json!("/sized.pdf");
    sized["fields"]["blob"] = json!(hash("sized"));
    w.ok(
        "follow.files",
        json!({ "origin": origin, "records": [sized], "complete": false }),
    );
    assert_eq!(
        w.one::<i64>("SELECT size FROM blob WHERE hash = ?1", &[&hash("sized")]),
        25
    );
    // Six files read, then a complete read of one: five lost of six is a glitch, not a delete.
    let many: Vec<Value> = (0..6)
        .map(|i| {
            file(
                &format!("/{i}.pdf"),
                &format!("{i}.pdf"),
                &format!("file {i}"),
            )
        })
        .collect();
    files(&w, &taxes, false, many);
    let tally = files(&w, &taxes, true, vec![file("/0.pdf", "0.pdf", "file 0")]);
    assert_eq!(
        (tally["trashed"].as_i64(), tally["doubted"].as_i64()),
        (Some(0), Some(6)),
        "{tally}"
    );
}

// ---------------------------------------------------------------------------------------------
// The camera roll
// ---------------------------------------------------------------------------------------------

fn roll(w: &World, cursor: Option<&str>, complete: bool, records: Vec<Value>) -> Value {
    let mut origin =
        json!({ "ref": "camera-roll", "label": "Camera roll", "device_id": "phone-a" });
    if let Some(cursor) = cursor {
        origin["cursor"] = json!(cursor);
    }
    w.ok(
        "follow.camera_roll",
        json!({ "origin": origin, "records": records, "complete": complete }),
    )
}

fn shot(local: &str, seed: &str, extra: Value) -> Value {
    let mut fields = json!({ "blob": hash(seed), "media_type": "image/jpeg",
                              "taken_at": "2025-07-01T10:00:00.000Z", "lat": 48.8584, "lon": 2.2945 });
    for (key, value) in extra.as_object().expect("an object") {
        fields[key] = value.clone();
    }
    json!({ "external_id": local, "device_id": "phone-a", "size": seed.len(), "fields": fields })
}

#[test]
fn a_roll_pass_adds_photographs_that_are_a_stores_with_no_place_and_a_point_on_the_map() {
    let w = world("dpf_roll");
    let tally = roll(
        &w,
        Some("k|2"),
        false,
        vec![
            shot("L1", "one", json!({})),
            shot(
                "L2",
                "two",
                json!({ "media_type": "video/mp4", "duration_s": 4.0, "lat": null, "lon": null }),
            ),
            shot(
                "L3",
                "three",
                json!({ "motion_blob": hash("clip"), "motion_size": 4,
                                         "motion_duration_s": 1.5, "exif": { "make": "X" } }),
            ),
        ],
    );
    assert_eq!(tally["added"], json!(3));
    assert_eq!(
        w.one::<String>(
            "SELECT cursor FROM origin WHERE system = 'camera_roll'",
            &[]
        ),
        "k|2"
    );
    let (one, two, three) = (
        entity_of(&w, "L1"),
        entity_of(&w, "L2"),
        entity_of(&w, "L3"),
    );
    // A followed photograph is a source's, not an arrival; the form follows the bytes.
    assert_eq!(
        w.one::<Option<String>>("SELECT arrived_via FROM entity WHERE id = ?1", &[&one]),
        None
    );
    assert_eq!(
        w.one::<String>("SELECT form FROM photo WHERE id = ?1", &[&two]),
        "video"
    );
    // The clip is claimed at its size and kept; the capture metadata is one JSON text.
    assert_eq!(
        w.one::<i64>("SELECT size FROM blob WHERE hash = ?1", &[&hash("clip")]),
        4
    );
    assert_eq!(
        w.one::<String>("SELECT motion_blob FROM photo WHERE id = ?1", &[&three]),
        hash("clip")
    );
    assert!(
        w.one::<String>("SELECT exif FROM photo WHERE id = ?1", &[&three])
            .contains("make")
    );
    // Where it was taken is on the map; nothing made a place.
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM place", &[]), 0);
    let points = w
        .vault()
        .read(|c| viewport(c, -180.0, 180.0, -90.0, 90.0, 100))
        .expect("a viewport");
    assert_eq!(
        points
            .iter()
            .filter(|p| p.id == one || p.id == three)
            .count(),
        2
    );
    assert!(!points.iter().any(|p| p.id == two));
    // A record that is not a picture, or says nothing of its bytes, is counted refused.
    let refused = roll(
        &w,
        None,
        false,
        vec![shot("S1", "song", json!({ "media_type": "audio/mpeg" }))],
    );
    assert_eq!(refused["added"], json!(0));
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM photo", &[]), 3);
}

#[test]
fn a_trashed_photograph_stays_trashed_and_a_purged_one_is_never_added_again() {
    let w = world("dpf_tombstones");
    roll(
        &w,
        None,
        true,
        vec![shot("L1", "one", json!({})), shot("L2", "two", json!({}))],
    );
    let (one, two) = (entity_of(&w, "L1"), entity_of(&w, "L2"));
    // The member trashes one: a rescan leaves it where it is.
    w.ok("entity.trash", json!({ "id": one }));
    let rescan = roll(
        &w,
        None,
        true,
        vec![shot("L1", "one", json!({})), shot("L2", "two", json!({}))],
    );
    assert_eq!(rescan["added"], json!(0));
    assert!(trashed(&w, &one), "a rescan is not a restore");
    // The member purges the other: its source is a tombstone, and the same record adds nothing.
    w.ok("entity.trash", json!({ "id": two }));
    w.ok("entity.purge", json!({ "id": two }));
    assert_eq!(
        w.one::<Option<String>>("SELECT entity_id FROM source WHERE external_id = 'L2'", &[]),
        None,
        "the source stays as a tombstone"
    );
    let rescan = roll(
        &w,
        None,
        true,
        vec![shot("L1", "one", json!({})), shot("L2", "two", json!({}))],
    );
    assert_eq!(rescan["added"], json!(0));
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM photo", &[]), 1);
    // The phone deleting its photograph is the vault's to keep (a complete read finds it absent).
    let w2 = world("dpf_kept");
    roll(&w2, None, true, vec![shot("L1", "one", json!({}))]);
    let kept = entity_of(&w2, "L1");
    let gone = roll(&w2, None, true, vec![]);
    assert_eq!(gone["forgotten"], json!(1));
    assert!(!trashed(&w2, &kept), "the vault outlives the phone's roll");
    assert_eq!(w2.one::<i64>("SELECT COUNT(*) FROM source", &[]), 0);
}

#[test]
fn what_the_member_corrected_stands_and_the_files_facts_never_change() {
    let w = world("dpf_roll_merge");
    roll(
        &w,
        None,
        true,
        vec![shot("L1", "one", json!({ "burst": "b1" }))],
    );
    let id = entity_of(&w, "L1");
    // The member corrects where it was taken; the phone's next word does not undo it.
    w.ok("photo.edit", json!({ "id": id, "lat": 10.0, "lon": 20.0 }));
    roll(
        &w,
        None,
        true,
        vec![shot(
            "L1",
            "one",
            json!({ "lat": 1.0, "lon": 2.0, "taken_at": "2025-07-02T10:00:00.000Z",
                                         "width": 4000, "burst": "b2" }),
        )],
    );
    assert_eq!(
        w.one::<f64>("SELECT lat FROM photo WHERE id = ?1", &[&id]),
        10.0
    );
    assert_eq!(
        w.one::<String>("SELECT taken_at FROM photo WHERE id = ?1", &[&id]),
        "2025-07-02T10:00:00.000Z",
        "what the member did not touch follows the phone"
    );
    assert_eq!(
        w.one::<Option<i64>>("SELECT width FROM photo WHERE id = ?1", &[&id]),
        None,
        "the file's own facts are written once"
    );
    assert_eq!(
        w.one::<String>(
            "SELECT actor FROM revision WHERE entity_id = ?1 ORDER BY seq DESC LIMIT 1",
            &[&id]
        ),
        "store"
    );
}

#[test]
fn a_stopped_roll_keeps_every_photograph_and_one_picked_is_a_different_thing() {
    let w = world("dpf_stop");
    roll(&w, Some("k|1"), false, vec![shot("L1", "one", json!({}))]);
    let stopped = w.ok(
        "follow.stop",
        json!({ "system": "camera_roll", "ref": "camera-roll" }),
    );
    assert_eq!(stopped["stopped"], json!(true));
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM photo", &[]), 1);
    // The same bytes picked by hand are an arrival and make no origin of their own.
    let picked = w.ok(
        "photo.add",
        json!({ "blob": hash("one"), "media_type": "image/jpeg", "arrived_via": "picker",
                 "arrived_label": "IMG_1.jpg", "size": 3 }),
    );
    assert_eq!(
        picked["deduped"],
        json!(true),
        "the bytes are already a photograph"
    );
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM origin", &[]), 1);
}
