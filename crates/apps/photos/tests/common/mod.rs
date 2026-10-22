//! The world every Photos test founds: a vault the product founds, filled by Photos'
//! own commands, and read through the same paged door a phone's core reads through.

#![allow(dead_code)]

use std::sync::Arc;

use centraid_apps_kit::testdoor::TestDoor;
use centraid_apps_photos::queries::{LibraryInput, load_library};
use centraid_vault::clock::{FixedClock, SeededIds};
use centraid_vault::commands::Registry;
use centraid_vault::{Command, CommandStatus, Principal, Vault};
use serde_json::json;

pub struct World {
    dir: std::path::PathBuf,
    pub vault: Vault,
    pub clock: Arc<FixedClock>,
    pub registry: Registry,
}

impl Drop for World {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl World {
    pub fn new() -> Self {
        let dir = centraid_ontology::scratch::scratch_dir();
        std::fs::create_dir_all(&dir).expect("a scratch directory");
        let clock = Arc::new(FixedClock::frozen());
        let vault = Vault::create_with(
            dir.join("vault.db"),
            Box::new(Arc::clone(&clock)),
            Box::new(SeededIds::new("photos")),
        )
        .expect("a vault");
        vault.found("Home", "Owner").expect("founded");
        Self {
            dir,
            vault,
            clock,
            registry: Registry::with_system_commands().expect("a registry"),
        }
    }

    pub fn ok(&self, name: &str, input: serde_json::Value) -> serde_json::Value {
        let outcome = self
            .vault
            .execute(
                &self.registry,
                &Principal::owner("phone"),
                &Command::new(name, input),
            )
            .expect("runs");
        assert_eq!(
            outcome.status,
            CommandStatus::Executed,
            "{name}: {:?}",
            outcome.reason
        );
        outcome.output
    }

    pub fn photo(&self, seed: &str, extra: serde_json::Value) -> String {
        let hash = centraid_vault::blob::content_digest(seed.as_bytes());
        self.ok("blob.stage", json!({ "hash": hash, "size": seed.len() }));
        let mut input = json!({ "blob": hash, "media_type": "image/jpeg", "form": "photo" });
        for (key, value) in extra.as_object().expect("an object") {
            input[key] = value.clone();
        }
        self.ok("photo.add", input)["id"]
            .as_str()
            .expect("an id")
            .to_owned()
    }

    pub fn album(&self, title: &str) -> String {
        self.ok(
            "container.create",
            json!({ "kind": "album", "title": title }),
        )["id"]
            .as_str()
            .expect("an id")
            .to_owned()
    }

    pub fn read<T>(&self, body: impl FnOnce(&TestDoor<'_>) -> T) -> T {
        self.vault
            .read(|c| Ok(body(&TestDoor::new(c))))
            .expect("a read")
    }

    pub fn library(&self) -> centraid_apps_photos::LibraryData {
        let now = centraid_vault::time::recurrence::parse_instant_ms("2026-01-02T00:00:00.000Z")
            .expect("an instant");
        self.read(|door| load_library(door, &LibraryInput::default(), now).expect("reads"))
    }
}
