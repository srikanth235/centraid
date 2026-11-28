//! The shared verbs that join two things (`edge.*`, #1214 K5): what `edge_shape` allows and the
//! sentence when it does not, a relation's label, an ordered list, an anchor, and which edge touches
//! the note it is part of. The rules a sentence states are held by the database too:
//! `schema_rules.rs` writes each bad row with raw SQL.

mod common;

use centraid_vault::model::Kind;
use common::world::{AT, World};
use serde_json::json;

fn edges(w: &World, rel: &str) -> i64 {
    w.one("SELECT COUNT(*) FROM edge WHERE rel = ?1", &[rel])
}

#[test]
fn an_edge_joins_what_edge_shape_allows_and_says_so_in_a_sentence_when_it_does_not() {
    let w = World::new("edges_sentences");
    let (ada, grace) = (w.person("Ada"), w.person("Grace"));
    let note = w.note("Note");
    let album = w.container("album", "Trip");
    let refusal = w.refused(
        "edge.add",
        json!({"from": &album, "rel": "contains", "to": &note}),
    );
    assert!(refusal.contains("cannot be `contains`"), "{refusal}");
    assert!(
        w.refused(
            "edge.add",
            json!({"from": &ada, "rel": "related", "to": &grace})
        )
        .contains("say how")
    );
    assert!(
        w.refused(
            "edge.add",
            json!({"from": &ada, "rel": "with", "to": &grace})
        )
        .contains("cannot be `with`")
    );
    assert!(
        w.refused(
            "edge.add",
            json!({"from": &ada, "rel": "related", "to": &ada, "label": "self"})
        )
        .contains("itself")
    );
    // A place only where the relation is ordered, a label only where it is labelled, an anchor
    // only where a note's words point.
    assert!(
        w.refused(
            "edge.add",
            json!({"from": &note, "rel": "about", "to": &ada, "position": 1})
        )
        .contains("has a place")
    );
    assert!(
        w.refused(
            "edge.add",
            json!({"from": &note, "rel": "about", "to": &ada, "label": "x"})
        )
        .contains("only a relation is labelled")
    );
    let task = w.made(Kind::Task, "Call");
    assert!(
        w.refused(
            "edge.add",
            json!({"from": &task, "rel": "about", "to": &ada, "anchor": {"at": 3}})
        )
        .contains("point at a place")
    );
    // An end that is no linkable kind is no end of a `*` shape: a label, a chat, a reading.
    for kind in [Kind::Tag, Kind::Thread, Kind::Reading, Kind::Album] {
        let other = w.made(kind, "x");
        assert!(
            w.refused(
                "edge.add",
                json!({"from": &note, "rel": "about", "to": &other})
            )
            .contains("cannot be `about`"),
            "{kind:?}"
        );
    }
    assert_eq!(edges(&w, "about"), 0, "a refusal writes nothing");
}

#[test]
fn a_relation_label_is_a_concept_the_member_names_found_by_its_key_and_never_built() {
    let w = World::new("edges_labels");
    let (ada, grace) = (w.person("Ada"), w.person("Grace"));
    let out = w.ok(
        "edge.add",
        json!({"from": &ada, "rel": "related", "to": &grace, "label": "Colleague"}),
    );
    let label = out["label"].as_str().expect("a label id").to_owned();
    assert!(
        centraid_vault::model::is_minted_id(&label),
        "a member's relation has a minted id, not a built `relation:colleague`: {label}"
    );
    assert_eq!(
        w.one::<String>(
            "SELECT kind || '/' || key FROM concept WHERE id = ?1",
            &[&label]
        ),
        "relation/colleague"
    );
    assert_eq!(
        w.one::<String>("SELECT title FROM entity WHERE id = ?1", &[&label]),
        "Colleague"
    );
    // The same word in other letters is the same relation, and adding twice is one edge.
    let again = w.ok(
        "edge.add",
        json!({"from": &ada, "rel": "related", "to": &grace, "label": "  colleague "}),
    );
    assert_eq!(again["label"], label.as_str());
    assert_eq!(edges(&w, "related"), 1, "adding is idempotent");
    // A relation the vault is founded with is found the same way.
    let seeded = w.ok(
        "edge.add",
        json!({"from": &ada, "rel": "related", "to": &grace, "label": "Related"}),
    );
    assert_eq!(seeded["label"], "relation:related");
    assert_eq!(edges(&w, "related"), 2, "a second label is a second edge");
    // Taking it off goes by the words, and only that label's edge goes.
    assert_eq!(
        w.ok(
            "edge.remove",
            json!({"from": &ada, "rel": "related", "to": &grace, "label": "COLLEAGUE"})
        )["removed"],
        true
    );
    assert_eq!(edges(&w, "related"), 1);
    assert_eq!(
        w.ok(
            "edge.remove",
            json!({"from": &ada, "rel": "related", "to": &grace, "label": "nobody has this word"})
        )["removed"],
        false
    );
    assert_eq!(edges(&w, "related"), 1);
    // The relation label stays a word the member made, to be offered again.
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM concept WHERE id = ?1", &[&label]),
        1
    );
}

