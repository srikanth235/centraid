//! `agenda.attachments` (#1173): what ONE event or task has attached, a page at a time, each row
//! with the file that draws its thumbnail when this phone holds one.
//!
//! The page itself is `crates/apps/calendar`'s or `crates/apps/reminders`' `load_attachments`. The thumbnails are the core's: the
//! vault resolves a held picture beside a page of `photo` or `document` rows
//! (`PageQuery::with_held_thumbnail`, the rule Photos' and Docs' tiles use), so a thumbnail asks
//! one extra page per kind for the page's own ids, and never a store lookup per attachment of the
//! vault.

use std::collections::BTreeMap;

use centraid_api_proto::core_v1 as wire;
use centraid_apps_calendar::AttachmentRow;
use centraid_apps_kit::page::{PageCursor, PageRequest};
use centraid_apps_kit::reads::PageDoor;
use centraid_apps_kit::row::text_of;
use centraid_apps_kit::statement::{PageBindValue, PageOrder, PageQuery};

use super::{Answer, VaultDoor, settle};
use crate::error::Result;

/// The key and the primary key of a cursor, joined as a request's `after` spells it.
const CURSOR_SEPARATOR: char = '\u{1f}';

/// `<app>.attachments`: one page of what `item_id` has attached. `after` is the cursor of the
/// page before, as its answer's `next` spelled it. `app` is the host's (`calendar`, `notes`, ...):
/// every app's read is the kit's one page over its own item kind (the Attach promise).
pub(crate) fn attachments(
    door: &VaultDoor<'_>,
    app: &str,
    item_id: &str,
    after: Option<(String, String)>,
    limit: u32,
) -> Result<Answer> {
    let limit = usize::try_from(limit).unwrap_or(usize::MAX).max(1);
    let after = after.map(|(sort_key, pk)| PageCursor { sort_key, pk });
    let loaded = match app {
        "calendar" => centraid_apps_calendar::load_attachments(door, item_id, after, limit),
        "reminders" => centraid_apps_reminders::load_attachments(door, item_id, after, limit),
        "notes" => centraid_apps_notes::load_attachments(door, item_id, after, limit),
        "people" => centraid_apps_people::load_attachments(door, item_id, after, limit),
        "photos" => centraid_apps_photos::load_attachments(door, item_id, after, limit),
        "docs" => centraid_apps_docs::load_attachments(door, item_id, after, limit),
        "health" => centraid_apps_health::load_attachments(door, item_id, after, limit),
        "money" => centraid_apps_money::load_attachments(door, item_id, after, limit),
        // Locker's items hold no attachments (D11), and no other app has the read.
        other => {
            return Ok(Answer::Denied(wire::AppQueryDenial {
                code: Some("no-attachments".to_owned()),
                message: Some(format!("{other} items hold no attachments")),
                revoked_at: None,
            }));
        }
    }
    .and_then(|(data, denial)| {
        let thumbnails = if denial.is_some() {
            BTreeMap::new()
        } else {
            thumbnails(door, &data.attachments)?
        };
        Ok((data, thumbnails, denial))
    });
    let loaded = loaded.map(|(data, thumbnails, denial)| ((data, thumbnails), denial));
    settle(door, loaded, |(data, thumbnails)| {
        Answer::AgendaAttachments(wire::AgendaAttachments {
            attachments: data
                .attachments
                .into_iter()
                .map(|row| {
                    let thumbnail_path = thumbnails
                        .get(&row.attachment_id)
                        .cloned()
                        .unwrap_or_default();
                    row_to_wire(row, thumbnail_path)
                })
                .collect(),
            next: data
                .next
                .map(|cursor| format!("{}{CURSOR_SEPARATOR}{}", cursor.sort_key, cursor.pk)),
        })
    })
}

fn row_to_wire(row: AttachmentRow, thumbnail_path: String) -> wire::AgendaAttachmentRow {
    wire::AgendaAttachmentRow {
        attachment_id: row.attachment_id,
        kind: row.kind,
        title: row.title,
        content_id: row.content_id,
        media_type: row.media_type,
        byte_size: row.byte_size,
        attached_at: row.attached_at,
        thumbnail_path,
    }
}

/// The picture each photo and image document of the page may be drawn as, by attachment id.
/// A page is at most the read's page maximum, so each kind is one page of its own ids.
fn thumbnails(
    door: &dyn PageDoor,
    rows: &[AttachmentRow],
) -> centraid_apps_kit::error::KitResult<BTreeMap<String, String>> {
    let mut found = BTreeMap::new();
    for (kind, table) in [("photo", "photo"), ("document", "document")] {
        let ids: Vec<&AttachmentRow> = rows.iter().filter(|row| row.kind == kind).collect();
        if ids.is_empty() {
            continue;
        }
        let marks = vec!["?"; ids.len()].join(", ");
        let query = PageQuery::new(
            &format!("agenda.attachments.thumbs.{kind}"),
            "id",
            table,
            PageOrder::asc("id", "id"),
        )
        .filter(
            &format!("id IN ({marks})"),
            ids.iter()
                .map(|row| PageBindValue::Text(row.attachment_id.clone()))
                .collect(),
        )
        .with_held_thumbnail();
        let page = door.page(&query, &PageRequest::first(ids.len()))?;
        for row in &page.rows {
            if let (Some(id), Some(path)) = (text_of(row, "id"), text_of(row, "thumbnail_path"))
                && !path.is_empty()
            {
                found.insert(id, path);
            }
        }
    }
    Ok(found)
}

#[cfg(test)]
#[path = "attachments_tests.rs"]
mod tests;
