//! What is attached to a set of things: documents and photos, in the order they
//! were attached.
//!
//! An attachment is an `attached` edge from the thing to a `document` or a
//! `photo`, and the edge has no id of its own: the attached file's id is its
//! identity (`edge.remove` takes the three ends). Notes, Agenda and Tasks each
//! show their attachments the same way, so the read is written once: the edges
//! of a window of ids, which of their far ends are live, their blobs and sizes,
//! one table at a time.

use std::collections::{BTreeMap, BTreeSet};

use crate::error::KitResult;
use crate::reads::{PageDoor, Read};
use crate::row::{Row, integer_or_zero, text_of};
use crate::statement::PageBindValue;

/// Where the vault serves a blob's bytes, by hash.
pub const BLOB_ROUTE: &str = "/centraid/_vault/blobs";

/// One attachment: a document or a photo attached to something.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attachment {
    /// The attached document's or photo's id: an attachment is an edge, and the
    /// thing it joins is its identity.
    pub attachment_id: String,
    /// The bytes' hash.
    pub content_id: String,
    pub media_type: String,
    pub content_uri: String,
    pub byte_size: i64,
}

fn texts(rows: &[Row], column: &str) -> Vec<String> {
    rows.iter().filter_map(|row| text_of(row, column)).collect()
}

/// The live attachments of each of `ids`, by id.
pub fn of(door: &dyn PageDoor, ids: &[String]) -> KitResult<BTreeMap<String, Vec<Attachment>>> {
    if ids.is_empty() {
        return Ok(BTreeMap::new());
    }
    let edges = Read {
        name: "attached.edges",
        table: "edge",
        select: "from_id, to_id",
        order: ("from_id", "to_id"),
        column: "from_id",
    }
    .of(
        door,
        ids,
        Some(("rel = ?", vec![PageBindValue::Text("attached".to_owned())])),
    )?;
    let targets = texts(&edges, "to_id");
    if targets.is_empty() {
        return Ok(BTreeMap::new());
    }
    let live: BTreeSet<String> = Read {
        name: "attached.live",
        table: "entity",
        select: "id",
        order: ("id", "id"),
        column: "id",
    }
    .of(door, &targets, Some(("deleted_at IS NULL", Vec::new())))?
    .iter()
    .filter_map(|row| text_of(row, "id"))
    .collect();
    let mut held: BTreeMap<String, (String, String)> = BTreeMap::new();
    // A document and a photo are both a blob with a media type.
    for (name, table) in [
        ("attached.document", "document"),
        ("attached.photo", "photo"),
    ] {
        let rows = Read {
            name,
            table,
            select: "id, blob, media_type",
            order: ("id", "id"),
            column: "id",
        }
        .of(door, &targets, None)?;
        for row in rows {
            if let (Some(id), Some(blob)) = (text_of(&row, "id"), text_of(&row, "blob")) {
                held.insert(id, (blob, text_of(&row, "media_type").unwrap_or_default()));
            }
        }
    }
    let hashes: Vec<String> = held.values().map(|(blob, _)| blob.clone()).collect();
    let sizes: BTreeMap<String, i64> = if hashes.is_empty() {
        BTreeMap::new()
    } else {
        Read {
            name: "attached.blobs",
            table: "blob",
            select: "hash, size",
            order: ("hash", "hash"),
            column: "hash",
        }
        .of(door, &hashes, None)?
        .iter()
        .filter_map(|row| Some((text_of(row, "hash")?, integer_or_zero(row, "size"))))
        .collect()
    };
    let mut by_owner: BTreeMap<String, Vec<Attachment>> = BTreeMap::new();
    for edge in &edges {
        let (Some(owner), Some(target)) = (text_of(edge, "from_id"), text_of(edge, "to_id")) else {
            continue;
        };
        let Some((blob, media_type)) = held.get(&target).filter(|_| live.contains(&target)) else {
            continue;
        };
        by_owner.entry(owner).or_default().push(Attachment {
            attachment_id: target,
            content_id: blob.clone(),
            media_type: if media_type.is_empty() {
                "application/octet-stream".to_owned()
            } else {
                media_type.clone()
            },
            content_uri: format!("{BLOB_ROUTE}/{blob}"),
            byte_size: sizes.get(blob).copied().unwrap_or_default(),
        });
    }
    Ok(by_owner)
}
