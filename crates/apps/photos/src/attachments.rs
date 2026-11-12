//! `attachments` — what is attached to ONE photo, a page at a time (#1185). The read is the kit's;
//! this app names the one kind it may be asked of and its own plans.

use centraid_apps_kit::attachments::{self, AttachmentsData, Owner};
use centraid_apps_kit::page::PageCursor;
use centraid_apps_kit::reads::PageDoor;
use centraid_apps_kit::{Denial, KitResult};

const OWNER: Owner = Owner {
    kind: "photo",
    item: "photos.attachments.item",
    edges: "photos.attachments.edges",
    far: "photos.attachments.far",
    document: "photos.attachments.document",
    photo: "photos.attachments.photo",
    blobs: "photos.attachments.blobs",
};

/// `attachments`: one page of what a photo (`item_id`) has attached.
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
    attachments::load_attachments(door, OWNER, item_id, after, limit)
}
