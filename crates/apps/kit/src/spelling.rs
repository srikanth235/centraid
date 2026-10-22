//! ONE SPELLING RULE, for every surface that forgives a typo.
//!
//! The assistant's name resolver had a rule — **Damerau distance one** (a letter
//! more, fewer or different, or two neighbours swapped), read in a word of four
//! letters or more and never in a word with a digit
//! (`crates/assist/src/native/resolve.rs`). Search had none, and Locker's walker
//! had less. This module is that rule lifted to the one place all of them can
//! reach ([`within_one`], [`one_edit`]), plus what search needs on top of it: the
//! tokenization of a query ([`words`]), the fold the full-text index applies
//! ([`fold_like_index`]), and a correction that is **a lookup in the vault's own
//! words, never a guess** ([`near_words`], [`try_correct_words`]).
//!
//! ## Why correction, and not a fuzzy OR
//!
//! A fuzzy match widens every query for every member, on every keystroke, and
//! cannot say what it did. A correction replaces a word by a word the vault holds
//! and is reported: the caller runs the search again with the corrected words and
//! tells the member what it included ("Including results for budget"). A word the
//! vault does not know is never invented — a correction is one whole word of the
//! list the index keeps.
//!
//! ## What a word is corrected to ([`near_words`])
//!
//! The candidates are read from **the whole word list** in memory (the vault
//! keeps it, `crates/vault/src/words.rs`), not from ranges of the index's
//! vocabulary, so a slip anywhere in a word is found as readily as one at its end.
//!
//! * An **eligible** word has [`TYPO_MIN`] letters or more and nothing but
//!   letters ([`eligible`]), so `2025` is never `2026`, `abc` is never `abd`, and
//!   `a1b2` is left alone.
//! * A word some word of the list **starts with** is known ([`is_known`]) and is
//!   kept as typed: search is a prefix search, so `budg` is already a hit.
//! * Otherwise, the candidates in tiers, the first tier that has any:
//!   1. **One edit anywhere**: a word of the list within [`within_one`] of the
//!      typed word, or whose first `|w| - 1 ..= |w| + 1` letters are ([`near_prefix`]),
//!      so a slip made mid-word as you type (`budeg`) still lands on `budget`.
//!      Among these, those that keep the typed first letter; only when there is
//!      none do the ones that change it count (`gudget` finds `budget` only if
//!      the vault holds no `gudgex`). A typo in the first letter is rarer than one
//!      after it, and a first-letter candidate is a much wider net.
//!   2. **In-word**: the typed fragment appears inside a longer word
//!      (`screen` in `sunscreen`), for fragments of [`IN_WORD_MIN`] letters or
//!      more. It is the last resort because it is the widest.
//! * The caller then ranks the candidates by the documents that hold each, then
//!   the shorter word, then the one that sorts first, so the same vault answers
//!   the same ([`rank_order`]), and the answer is that **one whole word**.
//!
//! ## One rule, several users
//!
//! The assistant keeps a **different** measure for ranking a whole search's words
//! (`crates/assist/src/native/search.rs` `word_score`, Levenshtein with a limit of
//! two for words of seven letters or more): the 0.8B evaluation depends on it and
//! it is not touched. Everything that decides "is this one slip of the other
//! word" — the name resolver, the `where` language's codes, search — is
//! [`within_one`].

use std::collections::BTreeMap;

/// The shortest prefix of a name word a person's word may be (`kit` for
/// `kitchen`, never `ki`).
pub const PREFIX_MIN: usize = 3;

/// The shortest word a typo is read in.
pub const TYPO_MIN: usize = 4;

/// The shortest fragment read as the inside of a longer word. Under four letters
/// a fragment is inside a great many words, and the guess would be the vault's
/// most common.
pub const IN_WORD_MIN: usize = 4;

/// At most this many words of a query are read. v0's slice (`search.ts:34`): a
/// hundred-word paste is a question about the tokenizer's cost, not about the
/// member's notes.
pub const MAX_WORDS: usize = 16;

/// Whether two words are one edit apart: a letter more, fewer or different, or
/// two neighbours swapped. The word said is of [`TYPO_MIN`] letters or more and
/// has no digit.
#[must_use]
pub fn one_edit(word: &str, have: &str) -> bool {
    if word.chars().count() < TYPO_MIN
        || have.chars().count() < PREFIX_MIN
        || !word.chars().all(char::is_alphabetic)
    {
        return false;
    }
    within_one(word, have)
}

/// Whether two texts are one edit apart, whatever their length ([`one_edit`]
/// without its limits: a currency code of three letters is read with it).
#[must_use]
pub fn within_one(word: &str, have: &str) -> bool {
    let (a, b): (Vec<char>, Vec<char>) = (word.chars().collect(), have.chars().collect());
    if a == b || a.len().abs_diff(b.len()) > 1 {
        return false;
    }
    let common = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
    match a.len().cmp(&b.len()) {
        std::cmp::Ordering::Equal => {
            let after = common + 1;
            a[after..] == b[after..]
                || (a.len() > after
                    && a[common] == b[after]
                    && a[after] == b[common]
                    && a[after + 1..] == b[after + 1..])
        }
        std::cmp::Ordering::Greater => a[common + 1..] == b[common..],
        std::cmp::Ordering::Less => a[common..] == b[common + 1..],
    }
}

