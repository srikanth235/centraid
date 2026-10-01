//! GROUNDING THE MODEL'S DATES IN THE USER'S WORDS.
//!
//! A trained model writes date expressions and sometimes computes them
//! wrongly: a bare weekday read as next week, "the twentieth" put in the wrong
//! month, "in an hour" turned into a weekday. The runtime sees the user's
//! message of the turn, so it reads the *unambiguous* date phrases in it with
//! the SPEC §14.1 rules and, when the model's expression contradicts the one
//! phrase the message has, replaces it and says so in the observation.
//!
//! Conservative by construction. A date the model wrote is replaced only when
//!
//! - the message states exactly one reading (a bare or "next" weekday, today,
//!   tomorrow, yesterday, "in an hour"; several phrases only if they all mean
//!   the same day), with no broader phrase (a week, a month, a span operator
//!   such as "from" or "between");
//! - the model's expression resolves to one day or instant that disagrees
//!   with it; and
//! - the field being repaired is the one the phrase governs: a phrase that
//!   names the row ("the one due tomorrow", "friday's call") never becomes the
//!   new date of a reschedule or edit, which needs a destination phrase ("to
//!   friday", "make it due friday"); a span is only repaired when both its ends
//!   are on the same day.
//!
//! A bare weekday ("thursday") is also left alone when it may continue the
//! talk rather than start it: it is today's weekday, the turn before read
//! dates in a later week, or it is a short answer to a turn that only asked.
//! "next friday", "tomorrow" and "in an hour" need no such context.
//!
//! A bare day of the month ("the twenty-ninth", "the third") and a named
//! month and day are never read into a date: the year, month and direction are
//! the model's. The one exception is a date that does not exist
//! ("2026-11-31") under a single stated ordinal. When unsure, nothing is
//! rewritten. This is a deliberate exception to SPEC §3.3's "the runtime does
//! not look at the message": it never picks rows, only repairs a date the
//! message states outright.

use jiff::ToSpan as _;
use jiff::civil::{Date, DateTime, Time};
use serde_json::{Map, Value, json};

use crate::dates::{self, Resolved};
use crate::session::Session;

const WEEKDAYS: [(&str, i8); 17] = [
    ("monday", 1),
    ("tuesday", 2),
    ("tue", 2),
    ("tues", 2),
    ("wednesday", 3),
    ("thursday", 4),
    ("thu", 4),
    ("thur", 4),
    ("thurs", 4),
    ("friday", 5),
    ("fri", 5),
    ("saturday", 6),
    ("sunday", 7),
    ("mon", 1),
    ("wed", 3),
    ("sat", 6),
    ("sun", 7),
];
/// Short spellings that are also ordinary words: not read as a weekday.
const WORD_LIKE: [&str; 4] = ["mon", "wed", "sat", "sun"];

const MONTHS: [(&str, i8); 21] = [
    ("january", 1),
    ("jan", 1),
    ("february", 2),
    ("feb", 2),
    ("march", 3),
    ("april", 4),
    ("may", 5),
    ("june", 6),
    ("july", 7),
    ("august", 8),
    ("aug", 8),
    ("september", 9),
    ("sept", 9),
    ("sep", 9),
    ("october", 10),
    ("oct", 10),
    ("november", 11),
    ("nov", 11),
    ("december", 12),
    ("dec", 12),
    ("jul", 7),
];

/// Words that make the message speak of more than one day: nothing is
/// replaced.
const BROAD: [&str; 21] = [
    "week", "weeks", "weekend", "weekends", "month", "months", "year", "years", "every", "daily",
    "weekly", "monthly", "ago", "later", "earlier", "before", "after", "since", "until", "till",
    "between",
];
const SPANNING: [&str; 4] = ["through", "from", "onwards", "overdue"];

/// One date phrase of the message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phrase {
    /// A day the words fix on their own: tomorrow, "next friday", "the 3rd of
    /// may".
    Day(Date),
    /// A bare or "this" weekday. Looking ahead ("cancel it on saturday") it is
    /// the next one; looking back ("who did i see monday") it may be this
    /// week's, already past, so only forward-looking calls use it.
    Weekday(Date),
    /// "in an hour": an instant.
    Instant(DateTime),
    /// A bare "the 20th" with no month.
    Ordinal(i8),
}

/// What a phrase is about in the sentence around it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Role {
    /// It names the row ("the one due tomorrow", "friday's call", "from
    /// monday"): a filter's date, never a write's new date.
    Row,
    /// It names where a write puts the row ("to friday", "make it due
    /// friday", "instead on thursday").
    Dest,
    /// Nothing around it says which.
    Free,
}

/// What the message says about dates.
#[derive(Debug, Default)]
pub(crate) struct Said {
    phrases: Vec<(Phrase, String, Role)>,
    /// Clock times written as "at 9pm" / "to 19:00".
    clocks: Vec<Time>,
    /// The message speaks of a wider period, or of a month by name.
    broad: bool,
    month_named: bool,
    /// Words in the message.
    len: usize,
}

impl Said {
    /// The one day the message names, when it names exactly one thing.
    pub(crate) fn only_day(&self, ahead: bool) -> Option<(Date, &str)> {
        match self.only()? {
            (Phrase::Day(date), text) => Some((date, text)),
            (Phrase::Weekday(date), text) if ahead => Some((date, text)),
            _ => None,
        }
    }

    fn only(&self) -> Option<(Phrase, &str)> {
        if self.broad {
            return None;
        }
        let (first, text, _) = self.phrases.first()?;
        self.phrases
            .iter()
            .all(|(phrase, _, _)| same_reading(phrase, first))
            .then_some((*first, text.as_str()))
    }

    /// Whether every phrase has a role the caller accepts.
    fn all_roles(&self, accept: impl Fn(Role) -> bool) -> bool {
        self.phrases.iter().all(|(_, _, role)| accept(*role))
    }

    fn only_clock(&self) -> Option<Time> {
        (self.clocks.len() == 1).then(|| self.clocks[0])
    }

    /// Distinct bare ordinals, when the message holds nothing else that
    /// states a date.
    fn ordinals(&self) -> Vec<i8> {
        if self.month_named {
            return Vec::new();
        }
        let mut days = Vec::new();
        for (phrase, _, _) in &self.phrases {
            if let Phrase::Ordinal(day) = phrase
                && !days.contains(day)
            {
                days.push(*day);
            }
        }
        days
    }
}

