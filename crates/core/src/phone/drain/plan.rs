//! Pure pass state machine for [`super::pass_over`].
//!
//! Zero IO, zero wall clock, zero SQLite: given the pass's transfer conditions,
//! fleet reachability, and the outcomes fed back after each step, [`PassPlan`]
//! decides the exact sequence of steps to run (contact & reconcile → verify
//! read-back samples → records pass → interleaved media rounds → follow-up
//! records snapshot or deferred `snapshot_owed`).

use super::policy::{Conditions, Kind};

/// One action [`super::pass_over`] executes against the fleet and vault.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Step {
    /// Check each gateway's writer epoch / head rollback and reconcile owed names if needed.
    ContactAndReconcile,
    /// Read back a keyed random sample of the newest snapshot before writing.
    VerifySamples,
    /// Plan and move the records pass (snapshot if due, move ranges/manifest, settle head, retain).
    Records,
    /// Run bounded interleaved media rounds across every remaining live gateway.
    Media,
    /// Check whether newly confirmed media have rows not yet covered by a snapshot.
    CheckUncoveredRows,
    /// Take and move a follow-up records snapshot covering newly confirmed media rows.
    FollowupRecords,
    /// Mark `snapshot_owed = true` so the next pass covers newly confirmed media rows first.
    MarkSnapshotOwed,
    /// Pass complete.
    Done,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    Contact,
    Verify,
    Records,
    Media,
    CheckUncovered,
    Followup { run_now: bool },
    Done,
}

/// Pure pass planner driving [`super::pass_over`].
#[derive(Debug, Clone)]
pub(super) struct PassPlan {
    phase: Phase,
    conditions: Conditions,
    fleet_count: usize,
    live_count: usize,
    everyone_reached: bool,
    owes_reconcile: bool,
    all_media_finished: bool,
    media_confirmed: usize,
}

impl PassPlan {
    pub(super) const fn new(
        conditions: Conditions,
        fleet_count: usize,
        everyone_reached: bool,
        owes_reconcile: bool,
    ) -> Self {
        Self {
            phase: Phase::Contact,
            conditions,
            fleet_count,
            live_count: fleet_count,
            everyone_reached,
            owes_reconcile,
            all_media_finished: true,
            media_confirmed: 0,
        }
    }

    /// The next step the driver should execute.
    pub(super) fn next_step(&self) -> Step {
        match self.phase {
            Phase::Contact => Step::ContactAndReconcile,
            Phase::Verify => Step::VerifySamples,
            Phase::Records => Step::Records,
            Phase::Media => Step::Media,
            Phase::CheckUncovered => Step::CheckUncoveredRows,
            Phase::Followup { run_now: true } => Step::FollowupRecords,
            Phase::Followup { run_now: false } => Step::MarkSnapshotOwed,
            Phase::Done => Step::Done,
        }
    }

    /// Record the outcome of [`Step::ContactAndReconcile`]. Returns `true` when
    /// the handle may mark its once-per-core full reconciliation complete.
    pub(super) fn on_contact(&mut self, live_count: usize, squared_all: bool) -> bool {
        self.live_count = live_count;
        self.phase = Phase::Verify;
        self.owes_reconcile
            && self.everyone_reached
            && squared_all
            && live_count == self.fleet_count
    }

    /// Record the outcome of [`Step::VerifySamples`].
    pub(super) fn on_verify(&mut self, live_count: usize) {
        self.live_count = live_count;
        if self.conditions.may_move(Kind::Records) && self.live_count > 0 {
            self.phase = Phase::Records;
        } else {
            self.phase = Phase::Media;
        }
    }

    /// Record the outcome of [`Step::Records`]. When records stopped the pass
    /// early (e.g. deadline), media is skipped and the pass ends.
    pub(super) fn on_records(&mut self, live_count: usize, stopped_early: bool) {
        self.live_count = live_count;
        self.phase = if stopped_early {
            Phase::Done
        } else {
            Phase::Media
        };
    }

    /// Record the outcome of [`Step::Media`].
    pub(super) fn on_media(
        &mut self,
        live_count: usize,
        all_feeds_finished: bool,
        media_confirmed: usize,
    ) {
        self.live_count = live_count;
        self.all_media_finished = all_feeds_finished && live_count == self.fleet_count;
        self.media_confirmed = media_confirmed;
        if self.media_confirmed > 0 && self.conditions.may_move(Kind::Records) {
            self.phase = Phase::CheckUncovered;
        } else {
            self.phase = Phase::Done;
        }
    }

    /// Record whether [`Step::CheckUncoveredRows`] found media rows not yet in a snapshot.
    pub(super) fn on_uncovered_check(&mut self, uncovered: bool) {
        self.phase = if uncovered {
            Phase::Followup {
                run_now: self.all_media_finished,
            }
        } else {
            Phase::Done
        };
    }

    /// Record completion of [`Step::FollowupRecords`] or [`Step::MarkSnapshotOwed`].
    pub(super) fn on_followup_done(&mut self) {
        self.phase = Phase::Done;
    }
}

/// Pure decision for whether a gateway's head went backwards relative to the
/// phone's last recorded generation (#1188, B4).
#[must_use]
pub(super) const fn head_rolled_back(
    recorded_head: bool,
    recorded_generation: u64,
    remote_generation: Option<u64>,
) -> bool {
    match (recorded_head, remote_generation) {
        (true, None) => true,
        (true, Some(generation)) => generation < recorded_generation,
        (false, _) => false,
    }
}

