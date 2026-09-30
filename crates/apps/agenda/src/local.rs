//! WHERE AN OCCURRENCE FALLS ON A MEMBER'S CALENDAR — in the zone the device
//! states, computed here so no shell does civil arithmetic (#1046).
//!
//! `mobile/shared`'s `commonMain` has no calendar, zone or date-time library by
//! design (`sync/Instants.kt`'s header), and an Agenda screen still has to
//! group occurrences by the member's LOCAL day, draw a now line and print
//! "08:15". So the core answers those in the request's zone, from this module,
//! and a screen reads strings. Every function is pure: a zone, a row, an
//! instant in, civil text out.
//!
//! ## The three readings, and what each one's end means
//!
//! | `recurrence_semantics` | start and end are | `local_start` / `local_end` | the days it occupies |
//! |---|---|---|---|
//! | `zoned` | instants | the instants' wall clock in the request zone, `YYYY-MM-DDTHH:MM` | start day through the day of the end, the end EXCLUSIVE — a run that ends exactly at local midnight does not occupy the next day |
//! | `floating` | wall clocks with no zone (a trailing `Z` is ignored, as [`parse_wall_iso`] ignores it) | the stored wall clock, the same in every zone | as `zoned`, on the wall clock |
//! | `all-day` | civil dates | the dates, `YYYY-MM-DD` | start through end, **the end INCLUSIVE** |
//!
//! **An all-day `dtend` is the LAST day, not the day after it.** That is the
//! vault's own reading and v0's, stated where v0 stated it — `bucketByDay`'s
//! "All-day civil `dtend` is inclusive" and the phone's "end inclusive" test —
//! and it is the reading [`crate::expansion::event_duration_ms`] already
//! carries into every occurrence: a one-day event stores `dtend = dtstart`,
//! which `core_event`'s `dtend >= dtstart` CHECK admits. iCal's exclusive
//! `DTEND;VALUE=DATE` is an import's to convert, not a reader's to guess at.
//!
//! ## An interval, for the true lower bound
//!
//! [`interval_ms`] is the same placement as two instants, `[start, end)`,
//! which is what `upcoming`'s lower bound compares against `from`. A floating
//! wall clock and an all-day date are read in the REQUEST zone there — the
//! only zone in which "has this already ended" has an answer for them.

use centraid_vault::clock::format_iso_ms;
use centraid_vault::time::recurrence::{Semantics, parse_instant_ms};
use centraid_vault::time::zone::{
    FireZone, WallTime, add_wall_days, parse_wall_iso, wall_epoch, wall_from_epoch, wall_iso,
};

use crate::queries::EventRow;

/// Where one occurrence falls, in one zone.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Placement {
    /// `YYYY-MM-DDTHH:MM`, or `YYYY-MM-DD` for an all-day event.
    pub local_start: String,
    /// The same spelling as `local_start`; EMPTY when the row states no end.
    /// An all-day end is the last day, inclusive.
    pub local_end: String,
    /// Every civil day the occurrence occupies, in order, `YYYY-MM-DD`.
    pub local_days: Vec<String>,
    /// `recurrence_semantics` is `all-day`: a day, never a clock time.
    pub all_day: bool,
}

/// `YYYY-MM-DD`.
#[must_use]
pub fn civil_day(wall: WallTime) -> String {
    wall_iso(wall, false)
}

/// `YYYY-MM-DDTHH:MM` — minutes are what a member reads; seconds never are.
#[must_use]
pub fn civil_minute(wall: WallTime) -> String {
    format!("{}T{:02}:{:02}", civil_day(wall), wall.hour, wall.minute)
}

/// The civil day an instant falls on in `zone`, `YYYY-MM-DD`.
#[must_use]
pub fn today(zone: &FireZone, now: &str) -> Option<String> {
    parse_instant_ms(now).map(|millis| civil_day(zone.zoned_parts(millis)))
}

/// The wall clock an instant reads in `zone`, `YYYY-MM-DDTHH:MM`.
#[must_use]
pub fn now_local(zone: &FireZone, now: &str) -> Option<String> {
    parse_instant_ms(now).map(|millis| civil_minute(zone.zoned_parts(millis)))
}

