//! THE PHRASE → EXPRESSION TABLE and the `dates:` line (SPEC §4.4, §6.1, §14).
//!
//! The evaluator reads only the expression it is handed, so `PHRASES` is data
//! for the generator: one fixed reading per phrase, the §14 date rulings, and
//! `tests/dates.rs` proves every row's expression evaluates to the echo
//! written beside it. Each row is a worked example: the phrase, the `today` it
//! is read on (and the row date, for `anchor: row` phrases), the expression the
//! model writes, and the echo the runtime answers with. A reading that depends
//! on today (a bare weekday) carries its rule.
//!
//! The runtime reads a person's date phrases in one place, `dates_line`: the
//! phrases of a message it can resolve, each read into the expression the
//! table pairs with it and evaluated by `crate::dates`, printed in the user
//! turn's block so the model copies a date instead of computing it.

use jiff::ToSpan as _;
use jiff::civil::{Date, DateTime, Time};
use serde::Serialize;

use crate::dates::{self, Expr, Resolved, Unit};

/// One worked example.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct Phrase {
    pub phrase: &'static str,
    /// `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM` (the current time, for hour units).
    pub today: &'static str,
    /// The target row's date, for `anchor: row`.
    pub row: Option<&'static str>,
    /// The expression, as JSON text.
    pub expr: &'static str,
    /// What the runtime echoes.
    pub echo: &'static str,
    /// The §14 ruling the reading follows, when one applies.
    pub rule: Option<&'static str>,
}

pub const RULE_AT_HOUR: &str = "\"at N\" = N+12:00 for N in 1..7, else as written";
pub const RULE_LAST_MONTH: &str =
    "\"last <month>\" = the most recent fully ended month of that name (rel -1)";
pub const RULE_NEXT_MONTH: &str =
    "\"next <month>\" = the next month of that name that has not begun (rel 1)";
pub const RULE_NEXT_WEEKDAY: &str =
    "\"next <weekday>\" = that day of next week (week rel 1), even on a Sunday";
pub const RULE_BARE_WEEKDAY: &str = "a bare weekday = its next occurrence, today included: week rel 0 when the day is today or later this week, else week rel 1";
pub const RULE_WEEKEND: &str = "\"this weekend\" = the coming Saturday–Sunday, today if it is Saturday or Sunday (weeks start Monday)";
pub const RULE_LAST_N_DAYS: &str = "\"the last N days\" = N days ending today";
pub const RULE_WEEKDAY_WEEK: &str =
    "\"<weekday> week\" = that day of the week after next (week rel 2)";
pub const RULE_END_OF: &str = "\"end of the month\" = this month's last day; \"end of <month>\" = the last day of the next one that is not past, in a write";
pub const RULE_MONTH_DAY: &str =
    "a month and day, or a day of the month, in a write = its next occurrence, today included";
pub const RULE_OVERDUE: &str = "\"overdue\" = up to yesterday";

const fn row(
    phrase: &'static str,
    today: &'static str,
    expr: &'static str,
    echo: &'static str,
) -> Phrase {
    Phrase {
        phrase,
        today,
        row: None,
        expr,
        echo,
        rule: None,
    }
}

const fn ruled(
    phrase: &'static str,
    today: &'static str,
    expr: &'static str,
    echo: &'static str,
    rule: &'static str,
) -> Phrase {
    Phrase {
        phrase,
        today,
        row: None,
        expr,
        echo,
        rule: Some(rule),
    }
}

const fn anchored(
    phrase: &'static str,
    at: &'static str,
    expr: &'static str,
    echo: &'static str,
) -> Phrase {
    Phrase {
        phrase,
        today: "2026-09-30",
        row: Some(at),
        expr,
        echo,
        rule: None,
    }
}

const W: &str = "2026-09-30"; // a Wednesday
const SUN: &str = "2026-09-27";
const JAN: &str = "2027-01-19"; // a Tuesday
const R: &str = "2026-06-19T09:00"; // a Friday, 09:00

