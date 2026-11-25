//! Docs, Photos and Places against the v0 tables (#1214): a document in a folder that is a place,
//! the bytes a replace keeps, a photograph over bytes that are not unique, where it was taken and
//! the map that reads it, places the member makes, albums, derivatives, and the two followed
//! stores (a picked folder of files, the camera roll). The trash, a star, a tag and a rename are
//! shared verbs proved in the shared tests; here they only arrange a state. The rules the database
//! holds for these tables are in `schema_rules.rs`; the archives are `document_portable.rs` and
//! `photo_portable.rs`.

mod common;

use centraid_vault::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency};
use centraid_vault::index::viewport;
use common::world::World;
use serde_json::{Value, json};

fn world(seed: &str) -> World {
    let mut w = World {
        scratch: common::Scratch::founded_with_blobs(seed).expect("a vault"),
        registry: centraid_vault::commands::Registry::with_system_commands().expect("a registry"),
    };
    // One probe: replace a document's bytes and collect in the SAME commit (B3).
    w.registry
        .register(CommandDefinition::plain(
            "probe.replace_and_collect",
            "probe",
            r#"{"type":"object","additionalProperties":true}"#,
            Idempotency::Idempotent,
            &[] as &[CommandCondition],
            replace_and_collect,
        ))
        .expect("a probe");
    w
}

fn replace_and_collect(ctx: &CommandCtx<'_, '_>) -> centraid_vault::Result<Value> {
    ctx.connection().execute(
        "UPDATE document SET blob = ?2 WHERE id = ?1",
        [ctx.required_str("id")?, ctx.required_str("blob")?],
    )?;
    let released = centraid_vault::blob::collect(ctx.connection())?;
    Ok(json!({ "released": released }))
}

fn id_of(value: &Value) -> String {
    value["id"].as_str().expect("an id").to_owned()
}

/// Bytes the stage door would have claimed: a hash and a size.
fn bytes(w: &World, seed: &str) -> String {
    let hash = centraid_vault::blob::content_digest(seed.as_bytes());
    w.ok("blob.stage", json!({ "hash": hash, "size": seed.len() }));
    hash
}

fn document(w: &World, title: &str, seed: &str, folder: Option<&str>) -> String {
    id_of(&w.ok(
        "document.add",
        json!({ "title": title, "blob": bytes(w, seed), "media_type": "application/pdf",
                 "folder_id": folder }),
    ))
}

fn folder(w: &World, title: &str, parent: Option<&str>) -> String {
    id_of(&w.ok(
        "container.create",
        json!({ "kind": "folder", "title": title, "parent": parent }),
    ))
}

fn photo(w: &World, seed: &str, extra: Value) -> Value {
    let mut input = json!({ "blob": bytes(w, seed), "media_type": "image/jpeg" });
    for (key, value) in extra.as_object().expect("an object") {
        input[key] = value.clone();
    }
    w.ok("photo.add", input)
}

fn place(w: &World, title: &str, extra: Value) -> String {
    let mut input = json!({ "title": title });
    for (key, value) in extra.as_object().expect("an object") {
        input[key] = value.clone();
    }
    id_of(&w.ok("place.add", input))
}

fn trashed(w: &World, id: &str) -> bool {
    w.one::<Option<String>>("SELECT deleted_at FROM entity WHERE id = ?1", &[id])
        .is_some()
}

fn home(w: &World, id: &str) -> Option<String> {
    w.one("SELECT parent_id FROM entity WHERE id = ?1", &[id])
}

fn hits(w: &World, term: &str, id: &str) -> i64 {
    w.one(
        "SELECT count(DISTINCT e.id) FROM search s JOIN entity e ON e.n = s.rowid
          WHERE search MATCH ?1 AND e.id = ?2",
        &[term, id],
    )
}

fn plan(w: &World, sql: &str) -> String {
    w.vault()
        .read(|c| {
            let mut statement = c.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(3))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows.join(" | "))
        })
        .expect("a plan")
}

fn on_map(w: &World, id: &str) -> bool {
    w.vault()
        .read(|c| viewport(c, -180.0, 180.0, -90.0, 90.0, 1000))
        .expect("a viewport")
        .iter()
        .any(|point| point.id == id)
}

// ---------------------------------------------------------------------------------------------
// 1. Documents
// ---------------------------------------------------------------------------------------------

