#![forbid(unsafe_code)]
//! The wire protocol (#1020 wave 2 lane C).
//!
//! **No iroh type appears in this crate**, and that is the design rather than a
//! coincidence (D-1020-C1). Everything here is written over
//! `tokio::io::{AsyncRead, AsyncWrite}` and the two traits in [`transport`];
//! `crates/net` implements them over iroh 1.x and lane D2's `turmoil`
//! simulation implements them over turmoil's streams. #1020 makes deterministic
//! simulation the *primary* sync proof, and a protocol that named a real
//! network could not be one — which is the position v0 was in, with a transport
//! that only existed across Bun, Hermes and a browser worker.
//!
//! | Module | What it holds |
//! | --- | --- |
//! | [`alpn`] | the three v1 ALPNs, and the test that none equals a v0 one |
//! | [`framing`] | `u32BE(len) ‖ bytes`, the 256 KiB ceiling, the three refusals |
//! | [`wire`] | `Envelope`s over frames, and the frame-level relay |
//! | [`session`] | request-id multiplexing, and what `Cancel` may cancel |
//! | [`handshake`] | the exchange at request id 0 |
//! | [`version`] | `SCHEMA_VERSION`, `MIN_SUPPORTED`, `judge` |
//! | [`error`] | the typed errors and their wire codes |
//!
//! The byte-level facts are also fixtures: `contracts/protocol/framing-golden.json`
//! carries the frame bytes for named messages, and
//! `tests/framing_golden.rs` regenerates and diffs them. That is v0's
//! `packages/tunnel/fixtures/wire-golden.json` idea, kept because it is the
//! only form in which a Swift or Kotlin implementation can be held to the same
//! answer.

pub mod alpn;
pub mod error;
pub mod framing;
pub mod handshake;
pub mod session;
pub mod transport;
pub mod version;
pub mod wire;

pub use error::{ProtocolError, Result};
pub use framing::{CHUNK_BYTES, MAX_FRAME_BYTES, read_frame, write_frame};
pub use session::{RequestKind, Session};
pub use transport::{Connection, Transport};
pub use version::{MIN_SUPPORTED, SCHEMA_VERSION, WINDOW_MINORS, judge, local_hello};
