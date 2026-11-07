//! ONE RRULE PARSER, THREE CALL SHAPES (#1020, D-1020-S1; widened by #1173).
//!
//! The reason: every part outside the supported subset used to be read past
//! in silence, so `FREQ=MONTHLY;BYSETPOS=-1` parsed as a plain monthly rule
//! and a "last Friday of the month" reminder fired on the wrong date forever.
//! A silently dropped part is worse than an unsupported one: the wrong
//! answer wears the same face as the right one.
//!
//! The three shapes, and which surface takes which:
//!
//! | Shape | Who calls it | What it answers |
//! |---|---|---|
//! | [`assert_supported`] | a WRITE boundary: `schedule.propose_event`, `schedule.edit_event`, `schedule.add_task`, `schedule.edit_task` | accept the rule, or refuse it where the member wrote it |
//! | [`inspect`] | a surface that can REPORT: a precondition, a doctor, a manifest validator | the parsed rule, or the typed refusal and its sentence |
//! | [`parse`] | a READ surface with nothing to say | the rule, or `None`: **never a plausible series that means something else** |
//!
//! [`super::recurrence::expand`] is built on [`parse`], so a refused rule
//! expands to NO occurrences rather than to a plausible-but-wrong series.
//!
//! ## The subset (#1173, "custom repeat: any RRULE")
//!
//! Every RFC 5545 rule whose frequency is a day or coarser:
//!
//! - `FREQ` is `DAILY`, `WEEKLY`, `MONTHLY` or `YEARLY`, with `INTERVAL`,
//!   `COUNT` or `UNTIL` (never both: RFC 5545 forbids it) and `WKST` (default
//!   Monday, as the RFC says; it decides which days a week holds, so it matters
//!   for `WEEKLY;INTERVAL>1`, for `BYWEEKNO` and for the week a `BYDAY` list
//!   is read in).
//! - `BYDAY` (a plain day list under every frequency; ordinals `+-1..5` under
//!   MONTHLY and under YEARLY with `BYMONTH`, `+-1..53` under YEARLY without
//!   it), `BYMONTHDAY`, `BYMONTH`, `BYYEARDAY`, `BYWEEKNO`, `BYSETPOS`, each a
//!   list, expanding or limiting per the RFC's table. The frequencies a part
//!   may NOT take are refused with a sentence, exactly as the RFC says:
//!   `BYWEEKNO` and `BYYEARDAY` are YEARLY's, `BYMONTHDAY` is not WEEKLY's,
//!   an ordinal `BYDAY` is MONTHLY's and YEARLY's, and `BYSETPOS` needs
//!   another `BYxxx` part to select from.
//! - A date that does not exist (`BYMONTHDAY=31` in April, Feb 29 in a common
//!   year) is SKIPPED, never rolled over. The one exception is the day a rule
//!   takes from `DTSTART` because it names none (`FREQ=MONTHLY` anchored on
//!   the 31st): that lands on the month's last day, which is what the engine
//!   has always done and what "monthly on the 31st" means to a member.
//!
//! Refused, each with the reason accepting it would be a lie: `BYHOUR`,
//! `BYMINUTE`, `BYSECOND` (the engine carries the anchor's wall clock);
//! `RSCALE` and `SKIP` (RFC 7529 calendars); sub-daily `FREQ` (`HOURLY`,
//! `MINUTELY`, `SECONDLY`); `COUNT` together with `UNTIL`; a part written
//! twice, an unknown part, and a value that is not what its part takes.
//!
//! Lenient on purpose, because stored rules predate this: empty `;;`
//! segments, an `INTERVAL` or `COUNT` of zero or less (read as 1: "once",
//! never unbounded), and the extended `UNTIL=2026-12-31` spelling beside the
//! basic `20261231`.

/// The seven day tokens, in the order [`DayRule::day`] indexes them: Sunday
/// first, the way `wall_weekday` counts.
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

/// One `BYDAY` member: a weekday, with the ordinal that says WHICH one of the
/// period (`2MO`, `-1FR`) or none (every such weekday).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DayRule {
    /// `+-1..=53`; `None` is "every". Never `0`.
    pub ordinal: Option<i64>,
    /// `0` = Sunday … `6` = Saturday, as [`DAY_TOKENS`] indexes.
    pub day: u8,
}

impl DayRule {
    /// The two-letter token (`MO`).
    #[must_use]
    pub fn token(self) -> &'static str {
        DAY_TOKENS[usize::from(self.day) % 7]
    }
}

