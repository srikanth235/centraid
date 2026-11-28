use std::sync::Arc;

use centraid_api_proto::core_v1 as wire;
use centraid_core::{Core, CoreConfig, Handle};
use centraid_vault::clock::{FixedClock, SeededIds};
use serde_json::json;

const WORDS: &str = "abandon abandon abandon abandon abandon abandon abandon abandon \
                     abandon abandon abandon abandon abandon abandon abandon abandon \
                     abandon abandon abandon abandon abandon abandon abandon art";
const NOW: i64 = 1_795_687_200_000;
const PHOTO_A: &str = "01900000-0000-7000-8000-000000009101";
const PHOTO_B: &str = "01900000-0000-7000-8000-000000009102";
const BLOB_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BLOB_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fn phone(dir: &std::path::Path) -> Handle {
    let seed = centraid_identity::RecoveryPhrase::parse(WORDS)
        .expect("the vector parses")
        .seed();
    let handle = Core::open(
        CoreConfig::new(dir.join("vault.db"))
            .with_seed(seed, 0)
            .with_clock(
                Arc::new(FixedClock::at(NOW)),
                Arc::new(SeededIds::new("room-photo-selection")),
            ),
    )
    .expect("the core opens");
    handle
        .with_vault(|vault| Ok(vault.found("Household", "Ada")?))
        .expect("it founds");
    centraid_screens::attach(&handle);
    for (id, blob, title, key) in [
        (PHOTO_A, BLOB_A, "Morning", "photo-a"),
        (PHOTO_B, BLOB_B, "Evening", "photo-b"),
    ] {
        call(
            &handle,
            "photo.add",
            json!({
                "id": id,
                "title": title,
                "blob": blob,
                "size": 1024,
                "media_type": "image/jpeg",
                "form": "photo"
            }),
            key,
        );
    }
    // A mixed initial state proves that one bulk Undo removes only its own change.
    call(
        &handle,
        "flag.set",
        json!({ "id": PHOTO_A, "flag": "starred" }),
        "pre-star-a",
    );
    handle
}

fn call(handle: &Handle, command: &str, input: serde_json::Value, key: &str) -> serde_json::Value {
    let outcome = handle.command(command, &input, key).expect("command runs");
    assert_eq!(
        outcome.status,
        centraid_vault::CommandStatus::Executed,
        "{command}: {:?}",
        outcome.reason
    );
    outcome.output
}

fn has_tag(handle: &Handle, id: &str, label: &str) -> bool {
    let reader = centraid_domain::read::Reader::open(handle.path()).expect("tag read opens");
    reader
        .run(
            &centraid_domain::apps::notes::NOTE_TAGS,
            &centraid_domain::read::Args::new().text("id", id),
        )
        .expect("registered tag read answers")
        .rows
        .iter()
        .any(|tag| tag.key.eq_ignore_ascii_case(label))
}

fn room_call(handle: &Handle, kind: wire::room_request::Kind) -> Vec<wire::RoomShown> {
    let response = handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Room(wire::RoomRequest {
                kind: Some(kind),
            })),
        })
        .expect("room request answers");
    match response.kind.expect("response kind") {
        wire::response::Kind::Room(response) => response.shown,
        _ => panic!("expected a room response"),
    }
}

fn tap(handle: &Handle, instance: u64, selector_id: &str) -> Vec<wire::RoomShown> {
    room_call(
        handle,
        wire::room_request::Kind::Send(wire::RoomSend {
            instance,
            event: Some(wire::RoomEvent {
                kind: Some(wire::room_event::Kind::Tap(wire::RoomTap {
                    selector_id: selector_id.to_owned(),
                })),
            }),
        }),
    )
}

fn open(handle: &Handle, key: &str, root: bool) -> wire::RoomShown {
    room_call(
        handle,
        wire::room_request::Kind::Open(wire::RoomOpen {
            key: key.to_owned(),
            root,
            ..Default::default()
        }),
    )
    .remove(0)
}

