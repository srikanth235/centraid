//! Search answers over a year-3 vault, checked for correctness (#1135).
//!
//! This was `search_budget`, which also held each call to a p95 ceiling. That wall-clock
//! assertion is removed (owner ruling 2026-11-04: timing checks flake on a loaded machine and
//! block unrelated changes); what is kept is what the answers *are*:
//!
//! - the corpus is the year-3 one it claims to be;
//! - the same question has the same answer every time;
//! - a word typed right finds something, and a word nothing holds finds nothing.
//!
//! ## Surfaces and queries
//!
//! `Handle::call` with an `AppQuery` request: the door a shell uses. The surfaces are the ones a
//! member types into: Home's vault search, and Notes', Docs', Money's and Locker's own (Locker
//! after its session is unlocked, as the shell gates it). Each query is a way the same box is
//! typed into: a prefix of two letters and of three, a word held by most documents, by a few
//! hundred, and by two; two words; a one-letter word beside a word; a typo (corrected over the
//! whole word list); a rare word typed right (the filled pass); a fragment from the middle of a
//! word; and a word nothing holds. The words are chosen from the corpus's own tallies.
//!
//! The vault is [`year3_corpus`]'s, about 45,000 entities; founding it is the cost of this
//! target (about 30 s in a debug build), the same order as `query_plans`, which founds it too.

mod year3_corpus;

use centraid_apps_kit::search_corpus::{a_then_word, adjacent_pair};
use centraid_core::api_proto as wire;
use wire::app_query_request::Query as Q;
use wire::app_query_response::Answer;

/// Calls per query: the second proves the answer is the same.
const ASKS: usize = 2;
const TZ: &str = "America/Los_Angeles";
const LIMIT: u32 = 50;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Surface {
    Home,
    Notes,
    Docs,
    Money,
    Locker,
}

impl Surface {
    const ALL: [Self; 5] = [
        Self::Home,
        Self::Notes,
        Self::Docs,
        Self::Money,
        Self::Locker,
    ];

    fn name(self) -> &'static str {
        match self {
            Self::Home => "home",
            Self::Notes => "notes",
            Self::Docs => "docs",
            Self::Money => "money",
            Self::Locker => "locker",
        }
    }

    /// The kind whose words choose this surface's queries (`None` for all).
    fn kind(self) -> Option<&'static str> {
        match self {
            Self::Home => None,
            Self::Notes => Some("note"),
            Self::Docs => Some("document"),
            Self::Money => Some("txn"),
            Self::Locker => Some("locker_item"),
        }
    }

    fn query(self, term: &str) -> Q {
        let term = term.to_owned();
        let tz = TZ.to_owned();
        match self {
            Self::Home => Q::VaultSearch(wire::VaultSearchRequest { term, tz }),
            Self::Notes => Q::NotesSearch(wire::NotesSearchRequest { term, tz }),
            Self::Docs => Q::DocsSearch(wire::DocsSearchRequest {
                term,
                limit: LIMIT,
                tz,
            }),
            Self::Money => Q::MoneySearch(wire::MoneySearchRequest {
                tz,
                month: String::new(),
                term,
                limit: LIMIT,
            }),
            Self::Locker => Q::LockerSearch(wire::LockerSearchRequest {
                term,
                limit: LIMIT,
                tz,
            }),
        }
    }

    /// `(rows, corrected)` of an answer from this surface.
    fn read(self, answer: Answer) -> (usize, String) {
        match (self, answer) {
            (Self::Home, Answer::VaultSearch(found)) => (found.hits.len(), found.corrected),
            (Self::Notes, Answer::NotesSearch(found)) => {
                (found.hits.len() + found.containers.len(), found.corrected)
            }
            (Self::Docs, Answer::DocsSearch(found)) => (
                found.documents.len() + found.containers.len(),
                found.corrected,
            ),
            (Self::Money, Answer::MoneySearch(found)) => {
                (found.rows.len(), found.corrected.unwrap_or_default())
            }
            (Self::Locker, Answer::LockerSearch(found)) => (found.items.len(), found.corrected),
            (_, other) => panic!("a search answered as {other:?}"),
        }
    }
}

fn ask(handle: &centraid_core::Handle, query: Q) -> Answer {
    match handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::AppQuery(wire::AppQueryRequest {
                query: Some(query),
            })),
        })
        .expect("a search answers")
        .kind
    {
        Some(wire::response::Kind::AppQuery(answer)) => {
            answer.answer.expect("an app query is answered")
        }
        other => panic!("an app query answered as {other:?}"),
    }
}

/// A word with two neighbouring letters swapped that nothing in the corpus holds.
fn typo_of(corpus: &year3_corpus::Year3, word: &str) -> String {
    let letters: Vec<char> = word.chars().collect();
    for at in 1..letters.len() - 1 {
        let mut swapped = letters.clone();
        swapped.swap(at, at + 1);
        let candidate: String = swapped.into_iter().collect();
        if candidate != word && !corpus.counts.holds(&candidate) {
            return candidate;
        }
    }
    panic!("`{word}` has no transposition the corpus does not hold");
}

