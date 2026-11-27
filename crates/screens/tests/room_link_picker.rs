use std::sync::Arc;

use centraid_api_proto::core_v1 as wire;
use centraid_core::{Core, CoreConfig, Handle};
use centraid_screens::room::snapshot;
use centraid_vault::clock::{FixedClock, SeededIds};
use serde_json::json;

const WORDS: &str = "abandon abandon abandon abandon abandon abandon abandon abandon \
                     abandon abandon abandon abandon abandon abandon abandon abandon \
                     abandon abandon abandon abandon abandon abandon abandon art";
const NOW: i64 = 1_795_687_200_000;
const PERSON: &str = "01900000-0000-7000-8000-000000009010";
const NOTE: &str = "01900000-0000-7000-8000-000000009020";
const BOOK: &str = "01900000-0000-7000-8000-000000009030";
const PHOTO_SOURCE: &str = "01900000-0000-7000-8000-000000009040";
const PHOTO_PLACE: &str = "01900000-0000-7000-8000-000000009050";
const SOURCE_BLOB: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn phone(dir: &std::path::Path) -> Handle {
    let seed = centraid_identity::RecoveryPhrase::parse(WORDS)
        .expect("the vector parses")
        .seed();
    let handle = Core::open(
        CoreConfig::new(dir.join("vault.db"))
            .with_seed(seed, 0)
            .with_clock(
                Arc::new(FixedClock::at(NOW)),
                Arc::new(SeededIds::new("link-picker")),
            ),
    )
    .expect("the core opens");
    handle
        .with_vault(|vault| Ok(vault.found("Household", "Ada")?))
        .unwrap();
    handle
        .open_own_bytes(dir.join("vault.bytes"))
        .expect("the byte store opens");
    centraid_screens::attach(&handle);
    handle
}

fn room_call(handle: &Handle, kind: wire::room_request::Kind) -> Vec<wire::RoomShown> {
    let answer = handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Room(wire::RoomRequest {
                kind: Some(kind),
            })),
        })
        .expect("room call answers")
        .kind
        .expect("an answer");
    match answer {
        wire::response::Kind::Room(resp) => resp.shown,
        other => panic!("not a room response: {other:?}"),
    }
}

fn stage(handle: &Handle, media_type: &str, bytes: &[u8]) -> wire::StageHandle {
    let frame = |kind| {
        let answer = handle
            .call(&wire::Request {
                kind: Some(wire::request::Kind::Stage(wire::StageRequest {
                    kind: Some(kind),
                })),
            })
            .expect("stage frame");
        let wire::response::Kind::Stage(stage) = answer.kind.expect("stage answer") else {
            panic!("stage response");
        };
        stage.kind.expect("stage kind")
    };
    let wire::stage_response::Kind::Begun(begun) =
        frame(wire::stage_request::Kind::Begin(wire::StageBegin {
            media_type: media_type.to_owned(),
            byte_size: bytes.len() as u64,
            source: wire::StageSource::Owned as i32,
            ..Default::default()
        }))
    else {
        panic!("stage begin");
    };
    let wire::stage_response::Kind::Chunked(_) =
        frame(wire::stage_request::Kind::Chunk(wire::StageChunk {
            staging_id: begun.staging_id.clone(),
            seq: 0,
            payload: bytes.to_vec(),
        }))
    else {
        panic!("stage chunk");
    };
    let wire::stage_response::Kind::Handle(staged) =
        frame(wire::stage_request::Kind::End(wire::StageEnd {
            staging_id: begun.staging_id,
        }))
    else {
        panic!("stage end");
    };
    staged
}

fn send_response(
    handle: &Handle,
    instance: u64,
    kind: wire::room_event::Kind,
) -> wire::RoomResponse {
    let answer = handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Room(wire::RoomRequest {
                kind: Some(wire::room_request::Kind::Send(wire::RoomSend {
                    instance,
                    event: Some(wire::RoomEvent { kind: Some(kind) }),
                })),
            })),
        })
        .expect("room event");
    let wire::response::Kind::Room(response) = answer.kind.expect("room response") else {
        panic!("room response");
    };
    response
}

