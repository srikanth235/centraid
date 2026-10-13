//! ONE SPELLING RULE, for every surface that forgives a typo (#1097, R4, R4a, R5).
//!
//! The assistant's name resolver already had a rule — **Damerau distance one**
//! (a letter more, fewer or different, or two neighbours swapped), read in a word
//! of four letters or more and never in a word with a digit
//! (`crates/assist/src/native/resolve.rs`, nt11 R1). Search had none, and Locker
//! and Tally's walkers had less. This module is that rule lifted to the one place
//! all of them can reach ([`within_one`], [`one_edit`]), plus what search needs
//! on top of it: the tokenization of a query ([`words`]), the fold the full-text
//! index applies ([`fold_like_index`]), and a correction that is **a lookup in the
//! vault's own vocabulary, never a guess** ([`correct_words`]).
//!
//! ## Why correction, and not a fuzzy OR (R4)
//!
//! A fuzzy match widens every query for every member, on every keystroke, and
//! cannot say what it did. A correction runs **only when the exact answer was
//! empty**, replaces a word by a word the vault holds, and is reported: the caller
//! runs the exact search again with the corrected words and tells the member what
//! it searched for ("Showing results for budget"). A query that found something is
//! never touched, and a word the vault does not know is never invented — a
//! correction is a whole term of the vocabulary.
//!
//! ## What a word is corrected to (R4, R4a)
//!
//! * An **eligible** word has [`TYPO_MIN`] letters or more and nothing but
//!   letters ([`eligible`]), so `2025` is never `2026`, `abc` is never `abd`, and
//!   `a1b2` is left alone.
//! * A word the vocabulary already holds — as a term or the start of one, because
//!   search is a prefix search — is **known** and kept as typed.
//! * Otherwise a candidate is a vocabulary term with a **prefix** of length
//!   `|w| - 1 ..= |w| + 1` within one edit of the word ([`near_prefix`]), so a
//!   slip made mid-word as you type (`budeg`) still lands on `budget`. Among the
//!   candidates the prefix with the most documents wins, then the shorter, then
//!   the one that sorts first; the answer is then **the whole term** of that
//!   prefix the most documents hold (R4b), by the same order: `sunscren` is
//!   `sunscreen`, not the prefix `sunscree`. Deterministic, so the same vault
//!   answers the same.
//! * **A slip in the first letter is not corrected** (R4a), except a swap of the
//!   first two (`ubdget`). The caller reads only the terms that start like the
//!   word, which is what keeps the scan bounded; the rule here is what the caller
//!   promises to do with them.
//!
//! ## One rule, two users
//!
//! The assistant keeps a **different** measure for ranking a whole search's words
//! (`crates/assist/src/native/search.rs` `word_score`, Levenshtein with a limit of
//! two for words of seven letters or more): the 0.8B evaluation depends on it and
//! it is not touched (R5a). Everything that decides "is this one slip of the
//! other word" — the name resolver, the `where` language's codes, search — is
//! [`within_one`].

use std::collections::BTreeMap;

/// The shortest prefix of a name word a person's word may be (`kit` for
/// `kitchen`, never `ki`).
pub const PREFIX_MIN: usize = 3;

/// The shortest word a typo is read in.
pub const TYPO_MIN: usize = 4;

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

