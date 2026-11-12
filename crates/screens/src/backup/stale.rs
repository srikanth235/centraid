//! THE STALE-BACKUP NOTICE (#1188, NB2, the owner's ruling on the interface).
//!
//! A notice posted only when Centraid runs fails exactly when it matters: a backup goes stale
//! because the app is not being opened or passes are not running. So it is **scheduled ahead**,
//! like every other notification, as a pure function of what the backup ledger says and the
//! clock. There is no "last posted" anywhere: ids are deterministic from the oldest device's last
//! confirmed backup `T` and the step, so a new confirmed backup changes `T`, and the service's
//! ordinary reconcile drops the old ids and schedules the new.
//!
//! One notice is due at `T + 3 days`, then `T + 10 days`, `T + 17 days`, and so on weekly. At
//! most two are returned (they take two slots of the cap): the latest step already due, which
//! stays until a backup is confirmed, and the next. Written before the day comes, the text says
//! only what is known then: how old the backup will be, and which device has not been reached
//! since when. **No reason is claimed in advance.** A tap opens Backup; there are no buttons.

use centraid_api_proto::core_v1 as wire;
use centraid_vault::time::FireZone;

use super::line::{CLOCK_TOLERANCE_MS, STALE_MS};
use super::reading::Reading;
use crate::kit::schedule::rule_words::long_day;
use crate::strings::{Locale, backup_check as words, fill};

/// The Android channel: its own, so a member can silence it without silencing reminders.
pub const CHANNEL: &str = "backup";

const DAY_MS: i64 = 24 * 60 * 60 * 1000;
/// After the first notice, one a week.
const REPEAT_MS: i64 = 7 * DAY_MS;

/// One notice to schedule.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StaleNotice {
    /// `backup-stale:<T>:<n>`, deterministic from the last confirmed backup and the step.
    pub id: String,
    pub channel: &'static str,
    /// When it fires, this phone's clock; a step already due fires now.
    pub fire_at_ms: i64,
    pub title: String,
    pub body: String,
    /// Where a tap goes: Backup.
    pub opens: wire::Route,
}

/// THE ONE PRODUCER the notification service asks on every sync: the notices to schedule and the
/// ids still wanted (a delivered notice stays on screen while its id is listed; once a backup is
/// confirmed the ids change and the old ones are no longer wanted). It depends on the ledger's
/// reading and the clock alone, never on the Backup screen being open.
#[must_use]
pub fn producer(
    locale: Locale,
    zone: &str,
    reading: &Reading,
    now_ms: i64,
) -> (Vec<StaleNotice>, Vec<String>) {
    let notices = stale_backup_notices(locale, zone, reading, now_ms);
    let wanted = notices.iter().map(|n| n.id.clone()).collect();
    (notices, wanted)
}

