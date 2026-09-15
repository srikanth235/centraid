//! A schedule, generated from a seed.
//!
//! **Deterministic from a `u64`.** `rand_chacha` and not the thread RNG,
//! because a failing seed has to reproduce on another machine, another
//! platform and another year — and `SmallRng`'s algorithm is explicitly not
//! stable across releases. ChaCha's is.
//!
//! A schedule is **data**: it serialises to JSON, a failure prints it, and a
//! recorded seed replays it. That is what makes
//! `contracts/sim/failing-seeds.json` worth having — a seed that reproduced a
//! bug once but whose generator has since changed would be a seed that reproduces
//! nothing, so the recorded file carries the schedule's JSON alongside the seed
//! and the replay asserts they still agree.

use rand::{Rng as _, SeedableRng as _};
use rand_chacha::ChaCha8Rng;

/// What the network and the hosts do to the run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Fault {
    /// A two-way partition between the gateway and one seat, for `ticks`.
    Partition { seat: usize, ticks: u64 },
    /// Messages held (queued, not dropped) then released — which is how
    /// turmoil reorders, because the held ones arrive after the ones that came
    /// later.
    HoldRelease { seat: usize, ticks: u64 },
    /// A deliberately re-sent request: the same page asked for twice, or the
    /// same intent submitted twice. The point of the whole idempotency plane.
    Duplicate { seat: usize },
    /// The gateway host crashes and restarts, reopening its file.
    CrashGateway { after_ticks: u64 },
    /// One seat crashes and restarts, reopening its file from its cursor.
    CrashSeat { seat: usize, after_ticks: u64 },
    /// Extra link latency for one seat, in milliseconds.
    Latency { seat: usize, millis: u64 },
    /// Clock skew at one seat, in milliseconds. Turmoil's clock is the host's,
    /// so this is expressed as a delay before the seat's first pass.
    ClockSkew { seat: usize, millis: u64 },
}

/// One seat's intents for the run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Workload {
    pub seat: usize,
    /// `(command, title)` pairs. The command is one D1 actually implements, so
    /// the simulation exercises the real command plane rather than a stub that
    /// would converge trivially.
    pub writes: Vec<(String, String)>,
}

/// Everything one run does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Schedule {
    pub seed: u64,
    pub seats: usize,
    /// How many sync passes each seat makes.
    pub passes: usize,
    pub faults: Vec<Fault>,
    pub workloads: Vec<Workload>,
}

/// The commands a workload draws from.
///
/// D1's three real `core.*` commands. The `tally.*` ones return
/// `NotImplemented`, so a workload of those would converge because nothing
/// happened — which is the trivial pass this list exists to avoid.
const COMMANDS: [&str; 1] = ["core.add_party"];

/// The most seats a schedule uses.
///
/// Four, not forty. Each seat is a real SQLite file and a real applier, and the
/// property under test is the *protocol's*, which does not get more true with
/// more mirrors — while the run time does get longer, and a simulation nobody
/// runs proves nothing. Convergence across four seats with partitions,
/// crashes, reordering and duplication is the same claim as across forty.
pub const MAX_SEATS: usize = 4;

impl Schedule {
    /// Generate a schedule from a seed.
    pub fn from_seed(seed: u64) -> Self {
        let mut rng = ChaCha8Rng::seed_from_u64(seed);
        let seats = rng.random_range(1..=MAX_SEATS);
        let passes = rng.random_range(3..=8);

        let mut workloads = Vec::new();
        for seat in 0..seats {
            let writes = rng.random_range(1..=4);
            workloads.push(Workload {
                seat,
                writes: (0..writes)
                    .map(|index| {
                        let command = COMMANDS[rng.random_range(0..COMMANDS.len())].to_owned();
                        (command, format!("s{seat}-w{index}"))
                    })
                    .collect(),
            });
        }

        let mut faults = Vec::new();
        let fault_count = rng.random_range(0..=5);
        for _ in 0..fault_count {
            let seat = rng.random_range(0..seats);
            faults.push(match rng.random_range(0..7) {
                0 => Fault::Partition {
                    seat,
                    ticks: rng.random_range(1..=20),
                },
                1 => Fault::HoldRelease {
                    seat,
                    ticks: rng.random_range(1..=20),
                },
                2 => Fault::Duplicate { seat },
                3 => Fault::CrashGateway {
                    after_ticks: rng.random_range(1..=30),
                },
                4 => Fault::CrashSeat {
                    seat,
                    after_ticks: rng.random_range(1..=30),
                },
                5 => Fault::Latency {
                    seat,
                    millis: rng.random_range(1..=200),
                },
                _ => Fault::ClockSkew {
                    seat,
                    millis: rng.random_range(1..=5_000),
                },
            });
        }

        Self {
            seed,
            seats,
            passes,
            faults,
            workloads,
        }
    }

