//! Docs' originals as one archive (#1185): `document.export_zip` streams every document that is
//! not in the trash into a zip under the folder structure the member sees, byte for byte, leaves
//! out what is not on this phone, de-duplicates names, and writes nothing to the vault.

mod common;

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
            scratch: common::Scratch::founded_with_blobs("export-zip").expect("a vault"),
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

    fn folder(&self, title: &str, parent: Option<&str>) -> String {
        self.id(
            "container.create",
            json!({ "kind": "folder", "title": title, "parent": parent }),
        )
    }

    /// A document whose bytes are in the store.
    fn document(&self, title: &str, bytes: &[u8], folder: Option<&str>) -> String {
        let hash = self
            .scratch
            .vault
            .blobs()
            .expect("a store")
            .put(bytes)
            .expect("stored");
        self.ok("blob.stage", json!({ "hash": hash, "size": bytes.len() }));
        self.id(
            "document.add",
            json!({ "title": title, "blob": hash, "media_type": "application/pdf",
                     "folder_id": folder }),
        )
    }

    fn zip(&self, input: Value) -> (Value, Vec<(String, Vec<u8>)>) {
        let out = self.ok("document.export_zip", input);
        let path = out["path"].as_str().expect("a path");
        let bytes = std::fs::read(path).expect("the staged file");
        (out.clone(), stored_entries(&bytes).expect("a zip"))
    }

    fn commits(&self) -> i64 {
        self.scratch
            .vault
            .read(|c| Ok(c.query_row("SELECT COUNT(*) FROM entity", [], |r| r.get(0))?))
            .expect("a count")
    }
}

fn names(entries: &[(String, Vec<u8>)]) -> Vec<&str> {
    entries.iter().map(|(name, _)| name.as_str()).collect()
}

#[test]
fn the_archive_holds_every_original_byte_for_byte_under_the_members_folders() {
    let w = World::new();
    let taxes = w.folder("Taxes", None);
    let year = w.folder("2026", Some(&taxes));
    let big: Vec<u8> = (0..300_000_u32).map(|n| (n % 251) as u8).collect();
    w.document("Receipt.pdf", &big, Some(&year));
    w.document("Lease.pdf", b"lease bytes", None);
    w.document("W2.pdf", b"", Some(&taxes));

    let (out, entries) = w.zip(json!({}));
    assert_eq!(out["name"], "Documents.zip");
    assert_eq!(out["media_type"], "application/zip");
    assert_eq!(
        (out["count"].as_u64(), out["missing"].as_u64()),
        (Some(3), Some(0))
    );
    let mut got: Vec<(&str, &[u8])> = entries
        .iter()
        .map(|(name, bytes)| (name.as_str(), bytes.as_slice()))
        .collect();
    got.sort_by_key(|(name, _)| *name);
    assert_eq!(
        got,
        vec![
            ("Lease.pdf", &b"lease bytes"[..]),
            ("Taxes/2026/Receipt.pdf", big.as_slice()),
            ("Taxes/W2.pdf", &b""[..]),
        ]
    );
}

#[test]
fn the_trash_the_missing_and_the_duplicates() {
    let w = World::new();
    w.document("Same.pdf", b"one", None);
    w.document("same.PDF", b"two", None);
    w.document("Same.pdf", b"three", None);
    let gone = w.document("Gone.pdf", b"gone", None);
    w.ok("entity.trash", json!({ "id": gone }));
    let folder = w.folder("Old", None);
    w.document("Inside.pdf", b"inside", Some(&folder));
    w.ok("entity.trash", json!({ "id": folder }));
    // A document whose bytes never arrived on this phone is counted, not written.
    let hash = centraid_vault::blob::content_digest(b"far away");
    w.ok("blob.stage", json!({ "hash": hash, "size": 8 }));
    w.ok(
        "document.add",
        json!({ "title": "Far.pdf", "blob": hash, "media_type": "application/pdf" }),
    );

    let (out, entries) = w.zip(json!({}));
    assert_eq!(out["count"], 3);
    assert_eq!(out["missing"], 1);
    assert_eq!(
        out["left_out"],
        json!([{ "name": "Far.pdf", "why": "not on this phone" }])
    );
    let mut listed = names(&entries);
    listed.sort_unstable();
    assert_eq!(
        listed,
        ["Left out.txt", "Same 3.pdf", "Same.pdf", "same 2.PDF"]
    );
    let note = entries
        .iter()
        .find(|(name, _)| name == "Left out.txt")
        .expect("the note of what was left out");
    assert_eq!(
        String::from_utf8_lossy(&note.1),
        "These originals could not be included in this archive.\n\nFar.pdf (not on this phone)\n"
    );
    let first = entries
        .iter()
        .find(|(name, _)| name == "Same.pdf")
        .expect("first");
    assert_eq!(first.1, b"one");
}

#[test]
fn an_archive_with_nothing_left_out_has_no_note_and_unsafe_titles_are_made_safe() {
    let w = World::new();
    w.document("a/b: c.pdf", b"one", None);
    w.document("CON.txt", b"two", None);
    let (out, entries) = w.zip(json!({}));
    assert_eq!(out["missing"], 0);
    assert_eq!(out["left_out"], json!([]));
    let mut listed = names(&entries);
    listed.sort_unstable();
    assert_eq!(listed, ["CON_.txt", "a-b- c.pdf"]);
}

#[test]
fn a_folder_scope_holds_that_folder_and_the_ones_below_it_relative_to_it() {
    let w = World::new();
    let taxes = w.folder("Taxes", None);
    let year = w.folder("2026", Some(&taxes));
    let other = w.folder("Other", None);
    w.document("In year.pdf", b"a", Some(&year));
    w.document("In taxes.pdf", b"b", Some(&taxes));
    w.document("Elsewhere.pdf", b"c", Some(&other));
    w.document("Top.pdf", b"d", None);

    let (out, entries) = w.zip(json!({ "folder_id": taxes }));
    assert_eq!(out["name"], "Taxes.zip");
    let mut listed = names(&entries);
    listed.sort_unstable();
    assert_eq!(listed, ["2026/In year.pdf", "In taxes.pdf"]);
}

#[test]
fn it_writes_nothing_to_the_vault_and_replaces_the_last_staged_file() {
    let w = World::new();
    w.document("A.pdf", b"a", None);
    let before = w.commits();
    let (first, _) = w.zip(json!({}));
    let staged = std::path::PathBuf::from(first["path"].as_str().expect("a path"));
    let stray = staged.with_file_name("left-over.zip");
    std::fs::write(&stray, b"old plaintext").expect("a stray file");
    let (second, entries) = w.zip(json!({}));
    assert_eq!(second["path"], first["path"]);
    assert_eq!(names(&entries), ["A.pdf"]);
    assert!(!stray.exists(), "an earlier file does not linger");
    assert_eq!(w.commits(), before);
}

#[test]
fn a_folder_that_is_not_there_is_refused_in_words() {
    let w = World::new();
    let outcome = w.run("document.export_zip", json!({ "folder_id": "nope" }));
    assert_eq!(outcome.status, CommandStatus::Failed);
    assert!(outcome.reason.is_some_and(|reason| !reason.is_empty()));
}
