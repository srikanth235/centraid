#![forbid(unsafe_code)]
//! EVERY RULE A GATEWAY ENFORCES, WRITTEN ONCE (#1029 §3).
//!
//! The gateway is a **protocol**, and the server a member runs on their own
//! laptop is a deployment of it, not the definition of it: *the protocol and
//! its conformance suite are the reference*. This crate is the protocol's
//! rules and [`conformance`] is the suite. A second, hosted deployment was the
//! other half of this shape until the scope amendment of 2026-09-21 struck it;
//! the separation stands because an adapter
//! that reimplements one of these rules is an adapter that drifts from the
//! suite, on a phone somebody is restoring.
//!
//! # THE GATEWAY IS BLIND
//!
//! It never receives plaintext, a plaintext hash, or a key. Read the fields of
//! [`store::StoredObject`] and [`store::VaultState`] and ask what they could
//! tell somebody who stole them: identity keys, generation ids, txid ranges,
//! object kinds, **padded** sizes and timing. Nothing else, because a field is
//! the only way anything else could arrive.
//!
//! **This is the invariant to check a new rule against.** If a rule needs
//! plaintext, a plaintext hash or a key, the rule is wrong — not the design of
//! the store. The shrink guard is the worked example: it started as a
//! comparison of *sealed row censuses*, which a blind store cannot read, and
//! became padded base size plus a server-side delete rate limit (F4). The
//! row-census warning moved to the phone, where the census is readable.
//!
//! [`conformance`]'s own canary case is what keeps this from being a comment:
//! it plants a plaintext, puts a ciphertext derived from it through the whole
//! object path, and reads back **every stored byte and the adapter's whole
//! state dump** looking for the plaintext or its BLAKE3, raw and in hex. It
//! runs against every adapter, because the suite does; `gateway-server`'s
//! `tests/canary.rs` opens a wider window still, onto the raw SQLite file and
//! the log.
//!
//! # A PURE STATE MACHINE BY CONSTRUCTION
//!
//! These rules take their world as arguments. So:
//!
//! - **no threads, no filesystem, no sockets** — there is no `std::thread`,
//!   `std::fs`, `std::net` or `std::process` in this crate;
//! - **no ambient clock** — [`ServerTime`] is an *input* to every rule that
//!   needs one. A rule that read a clock would be a rule no test can pin and
//!   no adapter can replay;
//! - **no ambient randomness** — anything random (an entry id, a capability id)
//!   is passed in by the adapter, which has the platform's generator.
//!
//! `tests/pure_rules.rs` scans the source for exactly those reaches. The list
//! was first drawn by the struck hosted adapter's `wasm32` build, where
//! `SystemTime::now()` compiles and then panics (scope amendment 2026-09-21);
//! the property is kept on its own merits.
//!
//! # The shape
//!
//! | Module | What it rules on |
//! |---|---|
//! | [`version`] | the protocol range, both directions |
//! | [`auth`] | the signed preimage, the replay window, and the skew answer |
//! | [`lease`] | epochs, and `VAULT_MOVED` as a tombstone |
//! | [`upload`] | refusing to presign a committed name; the 16 MiB cap |
//! | [`checksum`] | attest and read-and-hash, the two modes |
//! | [`commit`] | the manifest head moves only by compare-and-set |
//! | [`retention`] | the floor over bases, the grace period, the size guard, the rate limit |
//! | [`plan`] | the quota a vault's account is held to |
//! | [`scrub`] | blind re-hashing |
//! | [`store`] | the two ports, and the one SQL schema both adapters apply |
//! | [`engine`] | the orchestration that calls the rules in order |
//! | [`memory`] | an in-memory adapter, so the suite has something to run against |
//! | [`conformance`] | the suite both adapters must pass |

pub mod auth;
pub mod checksum;
pub mod commit;
pub mod conformance;
pub mod engine;
pub mod error;
pub mod ids;
pub mod lease;
pub mod memory;
pub mod plan;
pub mod retention;
pub mod scrub;
pub mod store;
pub mod time;
pub mod upload;
pub mod version;

pub use checksum::{AttestedChecksum, ChecksumEvidence, ChecksumMode};
pub use engine::Gateway;
pub use error::Refusal;
pub use ids::{AccountId, DeviceId, Generation, ObjectKind, ObjectName, VaultId};
pub use store::{ByteStore, StateStore, StoredObject, VaultState};
pub use time::{Duration, ServerTime};

/// The protocol versions this build of the rules speaks, inclusive.
///
/// Until the first release "v0, no legacy" holds and the protocol changes
/// freely, which is why both ends are 1. From the first release the hosted
/// adapter supports at least the last two phone releases and this widens;
/// self-hosters upgrade late, so the range is a real constraint and not a
/// formality.
pub const PROTOCOL_MIN: u32 = 1;

/// See [`PROTOCOL_MIN`].
pub const PROTOCOL_MAX: u32 = 1;

/// The one SQL schema both adapters apply (#1029 §3).
///
/// It is `contracts/gateway/schema.sql` and not a string in this file, for
/// three reasons that all point the same way: it is a contract between two
/// adapters rather than one crate's private detail, which is what `contracts/`
/// is for; this crate is a pure state machine and holds no SQL of its own; and
/// `cargo xtask rules`' sql-confinement scans Rust string literals, so keeping
/// the DDL out of one is what let this crate land without an allowlist edit.
pub const SCHEMA_SQL: &str = include_str!("../../../contracts/gateway/schema.sql");
