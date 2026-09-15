//! The four visible states, folded in one place (#1020, D-1020-F4).
//!
//! v0 broadcasts **connectivity only**, from a 5 s health poll in main
//! (`apps/desktop/src/main/gateway-monitor.ts:45`, census §F seam 10). Two of
//! the four states #1020 requires have no v0 broadcast to extend at all:
//! *durability* ("is what I wrote safe") and *pending work* ("how far behind am
//! I"). Both are facts the core already knows — the outbox depth, the log
//! watermark, the bounded event queue's stall flag — so they come from the
//! core's own events and **not** from a second poll. A poll would be a third
//! source of truth for something the writer already told us.
//!
//! The fold is pure so the transitions are tested as transitions. What the
//! renderer must never receive is a state that never existed: availability and
//! durability are read together (a shell with availability and no durability
//! draws a different screen from one with both), which is why they cross as
//! one message.

use super::local::{Availability, Connectivity, Durability, PendingWork, SeatMode, SeatStateJson};

/// What the seat knows right now, before it is turned into a screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Facts {
    pub mode: SeatMode,
    /// Whether a gateway has been chosen at all. First run: `false`.
    pub gateway_configured: bool,
    /// Whether the gateway answered the last thing asked of it.
    pub gateway_reachable: bool,
    /// Whether this seat has a local file it can read rows out of.
    pub local_rows: bool,
    /// Intents committed here that the gateway has not settled.
    pub outbox: u32,
    /// Log entries behind the gateway's watermark, when known.
    pub behind: u64,
    /// The core's bounded event queue has filled and sync has stalled.
    pub stalled: bool,
}

/// Fold the facts into the four states.
#[must_use]
pub fn fold(facts: Facts, at_ms: u64) -> SeatStateJson {
    let connectivity = if !facts.gateway_configured {
        // NOT "offline". The member has not chosen a gateway; "offline" would
        // send them looking for a network problem they do not have.
        Connectivity::Unconfigured
    } else if facts.gateway_reachable {
        Connectivity::Online
    } else {
        Connectivity::Offline
    };

    let availability = match facts.mode {
        // A replicated seat reads its own file whatever the network is doing.
        // That is the whole reason it exists, so it is `Local` even offline —
        // unless the file is not there yet.
        SeatMode::Replicated if facts.local_rows => Availability::Local,
        SeatMode::Replicated => Availability::Unavailable,
        // A THIN SEAT WITH NO GATEWAY IS `Unavailable`, and the shell draws
        // "nothing to show" — never an empty list. An empty list is a claim
        // that the vault is empty, and a thin seat that cannot reach its
        // gateway knows nothing about what the vault holds.
        SeatMode::Thin if facts.gateway_reachable => Availability::Forwarded,
        SeatMode::Thin => Availability::Unavailable,
    };

    let durability = match facts.mode {
        // A thin seat commits nothing locally, so "local only" is not a state
        // it can be in: either the gateway took the write or the write did not
        // happen.
        SeatMode::Thin => Durability::None,
        SeatMode::Replicated if facts.outbox == 0 && facts.gateway_reachable => Durability::Settled,
        SeatMode::Replicated => Durability::LocalOnly,
    };

    SeatStateJson {
        availability,
        durability,
        pending_work: PendingWork {
            outbox: facts.outbox,
            behind: facts.behind,
            stalled: facts.stalled,
        },
        connectivity,
        mode: facts.mode,
        at_ms,
    }
}

