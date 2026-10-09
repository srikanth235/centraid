//! WHAT THE CONVERSATION ADDS TO THE `dates:` LINE (`phrases::Context`).
//!
//! The line reads a message alone (`phrases::read_dates`). A few phrases point back at the talk:
//! "that day" (the date the conversation last resolved), "the day before that", "before berlin"
//! (the one grounded event the words name). `Session::dates_context` gathers what they point at,
//! and `Session::dates_line` / `Session::date_readings` read the message with it; the compile
//! step's `dates[i]` picks index the same readings the model's line shows.

use std::collections::BTreeSet;

use jiff::civil::Date;

use crate::native::meta::Kind;
use crate::native::phrases::{self, Context, Reading, RowDate};
use crate::native::session::{Session, words};

/// "the first" to "the thirty-first": a day of the month, as a person says it.
fn ordinal_word(day: i8) -> String {
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
    let at = usize::try_from(day).unwrap_or(1).max(1) - 1;
    match day {
        1..=19 => format!("the {}", UNITS[at]),
        20 => "the twentieth".to_owned(),
        30 => "the thirtieth".to_owned(),
        21..=29 => format!("the twenty-{}", UNITS[at - 20]),
        _ => format!("the thirty-{}", UNITS[at - 30]),
    }
}

/// The one day a resolution is, when it is exactly one (`2027-02-08`, or with a clock).
fn one_day(resolution: &str) -> Option<Date> {
    let day: Date = resolution.get(..10)?.parse().ok()?;
    let rest = &resolution[10..];
    let clock = rest.strip_prefix(' ');
    (rest.is_empty() || clock.is_some_and(|clock| clock.len() == 5 && !clock.contains([' ', '.'])))
        .then_some(day)
}

impl Session {
    /// The date the conversation last resolved, from the freshest source: a row a write of this
    /// turn or the last one dated, the last single day the previous message said, the one day
    /// the previous turn's result showed.
    fn that_day(&self) -> Option<(Date, String)> {
        let label = |date: Date, turn: usize| format!("{}, turn {turn}", ordinal_word(date.day()));
        let floor = self.turn.saturating_sub(1);
        for (turn, inverses, _) in self.writes.iter().rev() {
            if *turn < floor {
                break;
            }
            for inverse in inverses.iter().rev() {
                if let Some(stamp) = self.world.row(&inverse.key).and_then(|row| row.date) {
                    return Some((stamp.date, label(stamp.date, *turn)));
                }
            }
        }
        let said = phrases::read_dates(&self.prev_message, self.now);
        if let Some(date) = said
            .iter()
            .rev()
            .find_map(|reading| one_day(&reading.resolution))
        {
            return Some((date, label(date, self.turn.saturating_sub(1))));
        }
        let mut shown: BTreeSet<Date> = BTreeSet::new();
        let mut turn = 0;
        for obs in self
            .observations
            .iter()
            .filter(|obs| obs.result && obs.turn + 1 == self.turn)
        {
            turn = obs.turn;
            for (numbers, _) in &obs.lines {
                for number in numbers {
                    let date = self
                        .by_number
                        .get(number.wrapping_sub(1))
                        .and_then(|key| self.world.row(key))
                        .and_then(|row| row.date);
                    shown.extend(date.map(|stamp| stamp.date));
                }
            }
        }
        match shown.iter().collect::<Vec<_>>().as_slice() {
            [only] => Some((**only, label(**only, turn))),
            _ => None,
        }
    }

    /// The dated events a "before X" can anchor on: the pre-grounded rows and the focus line's.
    fn anchor_rows(&self) -> Vec<RowDate> {
        let mut numbers: Vec<usize> = self.preground.iter().copied().collect();
        if let Some(line) = crate::native::prompt::focus_line(self) {
            let mut rest = line.as_str();
            while let Some(at) = rest.find('#') {
                let digits: String = rest[at + 1..]
                    .chars()
                    .take_while(char::is_ascii_digit)
                    .collect();
                rest = &rest[at + 1 + digits.len()..];
                if let Ok(number) = digits.parse::<usize>()
                    && !numbers.contains(&number)
                {
                    numbers.push(number);
                }
            }
        }
        numbers
            .into_iter()
            .filter_map(|number| {
                let row = self
                    .by_number
                    .get(number.wrapping_sub(1))
                    .and_then(|key| self.world.row(key))?;
                (row.kind == Kind::Event && !row.trashed).then_some(())?;
                Some(RowDate {
                    label: format!("#{number} event \"{}\"", row.name),
                    words: words(&row.name),
                    date: row.date?.date,
                })
            })
            .collect()
    }

    /// What the conversation adds to the `dates:` line of the message being read.
    #[must_use]
    pub fn dates_context(&self) -> Context {
        Context {
            that_day: self.that_day(),
            rows: self.anchor_rows(),
        }
    }

    /// The date phrases of `message` with the conversation's help: the entries of the `dates:`
    /// line, in order, which a `{"date": index}` pick indexes.
    #[must_use]
    pub fn date_readings(&self, message: &str) -> Vec<Reading> {
        phrases::read_dates_in(message, self.now, &self.dates_context())
    }

    /// The `dates:` line of `message` with the conversation's help.
    #[must_use]
    pub fn dates_line(&self, message: &str) -> Option<String> {
        phrases::dates_line_in(message, self.now, &self.dates_context())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn days_of_the_month_are_said_as_ordinals() {
        assert_eq!(ordinal_word(1), "the first");
        assert_eq!(ordinal_word(8), "the eighth");
        assert_eq!(ordinal_word(20), "the twentieth");
        assert_eq!(ordinal_word(23), "the twenty-third");
        assert_eq!(ordinal_word(30), "the thirtieth");
        assert_eq!(ordinal_word(31), "the thirty-first");
    }

    #[test]
    fn one_day_is_a_day_or_a_day_with_a_clock() {
        assert!(one_day("2027-02-08").is_some());
        assert!(one_day("2027-02-08 09:00").is_some());
        assert!(one_day("2027-02-08..2027-02-09").is_none());
        assert!(one_day("2027-02-08 (past) / 2027-03-08 (upcoming)").is_none());
    }
}