/// The words of a query, as the full-text door reads them: split on whitespace,
/// `"` removed, a token with no letter and no digit dropped, at most
/// [`MAX_WORDS`] kept.
///
/// **This is the only tokenization.** `crates/search`'s `match_expression`
/// quotes exactly these words, and a correction replaces exactly these words, so
/// the word a member sees corrected is the word the index was asked for.
#[must_use]
pub fn words(query: &str) -> Vec<String> {
    query
        .split_whitespace()
        .map(|token| token.replace('"', ""))
        .filter(|token| token.chars().any(char::is_alphanumeric))
        .take(MAX_WORDS)
        .collect()
}

/// Whether a word is read for a typo at all: [`TYPO_MIN`] letters or more and
/// nothing but letters. Give it the folded word ([`fold_like_index`]).
#[must_use]
pub fn eligible(word: &str) -> bool {
    word.chars().count() >= TYPO_MIN && word.chars().all(char::is_alphabetic)
}

/// What `unicode61 remove_diacritics 2` stores for a word. The fold itself, and
/// the tokenizer the vault's word list is made with, are
/// [`centraid_ontology::text`]: the vault writes the index and this crate reads
/// it, and the two cannot be allowed to disagree about a word.
pub use centraid_ontology::text::fold_like_index;

/// The first `count` characters of `term`, when it has that many.
fn leading(term: &str, count: usize) -> Option<&str> {
    let mut seen = 0;
    for (index, _) in term.char_indices() {
        if seen == count {
            return Some(&term[..index]);
        }
        seen += 1;
    }
    (seen == count).then_some(term)
}

/// A necessary condition for [`within_one`], read without allocating: two texts
/// one edit apart agree on everything but a letter (or two neighbours), so what
/// they share at the start and at the end covers all but two of the shorter's
/// letters. A correction asks it of every term in a bucket of thousands, and most
/// terms fail it on their first letters; [`within_one`] is asked of the rest.
fn plausibly_one_edit_apart(word: &str, have: &str) -> bool {
    let shorter = word.chars().count().min(have.chars().count());
    let head = word
        .chars()
        .zip(have.chars())
        .take_while(|(a, b)| a == b)
        .count();
    let tail = word
        .chars()
        .rev()
        .zip(have.chars().rev())
        .take_while(|(a, b)| a == b)
        .count();
    head + tail + 2 >= shorter
}

/// The prefix of `term` the word may have meant, when there is one.
///
/// A prefix of `term` of length `|word|`, `|word| + 1` or `|word| - 1` that is
/// within one edit of the word, tried in that order; a prefix shorter than
/// [`PREFIX_MIN`] is never one. `None` when `term` already starts with the word:
/// that is an exact hit and not a typo, and `rent` is not corrected to `rents`.
///
/// Both arguments are folded ([`fold_like_index`]); the first-letter rule is
/// [`near_words`]'s.
#[must_use]
pub fn near_prefix(word: &str, term: &str) -> Option<String> {
    if term.starts_with(word) {
        return None;
    }
    let length = word.chars().count();
    [length, length + 1, length.saturating_sub(1)]
        .into_iter()
        .filter(|&take| take >= PREFIX_MIN)
        .filter_map(|take| leading(term, take))
        .find(|prefix| plausibly_one_edit_apart(word, prefix) && within_one(word, prefix))
        .map(str::to_owned)
}

/// The whole term a typed word is corrected to, among the `(term, documents)`
/// pairs a walker offers ([`WalkedWords`]).
///
/// The prefixes the candidates offer ([`near_prefix`]) are groups; the group the
/// most documents hold wins, then the shorter prefix, then the one that sorts
/// first. The answer is **the whole term** in that group that the most documents
/// hold, then the shorter, then the one that sorts first, because that word is
/// both what is searched again and what the member is told: `sunscren` reads
/// "sunscreen", not the prefix `sunscree`. A term offered more than once adds its
/// documents.
fn best_term(word: &str, candidates: Vec<(String, u64)>) -> Option<String> {
    let mut groups: BTreeMap<String, (u64, BTreeMap<String, u64>)> = BTreeMap::new();
    for (term, docs) in candidates {
        if let Some(prefix) = near_prefix(word, &term) {
            let (total, terms) = groups.entry(prefix).or_default();
            *total = total.saturating_add(docs);
            let held = terms.entry(term).or_default();
            *held = held.saturating_add(docs);
        }
    }
    let (_, (_, terms)) =
        groups
            .into_iter()
            .min_by(|(left, (left_docs, _)), (right, (right_docs, _))| {
                right_docs
                    .cmp(left_docs)
                    .then_with(|| left.chars().count().cmp(&right.chars().count()))
                    .then_with(|| left.cmp(right))
            })?;
    terms
        .into_iter()
        .min_by(|(left, left_docs), (right, right_docs)| {
            right_docs
                .cmp(left_docs)
                .then_with(|| left.chars().count().cmp(&right.chars().count()))
                .then_with(|| left.cmp(right))
        })
        .map(|(term, _)| term)
}

