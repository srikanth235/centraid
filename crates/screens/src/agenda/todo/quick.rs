//! Small, deterministic quick-add grammar. Only a suffix is interpreted, so
//! ordinary words inside a title survive. Ambiguous dates/times are explained
//! before a write; the member's current civil day comes from the core read.

use crate::kit::civil;
use crate::strings::{Locale, fill, task as words};

#[derive(Debug, PartialEq, Eq)]
pub struct Parsed {
    pub title: String,
    pub due: String,
    pub preview: String,
    pub valid: bool,
}

/// Explicit quick-add controls stay separate from the title, so changing a
/// date never moves the typing cursor or rewrites a person's words.
#[derive(Default)]
pub struct Options<'a> {
    pub project: Option<&'a str>,
    pub section: Option<&'a str>,
    pub due: Option<&'a str>,
    pub flagged: bool,
}

pub fn with_due(input: &str, today: &str, due: Option<&str>, locale: Locale) -> Parsed {
    let mut parsed = parse(input, today, locale);
    if let Some(due) = due {
        let time = if due.is_empty() {
            ""
        } else {
            parsed.due.get(10..).unwrap_or_default()
        };
        parsed.due = format!("{due}{time}");
        if parsed.valid || input.trim().is_empty() {
            parsed.preview = if parsed.due.is_empty() {
                String::new()
            } else {
                fill(
                    &words::quick_due_preview(locale),
                    &[("date", &parsed.due.replace('T', " · "))],
                )
            };
        }
    }
    parsed
}

pub fn tools(
    locale: Locale,
    today: &str,
    due: &str,
    flagged: bool,
) -> Vec<centraid_api_proto::core_v1::TodoChoice> {
    let tomorrow = civil::plus_days(today, 1).unwrap_or_default();
    [
        (
            "today",
            words::when_today(locale),
            due.get(..10) == Some(today),
            "Calendar",
        ),
        (
            "tomorrow",
            words::when_tomorrow(locale),
            due.get(..10) == Some(tomorrow.as_str()),
            "Calendar",
        ),
        (
            "no_date",
            words::when_none(locale),
            due.is_empty(),
            "Calendar",
        ),
        (
            "flag",
            if flagged {
                words::flagged(locale)
            } else {
                words::flag(locale)
            },
            flagged,
            "Flag",
        ),
    ]
    .into_iter()
    .map(
        |(key, label, selected, icon)| centraid_api_proto::core_v1::TodoChoice {
            key: key.into(),
            label,
            selected,
            enabled: true,
            icon_key: icon.into(),
            ..Default::default()
        },
    )
    .collect()
}

pub fn pick(key: &str, today: &str, due: &mut Option<String>, flagged: &mut bool) {
    match key {
        "today" => *due = Some(today.to_owned()),
        "tomorrow" => *due = civil::plus_days(today, 1),
        "no_date" => *due = Some(String::new()),
        "flag" => *flagged = !*flagged,
        _ => {}
    }
}