#[test]
fn identity_is_the_wrapper_two_documents_may_share_their_bytes() {
    let w = world("dp_identity");
    let a = document(&w, "Lease", "the same pages", None);
    let b = document(&w, "Lease copy", "the same pages", None);
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
fn a_document_is_refused_with_a_sentence_and_an_upload_is_an_arrival() {
    let w = world("dp_refusals");
    let sentence = w.refused(
        "document.add",
        json!({ "title": "Ghost", "blob": "ab".repeat(32), "media_type": "text/plain" }),
    );
    assert!(sentence.contains("not been counted"), "{sentence}");
    let taxes = folder(&w, "Taxes", None);
    w.ok("entity.trash", json!({ "id": taxes }));
    let sentence = w.refused(
        "document.add",
        json!({ "title": "Late", "blob": bytes(&w, "x"), "media_type": "text/plain",
                 "folder_id": taxes }),
    );
    assert!(sentence.contains("trash"), "{sentence}");
    let sentence = w.refused(
        "document.add",
        json!({ "title": " ", "blob": bytes(&w, "x"), "media_type": "text/plain" }),
    );
    assert!(sentence.contains("needs a name"), "{sentence}");
    let list = w.container("list", "A list");
    let sentence = w.refused(
        "document.add",
        json!({ "title": "Wrong", "blob": bytes(&w, "x"), "media_type": "text/plain",
                 "folder_id": list }),
    );
    assert!(sentence.contains("does not go inside"), "{sentence}");
    // An upload says where it came from, in both columns or neither, and makes no origin.
    let id = id_of(&w.ok(
        "document.add",
        json!({ "title": "Scan", "blob": bytes(&w, "scan"), "media_type": "application/pdf",
                 "arrived_via": "upload", "arrived_label": "/Downloads/scan.pdf" }),
    ));
    assert_eq!(
        w.one::<String>(
            "SELECT arrived_via || ':' || arrived_label FROM entity WHERE id = ?1",
            &[&id]
        ),
        "upload:scan.pdf"
    );
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM origin", &[]), 0);
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM source", &[]), 0);
    // A way in that does not bring in a document is refused before anything is written.
    let wrong = w.vault().execute(
        &w.registry,
        &centraid_vault::Principal::owner("phone"),
        &centraid_vault::Command::new(
            "document.add",
            json!({ "title": "Odd", "blob": bytes(&w, "x"), "media_type": "text/plain",
                     "arrived_via": "picker", "arrived_label": "x" }),
        ),
    );
    assert!(
        wrong.is_err_and(|error| error.to_string().contains("does not bring in")),
        "a picker brings in photographs"
    );
}

#[test]
fn replacing_keeps_the_earlier_bytes_through_its_history_slot_and_a_restore_brings_them_back() {
    let w = world("dp_replace");
    let id = document(&w, "Scan", "first scan", None);
    let first = w.one::<String>("SELECT blob FROM document WHERE id = ?1", &[&id]);
    let second = bytes(&w, "second scan");
    w.ok("document.replace", json!({ "id": id, "blob": second }));
    assert_eq!(
        w.one::<String>("SELECT blob FROM document WHERE id = ?1", &[&id]),
        second
    );
    // The first bytes are the version's, named by a `revision_blob` row in the `blob` slot.
    assert_eq!(
        w.one::<String>(
            "SELECT rb.slot FROM revision r JOIN revision_blob rb
               ON rb.entity_id = r.entity_id AND rb.seq = r.seq
              WHERE r.entity_id = ?1 AND rb.blob = ?2",
            &[&id, &first]
        ),
        "blob"
    );
    // A collection finds nothing to release: the version names the old bytes.
    assert_eq!(w.ok("blob.collect", json!({}))["released"], json!([]));
    // The same bytes again revise nothing.
    let versions =
        |w: &World| w.one::<i64>("SELECT COUNT(*) FROM revision WHERE entity_id = ?1", &[&id]);
    let before = versions(&w);
    assert_eq!(
        w.ok("document.replace", json!({ "id": id, "blob": second }))["replaced"],
        json!(false)
    );
    assert_eq!(versions(&w), before);
    // Restoring the first version puts the first bytes back and keeps the second as a version.
    let seq = w.one::<i64>(
        "SELECT r.seq FROM revision r JOIN revision_blob rb
           ON rb.entity_id = r.entity_id AND rb.seq = r.seq
          WHERE r.entity_id = ?1 AND rb.blob = ?2",
        &[&id, &first],
    );
    w.ok("document.restore_version", json!({ "id": id, "seq": seq }));
    assert_eq!(
        w.one::<String>("SELECT blob FROM document WHERE id = ?1", &[&id]),
        first
    );
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM revision_blob WHERE entity_id = ?1 AND blob = ?2",
            &[&id, &second]
        ),
        1
    );
    let sentence = w.refused("document.restore_version", json!({ "id": id, "seq": 99 }));
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
    assert_eq!(w.ok("blob.collect", json!({}))["released"], json!([]));
}

#[test]
fn collecting_in_the_same_commit_as_a_replace_cannot_take_the_earlier_bytes() {
    let w = world("dp_same_commit");
    let id = document(&w, "Scan", "first", None);
    let first = w.one::<String>("SELECT blob FROM document WHERE id = ?1", &[&id]);
    let second = bytes(&w, "second");
    let out = w.ok(
        "probe.replace_and_collect",
        json!({ "id": id, "blob": second }),
    );
    assert_eq!(
        out["released"],
        json!([]),
        "the version about to be written names them"
    );
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM blob WHERE hash = ?1", &[&first]),
        1
    );
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM revision_blob WHERE entity_id = ?1 AND blob = ?2",
            &[&id, &first]
        ),
        1
    );
}

