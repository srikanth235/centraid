//! ONE RRULE PARSER, THREE CALL SHAPES (#1020, D-1020-S1).
//!
//! v0's `packages/core/src/time/rrule-support.ts`, and its reason, verbatim:
//! *every part outside the supported subset used to be read past in silence,
//! so `FREQ=MONTHLY;BYSETPOS=-1` parsed as a plain monthly rule and a "last
//! Friday of the month" reminder fired on the wrong date forever. A silently
//! dropped part is worse than an unsupported one — the wrong answer wears the
//! same face as the right one.*
//!
//! The three shapes, and which surface takes which:
//!
//! | Shape | Who calls it | What it answers |
//! |---|---|---|
//! | [`assert_supported`] | a WRITE boundary — `schedule.propose_event`, `schedule.edit_event`, `schedule.add_task`, `schedule.edit_task` | accept the rule, or refuse it where the member wrote it |
//! | [`inspect`] | a surface that can REPORT — a precondition, a doctor, a manifest validator | the parsed rule, or the typed refusal and its sentence |
//! | [`parse`] | a READ surface with nothing to say | the rule, or `None` — **never a plausible series that means something else** |
//!
//! [`super::recurrence::expand`] is built on [`parse`], so a refused rule
//! expands to NO occurrences rather than to a plausible-but-wrong series.
//!
//! ## The subset
//!
//! Supported: `FREQ ∈ DAILY | WEEKLY | MONTHLY | YEARLY`, with
//! `INTERVAL`, `COUNT`, `UNTIL` and (WEEKLY only) `BYDAY`.
//!
//! Refused, each with the reason accepting it would be a lie: `BYSETPOS`,
//! `BYMONTHDAY`, `BYMONTH`, `BYYEARDAY`, `BYWEEKNO`, `BYHOUR`, `BYMINUTE`,
//! `BYSECOND`; sub-daily `FREQ` (`HOURLY`, `MINUTELY`, `SECONDLY`); a
//! positional or non-WEEKLY `BYDAY`; and a non-`SU` `WKST` under
//! `INTERVAL > 1`.

/// The seven day tokens, in the order `BYDAY` offsets are taken from — Sunday
/// first, because `weekly_candidates` anchors on the week's Sunday.
pub const DAY_TOKENS: [&str; 7] = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/// How often a rule repeats. A CLOSED set: everything else is refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Freq {
    Daily,
    Weekly,
    Monthly,
    Yearly,
}

impl Freq {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Daily => "DAILY",
            Self::Weekly => "WEEKLY",
            Self::Monthly => "MONTHLY",
            Self::Yearly => "YEARLY",
        }
    }

    const fn unit(self) -> &'static str {
        match self {
            Self::Daily => "day",
            Self::Weekly => "week",
            Self::Monthly => "month",
            Self::Yearly => "year",
        }
    }
}

/// A rule this engine will expand.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedRrule {
    pub freq: Freq,
    pub interval: i64,
    pub count: Option<i64>,
    pub until: Option<String>,
    /// WEEKLY only, and in the order they were written.
    pub by_day: Option<Vec<&'static str>>,
}

/// The parts the expander cannot honour, each with the reason accepting it
/// would be a lie. **A table, not a chain of `if`s**: this list IS the
/// engine's stated scope, and the refusal message quotes it back.
const UNSUPPORTED_PARTS: [(&str, &str); 8] = [
    (
        "BYSETPOS",
        "selects the nth candidate within each period; the expander emits every candidate",
    ),
    (
        "BYMONTHDAY",
        "pins occurrences to days of the month; the expander steps from the anchor day",
    ),
    (
        "BYMONTH",
        "restricts occurrences to named months; the expander does not filter by month",
    ),
    (
        "BYYEARDAY",
        "pins occurrences to days of the year; the expander steps from the anchor day",
    ),
    (
        "BYWEEKNO",
        "pins occurrences to ISO week numbers, which the expander does not compute",
    ),
    (
        "BYHOUR",
        "moves the time of day; the expander carries the anchor's wall clock unchanged",
    ),
    (
        "BYMINUTE",
        "moves the time of day; the expander carries the anchor's wall clock unchanged",
    ),
    (
        "BYSECOND",
        "moves the time of day; the expander carries the anchor's wall clock unchanged",
    ),
];