/// The precomposed Latin letters `unicode61 remove_diacritics 2` stores as a
/// plain ASCII letter, as `(first, last, letter)` ranges of code points, sorted.
/// Both cases of a letter are listed, because the index lowercases first and
/// removes the mark second; `ø`, `æ`, `ß`, `ł` and `đ` are not here because the
/// tokenizer keeps them.
///
/// Not written by hand: `fold_like_index_is_what_the_index_stores` compares the
/// fold with the tokenizer's own over every code point of the blocks it claims,
/// so a table that drifts from the tokenizer's fails there.
const UNACCENT: &[(u32, u32, char)] = &[
    (0x00C0, 0x00C5, 'a'),
    (0x00C7, 0x00C7, 'c'),
    (0x00C8, 0x00CB, 'e'),
    (0x00CC, 0x00CF, 'i'),
    (0x00D1, 0x00D1, 'n'),
    (0x00D2, 0x00D6, 'o'),
    (0x00D9, 0x00DC, 'u'),
    (0x00DD, 0x00DD, 'y'),
    (0x00E0, 0x00E5, 'a'),
    (0x00E7, 0x00E7, 'c'),
    (0x00E8, 0x00EB, 'e'),
    (0x00EC, 0x00EF, 'i'),
    (0x00F1, 0x00F1, 'n'),
    (0x00F2, 0x00F6, 'o'),
    (0x00F9, 0x00FC, 'u'),
    (0x00FD, 0x00FD, 'y'),
    (0x00FF, 0x00FF, 'y'),
    (0x0100, 0x0105, 'a'),
    (0x0106, 0x010D, 'c'),
    (0x010E, 0x010F, 'd'),
    (0x0112, 0x011B, 'e'),
    (0x011C, 0x0123, 'g'),
    (0x0124, 0x0125, 'h'),
    (0x0128, 0x0130, 'i'),
    (0x0134, 0x0135, 'j'),
    (0x0136, 0x0137, 'k'),
    (0x0139, 0x013E, 'l'),
    (0x0143, 0x0148, 'n'),
    (0x014C, 0x0151, 'o'),
    (0x0154, 0x0159, 'r'),
    (0x015A, 0x0161, 's'),
    (0x0162, 0x0165, 't'),
    (0x0168, 0x0173, 'u'),
    (0x0174, 0x0175, 'w'),
    (0x0176, 0x0178, 'y'),
    (0x0179, 0x017E, 'z'),
    (0x017F, 0x017F, 's'),
    (0x01A0, 0x01A1, 'o'),
    (0x01AF, 0x01B0, 'u'),
    (0x01CD, 0x01CE, 'a'),
    (0x01CF, 0x01D0, 'i'),
    (0x01D1, 0x01D2, 'o'),
    (0x01D3, 0x01DC, 'u'),
    (0x01DE, 0x01DF, 'a'),
    (0x01E6, 0x01E7, 'g'),
    (0x01E8, 0x01E9, 'k'),
    (0x01EA, 0x01ED, 'o'),
    (0x01F0, 0x01F0, 'j'),
    (0x01F4, 0x01F5, 'g'),
    (0x01F8, 0x01F9, 'n'),
    (0x01FA, 0x01FB, 'a'),
    (0x0200, 0x0203, 'a'),
    (0x0204, 0x0207, 'e'),
    (0x0208, 0x020B, 'i'),
    (0x020C, 0x020F, 'o'),
    (0x0210, 0x0213, 'r'),
    (0x0214, 0x0217, 'u'),
    (0x0218, 0x0219, 's'),
    (0x021A, 0x021B, 't'),
    (0x021E, 0x021F, 'h'),
    (0x0226, 0x0227, 'a'),
    (0x0228, 0x0229, 'e'),
    (0x022A, 0x0231, 'o'),
    (0x0232, 0x0233, 'y'),
    (0x1E00, 0x1E01, 'a'),
    (0x1E02, 0x1E07, 'b'),
    (0x1E08, 0x1E09, 'c'),
    (0x1E0A, 0x1E13, 'd'),
    (0x1E14, 0x1E1D, 'e'),
    (0x1E1E, 0x1E1F, 'f'),
    (0x1E20, 0x1E21, 'g'),
    (0x1E22, 0x1E2B, 'h'),
    (0x1E2C, 0x1E2F, 'i'),
    (0x1E30, 0x1E35, 'k'),
    (0x1E36, 0x1E3D, 'l'),
    (0x1E3E, 0x1E43, 'm'),
    (0x1E44, 0x1E4B, 'n'),
    (0x1E4C, 0x1E53, 'o'),
    (0x1E54, 0x1E57, 'p'),
    (0x1E58, 0x1E5F, 'r'),
    (0x1E60, 0x1E69, 's'),
    (0x1E6A, 0x1E71, 't'),
    (0x1E72, 0x1E7B, 'u'),
    (0x1E7C, 0x1E7F, 'v'),
    (0x1E80, 0x1E89, 'w'),
    (0x1E8A, 0x1E8D, 'x'),
    (0x1E8E, 0x1E8F, 'y'),
    (0x1E90, 0x1E95, 'z'),
    (0x1E96, 0x1E96, 'h'),
    (0x1E97, 0x1E97, 't'),
    (0x1E98, 0x1E98, 'w'),
    (0x1E99, 0x1E99, 'y'),
    (0x1E9B, 0x1E9B, 's'),
    (0x1EA0, 0x1EB7, 'a'),
    (0x1EB8, 0x1EC7, 'e'),
    (0x1EC8, 0x1ECB, 'i'),
    (0x1ECC, 0x1EE3, 'o'),
    (0x1EE4, 0x1EF1, 'u'),
    (0x1EF2, 0x1EF9, 'y'),
    (0x212B, 0x212B, 'a'),
];

