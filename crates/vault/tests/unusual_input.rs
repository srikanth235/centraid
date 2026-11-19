//! UNUSUAL INPUT AND ROUND TRIPS (#1202, S8 and S14). Every app that exports: a record whose
//! text is 10,000 characters, an emoji with joiners, right-to-left script, CJK, the characters a
//! file name may not hold, and control characters, is saved, listed, exported without a panic and
//! without being altered; and where the app also imports, what an export holds is what an import
//! gives back, and a second export is the first, byte for byte.

mod common;

use base64::Engine as _;
use centraid_vault::commands::Registry;
use centraid_vault::portable::zip::stored_entries;
use centraid_vault::{Command, CommandStatus, Principal};
use serde_json::{Value, json};

/// The texts, each named. `plain` is true where the text has no control character, so a
/// comparison with it is exact.
fn samples() -> Vec<(&'static str, String)> {
    vec![
        ("long", "Long line of text, with words. ".repeat(330)),
        (
            "emoji",
            "Party \u{1F389} family \u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466} flag \u{1F3F3}\u{FE0F}\u{200D}\u{1F308} wave \u{1F44B}\u{1F3FD} e\u{301}".to_owned(),
        ),
        (
            "rtl",
            "\u{645}\u{631}\u{62D}\u{628}\u{627} \u{628}\u{627}\u{644}\u{639}\u{627}\u{644}\u{645} \u{5E9}\u{5DC}\u{5D5}\u{5DD} \u{5E2}\u{5D5}\u{5DC}\u{5DD} 123".to_owned(),
        ),
        (
            "cjk",
            "\u{65E5}\u{672C}\u{8A9E}\u{306E}\u{30C6}\u{30AD}\u{30B9}\u{30C8} \u{4E2D}\u{6587}\u{6C49}\u{5B57} \u{D55C}\u{AD6D}\u{C5B4}".to_owned(),
        ),
        ("names", "a/b\\c:d*e?f\"g<h>i|j".to_owned()),
        ("lines", "one\ntwo, \"quoted\"; semi\\colon\nthree".to_owned()),
    ]
}

/// Control characters: kept apart, because a vault may refuse or tidy them; what it must never do
/// is panic or break the file it exports.
fn controls() -> String {
    "tab\there \u{1}\u{8}\u{1F}\u{7F} end".to_owned()
}

struct World {
    scratch: common::Scratch,
    registry: Registry,
}

