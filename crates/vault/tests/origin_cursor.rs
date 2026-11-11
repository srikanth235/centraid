//! A phone store's cursor lives in the vault, on its origin row, and moves in the commit of the
//! records it covers (#1183): `photo.add`'s `roll_cursor` and `roll_device`, and
//! `follow.advance_cursor` for a position no record rides with. A cursor is the word of the install
//! that wrote it: another install is told nothing, which is a complete read.

mod common;

use centraid_vault::commands::Registry;
use centraid_vault::commands::origin_cursor::{CAMERA_ROLL_REF, read};
use centraid_vault::{Command, CommandStatus, Principal};
use serde_json::{Value, json};

struct World {
    scratch: common::Scratch,
    registry: Registry,
}

impl World {
    fn new() -> Self {
        Self {
            scratch: common::Scratch::founded_with_blobs("origin_cursor").expect("a vault"),
            registry: Registry::with_system_commands().expect("a registry"),
        }
    }

    fn run(&self, name: &str, input: Value) -> centraid_vault::CommandOutcome {
        self.scratch
            .vault
            .execute(
                &self.registry,
                &Principal::owner("phone"),
                &Command::new(name, input),
            )
            .unwrap_or_else(|error| panic!("`{name}`: {error}"))
    }

    fn ok(&self, name: &str, input: Value) -> Value {
        let outcome = self.run(name, input);
        assert_eq!(
            outcome.status,
            CommandStatus::Executed,
            "{name}: {:?}",
            outcome.reason
        );
        outcome.output
    }

    fn bytes(&self, seed: &str) -> String {
        let hash = centraid_vault::blob::content_digest(seed.as_bytes());
        self.ok("blob.stage", json!({ "hash": hash, "size": seed.len() }));
        hash
    }

    fn count(&self, sql: &str) -> i64 {
        self.scratch
            .vault
            .read(|c| Ok(c.query_row(sql, [], |r| r.get(0))?))
            .expect("a count")
    }

    fn cursor(&self, device: &str) -> Option<String> {
        self.scratch
            .vault
            .read(|c| read(c, "camera_roll", CAMERA_ROLL_REF, device))
            .expect("a read")
    }

    fn photos(&self) -> i64 {
        self.count("SELECT COUNT(*) FROM photo")
    }
}

#[test]
fn a_photograph_and_the_cursor_past_it_are_one_commit_and_the_origin_names_the_install() {
    let w = World::new();
    assert_eq!(w.cursor("phone-a"), None, "no cursor before a read");
    let blob = w.bytes("first");
    w.ok(
        "photo.add",
        json!({ "blob": blob, "media_type": "image/jpeg",
                "arrived_system": "camera_roll", "arrived_label": CAMERA_ROLL_REF,
                "roll_cursor": "k|1", "roll_device": "phone-a" }),
    );
    assert_eq!(w.photos(), 1);
    assert_eq!(w.cursor("phone-a").as_deref(), Some("k|1"));
    // The arrival and the cursor share the one origin of the camera roll.
    assert_eq!(
        w.count("SELECT COUNT(*) FROM origin WHERE system = 'camera_roll'"),
        1
    );
    // ANOTHER INSTALL IS TOLD NOTHING: its read is a complete one.
    assert_eq!(w.cursor("phone-b"), None);
    assert_eq!(w.cursor(""), None);
}

#[test]
fn a_refused_add_leaves_the_cursor_and_the_records_where_they_were() {
    let w = World::new();
    let blob = w.bytes("first");
    w.ok(
        "photo.add",
        json!({ "blob": blob, "media_type": "image/jpeg",
                "roll_cursor": "k|1", "roll_device": "phone-a" }),
    );
    // Bytes nobody staged: the add is refused by its precondition, and the cursor does not move.
    let refused = w.run(
        "photo.add",
        json!({ "blob": "ab".repeat(32), "media_type": "image/jpeg",
                "roll_cursor": "k|2", "roll_device": "phone-a" }),
    );
    assert_eq!(refused.status, CommandStatus::Failed);
    assert!(refused.tables.is_empty());
    assert_eq!(w.cursor("phone-a").as_deref(), Some("k|1"));
    assert_eq!(w.photos(), 1);
    // A cursor with no install to own it is refused whole: no photograph either.
    let second = w.bytes("second");
    let nameless = w.scratch.vault.execute(
        &w.registry,
        &Principal::owner("phone"),
        &Command::new(
            "photo.add",
            json!({ "blob": second, "media_type": "image/jpeg", "roll_cursor": "k|2" }),
        ),
    );
    assert!(nameless.is_err(), "{nameless:?}");
    assert_eq!(w.photos(), 1);
    assert_eq!(w.cursor("phone-a").as_deref(), Some("k|1"));
}