/// When a rule stops, read from its `UNTIL`. The three spellings mean three
/// things: a UTC instant, a floating wall clock, and a whole day (inclusive).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Until {
    /// `...Z`: an instant, in milliseconds.
    Utc(i64),
    /// A wall clock with no zone, as a wall epoch.
    Floating(i64),
    /// A bare date: the whole of that civil day is inside the rule. The day
    /// number since 1970-01-01.
    Date(i64),
}

/// A rule this engine will expand.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedRrule {
    pub freq: Freq,
    pub interval: i64,
    pub count: Option<i64>,
    /// The `UNTIL` as written (upper-cased). [`ParsedRrule::until_bound`] reads it.
    pub until: Option<String>,
    /// `WKST` as written (`0` = Sunday); `None` is the RFC default, Monday.
    pub wkst: Option<u8>,
    pub by_day: Vec<DayRule>,
    pub by_month_day: Vec<i64>,
    pub by_month: Vec<i64>,
    pub by_year_day: Vec<i64>,
    pub by_week_no: Vec<i64>,
    pub by_set_pos: Vec<i64>,
}

impl ParsedRrule {
    /// The day a week starts on: `WKST`, or Monday (RFC 5545's default).
    #[must_use]
    pub fn week_start(&self) -> u8 {
        self.wkst.unwrap_or(1)
    }

    /// The `UNTIL` as a typed bound. `None` for no `UNTIL`; a rule that parsed
    /// always has a readable one (the parser refuses the rest).
    #[must_use]
    pub fn until_bound(&self) -> Option<Until> {
        self.until.as_deref().and_then(parse_until)
    }

    /// Whether any `BYxxx` part (other than `BYSETPOS`) is present.
    fn has_by_part(&self) -> bool {
        !(self.by_day.is_empty()
            && self.by_month_day.is_empty()
            && self.by_month.is_empty()
            && self.by_year_day.is_empty()
            && self.by_week_no.is_empty())
    }

    /// The rule as one canonical bare body: parts in a fixed order, a default
    /// `INTERVAL` and a plain `WKST=MO`... left out only when absent. Parsing
    /// the result gives this rule back (the round trip the corpus pins).
    #[must_use]
    pub fn to_canonical(&self) -> String {
        let mut parts = vec![format!("FREQ={}", self.freq.as_str())];
        if self.interval > 1 {
            parts.push(format!("INTERVAL={}", self.interval));
        }
        let ints = |name: &str, values: &[i64], parts: &mut Vec<String>| {
            if !values.is_empty() {
                let text: Vec<String> = values.iter().map(i64::to_string).collect();
                parts.push(format!("{name}={}", text.join(",")));
            }
        };
        ints("BYMONTH", &self.by_month, &mut parts);
        ints("BYWEEKNO", &self.by_week_no, &mut parts);
        ints("BYYEARDAY", &self.by_year_day, &mut parts);
        ints("BYMONTHDAY", &self.by_month_day, &mut parts);
        if !self.by_day.is_empty() {
            let text: Vec<String> = self
                .by_day
                .iter()
                .map(|rule| match rule.ordinal {
                    Some(ordinal) => format!("{ordinal}{}", rule.token()),
                    None => rule.token().to_owned(),
                })
                .collect();
            parts.push(format!("BYDAY={}", text.join(",")));
        }
        ints("BYSETPOS", &self.by_set_pos, &mut parts);
        if let Some(wkst) = self.wkst {
            parts.push(format!("WKST={}", DAY_TOKENS[usize::from(wkst) % 7]));
        }
        if let Some(count) = self.count {
            parts.push(format!("COUNT={count}"));
        }
        if let Some(until) = &self.until {
            parts.push(format!("UNTIL={until}"));
        }
        parts.join(";")
    }
}

/// The parts the expander cannot honour, each with the reason accepting it
/// would be a lie. **A table, not a chain of `if`s**: this list IS the
/// engine's stated scope, and the refusal message quotes it back.
const UNSUPPORTED_PARTS: [(&str, &str); 5] = [
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
    (
        "RSCALE",
        "names a non-Gregorian calendar (RFC 7529); the expander counts in the Gregorian calendar only",
    ),
    (
        "SKIP",
        "chooses what a missing date becomes (RFC 7529); the expander always skips a date that does not exist",
    ),
];

