//! WHEN A TASK FALLS ON A MEMBER'S CALENDAR — in the zone the device states,
//! computed here so no shell does civil arithmetic (#1046, the Tasks arm).
//!
//! `mobile/shared`'s `commonMain` has no calendar, zone or date-time library by
//! design, and the Tasks screens still sort by the member's LOCAL day, say
//! "overdue", group Upcoming by day and print "09:00". v0 did that arithmetic
//! on the phone with the host zone and got "today" wrong for every member east
//! of UTC at night (the audit's "UTC today" defect). So the core answers those
//! readings in the request's zone, from this module, and a screen reads
//! strings. Every function is pure: a zone, a stored value, an instant in,
//! civil text out.
//!
//! ## The two spellings a `due_at` has
//!
//! | Stored | What it is | Its local day | Its local time |
//! |---|---|---|---|
//! | `YYYY-MM-DD` | a CIVIL DATE — the same day in every zone | the date as stored | none |
//! | `YYYY-MM-DDTHH:MM…` | an INSTANT (`parse_instant_ms`: no designator reads as UTC) | the instant's day in the request zone | the instant's wall clock there |
//!
//! **The task's own `tz` is not the display zone.** It is the zone the
//! recurrence expands in ([`crate::queries`]' `recurrence_of`); a due instant
//! is the same instant everywhere, and a member reads it in the zone the
//! device is in now.
//!
//! ## The effective due
//!
//! A repeating task's next open period (`next_due`, from the one engine's
//! collapse) stands in for its stored `due_at`, exactly as v0's
//! `next_due ?? due_at` did — so a daily task that was due last Tuesday reads
//! as due today with its missed periods counted, never as a week overdue.

use centraid_vault::time::recurrence::parse_instant_ms;
use centraid_vault::time::zone::{FireZone, WallTime, parse_wall_iso, wall_epoch, wall_iso};

/// One civil day, in milliseconds.
const DAY_MS: i64 = 86_400_000;

/// A stored date or instant, read in one zone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Civil {
    /// The civil day, midnight.
    pub day: WallTime,
    /// The wall clock, when the value was an instant.
    pub time: Option<WallTime>,
}

impl Civil {
    /// `YYYY-MM-DD`.
    #[must_use]
    pub fn day_text(&self) -> String {
        wall_iso(self.day, false)
    }

    /// `YYYY-MM-DDTHH:MM`, or `YYYY-MM-DD` for a civil date.
    #[must_use]
    pub fn local_text(&self) -> String {
        self.time.map_or_else(
            || self.day_text(),
            |wall| format!("{}T{:02}:{:02}", self.day_text(), wall.hour, wall.minute),
        )
    }

    /// `HH:MM`, or empty for a civil date.
    #[must_use]
    pub fn time_text(&self) -> String {
        self.time
            .map(|wall| format!("{:02}:{:02}", wall.hour, wall.minute))
            .unwrap_or_default()
    }
}

const fn midnight(value: WallTime) -> WallTime {
    WallTime {
        hour: 0,
        minute: 0,
        second: 0,
        millisecond: 0,
        ..value
    }
}

/// Read a stored date or instant in `zone`. `None` when it does not parse —
/// a value the `due_at` CHECK refuses, placed nowhere rather than guessed at.
#[must_use]
pub fn read(value: &str, zone: &FireZone) -> Option<Civil> {
    if value.len() == 10 {
        let day = parse_wall_iso(value)?;
        return Some(Civil {
            day: midnight(day),
            time: None,
        });
    }
    let millis = parse_instant_ms(value)?;
    let wall = zone.zoned_parts(millis);
    Some(Civil {
        day: midnight(wall),
        time: Some(wall),
    })
}

/// The civil day `now` is in `zone`.
#[must_use]
pub fn today(zone: &FireZone, now: &str) -> Option<Civil> {
    parse_instant_ms(now).map(|millis| {
        let wall = zone.zoned_parts(millis);
        Civil {
            day: midnight(wall),
            time: Some(wall),
        }
    })
}

/// Whole CIVIL days from `from` to `to`, negative when `to` is earlier.
///
/// Counted on the wall calendar, never as instants divided by 24 hours: across
/// a spring-forward a local day is 23 hours long, and dividing would call
/// tomorrow "today".
#[must_use]
pub fn days_between(from: WallTime, to: WallTime) -> i64 {
    (wall_epoch(midnight(to)) - wall_epoch(midnight(from))).div_euclid(DAY_MS)
}

/// Where a task's due falls, relative to today, in one zone.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DuePlacement {
    /// `YYYY-MM-DD`; empty when the task is undated.
    pub due_day: String,
    /// `YYYY-MM-DDTHH:MM`, or `YYYY-MM-DD` for a date-only due; empty when
    /// undated.
    pub due_local: String,
    /// `HH:MM`; empty for a date-only due or an undated task.
    pub due_time: String,
    /// Civil days from today to the due day; `None` when undated.
    pub days_from_today: Option<i64>,
    /// The due day is before today.
    pub overdue: bool,
    /// The due day is today or before — v0's `landsToday`, which Today draws.
    pub lands_today: bool,
    /// When the reminder fires, `YYYY-MM-DDTHH:MM` in the zone; empty when the
    /// task carries no lead time or no moment to count back from. A date-only
    /// due has no moment (see `remind_at`).
    pub remind_at_local: String,
}

