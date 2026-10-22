//! COMPILING OWNER-TYPED WORDS INTO AN FTS5 EXPRESSION.
//!
//! Every word becomes a **quoted prefix phrase** (`"budg"*`) and the phrases
//! join by FTS5's implicit AND. The quoting is the security half: unquoted,
//! `AND`, `NEAR`, `OR` and a leading `-` are FTS5 *syntax*, so a member
//! typing `dinner OR password` would be running a query they did not write.
//! Quoted, they are words.
//!
//! Two refusals, and they are v0's:
//!
//! * a token with no letter and no digit is **dropped**, because `""*` is an
//!   FTS5 syntax error rather than a query that matches nothing;
//! * a query left with no tokens at all is a typed refusal, not an empty page —
//!   there is no statement to run, and "nothing matched" would be a different
//!   claim about the vault than the one the caller is owed.

use centraid_apps_kit::spelling::{MAX_WORDS, words};

use crate::SearchError;

/// At most this many words reach the index. v0's slice
/// (`search.ts:34`), kept: a hundred-word paste is a question about the
/// tokenizer's cost, not about the member's notes. The number is the kit's
/// ([`MAX_WORDS`]), because the words a query is read as are the kit's too.
pub const MAX_MATCH_TOKENS: usize = MAX_WORDS;

/// The fewest characters a query's longest word must have to be a search.
///
/// A one-letter prefix has no index of its own (the index keeps two- and
/// three-letter prefixes, `prefix = '2 3'`), so `a*` merges every term that begins with `a`:
/// seconds in a vault of years, to answer a question nobody has asked yet. A
/// query whose words are ALL one character is therefore answered as the empty
/// query is, [`SearchError::NoSearchableWords`], which every surface already
/// draws as its empty-term answer.
pub const MIN_WORD_LETTERS: usize = 2;

/// Owner-typed words → an FTS5 MATCH expression.
///
/// A word of [`MIN_WORD_LETTERS`] or more is a quoted prefix phrase; a word of one
/// character beside such words is a quoted whole word, so typing `a b` after
/// `report` narrows to the documents with the word `a` and not to every word that
/// starts with it.
///
/// The words are [`centraid_apps_kit::spelling::words`] — **one tokenization**,
/// shared with the correction (`Search::correct`), so the word a member sees
/// corrected is the word the index was asked for.
///
/// # Errors
///
/// [`SearchError::NoSearchableWords`] when nothing searchable survives: no word
/// at all, or every word one character ([`MIN_WORD_LETTERS`]).
pub fn match_expression(query: &str) -> Result<String, SearchError> {
    let tokens: Vec<String> = words(query);
    if !tokens
        .iter()
        .any(|token| token.chars().count() >= MIN_WORD_LETTERS)
    {
        return Err(SearchError::NoSearchableWords {
            query: query.to_owned(),
        });
    }
    Ok(tokens
        .iter()
        .map(|token| {
            // A one-character word beside longer ones is a WHOLE word: `a*` has no
            // index of its own and merges every term that begins with `a`.
            if token.chars().count() < MIN_WORD_LETTERS {
                format!("\"{token}\"")
            } else {
                format!("\"{token}\"*")
            }
        })
        .collect::<Vec<String>>()
        .join(" "))
}

/// The same words, required to be in the TITLE: FTS5's column filter over the
/// whole group, `{title} : ("a"* "b"*)`.
///
/// # Errors
///
/// As [`match_expression`].
pub fn title_expression(query: &str) -> Result<String, SearchError> {
    Ok(format!("{{title}} : ({})", match_expression(query)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_word_becomes_a_quoted_prefix_phrase() {
        assert_eq!(
            match_expression("budget cabin").unwrap(),
            "\"budget\"* \"cabin\"*"
        );
    }

    /// The security half: an operator a member typed is a WORD.
    #[test]
    fn fts_operators_in_member_text_stay_literals() {
        assert_eq!(
            match_expression("dinner OR password").unwrap(),
            "\"dinner\"* \"OR\"* \"password\"*"
        );
        assert_eq!(match_expression("-secret").unwrap(), "\"-secret\"*");
        // An embedded quote cannot close the phrase, because it is removed.
        assert_eq!(match_expression("a\"b").unwrap(), "\"ab\"*");
    }

    #[test]
    fn a_query_of_one_character_words_is_the_empty_query() {
        for query in ["a", "a b", "  x ", "a ---", "é", "7"] {
            assert!(
                matches!(
                    match_expression(query),
                    Err(SearchError::NoSearchableWords { .. })
                ),
                "{query:?}"
            );
        }
        // One word of two letters is a search, and so is a long word beside a short.
        assert_eq!(match_expression("ca").unwrap(), "\"ca\"*");
        assert_eq!(match_expression("a bc").unwrap(), "\"a\" \"bc\"*");
        assert_eq!(match_expression("bc d").unwrap(), "\"bc\"* \"d\"");
    }

    #[test]
    fn the_title_expression_filters_the_group_to_the_title_column() {
        assert_eq!(
            title_expression("budget cabin").unwrap(),
            "{title} : (\"budget\"* \"cabin\"*)"
        );
        assert!(title_expression("a").is_err());
    }

    #[test]
    fn a_token_with_no_letter_or_digit_is_dropped_rather_than_emitted_empty() {
        assert_eq!(match_expression("--- rent").unwrap(), "\"rent\"*");
    }

    #[test]
    fn a_query_with_nothing_searchable_is_a_refusal_not_an_empty_page() {
        assert!(matches!(
            match_expression("   "),
            Err(SearchError::NoSearchableWords { .. })
        ));
        assert!(matches!(
            match_expression("--- ***"),
            Err(SearchError::NoSearchableWords { .. })
        ));
    }

    #[test]
    fn the_token_cap_is_v0s_sixteen() {
        let long = (0..40)
            .map(|index| format!("w{index}"))
            .collect::<Vec<String>>()
            .join(" ");
        let compiled = match_expression(&long).unwrap();
        assert_eq!(compiled.split(' ').count(), MAX_MATCH_TOKENS);
    }

    /// Non-ASCII words are words: `char::is_alphanumeric` is Unicode-aware, the
    /// same property v0's `\p{L}\p{N}` class has.
    #[test]
    fn a_non_ascii_word_survives() {
        assert_eq!(match_expression("café Ω").unwrap(), "\"café\"* \"Ω\"");
    }
}
