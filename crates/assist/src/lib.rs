//! The on-device chat plane.
//!
//! Centraid is visual-first, and the chat follows: an answer is one short line
//! of model text and **result cards** — real rows (a task, a photograph, a
//! ledger line, a person) that the app's own tile draws and taps through to.
//! The model routes and phrases; the apps draw the data.
//!
//! This crate is everything about that except the engine and the vault:
//!
//! | Module | What it owns |
//! |---|---|
//! | [`tool`] | The registry of reads the model may name, built from the app read queries. Locker is not in it, by construction. |
//! | [`call`] | Parsing the model's route — a call, "no tool fits", or a direct answer. |
//! | [`grammar`] | The GBNF the engine decodes under, generated from the same registry. |
//! | [`prompt`] | The Qwen ChatML template and the 2K-token budget. |
//! | [`model`], [`host`] | The [`model::Model`] trait an engine implements, and the slot a loaded model lives in. |
//! | [`attach`] | A photograph or a text document riding on one question: the prompt, the truncation, the marker the history keeps. |
//! | [`turn`] | The turn loop: route, read, phrase, cards — and its typed refusals. |
//! | [`result`] | What a read answers: cards to draw, a digest for the model. |
//! | [`suggest`] | Three questions this vault can answer. |
//! | [`eval`], [`cli`] | The routing eval set, its JSONL export, the accuracy harness and the `assist-eval` command line. |
//! | [`native`] | The native tool runtime: eight flat tools over a vault, one metadata table, the date evaluator, observations and the system prompt (`experiments/toolchat/native/SPEC.md`). |
//! | [`native_turn`] | The native turn loop (#1088): the model drives [`native`] one call per message; the chat's own cards and a line composed from the effect. |
//! | [`testing`] | Deterministic stand-ins for the engine and the vault. |
//!
//! # WHAT THIS CRATE DOES NOT HAVE
//!
//! No SQL, no connection of its own, no engine, and no persistence of its own: a
//! [`turn::Session`] is in memory and ends with the app. What was said is saved
//! by `crates/core` through the `chat.*` commands, and a stored thread comes
//! back through [`turn::Session::restore`] (R-CHAT-1). The read goes through
//! [`turn::Reader`], which `crates/core` implements over the same query path a
//! screen uses; the model goes through [`model::Model`], which the llama.cpp
//! binding implements.
//!
//! v1 is READ-ONLY. A write would be a second kind of route that parks behind a
//! confirm card; nothing here can express one yet, deliberately. [`native`] is the other
//! runtime in this crate (#1088): the flat tool surface the fine-tuning loop trains, which does
//! write, through typed vault commands and never SQL.

pub mod attach;
pub mod call;
pub mod cli;
pub mod eval;
pub mod grammar;
pub mod host;
pub mod model;
pub mod native;
pub mod native_turn;
pub mod prompt;
pub mod result;
pub mod suggest;
pub mod testing;
pub mod tool;
pub mod turn;

pub use attach::{Attachments, ImageData, Notice, TextDoc};
pub use call::{Route, ToolCall};
pub use host::{ModelHost, ModelLoader, ModelState, ModelStatus, VisionState, VisionStatus};
pub use model::{Cancel, Model};
pub use result::{Card, ToolOutput};
pub use tool::{App, TOOLS, ToolSet};
pub use turn::{Answered, Event, Plane, ReadContext, ReadError, Reader, Reading, Refusal, Session};