/// Place a task's EFFECTIVE due (`next_due`, else `due_at`) in `zone`.
#[must_use]
pub fn place_due(
    effective_due: Option<&str>,
    remind_before_min: Option<i64>,
    zone: &FireZone,
    today: &Civil,
) -> DuePlacement {
    let Some(civil) = effective_due.and_then(|due| read(due, zone)) else {
        return DuePlacement::default();
    };
    let days = days_between(today.day, civil.day);
    DuePlacement {
        due_day: civil.day_text(),
        due_local: civil.local_text(),
        due_time: civil.time_text(),
        days_from_today: Some(days),
        overdue: days < 0,
        lands_today: days <= 0,
        remind_at_local: effective_due
            .and_then(|due| remind_at(due, remind_before_min?, zone))
            .unwrap_or_default(),
    }
}

/// The wall clock a reminder fires at: the due INSTANT less the lead time,
/// read in `zone`.
///
/// **A date-only due has no moment to count back from**, so it answers
/// `None` rather than inventing a time of day for it (an open question to the
/// owner, in the crate README).
#[must_use]
pub fn remind_at(due: &str, lead_minutes: i64, zone: &FireZone) -> Option<String> {
    if due.len() == 10 {
        return None;
    }
    let millis = parse_instant_ms(due)? - lead_minutes.checked_mul(60_000)?;
    let wall = zone.zoned_parts(millis);
    Some(format!(
        "{}T{:02}:{:02}",
        wall_iso(wall, false),
        wall.hour,
        wall.minute
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn zone(name: &str) -> FireZone {
        FireZone::named(name).expect("a real zone")
    }

    #[test]
    fn a_civil_date_is_the_same_day_in_every_zone() {
        for name in ["Pacific/Auckland", "America/Los_Angeles", "Etc/UTC"] {
            let civil = read("2099-06-10", &zone(name)).expect("a date");
            assert_eq!(civil.day_text(), "2099-06-10");
            assert_eq!(civil.local_text(), "2099-06-10");
            assert_eq!(civil.time_text(), "");
        }
    }

    #[test]
    fn an_instant_reads_on_the_local_day_of_the_request_zone() {
        // 02:30Z on the 11th is 22:30 on the 10th in New York (EDT).
        let civil =
            read("2099-06-11T02:30:00.000Z", &zone("America/New_York")).expect("an instant");
        assert_eq!(civil.local_text(), "2099-06-10T22:30");
        assert_eq!(civil.time_text(), "22:30");
    }

    /// THE SAME UTC HOUR READS AN HOUR APART ACROSS DST, and a civil day count
    /// across the spring-forward (a 23-hour local day) is still one per day.
    #[test]
    fn the_fold_follows_daylight_saving() {
        let new_york = zone("America/New_York");
        let winter = read("2099-01-15T14:00:00.000Z", &new_york).expect("winter");
        let summer = read("2099-07-15T14:00:00.000Z", &new_york).expect("summer");
        assert_eq!(winter.time_text(), "09:00", "EST is UTC-5");
        assert_eq!(summer.time_text(), "10:00", "EDT is UTC-4");
        // 2099's spring-forward in New York is Sunday 8 March.
        let before = read("2099-03-07T17:00:00.000Z", &new_york).expect("before");
        let after = read("2099-03-09T16:00:00.000Z", &new_york).expect("after");
        assert_eq!(days_between(before.day, after.day), 2);
        assert_eq!(before.time_text(), "12:00");
        assert_eq!(after.time_text(), "12:00");
    }

    #[test]
    fn overdue_is_a_civil_day_before_today_and_today_lands() {
        let new_york = zone("America/New_York");
        // 02:00Z on the 2nd is still the 1st, 22:00, in New York.
        let today = today(&new_york, "2099-06-02T02:00:00.000Z").expect("now");
        assert_eq!(today.day_text(), "2099-06-01");
        let yesterday = place_due(Some("2099-05-31"), None, &new_york, &today);
        assert!(yesterday.overdue && yesterday.lands_today);
        assert_eq!(yesterday.days_from_today, Some(-1));
        let tonight = place_due(Some("2099-06-02T01:00:00.000Z"), None, &new_york, &today);
        assert!(
            !tonight.overdue && tonight.lands_today,
            "21:00 on the 1st, local"
        );
        let tomorrow = place_due(Some("2099-06-02"), None, &new_york, &today);
        assert!(!tomorrow.lands_today);
        assert_eq!(tomorrow.days_from_today, Some(1));
        assert_eq!(
            place_due(None, Some(10), &new_york, &today),
            DuePlacement::default()
        );
    }

    #[test]
    fn a_reminder_counts_back_from_a_moment_and_a_date_has_none() {
        let new_york = zone("America/New_York");
        assert_eq!(
            remind_at("2099-06-10T13:00:00.000Z", 30, &new_york).as_deref(),
            Some("2099-06-10T08:30")
        );
        assert_eq!(remind_at("2099-06-10", 30, &new_york), None);
    }
}