/// Every part name an RRULE may carry that is NOT in [`UNSUPPORTED_PARTS`].
const KNOWN_PARTS: [&str; 11] = [
    "FREQ",
    "INTERVAL",
    "COUNT",
    "UNTIL",
    "WKST",
    "BYDAY",
    "BYMONTHDAY",
    "BYMONTH",
    "BYYEARDAY",
    "BYWEEKNO",
    "BYSETPOS",
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
    /// A part outside the subset: one of [`UNSUPPORTED_PARTS`].
    UnsupportedPart { part: String },
    /// A part the engine knows but this rule uses wrongly: a value that is not
    /// what the part takes, a part twice, an unknown part, a part the
    /// frequency may not carry, or `COUNT` beside `UNTIL`.
    Invalid { part: String, problem: String },
}

impl Refusal {
    /// ONE SENTENCE naming the part and why the engine will not pretend to
    /// honour it. v0's `rruleRefusalMessage`, word for word, for the parts
    /// that are still refused for v0's reason (`contracts/time/rrule-cases.json`
    /// compares these strings); the sentences #1119 and #1173 rewrote, because
    /// v0's words became false, are named in `time_corpus.rs`.
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
            Self::UnsupportedPart { part } => {
                let why = UNSUPPORTED_PARTS
                    .iter()
                    .find(|(name, _)| name == part)
                    .map_or("is outside the supported subset", |(_, why)| *why);
                format!("recurrence rule uses {part}, which this engine cannot honour: it {why}")
            }
            Self::Invalid { part, problem } => {
                format!("recurrence rule has a {part} this engine cannot honour: {problem}")
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
            Self::Invalid { .. } => "invalid-part",
        }
    }
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str(&self.message())
    }
}

impl std::error::Error for Refusal {}

fn invalid(part: &str, problem: &str) -> Refusal {
    Refusal::Invalid {
        part: part.to_owned(),
        problem: problem.to_owned(),
    }
}

/// Canonical bare RRULE body (`FREQ=...`).
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

/// A rule in its ONE canonical spelling, or `None` when it is refused: what a
/// store that wants equal rules to compare equal writes.
#[must_use]
pub fn normalize(value: &str) -> Option<String> {
    parse(value).map(|rule| rule.to_canonical())
}

/// `NAME=value` pairs of a canonical rule, upper-cased on both sides, and the
/// first thing wrong with the text, if anything. An empty segment (`;;`, a
/// trailing `;`) is read past; a segment with no `=` is not a part and a part
/// written twice is ambiguous, and both are refused, never dropped. The fault
/// is returned rather than raised so a text with no `FREQ` at all is still
/// "malformed" first.
fn parts_of(value: &str) -> (Vec<(String, String)>, Option<Refusal>) {
    let mut parts: Vec<(String, String)> = Vec::new();
    let mut fault: Option<Refusal> = None;
    for segment in canonicalize(value).split(';') {
        if segment.is_empty() {
            continue;
        }
        let Some(equals) = segment.find('=') else {
            fault.get_or_insert_with(|| {
                invalid(&segment.to_ascii_uppercase(), "is not a NAME=value part")
            });
            continue;
        };
        let name = segment[..equals].trim().to_ascii_uppercase();
        let text = segment[equals + 1..].trim().to_ascii_uppercase();
        if parts.iter().any(|(existing, _)| *existing == name) {
            fault.get_or_insert_with(|| invalid(&name, "is written more than once"));
            continue;
        }
        parts.push((name, text));
    }
    (parts, fault)
}

fn part<'a>(parts: &'a [(String, String)], name: &str) -> Option<&'a str> {
    parts
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.as_str())
}

/// v0's `positiveInteger`: `COUNT=0` is invalid ICS, and a non-positive bound
/// is treated as a single occurrence rather than as unbounded expansion. A
/// value that is no number at all is refused (v0 read past it, which turned
/// `COUNT=banana` into an endless series).
fn positive_integer(name: &str, value: Option<&str>) -> Result<Option<i64>, Refusal> {
    let Some(text) = value else { return Ok(None) };
    let parsed = text
        .parse::<f64>()
        .ok()
        .filter(|parsed| parsed.is_finite())
        .ok_or_else(|| invalid(name, "is not a whole number"))?;
    let truncated = parsed.trunc() as i64;
    Ok(Some(if truncated > 0 { truncated } else { 1 }))
}

fn day_index(token: &str) -> Option<u8> {
    DAY_TOKENS
        .iter()
        .position(|day| *day == token)
        .and_then(|index| u8::try_from(index).ok())
}

