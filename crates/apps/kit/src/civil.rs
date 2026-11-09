//! THE VAULT'S CIVIL CLOCK, FOR EVERY APP: the day an instant falls on in a member's zone, the wall
//! clock it reads there, and the first instant of a day. Pure: a zone and an instant in, civil
//! text out. It lived in Agenda's crate and moved here when Agenda became Calendar and Reminders,
//! because Docs, Health, Money, People, Notes and Locker read it too.

use centraid_vault::clock::format_iso_ms;
use centraid_vault::time::recurrence::parse_instant_ms;
use centraid_vault::time::zone::{FireZone, WallTime, wall_epoch, wall_iso};

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

pub const fn midnight(day: WallTime) -> WallTime {
    WallTime {
        hour: 0,
        minute: 0,
        second: 0,
        millisecond: 0,
        ..day
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn zone(name: &str) -> FireZone {
        FireZone::named(name).expect("a real zone")
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
}
