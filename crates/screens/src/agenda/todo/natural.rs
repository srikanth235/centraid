//! THE DATE CHIP'S READING (#1173 Wave 3): what a quick add's typed words will
//! save as, before the member taps Add.
//!
//! The parse is the app crate's own (`nl_date`), a pure function of the words
//! and the core's `now_local`; the clock is never the device's. A reading is a
//! preview, never a write: it becomes a task only when the member taps Add with
//! the chip still showing, and the chip's × keeps the typed words as the title.
//!
//! The chip's words reuse the rows' day wording (`civil::relative_day`: Today,
//! Tomorrow, then `Fri 4 December`) and the phone's clock (`civil::time_for`,
//! 12 or 24 hour), so a chip reads exactly as the row it becomes will.

use centraid_api_proto::core_v1 as wire;
use centraid_apps_agenda::nl_date::{self, Parsed, Repeat, Weekday};

use crate::catalog::load::agenda as query;
use crate::kit::civil::{self, HourCycle};
use crate::kit::read::{Reading as Answered, read};
use crate::screen::Ctx;
use crate::strings::{Locale, agenda as words, agenda_reminders as reminders, fill};

/// A phrase read off the typed words, and the chip that names it.
#[derive(Clone, Debug)]
pub struct Reading {
    parsed: Parsed,
    chip: wire::QuickAddChip,
}

/// What an add sends: the title that is left, the due and the repeat rule, and
/// whether the due is a wall clock (it then names the device's zone).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Fields {
    pub title: String,
    /// `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM:00`; empty is undated.
    pub due: String,
    pub rule: Option<String>,
    pub timed: bool,
}

impl Fields {
    /// The words as typed: no day, no repeat.
    #[must_use]
    pub fn bare(title: &str) -> Self {
        Self {
            title: title.to_owned(),
            ..Self::default()
        }
    }
}

impl Reading {
    /// The chip the view draws.
    #[must_use]
    pub fn chip(&self) -> wire::QuickAddChip {
        self.chip.clone()
    }

    /// The fields to save. A repeat never goes without a due: the parser always
    /// dates one, and a reading that did not is no reading ([`read_words`]).
    #[must_use]
    pub fn fields(&self) -> Fields {
        let due = self.parsed.when.as_ref();
        Fields {
            title: self.parsed.title.trim().to_owned(),
            due: due.map(nl_date::When::due).unwrap_or_default(),
            rule: self
                .parsed
                .repeat
                .as_ref()
                .filter(|_| due.is_some())
                .map(Repeat::rule),
            timed: due.is_some_and(|when| when.time.is_some()),
        }
    }
}

/// The core's `now_local` (`YYYY-MM-DDTHH:MM`, in the member's zone), read with
/// no bounds: the cheap answer. `None` when the core would not say, and then
/// nothing is read and an add is the words as typed.
#[must_use]
pub fn core_now(ctx: &Ctx) -> Option<String> {
    match read(ctx, query::DayContext::default(), |answer| match answer {
        wire::app_query_response::Answer::AgendaDayContext(context) => Some(context),
        _ => None,
    }) {
        Answered::Data(context) if nl_date::Now::parse(&context.now_local).is_some() => {
            Some(context.now_local)
        }
        _ => None,
    }
}

/// What `text` says, read against `now_local`; `None` when no phrase was read
/// (or no clock is held).
#[must_use]
pub fn read_words(
    locale: Locale,
    cycle: HourCycle,
    text: &str,
    now_local: &str,
) -> Option<Reading> {
    let now = nl_date::Now::parse(now_local)?;
    let parsed = nl_date::parse(text, &now);
    let title = parsed.title.trim().to_owned();
    let valid = parsed.matched()
        && !title.is_empty()
        // A repeat without a day is never offered.
        && (parsed.repeat.is_none() || parsed.when.is_some());
    if !valid {
        return None;
    }
    let today = now_local.get(..10).unwrap_or_default();
    let label = label_of(locale, cycle, &parsed, today);
    let spoken = if parsed.repeat.is_some() {
        fill(
            &reminders::quick_chip_spoken_repeats(locale),
            &[("when", &label), ("title", &title)],
        )
    } else {
        fill(
            &reminders::quick_chip_spoken_due(locale),
            &[("when", &label), ("title", &title)],
        )
    };
    let chip = wire::QuickAddChip {
        repeats: parsed.repeat.is_some(),
        label,
        title,
        dismiss_label: reminders::quick_chip_keep_text(locale),
        spoken,
    };
    Some(Reading { parsed, chip })
}