/// The combining marks the tokenizer drops from a token (`remove_diacritics`): a
/// word typed as a letter and a mark (`e` and U+0301) is the same word as the
/// precomposed one. A mark not listed here splits a token in the index, so it
/// stays in the folded word and [`eligible`] refuses the word.
const DROPPED_MARKS: &[(u32, u32)] = &[
    (0x0300, 0x0304),
    (0x0306, 0x030C),
    (0x030F, 0x030F),
    (0x0311, 0x0311),
    (0x031B, 0x031B),
    (0x0323, 0x0328),
    (0x032D, 0x032E),
    (0x0330, 0x0331),
];

/// The folds that are neither a lowercase nor an accent: the micro sign is the
/// Greek letter mu, and the final sigma is a sigma. A Greek name ending in `ς`
/// is in the index with a `σ`.
const SPECIAL: &[(char, char)] = &[('\u{00B5}', '\u{03BC}'), ('\u{03C2}', '\u{03C3}')];

/// What `unicode61 remove_diacritics 2` stores for a word: lowercased, and a
/// Latin letter with an accent as its plain letter (`Café` is `cafe`, `Ångström`
/// is `angstrom`, `İstanbul` is `istanbul`, but `Tromsø` is `tromsø` and `Straße`
/// is `straße`, because the tokenizer keeps those).
///
/// Faithful for the Latin blocks (U+0000 to U+024F, the combining marks, U+1E00
/// to U+1EFF, the letterlike signs) — `fold_like_index_is_what_the_index_stores` compares it with
/// an FTS5 index over every code point there. Any other script is lowercased one
/// character at a time, which is what the tokenizer does for every script it
/// knows the case of; for one it folds differently (Cherokee, a few Greek
/// variants) the folded word is a letter off the stored term, and a correction
/// can only land on a term the vocabulary holds, so the worst outcome is the
/// word's own stored form.
#[must_use]
pub fn fold_like_index(word: &str) -> String {
    let mut folded = String::with_capacity(word.len());
    for letter in word.chars() {
        let code = u32::from(letter);
        let at = UNACCENT.partition_point(|&(_, last, _)| last < code);
        if let Some(&(first, _, plain)) = UNACCENT.get(at)
            && first <= code
        {
            folded.push(plain);
        } else if DROPPED_MARKS
            .iter()
            .any(|&(first, last)| (first..=last).contains(&code))
        {
            continue;
        } else if let Some(&(_, plain)) = SPECIAL.iter().find(|&&(from, _)| from == letter) {
            folded.push(plain);
        } else {
            folded.extend(letter.to_lowercase());
        }
    }
    folded
}

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
/// Both arguments are folded ([`fold_like_index`]); the first-letter rule (R4a)
/// is the caller's, in which terms it offers.
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

