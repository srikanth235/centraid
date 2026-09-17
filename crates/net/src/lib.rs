#![forbid(unsafe_code)]
//! WHAT IS LEFT OF THE NETWORK CRATE: the pair ticket, and nothing else
//! ([#1029](https://github.com/srikanth235/centraid/issues/1029) §3, §6).
//!
//! The iroh transport is gone — the endpoint, ALPN routing, relay modes, the
//! bounded dial, the device allowlist and both halves of pairing left with it,
//! because v0 has no paired client and the phone has no inbound endpoint at
//! all.
//!
//! What remains is [`ticket`], and it remains for one reason: it is the
//! **parent of the §7 link ticket** — 15-minute lifetime, one use, secret
//! stored hashed — which W8 builds on top of it.
//!
//! **This crate is parked, not kept.** #1029's Reference A moves `ticket.rs`
//! into `crates/identity`, and W2 did not make that move: a sibling lane held
//! `crates/identity` open while this one ran. The file is left where it is with
//! its crate reduced to it, and the move is a hand-off to W8 — the wave that
//! has to read it anyway. Nothing in the workspace depends on this crate today.
//!
//! **No listening socket, and now no socket of any kind.** The
//! `no-listening-socket` rule still scans this crate and there is nothing left
//! here for it to find.

pub mod ticket;
