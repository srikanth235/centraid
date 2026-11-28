//! A photograph or document captured inside an item is filed with that item (#1214, S12): it is
//! homed in it (`entity.parent_id`), goes to the trash with it and comes back only with it, is no
//! line of the trash on its own, follows the item through a merge, and is never filed in a Locker
//! item or a reading.

mod common;

use centraid_vault::model::Kind;
use common::world::World;
use serde_json::json;

fn world(seed: &str) -> World {
    World {
        scratch: common::Scratch::founded_with_blobs(seed).expect("a vault"),
        registry: centraid_vault::commands::Registry::with_system_commands().expect("a registry"),
    }
}

fn bytes(w: &World, seed: &str) -> String {
    let hash = centraid_vault::blob::content_digest(seed.as_bytes());
    w.ok("blob.stage", json!({ "hash": hash, "size": seed.len() }));
    hash
}

fn receipt(w: &World, seed: &str, home: &str) -> String {
    w.ok(
        "photo.add",
        json!({ "blob": bytes(w, seed), "media_type": "image/jpeg", "home": home }),
    )["id"]
        .as_str()
        .expect("an id")
        .to_owned()
}

fn home_of(w: &World, id: &str) -> Option<String> {
    w.one("SELECT parent_id FROM entity WHERE id = ?1", &[id])
}

fn trashed_kinds(w: &World, kind: &str, table: &str) -> i64 {
    w.vault()
        .count_kind(&centraid_vault::page::KindCount {
            kind,
            table,
            trashed: true,
            tests: &[],
        })
        .expect("a count")
}

#[test]
fn a_capture_is_homed_in_its_item_and_goes_to_the_trash_and_comes_back_with_it() {
    let w = world("homed_trash");
    let payment = w.bare(Kind::Txn, "Lunch", None);
    let photo = receipt(&w, "receipt", &payment);
    let scan = w.ok(
        "document.add",
        json!({ "title": "Receipt scan", "blob": bytes(&w, "scan"),
                "media_type": "application/pdf", "home": &payment }),
    )["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    assert_eq!(home_of(&w, &photo).as_deref(), Some(payment.as_str()));
    assert_eq!(home_of(&w, &scan).as_deref(), Some(payment.as_str()));
    assert_eq!(
        w.vault()
            .read(|c| centraid_vault::commands::entity::held_count(c, &payment))
            .expect("a count"),
        2,
        "the confirm names what goes with the payment"
    );
    w.ok("entity.trash", json!({ "id": &payment }));
    for id in [&photo, &scan] {
        assert_eq!(
            w.one::<Option<String>>("SELECT trashed_by FROM entity WHERE id = ?1", &[id]),
            Some(payment.clone()),
            "it went with the payment"
        );
    }
    assert_eq!(
        trashed_kinds(&w, "photo", "photo"),
        0,
        "no line of the trash on its own"
    );
    assert_eq!(trashed_kinds(&w, "document", "document"), 0);
    assert_eq!(trashed_kinds(&w, "txn", "entity"), 1);
    assert!(
        w.refused("entity.restore", json!({ "id": &photo }))
            .contains("restore"),
        "a capture does not come back alone"
    );
    w.ok("entity.restore", json!({ "id": &payment }));
    for id in [&photo, &scan] {
        assert_eq!(
            w.one::<Option<String>>("SELECT deleted_at FROM entity WHERE id = ?1", &[id]),
            None
        );
        assert_eq!(home_of(&w, id).as_deref(), Some(payment.as_str()));
    }
}

#[test]
fn the_same_bytes_in_the_library_and_in_an_item_are_two_photographs() {
    let w = world("homed_dedupe");
    let payment = w.bare(Kind::Txn, "Lunch", None);
    let filed = receipt(&w, "same", &payment);
    let library = w.ok(
        "photo.add",
        json!({ "blob": bytes(&w, "same"), "media_type": "image/jpeg" }),
    );
    assert_eq!(library["deduped"], json!(false));
    assert_ne!(library["id"].as_str(), Some(filed.as_str()));
    let again = receipt(&w, "same", &payment);
    assert_eq!(again, filed, "the same capture offered again commits once");
}

#[test]
fn a_capture_is_never_filed_in_a_locker_item_a_reading_or_a_folder_and_an_item_at_once() {
    let w = world("homed_refused");
    let locker = w.bare(Kind::LockerItem, "Passport", None);
    let note = w.bare(Kind::Note, "N", None);
    let folder = w.container("folder", "F");
    let photo = |home: &str| {
        w.refused(
            "photo.add",
            json!({ "blob": bytes(&w, "x"), "media_type": "image/jpeg", "home": home }),
        )
    };
    assert!(photo(&locker).contains("does not go inside"));
    assert!(photo(&folder).contains("does not go inside"));
    let sentence = w.refused(
        "document.add",
        json!({ "title": "D", "blob": bytes(&w, "y"), "media_type": "application/pdf",
                "home": &note, "folder_id": &folder }),
    );
    assert!(sentence.contains("not both"), "{sentence}");
    let in_locker = w.refused(
        "document.add",
        json!({ "title": "D", "blob": bytes(&w, "y"), "media_type": "application/pdf",
                "home": &locker }),
    );
    assert!(in_locker.contains("does not go inside"), "{in_locker}");
}

#[test]
fn a_capture_on_a_person_survives_merging_them_and_an_attached_library_photo_is_not_taken() {
    let w = world("homed_merge");
    let (maya, duplicate) = (w.person("Maya"), w.person("Maya R"));
    let capture = receipt(&w, "card", &duplicate);
    let library = w.ok(
        "photo.add",
        json!({ "blob": bytes(&w, "library"), "media_type": "image/jpeg" }),
    )["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    w.ok(
        "edge.add",
        json!({ "from": &duplicate, "rel": "attached", "to": &library }),
    );
    w.ok("person.merge", json!({ "from": &duplicate, "into": &maya }));
    assert_eq!(home_of(&w, &capture).as_deref(), Some(maya.as_str()));
    assert_eq!(
        w.one::<Option<String>>("SELECT deleted_at FROM entity WHERE id = ?1", &[&capture]),
        None
    );
    assert_eq!(
        home_of(&w, &library),
        None,
        "an attached library photo stays in the library"
    );
    w.ok("entity.trash", json!({ "id": &maya }));
    assert_eq!(
        w.one::<Option<String>>("SELECT deleted_at FROM entity WHERE id = ?1", &[&library]),
        None,
        "a person's delete does not take a photo that is only attached to them"
    );
}
