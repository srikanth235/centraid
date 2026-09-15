//! Cron in **the vault's zone**, with v0's tier 3 deleted (#1020,
//! D-1020-AU2, R-1020-33).
//!
//! ## Two tiers, and a refusal where the third was
//!
//! v0 resolves a fire zone in three tiers (`docs/cron-timezone.md:17`–`:21`):
//! the trigger's own `tz`, the gateway-wide device pref, then **host-local via
//! `Date` getters**. The third tier is the one v1 cannot keep, and the reason
//! is in the inventory row itself — *the vault's zone, never the host's (a VPS
//! runs UTC)*. On a laptop tier 3 is a promise (*"your 7 a.m. reminder keeps
//! arriving at 7 a.m."*); on a VPS it silently becomes UTC, so a member in
//! Bengaluru gets their morning digest at half past noon and nothing anywhere
//! says why.
//!
//! So v1 resolves:
//!
//! 1. the trigger's own `tz`;
//! 2. **the vault's zone** — `core_vault.settings_json`'s zone, written from
//!    Settings and validated as IANA at write;
//! 3. nothing. [`ZoneUnset`] is returned, the registration is REFUSED, and
//!    [`crate::signals::Signal::ZoneUnset`] is raised so a member is asked for
//!    their zone instead of being given a schedule in somebody else's.
//!
//! **The host's clock zone is unreachable from this crate by construction**,
//! not by convention: `jiff` is depended on with `default-features = false` and
//! without `tz-system`, so there is no code path — ours or the library's —
//! that can read `TZ` or `/etc/localtime`. The zone database is
//! `tzdb-bundle-always`, compiled in, so the answer this crate gives does not
//! depend on whether a container image shipped `tzdata` either.
//!
//! ## The rest is v0's, verbatim
//!
//! [`matches`] is `cronMatches` (`fire/cron-match.ts`): five numeric fields,
//! wildcards, values, ranges, lists and steps, Vixie dom/dow OR semantics when
//! both are restricted, `0` and `7` both Sunday, and an unparseable field
//! **never matches** rather than matching everything. [`next_runs`] and
//! [`run_label`] read the SAME resolved zone as the matcher, because a preview
//! that re-interpreted the schedule in the viewer's zone would show a time the
//! automation will not fire at.
//!
//! DST is `docs/cron-timezone.md`'s table: a **gap** wall time is skipped
//! (it exists at no instant, so nothing can deliver it), and an **overlap**
//! wall time occurs **once, at the earlier instant** — which is
//! [`crate::fire::cron_cursor`]'s job, because "once" is a property of a window
//! and not of a minute.

// ONE ZONE SOURCE, AND IT IS THE VAULT'S (#1020, D-1020-S8).
//
// `FireZone`, `ZoneUnset`, `WallClock` and `sunday_zero` were defined here.
// They are `crates/vault::time::zone`'s now and re-exported unchanged, because
// RECURRENCE needs the same resolution cron already had — the same two tiers,
// the same deleted host-local third, the same bundled `tzdb` — and a second
// reader is exactly the drift `docs/cron-timezone.md` was written about. The
// crate graph forces the direction: `automations` → `assist` → `vault`, so the
// shared type can only live at the bottom.
//
// Nothing about this crate's behaviour changed: the module's public names,
// their signatures and their doc comments are the ones that moved.
pub use centraid_vault::time::zone::{FireZone, WallClock, ZoneUnset, sunday_zero};

/// Milliseconds in a minute. The cron grain, everywhere.
pub const MINUTE_MS: i64 = 60_000;

/// Floor an epoch-millisecond instant to its minute.
#[must_use]
pub const fn floor_minute(millis: i64) -> i64 {
    millis.div_euclid(MINUTE_MS) * MINUTE_MS
}

/// Is `expr` a well-formed five-field expression?
///
/// Structural only: it says the shape is legal, never that any minute matches.
#[must_use]
pub fn is_valid(expr: &str) -> bool {
    let fields: Vec<&str> = expr.split_whitespace().collect();
    if fields.len() != 5 {
        return false;
    }
    let bounds = [(0, 59), (0, 23), (1, 31), (1, 12), (0, 7)];
    fields
        .iter()
        .zip(bounds)
        .all(|(field, (min, max))| field_is_valid(field, min, max))
}