/// Pure decision for the records phase once the driver knows whether every live
/// gateway already holds the current snapshot (`newest_stands`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct RecordsDecision {
    pub(super) take_snapshot: bool,
    pub(super) acked_at_ms: Option<i64>,
    pub(super) clear_owed: bool,
}

#[must_use]
pub(super) fn decide_records(
    newest_stands_acked: Option<u64>,
    snapshot_owed: bool,
    any_gateway_due: bool,
) -> RecordsDecision {
    if let Some(acked) = newest_stands_acked {
        RecordsDecision {
            take_snapshot: false,
            acked_at_ms: if snapshot_owed {
                i64::try_from(acked).ok()
            } else {
                None
            },
            clear_owed: true,
        }
    } else {
        RecordsDecision {
            take_snapshot: any_gateway_due,
            acked_at_ms: None,
            clear_owed: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use centraid_api_proto::core_v1 as wire;

    use super::*;

    fn wifi_conditions() -> Conditions {
        Conditions {
            rule: wire::TransferRule::WifiOnly,
            exclude_videos: false,
            metered: false,
            charging: true,
            asked: false,
            snapshot: false,
        }
    }

    fn metered_wifi_only() -> Conditions {
        Conditions {
            metered: true,
            ..wifi_conditions()
        }
    }

    #[test]
    fn normal_pass_walks_contact_verify_records_media_and_followup_snapshot() {
        let mut plan = PassPlan::new(wifi_conditions(), 2, true, true);
        assert_eq!(plan.next_step(), Step::ContactAndReconcile);
        assert!(plan.on_contact(2, true));

        assert_eq!(plan.next_step(), Step::VerifySamples);
        plan.on_verify(2);

        assert_eq!(plan.next_step(), Step::Records);
        plan.on_records(2, false);

        assert_eq!(plan.next_step(), Step::Media);
        plan.on_media(2, true, 3);

        assert_eq!(plan.next_step(), Step::CheckUncoveredRows);
        plan.on_uncovered_check(true);

        assert_eq!(plan.next_step(), Step::FollowupRecords);
        plan.on_followup_done();
        assert_eq!(plan.next_step(), Step::Done);
    }

    #[test]
    fn cut_off_media_defers_followup_snapshot_via_mark_snapshot_owed() {
        let mut plan = PassPlan::new(wifi_conditions(), 2, true, false);
        plan.on_contact(2, true);
        plan.on_verify(2);
        plan.on_records(2, false);
        // One gateway dropped during media -> not all_finished, so defer snapshot.
        plan.on_media(1, false, 1);

        assert_eq!(plan.next_step(), Step::CheckUncoveredRows);
        plan.on_uncovered_check(true);
        assert_eq!(plan.next_step(), Step::MarkSnapshotOwed);
        plan.on_followup_done();
        assert_eq!(plan.next_step(), Step::Done);
    }

    #[test]
    fn records_stopping_early_skips_media_and_ends_pass() {
        let mut plan = PassPlan::new(wifi_conditions(), 1, true, false);
        plan.on_contact(1, true);
        plan.on_verify(1);
        plan.on_records(1, true);
        assert_eq!(plan.next_step(), Step::Done);
    }

    #[test]
    fn metered_wifi_only_skips_records_and_followup_even_when_media_confirms() {
        let mut plan = PassPlan::new(metered_wifi_only(), 1, true, false);
        plan.on_contact(1, true);
        plan.on_verify(1);
        // Records skipped because metered + WifiOnly cannot move records.
        assert_eq!(plan.next_step(), Step::Media);
        plan.on_media(1, true, 5);
        // Follow-up also skipped for the same reason.
        assert_eq!(plan.next_step(), Step::Done);
    }

    #[test]
    fn full_reconcile_requires_everyone_reached_squared_and_all_live() {
        let mut p1 = PassPlan::new(wifi_conditions(), 2, false, true);
        assert!(!p1.on_contact(2, true));

        let mut p2 = PassPlan::new(wifi_conditions(), 2, true, true);
        assert!(!p2.on_contact(2, false));

        let mut p3 = PassPlan::new(wifi_conditions(), 2, true, true);
        assert!(!p3.on_contact(1, true));

        let mut p4 = PassPlan::new(wifi_conditions(), 2, true, false);
        assert!(!p4.on_contact(2, true));
    }

    #[test]
    fn rollback_and_records_decisions_cover_all_edges() {
        assert!(!head_rolled_back(false, 0, None));
        assert!(!head_rolled_back(false, 5, Some(1)));
        assert!(head_rolled_back(true, 5, None));
        assert!(head_rolled_back(true, 5, Some(4)));
        assert!(!head_rolled_back(true, 5, Some(5)));
        assert!(!head_rolled_back(true, 5, Some(6)));

        assert_eq!(
            decide_records(Some(1_234), true, true),
            RecordsDecision {
                take_snapshot: false,
                acked_at_ms: Some(1_234),
                clear_owed: true,
            }
        );
        assert_eq!(
            decide_records(Some(1_234), false, true),
            RecordsDecision {
                take_snapshot: false,
                acked_at_ms: None,
                clear_owed: true,
            }
        );
        assert_eq!(
            decide_records(None, false, true),
            RecordsDecision {
                take_snapshot: true,
                acked_at_ms: None,
                clear_owed: false,
            }
        );
        assert_eq!(
            decide_records(None, false, false),
            RecordsDecision {
                take_snapshot: false,
                acked_at_ms: None,
                clear_owed: false,
            }
        );
    }
}
