//! DATE EXPRESSIONS (SPEC §4.4): the model writes a small JSON object, the
//! runtime evaluates it against `today` (or the target row's date) and echoes
//! the absolute range. No English reaches this module; the phrase readings
//! live in `crate::phrases`, which is data for the generator.

use jiff::civil::{Date, DateTime, Time};
use jiff::{Span, ToSpan as _};
use serde_json::{Value, json};

/// A unit of a relative expression.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unit {
    Minute,
    Hour,
    Day,
    Week,
    Month,
    Year,
}

impl Unit {
    pub const NAMES: [&'static str; 6] = ["minute", "hour", "day", "week", "month", "year"];

    fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "minute" => Self::Minute,
            "hour" => Self::Hour,
            "day" => Self::Day,
            "week" => Self::Week,
            "month" => Self::Month,
            "year" => Self::Year,
            _ => return None,
        })
    }
}

/// One parsed expression.
#[derive(Debug, Clone, PartialEq)]
pub enum Expr {
    /// `{"date":"2026-09-30"}`, optionally with `time`.
    Absolute { date: Date, time: Option<Time> },
    /// `{"unit":…,"rel":…}` with its optional qualifiers.
    Relative {
        unit: Unit,
        rel: i64,
        name: Option<i8>,
        weekday: Option<i8>,
        time: Option<Time>,
        row: bool,
    },
    /// `{"from":…,"to":…}`; one end may be left out for an open span
    /// ("since March", "before Friday").
    Span(Option<Box<Self>>, Option<Box<Self>>),
}

/// A row's date: a day, optionally with a time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Stamp {
    pub date: Date,
    pub time: Option<Time>,
}

impl Stamp {
    #[must_use]
    pub fn at(self) -> DateTime {
        self.date.to_datetime(self.time.unwrap_or(Time::midnight()))
    }

    /// Parse a vault spelling: `2026-06-19`, `2026-06-19T09:00:00`,
    /// `2026-06-19T09:00:00.000Z`, `2026-06-19 09:00`.
    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        let text = text.trim();
        let date: Date = text.get(..10)?.parse().ok()?;
        let rest = text.get(10..).unwrap_or("");
        if rest.is_empty() {
            return Some(Self { date, time: None });
        }
        let clock = rest.trim_start_matches(['T', ' ']);
        let hour: i8 = clock.get(0..2)?.parse().ok()?;
        let minute: i8 = clock.get(3..5)?.parse().ok()?;
        let time = Time::new(hour, minute, 0, 0).ok()?;
        Some(Self {
            date,
            time: Some(time),
        })
    }

    /// `Fri 2026-06-19 09:00` or `Fri 2026-06-19`.
    #[must_use]
    pub fn show(self) -> String {
        match self.time {
            Some(time) => format!("{} {}", day_label(self.date), clock(time)),
            None => day_label(self.date),
        }
    }

    /// The floating vault spelling the schedule tables take.
    #[must_use]
    pub fn vault(self) -> String {
        match self.time {
            Some(time) => format!("{}T{}:00", self.date, clock(time)),
            None => self.date.to_string(),
        }
    }
}

/// What an expression resolves to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Resolved {
    /// Whole days, inclusive.
    Days { from: Date, to: Date },
    /// One instant, minute precision.
    At(DateTime),
    /// A span with at least one timed end, inclusive.
    Between { from: DateTime, to: DateTime },
}

impl Resolved {
    /// The echo the response carries: `2025-11-01..2025-11-30`.
    #[must_use]
    pub fn echo(self) -> String {
        if self.is_open() {
            let (from, to) = self.ends();
            let side = |at: DateTime, open: bool| {
                if open {
                    String::new()
                } else if at.time() == Time::midnight() || matches!(self, Self::Days { .. }) {
                    at.date().to_string()
                } else {
                    format!("{} {}", at.date(), clock(at.time()))
                }
            };
            return format!(
                "{}..{}",
                side(from, from.date() == Date::MIN),
                side(to, to.date() == Date::MAX)
            );
        }
        match self {
            Self::Days { from, to } if from == to => day_label(from),
            Self::Days { from, to } => format!("{from}..{to}"),
            Self::At(at) => format!("{} {}", day_label(at.date()), clock(at.time())),
            Self::Between { from, to } => format!(
                "{} {}..{} {}",
                from.date(),
                clock(from.time()),
                to.date(),
                clock(to.time())
            ),
        }
    }

