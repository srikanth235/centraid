//! THE YEAR-3 SEARCH CORPUS (#1135): a vault's text at a stated volume, written
//! so that the search index over it has a realistic vocabulary and a realistic
//! spread of document sizes, and so that a timing taken over it is a timing over
//! something a member's phone holds in its third year.
//!
//! **Why not the per-app generators.** `year3_notes` and the rest write the rows
//! each app's *window* tests need, with titles like `Note 4 about topic 17`: a
//! vocabulary of a few hundred words, in which a prefix of two letters matches a
//! handful of terms. A search over that proves nothing about a prefix that
//! matches a thousand terms, a word held by half the documents, or a correction
//! over a hundred thousand words. This corpus is the search lane's own.
//!
//! **What it writes.** Notes (with bodies, a tenth of them long), documents with
//! extracted text (median about 800 words), photographs with captions, people with
//! contact points, events, tasks, transactions filed under categories and
//! accounts, and Locker items; the containers that title them (notebooks,
//! folders, projects, albums, places, categories, accounts, tags); and the edges
//! that make a title part of what it labels. Entities are written in one
//! interleaved creation order, so `entity.n` is a timeline and "the newest" means
//! something.
//!
//! **Where the words come from.** A [`Vocabulary`]: `size` distinct words, each a
//! pronounceable run of syllables (short for the common ranks, long for the rare,
//! as in a language), drawn Zipf-distributed (exponent 1). The twelve commonest
//! ranks are English function words, so a corpus holds one-letter and two-letter
//! whole words (`a`, `to`, `of`) beside the invented ones. The rest are invented
//! and deterministic: no word list, no network and no committed fixture.
//!
//! **Deterministic**: a named LCG, as in [`crate::fixtures`], so the bytes of the
//! corpus never move for a seed. Nothing is indexed here: the vault's own writer
//! keeps the `search` table, and a caller that wrote rows around it rebuilds the
//! index (`centraid_vault::index::rebuild`).
//!
//! **Why here.** `sql-confinement` keeps SQL out of every crate but
//! `crates/{ontology,vault,search}` and this one.

use std::collections::{BTreeMap, HashSet};

use rusqlite::{Connection, params};

use crate::error::{KitError, KitResult};

/// The function words that take the commonest ranks, in rank order.
pub const FUNCTION_WORDS: [&str; 12] = [
    "the", "a", "and", "of", "to", "in", "is", "for", "on", "it", "with", "as",
];

/// Onsets and vowels of the invented syllables: 20 × 7 = 140 syllables, so a
/// word of one syllable is two to three letters, of two is four to six, of three
/// six to nine.
const ONSETS: [&str; 20] = [
    "b", "d", "f", "g", "h", "k", "l", "m", "n", "p", "r", "s", "t", "v", "z", "ch", "sh", "th",
    "st", "br",
];
const VOWELS: [&str; 7] = ["a", "e", "i", "o", "u", "ai", "ou"];
const SYLLABLES: usize = ONSETS.len() * VOWELS.len();

fn syllable(index: usize) -> String {
    format!(
        "{}{}",
        ONSETS[index / VOWELS.len()],
        VOWELS[index % VOWELS.len()]
    )
}

/// A seeded integer stream: a named, tiny LCG rather than a crate, because a
/// fixture's value is that its bytes never move.
struct Seeded(u64);

impl Seeded {
    fn new(seed: u64) -> Self {
        Self(seed.wrapping_mul(2).wrapping_add(1))
    }

    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        self.0 >> 16
    }

    fn upto(&mut self, bound: usize) -> usize {
        if bound == 0 {
            return 0;
        }
        usize::try_from(self.next() % bound as u64).expect("a bound is a usize")
    }

    /// A uniform number in `[0, 1)`.
    fn unit(&mut self) -> f64 {
        (self.next() & ((1 << 47) - 1)) as f64 / (1_u64 << 47) as f64
    }
}

/// The distinct words of a corpus and the Zipf law they are drawn by.
pub struct Vocabulary {
    words: Vec<String>,
    /// `cumulative[r]` is the weight of ranks `0..=r`, weight `1 / (r + 1)`.
    cumulative: Vec<f64>,
}

impl Vocabulary {
    /// `size` distinct words, the commonest first.
    ///
    /// # Panics
    /// If `size` is smaller than the function words.
    #[must_use]
    pub fn new(size: usize) -> Self {
        assert!(
            size > FUNCTION_WORDS.len(),
            "a vocabulary holds the function words"
        );
        let mut words: Vec<String> = FUNCTION_WORDS
            .iter()
            .map(|word| (*word).to_owned())
            .collect();
        let mut seen: HashSet<String> = words.iter().cloned().collect();
        // Every word of one syllable, then two, then three, in the order a
        // counter spells them.
        let mut index = 0usize;
        while words.len() < size {
            let word = if index < SYLLABLES {
                syllable(index)
            } else if index < SYLLABLES + SYLLABLES * SYLLABLES {
                let at = index - SYLLABLES;
                format!("{}{}", syllable(at / SYLLABLES), syllable(at % SYLLABLES))
            } else {
                let at = index - SYLLABLES - SYLLABLES * SYLLABLES;
                format!(
                    "{}{}{}",
                    syllable(at / (SYLLABLES * SYLLABLES)),
                    syllable(at / SYLLABLES % SYLLABLES),
                    syllable(at % SYLLABLES)
                )
            };
            index += 1;
            if seen.insert(word.clone()) {
                words.push(word);
            }
        }
        let mut total = 0.0;
        let cumulative = (0..words.len())
            .map(|rank| {
                total += 1.0 / (rank as f64 + 1.0);
                total
            })
            .collect();
        Self { words, cumulative }
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.words.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.words.is_empty()
    }