const UNSUPPORTED_FREQS: [&str; 3] = ["HOURLY", "MINUTELY", "SECONDLY"];

/// Why a rule was refused. Typed, so a caller reports the PART rather than a
/// sentence it has to pattern-match.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    /// No `FREQ` this engine recognises at all.
    Malformed,
    /// A sub-daily frequency, named so the refusal can say which one arrived.
    UnsupportedFreq { freq: String },
    /// A part outside the subset — one of [`UNSUPPORTED_PARTS`], or `BYDAY`
    /// / `WKST` in a shape the expander cannot honour.
    UnsupportedPart { part: String },
}

impl Refusal {
    /// ONE SENTENCE naming the part and why the engine will not pretend to
    /// honour it. v0's `rruleRefusalMessage`, word for word — the corpus in
    /// `contracts/time/rrule-cases.json` compares these strings.
    #[must_use]
    pub fn message(&self) -> String {
        match self {
            Self::Malformed => "recurrence rule has no supported FREQ (expected DAILY, WEEKLY, \
                                MONTHLY or YEARLY)"
                .to_owned(),
            Self::UnsupportedFreq { freq } => format!(
                "recurrence rule uses FREQ={freq}, which this engine does not expand (sub-daily \
                 recurrence is not supported)"
            ),
            Self::UnsupportedPart { part } if part == "BYDAY" => {
                "recurrence rule uses a BYDAY this engine cannot honour: days steer WEEKLY \
                 expansion only, and a positional day (\"-1FR\") or a non-day token is not a rule \
                 it can expand"
                    .to_owned()
            }
            Self::UnsupportedPart { part } if part == "WKST" => {
                "recurrence rule sets WKST to a day other than SU with INTERVAL>1; this engine \
                 starts every week on Sunday, so the periods would not line up"
                    .to_owned()
            }
            Self::UnsupportedPart { part } => {
                let why = UNSUPPORTED_PARTS
                    .iter()
                    .find(|(name, _)| name == part)
                    .map_or("is outside the supported subset", |(_, why)| *why);
                format!("recurrence rule uses {part}, which this engine cannot honour: it {why}")
            }
        }
    }

    /// The refusal's own tag, for a fixture and a receipt.
    #[must_use]
    pub fn reason(&self) -> &'static str {
        match self {
            Self::Malformed => "malformed",
            Self::UnsupportedFreq { .. } => "unsupported-freq",
            Self::UnsupportedPart { .. } => "unsupported-part",
        }
    }
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str(&self.message())
    }
}

impl std::error::Error for Refusal {}

/// Canonical bare RRULE body (`FREQ=…`).
///
/// Strips a leading `RRULE:` (Google Calendar and ICS both emit the prefixed
/// form) and removes all whitespace, so schedule preconditions, the parser and
/// an ICS export share one shape.
#[must_use]
pub fn canonicalize(value: &str) -> String {
    let trimmed = value.trim_start();
    let body = if trimmed.len() >= 6 && trimmed[..6].eq_ignore_ascii_case("RRULE:") {
        &trimmed[6..]
    } else {
        trimmed
    };
    body.chars().filter(|c| !c.is_whitespace()).collect()
}

/// Prefixed RRULE line for Google/ICS writeback, without double-prefixing.
#[must_use]
pub fn rrule_line(value: &str) -> String {
    let bare = canonicalize(value);
    if bare.is_empty() {
        String::new()
    } else {
        format!("RRULE:{bare}")
    }
}

/// `NAME=value` pairs of a canonical rule, upper-cased on both sides.
fn parts_of(value: &str) -> Vec<(String, String)> {
    canonicalize(value)
        .split(';')
        .filter_map(|segment| {
            let equals = segment.find('=')?;
            Some((
                segment[..equals].trim().to_ascii_uppercase(),
                segment[equals + 1..].trim().to_ascii_uppercase(),
            ))
        })
        .collect()
}

fn part(parts: &[(String, String)], name: &str) -> Option<String> {
    parts
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.clone())
}

/// v0's `positiveInteger`: `COUNT=0` is invalid ICS, and a non-positive bound
/// is treated as a single occurrence rather than as unbounded expansion.
fn positive_integer(value: Option<&str>) -> Option<i64> {
    let text = value?;
    let parsed = text.parse::<f64>().ok()?;
    if !parsed.is_finite() {
        return None;
    }
    let truncated = parsed.trunc() as i64;
    Some(if truncated > 0 { truncated } else { 1 })
}

