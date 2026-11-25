//! Notes in and out as Markdown (#1173, item 14; #1214 K11): a folder of files imported as a
//! one-time arrival with its links, tags, notebooks, journal days and assets; a preview that writes
//! nothing; a second import that adds nothing; and an export whose archive, imported into another
//! vault, gives the same notes back.

mod common;

use common::world::World;
use serde_json::{Value, json};

fn world(seed: &str) -> World {
    World {
        scratch: common::Scratch::founded_with_blobs(seed).expect("a vault"),
        registry: centraid_vault::commands::Registry::with_system_commands().expect("a registry"),
    }
}

fn vault_files() -> Value {
    json!([
        { "path": "Trip/Paris.md", "text": "---\ntags: [travel]\n---\nSee [[Hotel|the hotel]] and [[Later]] #food" },
        { "path": "Trip/Hotel.md", "text": "Booked. #travel" },
        { "path": "Later.md", "text": "Written after the note that names it." },
        { "path": "photo.png", "text": "ignored" },
    ])
}

/// The entries of a stored ZIP, read through its central directory: `(path, bytes)`.
fn unzip(bytes: &[u8]) -> Vec<(String, Vec<u8>)> {
    let le16 = |at: usize| usize::from(u16::from_le_bytes([bytes[at], bytes[at + 1]]));
    let le32 = |at: usize| {
        u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]]) as usize
    };
    let end = bytes.len() - 22;
    assert_eq!(&bytes[end..end + 4], b"PK\x05\x06");
    let (count, mut at) = (le16(end + 10), le32(end + 16));
    let mut out = Vec::new();
    for _ in 0..count {
        assert_eq!(&bytes[at..at + 4], b"PK\x01\x02");
        let (size, name_len, extra_len, comment_len, local) = (
            le32(at + 20),
            le16(at + 28),
            le16(at + 30),
            le16(at + 32),
            le32(at + 42),
        );
        let name = String::from_utf8(bytes[at + 46..at + 46 + name_len].to_vec()).unwrap();
        let data = local + 30 + le16(local + 26) + le16(local + 28);
        out.push((name, bytes[data..data + size].to_vec()));
        at += 46 + name_len + extra_len + comment_len;
    }
    out
}

fn exported(w: &World, input: Value) -> (Value, Vec<(String, Vec<u8>)>) {
    let out = w.ok("note.export", input);
    let bytes = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        out["content"].as_str().unwrap(),
    )
    .unwrap();
    (out, unzip(&bytes))
}

#[test]
fn a_preview_writes_nothing_and_the_import_makes_notes_mentions_tags_and_notebooks() {
    let w = world("portable_import");
    let preview = w.ok(
        "note.import",
        json!({ "files": vault_files(), "dry_run": true }),
    );
    assert_eq!(
        [
            &preview["notes"],
            &preview["ignored"],
            &preview["tags"],
            &preview["notebooks"],
            &preview["links"],
            &preview["unresolved"]
        ],
        [
            &json!(3),
            &json!(1),
            &json!(2),
            &json!(1),
            &json!(2),
            &json!(0)
        ],
        "{preview}"
    );
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM note", &[]), 0);
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM concept WHERE kind = 'tag'", &[]),
        0
    );

    let done = w.ok(
        "note.import",
        json!({ "files": vault_files(), "arrived_via": "markdown", "arrived_label": "Trip" }),
    );
    assert_eq!(done["notes"], 3);
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM note", &[]), 3);
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM entity WHERE kind = 'notebook' AND title = 'Trip'",
            &[]
        ),
        1
    );
    // Paris sits in the notebook, and names Hotel and Later, the second of which was imported
    // after it: both are resolved, `[[Hotel|the hotel]]` as a plain `[[Hotel]]`.
    let paris: String = w.one(
        "SELECT e.id FROM entity e WHERE e.title = 'Paris' AND e.kind = 'note'",
        &[],
    );
    assert_eq!(
        w.one::<String>(
            "SELECT p.title FROM entity e JOIN entity p ON p.id = e.parent_id WHERE e.id = ?1",
            &[&paris]
        ),
        "Trip"
    );
    assert_eq!(
        w.strings(
            "SELECT m.wikilink || '>' || t.title FROM mention m JOIN entity t ON t.id = m.to_id
              WHERE m.note_id = ?1 ORDER BY m.ordinal",
            &[&paris]
        ),
        ["Hotel>Hotel", "Later>Later"]
    );
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM edge WHERE rel = 'tagged' AND from_id IN (SELECT id FROM note)",
            &[]
        ),
        3,
        "travel on two notes and food on one: the front-matter travel and the inline one are one tag"
    );
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM concept WHERE kind = 'tag'", &[]),
        2
    );
    // A one-time arrival: stamped on each note, and no origin or source.
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM entity WHERE kind = 'note' AND arrived_via = 'markdown' AND arrived_label = 'Trip'",
            &[]
        ),
        3
    );
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM origin", &[]), 0);
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM source", &[]), 0);

    // Importing again adds nothing.
    let again = w.ok("note.import", json!({ "files": vault_files() }));
    assert_eq!((&again["notes"], &again["skipped"]), (&json!(0), &json!(3)));
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM note", &[]), 3);
}

