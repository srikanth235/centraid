//! What every app's screens share: civil time in words, the three states of a
//! read, the write helper, search's Ask row. An app's screens import from here
//! and never restate a law (#1135).

pub mod act;
pub mod civil;
pub mod export;
pub mod money;
pub mod owner;
pub mod permission;
pub mod quantity;
pub mod read;
pub mod secret;
pub mod transfer;
pub mod undo;
