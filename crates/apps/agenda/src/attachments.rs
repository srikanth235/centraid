//! `attachments` — what is attached to ONE event or task, a page at a time (#1173).
//!
//! The detail screens decorate a row with its attachments for the board and the agenda
//! ([`centraid_apps_kit::attached`]); this is the read behind an item's own attachments list, which a
//! member may grow without bound. It is a keyset page of the `attached` edges the item starts, in
//! the order of the attached file's id (the one thing about an attachment that never changes), and
//! each far end is then named, typed and sized, one table at a time, for the page alone.
//!
//! **Absent is an answer**: an id that is no live event or task, and an item with nothing attached,
//! both answer an empty page. An attached file in the trash is left out of the page (it comes back
//! with the file), so a page may be shorter than its window and still have a `next`.

use std::collections::BTreeMap;

use centraid_apps_kit::attached::BLOB_ROUTE;
use centraid_apps_kit::error::{KitError, KitResult};
use centraid_apps_kit::page::{PageCursor, PageRequest};
use centraid_apps_kit::reads::{PageDoor, Read};
use centraid_apps_kit::row::{Row, integer_or_zero, text_of};
use centraid_apps_kit::statement::{PageBindValue, PageOrder, PageQuery};

use crate::{Denial, denial_of};

/// The most attachments one page answers; a request is clamped to it.
pub const ATTACHMENTS_PAGE_MAX: usize = 100;

/// One attachment of an event or a task.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttachmentRow {
    /// The attached document's or photo's id, which is also what `edge.remove` takes as `to`.
    pub attachment_id: String,
    /// `document` or `photo`.
    pub kind: String,
    /// The file's name; a photo may have none.
    pub title: Option<String>,
    /// The bytes' hash.
    pub content_id: String,
    pub media_type: String,
    pub content_uri: String,
    pub byte_size: i64,
    /// When it was attached.
    pub attached_at: Option<String>,
}

/// What `attachments` answers.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct AttachmentsData {
    pub attachments: Vec<AttachmentRow>,
    /// Pass this as `after` for the next page; `None` when the attachments ended.
    pub next: Option<PageCursor>,
}

fn text(word: &str) -> PageBindValue {
    PageBindValue::Text(word.to_owned())
}

fn by_ids(
    name: &'static str,
    table: &'static str,
    select: &'static str,
    column: &'static str,
) -> Read {
    Read {
        name,
        table,
        select,
        order: (column, column),
        column,
    }
}

fn ids_of(rows: &[Row], column: &str) -> Vec<String> {
    rows.iter().filter_map(|row| text_of(row, column)).collect()
}

/// `attachments`: one page of what `item_id` has attached.
///
/// `limit` is clamped to `1..=`[`ATTACHMENTS_PAGE_MAX`].
///
/// # Errors
///
/// A door refusal becomes the payload's denial.
pub fn load_attachments(
    door: &dyn PageDoor,
    item_id: &str,
    after: Option<PageCursor>,
    limit: usize,
) -> KitResult<(AttachmentsData, Option<Denial>)> {
    match read(door, item_id.trim(), after, limit) {
        Ok(data) => Ok((data, None)),
        Err(KitError::Door(message)) => Ok((AttachmentsData::default(), Some(denial_of(message)))),
        Err(other) => Err(other),
    }
}

fn read(
    door: &dyn PageDoor,
    item_id: &str,
    after: Option<PageCursor>,
    limit: usize,
) -> KitResult<AttachmentsData> {
    if item_id.is_empty() {
        return Ok(AttachmentsData::default());
    }
    let owner = [item_id.to_owned()];
    let live_item = by_ids("agenda.attachments.item", "entity", "id, kind", "id").of(
        door,
        &owner,
        Some((
            "deleted_at IS NULL AND kind IN (?, ?)",
            vec![text("event"), text("task")],
        )),
    )?;
    if live_item.is_empty() {
        return Ok(AttachmentsData::default());
    }
    let edges = door.page(
        &PageQuery::new(
            "agenda.attachments.edges",
            "from_id, to_id, created_at",
            "edge",
            PageOrder::asc("to_id", "to_id"),
        )
        .filter(
            "from_id = ? AND rel = ?",
            vec![text(item_id), text("attached")],
        ),
        &PageRequest {
            limit: limit.clamp(1, ATTACHMENTS_PAGE_MAX),
            after,
        },
    )?;
    let targets = ids_of(&edges.rows, "to_id");
    let live: BTreeMap<String, Row> =
        by_ids("agenda.attachments.far", "entity", "id, kind, title", "id")
            .of(door, &targets, Some(("deleted_at IS NULL", Vec::new())))?
            .into_iter()
            .filter_map(|row| text_of(&row, "id").map(|id| (id, row)))
            .collect();
    let mut held: BTreeMap<String, (String, String)> = BTreeMap::new();
    for (name, table) in [
        ("agenda.attachments.document", "document"),
        ("agenda.attachments.photo", "photo"),
    ] {
        let live_ids: Vec<String> = live.keys().cloned().collect();
        for row in by_ids(name, table, "id, blob, media_type", "id").of(door, &live_ids, None)? {
            if let (Some(id), Some(blob)) = (text_of(&row, "id"), text_of(&row, "blob")) {
                held.insert(id, (blob, text_of(&row, "media_type").unwrap_or_default()));
            }
        }
    }
    let hashes: Vec<String> = held.values().map(|(blob, _)| blob.clone()).collect();
    let sizes: BTreeMap<String, i64> =
        by_ids("agenda.attachments.blobs", "blob", "hash, size", "hash")
            .of(door, &hashes, None)?
            .iter()
            .filter_map(|row| Some((text_of(row, "hash")?, integer_or_zero(row, "size"))))
            .collect();
    let attachments = edges
        .rows
        .iter()
        .filter_map(|edge| {
            let id = text_of(edge, "to_id")?;
            let far = live.get(&id)?;
            let (blob, media_type) = held.get(&id)?;
            Some(AttachmentRow {
                kind: text_of(far, "kind").unwrap_or_default(),
                title: text_of(far, "title").filter(|title| !title.is_empty()),
                content_uri: format!("{BLOB_ROUTE}/{blob}"),
                byte_size: sizes.get(blob).copied().unwrap_or_default(),
                media_type: if media_type.is_empty() {
                    "application/octet-stream".to_owned()
                } else {
                    media_type.clone()
                },
                content_id: blob.clone(),
                attached_at: text_of(edge, "created_at"),
                attachment_id: id,
            })
        })
        .collect();
    Ok(AttachmentsData {
        attachments,
        next: edges.next,
    })
}
