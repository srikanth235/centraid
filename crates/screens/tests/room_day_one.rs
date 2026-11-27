//! Day one on the room plane (2026-11-17 ruling): Welcome, then the one Home filling in, the
//! per-platform import group, a refused permission changing only its own widget, and the first
//! open of an app.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use centraid_api_proto::core_v1 as wire;
use centraid_core::{Core, CoreConfig, Handle};
use centraid_screens::room::selector::Act;
use centraid_screens::room::{Done, Door, Refused, Rooms, shell, snapshot};
use centraid_vault::clock::{FixedClock, SeededIds};
use serde_json::json;

const WORDS: &str = "abandon abandon abandon abandon abandon abandon abandon abandon \
                     abandon abandon abandon abandon abandon abandon abandon abandon \
                     abandon abandon abandon abandon abandon abandon abandon art";
const NOW: i64 = 1_781_517_600_000;

struct Phone {
    path: PathBuf,
    device: Mutex<BTreeMap<String, String>>,
    reminders: bool,
    refused: Vec<&'static str>,
}

impl Door for Phone {
    fn act(&self, _: &Act) -> Result<Done, Refused> {
        Err(Refused("no writes here".to_owned()))
    }

    fn undo(&self) -> Result<Done, Refused> {
        Err(Refused("nothing to undo".to_owned()))
    }

    fn now_ms(&self) -> i64 {
        NOW
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

    fn reader(&self) -> Result<centraid_domain::read::Reader, Refused> {
        centraid_domain::read::Reader::open(&self.path).map_err(|e| Refused(e.to_string()))
    }

    fn reminders_source(&self) -> bool {
        self.reminders
    }

    fn call(&self, request: &wire::Request) -> Result<wire::Response, Refused> {
        let Some(wire::request::Kind::Follow(follow)) = &request.kind else {
            return Err(Refused("no core here".to_owned()));
        };
        if follow.verb != wire::FollowVerb::Status as i32 {
            return Err(Refused("this door follows no phone store".to_owned()));
        }
        let store = match follow.system.as_str() {
            "camera_roll" => "photos",
            "contacts" => "people",
            other => other,
        };
        let blocked = if self.refused.contains(&store) {
            wire::FollowGrant::Refused
        } else {
            wire::FollowGrant::Unspecified
        };
        Ok(wire::Response {
            kind: Some(wire::response::Kind::Follow(wire::FollowResponse {
                status: Some(wire::FollowStatus {
                    blocked: blocked as i32,
                    ..Default::default()
                }),
                ..Default::default()
            })),
        })
    }
}

fn vault(dir: &std::path::Path) -> (Handle, PathBuf) {
    let seed = centraid_identity::RecoveryPhrase::parse(WORDS)
        .expect("the vector parses")
        .seed();
    let path = dir.join("vault.db");
    let handle = Core::open(CoreConfig::new(path.clone()).with_seed(seed, 0).with_clock(
        Arc::new(FixedClock::at(NOW)),
        Arc::new(SeededIds::new("day-one")),
    ))
    .expect("the core opens");
    handle
        .with_vault(|vault| Ok(vault.found("My vault", "Ada")?))
        .expect("it founds");
    (handle, path)
}

fn phone(path: &std::path::Path, reminders: bool, refused: Vec<&'static str>) -> Phone {
    Phone {
        path: path.to_path_buf(),
        device: Mutex::default(),
        reminders,
        refused,
    }
}

fn home(door: &Phone) -> (Rooms, wire::Room, u64) {
    let mut rooms = Rooms::new(shell::registry());
    let shown = rooms.open(door, "home", "home", true).expect("home opens");
    (rooms, shown.room.clone(), shown.instance)
}

fn tap(rooms: &mut Rooms, door: &Phone, instance: u64, id: &str) -> wire::Room {
    let event = wire::RoomEvent {
        kind: Some(wire::room_event::Kind::Tap(wire::RoomTap {
            selector_id: id.to_owned(),
        })),
    };
    rooms
        .event(door, instance, &event)
        .expect("event lands")
        .expect("something changed")
        .room
}

#[test]
fn a_founded_empty_vault_opens_welcome_and_get_started_shows_the_one_home() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (_handle, path) = vault(dir.path());
    let door = phone(&path, true, vec![]);
    let (mut rooms, welcome, instance) = home(&door);
    snapshot::assert_room("day_one_welcome", &welcome);
    let first = tap(&mut rooms, &door, instance, "welcome/start");
    snapshot::assert_room("day_one_home_ios", &first);
    assert!(
        door.device_get("welcome.seen").is_some(),
        "Welcome is shown once"
    );
}

