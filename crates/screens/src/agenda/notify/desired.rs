//! THE DESIRED SET: every notification the phone should hold, as a pure
//! function of what the core read. Nothing here reads a clock (`now_local` is
//! the core's), a vault or a screen, so the whole rule is tested with built
//! messages and a pinned now.
//!
//! A day has no moment: a task whose due is a date, and an all-day event, sound at 09:00 that
//! day (`remind_at_local` already says so for the task) and are never given that time. A repeating task contributes its one next reminder (the core already
//! computed it from the effective due), a repeating event each occurrence of
//! the window.

use std::collections::BTreeSet;
use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_vault::time::{FireZone, parse_civil_ms};

use super::retention;
use crate::kit::civil;
use crate::kit::permission::ExtraNotice;
use crate::strings::agenda_reminders as reminders_words;
use crate::strings::{
    Locale, agenda as agenda_words, agenda_notify as words, fill, shared, task as task_words,
};

/// The furthest ahead a reminder is looked for, in days. THE HORIZON IS FILLED BY TIME, NOT BY A
/// FIXED WINDOW: the soonest reminders are held until the cap is full, and when more remain beyond
/// it the last slot says reminders are paused until Centraid is opened (#1188, A4).
pub const HORIZON_DAYS: i64 = 90;
/// The id of that last notification.
const PAUSED: &str = "paused";
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
    /// The phone clock format changes words, never the desired instant.
    pub hour_cycle: civil::HourCycle,
    /// The core's now, `YYYY-MM-DDTHH:MM`, in `zone`.
    pub now_local: &'a str,
    /// Every task of the reminders answer, each once ([`flatten`]).
    pub tasks: &'a [wire::AgendaTask],
    pub projects: &'a [wire::AgendaTaskProject],
    pub events: &'a [wire::AgendaEvent],
    pub calendars: &'a [wire::AgendaCalendar],
    /// What other screens want held through this service (`kit::permission::AlertBoard`), soonest
    /// first, and the delivered ids they still want.
    pub extra: &'a [ExtraNotice],
    pub extra_wanted: &'a [String],
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
    /// For the DELIVERED reading ([`live`]): now, so an event that has ended is not wanted.
    ongoing_at: Option<i64>,
}

impl Window {
    fn holds(&self, ms: i64) -> bool {
        (self.from..=self.to).contains(&ms)
    }
}

/// How far back the service reads events for the delivered reading, in days. A bound on the READ
/// only: an event running longer keeps its banner (the loader keeps what is still running), and a
/// task reminder until its task is resolved (the newest `LIVE_CAP`; an older banner is not named
/// and goes).
pub const LIVE_DAYS: i64 = 2;
/// The most delivered ids named at once.
pub const LIVE_CAP: usize = 64;

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
        to: now + HORIZON_DAYS * DAY_MS,
        ongoing_at: None,
    };
    let mut all = tasks(inputs, &zone, &window);
    all.extend(events(inputs, &zone, &window));
    all.sort_by(|a, b| (a.fire_at_ms, &a.notification_id).cmp(&(b.fire_at_ms, &b.notification_id)));
    all.dedup_by(|a, b| a.notification_id == b.notification_id);
    // THE OTHER PRODUCERS' SLOTS ARE THEIR OWN: agenda fill never starves them.
    let extra = extras(inputs, &zone, now);
    let room = CAP - extra.len();
    if all.len() > room {
        // MORE REMAIN THAN THE PHONE CAN HOLD: the last slot says so, at the moment the last
        // reminder it holds would have sounded, so the member learns reminders have stopped
        // before one is missed. Opening Centraid brings them back.
        all.truncate(room - 1);
        if let Some(last) = all.last() {
            let locale = inputs.locale;
            let paused = pending(
                &zone,
                THREAD,
                format!("{PAUSED}|{}", inputs.vault_id),
                last.fire_at_ms,
                reminders_words::paused_title(locale),
                reminders_words::paused_body(locale),
                "",
            );
            all.push(paused);
        }
    }
    all.extend(extra);
    // The paused notice comes after the reminder whose moment it shares.
    all.sort_by_key(|n| {
        (
            n.fire_at_ms,
            n.notification_id.starts_with("paused|"),
            n.notification_id.clone(),
        )
    });
    all
}

/// The most slots of the cap other producers' notices take, kept for them when they exist (the stale-backup warnings, #1188).
pub const EXTRA_RESERVE: usize = 2;

fn extras(inputs: &Inputs, zone: &FireZone, now: i64) -> Vec<wire::PendingNotification> {
    inputs
        .extra
        .iter()
        .filter(|notice| notice.fire_at_ms >= now)
        .take(EXTRA_RESERVE)
        .map(|notice| {
            let mut held = pending(
                zone,
                notice.channel.thread(),
                notice.id.clone(),
                notice.fire_at_ms,
                notice.title.clone(),
                notice.body.clone(),
                "",
            );
            held.channel_id = notice.channel.id().to_owned();
            held
        })
        .collect()
}

