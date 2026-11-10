//! A RECORD'S EARLIER VALUES (#1185): `shell.earlier-versions` and `shell.earlier-count`, the two
//! reads behind every detail screen's "Earlier versions".
//!
//! The vault keeps the history at its commit door and derives each version's changes on read
//! (`centraid_vault::history`): nothing is stored here. A page answers each version's two
//! instants as civil minutes in the request's zone (empty when the vault names no zone: no time is
//! invented), who replaced it, and the changed fields with both values as JSON text; the screen of
//! the kind words them. The page is keyset paged on `seq`: `after` is the `next` of the page before
//! and `limit` is at most 100.

use centraid_api_proto::core_v1 as wire;
use centraid_vault::Vault;
use centraid_vault::history::{self, Who};

use super::{Answer, zone_if_any};
use crate::error::{CoreError, Result};

/// A page's default rows: a screenful.
pub(crate) const PAGE: usize = 20;

/// `shell.earlier-versions` for one entity.
pub(crate) fn versions(
    vault: &Vault,
    entity_id: &str,
    zone: &str,
    after: &str,
    limit: usize,
) -> Result<Answer> {
    let before =
        if after.is_empty() {
            None
        } else {
            Some(after.parse::<i64>().map_err(|_| {
                CoreError::InvalidRequest {
                    detail:
                        "`shell.earlier-versions` takes the `next` of the page before as `after`"
                            .to_owned(),
                }
            })?)
        };
    let page =
        vault.read(|connection| history::earlier_versions(connection, entity_id, before, limit))?;
    let zone = zone_if_any(vault, zone)?;
    let local = |instant: &str| {
        zone.as_ref()
            .and_then(|zone| centraid_apps_kit::civil::now_local(zone, instant))
            .unwrap_or_default()
    };
    let system = |who: Who| match who {
        Who::Member => String::new(),
        Who::Store(system) => system,
    };
    let text = |value: &serde_json::Value| value.to_string();
    Ok(Answer::EarlierVersions(wire::EarlierVersions {
        next: page.next,
        versions: page
            .versions
            .into_iter()
            .map(|version| wire::EarlierVersion {
                seq: version.seq,
                replaced_local: local(&version.at),
                since_local: local(&version.since),
                store_system: system(version.by),
                since_store_system: system(version.since_by),
                changes: version
                    .changes
                    .iter()
                    .map(|change| wire::EarlierChange {
                        field: change.field.clone(),
                        before_json: text(&change.before),
                        after_json: text(&change.after),
                    })
                    .collect(),
            })
            .collect(),
    }))
}

/// `shell.earlier-count` for one entity.
pub(crate) fn count(vault: &Vault, entity_id: &str) -> Result<Answer> {
    let count = vault.read(|connection| history::count(connection, entity_id))?;
    Ok(Answer::EarlierCount(wire::EarlierCount { count }))
}
