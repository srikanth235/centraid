//! The tier-D paraphrase parser: member text -> the canonical grammar of
//! `crates/evalsuite/grammar/GRAMMAR.md`, with NO model in the loop.
//!
//! It exists to put a floor under every later candidate. A 20M-parameter
//! encoder that cannot beat hand-written rules on a corpus this small is not
//! earning its megabytes; one that can, should be measured against this and
//! not against zero. It never touches the vault: a `Canonical` is a sentence,
//! and executing it is somebody else's job.

pub mod calendar;
pub mod lexicon;
pub mod rules;
pub mod score;
pub mod tree;

pub use rules::{Move, ParseState, Parser};
pub use tree::{Canonical, Turn, Unparsed};
