//! LOCKER'S TRASH, the kit's one trash screen (#1015 D1) with Locker as its
//! parameter: 30 days with the star and the tags kept, restore, and Delete
//! forever, through the vault's own `entity.restore` and `entity.purge`
//! (confirmed): a Locker item is an entity of kind `locker_item` (#1135). "Empty
//! trash" is `empty-trash` (`entity.empty_trash`, kind `locker_item`), as in
//! every app (#1185; it replaces the R-1047-K5 ruling that Locker does not
//! empty its trash).
//!
//! **A trash row is a title, and a title is inside Locker**, so the read is
//! behind the Locker's own lock: while the session is closed there is no read,
//! and the gate says the Locker is locked.

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;

use super::shared;
use crate::catalog::{act, load};
use crate::kit::read::{self, Reading};
use crate::kit::trash::{self, TrashItem, TrashSpec};
use crate::screen::{Ctx, Screen};
use crate::strings::{locker as words, shared as kit_words};

/// Locker's trash, as the kit's screen takes it.
pub static SPEC: TrashSpec = TrashSpec {
    of_row: None,
    app: act::locker::APP,
    icon_key: "Key",
    noun: kit_words::trash_noun_item,
    purge_lead: Some(words::purge_lead),
    back_label: words::app_name,
    denied: shared::gate,
    load: trashed,
    trash: |id| {
        act::locker::TrashItem {
            locker_item_id: id.to_owned(),
        }
        .into()
    },
    restore: |id| {
        act::locker::RestoreItem {
            locker_item_id: id.to_owned(),
        }
        .into()
    },
    purge: |id| {
        act::locker::PurgeItem {
            locker_item_id: id.to_owned(),
        }
        .into()
    },
    empty: || {
        act::locker::EmptyTrash {
            kind: Some(act::locker::EmptyTrashKind::LockerItem),
            ..Default::default()
        }
        .into()
    },
};

#[must_use]
pub fn build(_route: &wire::Route) -> Option<Box<dyn Screen>> {
    trash::build(&SPEC)
}

/// `locker.trash`: the trashed items, most recently trashed first.
fn trashed(ctx: &Ctx) -> Reading<Vec<TrashItem>> {
    if let Some(denial) = shared::closed(ctx) {
        return Reading::Denied(denial);
    }
    match read::read(ctx, load::locker::Trash::default(), |answer| match answer {
        Answer::LockerItems(items) => Some(items),
        _ => None,
    }) {
        Reading::Data(items) => Reading::Data(
            items
                .items
                .into_iter()
                .map(|row| TrashItem {
                    with: String::new(),
                    id: row.item_id,
                    title: row.title,
                    deleted_day: row.deleted_local_day,
                    purge_day: row.purge_local_day,
                    noun: None,
                })
                .collect(),
        ),
        Reading::Denied(denial) => Reading::Denied(denial),
        Reading::Failed => Reading::Failed,
    }
}
