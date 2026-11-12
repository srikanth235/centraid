//! THE DESIRED SET: every notification the phone should hold, as a pure
//! function of what the core read. Nothing here reads a clock (`now_local` is
//! the core's), a vault or a screen, so the whole rule is tested with built
//! messages and a pinned now.
//!
//! A moment is a moment: a task whose due is a date has no `remind_at_local`
//! and an all-day event has no start, so neither is ever given an invented
//! time. A repeating task contributes its one next reminder (the core already
//! computed it from the effective due), a repeating event each occurrence of
//! the window.

use std::collections::BTreeSet;
use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_vault::time::{FireZone, parse_civil_ms};

use crate::kit::civil;
use crate::strings::{
    Locale, agenda as agenda_words, agenda_notify as words, fill, shared, task as task_words,
};

/// How far ahead a reminder is scheduled, in days.
pub const WINDOW_DAYS: i64 = 14;
/// The most notifications held at once. iOS keeps at most 64 pending; the rest
/// is headroom for the receipt of a button just pressed.
pub const CAP: usize = 48;
/// What iOS keeps pending, all apps' notifications together.
pub const OS_PENDING_LIMIT: usize = 64;
/// What rides in the set beyond [`CAP`]: the receipt of the button just pressed. Everything pending
/// on iOS is this set (one scheduling place, `Notifications.swift`), so the budget is
/// `CAP + RECEIPTS`.
pub const RECEIPTS: usize = 1;
const _: () = assert!(CAP + RECEIPTS <= OS_PENDING_LIMIT);
/// The thread a reminder's notifications are grouped under (Reminders, round 10 of #1173).
pub const THREAD: &str = "reminders";
/// The thread an event's alerts are grouped under (Calendar).
pub const EVENT_THREAD: &str = "calendar";
/// A task's buttons are on this category; a repeating task's are not the same.
pub const TASK: &str = "task";
pub const TASK_REPEATING: &str = "task.repeating";
/// The category of the receipt of a button just pressed (it carries Undo).
pub const RECEIPT: &str = "receipt";

const DAY_MS: i64 = 86_400_000;
const MINUTE_MS: i64 = 60_000;
/// How long a set stays good when nothing moves it: the window slides, so it is
/// read again.
const REFRESH: Duration = Duration::from_secs(6 * 60 * 60);
/// The least a refresh waits, so a set full of near moments is not read in a loop.
const REFRESH_LEAST: Duration = Duration::from_secs(60);

/// What the core read, and the member's place.
pub struct Inputs<'a> {
    pub vault_id: &'a str,
    pub zone: &'a str,
    pub locale: Locale,
    /// The core's now, `YYYY-MM-DDTHH:MM`, in `zone`.
    pub now_local: &'a str,
    /// Every task of the reminders answer, each once ([`flatten`]).
    pub tasks: &'a [wire::AgendaTask],
    pub projects: &'a [wire::AgendaTaskProject],
    pub events: &'a [wire::AgendaEvent],
    pub calendars: &'a [wire::AgendaCalendar],
}

/// Every task of a board's groups and of their children, each once, the
/// children cleared off the copy.
#[must_use]
pub fn flatten(groups: &[wire::AgendaTaskGroup]) -> Vec<wire::AgendaTask> {
    fn walk(task: &wire::AgendaTask, seen: &mut BTreeSet<String>, out: &mut Vec<wire::AgendaTask>) {
        if seen.insert(task.task_id.clone()) {
            let mut flat = task.clone();
            flat.children.clear();
            out.push(flat);
        }
        for child in &task.children {
            walk(child, seen, out);
        }
    }
    let (mut seen, mut out) = (BTreeSet::new(), Vec::new());
    for group in groups {
        for task in &group.tasks {
            walk(task, &mut seen, &mut out);
        }
    }
    out
}

/// `YYYY-MM-DDTHH:MM` of an instant, in `zone`.
fn local_of(zone: &FireZone, ms: i64) -> String {
    let at = zone.zoned_parts(ms);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}",
        at.year, at.month, at.day, at.hour, at.minute
    )
}

/// `{day} at {time}`, or the day alone when there is no time.
fn when(locale: Locale, day: &str, time: &str) -> String {
    if time.is_empty() {
        day.to_owned()
    } else {
        fill(&words::at_time(locale), &[("day", day), ("time", time)])
    }
}

/// The second line: when it is for, then where it lives.
fn body(when: &str, place: &str) -> String {
    match (when.is_empty(), place.is_empty()) {
        (_, true) => when.to_owned(),
        (true, false) => place.to_owned(),
        (false, false) => format!("{when} · {place}"),
    }
}

/// The title, or `untitled` (the task's or the event's own word) when it is blank.
fn titled(untitled: fn(Locale) -> String, locale: Locale, title: &str) -> String {
    if title.trim().is_empty() {
        untitled(locale)
    } else {
        title.to_owned()
    }
}

struct Window {
    from: i64,
    to: i64,
}

impl Window {
    fn holds(&self, ms: i64) -> bool {
        (self.from..=self.to).contains(&ms)
    }
}

/// Everything the phone should hold, soonest first, at most [`CAP`].
#[must_use]
pub fn desired(inputs: &Inputs) -> Vec<wire::PendingNotification> {
    let Ok(zone) = FireZone::named(inputs.zone) else {
        return Vec::new();
    };
    let Some(now) = parse_civil_ms(inputs.now_local, &zone) else {
        return Vec::new();
    };
    let window = Window {
        from: now,
        to: now + WINDOW_DAYS * DAY_MS,
    };
    let mut all = tasks(inputs, &zone, &window);
    all.extend(events(inputs, &zone, &window));
    all.sort_by(|a, b| (a.fire_at_ms, &a.notification_id).cmp(&(b.fire_at_ms, &b.notification_id)));
    all.dedup_by(|a, b| a.notification_id == b.notification_id);
    all.truncate(CAP);
    all
}

