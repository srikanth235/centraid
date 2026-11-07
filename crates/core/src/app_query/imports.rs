//! THE SHELL'S IMPORT READS (#1135, lane I): what the vault holds of the folders a
//! member follows. `shell.files-followed` is the Rust form of the KMP follower's
//! `files.origins` / `files.sources` / `files.followed` page reads, in one answer:
//! each followed folder (an `origin` of system `files`), the documents that still
//! follow one of its files, and each file's last stated `stat`.
//!
//! A half-read table planned against would trash what it did not see, so a page that
//! fails fails the whole answer (the door keeps the failure and `settle` answers it).

use std::collections::BTreeMap;

use centraid_api_proto::core_v1 as wire;
use centraid_apps_kit::page::{PageCursor, PageRequest};
use centraid_apps_kit::reads::PageDoor;
use centraid_apps_kit::row::{Row, text_of};
use centraid_apps_kit::statement::{PageBindValue, PageOrder, PageQuery};
use centraid_apps_kit::{KitError, KitResult};
use centraid_vault::Vault;
use centraid_vault::commands::calendar_push;
use centraid_vault::rusqlite::OptionalExtension;

use super::{Answer, VaultDoor, settle};
use crate::error::Result;

const PAGE: usize = 500;
const MAX_PAGES: usize = 10_000;

/// Every row of a query, a page at a time by its keyset cursor.
fn all(door: &dyn PageDoor, query: &PageQuery) -> KitResult<Vec<Row>> {
    let mut rows = Vec::new();
    let mut after: Option<PageCursor> = None;
    for _ in 0..MAX_PAGES {
        let page = door.page(
            query,
            &PageRequest {
                limit: PAGE,
                after: after.clone(),
            },
        )?;
        rows.extend(page.rows);
        match page.next {
            Some(next) => after = Some(next),
            None => return Ok(rows),
        }
    }
    Err(KitError::Door(
        "a followed table has too many pages".to_owned(),
    ))
}

fn files_only(name: &str, select: &str, from: &str) -> PageQuery {
    PageQuery::new(name, select, from, PageOrder::asc("id", "id"))
        .filter("system = ?", vec![PageBindValue::Text("files".to_owned())])
}

/// The `stat` a source last stated, out of its `stated` JSON.
fn stat_of(stated: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(stated).ok()?;
    value.get("stat")?.as_str().map(str::to_owned)
}

/// `shell.files-followed`.
pub(crate) fn files_followed(door: &VaultDoor<'_>) -> Result<Answer> {
    let loaded = (|| -> KitResult<(wire::ImportsFilesHeld, Option<centraid_apps_kit::Denial>)> {
        let origins = all(
            door,
            &files_only("files.origins", "id, ref, label", "origin"),
        )?;
        let sources = all(
            door,
            &files_only(
                "files.sources",
                "id, origin_id, external_id, entity_id, stated",
                "source",
            ),
        )?;
        let mut folders: BTreeMap<String, wire::ImportsHeldFolder> = BTreeMap::new();
        for row in &origins {
            let id = text_of(row, "id").unwrap_or_default();
            folders.insert(
                id.clone(),
                wire::ImportsHeldFolder {
                    origin_id: id,
                    origin_ref: text_of(row, "ref").unwrap_or_default(),
                    label: text_of(row, "label").unwrap_or_default(),
                    documents: 0,
                    files: Vec::new(),
                },
            );
        }
        for row in &sources {
            let Some(folder) = text_of(row, "origin_id").and_then(|id| folders.get_mut(&id)) else {
                continue;
            };
            if text_of(row, "entity_id").is_some_and(|id| !id.is_empty()) {
                folder.documents += 1;
            }
            if let Some(stat) = text_of(row, "stated").as_deref().and_then(stat_of) {
                folder.files.push(wire::ImportsHeldFile {
                    path: text_of(row, "external_id").unwrap_or_default(),
                    stat,
                });
            }
        }
        let mut folders: Vec<_> = folders.into_values().collect();
        folders.sort_by(|a, b| a.label.to_lowercase().cmp(&b.label.to_lowercase()));
        Ok((wire::ImportsFilesHeld { folders }, None))
    })();
    settle(door, loaded, Answer::ImportsFilesHeld)
}

/// `shell.calendar-owed`: the pushes the shell's writable phone calendars are owed, one page.
///
/// The vault derives them at read time ([`calendar_push::owed_pushes`]), so a push that failed or
/// was never answered is simply owed again; nothing is stored. `limit` 0 is the vault's own page.
pub(crate) fn calendar_owed(
    vault: &Vault,
    door: &VaultDoor<'_>,
    origins: &[String],
    after_event: &str,
    limit: u32,
) -> Result<Answer> {
    let limit = usize::try_from(limit).unwrap_or(usize::MAX).max(1);
    let after = (!after_event.is_empty()).then_some(after_event);
    // The shell knows its calendars by origin ref (`calendar:<key>`); the vault's own origin ids are
    // minted, so the refs are looked up here, inside the one read.
    let page = vault.read(|connection| {
        let mut ids: Vec<String> = Vec::new();
        for reference in origins {
            let found: Option<String> = connection
                .query_row(
                    "SELECT id FROM origin WHERE system = 'calendar' AND ref = ?1 ORDER BY created_at, id LIMIT 1",
                    [reference],
                    |row| row.get(0),
                )
                .optional()?;
            ids.extend(found);
        }
        calendar_push::owed_pushes(connection, &ids, after, limit)
    })?;
    let loaded: KitResult<(wire::ImportsCalendarOwed, Option<centraid_apps_kit::Denial>)> = Ok((
        wire::ImportsCalendarOwed {
            items: page
                .items
                .into_iter()
                .map(|owed| wire::ImportsOwedPush {
                    op: owed.op.as_str().to_owned(),
                    event_id: owed.event_id,
                    origin_ref: owed.origin_ref,
                    external_id: owed.external_id.unwrap_or_default(),
                    device_id: owed.device_id.unwrap_or_default(),
                    changed: owed.changed,
                    stated_json: owed.stated.to_string(),
                    fields_json: owed.fields.to_string(),
                })
                .collect(),
            next: page.next.unwrap_or_default(),
        },
        None,
    ));
    settle(door, loaded, Answer::ImportsCalendarOwed)
}
