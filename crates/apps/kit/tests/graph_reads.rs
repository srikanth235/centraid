//! The graph read through the door, pinned over a real vault (#1185): what `graph::incoming`,
//! `graph::outgoing` and `graph::owner` answer for edges and for the foreign-key columns of the
//! catalogue, so the one reader that plans them from `centraid_ontology::graph` can be moved
//! without a join appearing or going missing. Every assertion is a value or a count.

use centraid_apps_kit::graph::{self, Joined, Via};
use centraid_apps_kit::reads::FanOutBound;
use centraid_apps_kit::testdoor::TestDoor;
use centraid_vault::commands::Registry;
use centraid_vault::{Command, CommandStatus, Principal, Vault};
use serde_json::json;

const BOUND: FanOutBound = FanOutBound::new(50, 4);

struct World {
    dir: std::path::PathBuf,
    vault: Vault,
    registry: Registry,
}

impl Drop for World {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl World {
    fn new() -> Self {
        let dir = centraid_ontology::scratch::scratch_dir();
        std::fs::create_dir_all(&dir).expect("a scratch directory");
        let vault = Vault::create(dir.join("vault.db")).expect("a vault");
        vault.found("Home", "Owner").expect("founded");
        Self {
            dir,
            vault,
            registry: Registry::with_system_commands().expect("a registry"),
        }
    }