/// A positional BYDAY member: `2MO`, `-1FR` — the nth weekday of a period.
fn is_positional_day(token: &str) -> bool {
    let rest = token.strip_prefix(['+', '-']).unwrap_or(token);
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() || digits.len() > 2 {
        return false;
    }
    let tail = &rest[digits.len()..];
    DAY_TOKENS.contains(&tail)
}

/// The days, or the refusal that stops them being dropped.
///
/// Only WEEKLY expansion reads BYDAY, so outside WEEKLY it names a different
/// rule ("every Monday IN the month"); a positional member (`-1FR`) is
/// `BYSETPOS` by another spelling; the rest are not day tokens. Filtering any
/// of them left a rule that parsed and meant something else — `BYDAY=1MO`
/// became plain WEEKLY, firing every Monday.
fn read_by_day(raw: Option<&str>, freq: Freq) -> Result<Option<Vec<&'static str>>, Refusal> {
    let Some(raw) = raw else { return Ok(None) };
    if freq != Freq::Weekly {
        return Err(Refusal::UnsupportedPart {
            part: "BYDAY".to_owned(),
        });
    }
    let mut days = Vec::new();
    for token in raw.split(',') {
        let token = token.trim();
        if is_positional_day(token) {
            return Err(Refusal::UnsupportedPart {
                part: "BYDAY".to_owned(),
            });
        }
        match DAY_TOKENS.iter().find(|day| **day == token) {
            Some(day) => days.push(*day),
            None => return Err(Refusal::Malformed),
        }
    }
    Ok(Some(days))
}

/// **Shape 2 — parse a rule, or say why it cannot be honoured.** THE parser:
/// [`parse`] and [`assert_supported`] both read a rule through here.
///
/// WKST is refused rather than implemented: it only changes an expansion when
/// `INTERVAL > 1`, and `WKST=SU` is what the weekly candidate walk already
/// assumes, so refusing exactly the cases that would differ leaves every
/// accepted rule identical and never relocates a fortnightly series by up to
/// six days.
pub fn inspect(value: &str) -> Result<ParsedRrule, Refusal> {
    let parts = parts_of(value);
    let freq_text = part(&parts, "FREQ");
    if let Some(freq) = freq_text.as_deref()
        && UNSUPPORTED_FREQS.contains(&freq)
    {
        return Err(Refusal::UnsupportedFreq {
            freq: freq.to_owned(),
        });
    }
    let freq = match freq_text.as_deref() {
        Some("DAILY") => Freq::Daily,
        Some("WEEKLY") => Freq::Weekly,
        Some("MONTHLY") => Freq::Monthly,
        Some("YEARLY") => Freq::Yearly,
        _ => return Err(Refusal::Malformed),
    };
    for (name, _) in UNSUPPORTED_PARTS {
        if part(&parts, name).is_some() {
            return Err(Refusal::UnsupportedPart {
                part: name.to_owned(),
            });
        }
    }
    let interval = positive_integer(part(&parts, "INTERVAL").as_deref()).unwrap_or(1);
    if let Some(wkst) = part(&parts, "WKST")
        && wkst != "SU"
        && interval > 1
    {
        return Err(Refusal::UnsupportedPart {
            part: "WKST".to_owned(),
        });
    }
    let by_day = read_by_day(part(&parts, "BYDAY").as_deref(), freq)?;
    Ok(ParsedRrule {
        freq,
        interval,
        count: positive_integer(part(&parts, "COUNT").as_deref()),
        until: part(&parts, "UNTIL"),
        by_day,
    })
}

/// **Shape 3 — the parsed rule, or `None`.** For read surfaces with nothing to
/// say about a refusal: the expander returns no occurrences rather than a
/// series that means something else.
#[must_use]
pub fn parse(value: &str) -> Option<ParsedRrule> {
    inspect(value).ok()
}

/// **Shape 1 — accept the rule, or refuse it.** A command that STORES an
/// RRULE calls this, so an unhonourable rule is refused where the member wrote
/// it instead of becoming a row whose expansion is quietly wrong.
///
/// # Errors
///
/// The typed [`Refusal`], carrying the sentence the member reads.
pub fn assert_supported(value: &str) -> Result<ParsedRrule, Refusal> {
    inspect(value)
}