#[test]
fn bytes_already_held_still_move_the_cursor_and_another_install_takes_the_origin_over() {
    let w = World::new();
    let blob = w.bytes("first");
    w.ok(
        "photo.add",
        json!({ "blob": blob, "media_type": "image/jpeg",
                "roll_cursor": "k|1", "roll_device": "phone-a" }),
    );
    // A re-walk from the start by a second phone offers the same bytes: adopted, and its cursor is
    // the origin's now.
    let again = w.ok(
        "photo.add",
        json!({ "blob": blob, "media_type": "image/jpeg",
                "roll_cursor": "t|9", "roll_device": "phone-b" }),
    );
    assert_eq!(again["deduped"], true);
    assert_eq!(w.photos(), 1);
    assert_eq!(w.cursor("phone-b").as_deref(), Some("t|9"));
    assert_eq!(
        w.cursor("phone-a"),
        None,
        "the first phone's word is replaced"
    );
}

#[test]
fn a_cursor_with_no_photograph_moves_alone_and_is_idempotent() {
    let w = World::new();
    let input = json!({ "system": "camera_roll", "ref": CAMERA_ROLL_REF,
                        "device_id": "phone-a", "cursor": "t|3" });
    w.ok("follow.advance_cursor", input.clone());
    w.ok("follow.advance_cursor", input);
    assert_eq!(w.cursor("phone-a").as_deref(), Some("t|3"));
    assert_eq!(
        w.count("SELECT COUNT(*) FROM origin WHERE system = 'camera_roll'"),
        1
    );
    // A cursor is kept beside what the origin already holds: nothing else of `config` goes.
    w.ok(
        "follow.advance_cursor",
        json!({ "system": "camera_roll", "ref": CAMERA_ROLL_REF,
                "device_id": "phone-a", "cursor": "t|4" }),
    );
    assert_eq!(w.cursor("phone-a").as_deref(), Some("t|4"));
}

const STORE: &str = "store:apple-health";

impl World {
    fn health_cursor(&self, device: &str) -> Option<String> {
        self.scratch
            .vault
            .read(|c| read(c, "health", STORE, device))
            .expect("a read")
    }

    fn steps(&self, day: &str) -> Option<f64> {
        self.scratch
            .vault
            .read(|c| {
                Ok(c.query_row(
                    "SELECT value FROM measurement WHERE day = ?1 AND metric = 'steps'",
                    [day],
                    |r| r.get(0),
                )
                .ok())
            })
            .expect("a read")
    }

    fn follow_workouts(&self, device: &str, records: Value, extra: Value) -> Value {
        let mut input = json!({
            "origin": { "ref": STORE, "label": "Apple Health", "device_id": device },
            "records": records,
        });
        for (name, value) in extra.as_object().cloned().unwrap_or_default() {
            if name == "cursor" {
                input["origin"]["cursor"] = value;
            } else {
                input[name] = value;
            }
        }
        self.ok("follow.health", input)
    }
}

fn run_record(id: &str, hour: u32) -> Value {
    json!({ "external_id": format!("local:{id}"), "device_id": "phone-a", "fields": {
        "kind": "run",
        "starts": format!("2026-03-02T{hour:02}:00:00.000Z"),
        "ends": format!("2026-03-02T{hour:02}:30:00.000Z"),
        "workout": {} } })
}

#[test]
fn health_days_and_the_cursor_past_them_are_one_commit_and_a_refused_batch_moves_neither() {
    let w = World::new();
    let days = |value: f64| json!([{ "day": "2026-03-02", "metric": "steps", "value": value }]);
    w.ok(
        "measurement.record",
        json!({ "days": days(900.0), "cursor": "a1", "cursor_ref": STORE,
                "cursor_device": "phone-a" }),
    );
    assert_eq!(w.steps("2026-03-02"), Some(900.0));
    assert_eq!(w.health_cursor("phone-a").as_deref(), Some("a1"));
    // The origin the cursor founded names the install, and another install is told nothing.
    assert_eq!(w.health_cursor("phone-b"), None);
    // A batch the vault refuses (a day that is no day) leaves the figure and the cursor.
    let refused = w.run(
        "measurement.record",
        json!({ "days": [{ "day": "2026-02-30", "metric": "steps", "value": 5.0 }],
                "cursor": "a2", "cursor_ref": STORE, "cursor_device": "phone-a" }),
    );
    assert_eq!(refused.status, CommandStatus::Failed);
    assert_eq!(w.health_cursor("phone-a").as_deref(), Some("a1"));
    assert_eq!(w.steps("2026-03-02"), Some(900.0));
    // A cursor without the store or the install is refused whole.
    let nameless = w.run(
        "measurement.record",
        json!({ "days": days(1.0), "cursor": "a3" }),
    );
    assert_eq!(nameless.status, CommandStatus::Failed);
    assert_eq!(w.health_cursor("phone-a").as_deref(), Some("a1"));
    assert_eq!(w.steps("2026-03-02"), Some(900.0));
}