    /// The word of a rank (`0` is the commonest).
    #[must_use]
    pub fn word(&self, rank: usize) -> &str {
        &self.words[rank]
    }

    /// One word, Zipf-distributed.
    fn draw(&self, random: &mut Seeded) -> usize {
        let target = random.unit() * self.cumulative[self.cumulative.len() - 1];
        self.cumulative
            .partition_point(|weight| *weight < target)
            .min(self.words.len() - 1)
    }
}

/// The writer's running state: the vocabulary, the stream, and how many
/// documents (texts) each word was written into.
struct Writer<'a> {
    vocabulary: &'a Vocabulary,
    random: Seeded,
    /// `df[rank]`: how many entities hold the word, in all and by the kind of
    /// the entity.
    df: Vec<u32>,
    df_by_kind: BTreeMap<&'static str, Vec<u32>>,
    /// The ranks the entity being written holds so far.
    scratch: HashSet<usize>,
}

impl Writer<'_> {
    /// An entity is written: every distinct word it holds is held by one more
    /// entity of its kind.
    fn finish(&mut self, kind: &'static str) {
        let size = self.vocabulary.len();
        let by_kind = self.df_by_kind.entry(kind).or_insert_with(|| vec![0; size]);
        for rank in &self.scratch {
            self.df[*rank] += 1;
            by_kind[*rank] += 1;
        }
        self.scratch.clear();
    }

    /// A text of `count` words, its words added to the entity being written.
    fn text(&mut self, count: usize, content_only: bool) -> String {
        let mut out = String::with_capacity(count * 6);
        for at in 0..count {
            let mut rank = self.vocabulary.draw(&mut self.random);
            while content_only && rank < FUNCTION_WORDS.len() {
                rank = self.vocabulary.draw(&mut self.random);
            }
            self.scratch.insert(rank);
            if at > 0 {
                out.push(if at % 14 == 0 { '\n' } else { ' ' });
            }
            out.push_str(self.vocabulary.word(rank));
        }
        out
    }

    /// A text of `low` words plus up to `spread - 1` more.
    fn text_of(&mut self, low: usize, spread: usize, content_only: bool) -> String {
        let count = low + self.random.upto(spread);
        self.text(count, content_only)
    }

    /// A title: two to six words, function words and all (`a walk in the park`).
    fn title(&mut self) -> String {
        let count = 2 + self.random.upto(5);
        self.text(count, false)
    }

    /// A length from a log-normal with the stated median, clipped.
    fn length(&mut self, median: usize, sigma: f64, floor: usize, ceiling: usize) -> usize {
        // Irwin–Hall of four: mean 2, variance 1/3.
        let sum: f64 = (0..4).map(|_| self.random.unit()).sum();
        let z = (sum - 2.0) / (1.0_f64 / 3.0).sqrt();
        let length = (median as f64 * (sigma * z).exp()).round();
        (length as usize).clamp(floor, ceiling)
    }
}

fn door(error: rusqlite::Error) -> KitError {
    KitError::Door(error.to_string())
}

