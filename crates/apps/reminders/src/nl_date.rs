//! # Natural-language dates for quick add
//!
//! Reads a trailing date, time or repeat phrase off a quick-add title ("Call mom tomorrow at
//! 9am") and says what it meant. Pure: no I/O, no vault, no clock. "Now" is a [`Now`] the caller
//! passes in (the core's `now_local`), so every answer is a function of its arguments.
//!
//! ## Rules
//!
//! - **Only a trailing phrase is read.** The parser takes the longest suffix of
//!   whitespace-separated tokens that is entirely a valid phrase. Never the middle or the start.
//!   If the phrase would be the whole input, nothing matches and the title is untouched.
//!   Matching ignores case; trailing whitespace on the input is tolerated. The connectors `at`,
//!   `on`, `by` may lead or sit inside a phrase and leave with it.
//! - **Days**: `today`, `tomorrow`, `tonight` (today 20:00; from 20:00 on, today with no time),
//!   weekday names (`mon`..`sunday`; a bare one is the soonest such day, today included, except
//!   that today is skipped when a time is given that is no longer ahead; `this <weekday>` is the
//!   same; `next <weekday>` is strictly after today), `next week` (the following Monday),
//!   `next month` (the 1st), `in N days|weeks` (`N` is 1-999 or one..ten, `a`, `an`), and
//!   `in N hours|minutes` (now plus the offset, rolling into the next day).
//! - **Dates**: `dec 4`, `4 dec`, `dec 4th`, `4th december`, an optional four-digit year after
//!   them, and ISO `2026-12-04`. A month name needs a day number beside it. Without a year, a
//!   date already past rolls to next year; today stays today. `feb 30` is no match. Numeric
//!   dates like `12/4` or `4.12` are never read (locale-ambiguous); only ISO is numeric.
//! - **Times**: `9am`, `9 am`, `9:30pm`, 24-hour `14:30`, `noon`, and `morning` (9:00),
//!   `afternoon` (15:00), `evening` (19:00) only straight after a day word or `this`. A bare hour
//!   or `h:mm` with h 1-12 and no am/pm needs a leading `at` and resolves by the ambiguity rule:
//!   7-11 morning, 12 noon, 1-6 afternoon (13-18; after `tonight`, 1-11 are evening). A
//!   leading-zero hour (`09:00`), `0:xx` and 13-23 are 24-hour. Only `:` separates hours from
//!   minutes. Hours above 23 or minutes above 59 are no match.
//! - **A time with no day** is today when strictly ahead of now, else tomorrow. A day and a time
//!   combine in either order (`tomorrow 9am`, `9am tomorrow`, `at 6 tomorrow`).
//! - **Repeats**: `every day`, `daily`, `every weekday`, `every week`, `weekly` (on today's
//!   weekday), `every <weekday>`, `every month`, `monthly`, `every year`, `yearly`, `annually`;
//!   a time may come with them (`every monday at 9`). A repeat always has a `when`: the first
//!   occurrence on or after today (today only when the weekday fits and any time is still
//!   ahead). Monthly and yearly anchor on today.

mod civil;
mod lexicon;

use std::ops::Range;

use civil::{civil_from_days, days_from_civil, weekday_index};
use lexicon::{Clock, Comp, Ctx, Day, RepKind, component, is_connector};

/// The longest phrase, in tokens, that is considered.
const MAX_PHRASE_TOKENS: usize = 10;
/// `tonight` starts at 20:00, in minutes of the day.
const TONIGHT: u32 = 20 * 60;

/// The member's wall clock now, in their zone: the core's `now_local` (`YYYY-MM-DDTHH:MM`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Now {
    pub year: i32,
    pub month: u8,
    pub day: u8,
    pub hour: u8,
    pub minute: u8,
}

impl Now {
    /// Parses `YYYY-MM-DDTHH:MM` (seconds, if present, ignored). None if malformed.
    pub fn parse(now_local: &str) -> Option<Now> {
        let b = now_local.as_bytes();
        if b.len() < 16 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' {
            return None;
        }
        if b.len() > 16 && b[16] != b':' {
            return None;
        }
        let digits = |r: Range<usize>| -> Option<u32> {
            let s = b.get(r)?;
            s.iter().try_fold(0u32, |acc, c| {
                c.is_ascii_digit().then(|| acc * 10 + u32::from(c - b'0'))
            })
        };
        let now = Now {
            year: i32::try_from(digits(0..4)?).ok()?,
            month: u8::try_from(digits(5..7)?).ok()?,
            day: u8::try_from(digits(8..10)?).ok()?,
            hour: u8::try_from(digits(11..13)?).ok()?,
            minute: u8::try_from(digits(14..16)?).ok()?,
        };
        now.is_valid().then_some(now)
    }

    fn is_valid(&self) -> bool {
        civil::valid(self.year, self.month, self.day) && self.hour < 24 && self.minute < 60
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Weekday {
    Mon,
    Tue,
    Wed,
    Thu,
    Fri,
    Sat,
    Sun,
}

impl Weekday {
    fn from_index(idx: u8) -> Weekday {
        match idx {
            0 => Weekday::Mon,
            1 => Weekday::Tue,
            2 => Weekday::Wed,
            3 => Weekday::Thu,
            4 => Weekday::Fri,
            5 => Weekday::Sat,
            _ => Weekday::Sun,
        }
    }

    fn code(self) -> &'static str {
        match self {
            Weekday::Mon => "MO",
            Weekday::Tue => "TU",
            Weekday::Wed => "WE",
            Weekday::Thu => "TH",
            Weekday::Fri => "FR",
            Weekday::Sat => "SA",
            Weekday::Sun => "SU",
        }
    }
}

