//! The shell frame on rooms: Home, Settings and Backup, with their text snapshots, driven through
//! a door that answers the backup status and keeps the device store in memory.

use std::collections::BTreeMap;
use std::sync::Mutex;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::room::selector::Act;
use centraid_screens::room::shell::{self, APPEARANCE_KEY, DETAILS_KEY};
use centraid_screens::room::{Done, Door, Move, Refused, Rooms, snapshot};

const NOW: i64 = 1_795_687_200_000;

#[derive(Default)]
struct Phone {
    status: Mutex<Option<wire::BackupStatusResponse>>,
    device: Mutex<BTreeMap<String, String>>,
    failing: Mutex<bool>,
}

impl Door for Phone {
    fn act(&self, _: &Act) -> Result<Done, Refused> {
        Err(Refused("no actions here".into()))
    }

    fn undo(&self) -> Result<Done, Refused> {
        Err(Refused("nothing to undo".into()))
    }

    fn now_ms(&self) -> i64 {
        NOW
    }

    fn call(&self, request: &wire::Request) -> Result<wire::Response, Refused> {
        match &request.kind {
            Some(wire::request::Kind::BackupStatus(_)) => {
                if *self.failing.lock().unwrap() {
                    return Err(Refused("The core could not be asked.".into()));
                }
                let status = self.status.lock().unwrap().clone().unwrap_or_default();
                Ok(wire::Response {
                    kind: Some(wire::response::Kind::BackupStatus(status)),
                })
            }
            _ => Err(Refused("unexpected".into())),
        }
    }

    fn device_get(&self, key: &str) -> Option<String> {
        self.device.lock().unwrap().get(key).cloned()
    }

    fn device_put(&self, key: &str, value: &str) -> Result<(), Refused> {
        self.device
            .lock()
            .unwrap()
            .insert(key.to_owned(), value.to_owned());
        Ok(())
    }
}

fn tap(id: &str) -> wire::RoomEvent {
    wire::RoomEvent {
        kind: Some(wire::room_event::Kind::Tap(wire::RoomTap {
            selector_id: id.to_owned(),
        })),
    }
}

fn pick(id: &str, option: &str) -> wire::RoomEvent {
    wire::RoomEvent {
        kind: Some(wire::room_event::Kind::Change(wire::RoomChange {
            selector_id: id.to_owned(),
            seq: 1,
            value: Some(wire::room_change::Value::Option(option.to_owned())),
        })),
    }
}

fn paired() -> wire::BackupStatusResponse {
    wire::BackupStatusResponse {
        acked_at_ms: Some(NOW - 5 * 60_000),
        last_snapshot_ms: Some(NOW - 5 * 60_000),
        destinations: vec![wire::Destination {
            gateway_id: "g1".into(),
            label: "Kitchen laptop".into(),
            last_seen_ms: NOW - 60_000,
            last_ack_ms: NOW - 5 * 60_000,
            ..wire::Destination::default()
        }],
        content_total: 1240,
        content_confirmed: 1240,
        ..wire::BackupStatusResponse::default()
    }
}

#[test]
fn home_is_a_placeholder_room_with_the_band_and_two_tiles() {
    let phone = Phone::default();
    *phone.status.lock().unwrap() = Some(paired());
    let mut rooms = Rooms::new(shell::registry());
    let home = rooms.open(&phone, "home", "home", true).unwrap();
    snapshot::assert_room("shell_home", &home.room);
}