#[test]
fn the_words_a_phone_read_out_of_a_file_are_what_it_is_found_by() {
    let w = world("dp_words");
    let id = id_of(&w.ok(
        "document.add",
        json!({ "title": "Scan 0041", "blob": bytes(&w, "scanned lease"),
                 "media_type": "application/pdf", "text": "monthly rent is due on the first" }),
    ));
    assert_eq!(hits(&w, "rent", &id), 1);
    w.ok(
        "document.replace",
        json!({ "id": id, "blob": bytes(&w, "rescanned lease"), "text": "deposit refunded" }),
    );
    assert_eq!(hits(&w, "rent", &id), 0);
    assert_eq!(hits(&w, "deposit", &id), 1);
    // The derivative is the blob's `text` variant, a text and no file.
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM derivative WHERE variant = 'text' AND out IS NULL",
            &[]
        ),
        2
    );
}

#[test]
fn text_is_written_through_the_blob_door_and_found_by_its_words() {
    let w = world("dp_text");
    let id = id_of(&w.ok(
        "document.create_text",
        json!({ "title": "Packing", "body_text": "passport and sunscreen" }),
    ));
    assert_eq!(hits(&w, "sunscreen", &id), 1);
    w.ok(
        "document.edit",
        json!({ "id": id, "body_text": "passport and umbrella" }),
    );
    assert_eq!(hits(&w, "sunscreen", &id), 0);
    assert_eq!(hits(&w, "umbrella", &id), 1);
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM revision WHERE entity_id = ?1", &[&id]),
        1,
        "the words that were replaced are version one"
    );
    w.ok(
        "document.edit",
        json!({ "id": id, "title": "Packing list" }),
    );
    assert_eq!(
        w.one::<String>("SELECT title FROM entity WHERE id = ?1", &[&id]),
        "Packing list"
    );
    let pdf = document(&w, "Scan", "pages", None);
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

// ---------------------------------------------------------------------------------------------
// 2. Folders are places
// ---------------------------------------------------------------------------------------------

#[test]
fn a_document_sits_in_one_folder_and_moves_through_entity_move() {
    let w = world("dp_move");
    let (taxes, trips) = (folder(&w, "Taxes", None), folder(&w, "Trips", None));
    let id = document(&w, "Return", "return", Some(&taxes));
    assert_eq!(home(&w, &id).as_deref(), Some(taxes.as_str()));
    w.ok("entity.move", json!({ "id": id, "parent": trips }));
    assert_eq!(home(&w, &id).as_deref(), Some(trips.as_str()));
    w.ok("entity.move", json!({ "id": id, "parent": null }));
    assert_eq!(home(&w, &id), None);
    // The home is one column: there is no second place a document is in.
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM pragma_table_info('document') WHERE name LIKE '%folder%'",
            &[]
        ),
        0
    );
    // Two siblings may repeat a name; a folder sits in a folder, and never inside itself.
    let again = folder(&w, "Taxes", None);
    assert_ne!(again, taxes);
    let nested = folder(&w, "2025", Some(&taxes));
    let deeper = folder(&w, "Receipts", Some(&nested));
    let sentence = w.refused("entity.move", json!({ "id": taxes, "parent": deeper }));
    assert!(sentence.contains("inside"), "{sentence}");
    let sentence = w.refused("entity.move", json!({ "id": taxes, "parent": taxes }));
    assert!(sentence.contains("inside"), "{sentence}");
    // A document belongs in two places by a tag, not by a second home.
    w.ok("tag.add", json!({ "id": id, "label": "tax" }));
    assert_eq!(home(&w, &id), None);
}

#[test]
fn a_folder_takes_its_contents_to_the_trash_and_brings_back_exactly_those() {
    let w = world("dp_folder_trash");
    let taxes = folder(&w, "Taxes", None);
    let nested = folder(&w, "2025", Some(&taxes));
    let inner = document(&w, "W-2", "w2", Some(&nested));
    let direct = document(&w, "Return", "return", Some(&taxes));
    let earlier = document(&w, "Old", "old", Some(&taxes));
    // One document was trashed on its own before the folder was.
    w.ok("entity.trash", json!({ "id": earlier }));
    w.ok("entity.trash", json!({ "id": taxes }));
    for (gone, by) in [(&nested, &taxes), (&direct, &taxes), (&inner, &nested)] {
        assert!(trashed(&w, gone), "{gone} went with the folder");
        assert_eq!(
            w.one::<String>("SELECT trashed_by FROM entity WHERE id = ?1", &[gone]),
            *by,
            "named by the holder that took it"
        );
    }
    assert_eq!(
        w.one::<Option<String>>("SELECT trashed_by FROM entity WHERE id = ?1", &[&earlier]),
        None,
        "the one trashed on its own is not the folder's"
    );
    w.ok("entity.restore", json!({ "id": taxes }));
    for back in [&taxes, &nested, &inner, &direct] {
        assert!(!trashed(&w, back), "{back} came back with the folder");
    }
    assert!(
        trashed(&w, &earlier),
        "exactly what the folder took came back"
    );
    assert_eq!(home(&w, &inner).as_deref(), Some(nested.as_str()));
}