/// A `BYDAY` member: `MO`, `2MO`, `-1FR`.
fn day_rule(token: &str) -> Option<DayRule> {
    let (negative, rest) = match token.as_bytes().first() {
        Some(b'-') => (true, &token[1..]),
        Some(b'+') => (false, &token[1..]),
        _ => (false, token),
    };
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    let day = day_index(&rest[digits.len()..])?;
    if digits.is_empty() {
        return (!token.starts_with(['+', '-'])).then_some(DayRule { ordinal: None, day });
    }
    if digits.len() > 2 {
        return None;
    }
    let ordinal: i64 = digits.parse().ok()?;
    Some(DayRule {
        ordinal: Some(if negative { -ordinal } else { ordinal }),
        day,
    })
}

/// A comma list of integers, each `+-1..=max` (never `0`), in the order
/// written and without repeats.
fn int_list(name: &str, raw: Option<&str>, max: i64) -> Result<Vec<i64>, Refusal> {
    let Some(raw) = raw else {
        return Ok(Vec::new());
    };
    let mut values: Vec<i64> = Vec::new();
    for token in raw.split(',') {
        let value = token
            .trim()
            .parse::<i64>()
            .ok()
            .filter(|value| *value != 0 && value.abs() <= max)
            .ok_or_else(|| {
                invalid(
                    name,
                    &format!("takes whole numbers from 1 to {max}, or -1 to -{max} from the end"),
                )
            })?;
        if !values.contains(&value) {
            values.push(value);
        }
    }
    Ok(values)
}

fn read_by_month(raw: Option<&str>) -> Result<Vec<i64>, Refusal> {
    let Some(raw) = raw else {
        return Ok(Vec::new());
    };
    let mut values: Vec<i64> = Vec::new();
    for token in raw.split(',') {
        let value = token
            .trim()
            .parse::<i64>()
            .ok()
            .filter(|value| (1..=12).contains(value))
            .ok_or_else(|| invalid("BYMONTH", "takes month numbers from 1 to 12"))?;
        if !values.contains(&value) {
            values.push(value);
        }
    }
    Ok(values)
}

fn read_by_day(raw: Option<&str>) -> Result<Vec<DayRule>, Refusal> {
    let Some(raw) = raw else {
        return Ok(Vec::new());
    };
    let mut rules: Vec<DayRule> = Vec::new();
    for token in raw.split(',') {
        let rule = day_rule(token.trim()).ok_or_else(|| {
            invalid(
                "BYDAY",
                "takes day tokens (MO, TU, WE, TH, FR, SA, SU), each with an optional number (2MO, -1FR)",
            )
        })?;
        if rule.ordinal == Some(0) || rule.ordinal.is_some_and(|ordinal| ordinal.abs() > 53) {
            return Err(invalid(
                "BYDAY",
                "numbers its weekday from 1 to 53, or -1 to -53 from the end",
            ));
        }
        if !rules.contains(&rule) {
            rules.push(rule);
        }
    }
    Ok(rules)
}

/// Whether `UNTIL`'s text is one of the spellings [`parse_until`] reads.
fn parse_until(text: &str) -> Option<Until> {
    use super::recurrence::parse_instant_ms;
    use super::zone::{parse_wall_iso, wall_epoch};
    let bytes = text.as_bytes();
    let all_digits = |slice: &[u8]| slice.iter().all(u8::is_ascii_digit);
    // Basic: `YYYYMMDD`, `YYYYMMDDTHHMMSS[Z]`.
    if bytes.len() >= 8 && all_digits(&bytes[..8]) {
        let date = format!("{}-{}-{}", &text[0..4], &text[4..6], &text[6..8]);
        let wall = parse_wall_iso(&date)?;
        if bytes.len() == 8 {
            return Some(Until::Date(wall_epoch(wall).div_euclid(86_400_000)));
        }
        let (body, utc) = match text.strip_suffix('Z') {
            Some(body) => (body, true),
            None => (text, false),
        };
        let body = body.as_bytes();
        if body.len() != 15 || body[8] != b'T' || !all_digits(&body[9..]) {
            return None;
        }
        let stamp = format!(
            "{date}T{}:{}:{}",
            &text[9..11],
            &text[11..13],
            &text[13..15]
        );
        let epoch = wall_epoch(parse_wall_iso(&stamp)?);
        return Some(if utc {
            Until::Utc(epoch)
        } else {
            Until::Floating(epoch)
        });
    }
    // Extended: `YYYY-MM-DD`, `YYYY-MM-DDTHH:MM[:SS[.fff]]` with an optional zone.
    if bytes.len() == 10 {
        let wall = parse_wall_iso(text)?;
        return Some(Until::Date(wall_epoch(wall).div_euclid(86_400_000)));
    }
    if super::civil::has_zone_designator(text) {
        return parse_instant_ms(text).map(Until::Utc);
    }
    parse_wall_iso(text).map(|wall| Until::Floating(wall_epoch(wall)))
}

