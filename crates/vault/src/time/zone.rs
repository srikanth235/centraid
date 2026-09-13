//! The vault's zone, and civil time under it (#1020, D-1020-S2, D-1020-S8).
//!
//! ## One zone source, moved here so there is only one
//!
//! [`FireZone`] and [`ZoneUnset`] were `crates/automations::cron`'s. They are
//! this module's now, and `crates/automations::cron` re-exports them, because
//! recurrence needs the SAME resolution cron already had and a second reader
//! would be exactly the drift `docs/cron-timezone.md` was written about. The
//! direction is forced: `crates/automations` → `crates/assist` →
//! `crates/vault`, so the shared type can only live at the bottom.
//!
//! Two tiers, and a refusal where v0's third was (`docs/cron-timezone.md:17`
//! -`:21`): the caller's own zone (a trigger's `tz`, a series' `start_tz`, a
//! task's `tz`), then **the vault's** — `core_vault.settings_json`'s zone —
//! and then nothing. v0's tier 3 read the HOST's clock, which on a VPS is UTC,
//! so "every morning at seven" silently became seven in a place nobody lives.
//!
//! **The host's clock zone is unreachable from this crate by construction**:
//! `jiff` is depended on with `default-features = false` and without
//! `tz-system`, so no code path — ours or the library's — can read `TZ` or
//! `/etc/localtime`. The database is `tzdb-bundle-always`, compiled in.
//!
//! ## The DST policy, shared with cron
//!
//! `docs/cron-timezone.md:13`, three sentences, and this module is the
//! recurrence side of them:
//!
//! - a **nonexistent** wall time (the spring-forward gap) is SKIPPED — it
//!   exists at no instant, so nothing can deliver it;
//! - an **overlapping** wall time (the autumn fold) occurs ONCE, at the
//!   EARLIER instant;
//! - a per-instance exception keys off the **unmodified original**
//!   occurrence, even when an override moves what the member sees
//!   ([`super::occurrence`]).

use std::fmt;

use jiff::Timestamp;
use jiff::civil::Weekday;
use jiff::tz::TimeZone;

/// The wall-clock fields a cron expression is matched against.
///
/// Cron's reading of a civil instant: whole minutes, plus the weekday cron
/// counts from Sunday. [`WallTime`] is recurrence's reading of the same thing
/// and carries milliseconds; the two are separate because a cron field is
/// never sub-minute and an occurrence always is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WallClock {
    pub year: i16,
    pub month: i8,
    pub day: i8,
    pub hour: i8,
    pub minute: i8,
    /// 0 = Sunday … 6 = Saturday, as cron counts.
    pub weekday: i8,
}

/// A CIVIL CLOCK VALUE — never an instant.
///
/// v0's `WallTime` (`packages/core/src/time/timezone.ts:1`-`:9`). A rule
/// expands in wall clock, so this is what identifies an occurrence, and
/// re-anchoring a series must not orphan its exceptions
/// (`packages/core/src/time/occurrence.ts:28`-`:32`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct WallTime {
    pub year: i64,
    pub month: i64,
    pub day: i64,
    pub hour: i64,
    pub minute: i64,
    pub second: i64,
    pub millisecond: i64,
}

/// A civil clock value resolved into an instant, and whether the wall clock it
/// came from happens twice that day.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedWallTime {
    /// `YYYY-MM-DDTHH:MM:SS.mmmZ`, the one instant spelling this tree writes.
    pub instant: String,
    /// The autumn fold: the same wall clock exists at two instants and this is
    /// the EARLIER of them.
    pub overlap: bool,
}

/// A zone that resolved. The newtype exists so a resolved zone cannot be
/// confused with a name a manifest happened to carry.
#[derive(Debug, Clone)]
pub struct FireZone {
    name: String,
    zone: TimeZone,
}

