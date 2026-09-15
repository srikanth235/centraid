//! The missed-run ledger: without it, an outage and a quiet day look alike
//! (#351, #1014 B9; #1020, D-1020-AU1).
//!
//! Cron fires only while the scheduler runs, and — for the `latest` class —
//! there is no per-occurrence backfill. So the fact that nothing happened
//! between 02:00 and 09:00 is either "the member had nothing scheduled" or
//! "the gateway was down for seven hours", and the two are indistinguishable
//! from the outside.
//!
//! Three properties:
//!
//! 1. **Entries are RECORDED, never retro-executed.** Firing seven missed
//!    hourly polls on boot is a thundering herd against a provider; the
//!    `each` backfill class is the deliberate, bounded exception and it lives
//!    in [`super::cron_cursor`], not here.
//! 2. **One entry per automation PER GAP**, not per missed minute. An
//!    every-minute automation across a seven-hour outage is one row, anchored
//!    at the EARLIEST missed minute — which is the number a member reads as
//!    "since when".
//! 3. **Read-modify-write, atomically** (#1014, B9). The whole ledger is one
//!    JSON blob under one key, so a `record_tick` and a `record_missed` that
//!    interleaved each read the same snapshot and the second write erased the
//!    first — losing the missed-run record an outage exists to leave behind,
//!    to the tick that noticed the outage. [`LedgerStore::in_transaction`] is
//!    how that is held; a store with no transaction gets the old behaviour,
//!    never worse.

use serde::{Deserialize, Serialize};

use crate::cron::{self, FireZone, MINUTE_MS, floor_minute};

/// The reserved `automation_state.automation_id` the ledger lives under.
pub const SCHEDULER_LEDGER_AUTOMATION_ID: &str = "__scheduler";
/// Its key.
pub const SCHEDULER_LEDGER_KEY: &str = "ledger";

/// Ring-buffer bound: a neglected gateway must not grow this unbounded.
pub const MAX_MISSED_ENTRIES: usize = 200;

/// Below this a gap is jitter, not an outage: three minutes.
pub const DEFAULT_GRACE_MS: i64 = 3 * MINUTE_MS;

/// Caps worst-case CPU. Past it the entry anchors to the recent window rather
/// than the true first missed minute — the count degrades, the fact does not.
const MAX_SCAN_MS: i64 = 7 * 24 * 60 * 60 * 1_000;

/// One window nobody fired.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MissedWindow {
    #[serde(rename = "automationRef")]
    pub automation_ref: String,
    /// The EARLIEST missed minute, as epoch milliseconds.
    #[serde(rename = "scheduledFor")]
    pub scheduled_for: i64,
    #[serde(rename = "recordedAt")]
    pub recorded_at: i64,
    /// One value today, and a field rather than a constant because a future
    /// reason (a paused scheduler, a refused zone) is a different sentence.
    pub reason: MissedReason,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MissedReason {
    #[serde(rename = "gateway-down")]
    GatewayDown,
}

/// What the ledger holds.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Snapshot {
    #[serde(
        rename = "lastTickAt",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub last_tick_at: Option<i64>,
    /// Present and true while no registration exists. **Cleared rather than
    /// set false** on a live tick, so "dormant" and "was dormant once" are not
    /// the same row.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dormant: Option<bool>,
    #[serde(default)]
    pub missed: Vec<MissedWindow>,
}

/// The two accessors plus the transaction. The vault's
/// `automation_state` store implements it.
pub trait LedgerStore {
    fn state_get(&self, automation_id: &str, key: &str) -> Option<String>;
    fn state_set(&self, automation_id: &str, key: &str, value_json: &str, updated_at: i64);
    /// Run a read-modify-write atomically. Optional: a store with no
    /// transaction available gets the pre-#1014 behaviour.
    fn in_transaction(&self, work: &mut dyn FnMut()) {
        work();
    }
}

/// **Never throws**: a ledger read is diagnostics, and diagnostics that can
/// fail a fire are worse than no diagnostics.
#[must_use]
pub fn parse_snapshot(json: Option<&str>) -> Snapshot {
    json.and_then(|text| serde_json::from_str(text).ok())
        .unwrap_or_default()
}

