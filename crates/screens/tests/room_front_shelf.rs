//! Room navigation stays on the shelf core while app reads and writes reach
//! the real foreground vault core.

mod vault_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::room::{RoomRuntime, shell, snapshot};
use serde_json::json;
use vault_support::{Phone, lay_down, scratch};

fn call_room(handle: &centraid_core::Handle, kind: wire::room_request::Kind) -> wire::RoomResponse {
    let response = handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Room(wire::RoomRequest {
                kind: Some(kind),
            })),
        })
        .expect("the front core handles the room request");
    match response.kind {
        Some(wire::response::Kind::Room(answer)) => answer,
        other => panic!("not a room response: {other:?}"),
    }
}

fn tap(handle: &centraid_core::Handle, instance: u64, selector_id: &str) -> wire::RoomShown {
    call_room(
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
    .shown
    .into_iter()
    .last()
    .expect("a successful navigation shows its destination")
}

fn search(handle: &centraid_core::Handle, instance: u64, term: &str) -> wire::RoomShown {
    call_room(
        handle,
        wire::room_request::Kind::Send(wire::RoomSend {
            instance,
            event: Some(wire::RoomEvent {
                kind: Some(wire::room_event::Kind::Change(wire::RoomChange {
                    selector_id: "search".to_owned(),
                    seq: 1,
                    value: Some(wire::room_change::Value::Text(term.to_owned())),
                })),
            }),
        }),
    )
    .shown
    .into_iter()
    .last()
    .expect("search rebuilds Home")
}

#[test]
fn front_shelf_keeps_room_navigation_local_and_reads_the_foreground_vault() {
    let dir = scratch();
    let vault_id = lay_down(&dir, "family", "Family");
    let mut phone = Phone::on(&dir, None);
    phone.launch();
    assert_eq!(phone.holdings().foreground, vault_id);

    let handle = phone.driver.handle.clone();
    let person_id = "01900000-0000-7000-8000-000000009901";
    let added = handle
        .command(
            "person.add",
            &json!({"id": person_id, "title": "Foreground Person"}),
            "seed-front-shelf-person",
        )
        .expect("the command reaches the active child vault");
    assert_eq!(added.status, centraid_vault::CommandStatus::Executed);

    // Production installs the room runtime on the front core; the foreground
    // child is a vault core and deliberately has no RoomHost of its own.
    handle.attach_rooms(std::sync::Arc::new(RoomRuntime::new(shell::registry())));

    let opened = call_room(
        &handle,
        wire::room_request::Kind::Open(wire::RoomOpen {
            key: "home".to_owned(),
            tab: "home".to_owned(),
            root: true,
            ..Default::default()
        }),
    );
    let mut home = opened.shown.into_iter().last().expect("Home opens locally");
    if home.room.as_ref().is_some_and(|room| room.key == "welcome") {
        home = tap(&handle, home.instance, "welcome/start");
    }
    assert_eq!(home.room.as_ref().unwrap().key, "home");

    let people = tap(&handle, home.instance, "tile/people");
    let people_room = people
        .room
        .as_ref()
        .expect("People opens on the front core");
    assert_eq!(people_room.key, "people");
    assert!(
        snapshot::render(people_room).contains("Foreground Person"),
        "the People room reads the foreground child vault"
    );

    let home = call_room(
        &handle,
        wire::room_request::Kind::Open(wire::RoomOpen {
            key: "home".to_owned(),
            tab: "home".to_owned(),
            root: true,
            ..Default::default()
        }),
    )
    .shown
    .into_iter()
    .last()
    .expect("Home reopens on the front core");
    let money = tap(&handle, home.instance, "tile/money");
    assert_eq!(money.room.as_ref().unwrap().key, "money");

    // Switching the shelf must keep room navigation on its attached front
    // runtime while commands and typed reads follow the new child.
    let founded = phone.shelf.found(None, "Second vault");
    phone.apply(&founded.writes);
    let second_vault_id = phone.holdings().foreground;
    assert_ne!(second_vault_id, vault_id);
    let second_person_id = "01900000-0000-7000-8000-000000009902";
    let added = handle
        .command(
            "person.add",
            &json!({"id": second_person_id, "title": "Second Vault Person"}),
            "seed-second-shelf-person",
        )
        .expect("the command follows the newly foregrounded child");
    assert_eq!(added.status, centraid_vault::CommandStatus::Executed);

    let home = call_room(
        &handle,
        wire::room_request::Kind::Open(wire::RoomOpen {
            key: "home".to_owned(),
            tab: "home".to_owned(),
            root: true,
            ..Default::default()
        }),
    )
    .shown
    .into_iter()
    .last()
    .expect("Home opens after the shelf switch");
    assert_eq!(home.room.as_ref().unwrap().key, "home");
    let people = tap(&handle, home.instance, "tile/people");
    let people_room = people.room.as_ref().expect("People opens after the switch");
    assert_eq!(people_room.key, "people");
    let rendered = snapshot::render(people_room);
    assert!(rendered.contains("Second Vault Person"), "{rendered}");
    assert!(!rendered.contains("Foreground Person"), "{rendered}");

    let home = call_room(
        &handle,
        wire::room_request::Kind::Open(wire::RoomOpen {
            key: "home".to_owned(),
            tab: "home".to_owned(),
            root: true,
            ..Default::default()
        }),
    )
    .shown
    .into_iter()
    .last()
    .expect("Home reopens for search");
    let searching = tap(&handle, home.instance, "search");
    let results = search(&handle, searching.instance, "Second Vault Person");
    let search_slot = results.room.as_ref().unwrap().search.as_ref().unwrap();
    assert_eq!(search_slot.term, "Second Vault Person");
    assert!(snapshot::render(results.room.as_ref().unwrap()).contains("Second Vault Person"));
}