/// The instant a civil wall clock names in `zone`, under the vault's DST
/// policy: a fold resolves to the EARLIER instant
/// ([`FireZone::resolve_wall_time`]). A wall clock in a spring-forward GAP
/// exists at no instant, and for a BOUND — which is all this is used for —
/// the gap's end stands in for it: the naive clock read at the offset in force
/// before the change, which lands just past the gap.
#[must_use]
pub fn instant_of_wall(zone: &FireZone, wall: WallTime) -> i64 {
    zone.resolve_wall_time(wall)
        .and_then(|resolved| parse_instant_ms(&resolved.instant))
        .unwrap_or_else(|| {
            let naive = wall_epoch(wall);
            naive - i64::from(zone.offset_minutes(naive)) * 60_000
        })
}

/// The FIRST instant of a civil day in `zone`, as the vault spells an instant.
/// Midnight, unless the zone skips midnight that day — then the gap's end.
#[must_use]
pub fn start_of_day(zone: &FireZone, day: WallTime) -> String {
    format_iso_ms(instant_of_wall(zone, midnight(day)))
}

const fn midnight(day: WallTime) -> WallTime {
    WallTime {
        hour: 0,
        minute: 0,
        second: 0,
        millisecond: 0,
        ..day
    }
}

/// The occurrence's start and end as civil wall clocks in `zone`, and whether
/// the end was stated. `None` when the start does not parse — a row no
/// command writes, placed nowhere rather than guessed at.
fn walls(event: &EventRow, zone: &FireZone) -> Option<(WallTime, WallTime, bool)> {
    let stated = event.dtend.is_some();
    if event.semantics() == Semantics::Zoned {
        // Compared as INSTANTS, then read: across a fall-back an end can read
        // earlier on the wall than a start it follows.
        let (start, end) = interval_ms(event, zone)?;
        return Some((zone.zoned_parts(start), zone.zoned_parts(end), stated));
    }
    let all_day = event.semantics() == Semantics::AllDay;
    let read =
        |value: &str| parse_wall_iso(value).map(|wall| if all_day { midnight(wall) } else { wall });
    let start = read(&event.dtstart)?;
    // An end before its start is the start (v0's `end < start` guard): the
    // CHECK refuses one, and a placement never runs backwards.
    let end = event
        .dtend
        .as_deref()
        .and_then(read)
        .filter(|end| *end >= start)
        .unwrap_or(start);
    Some((start, end, stated))
}

/// Where `event` falls in `zone`. `None` when its start does not parse.
#[must_use]
pub fn place(event: &EventRow, zone: &FireZone) -> Option<Placement> {
    let (start, end, stated) = walls(event, zone)?;
    let all_day = event.semantics() == Semantics::AllDay;
    let format = |wall: WallTime| {
        if all_day {
            civil_day(wall)
        } else {
            civil_minute(wall)
        }
    };
    // THE LAST DAY: an all-day end is inclusive; a timed end is exclusive, so
    // a run ending exactly at midnight stops on the day before — and a
    // zero-length event occupies its own day.
    let last = if all_day || end == start {
        end
    } else {
        wall_from_epoch(wall_epoch(end) - 1)
    };
    let mut local_days = Vec::new();
    let mut cursor = midnight(start);
    let last = midnight(last);
    while cursor <= last {
        local_days.push(civil_day(cursor));
        cursor = add_wall_days(cursor, 1);
    }
    Some(Placement {
        local_start: format(start),
        local_end: if stated { format(end) } else { String::new() },
        local_days,
        all_day,
    })
}

