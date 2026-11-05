//! Civil RFC 5545 candidates. A period holds at most 371 dates and three small
//! time lists; even a yearly rule with every second never allocates its full
//! Cartesian product. BYSETPOS indexes that product before any range clipping.

use super::rrule::{Freq, ParsedRrule};
use super::zone::{
    WallTime, add_wall_days, add_wall_months, days_in_month, wall_epoch, wall_from_epoch,
    wall_weekday,
};

const DAY_MS: i64 = 86_400_000;

pub(super) fn quantum(freq: Freq) -> Option<i64> {
    match freq {
        Freq::Secondly => Some(1_000),
        Freq::Minutely => Some(60_000),
        Freq::Hourly => Some(3_600_000),
        Freq::Daily => Some(DAY_MS),
        Freq::Weekly => Some(7 * DAY_MS),
        _ => None,
    }
}

fn midnight(wall: WallTime) -> WallTime {
    WallTime {
        hour: 0,
        minute: 0,
        second: 0,
        millisecond: 0,
        ..wall
    }
}
fn jan_first(year: i64) -> WallTime {
    WallTime {
        year,
        month: 1,
        day: 1,
        hour: 0,
        minute: 0,
        second: 0,
        millisecond: 0,
    }
}

pub(super) fn anchor(initial: WallTime, rule: &ParsedRrule, index: i64) -> Option<WallTime> {
    let steps = index.checked_mul(rule.interval)?;
    let wall = match rule.freq {
        Freq::Monthly => add_wall_months(WallTime { day: 1, ..initial }, steps),
        Freq::Yearly => WallTime {
            year: initial.year.checked_add(steps)?,
            month: 1,
            day: 1,
            ..initial
        },
        freq => {
            wall_from_epoch(wall_epoch(initial).checked_add(steps.checked_mul(quantum(freq)?)?)?)
        }
    };
    (1..=9999).contains(&wall.year).then_some(wall)
}

/// The week containing January 4 is week one, with the rule's chosen WKST.
fn week_one(year: i64, week_start: i64) -> WallTime {
    let fourth = WallTime {
        day: 4,
        ..jan_first(year)
    };
    add_wall_days(fourth, -(wall_weekday(fourth) - week_start).rem_euclid(7))
}

fn ordinal_match(day: i64, length: i64, values: &[i64]) -> bool {
    values.is_empty()
        || values.iter().any(|value| {
            day == if *value > 0 {
                *value
            } else {
                length + value + 1
            }
        })
}

pub(super) fn date_matches(
    date: WallTime,
    initial: WallTime,
    period_year: i64,
    rule: &ParsedRrule,
) -> bool {
    if !rule.months.is_empty() && !rule.months.contains(&date.month) {
        return false;
    }
    if !ordinal_match(
        date.day,
        days_in_month(date.year, date.month),
        &rule.month_days,
    ) {
        return false;
    }
    let year_day = (wall_epoch(midnight(date)) - wall_epoch(jan_first(date.year))) / DAY_MS + 1;
    let year_length =
        (wall_epoch(jan_first(date.year + 1)) - wall_epoch(jan_first(date.year))) / DAY_MS;
    if !ordinal_match(year_day, year_length, &rule.year_days) {
        return false;
    }
    if !rule.week_numbers.is_empty() {
        let first = wall_epoch(week_one(period_year, rule.week_start));
        let next = wall_epoch(week_one(period_year + 1, rule.week_start));
        let current = wall_epoch(midnight(date));
        if current < first
            || current >= next
            || !ordinal_match(
                (current - first) / (7 * DAY_MS) + 1,
                (next - first) / (7 * DAY_MS),
                &rule.week_numbers,
            )
        {
            return false;
        }
    }
    if !rule.weekdays.is_empty()
        && !rule.weekdays.iter().any(|weekday| {
            if wall_weekday(date) != weekday.day {
                return false;
            }
            let Some(ordinal) = weekday.ordinal else {
                return true;
            };
            let (position, length) = if rule.freq == Freq::Monthly || !rule.months.is_empty() {
                (date.day, days_in_month(date.year, date.month))
            } else {
                (year_day, year_length)
            };
            if ordinal > 0 {
                (position - 1) / 7 + 1 == ordinal
            } else {
                (length - position) / 7 + 1 == -ordinal
            }
        })
    {
        return false;
    }
    // Missing date selectors inherit DTSTART's corresponding fields, per
    // RFC 5545 section 3.3.10. Explicit selectors expand within the period.
    let explicit_day = !rule.weekdays.is_empty()
        || !rule.month_days.is_empty()
        || !rule.year_days.is_empty()
        || !rule.week_numbers.is_empty();
    match rule.freq {
        Freq::Weekly if rule.weekdays.is_empty() => wall_weekday(date) == wall_weekday(initial),
        Freq::Monthly if !explicit_day => date.day == initial.day,
        Freq::Yearly if !explicit_day => {
            date.day == initial.day && (!rule.months.is_empty() || date.month == initial.month)
        }
        _ => true,
    }
}

