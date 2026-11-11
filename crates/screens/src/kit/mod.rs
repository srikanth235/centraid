//! What every app's screens share: civil time in words, the three states of a
//! read, the write helper, search's Ask row. An app's screens import from here
//! and never restate a law (#1135).

pub mod act;
pub mod attachments;
pub mod autosave;
pub mod civil;
pub mod earlier;
pub mod export;
pub mod follow;
pub mod links;
pub mod menu;
pub mod money;
pub mod origin;
pub mod owner;
pub mod quantity;
pub mod read;
pub mod schedule;
pub mod search;
pub mod secret;
pub mod share;
pub mod transfer;
pub mod trash;
pub mod undo;