#[test]
fn one_file_restored_out_of_a_trashed_folder_lands_at_the_top() {
    let w = world("dp_restore_out");
    let taxes = folder(&w, "Taxes", None);
    let id = document(&w, "Return", "return", Some(&taxes));
    let other = document(&w, "Other", "other", Some(&taxes));
    w.ok("entity.trash", json!({ "id": taxes }));
    w.ok("entity.restore", json!({ "id": id }));
    assert!(!trashed(&w, &id));
    assert_eq!(home(&w, &id), None, "it left the trashed folder first");
    assert!(trashed(&w, &taxes) && trashed(&w, &other));
    // A purge of the folder takes what went with it and keeps the one restored on its own.
    w.ok("entity.purge", json!({ "id": taxes }));
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM entity WHERE id IN (?1, ?2)",
            &[&taxes, &other]
        ),
        0
    );
    assert!(!trashed(&w, &id));
}

#[test]
fn documents_in_a_folder_are_one_index_seek() {
    let w = world("dp_plan");
    let taxes = folder(&w, "Taxes", None);
    document(&w, "Return", "return", Some(&taxes));
    let in_folder = plan(
        &w,
        &format!(
            "SELECT id FROM entity WHERE parent_id = '{taxes}' AND kind = 'document'
               AND deleted_at IS NULL ORDER BY updated_at DESC"
        ),
    );
    assert!(in_folder.contains("entity_by_home"), "{in_folder}");
    assert!(!in_folder.contains("TEMP B-TREE"), "{in_folder}");
    assert!(!in_folder.contains("SCAN"), "{in_folder}");
    // At the top level: the kind's list by last edited, nothing sorted.
    let top = plan(
        &w,
        "SELECT id FROM entity WHERE kind = 'document' AND deleted_at IS NULL
           AND parent_id IS NULL ORDER BY updated_at DESC",
    );
    assert!(top.contains("entity_by_updated"), "{top}");
    assert!(!top.contains("TEMP B-TREE"), "{top}");
}

// ---------------------------------------------------------------------------------------------
// 3. Photographs: the same bytes commit once
// ---------------------------------------------------------------------------------------------

#[test]
fn the_same_bytes_offered_twice_commit_once_and_a_trashed_photograph_stays_trashed() {
    let w = world("dp_photo_once");
    let first = photo(&w, "sunset", json!({ "title": "Sunset" }));
    assert_eq!(first["deduped"], json!(false));
    let id = id_of(&first);
    let again = photo(&w, "sunset", json!({ "title": "Another" }));
    assert_eq!(
        (id_of(&again), again["deduped"].clone()),
        (id.clone(), json!(true))
    );
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM photo", &[]), 1);
    // The member trashes it; offered again, it commits nothing and is not pulled out of the trash.
    w.ok("entity.trash", json!({ "id": id }));
    let stamp = w.stamp(&id);
    let again = photo(&w, "sunset", json!({ "burst": "b1" }));
    assert_eq!(id_of(&again), id);
    assert_eq!(again["trashed"], json!(true));
    assert!(trashed(&w, &id), "re-offering is not a restore");
    assert_eq!(
        w.stamp(&id),
        stamp,
        "a trashed photograph is left exactly as it was"
    );
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM photo", &[]), 1);
    // A burst the bytes now name is filled on a live photograph that has none.
    let live = id_of(&photo(&w, "pier", json!({})));
    photo(&w, "pier", json!({ "burst": "b2" }));
    assert_eq!(
        w.one::<String>("SELECT burst FROM photo WHERE id = ?1", &[&live]),
        "b2"
    );
    // Once purged its bytes are gone with it, so the same bytes are a new photograph.
    w.ok("entity.purge", json!({ "id": id }));
    let fresh = photo(&w, "sunset", json!({}));
    assert_eq!(fresh["deduped"], json!(false));
    assert_ne!(id_of(&fresh), id);
}

#[test]
fn a_picked_photograph_is_an_arrival_and_the_form_follows_the_bytes() {
    let w = world("dp_photo_arrival");
    let id = id_of(&photo(
        &w,
        "picked",
        json!({ "arrived_via": "picker", "arrived_label": "IMG_0001.jpg" }),
    ));
    assert_eq!(
        w.one::<String>("SELECT arrived_via FROM entity WHERE id = ?1", &[&id]),
        "picker"
    );
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM origin", &[]), 0);
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM source", &[]), 0);
    let film = id_of(&w.ok(
        "photo.add",
        json!({ "blob": bytes(&w, "film"), "media_type": "video/mp4", "duration_s": 3.5 }),
    ));
    let page = id_of(&w.ok(
        "photo.add",
        json!({ "blob": bytes(&w, "page"), "media_type": "application/pdf" }),
    ));
    let form = |id: &str| w.one::<String>("SELECT form FROM photo WHERE id = ?1", &[id]);
    assert_eq!(
        (
            form(&id).as_str(),
            form(&film).as_str(),
            form(&page).as_str()
        ),
        ("photo", "video", "scan")
    );
    let sentence = w.refused(
        "photo.add",
        json!({ "blob": bytes(&w, "song"), "media_type": "audio/mpeg" }),
    );
    assert!(sentence.contains("Docs"), "{sentence}");
    let sentence = w.refused(
        "photo.add",
        json!({ "blob": bytes(&w, "odd"), "media_type": "image/png", "form": "hologram" }),
    );
    assert!(sentence.contains("hologram"), "{sentence}");
    // The Videos and Scans shelves are one index walk by form.
    let shelf = plan(
        &w,
        "SELECT p.id FROM photo p JOIN entity e ON e.id = p.id
          WHERE p.form = 'video' AND e.deleted_at IS NULL ORDER BY p.taken_at DESC",
    );
    assert!(shelf.contains("photo_by_form"), "{shelf}");
    assert!(!shelf.contains("TEMP B-TREE"), "{shelf}");
    assert_eq!(
        w.strings("SELECT p.id FROM photo p WHERE p.form = 'video'", &[]),
        [film]
    );
}