/// The ledger, over a store.
pub struct SchedulerLedger<'a, S: LedgerStore> {
    store: &'a S,
}

impl<'a, S: LedgerStore> SchedulerLedger<'a, S> {
    pub const fn new(store: &'a S) -> Self {
        Self { store }
    }

    #[must_use]
    pub fn load(&self) -> Snapshot {
        parse_snapshot(
            self.store
                .state_get(SCHEDULER_LEDGER_AUTOMATION_ID, SCHEDULER_LEDGER_KEY)
                .as_deref(),
        )
    }

    /// Every mutation is one read-modify-write, and takes this door.
    fn update(&self, at: i64, mutate: impl Fn(Snapshot) -> Snapshot) {
        let mut work = || {
            let next = mutate(self.load());
            if let Ok(json) = serde_json::to_string(&next) {
                self.store.state_set(
                    SCHEDULER_LEDGER_AUTOMATION_ID,
                    SCHEDULER_LEDGER_KEY,
                    &json,
                    at,
                );
            }
        };
        self.store.in_transaction(&mut work);
    }

    pub fn record_tick(&self, at: i64) {
        self.update(at, move |mut snapshot| {
            snapshot.dormant = None;
            snapshot.last_tick_at = Some(at);
            snapshot
        });
    }

    pub fn set_dormant(&self, dormant: bool, at: i64) {
        self.update(at, move |mut snapshot| {
            if dormant {
                snapshot.dormant = Some(true);
            } else {
                snapshot.dormant = None;
                snapshot.last_tick_at = Some(at);
            }
            snapshot
        });
    }

    pub fn record_missed(&self, entries: &[MissedWindow], at: i64) {
        if entries.is_empty() {
            return;
        }
        self.update(at, |mut snapshot| {
            snapshot.missed.extend(entries.iter().cloned());
            let overflow = snapshot.missed.len().saturating_sub(MAX_MISSED_ENTRIES);
            snapshot.missed.drain(..overflow);
            snapshot
        });
    }
}

/// One automation's cron schedules, for the missed-window scan.
#[derive(Debug, Clone)]
pub struct LedgerEntry {
    pub automation_ref: String,
    /// `(expression, resolved zone)`. A schedule whose zone did not resolve
    /// contributes nothing: it was never registered, so it missed nothing.
    pub schedules: Vec<(String, FireZone)>,
}

/// One entry per automation whose cron matches a minute strictly inside
/// `(last_tick_at, now)`.
#[must_use]
pub fn compute_missed_windows(
    last_tick_at: i64,
    now: i64,
    entries: &[LedgerEntry],
    grace_ms: i64,
) -> Vec<MissedWindow> {
    if now - last_tick_at <= grace_ms {
        return Vec::new();
    }
    let scan_start = last_tick_at.max(now - MAX_SCAN_MS);
    let now_minute = floor_minute(now);
    let mut out = Vec::new();
    for entry in entries {
        if entry.schedules.is_empty() {
            continue;
        }
        // EARLIEST-ONLY, so an often-firing automation costs no full scan.
        let mut instant = floor_minute(scan_start) + MINUTE_MS;
        while instant < now_minute {
            if entry
                .schedules
                .iter()
                .any(|(expr, zone)| cron::matches(expr, instant, zone))
            {
                out.push(MissedWindow {
                    automation_ref: entry.automation_ref.clone(),
                    scheduled_for: instant,
                    recorded_at: now,
                    reason: MissedReason::GatewayDown,
                });
                break;
            }
            instant += MINUTE_MS;
        }
    }
    out
}

