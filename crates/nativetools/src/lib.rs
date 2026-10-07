//! `centraid-nativetools` — the flat tool surface a small on-device model
//! drives over the real vault (`experiments/toolchat/native/SPEC.md`).
//!
//! Eight tools (`search`, `find`, `open`, `compute`, `act`, `answer`, `ask`,
//! `decline`), one metadata table they are all generated from, a date
//! expression evaluator the model writes typed expressions for, observations,
//! the system prompt, and world seeding through the vault's typed commands.
//! The runtime reads the person's message in a few named places only: to retrieve the
//! pre-grounding rows, to list the resolution of its date phrases (`phrases::dates_line`), to
//! repair a stated date (`ground`), to pick the row in focus and to check a pick for ambiguity
//! (`session`, `act`), to read the plain yes that confirms a write over the cap (`act`), to read a retraction that
//! ends the turn (`phrases::is_retraction`), and to
//! fill a slot a read leaves out from a few words the SPEC names (`ground::Defaults`). It
//! never writes SQL: reads go through the app kit's paged door and writes through `Vault::execute`.
//!
//! `compile` turns the slots of a v3 trace into the call the runtime executes (`compile`), and
//! `export` writes the error table beside the other contract files (`export::errors`).
//!
//! The `nativetools` binary is what the Python side drives (JSON lines).

#![forbid(unsafe_code)]

pub mod act;
mod block;
pub mod compile;
mod compose;
pub mod dates;
mod dates_ctx;
pub mod export;
mod failsoft;
mod follow;
pub mod ground;
pub mod identity;
pub mod meta;
mod normalize;
pub mod parse;
pub mod phrases;
pub mod prompt;
mod recover;
pub mod render;
pub mod resolve;
pub mod search;
pub mod seed;
pub mod session;
pub mod trace;
pub mod values;
pub mod vaultio;
pub mod whr;
pub mod world;

pub use session::{Flags, Session};