#[test]
fn an_edit_keeps_the_originals_date_place_coordinates_and_caption() {
    let w = world("dp_photo_edit");
    let cabin = place(&w, "The cabin", json!({ "lat": 61.0, "lon": 7.0 }));
    let original = id_of(&photo(
        &w,
        "original",
        json!({ "title": "Lake", "taken_at": "2025-07-01T10:00:00.000Z", "offset_min": 120,
                 "place_id": cabin, "lat": 61.001, "lon": 7.002 }),
    ));
    let edit = id_of(&w.ok(
        "photo.add",
        json!({ "blob": bytes(&w, "cropped"), "media_type": "image/jpeg", "edited_from": original }),
    ));
    let read = |col: &str, id: &str| {
        w.one::<Option<String>>(
            &format!("SELECT CAST({col} AS TEXT) FROM photo WHERE id = ?1"),
            &[id],
        )
    };
    assert_eq!(
        read("taken_at", &edit).as_deref(),
        Some("2025-07-01T10:00:00.000Z")
    );
    assert_eq!(read("place_id", &edit).as_deref(), Some(cabin.as_str()));
    assert_eq!(read("lat", &edit).as_deref(), Some("61.001"));
    assert_eq!(
        read("edited_from", &edit).as_deref(),
        Some(original.as_str())
    );
    assert_eq!(
        w.one::<String>("SELECT title FROM entity WHERE id = ?1", &[&edit]),
        "Lake"
    );
    // Said outright, the editor's own values win; lineage never loops.
    let own = id_of(&w.ok(
        "photo.add",
        json!({ "blob": bytes(&w, "filtered"), "media_type": "image/jpeg",
                 "edited_from": original, "title": "Lake, warm", "taken_at": "2025-07-02T00:00:00.000Z" }),
    ));
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
    assert_eq!(read("taken_at", &edit), None);
    assert_eq!(read("offset_min", &edit).as_deref(), Some("-60"));
    // Edited-from has an index of its own: what was made from a photograph is a seek.
    let derived = plan(&w, "SELECT id FROM photo WHERE edited_from = 'x'");
    assert!(derived.contains("photo_by_edited_from"), "{derived}");
}

#[test]
fn a_live_photograph_keeps_its_clip_and_a_burst_is_one_index_seek() {
    let w = world("dp_photo_motion");
    let clip = centraid_vault::blob::content_digest(b"the clip");
    let id = id_of(&photo(
        &w,
        "live",
        json!({ "motion_blob": clip, "motion_size": 8, "motion_duration_s": 1.5, "burst": "b9" }),
    ));
    assert_eq!(
        w.one::<String>("SELECT motion_blob FROM photo WHERE id = ?1", &[&id]),
        clip
    );
    assert_eq!(
        w.one::<f64>("SELECT motion_duration_s FROM photo WHERE id = ?1", &[&id]),
        1.5
    );
    assert_eq!(
        w.one::<i64>("SELECT size FROM blob WHERE hash = ?1", &[&clip]),
        8
    );
    let sentence = w.refused(
        "photo.add",
        json!({ "blob": bytes(&w, "x"), "media_type": "image/jpeg", "motion_duration_s": 2 }),
    );
    assert!(sentence.contains("needs the clip"), "{sentence}");
    let sentence = w.refused(
        "photo.add",
        json!({ "blob": bytes(&w, "y"), "media_type": "image/jpeg",
                 "motion_blob": "cd".repeat(32) }),
    );
    assert!(sentence.contains("not been counted"), "{sentence}");
    // The clip is the photograph's, held while it is and collected with it.
    let released = w.ok("blob.collect", json!({}))["released"].clone();
    assert!(
        !released
            .as_array()
            .expect("a list")
            .iter()
            .any(|h| h.as_str() == Some(&clip))
    );
    let burst = plan(&w, "SELECT id FROM photo WHERE burst = 'b9'");
    assert!(burst.contains("photo_by_burst"), "{burst}");
    w.ok("entity.trash", json!({ "id": id }));
    let purged = w.ok("entity.purge", json!({ "id": id }));
    assert!(
        purged["released"]
            .as_array()
            .expect("a list")
            .iter()
            .any(|h| h.as_str() == Some(&clip)),
        "{purged}"
    );
}

