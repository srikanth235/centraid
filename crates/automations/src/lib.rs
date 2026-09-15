//! `crates/automations` — the fire spine, the triggers, the enrichment gate
//! and the recognition recipes (#1020, inventory row *automations — retain*).
//!
//! The crate's whole job in one sentence: **decide what should run, and hand
//! it to somebody else to run.** It schedules (in the vault's zone), it walks
//! cursors, it refuses what a member has not consented to, and it steers a
//! delegate through exactly one injected seam. It opens no socket, spawns no
//! process, holds no SQL and reaches no harness.
//!
//! | Module | What it owns |
//! |---|---|
//! | [`manifest`] | `automation.json`: five trigger kinds, the enrich block, the sandbox declaration |
//! | [`watch`] | which entities a trigger may watch, as a structural rule |
//! | [`cron`] | civil time in the vault's zone, with v0's host-clock tier deleted |
//! | [`fire`] | the spine, the cursors, the enrichment gate, the missed-run ledger, steering |
//! | [`handler`] | provenance tiers, the target-failure caps, the `Model` trait, the recipe catalogue |
//! | [`webhook`] | the ingress door, without a listening socket |
//! | [`anchor`] | the `@[…]` grammar and the consent scopes it collapses to |
//! | [`signals`] | what a member is told when any of the above refuses |
//!
//! ## The four boundaries, and where each one is written down
//!
//! 1. **One injection point.** [`fire::Steering`] takes
//!    `&dyn centraid_assist::turn::Dispatch`. There is no other route to a
//!    harness (`fire/fire.ts:1`–`:3`).
//! 2. **No listening socket.** A webhook is inbound HTTP and the product has
//!    no listener, so a delivery arrives through a seat
//!    ([`webhook::Delivery`]) — see [`webhook`] for the ruling.
//! 3. **No SQL.** Every store is a trait ([`fire::cursor::CursorStore`],
//!    [`fire::scheduler_ledger::LedgerStore`]); the statements are
//!    `centraid_vault::ledger`'s.
//! 4. **No model client.** [`handler::Model`] is the seam and real inference is
//!    an owner hand-off per model — never a stub that reads green.

pub mod anchor;
pub mod cron;
pub mod fire;
pub mod handler;
pub mod manifest;
pub mod signals;
pub mod watch;
pub mod webhook;
