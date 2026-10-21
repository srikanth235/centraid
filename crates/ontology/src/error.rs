//! Every way opening or checking a vault can fail, as one typed enum.

use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum OntologyError {
    #[error("vault file {path} does not exist")]
    Missing { path: PathBuf },

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
