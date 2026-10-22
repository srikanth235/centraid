//! **WHICH ASSET A LIBRARY ITEM WAS BACKED UP AS** (`library_assets`, #1127,
//! A20), through the core's own door.
//!
//! An item edited in place keeps its ref and changes its bytes, so the shell
//! asks the ledger which asset the ref was last backed up as — before staging
//! the new bytes — and names it as the edit's source. Each case is one way the
//! answer could lie: an asset that is not there, a trashed one, the older of
//! two versions staged under one ref, a ref another item wears, too many refs.

mod common;

use centraid_api_proto::core_v1 as wire;
use common::*;

fn asked(handle: &centraid_core::Handle, refs: &[&str]) -> Vec<wire::LibraryAsset> {
    let wire::response::Kind::LibraryAssets(answer) = ask(
        handle,
        wire::request::Kind::LibraryAssets(wire::LibraryAssetsRequest {
            os_ref: refs.iter().map(|os_ref| (*os_ref).to_owned()).collect(),
        }),
    ) else {
        panic!("library_assets answers");
    };
    let mut items = answer.items;
    items.sort_by(|left, right| left.os_ref.cmp(&right.os_ref));
    items
}

/// One library item staged under `os_ref` and committed as an asset.
fn imported(
    handle: &centraid_core::Handle,
    os_ref: &str,
    label: &str,
) -> (wire::StageHandle, String) {
    let bytes = bytes_of(label, 40_000);
    let staged = stage(handle, library("image/heic", os_ref, &bytes, false), &bytes);
    let asset = add_asset(handle, &staged, "photo");
    (staged, asset)
}

#[test]
fn a_ref_answers_the_live_asset_its_bytes_were_filed_as() {
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    let (staged, asset) = imported(&phone, "image:7", "the camera's version");
    imported(&phone, "image:8", "another photograph");

    let items = asked(&phone, &["image:7", "image:unknown", ""]);
    assert_eq!(items.len(), 1, "an unknown ref and an empty one are absent");
    assert_eq!(items[0].os_ref, "image:7");
    assert_eq!(items[0].asset_id, asset);
    assert_eq!(hex::encode(&items[0].content_hash), staged.content_hash);
    assert!(asked(&phone, &[]).is_empty());
}

#[test]
fn a_trashed_asset_is_not_an_answer() {
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    let (_, asset) = imported(&phone, "image:7", "a photograph the member trashed");
    assert_eq!(asked(&phone, &["image:7"]).len(), 1);

    command(
        &phone,
        "entity.trash",
        &serde_json::json!({ "id": asset }),
        "delete-7",
    );
    assert!(
        asked(&phone, &["image:7"]).is_empty(),
        "the shell then files the edit as a photograph of its own"
    );
}

#[test]
fn a_ref_staged_twice_answers_the_newer_version() {
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    let (_, first) = imported(&phone, "image:7", "the camera's version");
    // THE EDIT, IN PLACE: the same ref, new bytes — what the walker stages
    // after it has asked, so the NEXT edit's source is this one.
    std::thread::sleep(std::time::Duration::from_millis(5));
    let (second_staged, second) = imported(&phone, "image:7", "the edited version");
    assert_ne!(first, second);

    let items = asked(&phone, &["image:7"]);
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].asset_id, second);
    assert_eq!(
        hex::encode(&items[0].content_hash),
        second_staged.content_hash
    );
}

#[test]
fn bytes_the_ledger_holds_and_no_asset_wraps_are_absent() {
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    // STAGED, NEVER COMMITTED: the ledger has the ref, the vault has no row.
    let bytes = bytes_of("staged and not filed", 40_000);
    stage(
        &phone,
        library("image/heic", "image:9", &bytes, false),
        &bytes,
    );
    assert!(asked(&phone, &["image:9"]).is_empty());
}

#[test]
fn more_than_a_hundred_refs_is_refused() {
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    let refs: Vec<String> = (0..101).map(|index| format!("image:{index}")).collect();
    let refused = try_ask(
        &phone,
        wire::request::Kind::LibraryAssets(wire::LibraryAssetsRequest { os_ref: refs }),
    );
    assert!(refused.is_err(), "a hundred and one refs is too many");
}