pub const PHRASES: &[Phrase] = &[
    row("today", W, r#"{"unit":"day","rel":0}"#, "Wed 2026-09-30"),
    row("tomorrow", W, r#"{"unit":"day","rel":1}"#, "Thu 2026-10-01"),
    row(
        "yesterday",
        W,
        r#"{"unit":"day","rel":-1}"#,
        "Tue 2026-09-29",
    ),
    row(
        "the day after tomorrow",
        W,
        r#"{"unit":"day","rel":2}"#,
        "Fri 2026-10-02",
    ),
    row(
        "the day before yesterday",
        W,
        r#"{"unit":"day","rel":-2}"#,
        "Mon 2026-09-28",
    ),
    row(
        "three days ago",
        W,
        r#"{"unit":"day","rel":-3}"#,
        "Sun 2026-09-27",
    ),
    row(
        "in three days",
        W,
        r#"{"unit":"day","rel":3}"#,
        "Sat 2026-10-03",
    ),
    row(
        "a week ago",
        W,
        r#"{"unit":"day","rel":-7}"#,
        "Wed 2026-09-23",
    ),
    row(
        "in a week",
        W,
        r#"{"unit":"day","rel":7}"#,
        "Wed 2026-10-07",
    ),
    row(
        "two weeks ago",
        W,
        r#"{"unit":"day","rel":-14}"#,
        "Wed 2026-09-16",
    ),
    row(
        "this week",
        W,
        r#"{"unit":"week","rel":0}"#,
        "2026-09-28..2026-10-04",
    ),
    row(
        "next week",
        W,
        r#"{"unit":"week","rel":1}"#,
        "2026-10-05..2026-10-11",
    ),
    row(
        "last week",
        W,
        r#"{"unit":"week","rel":-1}"#,
        "2026-09-21..2026-09-27",
    ),
    row(
        "the week after next",
        W,
        r#"{"unit":"week","rel":2}"#,
        "2026-10-12..2026-10-18",
    ),
    row(
        "this week",
        SUN,
        r#"{"unit":"week","rel":0}"#,
        "2026-09-21..2026-09-27",
    ),
    row(
        "this month",
        W,
        r#"{"unit":"month","rel":0}"#,
        "2026-09-01..2026-09-30",
    ),
    row(
        "next month",
        W,
        r#"{"unit":"month","rel":1}"#,
        "2026-10-01..2026-10-31",
    ),
    row(
        "last month",
        W,
        r#"{"unit":"month","rel":-1}"#,
        "2026-08-01..2026-08-31",
    ),
    row(
        "last month",
        JAN,
        r#"{"unit":"month","rel":-1}"#,
        "2026-12-01..2026-12-31",
    ),
    row(
        "this year",
        W,
        r#"{"unit":"year","rel":0}"#,
        "2026-01-01..2026-12-31",
    ),
    row(
        "last year",
        W,
        r#"{"unit":"year","rel":-1}"#,
        "2025-01-01..2025-12-31",
    ),
    row(
        "next year",
        W,
        r#"{"unit":"year","rel":1}"#,
        "2027-01-01..2027-12-31",
    ),
    ruled(
        "last november",
        JAN,
        r#"{"unit":"month","name":11,"rel":-1}"#,
        "2026-11-01..2026-11-30",
        RULE_LAST_MONTH,
    ),
    ruled(
        "last november",
        "2026-11-10",
        r#"{"unit":"month","name":11,"rel":-1}"#,
        "2025-11-01..2025-11-30",
        RULE_LAST_MONTH,
    ),
    ruled(
        "last september",
        W,
        r#"{"unit":"month","name":9,"rel":-1}"#,
        "2025-09-01..2025-09-30",
        RULE_LAST_MONTH,
    ),
    ruled(
        "last june",
        W,
        r#"{"unit":"month","name":6,"rel":-1}"#,
        "2026-06-01..2026-06-30",
        RULE_LAST_MONTH,
    ),
    ruled(
        "last december",
        JAN,
        r#"{"unit":"month","name":12,"rel":-1}"#,
        "2026-12-01..2026-12-31",
        RULE_LAST_MONTH,
    ),
    row(
        "this november",
        W,
        r#"{"unit":"month","name":11,"rel":0}"#,
        "2026-11-01..2026-11-30",
    ),
    ruled(
        "next march",
        W,
        r#"{"unit":"month","name":3,"rel":1}"#,
        "2027-03-01..2027-03-31",
        RULE_NEXT_MONTH,
    ),
    ruled(
        "next october",
        W,
        r#"{"unit":"month","name":10,"rel":1}"#,
        "2026-10-01..2026-10-31",
        RULE_NEXT_MONTH,
    ),
    ruled(
        "next september",
        W,
        r#"{"unit":"month","name":9,"rel":1}"#,
        "2027-09-01..2027-09-30",
        RULE_NEXT_MONTH,
    ),
    row(
        "the november before last",
        JAN,
        r#"{"unit":"month","name":11,"rel":-2}"#,
        "2025-11-01..2025-11-30",
    ),
    ruled(
        "next monday",
        W,
        r#"{"unit":"week","rel":1,"weekday":1}"#,
        "Mon 2026-10-05",
        RULE_NEXT_WEEKDAY,
    ),
    ruled(
        "next monday",
        SUN,
        r#"{"unit":"week","rel":1,"weekday":1}"#,
        "Mon 2026-09-28",
        RULE_NEXT_WEEKDAY,
    ),
    ruled(
        "next monday at 2",
        W,
        r#"{"unit":"week","rel":1,"weekday":1,"time":"14:00"}"#,
        "Mon 2026-10-05 14:00",
        RULE_AT_HOUR,
    ),
    ruled(
        "next friday",
        W,
        r#"{"unit":"week","rel":1,"weekday":5}"#,
        "Fri 2026-10-09",
        RULE_NEXT_WEEKDAY,
    ),
    row(
        "this friday",
        W,
        r#"{"unit":"week","rel":0,"weekday":5}"#,
        "Fri 2026-10-02",
    ),
    row(
        "last friday",
        W,
        r#"{"unit":"week","rel":-1,"weekday":5}"#,
        "Fri 2026-09-25",
    ),
    row(
        "last monday",
        W,
        r#"{"unit":"week","rel":-1,"weekday":1}"#,
        "Mon 2026-09-21",
    ),
    ruled(
        "monday",
        W,
        r#"{"unit":"week","rel":1,"weekday":1}"#,
        "Mon 2026-10-05",
        RULE_BARE_WEEKDAY,
    ),
    ruled(
        "friday",
        W,
        r#"{"unit":"week","rel":0,"weekday":5}"#,
        "Fri 2026-10-02",
        RULE_BARE_WEEKDAY,
    ),
    ruled(
        "wednesday",
        W,
        r#"{"unit":"week","rel":0,"weekday":3}"#,
        "Wed 2026-09-30",
        RULE_BARE_WEEKDAY,
    ),
    ruled(
        "saturday at 10",
        W,
        r#"{"unit":"week","rel":0,"weekday":6,"time":"10:00"}"#,
        "Sat 2026-10-03 10:00",
        RULE_AT_HOUR,
    ),
    ruled(
        "friday at 9:30",
        W,
        r#"{"unit":"week","rel":0,"weekday":5,"time":"09:30"}"#,
        "Fri 2026-10-02 09:30",
        RULE_BARE_WEEKDAY,
    ),
    ruled(
        "this weekend",
        W,
        r#"{"from":{"unit":"week","rel":0,"weekday":6},"to":{"unit":"week","rel":0,"weekday":7}}"#,
        "2026-10-03..2026-10-04",
        RULE_WEEKEND,
    ),
    ruled(
        "this weekend",
        "2026-10-03",
        r#"{"from":{"unit":"week","rel":0,"weekday":6},"to":{"unit":"week","rel":0,"weekday":7}}"#,
        "2026-10-03..2026-10-04",
        RULE_WEEKEND,
    ),
    ruled(
        "this weekend",
        "2026-10-04",
        r#"{"from":{"unit":"week","rel":0,"weekday":6},"to":{"unit":"week","rel":0,"weekday":7}}"#,
        "2026-10-03..2026-10-04",
        RULE_WEEKEND,
    ),
    row(
        "next weekend",
        W,
        r#"{"from":{"unit":"week","rel":1,"weekday":6},"to":{"unit":"week","rel":1,"weekday":7}}"#,
        "2026-10-10..2026-10-11",
    ),
    row(
        "last weekend",
        W,
        r#"{"from":{"unit":"week","rel":-1,"weekday":6},"to":{"unit":"week","rel":-1,"weekday":7}}"#,
        "2026-09-26..2026-09-27",
    ),
    row(
        "tomorrow at 9",
        W,
        r#"{"unit":"day","rel":1,"time":"09:00"}"#,
        "Thu 2026-10-01 09:00",
    ),
    ruled(
        "tomorrow at 3",
        W,
        r#"{"unit":"day","rel":1,"time":"15:00"}"#,
        "Thu 2026-10-01 15:00",
        RULE_AT_HOUR,
    ),
    row(
        "tomorrow at 3pm",
        W,
        r#"{"unit":"day","rel":1,"time":"15:00"}"#,
        "Thu 2026-10-01 15:00",
    ),
    row(
        "today at noon",
        W,
        r#"{"unit":"day","rel":0,"time":"12:00"}"#,
        "Wed 2026-09-30 12:00",
    ),
    row(
        "tonight at 8",
        W,
        r#"{"unit":"day","rel":0,"time":"20:00"}"#,
        "Wed 2026-09-30 20:00",
    ),
    ruled(
        "at 7 tomorrow",
        W,
        r#"{"unit":"day","rel":1,"time":"19:00"}"#,
        "Thu 2026-10-01 19:00",
        RULE_AT_HOUR,
    ),
    ruled(
        "tomorrow at 8",
        W,
        r#"{"unit":"day","rel":1,"time":"08:00"}"#,
        "Thu 2026-10-01 08:00",
        RULE_AT_HOUR,
    ),
    row(
        "in two hours",
        "2026-09-30T10:00",
        r#"{"unit":"hour","rel":2}"#,
        "Wed 2026-09-30 12:00",
    ),
    row(
        "an hour ago",
        "2026-09-30T10:00",
        r#"{"unit":"hour","rel":-1}"#,
        "Wed 2026-09-30 09:00",
    ),
    row(
        "in 30 minutes",
        "2026-09-30T10:00",
        r#"{"unit":"minute","rel":30}"#,
        "Wed 2026-09-30 10:30",
    ),
    anchored(
        "an hour earlier",
        R,
        r#"{"unit":"hour","rel":-1,"anchor":"row"}"#,
        "Fri 2026-06-19 08:00",
    ),
    anchored(
        "an hour later",
        R,
        r#"{"unit":"hour","rel":1,"anchor":"row"}"#,
        "Fri 2026-06-19 10:00",
    ),
    anchored(
        "half an hour later",
        R,
        r#"{"unit":"minute","rel":30,"anchor":"row"}"#,
        "Fri 2026-06-19 09:30",
    ),
    anchored(
        "a day later",
        R,
        r#"{"unit":"day","rel":1,"anchor":"row"}"#,
        "Sat 2026-06-20 09:00",
    ),
    anchored(
        "two days earlier",
        R,
        r#"{"unit":"day","rel":-2,"anchor":"row"}"#,
        "Wed 2026-06-17 09:00",
    ),
    anchored(
        "a week later",
        R,
        r#"{"unit":"week","rel":1,"anchor":"row"}"#,
        "Fri 2026-06-26 09:00",
    ),
    anchored(
        "the next day at 10",
        R,
        r#"{"unit":"day","rel":1,"anchor":"row","time":"10:00"}"#,
        "Sat 2026-06-20 10:00",
    ),
    anchored(
        "a month later",
        "2026-06-19",
        r#"{"unit":"month","rel":1,"anchor":"row"}"#,
        "Sun 2026-07-19",
    ),
    row(
        "on 2026-10-14",
        W,
        r#"{"date":"2026-10-14"}"#,
        "Wed 2026-10-14",
    ),
    row(
        "october 14 at 9:30",
        W,
        r#"{"date":"2026-10-14","time":"09:30"}"#,
        "Wed 2026-10-14 09:30",
    ),
    row(
        "on the 30th",
        SUN,
        r#"{"date":"2026-09-30"}"#,
        "Wed 2026-09-30",
    ),
    ruled(
        "since last june",
        W,
        r#"{"from":{"unit":"month","name":6,"rel":-1},"to":{"unit":"day","rel":0}}"#,
        "2026-06-01..2026-09-30",
        RULE_LAST_MONTH,
    ),
    ruled(
        "the last 7 days",
        W,
        r#"{"from":{"unit":"day","rel":-6},"to":{"unit":"day","rel":0}}"#,
        "2026-09-24..2026-09-30",
        RULE_LAST_N_DAYS,
    ),
    row(
        "from monday to wednesday next week",
        W,
        r#"{"from":{"unit":"week","rel":1,"weekday":1},"to":{"unit":"week","rel":1,"weekday":3}}"#,
        "2026-10-05..2026-10-07",
    ),
    ruled(
        "between now and friday",
        W,
        r#"{"from":{"unit":"day","rel":0},"to":{"unit":"week","rel":0,"weekday":5}}"#,
        "2026-09-30..2026-10-02",
        RULE_BARE_WEEKDAY,
    ),
    row(
        "in two weeks",
        W,
        r#"{"unit":"day","rel":14}"#,
        "Wed 2026-10-14",
    ),
    row(
        "two days from now",
        W,
        r#"{"unit":"day","rel":2}"#,
        "Fri 2026-10-02",
    ),
    row(
        "last night",
        W,
        r#"{"unit":"day","rel":-1}"#,
        "Tue 2026-09-29",
    ),
    row(
        "two months ago",
        W,
        r#"{"unit":"month","rel":-2}"#,
        "2026-07-01..2026-07-31",
    ),
    ruled(
        "friday week",
        W,
        r#"{"unit":"week","rel":2,"weekday":5}"#,
        "Fri 2026-10-16",
        RULE_WEEKDAY_WEEK,
    ),
    row(
        "thursday next week",
        W,
        r#"{"unit":"week","rel":1,"weekday":4}"#,
        "Thu 2026-10-08",
    ),
    row(
        "monday two weeks back",
        W,
        r#"{"unit":"week","rel":-2,"weekday":1}"#,
        "Mon 2026-09-14",
    ),
    ruled(
        "the weekend",
        W,
        r#"{"from":{"unit":"week","rel":0,"weekday":6},"to":{"unit":"week","rel":0,"weekday":7}}"#,
        "2026-10-03..2026-10-04",
        RULE_WEEKEND,
    ),
    ruled(
        "end of the month",
        W,
        r#"{"date":"2026-09-30"}"#,
        "Wed 2026-09-30",
        RULE_END_OF,
    ),
    ruled(
        "end of march",
        W,
        r#"{"date":"2027-03-31"}"#,
        "Wed 2027-03-31",
        RULE_END_OF,
    ),
    ruled(
        "dec 11",
        W,
        r#"{"date":"2026-12-11"}"#,
        "Fri 2026-12-11",
        RULE_MONTH_DAY,
    ),
    ruled(
        "sept first",
        W,
        r#"{"date":"2027-09-01"}"#,
        "Wed 2027-09-01",
        RULE_MONTH_DAY,
    ),
    ruled(
        "the 25th",
        W,
        r#"{"date":"2026-10-25"}"#,
        "Sun 2026-10-25",
        RULE_MONTH_DAY,
    ),
    ruled(
        "overdue",
        W,
        r#"{"to":{"unit":"day","rel":-1}}"#,
        "..2026-09-29",
        RULE_OVERDUE,
    ),
];

// ===========================================================================
// THE DATES LINE (SPEC §6.1)
// ===========================================================================
//
// Every user turn's prompt block may carry one `dates:` line: each date or
// time phrase of the message that can be resolved, with its resolution, so
// the model copies a date instead of computing it. A phrase is read into the
// structured expression the model would write for it (the table above and
// SPEC §4.4, §14.1) and the expression goes through `dates::evaluate`, so a
// line never contradicts what the evaluator computes from the expression.
//
// A phrase with two honest readings prints both. A weekday or a day of the
// month that has gone by this week or month, and a month or a month and day
// without a year, read `(past)` and `(upcoming)`: whether a person looks
// back or ahead is the model's judgment (SPEC §14.1 "in a read the model's
// month stands"). A bare 8 reads `08:00 (am) / 20:00 (pm)`: the one hour the
// training data splits on (SPEC §14, "at N"). Phrases that need the row they
// move (an hour earlier, the same day) or the conversation (the week after,
// that friday) are not listed.

/// Phrases one `dates:` line lists at most.
pub const DATES_CAP: usize = 6;

/// One date or time phrase of a message and what it resolves to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reading {
    /// The words as the message wrote them, lower-cased.
    pub phrase: String,
    /// What follows ` = ` in the line: `2026-10-06`, `21:00`,
    /// `2026-09-21..2026-09-27`, `2026-09-01 (past) / 2027-09-01 (upcoming)`.
    pub resolution: String,
}

/// A grounded event a "before X" or "until X" can anchor on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RowDate {
    /// How the line names the row: `#30 event "Flight to Berlin"`.
    pub label: String,
    /// The words of the row's name, lower-cased.
    pub words: Vec<String>,
    pub date: Date,
}

/// What the conversation adds to the line (`Session::dates_context`): the phrases that need it
/// ("that day", "the day before that", "before berlin") are listed only when it holds what they
/// point at.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Context {
    /// The most recent date the conversation resolved, and where it came from
    /// (`the eighth, turn 2`).
    pub that_day: Option<(Date, String)>,
    /// The events the message grounded or the focus line shows.
    pub rows: Vec<RowDate>,
}

/// Every date or time phrase of `message` the runtime can resolve against
/// `now`, in the order the message says them (at most `DATES_CAP`), from the
/// message alone.
#[must_use]
pub fn read_dates(message: &str, now: DateTime) -> Vec<Reading> {
    read_dates_in(message, now, &Context::default())
}

/// `read_dates` with what the conversation adds.
#[must_use]
pub fn read_dates_in(message: &str, now: DateTime, context: &Context) -> Vec<Reading> {
    Reader::new(message, now, context).read()
}

/// The `dates:` line of a user turn's block, or `None` when the message holds
/// no phrase to resolve: `dates: next tuesday = 2026-10-06 · 9pm = 21:00`.
#[must_use]
pub fn dates_line(message: &str, now: DateTime) -> Option<String> {
    line_of(read_dates(message, now))
}

/// `dates_line` with what the conversation adds.
#[must_use]
pub fn dates_line_in(message: &str, now: DateTime, context: &Context) -> Option<String> {
    line_of(read_dates_in(message, now, context))
}

fn line_of(readings: Vec<Reading>) -> Option<String> {
    if readings.is_empty() {
        return None;
    }
    let parts: Vec<String> = readings
        .iter()
        .map(|reading| format!("{} = {}", reading.phrase, reading.resolution))
        .collect();
    Some(format!("dates: {}", parts.join(" · ")))
}

// ---------------------------------------------------------------------------
// The retraction: a message that withdraws the request.
// ---------------------------------------------------------------------------

/// The phrases that withdraw a request, as folded words (apostrophes dropped,
/// so "don't bother" is `dont bother`). A phrase counts only as the last
/// clause of a message (`is_retraction`).
pub const RETRACTIONS: [&str; 19] = [
    "never mind",
    "nevermind",
    "nvm",
    "forget it",
    "forget that",
    "forget about it",
    "forget about that",
    "kidding",
    "jk",
    "skip it",
    "skip that",
    "scratch that",
    "scratch it",
    "leave it",
    "leave that",
    "drop it",
    "drop that",
    "dont bother",
    "do not bother",
];

/// Words that may come before a retraction phrase without changing what it
/// says: the hedge of a person taking a request back ("actually no, forget it",
/// "no wait, never mind", "I'm just kidding").
const RETRACTION_LEAD: [&str; 29] = [
    "actually", "no", "nope", "nah", "wait", "oh", "oops", "ok", "okay", "hmm", "um", "uh", "well",
    "sorry", "please", "just", "lets", "let", "its", "it", "you", "can", "i", "im", "ill", "said",
    "yeah", "so", "hey",
];

