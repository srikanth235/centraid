//! The search budget: p95 of the core's own search answers over a year-3 vault,
//! against a ceiling (#1135, after `call_budget`'s pattern, D-1020-D2-6).
//!
//! `SEARCH_BUDGET_MS` is **50** on `ci-linux-x64-4c`, and the number is in
//! `contracts/ledgers/search-budget.json` where it can only fall. The ceiling is
//! the product's promise about a call (a frame is not late because a member
//! typed), stated once for every search call, and never the observation.
//!
//! ## What is timed
//!
//! `Handle::call` with an `AppQuery` request: the door a shell uses, so the
//! number includes the request's decode, the read connection, the FTS door, the
//! correction pass, the app's fold and the answer's conversion. The surfaces are
//! the ones a member types into: Home's vault search, and Notes', Docs', Money's
//! and Locker's own (Locker after its session is unlocked, as the shell gates it).
//!
//! ## Over what
//!
//! The vault of [`year3_corpus`]: about 45,000 entities and two million words of
//! text drawn Zipf-distributed from 200,000 distinct words, so a two-letter prefix
//! matches thousands of terms and a common word is held by nearly every
//! document. `call_budget` is the floor measurement over a few hundred rows;
//! this is the year-3 one.
//!
//! ## Which queries
//!
//! Each is a way the same box is typed into, and each costs a different path:
//! a prefix of two letters and of three (the term count the index expands), a
//! word held by most documents, by a few hundred, and by two; two words; a
//! one-letter word beside a word; a typo (the empty answer is corrected over the
//! whole word list); a rare word typed right (the filled pass corrects a thin
//! exact answer); a fragment from the middle of a word; and a word nothing
//! holds. The words are chosen from the corpus's own tallies, not typed here.

mod year3_corpus;

use std::time::{Duration, Instant};

use centraid_apps_kit::search_corpus::{a_then_word, adjacent_pair};
use centraid_core::api_proto as wire;
use wire::app_query_request::Query as Q;
use wire::app_query_response::Answer;

/// The ceiling, in milliseconds, on `ci-linux-x64-4c`: 64, by the owner's ruling of
/// 2026-10-22 (#1135), after the search-speed pass left two cells between 50 and 64.
const SEARCH_BUDGET_MS: f64 = 64.0;
/// How many calls each percentile is taken over.
const SAMPLES: usize = 100;
/// Unmeasured calls first: the statement compiles, the pages fault in, the
/// vault's word cache loads.
const WARMUP: usize = 10;
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

/// The nearest-rank percentile of a sorted sample.
fn percentile(sorted: &[Duration], fraction: f64) -> Duration {
    if sorted.is_empty() {
        return Duration::ZERO;
    }
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let rank = ((sorted.len() as f64 * fraction).ceil() as usize).clamp(1, sorted.len()) - 1;
    sorted[rank]
}

