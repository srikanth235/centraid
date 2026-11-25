//! The edges, by `edge_shape` (#1214 K5): the command accepts exactly the pairs the shape table
//! joins (`*` is any linkable kind, read from `entity_kind.linkable`), a purge takes an item's
//! edges with it, and the merge hook moves an item's whole graph onto another with no duplicate.
//! The database refuses the same bad rows by itself: `schema_rules.rs`.

mod common;

use centraid_vault::links;
use centraid_vault::model::{Kind, Rel};
use common::edge_shapes::SHAPES;
use common::world::World;
use serde_json::json;

#[test]
fn the_models_relations_are_the_shape_tables_and_the_commands_accept_the_same() {
    let w = World::new("graph_rels");
    let mut seeded = w.strings("SELECT DISTINCT rel FROM edge_shape ORDER BY rel", &[]);
    let mut named: Vec<String> = Rel::ALL.iter().map(|rel| rel.as_str().to_owned()).collect();
    seeded.sort();
    named.sort();
    assert_eq!(seeded, named);
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM edge_shape", &[]),
        SHAPES.len() as i64,
        "the generated list is the seed"
    );
}

#[test]
fn an_edge_is_added_exactly_where_a_shape_joins_the_two_kinds() {
    let w = World::new("graph_matrix");
    let linkable: Vec<Kind> = w.kinds_linkable(true);
    // The kinds a shape names, a linkable kind and a kind of each way of not being one that no shape
    // names (the whole kind matrix is the trigger's, in `schema_rules.rs`).
    let kinds: Vec<Kind> = [
        Kind::Album,
        Kind::Photo,
        Kind::List,
        Kind::Person,
        Kind::Tag,
        Kind::Note,
        Kind::Task,
        Kind::Document,
        Kind::LockerItem,
        Kind::Workout,
        Kind::Touch,
        Kind::Txn,
        Kind::Place,
        Kind::Event,
        Kind::Account,
        Kind::Reading,
        Kind::Thread,
        Kind::Notebook,
        Kind::Category,
    ]
    .to_vec();
    let firsts: Vec<String> = kinds.iter().map(|k| w.made(*k, "First")).collect();
    let seconds: Vec<String> = kinds.iter().map(|k| w.made(*k, "Second")).collect();
    let joins = |rel: Rel, from: Kind, to: Kind| {
        SHAPES.iter().any(|(r, f, t, _, _, _)| {
            *r == rel.as_str()
                && (*f == from.as_str() || (*f == "*" && linkable.contains(&from)))
                && (*t == to.as_str() || (*t == "*" && linkable.contains(&to)))
        })
    };
    let (mut accepted, mut refused) = (0, 0);
    for rel in Rel::ALL {
        // A relation that wears a label is given one; no other is.
        let labelled = SHAPES.iter().any(|s| s.0 == rel.as_str() && s.3.is_some());
        for (i, from) in kinds.iter().enumerate() {
            for (j, to) in kinds.iter().enumerate() {
                let mut input = json!({"from": &firsts[i], "rel": rel.as_str(), "to": &seconds[j]});
                if labelled {
                    input["label"] = json!("Friend");
                }
                let outcome = w.run("edge.add", input);
                let want = joins(rel, *from, *to);
                // The command reads a label only when the shape has one: a labelled relation given
                // a label on a pair it does not join is refused for the pair first.
                assert_eq!(
                    outcome.status == centraid_vault::CommandStatus::Executed,
                    want,
                    "{rel:?} {from:?} -> {to:?}: {:?}",
                    outcome.reason
                );
                if want {
                    accepted += 1;
                } else {
                    refused += 1;
                    assert!(
                        outcome
                            .reason
                            .as_deref()
                            .is_some_and(|s| s.contains("cannot be")),
                        "{rel:?} {from:?} -> {to:?}: {:?}",
                        outcome.reason
                    );
                }
            }
        }
    }
    assert!(accepted > 40 && refused > 2_000, "{accepted} {refused}");
}

#[test]
fn purging_an_item_takes_its_edges_with_it_by_the_tables_own_cascade() {
    let w = World::new("graph_purge");
    let (ada, grace) = (w.person("Ada"), w.person("Grace"));
    let note = w.note("About Ada");
    let album = w.container("album", "Trip");
    let photo = w.made(Kind::Photo, "Beach");
    w.ok(
        "edge.add",
        json!({"from": &note, "rel": "about", "to": &ada}),
    );
    w.ok(
        "edge.add",
        json!({"from": &photo, "rel": "depicts", "to": &ada}),
    );
    w.ok(
        "edge.add",
        json!({"from": &album, "rel": "contains", "to": &photo}),
    );
    w.ok(
        "edge.add",
        json!({"from": &ada, "rel": "related", "to": &grace, "label": "Friend"}),
    );
    w.ok("link.add", json!({"a": &ada, "b": &grace}));
    w.ok("tag.add", json!({"id": &ada, "label": "vip"}));
    w.ok("entity.trash", json!({"id": &ada}));
    w.ok("entity.purge", json!({"id": &ada}));
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM edge WHERE from_id = ?1 OR to_id = ?1",
            &[&ada]
        ),
        0
    );
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM link", &[]), 0);
    // What did not touch Ada stays.
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM edge WHERE rel = 'contains'", &[]),
        1
    );
    // Purging the photo takes it out of the album, and the album stays.
    w.ok("entity.trash", json!({"id": &photo}));
    w.ok("entity.purge", json!({"id": &photo}));
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM edge WHERE rel = 'contains'", &[]),
        0
    );
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM entity WHERE id = ?1", &[&album]),
        1
    );
}