/// The ordinal a day carries must fit the period it counts in: `MONTHLY`'s
/// month, `YEARLY`'s month when `BYMONTH` names one, else its year.
fn check_by_day_shape(rule: &ParsedRrule) -> Result<(), Refusal> {
    let numbered = rule.by_day.iter().filter_map(|day| day.ordinal);
    let widest = numbered.map(i64::abs).max();
    let Some(widest) = widest else { return Ok(()) };
    match rule.freq {
        Freq::Daily | Freq::Weekly => Err(invalid(
            "BYDAY",
            "a numbered weekday (\"2MO\", \"-1FR\") only applies to MONTHLY and YEARLY rules",
        )),
        Freq::Monthly if widest > 5 => Err(invalid(
            "BYDAY",
            "a MONTHLY rule numbers its weekday from 1 to 5, or -1 to -5 from the end of the month",
        )),
        Freq::Yearly if !rule.by_week_no.is_empty() => Err(invalid(
            "BYDAY",
            "a numbered weekday cannot be combined with BYWEEKNO",
        )),
        Freq::Yearly if !rule.by_month.is_empty() && widest > 5 => Err(invalid(
            "BYDAY",
            "a YEARLY rule with BYMONTH numbers its weekday within the month, from 1 to 5",
        )),
        _ => Ok(()),
    }
}

/// **Shape 2: parse a rule, or say why it cannot be honoured.** THE parser:
/// [`parse`] and [`assert_supported`] both read a rule through here.
///
/// # Errors
///
/// The typed [`Refusal`].
pub fn inspect(value: &str) -> Result<ParsedRrule, Refusal> {
    let (parts, fault) = parts_of(value);
    let freq_text = part(&parts, "FREQ");
    if let Some(freq) = freq_text
        && UNSUPPORTED_FREQS.contains(&freq)
    {
        return Err(Refusal::UnsupportedFreq {
            freq: freq.to_owned(),
        });
    }
    let freq = match freq_text {
        Some("DAILY") => Freq::Daily,
        Some("WEEKLY") => Freq::Weekly,
        Some("MONTHLY") => Freq::Monthly,
        Some("YEARLY") => Freq::Yearly,
        _ => return Err(Refusal::Malformed),
    };
    if let Some(fault) = fault {
        return Err(fault);
    }
    for (name, _) in UNSUPPORTED_PARTS {
        if part(&parts, name).is_some() {
            return Err(Refusal::UnsupportedPart {
                part: name.to_owned(),
            });
        }
    }
    for (name, _) in &parts {
        if !KNOWN_PARTS.contains(&name.as_str()) {
            return Err(invalid(name, "is not a recurrence rule part"));
        }
    }
    let interval = positive_integer("INTERVAL", part(&parts, "INTERVAL"))?.unwrap_or(1);
    let count = positive_integer("COUNT", part(&parts, "COUNT"))?;
    let until = part(&parts, "UNTIL").map(str::to_owned);
    if let Some(text) = &until
        && parse_until(text).is_none()
    {
        return Err(invalid(
            "UNTIL",
            "is not a date or date-time (20261231, 20261231T235959Z or 2026-12-31)",
        ));
    }
    if count.is_some() && until.is_some() {
        return Err(invalid(
            "COUNT",
            "cannot be combined with UNTIL (RFC 5545 allows one or the other)",
        ));
    }
    let wkst = match part(&parts, "WKST") {
        None => None,
        Some(token) => Some(
            day_index(token)
                .ok_or_else(|| invalid("WKST", "takes a day token (MO, TU, WE, TH, FR, SA, SU)"))?,
        ),
    };
    let rule = ParsedRrule {
        freq,
        interval,
        count,
        until,
        wkst,
        by_day: read_by_day(part(&parts, "BYDAY"))?,
        by_month_day: int_list("BYMONTHDAY", part(&parts, "BYMONTHDAY"), 31)?,
        by_month: read_by_month(part(&parts, "BYMONTH"))?,
        by_year_day: int_list("BYYEARDAY", part(&parts, "BYYEARDAY"), 366)?,
        by_week_no: int_list("BYWEEKNO", part(&parts, "BYWEEKNO"), 53)?,
        by_set_pos: int_list("BYSETPOS", part(&parts, "BYSETPOS"), 366)?,
    };
    if !rule.by_week_no.is_empty() && freq != Freq::Yearly {
        return Err(invalid("BYWEEKNO", "only applies to a YEARLY rule"));
    }
    if !rule.by_year_day.is_empty() && freq != Freq::Yearly {
        return Err(invalid("BYYEARDAY", "only applies to a YEARLY rule"));
    }
    if !rule.by_month_day.is_empty() && freq == Freq::Weekly {
        return Err(invalid(
            "BYMONTHDAY",
            "does not apply to a WEEKLY rule (a week spans months; use BYDAY)",
        ));
    }
    check_by_day_shape(&rule)?;
    if !rule.by_set_pos.is_empty() && !rule.has_by_part() {
        return Err(invalid(
            "BYSETPOS",
            "picks among the days another BYxxx part selects (BYDAY, BYMONTHDAY, BYMONTH...); with none, it has nothing to pick from",
        ));
    }
    Ok(rule)
}