/// The whole term a typed word is corrected to (ruling R4b).
///
/// The prefixes the candidates offer ([`near_prefix`]) are groups; the group the
/// most documents hold wins, then the shorter prefix, then the one that sorts
/// first. The answer is **the whole vocabulary term** in that group that the most
/// documents hold, then the shorter, then the one that sorts first, because that
/// word is both what is searched again and what the member is told: `sunscren`
/// reads "sunscreen", not the prefix `sunscree` the index would also match. A term
/// offered more than once (one pair per domain) adds its documents.
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

/// A query with its mistyped words replaced by the words the vault holds, or
/// `None` when nothing was replaced.
///
/// For each word of [`words`]: fold it ([`fold_like_index`]); a word that is not
/// [`eligible`], or that `known` says the vocabulary already holds, stays as
/// typed. Any other word asks `candidates` for the `(term, documents)` pairs
/// that start like it (the caller's bounded read of its vocabulary) and is
/// replaced by the best whole term among them ([`best_term`]); with none, it
/// stays.
/// The words are joined by single spaces, so a corrected query is not the typed
/// one with a word patched but the words the index will be asked for.
///
/// Leading and trailing characters that are neither letters nor digits are
/// trimmed before the word is read, and are not part of the corrected word.
///
/// `known` and `candidates` receive the **folded** word. The same term may be
/// offered more than once (one pair per domain); its documents add.
pub fn correct_words(
    query: &str,
    mut known: impl FnMut(&str) -> bool,
    mut candidates: impl FnMut(&str) -> Vec<(String, u64)>,
) -> Option<String> {
    let mut changed = false;
    let corrected: Vec<String> = words(query)
        .into_iter()
        .map(|typed| {
            // Punctuation stuck to the ends of a word (`budegt?`, `(budegt`) is
            // no part of the word: it is read without it and, when the word is
            // corrected, left out of the corrected words.
            let folded = fold_like_index(typed.trim_matches(|c: char| !c.is_alphanumeric()));
            if !eligible(&folded) || known(&folded) {
                return typed;
            }
            match best_term(&folded, candidates(&folded)) {
                Some(term) => {
                    changed = true;
                    term
                }
                None => typed,
            }
        })
        .collect();
    changed.then(|| corrected.join(" "))
}

