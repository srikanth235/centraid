//! Everything on the phone as one archive (#1185): `vault.export_all` streams a zip with one
//! folder per app, ordinary app-export text is exact, My card is included (a journal entry is a
//! note, so it is under `Notes/`), originals are byte for byte, Locker is not in it anywhere (and
//! the export reads no Locker table), and it writes nothing to the vault.

mod common;

use base64::Engine as _;
use centraid_vault::portable::zip::stored_entries;
use centraid_vault::{Command, CommandStatus, Principal};
use serde_json::{Value, json};

use common::locker;

/// The shared world (with a content store), and the verbs this file leans on.
struct World {
    inner: common::world::World,
}

impl std::ops::Deref for World {
    type Target = common::world::World;
    fn deref(&self) -> &Self::Target {
        &self.inner
    }
}

impl World {
    fn new() -> Self {
        Self {
            inner: locker::world("export-all"),
        }
    }

    fn world(&self) -> &common::world::World {
        &self.inner
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
    w.ok(
        "note.create",
        json!({ "title": "Grateful", "body": "A quiet day by the sea.", "journal_on": "2026-03-04" }),
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
        "txn.add",
        json!({ "account_id": account, "posted_on": "2026-03-01", "amount_minor": -450, "title": "Cafe" }),
    );
    w.ok(
        "measurement.log",
        json!({ "day": "2026-03-01", "metric": "steps", "value": 7500 }),
    );
    w.ok(
        "workout.log",
        json!({ "type": "run", "starts": "2026-03-04", "moving_s": 1_800 }),
    );
    w.ok(
        "reading.add",
        json!({ "metric": "weight_kg", "at": "2026-03-04T07:00:00Z", "value": 72.4 }),
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

    let item = locker::item_id(w.world());
    locker::add(
        w.world(),
        &item,
        "login",
        "ZQXVAULTBANKZQX",
        vec![
            locker::plain("username", "ZQXUSERNAMEZQX"),
            locker::plain("notes", "ZQXNOTESZQX"),
        ],
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
    assert_eq!(
        out["left_out"],
        json!([{ "name": "Photos/2025/2025-07-02 100000.jpg", "why": "not on this phone" }]),
        "and it is named"
    );

    let mut names: Vec<&str> = entries.iter().map(|(name, _)| name.as_str()).collect();
    names.sort_unstable();
    assert_eq!(
        names,
        vec![
            "Calendar/calendar.ics",
            "Docs/Taxes/Receipt.pdf",
            "Health/Daily totals.csv",
            "Health/Readings.csv",
            "Health/Workouts.csv",
            "Left out.txt",
            "Money/transactions.csv",
            "Notes/Grateful.md",
            "Notes/Ideas/Boat.md",
            "Notes/Loose.md",
            "People/people.vcf",
            "Photos/2025/2025-07-01 100000.jpg",
            "README.txt",
            "Reminders/reminders.ics",
        ]
    );
    assert_eq!(
        out["count"], 12,
        "every file but the README and the left-out note"
    );

    // The journal entry is a note: its words and its day are in the Markdown.
    assert!(has_bytes(
        find(&entries, "Notes/Grateful.md"),
        b"A quiet day by the sea."
    ));
    assert!(has_bytes(
        find(&entries, "Notes/Grateful.md"),
        b"2026-03-04"
    ));

    // The text files are what each app's own export saves, byte for byte.
    let per_app_people = w.content("person.export_vcf", json!({}));
    let self_name: String = w
        .scratch
        .vault
        .read(|connection| {
            Ok(connection.query_row(
                "SELECT e.title FROM entity e WHERE e.id = (SELECT self_id FROM vault)",
                [],
                |row| row.get(0),
            )?)
        })
        .expect("the member's card");
    assert!(has_bytes(
        find(&entries, "People/people.vcf"),
        self_name.as_bytes()
    ));
    let cards = |bytes: &[u8]| {
        bytes
            .windows(b"BEGIN:VCARD".len())
            .filter(|window| *window == b"BEGIN:VCARD")
            .count()
    };
    assert_eq!(
        cards(find(&entries, "People/people.vcf")),
        cards(&per_app_people) + 1,
        "the aggregate holds the same cards plus My card"
    );
    assert!(
        !has_bytes(&per_app_people, self_name.as_bytes()),
        "the standalone People export keeps its existing self-card exclusion"
    );
    for (path, command, input) in [
        ("Calendar/calendar.ics", "event.export_ics", json!({})),
        ("Reminders/reminders.ics", "task.export_ics", json!({})),
        ("Money/transactions.csv", "txn.export_csv", json!({})),
        (
            "Health/Daily totals.csv",
            "health.export_csv",
            json!({ "what": "measurements" }),
        ),
        (
            "Health/Workouts.csv",
            "health.export_csv",
            json!({ "what": "workouts" }),
        ),
        (
            "Health/Readings.csv",
            "health.export_csv",
            json!({ "what": "readings" }),
        ),
    ] {
        assert_eq!(
            find(&entries, path),
            w.content(command, input),
            "{path} is `{command}`'s own file"
        );
    }
    let notes = stored_entries(&w.content("note.export", json!({}))).expect("a zip");
    assert_eq!(notes.len(), 3);
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
    assert!(readme.contains("Left out.txt"));
    assert_eq!(
        String::from_utf8_lossy(find(&entries, "Left out.txt")),
        "These originals could not be included in this archive.\n\nPhotos/2025/2025-07-02 100000.jpg (not on this phone)\n"
    );
}

#[test]
fn nothing_of_lockers_is_anywhere_in_the_archive() {
    let (w, _, _) = seeded();
    let (out, _) = w.all();
    let bytes = std::fs::read(out["path"].as_str().expect("a path")).expect("the file");
    for secret in ["ZQXVAULTBANKZQX", "ZQXUSERNAMEZQX", "ZQXNOTESZQX"] {
        assert!(
            !has_bytes(&bytes, secret.as_bytes()),
            "{secret} is Locker's and must not leave in the whole-vault archive"
        );
    }
}

/// The proof that Locker is not in it is not only that its words are absent: the export never
/// reads a Locker table. SQLite names every table a statement reads at prepare, so the
/// authorizer sees each one; the snapshot is taken on a read-only connection under it.
#[test]
fn the_export_reads_no_locker_table() {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
    use std::sync::{Arc, Mutex};

    let (w, _, _) = seeded();
    let locker_tables: Vec<String> = w
        .scratch
        .vault
        .read(|c| {
            let mut statement = c.prepare(
                "SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'locker\\_%' ESCAPE '\\'",
            )?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .expect("the tables");
    assert!(
        locker_tables.len() >= 4,
        "the Locker tables exist to be left alone: {locker_tables:?}"
    );

    let read = Arc::new(Mutex::new(Vec::<String>::new()));
    let mut connection = rusqlite::Connection::open_with_flags(
        w.scratch.vault.path(),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .expect("a second reader");
    let seen = Arc::clone(&read);
    connection
        .authorizer(Some(move |context: AuthContext<'_>| {
            if let AuthAction::Read { table_name, .. } = context.action {
                seen.lock().expect("a list").push(table_name.to_owned());
            }
            Authorization::Allow
        }))
        .expect("the authorizer");
    let snapshot = centraid_vault::commands::vault_export::VaultExportSnapshot::capture(
        &connection,
        w.scratch.vault.blobs().expect("a store"),
    )
    .expect("the snapshot");
    drop(snapshot);
    let read = read.lock().expect("a list").clone();
    assert!(
        read.iter().any(|table| table == "entity"),
        "the authorizer saw the export's reads: {read:?}"
    );
    for table in &locker_tables {
        assert!(
            !read.contains(table),
            "`{table}` is Locker's and the export must not read it"
        );
    }
}

#[test]
fn an_empty_vault_still_makes_an_archive_and_a_second_export_replaces_the_first() {
    let w = World::new();
    let (first, entries) = w.all();
    assert_eq!(first["count"], 7);
    assert!(entries.iter().any(|(name, _)| name == "README.txt"));
    let (second, _) = w.all();
    assert_eq!(first["path"], second["path"]);
}

impl World {
    fn note_with_asset(&self, title: &str, name: &str, bytes: &[u8]) -> (String, String) {
        let id = self.id(
            "note.create",
            json!({ "title": title, "body": "see the picture" }),
        );
        let hash = self.stage(bytes);
        self.ok(
            "note.asset_add",
            json!({ "id": id, "blob": hash, "name": name, "media_type": "image/png" }),
        );
        (id, hash)
    }
}

#[test]
fn a_notes_image_is_in_the_archive_beside_it_byte_for_byte() {
    let w = World::new();
    let picture: Vec<u8> = (0..150_000_u32).map(|n| (n % 247) as u8).collect();
    w.note_with_asset("Trip", "view.png", &picture);
    let (out, entries) = w.all();
    assert_eq!(out["missing"], 0);
    assert!(entries.iter().any(|(name, _)| name == "Notes/Trip.md"));
    assert_eq!(find(&entries, "Notes/Trip.assets/view.png"), picture);
}

#[test]
fn two_notes_with_one_title_keep_their_images_apart() {
    let w = World::new();
    w.note_with_asset("Same", "a.png", b"first picture");
    w.note_with_asset("Same", "a.png", b"second picture");
    let (_, entries) = w.all();
    assert_eq!(find(&entries, "Notes/Same.assets/a.png"), b"first picture");
    assert_eq!(
        find(&entries, "Notes/Same 2.assets/a.png"),
        b"second picture"
    );
}

#[test]
fn a_notes_image_whose_bytes_are_gone_is_named_not_dropped() {
    let w = World::new();
    let (_, hash) = w.note_with_asset("Trip", "view.png", b"lost picture");
    w.scratch
        .vault
        .blobs()
        .expect("a store")
        .remove(&hash)
        .expect("removed");
    let (out, entries) = w.all();
    assert_eq!(out["missing"], 1);
    assert_eq!(
        out["left_out"],
        json!([{ "name": "Notes/Trip.assets/view.png", "why": "not on this phone" }])
    );
    assert!(
        entries
            .iter()
            .all(|(name, _)| name != "Notes/Trip.assets/view.png")
    );
    assert!(has_bytes(
        find(&entries, "Left out.txt"),
        b"Notes/Trip.assets/view.png"
    ));
}
