//! THE EDITOR'S DRAFT: the member's values as the pickers bind them, and the
//! civil arithmetic on them. Pure: every day is a `YYYY-MM-DD` and every time an
//! `HH:MM` on the device's wall clock; no zone is read here (the save names the
//! device's zone beside the wall clock and the core resolves the instant).

use centraid_api_proto::core_v1 as wire;

use crate::kit::civil;

pub type Draft = wire::AgendaDraft;

pub const REPEAT_NONE: &str = "none";
pub const REPEAT_DAILY: &str = "daily";
pub const REPEAT_WEEKLY: &str = "weekly";
pub const REPEAT_BIWEEKLY: &str = "biweekly";
pub const REPEAT_MONTHLY: &str = "monthly";
pub const REPEAT_YEARLY: &str = "yearly";
pub const REPEAT_CUSTOM: &str = "custom";
pub const REMINDER_NONE: &str = "none";

/// The rule each preset writes, in the order the sheet lists them. The member
/// reads the label, never these.
pub const RULES: [(&str, &str); 5] = [
    (REPEAT_DAILY, "FREQ=DAILY"),
    (REPEAT_WEEKLY, "FREQ=WEEKLY"),
    (REPEAT_BIWEEKLY, "FREQ=WEEKLY;INTERVAL=2"),
    (REPEAT_MONTHLY, "FREQ=MONTHLY"),
    (REPEAT_YEARLY, "FREQ=YEARLY"),
];

/// The reminder leads offered, in minutes.
pub const REMINDERS: [i64; 5] = [0, 10, 30, 60, 1440];

const DAY: usize = 10;
const MINUTES_PER_DAY: i64 = 1440;
const HOUR: i64 = 60;
const HALF_HOUR: i64 = 30;
const DEFAULT_START: &str = "09:00";
const DEFAULT_END: &str = "10:00";

/// The rule a preset key writes, or `None` for "does not repeat" and a rule the
/// editor keeps as it is.
#[must_use]
pub fn rule_of(key: &str) -> Option<&'static str> {
    RULES
        .iter()
        .find(|(preset, _)| *preset == key)
        .map(|(_, rule)| *rule)
}

/// Minutes since 1970-01-01T00:00 on the wall clock, or `None` for a malformed pair.
#[must_use]
pub fn minutes_of(day: &str, time: &str) -> Option<i64> {
    Some(civil::epoch_day_of(day)? * MINUTES_PER_DAY + clock_minutes(time)?)
}

/// Minutes since midnight for `HH:MM`, or `None` for anything else.
#[must_use]
pub fn clock_minutes(time: &str) -> Option<i64> {
    let bytes = time.as_bytes();
    if bytes.len() != 5 || bytes[2] != b':' {
        return None;
    }
    let hours: i64 = time.get(0..2)?.parse().ok()?;
    let minutes: i64 = time.get(3..5)?.parse().ok()?;
    ((0..24).contains(&hours) && (0..60).contains(&minutes)).then_some(hours * HOUR + minutes)
}

/// The day and `HH:MM` that many minutes since 1970 are.
#[must_use]
pub fn from_minutes(minutes: i64) -> (String, String) {
    let day = minutes.div_euclid(MINUTES_PER_DAY);
    let clock = minutes.rem_euclid(MINUTES_PER_DAY);
    (
        civil::civil_day_of(day),
        format!("{:02}:{:02}", clock / HOUR, clock % HOUR),
    )
}