impl FireZone {
    /// Look up an IANA name in the **bundled** zone database.
    pub fn named(name: &str) -> Result<Self, ZoneUnset> {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err(ZoneUnset::Missing);
        }
        TimeZone::get(trimmed)
            .map(|zone| Self {
                name: trimmed.to_owned(),
                zone,
            })
            .map_err(|_| ZoneUnset::Unknown {
                name: trimmed.to_owned(),
            })
    }

    /// The two tiers, in order. `trigger_tz` is the caller's — a cron
    /// trigger's `tz`, an event's `start_tz`, a task's `tz`; `vault_zone` is
    /// `core_vault.settings_json`'s. **There is no third argument** — that is
    /// the deletion, expressed in the signature.
    ///
    /// An INVALID caller zone is not silently demoted to the vault's: a
    /// manifest that names `Asia/Calcutta/2` meant something, and firing it in
    /// another zone would be answering a question nobody asked. Manifest
    /// validation refuses it first; this refusal is the backstop for a row
    /// that predates the check.
    pub fn resolve(trigger_tz: Option<&str>, vault_zone: Option<&str>) -> Result<Self, ZoneUnset> {
        if let Some(name) = trigger_tz.map(str::trim).filter(|name| !name.is_empty()) {
            return Self::named(name);
        }
        match vault_zone.map(str::trim).filter(|name| !name.is_empty()) {
            Some(name) => Self::named(name),
            None => Err(ZoneUnset::Missing),
        }
    }

    #[must_use]
    pub fn name(&self) -> &str {
        &self.name
    }

    /// The resolved `jiff` zone.
    ///
    /// Exposed because `crates/automations::cron` walks civil DATES through it
    /// (a day's own span is 23, 24 or 25 hours, and that is how both copies of
    /// a fall-back minute land in one walk). It is not a hole in the two-tier
    /// rule: a `TimeZone` can only be obtained by resolving one, and the
    /// bundled database is the only source this build links.
    #[must_use]
    pub const fn time_zone(&self) -> &TimeZone {
        &self.zone
    }

    /// The wall-clock fields at an instant, in this zone.
    #[must_use]
    pub fn wall_clock(&self, millis: i64) -> WallClock {
        let stamp = Timestamp::from_millisecond(millis).unwrap_or(Timestamp::UNIX_EPOCH);
        let civil = self.zone.to_datetime(stamp);
        WallClock {
            year: civil.year(),
            month: civil.month(),
            day: civil.day(),
            hour: civil.hour(),
            minute: civil.minute(),
            weekday: sunday_zero(civil.weekday()),
        }
    }

    /// The full civil reading of an instant in this zone — v0's `zonedParts`
    /// (`timezone.ts:43`). Milliseconds come from the INSTANT rather than the
    /// zone, exactly as v0's `date.getUTCMilliseconds()` does: no zone on
    /// earth has a sub-second offset.
    #[must_use]
    pub fn zoned_parts(&self, millis: i64) -> WallTime {
        let stamp = Timestamp::from_millisecond(millis).unwrap_or(Timestamp::UNIX_EPOCH);
        let civil = self.zone.to_datetime(stamp);
        WallTime {
            year: i64::from(civil.year()),
            month: i64::from(civil.month()),
            day: i64::from(civil.day()),
            hour: i64::from(civil.hour()),
            minute: i64::from(civil.minute()),
            second: i64::from(civil.second()),
            millisecond: millis.rem_euclid(1_000),
        }
    }

    /// The zone's offset from UTC in minutes at an instant. The DST detector's
    /// input: a fall-back is an offset that decreased.
    #[must_use]
    pub fn offset_minutes(&self, millis: i64) -> i32 {
        let stamp = Timestamp::from_millisecond(millis).unwrap_or(Timestamp::UNIX_EPOCH);
        self.zone.to_offset(stamp).seconds() / 60
    }

    /// The zone's offset from UTC in milliseconds at an instant.
    fn offset_ms(&self, millis: i64) -> i64 {
        wall_epoch(self.zoned_parts(millis)) - millis
    }

    /// RESOLVE A CIVIL CLOCK VALUE INTO AN INSTANT — the DST policy, in one
    /// function (v0's `resolveWallTime`, `timezone.ts:96`).
    ///
    /// A **gap** returns `None`: the wall time exists at no instant, so there
    /// is nothing to deliver and nothing to pretend. An **overlap** returns
    /// the EARLIER of the two instants with `overlap: true`, so a caller can
    /// explain it and a window cannot emit the occurrence twice.
    ///
    /// The three probes are v0's, kept rather than swapped for `jiff`'s own
    /// ambiguity API, because the parity corpus is generated from v0 and the
    /// two must answer identically on every case in it — including the ones a
    /// library's "compatible" disambiguation would round the other way.
    #[must_use]
    pub fn resolve_wall_time(&self, value: WallTime) -> Option<ResolvedWallTime> {
        let naive = wall_epoch(value);
        let mut offsets = [
            self.offset_ms(naive.saturating_sub(86_400_000)),
            self.offset_ms(naive),
            self.offset_ms(naive.saturating_add(86_400_000)),
        ];
        offsets.sort_unstable();
        let mut candidates: Vec<i64> = offsets
            .into_iter()
            .map(|offset| naive - offset)
            .filter(|candidate| self.zoned_parts(*candidate) == value)
            .collect();
        candidates.sort_unstable();
        candidates.dedup();
        let first = *candidates.first()?;
        Some(ResolvedWallTime {
            instant: crate::clock::format_iso_ms(first),
            overlap: candidates.len() > 1,
        })
    }

    /// The dedupe key a fall-back's two absolute minutes share.
    ///
    /// v0's `wallClockMinuteKey`, with one difference: the zone name is always
    /// present, because there is no `"local"` case left to spell.
    #[must_use]
    pub fn wall_minute_key(&self, millis: i64) -> String {
        let wall = self.wall_clock(millis);
        format!(
            "{}:{}:{}:{}:{}:{}",
            wall.year, wall.month, wall.day, wall.hour, wall.minute, self.name
        )
    }
}

