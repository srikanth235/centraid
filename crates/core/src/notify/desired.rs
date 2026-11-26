//! THE DESIRED SET (app-plane §9): every notification the phone should hold, read from the
//! vault's alert index. The vault already holds each reminder's next firing, minus a `snooze`
//! (`centraid_vault::alerts`); this module only reads the soonest ones that fit the platform's
//! cap, words them and tells the shell which delivered ones are no longer wanted.
//!
//! A person's date and a Locker date fire at 09:00 local on the day; a Locker alert says only
//! that something in Locker expires soon, and names no item and no field.

use centraid_api_proto::core_v1 as wire;
use centraid_vault::alerts::{self, Alert, KEEP_PAST_MS, Notice, Timing};
use centraid_vault::clock::format_iso_ms;
use centraid_vault::rusqlite::{Connection, OptionalExtension};
use centraid_vault::time::recurrence::parse_instant_ms;
use centraid_vault::time::zone::{FireZone, parse_wall_iso, wall_epoch, wall_from_epoch};

use crate::device::open_url;
use crate::error::{CoreError, Result};

pub const HORIZON_DAYS: i64 = 90;
const DAY_MS: i64 = 86_400_000;
/// The most delivered ids named at once.
pub const LIVE_CAP: usize = 64;
/// What iOS keeps pending for one app; a shell that knows better says so at launch.
pub const DEFAULT_PENDING_CAP: usize = 64;
/// The slots of the cap kept for the backup's own notices.
pub const EXTRA_RESERVE: usize = 2;

pub const THREAD_REMINDERS: &str = "reminders";
pub const THREAD_CALENDAR: &str = "calendar";
pub const THREAD_BACKUP: &str = "backup";
pub const CHANNEL_BACKUP: &str = "backup";

/// The category of a reminder target's alerts: one per `reminder_target` kind (D4).
#[must_use]
pub fn category_of(kind: &str) -> String {
    format!("alert.{kind}")
}

/// The words a notification says. Every sentence is the catalogue's; the scheduler only picks one.
pub trait Words: Send + Sync {
    /// Title and body of an alert of an event, a task or a person's date.
    fn alert(&self, notice: &Notice) -> (String, String);
    /// Title and body when the member keeps details off: it says only that one is due.
    fn private(&self, kind: &str) -> (String, String);
    /// Title and body of a Locker alert: "An item in Locker expires soon", and nothing else.
    fn locker(&self) -> (String, String);
    fn done_label(&self) -> String;
    fn snooze_label(&self) -> String;
    fn channel_name(&self) -> String;
    fn backup_channel_name(&self) -> String;
}

/// A notice another producer wants held: the backup's stale warnings. A fixed instant, no
/// buttons.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Extra {
    pub id: String,
    pub backup: bool,
    pub fire_at_ms: i64,
    pub title: String,
    pub body: String,
    pub open_url: String,
}

pub struct Inputs<'a> {
    pub now_ms: i64,
    pub zone: &'a str,
    /// The most notifications the platform keeps pending, extras included.
    pub cap: usize,
    pub details: bool,
    pub words: &'a dyn Words,
    pub extras: &'a [Extra],
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Desired {
    /// Pending: soonest first, at most the cap.
    pub all: Vec<wire::PendingNotification>,
    /// Delivered ones still wanted: they fired inside the keep window and their item stands.
    pub live: Vec<String>,
}

/// The actions every category carries.
#[must_use]
pub fn categories(words: &dyn Words) -> Vec<wire::NotificationCategory> {
    let done = wire::NotificationAction {
        verb: wire::NotificationVerb::Done as i32,
        label: words.done_label(),
    };
    let snooze = wire::NotificationAction {
        verb: wire::NotificationVerb::SnoozeHour as i32,
        label: words.snooze_label(),
    };
    alerts::TARGET_KINDS
        .iter()
        .map(|kind| wire::NotificationCategory {
            category_id: category_of(kind),
            actions: if *kind == "task" {
                vec![done.clone(), snooze.clone()]
            } else {
                vec![snooze.clone()]
            },
        })
        .collect()
}

fn local_of(zone: &FireZone, ms: i64) -> String {
    let at = zone.zoned_parts(ms);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}",
        at.year, at.month, at.day, at.hour, at.minute
    )
}

fn floating_key(ms: i64) -> String {
    let wall = wall_from_epoch(ms);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}",
        wall.year, wall.month, wall.day, wall.hour, wall.minute
    )
}

/// The instant an alert fires.
fn fire_ms(alert: &Alert, zone: &FireZone) -> Option<i64> {
    match alert.timing {
        Timing::Fixed => parse_instant_ms(&alert.fire_key),
        Timing::Floating => {
            let wall = parse_wall_iso(&alert.fire_key)?;
            parse_instant_ms(&zone.resolve_wall_time_forward(wall).instant)
        }
    }
}

/// The stable id of one firing of one reminder.
#[must_use]
pub fn id_of(reminder_id: &str, fire_key: &str) -> String {
    format!("alert|{reminder_id}|{fire_key}")
}

/// The fire key an alert id carries.
#[must_use]
pub fn fire_key_of(id: &str) -> Option<&str> {
    id.strip_prefix("alert|")?
        .split_once('|')
        .map(|(_, key)| key)
}

