//! One RFC 5545 RRULE parser shared by write validation, inspection and expansion.
//!
//! All seven frequencies and the standard BY* parts are supported. The civil
//! candidate engine applies filters before BYSETPOS, then resolves each wall
//! time through FireZone. Unknown extensions, malformed values and invalid RFC
//! combinations are refused instead of silently changing the requested series.
//! The vault clock has no leap-second slot: RFC 5545 maps second 60 to 59.

pub const DAY_TOKENS: [&str; 7] = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Freq {
    Secondly,
    Minutely,
    Hourly,
    Daily,
    Weekly,
    Monthly,
    Yearly,
}

impl Freq {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Secondly => "SECONDLY",
            Self::Minutely => "MINUTELY",
            Self::Hourly => "HOURLY",
            Self::Daily => "DAILY",
            Self::Weekly => "WEEKLY",
            Self::Monthly => "MONTHLY",
            Self::Yearly => "YEARLY",
        }
    }
    const fn unit(self) -> &'static str {
        match self {
            Self::Secondly => "second",
            Self::Minutely => "minute",
            Self::Hourly => "hour",
            Self::Daily => "day",
            Self::Weekly => "week",
            Self::Monthly => "month",
            Self::Yearly => "year",
        }
    }
}

/// A simple monthly pin, retained for the familiar recurrence sentences.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MonthlyPin {
    MonthDay(i64),
    NthWeekday { ordinal: i64, day: &'static str },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ByWeekday {
    pub day: i64,
    pub ordinal: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedRrule {
    pub freq: Freq,
    pub interval: i64,
    pub count: Option<i64>,
    pub until: Option<String>,
    /// Plain weekly days, in written order, for the recurrence sentence.
    pub by_day: Option<Vec<&'static str>>,
    pub monthly_pin: Option<MonthlyPin>,
    pub weekdays: Vec<ByWeekday>,
    pub month_days: Vec<i64>,
    pub months: Vec<i64>,
    pub year_days: Vec<i64>,
    pub week_numbers: Vec<i64>,
    pub hours: Vec<i64>,
    pub minutes: Vec<i64>,
    pub seconds: Vec<i64>,
    pub set_positions: Vec<i64>,
    /// Sunday zero; RFC 5545 defaults to Monday.
    pub week_start: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    Malformed,
    UnsupportedFreq { freq: String },
    UnsupportedPart { part: String },
    InvalidPart { part: String, why: String },
}

impl Refusal {
    #[must_use]
    pub fn message(&self) -> String {
        match self {
            Self::Malformed => "recurrence rule has no supported FREQ (expected SECONDLY, MINUTELY, HOURLY, DAILY, WEEKLY, MONTHLY or YEARLY)".to_owned(),
            Self::UnsupportedFreq { freq } => format!("recurrence rule uses an unsupported FREQ={freq}"),
            Self::UnsupportedPart { part } => format!("recurrence rule uses {part}, which is not a supported RFC 5545 rule part"),
            Self::InvalidPart { part, why } => format!("recurrence rule has invalid {part}: {why}"),
        }
    }
    #[must_use]
    pub fn reason(&self) -> &'static str {
        match self {
            Self::Malformed => "malformed",
            Self::UnsupportedFreq { .. } => "unsupported-freq",
            Self::UnsupportedPart { .. } => "unsupported-part",
            Self::InvalidPart { .. } => "invalid-part",
        }
    }
}
impl std::fmt::Display for Refusal {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str(&self.message())
    }
}
impl std::error::Error for Refusal {}

#[must_use]
pub fn canonicalize(value: &str) -> String {
    let trimmed = value.trim_start();
    let body = if trimmed
        .get(..6)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("RRULE:"))
    {
        &trimmed[6..]
    } else {
        trimmed
    };
    body.chars().filter(|c| !c.is_whitespace()).collect()
}
#[must_use]
pub fn rrule_line(value: &str) -> String {
    let bare = canonicalize(value);
    if bare.is_empty() {
        String::new()
    } else {
        format!("RRULE:{bare}")
    }
}

