//! The index's words, read through a cache that asks the table whether it is
//! still right.
//!
//! `search_word` is the list a correction reads whole (`crates/vault/src/index.rs`
//! keeps it). Reading 150,000 rows for every misspelt query is the cost the list
//! exists to avoid, so a [`Vault`](crate::Vault) keeps what it read and asks the
//! table, with one statement, whether that is still the table. (The statement
//! is three subqueries rather than one `SELECT max(n), count(*)`: with two
//! aggregates in one query SQLite reads every row for both, 7 ms at 150,000
//! words, where the highest number is a descent of the tree and the count walks
//! its pages, 40 microseconds in all.)
//!
//! | The table, against the cache | It means | The cache |
//! | --- | --- | --- |
//! | same highest `n`, same count, same word at that `n` | nothing was written | kept |
//! | highest `n` and count grew by the same amount, same word at the old highest `n` | words were appended | the tail is read (`WHERE n > ?`) |
//! | anything else | a purge, a rebuild, a restore, a rolled-back number given out again | read again, whole |
//!
//! **What the check cannot see.** It reads three numbers and a word, not the
//! table, so it cannot tell a table from another that agrees on all four. The
//! writer only appends, and a purge or a rebuild changes the count, the highest
//! number or the word at the old highest number unless it removes the top words
//! and then appends as many that end in the very word that was at the top: the
//! one case a cache of this kind keeps wrongly, and one a surface that cannot
//! accept it can close by reading through a fresh [`Vault`](crate::Vault).
//! [`Words::loads`] says how often each kind of read happened.
//!
//! **Outside a commit only.** Inside one the table holds rows that may be rolled
//! back, and a cache that kept them would hold words nothing indexed.

use std::cell::{Ref, RefCell};

use rusqlite::Connection;

use crate::error::{Result, VaultError};

/// THE WORDS, PACKED: every word end to end in one buffer, with where each ends.
///
/// A correction reads the whole list (a hundred thousand words and more) for every
/// misspelt query. As a `Vec<String>` each word is a heap allocation of its own, and
/// walking the list is a cache miss per word: 10 ms of the correction at 200,000
/// words went to chasing pointers, not to the comparing. Packed, the walk is one
/// sequential read of about two megabytes.
#[derive(Default)]
pub struct WordList {
    text: String,
    /// `ends[i]` is where word `i` stops in `text`; it starts where the one
    /// before stopped.
    ends: Vec<usize>,
}

impl WordList {
    fn push(&mut self, word: &str) {
        self.text.push_str(word);
        self.ends.push(self.text.len());
    }

    /// How many words.
    #[must_use]
    pub fn len(&self) -> usize {
        self.ends.len()
    }

    /// Whether there are none.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.ends.is_empty()
    }

    /// The last word, the one with the highest number.
    #[must_use]
    pub fn last(&self) -> Option<&str> {
        let end = *self.ends.last()?;
        let start = self.ends.iter().rev().nth(1).copied().unwrap_or(0);
        Some(&self.text[start..end])
    }

    /// The words, in the order they arrived.
    pub fn iter(&self) -> impl Iterator<Item = &str> + Clone {
        let mut start = 0;
        self.ends.iter().map(move |&end| {
            let word = &self.text[start..end];
            start = end;
            word
        })
    }

    /// The words that contain `fragment`, are longer than it and do not start with it,
    /// in the order they arrived: the same words as filtering [`Self::iter`] by
    /// `contains`, found by searching the packed text once and not by asking each word.
    #[must_use]
    pub fn containing(&self, fragment: &str) -> Vec<&str> {
        let mut found = Vec::new();
        if fragment.is_empty() {
            return found;
        }
        let mut from = 0;
        while let Some(at) = self.text[from..].find(fragment) {
            let at = from + at;
            let index = self.ends.partition_point(|&end| end <= at);
            let Some(&end) = self.ends.get(index) else {
                break;
            };
            let start = if index == 0 { 0 } else { self.ends[index - 1] };
            if at + fragment.len() <= end {
                let word = &self.text[start..end];
                if word.len() > fragment.len() && !word.starts_with(fragment) {
                    found.push(word);
                }
                // One hit is enough for this word.
                from = end;
            } else {
                // The match runs over the end of a word into the next: no word has
                // it, and a later one in this word may.
                from = at + fragment[..].chars().next().map_or(1, char::len_utf8);
            }
        }
        found
    }

    /// The words as owned strings, for a caller that keeps them.
    #[must_use]
    pub fn to_vec(&self) -> Vec<String> {
        self.iter().map(str::to_owned).collect()
    }
}

