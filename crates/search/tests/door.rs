//! THE FTS DOOR over the vault's one index, against a vault the product founds.
//!
//! Every entity here is written the way a command writes it (`CommitTx::
//! insert_entity` and a kind row, then the guard re-indexes at commit) and
//! changed through the shared verbs, so what is proved is the door over the
//! index the writer keeps, not over a fixture of the door's own.

use centraid_search::sqlite::SqliteDoor;
use centraid_search::{Answer, EachRequest, Principal, Search, SearchError, SearchRequest, Target};
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

    /// Many notes in one commit, oldest first: `count` notes titled `title`
    /// with `body`, ids `{prefix}{index}`.
    fn notes(&self, prefix: &str, count: usize, title: &str, body: &str) {
        let now = self.vault.clock().now_text();
        self.vault
            .commit(|tx| {
                for index in 0..count {
                    let id = format!("{prefix}{index:04}");
                    tx.insert_entity(&id, Kind::Note, title, &now)?;
                    tx.connection().execute(
                        "INSERT INTO note (id, body) VALUES (?1, ?2)",
                        [id.as_str(), body],
                    )?;
                }
                Ok(())
            })
            .expect("the notes land");
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

    /// Every row of a search, window after window.
    fn walk(&self, mut asked: SearchRequest) -> Vec<(String, String)> {
        let mut rows = Vec::new();
        loop {
            let Answer::Data { page, .. } = self.answer(&asked) else {
                panic!("data");
            };
            rows.extend(page.rows.iter().map(|t| (t.entity.clone(), t.id.clone())));
            match page.next {
                Some(next) => asked.page.after = Some(next),
                None => return rows,
            }
        }
    }

    fn answer(&self, request: &SearchRequest) -> Answer {
        self.vault
            .read(|connection| {
                Ok(SqliteDoor::open(connection, self.vault.words())
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
fn every_kind_nobody_searches_is_refused_by_name() {
    let world = World::new();
    for kind in ["locker.item", "flag", "account", "calendar"] {
        let refused = world
            .vault
            .read(|connection| {
                Ok(SqliteDoor::open(connection, world.vault.words())
                    .and_then(|door| door.query(&Principal::Owner, &request(&[kind], "x", 5))))
            })
            .expect("reads");
        assert!(
            matches!(refused, Err(SearchError::NotSearchable { .. })),
            "{kind}: {refused:?}"
        );
    }
    // And a vault with no Locker item has none in the index.
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
            Ok(SqliteDoor::open(connection, world.vault.words())
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
                Ok(SqliteDoor::open(connection, world.vault.words())
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
            Ok(SqliteDoor::open(connection, world.vault.words())
                .and_then(|door| door.correct(&Principal::Owner, &["locker.item"], "budegt")))
        })
        .expect("reads");
    assert!(matches!(refused, Err(SearchError::NotSearchable { .. })));
}

#[test]
fn a_file_without_the_index_does_not_open() {
    let connection = rusqlite::Connection::open_in_memory().expect("a connection");
    assert!(matches!(
        SqliteDoor::open(&connection, &centraid_vault::words::Words::default()),
        Err(SearchError::IndexUnusable { .. })
    ));
}

// -- the two tiers --------------------------------------------------------------

#[test]
fn a_title_match_is_answered_before_a_body_match_whatever_the_score_and_the_age() {
    let world = World::new();
    // The title match is the OLDEST row and the body match repeats the word, which
    // is what a bm25 score alone would put first.
    world.note("title", "Orchard", "");
    world.note(
        "body",
        "Planting",
        "orchard orchard orchard orchard orchard orchard",
    );
    assert_eq!(ids(&world.ask(&["note"], "orchard")), ["title", "body"]);
    // A title match and a body match of ANOTHER word are not both title matches.
    world.note("split", "Orchard", "keys");
    let found = world.ask(&["note"], "orchard keys");
    assert_eq!(
        ids(&found),
        ["split"],
        "all the words are in the title or not at all"
    );
}

#[test]
fn the_tail_is_the_newest_five_hundred_and_a_title_match_is_never_cut() {
    let world = World::new();
    world.note("old-title", "Garden", "");
    world.notes(
        "n",
        centraid_search::TAIL_ROWS + 20,
        "Plain",
        "garden garden",
    );
    let found = world.walk(request(&["note"], "garden", 200));
    // The title match first, then exactly the cap: the 20 oldest body matches
    // are the ones left out.
    assert_eq!(found.len(), 1 + centraid_search::TAIL_ROWS);
    assert_eq!(found[0].1, "old-title");
    assert!(!found.iter().any(|(_, id)| id == "n0000" || id == "n0019"));
    assert!(found.iter().any(|(_, id)| id == "n0020"));
}

#[test]
fn a_one_kind_search_is_not_starved_by_newer_matches_of_other_kinds() {
    let world = World::new();
    // The only person that matches only in a body is OLDER than more than the cap
    // of newer notes that match too.
    world.person("p1", "Margaret", Some("Orchardkeeper"));
    world.notes(
        "n",
        centraid_search::TAIL_ROWS + 20,
        "Plain",
        "orchardkeeper",
    );
    assert_eq!(ids(&world.ask(&["person"], "orchardkeeper")), ["p1"]);
    // The kind, trash and excluded-id filters sit inside the cap, so excluding
    // the newest notes lets older ones fill it.
    let excluded: Vec<String> = (centraid_search::TAIL_ROWS..centraid_search::TAIL_ROWS + 20)
        .map(|index| format!("n{index:04}"))
        .collect();
    let found = world.walk(request(&["note"], "orchardkeeper", 200).excluding(excluded));
    assert_eq!(found.len(), centraid_search::TAIL_ROWS);
}

#[test]
fn a_window_continues_across_the_tiers_without_repeating_or_dropping_a_row() {
    let world = World::new();
    for index in 0..3 {
        world.note(&format!("t{index}"), "Garden", "");
    }
    for index in 0..4 {
        world.note(&format!("b{index}"), "Plain", "garden");
    }
    let mut seen = Vec::new();
    let mut after = None;
    let mut pages = 0;
    loop {
        let mut asked = request(&["note"], "garden", 2);
        asked.page.after = after.take();
        let Answer::Data { page, .. } = world.answer(&asked) else {
            panic!("data");
        };
        pages += 1;
        seen.extend(page.rows.iter().map(|target| target.id.clone()));
        match page.next {
            Some(next) => {
                assert!(next.sort_key.contains(':'), "a tier and a rank: {next:?}");
                after = Some(next);
            }
            None => break,
        }
    }
    assert_eq!(pages, 4);
    assert_eq!(seen.len(), 7);
    // Tier 0 first (the three titles), then the bodies.
    assert!(seen[..3].iter().all(|id| id.starts_with('t')), "{seen:?}");
    assert!(seen[3..].iter().all(|id| id.starts_with('b')), "{seen:?}");
    let mut unique = seen.clone();
    unique.sort();
    unique.dedup();
    assert_eq!(unique.len(), 7);
}

#[test]
fn a_cursor_that_is_not_a_tier_and_a_rank_is_refused() {
    let world = World::new();
    world.note("n1", "Garden", "");
    let mut asked = request(&["note"], "garden", 2);
    asked.page.after = Some(centraid_apps_kit::page::PageCursor {
        sort_key: "-1.5".to_owned(),
        pk: "n1".to_owned(),
    });
    let refused = world
        .vault
        .read(|connection| {
            Ok(SqliteDoor::open(connection, world.vault.words())
                .and_then(|door| door.query(&Principal::Owner, &asked)))
        })
        .expect("reads");
    assert!(
        matches!(refused, Err(SearchError::Sqlite(_))),
        "{refused:?}"
    );
}

#[test]
fn a_query_of_one_character_words_is_the_empty_query() {
    let world = World::new();
    world.note("n1", "Apple", "a b c");
    for query in ["a", "a b", " x "] {
        let refused = world
            .vault
            .read(|connection| {
                Ok(SqliteDoor::open(connection, world.vault.words())
                    .and_then(|door| door.query(&Principal::Owner, &request(&["note"], query, 5))))
            })
            .expect("reads");
        assert!(
            matches!(refused, Err(SearchError::NoSearchableWords { .. })),
            "{query:?}: {refused:?}"
        );
    }
    assert_eq!(ids(&world.ask(&["note"], "ap")), ["n1"]);
}

// -- several kinds, one statement ------------------------------------------------

impl World {
    fn each(&self, request: &EachRequest) -> Result<Vec<Target>, SearchError> {
        self.vault
            .read(|connection| {
                Ok(SqliteDoor::open(connection, self.vault.words())
                    .and_then(|door| door.query_each(&Principal::Owner, request)))
            })
            .expect("reads")
    }
}

fn each(kinds: &[&str], query: &str, per_kind: usize) -> EachRequest {
    EachRequest::new(kinds.iter().map(|kind| (*kind).to_owned()), query, per_kind)
}

#[test]
fn one_statement_answers_a_few_rows_of_each_kind_in_the_order_the_kinds_were_named() {
    let world = World::new();
    for index in 0..4 {
        world.note(&format!("n{index}"), "Garden", "");
    }
    world.note("body", "Plain", "garden");
    world.person("p1", "Garden Gus", None);
    world.person("p2", "Margaret", Some("Gardener"));
    let found = world
        .each(&each(&["person", "note"], "garden", 2))
        .expect("answers");
    let kinds: Vec<&str> = found.iter().map(|t| t.entity.as_str()).collect();
    assert_eq!(kinds, ["person", "person", "note", "note"], "{found:?}");
    // Best first inside a kind: a title match before a body match.
    assert_eq!(found[0].id, "p1");
    assert_eq!(found[1].id, "p2");
    // Fewer than the cap is all there is.
    let one = world
        .each(&each(&["person"], "garden", 8))
        .expect("answers");
    assert_eq!(one.len(), 2);
    // A kind with no match is no rows, and the other kinds still answer.
    let none = world
        .each(&each(&["event", "person"], "garden", 8))
        .expect("answers");
    assert_eq!(none.len(), 2);
}

#[test]
fn the_per_kind_door_honours_the_filters_the_window_door_does() {
    let world = World::new();
    world.note("keep", "Garden", "");
    world.note("skip", "Garden", "");
    world.note("gone", "Garden", "");
    world.run("entity.trash", serde_json::json!({"id": "gone"}));
    world.note("blank", "", "garden garden");
    let found = world
        .each(&each(&["note"], "garden", 8).excluding(vec!["skip".to_owned()]))
        .expect("answers");
    assert_eq!(
        found.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
        ["keep"]
    );
    assert!(matches!(
        world.each(&each(&["locker.item"], "garden", 8)),
        Err(SearchError::NotSearchable { .. })
    ));
    assert!(matches!(
        world.each(&each(&["note"], "g", 8)),
        Err(SearchError::NoSearchableWords { .. })
    ));
}

/// A door that only knows `query` still answers `query_each`, by asking once
/// per kind: a test double or a recorder that forgot to forward is slow, not wrong.
#[test]
fn the_default_asks_once_per_kind_and_agrees_with_the_one_statement() {
    struct OnlyQuery<'a>(SqliteDoor<'a>);
    impl Search for OnlyQuery<'_> {
        fn query(
            &self,
            principal: &Principal,
            request: &SearchRequest,
        ) -> Result<Answer, SearchError> {
            self.0.query(principal, request)
        }
    }
    let world = World::new();
    world.note("n1", "Garden", "");
    world.person("p1", "Garden Gus", None);
    let request = each(&["person", "note"], "garden", 4);
    let direct = world.each(&request).expect("answers");
    let by_default = world
        .vault
        .read(|connection| {
            let door = OnlyQuery(SqliteDoor::open(connection, world.vault.words()).expect("opens"));
            Ok(door.query_each(&Principal::Owner, &request))
        })
        .expect("reads")
        .expect("answers");
    assert_eq!(direct, by_default);
}

// -- correction over the word list -------------------------------------------------

impl World {
    fn correct(&self, query: &str) -> Option<String> {
        self.vault
            .read(|connection| {
                Ok(SqliteDoor::open(connection, self.vault.words())
                    .and_then(|door| door.correct(&Principal::Owner, &[], query))
                    .expect("corrects"))
            })
            .expect("reads")
    }
}

#[test]
fn a_slip_anywhere_in_a_word_is_corrected_to_a_whole_word_the_vault_holds() {
    let world = World::new();
    world.note("n1", "Plans", "the spring budget and a sunscreen list");
    assert_eq!(world.correct("budegt").as_deref(), Some("budget")); // a swap
    assert_eq!(world.correct("bidget").as_deref(), Some("budget")); // mid-word
    assert_eq!(world.correct("budgt").as_deref(), Some("budget")); // a letter fewer
    assert_eq!(world.correct("budeg").as_deref(), Some("budget")); // typed so far
    assert_eq!(
        world.correct("sunscren budegt").as_deref(),
        Some("sunscreen budget")
    );
    // The corrected words find the note, which the typed ones did not.
    assert!(world.ask(&["note"], "bidget").is_empty());
    assert_eq!(ids(&world.ask(&["note"], "budget")), ["n1"]);
}

#[test]
fn a_word_the_list_holds_or_starts_is_kept_as_typed() {
    let world = World::new();
    world.note("n1", "Plans", "the spring budget");
    assert_eq!(world.correct("budget"), None);
    assert_eq!(world.correct("budg"), None, "a prefix is a hit as typed");
    assert_eq!(world.correct("BUDGET"), None);
    assert_eq!(world.correct("abc"), None, "under four letters");
    assert_eq!(world.correct("2026"), None, "no digit is a typo");
    assert_eq!(
        world.correct("zzzzzz"),
        None,
        "a word near nothing is not invented"
    );
}

#[test]
fn a_first_letter_slip_is_corrected_only_when_no_word_keeps_the_first_letter() {
    let world = World::new();
    world.note("n1", "Plans", "the spring budget");
    // Nothing near `gudget` starts with g: the one that changes the first letter.
    assert_eq!(world.correct("gudget").as_deref(), Some("budget"));
    // With a word that keeps it, that word is the correction and `budget` is not.
    world.note("n2", "More", "a gudgex arrives");
    assert_eq!(world.correct("gudget").as_deref(), Some("gudgex"));
}

#[test]
fn a_fragment_inside_a_longer_word_is_found_from_four_letters_and_not_from_three() {
    let world = World::new();
    world.note("n1", "Beach", "pack the sunscreen");
    // `cree` starts no word and is a letters-only fragment of four.
    assert_eq!(world.correct("cree").as_deref(), Some("sunscreen"));
    assert_eq!(world.correct("screen").as_deref(), Some("sunscreen"));
    // Three letters is below the typo floor, in-word or not.
    assert_eq!(world.correct("cre"), None);
    // A word one edit away beats a longer word that contains the fragment.
    world.note("n2", "Cinema", "the big screen");
    assert_eq!(world.correct("creen").as_deref(), Some("screen"));
}

#[test]
fn the_word_the_most_documents_hold_wins_then_the_shorter_then_the_first() {
    let world = World::new();
    world.note("a1", "One", "budget");
    world.note("a2", "Two", "budgit");
    world.note("a3", "Three", "budgit");
    world.note("a4", "Four", "budgit budgit budgit");
    assert_eq!(
        world.correct("budgat").as_deref(),
        Some("budgit"),
        "3 documents beat 1"
    );
    // Equal documents: the shorter word.
    let tie = World::new();
    tie.note("b1", "One", "budgets");
    tie.note("b2", "Two", "budget");
    assert_eq!(tie.correct("budgat").as_deref(), Some("budget"));
    // Equal and equally long: the one that sorts first.
    let sorted = World::new();
    sorted.note("c1", "One", "budgit");
    sorted.note("c2", "Two", "budget");
    assert_eq!(sorted.correct("budgat").as_deref(), Some("budget"));
}

#[test]
fn a_word_no_document_holds_any_more_is_not_a_correction() {
    let world = World::new();
    world.note("n1", "Plans", "the spring budget");
    world.run("entity.trash", serde_json::json!({"id": "n1"}));
    // The word list keeps `budget` after its only document left the index.
    assert_eq!(world.correct("budegt"), None);
}

// -- the filled pass ---------------------------------------------------------------

impl World {
    fn correct_thin(&self, query: &str) -> Option<String> {
        self.vault
            .read(|connection| {
                Ok(SqliteDoor::open(connection, self.vault.words())
                    .and_then(|door| door.correct_thin(&Principal::Owner, &[], query))
                    .expect("corrects"))
            })
            .expect("reads")
    }
}

#[test]
fn a_rare_whole_word_is_corrected_on_a_filled_pass_when_a_neighbour_holds_more() {
    let world = World::new();
    world.note("own", "Odd", "the budegt is late");
    world.notes("n", 5, "Plan", "the budget is fine");
    assert_eq!(
        world.correct("budegt"),
        None,
        "the empty pass keeps a held word"
    );
    assert_eq!(world.correct_thin("budegt").as_deref(), Some("budget"));
    // The word that most documents hold is never the one corrected.
    assert_eq!(world.correct_thin("budget"), None);
    // Still being typed: held only as the start of `budget`.
    assert_eq!(world.correct_thin("budg"), None);
}

#[test]
fn a_filled_pass_needs_fewer_than_three_documents_and_a_neighbour_with_more() {
    let world = World::new();
    world.notes("a", 3, "One", "budegt");
    world.notes("b", 5, "Two", "budget");
    assert_eq!(
        world.correct_thin("budegt"),
        None,
        "three documents is not rare"
    );
    let even = World::new();
    even.note("c1", "One", "budegt");
    even.note("c2", "Two", "budget");
    assert_eq!(
        even.correct_thin("budegt"),
        None,
        "one is not more than one"
    );
    // A word the vault does not hold is corrected as on any pass.
    assert_eq!(even.correct_thin("bidget").as_deref(), Some("budget"));
}

#[test]
fn a_one_character_word_beside_longer_words_is_a_whole_word() {
    let world = World::new();
    world.note("whole", "Plan", "a big tree");
    world.note("prefix", "Plan", "apple tree");
    assert_eq!(ids(&world.ask(&["note"], "a tree")), ["whole"]);
    assert_eq!(ids(&world.ask(&["note"], "tree a")), ["whole"]);
    let mut both = ids(&world.ask(&["note"], "tree"))
        .into_iter()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    both.sort();
    assert_eq!(both, ["prefix", "whole"]);
}

// -- Locker, and the realms of the word list ---------------------------------------

impl World {
    fn locker_item(&self, id: &str, title: &str, username: &str) {
        self.run(
            "locker.add_item",
            serde_json::json!({"item_id": id, "type": "login", "title": title, "username": username}),
        );
    }

    fn correct_for(&self, entities: &[&str], query: &str) -> Option<String> {
        self.vault
            .read(|connection| {
                Ok(SqliteDoor::open(connection, self.vault.words())
                    .and_then(|door| door.correct(&Principal::Owner, entities, query))
                    .expect("corrects"))
            })
            .expect("reads")
    }

    fn correct_thin_for(&self, entities: &[&str], query: &str) -> Option<String> {
        self.vault
            .read(|connection| {
                Ok(SqliteDoor::open(connection, self.vault.words())
                    .and_then(|door| door.correct_thin(&Principal::Owner, entities, query))
                    .expect("corrects"))
            })
            .expect("reads")
    }
}

#[test]
fn a_locker_item_is_found_by_its_plain_text_and_only_when_its_kind_is_named() {
    let world = World::new();
    world.locker_item("lk", "Vaultbank", "quokkaname");
    world.note("n1", "Vaultbank plans", "a note that says vaultbank");
    assert_eq!(ids(&world.ask(&["locker_item"], "vaultbank")), ["lk"]);
    assert_eq!(ids(&world.ask(&["locker_item"], "quokkaname")), ["lk"]);
    // Asking for no kind in particular is every kind but Locker's.
    assert_eq!(ids(&world.ask(&[], "vaultbank")), ["n1"]);
    assert!(world.ask(&[], "quokkaname").is_empty());
    assert!(world.ask(&["note"], "quokkaname").is_empty());
    // Home's per-kind statement names the kinds it asks, Locker's among them
    // only when the core says the lock is open.
    let each_locker = world
        .each(&each(&["note", "locker_item"], "vaultbank", 8))
        .expect("answers");
    assert_eq!(each_locker.len(), 2);
    let each_vault = world.each(&each(&[], "quokkaname", 8)).expect("answers");
    assert!(each_vault.is_empty());
}

#[test]
fn a_word_only_locker_holds_is_not_offered_to_nor_known_by_a_reader_of_the_vault() {
    let world = World::new();
    world.locker_item("lk", "Bank", "quokkaname");
    world.note("n1", "Plans", "the spring budget and a quokkanamf");

    // NOT OFFERED: a vault reader mistyping the Locker-only word gets nothing,
    // where a reader that may open Locker is offered it.
    assert_eq!(world.correct_for(&["note"], "quokkanme"), None);
    assert_eq!(world.correct_for(&[], "quokkanme"), None);
    assert_eq!(
        world
            .correct_for(&["note", "locker_item"], "quokkanme")
            .as_deref(),
        Some("quokkaname")
    );
    assert_eq!(
        world.correct_for(&["locker_item"], "quokkanme").as_deref(),
        Some("quokkaname")
    );

    // NOT KNOWN: typed exactly, the Locker-only word is a word of the vault
    // for a reader of both realms (kept as typed) and an unknown for a reader of
    // the vault alone, which is offered its near neighbour instead.
    assert_eq!(
        world.correct_for(&["note", "locker_item"], "quokkaname"),
        None
    );
    assert_eq!(
        world.correct_for(&["note"], "quokkaname").as_deref(),
        Some("quokkanamf")
    );
    // The thin pass reads the same realms.
    assert_eq!(
        world.correct_thin_for(&["note"], "quokkaname").as_deref(),
        Some("quokkanamf")
    );
    assert_eq!(
        world.correct_thin_for(&["note", "locker_item"], "quokkaname"),
        None
    );

    // And the realm follows the lock: once the item is purged its word is gone
    // from the Locker realm, whoever asks.
    world.run("entity.trash", serde_json::json!({"id": "lk"}));
    world.run("entity.purge", serde_json::json!({"id": "lk"}));
    assert_eq!(
        world
            .correct_for(&["note", "locker_item"], "quokkaname")
            .as_deref(),
        Some("quokkanamf")
    );
}
