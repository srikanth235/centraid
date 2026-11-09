//! `attachments` — what is attached to ONE event, a page at a time (#1173). The read is the kit's;
//! this app names the one kind it may be asked of and its own plans.

use centraid_apps_kit::KitResult;
use centraid_apps_kit::attachments::{self, Owner};
use centraid_apps_kit::page::PageCursor;
use centraid_apps_kit::reads::PageDoor;

use crate::Denial;

pub use centraid_apps_kit::attachments::{ATTACHMENTS_PAGE_MAX, AttachmentRow, AttachmentsData};

const OWNER: Owner = Owner {
    kind: "event",
    item: "calendar.attachments.item",
    edges: "calendar.attachments.edges",
    far: "calendar.attachments.far",
    document: "calendar.attachments.document",
    photo: "calendar.attachments.photo",
    blobs: "calendar.attachments.blobs",
};

/// `attachments`: one page of what an event (`item_id`) has attached.
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