#[test]
fn follow_workouts_moves_the_cursor_with_its_records_and_another_install_takes_the_origin_over() {
    let w = World::new();
    w.follow_workouts(
        "phone-a",
        json!([run_record("w1", 7)]),
        json!({ "cursor": "a1" }),
    );
    assert_eq!(w.health_cursor("phone-a").as_deref(), Some("a1"));
    assert_eq!(w.count("SELECT COUNT(*) FROM activity"), 1);
    // The origin's other settings are kept beside the cursor: a pass that states no cursor leaves it.
    w.follow_workouts("phone-a", json!([run_record("w1", 7)]), json!({}));
    assert_eq!(w.health_cursor("phone-a").as_deref(), Some("a1"));
    // A cursor with no install to own it is refused whole, records and all.
    let nameless = w.run(
        "follow.health",
        json!({ "origin": { "ref": STORE, "label": "Apple Health", "cursor": "a2" },
                "records": [run_record("w2", 9)] }),
    );
    assert_eq!(nameless.status, CommandStatus::Failed);
    assert_eq!(w.count("SELECT COUNT(*) FROM activity"), 1);
    assert_eq!(w.health_cursor("phone-a").as_deref(), Some("a1"));
    // ANOTHER INSTALL'S FIRST COMMIT takes the origin over: even one that states no cursor leaves
    // the last install's word behind (a complete read, then its own cursor).
    w.follow_workouts("phone-b", json!([]), json!({}));
    assert_eq!(w.health_cursor("phone-a"), None);
    assert_eq!(w.health_cursor("phone-b"), None);
    w.follow_workouts("phone-b", json!([]), json!({ "cursor": "b1" }));
    assert_eq!(w.health_cursor("phone-b").as_deref(), Some("b1"));
}

#[test]
fn a_workout_a_delta_names_deleted_keeps_its_row_and_forgets_its_source() {
    let w = World::new();
    w.follow_workouts(
        "phone-a",
        json!([run_record("w1", 7), run_record("w2", 9)]),
        json!({ "cursor": "a1" }),
    );
    assert_eq!(
        w.count("SELECT COUNT(*) FROM source WHERE system = 'health'"),
        2
    );
    let told = w.follow_workouts(
        "phone-a",
        json!([]),
        json!({ "gone": ["local:w1", "local:never-seen"], "cursor": "a2" }),
    );
    assert_eq!(told["forgotten"], 1);
    // THE MEMBER'S RECORD STAYS: both rows are there, one has lost its source.
    assert_eq!(w.count("SELECT COUNT(*) FROM activity"), 2);
    assert_eq!(
        w.count("SELECT COUNT(*) FROM entity WHERE kind = 'activity' AND deleted_at IS NULL"),
        2
    );
    assert_eq!(
        w.count("SELECT COUNT(*) FROM source WHERE system = 'health'"),
        1
    );
    assert_eq!(w.health_cursor("phone-a").as_deref(), Some("a2"));
    // A system whose rows follow a complete read takes no such list.
    let refused = w.run(
        "follow.contacts",
        json!({ "origin": { "ref": "book", "label": "Contacts", "device_id": "phone-a" },
                "records": [], "gone": ["x"] }),
    );
    assert_eq!(refused.status, CommandStatus::Failed);
}

#[test]
fn advance_cursor_moves_the_health_cursor_alone() {
    let w = World::new();
    w.ok(
        "follow.advance_cursor",
        json!({ "system": "health", "ref": STORE, "device_id": "phone-a", "cursor": "a1" }),
    );
    assert_eq!(w.health_cursor("phone-a").as_deref(), Some("a1"));
    assert_eq!(w.count("SELECT COUNT(*) FROM activity"), 0);
}
