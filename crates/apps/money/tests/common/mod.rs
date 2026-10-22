//! A founded vault in a scratch directory and the commands that fill it, for the
//! suites that read Money back through the paged door a phone's core asks through.

#![allow(dead_code)]

use std::sync::Arc;

use centraid_vault::clock::{FixedClock, SeededIds};
use centraid_vault::commands::Registry;
use centraid_vault::{Command, CommandStatus, Principal, Vault};
use serde_json::{Value, json};

pub struct World {
    pub dir: std::path::PathBuf,
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
    pub fn founded(seed: &str) -> Self {
        let dir = centraid_ontology::scratch::scratch_dir();
        std::fs::create_dir_all(&dir).expect("a scratch directory");
        let clock = Arc::new(FixedClock::frozen());
        let vault = Vault::create_with(
            dir.join("vault.db"),
            Box::new(Arc::clone(&clock)),
            Box::new(SeededIds::new(seed)),
        )
        .expect("a vault is created");
        vault.found("Test", "Priya").expect("it is founded");
        Self {
            dir,
            vault,
            clock,
            registry: Registry::with_system_commands().expect("the registry builds"),
        }
    }

    /// Run a command; panics with the refusal's sentence if it does not execute.
    pub fn ok(&self, name: &str, input: Value) -> Value {
        let outcome = self
            .vault
            .execute(
                &self.registry,
                &Principal::owner("phone"),
                &Command::new(name, input),
            )
            .unwrap_or_else(|error| panic!("`{name}`: {error}"));
        assert_eq!(
            outcome.status,
            CommandStatus::Executed,
            "{name}: {:?}",
            outcome.reason
        );
        outcome.output
    }

    pub fn account(&self, id: &str, title: &str, kind: &str, currency: &str) {
        self.ok(
            "account.add",
            json!({ "id": id, "title": title, "type": kind, "currency": currency }),
        );
    }

    /// Lines of a statement, signed (money out negative), as the account's origin
    /// follows them: `(external id, day, amount, the bank's words)`.
    pub fn import(&self, account: &str, lines: &[(&str, &str, i64, &str)]) -> Value {
        let records: Vec<Value> = lines
            .iter()
            .map(|(external, day, amount, words)| {
                json!({
                    "external_id": external,
                    "fields": {
                        "title": words,
                        "posted_on": day,
                        "amount_minor": amount,
                        "line": { "memo": "m", "imported_from": "csv" },
                    }
                })
            })
            .collect();
        self.ok(
            "follow.statement",
            json!({
                "origin": { "ref": account, "label": "Statement", "fills": account },
                "records": records,
            }),
        )
    }

    /// The id the vault minted for a followed line.
    pub fn line(&self, external: &str) -> String {
        self.vault
            .read(|connection| {
                let door = centraid_apps_kit::testdoor::TestDoor::new(connection);
                let row = centraid_apps_kit::reads::read_by_id(
                    &door,
                    "money.test.line",
                    "entity_id, external_id",
                    "source",
                    "external_id",
                    external,
                )
                .expect("the door answers");
                Ok(row.and_then(|row| centraid_apps_kit::row::text_of(&row, "entity_id")))
            })
            .expect("reads")
            .expect("a followed line")
    }
}