/// Two phrases that mean the same day or instant.
fn same_reading(a: &Phrase, b: &Phrase) -> bool {
    match (a, b) {
        (Phrase::Day(x) | Phrase::Weekday(x), Phrase::Day(y) | Phrase::Weekday(y)) => x == y,
        _ => a == b,
    }
}

fn shift(date: Date, days: i64) -> Option<Date> {
    date.checked_add(days.days()).ok()
}

fn monday_of(date: Date) -> Option<Date> {
    shift(date, -i64::from(date.weekday().to_monday_one_offset() - 1))
}

fn weekday_of(text: &str) -> Option<i8> {
    if WORD_LIKE.contains(&text) {
        return None;
    }
    WEEKDAYS
        .iter()
        .find(|(name, _)| *name == text)
        .map(|(_, day)| *day)
}

fn month_of(text: &str) -> Option<i8> {
    MONTHS
        .iter()
        .find(|(name, _)| *name == text)
        .map(|(_, month)| *month)
}

fn word_ordinal(text: &str) -> Option<i8> {
    const UNITS: [&str; 19] = [
        "first",
        "second",
        "third",
        "fourth",
        "fifth",
        "sixth",
        "seventh",
        "eighth",
        "ninth",
        "tenth",
        "eleventh",
        "twelfth",
        "thirteenth",
        "fourteenth",
        "fifteenth",
        "sixteenth",
        "seventeenth",
        "eighteenth",
        "nineteenth",
    ];
    if let Some(at) = UNITS.iter().position(|unit| *unit == text) {
        return i8::try_from(at + 1).ok();
    }
    match text {
        "twentieth" => Some(20),
        "thirtieth" => Some(30),
        _ => None,
    }
}

fn numeric_ordinal(text: &str) -> Option<i8> {
    let digits = text
        .strip_suffix("st")
        .or_else(|| text.strip_suffix("nd"))
        .or_else(|| text.strip_suffix("rd"))
        .or_else(|| text.strip_suffix("th"))?;
    let day: i8 = digits.parse().ok()?;
    (1..=31).contains(&day).then_some(day)
}

/// `9pm`, `7am`, `6:30pm`, `19:00`.
fn clock_of(text: &str) -> Option<Time> {
    let (body, meridiem) = if let Some(body) = text.strip_suffix("pm") {
        (body, Some(true))
    } else if let Some(body) = text.strip_suffix("am") {
        (body, Some(false))
    } else {
        (text, None)
    };
    let (hour, minute) = match body.split_once([':', '.']) {
        Some((hour, minute)) if minute.len() == 2 => (hour, minute),
        Some(_) => return None,
        None if meridiem.is_some() => (body, "00"),
        None => return None,
    };
    // Without am/pm only an unmistakable 24-hour clock: "7:30" is "at N".
    if meridiem.is_none() && !(body.contains(':') && (body.starts_with('0') || hour_over_12(body)))
    {
        return None;
    }
    let mut hour: i8 = hour.parse().ok()?;
    let minute: i8 = minute.parse().ok()?;
    if let Some(pm) = meridiem {
        if !(1..=12).contains(&hour) {
            return None;
        }
        hour %= 12;
        if pm {
            hour += 12;
        }
    }
    Time::new(hour, minute, 0, 0).ok()
}

fn hour_over_12(body: &str) -> bool {
    body.split(':')
        .next()
        .and_then(|hour| hour.parse::<i8>().ok())
        .is_some_and(|hour| hour > 12)
}

/// A word of the message, lower-cased and stripped of punctuation.
struct Token {
    text: String,
    /// It was written with a possessive ("friday's").
    possessive: bool,
}

fn word_tokens(message: &str) -> Vec<Token> {
    let edge = |c: char| !c.is_alphanumeric();
    message
        .to_lowercase()
        .replace(['\u{2019}', '\u{2018}'], "'")
        .replace('-', " ")
        .split_whitespace()
        .filter_map(|word| {
            let word = word.trim_matches(edge);
            let (word, possessive) = match word.strip_suffix("'s") {
                Some(bare) => (bare, true),
                None => (word, false),
            };
            let text = word.trim_matches(edge).to_owned();
            (!text.is_empty()).then_some(Token { text, possessive })
        })
        .collect()
}

fn tokens(message: &str) -> Vec<String> {
    word_tokens(message)
        .into_iter()
        .map(|token| token.text)
        .collect()
}

/// Words that say a date belongs to the row, not to a new date.
const ROW_MARKERS: [&str; 5] = ["due", "dated", "from", "of", "scheduled"];
/// Words before "due" that make it a new due date ("make it due friday").
const SETTERS: [&str; 12] = [
    "make", "made", "set", "mark", "put", "change", "update", "give", "have", "move", "push", "to",
];
/// Words that introduce where a row goes.
const DESTINATIONS: [&str; 6] = ["to", "for", "by", "it", "them", "instead"];

/// What the words around the phrase at `words[start..=end]` make of it.
fn role_at(words: &[Token], start: usize, end: usize) -> Role {
    if words[end].possessive
        || matches!(
            words.get(end + 1).map(|t| t.text.as_str()),
            Some("one" | "ones")
        )
    {
        return Role::Row;
    }
    let mut at = start;
    while at > 0 && matches!(words[at - 1].text.as_str(), "the" | "a" | "an") {
        at -= 1;
    }
    let word = |back: usize| {
        at.checked_sub(back)
            .and_then(|i| words.get(i))
            .map(|t| t.text.as_str())
    };
    match word(1) {
        Some("due") if (2..=3).any(|back| word(back).is_some_and(|w| SETTERS.contains(&w))) => {
            Role::Dest
        }
        Some(marker) if ROW_MARKERS.contains(&marker) => Role::Row,
        Some("on") if word(2) == Some("instead") => Role::Dest,
        Some(marker) if DESTINATIONS.contains(&marker) => Role::Dest,
        _ => Role::Free,
    }
}

