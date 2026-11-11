//! Photos' export of its originals (`photos.export`, #1185): the Collections page's Export row
//! beside Trash, "All photos and videos" and each album, the owner check first, and then a
//! STREAMED file: the core stages one zip on disk and the OS save sheet is offered its path
//! (`SaveFilePath`), never its bytes. Every test goes through `Driver`.

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::act;
use centraid_screens::field::{Field, Keyed};
use centraid_screens::kit::act as kit_act;
use centraid_screens::kit::export;
use centraid_screens::photos;
use centraid_screens::strings::Locale;
use centraid_screens::testing::Driver;
use centraid_vault::bytes::BlobStore;
use centraid_vault::portable::zip::stored_entries;

fn transfer(v: &wire::ViewState) -> &wire::TransferView {
    match &v.kind {
        Some(wire::view_state::Kind::Transfer(view)) => view,
        other => panic!("not a transfer: {other:?}"),
    }
}

fn driver() -> Driver {
    let mut d = Driver::with_runtime(photos::runtime());
    d.start();
    d
}

fn open(d: &mut Driver) -> u64 {
    let entry = export::entry(Locale::En, photos::EXPORT);
    d.push(photos::TAB, entry.route)
}

fn tap(d: &mut Driver, i: u64, key: &str) {
    d.effects.clear();
    d.send(
        i,
        wire::screen_event::Kind::Transfer(wire::TransferEvent {
            key: key.to_owned(),
            ..Default::default()
        }),
    );
}

fn arrange(d: &Driver, request: impl Into<wire::ActRequest>) -> serde_json::Value {
    let response = d.act(
        request
            .into()
            .keyed(format!("arrange:{}", kit_act::fresh())),
    );
    assert_eq!(
        response.status,
        wire::ActStatus::Executed as i32,
        "arranging was refused: {}",
        response.reason
    );
    serde_json::from_slice(&response.output).unwrap_or_default()
}

/// A photograph whose original bytes are in the content store.
fn photo(d: &Driver, body: &str, taken_at: &str) -> String {
    let hash = d
        .handle
        .bytes()
        .expect("a content store")
        .put(body.as_bytes())
        .expect("stored");
    let staged = d
        .handle
        .command(
            "blob.stage",
            &serde_json::json!({ "hash": hash, "size": body.len() }),
            &format!("photos-export:{}", kit_act::fresh()),
        )
        .expect("staged");
    assert_eq!(staged.status, centraid_vault::CommandStatus::Executed);
    let value = arrange(
        d,
        act::photos::Upload {
            blob: hash,
            media_type: "image/jpeg".to_owned(),
            form: Some(act::photos::UploadForm::Photo),
            taken_at: Field::Is(taken_at.to_owned()),
            offset_min: Field::Is(0),
            ..Default::default()
        },
    );
    value["id"].as_str().expect("an id").to_owned()
}

fn first_kind(d: &Driver) -> Option<wire::effect::Kind> {
    d.effects
        .first()
        .and_then(|e| e.effect.as_ref())
        .and_then(|e| e.kind.clone())
}

fn pass_owner_check(d: &mut Driver) {
    while matches!(first_kind(d), Some(wire::effect::Kind::OwnerCheck(_))) {
        d.answer_effect(wire::effect_result::Outcome::OwnerChecked(
            wire::OwnerChecked {
                available: true,
                outcome: wire::owner_checked::Outcome::Succeeded as i32,
                ..wire::OwnerChecked::default()
            },
        ));
    }
}

fn staged(d: &Driver) -> wire::SaveFilePath {
    let Some(wire::effect::Kind::SaveFilePath(save)) = d
        .effects
        .last()
        .and_then(|e| e.effect.as_ref())
        .and_then(|e| e.kind.clone())
    else {
        panic!("the save sheet was offered a staged file: {:?}", d.effects);
    };
    save
}

fn entries(save: &wire::SaveFilePath) -> Vec<(String, String)> {
    let bytes = std::fs::read(&save.path).expect("the staged file is on disk");
    let mut listed: Vec<(String, String)> = stored_entries(&bytes)
        .expect("a zip")
        .into_iter()
        .map(|(name, body)| (name, String::from_utf8_lossy(&body).into_owned()))
        .collect();
    listed.sort();
    listed
}

