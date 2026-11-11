//! Everything on the phone as one archive (#1185): `vault.export_all` streams a zip with one
//! folder per app, the text files are exactly what each app's own export saves, the originals
//! are byte for byte, Locker is not in it anywhere, and it writes nothing to the vault.

mod common;

use base64::Engine as _;
use centraid_vault::commands::Registry;
use centraid_vault::portable::zip::stored_entries;
use centraid_vault::{Command, CommandStatus, Principal};
use serde_json::{Value, json};

struct World {
    scratch: common::Scratch,
    registry: Registry,
}

impl World {
    fn new() -> Self {
        Self {
            scratch: common::Scratch::founded_with_blobs("export-all").expect("a vault"),
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

    fn id(&self, name: &str, input: Value) -> String {
        self.ok(name, input)["id"]
            .as_str()
            .expect("an id")
            .to_owned()
    }

    fn stage(&self, bytes: &[u8]) -> String {
        let hash = self
            .scratch
            .vault
            .blobs()
            .expect("a store")
            .put(bytes)
            .expect("stored");
        self.ok("blob.stage", json!({ "hash": hash, "size": bytes.len() }));
        hash
    }

    /// The bytes an app's own export command answered in `content`.
    fn content(&self, name: &str, input: Value) -> Vec<u8> {
        let out = self.ok(name, input);
        base64::engine::general_purpose::STANDARD
            .decode(out["content"].as_str().expect("content"))
            .expect("base64")
    }

    fn all(&self) -> (Value, Vec<(String, Vec<u8>)>) {
        let out = self.ok("vault.export_all", json!({}));
        let bytes = std::fs::read(out["path"].as_str().expect("a path")).expect("the staged file");
        (out, stored_entries(&bytes).expect("a zip"))
    }

    fn writes(&self) -> i64 {
        self.scratch
            .vault
            .read(|c| Ok(c.query_row("SELECT writes FROM vault", [], |r| r.get(0))?))
            .expect("a row")
    }
}

fn find<'a>(entries: &'a [(String, Vec<u8>)], name: &str) -> &'a [u8] {
    entries
        .iter()
        .find(|(each, _)| each == name)
        .unwrap_or_else(|| panic!("{name} is in the archive"))
        .1
        .as_slice()
}

fn has_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

/// A vault with something in every app, and a Locker item with distinctive secrets.
fn seeded() -> (World, Vec<u8>, Vec<u8>) {
    let w = World::new();
    let book = w.id(
        "container.create",
        json!({ "kind": "notebook", "title": "Ideas" }),
    );
    w.ok(
        "note.create",
        json!({ "title": "Boat", "body": "Plans for a boat #sea", "notebook_id": book }),
    );
    w.ok(
        "note.create",
        json!({ "title": "Loose", "body": "No book" }),
    );
    w.ok("person.add", json!({ "title": "Maya Rao" }));
    w.ok(
        "event.propose",
        json!({ "title": "Review", "starts": "2026-03-03T10:00" }),
    );
    w.ok(
        "task.add",
        json!({ "title": "Buy milk", "due": "2026-03-05" }),
    );
    let account = w.id(
        "account.add",
        json!({ "title": "Everyday", "type": "checking", "currency": "USD" }),
    );
    w.ok(
        "follow.statement",
        json!({
            "origin": { "ref": account, "label": "Bank", "fills": account },
            "records": [{
                "external_id": "t1",
                "fields": { "title": "Cafe", "posted_on": "2026-03-01",
                            "amount_minor": -450, "line": {} }
            }],
        }),
    );
    w.ok(
        "measurement.record",
        json!({ "days": [{ "day": "2026-03-01", "metric": "steps", "value": 7500 }] }),
    );

    let folder = w.id(
        "container.create",
        json!({ "kind": "folder", "title": "Taxes" }),
    );
    let pdf: Vec<u8> = (0..200_000_u32).map(|n| (n % 253) as u8).collect();
    let hash = w.stage(&pdf);
    w.ok(
        "document.add",
        json!({ "title": "Receipt.pdf", "blob": hash, "media_type": "application/pdf",
                "folder_id": folder }),
    );
    let jpg: Vec<u8> = (0..70_000_u32).map(|n| (n % 241) as u8).collect();
    let hash = w.stage(&jpg);
    w.ok(
        "photo.add",
        json!({ "blob": hash, "media_type": "image/jpeg",
                "taken_at": "2025-07-01T10:00:00.000Z", "offset_min": 0 }),
    );
    // A photograph whose bytes never arrived is counted, not written.
    let far = centraid_vault::blob::content_digest(b"far away");
    w.ok("blob.stage", json!({ "hash": far, "size": 8 }));
    w.ok(
        "photo.add",
        json!({ "blob": far, "media_type": "image/jpeg",
                "taken_at": "2025-07-02T10:00:00.000Z", "offset_min": 0 }),
    );

    w.ok(
        "locker.add_item",
        json!({ "item_id": "lk1", "type": "login", "title": "ZQXVAULTBANKZQX",
                "username": "ZQXUSERNAMEZQX", "alias": "ZQXALIASZQX",
                "notes": "ZQXNOTESZQX" }),
    );
    (w, pdf, jpg)
}

