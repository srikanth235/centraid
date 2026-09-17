#![forbid(unsafe_code)]
//! The byte plane (#1020 wave 3 lane B).
//!
//! Rows live in the vault file; **bytes live here**. The split is not
//! tidiness — the two have opposite shapes. A row is small, ordered and must
//! land whole; a photograph is large, unordered and can land in pieces.
//!
//! | Module | What it holds |
//! | --- | --- |
//! | [`door`] | [`door::ContentBytes`] — this store wearing the vault's byte door, so a device has ONE content store |
//! | [`hash`] | [`hash::ContentHash`], the `blob:blake3-<hex>` URI, and why the hash function changed |
//! | [`store`] | [`store::ByteStore`] — what this device holds, and [`store::Holding`], which has three states |
//! | [`plan`] | WHICH blobs a window asks for, and in what order — pure, no I/O |
//!
//! ## Bytes never conflict
//!
//! This is what makes the plane simple enough to be reliable. Content-addressed
//! bytes are immutable by construction: two devices that both hold
//! `blob:blake3-8f3a…` hold the identical file, and no merge, no vector clock
//! and no last-writer-wins is needed or possible. Every hard question in sync —
//! ordering, conflict, causality — lives on the log plane, where the rows are.
//! Here there is exactly one question: *do I have these bytes yet, and if not,
//! which parts are missing.*
//!
//! ## Where the decisions are split
//!
//! [`plan`] decides WHICH blobs and in what order, from a list of wants and a
//! window budget. It is pure — no store, no socket, no SQL — because scheduling
//! is the part most likely to change as real phones report back, and a pure
//! function is the part that can be changed without a device in the room.
//!
//! What it does NOT do is find the wants. That needs the vault's own rows, and
//! SQL is confined to `crates/{ontology,vault,search}` and `crates/apps/kit`,
//! so the query lives there and hands its answer here.
//!
//! ## No socket at all (#1029 §3, §6)
//!
//! The transfer lane is gone with the iroh transport: `serve_stream` and
//! `fetch` moved bytes between a gateway and a seat over a QUIC connection,
//! and there is no second host to move them to. What is left is the STORE —
//! `iroh-blobs`' filesystem store, which opens no socket — and the planner
//! over it. The `no-listening-socket` rule holds here with no feature flag,
//! and there is nothing left for it to find.

pub mod door;
pub mod hash;
pub mod plan;
pub mod store;

pub use door::ContentBytes;
pub use hash::{BLOB_URI_PREFIX, ContentHash, HashError};
pub use plan::{Budget, OriginalsRule, Plan, Tier, Want, plan};
pub use store::{ByteStore, Holding, StoreError, Sweep};