/// The word with its first and last letters cut: a fragment from the middle.
fn fragment_of(word: &str) -> String {
    word.chars()
        .skip(1)
        .take(word.chars().count() - 2)
        .collect()
}

/// The queries of one surface, each named for what it exercises.
fn queries(corpus: &year3_corpus::Year3, surface: Surface) -> Vec<(&'static str, String)> {
    let counts = &corpus.counts;
    let kind = surface.kind();
    let entities = match surface {
        Surface::Home => counts.entities,
        Surface::Notes => counts.notes,
        Surface::Docs => counts.documents,
        Surface::Money => counts.transactions,
        Surface::Locker => counts.locker_items,
    };
    let held = |share: usize| u32::try_from(entities * share / 1_000).expect("a count");
    let common = counts.word_held_by(kind, held(300), 4).to_owned();
    let mid = counts.word_held_by(kind, held(10).max(5), 5).to_owned();
    let rare = counts.word_held_by(kind, 2, 5).to_owned();
    let single = counts.word_held_by(kind, 1, 6).to_owned();
    // Two words one entity of the kind holds side by side (a pair of its
    // title's), so the answer has a row by construction.
    let sample = kind.unwrap_or("note");
    let pair = adjacent_pair(&counts.sample_titles[sample]).expect("the sample has a pair");
    // A one-letter word beside a word that one entity holds together.
    let with_a = counts
        .sample_titles_with_a
        .get(sample)
        .and_then(|title| a_then_word(title))
        .map_or_else(|| format!("a {mid}"), |word| format!("a {word}"));
    vec![
        ("2 letters", common.chars().take(2).collect()),
        ("3 letters", common.chars().take(3).collect()),
        ("common word", common.clone()),
        ("mid word", mid.clone()),
        ("rare word", rare),
        ("two words", pair),
        ("1-letter + word", with_a),
        ("typo", typo_of(corpus, &mid)),
        ("filled pass", single),
        ("in-word fragment", fragment_of(&mid)),
        ("no match", "qxzvwkjq".to_owned()),
    ]
}

struct Found {
    surface: &'static str,
    query: &'static str,
    term: String,
    rows: usize,
}

#[test]
fn every_search_answers_the_same_and_finds_what_is_typed_right() {
    let corpus = year3_corpus::found();
    println!(
        "search corpus — {} entities ({} notes, {} documents, {} photos, {} people, {} events, \
         {} tasks, {} transactions, {} locker items, {} workouts, {} chat threads), {} words \
         of text, {} distinct words",
        corpus.counts.entities,
        corpus.counts.notes,
        corpus.counts.documents,
        corpus.counts.photos,
        corpus.counts.people,
        corpus.counts.events,
        corpus.counts.tasks,
        corpus.counts.transactions,
        corpus.counts.locker_items,
        corpus.counts.activities,
        corpus.counts.threads,
        corpus.counts.words_written,
        corpus.counts.distinct_words,
    );
    assert!(
        corpus.counts.entities >= 40_000 && corpus.counts.distinct_words >= 100_000,
        "the corpus is the year-3 one it claims to be: {} entities, {} distinct words",
        corpus.counts.entities,
        corpus.counts.distinct_words
    );

    // Locker's shelf is read after the member unlocks, as the shell gates it.
    let unlocked = corpus
        .handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Locker(wire::LockerSessionRequest {
                step: Some(wire::locker_session_request::Step::Unlock(
                    wire::LockerUnlock::default(),
                )),
            })),
        })
        .expect("the session answers");
    assert!(
        matches!(unlocked.kind, Some(wire::response::Kind::Locker(ref answer))
            if answer.state == wire::LockerSessionState::Unlocked as i32),
        "the Locker unlocks"
    );

    let mut found = Vec::new();
    for surface in Surface::ALL {
        for (query, term) in queries(&corpus, surface) {
            let mut shape = (0, String::new());
            for ask_number in 0..ASKS {
                let answered = surface.read(ask(&corpus.handle, surface.query(&term)));
                // The same question has the same answer every time.
                if ask_number > 0 {
                    assert_eq!(
                        answered,
                        shape,
                        "{} `{term}` answered differently",
                        surface.name()
                    );
                }
                shape = answered;
            }
            found.push(Found {
                surface: surface.name(),
                query,
                term,
                rows: shape.0,
            });
        }
    }

    // What is typed right finds something, and what nothing holds finds nothing.
    for hit in &found {
        match hit.query {
            "no match" => assert_eq!(hit.rows, 0, "{} `{}`", hit.surface, hit.term),
            "in-word fragment" => {}
            query => assert!(
                hit.rows > 0,
                "{} {query} `{}` found nothing",
                hit.surface,
                hit.term
            ),
        }
    }
}
