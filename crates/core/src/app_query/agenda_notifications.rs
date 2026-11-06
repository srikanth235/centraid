//! The scheduler's read, independent of any visible Agenda board.
use super::{Answer, VaultDoor, settle, zone_of};
use crate::error::Result;
use centraid_api_proto::core_v1 as wire;
use centraid_vault::Vault;
use centraid_vault::time::recurrence::parse_instant_ms;

pub(crate) fn read(vault: &Vault, door: &VaultDoor<'_>, now: &str, tz: &str) -> Result<Answer> {
    let zone = zone_of(vault, tz)?;
    settle(
        door,
        centraid_apps_agenda::notifications::load(door, now, &zone),
        |data| {
            Answer::AgendaAlerts(wire::AgendaAlerts {
                now_ms: parse_instant_ms(now).unwrap_or_default(),
                alerts: data
                    .alerts
                    .into_iter()
                    .map(|alert| wire::AgendaAlert {
                        id: alert.id,
                        entity_id: alert.entity_id,
                        fire_at_ms: alert.fire_at_ms,
                        title: alert.title,
                        body: alert.body,
                        task: alert.task,
                        source_stamp: alert.source_stamp,
                    })
                    .collect(),
                sources: data
                    .sources
                    .into_iter()
                    .map(|source| wire::AgendaAlertSource {
                        entity_id: source.entity_id,
                        source_stamp: source.source_stamp,
                        task: source.task,
                        title: source.title,
                    })
                    .collect(),
            })
        },
    )
}
