//! Photos' originals as one archive (#1185): `photo.export_zip` streams every photograph and video
//! that is not in the trash into a zip named by when it was taken, byte for byte, leaves out what
//! is not on this phone, de-duplicates names, can be scoped to one album, and writes nothing to
//! the vault.

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

    /// A photograph whose bytes are in the store.
    fn photo(&self, bytes: &[u8], media_type: &str, extra: Value) -> String {
        let hash = self
            .scratch
            .vault
            .blobs()
            .expect("a store")
            .put(bytes)
            .expect("stored");
        self.ok("blob.stage", json!({ "hash": hash, "size": bytes.len() }));
        let mut input = json!({ "blob": hash, "media_type": media_type });
        for (key, value) in extra.as_object().expect("an object") {
            input[key] = value.clone();
        }
        self.id("photo.add", input)
    }

    fn zip(&self, input: Value) -> (Value, Vec<(String, Vec<u8>)>) {
        let out = self.ok("photo.export_zip", input);
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

fn taken(at: &str, offset: i64) -> Value {
    json!({ "taken_at": at, "offset_min": offset })
}

#[test]
fn the_archive_holds_every_original_byte_for_byte_named_by_when_it_was_taken() {
    let w = World::new();
    let big: Vec<u8> = (0..300_000_u32).map(|n| (n % 251) as u8).collect();
    w.photo(&big, "image/jpeg", taken("2025-07-01T10:00:00.000Z", 120));
    w.photo(
        b"film",
        "video/quicktime",
        taken("2024-12-31T23:30:00.000Z", 60),
    );
    w.photo(b"shot", "image/png", taken("2025-07-01T10:00:01.000Z", 0));

    let (out, entries) = w.zip(json!({}));
    assert_eq!(out["name"], "Photos.zip");
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
            // the clock where it was taken: 23:30 UTC at +01:00 is the next day
            ("2025/2025-01-01 003000.mov", &b"film"[..]),
            ("2025/2025-07-01 100001.png", &b"shot"[..]),
            ("2025/2025-07-01 120000.jpg", big.as_slice()),
        ]
    );
}

#[test]
fn the_trash_the_missing_the_undated_and_the_duplicates() {
    let w = World::new();
    let same = taken("2025-03-03T08:00:00.000Z", 0);
    w.photo(b"one", "image/jpeg", same.clone());
    w.photo(b"two", "image/jpeg", same.clone());
    w.photo(b"three", "image/jpeg", same);
    let gone = w.photo(b"gone", "image/jpeg", taken("2025-03-04T08:00:00.000Z", 0));
    w.ok("entity.trash", json!({ "id": gone }));
    let undated = w.photo(b"undated", "image/heic", json!({}));
    // A photograph whose bytes never arrived on this phone is counted, not written.
    let hash = centraid_vault::blob::content_digest(b"far away");
    w.ok("blob.stage", json!({ "hash": hash, "size": 8 }));
    w.ok(
        "photo.add",
        json!({ "blob": hash, "media_type": "image/jpeg" }),
    );

    let (out, entries) = w.zip(json!({}));
    assert_eq!(out["count"], 4);
    assert_eq!(out["missing"], 1);
    // The one that is not here is named, in the answer and in the archive.
    assert_eq!(out["left_out"].as_array().map(Vec::len), Some(1));
    assert_eq!(out["left_out"][0]["why"], "not on this phone");
    let left_name = out["left_out"][0]["name"].as_str().expect("a name");
    assert!(
        left_name.ends_with(".jpg") && left_name.contains('/'),
        "{left_name}"
    );
    let year = w
        .scratch
        .vault
        .read(|c| {
            Ok(c.query_row(
                "SELECT strftime('%Y-%m-%d %H%M%S', created_at) FROM entity WHERE id = ?1",
                [&undated],
                |r| r.get::<_, String>(0),
            )?)
        })
        .expect("a stamp");
    let mut listed = names(&entries);
    listed.sort_unstable();
    let imported = format!("{}/{year}.heic", &year[..4]);
    assert_eq!(
        listed,
        [
            "2025/2025-03-03 080000 2.jpg",
            "2025/2025-03-03 080000 3.jpg",
            "2025/2025-03-03 080000.jpg",
            imported.as_str(),
            "Left out.txt",
        ]
    );
    let note = entries
        .iter()
        .find(|(name, _)| name == "Left out.txt")
        .expect("the note of what was left out");
    assert_eq!(
        String::from_utf8_lossy(&note.1),
        format!(
            "These originals could not be included in this archive.\n\n{left_name} (not on this phone)\n"
        )
    );
    let first = entries
        .iter()
        .find(|(name, _)| name == "2025/2025-03-03 080000.jpg")
        .expect("first");
    assert_eq!(first.1, b"one");
}

#[test]
fn an_album_scope_holds_that_album_and_is_named_after_it() {
    let w = World::new();
    let album = w.id(
        "container.create",
        json!({ "kind": "album", "title": "Summer" }),
    );
    let inside = w.photo(b"in", "image/jpeg", taken("2025-07-01T10:00:00.000Z", 0));
    w.photo(b"out", "image/jpeg", taken("2025-07-02T10:00:00.000Z", 0));
    w.ok(
        "edge.add",
        json!({ "from": album, "rel": "contains", "to": inside }),
    );

    let (out, entries) = w.zip(json!({ "album_id": album }));
    assert_eq!(out["name"], "Summer.zip");
    assert_eq!(names(&entries), ["2025/2025-07-01 100000.jpg"]);
    assert_eq!(entries[0].1, b"in");
}

#[test]
fn it_writes_nothing_to_the_vault_and_replaces_the_last_staged_file() {
    let w = World::new();
    w.photo(b"a", "image/jpeg", taken("2025-07-01T10:00:00.000Z", 0));
    let before = w.commits();
    let (first, _) = w.zip(json!({}));
    let staged = std::path::PathBuf::from(first["path"].as_str().expect("a path"));
    let stray = staged.with_file_name("left-over.zip");
    std::fs::write(&stray, b"old plaintext").expect("a stray file");
    let (second, entries) = w.zip(json!({}));
    assert_eq!(second["path"], first["path"]);
    assert_eq!(names(&entries), ["2025/2025-07-01 100000.jpg"]);
    assert!(!stray.exists(), "an earlier file does not linger");
    assert_eq!(w.commits(), before);
}

#[test]
fn an_album_that_is_not_there_is_refused_in_words() {
    let w = World::new();
    let outcome = w.run("photo.export_zip", json!({ "album_id": "nope" }));
    assert_eq!(outcome.status, CommandStatus::Failed);
    assert!(outcome.reason.is_some_and(|reason| !reason.is_empty()));
}