fn invalid(part: &str, why: impl Into<String>) -> Refusal {
    Refusal::InvalidPart {
        part: part.to_owned(),
        why: why.into(),
    }
}

fn numbers(
    parts: &std::collections::BTreeMap<String, String>,
    name: &str,
    min: i64,
    max: i64,
    zero: bool,
) -> Result<Vec<i64>, Refusal> {
    let Some(raw) = parts.get(name) else {
        return Ok(Vec::new());
    };
    let mut values = Vec::new();
    for text in raw.split(',') {
        let value = text
            .parse::<i64>()
            .map_err(|_| invalid(name, "expected comma-separated integers"))?;
        if !(min..=max).contains(&value) || (!zero && value == 0) {
            return Err(invalid(
                name,
                format!(
                    "expected values from {min} to {max}{}",
                    if zero { "" } else { ", excluding zero" }
                ),
            ));
        }
        values.push(value);
    }
    values.sort_unstable();
    values.dedup();
    Ok(values)
}

fn positive(
    parts: &std::collections::BTreeMap<String, String>,
    name: &str,
) -> Result<Option<i64>, Refusal> {
    let Some(raw) = parts.get(name) else {
        return Ok(None);
    };
    let value = raw
        .parse::<i64>()
        .map_err(|_| invalid(name, "expected a positive integer"))?;
    // Old vaults used non-positive COUNT as one, never as an unbounded series. Keep
    // that safe interpretation; nonsensical text no longer becomes infinite.
    if !(-i64::from(i32::MAX)..=i64::from(i32::MAX)).contains(&value) {
        return Err(invalid(name, "expected an integer from 1 to 2147483647"));
    }
    Ok(Some(value.max(1)))
}

