//! **THE SWEEPS HAVE A SCHEDULE** (#1029 §3, §5 line 337, W15-4).
//!
//! `gateway-core` has had `purge` and `scrub` since W4 and **nothing called
//! them**: `purge` had no caller at all, and `scrub` had one CLI verb. A
//! tombstone past its grace period stayed on the disk forever, and a household
//! that deleted a year of bases got the space back only if somebody happened to
//! run a command they had never been told about.
//!
//! This module is the caller. It decides nothing: the rules are
//! [`centraid_gateway_core::engine::Gateway::purge`] and
//! [`centraid_gateway_core::engine::Gateway::scrub`], the retention floor is
//! [`centraid_gateway_core::retention`], and what is here is a clock and a
//! loop.
//!
//! # THE TWO CADENCES, AND WHY THEY ARE NOT THE SAME NUMBER
//!
//! **Purge is hourly.** It is cheap — a state query per vault and an unlink per
//! purgeable object — and its job is to make "delete" mean something on a
//! timescale a member can perceive. The grace period is the delay that protects
//! an undo ([`ObjectEntry::purge_after_ms`]); the sweep interval must be short
//! enough that it does not silently become a second, longer one.
//!
//! **Scrub is quarterly**, which is §5 line 337's "quarterly and on demand"
//! and is deliberately rare: it **reads every stored byte** of every vault to
//! re-hash it. On a household's laptop with a year of bases that is hours of
//! disk, and running it often would make a backup server a machine you notice.
//! The "on demand" half is the CLI verb, which stays.
//!
//! Both are configurable, and **both are logged with counts only** (#1029 §3):
//! a gateway is blind, so a sweep may report how many objects it read and how
//! many it removed, and never which.
//!
//! # WHY A TIMER AND NOT A CRON
//!
//! A gateway is a program a member leaves running on their own laptop, which
//! sleeps, moves between networks and is closed at night. A wall-clock schedule
//! would either fire a storm of missed sweeps on wake or skip a quarter because
//! the machine was shut at the wrong moment. [`Schedule::due`] is a comparison
//! against the last completed sweep, so a laptop that was off for a month
//! sweeps once when it comes back.

use std::time::Duration;

use centraid_gateway_core::ServerTime;

use crate::http::Shared;

/// One hour.
pub const DEFAULT_PURGE_EVERY: Duration = Duration::from_secs(60 * 60);

/// Ninety days — §5 line 337's "quarterly".
pub const DEFAULT_SCRUB_EVERY: Duration = Duration::from_secs(90 * 24 * 60 * 60);

/// How often each sweep runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    /// Seconds between purges. `0` disables the purge sweep.
    #[serde(default = "default_purge_seconds")]
    pub purge_every_seconds: u64,
    /// Seconds between scrubs. `0` disables the scrub sweep — which a
    /// self-hoster on a spinning disk may genuinely want, and which is why it
    /// is a number and not a flag.
    #[serde(default = "default_scrub_seconds")]
    pub scrub_every_seconds: u64,
}

fn default_purge_seconds() -> u64 {
    DEFAULT_PURGE_EVERY.as_secs()
}

fn default_scrub_seconds() -> u64 {
    DEFAULT_SCRUB_EVERY.as_secs()
}

impl Default for Schedule {
    fn default() -> Self {
        Self {
            purge_every_seconds: default_purge_seconds(),
            scrub_every_seconds: default_scrub_seconds(),
        }
    }
}

impl Schedule {
    /// Whether a sweep whose last run ended `since` ago is due.
    ///
    /// `every == 0` is off, and is never due. A sweep that has never run
    /// (`since` of whatever the caller has counted so far) is due as soon as
    /// one interval has passed, **not immediately at start-up**: a gateway that
    /// swept on every launch would make restarting it a way to spend a
    /// household's disk on re-hashing.
    #[must_use]
    pub const fn due(every_seconds: u64, since: Duration) -> bool {
        every_seconds != 0 && since.as_secs() >= every_seconds
    }
}

/// What one purge sweep did. **Counts only.**
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PurgeCounts {
    pub vaults: usize,
    pub purged: usize,
}

/// What one scrub sweep did. **Counts only.**
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ScrubCounts {
    pub vaults: usize,
    pub objects_read: u64,
    pub corrupt: usize,
    /// Objects the store no longer has at all — a different finding from
    /// corrupt, and reported separately because "the bytes changed" and "the
    /// bytes are gone" are different failures of a disk.
    pub missing: usize,
}

