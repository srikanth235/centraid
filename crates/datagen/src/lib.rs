//! `centraid-datagen` — the chat model's single evolvable training-data pipeline (#1188), in Rust.
//!
//! Four-part evolvable architecture:
//! 1. [`declarations`] (+ [`catalog`]): schema derived from `centraid_assist::native::{meta, prompt}`,
//!    with `{type, value_maker, live, wording_hint, meaning_key}` and incremental `ChangeClassifier`.
//! 2. [`fixture_world`] (+ [`world`], [`pools`], [`text`], [`rng`], [`ambiguity`]): minimal deterministic
//!    fixture worlds per intent (referenced rows + look-alike distractors, multi-currency with ~40% INR,
//!    presence-only Locker items).
//! 3. [`intents`], [`deficit`], [`phrasing_cache`]: cross-product intent planner, isolated `<cache>/train/`
//!    and `<cache>/heldout/` meaning-keyed phrasing caches, deficit work orders, and Hydrogen swarm
//!    writer/reader batch export/import (`WRITER_PREFIX`, 8-10 variants/prompt).
//! 4. [`oracle`], [`render`], [`mix`], [`version`], [`drift`], [`publish`]: current-runtime oracle
//!    replay, ambiguity resolver, selective reader gating, currency message check, deterministic zstd
//!    sharding, contract verification, and split-repo publishing.

#![forbid(unsafe_code)]

pub mod ambiguity;
pub mod bpe;
pub mod brief;
pub mod catalog;
pub mod contract;
pub mod declarations;
pub mod deficit;
pub mod drift;
pub mod facts;
pub mod fixture_world;
pub mod intent;
pub mod intents;
pub mod labels;
pub mod mistakes;
pub mod mix;
pub mod oracle;
pub mod phrasing_cache;
pub mod plan;
pub mod pools;
pub mod publish;
pub mod render;
pub mod rng;
pub mod rollout;
pub mod source;
pub mod style;
pub mod text;
pub mod trace;
pub mod typos;
pub mod verify;
pub mod version;
pub mod world;

pub use catalog::Catalog;
pub use declarations::Declarations;
pub use world::{Split, World, WorldSpec};
