//! Time and identity as injected facts.
//!
//! `committed_at`, `occurred_at` and every id the vault mints come from here,
//! never from `SystemTime::now()` or a random source called inline. Two
//! reasons, and the second is the load-bearing one:
//!
//! - A test that cannot fix the clock cannot assert on a retention edge, and
//!   the retention rules are *about* an edge (a cutoff, a 14-day hold).
//! - **The vault's zone is the vault's, never the host's.** A gateway on a VPS
//!   runs UTC; v0's `docs/cron-timezone.md` is the whole file this mistake
//!   wrote. Instants here are always UTC and the civil-time conversion is
//!   `crates/automations`' problem, not a stray `chrono::Local`.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// The vault's clock: milliseconds since the Unix epoch, and the text form
/// every timestamp column holds.
pub trait Clock: Send + Sync {
    /// Milliseconds since the Unix epoch, UTC.
    fn now_ms(&self) -> i64;

    /// The text form: `YYYY-MM-DDTHH:MM:SS.mmmZ`, exactly what
    /// `strftime('%Y-%m-%dT%H:%M:%fZ','now')` writes, because the schema's own
    /// defaults write it and a second spelling would sort differently.
    fn now_text(&self) -> String {
        format_iso_ms(self.now_ms())
    }
}

/// A clock or an id source behind an `Arc` is still one.
///
/// This is what lets a test HOLD the clock it gave the vault: `Vault::create_with`
/// takes a `Box<dyn Clock>`, so without this the test would have no handle to
/// advance. And "advance the clock" is not a convenience — the retention rules
/// are about EDGES (a 30-day cutoff, a 14-day hold), and the two are different
/// lengths, so a test that cannot move time cannot have a live cursor and an
/// aged-out row at once.
impl<T: Clock + ?Sized> Clock for std::sync::Arc<T> {
    fn now_ms(&self) -> i64 {
        (**self).now_ms()
    }

    fn now_text(&self) -> String {
        (**self).now_text()
    }
}

impl<T: Ids + ?Sized> Ids for std::sync::Arc<T> {
    fn next(&self) -> String {
        (**self).next()
    }
}

/// The host clock.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        let since = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default();
        i64::try_from(since.as_millis()).unwrap_or(i64::MAX)
    }
}

/// A clock a test sets, and advances when it means to.
#[derive(Debug)]
pub struct FixedClock {
    millis: AtomicU64,
}

impl FixedClock {
    /// A clock stopped at `millis`.
    #[must_use]
    pub const fn at(millis: i64) -> Self {
        Self {
            millis: AtomicU64::new(millis as u64),
        }
    }

    /// A clock stopped at 2026-01-01T00:00:00.000Z — the instant v0's freezer
    /// stamps, so a fixture built on both sides carries one timestamp.
    #[must_use]
    pub const fn frozen() -> Self {
        Self::at(1_767_225_600_000)
    }

    /// Move the clock forward.
    pub fn advance_ms(&self, millis: i64) {
        self.millis
            .fetch_add(millis.unsigned_abs(), Ordering::Relaxed);
    }

    /// Move the clock forward by whole days.
    pub fn advance_days(&self, days: i64) {
        self.advance_ms(days * 86_400_000);
    }
}

impl Clock for FixedClock {
    fn now_ms(&self) -> i64 {
        i64::try_from(self.millis.load(Ordering::Relaxed)).unwrap_or(i64::MAX)
    }
}

/// `YYYY-MM-DDTHH:MM:SS.mmmZ` from epoch milliseconds.
///
/// Written out rather than pulled from a date library because it is the one
/// conversion the vault needs and the schema's own DEFAULT is the spec for it:
/// a dependency here would be a second implementation of `strftime`.
#[must_use]
pub fn format_iso_ms(millis: i64) -> String {
    let (days, time_ms) = {
        let day = millis.div_euclid(86_400_000);
        let rest = millis.rem_euclid(86_400_000);
        (day, rest)
    };
    let (year, month, day) = civil_from_days(days);
    let hour = time_ms / 3_600_000;
    let minute = (time_ms % 3_600_000) / 60_000;
    let second = (time_ms % 60_000) / 1_000;
    let milli = time_ms % 1_000;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{milli:03}Z")
}

