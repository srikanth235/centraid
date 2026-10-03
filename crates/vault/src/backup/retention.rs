//! Which snapshots to keep, and which names are garbage (#1080, "Retention").
//!
//! The phone keeps **7 daily, 4 weekly and 6 monthly** snapshots, judged on
//! `taken_at_ms`, deregisters the rest by deleting their manifests, and then
//! deletes every name nothing it keeps refers to. Pure functions: the caller
//! brings the snapshot list, the manifests and the content hashes, so a fixed
//! clock is all a test needs.
//!
//! ## A PERIOD COUNTS ONLY IF IT HOLDS A SNAPSHOT (R-1080-B5)
//!
//! "7 daily" is the newest snapshot of each of the 7 most recent UTC days that
//! have one, not of the 7 days before `now`; the same for ISO weeks (Monday to
//! Sunday, UTC) and calendar months. A phone that was off for a month comes
//! back to the history it left rather than to one snapshot. The rules overlap
//! — today's newest is also this week's and this month's — so the union is at
//! most 17. The newest snapshot is always kept, and so is one dated after
//! `now_ms`: a clock that went backwards cannot be judged against.
//!
//! ## WHAT IS LIVE
//!
//! [`live_names`] is every kept manifest, every range a kept manifest names,
//! and every name a content hash in the vault implies. The caller adds the
//! manifests and queued parts of uploads still in flight, which no snapshot
//! list names yet: a collection that ran between a range's upload and its
//! manifest's would otherwise delete the range.

use std::collections::BTreeSet;

use super::naming::{BackupKeys, Name, PlaintextHash, names_of};
use super::store::SnapshotEntry;

/// Daily snapshots kept.
pub const KEEP_DAILY: usize = 7;
/// Weekly snapshots kept.
pub const KEEP_WEEKLY: usize = 4;
/// Monthly snapshots kept.
pub const KEEP_MONTHLY: usize = 6;

const DAY_MS: u64 = 24 * 60 * 60 * 1000;

/// The period a snapshot falls in, under one rule.
type Period = fn(u64) -> i64;

/// What retention decided.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Keep {
    /// Kept, newest first.
    pub keep: Vec<Name>,
    /// To be deregistered, newest first.
    pub drop: Vec<Name>,
}

/// Days since 1970-01-01, UTC.
fn day(taken_at_ms: u64) -> i64 {
    i64::try_from(taken_at_ms / DAY_MS).unwrap_or(i64::MAX)
}

/// Monday-based weeks: day 0 was a Thursday, so day −3 is the Monday that
/// starts week 0.
fn iso_week(taken_at_ms: u64) -> i64 {
    (day(taken_at_ms) + 3).div_euclid(7)
}

/// `year * 12 + month0`, from Howard Hinnant's `civil_from_days`.
fn month(taken_at_ms: u64) -> i64 {
    let z = day(taken_at_ms) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    year * 12 + (month - 1)
}

/// Decide which snapshots to keep.
#[must_use]
pub fn keep(entries: &[SnapshotEntry], now_ms: u64) -> Keep {
    let mut ordered: Vec<&SnapshotEntry> = entries.iter().collect();
    ordered
        .sort_by(|left, right| (right.taken_at_ms, right.name).cmp(&(left.taken_at_ms, left.name)));

    let mut kept: BTreeSet<Name> = ordered
        .iter()
        .filter(|entry| entry.taken_at_ms > now_ms)
        .map(|entry| entry.name)
        .collect();
    let judged: Vec<&SnapshotEntry> = ordered
        .iter()
        .copied()
        .filter(|entry| entry.taken_at_ms <= now_ms)
        .collect();
    if let Some(newest) = judged.first() {
        kept.insert(newest.name);
    }
    let rules: [(usize, Period); 3] = [
        (KEEP_DAILY, day),
        (KEEP_WEEKLY, iso_week),
        (KEEP_MONTHLY, month),
    ];
    for (count, period) in rules {
        let mut last: Option<i64> = None;
        let mut periods = 0;
        for entry in &judged {
            let this = period(entry.taken_at_ms);
            if last == Some(this) {
                continue;
            }
            if periods == count {
                break;
            }
            periods += 1;
            last = Some(this);
            kept.insert(entry.name);
        }
    }

    let (keep, drop): (Vec<Name>, Vec<Name>) = ordered
        .iter()
        .map(|entry| entry.name)
        .partition(|name| kept.contains(name));
    Keep { keep, drop }
}

