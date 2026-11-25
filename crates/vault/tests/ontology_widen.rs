//! What the rest of the vault does with an `about`, `with` or `depicts` edge whose start is not a
//! note or a touch (#1173, the ontology audit, kept on the v0 shapes #1214): the pairs a document,
//! a line, a photograph and a Locker item may have to a person, the person's trash (an allow-list:
//! only what was written or logged about them goes with them), the person's search text, and that
//! no sealed value rides on an edge.
//!
//! What the old file held that other files now hold: the matrix over every pair of kinds is
//! `schema_rules.rs` and `graph.rs`; only a note is anchored (`edge_shape.anchored`) and what an
//! `about` touches is `shared_verbs_edges.rs`; a merge moving a person's edges to the survivor is
//! `people_merge.rs` and `graph.rs`.

mod common;

use centraid_vault::model::Kind;
use common::world::World;
use serde_json::json;

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

fn edge(w: &World, from: &str, rel: &str, to: &str) {
    w.ok("edge.add", json!({ "from": from, "rel": rel, "to": to }));
}

fn note(w: &World, title: &str, body: &str) -> String {
    w.ok("note.create", json!({ "title": title, "body": body }))["id"]
        .as_str()
        .expect("an id")
        .to_owned()
}

fn trashed(w: &World, id: &str) -> bool {
    w.one::<Option<String>>("SELECT deleted_at FROM entity WHERE id = ?1", &[id])
        .is_some()
}

fn exists(w: &World, id: &str) -> bool {
    w.one::<i64>("SELECT COUNT(*) FROM entity WHERE id = ?1", &[id]) == 1
}

fn found_by(w: &World, term: &str, id: &str) -> bool {
    w.one::<i64>(
        "SELECT COUNT(*) FROM search s JOIN entity e ON e.n = s.rowid
          WHERE search MATCH ?1 AND e.id = ?2",
        &[&format!("\"{term}\""), id],
    ) == 1
}

/// A document, a line, a photograph and a Locker item: what a person is joined to by something
/// that is not their own words.
struct Things {
    doc: String,
    line: String,
    photo: String,
    login: String,
}

impl Things {
    fn new(w: &World) -> Self {
        Self {
            doc: w.made(Kind::Document, "Lease"),
            line: w.made(Kind::Txn, "RENT"),
            photo: w.made(Kind::Photo, "p1"),
            login: w.made(Kind::LockerItem, "Bank"),
        }
    }

    fn all(&self) -> [&String; 4] {
        [&self.doc, &self.line, &self.photo, &self.login]
    }
}

// ---------------------------------------------------------------------------
// The shapes
// ---------------------------------------------------------------------------

#[test]
fn a_document_a_line_a_photograph_and_a_login_may_be_joined_to_a_person_and_nothing_else_may() {
    let w = World::new("widen_shapes");
    let (ada, bob) = (w.person("Ada"), w.person("Bob"));
    let t = Things::new(&w);
    let place = w.made(Kind::Place, "Home");
    let account = w.made(Kind::Account, "Current");

    edge(&w, &t.doc, "about", &ada);
    edge(&w, &t.line, "with", &ada);
    edge(&w, &t.photo, "depicts", &ada);
    edge(&w, &t.login, "about", &ada);
    edge(&w, &t.login, "with", &bob);
    edge(&w, &t.login, "about", &account);
    edge(&w, &t.login, "about", &place);

    for (from, rel, to, why) in [
        (&ada, "with", &bob, "a person is not with a person"),
        (
            &t.line,
            "about",
            &ada,
            "a line is `with` someone, not `about` them",
        ),
        (&t.doc, "depicts", &ada, "only a photograph depicts"),
        (
            &t.photo,
            "depicts",
            &t.doc,
            "a photograph depicts a person, not a document",
        ),
        (
            &t.doc,
            "with",
            &ada,
            "a document is `about` a person, never `with` one",
        ),
        (&t.photo, "about", &ada, "a photograph depicts"),
    ] {
        assert!(
            w.refused("edge.add", json!({ "from": from, "rel": rel, "to": to }))
                .contains("cannot be"),
            "{why}"
        );
    }
}

