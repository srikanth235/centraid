//! The deterministic simulation: one gateway, N seats, a scripted network.
//!
//! **This is #1020's primary sync proof** (wave 2 lane D2, D-1020-D2-4). Not a
//! mock: each seat runs the real [`centraid_seat`] applier, the real outbox and
//! the real [`centraid_seat::sync`] driver against a real on-disk SQLite file,
//! and the gateway runs the real [`centraid_vault`] with its real doors. What
//! is simulated is the *network* and the *clock*, which is what makes a
//! thousand schedules reproducible from a seed.
//!
//! ## Why UDP and not TCP (D-1020-D2-11)
//!
//! Turmoil offers both. The simulation uses **UDP**, for two reasons in this
//! order:
//!
//! 1. **It is what the product speaks.** Production is iroh, which is QUIC over
//!    UDP. A simulation over TCP would prove convergence for a transport no
//!    seat has: no head-of-line blocking, no reordering, no datagram loss —
//!    exactly the three things a sync loop must survive and exactly what TCP
//!    hides.
//! 2. **The product may not open a listening TCP socket**, and the xtask rule
//!    `no-listening-socket` says so on every gate run. A simulated TCP listener
//!    is not a real one, but a crate whose source reads `TcpListener::bind` is
//!    a crate somebody copies from. The rule stands unweakened and this crate
//!    never asks it to bend.
//!
//! The cost is that request/response framing is this crate's own: one datagram
//! per message, with the same `u32BE(len) ‖ bytes` prefix
//! [`centraid_protocol::framing`] uses, so a truncated datagram is refused for
//! the same reason a truncated stream frame is.
//!
//! ## What the invariants are
//!
//! Asserted after every `sim.run()` — see [`invariants`]:
//!
//! 1. Every seat's replicated tables equal the gateway's at the watermark,
//!    values not bytes, through D1's own CONVERGENCE comparator.
//! 2. Every seat's outbox is empty, or every remaining intent is terminal or
//!    parked with a recorded reason.
//! 3. The gateway's log is contiguous: `seq` gapless above the floor, one
//!    `commit_seq` per commit, ascending.
//! 4. Every executed intent has exactly one outcome row.
//! 5. `commit_seq` is monotonic.
//! 6. No seat ever applied a row below its `applied_seq`.
//! 7. The idempotency ledger holds one row per `(intent, hash)`.
//!
//! ## Seeds
//!
//! `cargo test -p centraid-sim` runs `SIM_SEEDS` seeds (default 25; the
//! `nightly` profile runs 250). A failing seed prints `SIM_SEED=<n>` and its
//! schedule as JSON. **`contracts/sim/failing-seeds.json` records every seed
//! that ever failed**, with the bug it found and the commit that fixed it, and
//! `tests/recorded_seeds.rs` replays each one — the issue's "a recorded failing
//! seed from wave 2 stays green".

pub mod invariants;
pub mod protocol;
pub mod schedule;
pub mod world;

pub use invariants::{Finding, check_invariants};
pub use schedule::{Fault, Schedule, Workload};
pub use world::{SimOutcome, run_schedule};

/// How many seeds a `pr`-profile run covers.
pub const DEFAULT_SEEDS: u64 = 25;
/// How many a `nightly` run covers.
pub const NIGHTLY_SEEDS: u64 = 250;

/// The seed count for this run: `SIM_SEEDS`, or [`DEFAULT_SEEDS`].
#[must_use]
pub fn seed_count() -> u64 {
    std::env::var("SIM_SEEDS")
        .ok()
        .and_then(|text| text.parse().ok())
        .unwrap_or(DEFAULT_SEEDS)
}

/// One seed to run alone: `SIM_SEED`. Set by a developer reproducing a failure.
#[must_use]
pub fn single_seed() -> Option<u64> {
    std::env::var("SIM_SEED")
        .ok()
        .and_then(|text| text.parse().ok())
}