/// Does `expr` match this instant, read in `zone`?
///
/// v0's `cronMatches`, with the zone mandatory rather than optional.
#[must_use]
pub fn matches(expr: &str, millis: i64, zone: &FireZone) -> bool {
    let fields: Vec<&str> = expr.split_whitespace().collect();
    if fields.len() != 5 {
        return false;
    }
    let wall = zone.wall_clock(millis);
    matches_wall(&fields, wall)
}

fn matches_wall(fields: &[&str], wall: WallClock) -> bool {
    let (minute, hour, dom, month, dow) = (fields[0], fields[1], fields[2], fields[3], fields[4]);
    if !match_field(minute, i64::from(wall.minute), 0, 59) {
        return false;
    }
    if !match_field(hour, i64::from(wall.hour), 0, 23) {
        return false;
    }
    if !match_field(month, i64::from(wall.month), 1, 12) {
        return false;
    }
    let dom_star = is_wildcard(dom);
    let dow_star = is_wildcard(dow);
    let dom_match = match_field(dom, i64::from(wall.day), 1, 31);
    // cron day-of-week: 0 and 7 are both Sunday.
    let dow_match = match_field(dow, i64::from(wall.weekday), 0, 7)
        || (wall.weekday == 0 && match_field(dow, 7, 0, 7));
    match (dom_star, dow_star) {
        (true, true) => true,
        (true, false) => dow_match,
        (false, true) => dom_match,
        // VIXIE OR: both restricted means either may satisfy the day.
        (false, false) => dom_match || dow_match,
    }
}

const fn is_wildcard(field: &str) -> bool {
    matches!(field.as_bytes(), b"*" | b"?")
}

fn field_is_valid(field: &str, min: i64, max: i64) -> bool {
    if is_wildcard(field) {
        return true;
    }
    !field.is_empty() && field.split(',').all(|part| part_is_valid(part, min, max))
}

fn part_is_valid(part: &str, min: i64, max: i64) -> bool {
    let (base, step) = match part.split_once('/') {
        Some((base, step)) => match step.parse::<i64>() {
            Ok(step) if step > 0 => (base, step),
            _ => return false,
        },
        None => (part, 1),
    };
    let _ = step;
    let (low, high) = match bounds_of(base, min, max) {
        Some(bounds) => bounds,
        None => return false,
    };
    low <= high && low >= min && high <= max
}

fn bounds_of(base: &str, min: i64, max: i64) -> Option<(i64, i64)> {
    if is_wildcard(base) {
        return Some((min, max));
    }
    if let Some((low, high)) = base.split_once('-') {
        return Some((low.trim().parse().ok()?, high.trim().parse().ok()?));
    }
    let value: i64 = base.trim().parse().ok()?;
    Some((value, value))
}

/// An unparseable field NEVER matches. v0 states the stance and it is the
/// safe one: a typo that matched everything would fire an automation every
/// minute of every day.
fn match_field(field: &str, value: i64, min: i64, max: i64) -> bool {
    if is_wildcard(field) {
        return true;
    }
    field
        .split(',')
        .any(|part| part_matches(part, value, min, max))
}

fn part_matches(part: &str, value: i64, min: i64, max: i64) -> bool {
    let (base, step) = match part.split_once('/') {
        Some((base, step)) => match step.parse::<i64>() {
            Ok(step) if step > 0 => (base, step),
            _ => return false,
        },
        None => (part, 1),
    };
    let Some((low, high)) = bounds_of(base, min, max) else {
        return false;
    };
    if low > high || value < low || value > high {
        return false;
    }
    (value - low) % step == 0
}

/// How far ahead [`next_runs`] will look before answering "not scheduled": five
/// years of days. Five rather than one because `0 9 29 2 *` is a legal
/// expression and the next 29 February can be three years away; the scan is
/// day-first, so the extra years cost a few thousand civil-date comparisons
/// rather than millions of zone lookups.
const NEXT_RUN_SCAN_DAYS: i64 = 5 * 366;