/// Read a message with the SPEC §14 date conventions.
pub(crate) fn said(message: &str, now: DateTime) -> Said {
    let today = now.date();
    let marked = word_tokens(message);
    let words: Vec<String> = marked.iter().map(|token| token.text.clone()).collect();
    let mut out = Said::default();
    let mut index = 0;
    // Tokens a phrase used up, so "twenty" + "seventh" is one ordinal.
    while index < words.len() {
        let word = words[index].as_str();
        let prev = index.checked_sub(1).map(|at| words[at].as_str());
        let next = words.get(index + 1).map(String::as_str);
        if BROAD.contains(&word) || SPANNING.contains(&word) {
            let after_weekday =
                word == "week" && prev.is_some_and(|prev| weekday_of(prev).is_some());
            if !after_weekday {
                out.broad = true;
            }
        }
        if matches!(word, "month" | "months" | "year" | "years") {
            out.month_named = true;
        }
        if month_of(word).is_some() && (word != "may" || next.is_some_and(is_number_like)) {
            out.month_named = true;
        }
        if let Some(day) = weekday_of(word) {
            let topic = matches!(prev, Some("about" | "regarding" | "re"));
            if !topic {
                let mut reading = None;
                if next.is_some_and(|next| next.chars().all(|c| c.is_ascii_digit())) {
                    out.broad = true; // "fri 6": a day of the month or an hour
                } else {
                    let weeks = match (prev, next) {
                        (Some("last"), _) => {
                            out.broad = true;
                            None
                        }
                        (Some("next"), _) => Some(1),
                        (_, Some("week")) => Some(2),
                        (Some("this"), _) => Some(0),
                        _ => None,
                    };
                    if let Some(weeks) = weeks {
                        reading = monday_of(today)
                            .and_then(|monday| shift(monday, weeks * 7 + i64::from(day) - 1));
                    } else if prev != Some("last") {
                        let ahead = (i64::from(day)
                            - i64::from(today.weekday().to_monday_one_offset())
                            + 7)
                            % 7;
                        reading = shift(today, ahead);
                    }
                }
                if let Some(date) = reading {
                    let phrase = if prev == Some("next") || next == Some("week") {
                        Phrase::Day(date)
                    } else {
                        Phrase::Weekday(date)
                    };
                    let start = if matches!(prev, Some("next" | "this")) {
                        index - 1
                    } else {
                        index
                    };
                    let end = if next == Some("week") {
                        index + 1
                    } else {
                        index
                    };
                    out.phrases
                        .push((phrase, word.to_owned(), role_at(&marked, start, end)));
                }
            }
        } else if matches!(word, "tomorrow" | "tmrw" | "tmr" | "tomorow") {
            out.phrases.push((
                Phrase::Day(shift(today, 1).unwrap_or(today)),
                word.to_owned(),
                role_at(&marked, index, index),
            ));
        } else if word == "today" || word == "tonight" {
            out.phrases.push((
                Phrase::Day(today),
                word.to_owned(),
                role_at(&marked, index, index),
            ));
        } else if word == "yesterday" {
            out.phrases.push((
                Phrase::Day(shift(today, -1).unwrap_or(today)),
                word.to_owned(),
                role_at(&marked, index, index),
            ));
        } else if word == "in"
            && let Some(minutes) = span_after_in(&words[index + 1..])
        {
            if let Ok(at) = now.checked_add(minutes.minutes()) {
                out.phrases
                    .push((Phrase::Instant(at), "in an hour".to_owned(), Role::Free));
            }
        } else if let Some(time) = words_clock(&words, index)
            && matches!(prev, Some("to" | "at" | "for" | "by" | "till" | "until"))
            && !ends_a_range(&words, index)
        {
            out.clocks.push(time);
        }
        // Ordinals, alone or with a month.
        let (ordinal, used) = match (numeric_ordinal(word), word_ordinal(word)) {
            (Some(day), _) => (Some(day), 1),
            (None, Some(day)) => (Some(day), 1),
            (None, None) if word == "twenty" || word == "thirty" => {
                let base: i8 = if word == "twenty" { 20 } else { 30 };
                match next.and_then(word_ordinal) {
                    Some(unit) if unit < 10 => (Some(base + unit), 2),
                    _ => (None, 1),
                }
            }
            _ => (None, 1),
        };
        if let Some(day) = ordinal {
            let after = words.get(index + used).map(String::as_str);
            let after_month = match after {
                Some("of") => words.get(index + used + 1).and_then(|w| month_of(w)),
                other => other.and_then(month_of),
            };
            let before_month = prev.and_then(month_of);
            let count_word = matches!(after, Some("one" | "ones" | "time" | "times"));
            // "the 2nd one", "first": a pick from a list, not a day.
            let low = day < 4 && !(matches!(prev, Some("the" | "on")) && after.is_none());
            let month = after_month.or(before_month);
            if !count_word {
                if let Some(month) = month {
                    if let Some(date) = named_day(today, month, day) {
                        out.phrases
                            .push((Phrase::Day(date), format!("{day} {month}"), Role::Free));
                    }
                } else if !low {
                    out.phrases
                        .push((Phrase::Ordinal(day), format!("the {day}th"), Role::Free));
                }
            }
            index += used;
            continue;
        }
        index += 1;
    }
    out
}

/// "2 to 4pm": the clock at `words[index]` ends a range that started with a
/// number, so it is not the start the call carries.
fn ends_a_range(words: &[String], index: usize) -> bool {
    index >= 2
        && words[index - 1] == "to"
        && (words[index - 2].chars().all(|c| c.is_ascii_digit())
            || clock_of(&words[index - 2]).is_some())
}

fn is_number_like(word: &str) -> bool {
    word.chars().next().is_some_and(|c| c.is_ascii_digit())
        || numeric_ordinal(word).is_some()
        || word_ordinal(word).is_some()
        || word == "twenty"
        || word == "thirty"
}

/// "in an hour" / "in 2 hours" / "in 20 minutes" / "in half an hour":
/// minutes, from the words after "in".
fn span_after_in(rest: &[String]) -> Option<i64> {
    let (count, unit) = match rest {
        [half, an, unit, ..] if half == "half" && an == "an" && unit.starts_with("hour") => {
            return Some(30);
        }
        [a, unit, ..] if a == "an" || a == "a" => (1, unit),
        [n, unit, ..] => (n.parse::<i64>().ok()?, unit),
        _ => return None,
    };
    match unit.as_str() {
        "hour" | "hours" | "hr" | "hrs" => Some(count * 60),
        "minute" | "minutes" | "min" | "mins" => Some(count),
        _ => None,
    }
}

