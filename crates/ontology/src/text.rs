//! The text the search index stores: one fold and one tokenizer, the index's own.
//!
//! The vault's search table is `fts5(... tokenize = "unicode61 remove_diacritics 2")`.
//! SQLite splits a text into words and folds each (lowercase, an accent removed)
//! inside the engine, and nothing it does is visible to Rust. Two things need the
//! same answer outside it: a correction ([`fold_like_index`]) compares a typed
//! word with the vocabulary, and the vault's word list ([`index_words`]) must hold
//! every word the engine would store for a text, without asking the engine.
//!
//! **Neither is a reading of the documentation. Each is compared with the
//! engine.** The tests insert text into a scratch FTS5 table with the same
//! tokenizer and read its `fts5vocab`: the fold over every code point of the
//! Latin blocks it claims, the split over every code point there is. A bundled
//! SQLite that changes either answer fails there.

mod token_chars;

use token_chars::TOKEN_CHARS;

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
        fold_into(letter, &mut folded);
    }
    folded
}

/// One character of [`fold_like_index`], appended to `folded`.
fn fold_into(letter: char, folded: &mut String) {
    let code = u32::from(letter);
    let at = UNACCENT.partition_point(|&(_, last, _)| last < code);
    if let Some(&(first, _, plain)) = UNACCENT.get(at)
        && first <= code
    {
        folded.push(plain);
    } else if is_dropped_mark(letter) {
        // Stored as nothing.
    } else if let Some(&(_, plain)) = SPECIAL.iter().find(|&&(from, _)| from == letter) {
        folded.push(plain);
    } else {
        folded.extend(letter.to_lowercase());
    }
}

/// Whether the tokenizer takes this character as part of a word.
///
/// ASCII letters and digits, and for everything else the engine's own table
/// ([`TOKEN_CHARS`]) rather than `char::is_alphanumeric`: the engine decides by
/// the general category of a Unicode version older than Rust's, and treats a
/// code point it has no category for as a letter, so a script written in
/// vowel signs (Devanagari, Thai) or a code point added since is split exactly
/// where the engine splits it and not where the standard library would.
fn is_token_char(letter: char) -> bool {
    let code = u32::from(letter);
    if code < 0x80 {
        return letter.is_ascii_alphanumeric();
    }
    let at = TOKEN_CHARS.partition_point(|&(_, last)| last < code);
    TOKEN_CHARS.get(at).is_some_and(|&(first, _)| first <= code)
}

/// Whether the tokenizer keeps this mark inside a word and stores nothing for it.
fn is_dropped_mark(letter: char) -> bool {
    let code = u32::from(letter);
    DROPPED_MARKS
        .iter()
        .any(|&(first, last)| (first..=last).contains(&code))
}