fn open(handle: &Handle, key: &str) -> wire::RoomShown {
    room_call(
        handle,
        wire::room_request::Kind::Open(wire::RoomOpen {
            key: key.to_owned(),
            tab: "people".to_owned(),
            root: false,
            ..Default::default()
        }),
    )
    .remove(0)
}

fn open_photo(handle: &Handle, key: &str, root: bool) -> wire::RoomShown {
    room_call(
        handle,
        wire::room_request::Kind::Open(wire::RoomOpen {
            key: key.to_owned(),
            tab: "photos".to_owned(),
            root,
            ..Default::default()
        }),
    )
    .remove(0)
}

fn send(handle: &Handle, instance: u64, kind: wire::room_event::Kind) -> wire::RoomShown {
    room_call(
        handle,
        wire::room_request::Kind::Send(wire::RoomSend {
            instance,
            event: Some(wire::RoomEvent { kind: Some(kind) }),
        }),
    )
    .remove(0)
}

fn tap(selector_id: &str) -> wire::room_event::Kind {
    wire::room_event::Kind::Tap(wire::RoomTap {
        selector_id: selector_id.to_owned(),
    })
}

#[test]
fn link_picker_adds_a_search_result_and_undoes_the_link() {
    let dir = tempfile::tempdir().unwrap();
    let handle = phone(dir.path());
    for (command, input, key) in [
        (
            "person.add",
            json!({"id": PERSON, "title": "Priya Nair"}),
            "person",
        ),
        (
            "container.create",
            json!({"id": BOOK, "kind": "notebook", "title": "General"}),
            "notebook",
        ),
        (
            "note.create",
            json!({"id": NOTE, "title": "Kitchen plans", "body": "Ideas", "notebook_id": BOOK}),
            "note",
        ),
    ] {
        let done = handle.command(command, &input, key).expect("seed command");
        assert_eq!(done.status, centraid_vault::CommandStatus::Executed);
    }

    let detail = open(&handle, &format!("person/{PERSON}"));
    let picker = send(&handle, detail.instance, tap("footer/linked/add"));
    let searched = send(
        &handle,
        picker.instance,
        wire::room_event::Kind::Change(wire::RoomChange {
            selector_id: "field/query".to_owned(),
            seq: 1,
            value: Some(wire::room_change::Value::Text("Kitchen".to_owned())),
        }),
    );
    let room = searched.room.as_ref().expect("link picker is shown");
    assert!(snapshot::render(room).contains(&format!("target/{NOTE}")));

    let added = send(&handle, searched.instance, tap(&format!("target/{NOTE}")));
    let rendered = snapshot::render(added.room.as_ref().expect("person detail returns"));
    assert!(rendered.contains("Kitchen plans"), "{rendered}");
    assert!(
        rendered.contains("Undo"),
        "the link action offers Undo: {rendered}"
    );

    let undone = send(&handle, added.instance, tap("status/undo"));
    let rendered = snapshot::render(undone.room.as_ref().expect("person detail returns"));
    assert!(!rendered.contains("Kitchen plans"), "{rendered}");

    let relinked = send(&handle, undone.instance, tap("footer/linked/add"));
    let searched = send(
        &handle,
        relinked.instance,
        wire::room_event::Kind::Change(wire::RoomChange {
            selector_id: "field/query".to_owned(),
            seq: 1,
            value: Some(wire::room_change::Value::Text("Kitchen".to_owned())),
        }),
    );
    let added_again = send(&handle, searched.instance, tap(&format!("target/{NOTE}")));
    let removed = send(
        &handle,
        added_again.instance,
        tap(&format!("linked/{NOTE}/unlink")),
    );
    let rendered = snapshot::render(removed.room.as_ref().expect("person detail returns"));
    assert!(
        !rendered.contains("Kitchen plans"),
        "unlink removes the target: {rendered}"
    );
    assert!(rendered.contains("Undo"), "unlink offers Undo: {rendered}");
    let restored = send(&handle, removed.instance, tap("status/undo"));
    let rendered = snapshot::render(restored.room.as_ref().expect("person detail returns"));
    assert!(
        rendered.contains("Kitchen plans"),
        "Undo restores the link: {rendered}"
    );
}