fn pending(
    zone: &FireZone,
    thread: &str,
    id: String,
    fire_ms: i64,
    title: String,
    body: String,
    category: &str,
) -> wire::PendingNotification {
    wire::PendingNotification {
        notification_id: id,
        fire_local: local_of(zone, fire_ms),
        zone: zone.name().to_owned(),
        fire_at_ms: fire_ms,
        title,
        body,
        category_id: category.to_owned(),
        thread_id: thread.to_owned(),
        immediate: false,
    }
}

fn tasks(inputs: &Inputs, zone: &FireZone, window: &Window) -> Vec<wire::PendingNotification> {
    let locale = inputs.locale;
    let mut out = Vec::new();
    for task in inputs.tasks {
        if task.status != "open" || task.remind_at_local.is_empty() {
            continue;
        }
        let Some(fire_ms) = parse_civil_ms(&task.remind_at_local, zone) else {
            continue;
        };
        if !window.holds(fire_ms) {
            continue;
        }
        let fire_local = local_of(zone, fire_ms);
        // READ WHEN IT FIRES: "Today" is the day the notification arrives.
        let fire_day = fire_local.get(..10).unwrap_or_default();
        let day = if task.due_day.is_empty() {
            String::new()
        } else {
            civil::relative_day(locale, &task.due_day, fire_day)
        };
        let list = task
            .project_id
            .as_deref()
            .and_then(|id| inputs.projects.iter().find(|p| p.project_id == id))
            .map_or_else(|| task_words::inbox(locale), |p| p.name.clone());
        out.push(pending(
            zone,
            THREAD,
            format!("task|{}|{}|{fire_local}", inputs.vault_id, task.task_id),
            fire_ms,
            titled(task_words::untitled, locale, &task.title),
            body(&when(locale, &day, &task.due_time), &list),
            if task.repeats { TASK_REPEATING } else { TASK },
        ));
    }
    out
}

fn events(inputs: &Inputs, zone: &FireZone, window: &Window) -> Vec<wire::PendingNotification> {
    let locale = inputs.locale;
    let mut out = Vec::new();
    for event in inputs.events {
        // A DAY HAS NO MOMENT: an all-day event is never alerted, as a date-only task is not.
        if event.all_day || event.status.as_deref() == Some("cancelled") {
            continue;
        }
        let Some(start_ms) = parse_civil_ms(&event.local_start, zone) else {
            continue;
        };
        let place = event
            .location_name
            .as_deref()
            .filter(|name| !name.trim().is_empty())
            .map(str::to_owned)
            .or_else(|| {
                let id = event.calendar_id.as_deref()?;
                let calendar = inputs.calendars.iter().find(|c| c.calendar_id == id)?;
                calendar.name.clone().filter(|name| !name.trim().is_empty())
            })
            .unwrap_or_default();
        for reminder in &event.reminders {
            let minutes = reminder.minutes_before;
            let fire_ms = start_ms - minutes * MINUTE_MS;
            if !window.holds(fire_ms) {
                continue;
            }
            let fire_local = local_of(zone, fire_ms);
            let fire_day = fire_local.get(..10).unwrap_or_default();
            let start_day = event.local_start.get(..10).unwrap_or_default();
            let day = civil::relative_day(locale, start_day, fire_day);
            out.push(pending(
                zone,
                EVENT_THREAD,
                format!("event|{}|{}|{minutes}", inputs.vault_id, event.instance_key),
                fire_ms,
                titled(
                    agenda_words::untitled,
                    locale,
                    event.summary.as_deref().unwrap_or_default(),
                ),
                body(
                    &when(locale, &day, &civil::clock(&event.local_start)),
                    &place,
                ),
                "",
            ));
        }
    }
    out
}

/// The buttons a notification can carry.
#[must_use]
pub fn categories(locale: Locale) -> Vec<wire::NotificationCategory> {
    use wire::NotificationVerb as Verb;
    let action = |verb: Verb, label: String| wire::NotificationAction {
        verb: verb as i32,
        label,
    };
    vec![
        wire::NotificationCategory {
            category_id: TASK.to_owned(),
            actions: vec![
                action(Verb::Done, words::mark_done(locale)),
                action(Verb::SnoozeHour, words::snooze_hour(locale)),
                action(Verb::Tomorrow, shared::tomorrow(locale)),
            ],
        },
        // MOVING A REPEATING TASK'S DUE WOULD MOVE THE WHOLE SERIES.
        wire::NotificationCategory {
            category_id: TASK_REPEATING.to_owned(),
            actions: vec![action(Verb::Done, words::mark_done(locale))],
        },
        wire::NotificationCategory {
            category_id: RECEIPT.to_owned(),
            actions: vec![action(Verb::Undo, task_words::undo(locale))],
        },
    ]
}

/// How long until the set is read again: the window slides, and a set that hit
/// the cap is cut off at its last item, so it is read again when that arrives.
#[must_use]
pub fn refresh_after(set: &[wire::PendingNotification], now_ms: i64) -> Duration {
    let wait = match set.last() {
        Some(last) if set.len() >= CAP => {
            Duration::from_millis(u64::try_from(last.fire_at_ms - now_ms).unwrap_or(0))
        }
        _ => REFRESH,
    };
    wait.clamp(REFRESH_LEAST, REFRESH)
}

#[cfg(test)]
mod tests;
