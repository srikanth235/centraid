#![forbid(unsafe_code)]
//! # The FTS door: text search as the vault's own question
//!
//! Matching happens **inside SQLite**. The vault keeps ONE index, `search`, a
//! contentless FTS5 table whose rowid is `entity.n`, written at commit by
//! `crates/vault`'s gate for every entity a command touched
//! ([#1135](https://github.com/srikanth235/centraid/issues/1135)). This crate
//! owns every `MATCH` statement in the workspace; the app kit's grammar has no
//! `MATCH` production at all ([`centraid_apps_kit::grammar`]), which is what
//! makes "an app cannot search by hand" a fact rather than a convention.
//!
//! A read joins `entity` on `n` for the kind and the trash filter, so a result
//! is an entity's id, kind and title and nothing else: **a result can carry no
//! secret** because the index holds none. Locker is not an entity and is not in
//! the index, so asking for it is a typed [`SearchError::NotSearchable`], never
//! an empty page (an empty page reads as "no matches", which is a different
//! claim about the vault).
//!
//! | Promise | What enforces it |
//! |---|---|
//! | SQL lives here, not in an app | `cargo xtask rules`' `sql-confinement` |
//! | Every read is a window | [`Search::query`] takes a [`centraid_apps_kit::page::PageRequest`], whose `limit` is required and has no default |
//! | A window continues by keyset | [`Page::next`] is the last row's `(rank, id)`; there is no offset to reconstruct |
//! | A denial is a VALUE | [`Answer`] is `Denied` or `Data`, never an `Err` |
//! | A bound reports the size it reaches | [`SearchRequest::page`] is clamped by [`MAX_MATCH_ROWS`] and [`Answer::window`] says what it actually was |
//! | A correction is a bounded lookup | [`Search::correct`] replaces a word by a whole term of the one vocabulary, reading at most [`MAX_VOCAB_SCAN`] rows per word |
//!
//! ## What this crate is NOT
//!
//! It is not the consent pipeline: it takes the [`Principal`] it is given and
//! answers the OWNER's view. Wiring a consented search is `crates/vault`'s
//! paged-door work, written down here rather than stubbed, because a stub that
//! *looks* like a consent check is worse than an absence that is written down.

pub mod matching;
pub mod snippet;
pub mod sqlite;

pub use matching::{MAX_MATCH_TOKENS, match_expression};
pub use sqlite::{MAX_VOCAB_SCAN, SqliteDoor};

use centraid_apps_kit::page::{Page, PageRequest};

/// The most rows one MATCH can return, whatever a caller asks for.
///
/// v0 clamps to 1,000 on top of
/// the window's own `MAX_PAGE_ROWS` of 500. Both clamps are kept: this one is
/// the door's, the kit's is the page's, and [`Answer::window`] reports the one
/// that actually applied — a bound that names a number it cannot reach is worse
/// than a smaller bound (D-1020-D3-12).
pub const MAX_MATCH_ROWS: usize = 1_000;

/// WHO IS ASKING. The door does not invent one.
///
/// A search is a read, and a read is authorised against a caller. `Owner` is the
/// identity v0's parity fixtures are generated under — no row filter, no field
/// mask — and `App` carries the id a grant is written against.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Principal {
    /// The vault's owner, through a device seat.
    Owner,
    /// A blueprint app, under its grant.
    App { app_id: String },
}

impl Principal {
    /// The app id, when there is one. `None` is the owner, never "unknown".
    #[must_use]
    pub fn app_id(&self) -> Option<&str> {
        match self {
            Self::Owner => None,
            Self::App { app_id } => Some(app_id),
        }
    }
}

/// One search: which kinds, what words, how many rows, and where to continue.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchRequest {
    /// The kinds to look in (`note`, `person`, `event`, ...), by the words
    /// `entity.kind` spells. Empty answers every searchable kind.
    pub kinds: Vec<String>,
    /// Owner-typed words. Compiled by [`match_expression`]; FTS5 operators in
    /// it stay literals.
    pub query: String,
    /// The window, and where it continues from. Required, with no default.
    pub page: PageRequest,
    /// Ids the caller wants left out: Notes passes its journal set, because the
    /// Journal place is those entries' one home (#834 R-journal). Applied **in
    /// the door**, over the ranked hits, so an all-journal search answers an
    /// empty list rather than a filtered one.
    pub excluded_ids: Vec<String>,
}

impl SearchRequest {
    /// A first window over one kind.
    #[must_use]
    pub fn new(kind: impl Into<String>, query: impl Into<String>, limit: usize) -> Self {
        Self::across([kind.into()], query, limit)
    }

    /// A first window over several kinds at once; none means every searchable one.
    #[must_use]
    pub fn across(
        kinds: impl IntoIterator<Item = String>,
        query: impl Into<String>,
        limit: usize,
    ) -> Self {
        Self {
            kinds: kinds.into_iter().collect(),
            query: query.into(),
            page: PageRequest::first(limit),
            excluded_ids: Vec::new(),
        }
    }

    /// The same request with ids the caller wants excluded.
    #[must_use]
    pub fn excluding(mut self, ids: Vec<String>) -> Self {
        self.excluded_ids = ids;
        self
    }
}

/// A CONSENT DENIAL, as a search carries it.
///
/// The same shape every app's payload carries: a code, a sentence and the
/// instant the grant was revoked — which comes from the HOST, because an app
/// whose grant was revoked cannot read the consent tables to date its own
/// revocation.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Denial {
    pub code: Option<String>,
    pub message: Option<String>,
    pub revoked_at: Option<String>,
}

