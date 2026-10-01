//! THE PHRASE → EXPRESSION TABLE, as data for the generator (SPEC §4.4, §14).
//!
//! The runtime never reads these phrases: it evaluates only the expression it
//! is handed. The table exists so the generator teaches one fixed reading per
//! phrase — the §14 date rulings — and so `tests/dates.rs` can prove every
//! row's expression evaluates to the echo written beside it.
//!
//! Each row is a worked example: the phrase, the `today` it is read on (and
//! the row date, for `anchor: row` phrases), the expression the model writes,
//! and the echo the runtime answers with. A reading that depends on today
//! (a bare weekday) carries its rule.

use serde::Serialize;

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
];