// ---------------------------------------------------------------------------
// The person's trash
// ---------------------------------------------------------------------------

#[test]
fn a_persons_trash_takes_notes_and_touches_and_never_a_document_a_line_a_photo_or_a_login() {
    let w = World::new("widen_trash");
    let ada = w.person("Ada");
    let words = note(&w, "N", "about Ada");
    let touch = w.made(Kind::Touch, "call");
    let t = Things::new(&w);
    edge(&w, &words, "about", &ada);
    edge(&w, &touch, "with", &ada);
    edge(&w, &t.doc, "about", &ada);
    edge(&w, &t.line, "with", &ada);
    edge(&w, &t.photo, "depicts", &ada);
    edge(&w, &t.login, "about", &ada);
    edge(&w, &t.login, "with", &ada);

    w.ok("entity.trash", json!({ "id": ada }));
    assert!(trashed(&w, &words) && trashed(&w, &touch));
    for kept in t.all() {
        assert!(!trashed(&w, kept), "{kept} is the member's own and stays");
    }
    w.ok("entity.restore", json!({ "id": ada }));
    assert!(!trashed(&w, &words) && !trashed(&w, &touch));
    w.ok("entity.trash", json!({ "id": ada }));
    w.ok("entity.purge", json!({ "id": ada }));
    assert!(!exists(&w, &words) && !exists(&w, &touch));
    for kept in t.all() {
        assert!(exists(&w, kept), "{kept} outlives the person");
    }
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM edge WHERE from_id IN (?1, ?2, ?3, ?4)",
            &[&t.doc, &t.line, &t.photo, &t.login]
        ),
        0,
        "the edges to the purged person are gone with it"
    );
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

#[test]
fn a_person_is_not_found_by_a_memo_about_a_line_or_a_login_that_is_with_them() {
    let w = World::new("widen_search");
    let ada = w.person("Ada");
    let t = Things::new(&w);
    edge(&w, &t.line, "with", &ada);
    edge(&w, &t.login, "with", &ada);
    let memo_line = note(&w, "m1", "zebracornflake paid late");
    let memo_login = note(&w, "m2", "quokkapineapple secret hint");
    edge(&w, &memo_line, "about", &t.line);
    edge(&w, &memo_login, "about", &t.login);
    assert!(
        !found_by(&w, "zebracornflake", &ada),
        "a memo on a line is not the person's"
    );
    assert!(
        !found_by(&w, "quokkapineapple", &ada),
        "a memo on a Locker item is never found through a person"
    );
    // A touch they were with still finds them, through what was written about it.
    let touch = w.made(Kind::Touch, "call");
    edge(&w, &touch, "with", &ada);
    let memo = note(&w, "m3", "marmosetwalnut said hi");
    edge(&w, &memo, "about", &ada);
    assert!(found_by(&w, "marmosetwalnut", &ada));
    // And a rebuild from the rows finds exactly what the incremental index did.
    w.vault().rebuild_index().expect("rebuilds");
    assert!(
        !found_by(&w, "zebracornflake", &ada) && !found_by(&w, "quokkapineapple", &ada),
        "a rebuild does not read a memo on a line or a login into the person"
    );
    assert!(found_by(&w, "marmosetwalnut", &ada));
}

// ---------------------------------------------------------------------------
// The Locker guard (O4)
// ---------------------------------------------------------------------------

#[test]
fn no_sealed_value_goes_into_an_edge_anchor() {
    let w = World::new("widen_sealed");
    let ada = w.person("Ada");
    let words = note(&w, "N", "the bank");
    let sealed = ciphertext("item_bank");
    assert!(
        w.refused(
            "edge.add",
            json!({ "from": words, "rel": "about", "to": ada,
                    "anchor": { "v": 1, "exact": sealed.clone(), "start": 0 } })
        )
        .contains("sealed"),
        "the anchor of an about"
    );
    // The edge itself, with an anchor in the note's own words, is the member's to make.
    w.ok(
        "edge.add",
        json!({ "from": words, "rel": "about", "to": ada,
                "anchor": { "v": 1, "exact": "the bank", "start": 0 } }),
    );
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM edge WHERE anchor LIKE '%lk1:%'", &[]),
        0
    );
}