/// Every name a destination must keep: the given manifests and every name
/// they reference, and every name the content implies.
#[must_use]
pub fn live_names(
    keys: &BackupKeys,
    manifests_and_ranges: impl IntoIterator<Item = Name>,
    content: impl IntoIterator<Item = (PlaintextHash, u64)>,
) -> BTreeSet<Name> {
    let mut live: BTreeSet<Name> = manifests_and_ranges.into_iter().collect();
    for (h, len) in content {
        live.extend(names_of(keys, &h, len));
    }
    live
}

/// What a destination lists beyond the live set.
#[must_use]
pub fn garbage(listed: impl IntoIterator<Item = Name>, live: &BTreeSet<Name>) -> Vec<Name> {
    let mut out: Vec<Name> = listed
        .into_iter()
        .filter(|name| !live.contains(name))
        .collect();
    out.sort();
    out.dedup();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOUR_MS: u64 = 60 * 60 * 1000;

    /// 2026-10-03T12:00:00Z, a Saturday.
    const NOW_MS: u64 = 1_791_028_800_000;

    fn name_at(taken_at_ms: u64) -> Name {
        Name::from_bytes(*PlaintextHash::of(&taken_at_ms.to_be_bytes()).as_bytes())
    }

    fn entry(taken_at_ms: u64) -> SnapshotEntry {
        SnapshotEntry {
            name: name_at(taken_at_ms),
            taken_at_ms,
            registered_at_ms: taken_at_ms,
        }
    }

    /// `YYYY-MM-DDTHH:00Z` to milliseconds, through the same day arithmetic
    /// run backwards — checked against two fixed points below.
    fn at(year: i64, month: i64, day: i64, hour: u64) -> u64 {
        let y = if month <= 2 { year - 1 } else { year };
        let era = y.div_euclid(400);
        let yoe = y - era * 400;
        let mp = (month + 9) % 12;
        let doy = (153 * mp + 2) / 5 + day - 1;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        let days = era * 146_097 + doe - 719_468;
        u64::try_from(days).expect("after 1970") * DAY_MS + hour * HOUR_MS
    }

    #[test]
    fn the_calendar_arithmetic_is_right_at_its_edges() {
        assert_eq!(at(1970, 1, 1, 0), 0);
        assert_eq!(at(2026, 10, 3, 12), NOW_MS);
        assert_eq!(month(at(2026, 10, 3, 12)), 2026 * 12 + 9);
        assert_eq!(month(at(2024, 2, 29, 23)), 2024 * 12 + 1, "a leap day");
        assert_eq!(month(at(2024, 3, 1, 0)), 2024 * 12 + 2);
        // 2026-09-28 is a Monday and 2026-10-04 a Sunday: one ISO week.
        assert_eq!(iso_week(at(2026, 9, 28, 0)), iso_week(at(2026, 10, 4, 23)));
        assert_ne!(iso_week(at(2026, 9, 27, 23)), iso_week(at(2026, 9, 28, 0)));
    }

    /// **The acceptance case, under a fixed clock.** Hourly snapshots for 400
    /// days keep exactly 7 daily, the 2 weekly and 4 monthly ones the daily
    /// rule did not already keep — 13 in all — and drop every other.
    #[test]
    fn hourly_snapshots_for_400_days_keep_exactly_the_seventeen_rules_union() {
        let entries: Vec<SnapshotEntry> = (0..400 * 24)
            .map(|hours_ago| entry(NOW_MS - hours_ago * HOUR_MS))
            .collect();
        let decided = keep(&entries, NOW_MS);
        let expected: BTreeSet<Name> = [
            // Daily: today's newest, then 23:00 of each of the six days before.
            at(2026, 10, 3, 12),
            at(2026, 10, 2, 23),
            at(2026, 10, 1, 23),
            at(2026, 9, 30, 23),
            at(2026, 9, 29, 23),
            at(2026, 9, 28, 23),
            at(2026, 9, 27, 23),
            // Weekly: this week and last are already kept; two more Sundays.
            at(2026, 9, 20, 23),
            at(2026, 9, 13, 23),
            // Monthly: October and September are already kept.
            at(2026, 8, 31, 23),
            at(2026, 7, 31, 23),
            at(2026, 6, 30, 23),
            at(2026, 5, 31, 23),
        ]
        .into_iter()
        .map(name_at)
        .collect();
        assert_eq!(
            decided.keep.iter().copied().collect::<BTreeSet<_>>(),
            expected
        );
        assert_eq!(decided.keep.len(), 13);
        assert_eq!(decided.drop.len(), entries.len() - 13);
        assert_eq!(decided.keep[0], name_at(NOW_MS), "newest first");
    }

    /// A month offline does not cost the history: periods with no snapshot do
    /// not count.
    #[test]
    fn a_gap_does_not_spend_the_periods() {
        let mut entries: Vec<SnapshotEntry> =
            (1..=10).map(|day| entry(at(2026, 8, day, 9))).collect();
        entries.push(entry(NOW_MS));
        let decided = keep(&entries, NOW_MS);
        // Daily: today and the six most recent days before the gap. Weekly
        // adds August 2, the newest of the week of July 27; the newest of the
        // two later weeks are already kept. Counted back from `now` instead,
        // the daily rule would keep today alone.
        let expected: BTreeSet<Name> = [
            NOW_MS,
            at(2026, 8, 10, 9),
            at(2026, 8, 9, 9),
            at(2026, 8, 8, 9),
            at(2026, 8, 7, 9),
            at(2026, 8, 6, 9),
            at(2026, 8, 5, 9),
            at(2026, 8, 2, 9),
        ]
        .into_iter()
        .map(name_at)
        .collect();
        assert_eq!(
            decided.keep.iter().copied().collect::<BTreeSet<_>>(),
            expected
        );
    }

    #[test]
    fn the_newest_is_always_kept_and_the_future_is_never_judged() {
        let only = [entry(NOW_MS - 400 * DAY_MS)];
        assert_eq!(keep(&only, NOW_MS).keep, vec![only[0].name]);
        assert_eq!(keep(&[], NOW_MS), Keep::default());

        let ahead = entry(NOW_MS + 30 * DAY_MS);
        let mut entries: Vec<SnapshotEntry> =
            (0..20).map(|day| entry(NOW_MS - day * DAY_MS)).collect();
        entries.push(ahead);
        let decided = keep(&entries, NOW_MS);
        assert!(decided.keep.contains(&ahead.name));
        assert!(
            decided.keep.contains(&name_at(NOW_MS)),
            "the newest judged one"
        );
    }

    #[test]
    fn garbage_is_exactly_what_the_live_set_does_not_name() {
        let keys = BackupKeys::from_root(&[1; 32]);
        let photo = PlaintextHash::of(b"a photograph");
        let kept_manifest = name_at(1);
        let kept_range = name_at(2);
        let live = live_names(&keys, [kept_manifest, kept_range], [(photo, 10)]);
        assert_eq!(live.len(), 3);
        let dropped_manifest = name_at(3);
        let dropped_range = name_at(4);
        let photo_name = names_of(&keys, &photo, 10)[0];
        let listed = [
            kept_manifest,
            dropped_range,
            photo_name,
            kept_range,
            dropped_manifest,
            dropped_range,
        ];
        let mut expected = vec![dropped_manifest, dropped_range];
        expected.sort();
        assert_eq!(garbage(listed, &live), expected);
    }
}
