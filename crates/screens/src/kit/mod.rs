//! What every app's screens share: civil time in words, the three states of a
//! read, the write helper, search's Ask row. An app's screens import from here
//! and never restate a law (#1135).

pub mod act;
pub mod autosave;
pub mod civil;
pub mod read;
pub mod search;
pub mod secret;
pub mod trash;
