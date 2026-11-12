//! `attachments` — what is attached to ONE workout, a page at a time (#1185). The read is the kit's;
//! this app names the one kind it may be asked of and its own plans.

use centraid_apps_kit::attachments::{self, AttachmentsData, Owner};
use centraid_apps_kit::page::PageCursor;
use centraid_apps_kit::reads::PageDoor;
use centraid_apps_kit::{Denial, KitResult};

const OWNER: Owner = Owner {
    kind: "activity",
    item: "health.attachments.item",
    edges: "health.attachments.edges",
    far: "health.attachments.far",
    document: "health.attachments.document",
    photo: "health.attachments.photo",
    blobs: "health.attachments.blobs",
};

/// `attachments`: one page of what a workout (`item_id`) has attached.
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
