//! `centraid-nativetools` — the trainer's side of the native tool runtime.
//!
//! The runtime itself (the eight tools, the metadata table, the date evaluator, observations,
//! the system prompt and the session that runs them) is `centraid_assist::native`
//! (`crates/assist`), the one assistant plane the phone and the fine-tuning loop share (#1088).
//! This crate keeps what only the harness needs: `seed` founds a world from a fixture through the
//! vault's typed commands, `export` writes the contract files (tool schemas, kind card, tables,
//! rendered prompts, the error table) beside `contracts/assist/export/`, `vaultio` opens a vault
//! file for the runtime, and the `nativetools` binary is what the Python side drives (JSON
//! lines).
//!
//! The runtime's modules are re-exported under their old paths, so a test or a tool written
//! against `centraid_nativetools::meta` still reads the same table.

#![forbid(unsafe_code)]

pub mod export;
pub mod seed;

pub use centraid_assist::native::{
    Flags, Session, act, compile, dates, ground, identity, meta, parse, phrases, prompt, render,
    resolve, search, session, think, trace, values, vaultio, whr, world,
};
