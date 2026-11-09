//! The edge shapes a document, a transaction, a photograph and a Locker item
//! may have to a person (and a Locker item to an account and a place), and what
//! the rest of the vault does with an `about`, `with` or `depicts` edge whose
//! start is not a note or a touch: the person's trash, the touch an edge gives,
//! the person's search text, and the merge (#1173, the ontology audit).

mod common;

use centraid_vault::commands::Registry;
use centraid_vault::{Command, CommandStatus, Principal};
use serde_json::json;

struct World {
    scratch: common::Scratch,
    registry: Registry,
}

fn ciphertext(seed: &str) -> String {
    use base64::Engine as _;
    let mut raw = vec![0_u8; 12 + 16 + 8];
    let span = raw.len();
    for (index, byte) in seed.bytes().enumerate() {
        raw[index % span] ^= byte;
    }
    format!(
        "lk1:{}",
        base64::engine::general_purpose::STANDARD.encode(raw)
    )
}

impl World {
    fn new() -> Self {
        let scratch = common::Scratch::founded_with_blobs("widen").expect("a vault");
        scratch
            .vault
            .commit(|tx| {
                tx.set_producer("test.fixture");
                tx.connection().execute(
                    "INSERT INTO locker_key (key_id, created_at)
                     VALUES ('k1', '2026-01-01T00:00:00.000Z')",
                    [],
                )?;
                Ok(())
            })
            .expect("the key plane");
        Self {
            scratch,
            registry: Registry::with_system_commands().expect("a registry"),
        }
    }

