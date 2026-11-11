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
