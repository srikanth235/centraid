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

/// Owner-typed words → an FTS5 MATCH expression.
///
/// The words are [`centraid_apps_kit::spelling::words`] — **one tokenization**,
/// shared with the correction (`Search::correct`), so the word a member sees
/// corrected is the word the index was asked for (#1097, R5).
///
/// # Errors
///
/// [`SearchError::NoSearchableWords`] when nothing searchable survives.
pub fn match_expression(query: &str) -> Result<String, SearchError> {
    let tokens: Vec<String> = words(query);
    if tokens.is_empty() {
        return Err(SearchError::NoSearchableWords {
            query: query.to_owned(),
        });
    }
    Ok(tokens
        .iter()
        .map(|token| format!("\"{token}\"*"))
        .collect::<Vec<String>>()
        .join(" "))
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
        assert_eq!(match_expression("café Ω").unwrap(), "\"café\"* \"Ω\"*");
    }
}