/// The refusal sentence a command precondition prints, with the rule quoted —
/// v0's `UnsupportedRruleError`'s message.
#[must_use]
pub fn refusal_sentence(refusal: &Refusal, rrule: &str) -> String {
    format!("{} (rule: {})", refusal.message(), canonicalize(rrule))
}

// ---------------------------------------------------------------------------
// THE ONE SUMMARISER. A raw RRULE string is never shown to a member.
// ---------------------------------------------------------------------------

const DAY_NAMES: [(&str, &str); 7] = [
    ("SU", "Sunday"),
    ("MO", "Monday"),
    ("TU", "Tuesday"),
    ("WE", "Wednesday"),
    ("TH", "Thursday"),
    ("FR", "Friday"),
    ("SA", "Saturday"),
];

const MONTH_NAMES: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

fn day_name(token: &str) -> &'static str {
    DAY_NAMES
        .iter()
        .find(|(code, _)| *code == token)
        .map_or("", |(_, name)| *name)
}

/// "Monday", "Monday and Tuesday", "Monday, Tuesday and Friday".
fn join_days(days: &[&str]) -> String {
    let names: Vec<&str> = days.iter().map(|day| day_name(day)).collect();
    match names.len() {
        0 => String::new(),
        1 => names[0].to_owned(),
        _ => format!(
            "{} and {}",
            names[..names.len() - 1].join(", "),
            names[names.len() - 1]
        ),
    }
}

fn cadence(rule: &ParsedRrule) -> String {
    let days: &[&str] = rule.by_day.as_deref().unwrap_or(&[]);
    let unit = rule.freq.unit();
    if rule.interval == 1 {
        if !days.is_empty() {
            return format!("Every {}", join_days(days));
        }
        return match rule.freq {
            Freq::Daily => "Daily".to_owned(),
            Freq::Weekly => "Weekly".to_owned(),
            _ => format!("Every {unit}"),
        };
    }
    let every = if rule.interval == 2 {
        format!("Every other {unit}")
    } else {
        format!("Every {} {unit}s", rule.interval)
    };
    if days.is_empty() {
        return every;
    }
    // "Every other Friday" reads better than "Every other week on Friday",
    // but only a single day can collapse that way.
    if rule.interval == 2 && days.len() == 1 {
        return format!("Every other {}", join_days(days));
    }
    format!("{every} on {}", join_days(days))
}

/// UNTIL is a UTC instant in the rule itself; it carries no zone of its own.
fn until_label(until: &str) -> Option<String> {
    let bytes = until.as_bytes();
    let (year, month, day) = if bytes.len() >= 8 && bytes[..8].iter().all(u8::is_ascii_digit) {
        (&until[0..4], &until[4..6], &until[6..8])
    } else if bytes.len() >= 10 && bytes[4] == b'-' && bytes[7] == b'-' {
        (&until[0..4], &until[5..7], &until[8..10])
    } else {
        return None;
    };
    let year: i64 = year.parse().ok()?;
    let month: usize = month.parse().ok()?;
    let day: i64 = day.parse().ok()?;
    if !(1..=12).contains(&month) {
        return None;
    }
    Some(format!("{} {day}, {year}", MONTH_NAMES[month - 1]))
}

/// COUNT wins over UNTIL, matching the expansion's own precedence.
fn ending(rule: &ParsedRrule) -> String {
    if let Some(count) = rule.count {
        return if count == 1 {
            " · once".to_owned()
        } else {
            format!(" · {count} times")
        };
    }
    let Some(until) = rule.until.as_deref() else {
        return String::new();
    };
    until_label(until).map_or_else(String::new, |label| format!(" · until {label}"))
}

