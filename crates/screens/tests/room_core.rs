//! The app plane over a real core, through the calls a shell makes: a room by key, a room event,
//! the device store, the notification service and the room Rust pushes on its own.

use std::sync::Arc;
use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_core::{Core, CoreConfig, Handle};
use centraid_vault::clock::{FixedClock, SeededIds};
use serde_json::json;

const WORDS: &str = "abandon abandon abandon abandon abandon abandon abandon abandon \
                     abandon abandon abandon abandon abandon abandon abandon abandon \
                     abandon abandon abandon abandon abandon abandon abandon art";
/// 2026-11-26T10:00:00Z
const NOW: i64 = 1_795_687_200_000;
const DAY: i64 = 86_400_000;

fn phone(dir: &std::path::Path) -> Handle {
    let seed = centraid_identity::RecoveryPhrase::parse(WORDS)
        .expect("the vector parses")
        .seed();
    let handle = Core::open(
        CoreConfig::new(dir.join("vault.db"))
            .with_seed(seed, 0)
            .with_clock(
                Arc::new(FixedClock::at(NOW)),
                Arc::new(SeededIds::new("rooms")),
            ),
    )
    .expect("the core opens");
    handle
        .with_vault(|vault| Ok(vault.found("Household", "Ada")?))
        .expect("it founds");
    centraid_screens::attach(&handle);
    handle
}

fn ask(handle: &Handle, kind: wire::request::Kind) -> wire::response::Kind {
    handle
        .call(&wire::Request { kind: Some(kind) })
        .expect("the call answers")
        .kind
        .expect("an answer")
}

fn room_call(handle: &Handle, kind: wire::room_request::Kind) -> Vec<wire::RoomShown> {
    match ask(
        handle,
        wire::request::Kind::Room(wire::RoomRequest { kind: Some(kind) }),
    ) {
        wire::response::Kind::Room(answer) => answer.shown,
        other => panic!("not a room answer: {other:?}"),
    }
}

fn open(handle: &Handle, key: &str, tab: &str, root: bool) -> wire::RoomShown {
    room_call(
        handle,
        wire::room_request::Kind::Open(wire::RoomOpen {
            key: key.to_owned(),
            tab: tab.to_owned(),
            root,
        }),
    )
    .remove(0)
}

fn send(handle: &Handle, instance: u64, event: wire::room_event::Kind) -> Vec<wire::RoomShown> {
    room_call(
        handle,
        wire::room_request::Kind::Send(wire::RoomSend {
            instance,
            event: Some(wire::RoomEvent { kind: Some(event) }),
        }),
    )
}

fn device(
    handle: &Handle,
    kind: wire::device_request::Kind,
) -> Result<wire::DeviceResponse, String> {
    handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Device(wire::DeviceRequest {
                kind: Some(kind),
            })),
        })
        .map(|response| match response.kind {
            Some(wire::response::Kind::Device(answer)) => answer,
            other => panic!("not a device answer: {other:?}"),
        })
        .map_err(|error| error.to_string())
}