#[test]
fn settings_shows_the_choices_the_device_keeps_and_saves_a_pick() {
    let phone = Phone::default();
    *phone.status.lock().unwrap() = Some(paired());
    let mut rooms = Rooms::new(shell::registry());
    let home = rooms.open(&phone, "home", "home", true).unwrap();
    let settings = rooms
        .event(&phone, home.instance, &tap("tile/settings"))
        .unwrap()
        .unwrap();
    assert_eq!((settings.depth, settings.movement), (2, Move::Push));
    snapshot::assert_room("shell_settings", &settings.room);

    let dark = rooms
        .event(
            &phone,
            settings.instance,
            &pick("choice/appearance", "dark"),
        )
        .unwrap()
        .unwrap();
    assert_eq!(
        phone.device.lock().unwrap()[APPEARANCE_KEY],
        r#"{"v":1,"value":"dark"}"#
    );
    snapshot::assert_room("shell_settings_dark", &dark.room);

    rooms
        .event(&phone, settings.instance, &pick("choice/details", "off"))
        .unwrap();
    assert_eq!(
        phone.device.lock().unwrap()[DETAILS_KEY],
        r#"{"v":1,"value":"off"}"#
    );
}

#[test]
fn settings_says_so_when_a_pick_could_not_be_kept() {
    struct Refusing(Phone);
    impl Door for Refusing {
        fn act(&self, a: &Act) -> Result<Done, Refused> {
            self.0.act(a)
        }
        fn undo(&self) -> Result<Done, Refused> {
            self.0.undo()
        }
        fn now_ms(&self) -> i64 {
            NOW
        }
        fn call(&self, r: &wire::Request) -> Result<wire::Response, Refused> {
            self.0.call(r)
        }
        fn device_put(&self, _: &str, _: &str) -> Result<(), Refused> {
            Err(Refused("disk".into()))
        }
    }
    let phone = Refusing(Phone::default());
    let mut rooms = Rooms::new(shell::registry());
    let settings = rooms.open(&phone, "settings", "home", true).unwrap();
    let shown = rooms
        .event(&phone, settings.instance, &pick("choice/units", "metric"))
        .unwrap()
        .unwrap();
    let line = shown.room.status_line.unwrap();
    assert!(line.refused);
    assert_eq!(line.sentence, "Couldn't save your units. Try again.");
}

#[test]
fn backup_shows_the_one_honest_line_and_the_devices() {
    let phone = Phone::default();
    *phone.status.lock().unwrap() = Some(paired());
    let mut rooms = Rooms::new(shell::registry());
    let backup = rooms.open(&phone, "backup", "backup", true).unwrap();
    snapshot::assert_room("shell_backup_paired", &backup.room);
}

#[test]
fn backup_says_so_when_nothing_is_paired() {
    let phone = Phone::default();
    *phone.status.lock().unwrap() = Some(wire::BackupStatusResponse::default());
    let mut rooms = Rooms::new(shell::registry());
    let backup = rooms.open(&phone, "backup", "backup", true).unwrap();
    snapshot::assert_room("shell_backup_unpaired", &backup.room);
}

#[test]
fn backup_fails_in_the_cores_sentence_with_a_retry_and_recovers() {
    let phone = Phone::default();
    *phone.failing.lock().unwrap() = true;
    let mut rooms = Rooms::new(shell::registry());
    let backup = rooms.open(&phone, "backup", "backup", true).unwrap();
    snapshot::assert_room("shell_backup_failed", &backup.room);
    *phone.failing.lock().unwrap() = false;
    *phone.status.lock().unwrap() = Some(paired());
    let again = rooms
        .event(&phone, backup.instance, &tap("retry"))
        .unwrap()
        .unwrap();
    assert!(matches!(
        again.room.state,
        Some(wire::room::State::Ready(_))
    ));
}

#[test]
fn back_from_settings_returns_to_home_where_it_was() {
    let phone = Phone::default();
    *phone.status.lock().unwrap() = Some(paired());
    let mut rooms = Rooms::new(shell::registry());
    let home = rooms.open(&phone, "home", "home", true).unwrap();
    let settings = rooms
        .event(&phone, home.instance, &tap("tile/settings"))
        .unwrap()
        .unwrap();
    let back = rooms
        .event(&phone, settings.instance, &tap("back"))
        .unwrap()
        .unwrap();
    assert_eq!((back.instance, back.movement), (home.instance, Move::Pop));
}
