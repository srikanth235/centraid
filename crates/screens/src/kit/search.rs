//! SEARCH'S ONE ASK (#1135): the row at the foot of an answer that hands the
//! term to the assistant, scoped to the app the member searched from.

use centraid_api_proto::core_v1 as wire;

use crate::strings::{Locale, fill, shared};

/// How many recent terms are kept for one search.
pub const RECENT_MAX: usize = 4;

/// THE TERMS MEMBERS RECENTLY SEARCHED (ruling 24, #1202): held in memory for as long as the
/// runtime lives, so closing and reopening Search shows them and a restart shows none. Never
/// written anywhere. One list per search (Home's, Health's in place), newest first, once each.
/// The runtime empties it whenever the vault in front changes, so one vault's terms are never
/// offered over another's.
#[derive(Clone, Debug, Default)]
pub struct Recents(
    std::sync::Arc<std::sync::Mutex<std::collections::BTreeMap<String, Vec<String>>>>,
);

impl Recents {
    fn lock(&self) -> std::sync::MutexGuard<'_, std::collections::BTreeMap<String, Vec<String>>> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// The terms kept for the search `scope` (an app id, or empty for Home's), newest first.
    #[must_use]
    pub fn get(&self, scope: &str) -> Vec<String> {
        self.lock().get(scope).cloned().unwrap_or_default()
    }

    /// Remember `term` for `scope`: newest first, a repeat (in any case) moved to the front,
    /// at most [`RECENT_MAX`] kept. A blank term is not remembered.
    pub fn remember(&self, scope: &str, term: &str) {
        let term = term.trim();
        if term.is_empty() {
            return;
        }
        let mut held = self.lock();
        let kept = held.entry(scope.to_owned()).or_default();
        let folded = term.to_lowercase();
        kept.retain(|old| old.to_lowercase() != folded);
        kept.insert(0, term.to_owned());
        kept.truncate(RECENT_MAX);
    }

    /// Forget every term (the vault in front changed).
    pub fn clear(&self) {
        self.lock().clear();
    }
}

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