/// A clock at `words[index]`: `9pm`, `19:00`, or `9` `pm`.
fn words_clock(words: &[String], index: usize) -> Option<Time> {
    let word = words[index].as_str();
    if let Some(time) = clock_of(word) {
        return Some(time);
    }
    let meridiem = words.get(index + 1).map(String::as_str)?;
    if (meridiem == "am" || meridiem == "pm") && word.chars().all(|c| c.is_ascii_digit()) {
        return clock_of(&format!("{word}{meridiem}"));
    }
    None
}

/// The day a named month and day fall on, the year nearest to today.
fn named_day(today: Date, month: i8, day: i8) -> Option<Date> {
    let make = |year: i16| Date::new(year, month, day).ok();
    let this = make(today.year())?;
    let gap = (this - today).get_days();
    if gap < -200 {
        make(today.year() + 1)
    } else if gap > 165 {
        make(today.year() - 1)
    } else {
        Some(this)
    }
}

/// The calendar dates written as `YYYY-MM-DD` in a text.
fn iso_dates(text: &str) -> impl Iterator<Item = Date> + '_ {
    let bytes = text.as_bytes();
    (0..bytes.len().saturating_sub(9)).filter_map(move |at| {
        let stamp = text.get(at..at + 10)?;
        let digits = stamp.bytes().enumerate().all(|(i, b)| {
            if i == 4 || i == 7 {
                b == b'-'
            } else {
                b.is_ascii_digit()
            }
        });
        if !digits {
            return None;
        }
        let (year, month, day) = parts(stamp)?;
        Date::new(year, month, day).ok()
    })
}

/// `YYYY-MM-DD` read without a calendar check, so a wrong day such as
/// `2026-11-31` still yields its parts.
fn parts(text: &str) -> Option<(i16, i8, i8)> {
    let bytes = text.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    Some((
        text.get(0..4)?.parse().ok()?,
        text.get(5..7)?.parse().ok()?,
        text.get(8..10)?.parse().ok()?,
    ))
}

/// Where a call's expression can sit.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Place {
    /// A selector's `when`: a filter. A span is a period, never edited.
    Filter,
    /// A write's date: a span is an event's start and end.
    Write,
}

/// What the call being grounded does with its dates.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Call {
    /// A read, or a write that only selects rows by date (a cancel).
    Read,
    /// A create: the `date` is the new row's.
    Create,
    /// A reschedule or an edit: `when` selects the row, `to`/`date` is where
    /// it goes.
    Move,
}

/// What the turn before this message showed of dates.
#[derive(Clone, Copy, Default)]
struct Context {
    /// The previous turn showed a date after this week: the talk is already
    /// about later weeks, and a bare weekday may mean one of them.
    later: bool,
    /// The previous turn made no call but `ask`: whatever week the person
    /// named, they named it in words the runtime no longer sees.
    asked_only: bool,
}

struct Grounder<'a> {
    said: &'a Said,
    now: DateTime,
    notes: Vec<String>,
    /// The call looks ahead (a cancel or a write of a new date).
    ahead: bool,
    call: Call,
    context: Context,
}