/// Parse `YYYY-MM-DDTHH:MM:SS(.mmm)?Z` back to epoch milliseconds.
///
/// Returns `None` for anything that is not that shape — a timestamp column that
/// holds something else is a finding, not a value to guess at.
#[must_use]
pub fn parse_iso_ms(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    if bytes.len() < 20 || bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' {
        return None;
    }
    let year: i64 = text.get(0..4)?.parse().ok()?;
    let month: i64 = text.get(5..7)?.parse().ok()?;
    let day: i64 = text.get(8..10)?.parse().ok()?;
    let hour: i64 = text.get(11..13)?.parse().ok()?;
    let minute: i64 = text.get(14..16)?.parse().ok()?;
    let second: i64 = text.get(17..19)?.parse().ok()?;
    let milli: i64 = if bytes.get(19) == Some(&b'.') {
        text.get(20..23)?.parse().ok()?
    } else {
        0
    };
    Some(
        days_from_civil(year, month, day) * 86_400_000
            + hour * 3_600_000
            + minute * 60_000
            + second * 1_000
            + milli,
    )
}

/// Howard Hinnant's `days_from_civil`, the proleptic Gregorian conversion.
const fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let day_of_year = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// Its inverse, `civil_from_days`.
const fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let shifted = days + 719_468;
    let era = if shifted >= 0 {
        shifted
    } else {
        shifted - 146_096
    } / 146_097;
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = if month_prime < 10 {
        month_prime + 3
    } else {
        month_prime - 9
    };
    (if month <= 2 { year + 1 } else { year }, month, day)
}

/// Where new ids come from.
///
/// A uuid v7 is time-ordered, which the audit band's `seq`-less history relied
/// on before #928 gave it a real chain position. The trait exists so a fixture
/// can be REPLAYED: v0's freezer derives every id from a seed for exactly this
/// reason, and a corpus seeded with randomness re-freezes differently every run.
pub trait Ids: Send + Sync {
    fn next(&self) -> String;
}

/// **The default: uuid v7 off the injected clock, with a per-open random
/// suffix.** What a gateway and a seat mint (#1020 wave 3 lane X3).
///
/// ## Why this exists, and what it replaces
///
/// [`SeededIds`] was the default for `Vault::open` and `Vault::create`, and its
/// counter starts at zero **per instance**. So every open minted the same
/// sequence from the beginning and the first write after ANY reopen asked for
/// an id the first session had already used. Reproduced from Kotlin through
/// the real C ABI by wave 3 lane E:
///
/// ```text
/// Refused(code=63, detail=entity id is already held by another kind: core_party (#916))
/// ```
///
/// A gateway that restarts fails its next write. `crates/vault/src/file.rs`'s
/// reopen test is the red.
///
/// ## The shape
///
/// RFC 9562's layout, and every bit is accounted for:
///
/// * 48 bits — milliseconds since the epoch, **from the injected [`Clock`]**,
///   never `SystemTime::now()` called inline. Time-ordered ids are the whole
///   reason the audit band could read history before #928 gave it a chain
///   position, and a clock a test can hold keeps that assertable.
/// * 4 bits — version `7`.
/// * 12 bits (`rand_a`) — the **per-open suffix**, drawn once when this source
///   is constructed. Two sessions of the same vault in the same millisecond
///   have different ones, which is exactly the collision that was happening.
/// * 2 bits — variant `0b10`.
/// * 62 bits (`rand_b`) — fresh randomness per call. This is what makes a
///   collision improbable rather than merely unlikely: the per-open suffix
///   separates sessions and this separates calls within one.
///
/// Deliberately NOT a counter: a counter is what broke, and a counter mixed in
/// here would make two ids from two opens differ only if the suffix did.
pub struct ClockIds {
    clock: Box<dyn Clock>,
    /// The per-open suffix, 12 bits.
    suffix: u16,
}

impl ClockIds {
    /// A source over an injected clock.
    #[must_use]
    pub fn new(clock: Box<dyn Clock>) -> Self {
        Self {
            clock,
            suffix: rand::random::<u16>() & 0x0fff,
        }
    }