fn dates(initial: WallTime, anchor: WallTime, rule: &ParsedRrule) -> Vec<WallTime> {
    let (first, length) = match rule.freq {
        Freq::Yearly if !rule.week_numbers.is_empty() => {
            let first = week_one(anchor.year, rule.week_start);
            let days = (wall_epoch(week_one(anchor.year + 1, rule.week_start)) - wall_epoch(first))
                / DAY_MS;
            (first, days)
        }
        Freq::Yearly => (
            jan_first(anchor.year),
            (wall_epoch(jan_first(anchor.year + 1)) - wall_epoch(jan_first(anchor.year))) / DAY_MS,
        ),
        Freq::Monthly => (
            WallTime {
                day: 1,
                ..midnight(anchor)
            },
            days_in_month(anchor.year, anchor.month),
        ),
        Freq::Weekly => (
            add_wall_days(
                midnight(anchor),
                -(wall_weekday(anchor) - rule.week_start).rem_euclid(7),
            ),
            7,
        ),
        _ => (midnight(anchor), 1),
    };
    (0..length)
        .map(|day| add_wall_days(first, day))
        .filter(|date| date_matches(*date, initial, anchor.year, rule))
        .collect()
}

fn times(values: &[i64], initial: i64, anchor: i64, expands: bool) -> Vec<i64> {
    if expands {
        if values.is_empty() {
            vec![initial]
        } else {
            values.to_vec()
        }
    } else if values.is_empty() || values.contains(&anchor) {
        vec![anchor]
    } else {
        Vec::new()
    }
}

pub(super) struct Candidates {
    dates: Vec<WallTime>,
    hours: Vec<i64>,
    minutes: Vec<i64>,
    seconds: Vec<i64>,
    millisecond: i64,
    positions: Vec<usize>,
    next: usize,
    length: usize,
}

impl Candidates {
    pub(super) fn new(
        initial: WallTime,
        anchor: WallTime,
        rule: &ParsedRrule,
        all_day: bool,
    ) -> Self {
        let dates = dates(initial, anchor, rule);
        let hours = if all_day {
            vec![0]
        } else {
            times(
                &rule.hours,
                initial.hour,
                anchor.hour,
                rule.freq >= Freq::Daily,
            )
        };
        let minutes = if all_day {
            vec![0]
        } else {
            times(
                &rule.minutes,
                initial.minute,
                anchor.minute,
                rule.freq >= Freq::Hourly,
            )
        };
        let seconds = if all_day {
            vec![0]
        } else {
            times(
                &rule.seconds,
                initial.second,
                anchor.second,
                rule.freq >= Freq::Minutely,
            )
        };
        let length = dates.len() * hours.len() * minutes.len() * seconds.len();
        let mut positions: Vec<usize> = rule
            .set_positions
            .iter()
            .filter_map(|position| {
                let index = if *position > 0 {
                    position - 1
                } else {
                    length as i64 + position
                };
                (index >= 0 && index < length as i64).then_some(index as usize)
            })
            .collect();
        positions.sort_unstable();
        positions.dedup();
        let length = if rule.set_positions.is_empty() {
            length
        } else {
            positions.len()
        };
        Self {
            dates,
            hours,
            minutes,
            seconds,
            millisecond: if all_day { 0 } else { initial.millisecond },
            positions,
            next: 0,
            length,
        }
    }
}