impl Grounder<'_> {
    /// Ground one expression value; `Some` is the replacement.
    fn expr(&mut self, value: &Value, place: Place) -> Option<Value> {
        let mut value = match value {
            Value::String(text) => serde_json::from_str::<Value>(text).ok()?,
            other => other.clone(),
        };
        if !value.is_object() {
            return None;
        }
        let mut changed = self.ordinal_dates(&mut value, place == Place::Filter);
        if let Some(fixed) = self.leaf_or_span(&value, place) {
            value = fixed;
            changed = true;
        } else if place == Place::Write
            && let Some(fixed) = self.clock_only(&value)
        {
            value = fixed;
            changed = true;
        }
        changed.then_some(value)
    }

    /// RULE C, filters only: a date that does not exist ("2026-11-31") whose
    /// day of month is the one bare ordinal the message says ("the
    /// thirty-first") is that day of this month. A date that exists is never
    /// touched, whatever month it is in: which month a bare ordinal means
    /// ("the third" in May: the 3rd of May or of June; "the twenty-ninth" of
    /// last month) is the model's call, and the authored data holds it both
    /// ways. Only a message with no other date phrase is read at all.
    fn ordinal_dates(&mut self, value: &mut Value, filter: bool) -> bool {
        if !filter {
            return false;
        }
        let days = self.said.ordinals();
        let only_ordinals = self
            .said
            .phrases
            .iter()
            .all(|(phrase, _, _)| matches!(phrase, Phrase::Ordinal(_)));
        let [day] = days[..] else {
            return false;
        };
        if !only_ordinals {
            return false;
        }
        let today = self.now.date();
        fn walk(value: &mut Value, day: i8, today: Date, notes: &mut Vec<String>) -> bool {
            let Some(object) = value.as_object_mut() else {
                return false;
            };
            let mut changed = false;
            for key in ["from", "to"] {
                if let Some(end) = object.get_mut(key) {
                    changed |= walk(end, day, today, notes);
                }
            }
            if let Some(Value::String(text)) = object.get("date")
                && let Some((year, month, written)) = parts(text)
                && written == day
                && Date::new(year, month, written).is_err()
                && let Ok(fixed) = Date::new(today.year(), today.month(), day)
            {
                notes.push(format!(
                    "date: \"the {day}\" is this month's, {}; the call had {text}; used {}.",
                    dates::day_label(fixed),
                    fixed
                ));
                object.insert("date".to_owned(), json!(fixed.to_string()));
                changed = true;
            }
            changed
        }
        walk(value, day, today, &mut self.notes)
    }

    /// Whether the one phrase of the message is about this field: a filter's
    /// `when` or a write's new date.
    fn governs(&self, place: Place) -> bool {
        match (self.call, place) {
            (Call::Read, _) | (Call::Create, Place::Filter) => true,
            // A create's only date is the new row's, unless the phrase names a row.
            (Call::Create, Place::Write) => self.said.all_roles(|role| role != Role::Row),
            // A move's `when` picks the row; its new date needs a destination.
            (Call::Move, Place::Filter) => self.said.all_roles(|role| role == Role::Row),
            (Call::Move, Place::Write) => self.said.all_roles(|role| role == Role::Dest),
        }
    }

    /// Whether a bare weekday can only mean `date`. It cannot when:
    ///
    /// - it names today's weekday ("friday" on a Friday: today, or the next),
    ///   or a day already past ("this thursday" on a Saturday);
    /// - the turn before showed dates in a later week, whose weekday it may
    ///   continue ("thursday" after a list of next week's events);
    /// - it is a short follow-up ("monday at 5") to a turn that only asked a
    ///   question.
    fn weekday_is_clear(&self, date: Date) -> bool {
        if date <= self.now.date() || self.context.later {
            return false;
        }
        let fragment = self.said.len <= 4 && self.said.all_roles(|role| role == Role::Free);
        !(fragment && self.context.asked_only)
    }

    /// The day or instant an expression resolves to, when it is exactly one.
    fn resolves_to(&self, value: &Value) -> Option<(Date, Option<Time>)> {
        let expr = dates::parse(value).ok()?;
        if dates::uses_row(&expr) {
            return None;
        }
        match dates::evaluate(&expr, self.now, None).ok()? {
            Resolved::Days { from, to } if from == to => Some((from, None)),
            Resolved::At(at) => Some((at.date(), Some(at.time()))),
            _ => None,
        }
    }

    /// RULE B: one unambiguous day or instant in the message, for the field
    /// it governs.
    fn leaf_or_span(&mut self, value: &Value, place: Place) -> Option<Value> {
        let (phrase, text) = self.said.only()?;
        if !self.governs(place) {
            return None;
        }
        let phrase = match phrase {
            Phrase::Weekday(date) if self.ahead && self.weekday_is_clear(date) => Phrase::Day(date),
            Phrase::Weekday(_) | Phrase::Ordinal(_) => return None,
            other => other,
        };
        let object = value.as_object()?;
        if object.contains_key("from") || object.contains_key("to") {
            if place == Place::Filter {
                return None;
            }
            // One phrase cannot say both ends of a span: only an event on a
            // single day, both ends of which the phrase moves, is repaired.
            let (start, end) = (object.get("from")?, object.get("to")?);
            if self.resolves_to(start)?.0 != self.resolves_to(end)?.0 {
                return None;
            }
            let mut out = object.clone();
            let mut changed = false;
            for (key, end) in [("from", start), ("to", end)] {
                if let Some(fixed) = self.leaf(end, phrase, text) {
                    out.insert(key.to_owned(), fixed);
                    changed = true;
                }
            }
            return changed.then_some(Value::Object(out));
        }
        self.leaf(value, phrase, text)
    }

    fn leaf(&mut self, value: &Value, phrase: Phrase, text: &str) -> Option<Value> {
        // A named month and day ("the 3rd of may") is the person's own date:
        // which year it means is not the runtime's to say.
        if matches!(phrase, Phrase::Day(_)) && text.chars().any(|c| c.is_ascii_digit()) {
            return None;
        }
        let (date, time) = self.resolves_to(value)?;
        let (want_date, want_time) = match phrase {
            Phrase::Day(day) => (day, time.or(self.said.only_clock())),
            Phrase::Instant(at) => {
                if date == at.date() && time == Some(at.time()) {
                    return None;
                }
                (at.date(), Some(at.time()))
            }
            Phrase::Ordinal(_) | Phrase::Weekday(_) => return None,
        };
        let same = date == want_date
            && match phrase {
                Phrase::Instant(_) => time == want_time,
                _ => true,
            };
        if same {
            return None;
        }
        let mut fixed = Map::new();
        fixed.insert("date".to_owned(), json!(want_date.to_string()));
        if let Some(time) = want_time {
            fixed.insert(
                "time".to_owned(),
                json!(format!("{:02}:{:02}", time.hour(), time.minute())),
            );
        }
        let shown = |date: Date| {
            dates::relative_label(date, self.now.date()).map_or_else(
                || dates::day_label(date),
                |label| format!("{label} {}", dates::day_label(date)),
            )
        };
        self.notes.push(format!(
            "date: \"{text}\" is {}; the call had {}; used {}.",
            shown(want_date),
            shown(date),
            shown(want_date)
        ));
        Some(Value::Object(fixed))
    }

    /// A message with one "at 9pm" and a write whose time differs.
    fn clock_only(&mut self, value: &Value) -> Option<Value> {
        let clock = self.said.only_clock()?;
        if self.said.broad {
            return None;
        }
        // "the one due at 9": a time that names the row is not the new time.
        if self.call == Call::Move && !self.said.all_roles(|role| role != Role::Row) {
            return None;
        }
        let object = value.as_object()?;
        if object.contains_key("from") || object.contains_key("to") {
            return None;
        }
        let have = object.get("time")?.as_str()?.to_owned();
        let want = format!("{:02}:{:02}", clock.hour(), clock.minute());
        if have == want {
            return None;
        }
        let mut out = object.clone();
        out.insert("time".to_owned(), json!(want));
        self.notes.push(format!(
            "date: the message says {want}; the call had {have}; used {want}."
        ));
        Some(Value::Object(out))
    }
}

impl Session {
    /// Whether the message says "all" / "every" / "everything" outright.
    pub(crate) fn said_all(&self) -> bool {
        tokens(&self.message).iter().any(|word| {
            matches!(
                word.as_str(),
                "all" | "every" | "everything" | "each" | "whole" | "entire"
            )
        })
    }

    /// What the current message says about dates.
    pub(crate) fn said(&self) -> Said {
        said(&self.message, self.now)
    }

    /// What the previous turn showed of dates.
    fn date_context(&self) -> Context {
        let this_week = monday_of(self.now.date());
        let mut context = Context::default();
        let mut calls = 0;
        let mut asks = 0;
        for obs in self
            .observations
            .iter()
            .filter(|obs| obs.turn + 1 == self.turn)
        {
            calls += 1;
            asks +=
                usize::from(obs.summary.starts_with("asked:") || obs.header.starts_with("asked:"));
            // Only what a read showed (an empty answer still echoes its
            // range): the dates a write moved a row to, and the repair notes
            // of the runtime itself, are not the talk's.
            if !(obs.result || obs.header.starts_with("answered")) {
                continue;
            }
            let lines = obs.lines.iter().map(|(_, line)| line.as_str());
            for text in [obs.header.as_str(), obs.summary.as_str()]
                .into_iter()
                .chain(lines)
            {
                if text.starts_with("date:") {
                    continue;
                }
                for date in iso_dates(text) {
                    context.later |= this_week.is_some_and(|monday| {
                        monday_of(date).is_some_and(|theirs| theirs > monday)
                    });
                }
            }
        }
        context.asked_only = calls > 0 && calls == asks;
        context
    }

