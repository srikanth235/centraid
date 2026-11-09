//! The words: one function per phrase component, each reading tokens from a position and
//! returning what it found plus how many tokens it used. Tokens are already lowercased.

use super::civil::{civil_from_days, days_from_civil, days_in_month, valid, weekday_index};

/// What the parser knows about "now", pre-digested.
pub(super) struct Ctx {
    /// Today as days since 1970-01-01.
    pub today: i64,
    pub year: i32,
    pub minute_of_day: u32,
}

#[derive(Clone, Copy)]
pub(super) enum Day {
    Abs(i64),
    Weekday { idx: u8, next: bool },
    Tonight,
}

#[derive(Clone, Copy)]
pub(super) struct Clock {
    pub h: u8,
    pub m: u8,
}

#[derive(Clone, Copy)]
pub(super) enum RepKind {
    Daily,
    Weekdays,
    WeeklyToday,
    Weekly(u8),
    Monthly,
    Yearly,
}

pub(super) enum Comp {
    Day(Day),
    /// `bare` is the hour as written when no am/pm said which half of the day.
    Time {
        clock: Clock,
        bare: Option<u8>,
    },
    /// morning / afternoon / evening: only valid straight after a day word.
    Period(Clock),
    /// A day and a time at once (`in 2 hours`, `this evening`).
    DayTime(Day, Clock),
    Repeat(RepKind),
}

const MONTHS: [(&str, u8); 24] = [
    ("jan", 1),
    ("january", 1),
    ("feb", 2),
    ("february", 2),
    ("mar", 3),
    ("march", 3),
    ("apr", 4),
    ("april", 4),
    ("may", 5),
    ("jun", 6),
    ("june", 6),
    ("jul", 7),
    ("july", 7),
    ("aug", 8),
    ("august", 8),
    ("sep", 9),
    ("sept", 9),
    ("september", 9),
    ("oct", 10),
    ("october", 10),
    ("nov", 11),
    ("november", 11),
    ("dec", 12),
    ("december", 12),
];
const WEEKDAYS: [(&str, u8); 17] = [
    ("mon", 0),
    ("monday", 0),
    ("tue", 1),
    ("tues", 1),
    ("tuesday", 1),
    ("wed", 2),
    ("wednesday", 2),
    ("thu", 3),
    ("thur", 3),
    ("thurs", 3),
    ("thursday", 3),
    ("fri", 4),
    ("friday", 4),
    ("sat", 5),
    ("saturday", 5),
    ("sun", 6),
    ("sunday", 6),
];

pub(super) fn is_connector(tok: &str) -> bool {
    matches!(tok, "at" | "on" | "by")
}

fn month_from(tok: &str) -> Option<u8> {
    MONTHS.iter().find(|(n, _)| *n == tok).map(|(_, m)| *m)
}

fn weekday_from(tok: &str) -> Option<u8> {
    WEEKDAYS.iter().find(|(n, _)| *n == tok).map(|(_, i)| *i)
}

fn period_from(tok: &str) -> Option<Clock> {
    let h = match tok {
        "morning" => 9,
        "afternoon" => 15,
        "evening" => 19,
        _ => return None,
    };
    Some(Clock { h, m: 0 })
}

fn all_digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

fn number(s: &str, max_len: usize) -> Option<u32> {
    if all_digits(s) && s.len() <= max_len {
        s.parse().ok()
    } else {
        None
    }
}

/// `1..=999` as digits, or `one`..`ten`, `a`, `an`.
fn count_word(tok: &str) -> Option<i64> {
    let words = [
        "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
    ];
    if matches!(tok, "a" | "an") {
        return Some(1);
    }
    if let Some(i) = words.iter().position(|w| *w == tok) {
        return i64::try_from(i + 1).ok();
    }
    number(tok, 3).filter(|n| *n >= 1).map(i64::from)
}

fn day_number(tok: &str) -> Option<u8> {
    let digits = ["st", "nd", "rd", "th"]
        .iter()
        .find_map(|s| tok.strip_suffix(s))
        .unwrap_or(tok);
    let n = number(digits, 2)?;
    u8::try_from(n).ok().filter(|d| (1..=31).contains(d))
}