fn targets_of(
    connection: &Connection,
    reminder_id: &str,
) -> Result<(Option<String>, Option<String>)> {
    connection
        .query_row(
            "SELECT date_id, field_id FROM reminder WHERE id = ?1",
            [reminder_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map(Option::unwrap_or_default)
        .map_err(|error| CoreError::Invariant {
            context: format!("a reminder's target will not read: {error}"),
        })
}

fn pending_of(
    connection: &Connection,
    alert: &Alert,
    fire: i64,
    zone: &FireZone,
    inputs: &Inputs<'_>,
) -> Result<Option<wire::PendingNotification>> {
    let Some(notice) =
        alerts::notice(connection, &alert.reminder_id).map_err(|error| CoreError::Invariant {
            context: format!("an alert's notice will not read: {error}"),
        })?
    else {
        return Ok(None);
    };
    let (date_id, field_id) = targets_of(connection, &alert.reminder_id)?;
    let (title, body) = if notice.kind == "locker_item" {
        inputs.words.locker()
    } else if inputs.details {
        inputs.words.alert(&notice)
    } else {
        inputs.words.private(&notice.kind)
    };
    let thread = if notice.kind == "task" {
        THREAD_REMINDERS
    } else {
        THREAD_CALENDAR
    };
    Ok(Some(wire::PendingNotification {
        notification_id: id_of(&alert.reminder_id, &alert.fire_key),
        fire_local: local_of(zone, fire),
        zone: zone.name().to_owned(),
        fire_at_ms: fire,
        title,
        body,
        category_id: category_of(&notice.kind),
        thread_id: thread.to_owned(),
        immediate: false,
        channel_id: String::new(),
        source_fingerprint: String::new(),
        open_url: open_url::link(&notice.kind, &notice.entity_id),
        entity_id: notice.entity_id,
        date_id: date_id.unwrap_or_default(),
        field_id: field_id.unwrap_or_default(),
    }))
}

fn extra_of(extra: &Extra, zone: &FireZone) -> wire::PendingNotification {
    wire::PendingNotification {
        notification_id: extra.id.clone(),
        fire_local: local_of(zone, extra.fire_at_ms),
        zone: zone.name().to_owned(),
        fire_at_ms: extra.fire_at_ms,
        title: extra.title.clone(),
        body: extra.body.clone(),
        thread_id: if extra.backup {
            THREAD_BACKUP
        } else {
            THREAD_REMINDERS
        }
        .to_owned(),
        channel_id: if extra.backup { CHANNEL_BACKUP } else { "" }.to_owned(),
        open_url: extra.open_url.clone(),
        ..wire::PendingNotification::default()
    }
}

/// Everything the phone should hold, and what it may keep on screen.
///
/// # Errors
/// The vault's refusal to read the alert index.
pub fn desired(connection: &Connection, inputs: &Inputs<'_>) -> Result<Desired> {
    let zone = FireZone::named(inputs.zone)
        .or_else(|_| FireZone::named("UTC"))
        .map_err(|error| CoreError::Invariant {
            context: format!("no zone to read alerts in: {error:?}"),
        })?;
    let now = inputs.now_ms;
    let horizon = now + HORIZON_DAYS * DAY_MS;
    let extras: Vec<&Extra> = inputs
        .extras
        .iter()
        .filter(|extra| extra.fire_at_ms >= now)
        .take(EXTRA_RESERVE)
        .collect();
    let room = inputs.cap.saturating_sub(extras.len());
    let wall_now = wall_epoch(zone.zoned_parts(now));
    let ahead = alerts::next(
        connection,
        &format_iso_ms(now),
        &floating_key(wall_now - alerts::FLOATING_SLACK_MS),
        room,
    )
    .map_err(|error| CoreError::Invariant {
        context: format!("the alert index will not read: {error}"),
    })?;
    let mut timed: Vec<(i64, Alert)> = ahead
        .into_iter()
        .filter_map(|alert| fire_ms(&alert, &zone).map(|fire| (fire, alert)))
        .filter(|(fire, _)| (now..=horizon).contains(fire))
        .collect();
    timed.sort_by(|a, b| (a.0, &a.1.reminder_id).cmp(&(b.0, &b.1.reminder_id)));
    timed.truncate(room);
    let mut all = Vec::with_capacity(timed.len() + extras.len());
    for (fire, alert) in &timed {
        if let Some(pending) = pending_of(connection, alert, *fire, &zone, inputs)? {
            all.push(pending);
        }
    }
    all.extend(extras.iter().map(|extra| extra_of(extra, &zone)));
    all.sort_by(|a, b| (a.fire_at_ms, &a.notification_id).cmp(&(b.fire_at_ms, &b.notification_id)));

    let recent = alerts::recent(
        connection,
        (&format_iso_ms(now - KEEP_PAST_MS), &format_iso_ms(now)),
        (
            &floating_key(wall_now - KEEP_PAST_MS - alerts::FLOATING_SLACK_MS),
            &floating_key(wall_now + alerts::FLOATING_SLACK_MS),
        ),
        LIVE_CAP,
    )
    .map_err(|error| CoreError::Invariant {
        context: format!("the delivered alerts will not read: {error}"),
    })?;
    let mut live: Vec<(i64, String)> = recent
        .into_iter()
        .filter_map(|alert| {
            fire_ms(&alert, &zone)
                .filter(|fire| *fire <= now && *fire > now - KEEP_PAST_MS)
                .map(|fire| (fire, id_of(&alert.reminder_id, &alert.fire_key)))
        })
        .collect();
    live.sort_by(|a, b| b.cmp(a));
    live.truncate(LIVE_CAP);
    Ok(Desired {
        all,
        live: live.into_iter().map(|(_, id)| id).collect(),
    })
}
