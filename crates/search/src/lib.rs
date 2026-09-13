#![forbid(unsafe_code)]
//! # The FTS door — text search as the vault's own question (#1020, D-1020-N1)
//!
//! Matching happens **inside SQLite**. The alternative is what every app in v0
//! stopped doing: pull a table and grep it, over data that has no upper bound
//! (`packages/vault/src/gateway/search.ts:1`-`:5`). The FTS5 shadow tables are
//! the vault's — one per text-bearing entity, kept in step by triggers the
//! baseline installs — and **this crate owns every `MATCH` statement in the
//! workspace**. The app kit's grammar has no `MATCH` production at all
//! ([`centraid_apps_kit::grammar`]), which is what makes "an app cannot search
//! by hand" a fact rather than a convention.
//!
//! ## What this crate promises, and what enforces each promise
//!
//! | Promise | What enforces it |
//! |---|---|
//! | SQL lives here, not in an app | `cargo xtask rules`' `sql-confinement` allows `crates/{ontology,vault,seat,search}` and `crates/apps/kit`, and nothing else |
//! | Every read is a window | [`Search::query`] takes a [`centraid_apps_kit::page::PageRequest`], whose `limit` is required and has no default |
//! | A window continues by keyset | [`Page::next`] is the last row's `(rank, id)`; there is no offset to reconstruct |
//! | A denial is a VALUE | [`Answer`] is `Denied` or `Data`, never an `Err` (census §A seam 6) |
//! | A bound reports the size it reaches | [`SearchRequest::limit`] is clamped by [`MAX_MATCH_ROWS`] and [`Answer::window`] says what it actually was (D-1020-D3-12) |
//! | **A result can carry no secret** | [`Target`], and [`domains::assert_no_sealed_column`] — see below |
//!
//! ## Secret-free BY CONSTRUCTION, not by filtering
//!
//! A search result is a [`Target`]: five strings, every one of them read from a
//! column named in [`domains::DOMAINS`]. Three separate things have to be true
//! before a sealed value could reach a caller through this door, and each is
//! closed by a mechanism rather than by review:
//!
//! 1. **No sealed column is projected.** Every column any domain reads is
//!    checked against [`centraid_ontology::registries::sealed_physical_columns`]
//!    at door construction ([`domains::assert_no_sealed_column`]), so a domain
//!    that grew a sealed projection fails to open rather than answering.
//! 2. **No sealed column is INDEXED.** v0 throws at DDL-build time for an FTS
//!    spec naming a sealed column (`packages/vault/src/schema/fts.ts:404`-`:419`,
//!    issue #293) — FTS exclusion is one of the six sealed-column enforcement
//!    points (census §D2). [`SqliteDoor::open`] re-checks the live index columns
//!    against the same registry, so the DDL and this door cannot disagree.
//! 3. **`locker.item` is not a domain.** The absence is structural: the powerbox
//!    reaches seven domains and Locker is not one of them
//!    (`packages/blueprints/apps/notes/link-targets-table.ts:1`-`:3`), so a
//!    secret cannot become a link target by *adding a probe*. Asking for it is a
//!    typed [`SearchError::NotADomain`].
//!
//! `crates/search/tests/secret_free.rs` plants `lk1:` and `sealed:v1:` bytes in
//! every sealed column this model has and asserts the door answers nothing that
//! carries them.
//!
//! ## What this crate is NOT
//!
//! It is not the consent pipeline. v0's `searchEntity` evaluates access, folds
//! in the consent of every entity whose canonical text the index carries, fails
//! closed on a field mask that hides an indexed column, and receipts the
//! decision (`search.ts:43`-`:130`). Those are `crates/vault`'s gateway, whose
//! Rust home is the paged door; this crate takes the [`Principal`] it is given
//! and states, in [`SqliteDoor`]'s own words, which of those walls it does and
//! does not stand behind yet.

pub mod domains;
pub mod matching;
pub mod sqlite;

pub use domains::{DOMAINS, Domain, domain_of};
pub use matching::{MAX_MATCH_TOKENS, match_expression};
pub use sqlite::SqliteDoor;

use centraid_apps_kit::page::{Page, PageRequest};

/// The most rows one MATCH can return, whatever a caller asks for.
///
/// v0 clamps to 1,000 (`packages/vault/src/gateway/search.ts:127`) on top of
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