impl Candidates {
    fn at(&self, index: usize) -> WallTime {
        let mut index = if self.positions.is_empty() {
            index
        } else {
            self.positions[index]
        };
        let second = self.seconds[index % self.seconds.len()];
        let index2 = index / self.seconds.len();
        let minute = self.minutes[index2 % self.minutes.len()];
        index = index2 / self.minutes.len();
        let hour = self.hours[index % self.hours.len()];
        index /= self.hours.len();
        WallTime {
            hour,
            minute,
            second,
            millisecond: self.millisecond,
            ..self.dates[index]
        }
    }
    fn rank(&self, epoch: i64) -> usize {
        let (mut low, mut high) = (0, self.length);
        while low < high {
            let mid = low + (high - low) / 2;
            if wall_epoch(self.at(mid)) < epoch {
                low = mid + 1;
            } else {
                high = mid;
            }
        }
        low
    }
    pub(super) fn skip_before(&mut self, epoch: i64) -> i64 {
        let next = self.rank(epoch).max(self.next);
        let skipped = next - self.next;
        self.next = next;
        skipped as i64
    }
    pub(super) fn count_between(&self, from: i64, to: i64) -> i64 {
        self.rank(to).saturating_sub(self.rank(from)) as i64
    }
}

impl Iterator for Candidates {
    type Item = WallTime;
    fn next(&mut self) -> Option<Self::Item> {
        if self.next >= self.length {
            return None;
        }
        let wall = self.at(self.next);
        self.next += 1;
        Some(wall)
    }
}

/// Jump an empty subdaily period to the next admissible day/hour/minute,
/// preserving the interval's phase relative to DTSTART. A SECONDLY rule
/// limited to December therefore visits days, not 28 million rejected seconds.
pub(super) fn next_index(
    initial: WallTime,
    anchor: WallTime,
    rule: &ParsedRrule,
    index: i64,
) -> i64 {
    let Some(step) = quantum(rule.freq).and_then(|q| q.checked_mul(rule.interval)) else {
        return index + 1;
    };
    if rule.freq >= Freq::Daily {
        return index + 1;
    }
    let target = if !date_matches(anchor, initial, anchor.year, rule) {
        Some(wall_epoch(add_wall_days(midnight(anchor), 1)))
    } else if !rule.hours.is_empty() && !rule.hours.contains(&anchor.hour) {
        Some(
            wall_epoch(WallTime {
                minute: 0,
                second: 0,
                millisecond: 0,
                ..anchor
            }) + 3_600_000,
        )
    } else if rule.freq <= Freq::Minutely
        && !rule.minutes.is_empty()
        && !rule.minutes.contains(&anchor.minute)
    {
        Some(
            wall_epoch(WallTime {
                second: 0,
                millisecond: 0,
                ..anchor
            }) + 60_000,
        )
    } else {
        None
    };
    target.map_or(index + 1, |target| {
        ((target - wall_epoch(initial) + step - 1) / step).max(index + 1)
    })
}

/// Earliest possible civil candidate in this period; used to stop empty rules
/// at the query boundary, including week-number years crossing December.
pub(super) fn lower_bound(anchor: WallTime, rule: &ParsedRrule) -> WallTime {
    match rule.freq {
        Freq::Yearly if !rule.week_numbers.is_empty() => week_one(anchor.year, rule.week_start),
        Freq::Yearly => jan_first(anchor.year),
        Freq::Monthly => midnight(WallTime { day: 1, ..anchor }),
        Freq::Weekly => add_wall_days(
            midnight(anchor),
            -(wall_weekday(anchor) - rule.week_start).rem_euclid(7),
        ),
        Freq::Daily => midnight(anchor),
        Freq::Hourly => WallTime {
            minute: 0,
            second: 0,
            millisecond: 0,
            ..anchor
        },
        Freq::Minutely => WallTime {
            second: 0,
            millisecond: 0,
            ..anchor
        },
        Freq::Secondly => WallTime {
            millisecond: 0,
            ..anchor
        },
    }
}
