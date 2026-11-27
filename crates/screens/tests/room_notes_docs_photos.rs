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

const BOOK_ID: &str = "01900000-0000-7000-8000-000000001010";
const NOTE_PINNED_ID: &str = "01900000-0000-7000-8000-000000001020";
const NOTE_PLAIN_ID: &str = "01900000-0000-7000-8000-000000001030";
const NOTE_JOURNAL_ID: &str = "01900000-0000-7000-8000-000000001040";
const PERSON_ID: &str = "01900000-0000-7000-8000-000000001050";

const FOLDER_ID: &str = "01900000-0000-7000-8000-000000002010";
const SUBFOLDER_ID: &str = "01900000-0000-7000-8000-000000002020";
const DOC_TOP_ID: &str = "01900000-0000-7000-8000-000000002030";
const DOC_FOLDER_ID: &str = "01900000-0000-7000-8000-000000002040";
const DOC_HOMED_CAPTURE_ID: &str = "01900000-0000-7000-8000-000000002050";

const PHOTO_LIB_ID: &str = "01900000-0000-7000-8000-000000003010";
const PHOTO_VIDEO_ID: &str = "01900000-0000-7000-8000-000000003020";
const PHOTO_HOMED_CAPTURE_ID: &str = "01900000-0000-7000-8000-000000003030";
const ALBUM_ID: &str = "01900000-0000-7000-8000-000000003040";
const PLACE_A_ID: &str = "01900000-0000-7000-8000-000000003050";
const PLACE_B_ID: &str = "01900000-0000-7000-8000-000000003060";
const EVENT_AT_PLACE_ID: &str = "01900000-0000-7000-8000-000000003070";

const BLOB_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BLOB_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const BLOB_C: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const BLOB_D: &str = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