#[test]
fn every_app_has_its_folder_the_text_is_each_apps_own_export_and_the_originals_are_exact() {
    let (w, pdf, jpg) = seeded();
    let before = w.writes();
    let (out, entries) = w.all();
    assert_eq!(w.writes(), before, "an export writes nothing");

    assert_eq!(out["media_type"], "application/zip");
    assert!(
        out["name"]
            .as_str()
            .is_some_and(|name| name.starts_with("Centraid export ") && name.ends_with(".zip"))
    );
    assert_eq!(out["missing"], 1, "the photograph whose bytes are not here");

    let mut names: Vec<&str> = entries.iter().map(|(name, _)| name.as_str()).collect();
    names.sort_unstable();
    assert_eq!(
        names,
        vec![
            "Calendar/calendar.ics",
            "Docs/Taxes/Receipt.pdf",
            "Health/Daily totals.csv",
            "Health/Workouts.csv",
            "Money/transactions.csv",
            "Notes/Ideas/Boat.md",
            "Notes/Loose.md",
            "People/people.vcf",
            "Photos/2025/2025-07-01 100000.jpg",
            "README.txt",
            "Reminders/reminders.ics",
        ]
    );
    assert_eq!(out["count"], 10, "every file but the README");

    // The text files are what each app's own export saves, byte for byte.
    assert_eq!(
        find(&entries, "People/people.vcf"),
        w.content("person.export_vcf", json!({}))
    );
    assert_eq!(
        find(&entries, "Calendar/calendar.ics"),
        w.content("event.export_ics", json!({}))
    );
    assert_eq!(
        find(&entries, "Reminders/reminders.ics"),
        w.content("task.export_ics", json!({}))
    );
    assert_eq!(
        find(&entries, "Money/transactions.csv"),
        w.content("txn.export_csv", json!({}))
    );
    assert_eq!(
        find(&entries, "Health/Daily totals.csv"),
        w.content("health.export_csv", json!({ "what": "measurements" }))
    );
    assert_eq!(
        find(&entries, "Health/Workouts.csv"),
        w.content("health.export_csv", json!({ "what": "workouts" }))
    );
    let notes = stored_entries(&w.content("note.export", json!({}))).expect("a zip");
    assert_eq!(notes.len(), 2);
    for (path, bytes) in &notes {
        assert_eq!(find(&entries, &format!("Notes/{path}")), bytes.as_slice());
    }

    // The originals are exact.
    assert_eq!(find(&entries, "Docs/Taxes/Receipt.pdf"), pdf.as_slice());
    assert_eq!(
        find(&entries, "Photos/2025/2025-07-01 100000.jpg"),
        jpg.as_slice()
    );

    let readme = String::from_utf8_lossy(find(&entries, "README.txt")).into_owned();
    assert!(readme.contains("Locker is not here"));
}

#[test]
fn nothing_of_lockers_is_anywhere_in_the_archive() {
    let (w, _, _) = seeded();
    let (out, _) = w.all();
    let bytes = std::fs::read(out["path"].as_str().expect("a path")).expect("the file");
    for secret in [
        "ZQXVAULTBANKZQX",
        "ZQXUSERNAMEZQX",
        "ZQXALIASZQX",
        "ZQXNOTESZQX",
    ] {
        assert!(
            !has_bytes(&bytes, secret.as_bytes()),
            "{secret} is Locker's and must not leave in the whole-vault archive"
        );
    }
}

#[test]
fn an_empty_vault_still_makes_an_archive_and_a_second_export_replaces_the_first() {
    let w = World::new();
    let (first, entries) = w.all();
    assert_eq!(first["count"], 6);
    assert!(entries.iter().any(|(name, _)| name == "README.txt"));
    let (second, _) = w.all();
    assert_eq!(first["path"], second["path"]);
}