    /// Repair the date expressions of a call from the user's words. Returns
    /// the (maybe new) args and one note per repair.
    pub(crate) fn ground(&self, tool: &str, args: &Value) -> (Value, Vec<String>) {
        let Some(object) = args.as_object() else {
            return (args.clone(), Vec::new());
        };
        if self.message.trim().is_empty() || !matches!(tool, "find" | "answer" | "act" | "compute")
        {
            return (args.clone(), Vec::new());
        }
        let said = self.said();
        let context = self.date_context();
        let verb = object
            .get("verb")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let mut grounder = Grounder {
            said: &said,
            now: self.now,
            notes: Vec::new(),
            ahead: tool == "act" && matches!(verb, "cancel" | "reschedule" | "create" | "edit"),
            call: match (tool, verb) {
                ("act", "create") => Call::Create,
                ("act", "reschedule" | "edit") => Call::Move,
                _ => Call::Read,
            },
            context,
        };
        let mut out = object.clone();
        if let Some(when) = object.get("when").filter(|value| !value.is_null())
            && let Some(fixed) = grounder.expr(when, Place::Filter)
        {
            out.insert("when".to_owned(), fixed);
        }
        if tool == "act" && matches!(verb, "create" | "reschedule" | "edit") {
            let key = if verb == "reschedule" { "to" } else { "date" };
            match object.get("args") {
                Some(Value::Object(map)) => {
                    if let Some(value) = map.get(key)
                        && let Some(fixed) = grounder.expr(value, Place::Write)
                    {
                        let mut map = map.clone();
                        map.insert(key.to_owned(), fixed);
                        out.insert("args".to_owned(), Value::Object(map));
                    }
                }
                Some(Value::String(text)) if !text.trim_start().starts_with('{') => {
                    let mut lines = Vec::new();
                    let mut changed = false;
                    for line in text.lines() {
                        let mut line = line.to_owned();
                        if let Some((name, rest)) = line.split_once(':')
                            && name.trim().eq_ignore_ascii_case(key)
                            && let Ok(value) = serde_json::from_str::<Value>(rest.trim())
                            && let Some(fixed) = grounder.expr(&value, Place::Write)
                        {
                            line = format!("{}: {fixed}", name.trim());
                            changed = true;
                        }
                        lines.push(line);
                    }
                    if changed {
                        out.insert("args".to_owned(), Value::String(lines.join("\n")));
                    }
                }
                _ => {}
            }
        }
        (Value::Object(out), grounder.notes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> DateTime {
        dates::parse_now("2026-08-19T09:00").unwrap()
    }

    fn only_day(message: &str) -> Option<String> {
        said(message, now())
            .only_day(true)
            .map(|(date, _)| date.to_string())
    }

    #[test]
    fn a_bare_weekday_is_its_next_occurrence_and_next_is_next_week() {
        // 2026-08-19 is a Wednesday.
        assert_eq!(
            only_day("cancel the swim class on saturday").as_deref(),
            Some("2026-08-22")
        );
        assert_eq!(
            only_day("can fujita come at 9 on thursday").as_deref(),
            Some("2026-08-20")
        );
        assert_eq!(
            only_day("move it to next friday").as_deref(),
            Some("2026-08-28")
        );
        assert_eq!(only_day("wednesday works").as_deref(), Some("2026-08-19"));
        assert_eq!(only_day("friday week").as_deref(), Some("2026-09-04"));
    }

    #[test]
    fn two_phrases_or_a_broader_phrase_abstain() {
        assert_eq!(only_day("move friday's call to monday"), None);
        assert_eq!(only_day("what's on next week friday"), None);
        assert_eq!(only_day("text ines about sunday, in an hour"), None);
        assert_eq!(only_day("fri 6 to 6.30"), None);
    }

    #[test]
    fn a_topic_weekday_is_not_a_date() {
        let said = said("remind me in an hour to text ines about sunday", now());
        assert_eq!(said.phrases.len(), 1);
        assert!(matches!(said.phrases[0].0, Phrase::Instant(_)));
    }

    #[test]
    fn ordinals_words_and_digits() {
        let said = said("due by the twenty-second", now());
        assert_eq!(said.ordinals(), vec![22]);
        let said = super::said("what's on the 2nd one", now());
        assert!(said.ordinals().is_empty());
        let said = super::said("the twentieth of september", now());
        assert!(said.ordinals().is_empty());
    }

    fn ground_for(said: &Said, call: Call) -> Grounder<'_> {
        ground_at(said, call, now())
    }

    fn ground_at(said: &Said, call: Call, at: DateTime) -> Grounder<'_> {
        Grounder {
            said,
            now: at,
            notes: Vec::new(),
            ahead: true,
            call,
            context: Context::default(),
        }
    }

    fn role_of(message: &str) -> Role {
        said(message, now()).phrases[0].2
    }

    #[test]
    fn a_bare_ordinal_never_rewrites_a_date_that_exists() {
        // "the twenty-ninth" is last month's here; the call is right (T24-028).
        let today = dates::parse_now("2026-09-14T09:00").unwrap();
        let session_said = said("delete the one from the twenty-ninth", today);
        let mut grounder = ground_at(&session_said, Call::Read, today);
        assert!(
            grounder
                .expr(&json!({"date": "2026-08-29"}), Place::Filter)
                .is_none()
        );
        // "the third" said in May is June's (T09-131): the call is right.
        let may = dates::parse_now("2026-05-20T09:00").unwrap();
        let session_said = said("cancel the planning call on the third", may);
        let mut grounder = ground_at(&session_said, Call::Read, may);
        assert!(
            grounder
                .expr(&json!({"date": "2026-06-03"}), Place::Filter)
                .is_none()
        );
        // "what's not done that was due by the twentieth", a later month written.
        let session_said = said("what's not done that was due by the twentieth", now());
        let mut grounder = ground_for(&session_said, Call::Read);
        assert!(
            grounder
                .expr(&json!({"to": {"date": "2026-09-20"}}), Place::Filter)
                .is_none()
        );
        assert!(grounder.notes.is_empty());
    }

    #[test]
    fn a_range_from_a_weekday_to_an_ordinal_is_left_alone() {
        let today = dates::parse_now("2026-06-17T09:00").unwrap();
        let session_said = said("anything from next monday to the third", today);
        let mut grounder = ground_at(&session_said, Call::Read, today);
        let span =
            json!({"from": {"unit": "week", "rel": 1, "weekday": 1}, "to": {"date": "2026-07-03"}});
        assert!(grounder.expr(&span, Place::Filter).is_none());
        assert!(grounder.notes.is_empty());
    }

