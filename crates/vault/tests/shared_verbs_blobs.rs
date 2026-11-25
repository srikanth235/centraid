//! The shared verbs over bytes (`blob.*`, `derivative.*`, #1214 K10): staging, collecting what no
//! foreign key names, and one derivative per variant. Moved from the old `shared_verbs.rs`, which
//! kept every kind's helper; only what these three tests read is kept here.

mod common;

use centraid_vault::commands::Registry;
use centraid_vault::model::Kind;
use centraid_vault::{Command, CommandStatus, CommitTx, Principal, Vault};
use serde_json::json;

const AT: &str = "2026-03-01T09:00:00.000Z";

struct World {
    scratch: common::Scratch,
    registry: Registry,
}

impl World {
    fn new() -> Self {
        Self {
            scratch: common::Scratch::founded("verbs").expect("a vault"),
            registry: Registry::with_system_commands().expect("a registry"),
        }
    }

    fn vault(&self) -> &Vault {
        &self.scratch.vault
    }

    fn run(&self, name: &str, input: serde_json::Value) -> centraid_vault::CommandOutcome {
        self.scratch.clock.advance_ms(1_000);
        self.vault()
            .execute(
                &self.registry,
                &Principal::owner("phone"),
                &Command::new(name, input),
            )
            .unwrap_or_else(|error| panic!("`{name}`: {error}"))
    }

    fn ok(&self, name: &str, input: serde_json::Value) -> serde_json::Value {
        let outcome = self.run(name, input);
        assert_eq!(
            outcome.status,
            CommandStatus::Executed,
            "{name}: {:?}",
            outcome.reason
        );
        outcome.output
    }

    fn refused(&self, name: &str, input: serde_json::Value) -> String {
        let outcome = self.run(name, input);
        assert_eq!(
            outcome.status,
            CommandStatus::Failed,
            "{name} was not refused"
        );
        outcome.reason.expect("a sentence")
    }

    fn commit(&self, body: impl FnOnce(&CommitTx<'_>) -> centraid_vault::Result<()>) {
        self.vault()
            .commit(|tx| body(tx))
            .expect("the commit lands");
    }

    fn one<T: rusqlite::types::FromSql>(&self, sql: &str, params: &[&str]) -> T {
        self.vault()
            .read(|connection| {
                Ok(connection
                    .query_row(sql, rusqlite::params_from_iter(params), |row| row.get(0))?)
            })
            .unwrap_or_else(|error| panic!("{sql}: {error}"))
    }

    /// A document row as the documents lane will write it: the bytes are claimed, the entity and
    /// its kind row are inserted (the folder is the entity's `parent_id`, none here).
    fn document(&self, title: &str, bytes: &[u8]) -> (String, String) {
        let id = self.vault().ids().next();
        let id = id.as_str();
        let hash = centraid_vault::blob::content_digest(bytes);
        self.commit(|tx| {
            centraid_vault::blob::stage(tx.connection(), &hash, bytes.len() as i64)?;
            tx.insert_entity(id, Kind::Document, title, AT)?;
            tx.connection().execute(
                "INSERT INTO document (id, blob, media_type) VALUES (?1, ?2, 'text/plain')",
                rusqlite::params![id, hash],
            )?;
            Ok(())
        });
        (id.to_owned(), hash)
    }
}

#[test]
fn staging_bytes_is_idempotent_and_the_same_bytes_have_one_size() {
    let w = World::new();
    let hash = centraid_vault::blob::content_digest(b"hello");
    assert_eq!(
        w.ok("blob.stage", json!({"hash": &hash, "size": 5}))["added"],
        true
    );
    assert_eq!(
        w.ok("blob.stage", json!({"hash": &hash, "size": 5}))["added"],
        false
    );
    let error = w
        .vault()
        .execute(
            &w.registry,
            &Principal::owner("p"),
            &Command::new("blob.stage", json!({"hash": &hash, "size": 6})),
        )
        .expect_err("a different size");
    assert!(error.to_string().contains("already held at 5 bytes"));
}

#[test]
fn garbage_collection_takes_what_no_foreign_key_names_and_what_only_a_collected_blob_named() {
    let w = World::new();
    let (doc, kept) = w.document("Kept", b"kept");
    let orphan = centraid_vault::blob::content_digest(b"orphan");
    // A derivative of the orphan has bytes of its own; the orphan's collection
    // takes the derivative, and its bytes then have no claim either. Written
    // through the library, not the command: `derivative.write` collects, and
    // would take the orphan before this test asks.
    let thumb = centraid_vault::blob::content_digest(b"orphan thumb");
    w.commit(|tx| {
        centraid_vault::blob::stage(tx.connection(), &orphan, 6)?;
        centraid_vault::blob::write_derivative(
            tx.connection(),
            AT,
            &orphan,
            "thumb",
            Some((&thumb, 12, "image/jpeg")),
            None,
        )
    });
    let collected = w.ok("blob.collect", json!({}))["released"]
        .as_array()
        .expect("hashes")
        .clone();
    let mut collected: Vec<String> = collected
        .iter()
        .map(|hash| hash.as_str().expect("hash").to_owned())
        .collect();
    collected.sort();
    let mut expected = vec![orphan.clone(), thumb.clone()];
    expected.sort();
    assert_eq!(collected, expected);
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM blob", &[]), 1);
    // A derivative of the kept document keeps its own bytes alive only while it exists.
    let kept_thumb = centraid_vault::blob::content_digest(b"kept thumb");
    w.ok(
        "derivative.write",
        json!({"blob": &kept, "variant": "preview", "out": &kept_thumb, "out_size": 10, "media_type": "image/jpeg"}),
    );
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM blob", &[]),
        2,
        "the kept document's blob and its preview"
    );
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM derivative", &[]), 1);