impl World {
    fn new(seed: &str) -> Self {
        Self {
            scratch: common::Scratch::founded_with_blobs(seed).expect("a vault"),
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

    fn content(&self, name: &str, input: Value) -> Vec<u8> {
        let out = self.ok(name, input);
        base64::engine::general_purpose::STANDARD
            .decode(out["content"].as_str().expect("content"))
            .expect("base64")
    }

    fn column(&self, sql: &str) -> Vec<String> {
        self.scratch
            .vault
            .read(|c| {
                let mut statement = c.prepare(sql)?;
                let rows = statement
                    .query_map([], |r| r.get::<_, String>(0))?
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                Ok(rows)
            })
            .expect("rows")
    }

    fn pairs(&self, sql: &str) -> Vec<(String, String)> {
        self.scratch
            .vault
            .read(|c| {
                let mut statement = c.prepare(sql)?;
                let rows = statement
                    .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                Ok(rows)
            })
            .expect("rows")
    }

    fn all(&self) -> Vec<(String, Vec<u8>)> {
        let out = self.ok("vault.export_all", json!({}));
        let bytes = std::fs::read(out["path"].as_str().expect("a path")).expect("the staged file");
        stored_entries(&bytes).expect("a zip")
    }
}

/// A name inside an archive holds nothing a file name may not, and goes nowhere above its folder.
fn assert_safe_names(entries: &[(String, Vec<u8>)]) {
    for (name, _) in entries {
        for part in name.split('/') {
            assert!(part != ".." && part != ".", "{name:?}");
            assert!(
                !part.chars().any(
                    |c| matches!(c, '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
                        || c.is_control()
                ),
                "an unsafe character in {name:?}"
            );
        }
        assert!(!name.starts_with('/'), "{name:?}");
    }
}

/// Unfold and unescape an iCalendar text: the value of the first `property` line.
fn ics_values(text: &str, property: &str) -> Vec<String> {
    let text = text.replace("\r\n ", "").replace("\r\n\t", "");
    text.split("\r\n")
        .filter_map(|line| {
            let rest = line.strip_prefix(property)?;
            let value = rest
                .strip_prefix(':')
                .or_else(|| rest.split_once(':').map(|(_, v)| v))?;
            Some(ics_unescape(value))
        })
        .collect()
}

fn ics_unescape(value: &str) -> String {
    let mut out = String::new();
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('n' | 'N') => out.push('\n'),
                Some(other) => out.push(other),
                None => out.push('\\'),
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// RFC 4180 records.
fn csv_records(text: &str) -> Vec<Vec<String>> {
    let (mut rows, mut row, mut cell) = (Vec::new(), Vec::new(), String::new());
    let mut quoted = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match (quoted, c) {
            (true, '"') if chars.peek() == Some(&'"') => {
                chars.next();
                cell.push('"');
            }
            (true, '"') => quoted = false,
            (false, '"') if cell.is_empty() => quoted = true,
            (false, ',') => row.push(std::mem::take(&mut cell)),
            (false, '\r') => {}
            (false, '\n') => {
                row.push(std::mem::take(&mut cell));
                rows.push(std::mem::take(&mut row));
            }
            (_, c) => cell.push(c),
        }
    }
    if !cell.is_empty() || !row.is_empty() {
        row.push(cell);
        rows.push(row);
    }
    rows
}

fn text_of(entries: &[(String, Vec<u8>)]) -> Vec<(String, String)> {
    let mut found: Vec<(String, String)> = entries
        .iter()
        .map(|(name, bytes)| {
            (
                name.clone(),
                String::from_utf8(bytes.clone()).expect("utf-8"),
            )
        })
        .collect();
    found.sort();
    found
}

#[test]
fn notes_with_unusual_text_survive_an_export_an_import_and_a_second_export_unchanged() {
    let a = World::new("notes-a");
    let mut made = Vec::new();
    for (label, text) in samples() {
        let title = if text.len() > 200 {
            format!("Note {label}")
        } else {
            text.clone()
        };
        a.ok("note.create", json!({ "title": title, "body": text }));
        made.push((title, text));
    }
    // Control characters: saved without a panic, and the export is still a zip.
    a.run(
        "note.create",
        json!({ "title": "Control", "body": controls() }),
    );

    // Saved and listed: every note is there with the text it was given.
    let stored = a.pairs("SELECT e.title, n.body FROM note n JOIN entity e ON e.id = n.id");
    for (title, text) in &made {
        assert!(
            stored.iter().any(|(t, b)| t == title && b == text),
            "{title:?} is saved as given"
        );
    }

    let first = stored_entries(&a.content("note.export", json!({}))).expect("a zip");
    assert_safe_names(&first);
    assert!(
        first.len() >= made.len(),
        "{:?}",
        first.iter().map(|e| &e.0).collect::<Vec<_>>()
    );
    assert_eq!(
        first,
        stored_entries(&a.content("note.export", json!({}))).expect("a zip"),
        "an export is deterministic"
    );

    // Import what the export holds into another vault: the same notes come back.
    let b = World::new("notes-b");
    let files: Vec<Value> = text_of(&first)
        .into_iter()
        .filter(|(name, _)| {
            std::path::Path::new(name)
                .extension()
                .is_some_and(|e| e == "md")
        })
        .map(|(path, text)| json!({ "path": path, "text": text }))
        .collect();
    b.ok("note.import", json!({ "files": files }));
    let back = b.pairs("SELECT e.title, n.body FROM note n JOIN entity e ON e.id = n.id");
    for (title, text) in &made {
        assert!(
            back.iter()
                .any(|(t, body)| t == title && body.trim_end() == text.trim_end()),
            "{title:?} survives the round trip"
        );
    }
    assert_eq!(back.len(), stored.len(), "the same number of notes");

    // And export again from the imported vault: the same files.
    let second = stored_entries(&b.content("note.export", json!({}))).expect("a zip");
    assert_eq!(text_of(&second), text_of(&first), "export, import, export");
}

#[test]
fn people_with_unusual_names_survive_an_export_an_import_and_a_second_export_unchanged() {
    let a = World::new("people-a");
    let mut made = Vec::new();
    for (label, text) in samples() {
        let name = if text.len() > 200 {
            format!("{label} {}", &text[..180])
        } else {
            text.clone()
        };
        a.ok("person.add", json!({ "title": name }));
        made.push(name);
    }
    a.run("person.add", json!({ "title": controls() }));
    let stored = a.column("SELECT title FROM entity WHERE kind = 'person'");
    for name in &made {
        assert!(stored.contains(name), "{name:?} is listed");
    }

    let first = a.content("person.export_vcf", json!({}));
    assert_eq!(
        first,
        a.content("person.export_vcf", json!({})),
        "deterministic"
    );
    let text = String::from_utf8(first.clone()).expect("a vcf is utf-8");
    assert!(text.starts_with("BEGIN:VCARD"));

    let b = World::new("people-b");
    b.ok("person.import_vcf", json!({ "cards": text }));
    let back = b.column("SELECT title FROM entity WHERE kind = 'person'");
    for name in &made {
        assert!(
            back.contains(name),
            "{name:?} survives the round trip: {back:?}"
        );
    }
    assert_eq!(back.len(), stored.len(), "the same number of people");
    let second = b.content("person.export_vcf", json!({}));
    assert_eq!(
        ics_free(&String::from_utf8(second).expect("utf-8")),
        ics_free(&text),
        "export, import, export"
    );
}

/// A card or calendar text without the lines a fresh id or a stamp changes.
fn ics_free(text: &str) -> Vec<String> {
    let mut lines: Vec<String> = text
        .split("\r\n")
        .filter(|l| !l.starts_with("UID") && !l.starts_with("REV") && !l.starts_with("DTSTAMP"))
        .map(str::to_owned)
        .collect();
    lines.sort();
    lines
}

#[test]
fn calendar_and_reminders_export_unusual_text_as_text_that_reads_back() {
    let w = World::new("agenda");
    let mut made = Vec::new();
    for (i, (label, text)) in samples().into_iter().enumerate() {
        let title = if text.len() > 200 {
            format!("{label} {}", &text[..150])
        } else {
            text.clone()
        };
        w.ok(
            "event.propose",
            json!({ "title": title, "starts": format!("2026-03-{:02}T10:00", i + 1), "description": text }),
        );
        w.ok(
            "task.add",
            json!({ "title": title, "due": format!("2026-03-{:02}", i + 1), "description": text }),
        );
        made.push((title, text));
    }
    w.run(
        "event.propose",
        json!({ "title": controls(), "starts": "2026-03-20T10:00" }),
    );
    w.run("task.add", json!({ "title": controls() }));

    for (command, component) in [("event.export_ics", "VEVENT"), ("task.export_ics", "VTODO")] {
        let bytes = w.content(command, json!({}));
        assert_eq!(
            bytes,
            w.content(command, json!({})),
            "{command} is deterministic"
        );
        let text = String::from_utf8(bytes).expect("utf-8");
        assert!(text.contains(&format!("BEGIN:{component}")));
        for line in text.split("\r\n") {
            assert!(
                line.len() <= 75 + 3 || line.is_empty(),
                "a line is folded at 75 octets: {} bytes",
                line.len()
            );
        }
        let summaries = ics_values(&text, "SUMMARY");
        for (title, _) in &made {
            assert!(
                summaries.contains(title),
                "{command}: {title:?} reads back from the file"
            );
        }
    }
}

#[test]
fn money_and_health_export_unusual_text_as_csv_that_reads_back() {
    let w = World::new("csv");
    let account = w.id(
        "account.add",
        json!({ "title": "Everyday", "type": "checking", "currency": "USD" }),
    );
    let mut made = Vec::new();
    for (i, (label, text)) in samples().into_iter().enumerate() {
        let title = if text.len() > 200 {
            format!("{label} {}", &text[..150])
        } else {
            text.clone()
        };
        w.ok(
            "follow.statement",
            json!({
                "origin": { "ref": account, "label": "Bank", "fills": account },
                "records": [{
                    "external_id": format!("t{i}"),
                    "fields": { "title": title, "posted_on": "2026-03-01",
                                "amount_minor": -100 - i as i64, "line": {} }
                }],
            }),
        );
        w.ok(
            "workout.log",
            json!({ "type": "run", "title": title, "starts": format!("2026-03-{:02}T07:00:00Z", i + 1),
                    "ends": format!("2026-03-{:02}T07:30:00Z", i + 1), "moving_s": 1800 }),
        );
        made.push(title);
    }
    w.run(
        "workout.log",
        json!({ "type": "run", "title": controls(), "starts": "2026-03-20" }),
    );

    let money = String::from_utf8(w.content("txn.export_csv", json!({}))).expect("utf-8");
    let health = String::from_utf8(w.content("health.export_csv", json!({ "what": "workouts" })))
        .expect("utf-8");
    assert_eq!(
        money.as_bytes(),
        w.content("txn.export_csv", json!({})),
        "deterministic"
    );
    for (what, text) in [("money", money), ("health", health)] {
        let rows = csv_records(&text);
        let width = rows[0].len();
        assert!(
            rows.iter().all(|r| r.len() == width),
            "{what}: every record has {width} cells"
        );
        for title in &made {
            assert!(
                rows.iter().any(|r| r.iter().any(|c| c == title)),
                "{what}: {title:?} reads back from the file"
            );
        }
    }
}

#[test]
fn documents_photos_and_the_whole_archive_name_unusual_titles_safely() {
    let w = World::new("files");
    let mut bodies = Vec::new();
    let folder = w.id(
        "container.create",
        json!({ "kind": "folder", "title": "F" }),
    );
    let album = w.id(
        "container.create",
        json!({ "kind": "album", "title": "Album" }),
    );
    for (i, (label, text)) in samples().into_iter().enumerate() {
        let title = if text.len() > 200 {
            format!("{label} {}", &text[..150])
        } else {
            text.clone()
        };
        let bytes: Vec<u8> = (0..300u32).map(|n| ((n + i as u32) % 251) as u8).collect();
        let hash = w
            .scratch
            .vault
            .blobs()
            .expect("a store")
            .put(&bytes)
            .expect("stored");
        w.ok("blob.stage", json!({ "hash": hash, "size": bytes.len() }));
        w.ok(
            "document.add",
            json!({ "title": title, "blob": hash, "media_type": "application/pdf", "folder_id": folder }),
        );
        bodies.push(bytes);
    }
    let photo_bytes = b"jpeg bytes".to_vec();
    let hash = w
        .scratch
        .vault
        .blobs()
        .expect("a store")
        .put(&photo_bytes)
        .expect("stored");
    w.ok(
        "blob.stage",
        json!({ "hash": hash, "size": photo_bytes.len() }),
    );
    let photo = w.id(
        "photo.add",
        json!({ "blob": hash, "media_type": "image/jpeg",
                "taken_at": "2025-07-01T10:00:00.000Z", "offset_min": 0 }),
    );
    w.ok(
        "edge.add",
        json!({ "from": album, "rel": "contains", "to": photo }),
    );
    // An album and a folder with the awkward names themselves.
    for (_, text) in samples().into_iter().filter(|(_, t)| t.len() <= 200) {
        w.run(
            "container.create",
            json!({ "kind": "album", "title": text }),
        );
        w.run(
            "container.create",
            json!({ "kind": "folder", "title": text }),
        );
    }

    let entries = w.all();
    assert_safe_names(&entries);
    // Every original is in the archive, byte for byte, whatever its title.
    let docs: Vec<&Vec<u8>> = entries
        .iter()
        .filter(|(n, _)| n.starts_with("Docs/"))
        .map(|(_, b)| b)
        .collect();
    assert_eq!(docs.len(), bodies.len(), "every document is exported");
    for bytes in &bodies {
        assert!(docs.contains(&bytes), "a document's bytes are exact");
    }
    assert!(
        entries
            .iter()
            .any(|(n, b)| n.starts_with("Photos/") && *b == photo_bytes)
    );
    assert_eq!(
        text_of(
            &entries
                .iter()
                .filter(|(n, _)| n.ends_with(".txt"))
                .cloned()
                .collect::<Vec<_>>()
        ),
        text_of(
            &w.all()
                .iter()
                .filter(|(n, _)| n.ends_with(".txt"))
                .cloned()
                .collect::<Vec<_>>()
        ),
        "a second archive says the same"
    );
}
