#![forbid(unsafe_code)]
//! The iroh endpoint (#1020 wave 2 lane C).
//!
//! This crate is where iroh lives and nowhere else: `crates/protocol` is
//! written over a transport trait so that lane D2's `turmoil` simulation can be
//! the primary sync proof (D-1020-C1), and this crate is that trait's
//! production implementation.
//!
//! | Module | What it holds |
//! | --- | --- |
//! | [`endpoint`] | the iroh endpoint, ALPN routing, relay modes, the bounded dial, `idle`/`resume` |
//! | [`allowlist`] | [`allowlist::AllowlistStore`] and the in-memory implementation |
//! | [`ticket`] | the pair ticket, `base64url`, and its terminal QR |
//! | [`pairing`] | mint and redeem, both halves |
//! | [`error`] | the typed connect failures and the events they become |
//!
//! **No listening TCP socket.** iroh is QUIC over UDP, and the only listener
//! this product may ever have is the wave 3 blob door, off by default until the
//! iPhone measurement rules on it (#1020 open question 3). The xtask
//! `no-listening-socket` rule scans this crate for `TcpListener::bind` on every
//! gate run, and `crates/centraid`'s test asserts the running process owns no
//! LISTEN socket.
//!
//! **Where the durable allowlist is.** Not here: see [`allowlist`]'s module
//! documentation for D-1020-C8 and why SQL confinement moved the design rather
//! than the rule.

pub mod allowlist;
pub mod endpoint;
pub mod error;
pub mod pairing;
pub mod ticket;

pub use allowlist::{AllowlistStore, Device, MemoryAllowlist, RedeemRefusal, Ticket};
pub use endpoint::{
    Accepted, CONNECT_TIMEOUT, Endpoint, EndpointConfig, IrohConnection, RelayMode,
};
pub use error::ConnectError;
