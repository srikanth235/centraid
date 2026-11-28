//! What a read refuses, and the sentence a member reads for it.

use super::Shape;

/// The sentence for a cursor that is not this list's: a list that changed under a screen.
pub const STALE_LIST: &str = "This list changed. Reload.";

/// Why a read did not answer.
#[derive(Debug, thiserror::Error)]
pub enum ReadError {
    /// A cursor naming another read, with the wrong number of keys, or not a cursor at all.
    #[error("{STALE_LIST}")]
    StaleCursor,

    /// The statement reads something its declaration does not name, or something no read may.
    #[error("read `{read}` is refused: {why}")]
    Refused { read: &'static str, why: String },

    /// The statement and its declaration disagree.
    #[error("read `{read}` is declared wrongly: {why}")]
    Declared { read: &'static str, why: String },

    /// A parameter that is missing, extra, or not of its declared type.
    #[error("read `{read}`: parameter `{name}` {why}")]
    Param {
        read: &'static str,
        name: String,
        why: &'static str,
    },

    /// A read of a shape that does not take what it was asked (a page of a `ByKey`).
    #[error("read `{read}` is a {shape:?} and cannot be asked that")]
    Shape { read: &'static str, shape: Shape },

    /// More rows than the read's bound.
    #[error("read `{read}` returned more than its bound of {bound} rows")]
    Bound { read: &'static str, bound: usize },

    #[error(transparent)]
    Sql(#[from] rusqlite::Error),
}

/// A result of this module.
pub type Result<T> = std::result::Result<T, ReadError>;