    #[test]
    fn a_date_that_does_not_exist_is_repaired_under_one_ordinal() {
        let session_said = said(
            "anything else at the hospital before the thirty-first",
            now(),
        );
        let mut grounder = ground_at(
            &session_said,
            Call::Read,
            dates::parse_now("2026-10-14T09:00").unwrap(),
        );
        let fixed = grounder
            .expr(&json!({"to": {"date": "2026-11-31"}}), Place::Filter)
            .unwrap();
        assert_eq!(fixed["to"]["date"], "2026-10-31");
        // Two ordinals, or a date on another day: left alone.
        let two = said("between the tenth and the thirty-first", now());
        let mut grounder = ground_for(&two, Call::Read);
        assert!(
            grounder
                .expr(&json!({"to": {"date": "2026-11-31"}}), Place::Filter)
                .is_none()
        );
        let mut grounder = ground_for(&session_said, Call::Read);
        assert!(
            grounder
                .expr(&json!({"to": {"date": "2026-02-30"}}), Place::Filter)
                .is_none()
        );
    }

    #[test]
    fn a_bare_weekday_read_as_next_week_is_repaired() {
        let session_said = said("cancel the swim class on saturday", now());
        let mut grounder = ground_for(&session_said, Call::Read);
        let fixed = grounder
            .expr(
                &json!({"rel": 1, "unit": "week", "weekday": 6}),
                Place::Filter,
            )
            .unwrap();
        assert_eq!(fixed["date"], "2026-08-22");
        assert!(grounder.notes[0].contains("Sat 2026-08-22"));
        // Already right: untouched.
        assert!(
            grounder
                .expr(
                    &json!({"rel": 0, "unit": "week", "weekday": 6}),
                    Place::Filter
                )
                .is_none()
        );
    }

    #[test]
    fn a_destination_weekday_written_as_next_week_is_repaired_in_a_move() {
        let session_said = said("push it to friday", now());
        let mut grounder = ground_for(&session_said, Call::Move);
        let fixed = grounder
            .expr(
                &json!({"unit": "week", "rel": 1, "weekday": 5}),
                Place::Write,
            )
            .unwrap();
        assert_eq!(fixed, json!({"date": "2026-08-21"}));
        assert!(
            grounder.notes[0].starts_with("date: \"friday\" is "),
            "{:?}",
            grounder.notes
        );
        assert!(
            grounder
                .expr(
                    &json!({"unit": "week", "rel": 0, "weekday": 5}),
                    Place::Write
                )
                .is_none()
        );
        // "make it due friday" sets the date too.
        let session_said = said("reopen it and make it due friday", now());
        let mut grounder = ground_for(&session_said, Call::Move);
        assert!(
            grounder
                .expr(
                    &json!({"unit": "week", "rel": 1, "weekday": 5}),
                    Place::Write
                )
                .is_some()
        );
    }

    #[test]
    fn next_friday_written_as_this_friday_is_repaired() {
        // 2026-08-19 is a Wednesday: "next friday" is 2026-08-28.
        let session_said = said("move it to next friday", now());
        let mut grounder = ground_for(&session_said, Call::Move);
        let fixed = grounder
            .expr(
                &json!({"unit": "week", "rel": 0, "weekday": 5}),
                Place::Write,
            )
            .unwrap();
        assert_eq!(fixed, json!({"date": "2026-08-28"}));
        assert!(
            grounder
                .expr(
                    &json!({"unit": "week", "rel": 1, "weekday": 5}),
                    Place::Write
                )
                .is_none()
        );
    }

    #[test]
    fn a_bare_weekday_on_a_create_is_repaired_with_its_time_kept() {
        let session_said = said("book coffee with koji thursday at 2", now());
        let mut grounder = ground_for(&session_said, Call::Create);
        let fixed = grounder
            .expr(
                &json!({"unit": "week", "rel": 1, "weekday": 4, "time": "14:00"}),
                Place::Write,
            )
            .unwrap();
        assert_eq!(fixed, json!({"date": "2026-08-20", "time": "14:00"}));
    }

    #[test]
    fn a_phrase_that_names_the_row_is_not_the_new_date() {
        // T16-109: the new date was said a turn earlier; "tomorrow" picks the row.
        let session_said = said("the one due tomorrow", now());
        assert_eq!(session_said.phrases[0].2, Role::Row);
        let mut grounder = ground_for(&session_said, Call::Move);
        assert!(
            grounder
                .expr(
                    &json!({"unit": "week", "rel": 0, "weekday": 5}),
                    Place::Write
                )
                .is_none()
        );
        assert!(grounder.notes.is_empty());
        // It is the filter's date, though.
        let fixed = grounder
            .expr(&json!({"unit": "day", "rel": 3}), Place::Filter)
            .unwrap();
        assert_eq!(fixed, json!({"date": "2026-08-20"}));
        // A create does not take a row-naming phrase either.
        let mut grounder = ground_for(&session_said, Call::Create);
        assert!(
            grounder
                .expr(&json!({"unit": "day", "rel": 3}), Place::Write)
                .is_none()
        );
    }

    #[test]
    fn roles_follow_the_words_around_a_phrase() {
        assert_eq!(role_of("the one due tomorrow"), Role::Row);
        assert_eq!(role_of("friday's call"), Role::Row);
        assert_eq!(role_of("the tomorrow one"), Role::Row);
        assert_eq!(role_of("the one dated friday"), Role::Row);
        assert_eq!(role_of("push it to friday"), Role::Dest);
        assert_eq!(role_of("push it to next friday"), Role::Dest);
        assert_eq!(role_of("make it due friday"), Role::Dest);
        assert_eq!(
            role_of("can fujita come at 9 instead on thursday"),
            Role::Dest
        );
        assert_eq!(role_of("book coffee with koji thursday at 2"), Role::Free);
        assert_eq!(role_of("cancel the dinner on friday"), Role::Free);
    }

    #[test]
    fn a_phrase_that_does_not_say_where_a_move_goes_is_left_alone() {
        let session_said = said("reschedule the dentist on friday", now());
        let mut grounder = ground_for(&session_said, Call::Move);
        assert!(
            grounder
                .expr(
                    &json!({"unit": "week", "rel": 2, "weekday": 1}),
                    Place::Write
                )
                .is_none()
        );
    }

