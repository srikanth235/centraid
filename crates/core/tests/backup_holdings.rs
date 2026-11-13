//! WHAT EACH APP'S BACKUP HOLDS, AGAINST A REAL GATEWAY (#1144).
//!
//! `backup-status` answers one row per app — what it holds, its size on this
//! phone, how much a gateway acknowledged — and the bytes each gateway holds.
//! These cases write through the apps' own commands, pass, and read it back:
//! the rows add up to the totals, the videos the member left out are said
//! apart, and a note written after the last snapshot is an edit that waits.

mod common;

use centraid_api_proto::core_v1 as wire;
use serde_json::json;

use common::*;

fn app<'a>(status: &'a wire::BackupStatusResponse, id: &str) -> &'a wire::AppHolding {
    status
        .apps
        .iter()
        .find(|row| row.app_id == id)
        .unwrap_or_else(|| panic!("no `{id}` row in {status:?}"))
}

#[test]
fn every_app_says_what_it_holds_and_the_rows_add_up() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    pair(&phone, &gateway);

    let photo = bytes_of("a photograph of the harbour", 120_000);
    let photo_handle = stage(&phone, owned("image/jpeg", &photo), &photo);
    add_asset(&phone, &photo_handle, "photo");
    let thumb = bytes_of("the harbour, small", 4_000);
    stage(&phone, thumb_of(&photo_handle, &thumb), &thumb);
    let film = bytes_of("a film of the harbour", 300_000);
    let film_handle = stage(&phone, owned("video/mp4", &film), &film);
    add_asset(&phone, &film_handle, "video");
    let note = command(
        &phone,
        "note.create",
        &json!({ "title": "Tides", "body": "high at six", "format": "plain" }),
        "note:tides",
    )["id"]
        .as_str()
        .expect("a note id")
        .to_owned();

    // THE MEMBER LEFT VIDEOS OUT, and the pass was told so.
    drain(
        &phone,
        wire::DrainRequest {
            exclude_videos: true,
            ..at_home()
        },
    );
    let backed = status(&phone);

    // Every app in the catalogue has a row, in the product's order.
    let ids: Vec<&str> = backed.apps.iter().map(|row| row.app_id.as_str()).collect();
    assert_eq!(
        ids,
        [
            "calendar",
            "docs",
            "health",
            "locker",
            "money",
            "notes",
            "people",
            "photos",
            "reminders"
        ]
    );
    let photos = app(&backed, "photos");
    assert_eq!(
        (photos.items, photos.items_confirmed, photos.waiting),
        (2, 1, 0),
        "{photos:?}"
    );
    assert_eq!(
        (photos.left_out_items, photos.left_out_bytes),
        (1, 300_000),
        "the film is left out, and said apart: {photos:?}"
    );
    assert!(
        photos.bytes >= 124_000,
        "the photograph and its thumbnail: {photos:?}"
    );
    assert_eq!(app(&backed, "notes").items, 1);

    // THE ROWS ADD UP TO THE TOTALS, and everything counted is backed up.
    let sum: u64 = backed.apps.iter().map(|row| row.bytes).sum();
    assert_eq!(backed.total_bytes, sum, "{backed:?}");
    assert_eq!(backed.confirmed_bytes, backed.total_bytes, "{backed:?}");
    assert_eq!((backed.left_out_items, backed.left_out_bytes), (1, 300_000));
    assert!(
        backed.apps.iter().all(|row| row.edits_waiting == 0),
        "{backed:?}"
    );

    // THE GATEWAY HOLDS WHAT IT ACKNOWLEDGED: the photograph, its thumbnail
    // and the snapshot, as sealed bytes recorded by size.
    let held = backed.destinations[0].held_bytes;
    assert!(held >= 124_000, "held {held}");

    // A NOTE WRITTEN AFTER THE SNAPSHOT is an edit that waits for the next.
    std::thread::sleep(std::time::Duration::from_millis(5));
    command(
        &phone,
        "note.edit",
        &json!({ "id": note, "body": "high at seven" }),
        "note:tides:edit",
    );
    let edited = status(&phone);
    assert_eq!(app(&edited, "notes").edits_waiting, 1, "{edited:?}");
    assert_eq!(app(&edited, "photos").edits_waiting, 0, "{edited:?}");
}