fn ms(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1_000.0
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

struct Timing {
    surface: &'static str,
    query: &'static str,
    term: String,
    rows: usize,
    corrected: bool,
    p50: Duration,
    p95: Duration,
    p99: Duration,
}

/// **`#[ignore]`d from the `test` step on purpose**, and run by `search-budget`
/// with `--include-ignored` in a RELEASE build: the promise is the shipped
/// core's, and a debug build runs the correction pass three to five times slower
/// than the phone does. Founding the vault and 6,000 calls is minutes in debug;
/// the `test` step running it again would charge the `pr` profile twice for one
/// measurement. By hand:
/// `cargo test --release -p centraid-core --test search_budget -- --include-ignored --nocapture`.
#[test]
#[ignore = "run by the pr gate's `search-budget` step, in release (cargo xtask gate --profile pr --lane search-budget)"]
fn the_p95_of_every_search_is_inside_the_budget() {
    let corpus = year3_corpus::found();
    println!(
        "search corpus — {} entities ({} notes, {} documents, {} photos, {} people, {} events, \
         {} tasks, {} transactions, {} locker items, {} workouts, {} chat threads), {} words \
         of text, {} distinct words; rows written in {:.1}s, index built in {:.1}s",
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
        corpus.wrote_seconds,
        corpus.indexed_seconds,
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
                    wire::LockerUnlock {},
                )),
            })),
        })
        .expect("the session answers");
    assert!(
        matches!(unlocked.kind, Some(wire::response::Kind::Locker(ref answer))
            if answer.state == wire::LockerSessionState::Unlocked as i32),
        "the Locker unlocks"
    );

    let mut timings = Vec::new();
    for surface in Surface::ALL {
        for (query, term) in queries(&corpus, surface) {
            let ask_once = || {
                let started = Instant::now();
                let answer = ask(&corpus.handle, surface.query(&term));
                (started.elapsed(), surface.read(answer))
            };
            for _ in 0..WARMUP {
                ask_once();
            }
            let mut samples = Vec::with_capacity(SAMPLES);
            let mut shape = (0, String::new());
            for sample in 0..SAMPLES {
                let (elapsed, answered) = ask_once();
                samples.push(elapsed);
                // The same question has the same answer every time.
                if sample > 0 {
                    assert_eq!(
                        answered,
                        shape,
                        "{} `{term}` answered differently",
                        surface.name()
                    );
                }
                shape = answered;
            }
            samples.sort_unstable();
            timings.push(Timing {
                surface: surface.name(),
                query,
                term,
                rows: shape.0,
                corrected: !shape.1.is_empty(),
                p50: percentile(&samples, 0.50),
                p95: percentile(&samples, 0.95),
                p99: percentile(&samples, 0.99),
            });
        }
    }

    println!(
        "search budget — {SAMPLES} samples after {WARMUP} warm-up on ci-linux-x64-4c, \
         ceiling {SEARCH_BUDGET_MS:.0}ms (p95)"
    );
    println!(
        "{:<7} {:<17} {:<16} {:>5} {:>5} {:>8} {:>8} {:>8}",
        "surface", "query", "term", "rows", "fixed", "p50 ms", "p95 ms", "p99 ms"
    );
    for timing in &timings {
        println!(
            "{:<7} {:<17} {:<16} {:>5} {:>5} {:>8.2} {:>8.2} {:>8.2}",
            timing.surface,
            timing.query,
            timing.term.chars().take(16).collect::<String>(),
            timing.rows,
            if timing.corrected { "yes" } else { "" },
            ms(timing.p50),
            ms(timing.p95),
            ms(timing.p99),
        );
    }

    // A budget met by returning nothing is not a budget met: what is typed right
    // finds something, and what nothing holds finds nothing.
    for timing in &timings {
        match timing.query {
            "no match" => assert_eq!(timing.rows, 0, "{} `{}`", timing.surface, timing.term),
            "in-word fragment" => {}
            query => assert!(
                timing.rows > 0,
                "{} {query} `{}` found nothing",
                timing.surface,
                timing.term
            ),
        }
    }
    let over: Vec<String> = timings
        .iter()
        .filter(|timing| ms(timing.p95) > SEARCH_BUDGET_MS)
        .map(|timing| {
            format!(
                "{} {} `{}`: p95 {:.2}ms",
                timing.surface,
                timing.query,
                timing.term,
                ms(timing.p95)
            )
        })
        .collect();
    assert!(
        over.is_empty(),
        "p95 over the {SEARCH_BUDGET_MS:.0}ms ceiling: {}. The budget is the product's \
         responsiveness promise, not a target — either the search path got slower or the \
         ledger needs an owner ruling (contracts/ledgers/search-budget.json, #1135)",
        over.join("; ")
    );
}

/// The ledger's number and this test's constant are the same number.
///
/// Two copies of a budget is two budgets, and the one that is not read is the
/// one that drifts. The ledger is what `cargo xtask gate` ratchets; this test is
/// what measures.
#[test]
fn the_ledger_and_this_test_state_the_same_ceiling() {
    let path = centraid_ontology::scratch::repo_root().join("contracts/ledgers/search-budget.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("{} is committed: {error}", path.display()));
    let ledger: serde_json::Value = serde_json::from_str(&text).expect("the ledger is valid JSON");
    let recorded = ledger["profiles"]["pr"]["ci-linux-x64-4c"]["p95Ms"]
        .as_f64()
        .expect("the ledger records a p95 ceiling for this hardware");
    assert!(
        (recorded - SEARCH_BUDGET_MS).abs() < f64::EPSILON,
        "the ledger says {recorded} and this test says {SEARCH_BUDGET_MS}"
    );
    let provenance = &ledger["_provenance"];
    assert_eq!(provenance["samples"].as_u64(), Some(SAMPLES as u64));
    assert_eq!(provenance["warmup"].as_u64(), Some(WARMUP as u64));
}
