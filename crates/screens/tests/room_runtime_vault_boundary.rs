//! A shelf foreground change drops the old room state and its vault-scoped drafts.

mod vault_support;

use centraid_api_proto::core_v1 as wire;
use centraid_core::{Handle, vaults::Vaults as _};
use centraid_screens::room::{RoomRuntime, shell};
use vault_support::{Phone, lay_down, scratch};

fn room_call(handle: &Handle, kind: wire::room_request::Kind) -> wire::RoomResponse {
    let answer = handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Room(wire::RoomRequest {
                kind: Some(kind),
            })),
        })
        .expect("the front core answers room requests");
    match answer.kind {
        Some(wire::response::Kind::Room(response)) => response,
        other => panic!("not a room response: {other:?}"),
    }
}

fn open_home(handle: &Handle) -> wire::RoomShown {
    room_call(
        handle,
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
    .expect("Home opens in the foreground vault")
}

fn device_get(handle: &Handle, key: &str) -> wire::DeviceResponse {
    let answer = handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Device(wire::DeviceRequest {
                kind: Some(wire::device_request::Kind::Get(wire::DeviceGet {
                    key: key.to_owned(),
                })),
            })),
        })
        .expect("the child device store answers");
    match answer.kind {
        Some(wire::response::Kind::Device(response)) => response,
        other => panic!("not a device response: {other:?}"),
    }
}

fn device_put(handle: &Handle, key: &str, value: &str) {
    handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Device(wire::DeviceRequest {
                kind: Some(wire::device_request::Kind::Put(wire::DevicePut {
                    key: key.to_owned(),
                    value: value.to_owned(),
                })),
            })),
        })
        .expect("the child device store accepts the registered draft");
}

#[test]
fn vault_changes_drop_old_drafts_and_never_reuse_room_instances() {
    let dir = scratch();
    let first_id = lay_down(&dir, "first", "First");
    let second_id = lay_down(&dir, "second", "Second");
    let mut phone = Phone::on(&dir, None);
    phone.keep_seed();
    phone.record_index(&first_id, 0);
    phone.record_index(&second_id, 1);
    phone.launch();
    assert!(phone.shelf.bring_to_front(&first_id));

    let front = phone.driver.handle.clone();
    front.attach_rooms(std::sync::Arc::new(RoomRuntime::new(shell::registry())));
    let first = phone.shelf.core_of(&first_id).expect("first child is open");
    let second = phone
        .shelf
        .core_of(&second_id)
        .expect("second child is open");

    let first_home = open_home(&front);
    let first_draft = format!("draft.{}.workout", first.device_vault_id());
    device_put(
        &first,
        &first_draft,
        r#"{"v":1,"value":"First vault draft"}"#,
    );
    assert!(device_get(&first, &first_draft).found);

    assert!(phone.shelf.bring_to_front(&second_id));
    let second_home = open_home(&front);
    assert!(
        second_home.instance > first_home.instance,
        "a vault reset must preserve the monotonic room instance allocator"
    );
    assert!(
        !device_get(&first, &first_draft).found,
        "leaving a vault deletes its persisted editor drafts"
    );

    let second_draft = format!("draft.{}.workout", second.device_vault_id());
    device_put(
        &second,
        &second_draft,
        r#"{"v":1,"value":"Second vault draft"}"#,
    );
    assert!(device_get(&second, &second_draft).found);

    assert!(phone.shelf.bring_to_front(&first_id));
    let first_home_again = open_home(&front);
    assert!(first_home_again.instance > second_home.instance);
    assert!(
        !device_get(&second, &second_draft).found,
        "returning to a vault does not retain the outgoing vault's drafts"
    );
}