/// Words that may follow one ("never mind, thanks", "forget it for now").
const RETRACTION_TAIL: [&str; 25] = [
    "thanks", "thank", "you", "thx", "ty", "lol", "haha", "anyway", "anyways", "now", "then",
    "please", "sorry", "though", "mate", "ok", "okay", "all", "good", "that", "it", "about",
    "already", "alone", "for",
];

/// A shrug that gives up on a question just asked ("oh he's already gone?
/// fine"): a retraction only as the sentence after a question, since a bare
/// "fine" answers a yes-or-no.
const RESIGNATIONS: [&str; 5] = ["fine", "fine then", "ok fine", "okay fine", "oh well"];

/// Whether `message` ends by taking the request back, so the turn is over
/// before any call (`Session::user`: `decline never_mind`).
///
/// THE BOUNDARY: the retraction must be the message's last clause. The last
/// sentence (after the final `.`, `!`, `?` or line break) is a hedge, one
/// phrase of `RETRACTIONS`, then at most a thanks; nothing else. So
/// "actually no, forget it" and "what's on friday? never mind" end the turn,
/// while a message that retracts and then asks or orders something else
/// ("skip it, what's on friday", "never mind. what's on friday?", "forget it,
/// add milk") does not, and neither does a phrase inside a longer thought
/// ("don't forget it", "leave it open", "fine, leave him").
#[must_use]
pub fn is_retraction(message: &str) -> bool {
    let mut sentences: Vec<(Vec<String>, bool)> = Vec::new();
    let mut words: Vec<String> = Vec::new();
    let mut word = String::new();
    let mut close = |words: &mut Vec<String>, word: &mut String, question: bool| {
        if !word.is_empty() {
            words.push(std::mem::take(word));
        }
        if !words.is_empty() {
            sentences.push((std::mem::take(words), question));
        }
    };
    for char in message.to_lowercase().chars() {
        match char {
            '\'' | '\u{2019}' | '\u{2018}' | '`' => {}
            '.' | '!' | '\n' | '\u{2026}' => close(&mut words, &mut word, false),
            '?' => close(&mut words, &mut word, true),
            char if char.is_alphanumeric() => word.push(char),
            _ => {
                if !word.is_empty() {
                    words.push(std::mem::take(&mut word));
                }
            }
        }
    }
    close(&mut words, &mut word, false);
    let Some((last, _)) = sentences.last() else {
        return false;
    };
    let last: Vec<&str> = last.iter().map(String::as_str).collect();
    let asked_before = sentences.len() > 1 && sentences[sentences.len() - 2].1;
    if asked_before
        && RESIGNATIONS
            .iter()
            .any(|shrug| shrug.split(' ').eq(last.iter().copied()))
    {
        return true;
    }
    RETRACTIONS.iter().any(|phrase| {
        let phrase: Vec<&str> = phrase.split(' ').collect();
        last.windows(phrase.len()).enumerate().any(|(at, window)| {
            window == phrase.as_slice()
                && last[..at].iter().all(|word| RETRACTION_LEAD.contains(word))
                && last[at + phrase.len()..]
                    .iter()
                    .all(|word| RETRACTION_TAIL.contains(word))
        })
    })
}

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
/// Short spellings that are also words: a weekday only after one of
/// `BEFORE_SHORT_WEEKDAY` ("next sat", "on sun", "fri and sun").
const SHORT_WEEKDAYS: [&str; 4] = ["mon", "wed", "sat", "sun"];
const BEFORE_SHORT_WEEKDAY: [&str; 15] = [
    "next", "this", "last", "on", "to", "by", "till", "til", "until", "from", "since", "and", "or",
    "through", "thru",
];
/// Words that join two weekdays of one week ("monday to wednesday next week").
const JOINS: [&str; 7] = ["to", "through", "thru", "till", "until", "and", "or"];

const MONTHS: [(&str, i8); 23] = [
    ("january", 1),
    ("jan", 1),
    ("february", 2),
    ("feb", 2),
    ("march", 3),
    ("april", 4),
    ("apr", 4),
    ("may", 5),
    ("june", 6),
    ("jun", 6),
    ("july", 7),
    ("jul", 7),
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
];
/// Month names that are also first names or words: a bare one is a month only
/// after one of `BEFORE_MONTH`.
const MONTH_WORDS: [&str; 5] = ["may", "april", "june", "august", "jan"];
const BEFORE_MONTH: [&str; 18] = [
    "in", "from", "since", "until", "till", "til", "through", "thru", "before", "after", "during",
    "by", "of", "early", "late", "mid", "between", "than",
];
/// Whether a month name is a month where it stands (nt12 B1): the unambiguous ones always, the
/// ones that are also names (`MONTH_WORDS`) only after a word that says so ("in june", "from
/// march to may"). `before` is the word before it; `month_before` whether a month was named
/// earlier in the message. The Reader and the date repair (`ground::said`) read months by it.
#[must_use]
pub(crate) fn month_is_here(word: &str, before: &str, month_before: bool) -> bool {
    !MONTH_WORDS.contains(&word)
        || BEFORE_MONTH.contains(&before)
        || (JOINS.contains(&before) && month_before)
}

/// What may stand before a bare year ("in 2024", "since 2023").
const BEFORE_YEAR: [&str; 16] = [
    "in",
    "from",
    "since",
    "until",
    "till",
    "til",
    "before",
    "after",
    "during",
    "by",
    "of",
    "through",
    "for",
    "throughout",
    "year",
    "to",
];

/// Words that make the message speak of an evening ("dinner at 8" is 20:00)
/// or a morning (SPEC §14: the message or the target row decides first).
const EVENING: [&str; 8] = [
    "tonight",
    "dinner",
    "drinks",
    "party",
    "movie",
    "evening",
    "supper",
    "afternoon",
];
const MORNING: [&str; 2] = ["breakfast", "morning"];

/// Words that lead a bare hour in the talk of a day part ("the morning, say 9", "evening
/// around 8"): a time only when the message holds a word that says a part of the day.
const HOUR_LEADS: [&str; 4] = ["say", "around", "maybe", "about"];

/// What a bare number after "at" is a count of, not an hour.
const UNITS: [&str; 55] = [
    "people",
    "persons",
    "person",
    "guests",
    "minutes",
    "minute",
    "mins",
    "min",
    "hours",
    "hour",
    "hrs",
    "hr",
    "days",
    "day",
    "weeks",
    "week",
    "months",
    "month",
    "years",
    "year",
    "times",
    "time",
    "items",
    "item",
    "tasks",
    "task",
    "events",
    "event",
    "notes",
    "note",
    "photos",
    "photo",
    "docs",
    "doc",
    "documents",
    "lists",
    "list",
    "places",
    "locations",
    "seats",
    "tickets",
    "copies",
    "cards",
    "rows",
    "degrees",
    "kids",
    "percent",
    "of",
    "them",
    "those",
    "these",
    "it",
    "past",
    "point",
    "stage",
];
/// What may follow a bare hour after "to", "till", "until", "by" or "make it".
const AFTER_HOUR: [&str; 30] = [
    "on", "at", "in", "this", "tomorrow", "today", "tonight", "then", "instead", "and", "so",
    "too", "as", "now", "or", "up", "from", "about", "for", "with", "please", "pls", "because",
    "since", "but", "if", "same", "sharp", "ish", "though",
];
/// What may follow a day of the month that could also be a position ("the
/// second one", "the third meeting" are picks; "the fifth altogether", "on the
/// third at 6" are dates): a word that is not a noun it counts.
const AFTER_DAY: [&str; 59] = [
    "at",
    "and",
    "to",
    "from",
    "through",
    "thru",
    "till",
    "until",
    "instead",
    "then",
    "please",
    "pls",
    "or",
    "so",
    "but",
    "though",
    "because",
    "if",
    "noon",
    "midday",
    "morning",
    "afternoon",
    "evening",
    "night",
    "lunchtime",
    "altogether",
    "except",
    "out",
    "look",
    "looks",
    "is",
    "are",
    "was",
    "be",
    "that",
    "which",
    "now",
    "too",
    "also",
    "only",
    "just",
    "yet",
    "still",
    "same",
    "with",
    "up",
    "off",
    "works",
    "work",
    "free",
    "good",
    "fine",
    "ok",
    "okay",
    "again",
    "available",
    "busy",
    "would",
    "will",
];

/// A small day number after one of these is a date even when a word follows that is no listed
/// continuation (`remind me on the 2nd about rent`, `by the 3rd for lunch`; nt15 R3a): it is only
/// a position (`on the second one`) when the next word is a noun it counts.
const DAY_LEAD: [&str; 10] = [
    "on", "by", "before", "until", "till", "due", "for", "from", "since", "around",
];
/// The nouns a small ordinal counts (`the 3rd meeting`, `the second one`): after a `DAY_LEAD` word
/// they still make it a position, and so does any kind of the vault.
const COUNTED: [&str; 18] = [
    "one",
    "ones",
    "thing",
    "things",
    "item",
    "items",
    "row",
    "rows",
    "result",
    "results",
    "option",
    "options",
    "meeting",
    "meetings",
    "appointment",
    "appointments",
    "visit",
    "class",
];

/// What may follow a day of the month that could also be a position, when the word before it
/// says a date (nt15 R3a): not a noun the ordinal counts.
fn counted_noun(word: &str) -> bool {
    COUNTED.contains(&word) || crate::meta::Kind::parse(word).is_some()
}

fn qualifier(word: &str) -> Option<i64> {
    match word {
        "this" => Some(0),
        "next" => Some(1),
        "last" => Some(-1),
        _ => None,
    }
}

fn month_of(word: &str) -> Option<i8> {
    MONTHS
        .iter()
        .find(|(name, _)| *name == word)
        .map(|(_, month)| *month)
}

fn word_ordinal(word: &str) -> Option<i8> {
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
    if let Some(at) = UNITS.iter().position(|unit| *unit == word) {
        return i8::try_from(at + 1).ok();
    }
    match word {
        "twentieth" => Some(20),
        "thirtieth" => Some(30),
        _ => None,
    }
}

fn numeric_ordinal(word: &str) -> Option<i8> {
    let digits = word
        .strip_suffix("st")
        .or_else(|| word.strip_suffix("nd"))
        .or_else(|| word.strip_suffix("rd"))
        .or_else(|| word.strip_suffix("th"))?;
    let day: i8 = digits.parse().ok()?;
    (1..=31).contains(&day).then_some(day)
}

/// A count: digits or a number word; "a" and "an" are one.
fn count(word: &str) -> Option<i64> {
    let named = [
        "one",
        "two",
        "three",
        "four",
        "five",
        "six",
        "seven",
        "eight",
        "nine",
        "ten",
        "eleven",
        "twelve",
        "thirteen",
        "fourteen",
        "fifteen",
        "sixteen",
        "seventeen",
        "eighteen",
        "nineteen",
        "twenty",
    ];
    if matches!(word, "a" | "an") {
        return Some(1);
    }
    if let Some(at) = named.iter().position(|name| *name == word) {
        return i64::try_from(at + 1).ok();
    }
    (word.len() <= 3 && !word.is_empty() && word.chars().all(|c| c.is_ascii_digit()))
        .then(|| word.parse().ok())
        .flatten()
        .filter(|n| *n >= 1)
}

#[derive(Clone, Copy)]
enum Step {
    Minute,
    Hour,
    Day,
    Week,
}

fn step_of(word: &str) -> Option<Step> {
    Some(match word {
        "minute" | "minutes" | "min" | "mins" => Step::Minute,
        "hour" | "hours" | "hr" | "hrs" => Step::Hour,
        "day" | "days" => Step::Day,
        "week" | "weeks" => Step::Week,
        _ => return None,
    })
}

fn step_expr(step: Step, n: i64) -> Expr {
    match step {
        Step::Minute => rel_expr(Unit::Minute, n),
        Step::Hour => rel_expr(Unit::Hour, n),
        Step::Day => rel_expr(Unit::Day, n),
        Step::Week => rel_expr(Unit::Day, 7 * n),
    }
}

