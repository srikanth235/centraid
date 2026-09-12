//! Every way opening or checking a vault can fail, as one typed enum.
//!
//! The two version refusals are named after the compatibility policy in
//! [#1020](https://github.com/srikanth235/centraid/issues/1020): a file NEWER
//! than the binary is `DowngradeRefused` (the core never guesses at a shape it
//! does not know), a file OLDER is `UpgradeRequired`. There are no migrations
//! in this crate yet, so `UpgradeRequired` is a refusal rather than a step —
//! `crates/vault` grows the forward-only ladder.

use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum OntologyError {
    #[error("vault file {path} does not exist")]
    Missing { path: PathBuf },

    #[error(
        "vault file {path} is at PRAGMA user_version {found}, newer than this build understands ({expected}) — refusing to downgrade"
    )]
    DowngradeRefused {
        path: PathBuf,
        found: i64,
        expected: i64,
    },

    #[error(
        "vault file {path} is at PRAGMA user_version {found}, older than this build expects ({expected}) — a forward migration is required"
    )]
    UpgradeRequired {
        path: PathBuf,
        found: i64,
        expected: i64,
    },

    #[error("sqlite refused: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    #[error("{context}: {source}")]
    Json {
        context: String,
        #[source]
        source: serde_json::Error,
    },
}

pub type Result<T> = std::result::Result<T, OntologyError>;
