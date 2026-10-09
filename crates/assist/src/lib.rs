//! The on-device chat plane.
//!
//! Centraid is visual-first, and the chat follows: an answer is one short line
//! and **result cards** — real rows (a task, a photograph, a ledger line, a
//! person) that the app's own tile draws and taps through to. The model writes
//! calls over eight flat tools; the runtime reads and composes the line; the
//! apps draw the data.
//!
//! This crate is everything about that except the engine and the vault:
//!
//! | Module | What it owns |
//! |---|---|
//! | [`native`] | The tool runtime: eight flat tools over a vault, one metadata table, the date evaluator, observations and the system prompt (`experiments/toolchat/native/SPEC.md`). |
//! | [`native_turn`] | The turn loop (#1088): the model drives [`native`] one call per message; the chat's own cards and a line composed from the effect (a decline `out_of_scope` is the canned sentence, R-1088-19). |
//! | [`app`] | The seven apps a card or a chat scope can name. Locker is not one. |
//! | [`result`] | The result card: a reference to a real row. |
//! | [`prompt`] | The Qwen ChatML pieces the attached path shares: the stored turn, the question, the token estimate and the context budget. |
//! | [`model`], [`host`] | The [`model::Model`] trait an engine implements, and the slot a loaded model lives in. |
//! | [`attach`] | A photograph or a text document riding on one question: the prompt, the truncation, the marker the history keeps. |
//! | [`turn`] | The shared vocabulary of a turn (events, answers, typed refusals), and the attached turn, which the shipped build keeps off (R-1088-19). |
//! | [`suggest`] | Three questions this vault can answer, read from the same world the runtime reads. |
//! | [`testing`] | Deterministic stand-ins for the engine. |
//!
//! # WHAT THIS CRATE DOES NOT HAVE
//!
//! No SQL, no connection of its own, no engine, and no persistence of its own: a
//! chat's session is in memory and ends with the app. What was said is saved by
//! `crates/core` through the `chat.*` commands. A stored thread reopens into a
//! fresh native session (R-1088-10); the old `tool` and `no_tool` records a
//! thread may hold still read ([`prompt::Turn::from_json`]), so no thread stops
//! opening. The vault is reached only through [`native::Door`], which
//! `crates/core` implements over the query path a screen uses; the model goes
//! through [`model::Model`], which the llama.cpp binding implements.
//!
//! A write the model makes parks behind a confirm card (R-1088-2); nothing in
//! this crate writes until the member taps it.

pub mod app;
pub mod attach;
pub mod host;
pub mod model;
pub mod native;
pub mod native_turn;
pub mod prompt;
pub mod result;
pub mod suggest;
pub mod testing;
pub mod turn;

pub use app::App;
pub use attach::{Attachments, ImageData, Notice, TextDoc};
pub use host::{ModelHost, ModelLoader, ModelState, ModelStatus, VisionState, VisionStatus};
pub use model::{Cancel, Model};
pub use result::Card;
pub use turn::{Answered, Event, Plane, Reading, Refusal, Session};
