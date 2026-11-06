//! Notification candidates and civil snoozes, using the same recurrence and
//! zone rules as Agenda. A past reminder is retained for validating an action,
//! but the scheduler never sends a backlog of overdue notifications.
use centraid_apps_kit::error::KitResult;
use centraid_apps_kit::reads::PageDoor;
use centraid_vault::clock::format_iso_ms as iso_of;
use centraid_vault::time::civil::parse_civil_ms;
use centraid_vault::time::recurrence::parse_instant_ms;
use centraid_vault::time::zone::{FireZone, add_wall_days, wall_iso};

use crate::{Denial, queries, task};

mod events;

/// A notification before platform capacity is applied.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Alert {
    pub id: String,
    pub entity_id: String,
    pub fire_at_ms: i64,
    pub title: String,
    pub body: String,
    pub task: bool,
    pub source_stamp: String,
}

/// Current live source revisions, separate from the bounded future plan.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Source {
    pub entity_id: String,
    pub source_stamp: String,
    pub task: bool,
    pub title: String,
}

/// Future candidates and the source identities which remain actionable.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Data {
    pub alerts: Vec<Alert>,
    pub sources: Vec<Source>,
}

/// All-day reminders fire at 09:00 in the member's zone.
#[must_use]
pub fn moment(value: &str, zone: &FireZone) -> Option<i64> {
    if value.len() == 10 {
        parse_civil_ms(&format!("{value}T09:00:00"), zone)
    } else {
        parse_civil_ms(value, zone)
    }
}

/// Tomorrow means 09:00 on the next local day, including a clock change.
#[must_use]
pub fn tomorrow(at_ms: i64, zone: &FireZone) -> Option<i64> {
    let mut wall = add_wall_days(zone.zoned_parts(at_ms), 1);
    wall.hour = 9;
    wall.minute = 0;
    wall.second = 0;
    wall.millisecond = 0;
    parse_civil_ms(&wall_iso(wall, true), zone)
}

/// A complete bounded read. Reaching a query bound refuses; it never silently
/// cancels alerts that happened to fall outside a UI window.
pub fn load(door: &dyn PageDoor, now: &str, zone: &FireZone) -> KitResult<(Data, Option<Denial>)> {
    let now_ms = parse_instant_ms(now).unwrap_or_default();
    let mut alerts = Vec::new();
    let mut sources = Vec::new();
    for task in task::queries::load_alert_tasks(door, now, zone)? {
        sources.push(Source {
            entity_id: task.task_id.clone(),
            source_stamp: task.updated_at.clone().unwrap_or_default(),
            task: true,
            title: task.title.clone(),
        });
        let own = task
            .tz
            .as_deref()
            .and_then(|name| FireZone::named(name).ok());
        let due = task
            .recurrence
            .next_due
            .as_deref()
            .or(task.due_at.as_deref());
        let at = |value: &str| {
            moment(
                value,
                if value.len() == 10 {
                    zone
                } else {
                    own.as_ref().unwrap_or(zone)
                },
            )
        };
        let Some(due) = due.and_then(at) else {
            continue;
        };
        let leads: std::collections::BTreeSet<i64> = task
            .reminders
            .iter()
            .copied()
            .chain(task.remind_before_min)
            .collect();
        for lead in leads {
            let Some(offset) = lead.checked_mul(60_000) else {
                continue;
            };
            // Compare due against the alarm's clock for every lead: a before-
            // due alarm may already be past while due remains in the future,
            // and an after-due alarm may still be ahead on the final period.
            let due = if task.rrule.is_some() {
                now_ms
                    .checked_add(offset)
                    .and_then(|clock| {
                        if task.due_at.as_deref().is_some_and(|due| due.len() == 10) {
                            let wall = centraid_vault::time::zone::wall_from_epoch(
                                centraid_vault::time::zone::wall_epoch(zone.zoned_parts(clock))
                                    .saturating_sub(9 * 3_600_000),
                            );
                            parse_civil_ms(&wall_iso(wall, true), zone)
                        } else {
                            Some(clock)
                        }
                    })
                    .and_then(|clock| {
                        task::queries::recurrence_of(&task, &iso_of(clock), zone).next_due
                    })
                    .as_deref()
                    .and_then(at)
                    .unwrap_or(due)
            } else {
                due
            };
            let fire = due.checked_sub(offset);
            let Some(fire_at_ms) = fire else {
                continue;
            };
            // The identity follows the task and lead, not its next expanded
            // period. A delivered reminder stays actionable while its source
            // revision lives, independently of the next scheduled period.
            alerts.push(Alert {
                id: format!(
                    "task:{}:{lead}:{}:{}",
                    task.task_id,
                    task.due_at.as_deref().unwrap_or_default(),
                    task.updated_at.as_deref().unwrap_or_default()
                ),
                entity_id: task.task_id.clone(),
                fire_at_ms,
                title: task.title.clone(),
                body: String::new(),
                task: true,
                source_stamp: task.updated_at.clone().unwrap_or_default(),
            });
        }
    }
    let event_rows = queries::load_alert_events(door)?;
    for event in &event_rows {
        sources.push(Source {
            entity_id: event.event_id.clone(),
            source_stamp: event.updated_at.clone().unwrap_or_default(),
            task: false,
            title: event.summary.clone().unwrap_or_default(),
        });
    }
    let exceptions = queries::read_exceptions(door, &event_rows)?;
    alerts.extend(events::load(event_rows, &exceptions, now_ms, zone)?);
    alerts.sort_by(|left, right| (left.fire_at_ms, &left.id).cmp(&(right.fire_at_ms, &right.id)));
    alerts.dedup_by(|left, right| left.id == right.id);
    Ok((Data { alerts, sources }, None))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn due_and_tomorrow_use_the_local_clock_across_dst() {
        let zone = FireZone::named("America/New_York").expect("zone");
        assert_eq!(
            moment("2026-03-08", &zone),
            parse_instant_ms("2026-03-08T13:00:00Z")
        );
        let saturday = parse_instant_ms("2026-03-07T20:00:00Z").expect("instant");
        assert_eq!(
            tomorrow(saturday, &zone),
            parse_instant_ms("2026-03-08T13:00:00Z")
        );
        assert_eq!(
            moment("2026-03-08T02:30", &zone),
            parse_instant_ms("2026-03-08T07:30:00Z")
        );
    }
}