#[test]
fn an_archive_imported_into_another_vault_gives_the_notes_back_with_their_links_assets_and_days() {
    let a = world("portable_round_a");
    a.ok(
        "note.import",
        json!({ "files": vault_files(), "arrived_via": "markdown", "arrived_label": "Trip" }),
    );
    let paris: String = a.one("SELECT id FROM entity WHERE title = 'Paris'", &[]);
    let hotel: String = a.one("SELECT id FROM entity WHERE title = 'Hotel'", &[]);
    let png = a
        .vault()
        .blobs()
        .unwrap()
        .put(b"\x89PNG not really")
        .unwrap();
    a.ok(
        "note.asset_add",
        json!({ "id": paris, "blob": png, "name": "view.png", "media_type": "image/png" }),
    );
    let pdf = a.vault().blobs().unwrap().put(b"%PDF-ish").unwrap();
    a.ok(
        "note.asset_add",
        json!({ "id": paris, "blob": pdf, "name": "menu.pdf", "media_type": "application/pdf" }),
    );
    a.ok(
        "note.edit",
        json!({ "id": hotel, "journal_on": "2026-02-24" }),
    );

    let (all, entries) = exported(&a, json!({}));
    assert_eq!(
        (all["name"].as_str(), all["count"].as_i64()),
        (Some("Notes.zip"), Some(3))
    );
    assert_eq!(all["missing_assets"], 0);
    let paths: Vec<&str> = entries.iter().map(|(path, _)| path.as_str()).collect();
    for expected in [
        "Trip/Paris.md",
        "Trip/Hotel.md",
        "Later.md",
        "Trip/Paris.assets/view.png",
        "Trip/Paris.assets/menu.pdf",
    ] {
        assert!(paths.contains(&expected), "{expected} is in {paths:?}");
    }
    let text_of = |path: &str| {
        String::from_utf8(entries.iter().find(|(p, _)| p == path).unwrap().1.clone()).unwrap()
    };
    assert!(
        text_of("Trip/Paris.md").contains("[[Hotel]]"),
        "links stay as written"
    );
    assert!(text_of("Trip/Hotel.md").contains("journal: 2026-02-24"));
    assert!(text_of("Trip/Paris.md").contains("tags: [food, travel]"));

    // The shell's side: text files as text, anything else as bytes it put in the store.
    let b = world("portable_round_b");
    let files: Vec<Value> = entries
        .iter()
        .map(|(path, bytes)| {
            if path.ends_with(".md") {
                json!({ "path": path, "text": String::from_utf8(bytes.clone()).unwrap() })
            } else {
                let hash = b.vault().blobs().unwrap().put(bytes).unwrap();
                json!({ "path": path, "blob": hash,
                        "media_type": if path.ends_with(".pdf") { "application/pdf" } else { "image/png" } })
            }
        })
        .collect();
    let preview = b.ok("note.import", json!({ "files": files, "dry_run": true }));
    assert_eq!(
        (&preview["notes"], &preview["assets"], &preview["ignored"]),
        (&json!(3), &json!(2), &json!(0))
    );
    b.ok(
        "note.import",
        json!({ "files": files, "arrived_via": "markdown", "arrived_label": "Notes.zip" }),
    );

    let summary = |w: &World| {
        w.strings(
            "SELECT e.title || '|' || n.body || '|' || ifnull(n.journal_on, '') || '|' ||
                    ifnull((SELECT p.title FROM entity p WHERE p.id = e.parent_id), '') || '|' ||
                    ifnull((SELECT group_concat(a.name || ':' || a.blob || ':' || a.media_type, ',') FROM
                       (SELECT * FROM note_asset WHERE note_id = e.id ORDER BY position, id) a), '')
               FROM entity e JOIN note n ON n.id = e.id WHERE e.kind = 'note' ORDER BY e.title",
            &[],
        )
    };
    assert_eq!(
        summary(&a),
        summary(&b),
        "the same notes, words, days, homes and assets"
    );
    let mention_rows = |w: &World| {
        w.strings(
            "SELECT s.title || '>' || m.wikilink || '>' || ifnull(t.title, '-')
               FROM mention m JOIN entity s ON s.id = m.note_id LEFT JOIN entity t ON t.id = m.to_id
              ORDER BY s.title, m.ordinal",
            &[],
        )
    };
    assert_eq!(mention_rows(&a), mention_rows(&b));
    assert_eq!(
        b.one::<i64>(
            "SELECT COUNT(*) FROM entity WHERE kind = 'note' AND arrived_via = 'markdown'",
            &[]
        ),
        3
    );
    // Two assets of one name do not overwrite each other in the archive.
    let again = a.vault().blobs().unwrap().put(b"another view").unwrap();
    a.ok(
        "note.asset_add",
        json!({ "id": paris, "blob": again, "name": "view.png", "media_type": "image/png" }),
    );
    let (_, entries) = exported(&a, json!({}));
    let paths: Vec<&str> = entries.iter().map(|(path, _)| path.as_str()).collect();
    assert!(paths.contains(&"Trip/Paris.assets/view.png"), "{paths:?}");
    assert!(paths.contains(&"Trip/Paris.assets/2 view.png"), "{paths:?}");
}

#[test]
fn an_export_of_one_notebook_holds_its_notes_and_a_file_too_big_for_a_note_is_left_out() {
    let w = world("portable_scope");
    w.ok("note.import", json!({ "files": vault_files() }));
    let notebook: String = w.one("SELECT id FROM entity WHERE kind = 'notebook'", &[]);
    let (one, entries) = exported(&w, json!({ "notebook_id": notebook }));
    assert_eq!(
        (one["name"].as_str(), one["count"].as_i64()),
        (Some("Trip.zip"), Some(2))
    );
    assert_eq!(entries.len(), 2);

    let big = "x".repeat(70 * 1024);
    let done = w.ok(
        "note.import",
        json!({ "files": [
            { "path": "Huge.md", "text": big },
            { "path": "Small.md", "text": "fine" },
        ] }),
    );
    assert_eq!((&done["notes"], &done["ignored"]), (&json!(1), &json!(1)));
}
