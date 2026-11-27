//! The device store (app-plane §10): the key registry, drafts, the deep link and the share-in
//! inbox. The inbox drains against a recording filer, so its mapping and idempotence are the
//! drain's own and no vault is needed.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use centraid_core::device::inbox::{self, Fate, Filer, Route};
use centraid_core::device::open_url::{self, Refused};
use centraid_core::device::registry::{self, DEVICE_KEYS, KeyError};
use centraid_core::device::{Checked, Drafts, MemoryStore};
use serde_json::{Value, json};

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn walk(dir: &Path, found: &mut Vec<PathBuf>, ext: &[&str]) {
    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in read.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if !matches!(
                entry.file_name().to_str(),
                Some("target" | "build" | ".gradle" | "node_modules")
            ) {
                walk(&path, found, ext);
            }
        } else if path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| ext.contains(&e))
        {
            found.push(path);
        }
    }
}

fn quoted(line: &str) -> Option<&str> {
    let start = line.find('"')? + 1;
    let end = line[start..].find('"')? + start;
    Some(&line[start..end])
}

#[test]
fn every_key_is_listed_once() {
    let mut seen = BTreeSet::new();
    for decl in DEVICE_KEYS {
        assert!(
            seen.insert((decl.name, decl.prefix)),
            "{} is listed twice",
            decl.name
        );
        assert!(
            matches!(
                decl.d,
                "D1" | "D2" | "D3" | "D4" | "D6" | "D7" | "D8" | "D9" | "D10" | "D11" | "D12" | "D13"
            ),
            "{} names no device-store row",
            decl.name
        );
    }
}

