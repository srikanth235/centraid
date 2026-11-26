//! WHAT A NOTIFICATION SAYS (app-plane §9): the catalogue's words for the core scheduler.

use centraid_core::notify::Words;
use centraid_vault::alerts::Notice;
use centraid_vault::time::recurrence::parse_instant_ms;
use centraid_vault::time::zone::FireZone;

use crate::kit::civil::{self, HourCycle};
use crate::strings::{Locale, fill, room as words};

pub struct Catalogue {
    pub locale: Locale,
    pub cycle: HourCycle,
}

impl Default for Catalogue {
    fn default() -> Self {
        Self {
            locale: Locale::En,
            cycle: HourCycle::of(false),
        }
    }
}

impl Catalogue {
    /// `(day, time)` of a notice's moment, as the member reads it: a zoned instant in their zone, a
    /// floating wall clock as it is, a date with no time.
    fn when(&self, notice: &Notice, zone: &str) -> String {
        let Some(at) = notice.at.as_deref() else {
            return String::new();
        };
        let (day, time) = match notice.timing.as_str() {
            "zoned" => {
                let Some(ms) = parse_instant_ms(at) else {
                    return String::new();
                };
                let Ok(zone) = FireZone::named(zone).or_else(|_| FireZone::named("UTC")) else {
                    return String::new();
                };
                let wall = zone.zoned_parts(ms);
                (
                    format!("{:04}-{:02}-{:02}", wall.year, wall.month, wall.day),
                    Some(format!("{:02}:{:02}", wall.hour, wall.minute)),
                )
            }
            "floating" => {
                let (day, time) = at.split_once('T').unwrap_or((at, ""));
                (day.to_owned(), (!time.is_empty()).then(|| time.to_owned()))
            }
            _ => (at.to_owned(), None),
        };
        let day_text = civil::short_date(self.locale, &day);
        match time {
            Some(time) => format!(
                "{day_text}, {}",
                civil::time_for(self.locale, &time, self.cycle)
            ),
            None => day_text,
        }
    }
}

impl centraid_core::device::widget::Words for Catalogue {
    fn title(&self) -> String {
        words::widget_today(self.locale)
    }

    fn empty(&self) -> String {
        words::widget_nothing(self.locale)
    }

    fn counts(&self, events: u64, tasks: u64) -> String {
        [
            (events > 0).then(|| words::widget_events(self.locale, events)),
            (tasks > 0).then(|| words::widget_tasks(self.locale, tasks)),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" · ")
    }
}

impl Words for Catalogue {
    fn alert(&self, notice: &Notice, zone: &str) -> (String, String) {
        let title = if notice.title.trim().is_empty() {
            words::notify_untitled(self.locale)
        } else {
            notice.title.clone()
        };
        let when = self.when(notice, zone);
        let body = match notice.kind.as_str() {
            "event" => fill(&words::notify_event_body(self.locale), &[("when", &when)]),
            "task" => fill(&words::notify_task_body(self.locale), &[("when", &when)]),
            _ => match notice.what.as_deref() {
                Some("birthday") => words::notify_birthday(self.locale),
                Some("anniversary") => words::notify_anniversary(self.locale),
                Some(label) if !label.is_empty() => label.to_owned(),
                _ => words::notify_date(self.locale),
            },
        };
        (title, body)
    }

    fn private(&self, kind: &str) -> (String, String) {
        let title = match kind {
            "event" => words::notify_private_event(self.locale),
            "task" => words::notify_private_task(self.locale),
            _ => words::notify_private_date(self.locale),
        };
        (title, words::notify_private_body(self.locale))
    }

    fn locker(&self) -> (String, String) {
        (words::notify_locker_title(self.locale), String::new())
    }

    fn done_label(&self) -> String {
        words::notify_done(self.locale)
    }

    fn snooze_label(&self) -> String {
        words::notify_snooze(self.locale)
    }

    fn channel_name(&self) -> String {
        words::notify_channel(self.locale)
    }

    fn backup_channel_name(&self) -> String {
        words::notify_backup_channel(self.locale)
    }
}
