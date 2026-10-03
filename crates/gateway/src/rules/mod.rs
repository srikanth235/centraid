//! THE PROTOCOL, AS RULES WITH NO I/O (#1080).
//!
//! Every decision a gateway makes is here, written once, and reached by the
//! server through [`engine::Gateway`]. The server decides only how bytes and
//! requests arrive; if a route grows an `if` about what is allowed, that `if`
//! belongs here.
//!
//! # THE GATEWAY IS BLIND
//!
//! It holds ciphertext under keyed names, the BLAKE3 of each ciphertext,
//! sizes, its own receipt times, epochs, device labels and the BLAKE3 of its
//! credentials. Read [`state`]'s records and ask what they could tell
//! somebody who stole them: nothing else, because a field is the only way
//! anything else could arrive. A rule that needs a plaintext, a plaintext
//! hash or a key is a wrong rule, and [`conformance`]'s canary plants all
//! three and scans every byte a gateway keeps for them.
//!
//! # A PURE STATE MACHINE BY CONSTRUCTION
//!
//! No thread, no file, no socket, no ambient clock, no ambient randomness:
//! `now_ms` and fresh tokens are arguments, the adapter's to supply. The
//! dependency list is part of the rule — `--no-default-features` builds this
//! module alone — and `tests/pure_rules.rs` scans it for every reach.
//!
//! | Module | What it rules on |
//! | --- | --- |
//! | [`ids`] | names, digests, ids, credentials: one spelling each |
//! | [`limits`] | every number both ends share |
//! | [`code`] | the closed refusal codes and the one refusal body |
//! | [`wire`] | every request and answer body |
//! | [`claim`] | the signed claim preimage, and the read grant |
//! | [`payload`] | the pairing QR's text |
//! | [`bundle`] | the many-objects framing, both ways |
//! | [`range`] | one `Range` per `GET` |
//! | [`state`] | the port, and the records a gateway keeps |
//! | [`engine`] | each route's decision, in order |
//! | [`memory`] | the rules over memory, as the suite's reference target |
//! | [`conformance`] | the suite every gateway must pass |

pub mod bundle;
pub mod claim;
pub mod code;
pub mod conformance;
pub mod engine;
pub mod ids;
pub mod limits;
pub mod memory;
pub mod payload;
pub mod range;
pub mod state;
pub mod wire;

pub use code::{Code, Refusal, RefusalBody};
pub use engine::Gateway;
pub use ids::{Digest, GatewayId, Name, Pin, Secret, Signature, Token, VaultId};
