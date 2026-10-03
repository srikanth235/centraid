//! THE SWEEPS: purge hourly, scrub quarterly (#1080).
//!
//! The rules are [`crate::rules::engine::Gateway::purge`] and
//! [`crate::rules::engine::Gateway::record_scrub`]; what is here is a clock,
//! a loop and the file reads. **Both log counts only**: a blind gateway may
//! say how many objects it read and removed, never which.
//!
//! # TWO CADENCES
//!
//! **Purge is hourly** and cheap — an indexed query and an unlink per
//! tombstone past its grace — so "deleted" means gone on a timescale a member
//! perceives, and the interval never quietly becomes a second grace.
//!
//! **Scrub is quarterly**: it reads every stored byte to re-hash it, which on a
//! year of photographs is hours of disk. The on-demand half is the `scrub`
//! verb. A damaged object is marked, so `exists` tells the phone to send it
//! again; nothing here deletes a byte the scrub could not vouch for.
//!
//! # TIMERS, NOT A CRON, AND THEY SURVIVE A RESTART
//!
//! A laptop sleeps, is shut at night and restarts. Each sweep is due one
//! interval after the last one finished **by the gateway's clock**, and when
//! each last finished is kept in the data directory ([`SWEEPS_FILE`]):
//! counting a process's own uptime would reset the quarter at every restart
//! and stand still through every night asleep, and a laptop's scrub would
//! never come. A gateway that was off for a month sweeps once when it wakes
//! rather than firing a backlog, and a sweep that fails is tried again an
//! hour later ([`RETRY`]).
//!
//! Both run on the blocking pool, page by page, taking the rules' lock for
//! one page or one object at a time: a phone's request waits at most one
//! step behind a sweep, never a whole pass.

use std::path::Path;
use std::time::Duration;

use crate::rules::engine::{Finding, ScrubCounts, examine};
use crate::rules::ids::{Name, VaultId};
use crate::rules::state::{Fault, StoreFault};
use crate::server::{Handle, Shared};

/// One hour.
pub const PURGE_EVERY: Duration = Duration::from_secs(60 * 60);

/// Ninety days.
pub const SCRUB_EVERY: Duration = Duration::from_secs(90 * 24 * 60 * 60);

/// Rows per page.
const PAGE: usize = 256;

/// How often each sweep runs. Zero turns one off.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Schedule {
    pub purge_every: Duration,
    pub scrub_every: Duration,
}

impl Default for Schedule {
    fn default() -> Self {
        Self {
            purge_every: PURGE_EVERY,
            scrub_every: SCRUB_EVERY,
        }
    }
}

/// How long after a failed sweep it is tried again.
pub const RETRY: Duration = Duration::from_secs(60 * 60);

/// Where the gateway keeps when each sweep last finished.
pub const SWEEPS_FILE: &str = "sweeps.json";

/// When each sweep last finished, in the gateway's milliseconds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Finished {
    pub purge_ms: i64,
    pub scrub_ms: i64,
}

impl Finished {
    /// What `data_dir` recorded. A gateway that never swept starts both
    /// clocks at `now_ms` and records that at once — it has nothing to purge
    /// or re-hash yet, its first scrub is a quarter away, and a restart before
    /// then must not move it.
    ///
    /// # Errors
    ///
    /// If a missing record cannot be written.
    pub fn load_or_start(data_dir: &Path, now_ms: i64) -> std::io::Result<Self> {
        let recorded = std::fs::read_to_string(data_dir.join(SWEEPS_FILE))
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok());
        if let Some(recorded) = recorded {
            return Ok(recorded);
        }
        let started = Self {
            purge_ms: now_ms,
            scrub_ms: now_ms,
        };
        started.save(data_dir)?;
        Ok(started)
    }

    /// Record these times, whole: written aside and renamed into place.
    ///
    /// # Errors
    ///
    /// If the data directory cannot be written.
    pub fn save(&self, data_dir: &Path) -> std::io::Result<()> {
        let staged = data_dir.join(format!("{SWEEPS_FILE}.tmp"));
        std::fs::write(
            &staged,
            serde_json::to_string(self).map_err(std::io::Error::other)?,
        )?;
        std::fs::rename(&staged, data_dir.join(SWEEPS_FILE))
    }
}

