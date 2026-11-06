//! A notification window starts at the next alert, independent of the calendar
//! page's lookback. Expansion and exception matching remain the vault's engine.
use std::collections::BTreeSet;

use centraid_apps_kit::error::KitResult;
use centraid_vault::time::occurrence::StoredExceptionRow;
use centraid_vault::time::recurrence::Semantics;
use centraid_vault::time::zone::{FireZone, wall_epoch};

use super::{Alert, moment};
use crate::expansion::expand_series_window;
use crate::queries::EventRow;

const CAPACITY: usize = 60;
const HORIZON_MS: i64 = 45 * 86_400_000;

fn comparison(at: i64, semantics: Semantics, zone: &FireZone) -> i64 {
    match semantics {
        Semantics::Zoned => at,
        Semantics::Floating => wall_epoch(zone.zoned_parts(at)),
        // The engine compares all-day occurrences at midnight; their alerts
        // are at 09:00 in the member's zone.
        Semantics::AllDay => wall_epoch(zone.zoned_parts(at)).saturating_sub(9 * 3_600_000),
    }
}

fn candidates(
    event: &EventRow,
    exceptions: &[StoredExceptionRow],
    offset: i64,
    now: i64,
    member_zone: &FireZone,
) -> KitResult<Vec<EventRow>> {
    let semantics = event.semantics();
    let own = event
        .start_tz
        .as_deref()
        .and_then(|name| FireZone::named(name).ok());
    let zone = if semantics == Semantics::AllDay {
        member_zone
    } else {
        own.as_ref().unwrap_or(member_zone)
    };
    let from = comparison(
        now.saturating_add(1).saturating_add(offset),
        semantics,
        zone,
    );
    let to = comparison(
        now.saturating_add(HORIZON_MS).saturating_add(offset),
        semantics,
        zone,
    );
    expand_series_window(event, exceptions, from, to, zone, CAPACITY)
}

pub(super) fn load(
    events: Vec<EventRow>,
    exceptions: &[StoredExceptionRow],
    now: i64,
    member_zone: &FireZone,
) -> KitResult<Vec<Alert>> {
    let mut alerts = Vec::new();
    for event in events {
        let leads: BTreeSet<_> = event.reminders.iter().copied().collect();
        for lead in leads {
            let Some(offset) = lead.checked_mul(60_000) else {
                continue;
            };
            for instance in candidates(&event, exceptions, offset, now, member_zone)? {
                let own = instance
                    .start_tz
                    .as_deref()
                    .and_then(|name| FireZone::named(name).ok());
                let zone = if instance.dtstart.len() == 10 {
                    member_zone
                } else {
                    own.as_ref().unwrap_or(member_zone)
                };
                let Some(fire_at_ms) =
                    moment(&instance.dtstart, zone).and_then(|at| at.checked_sub(offset))
                else {
                    continue;
                };
                if fire_at_ms <= now || fire_at_ms >= now.saturating_add(HORIZON_MS) {
                    continue;
                }
                alerts.push(Alert {
                    id: format!(
                        "event:{}:{}:{lead}:{fire_at_ms}:{}",
                        event.event_id,
                        instance.instance_key,
                        event.updated_at.as_deref().unwrap_or_default()
                    ),
                    entity_id: event.event_id.clone(),
                    fire_at_ms,
                    title: instance.summary.unwrap_or_default(),
                    body: String::new(),
                    task: false,
                    source_stamp: event.updated_at.clone().unwrap_or_default(),
                });
            }
            alerts.sort_by(|left, right| {
                (left.fire_at_ms, &left.id).cmp(&(right.fire_at_ms, &right.id))
            });
            alerts.dedup_by(|left, right| left.id == right.id);
            // The device can hold only sixty; selecting the earliest here is
            // explicit scheduling policy, independent of a UI query's cap.
            alerts.truncate(CAPACITY);
        }
    }
    Ok(alerts)
}