/// The notices to have scheduled now: none with no device paired, or with no confirmed backup to
/// count from.
#[must_use]
pub fn stale_backup_notices(
    locale: Locale,
    zone: &str,
    reading: &Reading,
    now_ms: i64,
) -> Vec<StaleNotice> {
    // THE OLDEST DEVICE sets the age: a backup is only as current as the device furthest behind.
    // A device that never confirmed anything is counted from the day it was paired, and it is the
    // worst case, never a silent one (the owner's ruling).
    let Some(behind) = reading
        .destinations
        .iter()
        .filter_map(|d| {
            d.last_ack_ms
                .map(|at| (at, false, d))
                .or_else(|| d.paired_at_ms.map(|at| (at, true, d)))
        })
        .min_by_key(|(at, _, _)| *at)
    else {
        return Vec::new();
    };
    let (raw, never, device) = behind;

    // A TIME AHEAD OF THIS PHONE'S CLOCK is a clock that was set ahead and corrected: it counts
    // as stale now (the first step is due now) and is not waited for.
    let future = raw - now_ms > CLOCK_TOLERANCE_MS;
    let base = if future { now_ms - STALE_MS } else { raw };
    let due_of = |step: i64| base + STALE_MS + REPEAT_MS * (step - 1);
    // The latest step already due, then the next: two at most.
    let passed = if now_ms >= due_of(1) {
        (now_ms - due_of(1)) / REPEAT_MS + 1
    } else {
        0
    };
    let steps: Vec<i64> = if passed == 0 {
        vec![1, 2]
    } else {
        vec![passed, passed + 1]
    };
    let since = since_day(locale, zone, raw);
    steps
        .into_iter()
        .map(|step| {
            let days = (due_of(step) - base) / DAY_MS;
            StaleNotice {
                id: format!("backup-stale:{raw}:{step}"),
                channel: CHANNEL,
                fire_at_ms: due_of(step).max(if now_ms >= due_of(step) { now_ms } else { 0 }),
                title: if never {
                    words::stale_never_title(locale)
                } else {
                    fill(&words::stale_title(locale), &[("n", &days.to_string())])
                },
                body: fill(
                    &if never {
                        words::stale_never_body(locale)
                    } else {
                        words::stale_body(locale)
                    },
                    &[("device", &device.label), ("since", &since)],
                ),
                opens: super::routes::home(),
            }
        })
        .collect()
}

