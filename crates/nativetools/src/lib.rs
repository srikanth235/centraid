//! `centraid-nativetools` — the flat tool surface a small on-device model
//! drives over the real vault (`experiments/toolchat/native/SPEC.md`).
//!
//! Eight tools (`search`, `find`, `open`, `compute`, `act`, `answer`, `ask`,
//! `decline`), one metadata table they are all generated from, a date
//! expression evaluator the model writes typed expressions for, observations,
//! the system prompt, and world seeding through the vault's typed commands.
//! The runtime never reads the person's message except to retrieve
//! pre-grounding rows, and never writes SQL: reads go through the app kit's
//! paged door and writes through `Vault::execute`.
//!
//! The `nativetools` binary is what the Python side drives (JSON lines).

#![forbid(unsafe_code)]

pub mod act;
pub mod dates;
pub mod export;
pub mod ground;
pub mod meta;
pub mod parse;
pub mod phrases;
pub mod prompt;
pub mod render;
pub mod search;
pub mod seed;
pub mod session;
pub mod trace;
pub mod values;
pub mod vaultio;
pub mod whr;
pub mod world;

pub use session::{Flags, Session};
