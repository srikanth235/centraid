#![forbid(unsafe_code)]
//! WHAT IS LEFT OF THE WIRE PROTOCOL: the call session and the version window
//! ([#1029](https://github.com/srikanth235/centraid/issues/1029) §3, §6).
//!
//! This crate was the stream protocol a seat spoke to a gateway: one ALPN,
//! `u32BE(len) ‖ bytes` framing with a 256 KiB ceiling, `Envelope`s over
//! frames, and a handshake at request id 0. v0 has no iroh transport and no
//! second host, so there is no stream to frame and no peer to hand-shake with.
//!
//! | Module | What it holds |
//! | --- | --- |
//! | [`session`] | request-id multiplexing, and what `Cancel` may cancel |
//! | [`version`] | `SCHEMA_VERSION`, `MIN_SUPPORTED`, `judge` |
//! | [`error`] | the typed errors and their wire codes |
//!
//! **Both survivors are read by `crates/core`'s CALL DOOR, not by a network.**
//! [`session::Session`] is what mints a request id, decides whether a `Cancel`
//! may cancel it, and settles it — over the C ABI, where the "peer" is the
//! shell in the same process. [`version::judge`] is what a shell's `Hello` is
//! answered against, and a shell linking a prebuilt core is exactly the
//! version-skew case it was written for.
//!
//! `alpn`, `framing`, `wire`, `handshake` and `transport` are deleted with the
//! transport, and `contracts/protocol/framing-golden.json` with them: the
//! byte-level fixture existed so a Swift and a Kotlin implementation of the
//! FRAMING could be held to one answer, and neither has a frame to build.

pub mod error;
pub mod session;
pub mod version;

pub use error::{ProtocolError, Result};
pub use session::{RequestKind, Session};
pub use version::{MIN_SUPPORTED, SCHEMA_VERSION, WINDOW_MINORS, judge, local_hello};