fn rel_expr(unit: Unit, rel: i64) -> Expr {
    Expr::Relative {
        unit,
        rel,
        name: None,
        weekday: None,
        time: None,
        row: false,
    }
}

fn week_expr(rel: i64, weekday: i8) -> Expr {
    Expr::Relative {
        unit: Unit::Week,
        rel,
        name: None,
        weekday: Some(weekday),
        time: None,
        row: false,
    }
}

fn month_expr(rel: i64, name: Option<i8>) -> Expr {
    Expr::Relative {
        unit: Unit::Month,
        rel,
        name,
        weekday: None,
        time: None,
        row: false,
    }
}

fn day_expr(date: Date) -> Expr {
    Expr::Absolute { date, time: None }
}

fn span_expr(from: Expr, to: Expr) -> Expr {
    Expr::Span(Some(Box::new(from)), Some(Box::new(to)))
}

/// The first day a resolution covers.
fn first_day(resolved: Resolved) -> Date {
    match resolved {
        Resolved::Days { from, .. } => from,
        Resolved::At(at) => at.date(),
        Resolved::Between { from, .. } => from.date(),
    }
}

/// Two readings of one phrase, or the one they share.
fn pair(past: Resolved, upcoming: Resolved) -> String {
    if past == upcoming {
        upcoming.plain()
    } else {
        format!("{} (past) / {} (upcoming)", past.plain(), upcoming.plain())
    }
}

/// THE ONE DECISION OF A BARE HOUR (SPEC §14, "at N"; nt12 B4): the 24-hour hour a clock of
/// `hour` means, and the other reading when nothing settles it, the likelier one first. A word of
/// the message that says an evening (`Some(true)`) or a morning (`Some(false)`) decides first; the
/// row's own clock decides the contested hour 8 (a row at 12:00 or later is 20:00, a row in the
/// morning 08:00); with neither, 1 to 8 is the afternoon or evening, 9 to 11 the morning, 12 is
/// noon, and the other reading stands beside it. The Reader lists it, `bare_hour` takes it for a
/// day with no time, and a reschedule that keeps the row's clock asks it too.
#[must_use]
pub fn at_hour(hour: i8, cue: Option<bool>, row_clock: Option<Time>) -> (i8, Option<i8>) {
    if !(1..=12).contains(&hour) {
        return (hour, None);
    }
    match cue {
        Some(true) if hour < 12 => return (hour + 12, None),
        Some(false) => return (hour, None),
        _ => {}
    }
    match hour {
        12 => (12, None),
        9..=11 => (hour, Some(hour + 12)),
        1..=7 => (hour + 12, Some(hour)),
        _ => match row_clock {
            Some(clock) if clock.hour() >= 12 => (hour + 12, None),
            Some(_) => (hour, None),
            None => (hour + 12, Some(hour)),
        },
    }
}

/// Both readings of a bare hour, the likelier first, each tagged: `15:00 (pm) / 03:00 (am)`.
fn both_readings(likely: i8, other: i8, minute: i8) -> Option<String> {
    let tagged = |hour: i8| {
        let tag = if hour >= 12 { "pm" } else { "am" };
        hm(hour, minute).map(|clock| format!("{clock} ({tag})"))
    };
    Some(format!("{} / {}", tagged(likely)?, tagged(other)?))
}

/// `HH:MM`, when the hour and minute are a time.
fn hm(hour: i8, minute: i8) -> Option<String> {
    Time::new(hour, minute, 0, 0).ok().map(dates::clock)
}

/// Words that say the message sets or moves something, so "sunday night" is a time.
const WRITE_WORDS: [&str; 18] = [
    "add",
    "create",
    "schedule",
    "reschedule",
    "move",
    "book",
    "set",
    "put",
    "push",
    "postpone",
    "delay",
    "change",
    "remind",
    "shift",
    "bump",
    "defer",
    "make",
    "invite",
];

/// Words of a row's name an anchor ("before the flight") does not need to say.
const ROW_FILLER: [&str; 6] = ["the", "a", "an", "to", "of", "with"];

/// What a word of the day stands for: the span it covers on a read and the time it is on a write.
#[allow(clippy::type_complexity)]
fn part_of_day(word: &str) -> Option<(((i8, i8), (i8, i8)), (i8, i8))> {
    Some(match word {
        "morning" => (((6, 0), (11, 59)), (9, 0)),
        "afternoon" => (((12, 0), (16, 59)), (15, 0)),
        "evening" => (((17, 0), (23, 59)), (18, 0)),
        "night" => (((17, 0), (23, 59)), (20, 0)),
        _ => return None,
    })
}

/// Whether a resolution is one day (or the past and upcoming days of one phrase), not a range or
/// a clock.
fn is_one_day(resolution: &str) -> bool {
    !resolution.contains("..")
        && !resolution.contains(':')
        && resolution
            .get(..10)
            .is_some_and(|day| day.parse::<Date>().is_ok())
}

/// `f` applied to each day of a resolution that is a day, or the past and upcoming days of one
/// phrase; what follows a day (` (past)`) stays.
fn map_days(resolution: &str, f: impl Fn(Date) -> Option<String>) -> Option<String> {
    let halves: Vec<String> = resolution
        .split(" / ")
        .map(|half| {
            let date: Date = half.get(..10)?.parse().ok()?;
            let rest = &half[10..];
            (rest.is_empty() || rest.starts_with(" (")).then_some(())?;
            Some(format!("{}{rest}", f(date)?))
        })
        .collect::<Option<_>>()?;
    Some(halves.join(" / "))
}

/// A word of the message with where it sits.
struct Tok {
    text: String,
    start: usize,
    end: usize,
}

/// Words of a message, lower-cased. A clock keeps its colon or point
/// (`8:15`, `9.40`), an apostrophe inside a word stays (`o'clock`), a
/// possessive is cut (`friday's`), a hyphen splits (`twenty-fifth`).
fn tokenize(message: &str) -> Vec<Tok> {
    let chars: Vec<(usize, char)> = message.char_indices().collect();
    let digit = |at: usize| chars.get(at).is_some_and(|(_, c)| c.is_ascii_digit());
    let letter = |at: usize| chars.get(at).is_some_and(|(_, c)| c.is_alphabetic());
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if !chars[i].1.is_alphanumeric() {
            i += 1;
            continue;
        }
        let start = chars[i].0;
        let mut j = i;
        while j < chars.len() {
            let c = chars[j].1;
            let joins = (matches!(c, '.' | ':') && j > i && digit(j - 1) && digit(j + 1))
                || (matches!(c, '\'' | '\u{2019}') && j > i && letter(j - 1) && letter(j + 1));
            if c.is_alphanumeric() || joins {
                j += 1;
            } else {
                break;
            }
        }
        let end = chars.get(j).map_or(message.len(), |(at, _)| *at);
        let raw = &message[start..end];
        let (body, end) = match raw.rfind(['\'', '\u{2019}']) {
            Some(at)
                if raw[at..]
                    .chars()
                    .skip(1)
                    .collect::<String>()
                    .eq_ignore_ascii_case("s") =>
            {
                (&raw[..at], start + at)
            }
            _ => (raw, end),
        };
        out.push(Tok {
            text: body.to_lowercase().replace('\u{2019}', "'"),
            start,
            end,
        });
        i = j;
    }
    out
}

/// A clock as the message writes it, before the SPEC §14 reading of a bare hour.
struct Spec {
    hour: i8,
    minute: i8,
    /// `Some(true)` for pm, `Some(false)` for am.
    pm: Option<bool>,
    /// Minutes were written (`7:30`, `9.40`).
    minutes: bool,
    /// The hour carries a leading zero (`07:30`): a 24-hour clock.
    zero: bool,
    /// The colon form: a clock on its own, where a point may be a decimal.
    colon: bool,
    /// Tokens the clock took.
    tokens: usize,
    /// The token it starts at.
    at: usize,
}

impl Spec {
    /// Whether the hour still needs the SPEC §14 reading ("at 7").
    fn bare(&self) -> bool {
        self.pm.is_none() && !(self.minutes && (self.hour >= 13 || self.zero))
    }
}

struct Reader<'a> {
    message: &'a str,
    toks: Vec<Tok>,
    now: DateTime,
    today: Date,
    /// Where the message says evening (`true`) or morning (`false`): the
    /// nearest one to a clock decides its bare hour.
    cues: Vec<(usize, bool)>,
    /// Where the phrase before the one being read ended: a clock right after
    /// a date ("friday 7 to 9") needs no word of its own.
    prev_end: std::cell::Cell<usize>,
    /// Whether the phrase before it was a single day ("sunday 11").
    prev_day: std::cell::Cell<bool>,
    /// The message sets or moves something: "sunday night" is a time, not a span to read.
    write: bool,
    /// The last day or month phrase read, and where it ended: the start of a span the next
    /// phrase may end ("from last saturday till sunday"), `SpanStart`.
    span_start: std::cell::RefCell<Option<SpanStart>>,
    context: &'a Context,
}

/// A phrase that may start a span: the tokens it took and what it resolved to. A clock right after
/// it ("from friday 5pm till sunday") moves its end and keeps its resolution.
#[derive(Clone)]
struct SpanStart {
    first: usize,
    /// The token after the phrase.
    end: usize,
    resolution: String,
}

/// The words that join the two ends of a span a bare weekday or ordinal may end ("and" and "or"
/// join two days, not a span).
const SPAN_JOINS: [&str; 6] = ["to", "till", "til", "until", "through", "thru"];

impl<'a> Reader<'a> {
    fn new(message: &'a str, now: DateTime, context: &'a Context) -> Self {
        let toks = tokenize(message);
        let mut cues = Vec::new();
        for (at, tok) in toks.iter().enumerate() {
            let word = tok.text.as_str();
            if EVENING.contains(&word) {
                cues.push((at, true));
            }
            if MORNING.contains(&word) {
                cues.push((at, false));
            }
            // last night, tomorrow night, friday night
            if word == "night"
                && at > 0
                && let before = toks[at - 1].text.as_str()
                && (matches!(before, "last" | "tomorrow" | "yesterday" | "this")
                    || WEEKDAYS.iter().any(|(name, _)| *name == before))
            {
                cues.push((at, true));
            }
        }
        let write = toks
            .iter()
            .any(|tok| WRITE_WORDS.contains(&tok.text.as_str()));
        Self {
            message,
            toks,
            now,
            today: now.date(),
            cues,
            prev_end: std::cell::Cell::new(usize::MAX),
            prev_day: std::cell::Cell::new(false),
            write,
            span_start: std::cell::RefCell::new(None),
            context,
        }
    }

    /// Whether the message makes the clock at token `at` an evening (`true`)
    /// or a morning (`false`): the nearest word that says so, `None` when
    /// none does.
    fn cue(&self, at: usize) -> Option<bool> {
        self.cues
            .iter()
            .min_by_key(|(place, evening)| (place.abs_diff(at), !evening))
            .map(|(_, evening)| *evening)
    }

    fn read(&self) -> Vec<Reading> {
        let mut out: Vec<Reading> = Vec::new();
        let mut at = 0;
        while at < self.toks.len() {
            match self.hit(at) {
                Some((len, resolution)) => {
                    let reading = Reading {
                        phrase: self.phrase(at, at + len - 1),
                        resolution,
                    };
                    self.prev_day.set(is_one_day(&reading.resolution));
                    self.note_span_start(at, at + len, &reading.resolution);
                    if !out.contains(&reading) {
                        out.push(reading);
                    }
                    at += len;
                    self.prev_end.set(at);
                }
                None => at += 1,
            }
        }
        out.truncate(DATES_CAP);
        out
    }

    /// Remember the phrase just read as the possible start of a span; a clock that follows it
    /// directly leaves it standing.
    fn note_span_start(&self, first: usize, end: usize, resolution: &str) {
        let is_date = resolution
            .get(..10)
            .is_some_and(|day| day.parse::<Date>().is_ok());
        let mut start = self.span_start.borrow_mut();
        if !is_date
            && resolution.contains(':')
            && let Some(kept) = start.as_mut()
            && first <= kept.end + 1
        {
            kept.end = end;
            return;
        }
        *start = is_date.then(|| SpanStart {
            first,
            end,
            resolution: resolution.to_owned(),
        });
    }

