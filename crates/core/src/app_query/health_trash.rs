//! `health.trash` (#1185): the workouts in the trash, most recently trashed first, with the wall
//! clock each started at and the civil day it was trashed and the day it will be erased, read in
//! the member's zone. The read is `crates/apps/health`'s `load_trash`.

use centraid_api_proto::core_v1 as wire;
use centraid_apps_kit::civil;
use centraid_vault::Vault;
use centraid_vault::time::zone::FireZone;

use super::{Answer, VaultDoor, settle, zone_if_any};
use crate::error::Result;

pub(crate) fn trash(
    vault: &Vault,
    door: &VaultDoor<'_>,
    asked: &wire::HealthTrashRequest,
) -> Result<Answer> {
    let zone = zone_if_any(vault, &asked.tz)?;
    let loaded = centraid_apps_health::trash::load_trash(door).map(|data| (data, None));
    settle(door, loaded, |data| {
        Answer::HealthTrash(wire::HealthTrash {
            workouts: data
                .workouts
                .into_iter()
                .map(|row| wire::HealthTrashRow {
                    local_start: zone
                        .as_ref()
                        .and_then(|zone| civil::now_local(zone, &row.started_at))
                        .unwrap_or_default(),
                    deleted_local_day: day_in(zone.as_ref(), row.deleted_at.as_deref()),
                    purge_local_day: day_in(zone.as_ref(), row.purge_at.as_deref()),
                    deleted_at: row.deleted_at.unwrap_or_default(),
                    activity_id: row.activity_id,
                    kind_key: row.kind_key,
                    started_at: row.started_at,
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
