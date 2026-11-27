use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use centraid_api_proto::core_v1 as wire;
use centraid_domain::apps::entity as entity_reads;
use centraid_domain::read::{Args, Reader};
use centraid_screens::room::selector::Act;
use centraid_screens::room::shell::{self, UNITS_KEY};
use centraid_screens::room::{Done, Door, Refused, Rooms, snapshot};
use centraid_vault::clock::{FixedClock, SeededIds};
use centraid_vault::commands::Registry as VaultRegistry;
use centraid_vault::{Command, CommandStatus, Principal, Vault};
use serde_json::{Value, json};

const NOW: i64 = 1_795_687_200_000; // 2026-11-27T10:00:00Z

struct TestDoor {
    _dir: tempfile::TempDir,
    vault: Vault,
    vault_registry: VaultRegistry,
    clock: Arc<FixedClock>,
    device: Mutex<BTreeMap<String, String>>,
    drains: Mutex<usize>,
}

impl TestDoor {
    fn new(seed: &str) -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        let clock = Arc::new(FixedClock::at(NOW));
        let vault = Vault::create_with(
            dir.path().join("vault.db"),
            Box::new(Arc::clone(&clock)),
            Box::new(SeededIds::new(seed)),
        )
        .expect("vault")
        .with_blobs(Box::new(
            centraid_vault::bytes::FsBlobStore::open(dir.path().join("blobs")).expect("blobs"),
        ));
        vault.found("My Vault", "Srikanth").expect("found");
        Self {
            _dir: dir,
            vault,
            vault_registry: VaultRegistry::with_system_commands().expect("registry"),
            clock,
            device: Mutex::new(BTreeMap::new()),
            drains: Mutex::new(0),
        }
    }

    fn ok(&self, cmd: &str, input: Value) -> Value {
        self.clock.advance_ms(1_000);
        let outcome = self
            .vault
            .execute(
                &self.vault_registry,
                &Principal::owner("phone"),
                &Command::new(cmd, input),
            )
            .unwrap_or_else(|e| panic!("{cmd}: {e}"));
        assert_eq!(
            outcome.status,
            CommandStatus::Executed,
            "{cmd}: {:?}",
            outcome.reason
        );
        outcome.output
    }
}

impl Door for TestDoor {
    fn act(&self, act: &Act) -> Result<Done, Refused> {
        let command = act.name.split('/').next().unwrap_or(&act.name);
        self.clock.advance_ms(1_000);
        let outcome = self
            .vault
            .execute(
                &self.vault_registry,
                &Principal::owner("phone"),
                &Command::new(command, act.input.clone()),
            )
            .map_err(|e| Refused(e.to_string()))?;
        if outcome.status == CommandStatus::Executed {
            Ok(Done {
                sentence: "Done".to_owned(),
                undo: false,
            })
        } else {
            Err(Refused(
                outcome.reason.unwrap_or_else(|| "Refused".to_owned()),
            ))
        }
    }

    fn undo(&self) -> Result<Done, Refused> {
        Err(Refused("nothing to undo".to_owned()))
    }

    fn now_ms(&self) -> i64 {
        NOW
    }