    /// The phrase a span ends at token `i` started with: the phrase read just before the span's
    /// join ("to", "till", "up to", ...), `None` when `i` ends no span.
    fn span_started_by(&self, i: usize) -> Option<SpanStart> {
        let join = i.checked_sub(1)?;
        if !SPAN_JOINS.contains(&self.text(join)) {
            return None;
        }
        let start = self.span_start.borrow().clone()?;
        let up_to = self.is(join, "to") && join >= 1 && self.is(join - 1, "up");
        (start.end == join || (up_to && start.end + 1 == join) || (up_to && start.end == join - 1))
            .then_some(start)
    }

    /// The first `weekday` (1 Monday .. 7 Sunday) on or after the day a span starts with, when
    /// that start is one day: the weekday that ends "from last saturday till sunday" is the
    /// Sunday after that Saturday, not the next one from today (B7). A start that is a week or a
    /// month ("from last week up to tuesday"), or that has two readings, leaves the weekday as
    /// it is read on its own.
    fn weekday_from_span_start(&self, i: usize, weekday: i8) -> Option<String> {
        let start = self.span_started_by(i)?;
        if !is_one_day(&start.resolution) || start.resolution.contains(" / ") {
            return None;
        }
        let from: Date = start.resolution.get(..10)?.parse().ok()?;
        let ahead = (i64::from(weekday) - i64::from(from.weekday().to_monday_one_offset()) + 7) % 7;
        let day = from.checked_add(ahead.days()).ok()?;
        self.one(&day_expr(day))
    }

    /// A bare ordinal that ends a span whose start names a month ("from august up to the
    /// sixth", "march the 3rd to the 9th"): that month's day, in each reading the start has
    /// (B8). The nearest past and upcoming ordinal stays the reading when no month starts the
    /// span.
    fn ordinal_in_span_month(&self, i: usize, day: i8) -> Option<String> {
        let start = self.span_started_by(i)?;
        if !(start.first..start.end).any(|at| self.month_at(at).is_some()) {
            return None;
        }
        let halves: Vec<String> = start
            .resolution
            .split(" / ")
            .map(|half| {
                let from: Date = half.get(..10)?.parse().ok()?;
                let date = Date::new(from.year(), from.month(), day).ok()?;
                let tag = half
                    .strip_suffix(')')
                    .and_then(|_| half.rfind(" ("))
                    .map_or("", |at| &half[at..]);
                Some(format!("{}{tag}", self.one(&day_expr(date))?))
            })
            .collect::<Option<_>>()?;
        Some(halves.join(" / "))
    }

    /// The phrase starting at token `i`: how many tokens it takes and what it
    /// resolves to. The most specific reading first.
    fn hit(&self, i: usize) -> Option<(usize, String)> {
        self.day_part(i)
            .or_else(|| self.day_word(i))
            .or_else(|| self.that_day(i))
            .or_else(|| self.day_offset(i))
            .or_else(|| self.offset(i))
            .or_else(|| self.overdue(i))
            .or_else(|| self.rest_of(i))
            .or_else(|| self.row_anchor(i))
            .or_else(|| self.weekday_phrase(i))
            .or_else(|| self.period(i))
            .or_else(|| self.end_of(i))
            .or_else(|| self.holiday(i))
            .or_else(|| self.date_phrase(i))
            .or_else(|| self.month_phrase(i))
            .or_else(|| self.year_phrase(i))
            .or_else(|| self.clock(i))
    }

    fn text(&self, i: usize) -> &str {
        self.toks.get(i).map_or("", |tok| tok.text.as_str())
    }

    fn is(&self, i: usize, word: &str) -> bool {
        self.text(i) == word
    }

    /// The word before token `i`, `""` at the start.
    fn before(&self, i: usize) -> &str {
        i.checked_sub(1).map_or("", |at| self.text(at))
    }

    /// Whether tokens `i..=j` run on: only blanks or hyphens between them.
    fn run(&self, i: usize, j: usize) -> bool {
        j < self.toks.len()
            && (i..j).all(|at| {
                self.message[self.toks[at].end..self.toks[at + 1].start]
                    .chars()
                    .all(|c| c.is_whitespace() || c == '-')
            })
    }

    /// The message's words from token `i` to token `j`, as written.
    fn phrase(&self, i: usize, j: usize) -> String {
        self.message[self.toks[i].start..self.toks[j].end]
            .to_lowercase()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    }

    fn eval(&self, expr: &Expr) -> Option<Resolved> {
        dates::evaluate(expr, self.now, None).ok()
    }

    fn one(&self, expr: &Expr) -> Option<String> {
        self.eval(expr).map(Resolved::plain)
    }

    fn weekday_at(&self, i: usize) -> Option<i8> {
        let word = self.text(i);
        let (_, day) = WEEKDAYS.iter().find(|(name, _)| *name == word)?;
        if SHORT_WEEKDAYS.contains(&word) && !BEFORE_SHORT_WEEKDAY.contains(&self.before(i)) {
            return None;
        }
        Some(*day)
    }

    fn month_at(&self, i: usize) -> Option<i8> {
        month_of(self.text(i))
    }

    /// A year written in full at token `i`.
    fn year_at(&self, i: usize) -> Option<i16> {
        let word = self.text(i);
        (word.len() == 4 && word.chars().all(|c| c.is_ascii_digit()))
            .then(|| word.parse::<i16>().ok())
            .flatten()
            .filter(|year| (1900..=2200).contains(year))
    }

    // -- days ---------------------------------------------------------------

    fn day_word(&self, i: usize) -> Option<(usize, String)> {
        let word = self.text(i);
        let rel = match word {
            "today" | "tonight" => Some(0),
            "tomorrow" | "tmrw" | "tmr" | "tomorow" => Some(1),
            "yesterday" => Some(-1),
            _ => None,
        };
        if let Some(rel) = rel {
            return Some((1, self.one(&rel_expr(Unit::Day, rel))?));
        }
        if self.run(i, i + 1)
            && ((word == "this" && matches!(self.text(i + 1), "morning" | "afternoon" | "evening"))
                || (word == "last" && self.is(i + 1, "night")))
        {
            let rel = if word == "last" { -1 } else { 0 };
            return Some((2, self.one(&rel_expr(Unit::Day, rel))?));
        }
        // the day after tomorrow, the day before yesterday
        let start = if word == "the" { i + 1 } else { i };
        if self.is(start, "day") && self.run(i, start + 2) {
            let rel = match (self.text(start + 1), self.text(start + 2)) {
                ("after", "tomorrow") => 2,
                ("before", "yesterday") => -2,
                _ => return None,
            };
            return Some((start + 3 - i, self.one(&rel_expr(Unit::Day, rel))?));
        }
        None
    }

    /// In two weeks, three days ago, a week from today, two months ago, the
    /// last 7 days.
    fn offset(&self, i: usize) -> Option<(usize, String)> {
        let word = self.text(i);
        if word == "in" {
            if self.is(i + 1, "half")
                && self.is(i + 2, "an")
                && matches!(self.text(i + 3), "hour" | "hr")
                && self.run(i, i + 3)
            {
                return Some((4, self.one(&step_expr(Step::Minute, 30))?));
            }
            let n = count(self.text(i + 1))?;
            let step = step_of(self.text(i + 2))?;
            return self
                .run(i, i + 2)
                .then(|| self.one(&step_expr(step, n)).map(|text| (3, text)))
                .flatten();
        }
        if let Some(n) = count(word)
            && let Some(step) = step_of(self.text(i + 1))
            && self.run(i, i + 1)
        {
            match self.text(i + 2) {
                "ago" | "back" if self.run(i, i + 2) => {
                    let day = self.one(&step_expr(step, -n))?;
                    // "two weeks ago" is that day, or the week it falls in
                    if matches!(step, Step::Week) {
                        let week = self.one(&rel_expr(Unit::Week, -n))?;
                        return Some((3, format!("{day} (day) / {week} (week)")));
                    }
                    return Some((3, day));
                }
                "from" if matches!(self.text(i + 3), "now" | "today") && self.run(i, i + 3) => {
                    return Some((4, self.one(&step_expr(step, n))?));
                }
                _ => {}
            }
        }
        // two months ago, a year ago: that whole month or year
        if let Some(n) = count(word)
            && matches!(self.text(i + 1), "month" | "months" | "year" | "years")
            && matches!(self.text(i + 2), "ago" | "back")
            && self.run(i, i + 2)
        {
            let unit = if self.text(i + 1).starts_with('m') {
                Unit::Month
            } else {
                Unit::Year
            };
            return Some((3, self.one(&rel_expr(unit, -n))?));
        }
        let start = if word == "the" { i + 1 } else { i };
        if matches!(self.text(start), "last" | "past" | "previous")
            && let Some(n) = count(self.text(start + 1))
            && (2..=366).contains(&n)
            && self.is(start + 2, "days")
            && self.run(i, start + 2)
        {
            let expr = span_expr(rel_expr(Unit::Day, 1 - n), rel_expr(Unit::Day, 0));
            return Some((start + 3 - i, self.one(&expr)?));
        }
        None
    }

    /// Overdue: up to yesterday.
    fn overdue(&self, i: usize) -> Option<(usize, String)> {
        if !self.is(i, "overdue") {
            return None;
        }
        let expr = Expr::Span(None, Some(Box::new(rel_expr(Unit::Day, -1))));
        Some((1, self.one(&expr)?))
    }

    // -- parts of a day, the rest of a period, the conversation ---------------

    /// The day a part-of-day phrase starts with ("tomorrow", "next friday", "sunday"): how many
    /// tokens it takes and what it resolves to.
    fn part_day(&self, i: usize) -> Option<(usize, String)> {
        match self.text(i) {
            "tomorrow" | "tmrw" | "tmr" | "tomorow" => {
                return Some((1, self.one(&rel_expr(Unit::Day, 1))?));
            }
            "yesterday" => return Some((1, self.one(&rel_expr(Unit::Day, -1))?)),
            _ => {}
        }
        if let Some(rel) = qualifier(self.text(i))
            && let Some(weekday) = self.weekday_at(i + 1)
            && self.run(i, i + 1)
        {
            return Some((2, self.weekday_reading(weekday, Some(rel))?));
        }
        let weekday = self.weekday_at(i)?;
        if matches!(self.before(i), "that" | "same" | "following") {
            return None;
        }
        Some((1, self.weekday_reading(weekday, None)?))
    }

    /// A bare hour led by `say`, `around`, `maybe` or `about` in a message that says a part of
    /// the day: the spec of the hour. "the morning, say 9" is 09:00 and "evening, around 8" is
    /// 20:00; with no such word, or a count of things ("say 9 people"), the number is no hour.
    fn hour_lead(&self, i: usize) -> Option<Spec> {
        if !HOUR_LEADS.contains(&self.text(i)) || self.cues.is_empty() || !self.run(i, i + 1) {
            return None;
        }
        let spec = self.spec_at(i + 1, false)?;
        (spec.bare() && !spec.minutes && !spec.colon && self.after_hour_ok("at", i + spec.tokens))
            .then_some(spec)
    }

    /// Whether the message gives a clock of its own: "at 9", "9pm", "7:30".
    fn has_clock(&self) -> bool {
        (0..self.toks.len()).any(|at| {
            (self.is(at, "at") && self.spec_at(at + 1, true).is_some())
                || self.hour_lead(at).is_some()
                || self
                    .spec_at(at, false)
                    .is_some_and(|spec| spec.pm.is_some() || spec.colon)
        })
    }

    /// "sunday night", "monday morning", "tomorrow afternoon", "next friday evening". On a read it
    /// is a span of the day (morning 06:00-11:59, afternoon 12:00-16:59, evening and night
    /// 17:00-23:59), never an instant; on a write it is the time such a word stands for
    /// (morning 09:00, afternoon 15:00, evening 18:00, night 20:00). A message with a clock of
    /// its own reads the day alone: the clock is its entry.
    fn day_part(&self, i: usize) -> Option<(usize, String)> {
        let (len, day) = self.part_day(i)?;
        let ((from, to), at) = part_of_day(self.text(i + len))?;
        if !self.run(i + len - 1, i + len) || self.has_clock() {
            return None;
        }
        let text = map_days(&day, |date| {
            if self.write {
                Some(format!("{date} {}", hm(at.0, at.1)?))
            } else {
                Some(format!(
                    "{date} {}..{date} {}",
                    hm(from.0, from.1)?,
                    hm(to.0, to.1)?
                ))
            }
        })?;
        Some((len + 1, text))
    }

