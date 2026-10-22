//! THE FTS DOOR over the vault's one index, against a vault the product founds.
//!
//! Every entity here is written the way a command writes it (`CommitTx::
//! insert_entity` and a kind row, then the guard re-indexes at commit) and
//! changed through the shared verbs, so what is proved is the door over the
//! index the writer keeps, not over a fixture of the door's own.

use centraid_search::sqlite::SqliteDoor;
use centraid_search::{Answer, Principal, Search, SearchError, SearchRequest};
use centraid_vault::commands::Registry;
use centraid_vault::model::Kind;
use centraid_vault::{Command, CommandStatus, Principal as VaultPrincipal, Vault};

struct World {
    _dir: tempfile::TempDir,
    vault: Vault,
    registry: Registry,
}

impl World {
    fn new() -> Self {
        let dir = tempfile::tempdir().expect("a directory");
        let vault = Vault::create(dir.path().join("vault.db")).expect("a vault");
        vault.found("Search", "Ada").expect("founded");
        Self {
            _dir: dir,
            vault,
            registry: Registry::with_system_commands().expect("a registry"),
        }
    }

    fn note(&self, id: &str, title: &str, body: &str) {
        let now = self.vault.clock().now_text();
        self.vault
            .commit(|tx| {
                tx.insert_entity(id, Kind::Note, title, &now)?;
                tx.connection()
                    .execute("INSERT INTO note (id, body) VALUES (?1, ?2)", [id, body])?;
                Ok(())
            })
            .expect("the note lands");
    }

    fn person(&self, id: &str, name: &str, nickname: Option<&str>) {
        let now = self.vault.clock().now_text();
        self.vault
            .commit(|tx| {
                tx.insert_entity(id, Kind::Person, name, &now)?;
                tx.connection().execute(
                    "INSERT INTO person (id, nickname) VALUES (?1, ?2)",
                    rusqlite::params![id, nickname],
                )?;
                Ok(())
            })
            .expect("the person lands");
    }

    fn run(&self, name: &str, input: serde_json::Value) {
        let outcome = self
            .vault
            .execute(
                &self.registry,
                &VaultPrincipal::owner("phone"),
                &Command::new(name, input),
            )
            .unwrap_or_else(|error| panic!("`{name}`: {error}"));
        assert_eq!(
            outcome.status,
            CommandStatus::Executed,
            "{name}: {:?}",
            outcome.reason
        );
    }

    fn ask(&self, kinds: &[&str], query: &str) -> Vec<(String, String)> {
        self.answer(&request(kinds, query, 50))
            .targets()
            .expect("data")
            .iter()
            .map(|target| (target.entity.clone(), target.id.clone()))
            .collect()
    }

    fn answer(&self, request: &SearchRequest) -> Answer {
        self.vault
            .read(|connection| {
                Ok(SqliteDoor::open(connection)
                    .and_then(|door| door.query(&Principal::Owner, request))
                    .expect("the door answers"))
            })
            .expect("reads")
    }
}

fn request(kinds: &[&str], query: &str, limit: usize) -> SearchRequest {
    SearchRequest::across(kinds.iter().map(|kind| (*kind).to_owned()), query, limit)
}

fn ids(found: &[(String, String)]) -> Vec<&str> {
    found.iter().map(|(_, id)| id.as_str()).collect()
}

#[test]
fn a_title_and_a_body_are_both_found_and_a_title_outranks_a_body() {
    let world = World::new();
    world.note("body", "Packing", "the cabin is cold in winter");
    world.note("title", "Cabin", "keys under the mat");
    let found = world.ask(&["note"], "cabin");
    assert_eq!(ids(&found), ["title", "body"], "title weighs twice a body");
}

#[test]
fn a_kind_filter_narrows_and_none_means_every_searchable_kind() {
    let world = World::new();
    world.note("n1", "Cabin plans", "");
    world.person("p1", "Cabin Crew", None);
    assert_eq!(ids(&world.ask(&["note"], "cabin")), ["n1"]);
    assert_eq!(ids(&world.ask(&["person"], "cabin")), ["p1"]);
    let both = world.ask(&[], "cabin");
    assert_eq!(both.len(), 2);
    assert!(both.iter().any(|(kind, _)| kind == "note"));
    assert!(both.iter().any(|(kind, _)| kind == "person"));
}