#[test]
fn staged_file_picker_adds_a_real_homed_attachment_with_undo() {
    let dir = tempfile::tempdir().unwrap();
    let handle = phone(dir.path());
    for (command, input, key) in [
        (
            "container.create",
            json!({"id": BOOK, "kind": "notebook", "title": "General"}),
            "notebook",
        ),
        (
            "note.create",
            json!({"id": NOTE, "title": "Kitchen plans", "body": "Ideas", "notebook_id": BOOK}),
            "note",
        ),
    ] {
        let done = handle.command(command, &input, key).expect("seed command");
        assert_eq!(done.status, centraid_vault::CommandStatus::Executed);
    }
    let note = open(&handle, &format!("notes/note/{NOTE}"));
    let chosen = send_response(&handle, note.instance, tap("attach/add/file"));
    let effect = chosen
        .effects
        .iter()
        .find(|effect| {
            matches!(
                effect.kind.as_ref(),
                Some(wire::shell_effect::Kind::PickFile(_))
            )
        })
        .expect("the attachment menu opens the native file picker");
    let bytes = b"%PDF-1.7\nreceipt bytes";
    let staged = stage(&handle, "application/pdf", bytes);
    let attached = send_response(
        &handle,
        note.instance,
        wire::room_event::Kind::EffectResult(wire::ShellEffectResult {
            effect_id: effect.effect_id,
            outcome: Some(wire::shell_effect_result::Outcome::Picked(
                wire::ShellPicked {
                    items: vec![wire::ShellPickedItem {
                        name: "Receipt.pdf".to_owned(),
                        media_type: "application/pdf".to_owned(),
                        size: staged.byte_size,
                        stage_handle: Some(staged),
                        ..Default::default()
                    }],
                },
            )),
        }),
    );
    let shown = attached.shown.first().expect("note detail returns");
    let text = snapshot::render(shown.room.as_ref().expect("note room"));
    assert!(text.contains("Receipt.pdf"), "{text}");
    assert_eq!(
        shown
            .room
            .as_ref()
            .unwrap()
            .status_line
            .as_ref()
            .unwrap()
            .action_label,
        "Undo"
    );
}

#[test]
fn docs_scan_sheet_imports_the_staged_capture_as_a_scan() {
    let dir = tempfile::tempdir().unwrap();
    let handle = phone(dir.path());
    let add = open(&handle, "docs/add");
    let picker = send_response(&handle, add.instance, tap("add/scan"));
    let effect = picker
        .effects
        .iter()
        .find(|effect| {
            matches!(
                effect.kind.as_ref(),
                Some(wire::shell_effect::Kind::ScanDocument(_))
            )
        })
        .expect("Docs starts the document scanner");
    let staged = stage(&handle, "application/pdf", b"%PDF-1.7\nscanned page");
    let added = send_response(
        &handle,
        add.instance,
        wire::room_event::Kind::EffectResult(wire::ShellEffectResult {
            effect_id: effect.effect_id,
            outcome: Some(wire::shell_effect_result::Outcome::Picked(
                wire::ShellPicked {
                    items: vec![wire::ShellPickedItem {
                        name: "Lease scan.pdf".to_owned(),
                        media_type: "application/pdf".to_owned(),
                        size: staged.byte_size,
                        stage_handle: Some(staged),
                        ..Default::default()
                    }],
                },
            )),
        }),
    );
    assert!(
        added.shown.iter().any(|shown| shown
            .room
            .as_ref()
            .and_then(|room| room.status_line.as_ref())
            .is_some_and(|line| line.action_label == "Undo")),
        "scan import should be an undoable document.add: {:#?}",
        added.shown
    );
    let docs = open(&handle, "docs");
    let rendered = snapshot::render(docs.room.as_ref().unwrap());
    assert!(
        rendered.contains("Lease scan.pdf"),
        "scanned document is imported: {rendered}"
    );
}

