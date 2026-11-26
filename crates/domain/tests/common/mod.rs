//! One founded vault in a scratch directory, and the doors the registry's tests read it through.
//! Each integration test is its own binary and compiles this whole module, so a helper one of
//! them does not use is dead in that binary and live in another.
#![allow(dead_code)]

use std::sync::Arc;

use centraid_domain::read::Reader;
use centraid_vault::clock::{FixedClock, SeededIds};
use centraid_vault::commands::Registry;
use centraid_vault::{Command, CommandOutcome, CommandStatus, Principal, Vault};
use serde_json::{Value, json};

pub struct World {
    dir: std::path::PathBuf,
    pub vault: Vault,
    pub registry: Registry,
    clock: Arc<FixedClock>,
}

impl World {
    pub fn new(seed: &str) -> Self {
        let dir = centraid_ontology::scratch::scratch_dir();
        std::fs::create_dir_all(&dir).expect("a scratch directory");
        let clock = Arc::new(FixedClock::frozen());
        let vault = Vault::create_with(
            dir.join("vault.db"),
            Box::new(Arc::clone(&clock)),
            Box::new(SeededIds::new(seed)),
        )
        .expect("a vault");
        vault.found("Test", "Test Owner").expect("founded");
        Self {
            dir,
            vault,
            registry: Registry::with_system_commands().expect("a registry"),
            clock,
        }
    }

    /// A read-only door onto this vault's file.
    pub fn reader(&self) -> Reader {
        Reader::open(self.vault.path()).expect("a read door")
    }

    pub fn run(&self, name: &str, input: Value) -> CommandOutcome {
        self.clock.advance_ms(1_000);
        self.vault
            .execute(
                &self.registry,
                &Principal::owner("phone"),
                &Command::new(name, input),
            )
            .unwrap_or_else(|error| panic!("`{name}`: {error}"))
    }

    pub fn ok(&self, name: &str, input: Value) -> Value {
        let outcome = self.run(name, input);
        assert_eq!(
            outcome.status,
            CommandStatus::Executed,
            "{name}: {:?}",
            outcome.reason
        );
        outcome.output
    }

    /// A new entity's id, from the command that made it.
    pub fn made(&self, name: &str, input: Value) -> String {
        let output = self.ok(name, input);
        output
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_else(|| panic!("`{name}` made no id: {output}"))
            .to_owned()
    }

    pub fn notebook(&self, title: &str) -> String {
        self.made(
            "container.create",
            json!({ "kind": "notebook", "title": title }),
        )
    }

    pub fn note(&self, title: &str, notebook: &str) -> String {
        self.made(
            "note.create",
            json!({ "title": title, "notebook_id": notebook }),
        )
    }
}

impl Drop for World {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}