    /// "that day", "the same day", "that date", and "then" as a time: how many tokens, when the
    /// words point back at the conversation (`bare_that` also takes a lone "that").
    fn context_ref(&self, i: usize, bare_that: bool) -> Option<usize> {
        match self.text(i) {
            "that" if matches!(self.text(i + 1), "day" | "date") && self.run(i, i + 1) => Some(2),
            "that"
                if bare_that
                    && self.weekday_at(i + 1).is_none()
                    && self.month_at(i + 1).is_none() =>
            {
                Some(1)
            }
            "the" if self.is(i + 1, "same") && self.is(i + 2, "day") && self.run(i, i + 2) => {
                Some(3)
            }
            "same" if self.is(i + 1, "day") && self.run(i, i + 1) => Some(2),
            // "ok make it 7 then" is "in that case", not a time
            "then"
                if matches!(
                    self.before(i),
                    "about" | "for" | "by" | "until" | "since" | "from" | "on"
                ) =>
            {
                Some(1)
            }
            _ => None,
        }
    }

    /// "that day" = the date the conversation last resolved, with where it came from.
    fn that_day(&self, i: usize) -> Option<(usize, String)> {
        let (date, label) = self.context.that_day.as_ref()?;
        let len = self.context_ref(i, false)?;
        Some((len, format!("{date} ({label})")))
    }

    /// "the day before that day", "the day after that", "3 days before friday", "a week after
    /// the 15th": the date shifted from the one it names.
    fn day_offset(&self, i: usize) -> Option<(usize, String)> {
        let mut at = i;
        if self.is(at, "the") && self.run(at, at + 1) {
            at += 1;
        }
        let n = match count(self.text(at)) {
            Some(n) => {
                at += 1;
                n
            }
            None => 1,
        };
        let (days, unit) = match self.text(at) {
            "day" => (n, "day"),
            "days" => (n, "days"),
            "week" => (7 * n, "week"),
            "weeks" => (7 * n, "weeks"),
            _ => return None,
        };
        let (sign, word) = match self.text(at + 1) {
            "before" => (-1, "before"),
            "after" => (1, "after"),
            _ => return None,
        };
        if !self.run(i, at + 1) {
            return None;
        }
        let at = at + 2;
        let shifted = |date: Date| date.checked_add((sign * days).days()).ok();
        if let Some(len) = self.context_ref(at, true) {
            let (date, label) = self.context.that_day.as_ref()?;
            let moved = shifted(*date)?;
            let how = if n == 1 && unit == "day" {
                "the day".to_owned()
            } else {
                format!("{n} {unit}")
            };
            return Some((at + len - i, format!("{moved} ({how} {word} {label})")));
        }
        let (len, resolution) = self.hit(at)?;
        let text = map_days(&resolution, |date| Some(shifted(date)?.to_string()))?;
        Some((at + len - i, text))
    }

    /// "the rest of the week" (tomorrow to Sunday; from today when the message is about today),
    /// "the rest of the month", "rest of today".
    fn rest_of(&self, i: usize) -> Option<(usize, String)> {
        let mut at = i;
        if self.is(at, "the") && self.run(at, at + 1) {
            at += 1;
        }
        if !(self.is(at, "rest") && self.is(at + 1, "of") && self.run(at, at + 1)) {
            return None;
        }
        at += 2;
        if matches!(self.text(at), "the" | "this") && self.run(at - 1, at) {
            at += 1;
        }
        let target = self.text(at);
        if !matches!(target, "week" | "month" | "today" | "day") || !self.run(at - 1, at) {
            return None;
        }
        let end = at + 1;
        let about_today = (0..self.toks.len())
            .filter(|place| !(i..end).contains(place))
            .any(|place| matches!(self.text(place), "today" | "tonight"));
        let from = |last: Date| rel_expr(Unit::Day, i64::from(!about_today && self.today < last));
        let expr = match target {
            "week" => {
                let sunday = first_day(self.eval(&week_expr(0, 7))?);
                span_expr(from(sunday), week_expr(0, 7))
            }
            "month" => {
                let last = self.today.last_of_month();
                span_expr(from(last), day_expr(last))
            }
            _ => span_expr(
                rel_expr(Unit::Hour, 0),
                Expr::Absolute {
                    date: self.today,
                    time: Some(Time::constant(23, 59, 0, 0)),
                },
            ),
        };
        Some((end - i, self.one(&expr)?))
    }

    /// "before berlin", "until the wedding", "after the flight": the day of the one grounded
    /// event the words name. Before and until end on that day, after starts on it.
    fn row_anchor(&self, i: usize) -> Option<(usize, String)> {
        let cue = self.text(i);
        if !matches!(cue, "before" | "after" | "until" | "till" | "til")
            || self.context.rows.is_empty()
        {
            return None;
        }
        let mut at = i + 1;
        while matches!(
            self.text(at),
            "the" | "my" | "our" | "that" | "this" | "his" | "her" | "their" | "a" | "an"
        ) && self.run(at - 1, at)
        {
            at += 1;
        }
        // a date of its own wins ("before friday")
        if self.hit(at).is_some() || !self.run(i, at - 1) {
            return None;
        }
        for len in (1..=3).rev() {
            if at + len > self.toks.len() || !self.run(at, at + len - 1) {
                continue;
            }
            let said: Vec<&str> = (at..at + len)
                .map(|place| self.text(place))
                .filter(|word| !ROW_FILLER.contains(word))
                .collect();
            if said.is_empty() {
                continue;
            }
            let fits: Vec<&RowDate> = self
                .context
                .rows
                .iter()
                .filter(|row| {
                    said.iter()
                        .all(|word| row.words.iter().any(|name| name == word))
                })
                .collect();
            if let [row] = fits.as_slice() {
                let range = match cue {
                    "after" => format!("{}..", row.date),
                    _ => format!("..{}", row.date),
                };
                return Some((at + len - i, format!("{range} ({})", row.label)));
            }
        }
        None
    }

    // -- weekdays -----------------------------------------------------------

    /// This week's weekday, and the next one when this week's has gone by;
    /// `rel` for "next" and "last".
    fn weekday_reading(&self, weekday: i8, rel: Option<i64>) -> Option<String> {
        match rel {
            Some(rel) if rel != 0 => self.one(&week_expr(rel, weekday)),
            _ => {
                let this = self.eval(&week_expr(0, weekday))?;
                if first_day(this) >= self.today {
                    Some(this.plain())
                } else {
                    Some(pair(this, self.eval(&week_expr(1, weekday))?))
                }
            }
        }
    }

    /// "next week", "of next week", "week" (friday week): the week a weekday
    /// is in, read at token `j`: how many tokens and the week's `rel`.
    fn week_after(&self, j: usize) -> Option<(usize, i64)> {
        let at = if self.is(j, "of") { j + 1 } else { j };
        if let Some(rel) = qualifier(self.text(at))
            && self.is(at + 1, "week")
            && self.run(j, at + 1)
        {
            return Some((at + 2 - j, rel));
        }
        (at == j && self.is(j, "week")).then_some((1, 2))
    }

    /// "monday to wednesday next week": the week the second weekday names is
    /// the first one's too.
    fn week_of_pair(&self, i: usize) -> Option<i64> {
        if !(JOINS.contains(&self.text(i + 1)) && self.run(i, i + 2)) {
            return None;
        }
        self.weekday_at(i + 2)?;
        let (_, rel) = self.week_after(i + 3).filter(|_| self.run(i + 2, i + 3))?;
        (rel != 2).then_some(rel)
    }

    fn weekday_phrase(&self, i: usize) -> Option<(usize, String)> {
        // next friday, last monday, this sunday
        if let Some(rel) = qualifier(self.text(i)) {
            let weekday = self.weekday_at(i + 1)?;
            if !self.run(i, i + 1) {
                return None;
            }
            return Some((2, self.weekday_reading(weekday, Some(rel))?));
        }
        let weekday = self.weekday_at(i)?;
        // "that friday", "the same friday": the conversation's, not a date
        if matches!(self.before(i), "that" | "same" | "following") {
            return None;
        }
        if self.run(i, i + 1) {
            // friday dec 11, thursday the twenty-sixth: the day of the month wins
            if let Some((len, resolution)) = self.date_phrase(i + 1) {
                return Some((1 + len, resolution));
            }
            // "the monday before", "friday before last": the conversation's. "on friday
            // after that" is not: the friday is a day of its own and "after that" is about
            // the action, so only "the friday after that" points back.
            if matches!(self.text(i + 1), "before" | "after")
                && (!self.run(i + 1, i + 2)
                    || matches!(self.text(i + 2), "last" | "next")
                    || (matches!(self.text(i + 2), "that" | "this") && self.before(i) == "the"))
            {
                return None;
            }
            // friday next week, wednesday of next week, friday week
            if let Some((len, rel)) = self.week_after(i + 1) {
                return Some((1 + len, self.one(&week_expr(rel, weekday))?));
            }
            // monday two weeks back
            if let Some(n) = count(self.text(i + 1))
                && self.is(i + 2, "weeks")
                && matches!(self.text(i + 3), "back" | "ago")
                && self.run(i, i + 3)
            {
                return Some((4, self.one(&week_expr(-n, weekday))?));
            }
            // monday to wednesday next week
            if let Some(rel) = self.week_of_pair(i) {
                return Some((1, self.one(&week_expr(rel, weekday))?));
            }
        }
        if let Some(reading) = self.weekday_from_span_start(i, weekday) {
            return Some((1, reading));
        }
        Some((1, self.weekday_reading(weekday, None)?))
    }

    // -- weeks, months, years ----------------------------------------------

    fn weekend(&self, rel: i64) -> Option<String> {
        self.one(&span_expr(week_expr(rel, 6), week_expr(rel, 7)))
    }

    fn period(&self, i: usize) -> Option<(usize, String)> {
        let word = self.text(i);
        if word == "the" {
            if self.is(i + 1, "weekend") && self.run(i, i + 1) {
                return Some((2, self.weekend(0)?));
            }
            if self.is(i + 1, "week") && self.run(i, i + 3) {
                match (self.text(i + 2), self.text(i + 3)) {
                    ("after", "next") => return Some((4, self.one(&rel_expr(Unit::Week, 2))?)),
                    ("before", "last") => {
                        return Some((4, self.one(&rel_expr(Unit::Week, -2))?));
                    }
                    _ => {}
                }
            }
            // the november before last, the march after next
            if let Some(month) = self.month_at(i + 1)
                && self.run(i, i + 3)
            {
                let rel = match (self.text(i + 2), self.text(i + 3)) {
                    ("before", "last") => -2,
                    ("after", "next") => 2,
                    _ => return None,
                };
                return Some((4, self.one(&month_expr(rel, Some(month)))?));
            }
            return None;
        }
        let rel = qualifier(word)?;
        if !self.run(i, i + 1) {
            return None;
        }
        match self.text(i + 1) {
            "week" => Some((2, self.one(&rel_expr(Unit::Week, rel))?)),
            "weekend" => Some((2, self.weekend(rel)?)),
            "month" => Some((2, self.one(&month_expr(rel, None))?)),
            "year" => Some((2, self.one(&rel_expr(Unit::Year, rel))?)),
            _ => None,
        }
    }

    /// The last day of a month, as a resolution.
    fn last_day(&self, expr: &Expr) -> Option<Resolved> {
        match self.eval(expr)? {
            Resolved::Days { to, .. } => Some(Resolved::Days { from: to, to }),
            _ => None,
        }
    }

