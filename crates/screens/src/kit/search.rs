//! SEARCH'S ONE ASK (#1135): the row at the foot of an answer that hands the
//! term to the assistant, scoped to the app the member searched from.

use centraid_api_proto::core_v1 as wire;

use crate::strings::{Locale, fill, shared};

/// The question the Ask sends for `term`.
#[must_use]
pub fn question(locale: Locale, term: &str) -> String {
    fill(
        &shared::search_ask_question(locale),
        &[("term", term.trim())],
    )
}

/// The Ask row's label for `term`.
#[must_use]
pub fn ask_label(locale: Locale, term: &str) -> String {
    fill(&shared::search_ask_about(locale), &[("term", term.trim())])
}

/// The Ask row for `term`, opening the chat in `scope` (an app id, or empty for
/// every app).
#[must_use]
pub fn offer(locale: Locale, term: &str, scope: &str) -> wire::SearchAsk {
    wire::SearchAsk {
        label: ask_label(locale, term),
        question: question(locale, term),
        scope: scope.to_owned(),
        route: Some(crate::chat::routes::ask(&question(locale, term), scope)),
    }
}

/// "Including results for “x”", the line under a field when the core corrected
/// a typo.
#[must_use]
pub fn corrected(locale: Locale, words: &str) -> String {
    fill(&shared::search_corrected(locale), &[("corrected", words)])
}