/// What a search answered. **A refusal is one of the answers.**
#[derive(Debug, Clone, PartialEq)]
pub enum Answer {
    /// The vault refused. A surface renders the ask, not an empty list —
    /// "nothing matched" and "you may not ask" are different sentences and only
    /// one of them is worth a member's time (census §A seam 6).
    Denied(Denial),
    /// The page, and the window that produced it.
    Data {
        page: Page<Target>,
        /// The rows this window could reach — the caller's limit after both
        /// clamps, not the number it asked for.
        window: usize,
    },
}

impl Answer {
    /// The targets, when there are targets. **Not** a default: a caller that
    /// wants to print "nothing matched" has to decide what "we cannot look"
    /// prints as.
    #[must_use]
    pub fn targets(&self) -> Option<&[Target]> {
        match self {
            Self::Data { page, .. } => Some(&page.rows),
            Self::Denied(_) => None,
        }
    }

    /// The window that applied, when the read happened.
    #[must_use]
    pub const fn window(&self) -> Option<usize> {
        match self {
            Self::Data { window, .. } => Some(*window),
            Self::Denied(_) => None,
        }
    }
}

/// One hit. Strings and nothing else: there is no `Value`, no map, no byte field,
/// so there is no shape a sealed cell could arrive in even if the index held one,
/// and it holds none (Locker is not indexed).
///
/// `snippet` is the matching words in their text, marked `⟦…⟧` ([`snippet`]),
/// read from the same text the index was written from.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Target {
    /// The entity's kind (`note`, `person`, ...).
    #[serde(rename = "type")]
    pub entity: String,
    /// The entity's id.
    pub id: String,
    /// The entity's title. An entity with none **is not a target**: an
    /// unlabelled link is a link a member cannot recognise.
    pub title: String,
    /// What the hit is, in words (`note`, `person`, ...), so a surface never
    /// has to guess; never empty.
    pub subtitle: String,
    /// The highlight of the match, or empty when it had none.
    pub snippet: String,
}

/// THE DOOR. One method, and it reads.
pub trait Search {
    /// One page of one domain, under `principal`.
    ///
    /// `Err` is for a question the door cannot answer *at all* — an unknown
    /// domain, a query with no searchable word, a broken index. A **denial** is
    /// not one of those: it is [`Answer::Denied`], because a surface renders it.
    fn query(&self, principal: &Principal, request: &SearchRequest) -> Result<Answer, SearchError>;

    /// The query with its mistyped words replaced by the words the vault holds,
    /// or `None` when no word changed (#1097, R4, R4a).
    ///
    /// **A caller runs this only when its whole exact answer was empty**, then
    /// runs [`Search::query`] again with the words it returned and says what it
    /// searched for. It is a correction and never a wider match: a word the
    /// vocabulary holds is kept, a word of fewer than four letters or with a digit
    /// is kept, a slip in the first letter is not corrected (except a swap of the
    /// first two), and the replacement is always a whole term the named
    /// domains' vocabularies hold (R4b). The rule is
    /// [`centraid_apps_kit::spelling`]'s, which the assistant's name resolver
    /// reads too.
    ///
    /// `entities` are the kinds the caller is about to search
    /// again, and the same refusal applies as in `query`: an entity that is
    /// neither is [`SearchError::NotSearchable`], so Locker has no vocabulary to ask.
    ///
    /// The default is `None`, so a door with no vocabulary (a test double, a
    /// recorder around another door) is a door that corrects nothing and not one
    /// that fails to compile; a door that wraps another has to forward this.
    ///
    /// # Errors
    ///
    /// The refusals `query` has for an unknown domain and a broken index. A
    /// query with nothing to correct is `Ok(None)`.
    fn correct(
        &self,
        principal: &Principal,
        entities: &[&str],
        query: &str,
    ) -> Result<Option<String>, SearchError> {
        let _ = (principal, entities, query);
        Ok(None)
    }
}

/// Everything this door refuses, and why each one is a refusal rather than an
/// empty page.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SearchError {
    #[error(
        "`{kind}` is not a kind the vault searches: its index holds {count} kinds, and a secret cannot become one (#1135)"
    )]
    NotSearchable { kind: String, count: usize },

    #[error("\"{query}\" has no searchable words")]
    NoSearchableWords { query: String },

    #[error("the search index is not usable: {detail}")]
    IndexUnusable { detail: String },

    #[error("{0}")]
    Window(#[from] centraid_apps_kit::error::KitError),

    #[error("search: {0}")]
    Sqlite(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_answer_keeps_denied_and_empty_apart() {
        let denied = Answer::Denied(Denial::default());
        assert!(denied.targets().is_none());
        assert!(denied.window().is_none());
        let empty = Answer::Data {
            page: Page {
                rows: Vec::new(),
                next: None,
            },
            window: 8,
        };
        assert_eq!(empty.targets().map(<[Target]>::len), Some(0));
        assert_eq!(empty.window(), Some(8));
    }

    #[test]
    fn a_principal_never_reports_an_unknown_app() {
        assert_eq!(Principal::Owner.app_id(), None);
        assert_eq!(
            Principal::App {
                app_id: "notes".to_owned()
            }
            .app_id(),
            Some("notes")
        );
    }
}