/// The next `count` instants this expression is due, in the resolved zone.
///
/// The **same** zone the matcher uses, which is the point (`cron-timezone.md`
/// Matching): a preview computed in the viewer's zone is a different schedule
/// wearing the same numbers. A gap minute simply never appears (it exists at no
/// instant, so the day's walk never produces it), and a fall-back repeat
/// appears once because the wall-minute key dedupes it — the same key the
/// cursor dedupes on, so the pill and the fire agree.
///
/// The walk is **day-first**: the month/day-of-month/day-of-week fields are
/// tested against a civil date, and only a matching day's minutes are walked.
/// A minute-by-minute scan over five years would be 2.6 million zone lookups
/// for one pill.
#[must_use]
pub fn next_runs(expr: &str, after_millis: i64, zone: &FireZone, count: usize) -> Vec<i64> {
    let mut out = Vec::with_capacity(count);
    if count == 0 || !is_valid(expr) {
        return out;
    }
    let fields: Vec<&str> = expr.split_whitespace().collect();
    let after = floor_minute(after_millis);
    let mut seen = std::collections::BTreeSet::new();
    let mut date = {
        let wall = zone.wall_clock(after);
        match jiff::civil::Date::new(wall.year, wall.month, wall.day) {
            Ok(date) => date,
            Err(_) => return out,
        }
    };
    for _ in 0..NEXT_RUN_SCAN_DAYS {
        if out.len() >= count {
            break;
        }
        if day_matches(&fields, date) {
            // The day's own span, in this zone: 23, 24 or 25 hours, which is
            // how both copies of a fall-back minute land in one walk.
            let Some(start) = first_instant_of(zone, date) else {
                break;
            };
            let end = date
                .tomorrow()
                .ok()
                .and_then(|next| first_instant_of(zone, next))
                .unwrap_or(start + 26 * 60 * MINUTE_MS);
            let mut instant = start;
            while instant < end && out.len() < count {
                if instant > after
                    && matches_wall_minute(&fields, zone.wall_clock(instant))
                    && seen.insert(zone.wall_minute_key(instant))
                {
                    out.push(instant);
                }
                instant += MINUTE_MS;
            }
        }
        match date.tomorrow() {
            Ok(next) => date = next,
            Err(_) => break,
        }
    }
    out
}

/// The three DAY fields against a civil date. Vixie OR, exactly as
/// [`matches_wall`] applies it.
fn day_matches(fields: &[&str], date: jiff::civil::Date) -> bool {
    let (dom, month, dow) = (fields[2], fields[3], fields[4]);
    if !match_field(month, i64::from(date.month()), 1, 12) {
        return false;
    }
    let weekday = sunday_zero(date.weekday());
    let dom_star = is_wildcard(dom);
    let dow_star = is_wildcard(dow);
    let dom_match = match_field(dom, i64::from(date.day()), 1, 31);
    let dow_match =
        match_field(dow, i64::from(weekday), 0, 7) || (weekday == 0 && match_field(dow, 7, 0, 7));
    match (dom_star, dow_star) {
        (true, true) => true,
        (true, false) => dow_match,
        (false, true) => dom_match,
        (false, false) => dom_match || dow_match,
    }
}

/// The MINUTE and HOUR fields only; the day is already settled by the caller.
fn matches_wall_minute(fields: &[&str], wall: WallClock) -> bool {
    match_field(fields[0], i64::from(wall.minute), 0, 59)
        && match_field(fields[1], i64::from(wall.hour), 0, 23)
}

/// Midnight on `date` in `zone`, resolved FORWARD through a gap — a zone whose
/// clocks jump at midnight has no 00:00 that day, and the day still starts.
fn first_instant_of(zone: &FireZone, date: jiff::civil::Date) -> Option<i64> {
    zone.time_zone()
        .to_ambiguous_zoned(date.at(0, 0, 0, 0))
        .compatible()
        .ok()
        .map(|zoned| zoned.timestamp().as_millisecond())
}

