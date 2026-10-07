//! The native tool runtime: the flat tool surface a small on-device model
//! drives over a vault (`experiments/toolchat/native/SPEC.md`).
//!
//! Eight tools (`search`, `find`, `open`, `compute`, `act`, `answer`, `ask`,
//! `decline`), one metadata table they are all generated from, a date
//! expression evaluator the model writes typed expressions for, observations,
//! the system prompt, and the typed commands a write goes through.
//! The runtime reads the person's message in a few named places only: to retrieve the
//! pre-grounding rows, to list the resolution of its date phrases (`phrases::dates_line`), to
//! repair a stated date (`ground`), to pick the row in focus and to check a pick for ambiguity
//! (`session`, `act`), to read the plain yes that confirms a write over the cap (`act`), to read a retraction that
//! ends the turn (`phrases::is_retraction`), and to
//! fill a slot a read leaves out from a few words the SPEC names (`ground::Defaults`). It
//! never writes SQL: reads go through the app kit's paged door and writes through `Vault::execute`.
//!
//! `compile` turns the slots of a v3 trace into the call the runtime executes (`compile`), and
//! `think` is the same compile step with no vault, reading a think's text (the decoder's and the
//! data builders' compiler, and the v3.1 to v4 rewrite of a think).
//!
//! The trainer drives this runtime through the `nativetools` binary (`crates/nativetools`, JSON
//! lines), which also seeds worlds and writes the export; the phone links it from here.

pub mod act;
mod block;
pub mod compile;
mod compose;
pub mod dates;
mod dates_ctx;
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
pub mod session;
pub mod think;
pub mod trace;
pub mod transcript;
pub mod values;
pub mod vaultio;
pub mod whr;
pub mod world;

pub use session::{Flags, Session};