    // Trash keeps the reference alive; a purge releases it.
    w.ok("entity.trash", json!({"id": &doc}));
    assert!(
        w.ok("blob.collect", json!({}))["released"]
            .as_array()
            .expect("hashes")
            .is_empty()
    );
    // The purge collects inside its own commit and says what it released.
    let purged = w.ok("entity.purge", json!({"id": &doc}));
    assert_eq!(purged["released"].as_array().expect("hashes").len(), 2);
    assert!(
        w.ok("blob.collect", json!({}))["released"]
            .as_array()
            .expect("hashes")
            .is_empty(),
        "nothing is left for a later sweep"
    );
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM blob", &[]), 0);
}

#[test]
fn a_derivative_is_one_row_per_variant_and_checks_its_own_shape() {
    let w = World::new();
    let (_, original) = w.document("Scan", b"scan");
    assert!(
        w.refused(
            "derivative.write",
            json!({"blob": &original, "variant": "thumb"})
        )
        .contains("needs its bytes")
    );
    assert!(
        w.refused(
            "derivative.write",
            json!({"blob": &original, "variant": "text"})
        )
        .contains("needs its value")
    );
    w.ok(
        "derivative.write",
        json!({"blob": &original, "variant": "text", "text": "first"}),
    );
    w.ok(
        "derivative.write",
        json!({"blob": &original, "variant": "text", "text": "second"}),
    );
    assert_eq!(
        w.one::<String>("SELECT text FROM derivative WHERE variant = 'text'", &[]),
        "second"
    );
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM derivative", &[]), 1);
    let missing = centraid_vault::blob::content_digest(b"never staged");
    assert!(
        w.vault()
            .execute(
                &w.registry,
                &Principal::owner("p"),
                &Command::new(
                    "derivative.write",
                    json!({"blob": &missing, "variant": "text", "text": "x"})
                ),
            )
            .is_err()
    );
    w.ok(
        "derivative.drop",
        json!({"blob": &original, "variant": "text"}),
    );
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM derivative", &[]), 0);
}