/// What the cache holds: the words in the order they arrived, and the two
/// numbers it checks them by.
#[derive(Default)]
struct Cache {
    /// Whether anything has been read: an empty table and a cache that has
    /// never looked are different states.
    loaded: bool,
    words: WordList,
    /// The highest `n` read, `0` for none. The words are in `n` order, so the
    /// word at this `n` is the last.
    last: i64,
    /// How many rows the table had when it was read.
    count: i64,
    full_loads: u64,
    tail_loads: u64,
}

/// How often the cache read the table, by kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Loads {
    /// The whole table, read from the start.
    pub full: u64,
    /// Only the rows after the highest number the cache had.
    pub tail: u64,
}

/// A vault's cache of its `search_word` table.
#[derive(Default)]
pub struct Words {
    cache: RefCell<Cache>,
}

impl Words {
    /// The words the index holds, in the order they arrived, current as of this
    /// call. Cheap when nothing was written (one statement), cheaper than a
    /// reload when words were appended.
    ///
    /// The list is borrowed from the cache: it must be dropped before the next
    /// call that finds the table changed, which is refused rather than
    /// panicked on.
    ///
    /// # Errors
    /// Called inside a commit; called while a slice from an earlier call is
    /// still held and the table has changed since; SQLite's refusal.
    pub fn current(&self, connection: &Connection) -> Result<Ref<'_, WordList>> {
        if !connection.is_autocommit() {
            return Err(VaultError::Invariant {
                context: "the word list is read outside a commit: inside one it holds rows \
                          that may be rolled back"
                    .to_owned(),
            });
        }
        let verdict = self.verdict(connection)?;
        if verdict != Verdict::Kept {
            let mut cache = self
                .cache
                .try_borrow_mut()
                .map_err(|_| VaultError::Invariant {
                    context: "the word list changed while an earlier read of it was still held"
                        .to_owned(),
                })?;
            cache.refresh(connection, verdict)?;
        }
        Ok(Ref::map(self.cache.borrow(), |cache| &cache.words))
    }

    /// How often the table was read whole and how often only its tail.
    #[must_use]
    pub fn loads(&self) -> Loads {
        let cache = self.cache.borrow();
        Loads {
            full: cache.full_loads,
            tail: cache.tail_loads,
        }
    }

    /// Ask the table, in one statement, what the cache is against it.
    fn verdict(&self, connection: &Connection) -> Result<Verdict> {
        let cache = self.cache.borrow();
        if !cache.loaded {
            return Ok(Verdict::Whole);
        }
        let mut ask = connection.prepare_cached(
            "SELECT (SELECT max(n) FROM search_word),
                    (SELECT count(*) FROM search_word),
                    (SELECT word FROM search_word WHERE n = ?1)",
        )?;
        let (highest, count, at_last): (Option<i64>, i64, Option<String>) = ask
            .query_row([cache.last], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })?;
        let highest = highest.unwrap_or(0);
        let same_last = at_last.as_deref() == cache.words.last();
        Ok(if !same_last {
            Verdict::Whole
        } else if highest == cache.last && count == cache.count {
            Verdict::Kept
        } else if highest > cache.last && highest - cache.last == count - cache.count {
            Verdict::Tail
        } else {
            Verdict::Whole
        })
    }
}

/// What to do with the cache.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Verdict {
    Kept,
    Tail,
    Whole,
}

impl Cache {
    fn refresh(&mut self, connection: &Connection, verdict: Verdict) -> Result<()> {
        if verdict == Verdict::Tail {
            let appended = self.read_after(connection, self.last)?;
            let mut ask = connection.prepare_cached(
                "SELECT (SELECT max(n) FROM search_word), (SELECT count(*) FROM search_word)",
            )?;
            let (highest, count): (Option<i64>, i64) =
                ask.query_row([], |row| Ok((row.get(0)?, row.get(1)?)))?;
            // The tail has to be exactly what the check said it was; if the
            // table moved between the two statements, start again from the top.
            if i64::try_from(appended.len()).ok() == Some(count - self.count) {
                for (_, word) in &appended {
                    self.words.push(word);
                }
                self.last = highest.unwrap_or(0);
                self.count = count;
                self.tail_loads += 1;
                return Ok(());
            }
        }
        let all = self.read_after(connection, 0)?;
        self.last = all.last().map_or(0, |&(n, _)| n);
        self.count = i64::try_from(all.len()).unwrap_or(i64::MAX);
        self.words = WordList::default();
        for (_, word) in &all {
            self.words.push(word);
        }
        self.loaded = true;
        self.full_loads += 1;
        Ok(())
    }

