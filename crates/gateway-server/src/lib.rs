#![forbid(unsafe_code)]
//! THE GATEWAY: ONE BINARY ANYONE CAN RUN (#1029 §3).
//!
//! One protocol, and in v0 one deployment of it — a server a member runs on
//! their own machine (scope amendment 2026-09-21 struck the hosted sibling).
//! The rules are still not this crate's to implement: every rule a gateway
//! enforces lives
//! in [`centraid_gateway_core`], and what is here is a socket, a SQLite file,
//! two object stores, a certificate and a service unit.
//!
//! # NO RULE IS REIMPLEMENTED HERE, AND THAT IS CHECKABLE
//!
//! The checksum comparison in both modes, the refusal to presign a committed
//! name, the manifest compare-and-set, delayed deletes, the retention floor,
//! the size guard, the delete rate limit, blind scrubbing and
//! capability scope are all in `gateway-core` and are reached through
//! [`centraid_gateway_core::Gateway`]. If the conformance suite checks a
//! behaviour this crate would have to add, the fix goes **into `gateway-core`**:
//! two adapters that each carry half a rule are two adapters that will disagree
//! about it, on a phone somebody is restoring.
//!
//! `tests/no_rules_here.rs` is the scan that keeps that from being a comment,
//! and `tests/conformance.rs` runs `gateway-core`'s own suite against this
//! adapter in all four store-and-mode combinations.
//!
//! # THE GATEWAY IS BLIND
//!
//! It never receives plaintext, a plaintext hash or a key, and there is nowhere
//! for one to arrive: the state file's columns are
//! `contracts/gateway/schema.sql`'s and the object store holds ciphertext under
//! the BLAKE3 of itself. `tests/canary.rs` plants a plaintext, puts a derived
//! ciphertext through the whole path, and then reads the SQLite file **and its
//! raw bytes** and every stored object looking for either the plaintext or its
//! hash.
//!
//! # WHAT IS THIS DEPLOYMENT'S AND NOT THE PROTOCOL'S
//!
//! Three things, and they are the three the protocol names as the adapter's:
//!
//! | This crate's | Why it is not a rule |
//! |---|---|
//! | [`bytes`] — a directory or an S3-compatible bucket, with an optional mirror | `ByteStore` is a port; where bytes live is the adapter's |
//! | [`tenancy`] — admission by invite, owner-managed (Q13) | the hosted adapter admits by purchase; both end in the same `VaultState` |
//! | [`service`], [`acme`] — a systemd unit, a launchd agent, a certificate | a Worker has none of these |
//!
//! # THE SHAPE
//!
//! | Module | What it holds |
//! |---|---|
//! | [`clock`] | the one reach for the wall clock, which rules take as an input |
//! | [`sql`] | every statement, by `include_str!` from `contracts/gateway/` |
//! | [`state`] | `StateStore` over SQLite; the compare-and-set under `BEGIN IMMEDIATE` |
//! | [`bytes`] | `ByteStore` over a directory, and the mirror beside it |
//! | [`tenancy`] | invites, quotas and the household owner's admin path |
//! | [`http`] | axum over the rules, and the proxy a phone `PUT`s to |
//! | [`serve`] | the listener, and the only one in this workspace |
//! | [`acme`] | a certificate, with no second daemon and no inbound port 80 |
//! | [`service`] | the systemd unit and launchd agent an install writes |
//! | [`config`] | what an operator wrote down, and the defaults if they wrote nothing |

pub mod acme;
pub mod bytes;
pub mod clock;
pub mod config;
pub mod http;
pub mod serve;
pub mod service;
pub mod sql;
pub mod state;
pub mod tenancy;

pub use config::Config;
pub use state::SqliteState;
