//! # Name matching — one normalisation for the runtime and the suite
//!
//! [`labelled`] is how a `called "…"` literal answers to a row's label in the
//! candidates' executor, and how a predicate that scores a WRITTEN title (a
//! task the member asked for) reads that title against the expected one: the
//! two cannot disagree about what "the person's words" are.

/// Does this label answer to `called Lit`?
///
/// The literal as a case-insensitive substring, or — because a member says
/// "my dentist cleaning" and the calendar says "Dentist — cleaning" — every
/// CONTENT word of it matching a word of the label. The second is what the FTS
/// plane would answer for the same phrase, said in the board's own terms so a
/// row's facts come with it. Both sides are normalised the same way by
/// [`name_stems`]: lowercased, split on anything not alphanumeric, a trailing
/// possessive `'s`/`’s` dropped ("Ana Ferreira's"), function words dropped
/// ("wifi at the cabin" is "cabin wifi"), and each word lightly stemmed
/// ("booking" and "book" are one stem). Words match by EQUAL stem, never by
/// prefix, so "cabin wifi" does not answer to "Cabinet wifi" (though the bare
/// "cabin" still does, as a raw substring). A literal that normalises
/// to nothing ("the") matches only by the substring test — an empty word set
/// would otherwise match every row.
pub fn labelled(label: &str, lit: &str) -> bool {
    if contains_words(&label.to_lowercase(), &lit.to_lowercase()) {
        return true;
    }
    let wanted = name_stems(lit);
    let have = name_stems(label);
    !wanted.is_empty() && wanted.iter().all(|word| have.contains(word))
}

/// `needle` occurs in `hay` on word boundaries: the characters either side of
/// the match are not alphanumeric. "cabin" is in "Cabin wifi" and
/// "the cabin's gate", not in "Cabinet": a short name must not match a longer
/// word it happens to start.
fn contains_words(hay: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return false;
    }
    let edge = |c: Option<char>| c.is_none_or(|c| !c.is_alphanumeric());
    hay.match_indices(needle).any(|(at, _)| {
        edge(hay[..at].chars().next_back()) && edge(hay[at + needle.len()..].chars().next())
    })
}

/// Words a `called` literal carries no meaning in.
const NAME_STOPWORDS: &[&str] = &[
    "the", "a", "an", "my", "our", "at", "of", "for", "to", "in", "on", "about", "with", "and",
];

/// The normalised content-word stems of a name, for [`labelled`].
fn name_stems(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !(c.is_alphanumeric() || c == '\'' || c == '\u{2019}'))
        .map(|word| {
            let word = word
                .strip_suffix("'s")
                .or_else(|| word.strip_suffix("\u{2019}s"))
                .unwrap_or(word);
            word.trim_matches(|c| c == '\'' || c == '\u{2019}')
        })
        .filter(|word| !word.is_empty() && !NAME_STOPWORDS.contains(word))
        .map(name_stem)
        .collect()
}

/// Light stemming: strip one of `-ing`, `-ed`, `-es`, `-s` when at least three
/// letters remain.
fn name_stem(word: &str) -> String {
    for suffix in ["ing", "ed", "es", "s"] {
        if let Some(stem) = word.strip_suffix(suffix)
            && stem.chars().count() >= 3
        {
            return stem.to_owned();
        }
    }
    word.to_owned()
}
