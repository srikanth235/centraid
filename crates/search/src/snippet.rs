//! The words a hit matched, in their text.
//!
//! The index is **contentless** (`content = ''`), so FTS5's own `snippet()` has
//! nothing to read. The door asks `crates/vault` for the text the entity was
//! indexed from (`centraid_vault::index::text_of`) and excerpts it here: the
//! first word a query token is a prefix of, a few words either side, the
//! matching words marked `⟦…⟧`, and `…` where the text goes on.

/// How many words of context sit before the first match.
const BEFORE: usize = 4;
/// How many words the excerpt runs on, from the first match.
const AFTER: usize = 8;

/// An excerpt of `text` around the first word any of `tokens` is a prefix of, or
/// `None` when no word matches (the hit was on the title).
///
/// The match is by prefix and without regard to case, because that is how the
/// query was asked ([`crate::match_expression`]: every word a quoted prefix).
#[must_use]
pub fn snippet_of(text: &str, tokens: &[String]) -> Option<String> {
    let words: Vec<&str> = text.split_whitespace().collect();
    let hit = |word: &str| {
        let folded = fold(word);
        !folded.is_empty()
            && tokens
                .iter()
                .any(|token| folded.starts_with(token.as_str()))
    };
    let first = words.iter().position(|word| hit(word))?;
    let start = first.saturating_sub(BEFORE);
    let end = (first + AFTER + 1).min(words.len());
    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    for (index, word) in words[start..end].iter().enumerate() {
        if index > 0 {
            out.push(' ');
        }
        if hit(word) {
            out.push('⟦');
            out.push_str(word);
            out.push('⟧');
        } else {
            out.push_str(word);
        }
    }
    if end < words.len() {
        out.push('…');
    }
    Some(out)
}

/// A word as the tokenizer would see it: letters and digits only, lowercased.
fn fold(word: &str) -> String {
    word.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tokens(words: &[&str]) -> Vec<String> {
        words.iter().map(|word| (*word).to_owned()).collect()
    }

    #[test]
    fn the_first_matching_word_is_marked_with_its_context() {
        let text = "one two three four five Cabin six seven eight nine ten eleven twelve thirteen fourteen";
        assert_eq!(
            snippet_of(text, &tokens(&["cab"])).as_deref(),
            Some("…two three four five ⟦Cabin⟧ six seven eight nine ten eleven twelve thirteen…")
        );
    }

    #[test]
    fn a_match_at_the_ends_has_no_ellipsis_on_that_side() {
        assert_eq!(
            snippet_of("cabin by the lake", &tokens(&["cabin"])).as_deref(),
            Some("⟦cabin⟧ by the lake")
        );
    }

    #[test]
    fn punctuation_does_not_hide_a_match_and_no_match_is_none() {
        assert_eq!(
            snippet_of("We went to the (cabin), twice.", &tokens(&["cabin"])).as_deref(),
            Some("We went to the ⟦(cabin),⟧ twice.")
        );
        assert_eq!(snippet_of("nothing here", &tokens(&["cabin"])), None);
    }
}