/// The words the index stores for a text, in order: split where
/// `unicode61 remove_diacritics 2` splits, and folded as it folds
/// ([`fold_like_index`]).
///
/// A word is a run of token characters ([`is_token_char`]) and of the marks the
/// tokenizer drops; a run of nothing but marks stores nothing, as in the engine.
/// An apostrophe, a hyphen, a full stop and an underscore all end a word
/// (`o'brien` is `o` and `brien`, `3.14` is `3` and `14`), and so does an emoji.
///
/// The fold is exact for the Latin blocks and lowercases one character at a time
/// elsewhere ([`fold_like_index`]); a word of another script that the engine
/// folds differently is a letter off, which for a list of words kept for
/// correction means the word's own stored form is not among its candidates.
pub fn index_words(text: &str) -> impl Iterator<Item = String> + '_ {
    let mut letters = text.chars();
    std::iter::from_fn(move || {
        let mut word = String::new();
        let mut inside = false;
        for letter in letters.by_ref() {
            if is_token_char(letter) {
                fold_into(letter, &mut word);
                inside = true;
            } else if is_dropped_mark(letter) {
                // Part of the word, and stored as nothing.
                inside = true;
            } else if inside {
                if !word.is_empty() {
                    return Some(word);
                }
                inside = false;
            }
        }
        (!word.is_empty()).then_some(word)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    /// A scratch index with the vault's tokenizer, and the engine's own answer
    /// for a text: the terms it stored, in the order it stored them.
    struct Engine {
        connection: Connection,
        next: i64,
    }

    impl Engine {
        fn new() -> Self {
            let connection = Connection::open_in_memory().expect("an in-memory file opens");
            connection
                .execute_batch(
                    "CREATE VIRTUAL TABLE t USING fts5(x, tokenize = \"unicode61 remove_diacritics 2\");
                     CREATE VIRTUAL TABLE v USING fts5vocab(t, 'instance');",
                )
                .expect("the index and its vocabulary are created");
            Self {
                connection,
                next: 1,
            }
        }

        /// Index each text as its own row; the row numbers it was given.
        fn index(&mut self, texts: &[String]) -> std::ops::Range<i64> {
            let first = self.next;
            let mut insert = self
                .connection
                .prepare_cached("INSERT INTO t(rowid, x) VALUES (?1, ?2)")
                .expect("the insert prepares");
            for text in texts {
                insert
                    .execute(rusqlite::params![self.next, text])
                    .expect("a text is indexed");
                self.next += 1;
            }
            first..self.next
        }

        /// The terms of each row of `rows`, in token order.
        fn terms(&self, rows: std::ops::Range<i64>) -> Vec<Vec<String>> {
            let mut out = vec![Vec::new(); usize::try_from(rows.end - rows.start).expect("a size")];
            let mut statement = self
                .connection
                .prepare(
                    "SELECT doc, term FROM v WHERE doc >= ?1 AND doc < ?2 ORDER BY doc, \"offset\"",
                )
                .expect("the vocabulary prepares");
            let pairs = statement
                .query_map([rows.start, rows.end], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                })
                .expect("the vocabulary reads")
                .collect::<rusqlite::Result<Vec<_>>>()
                .expect("the rows read");
            for (doc, term) in pairs {
                out[usize::try_from(doc - rows.start).expect("a row")].push(term);
            }
            out
        }

        /// The engine's terms for each text, one row per text.
        fn of(&mut self, texts: &[String]) -> Vec<Vec<String>> {
            let rows = self.index(texts);
            self.terms(rows)
        }
    }

    fn engine_terms(texts: &[&str]) -> Vec<Vec<String>> {
        let owned: Vec<String> = texts.iter().map(|text| (*text).to_owned()).collect();
        Engine::new().of(&owned)
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
        let terms = engine_terms(&samples);
        for (word, stored) in samples.iter().zip(&terms) {
            // A phrase of words is several terms; the fold is per word.
            let folded: Vec<String> = word.split(' ').map(fold_like_index).collect();
            assert_eq!(&folded, stored, "{word}");
        }
    }

    /// The code points the fold claims to be faithful for: the Latin blocks, the
    /// combining marks, Latin Extended Additional and the letterlike signs.
    const CLAIMED: [std::ops::RangeInclusive<u32>; 4] = [
        0x0000..=0x024F,
        0x0300..=0x036F,
        0x1E00..=0x1EFF,
        0x2100..=0x214F,
    ];

    /// Each code point of the claimed blocks stands between two `x`, so a
    /// separator shows as two terms and a dropped mark as `xx`.
    fn wrapped(range: std::ops::RangeInclusive<u32>) -> Vec<(char, String)> {
        range
            .filter_map(char::from_u32)
            .map(|letter| (letter, format!("x{letter}x")))
            .collect()
    }

    /// EVERY CODE POINT OF THE BLOCKS THE FOLD CLAIMS, against the index: the
    /// ranges in `UNACCENT` are the tokenizer's, not a reading of it. A code point
    /// the tokenizer treats as a separator has no term and is skipped; a mark it
    /// drops has the empty term, which is what the fold gives.
    #[test]
    fn fold_like_index_is_what_the_index_stores() {
        let letters: Vec<(char, String)> = CLAIMED.iter().cloned().flat_map(wrapped).collect();
        let texts: Vec<String> = letters.iter().map(|(_, text)| text.clone()).collect();
        let terms = Engine::new().of(&texts);
        let mut compared = 0;
        for ((letter, text), stored) in letters.iter().zip(&terms) {
            let [term] = stored.as_slice() else {
                continue; // a separator: two terms, nothing to fold
            };
            assert_eq!(&fold_like_index(text), term, "U+{:04X}", u32::from(*letter));
            compared += 1;
        }
        // Not vacuous: nearly every code point of the blocks is a token character.
        assert!(compared > 700, "only {compared} code points were compared");
    }

    // -- the tokenizer ----------------------------------------------------------

    /// THE WORDS OF A TEXT ARE THE ENGINE'S TERMS: the same split and the same
    /// fold, over text of every shape a member writes.
    #[test]
    fn index_words_are_the_terms_the_engine_stores_for_mixed_text() {
        let texts = [
            "",
            "   ",
            "Budget for the cabin",
            "o'brien's café, 3.14 and 2,000 ms-1: snake_case; e-mail",
            "Order #4471 — total $1,299.00 (approx.) / 15% off!",
            "\"quoted\" 'single' (paren) [bracket] {brace} <angle>",
            "😀 emoji 🎉🎉 between 👍x👍 words",
            "ΣΑΣ γιάννης Ελληνικά ΜΑΪΟΣ",
            "Москва Санкт-Петербург Ёж",
            "हिन्दी भाषा में खोज",
            "日本語のテキスト 한국어 中文",
            "Zoë Müller Dvořák Ñandú Łódź Tromsø Straße Æther İstanbul",
            "cafe\u{0301} re\u{0301}sume\u{0301} a\u{0305}b",
            "\u{0301}\u{0301} e \u{0301} e\u{0301}\u{0301}x",
            "tab\tnew\nline\r\nnbsp\u{00a0}zero\u{200b}width",
            "x\u{00b5}x \u{212b}ngstr\u{00f6}m",
            "CamelCaseWord ALLCAPS lower 123abc abc123 a1b2",
            "-- *** ... ,,, ;;; !!!",
        ];
        let stored = engine_terms(&texts);
        for (text, stored) in texts.iter().zip(&stored) {
            let words: Vec<String> = index_words(text).collect();
            assert_eq!(&words, stored, "{text:?}");
        }
    }

    /// Over the claimed blocks the words are exactly the engine's terms, one
    /// code point at a time and with the fold: the same check as the fold's, now
    /// through the tokenizer.
    #[test]
    fn index_words_are_the_engine_s_terms_over_every_code_point_the_fold_claims() {
        let letters: Vec<(char, String)> = CLAIMED.iter().cloned().flat_map(wrapped).collect();
        let texts: Vec<String> = letters.iter().map(|(_, text)| text.clone()).collect();
        let terms = Engine::new().of(&texts);
        for ((letter, text), stored) in letters.iter().zip(&terms) {
            let words: Vec<String> = index_words(text).collect();
            assert_eq!(&words, stored, "U+{:04X}", u32::from(*letter));
        }
    }

    /// The code points one batch stands for, each between two `x` and apart by a
    /// space, so a batch's engine terms are the sum of its code points'.
    fn batch(first: u32, last: u32) -> (Vec<char>, String) {
        let letters: Vec<char> = (first..=last).filter_map(char::from_u32).collect();
        let text = letters
            .iter()
            .map(|letter| format!("x{letter}x"))
            .collect::<Vec<_>>()
            .join(" ");
        (letters, text)
    }

    /// How many words the engine finds in each text, and how many we do.
    fn counts(engine: &mut Engine, texts: &[String]) -> Vec<(usize, usize)> {
        let rows = engine.index(texts);
        engine
            .terms(rows)
            .iter()
            .zip(texts)
            .map(|(terms, text)| (terms.len(), index_words(text).count()))
            .collect()
    }

    /// EVERY CODE POINT THERE IS, for where a word ends: the engine's table of
    /// token characters is not the standard library's, and `TOKEN_CHARS` is a copy
    /// of it. A code point on which the two disagree is named, with the command
    /// that writes the table again.
    #[test]
    fn the_split_agrees_with_the_engine_over_every_code_point() {
        const BATCH: u32 = 512;
        let mut disagree = Vec::new();
        let mut first = 0;
        while first <= 0x10_FFFF {
            let last = (first + BATCH - 1).min(0x10_FFFF);
            // A fresh index per batch: the vocabulary has no index on the row, so a
            // read of one row scans every row there is.
            let (_, text) = batch(first, last);
            let [(engine_count, our_count)] = counts(&mut Engine::new(), &[text])[..] else {
                unreachable!("one text, one count");
            };
            if engine_count != our_count {
                // Narrow the batch down to the code points.
                for code in first..=last {
                    let (letters, text) = batch(code, code);
                    if letters.is_empty() {
                        continue;
                    }
                    let [(engine_count, our_count)] = counts(&mut Engine::new(), &[text])[..]
                    else {
                        unreachable!("one text, one count");
                    };
                    if engine_count != our_count {
                        disagree.push(format!("U+{code:04X}"));
                    }
                }
            }
            first = last + 1;
        }
        assert!(
            disagree.is_empty(),
            "the bundled SQLite splits differently from TOKEN_CHARS at {} code points, first {:?}; \
             write the table again: `cargo test -p centraid-ontology --lib \
             text::tests::write_token_chars -- --ignored --nocapture | sed -n \
             '/^\\/\\/! GENERATED/,/^];/p' > crates/ontology/src/text/token_chars.rs`",
            disagree.len(),
            &disagree[..disagree.len().min(8)]
        );
    }

    /// Prints `src/text/token_chars.rs`: every non-ASCII code point the engine
    /// takes as part of a word, as sorted inclusive ranges. A mark the tokenizer
    /// drops is not in it (`DROPPED_MARKS` is), because the engine stores nothing
    /// for it.
    #[test]
    #[ignore = "writes the table: run it when the bundled SQLite changes its Unicode tables"]
    fn write_token_chars() {
        let mut ranges: Vec<(u32, u32)> = Vec::new();
        for first in (0x80..=0x10_FFFF_u32).step_by(2048) {
            let last = (first + 2047).min(0x10_FFFF);
            let texts: Vec<String> = (first..=last)
                .filter_map(char::from_u32)
                .map(|letter| format!("x{letter}x"))
                .collect();
            let codes: Vec<u32> = (first..=last)
                .filter(|&c| char::from_u32(c).is_some())
                .collect();
            let terms = Engine::new().of(&texts);
            for (code, terms) in codes.into_iter().zip(terms) {
                // One term holding something between the `x`s is a token character;
                // `xx` is a dropped mark; two terms is a separator.
                if terms.len() == 1 && terms[0] != "xx" {
                    match ranges.last_mut() {
                        Some(last) if last.1 + 1 == code => last.1 = code,
                        _ => ranges.push((code, code)),
                    }
                }
            }
        }
        let mut out = String::from(
            "//! GENERATED — do not edit. Every non-ASCII code point `unicode61` takes as part of a\n\
             //! word, as sorted inclusive `(first, last)` ranges, read back from the bundled SQLite by\n\
             //! `text::tests::write_token_chars`. `text::tests::the_split_agrees_with_the_engine_over_every_code_point`\n\
             //! fails when the engine and this table part, and names the command that writes it again.\n\n\
             pub(super) const TOKEN_CHARS: &[(u32, u32)] = &[\n",
        );
        for row in ranges.chunks(4) {
            out.push_str("   ");
            for (first, last) in row {
                out.push_str(&format!(" (0x{first:04X}, 0x{last:04X}),"));
            }
            out.push('\n');
        }
        out.push_str("];\n");
        println!("{out}");
    }
}