    /// End of the month, end of next month, end of march.
    fn end_of(&self, i: usize) -> Option<(usize, String)> {
        if !(self.is(i, "end") && self.is(i + 1, "of") && self.run(i, i + 1)) {
            return None;
        }
        let mut at = i + 2;
        if self.is(at, "the") && self.run(i, at) {
            at += 1;
        }
        let word = self.text(at);
        // the end of the day is today, and only today
        if matches!(word, "day" | "today") && self.run(i, at) {
            return Some((at + 1 - i, self.one(&rel_expr(Unit::Day, 0))?));
        }
        if word == "month" || (qualifier(word).is_some() && self.is(at + 1, "month")) {
            let rel = qualifier(word).unwrap_or(0);
            let len = at + 1 + usize::from(word != "month") - i;
            if !self.run(i, len + i - 1) {
                return None;
            }
            return Some((len, self.last_day(&month_expr(rel, None))?.plain()));
        }
        let month = self.month_at(at)?;
        if !self.run(i, at) {
            return None;
        }
        let text = if month == self.today.month() {
            self.last_day(&month_expr(0, Some(month)))?.plain()
        } else {
            pair(
                self.last_day(&month_expr(-1, Some(month)))?,
                self.last_day(&month_expr(1, Some(month)))?,
            )
        };
        Some((at + 1 - i, text))
    }

    /// The holidays that fall on one date every year: new year's day and eve, christmas day and
    /// eve, valentine's (day), halloween. Read as the month and day they are (`dec 25`): the
    /// nearest one behind and the nearest ahead. The bare word `christmas` is no day (it names
    /// a list or an album), nor is `new year`.
    fn holiday(&self, i: usize) -> Option<(usize, String)> {
        let (len, month, day) = match (self.text(i), self.text(i + 1), self.text(i + 2)) {
            ("new", "year" | "years", "day") => (3, 1, 1),
            ("new", "year" | "years", "eve") => (3, 12, 31),
            ("christmas" | "xmas", "day", _) => (2, 12, 25),
            ("christmas" | "xmas", "eve", _) => (2, 12, 24),
            ("valentine" | "valentines", "day", _) => (2, 2, 14),
            // a person called Valentine is not the day: bare, only the possessive is
            ("valentine", _, _)
                if self.message[self.toks[i].end..].starts_with(['\'', '\u{2019}']) =>
            {
                (1, 2, 14)
            }
            ("halloween", _, _) => (1, 10, 31),
            _ => return None,
        };
        // the possessive (`new year's day`) is cut off its token: allow it between the words
        let joined = (i..i + len - 1).all(|at| {
            self.message[self.toks[at].end..self.toks[at + 1].start]
                .chars()
                .all(|c| c.is_whitespace() || matches!(c, '-' | '\'' | '\u{2019}' | 's' | 'S'))
        });
        if len > 1 && !joined {
            return None;
        }
        let (past, upcoming) = self.month_day_dates(month, day)?;
        Some((len, pair(past, upcoming)))
    }

    /// Whether the month name at token `i` is a month here: the unambiguous
    /// ones always, the ones that are also names after a word that says so
    /// ("in june", "from march to may").
    fn month_here(&self, i: usize) -> bool {
        month_is_here(
            self.text(i),
            self.before(i),
            (0..i).any(|at| self.month_at(at).is_some()),
        )
    }

    /// Last november, next march, this june; a bare month is the nearest one
    /// behind and the nearest one ahead.
    fn month_phrase(&self, i: usize) -> Option<(usize, String)> {
        if let Some(rel) = qualifier(self.text(i))
            && let Some(month) = self.month_at(i + 1)
            && self.run(i, i + 1)
            && !(rel == 0 && self.is(i + 1, "may"))
        {
            return Some((2, self.one(&month_expr(rel, Some(month)))?));
        }
        let month = self.month_at(i)?;
        // march 2027: that month of that year
        if let Some(year) = self.year_at(i + 1)
            && self.run(i, i + 1)
        {
            let first = Date::new(year, month, 1).ok()?;
            let expr = span_expr(day_expr(first), day_expr(first.last_of_month()));
            return Some((2, self.one(&expr)?));
        }
        if !self.month_here(i) {
            return None;
        }
        let text = if month == self.today.month() {
            self.one(&month_expr(0, Some(month)))?
        } else {
            pair(
                self.eval(&month_expr(-1, Some(month)))?,
                self.eval(&month_expr(1, Some(month)))?,
            )
        };
        Some((1, text))
    }

    /// In 2024, since 2023, before 2025: that whole year.
    fn year_phrase(&self, i: usize) -> Option<(usize, String)> {
        let year = self.year_at(i)?;
        if !BEFORE_YEAR.contains(&self.before(i)) {
            return None;
        }
        let first = Date::new(year, 1, 1).ok()?;
        let last = Date::new(year, 12, 31).ok()?;
        Some((1, self.one(&span_expr(day_expr(first), day_expr(last)))?))
    }

    // -- days of the month ---------------------------------------------------

    /// A day of the month at token `i`: digits, an ordinal, or a compound
    /// ordinal ("twenty fifth"); how many tokens it takes.
    fn day_at(&self, i: usize) -> Option<(i8, usize)> {
        let word = self.text(i);
        if word.len() <= 2 && !word.is_empty() && word.chars().all(|c| c.is_ascii_digit()) {
            let day: i8 = word.parse().ok()?;
            return (1..=31).contains(&day).then_some((day, 1));
        }
        self.ordinal_at(i)
    }

    /// An ordinal (`25th`, `fifth`, `twenty fifth`) at token `i`.
    fn ordinal_at(&self, i: usize) -> Option<(i8, usize)> {
        let word = self.text(i);
        if let Some(day) = numeric_ordinal(word).or_else(|| word_ordinal(word)) {
            return Some((day, 1));
        }
        let base: i8 = match word {
            "twenty" => 20,
            "thirty" => 30,
            _ => return None,
        };
        let unit = word_ordinal(self.text(i + 1)).filter(|unit| *unit < 10)?;
        (self.run(i, i + 1) && base + unit <= 31).then_some((base + unit, 2))
    }

    /// The nearest `month`/`day` at or before today and at or after it.
    fn month_day_dates(&self, month: i8, day: i8) -> Option<(Resolved, Resolved)> {
        let year = self.today.year();
        let (mut past, mut upcoming) = (None, None);
        for year in (year - 8)..=(year + 8) {
            let Ok(date) = Date::new(year, month, day) else {
                continue;
            };
            if date <= self.today {
                past = Some(date);
            }
            if date >= self.today && upcoming.is_none() {
                upcoming = Some(date);
            }
        }
        self.both(past?, upcoming?)
    }

    /// The nearest day number at or before today and at or after it.
    fn day_dates(&self, day: i8) -> Option<(Resolved, Resolved)> {
        let first = self.today.first_of_month();
        let (mut past, mut upcoming) = (None, None);
        for offset in -13_i64..=13 {
            let Ok(month) = first.checked_add(offset.months()) else {
                continue;
            };
            let Ok(date) = Date::new(month.year(), month.month(), day) else {
                continue;
            };
            if date <= self.today {
                past = Some(date);
            }
            if date >= self.today && upcoming.is_none() {
                upcoming = Some(date);
            }
        }
        self.both(past?, upcoming?)
    }

    fn both(&self, past: Date, upcoming: Date) -> Option<(Resolved, Resolved)> {
        Some((self.eval(&day_expr(past))?, self.eval(&day_expr(upcoming))?))
    }

    fn date_phrase(&self, i: usize) -> Option<(usize, String)> {
        self.shared_month(i)
            .or_else(|| self.month_day(i))
            .or_else(|| self.ordinal_day(i))
    }

    /// The text between tokens `a` and `b`.
    fn gap(&self, a: usize, b: usize) -> &str {
        self.message
            .get(self.toks[a].end..self.toks[b].start)
            .unwrap_or("")
    }

    /// TWO DAYS THAT SHARE ONE MONTH NAME (nt15 R3b): "the 21st and 22nd of august" is one span
    /// from 08-21 to 08-22, in each reading the month has (the past one, then the upcoming one),
    /// not "the 21st" of this month and "the 22nd of august" beside it. Two consecutive days
    /// joined by "and", or two days joined by "to", "till", "until", "through" or a hyphen, are
    /// the span; two days that are not (the 5th and the 20th of august: the days between are not
    /// meant) or joined by "or" are two days, the first read in the month the second names. The
    /// phrase ends at the month (and its year, when one is said).
    fn shared_month(&self, i: usize) -> Option<(usize, String)> {
        let start = if self.is(i, "the") && self.run(i, i + 1) {
            i + 1
        } else {
            i
        };
        let (first, used) = self.day_at(start)?;
        let first_end = start + used - 1;
        let join = start + used;
        // "and", "or" or a comma join; "to", "till", "until", "through" or a hyphen make a span
        let (word, mut next) = if self.toks.get(join).is_some_and(|tok| {
            matches!(tok.text.as_str(), "and" | "or") || SPAN_JOINS.contains(&tok.text.as_str())
        }) {
            (self.text(join).to_owned(), join + 1)
        } else if self.toks.get(join).is_some()
            && self.gap(join - 1, join).contains('-')
            && !self.gap(join - 1, join).contains(char::is_whitespace)
        {
            ("-".to_owned(), join)
        } else if self.toks.get(join).is_some() && self.gap(join - 1, join).trim() == "," {
            ("and".to_owned(), join)
        } else {
            return None;
        };
        if self.is(next, "the") {
            next += 1;
        }
        let (second, used) = self.day_at(next)?;
        let mut at = next + used;
        if self.is(at, "of") && self.run(at - 1, at) {
            at += 1;
        }
        let month = self.month_at(at)?;
        let after = self.text(at + 1);
        if month == 5 && self.run(at, at + 1) && !self.after_day_ok(after) {
            return None;
        }
        // a day that is a bare small number is a day only beside an ordinal ("5 and 6 may")
        let span = match word.as_str() {
            "and" => second == first + 1,
            "or" => false,
            _ => second > first,
        };
        let year = self
            .year_at(at + 1)
            .filter(|_| self.run(at, at + 1))
            .map(|year| (year, 1));
        let consumed = |through: usize| through + 1 - i;
        if !span {
            // the first day in the month the second names; the second is read on its own
            let (past, upcoming) = self.month_day_dates(month, first)?;
            return Some((consumed(first_end), pair(past, upcoming)));
        }
        let last = at + year.map_or(0, |(_, tokens)| tokens);
        let build = |year: i16| -> Option<Resolved> {
            let from = Date::new(year, month, first).ok()?;
            let to = Date::new(year, month, second).ok()?;
            self.eval(&span_expr(day_expr(from), day_expr(to)))
        };
        if let Some((year, _)) = year {
            return Some((consumed(last), build(year)?.plain()));
        }
        let (past, upcoming) = self.month_day_dates(month, first)?;
        let past = build(first_day(past).year())?;
        let upcoming = build(first_day(upcoming).year())?;
        Some((consumed(last), pair(past, upcoming)))
    }

    /// Whether a word may follow a date without being a noun it counts.
    fn after_day_ok(&self, next: &str) -> bool {
        next.is_empty()
            || AFTER_DAY.contains(&next)
            || next.starts_with(|c: char| c.is_ascii_digit())
    }

    /// Dec 11, may first, the 3rd of may, 11 dec, twenty-fifth june; with a
    /// year it is that date, without one the nearest behind and ahead.
    fn month_day(&self, i: usize) -> Option<(usize, String)> {
        // MONTH [the] DAY
        if let Some(month) = self.month_at(i) {
            let mut at = i + 1;
            if self.is(at, "the") && self.run(i, at) {
                at += 1;
            }
            if self.run(i, at)
                && let Some((day, used)) = self.day_at(at)
            {
                let last = at + used - 1;
                let next = self.text(last + 1);
                let adjacent = self.run(last, last + 1);
                if !(adjacent && (matches!(next, "am" | "pm") || UNITS.contains(&next))) {
                    return self.dated(i, last, month, day);
                }
            }
        }
        // [the] DAY [of] MONTH
        let start = if self.is(i, "the") && self.run(i, i + 1) {
            i + 1
        } else {
            i
        };
        if let Some((day, used)) = self.day_at(start) {
            let mut at = start + used;
            if self.is(at, "of") && self.run(start, at) {
                at += 1;
            }
            if let Some(month) = self.month_at(at)
                && self.run(i, at)
            {
                let next = self.text(at + 1);
                let adjacent = self.run(at, at + 1);
                let modal = month == 5 && adjacent && !self.after_day_ok(next);
                if !modal {
                    return self.dated(i, at, month, day);
                }
            }
        }
        None
    }