/// One search: which domain, what words, how many rows, and where to continue.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchRequest {
    /// A logical entity from [`DOMAINS`], e.g. `knowledge.note`.
    pub entity: String,
    /// Owner-typed words. Compiled by [`match_expression`]; FTS5 operators in
    /// it stay literals.
    pub query: String,
    /// The window, and where it continues from. Required, with no default.
    pub page: PageRequest,
    /// Ids of this domain the caller wants left out — Notes passes its journal
    /// set, because the Journal place is those entries' one home (#834
    /// R-journal). Applied **in the door**, over the ranked hits, so an
    /// all-journal search answers an empty list rather than a filtered one.
    pub excluded_ids: Vec<String>,
}

impl SearchRequest {
    /// A first window over one domain.
    #[must_use]
    pub fn new(entity: impl Into<String>, query: impl Into<String>, limit: usize) -> Self {
        Self {
            entity: entity.into(),
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
/// revocation (`packages/server/src/engine/handlers/vault-bridge.ts:29`-`:36`).
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

/// ONE SEARCH RESULT, AND IT CANNOT CARRY A SECRET.
///
/// Five strings and nothing else. There is no `Value`, no map, no
/// `extra: serde_json::Value`, no byte field — so there is no shape a sealed
/// cell could arrive in even if a domain grew one, and
/// [`domains::assert_no_sealed_column`] is what stops a domain growing one at
/// all. This is v0's `LinkTarget`
/// (`packages/blueprints/apps/notes/types.ts`), which the powerbox already
/// treats as its whole vocabulary.
///
/// `snippet` is the index's own highlight (`snippet(fts, -1, '⟦', '⟧', '…',
/// 12)`), and it is a projection of the SAME indexed columns — a sealed column
/// is not indexed, so it cannot appear in a snippet either.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Target {
    /// The logical entity, e.g. `knowledge.note`.
    #[serde(rename = "type")]
    pub entity: String,
    /// The row's own primary key.
    pub id: String,
    /// The first non-empty label column. A row with none **is not a target** —
    /// an unlabelled link is a link a member cannot recognise.
    pub title: String,
    /// The first non-empty subtitle column, or the app's name when there is
    /// none. Never empty, so a surface has nothing to guess.
    pub subtitle: String,
    /// The app a member would open this in, by ID. The product catalogue owns
    /// the NAME (#883, ruling O-label), so this crate carries the id and
    /// `crates/design` lowers it.
    pub app_id: String,
    /// The index's highlight of the match, or empty when it had none.
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
}

/// Everything this door refuses, and why each one is a refusal rather than an
/// empty page.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SearchError {
    /// The entity is not one of the seven. **`locker.item` lands here on
    /// purpose**: the absence is the security property, so asking has to fail
    /// loudly rather than answer nothing and look like "no matches".
    #[error(
        "`{entity}` is not a search domain — the powerbox reaches {count} domains and a secret cannot become one by adding a probe (#1020, D-1020-N1)"
    )]
    NotADomain { entity: String, count: usize },

    /// Every word was punctuation. v0 throws `contract` here for the same
    /// reason: an empty quoted phrase is an FTS5 syntax error, so there is no
    /// statement to run (`search.ts:66`-`:69`).
    #[error("\"{query}\" has no searchable words")]
    NoSearchableWords { query: String },

    /// The index is not in this file, or does not carry the column the domain
    /// projects. A door that answered anyway would be answering over a
    /// different model than the one it was written against.
    #[error("the index for `{entity}` is not usable: {detail}")]
    IndexUnusable { entity: String, detail: String },

    /// A SEALED COLUMN IS REACHABLE FROM THIS DOOR. Refusing to open is the
    /// only safe answer: the alternative is a door that filters, and a filter
    /// is a thing someone edits.
    #[error(
        "`{entity}`.`{column}` is a sealed column and `{table}` feeds the search index — sealed columns are never indexed (#293; #1020, D-1020-N1)"
    )]
    SealedColumnReachable {
        entity: String,
        table: String,
        column: String,
    },

    /// The window itself was refused by the kit.
    #[error("{0}")]
    Window(#[from] centraid_apps_kit::error::KitError),

    /// SQLite said no. A broken fixture or a file from a newer rung.
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