fn year_number(tok: &str) -> Option<i32> {
    if tok.len() != 4 {
        return None;
    }
    number(tok, 4)
        .and_then(|y| i32::try_from(y).ok())
        .filter(|y| (1900..=2999).contains(y))
}

fn iso(tok: &str) -> Option<i64> {
    let b = tok.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let y = number(tok.get(0..4)?, 4)?;
    let m = number(tok.get(5..7)?, 2)?;
    let d = number(tok.get(8..10)?, 2)?;
    let (y, m, d) = (
        i32::try_from(y).ok()?,
        u8::try_from(m).ok()?,
        u8::try_from(d).ok()?,
    );
    valid(y, m, d).then(|| days_from_civil(y, m, d))
}

/// A month-day (and optional year) as a day. Without a year, the next one not in the past.
fn month_day(month: u8, day: u8, year: Option<i32>, ctx: &Ctx) -> Option<i64> {
    if let Some(y) = year {
        return valid(y, month, day).then(|| days_from_civil(y, month, day));
    }
    (ctx.year..ctx.year + 9)
        .filter(|y| day <= days_in_month(*y, month))
        .map(|y| days_from_civil(y, month, day))
        .find(|n| *n >= ctx.today)
}

fn date(toks: &[String], pos: usize, ctx: &Ctx) -> Option<(Comp, usize)> {
    let t = toks.get(pos)?.as_str();
    if let Some(n) = iso(t) {
        return Some((Comp::Day(Day::Abs(n)), 1));
    }
    let (month, day) = if let Some(m) = month_from(t) {
        (m, day_number(toks.get(pos + 1)?)?)
    } else {
        (month_from(toks.get(pos + 1)?)?, day_number(t)?)
    };
    let year = toks.get(pos + 2).and_then(|y| year_number(y));
    let used = if year.is_some() { 3 } else { 2 };
    Some((Comp::Day(Day::Abs(month_day(month, day, year, ctx)?)), used))
}

fn repeat(t: &str, next: Option<&str>) -> Option<(Comp, usize)> {
    let one = |k| Some((Comp::Repeat(k), 1));
    match t {
        "daily" => one(RepKind::Daily),
        "weekly" => one(RepKind::WeeklyToday),
        "monthly" => one(RepKind::Monthly),
        "yearly" | "annually" => one(RepKind::Yearly),
        "every" => {
            let kind = match next? {
                "day" => RepKind::Daily,
                "weekday" => RepKind::Weekdays,
                "week" => RepKind::WeeklyToday,
                "month" => RepKind::Monthly,
                "year" => RepKind::Yearly,
                w => RepKind::Weekly(weekday_from(w)?),
            };
            Some((Comp::Repeat(kind), 2))
        }
        _ => None,
    }
}

/// `in N unit`: days and weeks are a day; hours and minutes are a moment from now.
fn relative(toks: &[String], pos: usize, ctx: &Ctx) -> Option<(Comp, usize)> {
    let n = count_word(toks.get(pos + 1)?)?;
    let unit = toks.get(pos + 2)?.as_str();
    let minutes = match unit {
        "day" | "days" => return Some((Comp::Day(Day::Abs(ctx.today + n)), 3)),
        "week" | "weeks" => return Some((Comp::Day(Day::Abs(ctx.today + 7 * n)), 3)),
        "hour" | "hours" | "hr" | "hrs" => n * 60,
        "minute" | "minutes" | "min" | "mins" => n,
        _ => return None,
    };
    let total = i64::from(ctx.minute_of_day) + minutes;
    let clock = Clock {
        h: u8::try_from(total.rem_euclid(1440) / 60).ok()?,
        m: u8::try_from(total.rem_euclid(60)).ok()?,
    };
    Some((
        Comp::DayTime(Day::Abs(ctx.today + total.div_euclid(1440)), clock),
        3,
    ))
}