/// Purge every vault's tombstones that are past their grace period.
///
/// The one caller of [`centraid_gateway_core::engine::Gateway::purge`] outside
/// a test.
///
/// # Errors
///
/// A store fault. A fault on ONE vault ends the sweep rather than skipping it:
/// a sweep that silently walked past a vault it could not read would report a
/// clean run over a disk that is failing.
pub async fn purge_once(server: &Shared, now: ServerTime) -> anyhow::Result<PurgeCounts> {
    let mut counts = PurgeCounts::default();
    let vaults = {
        let held = server.lock().await;
        held.gateway.state.vaults()?
    };
    counts.vaults = vaults.len();
    for vault in vaults {
        let mut held = server.lock().await;
        counts.purged += held.gateway.purge(&vault, now).await?.len();
    }
    Ok(counts)
}

/// Re-hash every stored object of every vault and report what no longer hashes
/// to its own name.
///
/// **No key is involved**, which is the whole reason a blind gateway can do
/// this at all.
///
/// # Errors
///
/// A store fault.
pub async fn scrub_once(server: &Shared) -> anyhow::Result<ScrubCounts> {
    let mut counts = ScrubCounts::default();
    let vaults = {
        let held = server.lock().await;
        held.gateway.state.vaults()?
    };
    counts.vaults = vaults.len();
    for vault in vaults {
        let held = server.lock().await;
        let report = held.gateway.scrub(&vault).await?;
        counts.objects_read += report.read;
        counts.corrupt += report.corrupt.len();
        counts.missing += report.missing.len();
    }
    Ok(counts)
}

/// Run both sweeps on their own cadences, forever.
///
/// Spawned beside the listener by `centraid-gateway serve`. The tick is one
/// minute, which is the resolution the two intervals are compared at; a
/// finer one would wake a laptop's disk for nothing and a coarser one would
/// make the purge interval a lie by up to its own length.
pub async fn run(server: Shared, schedule: Schedule) {
    const TICK: Duration = Duration::from_secs(60);
    let mut since_purge = Duration::ZERO;
    let mut since_scrub = Duration::ZERO;
    loop {
        tokio::time::sleep(TICK).await;
        since_purge += TICK;
        since_scrub += TICK;

        if Schedule::due(schedule.purge_every_seconds, since_purge) {
            since_purge = Duration::ZERO;
            match purge_once(&server, crate::clock::now()).await {
                // COUNTS ONLY. A gateway is blind; naming an object here would
                // be the one place it wrote down what it holds.
                Ok(counts) => tracing::info!(
                    vaults = counts.vaults,
                    purged = counts.purged,
                    "purge sweep"
                ),
                Err(error) => tracing::warn!(%error, "purge sweep failed"),
            }
        }

        if Schedule::due(schedule.scrub_every_seconds, since_scrub) {
            since_scrub = Duration::ZERO;
            match scrub_once(&server).await {
                Ok(counts) => tracing::info!(
                    vaults = counts.vaults,
                    objects_read = counts.objects_read,
                    corrupt = counts.corrupt,
                    missing = counts.missing,
                    "scrub sweep"
                ),
                Err(error) => tracing::warn!(%error, "scrub sweep failed"),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_zero_interval_is_off_and_is_never_due() {
        assert!(!Schedule::due(0, Duration::from_secs(u32::MAX as u64)));
    }

    #[test]
    fn a_sweep_is_due_once_its_interval_has_passed_and_not_before() {
        assert!(!Schedule::due(3600, Duration::from_secs(3599)));
        assert!(Schedule::due(3600, Duration::from_secs(3600)));
        // A LAPTOP THAT WAS OFF FOR A MONTH sweeps ONCE when it comes back:
        // the comparison is against the last completed sweep, so there is no
        // backlog of missed ones to fire in a storm.
        assert!(Schedule::due(3600, Duration::from_secs(30 * 24 * 3600)));
    }

    #[test]
    fn the_defaults_are_hourly_and_quarterly() {
        let schedule = Schedule::default();
        assert_eq!(schedule.purge_every_seconds, 3_600);
        assert_eq!(
            schedule.scrub_every_seconds,
            90 * 24 * 3_600,
            "§5 line 337 says quarterly"
        );
    }
}