/// Is a sweep that runs `every` and last finished at `last_ms` due at
/// `now_ms`? A clock set back waits for itself to pass `last_ms` again.
#[must_use]
pub fn due(every: Duration, last_ms: i64, now_ms: i64) -> bool {
    !every.is_zero()
        && now_ms.saturating_sub(last_ms) >= i64::try_from(every.as_millis()).unwrap_or(i64::MAX)
}

/// The finish time to record for a sweep that failed at `now_ms`, so it is
/// due again [`RETRY`] later rather than a whole interval later.
#[must_use]
pub fn failed_at(every: Duration, now_ms: i64) -> i64 {
    let every = i64::try_from(every.as_millis()).unwrap_or(i64::MAX);
    let retry = i64::try_from(RETRY.as_millis()).unwrap_or(i64::MAX);
    now_ms.saturating_sub(every.saturating_sub(retry).max(0))
}

/// Purge every tombstone past its grace. Blocking: run it off the runtime.
///
/// # Errors
///
/// A store fault. One fault ends the pass rather than skipping an object: a
/// pass that walked past what it could not remove would report a clean run
/// over a failing disk.
pub fn purge_once(shared: &Shared) -> Result<u64, Fault> {
    let mut purged = 0;
    loop {
        let now = shared.now();
        let due = shared.rules(|gateway| gateway.purgeable(now, PAGE))?;
        if due.is_empty() {
            return Ok(purged);
        }
        let mut progressed = false;
        for (vault, name) in due {
            let store = shared.store();
            if shared.rules(|gateway| {
                gateway.purge(&vault, &name, now, || store.remove(&vault, &name))
            })? {
                purged += 1;
                progressed = true;
            }
        }
        if !progressed {
            return Ok(purged);
        }
    }
}

/// Re-hash every stored object against its digest and mark what no longer
/// matches. Blocking: run it off the runtime.
///
/// # Errors
///
/// A store fault, or a read error other than a missing file.
pub fn scrub_once(shared: &Shared) -> Result<ScrubCounts, Fault> {
    let mut counts = ScrubCounts::default();
    let mut after: Option<(VaultId, Name)> = None;
    loop {
        let page = shared.rules(|gateway| {
            gateway.scrub_page(after.as_ref().map(|(vault, name)| (vault, name)), PAGE)
        })?;
        let Some((last_vault, last)) = page.last() else {
            return Ok(counts);
        };
        after = Some((*last_vault, last.name));
        for (vault, record) in page {
            let found = shared
                .store()
                .read_digest(&vault, &record.name)
                .map_err(|error| StoreFault::new(error.to_string()))?;
            let finding = examine(&record.digest, found.map(|(digest, _)| digest).as_ref());
            counts.read += 1;
            match finding {
                Finding::Intact => {}
                Finding::Corrupt => counts.corrupt += 1,
                Finding::Missing => counts.missing += 1,
            }
            let now = shared.now();
            shared.rules(|gateway| gateway.record_scrub(&vault, &record, finding, now))?;
        }
    }
}