#[test]
fn purging_a_relation_label_takes_the_edges_that_wore_it() {
    let w = World::new("graph_label_purge");
    let (ada, grace) = (w.person("Ada"), w.person("Grace"));
    let out = w.ok(
        "edge.add",
        json!({"from": &ada, "rel": "related", "to": &grace, "label": "Rival"}),
    );
    let label = out["label"].as_str().expect("a label").to_owned();
    // A relation is deleted, not trashed: the delete is the purge, and the edges that wore it go.
    w.ok("entity.purge", json!({"id": &label}));
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM edge WHERE rel = 'related'", &[]),
        0
    );
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM entity WHERE id = ?1", &[&grace]),
        1
    );
}

#[test]
fn merging_one_item_into_another_moves_its_edges_keeping_places_and_anchors_with_no_duplicate() {
    let w = World::new("graph_repoint");
    let (from, into, third) = (w.person("Alex"), w.person("Alexander"), w.person("Chris"));
    let list = w.container("list", "Family");
    let (n1, n2) = (w.note("One"), w.note("Two"));
    // `from` is in the list (at place 1) and so is `into` (at place 2): the survivor keeps its own.
    w.ok(
        "edge.add",
        json!({"from": &list, "rel": "contains", "to": &from, "position": 1}),
    );
    w.ok(
        "edge.add",
        json!({"from": &list, "rel": "contains", "to": &into, "position": 2}),
    );
    // A note about `from`, anchored; a note about both (one edge each way to keep).
    w.ok(
        "edge.add",
        json!({"from": &n1, "rel": "about", "to": &from, "anchor": {"at": 4}}),
    );
    w.ok(
        "edge.add",
        json!({"from": &n2, "rel": "about", "to": &from}),
    );
    w.ok(
        "edge.add",
        json!({"from": &n2, "rel": "about", "to": &into}),
    );
    // `from` is related to a third person, and to `into` (which would become related to itself).
    w.ok(
        "edge.add",
        json!({"from": &from, "rel": "related", "to": &third, "label": "Cousin"}),
    );
    w.ok(
        "edge.add",
        json!({"from": &from, "rel": "related", "to": &into, "label": "Cousin"}),
    );
    w.ok(
        "edge.add",
        json!({"from": &third, "rel": "related", "to": &from, "label": "Cousin"}),
    );
    w.ok("tag.add", json!({"id": &from, "label": "vip"}));
    w.ok("tag.add", json!({"id": &into, "label": "vip"}));
    let moved = w
        .vault()
        .commit(|tx| links::repoint(tx.connection(), &from, &into))
        .expect("merged")
        .value;
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM edge WHERE from_id = ?1 OR to_id = ?1 OR label_id = ?1",
            &[&from]
        ),
        0,
        "nothing is left on the one merged away"
    );
    assert!(moved.edges >= 3, "{moved:?}");
    // The list holds the survivor once, at the place it already had.
    assert_eq!(
        w.one::<f64>(
            "SELECT position FROM edge WHERE from_id = ?1 AND to_id = ?2",
            &[&list, &into]
        ),
        2.0
    );
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM edge WHERE from_id = ?1", &[&list]),
        1
    );
    // The anchored note moved with its anchor intact.
    assert_eq!(
        w.one::<i64>(
            "SELECT json_extract(anchor, '$.at') FROM edge WHERE from_id = ?1 AND to_id = ?2",
            &[&n1, &into]
        ),
        4
    );
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM edge WHERE from_id = ?1 AND to_id = ?2",
            &[&n2, &into]
        ),
        1
    );
    // `related` to itself is dropped; the third person's relation is now to the survivor.
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM edge WHERE from_id = to_id", &[]),
        0
    );
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM edge WHERE from_id = ?1 AND to_id = ?2 AND rel = 'related'",
            &[&into, &third]
        ),
        1
    );
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM edge WHERE from_id = ?1 AND to_id = ?2 AND rel = 'related'",
            &[&third, &into]
        ),
        1
    );
    // The word both wore is one tag on the survivor.
    assert_eq!(
        w.one::<i64>(
            "SELECT COUNT(*) FROM edge WHERE from_id = ?1 AND rel = 'tagged'",
            &[&into]
        ),
        1
    );
    // Mentions that named the old item name the survivor.
    w.commit(|tx| {
        tx.connection().execute(
            "INSERT INTO mention (note_id, ordinal, wikilink, to_id) VALUES (?1, 0, 'Alex', ?2)",
            [&n1, &third],
        )?;
        Ok(())
    });
    let again = w.person("Alexa");
    w.commit(|tx| {
        tx.connection().execute(
            "UPDATE mention SET to_id = ?1 WHERE note_id = ?2",
            [&again, &n1],
        )?;
        Ok(())
    });
    let moved = w
        .vault()
        .commit(|tx| links::repoint(tx.connection(), &again, &into))
        .expect("merged")
        .value;
    assert_eq!(moved.mentions, 1);
    assert_eq!(
        w.one::<String>("SELECT to_id FROM mention WHERE note_id = ?1", &[&n1]),
        into
    );
}
