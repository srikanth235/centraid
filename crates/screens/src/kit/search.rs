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

/// "In an earlier version": the short line on a search row whose words the item said
/// only before, never now (#1185). The same words in every app's search and Home's.
#[must_use]
pub fn in_earlier_version(locale: Locale) -> String {
    shared::search_in_earlier_version(locale)
}

/// A search row's meta line when the words matched only an earlier version: "In an earlier
/// version", then whatever the row said of itself (`meta`, empty for none).
#[must_use]
pub fn earlier_meta(locale: Locale, meta: &str) -> String {
    let line = in_earlier_version(locale);
    if meta.trim().is_empty() {
        line
    } else {
        format!("{line} · {meta}")
    }
}

/// Where a row found only in an earlier version goes: that item's Earlier versions (`screen`
/// is the app's `<app>.earlier`), backing out to Search.
#[must_use]
pub fn earlier_route(locale: Locale, screen: &str, entity_id: &str) -> wire::Route {
    super::earlier::route(screen, entity_id, &shared::kit_search(locale))
}

/// "Including results for “x”", the line under a field when the core corrected
/// a typo.
#[must_use]
pub fn corrected(locale: Locale, words: &str) -> String {
    fill(&shared::search_corrected(locale), &[("corrected", words)])
}