#[test]
fn a_trashed_entity_is_not_found_and_comes_back_with_its_restore() {
    let world = World::new();
    world.note("n1", "Lighthouse", "a tall light");
    assert_eq!(ids(&world.ask(&["note"], "lighthouse")), ["n1"]);
    world.run("entity.trash", serde_json::json!({"id": "n1"}));
    assert!(world.ask(&["note"], "lighthouse").is_empty());
    world.run("entity.restore", serde_json::json!({"id": "n1"}));
    assert_eq!(ids(&world.ask(&["note"], "lighthouse")), ["n1"]);
    world.run("entity.trash", serde_json::json!({"id": "n1"}));
    world.run("entity.purge", serde_json::json!({"id": "n1"}));
    assert!(world.ask(&["note"], "lighthouse").is_empty());
}

#[test]
fn a_person_is_found_by_the_notes_written_about_them_and_loses_them_with_the_edge() {
    let world = World::new();
    world.person("mum", "Mum", None);
    world.note("n1", "Birthday", "she loves ranunculus flowers");
    assert!(world.ask(&["person"], "ranunculus").is_empty());
    world.run(
        "edge.add",
        serde_json::json!({"from": "n1", "rel": "about", "to": "mum"}),
    );
    assert_eq!(ids(&world.ask(&["person"], "ranunculus")), ["mum"]);
    // The note's own words move the person's text with them.
    world
        .vault
        .commit(|tx| {
            tx.connection().execute(
                "UPDATE note SET body = 'she loves tulips' WHERE id = 'n1'",
                [],
            )?;
            tx.touch("n1", "2026-01-02T00:00:00.000Z")?;
            Ok(())
        })
        .expect("the note changes");
    assert!(world.ask(&["person"], "ranunculus").is_empty());
    assert_eq!(ids(&world.ask(&["person"], "tulips")), ["mum"]);
    // A trashed note is not "live": the person forgets it.
    world.run("entity.trash", serde_json::json!({"id": "n1"}));
    assert!(world.ask(&["person"], "tulips").is_empty());
    world.run("entity.restore", serde_json::json!({"id": "n1"}));
    assert_eq!(ids(&world.ask(&["person"], "tulips")), ["mum"]);
    world.run(
        "edge.remove",
        serde_json::json!({"from": "n1", "rel": "about", "to": "mum"}),
    );
    assert!(world.ask(&["person"], "tulips").is_empty());
}

#[test]
fn a_person_is_found_by_a_nickname_and_by_a_contact_point() {
    let world = World::new();
    world.person("p1", "Margaret", Some("Peggy"));
    world
        .vault
        .commit(|tx| {
            tx.connection().execute(
                "INSERT INTO contact_point (id, person_id, kind, value, normalized, position)
                 VALUES ('c1', 'p1', 'email', 'peggy@orchard.example', 'peggy@orchard.example', 1)",
                [],
            )?;
            tx.touch("p1", "2026-01-02T00:00:00.000Z")?;
            Ok(())
        })
        .expect("the contact point lands");
    assert_eq!(ids(&world.ask(&["person"], "peggy")), ["p1"]);
    assert_eq!(ids(&world.ask(&["person"], "orchard")), ["p1"]);
}

#[test]
fn a_window_continues_by_keyset_without_repeating_or_dropping_a_row() {
    let world = World::new();
    for index in 0..5 {
        world.note(&format!("n{index}"), "Garden", "");
    }
    let mut seen = Vec::new();
    let mut after = None;
    loop {
        let mut asked = request(&["note"], "garden", 2);
        asked.page.after = after.take();
        let Answer::Data { page, window } = world.answer(&asked) else {
            panic!("data");
        };
        assert_eq!(window, 2);
        seen.extend(page.rows.iter().map(|target| target.id.clone()));
        match page.next {
            Some(next) => after = Some(next),
            None => break,
        }
    }
    seen.sort();
    assert_eq!(seen, ["n0", "n1", "n2", "n3", "n4"]);
}

