//! Every item that enters the vault by a path other than typing records where it came from
//! ([#1185](https://github.com/srikanth235/centraid/issues/1185)): one `origin` per
//! `(system, label)` and one `source` per item, through the one helper in
//! `commands/arrival.rs`. A typed item writes neither.

mod common;

use centraid_vault::commands::Registry;
use centraid_vault::{Command, CommandStatus, Principal};
use serde_json::{Value, json};

struct World {
    scratch: common::Scratch,
    registry: Registry,
}

impl World {
    fn new() -> Self {
        Self {
            scratch: common::Scratch::founded_with_blobs("arrival").expect("a vault"),
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

    /// The sentence a command is refused with, whether the schema or the handler said it.
    fn refused(&self, name: &str, input: Value) -> String {
        match self.scratch.vault.execute(
            &self.registry,
            &Principal::owner("phone"),
            &Command::new(name, input),
        ) {
            Ok(outcome) => {
                assert_eq!(outcome.status, CommandStatus::Failed, "{name} not refused");
                outcome.reason.expect("a sentence")
            }
            Err(error) => error.to_string(),
        }
    }

    fn count(&self, sql: &str, params: &[&str]) -> i64 {
        self.scratch
            .vault
            .read(|c| Ok(c.query_row(sql, rusqlite::params_from_iter(params), |r| r.get(0))?))
            .expect("a row")
    }

    /// `(origins, sources)` of one system.
    fn tally(&self, system: &str) -> (i64, i64) {
        (
            self.count("SELECT COUNT(*) FROM origin WHERE system = ?1", &[system]),
            self.count("SELECT COUNT(*) FROM source WHERE system = ?1", &[system]),
        )
    }

    fn bytes(&self, seed: &str) -> String {
        let hash = centraid_vault::blob::content_digest(seed.as_bytes());
        self.ok("blob.stage", json!({ "hash": hash, "size": seed.len() }));
        hash
    }

    fn source_of(&self, id: &str) -> (String, String, String) {
        self.scratch
            .vault
            .read(|c| {
                Ok(c.query_row(
                    "SELECT s.system, s.entity_kind, o.label FROM source s
                       JOIN origin o ON o.id = s.origin_id WHERE s.entity_id = ?1",
                    [id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )?)
            })
            .expect("one source")
    }
}

fn id(value: &Value) -> String {
    value["id"].as_str().expect("an id").to_owned()
}

#[test]
fn a_photo_from_the_camera_roll_or_the_picker_records_its_origin() {
    let w = World::new();
    let roll = |seed: &str| {
        json!({ "blob": w.bytes(seed), "media_type": "image/jpeg",
                "arrived_system": "camera_roll", "arrived_label": "Ada's iPhone" })
    };
    let (a, b) = (w.ok("photo.add", roll("a")), w.ok("photo.add", roll("b")));
    // Two photos, one origin (the device), one source each.
    assert_eq!(w.tally("camera_roll"), (1, 2));
    assert_eq!(
        w.source_of(&id(&a)),
        ("camera_roll".into(), "photo".into(), "Ada's iPhone".into())
    );
    assert_ne!(id(&a), id(&b));
    // The same bytes again are the same photograph: no second source.
    w.ok("photo.add", roll("a"));
    assert_eq!(w.tally("camera_roll"), (1, 2));
    // The picker is its own system.
    w.ok(
        "photo.add",
        json!({ "blob": w.bytes("c"), "media_type": "image/jpeg",
                "arrived_system": "picker", "arrived_label": "Photos picker" }),
    );
    assert_eq!(w.tally("picker"), (1, 1));
    // A typed (no `arrived`) photograph writes nothing.
    let typed = w.ok(
        "photo.add",
        json!({ "blob": w.bytes("d"), "media_type": "image/jpeg" }),
    );
    assert_eq!(
        w.count(
            "SELECT COUNT(*) FROM source WHERE entity_id = ?1",
            &[&id(&typed)]
        ),
        0
    );
    assert_eq!(w.count("SELECT COUNT(*) FROM origin", &[]), 2);
}

#[test]
fn a_vcard_import_records_one_origin_and_a_source_per_new_person() {
    let w = World::new();
    let file = "BEGIN:VCARD\nVERSION:3.0\nFN:Maya Rao\nTEL:+1 555 0100\nEND:VCARD\n\
                BEGIN:VCARD\nVERSION:3.0\nFN:Omar Haddad\nEND:VCARD\n";
    let arrived = ("vcard", "contacts.vcf");
    // A preview writes nothing.
    w.ok(
        "person.import_vcf",
        json!({ "cards": file, "dry_run": true, "arrived_system": arrived.0, "arrived_label": arrived.1 }),
    );
    assert_eq!(w.tally("vcard"), (0, 0));
    w.ok(
        "person.import_vcf",
        json!({ "cards": file, "arrived_system": arrived.0, "arrived_label": arrived.1 }),
    );
    assert_eq!(w.tally("vcard"), (1, 2));
    // Again: every card is the person the first made, so nothing new arrives.
    w.ok(
        "person.import_vcf",
        json!({ "cards": file, "arrived_system": arrived.0, "arrived_label": arrived.1 }),
    );
    assert_eq!(w.tally("vcard"), (1, 2));
    // Another file is another origin.
    w.ok(
        "person.import_vcf",
        json!({ "cards": "BEGIN:VCARD\nVERSION:3.0\nFN:Ines Costa\nEND:VCARD\n",
                "arrived_system": "vcard", "arrived_label": "folder/work.vcf" }),
    );
    assert_eq!(w.tally("vcard"), (2, 3));
    // Without `arrived` the cards are the member's own: no source.
    w.ok(
        "person.import_vcf",
        json!({ "cards": "BEGIN:VCARD\nVERSION:3.0\nFN:Typed Tim\nEND:VCARD\n" }),
    );
    assert_eq!(w.tally("vcard"), (2, 3));
}

#[test]
fn a_markdown_import_records_one_origin_and_a_source_per_note() {
    let w = World::new();
    let files = json!([
        { "path": "one.md", "text": "# One\nfirst" },
        { "path": "two.md", "text": "# Two\nsecond" }
    ])
    .to_string();
    let out = w.ok(
        "note.import",
        json!({ "files": files, "arrived_system": "markdown", "arrived_label": "Vault folder" }),
    );
    assert_eq!(out["notes"], 2);
    assert_eq!(w.tally("markdown"), (1, 2));
    let first = out["ids"][0].as_str().expect("an id");
    assert_eq!(w.source_of(first).1, "note");
    // Importing twice adds nothing, nor does a dry run.
    w.ok(
        "note.import",
        json!({ "files": files, "arrived_system": "markdown", "arrived_label": "Vault folder" }),
    );
    assert_eq!(w.tally("markdown"), (1, 2));
    w.ok(
        "note.import",
        json!({ "files": json!([{ "path": "x.md", "text": "# X\nx" }]).to_string() }),
    );
    assert_eq!(w.tally("markdown"), (1, 2));
}

#[test]
fn a_locker_csv_import_records_the_file_name_and_never_a_secret() {
    let w = World::new();
    let add = |item: &str, label: &str| {
        w.ok(
            "locker.add_item",
            json!({ "item_id": item, "type": "login", "title": item,
                    "arrived_system": "csv", "arrived_label": label }),
        )
    };
    add("item-1", "C:\\Users\\ada\\Downloads\\passwords.csv");
    add("item-2", "passwords.csv");
    // The label is the file's own name, never its path.
    assert_eq!(w.tally("csv"), (1, 2));
    assert_eq!(w.source_of("item-1").2, "passwords.csv");
    // A typed item has no source.
    w.ok(
        "locker.add_item",
        json!({ "item_id": "item-3", "type": "login", "title": "typed" }),
    );
    assert_eq!(w.tally("csv"), (1, 2));
}

#[test]
fn a_scan_or_an_upload_records_its_origin() {
    let w = World::new();
    let add = |seed: &str, system: &str, label: &str| {
        w.ok(
            "document.add",
            json!({ "title": seed, "blob": w.bytes(seed), "media_type": "application/pdf",
                    "arrived_system": system, "arrived_label": label }),
        )
    };
    add("receipt", "scan", "Scanner");
    add("lease", "scan", "Scanner");
    add("tax", "upload", "tax.pdf");
    assert_eq!(w.tally("scan"), (1, 2));
    assert_eq!(w.tally("upload"), (1, 1));
    let typed = w.ok(
        "document.add",
        json!({ "title": "typed", "blob": w.bytes("typed"), "media_type": "application/pdf" }),
    );
    assert_eq!(
        w.count(
            "SELECT COUNT(*) FROM source WHERE entity_id = ?1",
            &[&id(&typed)]
        ),
        0
    );
}

#[test]
fn a_reminders_import_records_its_origin_and_a_typed_task_none() {
    let w = World::new();
    let arrived = ("phone_reminders", "Reminders on this phone");
    for title in ["Call the plumber", "Renew passport"] {
        w.ok(
            "task.add",
            json!({ "title": title, "arrived_system": arrived.0, "arrived_label": arrived.1 }),
        );
    }
    assert_eq!(w.tally("phone_reminders"), (1, 2));
    w.ok("task.add", json!({ "title": "Typed" }));
    assert_eq!(w.tally("phone_reminders"), (1, 2));
    assert_eq!(w.count("SELECT COUNT(*) FROM task", &[]), 3);
}

#[test]
fn a_system_that_does_not_bring_in_the_kind_is_refused_and_writes_nothing() {
    let w = World::new();
    let sentence = w.refused(
        "task.add",
        json!({ "title": "x", "arrived_system": "vcard", "arrived_label": "a.vcf" }),
    );
    assert!(sentence.contains("does not bring in"), "{sentence}");
    assert_eq!(w.count("SELECT COUNT(*) FROM task", &[]), 0);
    assert_eq!(w.count("SELECT COUNT(*) FROM origin", &[]), 0);
    // A label with no system, and a system with no label, are half an arrival.
    w.refused(
        "task.add",
        json!({ "title": "x", "arrived_label": "a.vcf" }),
    );
    w.refused(
        "task.add",
        json!({ "title": "x", "arrived_system": "phone_reminders" }),
    );
    assert_eq!(w.count("SELECT COUNT(*) FROM task", &[]), 0);
    // A closed set: a made-up system never reaches the vault.
    w.refused(
        "task.add",
        json!({ "title": "x", "arrived_system": "telepathy", "arrived_label": "a" }),
    );
}

#[test]
fn a_followed_store_that_finds_an_arrived_person_takes_the_row_over() {
    let w = World::new();
    let made = w.ok(
        "person.import_vcf",
        json!({ "cards": "BEGIN:VCARD\nVERSION:3.0\nFN:Maya Rao\nEND:VCARD\n",
                "arrived_system": "vcard", "arrived_label": "contacts.vcf" }),
    );
    assert_eq!(made["added"], 1);
    w.ok(
        "follow.contacts",
        json!({
            "origin": { "ref": "phone", "label": "Phone" },
            "complete": true,
            "records": [{ "external_id": "c1", "fields": { "title": "Maya Rao" } }]
        }),
    );
    // One person, now followed by the phone's contacts and no longer "from a file".
    assert_eq!(
        w.count(
            "SELECT COUNT(*) FROM person p JOIN entity e ON e.id = p.id WHERE e.title = 'Maya Rao'",
            &[]
        ),
        1
    );
    assert_eq!(
        w.count(
            "SELECT COUNT(*) FROM source WHERE system = 'vcard' AND entity_id IS NOT NULL",
            &[]
        ),
        0
    );
    assert_eq!(
        w.count("SELECT COUNT(*) FROM source WHERE system = 'contacts'", &[]),
        1
    );
}

#[test]
fn where_an_item_came_from_reads_back_for_every_system_and_is_none_for_typed() {
    let w = World::new();
    let read = |id: &str| {
        w.scratch
            .vault
            .read(|c| centraid_vault::commands::arrival::origin_of(c, id))
            .expect("a read")
    };
    let photo = |seed: &str, system: &str, label: &str| {
        id(&w.ok(
            "photo.add",
            json!({ "blob": w.bytes(seed), "media_type": "image/jpeg",
                    "arrived_system": system, "arrived_label": label }),
        ))
    };
    let roll = photo("a", "camera_roll", "Camera roll");
    let picked = photo("b", "picker", "IMG_1.jpg");
    assert_eq!(
        read(&roll),
        Some(("camera_roll".into(), "Camera roll".into()))
    );
    assert_eq!(read(&picked), Some(("picker".into(), "IMG_1.jpg".into())));
    let doc = id(&w.ok(
        "document.add",
        json!({ "title": "t", "blob": w.bytes("d"), "media_type": "application/pdf",
                "arrived_system": "scan", "arrived_label": "Scanned document" }),
    ));
    assert_eq!(read(&doc).map(|found| found.0), Some("scan".to_owned()));
    let task = id(&w.ok(
        "task.add",
        json!({ "title": "x", "arrived_system": "phone_reminders", "arrived_label": "Groceries" }),
    ));
    assert_eq!(
        read(&task),
        Some(("phone_reminders".into(), "Groceries".into()))
    );
    let note = w.ok(
        "note.import",
        json!({ "files": json!([{ "path": "a.md", "text": "# A\nx" }]).to_string(),
                "arrived_system": "markdown", "arrived_label": "Vault" }),
    );
    assert_eq!(
        read(note["ids"][0].as_str().expect("an id")).map(|found| found.1),
        Some("Vault".to_owned())
    );
    // A followed store's row says its store, the same way.
    w.ok(
        "follow.contacts",
        json!({ "origin": { "ref": "phone", "label": "iCloud" }, "complete": true,
                "records": [{ "external_id": "c1", "fields": { "title": "Maya Rao" } }] }),
    );
    let followed: String = w
        .scratch
        .vault
        .read(|c| {
            Ok(
                c.query_row("SELECT id FROM entity WHERE title = 'Maya Rao'", [], |r| {
                    r.get(0)
                })?,
            )
        })
        .expect("a row");
    assert_eq!(read(&followed), Some(("contacts".into(), "iCloud".into())));
    // Typed: nothing.
    let typed = id(&w.ok("task.add", json!({ "title": "typed" })));
    assert_eq!(read(&typed), None);
}