/// Record a tick, and whatever it reveals was missed since the last one.
///
/// The ORDER matters: the missed windows are computed and written BEFORE the
/// tick moves `last_tick_at`, so a crash between the two leaves the gap
/// discoverable again rather than erased.
pub fn record_scheduler_tick<S: LedgerStore>(
    ledger: &SchedulerLedger<'_, S>,
    now: i64,
    entries: &[LedgerEntry],
    grace_ms: i64,
) -> Vec<MissedWindow> {
    let snapshot = ledger.load();
    let missed = snapshot
        .last_tick_at
        .map(|last| compute_missed_windows(last, now, entries, grace_ms))
        .unwrap_or_default();
    if !missed.is_empty() {
        ledger.record_missed(&missed, now);
    }
    ledger.record_tick(now);
    missed
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::collections::BTreeMap;

    use super::*;

    #[derive(Default)]
    struct MemoryLedger {
        rows: RefCell<BTreeMap<(String, String), String>>,
        transactions: RefCell<usize>,
    }

    impl LedgerStore for MemoryLedger {
        fn state_get(&self, automation_id: &str, key: &str) -> Option<String> {
            self.rows
                .borrow()
                .get(&(automation_id.to_owned(), key.to_owned()))
                .cloned()
        }

        fn state_set(&self, automation_id: &str, key: &str, value_json: &str, _updated_at: i64) {
            self.rows.borrow_mut().insert(
                (automation_id.to_owned(), key.to_owned()),
                value_json.to_owned(),
            );
        }

        fn in_transaction(&self, work: &mut dyn FnMut()) {
            *self.transactions.borrow_mut() += 1;
            work();
        }
    }

    fn entry(automation_ref: &str, expr: &str, zone: &str) -> LedgerEntry {
        LedgerEntry {
            automation_ref: automation_ref.to_owned(),
            schedules: vec![(expr.to_owned(), FireZone::named(zone).expect("bundled"))],
        }
    }

    /// ONE ENTRY PER GAP, anchored at the EARLIEST missed minute.
    #[test]
    fn a_seven_hour_outage_is_one_row_anchored_at_the_first_missed_minute() {
        let base = 1_767_225_600_000; // 2026-01-01T00:00:00Z
        let last_tick = base + 2 * 60 * MINUTE_MS; // 02:00
        let now = base + 9 * 60 * MINUTE_MS; // 09:00
        let missed = compute_missed_windows(
            last_tick,
            now,
            &[entry("poll/poll", "* * * * *", "UTC")],
            DEFAULT_GRACE_MS,
        );
        assert_eq!(missed.len(), 1, "one entry per automation per gap");
        assert_eq!(missed[0].scheduled_for, last_tick + MINUTE_MS);
        assert_eq!(missed[0].reason, MissedReason::GatewayDown);
    }

    #[test]
    fn a_quiet_day_and_an_outage_are_now_different() {
        let base = 1_767_225_600_000;
        // Nothing scheduled in the gap: no entry, even though the gap is real.
        let quiet = compute_missed_windows(
            base + 2 * 60 * MINUTE_MS,
            base + 9 * 60 * MINUTE_MS,
            &[entry("digest/digest", "0 22 * * *", "UTC")],
            DEFAULT_GRACE_MS,
        );
        assert!(quiet.is_empty());
        // Something WAS scheduled: an entry.
        let outage = compute_missed_windows(
            base + 2 * 60 * MINUTE_MS,
            base + 9 * 60 * MINUTE_MS,
            &[entry("digest/digest", "0 7 * * *", "UTC")],
            DEFAULT_GRACE_MS,
        );
        assert_eq!(outage.len(), 1);
        assert_eq!(outage[0].scheduled_for, base + 7 * 60 * MINUTE_MS);
    }

    #[test]
    fn a_gap_inside_the_grace_is_jitter() {
        let base = 1_767_225_600_000;
        assert!(
            compute_missed_windows(
                base,
                base + 2 * MINUTE_MS,
                &[entry("poll/poll", "* * * * *", "UTC")],
                DEFAULT_GRACE_MS,
            )
            .is_empty()
        );
    }

    /// A missed window is computed in the automation's OWN zone, which is the
    /// whole point of D-1020-AU2 reaching this file too.
    #[test]
    fn a_missed_window_is_read_in_the_schedules_zone() {
        // 2026-03-09: 01:30 IST is 2026-03-08T20:00:00Z.
        let last_tick = 1_772_985_600_000; // 2026-03-08T16:00:00Z
        let now = 1_773_050_400_000; // 2026-03-09T10:00:00Z
        let missed = compute_missed_windows(
            last_tick,
            now,
            &[entry("digest/digest", "0 7 * * *", "Asia/Kolkata")],
            DEFAULT_GRACE_MS,
        );
        assert_eq!(missed.len(), 1);
        let zone = FireZone::named("Asia/Kolkata").expect("bundled");
        assert_eq!(zone.wall_clock(missed[0].scheduled_for).hour, 7);
        // The same automation read in UTC would anchor at a different minute,
        // which is the wrong answer v0's tier 3 gives on a VPS.
        let utc = compute_missed_windows(
            last_tick,
            now,
            &[entry("digest/digest", "0 7 * * *", "UTC")],
            DEFAULT_GRACE_MS,
        );
        assert_ne!(utc[0].scheduled_for, missed[0].scheduled_for);
    }

    #[test]
    fn the_snapshot_round_trips_and_a_corrupt_one_reads_as_empty() {
        let store = MemoryLedger::default();
        let ledger = SchedulerLedger::new(&store);
        assert_eq!(ledger.load(), Snapshot::default());
        ledger.set_dormant(true, 1_000);
        assert_eq!(ledger.load().dormant, Some(true));
        ledger.record_tick(2_000);
        assert_eq!(ledger.load().last_tick_at, Some(2_000));
        assert_eq!(
            ledger.load().dormant,
            None,
            "a live tick CLEARS dormancy rather than setting it false"
        );
        store.state_set(
            SCHEDULER_LEDGER_AUTOMATION_ID,
            SCHEDULER_LEDGER_KEY,
            "{not json",
            0,
        );
        assert_eq!(ledger.load(), Snapshot::default(), "never throws");
    }

    /// THE #1014 B9 BUG: the tick that noticed the outage used to erase the
    /// record of it.
    #[test]
    fn the_missed_record_survives_the_tick_that_noticed_it() {
        let store = MemoryLedger::default();
        let ledger = SchedulerLedger::new(&store);
        let base = 1_767_225_600_000;
        ledger.record_tick(base + 2 * 60 * MINUTE_MS);
        let entries = [entry("poll/poll", "0 * * * *", "UTC")];
        let missed = record_scheduler_tick(
            &ledger,
            base + 9 * 60 * MINUTE_MS,
            &entries,
            DEFAULT_GRACE_MS,
        );
        assert_eq!(missed.len(), 1);
        let snapshot = ledger.load();
        assert_eq!(snapshot.missed.len(), 1, "the record is still there");
        assert_eq!(snapshot.last_tick_at, Some(base + 9 * 60 * MINUTE_MS));
        assert!(
            *store.transactions.borrow() >= 3,
            "every mutation takes the transaction door"
        );
    }

    #[test]
    fn the_missed_ring_is_bounded() {
        let store = MemoryLedger::default();
        let ledger = SchedulerLedger::new(&store);
        for index in 0..MAX_MISSED_ENTRIES + 10 {
            ledger.record_missed(
                &[MissedWindow {
                    automation_ref: format!("a{index}"),
                    scheduled_for: index as i64,
                    recorded_at: 0,
                    reason: MissedReason::GatewayDown,
                }],
                0,
            );
        }
        let snapshot = ledger.load();
        assert_eq!(snapshot.missed.len(), MAX_MISSED_ENTRIES);
        assert_eq!(
            snapshot.missed[0].automation_ref, "a10",
            "the oldest fall off the front"
        );
    }

    #[test]
    fn a_first_ever_tick_records_no_missed_window() {
        let store = MemoryLedger::default();
        let ledger = SchedulerLedger::new(&store);
        let missed = record_scheduler_tick(
            &ledger,
            1_767_225_600_000,
            &[entry("poll/poll", "* * * * *", "UTC")],
            DEFAULT_GRACE_MS,
        );
        assert!(
            missed.is_empty(),
            "a gateway that has never ticked has missed nothing"
        );
    }

    #[test]
    fn an_automation_with_no_resolvable_schedule_misses_nothing() {
        let base = 1_767_225_600_000;
        let missed = compute_missed_windows(
            base,
            base + 9 * 60 * MINUTE_MS,
            &[LedgerEntry {
                automation_ref: "unzoned/unzoned".to_owned(),
                schedules: Vec::new(),
            }],
            DEFAULT_GRACE_MS,
        );
        assert!(
            missed.is_empty(),
            "a schedule that never registered missed nothing"
        );
    }
}