    /// The rows after `n`, in `n` order.
    fn read_after(&self, connection: &Connection, n: i64) -> Result<Vec<(i64, String)>> {
        let mut statement =
            connection.prepare_cached("SELECT n, word FROM search_word WHERE n > ?1 ORDER BY n")?;
        let rows = statement
            .query_map([n], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }
}

/// The word at a number, for a test that needs to say what is where.
#[cfg(test)]
fn word_at(connection: &Connection, n: i64) -> Option<String> {
    use rusqlite::OptionalExtension;
    connection
        .query_row("SELECT word FROM search_word WHERE n = ?1", [n], |row| {
            row.get(0)
        })
        .optional()
        .expect("reads")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table() -> Connection {
        let connection = Connection::open_in_memory().expect("a connection");
        connection
            .execute_batch(
                "CREATE TABLE search_word (n INTEGER PRIMARY KEY, word TEXT NOT NULL UNIQUE) STRICT;",
            )
            .expect("the table");
        connection
    }

    fn add(connection: &Connection, words: &[&str]) {
        for word in words {
            connection
                .execute(
                    "INSERT OR IGNORE INTO search_word (word) VALUES (?1)",
                    [word],
                )
                .expect("a word");
        }
    }

    fn held(words: &Words, connection: &Connection) -> Vec<String> {
        words.current(connection).expect("reads").to_vec()
    }

    fn loads(words: &Words) -> (u64, u64) {
        let loads = words.loads();
        (loads.full, loads.tail)
    }

    #[test]
    fn the_first_read_is_whole_and_an_unchanged_table_is_not_read_again() {
        let connection = table();
        add(&connection, &["alpha", "beta"]);
        let words = Words::default();
        assert_eq!(held(&words, &connection), ["alpha", "beta"]);
        assert_eq!(loads(&words), (1, 0));
        assert_eq!(held(&words, &connection), ["alpha", "beta"]);
        assert_eq!(
            loads(&words),
            (1, 0),
            "nothing was written, nothing was read"
        );
    }

    /// `containing` is the filter it replaces, over words that run into each other in
    /// the packed text (`ab` + `cd` holds `bc`, and no word does).
    #[test]
    fn the_words_containing_a_fragment_are_the_words_that_contain_it() {
        let words = [
            "ab",
            "cd",
            "abcd",
            "bcd",
            "xbcx",
            "bc",
            "cbcbc",
            "sunscreen",
            "screen",
            "éclair",
            "relé",
            "eclair",
            "screens",
            "abab",
            "ba",
        ];
        let mut list = WordList::default();
        for word in words {
            list.push(word);
        }
        for fragment in [
            "bc", "cb", "screen", "abc", "ab", "ba", "cl", "é", "lé", "xyz", "cdx",
        ] {
            let expected: Vec<&str> = list
                .iter()
                .filter(|held| {
                    held.len() > fragment.len()
                        && held.contains(fragment)
                        && !held.starts_with(fragment)
                })
                .collect();
            assert_eq!(list.containing(fragment), expected, "`{fragment}`");
        }
        assert!(list.containing("").is_empty());
    }

    #[test]
    fn an_empty_table_is_a_loaded_cache_and_stays_one() {
        let connection = table();
        let words = Words::default();
        assert!(held(&words, &connection).is_empty());
        assert!(held(&words, &connection).is_empty());
        assert_eq!(loads(&words), (1, 0));
        add(&connection, &["alpha"]);
        assert_eq!(held(&words, &connection), ["alpha"]);
        assert_eq!(
            loads(&words),
            (1, 1),
            "words appended to an empty table are a tail"
        );
    }

    #[test]
    fn appended_words_are_read_as_a_tail() {
        let connection = table();
        add(&connection, &["alpha", "beta"]);
        let words = Words::default();
        held(&words, &connection);
        add(&connection, &["gamma", "delta", "alpha"]);
        assert_eq!(
            held(&words, &connection),
            ["alpha", "beta", "gamma", "delta"]
        );
        assert_eq!(loads(&words), (1, 1));
        add(&connection, &["epsilon"]);
        assert_eq!(
            held(&words, &connection),
            ["alpha", "beta", "gamma", "delta", "epsilon"]
        );
        assert_eq!(loads(&words), (1, 2));
    }

    #[test]
    fn a_word_that_was_already_there_appends_nothing() {
        let connection = table();
        add(&connection, &["alpha", "beta"]);
        let words = Words::default();
        held(&words, &connection);
        add(&connection, &["beta", "alpha"]);
        held(&words, &connection);
        assert_eq!(loads(&words), (1, 0));
    }

    #[test]
    fn a_rolled_back_write_never_reaches_the_cache_and_its_numbers_are_given_out_again() {
        let connection = table();
        add(&connection, &["alpha", "beta"]);
        let words = Words::default();
        held(&words, &connection);

        // A transaction that adds words and rolls back: the cache never saw them.
        connection.execute_batch("BEGIN").expect("begins");
        add(&connection, &["ghost", "phantom"]);
        connection.execute_batch("ROLLBACK").expect("rolls back");
        assert_eq!(held(&words, &connection), ["alpha", "beta"]);
        assert_eq!(loads(&words), (1, 0));

        // The numbers the rollback gave back are given out again, to other words.
        add(&connection, &["gamma", "delta"]);
        assert_eq!(word_at(&connection, 3).as_deref(), Some("gamma"));
        assert_eq!(
            held(&words, &connection),
            ["alpha", "beta", "gamma", "delta"]
        );
        assert_eq!(loads(&words), (1, 1));
    }

    #[test]
    fn a_number_given_out_again_to_another_word_is_a_whole_read() {
        let connection = table();
        add(&connection, &["alpha", "beta"]);
        let words = Words::default();
        held(&words, &connection);
        add(&connection, &["gamma", "delta"]);
        held(&words, &connection);
        // The two words go, and two others take their numbers.
        connection
            .execute("DELETE FROM search_word WHERE n > 2", [])
            .expect("deletes");
        add(&connection, &["sigma", "tau"]);
        assert_eq!(held(&words, &connection), ["alpha", "beta", "sigma", "tau"]);
        assert_eq!(
            loads(&words),
            (2, 1),
            "same count, same highest number, another word at it"
        );
    }

    #[test]
    fn a_purge_is_a_whole_read() {
        let connection = table();
        add(&connection, &["alpha", "beta", "gamma"]);
        let words = Words::default();
        held(&words, &connection);
        // A word below the top goes: the count falls and the highest number does not.
        connection
            .execute("DELETE FROM search_word WHERE word = 'alpha'", [])
            .expect("deletes");
        assert_eq!(held(&words, &connection), ["beta", "gamma"]);
        assert_eq!(loads(&words), (2, 0));
        // The top word goes and another takes its number.
        connection
            .execute("DELETE FROM search_word WHERE word = 'gamma'", [])
            .expect("deletes");
        add(&connection, &["delta"]);
        assert_eq!(held(&words, &connection), ["beta", "delta"]);
        assert_eq!(loads(&words), (3, 0));
        // Words go and more arrive: the count and the highest number move
        // differently.
        connection
            .execute("DELETE FROM search_word WHERE word = 'beta'", [])
            .expect("deletes");
        add(&connection, &["epsilon", "zeta"]);
        assert_eq!(held(&words, &connection), ["delta", "epsilon", "zeta"]);
        assert_eq!(loads(&words), (4, 0));
    }

    #[test]
    fn a_rebuilt_or_restored_table_is_a_whole_read_even_when_it_is_as_long() {
        let connection = table();
        add(&connection, &["alpha", "beta", "gamma"]);
        let words = Words::default();
        held(&words, &connection);
        // The same number of words, the same numbers, other words.
        connection
            .execute("DELETE FROM search_word", [])
            .expect("empties");
        add(&connection, &["zeta", "eta", "theta"]);
        assert_eq!(held(&words, &connection), ["zeta", "eta", "theta"]);
        assert_eq!(loads(&words), (2, 0));
        // Emptied altogether.
        connection
            .execute("DELETE FROM search_word", [])
            .expect("empties");
        assert!(held(&words, &connection).is_empty());
        assert_eq!(loads(&words), (3, 0));
    }

    #[test]
    fn a_read_inside_a_commit_is_refused() {
        let connection = table();
        add(&connection, &["alpha"]);
        let words = Words::default();
        connection.execute_batch("BEGIN").expect("begins");
        let refused = words.current(&connection).map(|held| held.len());
        connection.execute_batch("ROLLBACK").expect("rolls back");
        assert!(matches!(refused, Err(VaultError::Invariant { .. })));
        assert_eq!(loads(&words), (0, 0), "and it read nothing");
    }

    #[test]
    fn a_changed_table_is_refused_not_panicked_on_while_a_read_is_held() {
        let connection = table();
        add(&connection, &["alpha"]);
        let words = Words::default();
        let first = words.current(&connection).expect("reads");
        // Nothing changed: another read alongside is fine.
        assert_eq!(words.current(&connection).expect("reads").len(), 1);
        add(&connection, &["beta"]);
        let refused = words.current(&connection).map(|held| held.len());
        assert!(matches!(refused, Err(VaultError::Invariant { .. })));
        drop(first);
        assert_eq!(held(&words, &connection), ["alpha", "beta"]);
    }

    /// A vault's own cache follows the words its commits add and its purges take.
    #[test]
    fn a_vault_serves_the_words_its_commits_index() {
        let dir = centraid_ontology::scratch::scratch_dir();
        std::fs::create_dir_all(&dir).expect("a scratch directory");
        let vault = crate::Vault::create(dir.join("vault.db")).expect("a vault");
        vault.found("Test", "Test Owner").expect("founded");
        let held = |vault: &crate::Vault| -> Vec<String> {
            vault
                .read(|connection| Ok(vault.words().current(connection)?.to_vec()))
                .expect("reads")
        };
        let before = held(&vault);
        vault
            .commit(|tx| {
                tx.insert_entity(
                    "n1",
                    crate::model::Kind::Note,
                    "Zeppelin",
                    "2026-03-01T09:00:00.000Z",
                )?;
                tx.connection()
                    .execute("INSERT INTO note (id, body) VALUES ('n1', 'hangar')", [])?;
                Ok(())
            })
            .expect("commits");
        let after = held(&vault);
        assert!(after.len() > before.len());
        assert!(after.iter().any(|word| word == "zeppelin"));
        assert!(after.iter().any(|word| word == "hangar"));
        assert!(
            vault.words().loads().tail >= 1,
            "a commit appends: the tail is read"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// THE COST, measured and not guessed: 150,000 words, read whole, checked
    /// when nothing changed, and read as a tail of 1,000. Run it with
    /// `cargo test -p centraid-vault --lib words::tests::the_cost -- --ignored --nocapture`.
    #[test]
    #[ignore = "a measurement, not a check: it prints what loading and validating cost"]
    fn the_cost_of_a_cache_of_150000_words() {
        println!("in memory:");
        measure(&table());
        println!("on disk:");
        let dir = centraid_ontology::scratch::scratch_dir();
        std::fs::create_dir_all(&dir).expect("a scratch directory");
        let connection = Connection::open(dir.join("words.db")).expect("a file");
        connection
            .execute_batch(
                "CREATE TABLE search_word (n INTEGER PRIMARY KEY, word TEXT NOT NULL UNIQUE) STRICT;",
            )
            .expect("the table");
        measure(&connection);
        drop(connection);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn measure(connection: &Connection) {
        use std::time::Instant;
        connection.execute_batch("BEGIN").expect("begins");
        {
            let mut insert = connection
                .prepare("INSERT INTO search_word (word) VALUES (?1)")
                .expect("prepares");
            for n in 0..150_000_u32 {
                // Words of a natural length: 4 to 11 letters, all different.
                let word = format!(
                    "{}{n:x}",
                    ["tra", "mon", "qui", "bel", "ost", "fre"][(n % 6) as usize]
                );
                insert.execute([word]).expect("a word");
            }
        }
        connection.execute_batch("COMMIT").expect("commits");

        let words = Words::default();
        let started = Instant::now();
        let loaded = words.current(connection).expect("loads").len();
        let full = started.elapsed();

        let started = Instant::now();
        for _ in 0..200 {
            assert!(!words.current(connection).expect("checks").is_empty());
        }
        let validate = started.elapsed() / 200;

        for n in 0..1_000 {
            add(connection, &[&format!("tail{n}")]);
        }
        let started = Instant::now();
        words.current(connection).expect("tails");
        let tail = started.elapsed();
        assert_eq!(loads(&words), (1, 1));

        // Where the validation spends it: the highest number and the word at a
        // number are lookups; the count walks the table.
        let mean = |sql: &str| {
            let started = Instant::now();
            for _ in 0..200 {
                let _: i64 = connection
                    .query_row(sql, [], |row| {
                        row.get::<_, Option<i64>>(0).map(|n| n.unwrap_or(0))
                    })
                    .or_else(|_| {
                        connection.query_row(sql, [], |row| {
                            row.get::<_, String>(0).map(|w| w.len() as i64)
                        })
                    })
                    .expect("reads");
            }
            started.elapsed() / 200
        };
        let (highest, count, word) = (
            mean("SELECT max(n) FROM search_word"),
            mean("SELECT count(*) FROM search_word"),
            mean("SELECT word FROM search_word WHERE n = 75000"),
        );

        println!(
            "words: {loaded} loaded whole in {full:?}; validated unchanged in {validate:?} \
             (mean of 200: max(n) {highest:?}, count(*) {count:?}, word at n {word:?}); \
             1,000 appended read as a tail in {tail:?}"
        );
    }
}
