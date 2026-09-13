//! The cron cursor: which minutes are due, and which of them is delivered
//! (#1020, D-1020-AU2).
//!
//! ## Three properties, and the bug each one is
//!
//! 1. **A cron reader owns its whole `(cursor, now]` window.** Resuming at
//!    10:00 still catches the 09:00 due instant; matching only the current
//!    minute would defer it a day.
//! 2. **Matching ANY schedule makes a minute due ONCE.** An automation with
//!    two cron triggers that both match 09:00 is one fire.
//! 3. **A fall-back's repeat is the same wall minute, and the EARLIER copy
//!    survives.** `dueInstants` deduped only inside its own window, and a
//!    running scheduler ticks once a minute — so the two absolute minutes
//!    sharing a wall clock landed in two different windows, each deduped
//!    perfectly against itself, and the automation fired twice (#846 P2).
//!    [`read`] carries the memory ACROSS windows and **derives** it: when, and
//!    only when, a schedule's zone actually moved its clock back inside the
//!    last three hours, the reader re-walks the window behind its cursor and
//!    drops any candidate whose wall keys were all covered there. The cursor
//!    row stays a bare millisecond position, so there is no watermark to
//!    migrate.
//!
//! The gap row needs no code: a wall minute that exists at no instant cannot
//! be produced by any number of windows.

use std::collections::BTreeSet;

use crate::cron::{self, FireZone, MINUTE_MS, floor_minute};
use crate::manifest::{Backfill, MAX_BACKFILL_OCCURRENCES};

use super::cursor::{CursorElement, CursorRead, StoredCursor};

/// One cron expression with its zone and class, resolved ONCE at registration.
///
/// The reader never re-derives the default class (`docs/cron-timezone.md`
/// Backfill classes), and it never re-resolves the zone — a registration is
/// where `ZoneUnset` is decided, so by the time a schedule exists its zone
/// does too.
#[derive(Debug, Clone, PartialEq)]
pub struct Schedule {
    pub expr: String,
    pub zone: FireZone,
    pub backfill: Backfill,
}

/// Bounds a synchronous scan from an old cursor: 31 days. Past it only the
/// missed-run COUNT degrades, to a floor.
const MAX_SCAN_MINUTES: i64 = 44_640;

/// An idle cron row is refreshed at most hourly, so an automation that fires
/// once a day does not upsert its cursor 1,440 times.
const IDLE_POSITION_REFRESH_MS: i64 = 60 * 60 * 1_000;

/// No DST shift has ever exceeded two hours, so three covers every overlap.
const DST_OVERLAP_LOOKBACK_MS: i64 = 3 * 60 * 60 * 1_000;

/// The wall keys of every schedule that matches this instant.
fn wall_keys_at(schedules: &[Schedule], instant: i64) -> Vec<String> {
    schedules
        .iter()
        .filter(|schedule| cron::matches(&schedule.expr, instant, &schedule.zone))
        .map(|schedule| schedule.zone.wall_minute_key(instant))
        .collect()
}

/// Did any schedule's zone move its clock BACK between `to - span` and `to`?
fn fell_back_within(schedules: &[Schedule], to: i64, span: i64) -> bool {
    schedules
        .iter()
        .any(|schedule| schedule.zone.offset_minutes(to) < schedule.zone.offset_minutes(to - span))
}

/// Every instant in `(from, to]` at which any schedule is due, oldest first,
/// deduped by wall minute.
#[must_use]
pub fn due_instants(schedules: &[Schedule], from: i64, to: i64) -> Vec<i64> {
    let to = floor_minute(to);
    let earliest = floor_minute(from).max(to - MAX_SCAN_MINUTES * MINUTE_MS);
    let mut matched: Vec<(i64, Vec<String>)> = Vec::new();
    let mut instant = to;
    while instant > earliest {
        let keys = wall_keys_at(schedules, instant);
        if !keys.is_empty() {
            matched.push((instant, keys));
        }
        instant -= MINUTE_MS;
    }
    matched.reverse();
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for (at, keys) in matched {
        let mut novel = false;
        for key in keys {
            if seen.insert(key) {
                novel = true;
            }
        }
        if novel {
            out.push(at);
        }
    }
    out
}