#[test]
fn an_ordered_relation_keeps_a_place_and_an_item_is_moved_by_one_update() {
    let w = World::new("edges_order");
    for (kind, holder_kind) in [("list", "person"), ("album", "photo")] {
        let holder = w.container(kind, "Holder");
        let members: Vec<String> = ["Ann", "Bo", "Cy"]
            .iter()
            .map(|name| match holder_kind {
                "person" => w.person(name),
                _ => w.made(Kind::Photo, name),
            })
            .collect();
        for id in &members {
            w.ok(
                "edge.add",
                json!({"from": &holder, "rel": "contains", "to": id}),
            );
        }
        let order = || {
            w.strings(
                "SELECT to_id FROM edge WHERE from_id = ?1 AND rel = 'contains' ORDER BY position",
                &[&holder],
            )
        };
        assert_eq!(order(), members, "appended in the order they were added");
        let positions: Vec<f64> = w
            .vault()
            .read(|c| {
                let mut s =
                    c.prepare("SELECT position FROM edge WHERE from_id = ?1 ORDER BY position")?;
                Ok(s.query_map([&holder], |r| r.get(0))?
                    .collect::<rusqlite::Result<Vec<f64>>>()?)
            })
            .expect("reads");
        assert_eq!(positions, [1.0, 2.0, 3.0]);
        // One update moves the last to the front; its neighbours are not rewritten.
        let before = w.one::<f64>(
            "SELECT position FROM edge WHERE from_id = ?1 AND to_id = ?2",
            &[&holder, &members[0]],
        );
        w.ok(
            "edge.move",
            json!({"from": &holder, "to": &members[2], "position": 0.5}),
        );
        assert_eq!(
            order(),
            [members[2].clone(), members[0].clone(), members[1].clone()]
        );
        assert_eq!(
            w.one::<f64>(
                "SELECT position FROM edge WHERE from_id = ?1 AND to_id = ?2",
                &[&holder, &members[0]]
            ),
            before
        );
        // Adding one that is already there does not move it.
        w.ok(
            "edge.add",
            json!({"from": &holder, "rel": "contains", "to": &members[0]}),
        );
        assert_eq!(
            order(),
            [members[2].clone(), members[0].clone(), members[1].clone()]
        );
        assert!(
            w.refused(
                "edge.move",
                json!({"from": &holder, "to": "nobody", "position": 1})
            )
            .contains("not in this list")
        );
    }
    // What keeps no place cannot be moved.
    let (note, ada) = (w.note("N"), w.person("Ada"));
    w.ok(
        "edge.add",
        json!({"from": &note, "rel": "about", "to": &ada}),
    );
    assert!(
        w.refused(
            "edge.move",
            json!({"from": &note, "to": &ada, "position": 1})
        )
        .contains("not in this list")
    );
}

#[test]
fn a_notes_about_takes_an_anchor_with_its_version_and_touches_the_note_and_no_other_edge_does() {
    let w = World::new("edges_touch");
    let (mum, note, other) = (w.person("Mum"), w.note("Call"), w.note("Other"));
    let task = w.made(Kind::Task, "Ring");
    let before = w.stamp(&note);
    assert_eq!(before, AT);
    w.ok(
        "edge.add",
        json!({"from": &note, "rel": "about", "to": &mum}),
    );
    let about = w.stamp(&note);
    assert_ne!(about, AT, "an about edge touches the note at its start");
    assert_eq!(w.stamp(&mum), AT, "the person is re-indexed, not touched");
    // Another note, anchored: the place in the text is a JSON object the vault versions.
    w.ok(
        "edge.add",
        json!({"from": &other, "rel": "about", "to": &note, "anchor": {"from": 3, "to": 9}}),
    );
    let anchor = w.one::<String>("SELECT anchor FROM edge WHERE from_id = ?1", &[&other]);
    let parsed: serde_json::Value = serde_json::from_str(&anchor).expect("json");
    assert_eq!(parsed, json!({"v": 1, "from": 3, "to": 9}));
    // A task about a person is not part of a note's words: it keeps its place in Recents.
    w.ok(
        "edge.add",
        json!({"from": &task, "rel": "about", "to": &mum}),
    );
    assert_eq!(w.stamp(&task), AT);
    // Removing the about edge touches the note; removing what is not there changes nothing.
    w.ok(
        "edge.remove",
        json!({"from": &note, "rel": "about", "to": &mum}),
    );
    let removed = w.stamp(&note);
    assert_ne!(removed, about);
    assert_eq!(
        w.ok(
            "edge.remove",
            json!({"from": &note, "rel": "about", "to": &mum})
        )["removed"],
        false
    );
    assert_eq!(w.stamp(&note), removed);
    // Adding the same edge with an anchor later sets it; the edge stays one.
    w.ok(
        "edge.add",
        json!({"from": &other, "rel": "about", "to": &note}),
    );
    assert_eq!(
        edges(&w, "about"),
        2,
        "the anchored edge stays one, and the task's"
    );
    assert_eq!(
        w.one::<String>("SELECT anchor FROM edge WHERE from_id = ?1", &[&other]),
        anchor,
        "an add without an anchor keeps the one it has"
    );
}