/// Parse exactly the RFC parts the candidate engine can honour.
pub fn inspect(value: &str) -> Result<ParsedRrule, Refusal> {
    const PARTS: [&str; 14] = [
        "FREQ",
        "UNTIL",
        "COUNT",
        "INTERVAL",
        "BYSECOND",
        "BYMINUTE",
        "BYHOUR",
        "BYDAY",
        "BYMONTHDAY",
        "BYYEARDAY",
        "BYWEEKNO",
        "BYMONTH",
        "BYSETPOS",
        "WKST",
    ];
    let mut parts = std::collections::BTreeMap::new();
    for segment in canonicalize(value)
        .to_ascii_uppercase()
        .split(';')
        .filter(|segment| !segment.is_empty())
    {
        let Some((key, value)) = segment.split_once('=') else {
            return Err(Refusal::Malformed);
        };
        if !PARTS.contains(&key) {
            return Err(Refusal::UnsupportedPart {
                part: key.to_owned(),
            });
        }
        if parts.insert(key.to_owned(), value.to_owned()).is_some() {
            return Err(invalid(key, "each part may appear only once"));
        }
    }
    let freq = match parts.get("FREQ").map(String::as_str) {
        Some("SECONDLY") => Freq::Secondly,
        Some("MINUTELY") => Freq::Minutely,
        Some("HOURLY") => Freq::Hourly,
        Some("DAILY") => Freq::Daily,
        Some("WEEKLY") => Freq::Weekly,
        Some("MONTHLY") => Freq::Monthly,
        Some("YEARLY") => Freq::Yearly,
        _ => return Err(Refusal::Malformed),
    };
    let interval = positive(&parts, "INTERVAL")?.unwrap_or(1);
    let count = positive(&parts, "COUNT")?;
    let until = parts.get("UNTIL").cloned();
    if count.is_some() && until.is_some() {
        return Err(invalid("UNTIL", "COUNT and UNTIL cannot be used together"));
    }
    if let Some(until) = &until {
        // The shared civil parser accepts both ICS basic and existing vault ISO dates.
        let basic = matches!(until.len(), 8 | 15 | 16)
            && until.as_bytes().get(4).is_some_and(u8::is_ascii_digit);
        let shape = basic || super::temporal::classify(until).is_some();
        let valid = shape
            && super::recurrence::parse_basic_instant(until).is_some_and(|value| {
                let wall = super::zone::wall_from_epoch(value);
                (1..=9999).contains(&wall.year)
            });
        if !valid {
            return Err(invalid("UNTIL", "expected a valid date or date-time"));
        }
    }
    let mut weekdays = Vec::new();
    let mut plain = Vec::new();
    if let Some(raw) = parts.get("BYDAY") {
        for token in raw.split(',') {
            let Some((day, suffix)) = DAY_TOKENS
                .iter()
                .enumerate()
                .find(|(_, day)| token.ends_with(**day))
            else {
                return Err(invalid(
                    "BYDAY",
                    "expected MO, TU, WE, TH, FR, SA or SU with an optional ordinal",
                ));
            };
            let prefix = &token[..token.len() - suffix.len()];
            let ordinal = if prefix.is_empty() {
                None
            } else {
                let n = prefix
                    .parse::<i64>()
                    .map_err(|_| invalid("BYDAY", "invalid weekday ordinal"))?;
                if n == 0 || !(-53..=53).contains(&n) {
                    return Err(invalid(
                        "BYDAY",
                        "weekday ordinals run from -53 to 53, excluding zero",
                    ));
                }
                if !matches!(freq, Freq::Monthly | Freq::Yearly)
                    || (freq == Freq::Yearly && parts.contains_key("BYWEEKNO"))
                {
                    return Err(invalid(
                        "BYDAY",
                        "ordinal weekdays require MONTHLY or YEARLY without BYWEEKNO",
                    ));
                }
                Some(n)
            };
            weekdays.push(ByWeekday {
                day: day as i64,
                ordinal,
            });
            if ordinal.is_none() {
                plain.push(*suffix);
            }
        }
    }
    let month_days = numbers(&parts, "BYMONTHDAY", -31, 31, false)?;
    let months = numbers(&parts, "BYMONTH", 1, 12, false)?;
    let year_days = numbers(&parts, "BYYEARDAY", -366, 366, false)?;
    let week_numbers = numbers(&parts, "BYWEEKNO", -53, 53, false)?;
    let hours = numbers(&parts, "BYHOUR", 0, 23, true)?;
    let minutes = numbers(&parts, "BYMINUTE", 0, 59, true)?;
    let mut seconds = numbers(&parts, "BYSECOND", 0, 60, true)?;
    // RFC 5545 §3.3.5: a clock without leap-second support interprets 60 as
    // 59. The recurrence set still contains that instant only once.
    for second in &mut seconds {
        *second = (*second).min(59);
    }
    seconds.dedup();
    let set_positions = numbers(&parts, "BYSETPOS", -366, 366, false)?;
    if freq == Freq::Weekly && !month_days.is_empty() {
        return Err(invalid("BYMONTHDAY", "not valid with WEEKLY"));
    }
    if matches!(freq, Freq::Daily | Freq::Weekly | Freq::Monthly) && !year_days.is_empty() {
        return Err(invalid(
            "BYYEARDAY",
            "requires YEARLY or a subdaily frequency",
        ));
    }
    if freq != Freq::Yearly && !week_numbers.is_empty() {
        return Err(invalid("BYWEEKNO", "requires YEARLY"));
    }
    if !set_positions.is_empty() && !parts.keys().any(|p| p.starts_with("BY") && p != "BYSETPOS") {
        return Err(invalid(
            "BYSETPOS",
            "requires another BY part to select candidates from",
        ));
    }
    let week_start = match parts.get("WKST") {
        None => 1,
        Some(day) => DAY_TOKENS
            .iter()
            .position(|token| token == day)
            .ok_or_else(|| invalid("WKST", "expected a weekday token"))?
            as i64,
    };
    let monthly_pin = if freq == Freq::Monthly
        && months.is_empty()
        && year_days.is_empty()
        && week_numbers.is_empty()
        && hours.is_empty()
        && minutes.is_empty()
        && seconds.is_empty()
        && set_positions.is_empty()
    {
        if let [weekday] = weekdays.as_slice() {
            if month_days.is_empty() {
                weekday.ordinal.map(|ordinal| MonthlyPin::NthWeekday {
                    ordinal,
                    day: DAY_TOKENS[weekday.day as usize],
                })
            } else {
                None
            }
        } else if weekdays.is_empty() && month_days.len() == 1 {
            Some(MonthlyPin::MonthDay(month_days[0]))
        } else {
            None
        }
    } else {
        None
    };
    Ok(ParsedRrule {
        freq,
        interval,
        count,
        until,
        by_day: (freq == Freq::Weekly && !plain.is_empty()).then_some(plain),
        monthly_pin,
        weekdays,
        month_days,
        months,
        year_days,
        week_numbers,
        hours,
        minutes,
        seconds,
        set_positions,
        week_start,
    })
}
/// Validate the DTSTART value type as well as the rule. RFC date anchors
/// cannot carry a subdaily frequency; date/time selectors never invent a time.
pub fn inspect_for_date(value: &str, all_day: bool) -> Result<ParsedRrule, Refusal> {
    let rule = inspect(value)?;
    if all_day && rule.freq < Freq::Daily {
        return Err(invalid(
            "FREQ",
            "a repeat more often than daily needs a start time",
        ));
    }
    Ok(rule)
}