/// THE member-facing recurrence sentence, or `None` when the rule does not
/// parse. Every surface — Agenda, Tasks, the assistant — renders a rule with
/// this function; **a second summariser anywhere is the defect this exists to
/// prevent**, and a raw RRULE string is never shown to a member.
#[must_use]
pub fn describe(value: &str) -> Option<String> {
    let rule = parse(value)?;
    Some(format!("{}{}", cadence(&rule), ending(&rule)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_cautionary_case_is_refused_and_says_why() {
        let refusal = inspect("FREQ=MONTHLY;BYSETPOS=-1").expect_err("BYSETPOS is refused");
        assert_eq!(
            refusal,
            Refusal::UnsupportedPart {
                part: "BYSETPOS".to_owned()
            }
        );
        assert!(
            refusal.message().contains("emits every candidate"),
            "the sentence names the reason: {}",
            refusal.message()
        );
        assert_eq!(parse("FREQ=MONTHLY;BYSETPOS=-1"), None);
    }

    #[test]
    fn a_positional_byday_is_bysetpos_by_another_spelling() {
        assert!(matches!(
            inspect("FREQ=WEEKLY;BYDAY=-1FR"),
            Err(Refusal::UnsupportedPart { ref part }) if part == "BYDAY"
        ));
        assert!(matches!(
            inspect("FREQ=MONTHLY;BYDAY=MO"),
            Err(Refusal::UnsupportedPart { ref part }) if part == "BYDAY"
        ));
        assert_eq!(inspect("FREQ=WEEKLY;BYDAY=XX"), Err(Refusal::Malformed));
    }

    #[test]
    fn wkst_is_refused_only_where_it_would_differ() {
        assert!(
            inspect("FREQ=WEEKLY;WKST=MO").is_ok(),
            "INTERVAL=1 cannot differ"
        );
        assert!(matches!(
            inspect("FREQ=WEEKLY;INTERVAL=2;WKST=MO"),
            Err(Refusal::UnsupportedPart { ref part }) if part == "WKST"
        ));
        assert!(inspect("FREQ=WEEKLY;INTERVAL=2;WKST=SU").is_ok());
    }

    #[test]
    fn the_prefixed_form_is_canonicalised() {
        assert_eq!(canonicalize("RRULE:FREQ=DAILY"), "FREQ=DAILY");
        assert_eq!(canonicalize(" rrule:FREQ=DAILY "), "FREQ=DAILY");
        assert_eq!(rrule_line("FREQ=DAILY"), "RRULE:FREQ=DAILY");
        assert_eq!(rrule_line("RRULE:FREQ=DAILY"), "RRULE:FREQ=DAILY");
        assert_eq!(rrule_line("   "), "");
        assert!(inspect("RRULE:FREQ=DAILY").is_ok());
    }

    #[test]
    fn count_zero_is_one_occurrence_never_unbounded() {
        assert_eq!(
            inspect("FREQ=DAILY;COUNT=0").expect("parses").count,
            Some(1)
        );
        assert_eq!(
            inspect("FREQ=DAILY;COUNT=-3").expect("parses").count,
            Some(1)
        );
        assert_eq!(
            inspect("FREQ=DAILY;COUNT=banana").expect("parses").count,
            None
        );
    }

    #[test]
    fn sub_daily_frequencies_are_named_in_the_refusal() {
        let refusal = inspect("FREQ=HOURLY").expect_err("sub-daily is refused");
        assert!(
            refusal.message().contains("FREQ=HOURLY"),
            "{}",
            refusal.message()
        );
        assert_eq!(inspect("FREQ=FORTNIGHTLY"), Err(Refusal::Malformed));
        assert_eq!(inspect(""), Err(Refusal::Malformed));
    }

    #[test]
    fn the_summariser_is_the_only_thing_a_member_reads() {
        assert_eq!(describe("FREQ=DAILY").as_deref(), Some("Daily"));
        assert_eq!(describe("FREQ=WEEKLY").as_deref(), Some("Weekly"));
        assert_eq!(
            describe("FREQ=WEEKLY;BYDAY=MO,FR").as_deref(),
            Some("Every Monday and Friday")
        );
        assert_eq!(
            describe("FREQ=WEEKLY;INTERVAL=2;BYDAY=FR").as_deref(),
            Some("Every other Friday")
        );
        assert_eq!(
            describe("FREQ=MONTHLY;INTERVAL=3").as_deref(),
            Some("Every 3 months")
        );
        assert_eq!(
            describe("FREQ=DAILY;COUNT=1").as_deref(),
            Some("Daily · once")
        );
        assert_eq!(
            describe("FREQ=DAILY;UNTIL=20260301T000000Z").as_deref(),
            Some("Daily · until Mar 1, 2026")
        );
        assert_eq!(describe("FREQ=MONTHLY;BYSETPOS=-1"), None);
    }
}