/// ALL-DAY ON keeps the days and makes the end no earlier than the start; OFF
/// gives a timed event its times back, or an hour at 09:00.
#[must_use]
pub fn all_day(draft: &Draft, on: bool) -> Draft {
    if on {
        return Draft {
            all_day: true,
            end_day: draft.end_day.clone().max(draft.start_day.clone()),
            ..draft.clone()
        };
    }
    let mut timed = Draft {
        all_day: false,
        start_time: if draft.start_time.is_empty() {
            DEFAULT_START.to_owned()
        } else {
            draft.start_time.clone()
        },
        end_time: if draft.end_time.is_empty() {
            DEFAULT_END.to_owned()
        } else {
            draft.end_time.clone()
        },
        ..draft.clone()
    };
    let Some(start) = minutes_of(&timed.start_day, &timed.start_time) else {
        return timed;
    };
    let end = minutes_of(&timed.end_day, &timed.end_time);
    if end.is_none_or(|end| end <= start) {
        (timed.end_day, timed.end_time) = from_minutes(start + HOUR);
    }
    timed
}

/// A NEW START MOVES THE END WITH IT, keeping the length: a meeting moved to
/// the afternoon is still an hour long, and an end left behind would be an
/// event that ends before it starts. `None` for a day that is not one.
#[must_use]
pub fn move_start(draft: &Draft, day: &str, time: &str) -> Option<Draft> {
    let moved_to = civil::epoch_day_of(day)?;
    if draft.all_day {
        let shift = moved_to - civil::epoch_day_of(&draft.start_day)?;
        let end = civil::plus_days(&draft.end_day, shift).unwrap_or_else(|| day.to_owned());
        return Some(Draft {
            start_day: day.to_owned(),
            start_time: if clock_minutes(time).is_some() {
                time.to_owned()
            } else {
                draft.start_time.clone()
            },
            end_day: end,
            ..draft.clone()
        });
    }
    let new_time = if clock_minutes(time).is_some() {
        time
    } else {
        &draft.start_time
    };
    let before = minutes_of(&draft.start_day, &draft.start_time);
    let after = minutes_of(day, new_time)?;
    let end = minutes_of(&draft.end_day, &draft.end_time);
    let moved = match (before, end) {
        (Some(before), Some(end)) => from_minutes(end + (after - before)),
        _ => from_minutes(after + HOUR),
    };
    Some(Draft {
        start_day: day.to_owned(),
        start_time: new_time.to_owned(),
        end_day: moved.0,
        end_time: moved.1,
        ..draft.clone()
    })
}

/// The end the end picker chose. `None` for a day that is not one.
#[must_use]
pub fn set_end(draft: &Draft, day: &str, time: &str) -> Option<Draft> {
    civil::epoch_day_of(day)?;
    Some(Draft {
        end_day: day.to_owned(),
        end_time: if clock_minutes(time).is_some() {
            time.to_owned()
        } else {
            draft.end_time.clone()
        },
        ..draft.clone()
    })
}

/// The draft's range is an event's: an end after the start, or an all-day end no earlier.
#[must_use]
pub fn range_is_whole(draft: &Draft) -> bool {
    if draft.all_day {
        return civil::epoch_day_of(&draft.start_day).is_some()
            && civil::epoch_day_of(&draft.end_day).is_some()
            && draft.end_day >= draft.start_day;
    }
    match (
        minutes_of(&draft.start_day, &draft.start_time),
        minutes_of(&draft.end_day, &draft.end_time),
    ) {
        (Some(start), Some(end)) => end > start,
        _ => false,
    }
}

/// A NEW EVENT'S DEFAULTS: on `day` (the route's), or the core's today; the
/// next half hour after now on today, else 09:00; an hour long; on the first
/// calendar.
#[must_use]
pub fn new_draft(day: &str, upcoming: &wire::AgendaUpcoming) -> Draft {
    let on = if day.is_empty() {
        upcoming.today.as_str()
    } else {
        day
    };
    let base = minutes_of(on, DEFAULT_START);
    let start = if on == upcoming.today {
        match (clock_minutes(&civil::clock(&upcoming.now_local)), base) {
            (Some(now), Some(_)) => civil::epoch_day_of(on)
                .map(|epoch| epoch * MINUTES_PER_DAY + (now / HALF_HOUR + 1) * HALF_HOUR),
            _ => base,
        }
    } else {
        base
    };
    let (start_day, start_time) =
        start.map_or_else(|| (on.to_owned(), DEFAULT_START.to_owned()), from_minutes);
    let (end_day, end_time) = start.map_or_else(
        || (on.to_owned(), DEFAULT_END.to_owned()),
        |at| from_minutes(at + HOUR),
    );
    Draft {
        start_day,
        start_time,
        end_day,
        end_time,
        calendar_id: upcoming
            .calendars
            .first()
            .map(|c| c.calendar_id.clone())
            .unwrap_or_default(),
        repeat_key: REPEAT_NONE.to_owned(),
        reminder_key: REMINDER_NONE.to_owned(),
        ..Draft::default()
    }
}