    #[test]
    fn a_named_month_and_day_is_not_rewritten() {
        let session_said = said("put the vet on the 3rd of may", now());
        let mut grounder = ground_for(&session_said, Call::Create);
        assert!(
            grounder
                .expr(&json!({"date": "2026-06-03"}), Place::Write)
                .is_none()
        );
        assert!(grounder.notes.is_empty());
    }

    #[test]
    fn more_than_one_date_phrase_abstains_unless_they_agree() {
        let differ = said("move friday's call to monday", now());
        let mut grounder = ground_for(&differ, Call::Move);
        assert!(
            grounder
                .expr(
                    &json!({"unit": "week", "rel": 2, "weekday": 1}),
                    Place::Write
                )
                .is_none()
        );
        let mixed = said("next monday to the third", now());
        let mut grounder = ground_for(&mixed, Call::Read);
        assert!(
            grounder
                .expr(&json!({"date": "2026-09-03"}), Place::Filter)
                .is_none()
        );
        let agree = said("book it tomorrow, yes tomorrow at 9", now());
        assert_eq!(agree.phrases.len(), 2);
        let mut grounder = ground_for(&agree, Call::Create);
        let fixed = grounder
            .expr(&json!({"unit": "day", "rel": 3}), Place::Write)
            .unwrap();
        assert_eq!(fixed["date"], "2026-08-20");
    }

    #[test]
    fn a_span_is_repaired_only_when_both_ends_are_one_day() {
        let session_said = said("put the workshop in for friday", now());
        let mut grounder = ground_for(&session_said, Call::Create);
        // Two ends on two days: one phrase cannot say both.
        let long = json!({"from": {"date": "2026-08-28", "time": "09:00"}, "to": {"date": "2026-08-30", "time": "10:00"}});
        assert!(grounder.expr(&long, Place::Write).is_none());
        // One day, the wrong one: both ends move.
        let short = json!({"from": {"date": "2026-08-28", "time": "09:00"}, "to": {"date": "2026-08-28", "time": "10:00"}});
        let fixed = grounder.expr(&short, Place::Write).unwrap();
        assert_eq!(
            fixed["from"],
            json!({"date": "2026-08-21", "time": "09:00"})
        );
        assert_eq!(fixed["to"], json!({"date": "2026-08-21", "time": "10:00"}));
        // Open-ended: left alone.
        assert!(
            grounder
                .expr(&json!({"from": {"date": "2026-08-28"}}), Place::Write)
                .is_none()
        );
    }

    #[test]
    fn a_weekday_that_may_continue_the_talk_is_left_alone() {
        let wrong = json!({"unit": "week", "rel": 1, "weekday": 4, "time": "16:00"});
        // "thursday" said on a Thursday: today, or the next one.
        let thursday = dates::parse_now("2026-08-20T09:00").unwrap();
        let session_said = said("ok thursday at 4", thursday);
        let mut grounder = ground_at(&session_said, Call::Create, thursday);
        assert!(grounder.expr(&wrong, Place::Write).is_none());
        // The turn before read next week's rows: "thursday" may be theirs.
        let session_said = said("shift the fire drill to thursday same time", now());
        let mut grounder = ground_for(&session_said, Call::Move);
        grounder.context.later = true;
        assert!(
            grounder
                .expr(
                    &json!({"unit": "week", "rel": 1, "weekday": 4}),
                    Place::Write
                )
                .is_none()
        );
        grounder.context.later = false;
        assert!(
            grounder
                .expr(
                    &json!({"unit": "week", "rel": 1, "weekday": 4}),
                    Place::Write
                )
                .is_some()
        );
        // "this thursday" said on a Saturday is already past: not a reading.
        let saturday = dates::parse_now("2026-08-22T09:00").unwrap();
        let session_said = said("cancel the one this thursday", saturday);
        let mut grounder = ground_at(&session_said, Call::Read, saturday);
        assert!(
            grounder
                .expr(
                    &json!({"unit": "week", "rel": 1, "weekday": 4}),
                    Place::Filter
                )
                .is_none()
        );
        // A short answer to a turn that only asked: the week was in words
        // this message does not have. A full sentence is its own context.
        let session_said = said("monday at 5", now());
        let mut grounder = ground_for(&session_said, Call::Create);
        let monday = json!({"unit": "week", "rel": 2, "weekday": 1, "time": "17:00"});
        grounder.context.asked_only = true;
        assert!(grounder.expr(&monday, Place::Write).is_none());
        grounder.context.asked_only = false;
        assert!(grounder.expr(&monday, Place::Write).is_some());
        let session_said = said("book the haircut for monday at 5", now());
        let mut grounder = ground_for(&session_said, Call::Create);
        grounder.context.asked_only = true;
        assert!(grounder.expr(&monday, Place::Write).is_some());
        // "next friday" and "tomorrow" never depend on the talk.
        let session_said = said("move it to next friday", now());
        let mut grounder = ground_for(&session_said, Call::Move);
        grounder.context.later = true;
        assert!(
            grounder
                .expr(
                    &json!({"unit": "week", "rel": 0, "weekday": 5}),
                    Place::Write
                )
                .is_some()
        );
    }

    #[test]
    fn the_end_of_a_clock_range_is_not_the_start() {
        assert!(
            said("add choir concert on the twenty-first 2 to 4pm", now())
                .clocks
                .is_empty()
        );
        assert!(
            said("add choir concert friday 2pm to 4pm", now())
                .clocks
                .is_empty()
        );
        assert_eq!(
            said("add choir concert friday at 4pm", now()).clocks.len(),
            1
        );
    }

    #[test]
    fn iso_dates_are_read_out_of_text() {
        let found: Vec<String> =
            iso_dates("Fri 2026-08-21 09:00, when: 2026-08-17..2026-08-23; 2026-13-40")
                .map(|date| date.to_string())
                .collect();
        assert_eq!(found, ["2026-08-21", "2026-08-17", "2026-08-23"]);
    }

    #[test]
    fn in_an_hour_replaces_a_weekday_and_keeps_the_time() {
        let session_said = said("remind me in an hour to text ines about sunday", now());
        let mut grounder = ground_for(&session_said, Call::Create);
        let fixed = grounder
            .expr(
                &json!({"unit": "week", "rel": 0, "weekday": 7}),
                Place::Write,
            )
            .unwrap();
        assert_eq!(fixed, json!({"date": "2026-08-19", "time": "10:00"}));
    }
}