// ---------------------------------------------------------------------------------------------
// 4. Where it was taken, and places
// ---------------------------------------------------------------------------------------------

#[test]
fn where_a_photograph_was_taken_is_kept_and_never_makes_a_place() {
    let w = world("dp_geo");
    let id = id_of(&photo(
        &w,
        "paris",
        json!({ "lat": 48.8584, "lon": 2.2945 }),
    ));
    assert_eq!(
        w.one::<f64>("SELECT lat FROM photo WHERE id = ?1", &[&id]),
        48.8584
    );
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM place", &[]),
        0,
        "no place from a coordinate"
    );
    assert_eq!(
        w.one::<Option<String>>("SELECT place_id FROM photo WHERE id = ?1", &[&id]),
        None
    );
    assert!(on_map(&w, &id), "the viewport read returns it");
    let around = w
        .vault()
        .read(|c| viewport(c, 2.0, 3.0, 48.0, 49.0, 10))
        .expect("a box");
    assert_eq!(around.len(), 1);
    assert_eq!(
        (around[0].id.as_str(), around[0].kind.as_str()),
        (id.as_str(), "photo")
    );
    let elsewhere = w
        .vault()
        .read(|c| viewport(c, 100.0, 101.0, 0.0, 1.0, 10))
        .expect("a box");
    assert!(elsewhere.is_empty());
    // Half a coordinate is no coordinate.
    let sentence = w.refused(
        "photo.add",
        json!({ "blob": bytes(&w, "half"), "media_type": "image/jpeg", "lat": 1.0 }),
    );
    assert!(sentence.contains("go together"), "{sentence}");
    // The member corrects where it was taken, then clears it; the map follows.
    w.ok("photo.edit", json!({ "id": id, "lat": 40.0, "lon": -3.0 }));
    assert!(
        w.vault()
            .read(|c| viewport(c, -4.0, -2.0, 39.0, 41.0, 10))
            .expect("a box")
            .iter()
            .any(|p| p.id == id)
    );
    w.ok("photo.edit", json!({ "id": id, "lat": null, "lon": null }));
    assert!(!on_map(&w, &id));
    // A trashed photograph is not on the map.
    w.ok("photo.edit", json!({ "id": id, "lat": 40.0, "lon": -3.0 }));
    assert!(on_map(&w, &id));
    w.ok("entity.trash", json!({ "id": id }));
    assert!(!on_map(&w, &id));
}

#[test]
fn a_named_place_attaches_by_the_members_choice_and_is_found_by_its_name() {
    let w = world("dp_named_place");
    let id = id_of(&photo(
        &w,
        "tower",
        json!({ "lat": 48.8584, "lon": 2.2945 }),
    ));
    let tower = place(&w, "Tour Eiffel", json!({ "lat": 48.8584, "lon": 2.2945 }));
    // Nothing attaches it by itself, however near.
    assert_eq!(
        w.one::<Option<String>>("SELECT place_id FROM photo WHERE id = ?1", &[&id]),
        None
    );
    w.ok("photo.set_place", json!({ "id": id, "place_id": tower }));
    assert_eq!(hits(&w, "eiffel", &id), 1);
    w.ok("place.locate", json!({ "id": tower, "locality": "Paris" }));
    assert_eq!(hits(&w, "paris", &id), 1);
    w.ok("place.locate", json!({ "id": tower, "locality": null }));
    assert_eq!(hits(&w, "paris", &id), 0);
    // The place is on the map as its own point, and the photograph keeps its own.
    assert!(on_map(&w, &tower) && on_map(&w, &id));
    // Setting the place leaves where it was taken alone; clearing it clears only the name.
    w.ok("photo.set_place", json!({ "id": id }));
    assert_eq!(hits(&w, "eiffel", &id), 0);
    assert_eq!(
        w.one::<f64>("SELECT lat FROM photo WHERE id = ?1", &[&id]),
        48.8584
    );
    assert!(
        w.refused("photo.set_place", json!({ "id": id, "place_id": id }))
            .contains("not a place")
    );
    // A photograph taken at a place the member names at add time is attached; a trashed one is not.
    let at = photo(&w, "inside", json!({ "place_id": tower }));
    assert_eq!(
        w.one::<String>("SELECT place_id FROM photo WHERE id = ?1", &[&id_of(&at)]),
        tower
    );
    w.ok("entity.trash", json!({ "id": tower }));
    assert!(!on_map(&w, &tower));
    assert!(
        w.refused("photo.set_place", json!({ "id": id, "place_id": tower }))
            .contains("trash")
    );
}