impl PartialEq for FireZone {
    fn eq(&self, other: &Self) -> bool {
        self.name == other.name
    }
}

impl Eq for FireZone {}

impl fmt::Display for FireZone {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(&self.name)
    }
}

/// Where v0's tier 3 was. **A typed refusal, surfaced as a system signal** —
/// never a fallback, and never a log line.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ZoneUnset {
    /// Neither the trigger nor the vault names a zone.
    #[error(
        "this schedule cannot be set until this vault has a time zone: the trigger names none and \
         this vault's settings name none, and the machine's own clock is not an answer — a \
         gateway on a server runs in UTC, so \"every morning at seven\" would mean seven in a \
         place nobody lives"
    )]
    Missing,
    /// A name that is not in the bundled zone database.
    #[error(
        "\"{name}\" is not a time zone this build knows; schedules are resolved against a zone \
         database compiled into the binary, so the answer does not change when a host is \
         reinstalled"
    )]
    Unknown { name: String },
}

/// Cron's weekday numbering, from `jiff`'s. Exported because
/// `crates/automations::cron` walks civil dates with it.
#[must_use]
pub const fn sunday_zero(weekday: Weekday) -> i8 {
    match weekday {
        Weekday::Sunday => 0,
        Weekday::Monday => 1,
        Weekday::Tuesday => 2,
        Weekday::Wednesday => 3,
        Weekday::Thursday => 4,
        Weekday::Friday => 5,
        Weekday::Saturday => 6,
    }
}

/// Is `value` an IANA name this build knows?
#[must_use]
pub fn is_iana_time_zone(value: &str) -> bool {
    FireZone::named(value).is_ok()
}

// ---------------------------------------------------------------------------
// Civil arithmetic. All of it in wall clock, none of it through an instant.
// ---------------------------------------------------------------------------

/// The wall clock's own epoch: what `Date.UTC(y, m-1, d, …)` returns.
///
/// **This is not an instant.** It is a total order over civil clock values,
/// which is all the expander needs to step, compare and sort them; converting
/// to an instant is [`FireZone::resolve_wall_time`]'s job and happens once,
/// at the end.
#[must_use]
pub fn wall_epoch(value: WallTime) -> i64 {
    crate::clock::days_from_civil(value.year, value.month, value.day) * 86_400_000
        + value.hour * 3_600_000
        + value.minute * 60_000
        + value.second * 1_000
        + value.millisecond
}

/// The inverse: the civil fields of a wall epoch.
#[must_use]
pub fn wall_from_epoch(millis: i64) -> WallTime {
    let days = millis.div_euclid(86_400_000);
    let rest = millis.rem_euclid(86_400_000);
    let (year, month, day) = crate::clock::civil_from_days(days);
    WallTime {
        year,
        month,
        day,
        hour: rest / 3_600_000,
        minute: (rest % 3_600_000) / 60_000,
        second: (rest % 60_000) / 1_000,
        millisecond: rest % 1_000,
    }
}