#[test]
fn collections_offers_export_beside_trash_and_it_lists_the_library_and_each_album() {
    let mut d = driver();
    arrange(
        &d,
        act::photos::CreateAlbum {
            title: "Summer".to_owned(),
            id: None,
        },
    );
    let entry = export::entry(Locale::En, photos::EXPORT);
    assert_eq!(entry.label, "Export");
    let i = open(&mut d);
    let page = transfer(d.view(i));
    assert_eq!(page.title, "Export photos");
    let labels: Vec<&str> = page.rows.iter().map(|r| r.label.as_str()).collect();
    assert_eq!(labels[0], "All photos and videos");
    assert!(labels.contains(&"Summer"));
}

#[test]
fn a_tap_asks_the_owner_check_then_offers_the_staged_file_of_originals() {
    let mut d = driver();
    let album = arrange(
        &d,
        act::photos::CreateAlbum {
            title: "Summer".to_owned(),
            id: None,
        },
    )["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    let inside = photo(&d, "pe-inside", "2026-07-01T10:00:00.000Z");
    photo(&d, "pe-outside", "2026-07-02T10:00:00.000Z");
    arrange(
        &d,
        act::photos::AddToAlbum {
            from: album.clone(),
            to: inside,
            position: Field::Keep,
        },
    );
    let i = open(&mut d);
    tap(&mut d, i, &album);
    assert!(matches!(
        first_kind(&d),
        Some(wire::effect::Kind::OwnerCheck(_))
    ));
    assert!(
        !d.effects.iter().any(|e| matches!(
            e.effect.as_ref().and_then(|e| e.kind.as_ref()),
            Some(wire::effect::Kind::SaveFilePath(_) | wire::effect::Kind::SaveFile(_))
        )),
        "nothing is made before the check"
    );
    pass_owner_check(&mut d);
    let save = staged(&d);
    assert_eq!(save.name, "Summer.zip");
    assert_eq!(save.media_type, "application/zip");
    assert_eq!(
        entries(&save),
        [(
            "2026/2026-07-01 100000.jpg".to_owned(),
            "pe-inside".to_owned()
        )]
    );
    d.answer_effect(wire::effect_result::Outcome::Done(wire::EffectDone {}));
    assert_eq!(
        transfer(d.view(i))
            .status
            .as_ref()
            .map(|s| s.sentence.as_str()),
        Some("Export saved: 1 file")
    );
}

#[test]
fn all_photos_and_videos_is_one_archive_with_the_trash_left_out() {
    let mut d = driver();
    photo(&d, "pe-kept", "2026-08-01T10:00:00.000Z");
    let gone = photo(&d, "pe-gone", "2026-08-02T10:00:00.000Z");
    arrange(&d, act::photos::DeletePhoto { photo_id: gone });
    let i = open(&mut d);
    tap(&mut d, i, "all");
    pass_owner_check(&mut d);
    let save = staged(&d);
    assert_eq!(save.name, "Photos.zip");
    // The example library is in the vault too; the archive holds ours and not the trashed one.
    let listed = entries(&save);
    assert!(listed.contains(&(
        "2026/2026-08-01 100000.jpg".to_owned(),
        "pe-kept".to_owned()
    )));
    assert!(!listed.iter().any(|(_, body)| body == "pe-gone"));
}

#[test]
fn an_album_with_nothing_in_it_says_so_and_offers_nothing_to_save() {
    let mut d = driver();
    let empty = arrange(
        &d,
        act::photos::CreateAlbum {
            title: "Empty".to_owned(),
            id: None,
        },
    )["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    let i = open(&mut d);
    tap(&mut d, i, &empty);
    pass_owner_check(&mut d);
    assert!(!d.effects.iter().any(|e| matches!(
        e.effect.as_ref().and_then(|e| e.kind.as_ref()),
        Some(wire::effect::Kind::SaveFilePath(_))
    )));
    let status = transfer(d.view(i)).status.clone().expect("a line");
    assert!(status.refused);
    assert_eq!(
        status.sentence,
        "There are no photos or videos on this phone to export."
    );
}

#[test]
fn a_cancelled_check_makes_no_file() {
    let mut d = driver();
    photo(&d, "pe-cancel", "2026-08-03T10:00:00.000Z");
    let i = open(&mut d);
    tap(&mut d, i, "all");
    d.answer_effect(wire::effect_result::Outcome::OwnerChecked(
        wire::OwnerChecked {
            available: true,
            outcome: wire::owner_checked::Outcome::Cancelled as i32,
            ..wire::OwnerChecked::default()
        },
    ));
    assert!(!d.effects.iter().any(|e| matches!(
        e.effect.as_ref().and_then(|e| e.kind.as_ref()),
        Some(wire::effect::Kind::SaveFilePath(_))
    )));
    assert!(transfer(d.view(i)).status.is_none());
}