/// A query with its mistyped words replaced, or `None` when nothing was replaced.
///
/// For each word of [`words`]: punctuation stuck to its ends (`budegt?`,
/// `(budegt`) is no part of the word, so it is read without it and, when the word
/// is corrected, left out of the corrected words. The rest is folded
/// ([`fold_like_index`]) and handed to `correct_one`, but only when it is
/// [`eligible`]: any other word stays as typed. `correct_one` answers the word
/// that replaces it, `Ok(None)` to leave it, or the failure that ends the pass.
///
/// The words are joined by single spaces, so a corrected query is not the typed
/// one with a word patched but the words the index will be asked for.
///
/// # Errors
///
/// The first failure `correct_one` reports.
pub fn try_correct_words<E>(
    query: &str,
    mut correct_one: impl FnMut(&str) -> Result<Option<String>, E>,
) -> Result<Option<String>, E> {
    let mut changed = false;
    let mut corrected: Vec<String> = Vec::new();
    for typed in words(query) {
        let folded = fold_like_index(typed.trim_matches(|c: char| !c.is_alphanumeric()));
        let replacement = if eligible(&folded) {
            correct_one(&folded)?
        } else {
            None
        };
        match replacement {
            Some(term) => {
                changed = true;
                corrected.push(term);
            }
            None => corrected.push(typed),
        }
    }
    Ok(changed.then(|| corrected.join(" ")))
}

/// [`try_correct_words`] over a vocabulary a walker has: a word `known` says is
/// held stays; any other asks `candidates` for the `(term, documents)` pairs that
/// start like it and is replaced by the best whole term among them
/// ([`best_term`]); with none, it stays.
///
/// `known` and `candidates` receive the **folded** word. The same term may be
/// offered more than once; its documents add.
pub fn correct_words(
    query: &str,
    mut known: impl FnMut(&str) -> bool,
    mut candidates: impl FnMut(&str) -> Vec<(String, u64)>,
) -> Option<String> {
    match try_correct_words(query, |folded| {
        Ok::<_, std::convert::Infallible>(if known(folded) {
            None
        } else {
            best_term(folded, candidates(folded))
        })
    }) {
        Ok(corrected) => corrected,
        Err(never) => match never {},
    }
}

/// Whether some word of the list starts with `word`: the word is a hit as typed,
/// because search is a prefix search. Both are folded.
pub fn is_known<'a>(word: &str, list: impl IntoIterator<Item = &'a str>) -> bool {
    list.into_iter().any(|held| held.starts_with(word))
}

/// Whether `held` begins one edit away from the typed word (the same question
/// [`near_prefix`] answers, asked of every word of a list of a hundred thousand,
/// so it reads no more than it must): the two agree up to a first difference,
/// and past it the rest is a substitution, a letter more in `held`, a letter
/// more in `word`, or two neighbours swapped. `word` is the typed word's letters
/// and `held` does not start with it. A test holds it equal to [`near_prefix`].
fn begins_near(word: &[char], held: &str) -> bool {
    let len = word.len();
    let head = word
        .iter()
        .zip(held.chars())
        .take_while(|(typed, kept)| *typed == kept)
        .count();
    if head >= len {
        return false;
    }
    if head == 0 {
        // The slip is in the first two letters, and then one of them is where
        // the typed word has its own: this turns away most of a long list.
        let mut start = held.chars();
        let (first, second) = (start.next(), start.next());
        if second != Some(word[1]) && second != Some(word[0]) && first != Some(word[1]) {
            return false;
        }
    }
    let rest = &word[head..];
    let after = || held.chars().skip(head);
    let same = |from: usize, count: usize, against: &[char]| {
        after().skip(from).take(count).eq(against.iter().copied())
    };
    // A letter different, a letter more in `held`, a letter more in `word`.
    if same(1, rest.len() - 1, &rest[1..]) && after().nth(rest.len() - 1).is_some() {
        return true;
    }
    if same(1, rest.len(), rest) || same(0, rest.len() - 1, &rest[1..]) {
        return true;
    }
    // Two neighbours swapped.
    if rest.len() >= 2 {
        let mut tail = after();
        return tail.next() == Some(rest[1])
            && tail.next() == Some(rest[0])
            && tail.take(rest.len() - 2).eq(rest[2..].iter().copied());
    }
    false
}