    fn call(&self, request: &wire::Request) -> Result<wire::Response, Refused> {
        match &request.kind {
            Some(wire::request::Kind::Drain(_)) => {
                *self.drains.lock().unwrap() += 1;
                Ok(wire::Response::default())
            }
            Some(wire::request::Kind::BackupStatus(_)) => Ok(wire::Response {
                kind: Some(wire::response::Kind::BackupStatus(
                    wire::BackupStatusResponse {
                        acked_at_ms: Some(NOW - 5 * 60_000),
                        destinations: vec![wire::Destination {
                            gateway_id: "g1".into(),
                            label: "Kitchen laptop".into(),
                            last_seen_ms: NOW - 60_000,
                            last_ack_ms: NOW - 5 * 60_000,
                            ..wire::Destination::default()
                        }],
                        ..wire::BackupStatusResponse::default()
                    },
                )),
            }),
            _ => Err(Refused("unexpected".to_owned())),
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

    fn device_delete(&self, key: &str) -> Result<(), Refused> {
        self.device.lock().unwrap().remove(key);
        Ok(())
    }

    fn reader(&self) -> Result<Reader, Refused> {
        Reader::open(self.vault.path()).map_err(|e| Refused(e.to_string()))
    }

    fn vault_id(&self) -> String {
        "v1".to_owned()
    }
}

fn tap(id: &str) -> wire::RoomEvent {
    wire::RoomEvent {
        kind: Some(wire::room_event::Kind::Tap(wire::RoomTap {
            selector_id: id.to_owned(),
        })),
    }
}

fn text_change(id: &str, seq: u64, text: &str) -> wire::RoomEvent {
    wire::RoomEvent {
        kind: Some(wire::room_event::Kind::Change(wire::RoomChange {
            selector_id: id.to_owned(),
            seq,
            value: Some(wire::room_change::Value::Text(text.to_owned())),
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

#[test]
fn health_summary_phone_says_workouts_vitals_and_kinds_merge() {
    let door = TestDoor::new("health-room");

    // Seed followed daily totals from Apple Health, then override steps by hand (S5/N3).
    door.ok(
        "measurement.record",
        json!({
            "origin": { "system": "health", "ref": "apple-health", "device_id": "iphone-1", "cursor": "c1" },
            "days": [
                { "day": "2026-11-25", "metric": "steps", "value": 7200 },
                { "day": "2026-11-26", "metric": "steps", "value": 8100 },
                { "day": "2026-11-26", "metric": "sleep_min", "value": 450 }
            ]
        }),
    );
    door.ok(
        "measurement.log",
        json!({ "day": "2026-11-26", "metric": "steps", "value": 9000 }),
    );

    // Seed a workout and discrete readings.
    let w_out = door.ok(
        "workout.log",
        json!({
            "type": "run",
            "title": "Morning loop",
            "starts": "2026-11-26T07:00:00.000Z",
            "moving_s": 1800,
            "distance_m": 5000.0,
            "energy_kcal": 340.0,
            "heart_bpm": 148
        }),
    );
    let workout_id = w_out["id"].as_str().expect("workout id").to_owned();

    door.ok(
        "reading.add",
        json!({
            "metric": "weight_kg",
            "at": "2026-11-26T06:30:00.000Z",
            "value": 72.4,
            "context": "morning"
        }),
    );
    door.ok(
        "reading.add",
        json!({
            "metric": "blood_pressure",
            "at": "2026-11-26T06:35:00.000Z",
            "value": 118.0,
            "value2": 76.0
        }),
    );

    let mut rooms = Rooms::new(shell::registry());
    let summary = rooms.open(&door, "health", "home", true).unwrap();
    let rendered = snapshot::render(&summary.room);
    assert!(
        rendered.contains("Phone says"),
        "missing Phone says: {rendered}"
    );
    assert!(
        rendered.contains("8100 steps"),
        "missing stated value: {rendered}"
    );
    assert!(
        rendered.contains("9000 steps"),
        "missing override value: {rendered}"
    );
    snapshot::assert_room("health_summary", &summary.room);

    // Clear override restores Phone's stated value (8100 steps) and removes Phone says.
    let restored = rooms
        .event(&door, summary.instance, &tap("says/clear/steps"))
        .unwrap()
        .unwrap();
    let restored_text = snapshot::render(&restored.room);
    assert!(
        !restored_text.contains("Phone says"),
        "Phone says should disappear after clear: {restored_text}"
    );
    assert!(restored_text.contains("8100 steps"));

    // Imperial units formatting on Vitals & Workouts.
    door.device_put(UNITS_KEY, r#"{"v":1,"value":"imperial"}"#)
        .unwrap();
    let vitals = rooms.open(&door, "health/vitals", "home", true).unwrap();
    let vitals_text = snapshot::render(&vitals.room);
    assert!(
        vitals_text.contains("lb"),
        "expected lb in imperial vitals: {vitals_text}"
    );
    snapshot::assert_room("health_vitals", &vitals.room);

    let workouts = rooms.open(&door, "health/workouts", "home", true).unwrap();
    let workouts_text = snapshot::render(&workouts.room);
    assert!(
        workouts_text.contains("mi"),
        "expected mi in imperial workouts: {workouts_text}"
    );
    snapshot::assert_room("health_workouts", &workouts.room);

    // Workout detail opens cleanly.
    let detail = rooms
        .open(&door, &format!("health/workout/{workout_id}"), "home", true)
        .unwrap();
    assert!(snapshot::render(&detail.room).contains("Morning loop"));

    // New workout form writes a D1 draft on edit and clears it on cancel.
    let new_w = rooms
        .open(&door, "health/workouts/new", "home", true)
        .unwrap();
    rooms
        .event(
            &door,
            new_w.instance,
            &text_change("field/title", 1, "Tempo"),
        )
        .unwrap();
    assert!(door.device_get("draft.v1.workout").is_some());
    rooms
        .event(&door, new_w.instance, &tap("form/cancel"))
        .unwrap();
    assert!(door.device_get("draft.v1.workout").is_none());

    // Workout kinds page + concept.merge (V4/N17).
    let kinds = rooms.open(&door, "health/kinds", "home", true).unwrap();
    snapshot::assert_room("health_kinds", &kinds.room);
    let merge_confirm = rooms
        .open(
            &door,
            "health/kind/workout_kind:walk/merge/workout_kind:run",
            "home",
            true,
        )
        .unwrap();
    rooms
        .event(&door, merge_confirm.instance, &tap("confirm/yes"))
        .unwrap();
    let kinds_after = rooms.open(&door, "health/kinds", "home", true).unwrap();
    assert!(!snapshot::render(&kinds_after.room).contains("Walk"));
}

#[test]
fn locker_secure_wall_masked_facts_type_change_alerts_and_no_drafts() {
    let door = TestDoor::new("locker-room");

    // Seed a Locker login item with plaintext username, sealed password, date field + expiry reminder,
    // and a sealed capture file (kind = "file", I7).
    let item_id = "019a1111-1111-7111-8111-111111111111";
    let date_field_id = "019a1111-1111-7111-8111-222222222222";
    let key_id = door.vault.locker_generation().expect("locker key");
    let sealed_secret = "lk1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    let sealed_file = "lk1:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    let mut file_bytes = Vec::new();
    file_bytes.extend_from_slice(b"lkf1");
    file_bytes.extend_from_slice(&65_536u32.to_be_bytes());
    file_bytes.extend_from_slice(&[0x55u8; 32]);
    let blob_hash = door
        .vault
        .blobs()
        .expect("blobs")
        .put(&file_bytes)
        .expect("put blob");
    door.ok(
        "blob.stage",
        json!({ "hash": blob_hash, "size": file_bytes.len() }),
    );
    door.ok(
        "locker.add_item",
        json!({
            "item_id": item_id,
            "type": "login",
            "title": "GitHub",
            "fields": [
                { "field_key": "username", "label": "Username", "kind": "text", "value": "srikanth" },
                { "field_key": "password", "label": "Password", "kind": "sealed", "value": sealed_secret, "key_id": key_id },
                { "field_id": date_field_id, "label": "Passport renewal", "kind": "date", "value": "2027-01-15" },
                { "field_id": "019a1111-1111-7111-8111-333333333333", "label": "Recovery PDF", "kind": "file", "value": sealed_file, "blob": blob_hash, "key_id": key_id }
            ]
        }),
    );
    door.ok(
        "reminder.add",
        json!({ "entity_id": item_id, "field_id": date_field_id, "offset_min": 1440 }),
    );

    let mut rooms = Rooms::new(shell::registry());

    // Locked state: secure = true, wall block inside Ready, no search.
    let locked = rooms.open(&door, "locker", "home", true).unwrap();
    assert!(
        locked.room.secure,
        "Locker locked room must set secure = true"
    );
    assert!(locked.room.search.is_none(), "No search while locked");
    snapshot::assert_room("locker_locked", &locked.room);

    // Unlock via wall/unlock.
    let unlocked = rooms
        .event(&door, locked.instance, &tap("wall/unlock"))
        .unwrap()
        .unwrap();
    assert!(unlocked.room.secure);
    let unlocked_text = snapshot::render(&unlocked.room);
    assert!(unlocked_text.contains("GitHub"));
    assert!(
        !unlocked_text.contains("Share"),
        "P4/N13: no Share in Locker"
    );
    snapshot::assert_room("locker_unlocked", &unlocked.room);

    // Detail room: masked secret + sealed file, no plaintext ciphertext, no Share.
    let detail = rooms
        .open(&door, &format!("locker/item/{item_id}"), "home", true)
        .unwrap();
    assert!(detail.room.secure);
    let detail_text = snapshot::render(&detail.room);
    assert!(detail_text.contains("srikanth"));
    assert!(detail_text.contains("sealed"));
    assert!(!detail_text.contains("lk1:ciphertext"));
    assert!(!detail_text.contains("lk1:sealed-name"));
    assert!(!detail_text.contains("Share"));
    snapshot::assert_room("locker_detail", &detail.room);

    // Type change from login -> card keeps extra fields (N4/V3).
    let change_type = rooms
        .open(&door, &format!("locker/item/{item_id}/type"), "home", true)
        .unwrap();
    assert!(change_type.room.secure);
    rooms
        .event(&door, change_type.instance, &tap("type/card"))
        .unwrap();
    let after_retype = rooms
        .open(&door, &format!("locker/item/{item_id}"), "home", true)
        .unwrap();
    let retype_text = snapshot::render(&after_retype.room);
    assert!(retype_text.contains("Card"));
    assert!(
        retype_text.contains("srikanth"),
        "extra field must survive type change"
    );

    // Masked expiry alerts: never name the item or field, Snooze only (S9/N19).
    let alerts = rooms.open(&door, "locker/alerts", "home", true).unwrap();
    assert!(alerts.room.secure);
    let alerts_text = snapshot::render(&alerts.room);
    assert!(alerts_text.contains("An item in Locker expires soon"));
    assert!(
        !alerts_text.contains("GitHub"),
        "S9/N19: alert must not name item"
    );
    assert!(
        !alerts_text.contains("Passport renewal"),
        "S9/N19: alert must not name field"
    );
    snapshot::assert_room("locker_alerts", &alerts.room);

    // New item form: M9 — NO drafts on disk!
    let new_item = rooms.open(&door, "locker/new", "home", true).unwrap();
    assert!(new_item.room.secure);
    rooms
        .event(
            &door,
            new_item.instance,
            &text_change("field/title", 1, "Secret"),
        )
        .unwrap();
    assert!(
        door.device_get("draft.v1.locker_item").is_none(),
        "M9: Locker must never write drafts to disk"
    );

    // Export confirm is owner-check class and secure.
    let export = rooms.open(&door, "locker/export", "home", true).unwrap();
    assert!(export.room.secure);
    assert!(snapshot::render(&export.room).contains("owner"));
}

#[test]
fn chat_live_cards_attachments_tombstones_clear_and_concepts() {
    let door = TestDoor::new("chat-room");

    // Create two entities: one stays live, one gets purged so its card & attachment render tombstones!
    let live_person = door.ok("person.add", json!({ "title": "Ana Diaz" }))["id"]
        .as_str()
        .expect("id")
        .to_owned();
    let doomed_doc = door.ok(
        "document.create_text",
        json!({ "title": "Secret draft", "body_text": "ephemeral" }),
    )["id"]
        .as_str()
        .expect("id")
        .to_owned();

    let saved = door.ok(
        "thread.save_turn",
        json!({
            "turn": {
                "question": {
                    "text": "Who am I meeting?",
                    "attachments": [
                        { "form": "document", "entity_id": doomed_doc }
                    ]
                },
                "answer": {
                    "outcome": "answered",
                    "text": "You are meeting Ana Diaz.",
                    "cards": [
                        { "entity_id": live_person, "qualifier": "person" },
                        { "entity_id": doomed_doc, "qualifier": "doc" }
                    ]
                }
            }
        }),
    );
    let thread_id = saved["thread_id"].as_str().expect("thread_id").to_owned();

    // Trash & purge the doomed doc -> message_card.entity_id & message_attachment.entity_id become NULL.
    door.ok("entity.trash", json!({ "id": doomed_doc }));
    door.ok("entity.purge", json!({ "id": doomed_doc }));

    let mut rooms = Rooms::new(shell::registry());
    let root = rooms.open(&door, "chat", "chat", true).unwrap();
    snapshot::assert_room("chat_root", &root.room);

    let thread = rooms
        .open(&door, &format!("chat/{thread_id}"), "chat", true)
        .unwrap();
    let thread_text = snapshot::render(&thread.room);
    assert!(
        thread_text.contains("Ana Diaz"),
        "live card must resolve live title"
    );
    assert!(
        thread_text.contains("An item you deleted"),
        "S1/S2: purged card must render tombstone: {thread_text}"
    );
    assert!(
        thread_text.contains("[A deleted item]"),
        "S1b: purged attachment must render tombstone: {thread_text}"
    );
    assert!(
        !thread_text.contains("Secret draft"),
        "purged title must never appear"
    );
    snapshot::assert_room("chat_thread", &thread.room);

    // Concepts (touch_kind & relation) rename & merge (V4).
    let concepts = rooms.open(&door, "chat/concepts", "chat", true).unwrap();
    snapshot::assert_room("chat_concepts", &concepts.room);

    // Clear chats outlined confirm.
    let clear = rooms.open(&door, "chat/clear", "chat", true).unwrap();
    assert!(snapshot::render(&clear.room).contains("outlined"));
    rooms
        .event(&door, clear.instance, &tap("confirm/yes"))
        .unwrap();
    let root_after = rooms.open(&door, "chat", "chat", true).unwrap();
    assert!(snapshot::render(&root_after.room).contains("Ask your vault"));
}

#[test]
fn deferred_core_reads_and_shell_backup_settings_actions() {
    let door = TestDoor::new("core-reads");
    door.ok(
        "measurement.record",
        json!({
            "origin": { "system": "health", "ref": "apple-health", "device_id": "iphone-1", "cursor": "cur-42" },
            "days": [{ "day": "2026-11-27", "metric": "steps", "value": 5000 }]
        }),
    );

    let reader = door.reader().unwrap();
    let stores = reader
        .run(
            &entity_reads::FOLLOWED_STORES,
            &Args::new().text("system", "health"),
        )
        .unwrap();
    assert_eq!(stores.rows.len(), 1);
    assert_eq!(stores.rows[0].cursor.as_deref(), Some("cur-42"));

    let cursor = reader
        .run(
            &entity_reads::ORIGIN_CURSOR,
            &Args::new()
                .text("system", "health")
                .text("ref", "apple-health"),
        )
        .unwrap();
    assert_eq!(cursor.rows.len(), 1);
    assert_eq!(cursor.rows[0].cursor.as_deref(), Some("cur-42"));

    let files = reader
        .run(&entity_reads::FILES_FOLLOWED, &Args::new())
        .unwrap();
    assert!(files.rows.is_empty());

    let person_id = door.ok("person.add", json!({ "title": "Priya" }))["id"]
        .as_str()
        .expect("id")
        .to_owned();
    door.ok(
        "person.edit",
        json!({ "id": person_id, "role": "Engineer" }),
    );
    let versions = reader
        .run(
            &entity_reads::EARLIER_VERSIONS,
            &Args::new().text("id", &person_id),
        )
        .unwrap();
    assert!(!versions.rows.is_empty());

    let diffs = reader
        .run(
            &entity_reads::PHONE_DIFFERENCES,
            &Args::new().text("id", &person_id),
        )
        .unwrap();
    assert!(diffs.rows.is_empty());

    // Shell Backup "Back up now" and Settings recovery-key owner-check sheet.
    let mut rooms = Rooms::new(shell::registry());
    let backup = rooms.open(&door, "backup", "backup", true).unwrap();
    let backed = rooms
        .event(&door, backup.instance, &tap("row/backup-now"))
        .unwrap()
        .unwrap();
    assert_eq!(*door.drains.lock().unwrap(), 1);
    assert_eq!(
        backed
            .room
            .status_line
            .as_ref()
            .map(|s| s.sentence.as_str()),
        Some("Backing up")
    );

    let settings = rooms.open(&door, "settings", "home", true).unwrap();
    let rec = rooms
        .event(&door, settings.instance, &tap("row/recovery-key"))
        .unwrap()
        .unwrap();
    assert!(snapshot::render(&rec.room).contains("owner"));
    let _ = pick("choice/units", "metric");
}