/// `Monday 9 November`, in the member's zone.
pub(super) fn since_day(locale: Locale, zone: &str, ms: i64) -> String {
    let Some(zone) = FireZone::named(zone)
        .or_else(|_| FireZone::named("UTC"))
        .ok()
    else {
        return String::new();
    };
    let wall = zone.wall_clock(ms);
    long_day(
        locale,
        &format!("{:04}-{:02}-{:02}", wall.year, wall.month, wall.day),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::reading::Destination;

    /// Sunday 8 November 2026, 21:40 UTC.
    const T: i64 = 1_794_174_000_000;

    fn device(label: &str, ack: Option<i64>) -> Destination {
        Destination {
            gateway_id: format!("id-{label}"),
            label: label.to_owned(),
            addrs: Vec::new(),
            last_seen_ms: None,
            last_ack_ms: ack,
            pair_again: false,
            held_bytes: 0,
            behind_files: 0,
            behind_bytes: 0,
            records_behind: false,
            reach: 0,
            refused_limit_bytes: 0,
            rolled_back: false,
            paired_at_ms: None,
            waiting_apps: Vec::new(),
        }
    }

    fn reading(devices: Vec<Destination>) -> Reading {
        let mut r = Reading {
            destinations: devices,
            last_snapshot_ms: None,
            last_ack_ms: None,
            content_total: 0,
            content_confirmed: 0,
            pending_bytes: 0,
            spool_bytes: 0,
            waiting: std::collections::BTreeMap::new(),
            frozen: false,
            apps: Vec::new(),
            total_bytes: 0,
            confirmed_bytes: 0,
            left_out_items: 0,
            left_out_bytes: 0,
        };
        r.last_ack_ms = r.destinations.iter().filter_map(|d| d.last_ack_ms).max();
        r
    }

    fn notices(devices: Vec<Destination>, now: i64) -> Vec<StaleNotice> {
        stale_backup_notices(Locale::En, "UTC", &reading(devices), now)
    }

    #[test]
    fn no_device_paired_schedules_nothing() {
        assert!(notices(Vec::new(), T).is_empty());
    }

    #[test]
    fn a_device_that_never_confirmed_is_counted_from_its_pairing_and_never_silent() {
        let mut never = device("Mac mini", None);
        never.paired_at_ms = Some(T);
        let n = notices(vec![never.clone()], T + DAY_MS);
        assert_eq!(n.len(), 2);
        assert_eq!(n[0].fire_at_ms, T + 3 * DAY_MS);
        assert_eq!(n[0].title, "Not backed up yet");
        assert_eq!(
            n[0].body,
            "Nothing has reached Mac mini since it was paired on Sunday 8 November. Open Centraid to see why."
        );
        assert_eq!(n[0].id, format!("backup-stale:{T}:1"));
        // With no pairing time either, there is nothing to count from.
        never.paired_at_ms = None;
        assert!(notices(vec![never], T).is_empty());
    }

    #[test]
    fn the_producer_wants_every_id_it_offers() {
        let (notices, wanted) = producer(
            Locale::En,
            "UTC",
            &reading(vec![device("Mac mini", Some(T))]),
            T + 12 * DAY_MS,
        );
        assert_eq!(
            wanted,
            notices.iter().map(|n| n.id.clone()).collect::<Vec<_>>()
        );
        assert_eq!(wanted.len(), 2);
    }

    #[test]
    fn a_fresh_backup_schedules_the_first_two_ahead() {
        let n = notices(vec![device("Mac mini", Some(T))], T + 60_000);
        assert_eq!(n.len(), 2);
        assert_eq!(n[0].fire_at_ms, T + 3 * DAY_MS);
        assert_eq!(n[1].fire_at_ms, T + 10 * DAY_MS);
        assert_eq!(n[0].title, "Backup is 3 days old");
        assert_eq!(n[1].title, "Backup is 10 days old");
        assert_eq!(
            n[0].body,
            "Nothing has reached Mac mini since Sunday 8 November. Open Centraid to see why."
        );
        assert_eq!(n[0].id, format!("backup-stale:{T}:1"));
        assert_eq!(n[0].channel, "backup");
        assert_eq!(n[0].opens, crate::backup::routes::home());
    }

    #[test]
    fn exactly_three_days_the_first_is_due_now_and_the_next_waits() {
        let n = notices(vec![device("Mac mini", Some(T))], T + 3 * DAY_MS);
        assert_eq!(n[0].id, format!("backup-stale:{T}:1"));
        assert_eq!(n[0].fire_at_ms, T + 3 * DAY_MS);
        assert_eq!(n[1].id, format!("backup-stale:{T}:2"));
        assert_eq!(n[1].fire_at_ms, T + 10 * DAY_MS);
    }

    #[test]
    fn between_steps_the_delivered_one_stays_and_the_next_is_ahead() {
        let now = T + 12 * DAY_MS;
        let n = notices(vec![device("Mac mini", Some(T))], now);
        assert_eq!(n[0].id, format!("backup-stale:{T}:2"));
        assert_eq!(
            n[0].fire_at_ms, now,
            "already past: due now, the service knows it was delivered"
        );
        assert_eq!(n[1].id, format!("backup-stale:{T}:3"));
        assert_eq!(n[1].fire_at_ms, T + 17 * DAY_MS);
        assert_eq!(n[1].title, "Backup is 17 days old");
    }

    #[test]
    fn a_new_confirmed_backup_changes_every_id() {
        let old = notices(vec![device("Mac mini", Some(T))], T + 4 * DAY_MS);
        let new = notices(
            vec![device("Mac mini", Some(T + 4 * DAY_MS))],
            T + 4 * DAY_MS,
        );
        assert!(old.iter().all(|o| new.iter().all(|n| n.id != o.id)));
        assert_eq!(new[0].fire_at_ms, T + 7 * DAY_MS);
    }

    #[test]
    fn the_oldest_device_sets_the_age_and_is_named() {
        let n = notices(
            vec![
                device("Mac mini", Some(T + 2 * DAY_MS)),
                device("Office NAS", Some(T)),
            ],
            T + DAY_MS,
        );
        assert_eq!(n[0].fire_at_ms, T + 3 * DAY_MS);
        assert!(n[0].body.contains("Office NAS"));
    }

    #[test]
    fn a_future_dated_backup_counts_as_stale_now() {
        let now = T;
        let ahead = now + 40 * DAY_MS;
        let n = notices(vec![device("Mac mini", Some(ahead))], now);
        assert_eq!(n[0].fire_at_ms, now, "due now, not in 40 days");
        assert_eq!(n[0].id, format!("backup-stale:{ahead}:1"));
    }
}