/// **Shape 3: the parsed rule, or `None`.** For read surfaces with nothing to
/// say about a refusal: the expander returns no occurrences rather than a
/// series that means something else.
#[must_use]
pub fn parse(value: &str) -> Option<ParsedRrule> {
    inspect(value).ok()
}

/// **Shape 1: accept the rule, or refuse it.** A command that STORES an
/// RRULE calls this, so an unhonourable rule is refused where the member wrote
/// it instead of becoming a row whose expansion is quietly wrong.
///
/// # Errors
///
/// The typed [`Refusal`], carrying the sentence the member reads.
pub fn assert_supported(value: &str) -> Result<ParsedRrule, Refusal> {
    inspect(value)
}

/// The refusal sentence a command precondition prints, with the rule quoted:
/// v0's `UnsupportedRruleError`'s message.
#[must_use]
pub fn refusal_sentence(refusal: &Refusal, rrule: &str) -> String {
    format!("{} (rule: {})", refusal.message(), canonicalize(rrule))
}

// ---------------------------------------------------------------------------
// THE ONE SUMMARISER. A raw RRULE string is never shown to a member.
//
// Its words live HERE, in the vault, beside the rule they describe (the
// pattern since #1020). Member-facing words belong in the core strings
// (`crates/screens/src/strings/`); moving these there is an owner decision
// (see the #1173 hand-off), and until it is made this is still the ONE place
// a recurrence sentence is built.
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

const MONTH_FULL_NAMES: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];

fn day_name(token: &str) -> &'static str {
    DAY_NAMES
        .iter()
        .find(|(code, _)| *code == token)
        .map_or("", |(_, name)| *name)
}

/// "a", "a and b", "a, b and c".
fn join_and(items: &[String]) -> String {
    match items.len() {
        0 => String::new(),
        1 => items[0].clone(),
        _ => format!(
            "{} and {}",
            items[..items.len() - 1].join(", "),
            items[items.len() - 1]
        ),
    }
}

/// "Monday", "Monday and Tuesday", "Monday, Tuesday and Friday".
fn join_days(days: &[&str]) -> String {
    let names: Vec<String> = days.iter().map(|day| day_name(day).to_owned()).collect();
    join_and(&names)
}

/// 1st, 2nd, 3rd, 4th ... 11th, 12th, 13th ... 21st, 22nd, 31st.
fn day_of_month_label(day: i64) -> String {
    let suffix = match (day % 100, day % 10) {
        (11..=13, _) => "th",
        (_, 1) => "st",
        (_, 2) => "nd",
        (_, 3) => "rd",
        _ => "th",
    };
    format!("{day}{suffix}")
}

/// "first", "second" ... "fifth", "last", "second to last"; past five, "21st".
fn ordinal_word(ordinal: i64) -> String {
    const WORDS: [&str; 5] = ["first", "second", "third", "fourth", "fifth"];
    let from_end = ordinal < 0;
    let n = ordinal.unsigned_abs();
    let word = match usize::try_from(n) {
        Ok(n) if (1..=5).contains(&n) => WORDS[n - 1].to_owned(),
        _ => day_of_month_label(ordinal.abs()),
    };
    match (from_end, n) {
        (true, 1) => "last".to_owned(),
        (true, _) => format!("{word} to last"),
        (false, _) => word,
    }
}

