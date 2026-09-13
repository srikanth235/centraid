//! The assistant plane: the harness registry as data, the turn plane, the ACP
//! client, and the stdio MCP door (#1020 wave 4, lane assist).
//!
//! ## What runs where
//!
//! A harness is **an external process**. Nothing in this crate is a model, an
//! inference loop or a provider client: the gateway spawns a CLI that speaks
//! the Agent Client Protocol on its stdin and stdout, implements the protocol's
//! `Client` half, and writes what comes back into the ledger. That is the whole
//! integration, and it is one integration for all seventeen registered kinds.
//!
//! ## The four laws this crate is built around
//!
//! 1. **Nothing branches on the kind** ([`registry`], D-1020-AS1). The kinds
//!    differ only in how the process is launched, and every one of those
//!    differences is data in `contracts/assist/harnesses.json`. There is no
//!    `match kind` anywhere else, and a grep for one is the test.
//! 2. **There is no listener** ([`mcp`], D-1020-AS2). v0 served vault tools
//!    over a loopback HTTP MCP server on an ephemeral port. `centraid mcp` is
//!    the same tool surface over **stdio**, launched by the harness as its MCP
//!    child, and `no-listening-socket` stays clean over this crate.
//! 3. **Consent is a property of the posture, not of the call site**
//!    ([`turn`], D-1020-AS4). [`turn::TurnPlane::run_turn`] refuses before any
//!    process is spawned when the posture carries no consent proof. A caller
//!    cannot forget the check, because the check is not the caller's.
//! 4. **The ledger's SQL lives in `crates/vault`** ([`centraid_vault::ledger`],
//!    D-1020-AS3). This crate holds the band's *meaning* — what a turn is, when
//!    a breaker opens, what gets archived — and none of its statements.
//!
//! ## What is NOT here
//!
//! No model catalogue, no pricing table, no provider API client, no UI. A
//! permission request from a harness is answered by the posture's policy
//! (`auto-allow` or `deny`) and never by asking somebody: a gateway turn has no
//! approval UI, which is also why the `claude-code` adapter is launched in
//! `bypassPermissions` mode (`registry.ts:203`).

#![forbid(unsafe_code)]

pub mod acp;
pub mod adapters;
pub mod corpus;
pub mod health;
pub mod low_priority;
pub mod mcp;
pub mod preflight;
pub mod registry;
pub mod spawn_env;
pub mod turn;

pub use registry::{Harness, LaunchPlan, Registry};
pub use turn::{Dispatch, TurnError, TurnPlane, TurnPosture};