/// When the phrase lands, on the member's wall clock.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct When {
    /// `YYYY-MM-DD`.
    pub day: String,
    /// `(hour 0-23, minute)`, or None for a day with no time.
    pub time: Option<(u8, u8)>,
}

impl When {
    /// The vault's `due` spelling: `YYYY-MM-DD`, or `YYYY-MM-DDTHH:MM:00` with a time.
    pub fn due(&self) -> String {
        match self.time {
            Some((h, m)) => format!("{}T{h:02}:{m:02}:00", self.day),
            None => self.day.clone(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Repeat {
    Daily,
    Weekdays,
    Weekly(Weekday),
    Monthly,
    Yearly,
}

impl Repeat {
    /// RFC 5545 RRULE body: `FREQ=DAILY`, `FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR`,
    /// `FREQ=WEEKLY;BYDAY=MO`, `FREQ=MONTHLY`, `FREQ=YEARLY`.
    pub fn rule(&self) -> String {
        match self {
            Repeat::Daily => "FREQ=DAILY".to_string(),
            Repeat::Weekdays => "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR".to_string(),
            Repeat::Weekly(d) => format!("FREQ=WEEKLY;BYDAY={}", d.code()),
            Repeat::Monthly => "FREQ=MONTHLY".to_string(),
            Repeat::Yearly => "FREQ=YEARLY".to_string(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Parsed {
    /// The title with the phrase cut out and trailing whitespace trimmed; when nothing matched,
    /// the INPUT EXACTLY (not trimmed).
    pub title: String,
    pub when: Option<When>,
    pub repeat: Option<Repeat>,
    /// Byte range of the phrase in the input that was taken (for highlighting); None when nothing
    /// matched.
    pub phrase: Option<Range<usize>>,
}

impl Parsed {
    pub fn matched(&self) -> bool {
        self.phrase.is_some()
    }
}

/// What a phrase said, before it is resolved against today.
#[derive(Default)]
struct Reading {
    day: Option<Day>,
    time: Option<(Clock, Option<u8>)>,
    repeat: Option<RepKind>,
}

/// Read a trailing date, time or repeat phrase off a quick-add title.
pub fn parse(input: &str, now: &Now) -> Parsed {
    let untouched = || Parsed {
        title: input.to_string(),
        when: None,
        repeat: None,
        phrase: None,
    };
    if !now.is_valid() {
        return untouched();
    }
    let ctx = Ctx {
        today: days_from_civil(now.year, now.month, now.day),
        year: now.year,
        minute_of_day: u32::from(now.hour) * 60 + u32::from(now.minute),
    };
    let spans = tokenize(input);
    let words: Vec<String> = spans.iter().map(|(_, w)| w.clone()).collect();
    // Smallest start first is the longest suffix. Token 0 always stays in the title.
    for start in spans.len().saturating_sub(MAX_PHRASE_TOKENS).max(1)..spans.len() {
        // A title of nothing but connectors is no title: "at 9am" is the whole phrase.
        if words[..start].iter().all(|w| is_connector(w)) {
            continue;
        }
        let Some(reading) = read(&words[start..], &ctx) else {
            continue;
        };
        let Some((when, repeat)) = resolve(&reading, &ctx) else {
            continue;
        };
        let begin = spans[start].0.start;
        let end = spans[spans.len() - 1].0.end;
        let title = input
            .get(..begin)
            .unwrap_or_default()
            .trim_end()
            .to_string();
        return Parsed {
            title,
            when: Some(when),
            repeat,
            phrase: Some(begin..end),
        };
    }
    untouched()
}

/// Whitespace-separated tokens: byte range and lowercased text.
fn tokenize(input: &str) -> Vec<(Range<usize>, String)> {
    let mut out = Vec::new();
    let mut start: Option<usize> = None;
    let mut push = |s: usize, e: usize| {
        if let Some(t) = input.get(s..e) {
            out.push((s..e, t.to_lowercase()));
        }
    };
    for (i, c) in input.char_indices() {
        if c.is_whitespace() {
            if let Some(s) = start.take() {
                push(s, i);
            }
        } else if start.is_none() {
            start = Some(i);
        }
    }
    if let Some(s) = start {
        push(s, input.len());
    }
    out
}

/// The whole of `toks` as one phrase, or None if any token is left over.
fn read(toks: &[String], ctx: &Ctx) -> Option<Reading> {
    let mut r = Reading::default();
    let (mut pos, mut at, mut after_day, mut dangling) = (0, false, false, false);
    while pos < toks.len() {
        let tok = toks[pos].as_str();
        if is_connector(tok) {
            at = tok == "at";
            dangling = true;
            pos += 1;
            continue;
        }
        let (comp, used) = component(toks, pos, at, after_day, ctx)?;
        let is_day = matches!(comp, Comp::Day(_) | Comp::DayTime(..));
        match comp {
            Comp::Day(d) if r.day.is_none() && r.repeat.is_none() => r.day = Some(d),
            Comp::Time { clock, bare } if r.time.is_none() => r.time = Some((clock, bare)),
            Comp::Period(c) if r.time.is_none() => r.time = Some((c, None)),
            Comp::DayTime(d, c) if r.day.is_none() && r.time.is_none() && r.repeat.is_none() => {
                r.day = Some(d);
                r.time = Some((c, None));
            }
            Comp::Repeat(k) if r.repeat.is_none() && r.day.is_none() => r.repeat = Some(k),
            _ => return None,
        }
        pos += used;
        at = false;
        after_day = is_day;
        dangling = false;
    }
    let found = r.day.is_some() || r.time.is_some() || r.repeat.is_some();
    (found && !dangling).then_some(r)
}

fn ymd(day: i64) -> String {
    let (y, m, d) = civil_from_days(day);
    format!("{y:04}-{m:02}-{d:02}")
}

/// Pin a reading to a day and a time, given today.
fn resolve(r: &Reading, ctx: &Ctx) -> Option<(When, Option<Repeat>)> {
    let mut time = r.time.map(|(c, _)| c);
    let ahead = |c: Clock| u32::from(c.h) * 60 + u32::from(c.m) > ctx.minute_of_day;
    // The first day from today whose weekday satisfies `fits`; today only if no time or still ahead.
    let first = |fits: &dyn Fn(u8) -> bool| -> i64 {
        (0..14)
            .map(|k| ctx.today + k)
            .find(|d| {
                let today_ok = *d > ctx.today || time.is_none_or(ahead);
                today_ok && fits(weekday_index(*d))
            })
            .unwrap_or(ctx.today)
    };
    let today_wd = weekday_index(ctx.today);
    if let Some(kind) = r.repeat {
        let (day, repeat) = match kind {
            RepKind::Daily => (first(&|_| true), Repeat::Daily),
            RepKind::Weekdays => (first(&|w| w < 5), Repeat::Weekdays),
            RepKind::WeeklyToday => (
                first(&|w| w == today_wd),
                Repeat::Weekly(Weekday::from_index(today_wd)),
            ),
            RepKind::Weekly(idx) => (
                first(&|w| w == idx),
                Repeat::Weekly(Weekday::from_index(idx)),
            ),
            RepKind::Monthly => (ctx.today, Repeat::Monthly),
            RepKind::Yearly => (ctx.today, Repeat::Yearly),
        };
        let when = When {
            day: ymd(day),
            time: time.map(|c| (c.h, c.m)),
        };
        return Some((when, Some(repeat)));
    }
    let day = match r.day {
        Some(Day::Abs(d)) => d,
        Some(Day::Tonight) => {
            if let Some((c, Some(raw))) = r.time
                && (1..=11).contains(&raw)
            {
                time = Some(Clock {
                    h: raw + 12,
                    m: c.m,
                });
            }
            if time.is_none() && ctx.minute_of_day < TONIGHT {
                time = Some(Clock { h: 20, m: 0 });
            }
            ctx.today
        }
        Some(Day::Weekday { idx, next }) => {
            let delta = i64::from((idx + 7 - today_wd) % 7);
            let skip_today = delta == 0 && (next || time.is_some_and(|c| !ahead(c)));
            ctx.today + if skip_today { 7 } else { delta }
        }
        None => {
            let c = time?;
            ctx.today + i64::from(!ahead(c))
        }
    };
    Some((
        When {
            day: ymd(day),
            time: time.map(|c| (c.h, c.m)),
        },
        None,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> Now {
        Now {
            year: 2026,
            month: 11,
            day: 7,
            hour: 10,
            minute: 30,
        }
    }

    #[test]
    fn now_parse() {
        assert_eq!(Now::parse("2026-11-07T10:30"), Some(now()));
        assert_eq!(Now::parse("2026-11-07T10:30:59"), Some(now()));
        assert_eq!(Now::parse("2026-11-07 10:30"), None);
        assert_eq!(Now::parse("2026-02-30T10:30"), None);
        assert_eq!(Now::parse("2026-11-07T24:00"), None);
        assert_eq!(Now::parse("2026-11-0é"), None);
    }

    #[test]
    fn phrase_range_points_at_the_phrase() {
        let input = "Call mom at 9am tomorrow  ";
        let p = parse(input, &now());
        assert_eq!(p.title, "Call mom");
        assert_eq!(
            p.phrase.clone().and_then(|r| input.get(r)),
            Some("at 9am tomorrow")
        );
    }
}