/// THE WORDS A WALKER HAS READ, as the vocabulary its own correction asks
/// (#1097, R6).
///
/// Locker and Tally answer a search by walking a bounded window of rows and
/// matching text, not by asking the full-text door, and Locker is never a search
/// domain: it has no index and no vocabulary, and must not get one. So a walker
/// that found nothing corrects a typo against **the words of the very rows it
/// just walked** and nothing else — this list is built from them, row by row,
/// and dropped with the request.
///
/// Words are lowercased and not unaccented, because the walkers match by
/// lowercase `contains`; a word it offers is a word the re-walk will find. Each
/// word counts once per row, and that count is the `docs` [`correct_words`]
/// weighs candidates by. The first-letter rule is the door's (R4a): a candidate
/// starts with the typed word's first letter, or with its first two letters
/// swapped.
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
    use rusqlite::Connection;

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

    #[test]
    fn the_fold_lowercases_and_drops_an_accent_but_keeps_what_the_tokenizer_keeps() {
        assert_eq!(fold_like_index("Budget"), "budget");
        assert_eq!(fold_like_index("Café"), "cafe");
        assert_eq!(fold_like_index("Ångström"), "angstrom");
        assert_eq!(fold_like_index("İstanbul"), "istanbul");
        assert_eq!(fold_like_index("ŁÓDŹ"), "łodz");
        assert_eq!(fold_like_index("Tromsø"), "tromsø");
        assert_eq!(fold_like_index("Straße"), "straße");
        assert_eq!(fold_like_index("Æther"), "æther");
        assert_eq!(fold_like_index("ΣΑΣ"), "σασ");
        assert_eq!(fold_like_index("γιάννης"), "γιάννησ");
        // A letter and a combining mark is the precomposed letter.
        assert_eq!(fold_like_index("cafe\u{0301}"), "cafe");
    }

    /// The index's own answer for words: one row per word, the terms it stored.
    fn stored(words: &[&str]) -> Vec<Vec<String>> {
        let connection = Connection::open_in_memory().expect("an in-memory file opens");
        connection
            .execute_batch(
                "CREATE VIRTUAL TABLE t USING fts5(x, tokenize = \"unicode61 remove_diacritics 2\");
                 CREATE VIRTUAL TABLE v USING fts5vocab(t, 'instance');",
            )
            .expect("the index and its vocabulary are created");
        for (position, word) in words.iter().enumerate() {
            connection
                .execute(
                    "INSERT INTO t(rowid, x) VALUES (?1, ?2)",
                    rusqlite::params![i64::try_from(position).expect("a small index") + 1, word],
                )
                .expect("a word is indexed");
        }
        let mut statement = connection
            .prepare("SELECT doc, term FROM v ORDER BY doc, offset")
            .expect("the vocabulary prepares");
        let mut rows: Vec<Vec<String>> = vec![Vec::new(); words.len()];
        let pairs = statement
            .query_map([], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })
            .expect("the vocabulary reads")
            .collect::<rusqlite::Result<Vec<(i64, String)>>>()
            .expect("the rows read");
        for (doc, term) in pairs {
            rows[usize::try_from(doc).expect("a rowid") - 1].push(term);
        }
        rows
    }

    /// THE FOLD IS THE INDEX'S, PROVED AGAINST THE INDEX: a table of sample
    /// words, each lowercased and unaccented by `unicode61 remove_diacritics 2`
    /// itself, and `fold_like_index` has to say the same.
    #[test]
    fn fold_like_index_is_what_the_index_stores_for_sample_words() {
        let samples = [
            "budget",
            "Budget",
            "BUDGET",
            "Café",
            "CAFÉ",
            "naïve",
            "Müller",
            "Ångström",
            "Łódź",
            "Straße",
            "STRASSE",
            "Æther",
            "Tromsø",
            "İstanbul",
            "Ñandú",
            "Dvořák",
            "Garçon",
            "Zoë",
            "Hà Nội",
            "Ελληνικά",
            "ΣΑΣ",
            "γιάννης",
            "Москва",
            "ŒUVRE",
            "crème brûlée",
        ];
        let terms = stored(&samples);
        for (word, stored) in samples.iter().zip(&terms) {
            // A phrase of words is several terms; the fold is per word.
            let folded: Vec<String> = word.split(' ').map(fold_like_index).collect();
            assert_eq!(&folded, stored, "{word}");
        }
    }

    /// EVERY CODE POINT OF THE BLOCKS THE FOLD CLAIMS, against the index: the
    /// ranges in `UNACCENT` are the tokenizer's, not a reading of it. A code point
    /// the tokenizer treats as a separator has no term and is skipped; a mark it
    /// drops has the empty term, which is what the fold gives.
    #[test]
    fn fold_like_index_is_what_the_index_stores() {
        let claimed = [
            0x0000..=0x024F,
            0x0300..=0x036F,
            0x1E00..=0x1EFF,
            0x2100..=0x214F,
        ];
        // Each code point stands between two `x`, so a separator shows as two
        // terms and a dropped mark as `xx`.
        let letters: Vec<char> = claimed
            .iter()
            .flat_map(|range| range.clone())
            .filter_map(char::from_u32)
            .collect();
        let texts: Vec<String> = letters.iter().map(|letter| format!("x{letter}x")).collect();
        let refs: Vec<&str> = texts.iter().map(String::as_str).collect();
        let terms = stored(&refs);
        let mut compared = 0;
        for (letter, stored) in letters.iter().zip(&terms) {
            let [term] = stored.as_slice() else {
                continue; // a separator: two terms, nothing to fold
            };
            let wrapped = format!("x{letter}x");
            assert_eq!(
                &fold_like_index(&wrapped),
                term,
                "U+{:04X}",
                u32::from(*letter)
            );
            compared += 1;
        }
        // Not vacuous: nearly every code point of the blocks is a token character.
        assert!(compared > 700, "only {compared} code points were compared");
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
        // R4a: a slip in the first letter is not corrected...
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