    /// A source over the host clock — what `Vault::open` and `Vault::create`
    /// use when the caller injects nothing.
    #[must_use]
    pub fn system() -> Self {
        Self::new(Box::new(SystemClock))
    }
}

impl std::fmt::Debug for ClockIds {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The suffix is not a secret and printing it is how a support bundle
        // tells two sessions of one vault apart.
        formatter
            .debug_struct("ClockIds")
            .field("suffix", &self.suffix)
            .finish_non_exhaustive()
    }
}

impl Ids for ClockIds {
    fn next(&self) -> String {
        // A clock before the epoch cannot be encoded in an unsigned 48-bit
        // field. Clamped rather than refused: `Ids::next` has no error channel,
        // and a vault whose host clock is set to 1969 has a problem this
        // function is not the place to report.
        let millis = u64::try_from(self.clock.now_ms()).unwrap_or(0) & 0x0000_ffff_ffff_ffff;
        let rand_b = rand::random::<u64>() & 0x3fff_ffff_ffff_ffff;
        let time_high = (millis >> 16) & 0xffff_ffff;
        let time_low = millis & 0xffff;
        let version_and_a = 0x7000_u16 | self.suffix;
        let variant_and_b_high = 0x8000_u16 | u16::try_from((rand_b >> 48) & 0x3fff).unwrap_or(0);
        let b_low = rand_b & 0x0000_ffff_ffff_ffff;
        format!(
            "{time_high:08x}-{time_low:04x}-{version_and_a:04x}-{variant_and_b_high:04x}-{b_low:012x}"
        )
    }
}

/// Seeded, uuid-v7-SHAPED ids: the same seed always produces the same
/// sequence. The same derivation v0's `scripts/golden-vault/build.mjs` uses,
/// so a fixture generated on either side carries the same ids.
///
/// **For fixtures and the simulation only.** It is not a default any more, for
/// the reason [`ClockIds`] carries: a per-instance counter restarts on every
/// open. `crates/sim` and the golden freezer inject it deliberately, under a
/// fixed clock and a fixed seed, which is what makes a seed replayable.
#[derive(Debug)]
pub struct SeededIds {
    seed: String,
    counter: AtomicU64,
}

impl SeededIds {
    #[must_use]
    pub fn new(seed: impl Into<String>) -> Self {
        Self {
            seed: seed.into(),
            counter: AtomicU64::new(0),
        }
    }
}