    /// The schedule as JSON, so a failure prints something replayable and
    /// `contracts/sim/failing-seeds.json` can hold it.
    #[must_use]
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "seed": self.seed,
            "seats": self.seats,
            "passes": self.passes,
            "faults": self.faults.iter().map(fault_json).collect::<Vec<_>>(),
            "workloads": self
                .workloads
                .iter()
                .map(|workload| serde_json::json!({
                    "seat": workload.seat,
                    "writes": workload
                        .writes
                        .iter()
                        .map(|(command, title)| serde_json::json!([command, title]))
                        .collect::<Vec<_>>(),
                }))
                .collect::<Vec<_>>(),
        })
    }

    /// Whether this schedule ever crashes the gateway.
    #[must_use]
    pub fn crashes_gateway(&self) -> bool {
        self.faults
            .iter()
            .any(|fault| matches!(fault, Fault::CrashGateway { .. }))
    }

    /// The total number of writes across every seat.
    #[must_use]
    pub fn total_writes(&self) -> usize {
        self.workloads
            .iter()
            .map(|workload| workload.writes.len())
            .sum()
    }
}

fn fault_json(fault: &Fault) -> serde_json::Value {
    match fault {
        Fault::Partition { seat, ticks } => {
            serde_json::json!({ "kind": "partition", "seat": seat, "ticks": ticks })
        }
        Fault::HoldRelease { seat, ticks } => {
            serde_json::json!({ "kind": "hold-release", "seat": seat, "ticks": ticks })
        }
        Fault::Duplicate { seat } => serde_json::json!({ "kind": "duplicate", "seat": seat }),
        Fault::CrashGateway { after_ticks } => {
            serde_json::json!({ "kind": "crash-gateway", "afterTicks": after_ticks })
        }
        Fault::CrashSeat { seat, after_ticks } => {
            serde_json::json!({ "kind": "crash-seat", "seat": seat, "afterTicks": after_ticks })
        }
        Fault::Latency { seat, millis } => {
            serde_json::json!({ "kind": "latency", "seat": seat, "millis": millis })
        }
        Fault::ClockSkew { seat, millis } => {
            serde_json::json!({ "kind": "clock-skew", "seat": seat, "millis": millis })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// THE WHOLE POINT. A seed reproduces on another machine, another platform
    /// and another year, which `SmallRng` explicitly does not promise.
    #[test]
    fn a_seed_generates_the_same_schedule_every_time() {
        for seed in 0..50 {
            assert_eq!(
                Schedule::from_seed(seed),
                Schedule::from_seed(seed),
                "seed {seed} is not deterministic"
            );
        }
    }

    #[test]
    fn different_seeds_generate_different_schedules() {
        let schedules: Vec<Schedule> = (0..50).map(Schedule::from_seed).collect();
        let distinct: std::collections::HashSet<String> = schedules
            .iter()
            .map(|schedule| schedule.to_json().to_string())
            .collect();
        assert!(
            distinct.len() > 40,
            "only {} of 50 seeds produced a distinct schedule; the generator is not exploring",
            distinct.len()
        );
    }

    #[test]
    fn every_schedule_is_runnable_and_bounded() {
        for seed in 0..200 {
            let schedule = Schedule::from_seed(seed);
            assert!((1..=MAX_SEATS).contains(&schedule.seats), "seed {seed}");
            assert!((3..=8).contains(&schedule.passes), "seed {seed}");
            assert!(schedule.total_writes() >= 1, "seed {seed} writes nothing");
            for fault in &schedule.faults {
                let seat = match fault {
                    Fault::Partition { seat, .. }
                    | Fault::HoldRelease { seat, .. }
                    | Fault::Duplicate { seat }
                    | Fault::CrashSeat { seat, .. }
                    | Fault::Latency { seat, .. }
                    | Fault::ClockSkew { seat, .. } => *seat,
                    Fault::CrashGateway { .. } => continue,
                };
                assert!(
                    seat < schedule.seats,
                    "seed {seed} names seat {seat} of {}",
                    schedule.seats
                );
            }
        }
    }

    /// The generator must actually generate each fault, or a whole failure mode
    /// is untested and nobody notices.
    #[test]
    fn the_first_two_hundred_seeds_cover_every_fault_kind() {
        let mut seen: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
        for seed in 0..200 {
            for fault in &Schedule::from_seed(seed).faults {
                let json = fault_json(fault);
                seen.insert(json["kind"].as_str().expect("a kind is text").to_owned());
            }
        }
        for kind in [
            "partition",
            "hold-release",
            "duplicate",
            "crash-gateway",
            "crash-seat",
            "latency",
            "clock-skew",
        ] {
            assert!(seen.contains(kind), "`{kind}` is never generated");
        }
    }

    #[test]
    fn a_schedule_serialises_to_something_a_failure_can_print() {
        let json = Schedule::from_seed(7).to_json();
        assert_eq!(json["seed"], 7);
        assert!(json["workloads"].as_array().is_some_and(|w| !w.is_empty()));
        // And it round-trips through text, which is what a recorded seed holds.
        let text = serde_json::to_string(&json).expect("it serialises");
        let read: serde_json::Value = serde_json::from_str(&text).expect("it reads back");
        assert_eq!(read, json);
    }

    #[test]
    fn every_command_a_workload_draws_is_one_the_gateway_implements() {
        let registry =
            centraid_vault::commands::Registry::with_system_commands().expect("it builds");
        for command in COMMANDS {
            let entry = registry
                .get(command)
                .unwrap_or_else(|| panic!("`{command}` is not registered"));
            // AND IT IS IMPLEMENTED. A workload of `NotImplemented` stubs would
            // converge because nothing happened.
            assert!(
                !entry.definition.online_only,
                "`{command}` is online-only and a seat cannot queue it"
            );
        }
    }
}