#[test]
fn a_vault_never_backed_up_holds_bytes_and_none_is_confirmed() {
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    let photo = bytes_of("a photograph before any pairing", 50_000);
    let photo_handle = stage(&phone, owned("image/jpeg", &photo), &photo);
    add_asset(&phone, &photo_handle, "photo");

    let unpaired = status(&phone);
    assert!(unpaired.total_bytes >= 50_000, "{unpaired:?}");
    assert_eq!(unpaired.confirmed_bytes, 0, "{unpaired:?}");
    let photos = app(&unpaired, "photos");
    assert_eq!((photos.items, photos.waiting), (1, 1), "{photos:?}");
}

#[test]
fn shared_originals_count_each_visible_app_item_without_copying_their_bytes() {
    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    pair(&phone, &gateway);
    let film = bytes_of("one public movie shown in Photos and Docs", 300_000);
    let staged = stage(&phone, owned("video/mp4", &film), &film);
    add_asset(&phone, &staged, "video");
    let mut documents = Vec::new();
    for n in 0..2 {
        let made = command(
            &phone,
            "document.add",
            &json!({
                "blob": staged.content_hash,
                "size": staged.byte_size,
                "media_type": "video/mp4",
                "title": format!("Public movie wrapper {n}"),
            }),
            &format!("shared-movie-document-{n}"),
        );
        documents.push(made["id"].as_str().expect("document id").to_owned());
    }
    let waiting = status(&phone);
    assert_eq!(
        (
            app(&waiting, "photos").items,
            app(&waiting, "photos").waiting
        ),
        (1, 1)
    );
    assert_eq!(
        (app(&waiting, "docs").items, app(&waiting, "docs").waiting),
        (2, 2)
    );
    assert_eq!(
        waiting.content_total, 1,
        "one physical original, three visible items"
    );

    drain(&phone, at_home());
    let backed = status(&phone);
    assert_eq!(
        (
            app(&backed, "photos").items,
            app(&backed, "photos").items_confirmed
        ),
        (1, 1)
    );
    assert_eq!(
        (
            app(&backed, "docs").items,
            app(&backed, "docs").items_confirmed
        ),
        (2, 2)
    );
    assert_eq!(backed.content_total, 1);
    assert_eq!(backed.content_confirmed, 1);
    assert_eq!(
        backed.apps.iter().map(|row| row.bytes).sum::<u64>(),
        backed.total_bytes
    );
    assert_eq!(backed.confirmed_bytes, backed.total_bytes);

    command(
        &phone,
        "entity.trash",
        &json!({ "id": documents[0] }),
        "trash-public-wrapper",
    );
    let trashed = status(&phone);
    assert_eq!(
        app(&trashed, "docs").items,
        1,
        "trash retains bytes but is not a visible document"
    );
    assert_eq!(app(&trashed, "photos").items, 1);
    assert_eq!(
        trashed.content_total, 1,
        "the shared original remains one file"
    );
}

#[test]
fn people_item_count_matches_the_visible_circle_and_keeps_hidden_records_in_backup() {
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    assert_eq!(
        app(&status(&phone), "people").items,
        0,
        "the owner is not a circle item"
    );
    let person = command(
        &phone,
        "person.add",
        &json!({"title":"Visible contact"}),
        "visible-contact",
    )["id"]
        .as_str()
        .expect("person id")
        .to_owned();
    command(
        &phone,
        "person.add",
        &json!({"title":"A pet", "form":"pet"}),
        "hidden-pet",
    );
    phone
        .with_vault(|vault| {
            let now = vault.clock().now_text();
            Ok(vault.commit(|tx| {
                tx.set_producer("test.entity_without_person_row");
                tx.insert_entity(
                    "orphan-person",
                    centraid_vault::model::Kind::Person,
                    "No person row",
                    &now,
                )?;
                Ok(())
            })?)
        })
        .expect("fixture entity");
    let before = phone
        .with_vault(|vault| {
            Ok(centraid_vault::backup::holdings::holdings(vault, None).expect("holdings"))
        })
        .expect("vault");
    assert_eq!(
        before.live.get("person"),
        Some(&4),
        "hidden records remain in the raw backup weights"
    );
    assert_eq!(
        app(&status(&phone), "people").items,
        1,
        "only the actual visible contact counts"
    );
    command(
        &phone,
        "entity.trash",
        &json!({"id":person}),
        "trash-visible-contact",
    );
    assert_eq!(
        app(&status(&phone), "people").items,
        0,
        "trash is outside the circle"
    );
}