/// The values an occurrence has, as the editor binds them.
#[must_use]
pub fn draft_of(event: &wire::AgendaEvent) -> Draft {
    let start_day = event.local_start.get(..DAY).unwrap_or_default().to_owned();
    let start_time = Some(civil::clock(&event.local_start))
        .filter(|clock| !clock.is_empty())
        .unwrap_or_else(|| DEFAULT_START.to_owned());
    let (end_day, end_time) = if event.all_day {
        let last = if event.local_end.is_empty() {
            &event.local_start
        } else {
            &event.local_end
        };
        (
            last.get(..DAY).unwrap_or_default().to_owned(),
            DEFAULT_END.to_owned(),
        )
    } else if event.local_end.is_empty() {
        minutes_of(&start_day, &start_time).map_or_else(
            || (start_day.clone(), DEFAULT_END.to_owned()),
            |at| from_minutes(at + HOUR),
        )
    } else {
        (
            event.local_end.get(..DAY).unwrap_or_default().to_owned(),
            civil::clock(&event.local_end),
        )
    };
    Draft {
        title: event.summary.clone().unwrap_or_default(),
        notes: event.description.clone().unwrap_or_default(),
        all_day: event.all_day,
        start_day,
        start_time,
        end_day,
        end_time,
        calendar_id: event.calendar_id.clone().unwrap_or_default(),
        guest_ids: event
            .attendees
            .iter()
            .filter(|a| !a.is_you)
            .map(|a| a.party_id.clone())
            .collect(),
        repeat_key: repeat_key_of(event.rrule.as_deref()),
        reminder_key: event.reminders.first().map_or_else(
            || REMINDER_NONE.to_owned(),
            |reminder| reminder.minutes_before.to_string(),
        ),
        link: event.conferencing_uri.clone().unwrap_or_default(),
    }
}

/// A stored rule, as a preset key, or [`REPEAT_CUSTOM`], kept as it is.
#[must_use]
pub fn repeat_key_of(rrule: Option<&str>) -> String {
    let Some(rrule) = rrule.map(str::trim).filter(|rule| !rule.is_empty()) else {
        return REPEAT_NONE.to_owned();
    };
    let parts = |rule: &str| -> std::collections::BTreeSet<String> {
        rule.split(';')
            .filter(|part| !part.trim().is_empty())
            .map(str::to_owned)
            .collect()
    };
    let stored = parts(&rrule.to_uppercase());
    RULES
        .iter()
        .find(|(_, rule)| parts(rule) == stored)
        .map_or_else(|| REPEAT_CUSTOM.to_owned(), |(key, _)| (*key).to_owned())
}

/// A task's due, as `add-task` takes it: a bare day, or a floating local time.
#[must_use]
pub fn due_of(draft: &Draft) -> String {
    if draft.all_day {
        draft.start_day.clone()
    } else {
        format!("{}T{}", draft.start_day, draft.start_time)
    }
}

/// A DRAFT AS A KIND READS IT: a task opens All day (a bare date, so it lands
/// among the day's untimed rows); an event is timed again, with its end after
/// its start.
#[must_use]
pub fn shaped(draft: &Draft, kind: wire::AgendaEditorKind) -> Draft {
    all_day(draft, kind == wire::AgendaEditorKind::Task)
}