/// `Tomorrow, 09:00`, `Fri 4 December`, `Every Monday, 09:00`, `Every day`.
fn label_of(locale: Locale, cycle: HourCycle, parsed: &Parsed, today: &str) -> String {
    let time = parsed
        .when
        .as_ref()
        .and_then(|when| when.time)
        .map(|(hour, minute)| civil::time_for(locale, &format!("{hour:02}:{minute:02}"), cycle));
    let head = match (&parsed.repeat, &parsed.when) {
        (Some(repeat), _) => repeat_words(locale, repeat),
        (None, Some(when)) => civil::relative_day(locale, &when.day, today),
        (None, None) => String::new(),
    };
    match time {
        Some(time) => fill(
            &reminders::quick_chip_day_time(locale),
            &[("day", &head), ("time", &time)],
        ),
        None => head,
    }
}

fn repeat_words(locale: Locale, repeat: &Repeat) -> String {
    match repeat {
        Repeat::Daily => reminders::quick_chip_every_day(locale),
        Repeat::Weekdays => reminders::quick_chip_every_work_day(locale),
        Repeat::Monthly => reminders::quick_chip_every_month(locale),
        Repeat::Yearly => reminders::quick_chip_every_year(locale),
        Repeat::Weekly(day) => fill(
            &reminders::quick_chip_every_named(locale),
            &[("weekday", &weekday_name(locale, *day))],
        ),
    }
}

fn weekday_name(locale: Locale, day: Weekday) -> String {
    match day {
        Weekday::Mon => words::weekday_full_mon(locale),
        Weekday::Tue => words::weekday_full_tue(locale),
        Weekday::Wed => words::weekday_full_wed(locale),
        Weekday::Thu => words::weekday_full_thu(locale),
        Weekday::Fri => words::weekday_full_fri(locale),
        Weekday::Sat => words::weekday_full_sat(locale),
        Weekday::Sun => words::weekday_full_sun(locale),
    }
}

/// A quick add's held clock and dismissal: the shared half of both bars.
#[derive(Clone, Debug, Default)]
pub struct Chipper {
    /// The core's `now_local`; empty when none is held (no chip, a bare add).
    now: String,
    /// The words the member dismissed the chip for (trimmed).
    dismissed: String,
}

impl Chipper {
    /// Hold the core's clock again (the bar opened, the page loaded, an add is
    /// about to be sent).
    pub fn hold(&mut self, ctx: &Ctx) {
        self.now = core_now(ctx).unwrap_or_default();
    }

    /// The × for `words`: they save as typed until the phrase changes.
    pub fn dismiss(&mut self, words: &str) {
        self.dismissed = words.trim().to_owned();
    }

    /// Forget the dismissal: the words are gone. The clock stays held for the
    /// next add on the same open bar.
    pub fn clear(&mut self) {
        self.dismissed.clear();
    }

    /// The reading of `words`, unless the chip was dismissed for exactly them.
    #[must_use]
    pub fn reading(&self, locale: Locale, cycle: HourCycle, words: &str) -> Option<Reading> {
        if self.now.is_empty() || words.trim() == self.dismissed {
            return None;
        }
        read_words(locale, cycle, words, &self.now)
    }

    /// What an add sends for `words`, on a clock read just now.
    pub fn fields(&mut self, ctx: &Ctx, words: &str) -> Fields {
        self.hold(ctx);
        self.reading(ctx.locale(), ctx.hour_cycle(), words)
            .map_or_else(|| Fields::bare(words.trim()), |reading| reading.fields())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chip(cycle: HourCycle) -> String {
        read_words(
            Locale::En,
            cycle,
            "Call Mum tomorrow at 15:30",
            "2026-03-11T08:00",
        )
        .map(|reading| reading.chip().label)
        .unwrap_or_default()
    }

    #[test]
    fn the_chip_words_its_time_as_the_phone_does() {
        assert_eq!(chip(HourCycle::H24), "Tomorrow, 15:30");
        assert_eq!(chip(HourCycle::H12), "Tomorrow, 3:30 PM");
    }
}