fn day_tokens_of(rule: &ParsedRrule) -> Vec<&'static str> {
    rule.by_day.iter().map(|day| day.token()).collect()
}

/// "the 1st, 15th and last day": a `BYMONTHDAY` list.
fn month_day_items(days: &[i64]) -> String {
    let items: Vec<String> = days
        .iter()
        .map(|day| match *day {
            -1 => "last day".to_owned(),
            day if day < 0 => format!("{} to last day", day_of_month_label(-day)),
            day => day_of_month_label(day),
        })
        .collect();
    format!("the {}", join_and(&items))
}

/// "the second Monday and each Friday": a `BYDAY` list with ordinals.
fn by_day_items(rule: &ParsedRrule) -> String {
    let mut items: Vec<String> = Vec::new();
    let plain: Vec<&str> = rule
        .by_day
        .iter()
        .filter(|day| day.ordinal.is_none())
        .map(|day| day.token())
        .collect();
    for day in &rule.by_day {
        if let Some(ordinal) = day.ordinal {
            items.push(format!(
                "the {} {}",
                ordinal_word(ordinal),
                day_name(day.token())
            ));
        }
    }
    if !plain.is_empty() {
        items.push(format!("each {}", join_days(&plain)));
    }
    join_and(&items)
}

/// "the last weekday", "the first and third Friday": a `BYSETPOS` list over
/// the days `BYDAY` names.
fn set_position_items(rule: &ParsedRrule) -> String {
    let mut positions = rule.by_set_pos.clone();
    positions.sort_by_key(|pos| (*pos < 0, pos.abs()));
    let words: Vec<String> = positions.iter().map(|pos| ordinal_word(*pos)).collect();
    let ordinals = join_and(&words);
    let tokens = day_tokens_of(rule);
    let mut sorted: Vec<u8> = rule.by_day.iter().map(|day| day.day).collect();
    sorted.sort_unstable();
    sorted.dedup();
    let noun = match (tokens.len(), sorted.as_slice()) {
        (0, _) => None,
        (_, [1, 2, 3, 4, 5]) => Some("weekday".to_owned()),
        (_, [0, 6]) => Some("weekend day".to_owned()),
        (_, [single]) => Some(day_name(DAY_TOKENS[usize::from(*single)]).to_owned()),
        _ => None,
    };
    match noun {
        Some(noun) => format!("the {ordinals} {noun}"),
        None if tokens.is_empty() => format!("the {ordinals} day"),
        None => format!("the {ordinals} of {}", join_days(&tokens)),
    }
}

fn is_plain_days(rule: &ParsedRrule) -> bool {
    !rule.by_day.is_empty() && rule.by_day.iter().all(|day| day.ordinal.is_none())
}

/// The frequency's opening words: "Daily", "Every other week", "Every 3 months".
fn head(rule: &ParsedRrule, short: bool) -> String {
    let unit = rule.freq.unit();
    match (rule.interval, rule.freq, short) {
        (1, Freq::Daily, _) => "Daily".to_owned(),
        (1, Freq::Weekly, _) => "Weekly".to_owned(),
        (1, Freq::Monthly, true) => "Monthly".to_owned(),
        (1, _, _) => format!("Every {unit}"),
        (2, _, _) => format!("Every other {unit}"),
        (n, _, _) => format!("Every {n} {unit}s"),
    }
}

