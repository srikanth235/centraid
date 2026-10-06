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
//! "Since X" is the one broad phrase the runtime does read (SPEC §14.1): in a
//! count, a sum or a breakdown a filter span with no end gets today as its end
//! (`close_since`); a row listing keeps the span the model wrote.
//!
//! A bare weekday ("thursday") is also left alone when it may continue the
//! talk rather than start it: it is today's weekday, the turn before read
//! dates in a later week, or it is a short answer to a turn that only asked.
//! "next friday", "tomorrow" and "in an hour" need no such context.
//!
//! A bare day of the month ("the twenty-ninth", "the third") and a named
//! month and day ("dec 11", "the 3rd of may") are read into a *filter's* date
//! never: the year, month and direction are the model's, since a read looks
//! back as often as ahead. In a *write* they have one reading, the next
//! occurrence, today included (SPEC §14, as for a bare weekday): whatever date
//! the model wrote (past, later, a day that does not exist such as
//! "2026-11-31") is replaced by it. An explicit day of the month ("friday dec 11") beats the
//! weekday written beside it. A date expression the runtime cannot read at
//! all ("weekday": 8) is replaced by the one phrase the message states, when
//! there is one. A clock range ("fri 6 to 6.30") is one day. When unsure,
//! nothing is rewritten. This is a deliberate exception to SPEC §3.3's "the
//! runtime does not look at the message": the date repair never picks rows, it
//! only repairs a date the message states outright.
//!
//! CONVENTIONS (`Session::conventions`, after the date repair): a read, count or sum fills a slot
//! its call leaves out, from the call and a few words the SPEC names (SPEC §14.1: container
//! readouts select the active rows, the status words, "next", "last one", "biggest"). A call that
//! states the slot is never overridden; `Defaults` switches each one.
//!
//! A by-name selector is not repaired here: its name is resolved in tiers where the rows are
//! selected (`resolve.rs`, `Session::select_named`, SPEC §3, item 4).

use jiff::ToSpan as _;
use jiff::civil::{Date, DateTime, Time};
use serde_json::{Map, Value, json};

use crate::dates::{self, Resolved};
use crate::meta::{FieldType, Kind};
use crate::session::Session;
use crate::trace::Scope;
use crate::whr::{Cond, Op};

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
    /// A month and day without a year ("dec 11", "the 3rd of may").
    Named { month: i8, day: i8 },
    /// "the end of march", "end of the month": the last day, in a write.
    MonthEnd(Date),
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
    /// "due friday": the row's date when it is picked ("the one due friday"),
    /// the new row's when it is created ("add x, due friday").
    Due,
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
    /// A clock range was written ("6 to 6.30", "2 to 4pm"): one day.
    range: bool,
    /// Words in the message.
    len: usize,
    /// Bare hours the dates line reads both ways ("at 3": 03:00 or 15:00): the words, the morning
    /// reading and the afternoon one.
    bare: Vec<(String, Time, Time)>,
    /// The message carries a clock the line reads one way.
    timed: bool,
    /// "same time", "same hour": a move that keeps the row's clock.
    same_time: bool,
}

