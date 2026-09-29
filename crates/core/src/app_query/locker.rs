//! LOCKER'S ARM OF THE APP QUERY (#1047, wave L1): `crates/apps/locker::phone`'s
//! loaders, asked through [`super::VaultDoor`] and spelled as `locker.proto`
//! spells them.
//!
//! Metadata only. A sealed cell reaches this module as its PRESENCE and leaves
//! it as `LockerSecret.present`; its value is the session's
//! (`crate::locker::phone`), behind the unlock and a receipt. Every stored
//! instant a member reads leaves as a local day in the request's zone
//! ([`super::zone_of`]'s rule).

use centraid_api_proto::core_v1 as wire;
use centraid_apps_agenda::local;
use centraid_apps_kit::error::{KitError, KitResult};
use centraid_apps_locker::phone::{self, ItemData, Listed};
use centraid_vault::Vault;
use centraid_vault::time::zone::FireZone;

use super::{VaultDoor, settle, zone_of};
use crate::error::{CoreError, Result};

type Answer = wire::app_query_response::Answer;

/// A loader's answer as the wire's (Tally's `answered`, for Locker).
fn answered<T>(
    door: &VaultDoor<'_>,
    loaded: KitResult<T>,
    data: impl FnOnce(T) -> Answer,
) -> Result<Answer> {
    match loaded {
        Err(KitError::Door(message)) => settle(
            door,
            Ok(((), Some(centraid_apps_agenda::denial_of(message)))),
            |()| unreachable!("a denial carries no data"),
        ),
        other => settle(door, other.map(|value| (value, None)), data),
    }
}

fn today(zone: &FireZone, now: &str) -> Result<String> {
    local::today(zone, now).ok_or_else(|| CoreError::Invariant {
        context: format!("the vault clock did not read as a day: {now}"),
    })
}

fn day_of(zone: &FireZone, instant: Option<&str>) -> String {
    instant
        .and_then(|at| local::today(zone, at))
        .unwrap_or_default()
}

