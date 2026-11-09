//! IN YOUR VAULT, through the graph (#1173, O1/O3): a document about a person, a payment
//! with them and a photograph of them are there beside events, tasks and notes; a void line
//! is not a payment; and a Locker item joined to them never is, whatever the door does.

use std::sync::Arc;

use centraid_apps_kit::testdoor::TestDoor;
use centraid_apps_people::person::load_person;
use centraid_vault::clock::{FixedClock, SeededIds};
use centraid_vault::commands::Registry;
use centraid_vault::{Command, CommandStatus, Principal, Vault};
use serde_json::json;

struct World {
    dir: std::path::PathBuf,
    vault: Vault,
    registry: Registry,
}

impl Drop for World {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl World {
    fn new() -> Self {
        let dir = centraid_ontology::scratch::scratch_dir();
        std::fs::create_dir_all(&dir).expect("a scratch directory");
        let file = dir.join("vault.db");
        let store = centraid_blobs::ByteStore::open(file.with_extension("bytes")).expect("bytes");
        let vault = Vault::create_with(
            file,
            Box::new(Arc::new(FixedClock::frozen())),
            Box::new(SeededIds::new("vault-links")),
        )
        .expect("a vault")
        .with_blobs(Box::new(centraid_blobs::ContentBytes::new(store)));
        vault.found("Home", "Owner").expect("founded");
        vault
            .commit(|tx| {
                tx.set_producer("test.fixture");
                centraid_apps_kit::fixtures::locker_key(tx.connection(), "k1").map_err(|error| {
                    centraid_vault::VaultError::Invariant {
                        context: error.to_string(),
                    }
                })
            })
            .expect("key");
        Self {
            dir,
            vault,
            registry: Registry::with_system_commands().expect("a registry"),
        }
    }

    fn ok(&self, name: &str, input: serde_json::Value) -> serde_json::Value {
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

    fn id(&self, name: &str, input: serde_json::Value) -> String {
        self.ok(name, input)["id"].as_str().unwrap().to_owned()
    }

    fn stage(&self, seed: &str) -> String {
        let hash = centraid_vault::blob::content_digest(seed.as_bytes());
        self.ok("blob.stage", json!({ "hash": hash, "size": seed.len() }));
        hash
    }
}

#[test]
fn documents_payments_and_photographs_of_a_person_are_in_their_vault_and_a_login_never_is() {
    let w = World::new();
    let maya = w.id("person.add", json!({ "title": "Maya" }));
    let doc = w.id(
        "document.add",
        json!({ "title": "Lease", "blob": w.stage("lease"), "media_type": "application/pdf" }),
    );
    let photo = w.id(
        "photo.add",
        json!({ "blob": w.stage("p"), "media_type": "image/jpeg" }),
    );
    let account = w.id(
        "account.add",
        json!({ "title": "Everyday", "type": "checking", "currency": "USD" }),
    );
    let lines: Vec<String> = ["csv:a", "csv:b"]
        .iter()
        .map(|external| {
            w.ok(
                "follow.statement",
                json!({
                    "origin": { "ref": account, "label": "Everyday", "fills": account },
                    "records": [{ "external_id": external, "fields": {
                        "title": format!("RENT {external}"), "posted_on": "2026-03-02",
                        "amount_minor": -450,
                        "line": { "memo": "m", "imported_from": "csv" } } }],
                }),
            );
            w.vault
                .read(|c| {
                    centraid_apps_kit::fixtures::followed_entity(c, external).map_err(|error| {
                        centraid_vault::VaultError::Invariant {
                            context: error.to_string(),
                        }
                    })
                })
                .expect("a line")
        })
        .collect();
    w.ok(
        "locker.add_item",
        json!({ "item_id": "lk1", "type": "login", "title": "Bank" }),
    );
    for (from, rel) in [
        (doc.as_str(), "about"),
        (lines[0].as_str(), "with"),
        (lines[1].as_str(), "with"),
        (photo.as_str(), "depicts"),
        ("lk1", "about"),
        ("lk1", "with"),
    ] {
        w.ok("edge.add", json!({ "from": from, "rel": rel, "to": maya }));
    }
    // A void line stays on the ledger and is not a payment.
    w.ok("txn.void", json!({ "id": lines[1] }));

    let sheet = w
        .vault
        .read(|c| Ok(load_person(&TestDoor::new(c), &maya).expect("reads")))
        .expect("a read")
        .0
        .person
        .expect("a sheet");
    assert!(
        sheet.touches.is_empty(),
        "a payment with someone is no touch: it is not in their log"
    );
    let mut seen: Vec<(String, String)> = sheet
        .vault
        .items
        .iter()
        .map(|item| (item.kind.key().to_owned(), item.id.clone()))
        .collect();
    seen.sort();
    let mut want = vec![
        ("document".to_owned(), doc),
        ("photo".to_owned(), photo),
        ("txn".to_owned(), lines[0].clone()),
    ];
    want.sort();
    assert_eq!(
        seen, want,
        "documents, a payment and a photograph; no void line, no login"
    );
}