fn this_or_next(t: &str, next: Option<&str>, ctx: &Ctx) -> Option<(Comp, usize)> {
    let w = next?;
    if t == "this" {
        if let Some(idx) = weekday_from(w) {
            return Some((Comp::Day(Day::Weekday { idx, next: false }), 2));
        }
        return Some((Comp::DayTime(Day::Abs(ctx.today), period_from(w)?), 2));
    }
    if let Some(idx) = weekday_from(w) {
        return Some((Comp::Day(Day::Weekday { idx, next: true }), 2));
    }
    let wd = i64::from(weekday_index(ctx.today));
    match w {
        "week" => Some((Comp::Day(Day::Abs(ctx.today + 7 - wd)), 2)),
        "month" => {
            let (y, m, _) = civil_from_days(ctx.today);
            let (y, m) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
            Some((Comp::Day(Day::Abs(days_from_civil(y, m, 1))), 2))
        }
        _ => None,
    }
}

fn clock_at(toks: &[String], pos: usize, at: bool) -> Option<(Comp, usize)> {
    let t = toks.get(pos)?.as_str();
    let (body, mut suffix) = if let Some(b) = t.strip_suffix("am") {
        (b, Some(false))
    } else if let Some(b) = t.strip_suffix("pm") {
        (b, Some(true))
    } else {
        (t, None)
    };
    let mut used = 1;
    let (h_txt, m_txt) = match body.split_once(':') {
        Some((h, m)) => (h, Some(m)),
        None => (body, None),
    };
    let h = u8::try_from(number(h_txt, 2)?).ok()?;
    let m = match m_txt {
        Some(m) if m.len() == 2 => u8::try_from(number(m, 2)?).ok()?,
        Some(_) => return None,
        None => 0,
    };
    if suffix.is_none() {
        match toks.get(pos + 1).map(String::as_str) {
            Some("am") => suffix = Some(false),
            Some("pm") => suffix = Some(true),
            _ => {}
        }
        used += usize::from(suffix.is_some());
    }
    if m > 59 {
        return None;
    }
    if let Some(pm) = suffix {
        if !(1..=12).contains(&h) {
            return None;
        }
        let h24 = match (pm, h) {
            (false, 12) => 0,
            (true, 12) => 12,
            (true, h) => h + 12,
            (false, h) => h,
        };
        return Some((
            Comp::Time {
                clock: Clock { h: h24, m },
                bare: None,
            },
            used,
        ));
    }
    if h > 23 {
        return None;
    }
    let padded = h_txt.len() == 2 && h_txt.starts_with('0');
    if h == 0 || h >= 13 || padded {
        if m_txt.is_none() && !at {
            return None;
        }
        return Some((
            Comp::Time {
                clock: Clock { h, m },
                bare: None,
            },
            used,
        ));
    }
    if !at {
        return None;
    }
    let h24 = if h <= 6 { h + 12 } else { h };
    Some((
        Comp::Time {
            clock: Clock { h: h24, m },
            bare: Some(h),
        },
        used,
    ))
}

/// Read one component at `pos`. `at` is true when the previous token was `at`; `after_day` when
/// the previous component was a day.
pub(super) fn component(
    toks: &[String],
    pos: usize,
    at: bool,
    after_day: bool,
    ctx: &Ctx,
) -> Option<(Comp, usize)> {
    let t = toks.get(pos)?.as_str();
    let next = toks.get(pos + 1).map(String::as_str);
    if let Some(r) = repeat(t, next) {
        return Some(r);
    }
    match t {
        "in" => return relative(toks, pos, ctx),
        "this" | "next" => return this_or_next(t, next, ctx),
        "today" => return Some((Comp::Day(Day::Abs(ctx.today)), 1)),
        "tomorrow" => return Some((Comp::Day(Day::Abs(ctx.today + 1)), 1)),
        "tonight" => return Some((Comp::Day(Day::Tonight), 1)),
        "noon" => {
            return Some((
                Comp::Time {
                    clock: Clock { h: 12, m: 0 },
                    bare: None,
                },
                1,
            ));
        }
        _ => {}
    }
    if let Some(idx) = weekday_from(t) {
        return Some((Comp::Day(Day::Weekday { idx, next: false }), 1));
    }
    if after_day && let Some(c) = period_from(t) {
        return Some((Comp::Period(c), 1));
    }
    date(toks, pos, ctx).or_else(|| clock_at(toks, pos, at))
}
