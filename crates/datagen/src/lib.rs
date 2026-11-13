//! `centraid-datagen` — the chat model's training-data pipeline (#1166), in Rust.
//!
//! Built so far (M1, M2): [`catalog`] (stage 0, the only schema), [`world`] and [`generate`]
//! (stage 1, worlds as a pure function of a seed) and [`ambiguity`] (how confusable a world's
//! names are). Later stages (intents, planner, messages, render, mix) add modules beside these
//! and read the catalog; none of them reads a schema from anywhere else.
//!
//! M2 adds [`grid`] (the coverage grid), [`intent`] (typed intents and scenarios), [`facts`] (what
//! a world holds), [`sample`] (stage 2, the intent sampler), [`plan`] (stage 3, reference calls
//! run through the runtime, gold as its effect), [`run`] (both stages over many worlds, with the
//! coverage report) and [`source`] (the sessions as an `assist-eval` source).
//!
//! M3 adds [`brief`] (a typed turn in plain English), [`llm`] (Haiku behind a trait, with a
//! prompt-hash cache), [`typos`] (the seeded typo pass), [`verify`] (runtime grounding and the
//! read-back pass) and [`messages`] (stages 4 and 5 end to end).
//!
//! M4 adds [`bpe`] (the chat model's byte-level BPE, read from its `tokenizer.json`), [`trace`] (the v4 think of a reference call, round-tripped through the runtime's compiler),
//! [`render`] (a session as the phone renders it, tokenized, with the loss weight of every token), [`mix`]
//! (the sessions of a data version, chosen to the grid's shares) and [`version`] (the files and the manifest of
//! a data version, and the record contract M6 reads).
//!
//! M7 adds [`rollout`]: the RFT records `assist-eval` cuts from a model's rollouts, rendered by the M4
//! renderer (`datagen rollout-records`).

#![forbid(unsafe_code)]

pub mod ambiguity;
pub mod bpe;
pub mod brief;
pub mod catalog;
pub mod contract;
pub mod facts;
mod generate;
pub mod grid;
pub mod intent;
pub mod labels;
pub mod llm;
pub mod messages;
pub mod mistakes;
pub mod mix;
pub mod persona;
pub mod plan;
pub mod pools;
pub mod publish;
pub mod rehearsal;
pub mod render;
pub mod rng;
pub mod rollout;
pub mod run;
pub mod sample;
pub mod settings;
pub mod source;
pub mod style;
pub mod text;
pub mod trace;
pub mod typos;
pub mod verify;
pub mod version;
pub mod world;

pub use catalog::Catalog;
pub use settings::{Settings, Split};
pub use world::{World, WorldSpec, plan};