/// The words of `list` a typed `word` may have meant, in the tiers
/// [the module](self) describes: one edit anywhere with the typed first letter,
/// else one edit anywhere that changes it, else the typed fragment inside a
/// longer word. Empty when there is none, and for a word that is not
/// [`eligible`]. A word `list` starts with is never offered ([`is_known`] is the
/// caller's question to ask first).
///
/// `list` is the vault's whole word list, optionally filtered by the caller (a
/// realm); every word in it is folded.
#[must_use]
pub fn near_words<'a>(
    word: &str,
    list: impl IntoIterator<Item = &'a str, IntoIter: Clone>,
) -> Vec<&'a str> {
    if !eligible(word) {
        return Vec::new();
    }
    let first = word.chars().next();
    let letters: Vec<char> = word.chars().collect();
    let (mut kept, mut changed) = (Vec::new(), Vec::new());
    let list = list.into_iter();
    for held in list.clone() {
        if held.starts_with(word) {
            continue;
        }
        // One edit anywhere. `near_prefix` tries the held word itself when it is
        // within a letter of the typed word's length, so it covers
        // `within_one(word, held)` and also the held words that merely begin like
        // a slip of the typed one (`budeg` in `budget`).
        if begins_near(&letters, held) {
            if held.chars().next() == first {
                kept.push(held);
            } else {
                changed.push(held);
            }
        }
    }
    if !kept.is_empty() {
        kept
    } else if !changed.is_empty() {
        changed
    } else if word.chars().count() >= IN_WORD_MIN {
        // The widest net, cast only when nothing narrower caught anything.
        list.filter(|held| {
            held.len() > word.len() && held.contains(word) && !held.starts_with(word)
        })
        .collect()
    } else {
        Vec::new()
    }
}

/// The order candidates are chosen in: the most documents first, then the
/// shorter word, then the one that sorts first. Total, so a vault answers the
/// same every time.
#[must_use]
pub fn rank_order(left: (&str, u64), right: (&str, u64)) -> std::cmp::Ordering {
    right
        .1
        .cmp(&left.1)
        .then_with(|| left.0.chars().count().cmp(&right.0.chars().count()))
        .then_with(|| left.0.cmp(right.0))
}

/// THE WORDS A WALKER HAS READ, as the vocabulary its own correction asks.
///
/// Locker answers a search by walking a bounded window of rows and matching text,
/// not by asking the full-text door: it has no index and no vocabulary, and must
/// not get one. So a walker that found nothing corrects a typo against **the
/// words of the very rows it just walked** and nothing else — this list is built
/// from them, row by row, and dropped with the request.
///
/// Words are lowercased and not unaccented, because the walkers match by
/// lowercase `contains`; a word it offers is a word the re-walk will find. Each
/// word counts once per row, and that count is the `docs` [`correct_words`]
/// weighs candidates by. A walker offers a candidate that starts with the
/// typed word's first letter, or with its first two letters swapped.
#[derive(Debug, Clone, Default)]
pub struct WalkedWords {
    rows: BTreeMap<String, u64>,
}

