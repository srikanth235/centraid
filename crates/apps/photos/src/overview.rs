//! THE COLLECTIONS OVERVIEW: how many photographs each shelf holds (#1135).
//!
//! Every count here is a count of a SHELF, taken by the same verdict the shelf is
//! drawn by ([`centraid_apps_kit::rules::Standing`]), so a tile and the page it
//! opens cannot disagree.

use centraid_apps_kit::error::KitResult;
use centraid_apps_kit::reads::PageDoor;
use centraid_apps_kit::rules::{Standing, photo_ids};

/// How many photographs are live: not trashed, not archived, and not folded under
/// an edit. The number Home's tile shows and the library shelf's total.
///
/// # Errors
/// The door's refusal, or a walk past the library bound.
pub fn live_photo_count(door: &dyn PageDoor) -> KitResult<usize> {
    let standing = Standing::read(door)?;
    Ok(photo_ids(door)?
        .iter()
        .filter(|id| standing.is_live(id))
        .count())
}