/// The sentences the engine said before #1173, byte for byte.
fn legacy_cadence(rule: &ParsedRrule) -> Option<String> {
    let only = |rule: &ParsedRrule| {
        rule.by_month.is_empty()
            && rule.by_year_day.is_empty()
            && rule.by_week_no.is_empty()
            && rule.by_set_pos.is_empty()
    };
    if !only(rule) {
        return None;
    }
    match rule.freq {
        Freq::Monthly => {
            let on = match (rule.by_day.as_slice(), rule.by_month_day.as_slice()) {
                ([], []) => return Some(head(rule, false)),
                ([], [-1]) => "the last day".to_owned(),
                ([], [day @ 1..=31]) => format!("the {}", day_of_month_label(*day)),
                ([day], []) if matches!(day.ordinal, Some(1..=4 | -1)) => {
                    let ordinal = day.ordinal.unwrap_or(1);
                    format!("the {} {}", ordinal_word(ordinal), day_name(day.token()))
                }
                _ => return None,
            };
            Some(format!("{} on {on}", head(rule, true)))
        }
        Freq::Weekly => {
            if rule.by_day.is_empty() && rule.by_month_day.is_empty() {
                return Some(head(rule, false));
            }
            if !is_plain_days(rule) || !rule.by_month_day.is_empty() {
                return None;
            }
            let days = day_tokens_of(rule);
            Some(match rule.interval {
                1 => format!("Every {}", join_days(&days)),
                2 if days.len() == 1 => format!("Every other {}", join_days(&days)),
                _ => format!("{} on {}", head(rule, false), join_days(&days)),
            })
        }
        Freq::Daily | Freq::Yearly => {
            (rule.by_day.is_empty() && rule.by_month_day.is_empty()).then(|| head(rule, false))
        }
    }
}

fn cadence(rule: &ParsedRrule) -> String {
    if let Some(sentence) = legacy_cadence(rule) {
        return sentence;
    }
    let mut clauses: Vec<String> = Vec::new();
    if !rule.by_set_pos.is_empty() {
        clauses.push(format!("on {}", set_position_items(rule)));
        if !rule.by_month_day.is_empty() {
            clauses.push(format!("among {}", month_day_items(&rule.by_month_day)));
        }
    } else {
        if !rule.by_day.is_empty() {
            let in_a_week =
                matches!(rule.freq, Freq::Daily | Freq::Weekly) || !rule.by_week_no.is_empty();
            let text = if is_plain_days(rule) && in_a_week {
                join_days(&day_tokens_of(rule))
            } else {
                by_day_items(rule)
            };
            clauses.push(format!("on {text}"));
        }
        if !rule.by_month_day.is_empty() {
            let joiner = if rule.by_day.is_empty() {
                "on"
            } else {
                "when it falls on"
            };
            clauses.push(format!("{joiner} {}", month_day_items(&rule.by_month_day)));
        }
    }
    if !rule.by_year_day.is_empty() {
        let items: Vec<String> = rule
            .by_year_day
            .iter()
            .map(|day| match *day {
                -1 => "last".to_owned(),
                day if day < 0 => format!("{} to last", day_of_month_label(-day)),
                day => day_of_month_label(day),
            })
            .collect();
        clauses.push(format!("on the {} day of the year", join_and(&items)));
    }
    if !rule.by_week_no.is_empty() {
        let items: Vec<String> = rule
            .by_week_no
            .iter()
            .map(|week| match *week {
                -1 => "the last week".to_owned(),
                week if week < 0 => format!("the {} to last week", day_of_month_label(-week)),
                week => format!("week {week}"),
            })
            .collect();
        clauses.push(format!("in {}", join_and(&items)));
    }
    if !rule.by_month.is_empty() {
        let months: Vec<String> = rule
            .by_month
            .iter()
            .filter_map(|month| usize::try_from(*month).ok())
            .filter_map(|month| MONTH_FULL_NAMES.get(month.wrapping_sub(1)))
            .map(|name| (*name).to_owned())
            .collect();
        clauses.push(format!("in {}", join_and(&months)));
    }
    let opening = head(rule, true);
    if clauses.is_empty() {
        return opening;
    }
    format!("{opening} {}", clauses.join(" "))
}

/// UNTIL carries its own spelling; the label is the calendar day it names.
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

/// A rule never carries both (the parser refuses it), so this is whichever is set.
fn ending(rule: &ParsedRrule) -> String {
    if let Some(count) = rule.count {
        return if count == 1 {
            " \u{b7} once".to_owned()
        } else {
            format!(" \u{b7} {count} times")
        };
    }
    let Some(until) = rule.until.as_deref() else {
        return String::new();
    };
    until_label(until).map_or_else(String::new, |label| format!(" \u{b7} until {label}"))
}

/// THE member-facing recurrence sentence, or `None` when the rule does not
/// parse. Every surface (Agenda, Tasks, the assistant) renders a rule with
/// this function; **a second summariser anywhere is the defect this exists to
/// prevent**, and a raw RRULE string is never shown to a member.
#[must_use]
pub fn describe(value: &str) -> Option<String> {
    let rule = parse(value)?;
    Some(format!("{}{}", cadence(&rule), ending(&rule)))
}