#[test]
fn photo_picker_saves_an_edited_copy_with_source_moment_place_and_cancel_safety() {
    let dir = tempfile::tempdir().unwrap();
    let handle = phone(dir.path());
    let place = handle
        .command(
            "place.add",
            &serde_json::json!({"id": PHOTO_PLACE, "title": "Baker Beach"}),
            "photo-place",
        )
        .expect("place command");
    assert_eq!(place.status, centraid_vault::CommandStatus::Executed);
    let source = handle
        .command(
            "photo.add",
            &serde_json::json!({
                "id": PHOTO_SOURCE,
                "title": "Original beach photo",
                "blob": SOURCE_BLOB,
                "size": 1200,
                "media_type": "image/jpeg",
                "form": "photo",
                "taken_at": "2026-11-20T10:15:00.000Z",
                "place_id": PHOTO_PLACE
            }),
            "photo-source",
        )
        .expect("source photo command");
    assert_eq!(source.status, centraid_vault::CommandStatus::Executed);

    let library = open_photo(&handle, "photos", true);
    let picker = send_response(&handle, library.instance, tap("header/add"));
    let effect = picker
        .effects
        .iter()
        .find(|effect| {
            matches!(
                effect.kind.as_ref(),
                Some(wire::shell_effect::Kind::PickPhoto(_))
            )
        })
        .expect("Photos Add photo opens the native photo picker");
    let picked = stage(&handle, "image/png", b"new library image bytes");
    let imported = send_response(
        &handle,
        library.instance,
        wire::room_event::Kind::EffectResult(wire::ShellEffectResult {
            effect_id: effect.effect_id,
            outcome: Some(wire::shell_effect_result::Outcome::Picked(
                wire::ShellPicked {
                    items: vec![wire::ShellPickedItem {
                        name: "Picked photo.png".to_owned(),
                        media_type: "image/png".to_owned(),
                        size: picked.byte_size,
                        stage_handle: Some(picked),
                        ..Default::default()
                    }],
                },
            )),
        }),
    );
    assert_eq!(
        imported
            .shown
            .last()
            .unwrap()
            .room
            .as_ref()
            .unwrap()
            .status_line
            .as_ref()
            .unwrap()
            .action_label,
        "Undo"
    );

    let viewer = open_photo(&handle, &format!("photos/photo/{PHOTO_SOURCE}"), false);
    let sheet = send(&handle, viewer.instance, tap("viewer/menu/edited-copy"));
    assert_eq!(
        sheet.room.as_ref().unwrap().key,
        format!("photos/photo/{PHOTO_SOURCE}/edited-copy")
    );
    let picker = send_response(&handle, sheet.instance, tap("edited-copy/choose"));
    let effect = picker
        .effects
        .iter()
        .find(|effect| {
            matches!(
                effect.kind.as_ref(),
                Some(wire::shell_effect::Kind::PickPhoto(_))
            )
        })
        .expect("the route asks the native photo picker for the finished edit");
    let cancelled = send_response(
        &handle,
        sheet.instance,
        wire::room_event::Kind::EffectResult(wire::ShellEffectResult {
            effect_id: effect.effect_id,
            outcome: Some(wire::shell_effect_result::Outcome::Failed(
                wire::ShellFailed {
                    cancelled: true,
                    ..Default::default()
                },
            )),
        }),
    );
    assert!(
        cancelled
            .shown
            .last()
            .unwrap()
            .room
            .as_ref()
            .unwrap()
            .status_line
            .is_none()
    );

    let picker = send_response(&handle, sheet.instance, tap("edited-copy/choose"));
    let effect = picker
        .effects
        .iter()
        .find(|effect| {
            matches!(
                effect.kind.as_ref(),
                Some(wire::shell_effect::Kind::PickPhoto(_))
            )
        })
        .expect("picker can be retried after cancellation");
    let failed = send_response(
        &handle,
        sheet.instance,
        wire::room_event::Kind::EffectResult(wire::ShellEffectResult {
            effect_id: effect.effect_id,
            outcome: Some(wire::shell_effect_result::Outcome::Failed(
                wire::ShellFailed {
                    reason: "UNAVAILABLE".to_owned(),
                    cancelled: false,
                    ..Default::default()
                },
            )),
        }),
    );
    assert!(
        failed
            .shown
            .last()
            .unwrap()
            .room
            .as_ref()
            .unwrap()
            .status_line
            .as_ref()
            .is_some_and(|line| line.refused)
    );

    let picker = send_response(&handle, sheet.instance, tap("edited-copy/choose"));
    let effect = picker
        .effects
        .iter()
        .find(|effect| {
            matches!(
                effect.kind.as_ref(),
                Some(wire::shell_effect::Kind::PickPhoto(_))
            )
        })
        .expect("the picker can be opened again after cancel");
    let staged = stage(&handle, "image/png", b"member finished image bytes");
    let expected_blob = staged.content_hash.clone();
    let added = send_response(
        &handle,
        sheet.instance,
        wire::room_event::Kind::EffectResult(wire::ShellEffectResult {
            effect_id: effect.effect_id,
            outcome: Some(wire::shell_effect_result::Outcome::Picked(
                wire::ShellPicked {
                    items: vec![wire::ShellPickedItem {
                        name: "finished-edit.png".to_owned(),
                        media_type: "image/png".to_owned(),
                        size: staged.byte_size,
                        stage_handle: Some(staged),
                        ..Default::default()
                    }],
                },
            )),
        }),
    );
    assert_eq!(
        added
            .shown
            .last()
            .unwrap()
            .room
            .as_ref()
            .unwrap()
            .status_line
            .as_ref()
            .unwrap()
            .action_label,
        "Undo"
    );

    let library = open_photo(&handle, "photos", true);
    let ready = match library.room.as_ref().unwrap().state.as_ref().unwrap() {
        wire::room::State::Ready(ready) => ready,
        other => panic!("Photos library is ready: {other:?}"),
    };
    let edited_id = ready
        .blocks
        .iter()
        .filter_map(|block| match block.kind.as_ref() {
            Some(wire::room_block::Kind::PhotoGrid(grid)) => Some(grid),
            _ => None,
        })
        .flat_map(|grid| grid.sections.iter())
        .flat_map(|section| section.tiles.iter())
        .find(|tile| {
            tile.thumb
                .as_ref()
                .is_some_and(|thumb| thumb.r#ref == expected_blob)
        })
        .and_then(|tile| tile.selector_id.strip_prefix("tile/").map(str::to_owned))
        .expect("the new image is an independent library photo");
    assert_ne!(edited_id, PHOTO_SOURCE);
    let edited = open_photo(&handle, &format!("photos/photo/{edited_id}"), false);
    let details = send(&handle, edited.instance, tap("viewer/media"));
    let rendered = snapshot::render(details.room.as_ref().unwrap());
    assert!(
        rendered.contains("Edited from"),
        "lineage is visible: {rendered}"
    );
    assert!(
        rendered.contains("Original beach photo"),
        "source photo is named: {rendered}"
    );
    assert!(
        rendered.contains("Baker Beach"),
        "source place is inherited: {rendered}"
    );
    assert!(
        rendered.contains("2026-11-20"),
        "source moment is inherited: {rendered}"
    );

    let unchanged = open_photo(&handle, &format!("photos/photo/{PHOTO_SOURCE}"), false);
    let unchanged = send(&handle, unchanged.instance, tap("viewer/media"));
    let rendered = snapshot::render(unchanged.room.as_ref().unwrap());
    assert!(
        rendered.contains("Original beach photo"),
        "the original remains: {rendered}"
    );
    assert!(
        !rendered.contains("Edited from"),
        "the original has no parent lineage: {rendered}"
    );
}
