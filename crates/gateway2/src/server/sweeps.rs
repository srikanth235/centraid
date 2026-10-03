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
//! # TIMERS, NOT A CRON
//!
//! A laptop sleeps and is shut at night. Each sweep is due one interval after
//! the last one finished, so a gateway that was off for a month sweeps once
//! when it wakes rather than firing a backlog.
//!
//! Both run on the blocking pool, page by page, taking the rules' lock for
//! one page or one object at a time: a phone's request waits at most one
//! step behind a sweep, never a whole pass.

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

/// Is a sweep whose last run ended `since` ago due?
#[must_use]
pub const fn due(every: Duration, since: Duration) -> bool {
    !every.is_zero() && since.as_secs() >= every.as_secs()
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
    let mut since_purge = Duration::ZERO;
    let mut since_scrub = Duration::ZERO;
    loop {
        tokio::time::sleep(TICK).await;
        since_purge += TICK;
        since_scrub += TICK;
        if due(schedule.purge_every, since_purge) {
            since_purge = Duration::ZERO;
            let held = shared.clone();
            match tokio::task::spawn_blocking(move || purge_once(&held)).await {
                Ok(Ok(purged)) => tracing::info!(purged, "purge sweep"),
                Ok(Err(fault)) => tracing::warn!(%fault, "purge sweep failed"),
                Err(error) => tracing::warn!(%error, "purge sweep did not finish"),
            }
        }
        if due(schedule.scrub_every, since_scrub) {
            since_scrub = Duration::ZERO;
            let held = shared.clone();
            match tokio::task::spawn_blocking(move || scrub_once(&held)).await {
                Ok(Ok(counts)) => tracing::info!(
                    read = counts.read,
                    corrupt = counts.corrupt,
                    missing = counts.missing,
                    "scrub sweep"
                ),
                Ok(Err(fault)) => tracing::warn!(%fault, "scrub sweep failed"),
                Err(error) => tracing::warn!(%error, "scrub sweep did not finish"),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_zero_interval_is_off() {
        assert!(!due(
            Duration::ZERO,
            Duration::from_secs(u64::from(u32::MAX))
        ));
    }

    /// A laptop that was off for a month sweeps once, not thirty times.
    #[test]
    fn a_sweep_is_due_once_its_interval_has_passed() {
        assert!(!due(PURGE_EVERY, Duration::from_secs(3_599)));
        assert!(due(PURGE_EVERY, Duration::from_secs(3_600)));
        assert!(due(PURGE_EVERY, Duration::from_secs(30 * 24 * 3_600)));
        assert_eq!(SCRUB_EVERY.as_secs(), 90 * 24 * 3_600, "quarterly");
    }
}