    /// The resolution as the prompt's `dates:` line writes it: ISO days and
    /// `HH:MM` clocks without weekday labels (`2026-10-03`,
    /// `2026-09-21..2026-09-27`, `2026-10-03 15:00`); an open end is left
    /// empty (`..2026-10-01`).
    #[must_use]
    pub fn plain(self) -> String {
        if self.is_open() {
            let (from, to) = self.ends();
            let side = |at: DateTime, open: bool| {
                if open {
                    String::new()
                } else if at.time() == Time::midnight() || matches!(self, Self::Days { .. }) {
                    at.date().to_string()
                } else {
                    format!("{} {}", at.date(), clock(at.time()))
                }
            };
            return format!(
                "{}..{}",
                side(from, from.date() == Date::MIN),
                side(to, to.date() == Date::MAX)
            );
        }
        match self {
            Self::Days { from, to } if from == to => from.to_string(),
            Self::Days { from, to } => format!("{from}..{to}"),
            Self::At(at) => format!("{} {}", at.date(), clock(at.time())),
            Self::Between { from, to } => format!(
                "{} {}..{} {}",
                from.date(),
                clock(from.time()),
                to.date(),
                clock(to.time())
            ),
        }
    }

    /// Whether a row's date falls inside.
    #[must_use]
    pub fn contains(self, stamp: Stamp) -> bool {
        match self {
            Self::Days { from, to } => from <= stamp.date && stamp.date <= to,
            Self::At(at) => match stamp.time {
                Some(time) => {
                    stamp.date == at.date()
                        && time.hour() == at.hour()
                        && time.minute() == at.minute()
                }
                None => stamp.date == at.date(),
            },
            Self::Between { from, to } => match stamp.time {
                Some(_) => from <= stamp.at() && stamp.at() <= to,
                None => from.date() <= stamp.date && stamp.date <= to.date(),
            },
        }
    }

    /// Whether one end is open (`Date::MIN` or `Date::MAX`): a filter can
    /// take it, a write cannot.
    #[must_use]
    pub fn is_open(self) -> bool {
        let (from, to) = self.ends();
        from.date() == Date::MIN || to.date() == Date::MAX
    }

    /// The single point a write sets: a day or an instant.
    #[must_use]
    pub fn point(self) -> Option<Stamp> {
        match self {
            Self::Days { from, to } if from == to => Some(Stamp {
                date: from,
                time: None,
            }),
            Self::At(at) => Some(Stamp {
                date: at.date(),
                time: Some(Time::new(at.hour(), at.minute(), 0, 0).ok()?),
            }),
            _ => None,
        }
    }

    /// The first day of a closed range, for a write that takes one day (nt14 N5: a task due "in
    /// October" is due on the 1st). `None` for a day, an instant (`point` has those) and an
    /// open-ended range.
    #[must_use]
    pub fn first_day(self) -> Option<Stamp> {
        if self.is_open() || self.point().is_some() {
            return None;
        }
        let (from, _) = self.ends();
        Some(Stamp {
            date: from.date(),
            time: None,
        })
    }

    /// The part of the day around an instant (nt14 N9): morning 05:00 to 11:59, afternoon 12:00
    /// to 16:59, evening 17:00 to 23:59, as its name and the span. `None` for any other
    /// expression and for the small hours.
    #[must_use]
    pub fn part_of_day(self) -> Option<(&'static str, Self)> {
        let Self::At(at) = self else {
            return None;
        };
        let (name, from, to) = match at.hour() {
            5..=11 => ("morning", 5, 11),
            12..=16 => ("afternoon", 12, 16),
            17..=23 => ("evening", 17, 23),
            _ => return None,
        };
        let edge = |hour: i8, minute: i8| {
            Time::new(hour, minute, 0, 0)
                .ok()
                .map(|time| at.date().to_datetime(time))
        };
        Some((
            name,
            Self::Between {
                from: edge(from, 0)?,
                to: edge(to, 59)?,
            },
        ))
    }

