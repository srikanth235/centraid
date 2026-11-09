//! Notes in and out as Markdown (#1173, item 14): a folder of files imported with its links,
//! tags and notebooks; a preview that writes nothing; a second import that adds nothing; and an
//! export whose archive holds what was written.

mod common;

use centraid_vault::commands::Registry;
use centraid_vault::{Command, CommandStatus, Principal};
use serde_json::json;

struct World {
    scratch: common::Scratch,
    registry: Registry,
}

impl World {
    fn new() -> Self {
        Self {
            scratch: common::Scratch::founded("portable").expect("a vault"),
            registry: Registry::with_system_commands().expect("a registry"),
        }
    }

    fn ok(&self, name: &str, input: serde_json::Value) -> serde_json::Value {
        let outcome = self
            .scratch
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

    fn count(&self, sql: &str) -> i64 {
        self.scratch
            .vault
            .read(|c| Ok(c.query_row(sql, [], |r| r.get(0))?))
            .expect("a row")
    }
}

fn vault_files() -> serde_json::Value {
    json!([
        { "path": "Trip/Paris.md", "text": "---\ntags: [travel]\n---\nSee [[Hotel|the hotel]] and [[Later]] #food" },
        { "path": "Trip/Hotel.md", "text": "Booked. #travel" },
        { "path": "Later.md", "text": "Written after the note that names it." },
        { "path": "photo.png", "text": "ignored" },
    ])
}

#[test]
fn a_preview_writes_nothing_and_the_import_makes_notes_links_tags_and_notebooks() {
    let w = World::new();
    let preview = w.ok(
        "note.import",
        json!({ "files": vault_files(), "dry_run": true }),
    );
    assert_eq!(
        (
            preview["notes"].as_i64(),
            preview["ignored"].as_i64(),
            preview["tags"].as_i64(),
            preview["notebooks"].as_i64(),
            preview["links"].as_i64(),
            preview["unresolved"].as_i64()
        ),
        (Some(3), Some(1), Some(2), Some(1), Some(2), Some(0)),
        "{preview}"
    );
    assert_eq!(
        w.count("SELECT COUNT(*) FROM note"),
        0,
        "a preview writes no note"
    );
    assert_eq!(
        w.count("SELECT COUNT(*) FROM concept WHERE kind = 'tag'"),
        0
    );

    let done = w.ok("note.import", json!({ "files": vault_files() }));
    assert_eq!(done["notes"], 3);
    assert_eq!(w.count("SELECT COUNT(*) FROM note"), 3);
    assert_eq!(
        w.count("SELECT COUNT(*) FROM entity WHERE kind = 'notebook' AND title = 'Trip'"),
        1
    );
    assert_eq!(
        w.count(
            "SELECT COUNT(*) FROM edge e JOIN entity f ON f.id = e.from_id
              WHERE e.rel = 'links' AND f.title = 'Paris'"
        ),
        2,
        "[[Hotel|the hotel]] and a link to a note imported after it are real links"
    );
    assert_eq!(
        w.count("SELECT COUNT(*) FROM edge WHERE rel = 'tagged' AND to_id LIKE 'tag:%'"),
        3,
        "travel on two notes and food on one: the front-matter travel and the inline one are the same tag"
    );
    assert_eq!(
        w.count("SELECT COUNT(*) FROM concept WHERE kind = 'tag'"),
        2
    );

    // Importing again adds nothing.
    let again = w.ok("note.import", json!({ "files": vault_files() }));
    assert_eq!(
        (again["notes"].as_i64(), again["skipped"].as_i64()),
        (Some(0), Some(3))
    );
    assert_eq!(w.count("SELECT COUNT(*) FROM note"), 3);
}

#[test]
fn the_export_is_an_archive_of_markdown_files_with_links_as_written() {
    let w = World::new();
    w.ok("note.import", json!({ "files": vault_files() }));
    let all = w.ok("note.export", json!({}));
    assert_eq!(all["name"], "Notes.zip");
    assert_eq!(all["count"], 3);
    let bytes = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        all["content"].as_str().unwrap(),
    )
    .unwrap();
    let text = String::from_utf8_lossy(&bytes);
    for name in ["Trip/Paris.md", "Trip/Hotel.md", "Later.md"] {
        assert!(text.contains(name), "{name} is in the archive");
    }
    assert!(
        text.contains("[[Hotel]]") && text.contains("[[Later]]"),
        "links stay [[…]]"
    );
    assert!(text.contains("tags: [food, travel]") || text.contains("tags: [travel]"));
    let notebook = w
        .scratch
        .vault
        .read(|c| {
            Ok(
                c.query_row("SELECT id FROM entity WHERE kind = 'notebook'", [], |r| {
                    r.get::<_, String>(0)
                })?,
            )
        })
        .unwrap();
    let one = w.ok("note.export", json!({ "notebook_id": notebook }));
    assert_eq!(
        (one["name"].as_str(), one["count"].as_i64()),
        (Some("Trip.zip"), Some(2))
    );
}