impl WalkedWords {
    /// An empty list.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Add the words of one row's searchable texts. A word of fewer than
    /// [`PREFIX_MIN`] letters is never offered, because no correction lands on
    /// one.
    pub fn add_row<'a>(&mut self, texts: impl IntoIterator<Item = &'a str>) {
        let mut seen: Vec<String> = Vec::new();
        for text in texts {
            for word in text.split(|c: char| !c.is_alphanumeric()) {
                if word.chars().count() < PREFIX_MIN {
                    continue;
                }
                let word = word.to_lowercase();
                if !seen.contains(&word) {
                    seen.push(word);
                }
            }
        }
        for word in seen {
            let held = self.rows.entry(word).or_default();
            *held = held.saturating_add(1);
        }
    }

    /// Whether some walked word holds `word` (a substring: the walkers match by
    /// `contains`).
    #[must_use]
    pub fn knows(&self, word: &str) -> bool {
        self.rows.keys().any(|held| held.contains(word))
    }

    /// The `(word, rows)` pairs a typed word may have meant: those that start
    /// with its first letter, or with its first two letters swapped.
    #[must_use]
    pub fn candidates(&self, word: &str) -> Vec<(String, u64)> {
        let mut letters = word.chars();
        let (Some(first), Some(second)) = (letters.next(), letters.next()) else {
            return Vec::new();
        };
        let swapped: String = [second, first].iter().collect();
        let first = first.to_string();
        self.rows
            .iter()
            .filter(|(held, _)| held.starts_with(&first) || held.starts_with(&swapped))
            .map(|(held, rows)| (held.clone(), *rows))
            .collect()
    }

    /// [`correct_words`] over this list: the query with its mistyped words
    /// replaced by words the walked rows hold, or `None` when nothing changed.
    #[must_use]
    pub fn correct(&self, query: &str) -> Option<String> {
        correct_words(query, |word| self.knows(word), |word| self.candidates(word))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // -- the rule, moved from the assistant (R5): the same assertions -----------

    #[test]
    fn one_edit_reads_a_slip_of_one_letter_and_a_swap() {
        assert!(one_edit("farukh", "farrukh")); // a letter fewer
        assert!(one_edit("benedict", "benedikt")); // a letter different
        assert!(one_edit("amma", "ama")); // a letter more
        assert!(one_edit("ochao", "ochoa")); // two swapped
        assert!(!one_edit("amma", "amma"));
        assert!(!one_edit("rental", "dentals"));
        assert!(!one_edit("2025", "2026")); // a digit is no typo
        assert!(!one_edit("abc", "abd")); // under four letters
    }

    #[test]
    fn within_one_has_no_limits_of_its_own() {
        assert!(within_one("usd", "usf")); // a code of three letters
        assert!(within_one("ab", "ba")); // a swap of two
        assert!(within_one("a", "ab"));
        assert!(within_one("ab12", "ab13")); // a digit is a letter to it
        assert!(!within_one("abc", "abc"));
        assert!(!within_one("abc", "bca")); // a rotation is two edits
        assert!(!within_one("abc", "abcde"));
        assert!(!within_one("abcd", "badc")); // two swaps are two edits
    }

    // -- the query's words ------------------------------------------------------

    #[test]
    fn a_query_is_read_as_the_door_reads_it() {
        assert_eq!(words("budget  cabin"), ["budget", "cabin"]);
        assert_eq!(words("a\"b \"quoted\""), ["ab", "quoted"]);
        // A token with no letter and no digit is dropped, not emptied.
        assert_eq!(words("--- rent"), ["rent"]);
        assert!(words("   ").is_empty());
        assert!(words("--- ***").is_empty());
        assert_eq!(words("café Ω"), ["café", "Ω"]);
        let long = (0..40)
            .map(|n| format!("w{n}"))
            .collect::<Vec<_>>()
            .join(" ");
        assert_eq!(words(&long).len(), MAX_WORDS);
    }

    // -- eligibility ------------------------------------------------------------

    #[test]
    fn a_word_is_eligible_with_four_letters_and_nothing_else() {
        assert!(eligible("rent"));
        assert!(eligible("straße"));
        assert!(!eligible("rnt")); // under four
        assert!(!eligible("2025"));
        assert!(!eligible("rent2")); // a digit
        assert!(!eligible("o'brien")); // two tokens in the index
        assert!(!eligible("e-mail"));
        assert!(!eligible(""));
    }

    // -- the fold ---------------------------------------------------------------

    /// The fold is `centraid_ontology::text`'s, which compares it with the
    /// engine over every code point it claims; this is only the re-export.
    #[test]
    fn the_fold_is_the_ontology_s() {
        assert_eq!(fold_like_index("Café"), "cafe");
        assert_eq!(fold_like_index("Tromsø"), "tromsø");
    }

    // -- near_prefix ------------------------------------------------------------

    #[test]
    fn a_prefix_one_edit_from_the_word_is_the_correction() {
        assert_eq!(near_prefix("budegt", "budget").as_deref(), Some("budget"));
        assert_eq!(near_prefix("budegt", "budgets").as_deref(), Some("budget"));
        // The word is cut off mid-slip: the prefix is one shorter than the word.
        assert_eq!(near_prefix("buddg", "budget").as_deref(), Some("budg"));
        assert_eq!(near_prefix("budeg", "budget").as_deref(), Some("budge"));
        assert_eq!(
            near_prefix("recive", "received").as_deref(),
            Some("receive")
        );
        assert_eq!(
            near_prefix("recieve", "received").as_deref(),
            Some("receive")
        );
        assert_eq!(near_prefix("budgget", "budget").as_deref(), Some("budget"));
    }

    /// THE FILTER NEVER REJECTS WHAT `within_one` ACCEPTS: every pair of words of
    /// up to five letters over a three-letter alphabet, which holds every shape of
    /// insert, delete, substitute and swap at every position.
    #[test]
    fn the_cheap_filter_never_rejects_a_pair_within_one_edit() {
        let mut words = vec![String::new()];
        let mut frontier = vec![String::new()];
        for _ in 0..5 {
            frontier = frontier
                .iter()
                .flat_map(|word| ["a", "b", "c"].map(|letter| format!("{word}{letter}")))
                .collect();
            words.extend(frontier.iter().cloned());
        }
        let mut within = 0;
        for left in &words {
            for right in &words {
                if within_one(left, right) {
                    within += 1;
                    assert!(
                        plausibly_one_edit_apart(left, right),
                        "`{left}` and `{right}`"
                    );
                }
            }
        }
        assert!(within > 1_000, "only {within} pairs were one edit apart");
    }

    #[test]
    fn a_term_that_starts_with_the_word_is_a_hit_and_not_a_typo() {
        assert_eq!(near_prefix("rent", "rents"), None);
        assert_eq!(near_prefix("rent", "rent"), None);
        assert_eq!(near_prefix("budg", "budget"), None);
    }

    #[test]
    fn the_prefix_of_the_words_own_length_is_preferred() {
        // `abcd` is one edit from `abc` (shorter), `abce` (the same length) and
        // `abcde` (longer); a term can offer more than one of them, and the word's
        // own length wins.
        assert_eq!(near_prefix("abcd", "abcex").as_deref(), Some("abce"));
        assert_eq!(near_prefix("abcd", "abcdxy"), None); // it starts with the word
        // Only the longer prefix is within an edit...
        assert_eq!(near_prefix("abcd", "abxcdy").as_deref(), Some("abxcd"));
        // ...or only the shorter one.
        assert_eq!(near_prefix("abcd", "abdz").as_deref(), Some("abd"));
    }

    #[test]
    fn a_term_too_far_or_too_short_offers_nothing() {
        assert_eq!(near_prefix("budget", "bunker"), None);
        assert_eq!(near_prefix("budget", "bud"), None);
        assert_eq!(near_prefix("budget", ""), None);
        // A prefix under three letters is not a correction.
        assert_eq!(near_prefix("ab", "ba"), None);
    }

    #[test]
    fn a_multibyte_term_is_cut_on_a_character() {
        assert_eq!(near_prefix("łodzx", "łodzi").as_deref(), Some("łodzi"));
        assert_eq!(near_prefix("łodzx", "łodzix").as_deref(), Some("łodzi"));
    }

    // -- correct_words ----------------------------------------------------------

    /// A vocabulary as the closures see it.
    struct Vocabulary(Vec<(&'static str, u64)>);

    impl Vocabulary {
        fn known(&self, word: &str) -> bool {
            self.0.iter().any(|(term, _)| term.starts_with(word))
        }

        fn candidates(&self, word: &str) -> Vec<(String, u64)> {
            let first = word.chars().next();
            self.0
                .iter()
                .filter(|(term, _)| term.chars().next() == first)
                .map(|(term, docs)| ((*term).to_owned(), *docs))
                .collect()
        }

        fn correct(&self, query: &str) -> Option<String> {
            correct_words(query, |w| self.known(w), |w| self.candidates(w))
        }
    }

    #[test]
    fn only_the_unknown_word_changes() {
        let vocabulary = Vocabulary(vec![("budget", 3), ("cabin", 2)]);
        assert_eq!(
            vocabulary.correct("budegt Cabin").as_deref(),
            Some("budget Cabin")
        );
        assert_eq!(vocabulary.correct("budget cabin"), None);
    }

    #[test]
    fn the_best_prefix_has_the_most_documents_then_is_shorter_then_sorts_first() {
        // Most documents.
        let by_docs = Vocabulary(vec![("budget", 1), ("budgit", 4)]);
        assert_eq!(by_docs.correct("budgat").as_deref(), Some("budgit"));
        // Documents add across the terms that share a prefix; the answer is then
        // the whole term of that prefix with the most documents of its own.
        let added = Vocabulary(vec![("budgets", 2), ("budgeted", 3), ("budgit", 4)]);
        assert_eq!(added.correct("budgat").as_deref(), Some("budgeted"));
        // Equal documents: the shorter prefix.
        let shorter = Vocabulary(vec![("budgit", 2), ("budga", 2)]);
        assert_eq!(shorter.correct("budgat").as_deref(), Some("budga"));
        // Equal and equally long: the one that sorts first.
        let sorted = Vocabulary(vec![("budgit", 2), ("budget", 2)]);
        assert_eq!(sorted.correct("budgat").as_deref(), Some("budget"));
    }

    /// R4B: THE CORRECTION IS THE WHOLE TERM, not the prefix the index matched.
    #[test]
    fn a_correction_is_the_whole_term_of_the_winning_prefix() {
        // `sunscren` is one edit from the prefix `sunscree` of `sunscreen`; the
        // member is told, and the index asked for, `sunscreen`.
        let vocabulary = Vocabulary(vec![("sunscreen", 2), ("sunday", 5)]);
        assert_eq!(vocabulary.correct("sunscren").as_deref(), Some("sunscreen"));
        // `recieve` is one edit from the prefix `receive`; the vault holds
        // `received`, and that is the word.
        let received = Vocabulary(vec![("received", 3), ("recipe", 9)]);
        assert_eq!(received.correct("recieve").as_deref(), Some("received"));
        // Within the winning prefix, the term the most documents hold; then the
        // shorter; then the one that sorts first.
        let by_docs = Vocabulary(vec![("budgets", 1), ("budgeted", 4)]);
        assert_eq!(by_docs.correct("budegt").as_deref(), Some("budgeted"));
        let shorter = Vocabulary(vec![("budgeted", 2), ("budgets", 2)]);
        assert_eq!(shorter.correct("budegt").as_deref(), Some("budgets"));
        let sorted = Vocabulary(vec![("budgetz", 2), ("budgetx", 2)]);
        assert_eq!(sorted.correct("budegt").as_deref(), Some("budgetx"));
        // The same term offered by two domains adds its documents.
        let doubled = Vocabulary(vec![("budgets", 2), ("budgeted", 3), ("budgets", 2)]);
        assert_eq!(doubled.correct("budegt").as_deref(), Some("budgets"));
        // The winning prefix is chosen before the term: a term with more documents
        // in a losing prefix does not win.
        let losing = Vocabulary(vec![
            ("budgit", 5),
            ("budgets", 2),
            ("budgeted", 2),
            ("budgetary", 2),
        ]);
        assert_eq!(losing.correct("budgat").as_deref(), Some("budgets"));
    }

    #[test]
    fn a_word_that_is_not_eligible_is_never_asked_about() {
        let asked = std::cell::Cell::new(0);
        let corrected = correct_words(
            "abc 2025 a1b2 o'brien",
            |_| {
                asked.set(asked.get() + 1);
                false
            },
            |_| {
                asked.set(asked.get() + 1);
                vec![("abd".to_owned(), 9)]
            },
        );
        assert_eq!(corrected, None);
        assert_eq!(asked.get(), 0);
    }

    #[test]
    fn a_word_is_folded_before_the_vocabulary_is_asked() {
        let seen = std::cell::RefCell::new(Vec::new());
        let _ = correct_words(
            "Ångstrom",
            |word| {
                seen.borrow_mut().push(word.to_owned());
                true
            },
            |_| Vec::new(),
        );
        assert_eq!(*seen.borrow(), ["angstrom"]);
    }

    #[test]
    fn a_word_with_no_candidate_stays_as_typed() {
        let vocabulary = Vocabulary(vec![("cabin", 2)]);
        assert_eq!(vocabulary.correct("budegt"), None);
    }

    #[test]
    fn punctuation_stuck_to_a_word_is_read_around_and_left_out() {
        let vocabulary = Vocabulary(vec![("budget", 3), ("cabin", 2)]);
        assert_eq!(vocabulary.correct("budegt?").as_deref(), Some("budget"));
        assert_eq!(vocabulary.correct("(budegt").as_deref(), Some("budget"));
        assert_eq!(
            vocabulary.correct("\"budegt!\", cabin.").as_deref(),
            Some("budget cabin.")
        );
        // A known word with punctuation is still known, and nothing changes.
        assert_eq!(vocabulary.correct("budget?"), None);
        // Punctuation does not make a short word eligible.
        assert_eq!(vocabulary.correct("(bdg)"), None);
    }

    // -- candidates from the whole word list ------------------------------------

    fn near<'a>(word: &str, list: &[&'a str]) -> Vec<&'a str> {
        near_words(word, list.iter().copied())
    }

    /// THE FAST CHECK IS `near_prefix`: every word of four or five letters
    /// against every held word of up to six, over a three-letter alphabet,
    /// which holds every shape of insert, delete, substitute and swap at every
    /// position, and a held word that stops short.
    #[test]
    fn the_fast_check_agrees_with_near_prefix() {
        let mut every = vec![String::new()];
        let mut frontier = vec![String::new()];
        for _ in 0..6 {
            frontier = frontier
                .iter()
                .flat_map(|word| ["a", "b", "c"].map(|letter| format!("{word}{letter}")))
                .collect();
            every.extend(frontier.iter().cloned());
        }
        let mut near = 0;
        for word in every.iter().filter(|word| (4..=5).contains(&word.len())) {
            let letters: Vec<char> = word.chars().collect();
            for held in every.iter().filter(|held| !held.starts_with(word.as_str())) {
                let expected = near_prefix(word, held).is_some();
                near += usize::from(expected);
                assert_eq!(
                    begins_near(&letters, held),
                    expected,
                    "`{word}` and `{held}`"
                );
            }
        }
        assert!(near > 1_000, "only {near} pairs were near");
    }

    #[test]
    fn a_slip_anywhere_in_the_word_finds_the_word() {
        let list = ["budget", "cabin", "sunscreen"];
        assert_eq!(near("budegt", &list), ["budget"]); // a swap near the end
        assert_eq!(near("bidget", &list), ["budget"]); // a letter different mid-word
        assert_eq!(near("budgt", &list), ["budget"]); // a letter fewer
        assert_eq!(near("buddget", &list), ["budget"]); // a letter more
        // Cut off as you type, the slip is in the letters you have.
        assert_eq!(near("budeg", &list), ["budget"]);
        // A word the list starts with is a hit, never offered.
        assert!(near("budg", &list).is_empty());
        assert!(near("budget", &list).is_empty());
    }

    #[test]
    fn a_first_letter_change_counts_only_when_no_candidate_keeps_the_first_letter() {
        // Only a candidate that changes it: found.
        assert_eq!(near("gudget", &["budget", "cabin"]), ["budget"]);
        // A candidate that keeps it hides the one that changes it.
        assert_eq!(near("gudget", &["budget", "gudgex"]), ["gudgex"]);
        // The swap of the first two is a first-letter change like the others.
        assert_eq!(near("ubdget", &["budget"]), ["budget"]);
    }

    #[test]
    fn a_fragment_inside_a_longer_word_is_the_last_resort_and_needs_four_letters() {
        let list = ["sunscreen", "screenplay", "cabin"];
        // `screen` is the start of `screenplay`, so a caller asks `is_known` first
        // and never gets here; asked anyway, the words that START with it are not
        // offered and the one that contains it is.
        assert!(is_known("screen", list));
        assert_eq!(near("screen", &list), ["sunscreen"]);
        // Inside only: `sunscreen`.
        assert_eq!(near("cree", &["sunscreen", "cabin"]), ["sunscreen"]);
        assert_eq!(near("creen", &["sunscreen", "cabin"]), ["sunscreen"]);
        // Three letters is not a fragment: the word is not even eligible.
        assert!(near("cre", &["sunscreen"]).is_empty());
        // One edit anywhere is a tier ahead of in-word: `creen` is a letter from
        // `screen`, which beats `sunscreen` that merely contains it.
        assert_eq!(near("creen", &["screen", "sunscreen"]), ["screen"]);
    }

    #[test]
    fn a_word_that_is_not_eligible_has_no_candidates() {
        let list = ["budget", "abd", "2026"];
        assert!(near("bud", &list).is_empty());
        assert!(near("2025", &list).is_empty());
        assert!(near("bu1get", &list).is_empty());
    }

    #[test]
    fn candidates_are_ranked_by_documents_then_shorter_then_sorted() {
        use std::cmp::Ordering::{Greater, Less};
        assert_eq!(rank_order(("budgit", 4), ("budget", 1)), Less);
        assert_eq!(rank_order(("budget", 1), ("budgit", 4)), Greater);
        assert_eq!(rank_order(("budgets", 2), ("budget", 2)), Greater);
        assert_eq!(rank_order(("budget", 2), ("budgit", 2)), Less);
        let mut ranked = vec![("budgets", 2), ("budgit", 2), ("budget", 2), ("budgat", 9)];
        ranked.sort_by(|left, right| rank_order(*left, *right));
        assert_eq!(
            ranked.iter().map(|(word, _)| *word).collect::<Vec<_>>(),
            ["budgat", "budget", "budgit", "budgets"]
        );
    }

    #[test]
    fn a_word_is_known_when_some_word_starts_with_it() {
        assert!(is_known("budg", ["budget"]));
        assert!(is_known("budget", ["budget"]));
        assert!(!is_known("budgets", ["budget"]));
        assert!(!is_known("udget", ["budget"]));
    }

    #[test]
    fn a_failure_ends_the_pass_and_a_clean_pass_joins_the_words() {
        let corrected = try_correct_words::<()>("Budegt? cabin abc", |word| {
            Ok((word == "budegt").then(|| "budget".to_owned()))
        });
        assert_eq!(corrected, Ok(Some("budget cabin abc".to_owned())));
        let failed = try_correct_words("budegt", |_| Err("broken"));
        assert_eq!(failed, Err("broken"));
        assert_eq!(try_correct_words::<()>("cabin", |_| Ok(None)), Ok(None));
    }

    // -- the words a walker has read ----------------------------------------------

    #[test]
    fn a_walker_corrects_against_the_words_of_its_own_rows() {
        let mut walked = WalkedWords::new();
        walked.add_row(["Budget 2025", "ada@example.com"]);
        walked.add_row(["Budget plan"]);
        assert_eq!(walked.correct("budegt").as_deref(), Some("budget"));
        assert_eq!(walked.correct("exmaple").as_deref(), Some("example"));
        // The whole word the rows hold, not a prefix of it.
        let mut longer = WalkedWords::new();
        longer.add_row(["Sunscreen SPF 50"]);
        assert_eq!(longer.correct("sunscren").as_deref(), Some("sunscreen"));
        // A word the rows hold, as a part of a longer one, is known.
        assert_eq!(walked.correct("budg"), None);
        // A word no walked row is near stays as typed.
        assert_eq!(walked.correct("cabin"), None);
    }

    #[test]
    fn a_walked_word_counts_once_per_row() {
        let mut walked = WalkedWords::new();
        walked.add_row(["budget budget budget"]);
        walked.add_row(["budget"]);
        walked.add_row(["budgit"]);
        walked.add_row(["budgit"]);
        walked.add_row(["budgit"]);
        // `budgit` is in three rows and `budget` in two: the more rows win.
        assert_eq!(walked.correct("budgat").as_deref(), Some("budgit"));
    }

    #[test]
    fn a_walker_offers_a_word_by_its_first_letter_or_the_swap_of_its_first_two() {
        let mut walked = WalkedWords::new();
        walked.add_row(["budget", "ubdget"]);
        // A slip in the first letter is not corrected...
        assert_eq!(walked.correct("cudget"), None);
        // ...but the first two swapped are.
        assert_eq!(walked.correct("ubdgat").as_deref(), Some("ubdget"));
        assert_eq!(walked.candidates("bu").len(), 2); // `b...` and the swap `ub...`
        assert!(walked.candidates("b").is_empty());
    }

    #[test]
    fn a_walker_never_offers_a_word_of_under_three_letters() {
        let mut walked = WalkedWords::new();
        walked.add_row(["an ox is up"]);
        assert!(walked.candidates("an").is_empty());
        assert!(!walked.knows("ox"));
    }
}