    /// The reading of a month and day taken from tokens `first..=last`.
    fn dated(&self, first: usize, last: usize, month: i8, day: i8) -> Option<(usize, String)> {
        if let Some(year) = self.year_at(last + 1)
            && self.run(last, last + 1)
        {
            let date = Date::new(year, month, day).ok()?;
            return Some((last + 2 - first, self.one(&day_expr(date))?));
        }
        let (past, upcoming) = self.month_day_dates(month, day)?;
        Some((last + 1 - first, pair(past, upcoming)))
    }

    /// A bare ordinal: the 25th, on the third, by the thirty-first. A small
    /// one is a date only when nothing that it counts follows it; "the second
    /// one" is a pick.
    fn ordinal_day(&self, i: usize) -> Option<(usize, String)> {
        let the = self.is(i, "the") && self.run(i, i + 1);
        let start = if the { i + 1 } else { i };
        let (day, used) = self.ordinal_at(start)?;
        let last = start + used - 1;
        let next = self.text(last + 1);
        let adjacent = self.run(last, last + 1);
        if adjacent && matches!(next, "time" | "times" | "of") {
            return None;
        }
        if day <= 12 {
            let named = the || numeric_ordinal(self.text(start)).is_some();
            // a date word before it ("on the 2nd about rent") makes it a date unless a noun it
            // counts follows
            let led = DAY_LEAD.contains(&self.before(i)) && !counted_noun(next);
            if !(named && (!adjacent || self.after_day_ok(next) || led)) {
                return None;
            }
        }
        if let Some(reading) = self.ordinal_in_span_month(i, day) {
            return Some((last + 1 - i, reading));
        }
        let (past, upcoming) = self.day_dates(day)?;
        Some((last + 1 - i, pair(past, upcoming)))
    }

    // -- clocks ---------------------------------------------------------------

    /// The 24-hour hour a clock means, and the other reading when no word settles it
    /// (`at_hour`, SPEC §14, "at N": the message decides first, then 1 to 8 is pm, 9 to 11 am).
    fn spec_hour(&self, spec: &Spec) -> Option<(i8, Option<i8>)> {
        match spec.pm {
            Some(pm) => {
                if !(1..=12).contains(&spec.hour) {
                    return None;
                }
                Some((spec.hour % 12 + if pm { 12 } else { 0 }, None))
            }
            None if !spec.bare() => (spec.hour <= 23).then_some((spec.hour, None)),
            None => {
                let hour = spec.hour;
                if !(1..=12).contains(&hour) {
                    return None;
                }
                // a morning and an afternoon cue and ONE hour between them: the hour decides
                // (1 to 7 pm, 9 to 11 am); a clock for each cue ("tonight at 8 and tomorrow
                // morning at 6") follows the nearest one
                if self.cues.iter().any(|(_, evening)| *evening)
                    && self.cues.iter().any(|(_, evening)| !*evening)
                    && (0..self.toks.len())
                        .filter(|at| self.spec_at(*at, false).is_some())
                        .count()
                        == 1
                {
                    let (pick, other) = at_hour(hour, None, None);
                    return Some((pick, other.filter(|_| hour == 8)));
                }
                // no cue: the reading the data favours first, the other beside it, so a line
                // never settles an hour the person did not
                Some(at_hour(hour, self.cue(spec.at), None))
            }
        }
    }

    /// The hour a range starts or ends at: a bare 8 is read as written ("8 till 10" is the
    /// morning), every other hour as `spec_hour` reads it.
    fn range_hour(&self, spec: &Spec) -> Option<i8> {
        let (pick, other) = self.spec_hour(spec)?;
        Some(if spec.hour == 8 && other.is_some() {
            8
        } else {
            pick
        })
    }

    /// The clock a spec reads as: `HH:MM`, or both readings of a bare hour no word settles, the
    /// likelier one first (1 to 8 pm, 9 to 11 am): `15:00 (pm) / 03:00 (am)`.
    fn spec_time(&self, spec: &Spec) -> Option<String> {
        let (hour, other) = self.spec_hour(spec)?;
        match other {
            Some(other) => Some(both_readings(hour, other, spec.minute)?),
            None => hm(hour, spec.minute),
        }
    }

    /// A clock at token `i`: `9pm`, `9:30`, `9.40`, `8 pm`, and with
    /// `words` a number word (`five`).
    fn spec_at(&self, i: usize, words: bool) -> Option<Spec> {
        let raw = self.text(i);
        let (body, mut pm) = match (raw.strip_suffix("pm"), raw.strip_suffix("am")) {
            (Some(body), _) if !body.is_empty() => (body, Some(true)),
            (_, Some(body)) if !body.is_empty() => (body, Some(false)),
            _ => (raw, None),
        };
        let digits = |text: &str| !text.is_empty() && text.chars().all(|c| c.is_ascii_digit());
        let (hour_text, minute_text) = body.split_once([':', '.']).unwrap_or((body, ""));
        let colon = body.contains(':');
        let hour: i8 = if digits(hour_text) && hour_text.len() <= 2 {
            hour_text.parse().ok()?
        } else if words
            && pm.is_none()
            && !body.contains(['.', ':'])
            && !matches!(hour_text, "a" | "an")
        {
            let word = count(hour_text).filter(|n| (1..=12).contains(n))?;
            i8::try_from(word).ok()?
        } else {
            return None;
        };
        let minute: i8 = if minute_text.is_empty() {
            0
        } else if digits(minute_text) && minute_text.len() == 2 {
            minute_text.parse().ok()?
        } else {
            return None;
        };
        if minute > 59 {
            return None;
        }
        let mut tokens = 1;
        if pm.is_none() && matches!(self.text(i + 1), "am" | "pm") && self.run(i, i + 1) {
            pm = Some(self.is(i + 1, "pm"));
            tokens = 2;
        } else if pm.is_none() && self.is(i + 1, "o'clock") && self.run(i, i + 1) {
            tokens = 2;
        }
        Some(Spec {
            hour,
            minute,
            pm,
            minutes: !minute_text.is_empty(),
            zero: hour_text.len() == 2 && hour_text.starts_with('0'),
            colon,
            tokens,
            at: i,
        })
    }

    /// Whether the word after a bare hour leaves it an hour (not "3 people").
    fn after_hour_ok(&self, trigger: &str, last: usize) -> bool {
        if !self.run(last, last + 1) {
            return true;
        }
        let next = self.text(last + 1);
        if month_of(next).is_some() {
            return false;
        }
        if trigger == "at" {
            !UNITS.contains(&next)
        } else {
            AFTER_HOUR.contains(&next) || self.weekday_at(last + 1).is_some()
        }
    }

    /// Half 5, half past 7: the half hour after.
    fn half(&self, i: usize) -> Option<(usize, String)> {
        let at = if self.is(i + 1, "past") { i + 2 } else { i + 1 };
        let mut spec = self.spec_at(at, true)?;
        if !self.run(i, at) || spec.pm.is_some() || spec.minutes {
            return None;
        }
        spec.minute = 30;
        let last = at + spec.tokens - 1;
        self.after_hour_ok("at", last)
            .then(|| self.spec_time(&spec).map(|text| (last + 1 - i, text)))
            .flatten()
    }

    /// Quarter past 4, quarter to 4.
    fn quarter(&self, i: usize) -> Option<(usize, String)> {
        let to = match self.text(i + 1) {
            "past" => false,
            "to" => true,
            _ => return None,
        };
        let spec = self.spec_at(i + 2, true)?;
        if !self.run(i, i + 2) || spec.pm.is_some() || spec.minutes {
            return None;
        }
        let last = i + 2 + spec.tokens - 1;
        if !self.after_hour_ok("at", last) {
            return None;
        }
        let (hour, other) = self.spec_hour(&spec)?;
        let at = |hour: i8| {
            if to {
                hm((hour + 23) % 24, 45)
            } else {
                hm(hour, 15)
            }
        };
        let text = match other {
            Some(other) => {
                let (am, pm) = (hour.min(other), hour.max(other));
                let (am, pm) = (format!("{} (am)", at(am)?), format!("{} (pm)", at(pm)?));
                if hour.min(other) <= 8 {
                    format!("{pm} / {am}")
                } else {
                    format!("{am} / {pm}")
                }
            }
            None => at(hour)?,
        };
        Some((last + 1 - i, text))
    }

    /// A range of hours: `7 till 10`, `12 to 1`, `9 to 5pm`. The end never
    /// comes before the start, so `7 till 10` ends at 22:00.
    fn range(&self, i: usize) -> Option<(usize, String)> {
        let start = self.spec_at(i, false)?;
        let to = i + start.tokens;
        if !(matches!(self.text(to), "to" | "till" | "until") && self.run(i, to)) {
            return None;
        }
        let end = self.spec_at(to + 1, false)?;
        if !self.run(to, to + 1) {
            return None;
        }
        // a bare hour starts a range only when the end says it is a clock, or
        // right after a date or a word that says "from"
        if start.pm.is_none()
            && !start.colon
            && end.pm.is_none()
            && !end.colon
            && !(self.prev_end.get() == i
                || matches!(self.before(i), "from" | "between" | "at" | "around"))
        {
            return None;
        }
        let last = to + end.tokens;
        if end.bare() && !self.after_hour_ok("to", last) {
            return None;
        }
        let from_hour = self.range_hour(&start)?;
        let mut to_hour = self.range_hour(&end)?;
        if end.pm.is_none() && (to_hour, end.minute) <= (from_hour, start.minute) {
            to_hour += 12;
        }
        let text = format!(
            "{}..{}",
            hm(from_hour, start.minute)?,
            hm(to_hour, end.minute)?
        );
        Some((last + 1 - i, text))
    }

    fn clock(&self, i: usize) -> Option<(usize, String)> {
        let word = self.text(i);
        match word {
            "noon" | "midday" | "lunchtime" => return Some((1, "12:00".to_owned())),
            "lunch" if self.is(i + 1, "time") && self.run(i, i + 1) => {
                return Some((2, "12:00".to_owned()));
            }
            "half" => return self.half(i),
            "quarter" => return self.quarter(i),
            _ => {}
        }
        if let Some(hit) = self.range(i) {
            return Some(hit);
        }
        if let Some(spec) = self.hour_lead(i) {
            return Some((1 + spec.tokens, self.spec_time(&spec)?));
        }
        // at 9, to 5, till 10, make it 8: a bare hour needs a word that says it is a time
        let (skip, trigger) = match word {
            "at" | "to" | "till" | "until" | "by" => (1, word),
            "make" if matches!(self.text(i + 1), "it" | "that") && self.run(i, i + 1) => {
                (2, "make")
            }
            _ => (0, ""),
        };
        if skip > 0 {
            // a number word is an hour after "at", and, in a message that sets or moves something,
            // after "to" ("move it to one": 13:00 or 01:00, nt15 R3e)
            let words = trigger == "at" || (trigger == "to" && self.write);
            let spec = self.spec_at(i + skip, words)?;
            if !self.run(i, i + skip) {
                return None;
            }
            let last = i + skip + spec.tokens - 1;
            if spec.bare() && !self.after_hour_ok(trigger, last) {
                return None;
            }
            return Some((skip + spec.tokens, self.spec_time(&spec)?));
        }
        // sunday 11, tomorrow 4: a bare hour right after a single day is a time
        if self.prev_day.get()
            && self.prev_end.get() == i
            && let Some(spec) = self.spec_at(i, false)
            && spec.pm.is_none()
            && !spec.colon
            && !spec.minutes
            && self.after_hour_ok("at", i + spec.tokens - 1)
        {
            return Some((spec.tokens, self.spec_time(&spec)?));
        }
        // 9pm, 8 pm, 7:30: a clock on its own
        let spec = self.spec_at(i, false)?;
        if spec.pm.is_none() && !spec.colon {
            return None;
        }
        Some((spec.tokens, self.spec_time(&spec)?))
    }
}