    fn run(&self, name: &str, input: serde_json::Value) -> centraid_vault::CommandOutcome {
        self.scratch
            .vault
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

    fn id(&self, name: &str, input: serde_json::Value) -> String {
        self.ok(name, input)["id"]
            .as_str()
            .expect("an id")
            .to_owned()
    }

    fn count(&self, sql: &str, params: &[&str]) -> i64 {
        self.scratch
            .vault
            .read(|c| Ok(c.query_row(sql, rusqlite::params_from_iter(params), |r| r.get(0))?))
            .expect("a row")
    }

    fn text(&self, sql: &str, params: &[&str]) -> String {
        self.scratch
            .vault
            .read(|c| Ok(c.query_row(sql, rusqlite::params_from_iter(params), |r| r.get(0))?))
            .expect("a row")
    }

    fn person(&self, title: &str) -> String {
        self.id("person.add", json!({ "title": title }))
    }

    fn note(&self, title: &str, body: &str) -> String {
        self.id("note.create", json!({ "title": title, "body": body }))
    }

    fn document(&self, title: &str) -> String {
        let hash = centraid_vault::blob::content_digest(title.as_bytes());
        self.ok("blob.stage", json!({ "hash": hash, "size": title.len() }));
        self.id(
            "document.add",
            json!({ "title": title, "blob": hash, "media_type": "application/pdf" }),
        )
    }

    fn photo(&self, seed: &str) -> String {
        let hash = centraid_vault::blob::content_digest(seed.as_bytes());
        self.ok("blob.stage", json!({ "hash": hash, "size": seed.len() }));
        self.id(
            "photo.add",
            json!({ "blob": hash, "media_type": "image/jpeg" }),
        )
    }

    fn account(&self) -> String {
        self.id(
            "account.add",
            json!({ "title": "Everyday", "type": "checking", "currency": "USD" }),
        )
    }

    fn txn(&self, account: &str, external: &str, words: &str) -> String {
        self.ok(
            "follow.statement",
            json!({
                "origin": { "ref": account, "label": "Everyday", "fills": account },
                "records": [{
                    "external_id": external,
                    "fields": {
                        "title": words, "posted_on": "2026-03-02", "amount_minor": -450,
                        "line": { "memo": "m", "imported_from": "csv" },
                    }
                }],
            }),
        );
        self.text(
            "SELECT entity_id FROM source WHERE external_id = ?1",
            &[external],
        )
    }

    fn locker(&self, item_id: &str) -> String {
        self.ok(
            "locker.add_item",
            json!({
                "item_id": item_id, "type": "login", "title": "The bank",
                "username": "ada@example.com", "url": "https://bank.example",
                "password": ciphertext(item_id), "password_rotated": true, "key_id": "k1"
            }),
        );
        item_id.to_owned()
    }

    fn place(&self, title: &str) -> String {
        self.id("place.add", json!({ "title": title }))
    }

    fn stamp(&self, id: &str) -> String {
        self.text("SELECT updated_at FROM entity WHERE id = ?1", &[id])
    }

    fn trashed(&self, id: &str) -> bool {
        self.count(
            "SELECT deleted_at IS NOT NULL FROM entity WHERE id = ?1",
            &[id],
        ) == 1
    }

    fn exists(&self, id: &str) -> bool {
        self.count("SELECT COUNT(*) FROM entity WHERE id = ?1", &[id]) == 1
    }

    fn found_by(&self, term: &str, id: &str) -> bool {
        self.count(
            "SELECT COUNT(*) FROM search s JOIN entity e ON e.n = s.rowid
              WHERE search MATCH ?1 AND e.id = ?2",
            &[term, id],
        ) == 1
    }

    fn edge(&self, from: &str, rel: &str, to: &str) {
        self.ok("edge.add", json!({ "from": from, "rel": rel, "to": to }));
    }
}

// ---------------------------------------------------------------------------
// The shape matrix
// ---------------------------------------------------------------------------

#[test]
fn a_document_a_line_a_photograph_and_a_login_may_be_joined_to_a_person_and_nothing_else_may() {
    let w = World::new();
    let (ada, bob) = (w.person("Ada"), w.person("Bob"));
    let doc = w.document("Lease");
    let account = w.account();
    let line = w.txn(&account, "csv:aaaaa", "RENT");
    let photo = w.photo("p1");
    let login = w.locker("item_bank");
    let place = w.place("Home");

    w.edge(&doc, "about", &ada);
    w.edge(&line, "with", &ada);
    w.edge(&photo, "depicts", &ada);
    w.edge(&login, "about", &ada);
    w.edge(&login, "with", &bob);
    w.edge(&login, "about", &account);
    w.edge(&login, "about", &place);

    // Not these.
    assert!(
        w.refused("edge.add", json!({ "from": ada, "rel": "with", "to": bob }))
            .contains("cannot be")
    );
    assert!(
        w.refused(
            "edge.add",
            json!({ "from": line, "rel": "about", "to": ada })
        )
        .contains("cannot be"),
        "a line is `with` someone, not `about` them"
    );
    assert!(
        w.refused(
            "edge.add",
            json!({ "from": doc, "rel": "depicts", "to": ada })
        )
        .contains("cannot be"),
        "only a photograph depicts"
    );
    assert!(
        w.refused(
            "edge.add",
            json!({ "from": photo, "rel": "depicts", "to": doc })
        )
        .contains("cannot be"),
        "a photograph depicts a person, not a document"
    );
    assert!(
        w.refused("edge.add", json!({ "from": doc, "rel": "with", "to": ada }))
            .contains("cannot be"),
        "a document is `about` a person, never `with` one"
    );
    assert!(
        w.refused(
            "edge.add",
            json!({ "from": photo, "rel": "about", "to": ada })
        )
        .contains("cannot be"),
        "a photograph depicts"
    );
}

#[test]
fn only_a_note_has_an_anchor() {
    let w = World::new();
    let ada = w.person("Ada");
    let doc = w.document("Lease");
    let note = w.note("N", "body");
    let task = w.id("task.add", json!({ "title": "ring" }));
    let anchor = json!({ "start": 0, "end": 3 });
    assert!(
        w.refused(
            "edge.add",
            json!({ "from": doc, "rel": "about", "to": ada, "anchor": anchor })
        )
        .contains("note")
    );
    assert!(
        w.refused(
            "edge.add",
            json!({ "from": task, "rel": "about", "to": ada, "anchor": anchor })
        )
        .contains("note")
    );
    w.ok(
        "edge.add",
        json!({ "from": note, "rel": "about", "to": ada, "anchor": anchor }),
    );
}

// ---------------------------------------------------------------------------
// The person's trash
// ---------------------------------------------------------------------------

#[test]
fn a_persons_trash_takes_notes_events_and_touches_and_never_a_document_a_line_a_photo_or_a_login() {
    let w = World::new();
    let ada = w.person("Ada");
    let note = w.note("N", "about Ada");
    let touch = w.ok(
        "person.log_interaction",
        json!({ "id": ada, "kind": "call", "text": "hello" }),
    )["interaction_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let doc = w.document("Lease");
    let account = w.account();
    let line = w.txn(&account, "csv:aaaaa", "RENT");
    let photo = w.photo("p1");
    let login = w.locker("item_bank");
    w.edge(&note, "about", &ada);
    w.edge(&doc, "about", &ada);
    w.edge(&line, "with", &ada);
    w.edge(&photo, "depicts", &ada);
    w.edge(&login, "about", &ada);
    w.edge(&login, "with", &ada);

    w.ok("entity.trash", json!({ "id": ada }));
    assert!(w.trashed(&note) && w.trashed(&touch));
    for kept in [&doc, &line, &photo, &login] {
        assert!(!w.trashed(kept), "{kept} is the member's own and stays");
    }
    w.ok("entity.restore", json!({ "id": ada }));
    assert!(!w.trashed(&note) && !w.trashed(&touch));
    w.ok("entity.trash", json!({ "id": ada }));
    w.ok("entity.purge", json!({ "id": ada }));
    assert!(!w.exists(&note) && !w.exists(&touch));
    for kept in [&doc, &line, &photo, &login] {
        assert!(w.exists(kept), "{kept} outlives the person");
    }
    assert_eq!(
        w.count(
            "SELECT COUNT(*) FROM edge WHERE from_id IN (?1, ?2, ?3, ?4)",
            &[&doc, &line, &photo, &login]
        ),
        0,
        "the edges to the purged person are gone with it"
    );
}

#[test]
fn a_merge_keeps_what_the_loser_was_the_subject_of() {
    let w = World::new();
    let (ada, ada2) = (w.person("Ada"), w.person("A. Lovelace"));
    let doc = w.document("Lease");
    let account = w.account();
    let line = w.txn(&account, "csv:aaaaa", "RENT");
    let photo = w.photo("p1");
    let login = w.locker("item_bank");
    w.edge(&doc, "about", &ada2);
    w.edge(&line, "with", &ada2);
    w.edge(&photo, "depicts", &ada2);
    w.edge(&login, "about", &ada2);
    w.ok("person.merge", json!({ "from": ada2, "into": ada }));
    for (from, rel) in [
        (&doc, "about"),
        (&line, "with"),
        (&photo, "depicts"),
        (&login, "about"),
    ] {
        assert_eq!(
            w.count(
                "SELECT COUNT(*) FROM edge WHERE from_id = ?1 AND rel = ?2 AND to_id = ?3",
                &[from, rel, &ada]
            ),
            1,
            "{from} {rel} the survivor now"
        );
        assert!(w.exists(from) && !w.trashed(from));
    }
}

// ---------------------------------------------------------------------------
// The touch
// ---------------------------------------------------------------------------

#[test]
fn an_about_on_anything_but_a_note_does_not_touch_its_start() {
    let w = World::new();
    let ada = w.person("Ada");
    let doc = w.document("Lease");
    let note = w.note("N", "body");
    let task = w.id("task.add", json!({ "title": "ring" }));
    let (doc_before, note_before, task_before) = (w.stamp(&doc), w.stamp(&note), w.stamp(&task));
    w.scratch.clock.advance_ms(60_000);
    w.edge(&doc, "about", &ada);
    w.edge(&note, "about", &ada);
    w.edge(&task, "about", &ada);
    assert_eq!(w.stamp(&doc), doc_before, "a document is not re-ordered");
    assert_eq!(w.stamp(&task), task_before, "nor a task");
    assert_ne!(w.stamp(&note), note_before, "a note's words changed");
    w.scratch.clock.advance_ms(60_000);
    let (doc_mid, note_mid) = (w.stamp(&doc), w.stamp(&note));
    w.ok(
        "edge.remove",
        json!({ "from": doc, "rel": "about", "to": ada }),
    );
    w.ok(
        "edge.remove",
        json!({ "from": note, "rel": "about", "to": ada }),
    );
    assert_eq!(w.stamp(&doc), doc_mid);
    assert_ne!(w.stamp(&note), note_mid);
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

#[test]
fn a_person_is_not_found_by_a_memo_about_a_line_or_a_login_that_is_with_them() {
    let w = World::new();
    let ada = w.person("Ada");
    let account = w.account();
    let line = w.txn(&account, "csv:aaaaa", "RENT");
    let login = w.locker("item_bank");
    w.edge(&line, "with", &ada);
    w.edge(&login, "with", &ada);
    let memo_line = w.note("m1", "zebracornflake paid late");
    let memo_login = w.note("m2", "quokkapineapple secret hint");
    w.edge(&memo_line, "about", &line);
    w.edge(&memo_login, "about", &login);
    assert!(
        !w.found_by("zebracornflake", &ada),
        "a memo on a line is not the person's"
    );
    assert!(
        !w.found_by("quokkapineapple", &ada),
        "a memo on a Locker item is never found through a person"
    );
    // A touch they were with still finds them, as before.
    let touch = w.ok(
        "person.log_interaction",
        json!({ "id": ada, "kind": "call", "text": "hello" }),
    )["interaction_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let memo = w.note("m3", "marmosetwalnut said hi");
    w.edge(&memo, "about", &touch);
    assert!(w.found_by("marmosetwalnut", &ada));
    // And a rebuild from the rows finds exactly what the incremental index did.
    w.scratch
        .vault
        .commit(|tx| {
            centraid_vault::index::rebuild(tx.connection())?;
            Ok(())
        })
        .expect("rebuilds");
    assert!(
        !w.found_by("zebracornflake", &ada) && !w.found_by("quokkapineapple", &ada),
        "a rebuild does not read a memo on a line or a login into the person"
    );
    assert!(w.found_by("marmosetwalnut", &ada));
}

// ---------------------------------------------------------------------------
// The Locker guards (O4)
// ---------------------------------------------------------------------------

#[test]
fn no_sealed_value_goes_into_an_edge_label_or_anchor() {
    let w = World::new();
    let (ada, bob) = (w.person("Ada"), w.person("Bob"));
    let note = w.note("N", "body");
    let login = w.locker("item_bank");
    let sealed = ciphertext("item_bank");
    assert!(
        w.refused(
            "edge.add",
            json!({ "from": ada, "rel": "related", "to": bob, "label": format!("mum {sealed}") })
        )
        .contains("sealed"),
        "a relation's label"
    );
    assert!(
        w.refused(
            "edge.add",
            json!({ "from": note, "rel": "links", "to": login,
                    "anchor": { "exact": sealed.clone(), "start": 0 } })
        )
        .contains("sealed"),
        "the anchor of a link into the Locker"
    );
    // The link itself, with an anchor in the note's own words, is the member's to make.
    w.ok(
        "edge.add",
        json!({ "from": note, "rel": "links", "to": login,
                "anchor": { "exact": "the bank", "start": 0 } }),
    );
    assert_eq!(
        w.count(
            "SELECT COUNT(*) FROM edge WHERE anchor LIKE '%lk1:%' OR label_id LIKE '%lk1:%'",
            &[]
        ),
        0
    );
}