impl Said {
    /// Whether the message holds no date, ordinal or span that could say which
    /// row it means: a phrase that names the row, a broad word, a bare ordinal
    /// or a named month. A date that only says where a write goes ("to
    /// friday") does not pick the row.
    pub(crate) fn settles_nothing(&self) -> bool {
        !self.broad
            && !self.month_named
            && self.ordinals().is_empty()
            && self.phrases.iter().all(|(phrase, _, role)| {
                *role == Role::Dest && !matches!(phrase, Phrase::Ordinal(_) | Phrase::Named { .. })
            })
    }

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

/// Words that end a "since" clause: it names an end of its own.
const SINCE_ENDS: [&str; 7] = ["until", "till", "before", "through", "thru", "to", "up"];
/// Whether a word starts a date after "since": a month, a weekday, an
/// ordinal, a number, or a period word ("last", "start of", "yesterday").
fn starts_date(word: &str) -> bool {
    month_of(word).is_some()
        || weekday_of(word).is_some()
        || numeric_ordinal(word).is_some()
        || word_ordinal(word).is_some()
        || day_digits(word).is_some()
        || word.chars().next().is_some_and(|c| c.is_ascii_digit())
        || matches!(
            word,
            "last"
                | "this"
                | "yesterday"
                | "today"
                | "start"
                | "beginning"
                | "early"
                | "mid"
                | "end"
                | "middle"
                | "twenty"
                | "thirty"
                | "a"
                | "an"
        )
}

/// Whether the message says "since" before a date and names no end of its own.
fn says_since(message: &str) -> bool {
    let lower = message.to_lowercase();
    lower.split(['.', ',', ';', '?', '!']).any(|clause| {
        let words = tokens(clause);
        let Some(at) = words.iter().position(|word| word == "since") else {
            return false;
        };
        let rest = &words[at + 1..];
        let rest = match rest.first().map(String::as_str) {
            Some("the" | "my") => &rest[1..],
            _ => rest,
        };
        rest.first().is_some_and(|first| starts_date(first))
            && !rest.iter().any(|word| SINCE_ENDS.contains(&word.as_str()))
    })
}

/// An end that stands for "no end": the calendar's own limit.
fn is_sentinel_end(end: &Value) -> bool {
    end.get("date")
        .and_then(Value::as_str)
        .and_then(parts)
        .is_some_and(|(year, _, _)| year >= 2100)
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

pub(crate) fn weekday_of(text: &str) -> Option<i8> {
    if WORD_LIKE.contains(&text) {
        return None;
    }
    WEEKDAYS
        .iter()
        .find(|(name, _)| *name == text)
        .map(|(_, day)| *day)
}

/// Words after which a short spelling that is also a word ("sat", "sun") is
/// a weekday: "next sat", "on sun", "to mon".
const BEFORE_SHORT_WEEKDAY: [&str; 8] = ["next", "this", "last", "on", "to", "by", "till", "until"];

/// A weekday word, the short word-like spellings only after one of
/// `BEFORE_SHORT_WEEKDAY`.
fn weekday_after(text: &str, prev: Option<&str>) -> Option<i8> {
    weekday_of(text).or_else(|| {
        if WORD_LIKE.contains(&text)
            && prev.is_some_and(|prev| BEFORE_SHORT_WEEKDAY.contains(&prev))
        {
            WEEKDAYS
                .iter()
                .find(|(name, _)| *name == text)
                .map(|(_, day)| *day)
        } else {
            None
        }
    })
}

/// Verbs that move a row later: "tap can wait till next sat" names the new
/// date, where "what is due till friday" ends a span.
const WAITING: [&str; 10] = [
    "wait", "waits", "hold", "push", "delay", "postpone", "defer", "bump", "park", "move",
];

/// A number that can be a day of the month, written in digits (no suffix).
fn day_digits(text: &str) -> Option<i8> {
    if text.len() > 2 || !text.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let day: i8 = text.parse().ok()?;
    (1..=31).contains(&day).then_some(day)
}

/// Digits that can be a clock ("6", "6.30", "6:30"), not a day count.
fn clockish(text: &str) -> bool {
    let (hour, minute) = text.split_once([':', '.']).unwrap_or((text, "00"));
    hour.len() <= 2
        && !hour.is_empty()
        && minute.len() == 2
        && hour.chars().all(|c| c.is_ascii_digit())
        && minute.chars().all(|c| c.is_ascii_digit())
        && hour.parse::<i8>().is_ok_and(|hour| hour <= 24)
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

/// The words that name a stretch of time: "all day", "every week", "the whole weekend" quantify
/// the time, not the rows (`Session::said_every_row`).
const TIME_SPANS: [&str; 18] = [
    "day",
    "days",
    "week",
    "weeks",
    "weekend",
    "weekends",
    "night",
    "nights",
    "morning",
    "mornings",
    "afternoon",
    "afternoons",
    "evening",
    "evenings",
    "month",
    "months",
    "year",
    "years",
];

/// Words that say a date belongs to the row, not to a new date.
const ROW_MARKERS: [&str; 4] = ["dated", "from", "of", "scheduled"];
/// Words before "due" that make it a new due date ("make it due friday").
const SETTERS: [&str; 12] = [
    "make", "made", "set", "mark", "put", "change", "update", "give", "have", "move", "push", "to",
];
/// Words that introduce where a row goes.
const DESTINATIONS: [&str; 9] = [
    "to", "for", "by", "it", "them", "instead", "till", "until", "til",
];

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
        // "the one due friday" picks the row, in a create too.
        Some("due") if matches!(word(2), Some("one" | "ones")) => Role::Row,
        Some("due") => Role::Due,
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
    let waiting = words.iter().any(|word| WAITING.contains(&word.as_str()));
    let mut index = 0;
    // Tokens a phrase used up, so "twenty" + "seventh" is one ordinal.
    while index < words.len() {
        let word = words[index].as_str();
        let prev = index.checked_sub(1).map(|at| words[at].as_str());
        let next = words.get(index + 1).map(String::as_str);
        let after_next = words.get(index + 2).map(String::as_str);
        // A WORD OF A NAME IS NO PERIOD (nt12 B1): `year` in "the year end report" and `june` in
        // "star June" say no date. The Reader's own guard decides (`phrases::month_is_here`).
        let period_word = matches!(word, "month" | "months" | "year" | "years");
        let in_a_name = period_word && !period_here(prev, next);
        let month_before = words[..index]
            .iter()
            .any(|earlier| month_of(earlier).is_some());
        let month_here = month_of(word).is_some()
            && (crate::phrases::month_is_here(word, prev.unwrap_or(""), month_before)
                || next.is_some_and(is_number_like));
        if !in_a_name && (BROAD.contains(&word) || SPANNING.contains(&word)) {
            let after_weekday =
                word == "week" && prev.is_some_and(|prev| weekday_of(prev).is_some());
            // "can wait till next sat" moves a row; "due till friday" ends a span.
            let new_date = matches!(word, "till" | "until") && waiting;
            if !after_weekday && !new_date {
                out.broad = true;
            }
        }
        // "6 to 6.30", "2 to 4pm": one day, both ends on it.
        if word == "to"
            && after_next.and_then(month_of).is_none()
            && prev.is_some_and(|prev| clockish(prev) || day_digits(prev).is_some())
            && next.is_some_and(|next| {
                clockish(next) || day_digits(next).is_some() || clock_of(next).is_some()
            })
        {
            out.range = true;
        }
        if (period_word && !in_a_name) || month_here {
            out.month_named = true;
        }
        if let Some(day) = weekday_after(word, prev) {
            let topic = matches!(prev, Some("about" | "regarding" | "re"));
            // "friday dec 11", "fri 11 dec": the weekday only decorates the
            // day of the month, which the Named phrase below carries.
            let is_day = |text: &str| day_digits(text).is_some() || numeric_ordinal(text).is_some();
            let decorates = match (next, after_next) {
                (Some(a), Some(b)) => {
                    (month_of(a).is_some() && is_day(b)) || (is_day(a) && month_of(b).is_some())
                }
                _ => false,
            };
            if topic || decorates {
                // not a date of its own
            } else {
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
        // "end of march", "the end of the month": a write's last day of it.
        if word == "end" && next == Some("of") {
            let skip = usize::from(after_next == Some("the"));
            let target = words.get(index + 2 + skip).map(String::as_str);
            let last_of = |year: i16, month: i8| {
                Date::new(year, month, 1)
                    .ok()
                    .map(|first| first.last_of_month())
            };
            let date = match target {
                Some("month") => last_of(today.year(), today.month()),
                Some(name) => month_of(name).and_then(|month| {
                    last_of(today.year(), month)
                        .filter(|date| *date >= today)
                        .or_else(|| last_of(today.year() + 1, month))
                }),
                None => None,
            };
            if let Some(date) = date {
                out.phrases.push((
                    Phrase::MonthEnd(date),
                    format!("end of {}", target.unwrap_or_default()),
                    role_at(&marked, index, index + 2 + skip),
                ));
                out.month_named = true;
                index += 3 + skip;
                continue;
            }
        }
        // "dec 11", "11 dec": a month and day, no year.
        let named = if let (Some(month), Some(day)) = (month_of(word), next.and_then(day_digits)) {
            // "may 3" is a date, "may 3 people" a modal; "dec 11 pm" a time.
            (!matches!(after_next, Some("am" | "pm"))
                && (word != "may" || after_next != Some("people")))
            .then_some((month, day))
        } else if let (Some(day), Some(month)) = (day_digits(word), next.and_then(month_of)) {
            (prev != Some("at")).then_some((month, day))
        } else {
            None
        };
        if let Some((month, day)) = named {
            out.phrases.push((
                Phrase::Named { month, day },
                format!("{day} {month}"),
                role_at(&marked, index, index + 1),
            ));
            index += 2;
            continue;
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
                let last = index + used - 1
                    + usize::from(after_month.is_some())
                    + usize::from(after_month.is_some() && after == Some("of"));
                if let Some(month) = month {
                    out.phrases.push((
                        Phrase::Named { month, day },
                        format!("{day} {month}"),
                        role_at(&marked, index, last.min(words.len() - 1)),
                    ));
                } else if !low {
                    out.phrases.push((
                        Phrase::Ordinal(day),
                        ordinal_text(day),
                        role_at(&marked, index, last.min(words.len() - 1)),
                    ));
                }
            }
            index += used;
            continue;
        }
        index += 1;
    }
    out.same_time = words
        .windows(2)
        .any(|pair| pair[0] == "same" && matches!(pair[1].as_str(), "time" | "hour" | "slot"));
    for reading in crate::phrases::read_dates(message, now) {
        match bare_pair(&reading.resolution) {
            Some((am, pm)) => out.bare.push((reading.phrase, am, pm)),
            None => out.timed |= reading.resolution.contains(':'),
        }
    }
    out
}

/// `15:00 (pm) / 03:00 (am)` or `09:00 (am) / 21:00 (pm)`: the two readings of a bare hour, as
/// (morning, afternoon), in whichever order the line lists them.
fn bare_pair(resolution: &str) -> Option<(Time, Time)> {
    let (first, second) = resolution.split_once(" / ")?;
    let tagged = |text: &str, tag: &str| -> Option<Time> { text.strip_suffix(tag)?.parse().ok() };
    match (tagged(first, " (am)"), tagged(second, " (pm)")) {
        (Some(am), Some(pm)) => Some((am, pm)),
        _ => Some((tagged(second, " (am)")?, tagged(first, " (pm)")?)),
    }
}

/// What a reschedule's message says of its clock (`Session::time_words`).
pub(crate) struct TimeWords {
    /// The words of the clock as the dates line lists them: `to 5:30`.
    pub phrase: String,
    /// The message names no day and no shift of days: only a clock.
    pub day_less: bool,
    /// The one bare hour the message says, as its (morning, afternoon) readings.
    pub bare: Option<(Time, Time)>,
}

/// Whether a resolution of the dates line is a clock and nothing else: `17:30`, or the two
/// readings of a bare hour, `20:00 (pm) / 08:00 (am)`.
fn is_clock_only(resolution: &str) -> bool {
    resolution.split(" / ").all(|part| {
        let part = part
            .strip_suffix(" (am)")
            .or_else(|| part.strip_suffix(" (pm)"))
            .unwrap_or(part);
        part.len() == 5 && part.as_bytes()[2] == b':' && part.parse::<Time>().is_ok()
    })
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

/// Whether `month` or `year` at a place is a period the message speaks of ("this year", "every
/// month", "a year ago", "2 years"), not a word of a name ("the year end report").
fn period_here(prev: Option<&str>, next: Option<&str>) -> bool {
    prev.is_some_and(|prev| {
        is_number_like(prev)
            || matches!(
                prev,
                "this"
                    | "next"
                    | "last"
                    | "past"
                    | "previous"
                    | "coming"
                    | "every"
                    | "each"
                    | "per"
                    | "whole"
                    | "entire"
                    | "all"
                    | "a"
                    | "an"
                    | "one"
                    | "within"
                    | "over"
                    | "in"
                    | "during"
                    | "for"
                    | "since"
            )
    }) || matches!(next, Some("ago" | "later" | "from" | "before" | "after"))
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

/// The next time a month and day come round, today included (SPEC §14, as
/// for a bare weekday): this year's, else next year's.
fn next_occurrence(today: Date, month: i8, day: i8) -> Option<Date> {
    (0..=8).find_map(|ahead| {
        let date = Date::new(today.year() + ahead, month, day).ok()?;
        (date >= today).then_some(date)
    })
}

/// The next time a day of the month comes round, today included: this
/// month's, else the next month that has the day.
fn next_day_of_month(today: Date, day: i8) -> Option<Date> {
    (0..=12).find_map(|ahead| {
        let first = Date::new(today.year(), today.month(), 1).ok()?;
        let month = first.checked_add(jiff::Span::new().months(ahead)).ok()?;
        let date = Date::new(month.year(), month.month(), day).ok()?;
        (date >= today).then_some(date)
    })
}

/// "the 11th", "the 22nd".
fn ordinal_text(day: i8) -> String {
    let suffix = match (day % 10, day / 10) {
        (_, 1) => "th",
        (1, _) => "st",
        (2, _) => "nd",
        (3, _) => "rd",
        _ => "th",
    };
    format!("the {day}{suffix}")
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

/// What the write being grounded is about.
#[derive(Clone, Copy, Default)]
struct Target {
    /// An event: a create of one, or a reschedule.
    event: bool,
    /// A reschedule: `to` with a day alone keeps the row's clock.
    reschedule: bool,
}

struct Grounder<'a> {
    said: &'a Said,
    now: DateTime,
    notes: Vec<String>,
    /// The call looks ahead (a cancel or a write of a new date).
    ahead: bool,
    call: Call,
    context: Context,
    target: Target,
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
        if place == Place::Write
            && self.call == Call::Create
            && let Some(fixed) = self.same_day_range(&value)
        {
            value = fixed;
            changed = true;
        }
        if place == Place::Write
            && self.target.event
            && let Some(fixed) = self.bare_hour(&value)
        {
            value = fixed;
            changed = true;
        }
        if place == Place::Write
            && self.target.reschedule
            && let Some(fixed) = self.same_time(&value)
        {
            value = fixed;
            changed = true;
        }
        changed.then_some(value)
    }

    /// A BARE HOUR IN AN EVENT'S TIME ("at 3", "tuesday at 3"): the dates line lists both
    /// readings (`15:00 (pm) / 03:00 (am)`) and the model judges; a time the call states is never
    /// changed. Only a day the call gives with NO time at all takes one, the way a person books
    /// it: 1 to 8 is the afternoon or evening (appointments at 7 and 8 are dinner and yoga here),
    /// 9 to 11 the morning; the note says so. An hour the words settle (am, pm, morning, evening,
    /// tonight) is no bare hour, and a message with another clock or a range is left alone.
    fn bare_hour(&mut self, value: &Value) -> Option<Value> {
        let [(phrase, am, pm)] = self.said.bare.as_slice() else {
            return None;
        };
        if self.said.timed || self.said.range || self.said.broad || !self.said.clocks.is_empty() {
            return None;
        }
        // "the one at 3": a time that names the row is not the new time.
        if self.call == Call::Move
            && !self
                .said
                .all_roles(|role| !matches!(role, Role::Row | Role::Due))
        {
            return None;
        }
        let object = value.as_object()?;
        if object.contains_key("from") || object.contains_key("to") {
            return None;
        }
        let a_day = object.contains_key("date")
            || object.get("unit").and_then(Value::as_str) == Some("day")
            || object.get("unit").and_then(Value::as_str) == Some("week")
                && object.contains_key("weekday");
        if !a_day || object.get("time").is_some_and(|time| !time.is_null()) {
            return None;
        }
        // the one decision of a bare hour (`phrases::at_hour`): no word and no row settle it here
        let (pick, other) = if crate::phrases::at_hour(am.hour(), None, None).0 == pm.hour() {
            (pm, am)
        } else {
            (am, pm)
        };
        let show = |time: &Time| format!("{:02}:{:02}", time.hour(), time.minute());
        let mut out = object.clone();
        out.insert("time".to_owned(), json!(show(pick)));
        self.notes.push(format!(
            "date: \"{phrase}\" is {} or {}; the call had no time; used {} (an hour from 1 to 8 is the afternoon or evening, from 9 to 11 the morning).",
            show(pick),
            show(other),
            show(pick)
        ));
        Some(Value::Object(out))
    }

    /// "FRIDAY, SAME TIME" on a reschedule: a `to` with a day and no time keeps the row's own
    /// time; the note says what kept it. A time the call states is the model's judgement and
    /// stays.
    fn same_time(&mut self, value: &Value) -> Option<Value> {
        if !self.said.same_time
            || self.said.timed
            || !self.said.bare.is_empty()
            || !self.said.clocks.is_empty()
        {
            return None;
        }
        let object = value.as_object()?;
        if object.contains_key("from")
            || object.contains_key("to")
            || object.get("time").is_some_and(|time| !time.is_null())
        {
            return None;
        }
        self.notes.push(
            "date: the same time keeps the row's time; the call moves the day only.".to_owned(),
        );
        None
    }

    /// A clock range in the words ("fri 6 to 6.30") is one day: an event
    /// whose end the model put on a later day gets the start's day.
    fn same_day_range(&mut self, value: &Value) -> Option<Value> {
        if !self.said.range {
            return None;
        }
        let object = value.as_object()?;
        let (start, end) = (object.get("from")?, object.get("to")?);
        let (first, _) = self.resolves_to(start)?;
        let (last, time) = self.resolves_to(end)?;
        let time = time?;
        if last <= first {
            return None;
        }
        let mut out = object.clone();
        out.insert(
            "to".to_owned(),
            json!({"date": first.to_string(), "time": format!("{:02}:{:02}", time.hour(), time.minute())}),
        );
        self.notes.push(format!(
            "date: a clock range in the message is one day; the call ended on {}; used {}.",
            dates::day_label(last),
            dates::day_label(first)
        ));
        Some(Value::Object(out))
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
            (Call::Move, Place::Filter) => self
                .said
                .all_roles(|role| matches!(role, Role::Row | Role::Due)),
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
            Phrase::Weekday(_) => return None,
            // A read looks back as often as ahead: the model's month stands.
            Phrase::Ordinal(_) | Phrase::Named { .. } | Phrase::MonthEnd(_)
                if place == Place::Filter =>
            {
                return None;
            }
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
        let Some((date, time)) = self.resolves_to(value) else {
            return self.unreadable(value, phrase, text);
        };
        let (want_date, want_time) = match phrase {
            Phrase::Day(day) => (day, time.or(self.said.only_clock())),
            Phrase::Instant(at) => {
                if date == at.date() && time == Some(at.time()) {
                    return None;
                }
                (at.date(), Some(at.time()))
            }
            Phrase::Ordinal(day) => {
                // SPEC §14: the next occurrence, whatever the model wrote.
                let next = next_day_of_month(self.now.date(), day)?;
                (next, time.or(self.said.only_clock()))
            }
            Phrase::Named { month, day } => {
                let next = next_occurrence(self.now.date(), month, day)?;
                (next, time.or(self.said.only_clock()))
            }
            Phrase::MonthEnd(last) => (last, time.or(self.said.only_clock())),
            Phrase::Weekday(_) => return None,
        };
        let same = date == want_date
            && match phrase {
                Phrase::Instant(_) => time == want_time,
                _ => true,
            };
        if same {
            return None;
        }
        Some(self.replace(want_date, want_time, Some(date), text))
    }

    /// The expression for `want_date`, with the note that says what changed.
    fn replace(
        &mut self,
        want_date: Date,
        want_time: Option<Time>,
        had: Option<Date>,
        text: &str,
    ) -> Value {
        let mut fixed = Map::new();
        fixed.insert("date".to_owned(), json!(want_date.to_string()));
        if let Some(time) = want_time {
            fixed.insert(
                "time".to_owned(),
                json!(format!("{:02}:{:02}", time.hour(), time.minute())),
            );
        }
        // a weekday earlier this week is no "this Friday" to come: the note says it is past
        let shown = |date: Date| {
            let today = self.now.date();
            dates::relative_label(date, today).map_or_else(
                || dates::day_label(date),
                |label| {
                    let past = if date < today && label.starts_with("this ") {
                        " (past)"
                    } else {
                        ""
                    };
                    format!("{label}{past} {}", dates::day_label(date))
                },
            )
        };
        self.notes.push(match had {
            Some(had) => format!(
                "date: \"{text}\" is {}; the call had {}; used {}.",
                shown(want_date),
                shown(had),
                shown(want_date)
            ),
            None => format!(
                "date: \"{text}\" is {}; the call's date could not be read; used {}.",
                shown(want_date),
                shown(want_date)
            ),
        });
        Value::Object(fixed)
    }

    /// An expression the runtime cannot evaluate: a date that does not exist
    /// under the one ordinal the message states ("2026-11-31" for "the
    /// thirty-first"), or one outside the grammar ("weekday": 8) under the one
    /// day the message names. Left alone when it is a span, a row anchor, or
    /// when the message names no single day to put in its place.
    fn unreadable(&mut self, value: &Value, phrase: Phrase, text: &str) -> Option<Value> {
        let object = value.as_object()?;
        if object.contains_key("from") || object.contains_key("to") {
            return None;
        }
        // A CLOCK THE CALL WROTE MALFORMED ("time": "9") IS NOT REPAIRED: the
        // message's own clock may be another time ("at 9" is 9 or 21), and
        // dropping it would write a different hour than the person said. The
        // model gets the error and writes "HH:MM".
        if object.get("time").is_some_and(|clock| {
            !clock.is_null()
                && clock
                    .as_str()
                    .is_none_or(|clock| clock.parse::<Time>().is_err())
        }) {
            return None;
        }
        let time = object
            .get("time")
            .and_then(Value::as_str)
            .and_then(|clock| clock.parse::<Time>().ok())
            .or(self.said.only_clock());
        let readable = dates::parse(value).ok().is_some_and(|expr| {
            dates::uses_row(&expr) || dates::evaluate(&expr, self.now, None).is_ok()
        });
        if readable {
            return None;
        }
        let today = self.now.date();
        match phrase {
            Phrase::Day(day) => Some(self.replace(day, time, None, text)),
            Phrase::Ordinal(day) => {
                let (year, month, written) = parts(object.get("date")?.as_str()?)?;
                if written != day || Date::new(year, month, written).is_ok() {
                    return None;
                }
                let next = next_day_of_month(today, day)?;
                let had = Date::new(year, month, 1).ok()?;
                Some(self.replace(next, time, Some(had), text))
            }
            Phrase::Instant(_)
            | Phrase::Weekday(_)
            | Phrase::Named { .. }
            | Phrase::MonthEnd(_) => None,
        }
    }

    /// RULE R1 (SPEC §14.1): "since X" over an aggregate is from X up to now,
    /// closed at today. A filter span with no end (or an end at the calendar's limit) whose
    /// message says "since" before a date, with no end bound of its own in
    /// the words ("up to", "until", "before"), gets today as its end.
    fn close_since(&mut self, message: &str, when: &Value) -> Option<Value> {
        let object = when.as_object()?;
        let from = object.get("from").filter(|value| !value.is_null())?;
        let open = match object.get("to") {
            None | Some(Value::Null) => true,
            Some(end) => is_sentinel_end(end),
        };
        if !open || !says_since(message) {
            return None;
        }
        // A start after today is not a "since": leave the model's span.
        let (start, _) = self.resolves_to(from).or_else(|| {
            let expr = dates::parse(from).ok()?;
            match dates::evaluate(&expr, self.now, None).ok()? {
                Resolved::Days { from, .. } => Some((from, None)),
                Resolved::At(at) => Some((at.date(), Some(at.time()))),
                Resolved::Between { from, .. } => Some((from.date(), None)),
            }
        })?;
        let today = self.now.date();
        if start > today {
            return None;
        }
        let mut out = object.clone();
        out.insert("to".to_owned(), json!({"unit": "day", "rel": 0}));
        self.notes.push(format!(
            "date: \"since\" runs up to today; the call had no end; used {}..{}.",
            start, today
        ));
        Some(Value::Object(out))
    }

    /// A message with one "at 9pm" and a write whose time differs.
    fn clock_only(&mut self, value: &Value) -> Option<Value> {
        let clock = self.said.only_clock()?;
        if self.said.broad {
            return None;
        }
        // "the one due at 9": a time that names the row is not the new time.
        if self.call == Call::Move
            && !self
                .said
                .all_roles(|role| !matches!(role, Role::Row | Role::Due))
        {
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
    /// Whether a write may take every row its selector fits (SPEC §3.3, §4.8), and
    /// who says so: `"trace"` for `scope: all`, `"message"` when, with no scope line, the message
    /// says all, every, everything, each, whole, entire, both or everyone. A word
    /// that quantifies a stretch of time is not one of them: "an all-day event", "every week",
    /// "the whole weekend". A trace that states another scope decides the other way.
    pub(crate) fn said_every_row(&self) -> Option<&'static str> {
        match self.trace.as_ref().and_then(|trace| trace.scope) {
            Some(scope) => (scope == Scope::All).then_some("trace"),
            None => {
                let words = tokens(&self.message);
                words
                    .iter()
                    .enumerate()
                    .any(|(at, word)| match word.as_str() {
                        "both" | "everyone" => true,
                        "all" | "every" | "everything" | "each" | "whole" | "entire" => !words
                            .get(at + 1)
                            .is_some_and(|next| TIME_SPANS.contains(&next.as_str())),
                        _ => false,
                    })
                    .then_some("message")
            }
        }
    }

    /// The message says "same time" and no clock of its own: the time of a reschedule is the
    /// row's (SPEC §14.1, "same time").
    pub(crate) fn said_same_time(&self) -> bool {
        let words = tokens(&self.message);
        words
            .windows(2)
            .any(|pair| pair[0] == "same" && pair[1] == "time")
            && !crate::phrases::read_dates(&self.message, self.now)
                .iter()
                .any(|reading| reading.resolution.contains(':'))
    }

    /// What the current message says about dates.
    pub(crate) fn said(&self) -> Said {
        said(&self.message, self.now)
    }

    /// THE CLOCK A RESCHEDULE CARRIES, as the person said it (nt9, rules 2 and 3): the message
    /// that names a clock, this one or, when the previous turn only asked, the one before it
    /// ("move the call to 8", the ask, "the 22nd"). `None` when no such message names one.
    pub(crate) fn time_words(&self) -> Option<TimeWords> {
        let mut messages = vec![self.message.as_str()];
        if self.date_context().asked_only {
            messages.push(self.prev_message.as_str());
        }
        for message in messages {
            let readings = crate::phrases::read_dates(message, self.now);
            let Some(clock) = readings
                .iter()
                .find(|reading| is_clock_only(&reading.resolution))
            else {
                continue;
            };
            // a message that shifts the row ("a day later at 5") says a day without a phrase
            let shifts = tokens(message).iter().any(|word| {
                matches!(
                    word.as_str(),
                    "earlier"
                        | "later"
                        | "forward"
                        | "ahead"
                        | "day"
                        | "days"
                        | "week"
                        | "weeks"
                        | "month"
                        | "months"
                )
            });
            let day_less = !shifts
                && readings
                    .iter()
                    .all(|reading| is_clock_only(&reading.resolution));
            let said = said(message, self.now);
            let bare = match said.bare.as_slice() {
                [(_, am, pm)]
                    if !said.timed && !said.range && !said.broad && said.clocks.is_empty() =>
                {
                    Some((*am, *pm))
                }
                _ => None,
            };
            return Some(TimeWords {
                phrase: clock.phrase.clone(),
                day_less,
                bare,
            });
        }
        None
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

    /// Repair a call before it runs: the date expressions from the user's words
    /// (`ground_dates`), then its conventions. Returns the (maybe new) args and one note per
    /// repair.
    pub(crate) fn ground(&mut self, tool: &str, args: &Value) -> (Value, Vec<String>) {
        let Some(object) = args.as_object() else {
            return (args.clone(), Vec::new());
        };
        if !matches!(tool, "find" | "answer" | "act" | "compute") {
            return (args.clone(), Vec::new());
        }
        let (grounded, mut notes) = self.ground_dates(tool, object);
        let (grounded, conventions) = self.conventions(tool, &grounded);
        notes.extend(conventions);
        (Value::Object(grounded), notes)
    }

    /// Repair the date expressions of a call from the user's words. Returns
    /// the (maybe new) arguments and one note per repair.
    fn ground_dates(
        &self,
        tool: &str,
        object: &Map<String, Value>,
    ) -> (Map<String, Value>, Vec<String>) {
        if self.message.trim().is_empty() {
            return (object.clone(), Vec::new());
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
            target: Target {
                event: tool == "act"
                    && (verb == "reschedule"
                        || matches!(verb, "create" | "edit")
                            && object
                                .get("kind")
                                .and_then(Value::as_str)
                                .is_some_and(|kind| kind.trim().eq_ignore_ascii_case("event"))),
                reschedule: tool == "act" && verb == "reschedule",
            },
        };
        let mut out = object.clone();
        if let Some(when) = object.get("when").filter(|value| !value.is_null())
            && let Some(fixed) = grounder.expr(when, Place::Filter)
        {
            out.insert("when".to_owned(), fixed);
        }
        // "SINCE X" CLOSES AT TODAY ONLY WHEN THE CALL AGGREGATES (SPEC §14.1):
        // a count, a sum, a breakdown over the interval. A row listing stays
        // as the model wrote it.
        let aggregates = tool == "compute" || (tool == "answer" && object.contains_key("op"));
        if aggregates
            && let Some(when) = out.get("when").filter(|value| !value.is_null())
            && let Some(closed) = grounder.close_since(&self.message, when)
        {
            out.insert("when".to_owned(), closed);
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
        (out, grounder.notes)
    }
}

// ---------------------------------------------------------------------------------------------
// CONVENTIONS AS CODE (SPEC §14.1: "container readouts", "status words", "next", "last one",
// "biggest"). A convention fills a slot the call leaves out. It is read from the call and from a
// few words of the message the SPEC names; a call that states the slot itself is never changed
// (the one exception is `biggest`, which names its own trigger below). `Session::ground` runs them
// after the date repair; `Session::compile` runs the same function, so a compiled call and an
// executed one agree.
// ---------------------------------------------------------------------------------------------

/// Which conventions run (all by default). A switch exists so a convention can be measured on its
/// own; none is a flag of the model-facing prompt.
#[derive(Debug, Clone, Copy)]
pub struct Defaults {
    /// A read, count or sum of tasks linked to a list or a parent task and with no status
    /// condition selects the active rows.
    pub active: bool,
    /// "open", "left", "remaining", "still", "overdue" on a tasks readout (`answer`, `compute`;
    /// not `find`, which also looks rows up for a write: "open them again") with no status
    /// condition is `status = open`.
    pub status_words: bool,
    /// "next" on a dated readout with no `order` and no `limit`: nearest upcoming, `date asc`, 1.
    pub next: bool,
    /// "last one" on a dated readout: past, `date desc`, 1.
    pub last_one: bool,
    /// An else/other/after cue ("what else", "the one after", "besides X") on a read with no
    /// `exclude` leaves out what the previous answer showed (`follow.rs`).
    pub exclude: bool,
    /// "biggest" with `order <number field> desc` and `limit 1` is a value: `op max`.
    pub biggest: bool,
}

impl Default for Defaults {
    fn default() -> Self {
        Self {
            active: true,
            status_words: true,
            next: true,
            last_one: true,
            exclude: true,
            biggest: false, // off: 64 train references read "biggest" as rows+order; a value would regenerate them all for two val turns
        }
    }
}

/// The note under a readout that took the active rows.
pub const ACTIVE_NOTE: &str = "(active rows; add status = completed or all for the rest)";
/// The `where` clause that selects the active rows of a container.
const ACTIVE_CLAUSE: &str = "status != completed and status != cancelled";
/// Words that ask for what is left to do (SPEC §14.1, status).
const STATUS_WORDS: [&str; 5] = ["open", "left", "remaining", "still", "overdue"];
/// "Due" is a status word of the same kind when the message asks what is due on a day or span
/// ("what's due tomorrow"); "the next chore due" is the next-one convention's, not this one's.
const DUE: &str = "due";
/// The words of `EVERY_STATUS` that name a state a row has: "that i haven't done" is the open
/// rows, not the done ones.
const STATE_WORDS: [&str; 3] = ["done", "finished", "completed"];
/// What turns a state word into the rows that lack it.
const NEGATORS: [&str; 26] = [
    "not", "never", "no", "haven't", "havent", "hasn't", "hasnt", "hadn't", "didn't", "didnt",
    "don't", "dont", "isn't", "aren't", "wasn't", "weren't", "yet", "without", "haven", "hasn",
    "hadn", "didn", "don", "isn", "aren", "wasn",
];
/// Words that ask for rows of every status.
const EVERY_STATUS: [&str; 8] = [
    "all",
    "everything",
    "done",
    "completed",
    "finished",
    "cancelled",
    "canceled",
    "closed",
];
/// What may follow "next" without making it "the nearest one": a date unit or a count.
const NEXT_NOT: [&str; 36] = [
    "week",
    "weekend",
    "month",
    "year",
    "fortnight",
    "day",
    "days",
    "hour",
    "hours",
    "minute",
    "minutes",
    "quarter",
    "monday",
    "tuesday",
    "tue",
    "tues",
    "wednesday",
    "thursday",
    "thu",
    "thur",
    "thurs",
    "friday",
    "fri",
    "saturday",
    "sunday",
    "mon",
    "wed",
    "sat",
    "sun",
    "couple",
    "few",
    "to",
    "of",
    "morning",
    "evening",
    "weeks",
];
const NUMBER_WORDS: [&str; 13] = [
    "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven",
    "twelve", "dozen",
];

/// The date-expression text the conventions write for "from today on".
const FROM_TODAY: &str = r#"{"from":{"unit":"day","rel":0}}"#;
/// And for "up to today".
const UNTIL_TODAY: &str = r#"{"to":{"unit":"day","rel":0}}"#;

/// The kinds a schedule dates: a task is due and an event starts, upcoming or past.
fn scheduled(kind: Kind) -> bool {
    matches!(kind, Kind::Task | Kind::Event)
}

fn cond_field(cond: &Cond) -> Option<&'static str> {
    match cond {
        Cond::Number { field, .. }
        | Cond::Text { field, .. }
        | Cond::Enum { field, .. }
        | Cond::Bool { field, .. }
        | Cond::Contains { field, .. }
        | Cond::In { field, .. }
        | Cond::Presence { field, .. } => Some(field),
        Cond::LinkCount { .. } => None,
    }
}

/// Whether the message asks for rows of every status: a word of `EVERY_STATUS`, except a state
/// word the person negates ("what's due that i haven't done").
fn lifts_status(words: &[String]) -> bool {
    words.iter().enumerate().any(|(at, word)| {
        EVERY_STATUS.contains(&word.as_str())
            && !(STATE_WORDS.contains(&word.as_str())
                && words[at.saturating_sub(3)..at]
                    .iter()
                    .any(|before| NEGATORS.contains(&before.as_str())))
    })
}

fn says_any(words: &[String], list: &[&str]) -> bool {
    words.iter().any(|word| list.contains(&word.as_str()))
}

/// "next" as the nearest upcoming one: the word is there, what follows it is not a date unit
/// or a count ("next week", "next friday", "next 3", "next three"), and it does not close a
/// "this week or next".
fn says_next(words: &[String]) -> bool {
    words.iter().enumerate().any(|(index, word)| {
        word == "next"
            && !words.get(index + 1).is_some_and(|after| {
                NEXT_NOT.contains(&after.as_str())
                    || NUMBER_WORDS.contains(&after.as_str()) && after != "one"
                    || after.chars().all(|c| c.is_ascii_digit())
            })
            && !(index > 0 && matches!(words[index - 1].as_str(), "or" | "and" | "to" | "after"))
    })
}

fn says_last_one(words: &[String]) -> bool {
    words
        .windows(2)
        .any(|pair| pair[0] == "last" && pair[1] == "one")
}

/// "latest" or "newest" as the one most recent row ("my latest diary entry"): the word is there
/// and what follows it is not an order ("latest first", "latest to oldest"), a count ("3
/// latest" before it, "latest three", "latest ones") or a figure of speech ("the latest on x").
fn says_latest(words: &[String]) -> bool {
    words.iter().enumerate().any(|(index, word)| {
        matches!(word.as_str(), "latest" | "newest")
            && !words.get(index + 1).is_some_and(|after| {
                matches!(
                    after.as_str(),
                    "first"
                        | "to"
                        | "on"
                        | "about"
                        | "news"
                        | "update"
                        | "updates"
                        | "few"
                        | "ones"
                        | "couple"
                        | "from"
                        | "with"
                        | "and"
                        | "or"
                ) || NUMBER_WORDS.contains(&after.as_str()) && after != "one"
                    || after.chars().all(|c| c.is_ascii_digit())
            })
            && !(index > 0
                && (NUMBER_WORDS.contains(&words[index - 1].as_str()) && words[index - 1] != "one"
                    || words[index - 1].chars().all(|c| c.is_ascii_digit())))
    })
}

/// Whether `value` is the `when` the conventions write for "from today on" (or the same by the
/// model's hand).
fn is_from_today(value: &Value) -> bool {
    let parsed = match value {
        Value::String(text) => serde_json::from_str::<Value>(text).ok(),
        other => Some(other.clone()),
    };
    parsed.is_some_and(|parsed| parsed == json!({"from": {"unit": "day", "rel": 0}}))
}

fn is_blank(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => true,
        Some(Value::String(text)) => text.trim().is_empty(),
        _ => false,
    }
}

/// `where` plus one more clause.
fn add_where(out: &mut Map<String, Value>, clause: &str) {
    let have = out
        .get("where")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    let joined = if have.is_empty() {
        clause.to_owned()
    } else {
        format!("{have} and {clause}")
    };
    out.insert("where".to_owned(), Value::String(joined));
}

impl Session {
    /// The conventions of a read (`find`, `answer`, `compute`): the call with the slots they
    /// fill, and one note per convention that applied. A call that does not parse comes back as
    /// it was; the dispatch reports its error.
    pub(crate) fn conventions(
        &self,
        tool: &str,
        object: &Map<String, Value>,
    ) -> (Map<String, Value>, Vec<String>) {
        let (mut out, mut notes) = self.slot_conventions(tool, object);
        self.exclude_shown(tool, &mut out, &mut notes);
        (out, notes)
    }

    /// "What else": a read of a listing, with an else/other/after cue in the message and no
    /// `exclude` of its own, leaves out what the previous answer showed (`follow.rs`, D-1044-8).
    fn exclude_shown(&self, tool: &str, out: &mut Map<String, Value>, notes: &mut Vec<String>) {
        if !self.flags.defaults.exclude
            || !(tool == "find" || tool == "answer" && is_blank(out.get("op")))
            || !is_blank(out.get("exclude"))
            || !is_blank(out.get("within"))
            || !is_blank(out.get("rows"))
            || !is_blank(out.get("value"))
            || !is_blank(out.get("group"))
        {
            return;
        }
        let Ok(selector) = self.selector(out) else {
            return;
        };
        if selector.trashed {
            return;
        }
        let Some((handles, note)) = self.exclusion(&tokens(&self.message), &selector.kinds) else {
            return;
        };
        out.insert("exclude".to_owned(), json!(handles));
        notes.push(note);
    }

    /// The slots a convention fills from the call and a few words (`Defaults`).
    fn slot_conventions(
        &self,
        tool: &str,
        object: &Map<String, Value>,
    ) -> (Map<String, Value>, Vec<String>) {
        let unchanged = || (object.clone(), Vec::new());
        if !matches!(tool, "find" | "answer" | "compute") {
            return unchanged();
        }
        if object.get("rows").is_some_and(|rows| !rows.is_null())
            || object.get("value").is_some_and(|value| !value.is_null())
        {
            return unchanged();
        }
        let Ok(selector) = self.selector(object) else {
            return unchanged();
        };
        if selector.trashed || selector.kinds.len() != 1 {
            return unchanged();
        }
        let op = object.get("op").and_then(Value::as_str);
        let aggregates = tool == "compute" || (tool == "answer" && op.is_some());
        if op == Some("balance") {
            return unchanged();
        }
        let kind = selector.kinds[0];
        let words = tokens(&self.message);
        let defaults = self.flags.defaults;
        let mut out = object.clone();
        let mut notes = Vec::new();

        if kind == Kind::Task
            && !selector
                .conds
                .iter()
                .any(|c| cond_field(c) == Some("status"))
        {
            let every = lifts_status(&words);
            let container = selector
                .linked_to
                .iter()
                .any(|target| matches!(target.0, Kind::List | Kind::Task));
            let asks_left = says_any(&words, &STATUS_WORDS)
                || (words.iter().any(|word| word == DUE) && !says_next(&words));
            if defaults.status_words && tool != "find" && !every && asks_left {
                add_where(&mut out, "status = open");
                notes.push("status: the message asks what is left; used status = open.".to_owned());
            } else if defaults.active && !every && container {
                add_where(&mut out, ACTIVE_CLAUSE);
            }
        }
        // The note belongs to the clause, whoever wrote it.
        if kind == Kind::Task
            && let Ok(after) = self.selector(&out)
            && !after.linked_to.is_empty()
            && let [first, second] = after
                .conds
                .iter()
                .filter(|c| cond_field(c) == Some("status"))
                .collect::<Vec<_>>()
                .as_slice()
            && is_not(first, "completed", "cancelled")
            && is_not(second, "completed", "cancelled")
        {
            notes.push(ACTIVE_NOTE.to_owned());
        }

        // The rest read a listing of one dated kind, and not of what hangs off a task or an event
        // of another kind: "who's at the next rehearsal" is the next rehearsal in one call and the
        // people linked to it in another, and only the first is the next one.
        let through_a_dated_row = selector
            .linked_to
            .iter()
            .any(|row| scheduled(row.0) && row.0 != kind);
        let listing = (tool == "find" || (tool == "answer" && op.is_none()))
            && !aggregates
            && kind.spec().date.is_some()
            && !through_a_dated_row;
        if listing {
            let ordered = !is_blank(out.get("order"));
            let limited = !is_blank(out.get("limit"));
            // "next" is the nearest upcoming row, and only a task (due) or an event (start) has an
            // upcoming date: the date of the other dated kinds is when a row was made or last
            // touched, so "the next" of them is another read
            let next = defaults.next && says_next(&words) && scheduled(kind);
            let last = defaults.last_one && says_last_one(&words);
            let latest = defaults.last_one && says_latest(&words);
            if next && !last && !ordered && !limited {
                out.insert("order".to_owned(), json!("date asc"));
                out.insert("limit".to_owned(), json!(1));
                if is_blank(out.get("when")) {
                    out.insert("when".to_owned(), json!(FROM_TODAY));
                }
                notes.push(
                    "next: the message asks for the next one; used order date asc, limit 1 from today."
                        .to_owned(),
                );
            } else if last && !next {
                let mut changed = false;
                if !ordered && !limited {
                    out.insert("order".to_owned(), json!("date desc"));
                    out.insert("limit".to_owned(), json!(1));
                    changed = true;
                }
                let desc_one = out
                    .get("order")
                    .and_then(Value::as_str)
                    .is_some_and(|order| order.trim().eq_ignore_ascii_case("date desc"))
                    && self_limit(&out) == Some(1);
                if desc_one
                    && (is_blank(out.get("when")) || out.get("when").is_some_and(is_from_today))
                {
                    out.insert("when".to_owned(), json!(UNTIL_TODAY));
                    changed = true;
                }
                if changed {
                    notes.push(
                        "last: the message asks for the last one; used order date desc, limit 1 up to today."
                            .to_owned(),
                    );
                }
            } else if latest && !next && !ordered && !limited {
                // "latest" is the last by the kind's date, with no span of its own: it only fills
                // the order and the limit the call leaves out
                out.insert("order".to_owned(), json!("date desc"));
                out.insert("limit".to_owned(), json!(1));
                notes.push(
                    "last: the message asks for the latest one; used order date desc, limit 1."
                        .to_owned(),
                );
            }
            // THE CALL'S OWN SHAPE: the same read written as order, limit and `when` (the model
            // spells "next" that way as often as with the slot) is the same query, and a row
            // that is cancelled is never the next one.
            if let Some(shape) = self.query_shape(&out, defaults)
                && !says_any(&words, &EVERY_STATUS)
                && let Ok(after) = self.selector(&out)
                && !after
                    .conds
                    .iter()
                    .any(|cond| cond_field(cond) == Some("status"))
            {
                let (clause, left_out) = match kind {
                    Kind::Event => ("status != cancelled", "cancelled rows"),
                    Kind::Task => (ACTIVE_CLAUSE, "completed and cancelled rows"),
                    _ => ("", ""),
                };
                if !clause.is_empty() {
                    add_where(&mut out, clause);
                    notes.push(format!(
                        "{shape}: the call reads the {shape} one; left out {left_out} ({clause})."
                    ));
                }
            }
        }
        if defaults.biggest
            && tool == "answer"
            && op.is_none()
            && !object.contains_key("group")
            && words.iter().any(|word| word == "biggest")
            && self_limit(&out) == Some(1)
            && let Some(order) = out.get("order").and_then(Value::as_str)
        {
            let mut parts = order.split_whitespace();
            let field = parts.next().unwrap_or_default().to_lowercase();
            let desc = parts.next().is_some_and(|d| d.eq_ignore_ascii_case("desc"));
            let numeric = kind
                .spec()
                .field(&field)
                .is_some_and(|f| matches!(f.ty, FieldType::Number | FieldType::Money));
            if desc && numeric {
                out.remove("order");
                out.remove("limit");
                out.insert("op".to_owned(), json!("max"));
                out.insert("field".to_owned(), json!(field.clone()));
                notes.push(format!(
                    "value: the message asks for the biggest; read as op max of {field}."
                ));
            }
        }
        (out, notes)
    }
}

impl Session {
    /// Whether a read is a next-query or a last-query by its own shape: `order: date asc` (or
    /// `desc`), `limit: 1` and a `when` that starts today (or, for the last one, ends by it), in
    /// any spelling the date grammar has.
    fn query_shape(&self, call: &Map<String, Value>, defaults: Defaults) -> Option<&'static str> {
        let selector = self.selector(call).ok()?;
        let (field, desc) = selector.order.as_ref()?;
        if field != "date" || selector.limit != Some(1) {
            return None;
        }
        let (start, end) = selector.when?.ends();
        let today = self.now.date();
        if !desc && defaults.next && start.date() == today {
            Some("next")
        } else if *desc && defaults.last_one && start.date() == Date::MIN && end.date() <= today {
            Some("last")
        } else {
            None
        }
    }
}

fn is_not(cond: &Cond, a: &str, b: &str) -> bool {
    matches!(cond, Cond::Enum { field: "status", op: Op::Ne, value } if *value == a || *value == b)
}

fn self_limit(object: &Map<String, Value>) -> Option<i64> {
    match object.get("limit")? {
        Value::Number(number) => number.as_i64(),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
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
            target: Target::default(),
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
        assert_eq!(role_of("add the filing, due tomorrow"), Role::Due);
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
    fn a_named_month_and_day_is_rewritten_only_in_a_write() {
        // Said on 2026-08-19, "the 3rd of may" in a write is next year's (the
        // convention table is `a_named_month_and_day_on_a_write_is_its_next_occurrence`).
        let session_said = said("put the vet on the 3rd of may", now());
        let mut grounder = ground_for(&session_said, Call::Create);
        let fixed = grounder
            .expr(&json!({"date": "2026-06-03"}), Place::Write)
            .unwrap();
        assert_eq!(fixed, json!({"date": "2027-05-03"}));
        // In a read the model's month and year stand.
        let session_said = said("what was on the 3rd of may", now());
        let mut grounder = ground_for(&session_said, Call::Read);
        assert!(
            grounder
                .expr(&json!({"date": "2026-05-03"}), Place::Filter)
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

    // ---- A.1: ground, don't compute --------------------------------------

    /// One literal phrase, one model expression, the expression the runtime
    /// must end with (`None` = left as the model wrote it).
    struct Case {
        today: &'static str,
        message: &'static str,
        call: Call,
        place: Place,
        model: Value,
        want: Option<Value>,
    }

    fn run(case: &Case) -> Option<Value> {
        let today = dates::parse_now(case.today).unwrap();
        let said = said(case.message, today);
        let mut grounder = ground_at(&said, case.call, today);
        grounder.expr(&case.model, case.place)
    }

    #[test]
    fn an_explicit_day_of_the_month_is_never_rewritten_by_its_weekday() {
        // 2026-12-11 is a Friday; today (2026-08-19) is a Wednesday, so the
        // bare-weekday repair would move "friday" to 2026-08-21.
        for message in [
            "friday dec 11 at 8pm",
            "book dinner friday dec 11 at 8pm",
            "book dinner friday 11 dec at 8pm",
            "book dinner friday december 11th at 8pm",
            "book dinner on friday the 11th of december at 8pm",
            "book dinner fri 11 dec at 8pm",
        ] {
            let case = Case {
                today: "2026-08-19T09:00",
                message,
                call: Call::Create,
                place: Place::Write,
                model: json!({"date": "2026-12-11", "time": "20:00"}),
                want: None,
            };
            assert_eq!(run(&case), None, "{message}");
        }
        // The repair still fires for a bare weekday.
        let bare = Case {
            today: "2026-08-19T09:00",
            message: "book dinner friday at 8pm",
            call: Call::Create,
            place: Place::Write,
            model: json!({"unit": "week", "rel": 1, "weekday": 5, "time": "20:00"}),
            want: Some(json!({"date": "2026-08-21", "time": "20:00"})),
        };
        assert_eq!(run(&bare), bare.want);
    }

    #[test]
    fn a_write_to_a_bare_day_of_the_month_is_its_next_occurrence() {
        // SPEC §14 bare weekday: the next one, today included. Every one of
        // the 52 training writes to a bare ordinal is on or after today.
        let cases = [
            // The day has passed this month: next month's.
            (
                "2026-08-18T15:45",
                "the inspection follow-up, make it the eleventh instead",
                Call::Move,
                json!({"date": "2026-08-11"}),
                Some(json!({"date": "2026-09-11"})),
            ),
            (
                "2026-07-26T09:00",
                "push the insurance renewal to the twentieth",
                Call::Move,
                json!({"date": "2026-07-20"}),
                Some(json!({"date": "2026-08-20"})),
            ),
            (
                "2026-08-19T09:00",
                "put the vet on the 3rd",
                Call::Create,
                json!({"date": "2026-08-03"}),
                Some(json!({"date": "2026-09-03"})),
            ),
            // The right date is left alone, today's day included.
            (
                "2026-08-18T15:45",
                "make it the eleventh instead",
                Call::Move,
                json!({"date": "2026-09-11"}),
                None,
            ),
            (
                "2026-08-19T09:00",
                "push it to the nineteenth",
                Call::Move,
                json!({"date": "2026-08-19"}),
                None,
            ),
            // The next occurrence is the reading whatever the model wrote:
            // a later month or another day of the month is rolled back to it.
            (
                "2026-08-19T09:00",
                "push it to the twentieth",
                Call::Move,
                json!({"date": "2026-09-20"}),
                Some(json!({"date": "2026-08-20"})),
            ),
            (
                "2026-08-18T15:45",
                "make it the eleventh instead",
                Call::Move,
                json!({"date": "2026-10-11"}),
                Some(json!({"date": "2026-09-11"})),
            ),
            (
                "2026-09-25T09:00",
                "move it to the twenty-fifth",
                Call::Move,
                json!({"date": "2026-10-25"}),
                Some(json!({"date": "2026-09-25"})),
            ),
            (
                "2026-09-25T09:00",
                "move it to the twenty-fifth",
                Call::Move,
                json!({"date": "2026-09-27"}),
                Some(json!({"date": "2026-09-25"})),
            ),
            // A date that does not exist is the next day-of-month that does.
            (
                "2026-10-14T09:00",
                "put it on the thirty-first",
                Call::Create,
                json!({"date": "2026-11-31"}),
                Some(json!({"date": "2026-10-31"})),
            ),
            // The time rides along.
            (
                "2026-08-18T15:45",
                "move it to the 11th at 3pm",
                Call::Move,
                json!({"date": "2026-08-11", "time": "15:00"}),
                Some(json!({"date": "2026-09-11", "time": "15:00"})),
            ),
            // Two ordinals, or an ordinal that names the row: untouched.
            (
                "2026-08-18T15:45",
                "move the 11th to the 20th",
                Call::Move,
                json!({"date": "2026-08-11"}),
                None,
            ),
            (
                "2026-08-18T15:45",
                "reschedule the dentist on the 11th",
                Call::Move,
                json!({"date": "2026-08-11"}),
                None,
            ),
        ];
        let total = cases.len();
        let mut passed = 0;
        for (today, message, call, model, want) in cases {
            let case = Case {
                today,
                message,
                call,
                place: Place::Write,
                model,
                want,
            };
            let got = run(&case);
            if got == case.want {
                passed += 1;
            } else {
                eprintln!("{today} {message:?}: {got:?}, wanted {:?}", case.want);
            }
        }
        assert_eq!(passed, total);
    }

    #[test]
    fn a_read_of_a_bare_day_of_the_month_keeps_the_models_month() {
        // The past and the future both occur in reads ("from the tenth").
        let case = Case {
            today: "2026-09-14T09:00",
            message: "delete the one from the twenty-ninth",
            call: Call::Read,
            place: Place::Filter,
            model: json!({"date": "2026-08-29"}),
            want: None,
        };
        assert_eq!(run(&case), None);
    }

    #[test]
    fn a_named_month_and_day_on_a_write_is_its_next_occurrence() {
        let cases = [
            // Past this year: next year's.
            (
                "2026-08-19T09:00",
                "put the vet on the 3rd of may",
                Call::Create,
                json!({"date": "2026-05-03"}),
                Some(json!({"date": "2027-05-03"})),
            ),
            (
                "2026-08-19T09:00",
                "put the vet on may 3rd",
                Call::Create,
                json!({"date": "2026-05-03"}),
                Some(json!({"date": "2027-05-03"})),
            ),
            (
                "2026-08-19T09:00",
                "dinner dec 11",
                Call::Create,
                json!({"date": "2025-12-11"}),
                Some(json!({"date": "2026-12-11"})),
            ),
            // Wrong month: the person's month wins.
            (
                "2026-08-19T09:00",
                "put the vet on the 3rd of may",
                Call::Create,
                json!({"date": "2026-06-03"}),
                Some(json!({"date": "2027-05-03"})),
            ),
            // Already the next occurrence.
            (
                "2026-08-19T09:00",
                "dinner dec 11",
                Call::Create,
                json!({"date": "2026-12-11"}),
                None,
            ),
            // The next occurrence whatever the model wrote: this year's
            // December, not next year's.
            (
                "2026-08-19T09:00",
                "dinner dec 11",
                Call::Create,
                json!({"date": "2027-12-11"}),
                Some(json!({"date": "2026-12-11"})),
            ),
            (
                "2026-12-11T09:00",
                "dinner dec 11",
                Call::Create,
                json!({"date": "2027-12-11"}),
                Some(json!({"date": "2026-12-11"})),
            ),
            (
                "2026-08-19T09:00",
                "dinner 11 dec",
                Call::Create,
                json!({"date": "2026-12-11"}),
                None,
            ),
            (
                "2026-08-19T09:00",
                "move it to the 3rd of september",
                Call::Move,
                json!({"date": "2026-09-03"}),
                None,
            ),
            // The time rides along.
            (
                "2026-08-19T09:00",
                "dinner dec 11 at 8pm",
                Call::Create,
                json!({"date": "2025-12-11", "time": "20:00"}),
                Some(json!({"date": "2026-12-11", "time": "20:00"})),
            ),
        ];
        let total = cases.len();
        let mut passed = 0;
        for (today, message, call, model, want) in cases {
            let case = Case {
                today,
                message,
                call,
                place: Place::Write,
                model,
                want,
            };
            let got = run(&case);
            if got == case.want {
                passed += 1;
            } else {
                eprintln!("{today} {message:?}: {got:?}, wanted {:?}", case.want);
            }
        }
        assert_eq!(passed, total);
    }

    #[test]
    fn a_short_weekday_after_next_or_this_is_a_weekday() {
        // 2026-10-14 is a Wednesday.
        let at = |message: &str| {
            said(message, dates::parse_now("2026-10-14T21:10").unwrap())
                .only_day(true)
                .map(|(date, _)| date.to_string())
        };
        assert_eq!(at("cancel it next sat").as_deref(), Some("2026-10-24"));
        assert_eq!(at("cancel it this sat").as_deref(), Some("2026-10-17"));
        assert_eq!(at("see you on sun").as_deref(), Some("2026-10-18"));
        assert_eq!(at("push it to mon").as_deref(), Some("2026-10-19"));
        // The ordinary words stay words.
        assert_eq!(at("he sat there all day"), None);
        assert_eq!(at("the sun was out"), None);
    }

    #[test]
    fn a_date_expression_the_runtime_cannot_read_is_replaced_by_the_one_phrase() {
        // T03-004: "weekday": 8 looped the model to the step cap.
        let case = Case {
            today: "2026-10-14T21:10",
            message: "tap can wait till next sat",
            call: Call::Move,
            place: Place::Write,
            model: json!({"unit": "week", "rel": 1, "weekday": 8}),
            want: Some(json!({"date": "2026-10-24"})),
        };
        assert_eq!(run(&case), case.want);
        let case = Case {
            today: "2026-08-19T09:00",
            message: "push it to friday",
            call: Call::Move,
            place: Place::Write,
            model: json!({"unit": "week", "weekday": 9}),
            want: Some(json!({"date": "2026-08-21"})),
        };
        assert_eq!(run(&case), case.want);
        // Two phrases, or none: nothing to replace it with.
        let none = Case {
            today: "2026-08-19T09:00",
            message: "push it",
            call: Call::Move,
            place: Place::Write,
            model: json!({"unit": "week", "weekday": 9}),
            want: None,
        };
        assert_eq!(run(&none), None);
    }

    #[test]
    fn a_clock_range_is_one_day() {
        // T03-021: "fri 6 to 6.30" came back with the end on the 27th.
        let case = Case {
            today: "2026-10-14T21:10",
            message: "book a call w carla about the tournament fri 6 to 6.30",
            call: Call::Create,
            place: Place::Write,
            model: json!({"from": {"unit": "week", "rel": 0, "weekday": 5, "time": "18:00"},
                          "to": {"date": "2026-10-27", "time": "18:30"}}),
            want: Some(
                json!({"from": {"unit": "week", "rel": 0, "weekday": 5, "time": "18:00"},
                              "to": {"date": "2026-10-16", "time": "18:30"}}),
            ),
        };
        assert_eq!(run(&case), case.want);
        // No clock range in the words: a multi-day event is the model's call.
        let long = Case {
            today: "2026-10-14T21:10",
            message: "book the retreat friday to monday",
            call: Call::Create,
            place: Place::Write,
            model: json!({"from": {"date": "2026-10-16"}, "to": {"date": "2026-10-19"}}),
            want: None,
        };
        assert_eq!(run(&long), None);
    }

    /// The harvested phrase table: every create / reschedule of the training
    /// and validation sets whose user text holds a weekday, a month or an
    /// ordinal (`tests/fixtures/phrases.json`: today, message, verb, the
    /// authored date expression). Each is replayed with the model's expression
    /// wrong in two ways: the right date a month early (a wrong month or
    /// year), and a structured weekday in the wrong week. A case passes when
    /// the runtime ends on the authored date.
    #[test]
    fn the_harvested_phrase_table_resolves() {
        #[derive(serde::Deserialize)]
        struct Harvest {
            id: String,
            today: String,
            message: String,
            verb: String,
            gold: Value,
        }
        let cases: Vec<Harvest> =
            serde_json::from_str(include_str!("../tests/fixtures/phrases.json")).unwrap();
        let mut total = [0_usize; 2];
        let mut passed = [0_usize; 2];
        let mut reasons: std::collections::BTreeMap<String, Vec<String>> = Default::default();
        for case in &cases {
            let now = dates::parse_now(&case.today).unwrap();
            let Ok(expr) = dates::parse(&case.gold) else {
                continue;
            };
            let Ok(expected) = dates::evaluate(&expr, now, None) else {
                continue;
            };
            let (day, time) = match expected {
                Resolved::Days { from, to } if from == to => (from, None),
                Resolved::At(at) => (at.date(), Some(at.time())),
                _ => continue,
            };
            let clock =
                |time: Option<Time>| time.map(|t| format!("{:02}:{:02}", t.hour(), t.minute()));
            let mut wrongs: Vec<(usize, Value)> = Vec::new();
            if let Some(back) = day.checked_sub(1.month()).ok().filter(|back| *back != day) {
                let mut wrong = json!({"date": back.to_string()});
                if let Some(clock) = clock(time) {
                    wrong["time"] = json!(clock);
                }
                wrongs.push((0, wrong));
            }
            if let Some(object) = case.gold.as_object()
                && object.get("unit") == Some(&json!("week"))
                && object.contains_key("weekday")
                && let Some(rel) = object.get("rel").and_then(Value::as_i64)
            {
                let mut wrong = case.gold.clone();
                wrong["rel"] = json!(if rel == 0 { 1 } else { rel - 1 });
                wrongs.push((1, wrong));
            }
            let said = said(&case.message, now);
            for (kind, wrong) in wrongs {
                total[kind] += 1;
                let mut grounder = Grounder {
                    said: &said,
                    now,
                    notes: Vec::new(),
                    ahead: true,
                    call: if case.verb == "create" {
                        Call::Create
                    } else {
                        Call::Move
                    },
                    context: Context::default(),
                    target: Target::default(),
                };
                let fixed = grounder
                    .expr(&wrong, Place::Write)
                    .unwrap_or_else(|| wrong.clone());
                let got = dates::parse(&fixed)
                    .ok()
                    .and_then(|expr| dates::evaluate(&expr, now, None).ok());
                if got == Some(expected) {
                    passed[kind] += 1;
                    continue;
                }
                let why = if said.phrases.is_empty() {
                    "the message states no day the runtime reads"
                } else if said.broad {
                    "a broad word (week, month, a span word) is in the message"
                } else if said.only().is_none() {
                    "two different day phrases"
                } else if !grounder.governs(Place::Write) {
                    "the phrase names the row, not where the write puts it"
                } else {
                    "a weekday that may continue the talk"
                };
                reasons
                    .entry(format!("{kind}: {why}"))
                    .or_default()
                    .push(format!("{} {:?} {wrong}", case.id, case.message));
            }
        }
        eprintln!(
            "phrase table: month-early {}/{}, wrong week {}/{}",
            passed[0], total[0], passed[1], total[1]
        );
        for (why, cases) in &reasons {
            eprintln!("  {why}: {}", cases.len());
            for case in cases.iter().take(3) {
                eprintln!("      {case}");
            }
        }
        assert!(total[0] > 300 && total[1] > 150, "{total:?}");
        // The floor is what the table resolved when it was cut; a rule that
        // loses a case fails here.
        assert!(passed[0] * 100 >= total[0] * 74, "{passed:?} / {total:?}");
        assert!(passed[1] * 100 >= total[1] * 78, "{passed:?} / {total:?}");
    }

    #[test]
    fn a_create_due_on_a_day_takes_that_day() {
        // "due" names the row in "the one due tomorrow" but sets the date of a
        // new row ("add get travel adapter, due next fri").
        let cases = [
            (
                "2026-08-19T09:00",
                "add get travel adapter to tokyo prep, due next fri",
                Call::Create,
                json!({"unit": "week", "rel": 0, "weekday": 5}),
                Some(json!({"date": "2026-08-28"})),
            ),
            (
                "2026-08-19T09:00",
                "then add a task to call kirin, due saturday",
                Call::Create,
                json!({"unit": "week", "rel": 1, "weekday": 6}),
                Some(json!({"date": "2026-08-22"})),
            ),
            // The same words on a move name the row.
            (
                "2026-08-19T09:00",
                "the one due saturday",
                Call::Move,
                json!({"unit": "week", "rel": 1, "weekday": 6}),
                None,
            ),
        ];
        let total = cases.len();
        let mut passed = 0;
        for (today, message, call, model, want) in cases {
            let case = Case {
                today,
                message,
                call,
                place: Place::Write,
                model,
                want,
            };
            if run(&case) == case.want {
                passed += 1;
            } else {
                eprintln!(
                    "{today} {message:?}: {:?}, wanted {:?}",
                    run(&case),
                    case.want
                );
            }
        }
        assert_eq!(passed, total);
    }

    #[test]
    fn the_end_of_a_month_in_a_write_is_its_last_day() {
        // 6 of 6 training writes: "due end of march" is 2026-03-31.
        let cases = [
            (
                "2026-02-07T09:00",
                "remind me to book the room, due end of march",
                Call::Create,
                json!({"date": "2026-03-30"}),
                Some(json!({"date": "2026-03-31"})),
            ),
            (
                "2026-06-19T09:00",
                "push renew passport to the end of september",
                Call::Move,
                json!({"date": "2026-09-29"}),
                Some(json!({"date": "2026-09-30"})),
            ),
            (
                "2027-06-08T09:00",
                "add draft 3 spreads to it, due end of the month",
                Call::Create,
                json!({"date": "2027-06-29"}),
                Some(json!({"date": "2027-06-30"})),
            ),
            // Already right.
            (
                "2026-02-07T09:00",
                "remind me to book the room, due end of march",
                Call::Create,
                json!({"date": "2026-03-31"}),
                None,
            ),
            // A month that has passed this year is next year's.
            (
                "2026-08-19T09:00",
                "push it to the end of march",
                Call::Move,
                json!({"date": "2026-03-31"}),
                Some(json!({"date": "2027-03-31"})),
            ),
        ];
        let total = cases.len();
        let mut passed = 0;
        for (today, message, call, model, want) in cases {
            let case = Case {
                today,
                message,
                call,
                place: Place::Write,
                model,
                want,
            };
            if run(&case) == case.want {
                passed += 1;
            } else {
                eprintln!(
                    "{today} {message:?}: {:?}, wanted {:?}",
                    run(&case),
                    case.want
                );
            }
        }
        assert_eq!(passed, total);
        // In a read "the end of march" is a span the model writes.
        let read = Case {
            today: "2026-02-07T09:00",
            message: "what's due at the end of march",
            call: Call::Read,
            place: Place::Filter,
            model: json!({"date": "2026-03-30"}),
            want: None,
        };
        assert_eq!(run(&read), None);
    }
}
