//! `calendar.trash` (#1185): the events in the trash, most recently trashed first, with the civil day
//! each was trashed and the day it will be erased, read in the member's zone. The read is
//! `crates/apps/calendar`'s `load_trash`. A repeating event is one row, whole.

use centraid_api_proto::core_v1 as wire;
use centraid_apps_kit::civil;
use centraid_vault::Vault;
use centraid_vault::time::zone::FireZone;

use super::{Answer, VaultDoor, settle, zone_if_any};
use crate::error::Result;

pub(crate) fn trash(
    vault: &Vault,
    door: &VaultDoor<'_>,
    asked: &wire::CalendarTrashRequest,
) -> Result<Answer> {
    let zone = zone_if_any(vault, &asked.tz)?;
    settle(door, centraid_apps_calendar::load_trash(door), |data| {
        Answer::CalendarTrash(wire::CalendarTrash {
            events: data
                .events
                .into_iter()
                .map(|row| wire::CalendarTrashRow {
                    deleted_local_day: day_in(zone.as_ref(), row.deleted_at.as_deref()),
                    purge_local_day: day_in(zone.as_ref(), row.purge_at.as_deref()),
                    deleted_at: row.deleted_at.unwrap_or_default(),
                    event_id: row.event_id,
                    title: row.title,
                    purge_at: row.purge_at,
                })
                .collect(),
            truncated: data.truncated,
        })
    })
}

/// An instant's civil day in `zone`; EMPTY with no zone or no instant.
fn day_in(zone: Option<&FireZone>, instant: Option<&str>) -> String {
    zone.zip(instant)
        .and_then(|(zone, instant)| civil::today(zone, instant))
        .unwrap_or_default()
}