fn phone(dir: &std::path::Path) -> Handle {
    let seed = centraid_identity::RecoveryPhrase::parse(WORDS)
        .expect("the vector parses")
        .seed();
    let handle = Core::open(
        CoreConfig::new(dir.join("vault.db"))
            .with_seed(seed, 0)
            .with_clock(
                Arc::new(FixedClock::at(NOW)),
                Arc::new(SeededIds::new("notes-docs-photos")),
            ),
    )
    .expect("the core opens");
    handle
        .with_vault(|vault| Ok(vault.found("Household", "Ada")?))
        .expect("it founds");
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

fn open(handle: &Handle, key: &str, tab: &str, root: bool) -> wire::RoomShown {
    room_call(
        handle,
        wire::room_request::Kind::Open(wire::RoomOpen {
            key: key.to_owned(),
            tab: tab.to_owned(),
            root,
            ..Default::default()
        }),
    )
    .remove(0)
}

fn send(handle: &Handle, instance: u64, kind: wire::room_event::Kind) -> Vec<wire::RoomShown> {
    room_call(
        handle,
        wire::room_request::Kind::Send(wire::RoomSend {
            instance,
            event: Some(wire::RoomEvent { kind: Some(kind) }),
        }),
    )
}

fn tap(id: &str) -> wire::room_event::Kind {
    wire::room_event::Kind::Tap(wire::RoomTap {
        selector_id: id.to_owned(),
    })
}

fn option_change(id: &str, seq: u64, value: &str) -> wire::room_event::Kind {
    wire::room_event::Kind::Change(wire::RoomChange {
        selector_id: id.to_owned(),
        seq,
        value: Some(wire::room_change::Value::Option(value.to_owned())),
    })
}

fn text_change(id: &str, seq: u64, value: &str) -> wire::room_event::Kind {
    wire::room_event::Kind::Change(wire::RoomChange {
        selector_id: id.to_owned(),
        seq,
        value: Some(wire::room_change::Value::Text(value.to_owned())),
    })
}

fn cmd(handle: &Handle, name: &str, input: serde_json::Value, key: &str) {
    let outcome = handle.command(name, &input, key).expect("command runs");
    assert_eq!(
        outcome.status,
        centraid_vault::CommandStatus::Executed,
        "{name}: {:?}",
        outcome.reason
    );
}

fn seed_all(handle: &Handle) {
    cmd(
        handle,
        "person.add",
        json!({ "id": PERSON_ID, "title": "Priya Nair" }),
        "seed-person",
    );
    cmd(
        handle,
        "container.create",
        json!({ "id": BOOK_ID, "kind": "notebook", "title": "Field Notes" }),
        "seed-book",
    );
    cmd(
        handle,
        "note.create",
        json!({
            "id": NOTE_PINNED_ID,
            "title": "Trip Plan",
            "body": "Pack boots and call [[Priya Nair]].",
            "notebook_id": BOOK_ID
        }),
        "seed-note-1",
    );
    cmd(
        handle,
        "flag.set",
        json!({ "flag": "pinned", "ids": [NOTE_PINNED_ID] }),
        "seed-pin-1",
    );
    cmd(
        handle,
        "note.edit",
        json!({
            "id": NOTE_PINNED_ID,
            "body": "Pack boots, map, and call [[Priya Nair]]."
        }),
        "seed-note-1-v2",
    );
    cmd(
        handle,
        "note.create",
        json!({
            "id": NOTE_PLAIN_ID,
            "title": "Reading List",
            "body": "See [[Trip Plan]] for travel books.",
            "notebook_id": BOOK_ID
        }),
        "seed-note-2",
    );
    cmd(
        handle,
        "note.create",
        json!({
            "id": NOTE_JOURNAL_ID,
            "title": "Morning Walk",
            "body": "Clear sky over the harbour.",
            "journal_on": "2026-11-26"
        }),
        "seed-note-3",
    );
    cmd(
        handle,
        "tag.add",
        json!({ "ids": [NOTE_PINNED_ID], "label": "Travel" }),
        "seed-tag-1",
    );
    cmd(
        handle,
        "tag.add",
        json!({ "ids": [NOTE_PLAIN_ID], "label": "Trips" }),
        "seed-tag-2",
    );

    cmd(
        handle,
        "container.create",
        json!({ "id": FOLDER_ID, "kind": "folder", "title": "Tax 2026" }),
        "seed-folder",
    );
    cmd(
        handle,
        "container.create",
        json!({
            "id": SUBFOLDER_ID,
            "kind": "folder",
            "title": "Receipts",
            "parent": FOLDER_ID
        }),
        "seed-subfolder",
    );
    cmd(
        handle,
        "document.add",
        json!({
            "id": DOC_TOP_ID,
            "title": "Lease Summary",
            "blob": BLOB_A,
            "size": 1024,
            "media_type": "text/plain",
            "text": "Monthly rent due on the first."
        }),
        "seed-doc-top",
    );
    cmd(
        handle,
        "document.replace",
        json!({
            "id": DOC_TOP_ID,
            "blob": BLOB_B,
            "size": 1280,
            "media_type": "text/plain",
            "text": "Monthly rent due on the first. Renewal in May."
        }),
        "seed-doc-top-v2",
    );
    cmd(
        handle,
        "document.add",
        json!({
            "id": DOC_FOLDER_ID,
            "title": "W-2 Form.pdf",
            "blob": BLOB_A,
            "size": 1024,
            "media_type": "application/pdf",
            "folder_id": FOLDER_ID
        }),
        "seed-doc-folder",
    );
    // S12: a document captured inside a note must stay out of top-level Docs.
    cmd(
        handle,
        "document.add",
        json!({
            "id": DOC_HOMED_CAPTURE_ID,
            "title": "Homed Receipt Capture.pdf",
            "blob": BLOB_B,
            "size": 1280,
            "media_type": "application/pdf",
            "home": NOTE_PINNED_ID
        }),
        "seed-doc-homed",
    );

    cmd(
        handle,
        "place.add",
        json!({
            "id": PLACE_A_ID,
            "title": "Baker Beach",
            "address": "Gibson Rd, San Francisco"
        }),
        "seed-place-a",
    );
    cmd(
        handle,
        "place.add",
        json!({
            "id": PLACE_B_ID,
            "title": "Baker Beach North"
        }),
        "seed-place-b",
    );
    cmd(
        handle,
        "photo.add",
        json!({
            "id": PHOTO_LIB_ID,
            "title": "Golden Gate Fog",
            "blob": BLOB_C,
            "size": 120_000,
            "media_type": "image/jpeg",
            "form": "photo",
            "taken_at": "2026-11-26T10:15:00.000Z",
            "width": 4000,
            "height": 3000,
            "place_id": PLACE_A_ID
        }),
        "seed-photo-lib",
    );
    cmd(
        handle,
        "flag.set",
        json!({ "flag": "starred", "ids": [PHOTO_LIB_ID] }),
        "seed-star-photo",
    );
    cmd(
        handle,
        "photo.add",
        json!({
            "id": PHOTO_VIDEO_ID,
            "title": "Harbour Waves",
            "blob": BLOB_D,
            "size": 520_000,
            "media_type": "video/mp4",
            "form": "video",
            "taken_at": "2026-10-12T16:00:00.000Z",
            "width": 1920,
            "height": 1080,
            "duration_s": 14.0
        }),
        "seed-photo-video",
    );
    // S12: a photo captured inside a note must NEVER appear in any Photos read.
    cmd(
        handle,
        "photo.add",
        json!({
            "id": PHOTO_HOMED_CAPTURE_ID,
            "title": "Homed Whiteboard Snap",
            "blob": BLOB_A,
            "size": 1024,
            "media_type": "image/jpeg",
            "form": "photo",
            "home": NOTE_PINNED_ID
        }),
        "seed-photo-homed",
    );
    cmd(
        handle,
        "container.create",
        json!({ "id": ALBUM_ID, "kind": "album", "title": "Coastline" }),
        "seed-album",
    );
    cmd(
        handle,
        "edge.add",
        json!({ "from": ALBUM_ID, "rel": "contains", "to": PHOTO_LIB_ID }),
        "seed-album-member",
    );
    cmd(
        handle,
        "event.propose",
        json!({
            "id": EVENT_AT_PLACE_ID,
            "title": "Sunset Picnic",
            "starts": "2026-11-26T17:00",
            "ends": "2026-11-26T19:00",
            "timing": "floating",
            "place_id": PLACE_A_ID
        }),
        "seed-event-place",
    );
}

#[test]
fn notes_list_editor_notebooks_journal_and_tag_merge() {
    let dir = tempfile::tempdir().expect("tempdir");
    let handle = phone(dir.path());
    seed_all(&handle);

    let shown = open(&handle, "notes", "home", true);
    let room = shown.room.expect("notes room");
    snapshot::assert_room("notes_list", &room);

    let journal = open(&handle, "notes/journal", "home", true);
    snapshot::assert_room("notes_journal", &journal.room.expect("journal room"));

    let nb_trash = open(
        &handle,
        &format!("notes/notebook/{BOOK_ID}/trash-confirm"),
        "home",
        false,
    );
    let nb_room = nb_trash.room.expect("notebook trash confirm");
    let nb_text = snapshot::render(&nb_room);
    assert!(
        nb_text.contains("2 notes"),
        "N11/V2 confirm names held note count:\n{nb_text}"
    );
    snapshot::assert_room("notes_notebook_trash_confirm", &nb_room);

    let editor_shown = open(
        &handle,
        &format!("notes/note/{NOTE_PINNED_ID}"),
        "home",
        false,
    );
    let editor_room = editor_shown.room.expect("editor room");
    snapshot::assert_room("notes_editor", &editor_room);

    // Live [[ and @ mention trigger returns candidates, and note_edit autosaves.
    let after_trigger = send(
        &handle,
        editor_shown.instance,
        wire::room_event::Kind::Canvas(wire::RoomCanvasEvent {
            selector_id: "editor".to_owned(),
            kind: Some(wire::room_canvas_event::Kind::NoteTrigger(
                wire::RoomNoteTriggered {
                    trigger: "@".to_owned(),
                    query: "Pri".to_owned(),
                },
            )),
        }),
    );
    let trig_text = snapshot::render(after_trigger[0].room.as_ref().expect("triggered room"));
    assert!(
        trig_text.contains("Priya Nair"),
        "live @ trigger suggests Priya Nair:\n{trig_text}"
    );

    let after_edit = send(
        &handle,
        editor_shown.instance,
        wire::room_event::Kind::Canvas(wire::RoomCanvasEvent {
            selector_id: "editor".to_owned(),
            kind: Some(wire::room_canvas_event::Kind::NoteEdit(
                wire::RoomNoteEdited {
                    title: "Trip Plan".to_owned(),
                    body: "Updated body text.".to_owned(),
                    seq: 1,
                    base_revision_id: String::new(),
                },
            )),
        }),
    );
    let edited_text = snapshot::render(after_edit[0].room.as_ref().expect("edited room"));
    assert!(
        edited_text.contains("Updated body text."),
        "autosave updated body:\n{edited_text}"
    );

    // Tags list -> pick Travel and Trips -> outlined merge confirm -> concept.merge.
    let tags_shown = open(&handle, "notes/tags", "home", false);
    let tags_room = tags_shown.room.expect("tags room");
    let tags_text = snapshot::render(&tags_room);
    assert!(tags_text.contains("Travel") && tags_text.contains("Trips"));

    let mut tag_ids = Vec::new();
    if let Some(wire::room::State::Ready(ready)) = &tags_room.state {
        for block in &ready.blocks {
            if let Some(wire::room_block::Kind::Section(sec)) = &block.kind {
                for inner in &sec.blocks {
                    if let Some(wire::room_block::Kind::Row(row)) = &inner.kind
                        && let Some(id) = row.selector_id.strip_prefix("tag/")
                    {
                        tag_ids.push(id.to_owned());
                    }
                }
            }
        }
    }
    assert_eq!(tag_ids.len(), 2);

    let merge_shown = open(
        &handle,
        &format!("notes/tag/{}/merge/{}", tag_ids[1], tag_ids[0]),
        "home",
        false,
    );
    let merge_room = merge_shown.room.expect("tag merge confirm");
    snapshot::assert_room("notes_tag_merge_confirm", &merge_room);

    let after_merge = send(&handle, merge_shown.instance, tap("confirm/yes"));
    let post_merge_text = snapshot::render(after_merge[0].room.as_ref().expect("tags after merge"));
    assert!(
        post_merge_text.contains("Travel") && !post_merge_text.contains("Trips"),
        "concept.merge merged Trips into Travel:\n{post_merge_text}"
    );
}

#[test]
fn docs_s12_isolation_folders_add_sheet_and_versions() {
    let dir = tempfile::tempdir().expect("tempdir");
    let handle = phone(dir.path());
    seed_all(&handle);

    let shown = open(&handle, "docs", "home", true);
    let room = shown.room.expect("docs room");
    let text = snapshot::render(&room);
    assert!(text.contains("Lease Summary"), "top-level doc shown");
    assert!(
        !text.contains("Homed Receipt Capture"),
        "S12: homed capture never appears in top-level Docs:\n{text}"
    );
    assert!(
        !text.contains("W-2 Form"),
        "folder doc stays in its folder, not top level:\n{text}"
    );
    snapshot::assert_room("docs_list", &room);

    let add_shown = open(&handle, "docs/add", "home", false);
    let add_room = add_shown.room.expect("add sheet");
    let add_text = snapshot::render(&add_room);
    assert!(add_text.contains("Scan") && add_text.contains("Choose file"));
    snapshot::assert_room("docs_add_sheet", &add_room);

    let folder_trash = open(
        &handle,
        &format!("docs/folder/{FOLDER_ID}/trash-confirm"),
        "home",
        false,
    );
    let ft_room = folder_trash.room.expect("folder trash confirm");
    let ft_text = snapshot::render(&ft_room);
    assert!(
        ft_text.contains("2 items"),
        "N11/V2 folder trash confirm names held count:\n{ft_text}"
    );
    snapshot::assert_room("docs_folder_trash_confirm", &ft_room);

    let detail = open(&handle, &format!("docs/doc/{DOC_TOP_ID}"), "home", false);
    let detail_room = detail.room.expect("doc detail");
    let detail_text = snapshot::render(&detail_room);
    assert!(
        detail_text.contains("1 earlier version"),
        "doc detail shows earlier_versions footer:\n{detail_text}"
    );
    snapshot::assert_room("docs_detail", &detail_room);
}

#[test]
fn photos_s12_zoom_viewer_slideshow_albums_places_and_unbacked_warning() {
    let dir = tempfile::tempdir().expect("tempdir");
    let handle = phone(dir.path());
    seed_all(&handle);

    let shown = open(&handle, "photos", "home", true);
    let room = shown.room.expect("photos library");
    let text = snapshot::render(&room);
    assert!(text.contains("Golden Gate Fog"));
    assert!(text.contains("Harbour Waves"));
    assert!(
        !text.contains("Homed Whiteboard Snap"),
        "S12: homed capture never appears in Photos library:\n{text}"
    );
    snapshot::assert_room("photos_library", &room);

    // Persist zoom in D3 view.photos.
    let zoomed = send(&handle, shown.instance, option_change("zoom", 1, "years"));
    let zoomed_text = snapshot::render(zoomed[0].room.as_ref().expect("zoomed library"));
    assert!(zoomed_text.contains("photo_grid years"), "{zoomed_text}");
    let reopened = open(&handle, "photos", "home", true);
    let reopened_text = snapshot::render(reopened.room.as_ref().expect("reopened library"));
    assert!(
        reopened_text.contains("photo_grid years"),
        "D3 view.photos persisted zoom across reopen:\n{reopened_text}"
    );

    // Viewer & STAGE slideshow.
    let viewer = open(
        &handle,
        &format!("photos/photo/{PHOTO_LIB_ID}"),
        "home",
        false,
    );
    let viewer_room = viewer.room.expect("photo viewer");
    snapshot::assert_room("photos_viewer", &viewer_room);

    cmd(
        &handle,
        "entity.retitle",
        json!({ "id": PHOTO_LIB_ID, "title": "Evening fog" }),
        "edit-photo-before-version-restore",
    );
    let versions = open(
        &handle,
        &format!("photos/photo/{PHOTO_LIB_ID}/versions"),
        "home",
        false,
    );
    assert!(snapshot::render(versions.room.as_ref().unwrap()).contains("Restore"));
    let restored = send(&handle, versions.instance, tap("version/1")).remove(0);
    assert_eq!(
        restored
            .room
            .as_ref()
            .unwrap()
            .status_line
            .as_ref()
            .unwrap()
            .action_label,
        "Undo"
    );
    let restored_photo = open(
        &handle,
        &format!("photos/photo/{PHOTO_LIB_ID}"),
        "home",
        false,
    );
    assert!(snapshot::render(restored_photo.room.as_ref().unwrap()).contains("Golden Gate Fog"));

    let stage = open(
        &handle,
        &format!("photos/slideshow/{PHOTO_LIB_ID}"),
        "home",
        false,
    );
    let stage_room = stage.room.expect("slideshow stage");
    assert_eq!(stage_room.kind, wire::RoomKind::Stage as i32);

    // Album delete confirm (N12: photos stay in library).
    let album_trash = open(
        &handle,
        &format!("photos/album/{ALBUM_ID}/trash-confirm"),
        "home",
        false,
    );
    let at_room = album_trash.room.expect("album trash confirm");
    let at_text = snapshot::render(&at_room);
    assert!(
        at_text.contains("stay in your library"),
        "N12 album confirm reassures members stay:\n{at_text}"
    );
    snapshot::assert_room("photos_album_trash_confirm", &at_room);

    // Place detail ("At this place") + Place rename + Place merge (V5/N17).
    let place_detail = open(
        &handle,
        &format!("photos/place/{PLACE_A_ID}"),
        "home",
        false,
    );
    let pd_room = place_detail.room.expect("place detail");
    let pd_text = snapshot::render(&pd_room);
    assert!(pd_text.contains("Golden Gate Fog") && pd_text.contains("Sunset Picnic"));
    snapshot::assert_room("photos_place_detail", &pd_room);

    let rename = open(
        &handle,
        &format!("photos/place/{PLACE_B_ID}/rename"),
        "home",
        false,
    );
    let _ = send(
        &handle,
        rename.instance,
        text_change("field/name", 1, "Baker Beach West"),
    );
    let _ = send(&handle, rename.instance, tap("form/save"));

    let merge_confirm = open(
        &handle,
        &format!("photos/place/{PLACE_B_ID}/merge/{PLACE_A_ID}"),
        "home",
        false,
    );
    let mc_room = merge_confirm.room.expect("place merge confirm");
    snapshot::assert_room("photos_place_merge_confirm", &mc_room);
    let after_merge = send(&handle, merge_confirm.instance, tap("confirm/yes"));
    let places_text = snapshot::render(after_merge[0].room.as_ref().expect("places after merge"));
    assert!(
        places_text.contains("Baker Beach") && !places_text.contains("Baker Beach West"),
        "place.merge merged loser into winner:\n{places_text}"
    );

    // Trash a photo and verify #1209 unbacked-up warning before Delete forever.
    cmd(
        &handle,
        "entity.trash",
        json!({ "ids": [PHOTO_VIDEO_ID] }),
        "trash-photo",
    );
    let purge_confirm = open(
        &handle,
        &format!("photos/trash/purge/{PHOTO_VIDEO_ID}"),
        "home",
        false,
    );
    let pc_room = purge_confirm.room.expect("purge confirm");
    let pc_text = snapshot::render(&pc_room);
    assert!(
        pc_text.contains("isn't backed up yet"),
        "#1209 unbacked-up warning shown:\n{pc_text}"
    );
    snapshot::assert_room("photos_trash_purge_confirm", &pc_room);
}
