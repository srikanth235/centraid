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
        Who::Assistant => String::new(),
    };
    let actor = |who: &Who| if *who == Who::Assistant { "assist" } else { "" }.to_owned();
    let text = |value: &serde_json::Value| value.to_string();
    let names = named(vault, &page.versions)?;
    Ok(Answer::EarlierVersions(wire::EarlierVersions {
        next: page.next,
        names,
        versions: page
            .versions
            .into_iter()
            .map(|version| wire::EarlierVersion {
                seq: version.seq,
                replaced_local: local(&version.at),
                since_local: local(&version.since),
                made_by: actor(&version.by),
                since_made_by: actor(&version.since_by),
                store_system: system(version.by),
                since_store_system: system(version.since_by),
                field_changes: version
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

/// `shell.earlier-record`: one earlier version of an entity, whole. A record with no such version
/// is the request's mistake, not an empty answer.
pub(crate) fn record(vault: &Vault, entity_id: &str, seq: i64, zone: &str) -> Result<Answer> {
    let Some(record) = vault.read(|connection| history::record(connection, entity_id, seq))? else {
        return Err(CoreError::InvalidRequest {
            detail: "`shell.earlier-record` names a version the record does not hold".to_owned(),
        });
    };
    let zone = zone_if_any(vault, zone)?;
    let local = |instant: &str| {
        zone.as_ref()
            .and_then(|zone| centraid_apps_kit::civil::now_local(zone, instant))
            .unwrap_or_default()
    };
    let system = |who: &Who| match who {
        Who::Member => String::new(),
        Who::Store(system) => system.clone(),
        Who::Assistant => String::new(),
    };
    let actor = |who: &Who| if *who == Who::Assistant { "assist" } else { "" }.to_owned();
    let version = record.version;
    // The titles of the lists, albums and items the version, or its change, names by id.
    let names = named_by(
        vault,
        record
            .fields
            .iter()
            .map(|(field, _)| field.as_str())
            .chain(version.changes.iter().map(|change| change.field.as_str())),
    )?;
    Ok(Answer::EarlierRecord(wire::EarlierRecord {
        names,
        seq: version.seq,
        replaced_local: local(&version.at),
        since_local: local(&version.since),
        made_by: actor(&version.by),
        since_made_by: actor(&version.since_by),
        store_system: system(&version.by),
        since_store_system: system(&version.since_by),
        fields: record
            .fields
            .iter()
            .map(|(field, value)| wire::EarlierField {
                field: field.clone(),
                value_json: value.to_string(),
            })
            .collect(),
        field_changes: version
            .changes
            .iter()
            .map(|change| wire::EarlierChange {
                field: change.field.clone(),
                before_json: change.before.to_string(),
                after_json: change.after.to_string(),
            })
            .collect(),
    }))
}

/// `shell.earlier-count` for one entity.
pub(crate) fn count(vault: &Vault, entity_id: &str) -> Result<Answer> {
    let count = vault.read(|connection| history::offered(connection, entity_id))?;
    Ok(Answer::EarlierCount(wire::EarlierCount { count }))
}

/// The fields a version names another record by (the id is the field's key).
const NAMING: [&str; 5] = ["tag", "membership", "link", "about", "depicts"];

/// The titles of the records a page's changes name: a list, an album, an item a record was linked
/// to. A record the vault no longer holds is not named (the screen says so in its own words); a
/// Locker item is never named, so a version never carries a title from behind Locker's wall.
fn named(vault: &Vault, versions: &[history::Version]) -> Result<Vec<wire::EarlierName>> {
    named_by(
        vault,
        versions
            .iter()
            .flat_map(|version| version.changes.iter())
            .map(|change| change.field.as_str()),
    )
}

/// [`named`] over the field names that carry ids.
fn named_by<'a>(
    vault: &Vault,
    fields: impl Iterator<Item = &'a str>,
) -> Result<Vec<wire::EarlierName>> {
    let mut ids: Vec<String> = fields
        .filter_map(|field| {
            let (alias, rest) = field.split_once('[')?;
            let id = rest.split(']').next()?;
            NAMING.contains(&alias).then(|| id.to_owned())
        })
        .collect();
    ids.sort();
    ids.dedup();
    let found = vault.read(|connection| history::titles(connection, &ids))?;
    let names = found
        .into_iter()
        .map(|(id, title)| wire::EarlierName { id, title })
        .collect();
    Ok(names)
}