/// The next-run pill's text, zone label included when it differs from the
/// viewer's.
///
/// `cron-timezone.md` Matching: *"when the schedule zone differs from the
/// viewer's zone, next-run pills append a short zone label"*. The label is the
/// IANA name rather than an abbreviation, because an abbreviation is ambiguous
/// (`IST` is three different zones) and this string is what a member checks a
/// schedule against.
#[must_use]
pub fn run_label(expr: &str, after_millis: i64, zone: &FireZone, viewer_zone: &str) -> String {
    match next_runs(expr, after_millis, zone, 1).first() {
        None => "not scheduled".to_owned(),
        Some(&at) => {
            let wall = zone.wall_clock(at);
            let stamp = format!(
                "{:04}-{:02}-{:02} {:02}:{:02}",
                wall.year, wall.month, wall.day, wall.hour, wall.minute
            );
            if viewer_zone.trim() == zone.name() {
                stamp
            } else {
                format!("{stamp} {}", zone.name())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utc() -> FireZone {
        FireZone::named("UTC").expect("bundled")
    }

    fn new_york() -> FireZone {
        FireZone::named("America/New_York").expect("bundled")
    }

    /// THE DELETION, in the only form that cannot rot: `resolve` has two
    /// arguments, and with both empty it REFUSES.
    #[test]
    fn with_no_trigger_zone_and_no_vault_zone_the_schedule_is_refused() {
        assert_eq!(FireZone::resolve(None, None), Err(ZoneUnset::Missing));
        assert_eq!(
            FireZone::resolve(Some("  "), Some("")),
            Err(ZoneUnset::Missing)
        );
    }

    #[test]
    fn the_trigger_zone_wins_and_the_vault_zone_is_the_second_tier() {
        assert_eq!(
            FireZone::resolve(Some("Asia/Kolkata"), Some("America/New_York"))
                .expect("tier 1")
                .name(),
            "Asia/Kolkata"
        );
        assert_eq!(
            FireZone::resolve(None, Some("Europe/Berlin"))
                .expect("tier 2")
                .name(),
            "Europe/Berlin"
        );
    }

    #[test]
    fn an_unknown_zone_is_named_in_the_refusal() {
        assert_eq!(
            FireZone::named("Mars/Olympus"),
            Err(ZoneUnset::Unknown {
                name: "Mars/Olympus".to_owned()
            })
        );
        // And a bad TRIGGER zone is not demoted to the vault's.
        assert!(matches!(
            FireZone::resolve(Some("Mars/Olympus"), Some("UTC")),
            Err(ZoneUnset::Unknown { .. })
        ));
    }

    /// THE UTC-HOST CASE, which is the one v0 gets wrong (D-1020-AU2). A
    /// member whose vault zone is Asia/Kolkata, on a gateway whose process
    /// clock is UTC: `0 7 * * *` fires at 01:30 UTC, not 07:00 UTC.
    #[test]
    fn a_seven_am_schedule_fires_at_the_members_local_time_on_a_utc_host() {
        let vault = FireZone::resolve(None, Some("Asia/Kolkata")).expect("the vault's zone");
        // 2026-03-09T01:30:00Z == 07:00 IST.
        let at = 1_773_019_800_000;
        assert_eq!(vault.wall_clock(at).hour, 7);
        assert!(matches("0 7 * * *", at, &vault));
        // The same instant in the host's zone is 01:30, and does NOT match —
        // which is exactly the wrong answer v0's tier 3 gives on a VPS.
        assert!(!matches("0 7 * * *", at, &utc()));
        assert_eq!(utc().wall_clock(at).hour, 1);
    }

    #[test]
    fn the_matcher_is_v0s_grammar() {
        let zone = utc();
        // 2026-01-01T00:00:00Z is a Thursday.
        let midnight = 1_767_225_600_000;
        assert!(matches("* * * * *", midnight, &zone));
        assert!(matches("0 0 1 1 *", midnight, &zone));
        assert!(matches("0 0 * * 4", midnight, &zone));
        // 0 and 7 are both Sunday.
        let sunday = midnight + 3 * 24 * 60 * MINUTE_MS;
        assert_eq!(zone.wall_clock(sunday).weekday, 0);
        assert!(matches("0 0 * * 0", sunday, &zone));
        assert!(matches("0 0 * * 7", sunday, &zone));
        // Steps, ranges, lists.
        assert!(matches("*/15 * * * *", midnight, &zone));
        assert!(!matches("*/15 * * * *", midnight + MINUTE_MS, &zone));
        assert!(matches("0 0-6 * * *", midnight, &zone));
        assert!(matches("0 0 1,15 * *", midnight, &zone));
        // VIXIE OR: both day fields restricted, either satisfies.
        assert!(
            matches("0 0 1 * 1", midnight, &zone),
            "dom matches, dow does not"
        );
        // Fail-safe: an unparseable field matches nothing.
        assert!(!matches("x * * * *", midnight, &zone));
        assert!(!matches("*/0 * * * *", midnight, &zone));
        assert!(
            !matches("* * * *", midnight, &zone),
            "four fields is not cron"
        );
        assert!(!is_valid("60 * * * *"), "a minute of 60 is out of range");
        assert!(!is_valid("* * * * 8"));
        assert!(is_valid("*/5 9-17 * * 1-5"));
    }

    /// The gap: 02:30 on a spring-forward morning exists at no instant, so
    /// nothing matches it that day.
    #[test]
    fn a_nonexistent_wall_time_is_skipped() {
        let zone = new_york();
        // 2026-03-08: 02:00 -> 03:00 (docs/cron-timezone.md's pinned date).
        let day_start = 1_772_946_000_000; // 2026-03-08T05:00:00Z == 00:00 EST
        assert_eq!(zone.wall_clock(day_start).hour, 0);
        let fired: Vec<i64> = (0..24 * 60)
            .map(|minute| day_start + minute * MINUTE_MS)
            .filter(|at| matches("30 2 * * *", *at, &zone))
            .collect();
        assert!(
            fired.is_empty(),
            "02:30 does not exist on 2026-03-08 in America/New_York, so it cannot fire"
        );
        // The day after, it does.
        let next = day_start + 24 * 60 * MINUTE_MS;
        assert!(
            (0..26 * 60)
                .map(|minute| next + minute * MINUTE_MS)
                .any(|at| matches("30 2 * * *", at, &zone))
        );
    }

    /// The overlap: 01:30 happens twice on a fall-back morning, so the
    /// MATCHER matches both. "Once" is the cursor's job, and the wall-minute
    /// key is how it knows.
    #[test]
    fn an_overlapping_wall_time_matches_twice_and_shares_one_key() {
        let zone = new_york();
        // 2026-11-01: 02:00 -> 01:00.
        let day_start = 1_793_505_600_000; // 2026-11-01T04:00:00Z == 00:00 EDT
        assert_eq!(zone.wall_clock(day_start).hour, 0);
        let matched: Vec<i64> = (0..26 * 60)
            .map(|minute| day_start + minute * MINUTE_MS)
            .filter(|at| matches("30 1 * * *", *at, &zone))
            .collect();
        assert_eq!(matched.len(), 2, "01:30 exists at two instants");
        assert_eq!(
            zone.wall_minute_key(matched[0]),
            zone.wall_minute_key(matched[1]),
            "one wall minute, one key — which is what makes the dedupe possible"
        );
        assert!(zone.offset_minutes(matched[1]) < zone.offset_minutes(matched[0]));
        // next_runs dedupes on that key, so a preview shows the EARLIER one.
        let preview = next_runs("30 1 * * *", day_start, &zone, 2);
        assert_eq!(preview[0], matched[0]);
        assert_ne!(preview[1], matched[1], "the repeat is not a second run");
    }

    #[test]
    fn next_runs_and_the_label_read_the_schedules_own_zone() {
        let zone = FireZone::named("Asia/Kolkata").expect("bundled");
        let at = 1_773_000_000_000;
        let runs = next_runs("0 7 * * *", at, &zone, 3);
        assert_eq!(runs.len(), 3);
        for run in &runs {
            assert_eq!(zone.wall_clock(*run).hour, 7);
        }
        assert_eq!(runs[1] - runs[0], 24 * 60 * MINUTE_MS);
        // A viewer elsewhere is told which zone the numbers are in.
        let label = run_label("0 7 * * *", at, &zone, "America/New_York");
        assert!(label.ends_with("Asia/Kolkata"), "{label}");
        assert!(label.contains("07:00"), "{label}");
        // A viewer in the schedule's zone is not.
        let same = run_label("0 7 * * *", at, &zone, "Asia/Kolkata");
        assert!(!same.contains("Asia/Kolkata"), "{same}");
        assert_eq!(next_runs("nonsense", at, &zone, 1), Vec::<i64>::new());
        assert_eq!(run_label("nonsense", at, &zone, "UTC"), "not scheduled");
    }

    /// A 29 February expression answers, which is the reason the scan window
    /// is 400 days and not a year.
    #[test]
    fn a_leap_day_schedule_still_answers() {
        let zone = utc();
        let runs = next_runs("0 9 29 2 *", 1_767_225_600_000, &zone, 1);
        assert_eq!(runs.len(), 1);
        let wall = zone.wall_clock(runs[0]);
        assert_eq!((wall.year, wall.month, wall.day), (2028, 2, 29));
    }

    #[test]
    fn floor_minute_floors_toward_the_past_on_both_sides_of_the_epoch() {
        assert_eq!(floor_minute(0), 0);
        assert_eq!(floor_minute(59_999), 0);
        assert_eq!(floor_minute(60_001), 60_000);
        assert_eq!(floor_minute(-1), -60_000, "a pre-epoch instant floors DOWN");
    }
}