/// The instant `index` steps into a three-year span, in the vault's text form.
fn instant(index: usize, of: usize) -> String {
    let minutes = 1_576_800 * index / of.max(1);
    let (day, minute) = (minutes / 1_440, minutes % 1_440);
    let (mut year, mut left) = (2024, day);
    loop {
        let length = if year % 4 == 0 { 366 } else { 365 };
        if left < length {
            break;
        }
        left -= length;
        year += 1;
    }
    let months = [
        31,
        if year % 4 == 0 { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut month = 0;
    while left >= months[month] {
        left -= months[month];
        month += 1;
    }
    format!(
        "{year:04}-{:02}-{:02}T{:02}:{:02}:00.000Z",
        month + 1,
        left + 1,
        minute / 60,
        minute % 60
    )
}

fn id(prefix: &str, index: usize) -> String {
    format!("{prefix}-{index:06}")
}

fn hash_of(namespace: u64, index: usize) -> String {
    format!("{namespace:016x}{index:048x}")
}

/// The volume a search corpus is stated at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SearchCorpusShape {
    /// Distinct words the Zipf law draws from.
    pub vocabulary: usize,
    pub notes: usize,
    /// Of the notes, how many are long (`long_note_words` words).
    pub long_notes: usize,
    pub long_note_words: usize,
    /// Median words of an ordinary note's body.
    pub note_words: usize,
    pub documents: usize,
    /// Median words of a document's extracted text.
    pub document_words: usize,
    pub photos: usize,
    pub people: usize,
    pub events: usize,
    pub tasks: usize,
    pub transactions: usize,
    pub locker_items: usize,
    /// Workouts (an `activity` with a `workout` row), and how many kinds of
    /// workout there are.
    pub activities: usize,
    pub workout_kinds: usize,
    /// Chat threads, and the messages in each.
    pub threads: usize,
    pub messages_per_thread: usize,
    /// Of the events, how many repeat, and how many exceptions each series holds.
    pub recurring_events: usize,
    pub occurrences_per_series: usize,
    /// Revisions of notes (older bodies), spread over the notes.
    pub revisions: usize,
    /// Locker access receipts.
    pub receipts: usize,
    /// Days of health measurements, six metrics each, from the first day.
    pub measurement_days: usize,
    /// Containers that title what they hold.
    pub notebooks: usize,
    pub folders: usize,
    pub projects: usize,
    pub albums: usize,
    pub places: usize,
    pub categories: usize,
    pub accounts: usize,
    pub tags: usize,
}

/// THE YEAR-3 SEARCH PROFILE, sized so a test build founds it in well under a
/// minute: about 47,000 entities, about two million words of text, and the
/// year-3 rows of the tables search does not read (workouts, health
/// measurements, repeating-event exceptions, note revisions, chat messages and
/// Locker receipts), so a plan taken on it is a plan over every table a screen reads.
///
/// The ratios are a third-year phone's (photographs and transactions are the
/// most numerous things, documents are the largest); the absolute counts are
/// what the build can write and index in a test run. Nothing here claims to be
/// the largest vault: a member with ten times the photographs has ten times the
/// caption rows and the same query plans.
pub const YEAR3_SEARCH: SearchCorpusShape = SearchCorpusShape {
    vocabulary: 200_000,
    notes: 6_000,
    long_notes: 600,
    long_note_words: 1_500,
    note_words: 90,
    documents: 2_500,
    document_words: 800,
    photos: 12_000,
    people: 1_200,
    events: 3_000,
    tasks: 6_000,
    transactions: 12_000,
    locker_items: 500,
    activities: 2_500,
    workout_kinds: 8,
    threads: 150,
    messages_per_thread: 10,
    recurring_events: 60,
    occurrences_per_series: 5,
    revisions: 3_000,
    receipts: 1_500,
    measurement_days: 1_095,
    notebooks: 30,
    folders: 60,
    projects: 40,
    albums: 40,
    places: 200,
    categories: 40,
    accounts: 6,
    tags: 100,
};

/// THE YEAR-3 ROW COUNTS WITH THE TEXT KEPT SHORT: the same tables at the same
/// sizes, with a few words to a body, for a test that plans statements. A plan
/// depends on the tables, their indexes and their statistics, not on how long a
/// note is, and two million words of text is most of what founding costs.
pub const YEAR3_ROWS: SearchCorpusShape = SearchCorpusShape {
    long_notes: 20,
    long_note_words: 60,
    note_words: 12,
    document_words: 40,
    ..YEAR3_SEARCH
};

/// What one seeding wrote, and the words a query set is chosen from.
#[derive(Debug, Clone, PartialEq)]
pub struct SearchCorpusCounts {
    pub entities: usize,
    pub notes: usize,
    pub documents: usize,
    pub photos: usize,
    pub people: usize,
    pub events: usize,
    pub tasks: usize,
    pub transactions: usize,
    pub locker_items: usize,
    pub activities: usize,
    pub threads: usize,
    pub messages: usize,
    pub occurrences: usize,
    pub revisions: usize,
    pub receipts: usize,
    pub measurements: usize,
    /// Words of text written in notes, documents and captions.
    pub words_written: usize,
    /// Distinct words that appear in at least one text.
    pub distinct_words: usize,
    /// `(word, texts that hold it)` for every word that appears, the commonest
    /// first. A query set picks a common, a mid and a rare word from here.
    pub frequency: Vec<(String, u32)>,
    /// The same for the entities of one kind (`note`, `document`, `txn`, ...).
    pub frequency_by_kind: BTreeMap<String, Vec<(String, u32)>>,
    /// The title of one live entity of each kind (the fortieth written): words
    /// that are held together by one entity, so a query of two of them has an
    /// answer by construction.
    pub sample_titles: BTreeMap<String, String>,
    /// The same, of a title that holds the one-letter word `a`.
    pub sample_titles_with_a: BTreeMap<String, String>,
}

impl SearchCorpusCounts {
    /// The word held by the number of entities nearest `target` (of the kind, or
    /// of all kinds for `None`), among words of at least `min_letters` letters
    /// that are not function words. Ties go to the alphabetically first, so the
    /// answer is a function of the corpus alone.
    ///
    /// # Panics
    /// If the corpus holds no such word.
    #[must_use]
    pub fn word_held_by(&self, kind: Option<&str>, target: u32, min_letters: usize) -> &str {
        let frequency = match kind {
            Some(kind) => self
                .frequency_by_kind
                .get(kind)
                .unwrap_or_else(|| panic!("the corpus holds no {kind}")),
            None => &self.frequency,
        };
        frequency
            .iter()
            .filter(|(word, _)| {
                word.len() >= min_letters && !FUNCTION_WORDS.contains(&word.as_str())
            })
            .min_by(|left, right| {
                left.1
                    .abs_diff(target)
                    .cmp(&right.1.abs_diff(target))
                    .then_with(|| left.0.cmp(&right.0))
            })
            .map(|(word, _)| word.as_str())
            .expect("a corpus holds words")
    }

    /// Whether any text of the corpus holds the word.
    #[must_use]
    pub fn holds(&self, word: &str) -> bool {
        self.frequency.iter().any(|(held, _)| held == word)
    }
}

/// Two neighbouring words of a title that are not function words: a query of
/// two words that one entity holds side by side, which even a search that
/// matches the whole phrase (Locker's) answers.
#[must_use]
pub fn adjacent_pair(title: &str) -> Option<String> {
    let words: Vec<&str> = title.split_whitespace().collect();
    words
        .windows(2)
        .find(|pair| !pair.iter().any(|word| FUNCTION_WORDS.contains(word)))
        .map(|pair| pair.join(" "))
}

/// The word right after a one-letter `a` in a title, when it is not itself a
/// function word: the other half of a query of `a` beside a word.
#[must_use]
pub fn a_then_word(title: &str) -> Option<&str> {
    let words: Vec<&str> = title.split_whitespace().collect();
    words
        .windows(2)
        .find(|pair| pair[0] == "a" && !FUNCTION_WORDS.contains(&pair[1]))
        .map(|pair| pair[1])
}

#[derive(Clone, Copy)]
enum Item {
    Note,
    Document,
    Photo,
    Person,
    Event,
    Task,
    Txn,
    Locker,
    Activity,
    Thread,
}

/// Write the corpus into a founded vault's connection. Deterministic in `seed`.
///
/// # Errors
///
/// Whatever the vault refuses a row for; the generator writes only rows the
/// baseline's own constraints accept.
#[allow(clippy::too_many_lines)]
pub fn year3_search_corpus(
    connection: &Connection,
    shape: SearchCorpusShape,
    seed: u64,
) -> KitResult<SearchCorpusCounts> {
    let vocabulary = Vocabulary::new(shape.vocabulary);
    let mut writer = Writer {
        vocabulary: &vocabulary,
        random: Seeded::new(seed),
        df: vec![0; vocabulary.len()],
        df_by_kind: BTreeMap::new(),
        scratch: HashSet::new(),
    };
    let total_items = shape.notes
        + shape.documents
        + shape.photos
        + shape.people
        + shape.events
        + shape.tasks
        + shape.transactions
        + shape.locker_items
        + shape.activities
        + shape.threads;
    let mut counts = SearchCorpusCounts {
        entities: 0,
        notes: 0,
        documents: 0,
        photos: 0,
        people: 0,
        events: 0,
        tasks: 0,
        transactions: 0,
        locker_items: 0,
        activities: 0,
        threads: 0,
        messages: 0,
        occurrences: 0,
        revisions: 0,
        receipts: 0,
        measurements: 0,
        words_written: 0,
        distinct_words: 0,
        frequency: Vec::new(),
        frequency_by_kind: BTreeMap::new(),
        sample_titles: BTreeMap::new(),
        sample_titles_with_a: BTreeMap::new(),
    };
    let created = instant(0, total_items);

    let mut entity = connection
        .prepare_cached(
            "INSERT INTO entity (id, kind, title, created_at, updated_at, deleted_at, purge_at)
             VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6)",
        )
        .map_err(door)?;
    let mut edge = connection
        .prepare_cached(
            "INSERT OR IGNORE INTO edge (from_id, rel, to_id, created_at) VALUES (?1, ?2, ?3, ?4)",
        )
        .map_err(door)?;
    let mut put = |kind: &str,
                   key: &str,
                   title: &str,
                   at: &str,
                   trashed: bool,
                   until: &str|
     -> KitResult<()> {
        entity
            .execute(params![
                key,
                kind,
                title,
                at,
                trashed.then_some(at),
                trashed.then_some(until)
            ])
            .map_err(door)?;
        Ok(())
    };

    // Containers and the things that title what they hold.
    for index in 0..shape.notebooks {
        let key = id("notebook", index);
        let title = writer.title();
        put("notebook", &key, &title, &created, false, "")?;
        writer.finish("container");
        connection
            .execute(
                "INSERT INTO container (id, kind, position) VALUES (?1, 'notebook', ?2)",
                params![key, index as f64],
            )
            .map_err(door)?;
    }
    for index in 0..shape.folders {
        let key = id("folder", index);
        let title = writer.title();
        put("folder", &key, &title, &created, false, "")?;
        writer.finish("container");
        connection
            .execute(
                "INSERT INTO container (id, kind, position) VALUES (?1, 'folder', ?2)",
                params![key, index as f64],
            )
            .map_err(door)?;
    }
    for index in 0..shape.projects {
        let key = id("project", index);
        let title = writer.title();
        put("project", &key, &title, &created, false, "")?;
        writer.finish("container");
        connection
            .execute(
                "INSERT INTO container (id, kind, position) VALUES (?1, 'project', ?2)",
                params![key, index as f64],
            )
            .map_err(door)?;
    }
    for index in 0..shape.albums {
        let key = id("album", index);
        let title = writer.title();
        put("album", &key, &title, &created, false, "")?;
        writer.finish("container");
        connection
            .execute(
                "INSERT INTO container (id, kind, position) VALUES (?1, 'album', ?2)",
                params![key, index as f64],
            )
            .map_err(door)?;
    }
    for index in 0..shape.places {
        let key = id("place", index);
        let title = writer.title();
        put("place", &key, &title, &created, false, "")?;
        let address = writer.text(4, true);
        let locality = writer.text(1, true);
        writer.finish("container");
        connection
            .execute(
                "INSERT INTO place (id, lat, lon, address, locality, zone)
                 VALUES (?1, ?2, ?3, ?4, ?5, 'America/Los_Angeles')",
                params![
                    key,
                    36.0 + (index as f64) / 1_000.0,
                    -122.0 + (index as f64) / 1_000.0,
                    address,
                    locality
                ],
            )
            .map_err(door)?;
    }
    for index in 0..shape.tags {
        let key = id("tag", index);
        let title = writer.text(1, true);
        put("tag", &key, &title, &created, false, "")?;
        writer.finish("container");
        connection
            .execute(
                "INSERT INTO concept (id, kind, key) VALUES (?1, 'tag', ?2)",
                params![key, format!("{title}-{index}")],
            )
            .map_err(door)?;
    }
    for index in 0..shape.categories {
        let key = id("category", index);
        let title = writer.text(1 + index % 2, true);
        put("category", &key, &title, &created, false, "")?;
        writer.finish("container");
        connection
            .execute(
                "INSERT INTO concept (id, kind, key) VALUES (?1, 'category', ?2)",
                params![key, format!("{title}-{index}")],
            )
            .map_err(door)?;
    }
    for index in 0..shape.accounts {
        let key = id("account", index);
        let title = writer.text(2, true);
        put("account", &key, &title, &created, false, "")?;
        writer.finish("container");
        connection
            .execute(
                "INSERT INTO account (id, type, currency, opening_minor)
                 VALUES (?1, ?2, 'USD', 0)",
                params![
                    key,
                    ["checking", "savings", "credit_card", "cash"][index % 4]
                ],
            )
            .map_err(door)?;
    }

    for index in 0..shape.workout_kinds {
        let key = id("workout_kind", index);
        let title = writer.text(1, true);
        put("workout_kind", &key, &title, &created, false, "")?;
        writer.finish("container");
        connection
            .execute(
                "INSERT INTO concept (id, kind, key) VALUES (?1, 'workout_kind', ?2)",
                params![key, format!("{title}-{index}")],
            )
            .map_err(door)?;
    }

    // One creation order for everything a member makes, so `entity.n` is a
    // timeline: shuffled, deterministic.
    let mut order: Vec<Item> = Vec::with_capacity(total_items);
    for (item, count) in [
        (Item::Note, shape.notes),
        (Item::Document, shape.documents),
        (Item::Photo, shape.photos),
        (Item::Person, shape.people),
        (Item::Event, shape.events),
        (Item::Task, shape.tasks),
        (Item::Txn, shape.transactions),
        (Item::Locker, shape.locker_items),
        (Item::Activity, shape.activities),
        (Item::Thread, shape.threads),
    ] {
        order.extend(std::iter::repeat_n(item, count));
    }
    for at in (1..order.len()).rev() {
        let swap = writer.random.upto(at + 1);
        order.swap(at, swap);
    }

    let mut next: BTreeMap<&str, usize> = BTreeMap::new();
    let mut take = |kind: &'static str| -> usize {
        let slot = next.entry(kind).or_insert(0);
        let index = *slot;
        *slot += 1;
        index
    };
    for (position, item) in order.iter().enumerate() {
        let at = instant(position, total_items);
        let until = instant(position + total_items, total_items * 2);
        // About one in thirty-three is in the trash.
        let trashed = writer.random.upto(33) == 0;
        let kind = match item {
            Item::Note => "note",
            Item::Document => "document",
            Item::Photo => "photo",
            Item::Person => "person",
            Item::Event => "event",
            Item::Task => "task",
            Item::Txn => "txn",
            Item::Locker => "locker_item",
            Item::Activity => "activity",
            Item::Thread => "thread",
        };
        match item {
            Item::Note => {
                let index = take("note");
                let key = id("note", index);
                let title = writer.title();
                put("note", &key, &title, &at, trashed, &until)?;
                let words = if index < shape.long_notes {
                    shape.long_note_words
                } else {
                    writer.length(shape.note_words, 0.7, 4, 600)
                };
                let body = writer.text(words, false);
                counts.words_written += words;
                let notebook = (writer.random.upto(3) == 0)
                    .then(|| id("notebook", writer.random.upto(shape.notebooks.max(1))));
                connection
                    .execute(
                        "INSERT INTO note (id, body, format, notebook_id) VALUES (?1, ?2, 'markdown', ?3)",
                        params![key, body, notebook],
                    )
                    .map_err(door)?;
                if writer.random.upto(5) == 0 && shape.tags > 0 {
                    let tag = id("tag", writer.random.upto(shape.tags));
                    edge.execute(params![key, "tagged", tag, at])
                        .map_err(door)?;
                }
                counts.notes += 1;
            }
            Item::Document => {
                let index = take("document");
                let key = id("document", index);
                let title = writer.title();
                put("document", &key, &title, &at, trashed, &until)?;
                let words = writer.length(shape.document_words, 0.6, 60, 9_000);
                let text = writer.text(words, false);
                counts.words_written += words;
                let hash = hash_of(0x5d0c, index);
                connection
                    .execute(
                        "INSERT INTO blob (hash, size) VALUES (?1, ?2)",
                        params![hash, (words * 6) as i64],
                    )
                    .map_err(door)?;
                connection
                    .execute(
                        "INSERT INTO derivative (blob, variant, text, created_at)
                         VALUES (?1, 'text', ?2, ?3)",
                        params![hash, text, at],
                    )
                    .map_err(door)?;
                let folder =
                    (shape.folders > 0).then(|| id("folder", writer.random.upto(shape.folders)));
                connection
                    .execute(
                        "INSERT INTO document (id, blob, media_type, folder_id)
                         VALUES (?1, ?2, 'application/pdf', ?3)",
                        params![key, hash, folder],
                    )
                    .map_err(door)?;
                counts.documents += 1;
            }
            Item::Photo => {
                let index = take("photo");
                let key = id("photo", index);
                let title = format!("IMG {index:06}");
                put("photo", &key, &title, &at, trashed, &until)?;
                let hash = hash_of(0x9407, index);
                connection
                    .execute(
                        "INSERT INTO blob (hash, size) VALUES (?1, ?2)",
                        params![hash, 2_000_000],
                    )
                    .map_err(door)?;
                let place = (shape.places > 0 && writer.random.upto(2) == 0)
                    .then(|| id("place", writer.random.upto(shape.places)));
                connection
                    .execute(
                        "INSERT INTO photo
                           (id, blob, media_type, form, taken_at, offset_min, width, height, place_id)
                         VALUES (?1, ?2, 'image/jpeg', 'photo', ?3, -420, 4032, 3024, ?4)",
                        params![key, hash, at, place],
                    )
                    .map_err(door)?;
                // A caption is a short sentence; two in three photographs have one.
                if writer.random.upto(3) != 0 {
                    let words = 6 + writer.random.upto(10);
                    let caption = writer.text(words, false);
                    counts.words_written += words;
                    connection
                        .execute(
                            "INSERT INTO derivative (blob, variant, text, created_at)
                             VALUES (?1, 'caption', ?2, ?3)",
                            params![hash, caption, at],
                        )
                        .map_err(door)?;
                }
                if shape.albums > 0 && writer.random.upto(6) == 0 {
                    let album = id("album", writer.random.upto(shape.albums));
                    edge.execute(params![album, "contains", key, at])
                        .map_err(door)?;
                }
                counts.photos += 1;
            }
            Item::Person => {
                let index = take("person");
                let key = id("person", index);
                let title = writer.text(2, true);
                put("person", &key, &title, &at, trashed, &until)?;
                let nickname = (writer.random.upto(3) == 0).then(|| writer.text(1, true));
                let role = writer.text_of(1, 2, true);
                connection
                    .execute(
                        "INSERT INTO person (id, form, nickname, role) VALUES (?1, 'person', ?2, ?3)",
                        params![key, nickname, role],
                    )
                    .map_err(door)?;
                if writer.random.upto(2) == 0 {
                    let handle = writer.text(1, true);
                    let value = format!("{handle}{index}@example.com");
                    connection
                        .execute(
                            "INSERT INTO contact_point (id, person_id, kind, value, normalized, position)
                             VALUES (?1, ?2, 'email', ?3, ?3, 0)",
                            params![format!("contact-{index:06}"), key, value],
                        )
                        .map_err(door)?;
                }
                counts.people += 1;
            }
            Item::Event => {
                let index = take("event");
                let key = id("event", index);
                let title = writer.title();
                put("event", &key, &title, &at, trashed, &until)?;
                let description = (writer.random.upto(2) == 0).then(|| {
                    let words = 6 + writer.random.upto(30);
                    writer.text(words, false)
                });
                let place = (shape.places > 0 && writer.random.upto(3) == 0)
                    .then(|| id("place", writer.random.upto(shape.places)));
                let repeats = index < shape.recurring_events;
                connection
                    .execute(
                        "INSERT INTO event (id, starts, timing, zone, rule, calendar_id, place_id, description)
                         VALUES (?1, ?2, 'zoned', 'America/Los_Angeles', ?3, 'calendar:default', ?4, ?5)",
                        params![key, at, repeats.then_some("FREQ=WEEKLY"), place, description],
                    )
                    .map_err(door)?;
                if repeats {
                    for step in 0..shape.occurrences_per_series {
                        let moved = instant(position + step + 1, total_items);
                        let note = (step % 2 == 0).then(|| writer.text(3, true));
                        connection
                            .execute(
                                "INSERT INTO occurrence (series_id, original_start, scope, cancelled, starts, title)
                                 VALUES (?1, ?2, 'occurrence', ?3, ?4, ?5)",
                                params![key, moved, i64::from(step % 3 == 2), moved, note],
                            )
                            .map_err(door)?;
                        counts.occurrences += 1;
                    }
                }
                counts.events += 1;
            }
            Item::Task => {
                let index = take("task");
                let key = id("task", index);
                let title = writer.title();
                put("task", &key, &title, &at, trashed, &until)?;
                let description = (writer.random.upto(3) == 0).then(|| {
                    let words = 8 + writer.random.upto(40);
                    writer.text(words, false)
                });
                let done = writer.random.upto(10) < 3;
                let project = (shape.projects > 0 && writer.random.upto(2) == 0)
                    .then(|| id("project", writer.random.upto(shape.projects)));
                connection
                    .execute(
                        "INSERT INTO task (id, status, done_at, project_id, description)
                         VALUES (?1, ?2, ?3, ?4, ?5)",
                        params![
                            key,
                            if done { "done" } else { "open" },
                            done.then_some(&at),
                            project,
                            description
                        ],
                    )
                    .map_err(door)?;
                counts.tasks += 1;
            }
            Item::Txn => {
                let index = take("txn");
                let key = id("txn", index);
                let title = writer.text_of(2, 3, false);
                put("txn", &key, &title, &at, trashed, &until)?;
                let account = id("account", writer.random.upto(shape.accounts.max(1)));
                let category = (shape.categories > 0 && writer.random.upto(5) != 0)
                    .then(|| id("category", writer.random.upto(shape.categories)));
                let amount = -(500 + writer.random.upto(20_000) as i64);
                connection
                    .execute(
                        "INSERT INTO txn (id, account_id, currency, posted_on, amount_minor, category_id)
                         VALUES (?1, ?2, 'USD', ?3, ?4, ?5)",
                        params![key, account, &at[..10], amount, category],
                    )
                    .map_err(door)?;
                counts.transactions += 1;
            }
            Item::Locker => {
                let index = take("locker");
                let key = id("locker", index);
                let title = writer.text_of(2, 2, false);
                // A Locker item is never in the trash here: the shelf walk's own
                // archive and trash rules are not what this corpus measures.
                put("locker_item", &key, &title, &at, false, &until)?;
                let kind = ["login", "login", "login", "card", "note", "wifi"][index % 6];
                // Only a login has an account name and an address, and only the
                // words that are stored are counted as held.
                let (username, host) = if kind == "login" {
                    (Some(writer.text(1, true)), Some(writer.text(1, true)))
                } else {
                    (None, None)
                };
                let notes = (writer.random.upto(3) == 0).then(|| {
                    let words = 6 + writer.random.upto(20);
                    writer.text(words, false)
                });
                connection
                    .execute(
                        "INSERT INTO locker_item (id, type, username, url, notes)
                         VALUES (?1, ?2, ?3, ?4, ?5)",
                        params![
                            key,
                            kind,
                            username,
                            host.map(|host| format!("https://{host}.example.com")),
                            notes
                        ],
                    )
                    .map_err(door)?;
                counts.locker_items += 1;
            }
            Item::Activity => {
                let index = take("activity");
                let key = id("activity", index);
                put("activity", &key, "Workout", &at, trashed, &until)?;
                let kind_id = id("workout_kind", index % shape.workout_kinds.max(1));
                connection
                    .execute(
                        "INSERT INTO activity (id, type_id, type_kind, starts, ends)
                         VALUES (?1, ?2, 'workout_kind', ?3, ?3)",
                        params![key, kind_id, at],
                    )
                    .map_err(door)?;
                connection
                    .execute(
                        "INSERT INTO workout (id, moving_s, distance_m, energy_kcal, heart_bpm)
                         VALUES (?1, ?2, ?3, ?4, ?5)",
                        params![
                            key,
                            600 + writer.random.upto(5_000) as i64,
                            1_000.0 + writer.random.upto(20_000) as f64,
                            100.0 + writer.random.upto(900) as f64,
                            90 + writer.random.upto(80) as i64
                        ],
                    )
                    .map_err(door)?;
                counts.activities += 1;
            }
            Item::Thread => {
                let index = take("thread");
                let key = id("thread", index);
                let title = writer.title();
                put("thread", &key, &title, &at, false, &until)?;
                connection
                    .execute(
                        "INSERT INTO thread (id, scope) VALUES (?1, NULL)",
                        params![key],
                    )
                    .map_err(door)?;
                for ordinal in 0..shape.messages_per_thread {
                    let user = ordinal % 2 == 0;
                    let words = 5 + writer.random.upto(40);
                    let text = writer.text(words, false);
                    counts.words_written += words;
                    connection
                        .execute(
                            "INSERT INTO message (thread_id, ordinal, role, text, outcome, created_at, updated_at)
                             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
                            params![
                                key,
                                ordinal as i64,
                                if user { "user" } else { "assistant" },
                                text,
                                if user { "sent" } else { "answered" },
                                at
                            ],
                        )
                        .map_err(door)?;
                    counts.messages += 1;
                }
                counts.threads += 1;
            }
        }
        if trashed && kind != "locker_item" {
            // A trashed entity is not in the index, so what only it says is said
            // by nothing a search can find.
            writer.scratch.clear();
        } else {
            writer.finish(kind);
        }
    }

    // The tables nothing searches: health's days, a note's older bodies, and
    // Locker's receipts. Written after the timeline, with the time they were made.
    let me: String = connection
        .query_row("SELECT self_id FROM vault", [], |row| row.get(0))
        .map_err(door)?;
    let metrics = [
        "steps",
        "active_energy_kcal",
        "exercise_min",
        "sleep_min",
        "resting_hr_bpm",
        "weight_kg",
    ];
    for day in 0..shape.measurement_days {
        let stamp = instant(day, shape.measurement_days);
        for metric in metrics {
            connection
                .execute(
                    "INSERT OR IGNORE INTO measurement (person_id, day, metric, value)
                     VALUES (?1, ?2, ?3, ?4)",
                    params![
                        me,
                        &stamp[..10],
                        metric,
                        100.0 + writer.random.upto(9_000) as f64
                    ],
                )
                .map_err(door)?;
            counts.measurements += 1;
        }
    }
    for index in 0..shape.revisions {
        let note = id("note", writer.random.upto(shape.notes.max(1)));
        let body = writer.text(20, false);
        // `seq` counts per note: the first revision of a note is 1, and a note
        // revised again is the next, so a counter keyed by the note's id.
        let seq: i64 = connection
            .query_row(
                "SELECT coalesce(max(seq), 0) + 1 FROM revision WHERE entity_id = ?1",
                params![note],
                |row| row.get(0),
            )
            .map_err(door)?;
        connection
            .execute(
                "INSERT INTO revision (entity_id, seq, at, body) VALUES (?1, ?2, ?3, ?4)",
                params![note, seq, instant(index, shape.revisions), body],
            )
            .map_err(door)?;
        counts.revisions += 1;
    }
    for index in 0..shape.receipts {
        connection
            .execute(
                "INSERT INTO receipt (at, item_id, act, journal_seq) VALUES (?1, ?2, ?3, ?4)",
                params![
                    instant(index, shape.receipts),
                    id("locker", writer.random.upto(shape.locker_items.max(1))),
                    ["reveal", "unlock", "copy"][index % 3],
                    index as i64
                ],
            )
            .map_err(door)?;
        counts.receipts += 1;
    }

    counts.entities = connection
        .query_row("SELECT count(*) FROM entity", [], |row| {
            row.get::<_, i64>(0)
        })
        .map_err(door)? as usize;
    let tally = |held: &[u32]| -> Vec<(String, u32)> {
        let mut frequency: Vec<(String, u32)> = held
            .iter()
            .enumerate()
            .filter(|(_, held)| **held > 0)
            .map(|(rank, held)| (vocabulary.word(rank).to_owned(), *held))
            .collect();
        frequency.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));
        frequency
    };
    for kind in [
        "note",
        "document",
        "person",
        "event",
        "task",
        "txn",
        "locker_item",
    ] {
        let pairs: Vec<String> = connection
            .prepare(
                "SELECT title FROM entity WHERE kind = ?1 AND deleted_at IS NULL
                  ORDER BY n LIMIT 60 OFFSET 40",
            )
            .and_then(|mut statement| {
                statement
                    .query_map([kind], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()
            })
            .unwrap_or_default();
        let title = pairs
            .into_iter()
            .find(|title| adjacent_pair(title).is_some());
        if let Some(title) = title {
            counts.sample_titles.insert(kind.to_owned(), title);
        }
        let candidates: Vec<String> = connection
            .prepare(
                "SELECT title FROM entity WHERE kind = ?1 AND deleted_at IS NULL
                    AND title LIKE '% a %'
                  ORDER BY n LIMIT 60 OFFSET 10",
            )
            .and_then(|mut statement| {
                statement
                    .query_map([kind], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()
            })
            .unwrap_or_default();
        let with_a = candidates
            .into_iter()
            .find(|title| a_then_word(title).is_some());
        if let Some(title) = with_a {
            counts.sample_titles_with_a.insert(kind.to_owned(), title);
        }
    }
    counts.frequency = tally(&writer.df);
    counts.distinct_words = counts.frequency.len();
    for (kind, held) in &writer.df_by_kind {
        counts
            .frequency_by_kind
            .insert((*kind).to_owned(), tally(held));
    }
    Ok(counts)
}
