#![forbid(unsafe_code)]
//! THE GATEWAY PROTOCOL v2 (#1080).
//!
//! A gateway is any machine the member controls that runs `centraid-gateway2`:
//! the laptop at home, a VPS, a NAS. The phone opens a TLS connection straight
//! to it and pins the certificate the gateway minted for itself; there is no
//! certificate authority, no relay and no DNS service in between. The gateway
//! holds a complete, sealed copy of each paired vault and can neither read it
//! nor recognise a known file in it.
//!
//! # ONE CRATE, THREE MODULES, TWO FEATURES
//!
//! | Module | Feature | What it is |
//! | --- | --- | --- |
//! | [`rules`] | always | the protocol as pure functions over a [`rules::state::State`], and the conformance suite |
//! | [`client`] | `client` | the phone's HTTPS client, pinned to one certificate |
//! | [`server`] | `server` | the gateway a member runs: TLS, the SQLite state, the object directory, the sweeps, the CLI's pieces |
//!
//! The rules are the reference, not the server: the conformance suite in
//! [`rules::conformance`] runs over the in-memory state and over the real
//! server through the real client, and the two must agree case for case.

pub mod rules;

#[cfg(feature = "client")]
pub mod client;

#[cfg(feature = "server")]
pub mod server;
