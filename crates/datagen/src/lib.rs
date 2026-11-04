//! `centraid-datagen` — the chat model's training-data pipeline (#1166), in Rust.
//!
//! Built so far (M1): [`catalog`] (stage 0, the only schema), [`world`] and [`generate`]
//! (stage 1, worlds as a pure function of a seed) and [`ambiguity`] (how confusable a world's
//! names are). Later stages (intents, planner, messages, render, mix) add modules beside these
//! and read the catalog; none of them reads a schema from anywhere else.

#![forbid(unsafe_code)]

pub mod ambiguity;
pub mod catalog;
mod generate;
pub mod persona;
mod pools;
pub mod rng;
pub mod settings;
pub mod text;
pub mod world;

pub use catalog::Catalog;
pub use settings::{Settings, Split};
pub use world::{World, WorldSpec, plan};