#[must_use]
pub fn parse(value: &str) -> Option<ParsedRrule> {
    inspect(value).ok()
}
pub fn assert_supported(value: &str) -> Result<ParsedRrule, Refusal> {
    inspect(value)
}
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

const ORDINAL_WORDS: [(i64, &str); 6] = [
    (1, "first"),
    (2, "second"),
    (3, "third"),
    (4, "fourth"),
    (5, "fifth"),
    (-1, "last"),
];

/// 1st, 2nd, 3rd, 4th … 11th, 12th, 13th … 21st, 22nd, 31st.
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

/// "the second Monday", "the last day", "the 15th" — the tail of a monthly
/// rule's sentence.
fn pin_label(pin: MonthlyPin) -> String {
    match pin {
        MonthlyPin::MonthDay(-1) => "the last day".to_owned(),
        MonthlyPin::MonthDay(day) if day < 0 => {
            format!("the {} day from the end", day_of_month_label(-day))
        }
        MonthlyPin::MonthDay(day) => format!("the {}", day_of_month_label(day)),
        MonthlyPin::NthWeekday { ordinal, day } => {
            let word = ORDINAL_WORDS
                .iter()
                .find(|(value, _)| *value == ordinal)
                .map(|(_, word)| (*word).to_owned())
                .unwrap_or_else(|| {
                    if ordinal < 0 {
                        format!("{} from last", day_of_month_label(-ordinal))
                    } else {
                        day_of_month_label(ordinal)
                    }
                });
            format!("the {word} {}", day_name(day))
        }
    }
}

