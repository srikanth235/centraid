//! THE ONE CIVIL-TIME READER (#1135).
//!
//! [`parse_instant_ms`] reads a datetime with no zone designator as UTC, which
//! is right for the instants the vault itself writes (`...Z`) and wrong for the
//! text a member types: Tasks stores a due as `2026-10-22T09:00`, and that is
//! 09:00 on the member's wall, not on Greenwich's. Read as UTC it showed 09:00
//! in New York as 05:00.
//!
//! [`parse_civil_ms`] is the reader for text that may be either:
//!
//! | Text | Reading |
//! |---|---|
//! | `YYYY-MM-DD` | UTC midnight, as [`parse_instant_ms`]; a caller that means a civil DATE reads it as one first |
//! | `…THH:MM[:SS[.fff]]Z` or `±HH:MM` | the instant it names |
//! | `…THH:MM[:SS[.fff]]` | the member's wall clock in `zone` |
//!
//! A wall time that does not exist (the spring-forward gap) is read with the
//! offset in force just before the gap, which lands it at the same elapsed
//! time after the change: 02:30 on a gap day reads as 03:30. A wall time that
//! happens twice (the autumn fold) is the EARLIER of the two, as
//! [`FireZone::resolve_wall_time`] says.

use super::recurrence::parse_instant_ms;
use super::zone::{FireZone, parse_wall_iso, wall_epoch};

/// Whether a datetime text names its own zone: a `Z`, or a `+HH:MM` / `-HH:MM`
/// after the `T`. A bare date has none, and is not a datetime.
#[must_use]
pub fn has_zone_designator(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() < 16 || bytes[10] != b'T' {
        return false;
    }
    let tail = &value[11..];
    tail.ends_with('Z') || tail.contains('+') || tail.contains('-')
}

/// A date or datetime as an instant, a zone-less wall time read in `zone`.
#[must_use]
pub fn parse_civil_ms(value: &str, zone: &FireZone) -> Option<i64> {
    if value.len() == 10 || has_zone_designator(value) {
        return parse_instant_ms(value);
    }
    let wall = parse_wall_iso(value)?;
    if let Some(resolved) = zone.resolve_wall_time(wall) {
        return parse_instant_ms(&resolved.instant);
    }
    // THE GAP: no instant carries this wall clock. The offset a day earlier is
    // the one in force before the change.
    let naive = wall_epoch(wall);
    Some(naive - i64::from(zone.offset_minutes(naive - 86_400_000)) * 60_000)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn zone(name: &str) -> FireZone {
        FireZone::named(name).expect("a real zone")
    }

    #[test]
    fn a_wall_time_is_the_zones_and_a_designator_is_the_instants() {
        let new_york = zone("America/New_York");
        // 09:00 EDT is 13:00Z.
        assert_eq!(
            parse_civil_ms("2026-10-22T09:00", &new_york),
            parse_instant_ms("2026-10-22T13:00:00.000Z")
        );
        assert_eq!(
            parse_civil_ms("2026-10-22T09:00:00Z", &new_york),
            parse_instant_ms("2026-10-22T09:00:00Z")
        );
        assert_eq!(
            parse_civil_ms("2026-10-22T09:00:00-05:00", &new_york),
            parse_instant_ms("2026-10-22T14:00:00Z")
        );
        assert_eq!(
            parse_civil_ms("2026-10-22", &new_york),
            parse_instant_ms("2026-10-22")
        );
        assert_eq!(parse_civil_ms("tomorrow", &new_york), None);
    }

    #[test]
    fn the_gap_reads_after_the_change_and_the_fold_the_earlier_instant() {
        let new_york = zone("America/New_York");
        // 2026-03-08 02:30 does not exist in New York; it reads as 03:30 EDT.
        assert_eq!(
            parse_civil_ms("2026-03-08T02:30", &new_york),
            parse_instant_ms("2026-03-08T07:30:00.000Z")
        );
        // 2026-11-01 01:30 happens twice; the earlier is EDT, 05:30Z.
        assert_eq!(
            parse_civil_ms("2026-11-01T01:30", &new_york),
            parse_instant_ms("2026-11-01T05:30:00.000Z")
        );
    }
}