#[test]
fn photos_select_bulk_star_undo_preserves_preexisting_star_and_removes_new_star() {
    let dir = tempfile::tempdir().expect("temporary vault dir");
    let handle = phone(dir.path());
    let shown = open(&handle, "photos", true);
    assert!(
        shown
            .room
            .as_ref()
            .and_then(|room| room.header.as_ref())
            .unwrap()
            .keys
            .iter()
            .any(|key| { key.selector_id == "header/select" && key.label == "Select" })
    );

    let selected = tap(&handle, shown.instance, "header/select");
    let selected = selected.last().expect("selection view is shown");
    let room = selected.room.as_ref().expect("room");
    let selection = room.selection.as_ref().expect("selection toolbar");
    assert!(selection.on, "normal photo grid must enter Select mode");
    assert!(!selection.select_all_selector_id.is_empty());
    assert!(!selection.done_selector_id.is_empty());
    let selected = tap(&handle, selected.instance, &format!("tile/{PHOTO_A}"));
    let selected = selected.last().expect("first pick refreshes grid");
    let selected = tap(&handle, selected.instance, &format!("tile/{PHOTO_B}"));
    let selected = selected.last().expect("second pick refreshes grid");
    assert_eq!(
        selected
            .room
            .as_ref()
            .and_then(|room| room.selection.as_ref())
            .map(|selection| selection.count),
        Some(2)
    );
    assert!(
        selected
            .room
            .as_ref()
            .and_then(|room| room.selection.as_ref())
            .is_some_and(|selection| selection
                .actions
                .iter()
                .any(|action| action.selector_id == "selection/organize")),
        "organize is available after selecting supported records"
    );

    let after_action = tap(&handle, selected.instance, "selection/star");
    let shown = after_action.last().expect("bulk action refreshes the grid");
    assert_eq!(
        shown
            .room
            .as_ref()
            .and_then(|room| room.status_line.as_ref())
            .map(|line| line.action_label.as_str()),
        Some("Undo")
    );
    let grid = shown
        .room
        .as_ref()
        .and_then(|room| {
            let Some(wire::room::State::Ready(ready)) = room.state.as_ref() else {
                return None;
            };
            ready
                .blocks
                .iter()
                .find_map(|block| match block.kind.as_ref() {
                    Some(wire::room_block::Kind::PhotoGrid(grid)) => Some(grid),
                    _ => None,
                })
        })
        .expect("updated photo grid");
    let starred: Vec<&str> = grid
        .sections
        .iter()
        .flat_map(|section| section.tiles.iter())
        .filter(|tile| tile.starred)
        .map(|tile| tile.selector_id.as_str())
        .collect();
    assert!(starred.iter().any(|id| *id == format!("tile/{PHOTO_A}")));
    assert!(starred.iter().any(|id| *id == format!("tile/{PHOTO_B}")));

    let undone = tap(&handle, shown.instance, "status/undo");
    let room = undone.last().expect("Undo refreshes the room");
    let grid = room
        .room
        .as_ref()
        .and_then(|room| match room.state.as_ref() {
            Some(wire::room::State::Ready(ready)) => {
                ready
                    .blocks
                    .iter()
                    .find_map(|block| match block.kind.as_ref() {
                        Some(wire::room_block::Kind::PhotoGrid(grid)) => Some(grid),
                        _ => None,
                    })
            }
            _ => None,
        })
        .expect("updated photo grid after Undo");
    let starred: Vec<&str> = grid
        .sections
        .iter()
        .flat_map(|section| section.tiles.iter())
        .filter(|tile| tile.starred)
        .map(|tile| tile.selector_id.as_str())
        .collect();
    assert!(starred.iter().any(|id| *id == format!("tile/{PHOTO_A}")));
    assert!(!starred.iter().any(|id| *id == format!("tile/{PHOTO_B}")));
}

#[test]
fn a_noop_bulk_flag_does_not_offer_a_false_undo() {
    let dir = tempfile::tempdir().expect("temporary vault dir");
    let handle = phone(dir.path());
    let shown = open(&handle, "photos", true);
    let selected = tap(&handle, shown.instance, "header/select")
        .pop()
        .expect("selection mode shown");
    let selected = tap(&handle, selected.instance, &format!("tile/{PHOTO_A}"))
        .pop()
        .expect("photo selected");
    let changed = tap(&handle, selected.instance, "selection/star")
        .pop()
        .expect("no-op star returns a room");
    assert_ne!(
        changed
            .room
            .as_ref()
            .and_then(|room| room.status_line.as_ref())
            .map(|line| line.action_label.as_str()),
        Some("Undo")
    );
}

#[test]
fn bulk_tag_undo_preserves_existing_membership_and_removes_only_new_membership() {
    let dir = tempfile::tempdir().expect("temporary vault dir");
    let handle = phone(dir.path());
    let tag = call(
        &handle,
        "tag.add",
        json!({ "id": PHOTO_A, "label": "receipts" }),
        "tag-a-before-bulk",
    )["tag"]
        .as_str()
        .expect("tag id")
        .to_owned();
    assert!(has_tag(&handle, PHOTO_A, "receipts"));
    assert!(!has_tag(&handle, PHOTO_B, "receipts"));

    let shown = open(&handle, "photos", true);
    let selected = tap(&handle, shown.instance, "header/select")
        .pop()
        .expect("select mode shown");
    let selected = tap(&handle, selected.instance, &format!("tile/{PHOTO_A}"))
        .pop()
        .expect("first selection shown");
    let selected = tap(&handle, selected.instance, &format!("tile/{PHOTO_B}"))
        .pop()
        .expect("second selection shown");
    let organizer = tap(&handle, selected.instance, "selection/organize")
        .pop()
        .expect("organizer shown");
    let tagged = tap(&handle, organizer.instance, &format!("organize/tag/{tag}"))
        .pop()
        .expect("bulk tag applied");
    assert_eq!(
        tagged
            .room
            .as_ref()
            .and_then(|room| room.status_line.as_ref())
            .map(|line| line.action_label.as_str()),
        Some("Undo")
    );
    assert!(has_tag(&handle, PHOTO_A, "receipts"));
    assert!(has_tag(&handle, PHOTO_B, "receipts"));

    tap(&handle, tagged.instance, "status/undo");
    assert!(has_tag(&handle, PHOTO_A, "receipts"));
    assert!(!has_tag(&handle, PHOTO_B, "receipts"));
}