/// v0's `parseWallIso` (`timezone.ts:119`): `YYYY-MM-DD` with an optional
/// `THH:MM(:SS(.mmm)?)?` tail, and **a round-trip check** so `2026-02-31` is
/// refused rather than normalised into March.
///
/// A trailing `Z` or offset is IGNORED, exactly as v0's regex ignores it: the
/// caller that wants an instant parses one, and the caller that wants the
/// series' wall clock wants these fields.
#[must_use]
pub fn parse_wall_iso(value: &str) -> Option<WallTime> {
    let bytes = value.as_bytes();
    if bytes.len() < 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let year: i64 = digits(value.get(0..4)?)?;
    let month: i64 = digits(value.get(5..7)?)?;
    let day: i64 = digits(value.get(8..10)?)?;
    let (hour, minute, second, millisecond) = if bytes.get(10) == Some(&b'T') {
        if bytes.len() < 16 || bytes[13] != b':' {
            return None;
        }
        let hour: i64 = digits(value.get(11..13)?)?;
        let minute: i64 = digits(value.get(14..16)?)?;
        let (second, millisecond) = if bytes.get(16) == Some(&b':') {
            let second: i64 = digits(value.get(17..19)?)?;
            let millisecond = if bytes.get(19) == Some(&b'.') {
                let mut taken = String::new();
                for byte in bytes.iter().skip(20).take(3) {
                    if !byte.is_ascii_digit() {
                        break;
                    }
                    taken.push(char::from(*byte));
                }
                if taken.is_empty() {
                    return None;
                }
                // `.5` is 500 ms, as `padEnd(3, "0")` reads it.
                while taken.len() < 3 {
                    taken.push('0');
                }
                digits(&taken)?
            } else {
                0
            };
            (second, millisecond)
        } else {
            (0, 0)
        };
        (hour, minute, second, millisecond)
    } else {
        (0, 0, 0, 0)
    };
    let parsed = WallTime {
        year,
        month,
        day,
        hour,
        minute,
        second,
        millisecond,
    };
    // THE ROUND TRIP IS THE CALENDAR CHECK. `Date.UTC` normalises February 31
    // into March 3 and only the comparison notices.
    let round_trip = wall_from_epoch(wall_epoch(parsed));
    if round_trip.year != parsed.year
        || round_trip.month != parsed.month
        || round_trip.day != parsed.day
    {
        return None;
    }
    Some(parsed)
}