#[must_use]
pub fn times_changed(draft: &Draft, base: &Draft) -> bool {
    draft.all_day != base.all_day
        || draft.start_day != base.start_day
        || draft.end_day != base.end_day
        || (!draft.all_day
            && (draft.start_time != base.start_time || draft.end_time != base.end_time))
}

fn same_guests(draft: &Draft, base: &Draft) -> bool {
    fn set(draft: &Draft) -> std::collections::BTreeSet<&String> {
        draft.guest_ids.iter().collect()
    }
    set(draft) == set(base)
}

#[must_use]
pub fn guests_changed(draft: &Draft, base: &Draft) -> bool {
    !same_guests(draft, base)
}

/// Whether the draft changes what only the whole event has: its calendar, link,
/// reminder or guests.
#[must_use]
pub fn series_only(draft: &Draft, base: &Draft) -> bool {
    (draft.calendar_id != base.calendar_id && !draft.calendar_id.is_empty())
        || draft.link.trim() != base.link.trim()
        || draft.reminder_key != base.reminder_key
        || guests_changed(draft, base)
}

/// Whether the draft differs from the values as loaded.
#[must_use]
pub fn dirty(draft: &Draft, base: &Draft) -> bool {
    draft.title.trim() != base.title.trim()
        || draft.notes.trim() != base.notes.trim()
        || times_changed(draft, base)
        || draft.calendar_id != base.calendar_id
        || guests_changed(draft, base)
        || draft.repeat_key != base.repeat_key
        || draft.reminder_key != base.reminder_key
        || draft.link.trim() != base.link.trim()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn draft(start: (&str, &str), end: (&str, &str)) -> Draft {
        Draft {
            start_day: start.0.into(),
            start_time: start.1.into(),
            end_day: end.0.into(),
            end_time: end.1.into(),
            ..Draft::default()
        }
    }

    #[test]
    fn minutes_round_trip_across_midnight_and_reject_malformed_pairs() {
        let at = minutes_of("2026-06-15", "23:30").expect("a pair");
        assert_eq!(
            from_minutes(at + 60),
            ("2026-06-16".to_owned(), "00:30".to_owned())
        );
        assert_eq!(
            from_minutes(at),
            ("2026-06-15".to_owned(), "23:30".to_owned())
        );
        assert_eq!(minutes_of("June", "09:00"), None);
        assert_eq!(minutes_of("2026-06-15", "9"), None);
        assert_eq!(clock_minutes("24:00"), None);
        assert_eq!(clock_minutes("09:60"), None);
    }

    #[test]
    fn a_start_moves_the_end_with_it() {
        let moved = move_start(
            &draft(("2026-06-15", "10:00"), ("2026-06-15", "11:00")),
            "2026-06-15",
            "23:30",
        )
        .expect("a day");
        assert_eq!(
            (moved.end_day.as_str(), moved.end_time.as_str()),
            ("2026-06-16", "00:30")
        );
        assert_eq!(move_start(&moved, "June", "09:00"), None);
    }

    #[test]
    fn rules_name_their_presets_and_keep_what_they_cannot() {
        assert_eq!(
            repeat_key_of(Some("freq=weekly;interval=2")),
            REPEAT_BIWEEKLY
        );
        assert_eq!(
            repeat_key_of(Some("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR")),
            REPEAT_CUSTOM
        );
        assert_eq!(repeat_key_of(None), REPEAT_NONE);
        assert_eq!(repeat_key_of(Some("  ")), REPEAT_NONE);
    }

    #[test]
    fn all_day_off_restores_an_hour_after_a_start_that_would_end_first() {
        let on = all_day(
            &draft(("2026-06-15", "10:00"), ("2026-06-15", "09:00")),
            true,
        );
        assert!(on.all_day && on.end_day == "2026-06-15");
        let off = all_day(&on, false);
        assert!(range_is_whole(&off), "{off:?}");
    }
}