fn count(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

fn row(listed: Listed, zone: &FireZone) -> wire::LockerItemRow {
    let rendered = listed.rendered_type().to_owned();
    let subtitle = listed.subtitle();
    let archived = listed.archived();
    let item = listed.row;
    wire::LockerItemRow {
        updated_local_day: day_of(zone, item.updated_at.as_deref()),
        url: if rendered == "login" {
            item.url.unwrap_or_default()
        } else {
            String::new()
        },
        expiry: if rendered == "card" {
            item.expiry.unwrap_or_default()
        } else {
            String::new()
        },
        item_id: item.item_id,
        r#type: rendered,
        title: item.title,
        subtitle,
        starred: listed.starred,
        tags: listed.tags,
        compromised: item.compromised,
        archived,
    }
}

pub(super) fn items(
    vault: &Vault,
    door: &VaultDoor<'_>,
    now: &str,
    asked: &wire::LockerItemsRequest,
) -> Result<Answer> {
    let zone = zone_of(vault, &asked.tz)?;
    let today = today(&zone, now)?;
    let limit = (asked.limit > 0).then(|| i64::from(asked.limit));
    answered(
        door,
        phone::load_items(door, asked.archived, limit),
        |data| {
            Answer::LockerItems(wire::LockerItems {
                items: data
                    .items
                    .into_iter()
                    .map(|listed| row(listed, &zone))
                    .collect(),
                truncated: data.truncated,
                window: count(data.window),
                total: data.total.map(count),
                by_type: data
                    .by_type
                    .into_iter()
                    .map(|(r#type, n)| wire::LockerTypeCount {
                        r#type,
                        count: count(n),
                    })
                    .collect(),
                archived_count: data.archived_count.map(count),
                trashed_count: data.trashed_count.map(count),
                tags: data.tags,
                today,
            })
        },
    )
}

pub(super) fn item(
    vault: &Vault,
    door: &VaultDoor<'_>,
    now: &str,
    asked: &wire::LockerItemRequest,
) -> Result<Answer> {
    let zone = zone_of(vault, &asked.tz)?;
    let today = today(&zone, now)?;
    answered(door, phone::load_item(door, &asked.item_id), |data| {
        Answer::LockerItem(Box::new(wire::LockerItemDetail {
            item: data.map(|data| detail(data, &zone)),
            today,
        }))
    })
}

fn detail(data: ItemData, zone: &FireZone) -> wire::LockerItem {
    let rendered = data.listed.rendered_type().to_owned();
    let archived = data.listed.archived();
    let starred = data.listed.starred;
    let tags = data.listed.tags;
    let item = data.listed.row;
    let text = |value: Option<String>| value.unwrap_or_default();
    wire::LockerItem {
        password_set_local_day: day_of(zone, item.password_set_at.as_deref()),
        created_local_day: day_of(zone, item.created_at.as_deref()),
        updated_local_day: day_of(zone, item.updated_at.as_deref()),
        purge_local_day: day_of(zone, item.purge_at.as_deref()),
        trashed: item.deleted_at.is_some(),
        item_id: item.item_id,
        r#type: rendered,
        degraded_from: data.degraded_from.unwrap_or_default(),
        title: item.title,
        starred,
        tags,
        compromised: item.compromised,
        archived,
        username: text(item.username),
        url: text(item.url),
        notes: text(item.notes),
        cardholder: text(item.cardholder),
        expiry: text(item.expiry),
        brand: text(item.brand),
        fullname: text(item.fullname),
        email: text(item.email),
        phone: text(item.phone),
        address: text(item.address),
        network: text(item.network),
        alias: text(data.alias),
        memo: text(data.memo),
        secrets: data
            .secrets
            .into_iter()
            .map(|(column, present)| wire::LockerSecret {
                column: column.to_owned(),
                present,
            })
            .collect(),
        fields: data
            .fields
            .into_iter()
            .map(|field| wire::LockerField {
                field_id: field.field_id,
                section: field.section,
                label: field.label,
                kind: field.kind,
                value: field.value.unwrap_or_default(),
                sealed: field.sealed,
                present: field.present,
            })
            .collect(),
        addresses: data
            .addresses
            .into_iter()
            .map(|address| wire::LockerAddress {
                address_id: address.address_id,
                url: address.url,
            })
            .collect(),
        passkey: data.passkey.map(|passkey| wire::LockerPasskey {
            rp_id: passkey.rp_id,
            user_handle: passkey.user_handle.unwrap_or_default(),
            display_name: passkey.display_name.unwrap_or_default(),
            has_private_key: passkey.has_private_key,
        }),
    }
}

pub(super) fn search(
    vault: &Vault,
    door: &VaultDoor<'_>,
    asked: &wire::LockerSearchRequest,
) -> Result<Answer> {
    let zone = zone_of(vault, &asked.tz)?;
    let limit = usize::try_from(asked.limit).unwrap_or(usize::MAX);
    answered(door, phone::load_search(door, &asked.term, limit), |data| {
        Answer::LockerSearch(wire::LockerSearch {
            term: asked.term.clone(),
            items: data
                .items
                .into_iter()
                .map(|listed| row(listed, &zone))
                .collect(),
            truncated: data.truncated,
        })
    })
}

pub(super) fn review(
    vault: &Vault,
    door: &VaultDoor<'_>,
    now: &str,
    asked: &wire::LockerReviewRequest,
) -> Result<Answer> {
    let zone = zone_of(vault, &asked.tz)?;
    let today = today(&zone, now)?;
    let rows = |listed: Vec<Listed>| -> Vec<wire::LockerItemRow> {
        listed.into_iter().map(|one| row(one, &zone)).collect()
    };
    answered(door, phone::load_review(door, &today), |data| {
        Answer::LockerReview(wire::LockerReview {
            compromised: rows(data.compromised),
            insecure_address: rows(data.insecure_address),
            expired: rows(data.expired),
            expiring: rows(data.expiring),
            reviewed: count(data.reviewed),
            truncated: data.truncated,
            today: today.clone(),
        })
    })
}

#[cfg(test)]
#[path = "locker_tests.rs"]
mod tests;