    fn id(&self, name: &str, input: serde_json::Value) -> String {
        let outcome = self
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
        outcome.output["id"].as_str().unwrap_or_default().to_owned()
    }
}

fn joined(from: &str, to: &str, relation: &str, via: Via) -> Joined {
    Joined {
        from: from.to_owned(),
        to: to.to_owned(),
        relation: relation.to_owned(),
        via,
    }
}

/// A vault with a person, a notebook, two notes in it that are about the person (one then
/// trashed), and a link from one note to the other.
struct Fixture {
    world: World,
    maya: String,
    book: String,
    first: String,
    trashed: String,
}

fn fixture() -> Fixture {
    let world = World::new();
    let maya = world.id("person.add", json!({"title": "Maya"}));
    let book = world.id(
        "container.create",
        json!({"kind": "notebook", "title": "Trips"}),
    );
    let first = world.id(
        "note.create",
        json!({"title": "Plan", "body": "x", "notebook_id": book}),
    );
    let trashed = world.id(
        "note.create",
        json!({"title": "Old", "body": "x", "notebook_id": book}),
    );
    for note in [&first, &trashed] {
        world.id(
            "edge.add",
            json!({"from": note, "rel": "about", "to": maya}),
        );
    }
    world.id(
        "edge.add",
        json!({"from": first, "rel": "links", "to": trashed}),
    );
    world.id("entity.trash", json!({"id": trashed}));
    Fixture {
        world,
        maya,
        book,
        first,
        trashed,
    }
}

fn read<T>(f: &Fixture, body: impl FnOnce(&TestDoor) -> T) -> T {
    f.world
        .vault
        .read(|connection| Ok(body(&TestDoor::new(connection))))
        .expect("reads")
}

#[test]
fn incoming_names_the_edges_that_end_at_an_id_and_the_columns_that_point_at_it() {
    let f = fixture();
    let (about, none, notebook) = read(&f, |door| {
        (
            graph::incoming(door, BOUND, &f.maya, "person", &["about"]).expect("reads"),
            graph::incoming(door, BOUND, &f.maya, "person", &[]).expect("reads"),
            graph::incoming(door, BOUND, &f.book, "notebook", &[]).expect("reads"),
        )
    });
    // The door does not resolve an end: a trashed note's edge is read, and the caller resolves it.
    let mut expected = vec![
        joined(&f.first, &f.maya, "about", Via::Edge),
        joined(&f.trashed, &f.maya, "about", Via::Edge),
    ];
    expected.sort();
    assert_eq!(about, expected);
    assert!(none.is_empty(), "no relation asked for, no edge read");
    // A notebook is pointed at by the column of each note in it, and by no edge.
    let mut expected = vec![
        joined(&f.first, &f.book, "notebook", Via::Column),
        joined(&f.trashed, &f.book, "notebook", Via::Column),
    ];
    expected.sort();
    assert_eq!(notebook, expected);
}

#[test]
fn outgoing_names_the_edges_that_start_at_the_ids_and_the_columns_of_their_kind() {
    let f = fixture();
    let (mixed, edges_only, wrong_kind, nobody) = read(&f, |door| {
        (
            graph::outgoing(
                door,
                BOUND,
                std::slice::from_ref(&f.first),
                "note",
                &["about", "links"],
            )
            .expect("reads"),
            graph::outgoing(
                door,
                BOUND,
                std::slice::from_ref(&f.first),
                "person",
                &["about"],
            )
            .expect("reads"),
            graph::outgoing(door, BOUND, std::slice::from_ref(&f.first), "note", &[])
                .expect("reads"),
            graph::outgoing(door, BOUND, &[], "note", &["about"]).expect("reads"),
        )
    });
    let mut expected = vec![
        joined(&f.first, &f.maya, "about", Via::Edge),
        joined(&f.first, &f.trashed, "links", Via::Edge),
        joined(&f.first, &f.book, "notebook", Via::Column),
    ];
    expected.sort();
    assert_eq!(mixed, expected);
    // The columns read are the kind's own: asked as a person, a note's notebook is not one.
    assert_eq!(
        edges_only,
        vec![joined(&f.first, &f.maya, "about", Via::Edge)]
    );
    // No relation asked for leaves the columns alone.
    assert_eq!(
        wrong_kind,
        vec![joined(&f.first, &f.book, "notebook", Via::Column)]
    );
    assert!(nobody.is_empty());
}

#[test]
fn the_owner_is_the_person_a_founded_vault_names() {
    let f = fixture();
    let owner = read(&f, |door| graph::owner(door).expect("reads"));
    assert!(owner.is_some_and(|id| !id.is_empty() && id != f.maya));
}

#[test]
fn the_door_and_the_connection_are_two_sources_of_one_reading() {
    use centraid_ontology::graph::{ConnectionSource, incoming, outgoing};
    let f = fixture();
    let first = [f.first.clone()];
    f.world
        .vault
        .read(|connection| {
            let door = TestDoor::new(connection);
            let source = ConnectionSource(connection);
            for (id, kind, rels) in [
                (&f.maya, "person", vec!["about"]),
                (&f.maya, "person", vec![]),
                (&f.book, "notebook", vec![]),
                (&f.trashed, "note", vec!["links", "about"]),
            ] {
                assert_eq!(
                    graph::incoming(&door, BOUND, id, kind, &rels).expect("the door reads"),
                    incoming(&source, id, kind, &rels).expect("the connection reads"),
                    "incoming {kind} {rels:?}"
                );
            }
            for (kind, rels) in [
                ("note", vec!["about", "links"]),
                ("note", vec![]),
                ("person", vec!["about"]),
            ] {
                assert_eq!(
                    graph::outgoing(&door, BOUND, &first, kind, &rels).expect("the door reads"),
                    outgoing(&source, &first, kind, &rels).expect("the connection reads"),
                    "outgoing {kind} {rels:?}"
                );
            }
            Ok(())
        })
        .expect("reads");
}

/// Two relations between the same pair are two edges of one `(from, to)`. A page that ends
/// between them used to lose the second, so the relations are read one at a time.
#[test]
fn a_page_that_ends_between_two_relations_of_one_pair_loses_neither() {
    let f = fixture();
    // `first` is about `maya` and links to `trashed` already; it is now about `other` and links
    // to `other` as well: four edges out, two of them the same pair.
    let other = f.world.id(
        "note.create",
        json!({"title": "Other", "body": "x", "notebook_id": f.book}),
    );
    for rel in ["about", "links"] {
        f.world.id(
            "edge.add",
            json!({"from": f.first, "rel": rel, "to": other}),
        );
    }
    // The pages end where the tie is: the third row out is the first of the pair, and the one
    // row in is half of it.
    let (narrow_out, narrow_in) = (FanOutBound::new(3, 4), FanOutBound::new(1, 4));
    let (out, back) = read(&f, |door| {
        (
            graph::outgoing(
                door,
                narrow_out,
                std::slice::from_ref(&f.first),
                "note",
                &["about", "links"],
            )
            .expect("reads"),
            graph::incoming(door, narrow_in, &other, "note", &["about", "links"]).expect("reads"),
        )
    });
    let edges = |joins: &[Joined]| {
        let mut found: Vec<Joined> = joins
            .iter()
            .filter(|join| join.via == Via::Edge)
            .cloned()
            .collect();
        found.sort();
        found
    };
    let mut expected = vec![
        joined(&f.first, &f.maya, "about", Via::Edge),
        joined(&f.first, &f.trashed, "links", Via::Edge),
        joined(&f.first, &other, "about", Via::Edge),
        joined(&f.first, &other, "links", Via::Edge),
    ];
    expected.sort();
    assert_eq!(edges(&out), expected, "every edge out, none twice");
    let mut expected = vec![
        joined(&f.first, &other, "about", Via::Edge),
        joined(&f.first, &other, "links", Via::Edge),
    ];
    expected.sort();
    assert_eq!(edges(&back), expected, "every edge in, none twice");
}