fn cadence(rule: &ParsedRrule) -> String {
    if let Some(pin) = rule.monthly_pin {
        let on = pin_label(pin);
        return match rule.interval {
            1 => format!("Monthly on {on}"),
            2 => format!("Every other month on {on}"),
            n => format!("Every {n} months on {on}"),
        };
    }
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

fn custom_details(rule: &ParsedRrule) -> String {
    let mut details = Vec::new();
    if rule.monthly_pin.is_none() {
        if rule.by_day.is_none() && !rule.weekdays.is_empty() {
            let days: Vec<String> = rule
                .weekdays
                .iter()
                .map(|day| {
                    let token = DAY_TOKENS[day.day as usize];
                    day.ordinal.map_or_else(
                        || day_name(token).to_owned(),
                        |ordinal| {
                            pin_label(MonthlyPin::NthWeekday {
                                ordinal,
                                day: token,
                            })
                        },
                    )
                })
                .collect();
            details.push(format!("on {}", days.join(", ")));
        }
        if !rule.month_days.is_empty() {
            details.push(format!(
                "on {}",
                rule.month_days
                    .iter()
                    .map(|day| pin_label(MonthlyPin::MonthDay(*day)))
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
    }
    if !rule.months.is_empty() {
        details.push(format!(
            "in {}",
            rule.months
                .iter()
                .map(|month| MONTH_NAMES[(*month - 1) as usize])
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    for (name, values) in [
        ("year days", &rule.year_days),
        ("weeks", &rule.week_numbers),
        ("hours", &rule.hours),
        ("minutes", &rule.minutes),
        ("seconds", &rule.seconds),
    ] {
        if !values.is_empty() {
            details.push(format!(
                "{name} {}",
                values
                    .iter()
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
    }
    if !rule.set_positions.is_empty() {
        let positions: Vec<String> = rule
            .set_positions
            .iter()
            .map(|position| match position {
                -1 => "last".to_owned(),
                n if *n < 0 => format!("{} from last", day_of_month_label(-n)),
                n => day_of_month_label(*n),
            })
            .collect();
        details.push(format!(
            "{} matching occurrence in each {}",
            positions.join(", "),
            rule.freq.unit()
        ));
    }
    if ((rule.freq == Freq::Weekly && rule.interval > 1) || !rule.week_numbers.is_empty())
        && rule.week_start != 1
    {
        details.push(format!(
            "weeks start on {}",
            day_name(DAY_TOKENS[rule.week_start as usize])
        ));
    }
    if details.is_empty() {
        String::new()
    } else {
        format!(" · {}", details.join(" · "))
    }
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
    Some(format!(
        "{}{}{}",
        cadence(&rule),
        custom_details(&rule),
        ending(&rule)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepted_parts_have_typed_values_and_no_part_is_silently_dropped() {
        let rule = inspect("RRULE:FREQ=YEARLY;INTERVAL=2;BYMONTH=3,11;BYDAY=-2MO,FR;BYHOUR=9,17;BYMINUTE=30;BYSECOND=15;BYSETPOS=-1;WKST=WE;COUNT=4").expect("RFC rule");
        assert_eq!(rule.freq, Freq::Yearly);
        assert_eq!(rule.interval, 2);
        assert_eq!(rule.months, [3, 11]);
        assert_eq!(
            rule.weekdays,
            [
                ByWeekday {
                    day: 1,
                    ordinal: Some(-2)
                },
                ByWeekday {
                    day: 5,
                    ordinal: None
                }
            ]
        );
        assert_eq!(rule.hours, [9, 17]);
        assert_eq!(rule.minutes, [30]);
        assert_eq!(rule.seconds, [15]);
        assert_eq!(rule.set_positions, [-1]);
        assert_eq!(rule.week_start, 3);
        assert_eq!(rule.count, Some(4));
        assert!(
            matches!(inspect("FREQ=DAILY;BYEASTER=1"), Err(Refusal::UnsupportedPart { part }) if part == "BYEASTER")
        );
    }

    #[test]
    fn all_standard_frequencies_are_supported() {
        for frequency in [
            "SECONDLY", "MINUTELY", "HOURLY", "DAILY", "WEEKLY", "MONTHLY", "YEARLY",
        ] {
            assert_eq!(
                inspect(&format!("FREQ={frequency}"))
                    .expect("frequency")
                    .freq
                    .as_str(),
                frequency
            );
        }
        assert_eq!(inspect("FREQ=FORTNIGHTLY"), Err(Refusal::Malformed));
    }

    #[test]
    fn invalid_parts_are_named_and_cannot_become_infinite_series() {
        for (part, rule) in [
            ("COUNT", "FREQ=DAILY;COUNT=banana"),
            ("COUNT", "FREQ=DAILY;COUNT=1.3"),
            ("INTERVAL", "FREQ=DAILY;INTERVAL=1.5"),
            ("FREQ", "FREQ=DAILY;FREQ=MONTHLY"),
            ("UNTIL", "FREQ=DAILY;UNTIL=20260231T090000Z"),
            ("UNTIL", "FREQ=DAILY;UNTIL=20260101T250000Z"),
            ("UNTIL", "FREQ=DAILY;COUNT=2;UNTIL=20261231"),
            ("BYSECOND", "FREQ=MINUTELY;BYSECOND=61"),
            ("BYDAY", "FREQ=WEEKLY;BYDAY=-1FR"),
            ("BYDAY", "FREQ=MONTHLY;BYDAY=MO,"),
            ("BYDAY", "FREQ=YEARLY;BYWEEKNO=1;BYDAY=2MO"),
            ("BYDAY", "FREQ=MONTHLY;BYDAY=0MO"),
            ("BYMONTHDAY", "FREQ=WEEKLY;BYMONTHDAY=1"),
            ("BYYEARDAY", "FREQ=DAILY;BYYEARDAY=2"),
            ("BYWEEKNO", "FREQ=MONTHLY;BYWEEKNO=2"),
            ("BYSETPOS", "FREQ=MONTHLY;BYSETPOS=-1"),
            ("BYMONTH", "FREQ=YEARLY;BYMONTH=13"),
            ("WKST", "FREQ=WEEKLY;WKST=XX"),
        ] {
            let error = inspect(rule).expect_err(rule);
            assert!(
                matches!(&error, Refusal::InvalidPart { part: found, .. } if found == part),
                "{rule}: {error}"
            );
            assert!(error.message().contains(part));
            assert!(parse(rule).is_none());
        }
        assert_eq!(
            inspect("FREQ=DAILY;COUNT=0")
                .expect("safe old-vault zero")
                .count,
            Some(1)
        );
    }

    #[test]
    fn familiar_sentences_and_new_custom_constraints_are_described() {
        for (rule, expected) in [
            ("FREQ=DAILY", "Daily"),
            ("FREQ=WEEKLY;BYDAY=MO,FR", "Every Monday and Friday"),
            ("FREQ=WEEKLY;INTERVAL=2;BYDAY=FR", "Every other Friday"),
            ("FREQ=MONTHLY;BYDAY=2MO", "Monthly on the second Monday"),
            ("FREQ=MONTHLY;BYDAY=5MO", "Monthly on the fifth Monday"),
            ("FREQ=MONTHLY;BYDAY=-1FR", "Monthly on the last Friday"),
            (
                "FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=4",
                "Monthly on the last day · 4 times",
            ),
            (
                "FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=22",
                "Every 3 months on the 22nd",
            ),
            (
                "FREQ=DAILY;UNTIL=20260301T000000Z",
                "Daily · until Mar 1, 2026",
            ),
            ("FREQ=MINUTELY;INTERVAL=15", "Every 15 minutes"),
        ] {
            assert_eq!(describe(rule).as_deref(), Some(expected));
        }
        let custom =
            describe("FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1").expect("custom summary");
        assert!(custom.contains("Monday"));
        assert!(custom.contains("last matching occurrence in each month"));
        assert!(!custom.contains("FREQ="));
    }

    #[test]
    fn canonicalization_is_prefix_safe_even_for_unicode() {
        assert_eq!(canonicalize(" rrule:FREQ=DAILY "), "FREQ=DAILY");
        assert_eq!(rrule_line("RRULE:FREQ=DAILY"), "RRULE:FREQ=DAILY");
        assert_eq!(rrule_line("   "), "");
        assert_eq!(canonicalize("🗓️"), "🗓️");
    }
}