impl Ids for SeededIds {
    fn next(&self) -> String {
        use sha2::{Digest as _, Sha256};
        let count = self.counter.fetch_add(1, Ordering::Relaxed) + 1;
        let digest = hex::encode(Sha256::digest(format!("{}:{count}", self.seed).as_bytes()));
        format!(
            "{}-{}-7{}-8{}-{}",
            &digest[0..8],
            &digest[8..12],
            &digest[13..16],
            &digest[17..20],
            &digest[20..32]
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_text_form_is_the_schemas_own_spelling() {
        // What `strftime('%Y-%m-%dT%H:%M:%fZ','now')` writes: milliseconds,
        // always three digits, always `Z`.
        assert_eq!(format_iso_ms(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            FixedClock::frozen().now_text(),
            "2026-01-01T00:00:00.000Z",
            "the frozen instant must be v0's freezer's `FROZEN_NOW`"
        );
        assert_eq!(format_iso_ms(1_767_225_600_007), "2026-01-01T00:00:00.007Z");
    }

    #[test]
    fn the_conversion_round_trips_over_a_century_of_leap_years() {
        let mut findings: Vec<String> = Vec::new();
        // Every 37th day from 1970 to 2070 — through 2000 (a leap year) and
        // 2100's non-leap rule is outside the range on purpose, since a
        // timestamp column will never hold one and the const fns are Hinnant's.
        let mut millis = 0_i64;
        while millis < 3_155_760_000_000 {
            let text = format_iso_ms(millis);
            match parse_iso_ms(&text) {
                Some(back) if back == millis => {}
                other => findings.push(format!("{millis} -> {text} -> {other:?}")),
            }
            millis += 37 * 86_400_000 + 3_601_000;
        }
        assert_eq!(findings.len(), 0, "{}", findings.join("\n"));
    }

    #[test]
    fn a_timestamp_that_is_not_the_shape_does_not_parse() {
        assert_eq!(parse_iso_ms(""), None);
        assert_eq!(parse_iso_ms("2026-01-01"), None);
        assert_eq!(parse_iso_ms("2026/01/01T00:00:00.000Z"), None);
        // Seconds precision, which some v0 columns hold, IS accepted.
        assert_eq!(
            parse_iso_ms("2026-01-01T00:00:00Z"),
            Some(1_767_225_600_000)
        );
    }

    #[test]
    fn a_fixed_clock_advances_only_when_told_to() {
        let clock = FixedClock::frozen();
        let first = clock.now_ms();
        assert_eq!(clock.now_ms(), first);
        clock.advance_days(30);
        assert_eq!(clock.now_ms() - first, 30 * 86_400_000);
    }

    #[test]
    fn seeded_ids_are_a_function_of_the_seed_and_the_count() {
        let one = SeededIds::new("issue-1020");
        let two = SeededIds::new("issue-1020");
        let three = SeededIds::new("other");
        let first: Vec<String> = (0..3).map(|_| one.next()).collect();
        let second: Vec<String> = (0..3).map(|_| two.next()).collect();
        assert_eq!(first, second);
        assert_ne!(first[0], three.next());
        // uuid-v7-SHAPED, so anything validating the format is satisfied.
        assert_eq!(first[0].len(), 36);
        assert_eq!(&first[0][14..15], "7");
        assert_eq!(&first[0][19..20], "8");
    }

    /// TWO OPENS OF THE SAME VAULT DO NOT MINT THE SAME IDS, even on the same
    /// frozen clock. This is the property `SeededIds` did not have and the one
    /// the reopen collision was (#1020 wave 3, lane E finding 1).
    #[test]
    fn two_id_sources_on_one_clock_do_not_share_a_sequence() {
        let clock = std::sync::Arc::new(FixedClock::frozen());
        let session = |clock: &std::sync::Arc<FixedClock>| {
            let ids = ClockIds::new(Box::new(std::sync::Arc::clone(clock)));
            (0..64).map(|_| ids.next()).collect::<Vec<_>>()
        };
        let first = session(&clock);
        let second = session(&clock);
        let mut all = first.clone();
        all.extend(second.clone());
        let unique: std::collections::BTreeSet<&String> = all.iter().collect();
        assert_eq!(
            unique.len(),
            all.len(),
            "128 ids from two sessions on one frozen clock must all differ"
        );
        // The seeded source, by contrast, repeats itself — which is exactly why
        // it is a fixture tool and not a default.
        let seeded = |_: ()| {
            let ids = SeededIds::new("v1");
            (0..2).map(|_| ids.next()).collect::<Vec<_>>()
        };
        assert_eq!(seeded(()), seeded(()));
    }

    /// The shape is RFC 9562's, and the timestamp is the INJECTED clock's —
    /// time-ordered ids are what the audit band reads history by.
    #[test]
    fn a_clock_id_is_a_uuid_v7_whose_time_comes_from_the_clock() {
        let clock = std::sync::Arc::new(FixedClock::frozen());
        let ids = ClockIds::new(Box::new(std::sync::Arc::clone(&clock)));
        let early = ids.next();
        assert_eq!(early.len(), 36);
        assert_eq!(&early[14..15], "7", "the version nibble");
        assert!(
            matches!(&early[19..20], "8" | "9" | "a" | "b"),
            "the variant is the two bits `0b10`, so the nibble is 8, 9, a or b: {early}"
        );
        let millis = u64::from_str_radix(&format!("{}{}", &early[0..8], &early[9..13]), 16)
            .expect("the first 48 bits are hex");
        assert_eq!(
            i64::try_from(millis).expect("in range"),
            FixedClock::frozen().now_ms(),
            "the timestamp is the injected clock's, not the host's"
        );
        clock.advance_days(1);
        let late = ids.next();
        assert!(late > early, "{early} then {late} — v7 ids sort by time");
    }
}
