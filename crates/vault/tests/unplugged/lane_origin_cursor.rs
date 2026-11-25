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