impl Facts {
    /// The state a seat is in before it has reached anything: first run.
    #[must_use]
    pub const fn at_rest(mode: SeatMode) -> Self {
        Self {
            mode,
            gateway_configured: false,
            gateway_reachable: false,
            local_rows: false,
            outbox: 0,
            behind: 0,
            stalled: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn replicated() -> Facts {
        Facts {
            mode: SeatMode::Replicated,
            gateway_configured: true,
            gateway_reachable: true,
            local_rows: true,
            outbox: 0,
            behind: 0,
            stalled: false,
        }
    }

    #[test]
    fn a_settled_replicated_seat_is_local_settled_quiet_and_online() {
        let state = fold(replicated(), 7);
        assert_eq!(state.availability, Availability::Local);
        assert_eq!(state.durability, Durability::Settled);
        assert_eq!(state.connectivity, Connectivity::Online);
        assert_eq!(state.pending_work.outbox, 0);
        assert_eq!(state.at_ms, 7);
    }

    /// The transition that matters most: the network goes away and the seat
    /// keeps *reading*, while what was written stops being settled.
    #[test]
    fn a_replicated_seat_that_loses_its_gateway_still_reads_and_stops_being_settled() {
        let offline = fold(
            Facts {
                gateway_reachable: false,
                ..replicated()
            },
            1,
        );
        assert_eq!(offline.availability, Availability::Local);
        assert_eq!(offline.durability, Durability::LocalOnly);
        assert_eq!(offline.connectivity, Connectivity::Offline);
    }

    #[test]
    fn an_outbox_that_is_not_empty_is_not_settled_even_online() {
        let state = fold(
            Facts {
                outbox: 3,
                ..replicated()
            },
            1,
        );
        assert_eq!(state.durability, Durability::LocalOnly);
        assert_eq!(state.pending_work.outbox, 3);
    }

    /// THE THREE-STATE READ LAW. A thin seat that has lost its gateway has
    /// nothing to show, and "nothing to show" is not "the vault is empty".
    #[test]
    fn a_thin_seat_without_a_gateway_is_unavailable_and_never_an_empty_list() {
        let state = fold(
            Facts {
                mode: SeatMode::Thin,
                gateway_configured: true,
                gateway_reachable: false,
                local_rows: false,
                outbox: 0,
                behind: 0,
                stalled: false,
            },
            1,
        );
        assert_eq!(state.availability, Availability::Unavailable);
        assert_eq!(state.durability, Durability::None);
        assert_eq!(state.connectivity, Connectivity::Offline);
    }

    #[test]
    fn a_thin_seat_with_a_gateway_forwards() {
        let state = fold(
            Facts {
                mode: SeatMode::Thin,
                gateway_configured: true,
                gateway_reachable: true,
                local_rows: false,
                outbox: 0,
                behind: 0,
                stalled: false,
            },
            1,
        );
        assert_eq!(state.availability, Availability::Forwarded);
        assert_eq!(state.durability, Durability::None);
    }

    /// First run: no gateway chosen. `Unconfigured`, not `Offline`.
    #[test]
    fn first_run_is_unconfigured_in_both_modes() {
        for mode in [SeatMode::Replicated, SeatMode::Thin] {
            let state = fold(Facts::at_rest(mode), 0);
            assert_eq!(state.connectivity, Connectivity::Unconfigured, "{mode:?}");
            assert_eq!(state.availability, Availability::Unavailable, "{mode:?}");
        }
    }

    /// A replicated seat whose file is not there yet reads as unavailable, not
    /// as an empty vault — the same law as the thin case, for the same reason.
    #[test]
    fn a_replicated_seat_with_no_file_yet_is_unavailable() {
        let state = fold(
            Facts {
                local_rows: false,
                ..replicated()
            },
            1,
        );
        assert_eq!(state.availability, Availability::Unavailable);
    }

    #[test]
    fn a_stall_and_a_backlog_travel_in_pending_work_rather_than_in_availability() {
        let state = fold(
            Facts {
                stalled: true,
                behind: 4_096,
                outbox: 2,
                ..replicated()
            },
            1,
        );
        // Still readable: a stalled event queue means the screen may be behind,
        // not that the rows are gone.
        assert_eq!(state.availability, Availability::Local);
        assert!(state.pending_work.stalled);
        assert_eq!(state.pending_work.behind, 4_096);
    }
}