#[test]
fn a_shell_opens_settings_by_key_and_a_pick_lands_in_the_device_store() {
    let dir = tempfile::tempdir().unwrap();
    let handle = phone(dir.path());

    let home = open(&handle, "home", "home", true);
    assert_eq!(home.depth, 1);
    let room = home.room.as_ref().unwrap();
    assert_eq!(room.kind, wire::RoomKind::Home as i32);

    let tap = |id: &str| {
        wire::room_event::Kind::Tap(wire::RoomTap {
            selector_id: id.to_owned(),
        })
    };
    let settings = send(&handle, home.instance, tap("tile/settings")).remove(0);
    assert_eq!(settings.depth, 2);
    assert_eq!(settings.transition, wire::RoomTransition::Push as i32);

    let pick = wire::room_event::Kind::Change(wire::RoomChange {
        selector_id: "choice/appearance".to_owned(),
        seq: 1,
        value: Some(wire::room_change::Value::Option("dark".to_owned())),
    });
    send(&handle, settings.instance, pick);
    let kept = device(
        &handle,
        wire::device_request::Kind::Get(wire::DeviceGet {
            key: "settings.appearance".to_owned(),
        }),
    )
    .unwrap();
    assert!(kept.found);
    assert_eq!(kept.value, r#"{"v":1,"value":"dark"}"#);

    let back = send(&handle, settings.instance, tap("back")).remove(0);
    assert_eq!(back.instance, home.instance);
    assert_eq!(back.transition, wire::RoomTransition::Pop as i32);
}

#[test]
fn the_device_store_refuses_an_unlisted_key_and_a_value_without_its_version() {
    let dir = tempfile::tempdir().unwrap();
    let handle = phone(dir.path());
    let put = |key: &str, value: &str| {
        device(
            &handle,
            wire::device_request::Kind::Put(wire::DevicePut {
                key: key.to_owned(),
                value: value.to_owned(),
            }),
        )
    };
    assert!(put("mystery", "x").is_err());
    assert!(put("settings.units", r#"{"value":"metric"}"#).is_err());
    assert!(put("settings.units", r#"{"v":1,"value":"metric"}"#).is_ok());
}

#[test]
fn an_unknown_room_and_an_unknown_instance_are_refused_as_typed_errors() {
    let dir = tempfile::tempdir().unwrap();
    let handle = phone(dir.path());
    let refused = handle.call(&wire::Request {
        kind: Some(wire::request::Kind::Room(wire::RoomRequest {
            kind: Some(wire::room_request::Kind::Open(wire::RoomOpen {
                key: "nowhere".into(),
                tab: String::new(),
                root: true,
            })),
        })),
    });
    assert!(refused.is_err());
}

#[test]
fn the_core_pushes_the_notification_set_when_a_commit_reaches_the_alert_index() {
    let dir = tempfile::tempdir().unwrap();
    let handle = phone(dir.path());
    let launched = match ask(
        &handle,
        wire::request::Kind::Notify(wire::NotifyRequest {
            kind: Some(wire::notify_request::Kind::Launched(wire::NotifyLaunched {
                pending_cap: 20,
                zone: "UTC".into(),
                locale: "en".into(),
            })),
        }),
    ) {
        wire::response::Kind::Notify(answer) => answer,
        other => panic!("not a notify answer: {other:?}"),
    };
    assert!(
        launched
            .schedule
            .expect("a launch is answered with the set")
            .all
            .is_empty(),
        "nothing is due in a new vault"
    );

    handle
        .command(
            "event.propose",
            &json!({
                "id": "01900000-0000-7000-8000-000000000001",
                "title": "Dentist",
                "starts": "2026-11-27T15:00:00.000Z",
                "timing": "zoned",
                "zone": "UTC",
                "reminders": [30]
            }),
            "k1",
        )
        .expect("the event is proposed");

    let mut pushed = None;
    for _ in 0..20 {
        match handle.next_event(Duration::from_millis(200)) {
            Ok(Some(wire::Event {
                kind: Some(wire::event::Kind::Notify(set)),
            })) => {
                pushed = Some(set);
            }
            Ok(Some(_)) => {}
            _ => break,
        }
    }
    let set = pushed.expect("a commit that reaches the alert index pushes the set");
    assert_eq!(set.all.len(), 1);
    assert_eq!(set.all[0].title, "Dentist");
    assert_eq!(
        set.all[0].fire_at_ms,
        NOW + DAY + 5 * 3_600_000 - 30 * 60_000
    );
    assert!(set.retain_delivered);
}

fn notes(handle: &Handle) -> Vec<String> {
    handle
        .with_vault(|vault| {
            vault
                .read(|c| Ok(centraid_vault::testdoor::note_titles(c)))
                .map_err(Into::into)
        })
        .unwrap()
}

#[test]
fn the_share_in_drain_files_a_text_as_a_note_with_its_arrival_and_empties_the_inbox() {
    let dir = tempfile::tempdir().unwrap();
    let handle = phone(dir.path());
    let inbox = dir.path().join("inbox");
    let item = inbox.join("0192f0a0-0000-7000-8000-0000000000aa");
    std::fs::create_dir_all(&item).unwrap();
    std::fs::write(item.join("payload"), "Flour, eggs and butter").unwrap();
    std::fs::write(
        item.join("manifest.json"),
        r#"{"v":1,"type":"text","uti_or_mime":"text/plain","name":"","from_app":"Safari","received_at":1}"#,
    )
    .unwrap();

    let drain = || match ask(
        &handle,
        wire::request::Kind::ShareIn(wire::ShareInRequest {
            inbox_dir: inbox.display().to_string(),
        }),
    ) {
        wire::response::Kind::ShareIn(answer) => answer.items,
        other => panic!("not a share-in answer: {other:?}"),
    };
    let first = drain();
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].fate, wire::ShareInFate::Filed as i32);
    assert_eq!(first[0].detail, "note");
    assert_eq!(notes(&handle), ["Flour, eggs and butter"]);
    assert!(!item.exists());
    assert!(
        drain().is_empty(),
        "the inbox is empty and a second drain files nothing"
    );
}

#[test]
fn a_follow_request_names_a_followed_store_and_a_verb() {
    let dir = tempfile::tempdir().unwrap();
    let handle = phone(dir.path());
    let call = |system: &str, verb: wire::FollowVerb, input: &str| {
        handle.call(&wire::Request {
            kind: Some(wire::request::Kind::Follow(wire::FollowRequest {
                verb: verb as i32,
                system: system.to_owned(),
                input_json: input.to_owned(),
                invoke_key: "k".to_owned(),
            })),
        })
    };
    assert!(call("secrets", wire::FollowVerb::Pass, "{}").is_err());
    assert!(call("contacts", wire::FollowVerb::Unspecified, "{}").is_err());
    assert!(call("contacts", wire::FollowVerb::Pass, "not json").is_err());
    let stopped = call(
        "contacts",
        wire::FollowVerb::Stop,
        r#"{"origin_id":"nothing"}"#,
    )
    .expect("a stop of nothing is answered");
    let Some(wire::response::Kind::Follow(answer)) = stopped.kind else {
        panic!("a follow answer");
    };
    assert!(
        answer.declined,
        "the vault says so in its own sentence: {answer:?}"
    );
}