#[test]
fn an_unlisted_key_and_a_json_value_without_v_are_refused() {
    assert_eq!(
        registry::check("mystery", "x"),
        Err(KeyError::Unlisted("mystery".into()))
    );
    assert_eq!(
        registry::check("draft.v1.note", "not json"),
        Err(KeyError::NotJson("draft.v1.note".into()))
    );
    assert_eq!(
        registry::check("draft.v1.note", r#"{"kind":"note"}"#),
        Err(KeyError::Version("draft.v1.note".into()))
    );
    assert_eq!(
        registry::check("draft.v1.note", r#"{"v":2}"#),
        Err(KeyError::Version("draft.v1.note".into()))
    );
    assert!(registry::check("draft.v1.note", r#"{"v":1}"#).is_ok());
    assert!(registry::check("recovery-seed", "abcd").is_ok());
    let store = Checked::new(MemoryStore::default());
    assert!(store.put("mystery", "x").is_err());
    assert!(store.put("view.v1.calendar", r#"{"lens":"week"}"#).is_err());
    assert!(
        store
            .put("view.v1.calendar", r#"{"v":1,"lens":"week"}"#)
            .is_ok()
    );
}

#[test]
fn every_key_the_rust_side_names_is_in_the_registry() {
    let mut files = Vec::new();
    walk(&root().join("crates/screens/src"), &mut files, &["rs"]);
    walk(&root().join("crates/core/src"), &mut files, &["rs"]);
    let mut checked = 0;
    for file in files {
        let rel = file
            .strip_prefix(root())
            .unwrap()
            .to_string_lossy()
            .into_owned();
        if rel.contains("/strings/") || rel.ends_with("registry.rs") {
            continue;
        }
        let text = std::fs::read_to_string(&file).unwrap();
        for line in text.lines() {
            let line = line.trim();
            let Some(rest) = line
                .strip_prefix("pub const ")
                .or_else(|| line.strip_prefix("pub(crate) const "))
                .or_else(|| line.strip_prefix("const "))
            else {
                continue;
            };
            let Some((name, value)) = rest.split_once(": &str = ") else {
                continue;
            };
            let in_secrets = rel.ends_with("custody/secrets.rs") && line.starts_with("pub const ");
            let is_key = name.ends_with("_KEY") || name == "KEY" || in_secrets;
            if !is_key {
                continue;
            }
            let value = quoted(value).unwrap_or_else(|| panic!("{rel}: {line}"));
            let probe = if name.ends_with("PREFIX") {
                format!("{value}x")
            } else {
                value.to_owned()
            };
            assert!(
                registry::find(&probe).is_some(),
                "{rel}: `{name}` = \"{value}\" is not in the device-key registry"
            );
            checked += 1;
        }
    }
    assert!(checked >= 20, "the scan found only {checked} keys");
}

#[test]
fn every_store_the_shells_name_is_in_the_registry() {
    let mut files = Vec::new();
    walk(&root().join("mobile"), &mut files, &["kt", "swift"]);
    let mut checked = 0;
    for file in files {
        let text = std::fs::read_to_string(&file).unwrap_or_default();
        for line in text.lines() {
            let marker = line.contains("FILE") || line.contains("PREFS") || line.contains("Key =");
            if !marker {
                continue;
            }
            if let Some(name) = quoted(line).filter(|name| name.starts_with("centraid.")) {
                assert!(
                    registry::find(name).is_some(),
                    "{}: shell store `{name}` is not in the device-key registry",
                    file.display()
                );
                checked += 1;
            }
        }
    }
    assert!(checked >= 4, "the scan found only {checked} stores");
}

#[test]
fn a_draft_is_one_record_per_vault_and_kind_and_never_locker() {
    let store = Checked::new(MemoryStore::default());
    let drafts = Drafts::new(&store, "v1");
    let mut fields = serde_json::Map::new();
    fields.insert("title".into(), json!("Bread"));
    drafts.keep("note", fields.clone(), 10).unwrap();
    fields.insert("title".into(), json!("Bread and butter"));
    drafts.keep("note", fields, 20).unwrap();
    let draft = drafts.load("note").unwrap().unwrap();
    assert_eq!(draft.fields["title"], "Bread and butter");
    assert_eq!(draft.saved_at, 20);
    assert!(
        drafts
            .keep("locker_item", serde_json::Map::new(), 1)
            .is_err()
    );
    assert!(drafts.load("locker_item").unwrap().is_none());
    let raw = store.get("draft.v1.note").unwrap().unwrap();
    let value: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(value["v"], 1);
    assert_eq!(value["kind"], "note");
}

#[test]
fn a_draft_goes_on_save_on_a_confirmed_discard_and_on_a_vault_switch() {
    let store = Checked::new(MemoryStore::default());
    let one = Drafts::new(&store, "v1");
    let two = Drafts::new(&store, "v2");
    for kind in ["note", "task", "txn"] {
        one.keep(kind, serde_json::Map::new(), 1).unwrap();
    }
    two.keep("note", serde_json::Map::new(), 1).unwrap();
    one.saved("note").unwrap();
    assert!(one.load("note").unwrap().is_none());
    one.discarded("task").unwrap();
    assert!(one.load("task").unwrap().is_none());
    assert!(one.load("txn").unwrap().is_some());
    assert_eq!(one.left_vault().unwrap(), 1);
    assert!(one.load("txn").unwrap().is_none());
    assert!(
        two.load("note").unwrap().is_some(),
        "another vault's draft stays"
    );
}

#[test]
fn a_link_names_a_kind_and_an_id_and_nothing_else() {
    let open =
        open_url::parse("centraid://open/event/0192f0a0-0000-7000-8000-000000000001").unwrap();
    assert_eq!((open.kind.as_str(), open.app), ("event", "calendar"));
    assert_eq!(
        open.room_key(),
        "event/0192f0a0-0000-7000-8000-000000000001"
    );
    assert_eq!(open_url::parse(&open.url()).unwrap(), open);
    assert_eq!(open_url::parse("https://x"), Err(Refused::NotOurs));
    assert_eq!(
        open_url::parse("centraid://share/note/x"),
        Err(Refused::NotOpen)
    );
    assert_eq!(
        open_url::parse("centraid://open/nonsense/x"),
        Err(Refused::UnknownKind("nonsense".into()))
    );
    assert_eq!(
        open_url::parse("centraid://open/note/"),
        Err(Refused::BadId)
    );
    assert_eq!(
        open_url::parse("centraid://open/note/a/b"),
        Err(Refused::BadId)
    );
    assert_eq!(
        open_url::parse("centraid://open/note/A B"),
        Err(Refused::BadId)
    );
}

#[derive(Default)]
struct Recorder {
    commands: Mutex<Vec<(String, Value)>>,
    staged: Mutex<Vec<String>>,
    known: Mutex<BTreeSet<String>>,
    fail: Mutex<bool>,
}

impl Filer for Recorder {
    fn command(&self, name: &str, input: &Value, _: &str) -> Result<Value, String> {
        if *self.fail.lock().unwrap() {
            return Err("the vault is busy".into());
        }
        if let Some(id) = input.get("id").and_then(Value::as_str) {
            self.known.lock().unwrap().insert(id.to_owned());
        }
        self.commands
            .lock()
            .unwrap()
            .push((name.to_owned(), input.clone()));
        Ok(json!({}))
    }

    fn stage(&self, path: &Path, media_type: &str) -> Result<String, String> {
        self.staged.lock().unwrap().push(media_type.to_owned());
        Ok(format!(
            "hash-of-{}",
            path.file_name().unwrap().to_string_lossy()
        ))
    }

    fn exists(&self, id: &str) -> Result<bool, String> {
        Ok(self.known.lock().unwrap().contains(id))
    }
}

fn share(inbox: &Path, uuid: &str, kind: &str, mime: &str, name: &str, at: i64, payload: &[u8]) {
    let dir = inbox.join(uuid);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("payload"), payload).unwrap();
    std::fs::write(
        dir.join("manifest.json"),
        json!({ "v": 1, "type": kind, "uti_or_mime": mime, "name": name, "from_app": "Safari", "received_at": at })
            .to_string(),
    )
    .unwrap();
}

const U1: &str = "0192f0a0-0000-7000-8000-000000000001";
const U2: &str = "0192f0a0-0000-7000-8000-000000000002";
const U3: &str = "0192f0a0-0000-7000-8000-000000000003";

#[test]
fn each_inbox_item_is_filed_through_the_mapping_with_its_arrival() {
    let dir = tempfile::tempdir().unwrap();
    let inbox = dir.path();
    share(
        inbox,
        U1,
        "text",
        "text/plain",
        "",
        1,
        b"Buy flour\nand eggs",
    );
    share(inbox, U2, "file", "image/jpeg", "loaf.jpg", 2, b"jpegbytes");
    share(inbox, U3, "file", "application/pdf", "tax.pdf", 3, b"%PDF");
    share(
        inbox,
        "a-vcf",
        "file",
        "text/vcard",
        "friends.vcf",
        4,
        b"BEGIN:VCARD",
    );
    share(
        inbox,
        "a-csv",
        "file",
        "text/csv",
        "people.csv",
        5,
        b"Name,Email\nAna,a@b.c\n",
    );
    share(
        inbox,
        "a-bank",
        "file",
        "text/csv",
        "bank.csv",
        6,
        b"Date,Description,Amount\n",
    );
    share(
        inbox,
        "an-ics",
        "file",
        "text/calendar",
        "party.ics",
        7,
        b"BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Party\r\nDTSTART:20260615T180000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
    );
    share(
        inbox,
        "a-link",
        "url",
        "text/uri-list",
        "",
        8,
        b"https://example.com/loaf",
    );
    let filer = Recorder::default();

    let report = inbox::drain(inbox, &filer);

    let fates: Vec<_> = report
        .items
        .iter()
        .map(|(id, fate)| (id.as_str(), fate.clone()))
        .collect();
    assert_eq!(
        fates,
        [
            (U1, Fate::Filed(Route::Note)),
            (U2, Fate::Filed(Route::Photo)),
            (U3, Fate::Filed(Route::Document)),
            ("a-vcf", Fate::Filed(Route::Vcard)),
            ("a-csv", Fate::Filed(Route::CsvPeople)),
            (
                "a-bank",
                Fate::Kept(
                    "a spreadsheet of money or Locker items needs its column mapping".into()
                )
            ),
            ("an-ics", Fate::Filed(Route::Ics)),
            ("a-link", Fate::Filed(Route::Note)),
        ]
    );
    let commands = filer.commands.lock().unwrap();
    let names: Vec<_> = commands.iter().map(|(name, _)| name.as_str()).collect();
    assert_eq!(
        names,
        [
            "note.import",
            "photo.add",
            "document.add",
            "person.import_vcf",
            "person.import_csv",
            "event.propose",
            "note.import",
        ]
    );
    let arrivals: Vec<_> = commands
        .iter()
        .map(|(_, input)| input["arrived_via"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(
        arrivals,
        ["share", "share", "share", "vcard", "csv", "ics", "share"]
    );
    assert_eq!(
        commands[1].1["id"], U2,
        "the item's own uuid is the photo's id"
    );
    assert_eq!(commands[1].1["blob"], "hash-of-payload");
    assert_eq!(commands[1].1["media_type"], "image/jpeg");
    assert_eq!(commands[2].1["title"], "tax");
    assert!(
        commands[0].1["files"][0]["text"]
            .as_str()
            .unwrap()
            .starts_with("# Buy flour")
    );
    drop(commands);

    assert!(!inbox.join(U1).exists() && !inbox.join(U2).exists());
    assert!(
        inbox.join("a-bank").exists(),
        "an item the mapping cannot file stays"
    );
    assert!(!inbox.join("an-ics").exists());
}

#[test]
fn draining_twice_files_nothing_twice() {
    let dir = tempfile::tempdir().unwrap();
    let inbox = dir.path();
    share(inbox, U2, "file", "image/png", "a.png", 1, b"png");
    let filer = Recorder::default();
    inbox::drain(inbox, &filer);
    assert_eq!(filer.commands.lock().unwrap().len(), 1);

    share(inbox, U2, "file", "image/png", "a.png", 1, b"png");
    let again = inbox::drain(inbox, &filer);
    assert_eq!(again.items, [(U2.to_owned(), Fate::Already)]);
    assert_eq!(filer.commands.lock().unwrap().len(), 1);
    assert!(
        !inbox.join(U2).exists(),
        "a drained folder that came back is deleted"
    );
}

#[test]
fn a_photo_the_vault_already_holds_is_not_filed_again_after_a_crash_before_the_ledger() {
    let dir = tempfile::tempdir().unwrap();
    let inbox = dir.path();
    share(inbox, U2, "file", "image/png", "a.png", 1, b"png");
    let filer = Recorder::default();
    filer.known.lock().unwrap().insert(U2.to_owned());
    let report = inbox::drain(inbox, &filer);
    assert_eq!(report.filed(), 1);
    assert!(filer.commands.lock().unwrap().is_empty());
    assert!(filer.staged.lock().unwrap().is_empty());
}

#[test]
fn a_refused_filing_keeps_the_item_for_the_next_open() {
    let dir = tempfile::tempdir().unwrap();
    let inbox = dir.path();
    share(inbox, U1, "text", "text/plain", "", 1, b"hello");
    let filer = Recorder::default();
    *filer.fail.lock().unwrap() = true;
    let report = inbox::drain(inbox, &filer);
    assert_eq!(report.kept(), 1);
    assert!(inbox.join(U1).exists());
    *filer.fail.lock().unwrap() = false;
    assert_eq!(inbox::drain(inbox, &filer).filed(), 1);
    assert!(!inbox.join(U1).exists());
}