#[test]
fn organizer_paginates_notebooks_and_tags_and_undoes_the_last_page_action() {
    let dir = tempfile::tempdir().expect("temporary vault dir");
    let handle = phone(dir.path());
    let note = call(
        &handle,
        "note.create",
        json!({ "title": "Organizer pagination note", "body": "" }),
        "organizer-note",
    )["id"]
        .as_str()
        .expect("note id")
        .to_owned();

    let mut notebook_ids = Vec::new();
    for index in 0..51 {
        let output = call(
            &handle,
            "container.create",
            json!({ "kind": "notebook", "title": format!("Organizer book {index:03}") }),
            &format!("organizer-book-{index}"),
        );
        notebook_ids.push(output["id"].as_str().expect("notebook id").to_owned());
    }
    let last_notebook = notebook_ids.iter().max().expect("notebooks exist").clone();
    let organizer = open(&handle, &format!("organize/{note}"), false);
    let first_page = format!("{:?}", organizer.room);
    assert!(first_page.contains("organize/more/move:notebook"));
    assert!(!first_page.contains(&format!("organize/move/{last_notebook}")));
    let last_destination = tap(&handle, organizer.instance, "organize/more/move:notebook")
        .pop()
        .expect("next notebook page shown");
    assert!(
        format!("{:?}", last_destination.room).contains(&format!("organize/move/{last_notebook}"))
    );
    let moved = tap(
        &handle,
        last_destination.instance,
        &format!("organize/move/{last_notebook}"),
    )
    .pop()
    .expect("last notebook receives the note");
    assert_eq!(
        moved
            .room
            .as_ref()
            .and_then(|room| room.status_line.as_ref())
            .map(|line| line.action_label.as_str()),
        Some("Undo")
    );
    let reader = centraid_domain::read::Reader::open(handle.path()).expect("note read opens");
    let parent = reader
        .run(
            &centraid_domain::apps::entity::META_BY_ID,
            &centraid_domain::read::Args::new().text("id", &note),
        )
        .expect("note metadata reads")
        .rows
        .pop()
        .expect("note exists")
        .parent_id;
    assert_eq!(parent.as_deref(), Some(last_notebook.as_str()));
    tap(&handle, moved.instance, "status/undo");
    let restored = reader
        .run(
            &centraid_domain::apps::entity::META_BY_ID,
            &centraid_domain::read::Args::new().text("id", &note),
        )
        .expect("undo restores note metadata")
        .rows
        .pop()
        .expect("note remains");
    assert!(restored.parent_id.is_none());

    let mut last_tag = String::new();
    for index in 0..51 {
        let output = call(
            &handle,
            "tag.add",
            json!({ "id": PHOTO_A, "label": format!("z organizer tag {index:03}") }),
            &format!("organizer-tag-{index}"),
        );
        if index == 50 {
            last_tag = output["tag"].as_str().expect("tag id").to_owned();
        }
    }
    let organizer = open(&handle, &format!("organize/{PHOTO_B}"), false);
    let first_page = format!("{:?}", organizer.room);
    assert!(first_page.contains("organize/more/tags"));
    assert!(!first_page.contains(&format!("organize/tag/{last_tag}")));
    let last_tag_page = tap(&handle, organizer.instance, "organize/more/tags")
        .pop()
        .expect("next tag page shown");
    assert!(format!("{:?}", last_tag_page.room).contains(&format!("organize/tag/{last_tag}")));
    let tagged = tap(
        &handle,
        last_tag_page.instance,
        &format!("organize/tag/{last_tag}"),
    )
    .pop()
    .expect("last tag applies");
    assert_eq!(
        tagged
            .room
            .as_ref()
            .and_then(|room| room.status_line.as_ref())
            .map(|line| line.action_label.as_str()),
        Some("Undo")
    );
    assert!(has_tag(&handle, PHOTO_B, "z organizer tag 050"));
    tap(&handle, tagged.instance, "status/undo");
    assert!(!has_tag(&handle, PHOTO_B, "z organizer tag 050"));
}