/// WITH DETAILS OFF (#1188, NA3) a reminder or an event notification says only that one is due. The
/// buttons stay, the ids and moments stay; the backup warnings, the receipt and the paused notice
/// say nothing of the member's items and are left as they are.
pub fn redact(set: &mut [wire::PendingNotification], locale: Locale) {
    for held in set {
        let (title, private) = if held.notification_id.starts_with("task|") {
            (words::private_task_title(locale), true)
        } else if held.notification_id.starts_with("event|") {
            (words::private_event_title(locale), true)
        } else {
            (String::new(), false)
        };
        if private {
            held.title = title;
            held.body = words::private_body(locale);
        }
    }
}

/// THE DELIVERED READING (#1188, A2): the ids of reminders that have already fired and are still
/// wanted. TIME PASSING NEVER REMOVES A DELIVERED REMINDER; ONLY RESOLVING THE ITEM DOES: a task
/// done, moved or deleted, an event cancelled, moved, deleted or over. A shell keeps a delivered
/// notification while its id is in the set or here, and removes it otherwise.
#[must_use]
pub fn live(inputs: &Inputs) -> Vec<String> {
    let Ok(zone) = FireZone::named(inputs.zone) else {
        return Vec::new();
    };
    let Some(now) = parse_civil_ms(inputs.now_local, &zone) else {
        return Vec::new();
    };
    let window = Window {
        // No lower bound: the index names only what may still be live (see `alerts::advance`).
        from: i64::MIN,
        to: now,
        ongoing_at: Some(now),
    };
    let mut ids: Vec<(i64, String)> = inputs
        .extra_wanted
        .iter()
        .map(|id| (i64::MAX, id.clone()))
        .chain(
            tasks(inputs, &zone, &window)
                .into_iter()
                .chain(events(inputs, &zone, &window))
                .map(|n| (n.fire_at_ms, n.notification_id)),
        )
        .collect();
    // The newest first, so the cap keeps what is most likely on the screen.
    ids.sort_by(|a, b| b.cmp(a));
    ids.dedup_by(|a, b| a.1 == b.1);
    ids.truncate(LIVE_CAP);
    ids.into_iter().map(|(_, id)| id).collect()
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
        channel_id: String::new(),
        source_fingerprint: String::new(),
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
        let mut notice = pending(
            zone,
            THREAD,
            format!("task|{}|{}|{fire_local}", inputs.vault_id, task.task_id),
            fire_ms,
            titled(task_words::untitled, locale, &task.title),
            body(
                &when(
                    locale,
                    &day,
                    &civil::time_for(locale, &task.due_time, inputs.hour_cycle),
                ),
                &list,
            ),
            if task.repeats { TASK_REPEATING } else { TASK },
        );
        notice.source_fingerprint = retention::task_fingerprint(task);
        out.push(notice);
    }
    out
}

fn events(inputs: &Inputs, zone: &FireZone, window: &Window) -> Vec<wire::PendingNotification> {
    let locale = inputs.locale;
    let mut out = Vec::new();
    for event in inputs.events {
        if event.status.as_deref() == Some("cancelled") {
            continue;
        }
        // A DAY HAS NO MOMENT (#1188, NA6): an all-day event's alert sounds at 09:00 that day,
        // wherever the member is, and its lead times mean nothing (the first stands for "on the
        // day"). The event itself keeps no time.
        let day_alert = event.all_day;
        let start_text = if day_alert {
            format!(
                "{}T{}",
                event.local_start.get(..10).unwrap_or_default(),
                centraid_vault::alerts::DAY_ALERT_TIME
            )
        } else {
            event.local_start.clone()
        };
        let Some(start_ms) = parse_civil_ms(&start_text, zone) else {
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
        let reminders = if day_alert {
            &event.reminders[..event.reminders.len().min(1)]
        } else {
            &event.reminders[..]
        };
        for reminder in reminders {
            let minutes = reminder.minutes_before;
            let fire_ms = if day_alert {
                start_ms
            } else {
                start_ms - minutes * MINUTE_MS
            };
            if !window.holds(fire_ms) {
                continue;
            }
            if let Some(now) = window.ongoing_at {
                // AN EVENT THAT IS OVER IS RESOLVED: its reminder is not wanted on the screen.
                let end_text = if event.local_end.len() == 10 {
                    format!("{}T00:00", event.local_end)
                } else {
                    event.local_end.clone()
                };
                let end = parse_civil_ms(&end_text, zone).unwrap_or(start_ms);
                if end <= now {
                    continue;
                }
            }
            let fire_local = local_of(zone, fire_ms);
            let fire_day = fire_local.get(..10).unwrap_or_default();
            let start_day = event.local_start.get(..10).unwrap_or_default();
            let day = civil::relative_day(locale, start_day, fire_day);
            let mut notice = pending(
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
                    &when(
                        locale,
                        &day,
                        &if day_alert {
                            String::new()
                        } else {
                            civil::clock_for(locale, &event.local_start, inputs.hour_cycle)
                        },
                    ),
                    &place,
                ),
                "",
            );
            notice.source_fingerprint = retention::event_fingerprint(event, minutes);
            out.push(notice);
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