#[test]
fn android_has_no_reminders_import_and_says_write_your_first_reminder() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (_handle, path) = vault(dir.path());
    let door = phone(&path, false, vec![]);
    door.device_put("welcome.seen", "1").unwrap();
    let (_rooms, first, _) = home(&door);
    snapshot::assert_room("day_one_home_android", &first);
}

#[test]
fn a_refused_permission_changes_only_its_widget() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (_handle, path) = vault(dir.path());
    let door = phone(&path, true, vec!["photos"]);
    door.device_put("welcome.seen", "1").unwrap();
    let (_rooms, first, _) = home(&door);
    let text = snapshot::render(&first);
    assert!(
        text.contains("Photo access is off · Open Settings"),
        "{text}"
    );
    assert!(text.contains("Import your calendar"), "{text}");
    assert!(
        first.status_line.is_none(),
        "a refusal is never the status line"
    );
    snapshot::assert_room("day_one_home_photos_refused", &first);
}

#[test]
fn the_first_thing_added_ends_day_one() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (handle, path) = vault(dir.path());
    let outcome = handle
        .command(
            "person.add",
            &json!({ "id": "01900000-0000-7000-8000-000000000301", "title": "Priya Nair" }),
            "seed-person",
        )
        .expect("command runs");
    assert_eq!(outcome.status, centraid_vault::CommandStatus::Executed);
    let door = phone(&path, true, vec![]);
    let (_rooms, filled, _) = home(&door);
    let text = snapshot::render(&filled);
    assert!(!text.contains("Nothing in here yet"), "{text}");
    assert!(
        door.device_get("welcome.seen").is_none(),
        "a vault with something in it skips Welcome without recording it"
    );
}

fn open_app(door: &Phone, key: &str) -> wire::Room {
    let mut rooms = Rooms::new(shell::registry());
    rooms.open(door, key, "home", true).expect("opens").room
}

#[test]
fn every_apps_first_open_is_one_sentence_its_import_and_the_plus() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (_handle, path) = vault(dir.path());
    let door = phone(&path, true, vec![]);
    for (key, snap) in [
        ("people", "first_open_people"),
        ("calendar", "first_open_calendar"),
        ("reminders", "first_open_reminders"),
        ("photos", "first_open_photos"),
        ("notes", "first_open_notes"),
        ("docs", "first_open_docs"),
        ("money", "first_open_money"),
        ("health", "first_open_health"),
        ("locker", "first_open_locker_check"),
    ] {
        snapshot::assert_room(snap, &open_app(&door, key));
    }
}

#[test]
fn android_reminders_first_open_has_no_import_and_no_or() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (_handle, path) = vault(dir.path());
    let door = phone(&path, false, vec![]);
    let room = open_app(&door, "reminders");
    let text = snapshot::render(&room);
    assert!(
        text.contains("Add the first thing you must not forget. Tap + to write one."),
        "{text}"
    );
    assert!(!text.contains("Import"), "{text}");
    snapshot::assert_room("first_open_reminders_android", &room);
}

#[test]
fn a_refused_permission_is_open_settings_alone_on_the_app_and_never_the_status_line() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (_handle, path) = vault(dir.path());
    let door = phone(
        &path,
        true,
        vec!["photos", "calendar", "reminders", "people"],
    );
    for (key, snap) in [
        ("photos", "photos_refused"),
        ("calendar", "calendar_refused"),
        ("reminders", "reminders_refused"),
        ("people", "people_refused"),
    ] {
        let room = open_app(&door, key);
        assert!(room.status_line.is_none());
        snapshot::assert_room(snap, &room);
    }
}

struct Silent {
    inner: Phone,
    asked: Mutex<Vec<String>>,
}

impl Door for Silent {
    fn act(&self, act: &Act) -> Result<Done, Refused> {
        self.asked.lock().unwrap().push(format!("act {act:?}"));
        Err(Refused("no writes here".to_owned()))
    }

    fn undo(&self) -> Result<Done, Refused> {
        self.inner.undo()
    }

    fn now_ms(&self) -> i64 {
        NOW
    }

    fn device_get(&self, key: &str) -> Option<String> {
        self.inner.device_get(key)
    }