fn digits(text: &str) -> Option<i64> {
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

/// v0's `wallIso` (`timezone.ts:145`). Milliseconds appear only when non-zero,
/// which is the spelling every stored occurrence key already carries.
#[must_use]
pub fn wall_iso(value: WallTime, include_time: bool) -> String {
    let date = format!("{:04}-{:02}-{:02}", value.year, value.month, value.day);
    if !include_time {
        return date;
    }
    let milliseconds = if value.millisecond > 0 {
        format!(".{:03}", value.millisecond)
    } else {
        String::new()
    };
    format!(
        "{date}T{:02}:{:02}:{:02}{milliseconds}",
        value.hour, value.minute, value.second
    )
}

/// Add whole days in wall clock. Never through an instant, so a DST day is
/// still one day long here — which is the whole point: a 09:00 series stays a
/// 09:00 series across the change.
#[must_use]
pub fn add_wall_days(value: WallTime, days: i64) -> WallTime {
    wall_from_epoch(wall_epoch(value) + days * 86_400_000)
}

/// Add whole months in wall clock, CLAMPING the day to the target month's
/// last: a series anchored on the 31st lands on the 30th in a 30-day month
/// rather than rolling into the next one (v0's `addWallMonths`).
#[must_use]
pub fn add_wall_months(value: WallTime, months: i64) -> WallTime {
    let zero_based = value.year * 12 + (value.month - 1) + months;
    let year = zero_based.div_euclid(12);
    let month = zero_based.rem_euclid(12) + 1;
    let last_day = days_in_month(year, month);
    WallTime {
        year,
        month,
        day: value.day.min(last_day),
        ..value
    }
}

/// 0 = Sunday … 6 = Saturday, for a civil date.
#[must_use]
pub fn wall_weekday(value: WallTime) -> i64 {
    // 1970-01-01 was a Thursday (4).
    (wall_epoch(value).div_euclid(86_400_000) + 4).rem_euclid(7)
}

const fn is_leap_year(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

const fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 31,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_gap_wall_time_resolves_to_nothing() {
        // 2026-03-08 02:30 does not exist in New York: the clock jumps 02:00
        // to 03:00.
        let zone = FireZone::named("America/New_York").expect("a real zone");
        let gap = parse_wall_iso("2026-03-08T02:30:00").expect("a wall clock");
        assert_eq!(zone.resolve_wall_time(gap), None);
    }

    #[test]
    fn an_overlapping_wall_time_resolves_once_at_the_earlier_instant() {
        // 2026-11-01 01:30 happens twice in New York.
        let zone = FireZone::named("America/New_York").expect("a real zone");
        let fold = parse_wall_iso("2026-11-01T01:30:00").expect("a wall clock");
        let resolved = zone.resolve_wall_time(fold).expect("a fold still occurs");
        assert!(resolved.overlap, "the fold is marked");
        // EDT is UTC-4, EST is UTC-5; the earlier instant is the EDT one.
        assert_eq!(resolved.instant, "2026-11-01T05:30:00.000Z");
    }

    #[test]
    fn an_ordinary_wall_time_resolves_unambiguously() {
        let zone = FireZone::named("Asia/Kolkata").expect("a real zone");
        let wall = parse_wall_iso("2026-06-01T09:00:00").expect("a wall clock");
        let resolved = zone.resolve_wall_time(wall).expect("an ordinary day");
        assert!(!resolved.overlap);
        assert_eq!(resolved.instant, "2026-06-01T03:30:00.000Z");
    }

    #[test]
    fn february_thirty_first_is_refused_rather_than_normalised() {
        assert_eq!(parse_wall_iso("2026-02-31"), None);
        assert!(parse_wall_iso("2028-02-29").is_some(), "a leap day is real");
        assert_eq!(parse_wall_iso("2027-02-29"), None);
    }

    #[test]
    fn a_monthly_step_clamps_rather_than_rolling_over() {
        let anchor = parse_wall_iso("2026-01-31T09:00:00").expect("a wall clock");
        assert_eq!(
            wall_iso(add_wall_months(anchor, 1), true),
            "2026-02-28T09:00:00"
        );
        assert_eq!(
            wall_iso(add_wall_months(anchor, 2), true),
            "2026-03-31T09:00:00"
        );
        assert_eq!(
            wall_iso(add_wall_months(anchor, -1), true),
            "2025-12-31T09:00:00"
        );
    }

    #[test]
    fn the_weekday_is_sunday_zero() {
        // 2026-01-04 is a Sunday.
        let sunday = parse_wall_iso("2026-01-04").expect("a date");
        assert_eq!(wall_weekday(sunday), 0);
        assert_eq!(wall_weekday(add_wall_days(sunday, 5)), 5);
    }

    #[test]
    fn there_is_no_third_tier() {
        assert_eq!(FireZone::resolve(None, None), Err(ZoneUnset::Missing));
        assert_eq!(
            FireZone::resolve(Some("Mars/Olympus"), Some("Asia/Kolkata")),
            Err(ZoneUnset::Unknown {
                name: "Mars/Olympus".to_owned()
            }),
            "an invalid caller zone is refused, never demoted to the vault's"
        );
        assert_eq!(
            FireZone::resolve(None, Some("Asia/Kolkata"))
                .expect("the vault's zone")
                .name(),
            "Asia/Kolkata"
        );
    }

    #[test]
    fn a_wall_clock_round_trips_through_its_epoch() {
        for text in [
            "2026-03-01T09:00:00.500",
            "2026-12-31T23:59:59",
            "1970-01-01T00:00:00",
            "2026-03-01",
        ] {
            let wall = parse_wall_iso(text).expect(text);
            assert_eq!(wall_from_epoch(wall_epoch(wall)), wall, "{text}");
        }
    }
}