#[test]
fn the_door_reports_the_window_it_applied() {
    let world = World::new();
    world.note("n1", "Garden", "");
    let Answer::Data { window, .. } = world.answer(&request(&["note"], "garden", 5_000)) else {
        panic!("data");
    };
    assert_eq!(window, centraid_search::MAX_MATCH_ROWS);
}

#[test]
fn excluded_ids_and_unlabelled_entities_are_predicates_not_a_post_filter() {
    let world = World::new();
    world.note("keep", "Garden", "");
    world.note("skip", "Garden", "");
    world.note("blank", "", "garden garden garden");
    let found = world
        .answer(&request(&["note"], "garden", 1).excluding(vec!["skip".to_owned()]))
        .targets()
        .expect("data")
        .iter()
        .map(|target| target.id.clone())
        .collect::<Vec<_>>();
    assert_eq!(found, ["keep"], "an unlabelled note is not a target");
}

#[test]
fn a_snippet_marks_the_words_that_matched() {
    let world = World::new();
    world.note("n1", "Plans", "we drive to the cabin by the lake on friday");
    let Answer::Data { page, .. } = world.answer(&request(&["note"], "cabin", 5)) else {
        panic!("data");
    };
    assert_eq!(
        page.rows[0].snippet,
        "we drive to the ⟦cabin⟧ by the lake on friday"
    );
    assert_eq!(page.rows[0].subtitle, "note");
    // A hit on the title alone has no body words to mark.
    let Answer::Data { page, .. } = world.answer(&request(&["note"], "plans", 5)) else {
        panic!("data");
    };
    assert_eq!(page.rows[0].snippet, "");
}

#[test]
fn locker_and_every_kind_nobody_searches_is_refused_by_name() {
    let world = World::new();
    for kind in ["locker.item", "locker_item", "flag", "account", "calendar"] {
        let refused = world
            .vault
            .read(|connection| {
                Ok(SqliteDoor::open(connection)
                    .and_then(|door| door.query(&Principal::Owner, &request(&[kind], "x", 5))))
            })
            .expect("reads");
        assert!(
            matches!(refused, Err(SearchError::NotSearchable { .. })),
            "{kind}: {refused:?}"
        );
    }
    // And nothing of Locker's is in the index to find.
    let rows: i64 = world
        .vault
        .read(|connection| {
            Ok(connection.query_row("SELECT COUNT(*) FROM search", [], |row| row.get(0))?)
        })
        .expect("counts");
    assert_eq!(
        rows, 1,
        "only the self person is indexed in a founded vault"
    );
}

#[test]
fn a_query_with_no_searchable_word_is_a_typed_refusal() {
    let world = World::new();
    let refused = world
        .vault
        .read(|connection| {
            Ok(SqliteDoor::open(connection)
                .and_then(|door| door.query(&Principal::Owner, &request(&["note"], "?! ..", 5))))
        })
        .expect("reads");
    assert!(matches!(
        refused,
        Err(SearchError::NoSearchableWords { .. })
    ));
}

#[test]
fn a_typo_is_corrected_to_a_word_the_vault_holds_and_a_held_word_is_left_alone() {
    let world = World::new();
    world.note("n1", "Budget", "the spring budget");
    let correct = |query: &str| {
        world
            .vault
            .read(|connection| {
                Ok(SqliteDoor::open(connection)
                    .and_then(|door| door.correct(&Principal::Owner, &["note"], query))
                    .expect("corrects"))
            })
            .expect("reads")
    };
    assert_eq!(correct("budegt").as_deref(), Some("budget"));
    assert_eq!(correct("budget"), None, "a held word is kept as typed");
    assert_eq!(
        correct("zzzzzz"),
        None,
        "a word near nothing is not invented"
    );
    // Locker has no vocabulary to ask.
    let refused = world
        .vault
        .read(|connection| {
            Ok(SqliteDoor::open(connection)
                .and_then(|door| door.correct(&Principal::Owner, &["locker.item"], "budegt")))
        })
        .expect("reads");
    assert!(matches!(refused, Err(SearchError::NotSearchable { .. })));
}

#[test]
fn a_file_without_the_index_does_not_open() {
    let connection = rusqlite::Connection::open_in_memory().expect("a connection");
    assert!(matches!(
        SqliteDoor::open(&connection),
        Err(SearchError::IndexUnusable { .. })
    ));
}