    /// The first and last point, for a span a write takes (event start/end).
    #[must_use]
    pub fn ends(self) -> (DateTime, DateTime) {
        match self {
            Self::Days { from, to } => (
                from.to_datetime(Time::midnight()),
                to.to_datetime(Time::midnight()),
            ),
            Self::At(at) => (at, at),
            Self::Between { from, to } => (from, to),
        }
    }
}

/// `Fri 2026-06-19`.
#[must_use]
pub fn day_label(date: Date) -> String {
    format!("{} {date}", weekday_abbrev(date))
}

#[must_use]
pub fn weekday_abbrev(date: Date) -> &'static str {
    ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
        [usize::try_from(date.weekday().to_monday_one_offset() - 1).unwrap_or(0)]
}

#[must_use]
pub fn weekday_name(date: Date) -> &'static str {
    [
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
        "Sunday",
    ][usize::try_from(date.weekday().to_monday_one_offset() - 1).unwrap_or(0)]
}

/// `09:00`.
#[must_use]
pub fn clock(time: Time) -> String {
    format!("{:02}:{:02}", time.hour(), time.minute())
}

/// The grammar's own examples, quoted in every rejection (SPEC §4.4).
pub const EXAMPLES: &[(&str, &str)] = &[
    (r#"{"unit":"month","name":11,"rel":-1}"#, "last november"),
    (r#"{"unit":"day","rel":0}"#, "today"),
    (r#"{"unit":"day","rel":1}"#, "tomorrow"),
    (r#"{"unit":"day","rel":-3}"#, "three days ago"),
    (r#"{"unit":"week","rel":0}"#, "this week"),
    (
        r#"{"unit":"week","rel":1,"weekday":1,"time":"14:00"}"#,
        "next monday at 2",
    ),
    (
        r#"{"unit":"hour","rel":-1,"anchor":"row"}"#,
        "an hour earlier",
    ),
    (r#"{"date":"2026-09-30"}"#, "a date"),
    (
        r#"{"date":"2026-09-30","time":"09:30"}"#,
        "a date with a time",
    ),
    (r#"{"from":{...},"to":{...}}"#, "a span"),
    (r#"{"to":{"unit":"day","rel":-1}}"#, "before today"),
];

/// `error: …` plus the example of the key that failed (the grammar's examples when no key is
/// named): a bad time quotes the date with a time, a bad weekday the weekday, and so on.
#[must_use]
pub fn rejection(why: &str) -> String {
    let words: Vec<&str> = why.split_whitespace().collect();
    let wanted: &[&str] = match words.first().copied() {
        Some("time") => &["a date with a time"],
        Some("date") => &["a date", "a date with a time"],
        Some("weekday") => &["next monday at 2"],
        Some("name") => &["last november"],
        Some("rel" | "unit") => &["today", "tomorrow", "three days ago", "this week"],
        Some("anchor") => &["an hour earlier"],
        Some("a" | "span") if why.contains("span") => &["a span", "before today"],
        _ => &[],
    };
    let examples: Vec<String> = EXAMPLES
        .iter()
        .filter(|(_, gloss)| wanted.is_empty() || wanted.contains(gloss))
        .map(|(expr, gloss)| format!("{expr} = {gloss}"))
        .collect();
    format!(
        "error: could not read the date expression ({why}). Date expressions: {}",
        examples.join(" · ")
    )
}

/// THE LEXICAL LENIENCY OF A DATE EXPRESSION (SPEC §4.4, nt12 R3): a form that is not ambiguous
/// is read as the grammar's own, with one note each: a time `9:30`, `9pm`, `9 pm`, `21:00:00`
/// (a bare `9` stays an error: it is 9 or 21), a `rel` written as text (`"1"`), a `weekday` or a
/// month `name` written as a word (`friday`, `november`). Spans are read end by end; the
/// expression may be an object or its JSON text. What it does not read it leaves as it is for
/// `parse` to refuse.
#[must_use]
pub fn lenient(value: &Value) -> (Value, Vec<String>) {
    let mut notes = Vec::new();
    let fixed = lenient_in(value, &mut notes);
    (fixed, notes)
}

fn lenient_in(value: &Value, notes: &mut Vec<String>) -> Value {
    // a date written as its text (`2026-10-05`, `2026-10-05T09:30`) is the absolute expression
    if let Value::String(text) = value
        && let Some(expr) = text_date(text)
    {
        notes.push(format!("note: read {} as {expr}", text.trim()));
        return expr;
    }
    let owned;
    let value = match value {
        Value::String(text) if text.trim_start().starts_with('{') => {
            match serde_json::from_str::<Value>(text) {
                Ok(parsed) => {
                    owned = parsed;
                    &owned
                }
                Err(_) => return value.clone(),
            }
        }
        other => other,
    };
    let Some(object) = value.as_object() else {
        return value.clone();
    };
    let mut out = object.clone();
    for end in ["from", "to"] {
        if let Some(inner) = object.get(end).filter(|inner| !inner.is_null()) {
            out.insert(end.to_owned(), lenient_in(inner, notes));
        }
    }
    if let Some(Value::String(text)) = object.get("time")
        && let Some(clock) = lenient_time(text)
        && clock != *text
    {
        notes.push(format!("note: read time {text} as {clock}"));
        out.insert("time".to_owned(), json!(clock));
    }
    if let Some(Value::String(text)) = object.get("rel")
        && let Ok(number) = text.trim().trim_start_matches('+').parse::<i64>()
    {
        notes.push(format!("note: read rel \"{text}\" as {number}"));
        out.insert("rel".to_owned(), json!(number));
    }
    for (key, numbered) in [
        ("weekday", weekday_number as fn(&str) -> Option<i64>),
        ("name", month_number),
    ] {
        if let Some(Value::String(text)) = object.get(key)
            && let Some(number) = numbered(text)
        {
            notes.push(format!("note: read {key} {text} as {number}"));
            out.insert(key.to_owned(), json!(number));
        }
    }
    Value::Object(out)
}

/// `{"date": …}` (with a `time` when the text has one) for a date written as `YYYY-MM-DD` or
/// `YYYY-MM-DDTHH:MM`: the one reading it has.
fn text_date(text: &str) -> Option<Value> {
    let stamp = Stamp::parse(text.trim())?;
    let mut out = serde_json::Map::new();
    out.insert("date".to_owned(), json!(stamp.date.to_string()));
    if let Some(time) = stamp.time {
        out.insert("time".to_owned(), json!(clock(time)));
    }
    Some(Value::Object(out))
}

/// A clock in a form that is no ambiguity, as `HH:MM`: `9:30`, `9pm`, `9 pm`, `9:30pm`,
/// `21:00:00`; `None` for what it cannot read, and for a bare hour.
fn lenient_time(text: &str) -> Option<String> {
    let lower = text.trim().to_lowercase();
    let (body, pm) = match (lower.strip_suffix("pm"), lower.strip_suffix("am")) {
        (Some(body), _) => (body.trim_end(), Some(true)),
        (_, Some(body)) => (body.trim_end(), Some(false)),
        _ => (lower.as_str(), None),
    };
    let mut parts = body.split(':');
    let hour: i8 = parts.next()?.trim().parse().ok()?;
    let minute: i8 = match parts.next() {
        Some(minute) => minute.parse().ok()?,
        None if pm.is_some() => 0,
        None => return None,
    };
    match parts.next() {
        None => {}
        Some("00") if parts.next().is_none() => {}
        Some(_) => return None,
    }
    let hour = match pm {
        Some(pm) => {
            if !(1..=12).contains(&hour) {
                return None;
            }
            hour % 12 + if pm { 12 } else { 0 }
        }
        None => hour,
    };
    Time::new(hour, minute, 0, 0).ok().map(clock)
}

fn weekday_number(text: &str) -> Option<i64> {
    let word = text.trim().to_lowercase();
    if let Ok(number) = word.parse::<i64>() {
        return Some(number);
    }
    ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
        .iter()
        .position(|short| word.len() >= 3 && word.starts_with(short))
        .map(|at| at as i64 + 1)
}

fn month_number(text: &str) -> Option<i64> {
    let word = text.trim().to_lowercase();
    if let Ok(number) = word.parse::<i64>() {
        return Some(number);
    }
    [
        "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
    ]
    .iter()
    .position(|short| word.len() >= 3 && word.starts_with(short))
    .map(|at| at as i64 + 1)
}

/// Parse an expression, strictly. `why` in the error is the first problem.
pub fn parse(value: &Value) -> Result<Expr, String> {
    parse_at(value, true)
}

fn parse_at(value: &Value, top: bool) -> Result<Expr, String> {
    let value = match value {
        Value::String(text) => &serde_json::from_str::<Value>(text)
            .map_err(|_| "it is not a JSON object".to_owned())?,
        other => other,
    };
    let object = value
        .as_object()
        .ok_or_else(|| "it is not a JSON object".to_owned())?;
    if object.contains_key("from") || object.contains_key("to") {
        if !top {
            return Err("a span end cannot itself be a span".to_owned());
        }
        for key in object.keys() {
            if key != "from" && key != "to" {
                return Err(format!("a span takes only from and to, not {key}"));
            }
        }
        let end = |key: &str| -> Result<Option<Box<Expr>>, String> {
            object
                .get(key)
                .filter(|value| !value.is_null())
                .map(|value| parse_at(value, false).map(Box::new))
                .transpose()
        };
        let (from, to) = (end("from")?, end("to")?);
        if from.is_none() && to.is_none() {
            return Err("a span needs from, to or both".to_owned());
        }
        return Ok(Expr::Span(from, to));
    }
    let time = match object.get("time") {
        None => None,
        Some(Value::String(text)) => Some(parse_time(text)?),
        Some(_) => return Err("time is \"HH:MM\"".to_owned()),
    };
    if let Some(date) = object.get("date") {
        for key in object.keys() {
            if key != "date" && key != "time" {
                return Err(format!("a date takes only time beside it, not {key}"));
            }
        }
        let date: Date = date
            .as_str()
            .and_then(|text| text.parse().ok())
            .ok_or_else(|| "date is \"YYYY-MM-DD\"".to_owned())?;
        return Ok(Expr::Absolute { date, time });
    }
    for key in object.keys() {
        if !["unit", "rel", "name", "weekday", "time", "anchor"].contains(&key.as_str()) {
            return Err(format!(
                "unknown key {key}; keys are unit, rel, name, weekday, time, anchor, date, from, to"
            ));
        }
    }
    let unit_text = object
        .get("unit")
        .and_then(Value::as_str)
        .ok_or_else(|| "an expression needs unit or date".to_owned())?;
    let unit = Unit::parse(unit_text)
        .ok_or_else(|| format!("unit {unit_text} is not one of {}", Unit::NAMES.join(", ")))?;
    let rel = object
        .get("rel")
        .and_then(Value::as_i64)
        .ok_or_else(|| "rel is a signed whole number and is required".to_owned())?;
    if rel.abs() > 1000 {
        return Err("rel is out of range".to_owned());
    }
    let name = match object.get("name") {
        None => None,
        Some(value) => {
            if unit != Unit::Month {
                return Err("name goes only with unit month".to_owned());
            }
            let month = value
                .as_i64()
                .filter(|month| (1..=12).contains(month))
                .ok_or_else(|| "name is a month number 1..12".to_owned())?;
            Some(i8::try_from(month).unwrap_or(1))
        }
    };
    let weekday = match object.get("weekday") {
        None => None,
        Some(value) => {
            if unit != Unit::Week {
                return Err("weekday goes only with unit week".to_owned());
            }
            let day = value
                .as_i64()
                .filter(|day| (1..=7).contains(day))
                .ok_or_else(|| "weekday is 1..7, Monday..Sunday".to_owned())?;
            Some(i8::try_from(day).unwrap_or(1))
        }
    };
    let row = match object.get("anchor").map(Value::as_str) {
        None | Some(Some("today")) => false,
        Some(Some("row")) => true,
        Some(_) => return Err("anchor is today or row".to_owned()),
    };
    if time.is_some() && !(unit == Unit::Day || (unit == Unit::Week && weekday.is_some())) {
        return Err("time goes only with unit day, a week with a weekday, or a date".to_owned());
    }
    if row && name.is_some() {
        return Err("a month name cannot be anchored to the row".to_owned());
    }
    Ok(Expr::Relative {
        unit,
        rel,
        name,
        weekday,
        time,
        row,
    })
}

fn parse_time(text: &str) -> Result<Time, String> {
    let bad = || format!("time {text} is not \"HH:MM\"");
    let (hour, minute) = text.split_once(':').ok_or_else(bad)?;
    if hour.len() != 2 || minute.len() != 2 {
        return Err(bad());
    }
    let hour: i8 = hour.parse().map_err(|_| bad())?;
    let minute: i8 = minute.parse().map_err(|_| bad())?;
    Time::new(hour, minute, 0, 0).map_err(|_| bad())
}

/// Whether an expression names the row anchor anywhere.
#[must_use]
pub fn uses_row(expr: &Expr) -> bool {
    match expr {
        Expr::Relative { row, .. } => *row,
        Expr::Span(from, to) => {
            from.as_deref().is_some_and(uses_row) || to.as_deref().is_some_and(uses_row)
        }
        Expr::Absolute { .. } => false,
    }
}

/// Evaluate against `now` (today and the current time) and, for `anchor:
/// row`, the target row's date.
pub fn evaluate(expr: &Expr, now: DateTime, row: Option<Stamp>) -> Result<Resolved, String> {
    match expr {
        Expr::Absolute { date, time } => Ok(match time {
            Some(time) => Resolved::At(date.to_datetime(*time)),
            None => Resolved::Days {
                from: *date,
                to: *date,
            },
        }),
        Expr::Span(from, to) => {
            // AN OPEN END is the calendar's own limit: "since March" runs to
            // the end of time, "before Friday" from its start.
            let from = match from {
                Some(from) => evaluate(from, now, row)?,
                None => Resolved::Days {
                    from: Date::MIN,
                    to: Date::MIN,
                },
            };
            let to = match to {
                Some(to) => evaluate(to, now, row)?,
                None => Resolved::Days {
                    from: Date::MAX,
                    to: Date::MAX,
                },
            };
            let (start, _) = from.ends();
            let end = match to {
                Resolved::Days { to, .. } => to.to_datetime(Time::constant(23, 59, 0, 0)),
                Resolved::At(at) => at,
                Resolved::Between { to, .. } => to,
            };
            if end < start {
                return Err("the span ends before it starts".to_owned());
            }
            Ok(match (from, to) {
                (Resolved::Days { from, .. }, Resolved::Days { to, .. }) => {
                    Resolved::Days { from, to }
                }
                _ => Resolved::Between {
                    from: start,
                    to: end,
                },
            })
        }
        Expr::Relative {
            unit,
            rel,
            name,
            weekday,
            time,
            row: anchored,
        } => {
            if *anchored {
                let stamp = row.ok_or_else(|| {
                    "anchor row needs a target row with a date; anchor row is legal only inside act"
                        .to_owned()
                })?;
                relative_to_row(*unit, *rel, *weekday, *time, stamp)
            } else {
                relative_to_today(*unit, *rel, *name, *weekday, *time, now)
            }
        }
    }
}

fn shift(date: Date, span: Span) -> Result<Date, String> {
    date.checked_add(span)
        .map_err(|_| "the date is out of range".to_owned())
}

fn monday_of(date: Date) -> Result<Date, String> {
    let back = i64::from(date.weekday().to_monday_one_offset() - 1);
    shift(date, (-back).days())
}

fn day_or_at(date: Date, time: Option<Time>) -> Resolved {
    match time {
        Some(time) => Resolved::At(date.to_datetime(time)),
        None => Resolved::Days {
            from: date,
            to: date,
        },
    }
}

fn month_range(year: i16, month: i8) -> Result<Resolved, String> {
    let first = Date::new(year, month, 1).map_err(|_| "the month is out of range".to_owned())?;
    Ok(Resolved::Days {
        from: first,
        to: first.last_of_month(),
    })
}

fn relative_to_today(
    unit: Unit,
    rel: i64,
    name: Option<i8>,
    weekday: Option<i8>,
    time: Option<Time>,
    now: DateTime,
) -> Result<Resolved, String> {
    let today = now.date();
    match unit {
        Unit::Minute | Unit::Hour => {
            let span = if unit == Unit::Minute {
                rel.minutes()
            } else {
                rel.hours()
            };
            now.checked_add(span)
                .map(Resolved::At)
                .map_err(|_| "the instant is out of range".to_owned())
        }
        Unit::Day => Ok(day_or_at(shift(today, rel.days())?, time)),
        Unit::Week => {
            let monday = shift(monday_of(today)?, (rel * 7).days())?;
            match weekday {
                Some(day) => Ok(day_or_at(shift(monday, i64::from(day - 1).days())?, time)),
                None => Ok(Resolved::Days {
                    from: monday,
                    to: shift(monday, 6.days())?,
                }),
            }
        }
        Unit::Month => match name {
            // THE NAMED MONTH (SPEC §14): rel -1 is the most recent FULLY ENDED
            // month of that name, rel 1 the next one that has not begun, rel 0
            // this year's; further rels step whole years from those.
            Some(month) => {
                let current = today.month();
                let year = i64::from(today.year());
                let year = match rel.cmp(&0) {
                    std::cmp::Ordering::Less => {
                        let base = if month < current { year } else { year - 1 };
                        base + rel + 1
                    }
                    std::cmp::Ordering::Greater => {
                        let base = if month > current { year } else { year + 1 };
                        base + rel - 1
                    }
                    std::cmp::Ordering::Equal => year,
                };
                month_range(
                    i16::try_from(year).map_err(|_| "the year is out of range".to_owned())?,
                    month,
                )
            }
            None => {
                let first = shift(today.first_of_month(), rel.months())?;
                Ok(Resolved::Days {
                    from: first,
                    to: first.last_of_month(),
                })
            }
        },
        Unit::Year => {
            let year = i64::from(today.year()) + rel;
            let year = i16::try_from(year).map_err(|_| "the year is out of range".to_owned())?;
            Ok(Resolved::Days {
                from: Date::new(year, 1, 1).map_err(|_| "the year is out of range".to_owned())?,
                to: Date::new(year, 12, 31).map_err(|_| "the year is out of range".to_owned())?,
            })
        }
    }
}

fn relative_to_row(
    unit: Unit,
    rel: i64,
    weekday: Option<i8>,
    time: Option<Time>,
    stamp: Stamp,
) -> Result<Resolved, String> {
    let keep = |date: Date| -> Resolved {
        match (time, stamp.time) {
            (Some(time), _) | (None, Some(time)) => Resolved::At(date.to_datetime(time)),
            (None, None) => Resolved::Days {
                from: date,
                to: date,
            },
        }
    };
    match unit {
        Unit::Minute | Unit::Hour => {
            let span = if unit == Unit::Minute {
                rel.minutes()
            } else {
                rel.hours()
            };
            stamp
                .at()
                .checked_add(span)
                .map(Resolved::At)
                .map_err(|_| "the instant is out of range".to_owned())
        }
        Unit::Day => Ok(keep(shift(stamp.date, rel.days())?)),
        Unit::Week => match weekday {
            Some(day) => {
                let monday = shift(monday_of(stamp.date)?, (rel * 7).days())?;
                Ok(keep(shift(monday, i64::from(day - 1).days())?))
            }
            None => Ok(keep(shift(stamp.date, (rel * 7).days())?)),
        },
        Unit::Month => Ok(keep(shift(stamp.date, rel.months())?)),
        Unit::Year => Ok(keep(shift(stamp.date, rel.years())?)),
    }
}

/// Parse `--today`: `YYYY-MM-DD` (09:00 assumed) or `YYYY-MM-DDTHH:MM`.
pub fn parse_now(text: &str) -> Result<DateTime, String> {
    let stamp = Stamp::parse(text).ok_or_else(|| format!("--today {text} is not YYYY-MM-DD"))?;
    Ok(stamp
        .date
        .to_datetime(stamp.time.unwrap_or(Time::constant(9, 0, 0, 0))))
}

/// A relative label for a day seen from today: `today`, `tomorrow`,
/// `yesterday`, `this Friday`, `next Monday`, `last Friday`.
#[must_use]
pub fn relative_label(date: Date, today: Date) -> Option<String> {
    match (date - today).get_days() {
        0 => return Some("today".to_owned()),
        1 => return Some("tomorrow".to_owned()),
        -1 => return Some("yesterday".to_owned()),
        _ => {}
    }
    let this_monday = monday_of(today).ok()?;
    let their_monday = monday_of(date).ok()?;
    let weeks = their_monday.since(this_monday).ok()?.get_days() / 7;
    let prefix = match weeks {
        0 => "this",
        1 => "next",
        -1 => "last",
        _ => return None,
    };
    Some(format!("{prefix} {}", weekday_name(date)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now(text: &str) -> DateTime {
        parse_now(text).expect("a date")
    }

    fn eval(expr: &str, today: &str) -> String {
        let expr = parse(&serde_json::from_str(expr).expect("json")).expect("parses");
        evaluate(&expr, now(today), None).expect("evaluates").echo()
    }

    #[test]
    fn last_november_in_january_is_the_one_just_ended() {
        assert_eq!(
            eval(r#"{"unit":"month","name":11,"rel":-1}"#, "2027-01-19"),
            "2026-11-01..2026-11-30"
        );
        assert_eq!(
            eval(r#"{"unit":"month","name":11,"rel":-1}"#, "2026-11-10"),
            "2025-11-01..2025-11-30"
        );
    }

    #[test]
    fn misplaced_qualifiers_are_rejected_with_examples() {
        let error = parse(&serde_json::json!({"unit":"day","rel":1,"weekday":2})).unwrap_err();
        assert!(error.contains("weekday goes only with unit week"));
        assert!(rejection(&error).contains("next monday at 2"));
        assert!(parse(&serde_json::json!({"unit":"month","rel":0,"time":"10:00"})).is_err());
        assert!(parse(&serde_json::json!({"unit":"fortnight","rel":0})).is_err());
        assert!(parse(&serde_json::json!({"unit":"day"})).is_err());
    }

    #[test]
    fn the_row_anchor_needs_a_row() {
        let expr = parse(&serde_json::json!({"unit":"hour","rel":-1,"anchor":"row"})).unwrap();
        assert!(evaluate(&expr, now("2026-09-27"), None).is_err());
        let row = Stamp::parse("2026-06-19T09:00:00").unwrap();
        assert_eq!(
            evaluate(&expr, now("2026-09-27"), Some(row))
                .unwrap()
                .echo(),
            "Fri 2026-06-19 08:00"
        );
    }

    #[test]
    fn relative_labels_read_the_week_from_monday() {
        let today: Date = "2026-09-27".parse().unwrap(); // a Sunday
        let next_monday: Date = "2026-09-28".parse().unwrap();
        assert_eq!(relative_label(next_monday, today).unwrap(), "tomorrow");
        let friday: Date = "2026-10-02".parse().unwrap();
        assert_eq!(relative_label(friday, today).unwrap(), "next Friday");
        let last_friday: Date = "2026-09-25".parse().unwrap();
        assert_eq!(relative_label(last_friday, today).unwrap(), "this Friday");
    }
}