/// Run both sweeps on their cadences, forever. Spawned beside the listener.
pub async fn run(shared: Handle, schedule: Schedule) {
    const TICK: Duration = Duration::from_secs(60);
    let mut finished = match Finished::load_or_start(shared.data_dir(), shared.now()) {
        Ok(finished) => finished,
        Err(error) => {
            tracing::warn!(%error, "the sweeps cannot record their times; not sweeping");
            return;
        }
    };
    loop {
        tokio::time::sleep(TICK).await;
        if due(schedule.purge_every, finished.purge_ms, shared.now()) {
            let held = shared.clone();
            finished.purge_ms = match tokio::task::spawn_blocking(move || purge_once(&held)).await {
                Ok(Ok(purged)) => {
                    tracing::info!(purged, "purge sweep");
                    shared.now()
                }
                Ok(Err(fault)) => {
                    tracing::warn!(%fault, "purge sweep failed");
                    failed_at(schedule.purge_every, shared.now())
                }
                Err(error) => {
                    tracing::warn!(%error, "purge sweep did not finish");
                    failed_at(schedule.purge_every, shared.now())
                }
            };
            record(&shared, &finished);
        }
        if due(schedule.scrub_every, finished.scrub_ms, shared.now()) {
            let held = shared.clone();
            finished.scrub_ms = match tokio::task::spawn_blocking(move || scrub_once(&held)).await {
                Ok(Ok(counts)) => {
                    tracing::info!(
                        read = counts.read,
                        corrupt = counts.corrupt,
                        missing = counts.missing,
                        "scrub sweep"
                    );
                    shared.now()
                }
                Ok(Err(fault)) => {
                    tracing::warn!(%fault, "scrub sweep failed");
                    failed_at(schedule.scrub_every, shared.now())
                }
                Err(error) => {
                    tracing::warn!(%error, "scrub sweep did not finish");
                    failed_at(schedule.scrub_every, shared.now())
                }
            };
            record(&shared, &finished);
        }
    }
}

/// Keep the sweeps' times. A write that fails is logged and the times held
/// in memory still pace this run.
fn record(shared: &Shared, finished: &Finished) {
    if let Err(error) = finished.save(shared.data_dir()) {
        tracing::warn!(%error, "the sweeps could not record their times");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOUR_MS: i64 = 3_600_000;
    const DAY_MS: i64 = 24 * HOUR_MS;

    #[test]
    fn a_zero_interval_is_off() {
        assert!(!due(Duration::ZERO, 0, i64::MAX));
    }

    /// A laptop that was off for a month sweeps once, not thirty times, and a
    /// clock set back waits rather than sweeping.
    #[test]
    fn a_sweep_is_due_once_its_interval_has_passed() {
        let last = 1_000 * DAY_MS;
        assert!(!due(PURGE_EVERY, last, last + HOUR_MS - 1));
        assert!(due(PURGE_EVERY, last, last + HOUR_MS));
        assert!(due(PURGE_EVERY, last, last + 30 * DAY_MS));
        assert!(!due(PURGE_EVERY, last, last - DAY_MS));
        assert_eq!(SCRUB_EVERY.as_secs(), 90 * 24 * 3_600, "quarterly");
    }

    /// The quarter is kept in the data directory: a restart reads it back
    /// instead of starting a new one, which on a laptop restarted weekly would
    /// put the scrub off forever.
    #[test]
    fn a_restart_keeps_the_quarter() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let first_start = 1_000 * DAY_MS;
        let started = Finished::load_or_start(dir.path(), first_start).expect("starts");
        assert_eq!(started.scrub_ms, first_start);
        assert!(dir.path().join(SWEEPS_FILE).is_file(), "recorded at once");

        let restarted =
            Finished::load_or_start(dir.path(), first_start + 89 * DAY_MS).expect("restarts");
        assert_eq!(restarted, started, "a restart does not move the quarter");
        assert!(!due(
            SCRUB_EVERY,
            restarted.scrub_ms,
            first_start + 89 * DAY_MS
        ));
        assert!(due(
            SCRUB_EVERY,
            restarted.scrub_ms,
            first_start + 90 * DAY_MS
        ));

        let swept = Finished {
            scrub_ms: first_start + 90 * DAY_MS,
            ..restarted
        };
        swept.save(dir.path()).expect("records");
        assert_eq!(
            Finished::load_or_start(dir.path(), 0).expect("reads"),
            swept
        );
    }

    /// A failed sweep comes round again an hour later, not a quarter later.
    #[test]
    fn a_failed_sweep_is_tried_again_in_an_hour() {
        let now = 1_000 * DAY_MS;
        for every in [PURGE_EVERY, SCRUB_EVERY] {
            let last = failed_at(every, now);
            assert!(!due(every, last, now + HOUR_MS - 1), "{every:?}");
            assert!(due(every, last, now + HOUR_MS), "{every:?}");
        }
    }
}