/// `due_instants` plus the cross-window fall-back memory.
fn deliverable_instants(schedules: &[Schedule], from: i64, to: i64) -> Vec<i64> {
    let due = due_instants(schedules, from, to);
    if due.is_empty() || !fell_back_within(schedules, to, DST_OVERLAP_LOOKBACK_MS) {
        return due;
    }
    let mut prior = BTreeSet::new();
    let mut instant = floor_minute(from);
    while instant > from - DST_OVERLAP_LOOKBACK_MS {
        for key in wall_keys_at(schedules, instant) {
            prior.insert(key);
        }
        instant -= MINUTE_MS;
    }
    due.into_iter()
        .filter(|candidate| {
            wall_keys_at(schedules, *candidate)
                .into_iter()
                .any(|key| !prior.contains(&key))
        })
        .collect()
}

/// Read the cron source at `at`, given what the cursor row holds.
///
/// Cron is a **virtual source computed on read**: there is no table of due
/// minutes, so the reader is a pure function of the schedules, the stored
/// position and the clock.
#[must_use]
pub fn read(schedules: &[Schedule], cursor: Option<&StoredCursor>, at: i64) -> CursorRead {
    let to = floor_minute(at);
    let stored = cursor.and_then(|row| row.position_json.as_deref());
    let from = stored
        .and_then(|json| serde_json::from_str::<i64>(json).ok())
        .unwrap_or(to - MINUTE_MS);
    let due = deliverable_instants(schedules, from, to);
    // THE BACKFILL CLASS (#1014, R-1014-9). `each` on any schedule makes the
    // whole registration `each`: the registrations collapse into one cursor,
    // so the stronger promise wins rather than the first-declared one.
    let each = schedules
        .iter()
        .any(|schedule| schedule.backfill == Backfill::Each);
    let Some(&latest) = due.last() else {
        let bootstrap = stored.is_none();
        return CursorRead {
            position_json: (bootstrap || to - from >= IDLE_POSITION_REFRESH_MS)
                .then(|| to.to_string()),
            ..CursorRead::default()
        };
    };
    // Newest occurrences win the budget: a catch-up that can only deliver
    // twenty-four is more useful ending at NOW than ending three days ago.
    let delivered: Vec<i64> = if each {
        due.iter()
            .skip(due.len().saturating_sub(MAX_BACKFILL_OCCURRENCES))
            .copied()
            .collect()
    } else {
        vec![latest]
    };
    let skipped = u32::try_from(due.len().saturating_sub(delivered.len())).unwrap_or(u32::MAX);
    CursorRead {
        elements: delivered
            .into_iter()
            .map(|instant| CursorElement {
                position: instant.to_string(),
                occurred_at: instant,
                payload: None,
                position_json: None,
            })
            .collect(),
        position_json: Some(to.to_string()),
        window_from: Some(from),
        window_to: Some(to),
        skipped,
        gap_reason: (skipped > 0).then(|| "scheduler_gap".to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn schedule(expr: &str, zone: &str, backfill: Backfill) -> Schedule {
        Schedule {
            expr: expr.to_owned(),
            zone: FireZone::named(zone).expect("bundled"),
            backfill,
        }
    }

    fn stored(position: i64) -> StoredCursor {
        StoredCursor {
            source_kind: "cron".to_owned(),
            position_json: Some(position.to_string()),
            ..StoredCursor::default()
        }
    }

    #[test]
    fn a_reader_owns_its_whole_window_and_the_default_class_delivers_the_newest() {
        let schedules = [schedule("0 * * * *", "UTC", Backfill::Latest)];
        // Cursor at 08:00, now 10:30: 09:00 and 10:00 are both due.
        let base = 1_767_225_600_000; // 2026-01-01T00:00:00Z
        let cursor = stored(base + 8 * 60 * MINUTE_MS);
        let result = super::read(
            &schedules,
            Some(&cursor),
            base + 10 * 60 * MINUTE_MS + 30 * MINUTE_MS,
        );
        assert_eq!(result.elements.len(), 1, "latest collapses the catch-up");
        assert_eq!(result.elements[0].occurred_at, base + 10 * 60 * MINUTE_MS);
        assert_eq!(result.skipped, 1);
        assert_eq!(result.gap_reason.as_deref(), Some("scheduler_gap"));
        assert_eq!(result.window_from, Some(base + 8 * 60 * MINUTE_MS));
    }

    #[test]
    fn the_each_class_delivers_every_missed_occurrence_up_to_the_bound() {
        let schedules = [schedule("0 * * * *", "UTC", Backfill::Each)];
        let base = 1_767_225_600_000;
        let cursor = stored(base);
        let result = super::read(&schedules, Some(&cursor), base + 5 * 60 * MINUTE_MS);
        assert_eq!(
            result.elements.len(),
            5,
            "five missed hours are five reminders"
        );
        assert_eq!(result.skipped, 0);
        assert!(result.gap_reason.is_none());
        // Past the bound the remainder is still a gap.
        let long = super::read(&schedules, Some(&stored(base)), base + 40 * 60 * MINUTE_MS);
        assert_eq!(long.elements.len(), MAX_BACKFILL_OCCURRENCES);
        assert_eq!(long.skipped, 40 - MAX_BACKFILL_OCCURRENCES as u32);
        // And the newest win: the LAST element is the most recent hour.
        assert_eq!(
            long.elements.last().expect("one").occurred_at,
            base + 40 * 60 * MINUTE_MS
        );
    }

    /// `each` on ANY schedule makes the registration `each`.
    #[test]
    fn a_mixed_registration_takes_the_stronger_class() {
        let schedules = [
            schedule("0 * * * *", "UTC", Backfill::Latest),
            schedule("30 * * * *", "UTC", Backfill::Each),
        ];
        let base = 1_767_225_600_000;
        let result = super::read(&schedules, Some(&stored(base)), base + 3 * 60 * MINUTE_MS);
        assert!(result.elements.len() > 1, "{}", result.elements.len());
    }

    #[test]
    fn two_schedules_matching_one_minute_are_one_fire() {
        let schedules = [
            schedule("0 9 * * *", "UTC", Backfill::Latest),
            schedule("0 9 * * 1-5", "UTC", Backfill::Latest),
        ];
        let base = 1_767_225_600_000; // a Thursday
        let due = due_instants(&schedules, base, base + 24 * 60 * MINUTE_MS);
        assert_eq!(due.len(), 1);
        assert_eq!(due[0], base + 9 * 60 * MINUTE_MS);
    }

    /// THE #846 BUG, held as the property it is: a window WIDE enough to hold
    /// both copies delivers one, and the two one-minute windows a running
    /// scheduler actually takes deliver one between them.
    #[test]
    fn an_overlapping_wall_minute_fires_once_across_windows() {
        let schedules = [schedule("30 1 * * *", "America/New_York", Backfill::Latest)];
        let day_start = 1_793_505_600_000; // 2026-11-01T04:00:00Z == 00:00 EDT
        // One wide window: both absolute 01:30s are inside it.
        let wide = super::read(
            &schedules,
            Some(&stored(day_start)),
            day_start + 6 * 60 * MINUTE_MS,
        );
        assert_eq!(wide.elements.len(), 1, "one wall minute, one fire");
        // A continuous minute-by-minute tick across the shift.
        let mut fired = Vec::new();
        let mut position = day_start;
        for minute in 1..=(6 * 60) {
            let at = day_start + minute * MINUTE_MS;
            let result = super::read(&schedules, Some(&stored(position)), at);
            for element in &result.elements {
                fired.push(element.occurred_at);
            }
            if let Some(json) = result.position_json {
                position = json.parse().expect("a millisecond position");
            }
        }
        assert_eq!(
            fired.len(),
            1,
            "a continuous tick across a fall-back fires once: {fired:?}"
        );
        // And it is the EARLIER instant (docs/cron-timezone.md DST policy).
        let both: Vec<i64> = (0..6 * 60)
            .map(|minute| day_start + minute * MINUTE_MS)
            .filter(|at| cron::matches("30 1 * * *", *at, &schedules[0].zone))
            .collect();
        assert_eq!(both.len(), 2);
        assert_eq!(fired[0], both[0], "the earlier copy survives");
    }

    #[test]
    fn a_nonexistent_wall_minute_is_never_delivered() {
        let schedules = [schedule("30 2 * * *", "America/New_York", Backfill::Each)];
        let day_start = 1_772_946_000_000; // 2026-03-08T05:00:00Z == 00:00 EST
        let result = super::read(
            &schedules,
            Some(&stored(day_start)),
            day_start + 23 * 60 * MINUTE_MS,
        );
        assert!(
            result.elements.is_empty(),
            "02:30 does not exist on this day in this zone"
        );
    }

    /// A half-hour zone and a negative-DST zone, because both have broken
    /// wall-clock arithmetic before (`time-zoo-cron.test.ts`).
    #[test]
    fn a_half_hour_zone_and_a_southern_hemisphere_zone_both_hold() {
        for (zone, expr) in [
            ("Asia/Kolkata", "0 7 * * *"),
            ("Australia/Lord_Howe", "0 7 * * *"),
            ("Pacific/Chatham", "45 6 * * *"),
            ("America/Sao_Paulo", "0 7 * * *"),
        ] {
            let schedules = [schedule(expr, zone, Backfill::Each)];
            let base = 1_767_225_600_000;
            let result = super::read(
                &schedules,
                Some(&stored(base)),
                base + 3 * 24 * 60 * MINUTE_MS,
            );
            assert_eq!(result.elements.len(), 3, "{zone} fires once a day");
            for element in &result.elements {
                let wall = schedules[0].zone.wall_clock(element.occurred_at);
                let expected: i8 = expr
                    .split_whitespace()
                    .nth(1)
                    .and_then(|hour| hour.parse().ok())
                    .expect("an hour field");
                assert_eq!(wall.hour, expected, "{zone}");
            }
        }
    }

    #[test]
    fn a_bootstrap_read_records_its_position_and_fires_nothing_old() {
        let schedules = [schedule("0 3 * * *", "UTC", Backfill::Each)];
        let base = 1_767_225_600_000 + 10 * 60 * MINUTE_MS; // 10:00
        let result = super::read(&schedules, None, base);
        assert!(
            result.elements.is_empty(),
            "a fresh cursor's window is one minute, not the whole journal"
        );
        assert_eq!(
            result.position_json.as_deref(),
            Some(base.to_string().as_str())
        );
    }

    #[test]
    fn an_idle_minute_writes_nothing_and_an_idle_hour_refreshes() {
        let schedules = [schedule("0 3 * * *", "UTC", Backfill::Latest)];
        let base = 1_767_225_600_000 + 10 * 60 * MINUTE_MS;
        let quiet = super::read(&schedules, Some(&stored(base - MINUTE_MS)), base);
        assert!(quiet.elements.is_empty());
        assert!(
            quiet.position_json.is_none(),
            "an idle cron minute must not upsert the row 1,440 times a day"
        );
        let hour = super::read(&schedules, Some(&stored(base - 61 * MINUTE_MS)), base);
        assert!(hour.position_json.is_some());
    }

    /// A cursor from before an outage: the scan is bounded, and past the bound
    /// only the COUNT degrades.
    #[test]
    fn a_very_old_cursor_is_bounded_and_the_newest_minute_still_fires() {
        let schedules = [schedule("0 * * * *", "UTC", Backfill::Latest)];
        let now = 1_800_000_000_000;
        let ancient = now - 120 * 24 * 60 * MINUTE_MS;
        let result = super::read(&schedules, Some(&stored(ancient)), now);
        assert_eq!(result.elements.len(), 1);
        assert_eq!(result.elements[0].occurred_at, floor_minute(now));
        assert!(
            result.skipped > 0 && result.skipped < 31 * 24,
            "{}",
            result.skipped
        );
    }

    #[test]
    fn an_unreadable_stored_position_falls_back_to_one_minute() {
        let schedules = [schedule("* * * * *", "UTC", Backfill::Latest)];
        let base = 1_767_225_600_000;
        let corrupt = StoredCursor {
            source_kind: "cron".to_owned(),
            position_json: Some("{not a number".to_owned()),
            ..StoredCursor::default()
        };
        let result = super::read(&schedules, Some(&corrupt), base);
        assert_eq!(
            result.elements.len(),
            1,
            "a corrupt position must not replay a month"
        );
    }
}
