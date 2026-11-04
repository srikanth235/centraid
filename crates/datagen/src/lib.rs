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

#![forbid(unsafe_code)]

pub mod ambiguity;
pub mod catalog;
pub mod facts;
mod generate;
pub mod grid;
pub mod intent;
pub mod persona;
pub mod plan;
mod pools;
pub mod rng;
pub mod run;
pub mod sample;
pub mod settings;
pub mod source;
pub mod text;
pub mod world;

pub use catalog::Catalog;
pub use settings::{Settings, Split};
pub use world::{World, WorldSpec, plan};