pub fn parse(input: &str, today: &str, locale: Locale) -> Parsed {
    let text = input.trim();
    let mut title = text;
    let mut due = String::new();
    let lower = text.to_ascii_lowercase();
    let mut base = lower.as_str();
    let mut time = None;
    if let Some((left, clock)) = lower.rsplit_once(" at ") {
        // An ordinary location, such as "meet at the library", is not a time.
        if clock.starts_with(|c: char| c.is_ascii_digit()) || matches!(clock, "noon" | "midnight") {
            let Some(value) = clock_time(clock) else {
                return invalid(text, words::quick_time_unclear(locale));
            };
            time = Some(value);
            base = left;
            title = &text[..left.len()];
        }
    }
    let day = if let Some(left) = base.strip_suffix(" tomorrow") {
        Some((left, civil::plus_days(today, 1)))
    } else if let Some(left) = base.strip_suffix(" today") {
        Some((left, civil::epoch_day_of(today).map(|_| today.to_owned())))
    } else if let Some((left, weekday)) = base.rsplit_once(" next ") {
        weekday_number(weekday).map(|target| {
            let day = civil::iso_weekday_of(today).and_then(|current| {
                let delta = (i64::from(target) - i64::from(current)).rem_euclid(7);
                civil::plus_days(today, if delta == 0 { 7 } else { delta })
            });
            (left, day)
        })
    } else if let Some((left, date)) = base.rsplit_once(' ') {
        if date.len() == 10 && date.as_bytes().get(4) == Some(&b'-') {
            Some((
                left.strip_suffix(" on").unwrap_or(left),
                civil::epoch_day_of(date).map(|_| date.to_owned()),
            ))
        } else if date.contains('/') && date.starts_with(|c: char| c.is_ascii_digit()) {
            return invalid(text, words::quick_date_unclear(locale));
        } else {
            None
        }
    } else {
        None
    };
    if let Some((left, day)) = day {
        let Some(day) = day else {
            return invalid(text, words::quick_date_unclear(locale));
        };
        title = &text[..left.len()];
        due = day;
    } else if base.ends_with(" next week") || base.ends_with(" next month") {
        return invalid(text, words::quick_date_unclear(locale));
    }
    if let Some(time) = time {
        if due.is_empty() {
            if civil::epoch_day_of(today).is_none() {
                return invalid(text, words::quick_date_unclear(locale));
            }
            due = today.to_owned();
        }
        due.push('T');
        due.push_str(&time);
    }
    let title = title.trim().to_owned();
    let preview = if due.is_empty() {
        String::new()
    } else {
        fill(
            &words::quick_due_preview(locale),
            &[("date", &due.replace('T', " · "))],
        )
    };
    Parsed {
        valid: !title.is_empty(),
        title,
        due,
        preview,
    }
}

fn invalid(title: &str, preview: String) -> Parsed {
    Parsed {
        title: title.to_owned(),
        due: String::new(),
        preview,
        valid: false,
    }
}

fn weekday_number(day: &str) -> Option<u32> {
    [
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
        "sunday",
    ]
    .iter()
    .position(|name| *name == day)
    .map(|index| index as u32 + 1)
}

fn clock_time(value: &str) -> Option<String> {
    if value == "noon" {
        return Some("12:00".into());
    }
    if value == "midnight" {
        return Some("00:00".into());
    }
    let (digits, half) = if let Some(digits) = value.strip_suffix("am") {
        (digits.trim(), Some(false))
    } else if let Some(digits) = value.strip_suffix("pm") {
        (digits.trim(), Some(true))
    } else {
        (value, None)
    };
    let (hour, minute) = if let Some((hour, minute)) = digits.split_once(':') {
        if minute.len() != 2 {
            return None;
        }
        (hour.parse::<u32>().ok()?, minute.parse::<u32>().ok()?)
    } else {
        half?;
        (digits.parse::<u32>().ok()?, 0)
    };
    if minute > 59 {
        return None;
    }
    let hour = match half {
        Some(pm) if (1..=12).contains(&hour) => hour % 12 + if pm { 12 } else { 0 },
        None if hour < 24 => hour,
        _ => return None,
    };
    Some(format!("{hour:02}:{minute:02}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn natural_dates_cross_months_and_preview_the_exact_civil_result() {
        let parsed = parse("Pay rent tomorrow at 5:30pm", "2026-12-31", Locale::En);
        assert_eq!(parsed.title, "Pay rent");
        assert_eq!(parsed.due, "2027-01-01T17:30");
        assert!(parsed.preview.contains("2027-01-01"));
        assert!(parsed.valid);
        assert_eq!(
            parse("Call next thursday", "2026-11-05", Locale::En).due,
            "2026-11-12"
        );
        assert_eq!(
            parse("Walk at noon", "2026-11-05", Locale::En).due,
            "2026-11-05T12:00"
        );
    }

    #[test]
    fn ambiguous_invalid_and_ordinary_titles_never_become_silent_guesses() {
        for text in [
            "Call on 11/12",
            "Call 2026-02-30",
            "Call at 8",
            "Call next week",
        ] {
            let parsed = parse(text, "2026-11-05", Locale::En);
            assert!(!parsed.valid, "{text}");
            assert_eq!(parsed.title, text);
            assert!(!parsed.preview.is_empty());
        }
        for text in [
            "Tomorrow is another day",
            "Meet at the library",
            "Remember tomorrowland",
        ] {
            let parsed = parse(text, "2026-11-05", Locale::En);
            assert_eq!(parsed.title, text);
            assert!(parsed.due.is_empty());
            assert!(parsed.valid);
        }
    }
}