#[test]
fn a_place_is_made_edited_and_trashed_by_the_member_only() {
    let w = world("dp_places");
    let cabin = place(
        &w,
        "The cabin",
        json!({ "lat": 61.0, "lon": 7.0, "address": "Lake road 2" }),
    );
    assert!(on_map(&w, &cabin));
    assert!(
        w.refused("place.add", json!({ "title": " " }))
            .contains("needs a name")
    );
    assert!(
        w.refused("place.add", json!({ "title": "Half", "lat": 1.0 }))
            .contains("together")
    );
    w.ok(
        "place.edit",
        json!({ "id": cabin, "title": "The lake house", "lat": 62.0, "lon": 8.0, "zone": "Europe/Oslo" }),
    );
    assert_eq!(
        w.one::<String>("SELECT title FROM entity WHERE id = ?1", &[&cabin]),
        "The lake house"
    );
    assert_eq!(
        w.one::<f64>("SELECT lon FROM place WHERE id = ?1", &[&cabin]),
        8.0
    );
    assert_eq!(
        w.one::<String>("SELECT address FROM place WHERE id = ?1", &[&cabin]),
        "Lake road 2",
        "what an edit did not name stays"
    );
    assert!(
        w.refused("place.edit", json!({ "id": cabin, "title": "  " }))
            .contains("needs a name")
    );
    assert!(
        w.refused("place.edit", json!({ "id": cabin, "lat": 1.0 }))
            .contains("together")
    );
    w.ok(
        "place.edit",
        json!({ "id": cabin, "lat": null, "lon": null, "address": null }),
    );
    assert!(!on_map(&w, &cabin));
    // Trashed, it is frozen; restored, it is back.
    w.ok("entity.trash", json!({ "id": cabin }));
    assert!(
        w.refused("place.edit", json!({ "id": cabin, "title": "x" }))
            .contains("trash")
    );
    w.ok("entity.restore", json!({ "id": cabin }));
    w.ok("place.edit", json!({ "id": cabin, "title": "Back" }));
    // A purge lets a photograph go of the place and keeps the photograph and where it was taken.
    let id = id_of(&photo(
        &w,
        "p",
        json!({ "lat": 1.0, "lon": 2.0, "place_id": cabin }),
    ));
    w.ok("entity.trash", json!({ "id": cabin }));
    w.ok("entity.purge", json!({ "id": cabin }));
    assert_eq!(
        w.one::<Option<String>>("SELECT place_id FROM photo WHERE id = ?1", &[&id]),
        None
    );
    assert_eq!(
        w.one::<f64>("SELECT lat FROM photo WHERE id = ?1", &[&id]),
        1.0
    );
    // No place was made by anything else along the way.
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM place", &[]), 0);
}

// ---------------------------------------------------------------------------------------------
// 5. Albums, covers, derivatives
// ---------------------------------------------------------------------------------------------

fn album_order(w: &World, album: &str) -> Vec<String> {
    w.strings(
        "SELECT to_id FROM edge WHERE from_id = ?1 AND rel = 'contains' ORDER BY position",
        &[album],
    )
}

#[test]
fn an_album_adds_reorders_and_removes_and_a_photograph_may_be_in_two() {
    let w = world("dp_albums");
    let (summer, best) = (w.container("album", "Summer"), w.container("album", "Best"));
    let a = id_of(&photo(&w, "a", json!({})));
    let b = id_of(&photo(&w, "b", json!({})));
    let c = id_of(&photo(&w, "c", json!({})));
    for p in [&a, &b, &c] {
        w.ok(
            "edge.add",
            json!({ "from": summer, "rel": "contains", "to": p }),
        );
    }
    w.ok(
        "edge.add",
        json!({ "from": best, "rel": "contains", "to": a }),
    );
    assert_eq!(album_order(&w, &summer), [a.clone(), b.clone(), c.clone()]);
    assert_eq!(
        album_order(&w, &best),
        std::slice::from_ref(&a),
        "one photograph, two albums"
    );
    // Reorder: put the last first.
    w.ok(
        "edge.move",
        json!({ "from": summer, "to": c, "position": 0.5 }),
    );
    assert_eq!(album_order(&w, &summer), [c.clone(), a.clone(), b.clone()]);
    w.ok(
        "edge.remove",
        json!({ "from": summer, "rel": "contains", "to": a }),
    );
    assert_eq!(album_order(&w, &summer), [c.clone(), b.clone()]);
    assert_eq!(
        album_order(&w, &best),
        std::slice::from_ref(&a),
        "the other album still has it"
    );
    // An album's photographs in order are one index walk, nothing sorted.
    let walk = plan(
        &w,
        &format!(
            "SELECT to_id FROM edge WHERE from_id = '{summer}' AND rel = 'contains' AND position IS NOT NULL ORDER BY position"
        ),
    );
    assert!(walk.contains("edge_order"), "{walk}");
    assert!(!walk.contains("TEMP B-TREE"), "{walk}");
    // An album is a holder of nothing: trashing a photograph leaves its place in the album.
    w.ok("entity.trash", json!({ "id": b }));
    assert_eq!(album_order(&w, &summer), [c, b]);
}