/// The occurrence as instants, `[start, end)`, reading a floating wall clock
/// and an all-day date in `zone`. An all-day run ends at the first instant
/// AFTER its last day. `None` when its start does not parse.
#[must_use]
pub fn interval_ms(event: &EventRow, zone: &FireZone) -> Option<(i64, i64)> {
    if event.semantics() == Semantics::Zoned {
        let start = parse_instant_ms(&event.dtstart)?;
        let end = event
            .dtend
            .as_deref()
            .and_then(parse_instant_ms)
            .filter(|end| *end >= start)
            .unwrap_or(start);
        return Some((start, end));
    }
    let (start, end, _) = walls(event, zone)?;
    let end = if event.semantics() == Semantics::AllDay {
        add_wall_days(end, 1)
    } else {
        end
    };
    Some((instant_of_wall(zone, start), instant_of_wall(zone, end)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn zone(name: &str) -> FireZone {
        FireZone::named(name).expect("a real zone")
    }

    fn event(semantics: &str, start: &str, end: Option<&str>) -> EventRow {
        EventRow {
            event_id: "e".to_owned(),
            dtstart: start.to_owned(),
            dtend: end.map(str::to_owned),
            recurrence_semantics: Some(semantics.to_owned()),
            ..EventRow::default()
        }
    }

    fn placed(zone_name: &str, row: &EventRow) -> Placement {
        place(row, &zone(zone_name)).expect("the start parses")
    }

    #[test]
    fn a_zoned_event_reads_in_the_request_zone() {
        // 13:15Z is 09:15 in New York (EDT) and 14:15 in London (BST).
        let row = event(
            "zoned",
            "2026-06-10T13:15:00.000Z",
            Some("2026-06-10T14:00:00.000Z"),
        );
        let new_york = placed("America/New_York", &row);
        assert_eq!(new_york.local_start, "2026-06-10T09:15");
        assert_eq!(new_york.local_end, "2026-06-10T10:00");
        assert_eq!(new_york.local_days, ["2026-06-10"]);
        assert!(!new_york.all_day);
        assert_eq!(
            placed("Europe/London", &row).local_start,
            "2026-06-10T14:15"
        );
    }

    #[test]
    fn a_late_evening_instant_is_on_the_previous_local_day() {
        // 02:30Z on the 11th is 22:30 on the 10th in New York.
        let row = event("zoned", "2026-06-11T02:30:00.000Z", None);
        let new_york = placed("America/New_York", &row);
        assert_eq!(new_york.local_start, "2026-06-10T22:30");
        assert_eq!(new_york.local_end, "", "no end is stated, so none is drawn");
        assert_eq!(new_york.local_days, ["2026-06-10"]);
    }

    #[test]
    fn a_run_ending_exactly_at_local_midnight_does_not_occupy_the_next_day() {
        // 20:00–00:00 London time (BST, UTC+1) on the 10th.
        let row = event(
            "zoned",
            "2026-06-10T19:00:00.000Z",
            Some("2026-06-10T23:00:00.000Z"),
        );
        let london = placed("Europe/London", &row);
        assert_eq!(london.local_end, "2026-06-11T00:00");
        assert_eq!(london.local_days, ["2026-06-10"]);
        // One minute more and it does.
        let longer = event(
            "zoned",
            "2026-06-10T19:00:00.000Z",
            Some("2026-06-10T23:01:00.000Z"),
        );
        assert_eq!(
            placed("Europe/London", &longer).local_days,
            ["2026-06-10", "2026-06-11"]
        );
    }

    #[test]
    fn a_multi_day_run_occupies_every_day_in_the_middle() {
        // Friday 22:00 to Sunday 09:00, New York.
        let row = event(
            "zoned",
            "2026-08-22T02:00:00.000Z",
            Some("2026-08-23T13:00:00.000Z"),
        );
        assert_eq!(
            placed("America/New_York", &row).local_days,
            ["2026-08-21", "2026-08-22", "2026-08-23"]
        );
    }

    #[test]
    fn the_london_spring_forward_day_is_one_day_and_keeps_its_wall_clock() {
        // 29 March 2026: London goes 01:00 GMT → 02:00 BST. 00:30Z is 00:30
        // GMT; 09:00Z is 10:00 BST. One day, 23 hours long.
        let row = event(
            "zoned",
            "2026-03-29T00:30:00.000Z",
            Some("2026-03-29T09:00:00.000Z"),
        );
        let london = placed("Europe/London", &row);
        assert_eq!(london.local_start, "2026-03-29T00:30");
        assert_eq!(london.local_end, "2026-03-29T10:00");
        assert_eq!(london.local_days, ["2026-03-29"]);
    }

    #[test]
    fn the_new_york_fall_back_day_places_both_one_thirties() {
        // 1 November 2026: 01:30 happens twice in New York — 05:30Z (EDT)
        // and 06:30Z (EST). Both read 01:30 on the same day.
        for instant in ["2026-11-01T05:30:00.000Z", "2026-11-01T06:30:00.000Z"] {
            let row = event("zoned", instant, None);
            let new_york = placed("America/New_York", &row);
            assert_eq!(new_york.local_start, "2026-11-01T01:30");
            assert_eq!(new_york.local_days, ["2026-11-01"]);
        }
        // The day starts at 04:00Z (EDT midnight) and the next at 05:00Z
        // (EST midnight): the day is 25 hours long, and still one day.
        let day = parse_wall_iso("2026-11-01").expect("a day");
        assert_eq!(
            start_of_day(&zone("America/New_York"), day),
            "2026-11-01T04:00:00.000Z"
        );
        assert_eq!(
            start_of_day(&zone("America/New_York"), add_wall_days(day, 1)),
            "2026-11-02T05:00:00.000Z"
        );
    }

    #[test]
    fn a_new_york_spring_forward_gap_bound_lands_past_the_gap() {
        // 8 March 2026 02:30 does not exist in New York; as a bound it reads
        // as 03:30 EDT — past the gap, never before it.
        let gap = parse_wall_iso("2026-03-08T02:30:00").expect("a wall clock");
        assert_eq!(
            format_iso_ms(instant_of_wall(&zone("America/New_York"), gap)),
            "2026-03-08T07:30:00.000Z"
        );
    }

    #[test]
    fn a_floating_event_is_the_same_wall_clock_in_every_zone() {
        // A trailing `Z` on a floating row is ignored, as the engine ignores
        // it: a floating 09:00 is 09:00 wherever the member is.
        let row = event(
            "floating",
            "2026-06-10T09:00:00.000Z",
            Some("2026-06-10T10:30:00.000Z"),
        );
        for name in ["America/New_York", "Asia/Kolkata", "Etc/UTC"] {
            let placement = placed(name, &row);
            assert_eq!(placement.local_start, "2026-06-10T09:00");
            assert_eq!(placement.local_end, "2026-06-10T10:30");
            assert_eq!(placement.local_days, ["2026-06-10"]);
        }
        // …and its INTERVAL is read in the zone: 09:00 in New York is 13:00Z.
        let (start, end) = interval_ms(&row, &zone("America/New_York")).expect("the start parses");
        assert_eq!(format_iso_ms(start), "2026-06-10T13:00:00.000Z");
        assert_eq!(format_iso_ms(end), "2026-06-10T14:30:00.000Z");
    }

    #[test]
    fn an_all_day_run_is_dates_with_its_end_inclusive() {
        let row = event("all-day", "2026-08-21", Some("2026-08-23"));
        let placement = placed("America/New_York", &row);
        assert!(placement.all_day);
        assert_eq!(placement.local_start, "2026-08-21");
        assert_eq!(placement.local_end, "2026-08-23", "the LAST day");
        assert_eq!(
            placement.local_days,
            ["2026-08-21", "2026-08-22", "2026-08-23"]
        );
        // A one-day event stores its day twice, and occupies it once.
        let one = placed(
            "Asia/Kolkata",
            &event("all-day", "2026-08-21", Some("2026-08-21")),
        );
        assert_eq!(one.local_days, ["2026-08-21"]);
        // Its interval is the whole last day, in the zone: it ends at New
        // York's midnight AFTER the 23rd.
        let (start, end) = interval_ms(&row, &zone("America/New_York")).expect("the start parses");
        assert_eq!(format_iso_ms(start), "2026-08-21T04:00:00.000Z");
        assert_eq!(format_iso_ms(end), "2026-08-24T04:00:00.000Z");
    }

    #[test]
    fn today_and_now_are_the_zones_reading_of_the_vault_clock() {
        // 03:10Z on the 11th is still the 10th in New York, and already the
        // 11th in Kolkata.
        let now = "2026-06-11T03:10:00.000Z";
        let new_york = zone("America/New_York");
        assert_eq!(today(&new_york, now).as_deref(), Some("2026-06-10"));
        assert_eq!(
            now_local(&new_york, now).as_deref(),
            Some("2026-06-10T23:10")
        );
        assert_eq!(
            now_local(&zone("Asia/Kolkata"), now).as_deref(),
            Some("2026-06-11T08:40")
        );
    }

    #[test]
    fn a_start_that_does_not_parse_is_placed_nowhere() {
        assert_eq!(
            place(&event("zoned", "not a date", None), &zone("Etc/UTC")),
            None
        );
    }
}