    fn device_put(&self, key: &str, value: &str) -> Result<(), Refused> {
        self.inner.device_put(key, value)
    }

    fn reader(&self) -> Result<centraid_domain::read::Reader, Refused> {
        self.inner.reader()
    }

    fn enrol_store(&self, store: &str) -> Result<Done, Refused> {
        self.asked.lock().unwrap().push(format!("enrol {store}"));
        Err(Refused("asked".to_owned()))
    }

    fn open_settings(&self, store: &str) -> Result<Done, Refused> {
        self.asked.lock().unwrap().push(format!("settings {store}"));
        Err(Refused("asked".to_owned()))
    }
}

#[test]
fn first_launch_asks_the_phone_for_nothing() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (_handle, path) = vault(dir.path());
    let door = Silent {
        inner: phone(&path, true, vec![]),
        asked: Mutex::default(),
    };
    let mut rooms = Rooms::new(shell::registry());
    let shown = rooms
        .open(&door, "home", "home", true)
        .expect("welcome opens");
    let instance = shown.instance;
    let event = wire::RoomEvent {
        kind: Some(wire::room_event::Kind::Tap(wire::RoomTap {
            selector_id: "welcome/start".to_owned(),
        })),
    };
    rooms
        .event(&door, instance, &event)
        .expect("start lands")
        .expect("home shows");
    assert!(
        door.asked.lock().unwrap().is_empty(),
        "first launch asked the phone for something: {:?}",
        door.asked.lock().unwrap()
    );
}

#[test]
fn locker_first_open_is_two_steps_check_then_the_first_item() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (_handle, path) = vault(dir.path());
    let door = phone(&path, true, vec![]);
    let mut rooms = Rooms::new(shell::registry());
    let wall = rooms.open(&door, "locker", "home", true).expect("opens");
    let text = snapshot::render(&wall.room);
    assert!(
        text.contains("Step 1 of 2") && text.contains("Confirm it's you"),
        "{text}"
    );
    let event = wire::RoomEvent {
        kind: Some(wire::room_event::Kind::Tap(wire::RoomTap {
            selector_id: "wall/unlock".to_owned(),
        })),
    };
    let unlocked = rooms
        .event(&door, wall.instance, &event)
        .expect("unlocks")
        .expect("changed");
    let text = snapshot::render(&unlocked.room);
    assert!(
        text.contains("Step 2 of 2") && text.contains("Add your first item."),
        "{text}"
    );
    snapshot::assert_room("first_open_locker_item", &unlocked.room);
}

#[test]
fn home_widgets_run_the_import_directly_and_health_shows_its_card_only_before_it_holds_anything() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (_handle, path) = vault(dir.path());
    let door = phone(&path, true, vec![]);
    door.device_put("welcome.seen", "1").unwrap();
    let mut rooms = Rooms::new(shell::registry());
    let home = rooms.open(&door, "home", "home", true).expect("opens");
    let event = wire::RoomEvent {
        kind: Some(wire::room_event::Kind::Tap(wire::RoomTap {
            selector_id: "tile/calendar".to_owned(),
        })),
    };
    let shown = rooms
        .event(&door, home.instance, &event)
        .expect("tap lands")
        .expect("the door answered")
        .room;
    let text = snapshot::render(&shown);
    assert!(text.contains("this door follows no phone store"), "{text}");
}

#[test]
fn the_money_tile_says_what_this_month_spent() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (handle, path) = vault(dir.path());
    for (name, input, key) in [
        (
            "account.add",
            json!({ "id": "01900000-0000-7000-8000-000000000401", "title": "Checking",
                    "type": "checking", "currency": "USD", "opening_minor": 250_000,
                    "opening_on": "2026-01-01" }),
            "seed-account",
        ),
        (
            "txn.add",
            json!({ "id": "01900000-0000-7000-8000-000000000402",
                    "account_id": "01900000-0000-7000-8000-000000000401",
                    "posted_on": "2026-06-10", "amount_minor": -8450, "title": "Market" }),
            "seed-txn",
        ),
    ] {
        let outcome = handle.command(name, &input, key).expect("command runs");
        assert_eq!(outcome.status, centraid_vault::CommandStatus::Executed);
    }
    let door = phone(&path, true, vec![]);
    let (_rooms, home, _) = home(&door);
    let text = snapshot::render(&home);
    assert!(text.contains("$84.50 spent"), "{text}");
}