#[test]
fn an_album_keeps_its_cover_while_the_photograph_is_there() {
    let w = world("dp_cover");
    let id = id_of(&photo(&w, "beach", json!({})));
    let blob = w.one::<String>("SELECT blob FROM photo WHERE id = ?1", &[&id]);
    let album = w.container("album", "Summer");
    w.ok(
        "edge.add",
        json!({ "from": album, "rel": "contains", "to": id }),
    );
    w.ok("album.set_cover", json!({ "id": album, "photo_id": id }));
    assert_eq!(
        w.one::<String>("SELECT cover FROM container WHERE id = ?1", &[&album]),
        blob
    );
    let outsider = id_of(&photo(&w, "city", json!({})));
    assert!(
        w.refused(
            "album.set_cover",
            json!({ "id": album, "photo_id": outsider })
        )
        .contains("not in")
    );
    w.ok("entity.trash", json!({ "id": id }));
    let purged = w.ok("entity.purge", json!({ "id": id }));
    assert_eq!(
        w.one::<Option<String>>("SELECT cover FROM container WHERE id = ?1", &[&album]),
        None
    );
    // A cover is a view of the photograph's bytes, not the album's content: no version keeps it,
    // so the purge releases the bytes it named.
    assert!(
        purged["released"]
            .as_array()
            .expect("a list")
            .iter()
            .any(|h| h.as_str() == Some(&blob)),
        "{purged}"
    );
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM revision_blob WHERE blob = ?1",
            &[&blob]
        ),
        0
    );
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM blob WHERE hash = ?1", &[&blob]),
        0
    );
}

#[test]
fn derivatives_are_files_or_text_as_the_lookup_says_and_the_words_are_searchable() {
    let w = world("dp_derivatives");
    let id = id_of(&photo(
        &w,
        "beach",
        json!({ "phash": "abc", "thumbhash": "def" }),
    ));
    let blob = w.one::<String>("SELECT blob FROM photo WHERE id = ?1", &[&id]);
    // The hashes ride with the photograph as text variants.
    assert_eq!(
        w.strings(
            "SELECT variant FROM derivative WHERE blob = ?1 AND out IS NULL ORDER BY variant",
            &[&blob]
        ),
        ["phash", "thumbhash"]
    );
    // A caption is text, and the photograph is found by it.
    w.ok(
        "derivative.write",
        json!({ "blob": blob, "variant": "caption", "text": "dog on a beach" }),
    );
    assert_eq!(hits(&w, "dog", &id), 1);
    // A poster is a file, a caption is not: the lookup's `has_out` says so, not this crate.
    let sentence = w.refused(
        "derivative.write",
        json!({ "blob": blob, "variant": "caption", "out": "ab".repeat(32), "out_size": 3,
                 "media_type": "image/jpeg" }),
    );
    assert!(!sentence.is_empty());
    let poster = bytes(&w, "poster frame");
    w.ok(
        "derivative.write",
        json!({ "blob": blob, "variant": "poster", "out": poster, "out_size": 12,
                 "media_type": "image/jpeg" }),
    );
    assert_eq!(
        w.one::<i64>(
            "SELECT has_out FROM derivative WHERE blob = ?1 AND variant = 'poster'",
            &[&blob]
        ),
        1
    );
    // A document's extracted text is a derivative of its bytes, and a rename of nothing re-reads it.
    let doc = document(&w, "Scan", "scan", None);
    let dblob = w.one::<String>("SELECT blob FROM document WHERE id = ?1", &[&doc]);
    w.ok(
        "derivative.write",
        json!({ "blob": dblob, "variant": "text", "text": "invoice number nine" }),
    );
    assert_eq!(hits(&w, "invoice", &doc), 1);
}

#[test]
fn restoring_an_album_version_leaves_its_current_cover_as_it_is() {
    let w = world("dp_cover_restore");
    let (a, b) = (
        id_of(&photo(&w, "first", json!({}))),
        id_of(&photo(&w, "second", json!({}))),
    );
    let blob = |id: &str| w.one::<String>("SELECT blob FROM photo WHERE id = ?1", &[id]);
    let album = w.container("album", "Summer");
    for p in [&a, &b] {
        w.ok(
            "edge.add",
            json!({ "from": album, "rel": "contains", "to": p }),
        );
    }
    w.ok("album.set_cover", json!({ "id": album, "photo_id": a }));
    w.ok(
        "entity.retitle",
        json!({ "id": album, "title": "Summer 2025" }),
    );
    w.ok("album.set_cover", json!({ "id": album, "photo_id": b }));
    // An earlier version of the album held another title; no version holds a cover.
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM revision_blob WHERE entity_id = ?1",
            &[&album]
        ),
        0
    );
    let seq = w.one::<i64>(
        "SELECT MIN(seq) FROM revision WHERE entity_id = ?1",
        &[&album],
    );
    w.ok(
        "history.restore_version",
        json!({ "id": album, "seq": seq }),
    );
    assert_eq!(
        w.one::<String>("SELECT title FROM entity WHERE id = ?1", &[&album]),
        "Summer",
        "the version came back"
    );
    assert_eq!(
        w.one::<String>("SELECT cover FROM container WHERE id = ?1", &[&album]),
        blob(&b),
        "the cover is the album's current one"
    );
}
